"""Bake a coherent 4K height/normal/albedo atlas with hydraulic sediment transport.

Requires numpy, numba and Pillow. No run-time erosion or material generation.
Source coastlines and water colours are retained from the authored ring asset.
"""
from pathlib import Path
import gzip, hashlib, io, json, math, struct
import numpy as np
from numba import njit
from PIL import Image

ROOT=Path(__file__).resolve().parents[1]
ASSETS=ROOT/'assets/ringworld'
W,H=4344,1448
HEIGHT_METERS=180.0
TILE_METERS=2*math.pi*5000/8
WIDTH_METERS=966.0

def image_array(path):
    image=Image.open(path)
    data=np.asarray(image,dtype=np.float32)
    return data/(65535 if image.mode.startswith('I;16') or data.max()>255 else 255)

source=image_array(ASSETS/'ring_band_height.png')
base=np.asarray(Image.fromarray(source).resize((W,H),Image.Resampling.BICUBIC),dtype=np.float32).copy()
mask=np.asarray(Image.open(ASSETS/'ringworldlandmask.png').convert('L').resize((W,H),Image.Resampling.BILINEAR),dtype=np.float32)/255

@njit
def hash2(x,y,salt):
    n=np.uint32(x*374761393)^np.uint32(y*668265263)^np.uint32(salt)
    n=np.uint32((n^(n>>13))*np.uint32(1274126177))
    return float(n^(n>>16))/4294967295.0

@njit
def noise(x,y,cells,salt):
    px=x/W*cells*3;py=y/H*cells
    ix=int(math.floor(px));iy=int(math.floor(py));fx=px-ix;fy=py-iy
    sx=fx*fx*(3-2*fx);sy=fy*fy*(3-2*fy)
    a=hash2(ix%(cells*3),iy%cells,salt);b=hash2((ix+1)%(cells*3),iy%cells,salt)
    c=hash2(ix%(cells*3),(iy+1)%cells,salt);d=hash2((ix+1)%(cells*3),(iy+1)%cells,salt)
    return (a*(1-sx)+b*sx)*(1-sy)+(c*(1-sx)+d*sx)*sy

@njit
def uplift(base,mask):
    result=np.zeros((H,W),np.float32)
    for y in range(H):
        for x in range(W):
            land=min(1.,max(0.,(mask[y,x]-.40)/.55));land=land*land*(3-2*land)
            if land==0:continue
            b=max(0.,base[y,x]);mountain=min(1.,b/.35)
            wx=x+(noise(x,y,5,317)-.5)*110;wy=y+(noise(x,y,5,193)-.5)*110
            r0=(1-abs(noise(wx,wy,13,7919)*2-1))**2.6
            r1=(1-abs(noise(wx,wy,29,1543)*2-1))**2.3
            r2=(1-abs(noise(wx,wy,61,2749)*2-1))**2
            r3=(1-abs(noise(wx,wy,131,1009)*2-1))**2
            result[y,x]=land*(b**1.2*.70+mountain*(.23*r0+.13*r0*r1+.07*r1*r2+.026*r2*r3))
    return result

@njit
def sample(field,x,y):
    ix=int(x);iy=int(y);fx=x-ix;fy=y-iy
    a=field[iy%H,ix%W];b=field[iy%H,(ix+1)%W];c=field[(iy+1)%H,ix%W];d=field[(iy+1)%H,(ix+1)%W]
    return ((a*(1-fx)+b*fx)*(1-fy)+(c*(1-fx)+d*fx)*fy,
            (b-a)*(1-fy)+(d-c)*fy,(c-a)*(1-fx)+(d-b)*fx)

@njit
def deposit(field,x,y,amount):
    ix=int(x);iy=int(y);fx=x-ix;fy=y-iy
    for oy in range(2):
        for ox in range(2):
            field[(iy+oy)%H,(ix+ox)%W]+=amount*(fx if ox else 1-fx)*(fy if oy else 1-fy)

@njit
def erode(field,mask,count):
    np.random.seed(50906)
    brush=[];total=0.
    for y in range(-3,4):
        for x in range(-3,4):
            w=max(0.,3.3-math.hypot(x,y))
            if w>0:brush.append((x,y,w));total+=w
    flow=np.zeros_like(field)
    for drop in range(count):
        x=np.random.random()*W;y=np.random.random()*H
        if mask[int(y),int(x)]<.9:continue
        dx=0.;dy=0.;water=1.;sediment=0.;speed=.1
        for age in range(90):
            old,gx,gy=sample(field,x,y)
            dx=dx*.12-gx*.88;dy=dy*.12-gy*.88
            length=math.hypot(dx,dy)
            if length<1e-9:angle=np.random.random()*math.pi*2;dx=math.cos(angle);dy=math.sin(angle);length=1.
            dx/=length;dy/=length;nx=(x+dx)%W;ny=(y+dy)%H
            new,_,_=sample(field,nx,ny);delta=new-old
            capacity=max(-delta,.00008)*water*speed*8
            if delta>0 or sediment>capacity:
                amount=min(delta,sediment) if delta>0 else (sediment-capacity)*.22
                deposit(field,x,y,amount);sediment-=amount
            else:
                amount=min((capacity-sediment)*.36,max(0.,-delta)*.85)
                for ox,oy,w in brush:
                    xx=(int(x)+int(ox))%W;yy=(int(y)+int(oy))%H
                    taken=min(max(0.,field[yy,xx]),amount*w/total)
                    if mask[yy,xx]<.85:continue
                    field[yy,xx]-=taken;sediment+=taken
            flow[int(y),int(x)]+=water
            speed=math.sqrt(max(0.,speed*speed-delta*22));water*=.976;x=nx;y=ny
            if mask[int(y),int(x)]<.65 or water<.1:break
        deposit(field,x,y,sediment)
    return flow

print('Building 4K uplift field',flush=True)
height=uplift(base,mask)
before=height.copy()
droplets=W*H//2
print(f'Simulating {droplets:,} hydraulic paths',flush=True)
flow=erode(height,mask,droplets)
height=np.clip(height,0,.995);height[mask<.40]=0
dx=(np.roll(height,-1,1)-np.roll(height,1,1))*(HEIGHT_METERS*W/TILE_METERS/2)
dy=(np.roll(height,-1,0)-np.roll(height,1,0))*(HEIGHT_METERS*H/WIDTH_METERS/2)
inv=1/np.sqrt(1+dx*dx+dy*dy)
normals=np.empty((H,W,4),np.uint8)
normals[:,:,0]=np.rint((-dx*inv*.5+.5)*255)
normals[:,:,1]=np.rint((dy*inv*.5+.5)*255)
normals[:,:,2]=np.rint((inv*.5+.5)*255)
concavity=np.maximum(0,(np.roll(height,5,0)+np.roll(height,-5,0)+np.roll(height,5,1)+np.roll(height,-5,1))/4-height)
normals[:,:,3]=np.rint(np.clip(1-concavity*15,.6,1)*255)
payload=struct.pack('<4sIII',b'ERLF',1,W,H)+height[::-1].astype('<f2').tobytes()+normals[::-1].tobytes()
(ASSETS/'ring_relief_v4.bin.gz').write_bytes(gzip.compress(payload,compresslevel=9,mtime=0))

# Keep authored water colour; add terrain-dependent soil/vegetation variation
# without baking a directional light into the material.
glb=(ASSETS/'RINGWORLDskyelement.glb').read_bytes();length=struct.unpack_from('<I',glb,12)[0]
gltf=json.loads(glb[20:20+length]);view=gltf['bufferViews'][gltf['images'][1]['bufferView']]
offset=28+length+view.get('byteOffset',0)
color=Image.open(io.BytesIO(glb[offset:offset+view['byteLength']])).convert('RGB').resize((W,H),Image.Resampling.LANCZOS)
rgb=np.asarray(color,dtype=np.float32)/255
land=np.clip((mask-.45)/.4,0,1)
sediment=np.clip((height-before)*70,-.25,.25)
channel=np.clip(np.log1p(flow)/5,0,1)*np.clip(height/.12,0,1)*land
rgb*=np.clip(1+sediment[:,:,None]*land[:,:,None]-.10*channel[:,:,None],.8,1.15)
rgb[:,:,1]+=channel*.012
Image.fromarray(np.rint(np.clip(rgb,0,1)*255).astype(np.uint8)).save(ASSETS/'ring_albedo_v4.png')
manifest={'version':1,'width':W,'height':H,'heightMeters':HEIGHT_METERS,'tileMeters':TILE_METERS,'widthMeters':WIDTH_METERS,
    'seed':50906,'droplets':droplets,'maxDropletSteps':90,'heightFormat':'r16float','normalAoFormat':'rgba8unorm',
    'rowOrder':'bottom-to-top','sha256':hashlib.sha256(payload).hexdigest(),'decodedBytes':len(payload),
    'source':'ring_band_height.png + authored ring GLB albedo/coast mask',
    'erosionRmsMeters':float(np.sqrt(np.mean((height-before)**2))*HEIGHT_METERS)}
(ASSETS/'ring_relief_v4.json').write_text(json.dumps(manifest,indent=2)+'\n')
preview=Image.fromarray(np.rint(height*255).astype(np.uint8));preview.thumbnail((1448,483));preview.save(ROOT/'artifacts/overhaul/ring-height-v4.png')
print(json.dumps(manifest,indent=2),flush=True)
