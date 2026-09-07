import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {gunzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import * as T from '../vendor/three/three.core.js';
import {decodeRingRelief} from '../src/ring_relief.js';
import {makeRingTerrainGeometry} from '../engine/ring_terrain_geometry.js';

const payload=gunzipSync(await readFile(new URL('../assets/ringworld/ring_relief_v4.bin.gz',import.meta.url)));
const manifest=JSON.parse(await readFile(new URL('../assets/ringworld/ring_relief_v4.json',import.meta.url)));
const relief=decodeRingRelief(payload.buffer.slice(payload.byteOffset,payload.byteOffset+payload.byteLength));

test('new ring atlas has four times the source samples and bounded height/normal data',()=>{
    assert.equal(createHash('sha256').update(payload).digest('hex'),manifest.sha256);
    assert.equal(relief.width*relief.height,2172*724*4);
    for(let i=0;i<relief.heightData.length;i++){
        const height=T.DataUtils.fromHalfFloat(relief.heightData[i]);assert.ok(Number.isFinite(height)&&height>=0&&height<=1);
        if(i%7===0){const n=relief.normalAoData.subarray(i*4,i*4+3);assert.ok(Math.abs(Math.hypot(...Array.from(n,c=>c/127.5-1))-1)<.007);}
    }
});

test('displaced ring is a continuous inward-facing surface with closed angular seam and level water',()=>{
    const source=new T.BufferGeometry();source.setAttribute('position',new T.Float32BufferAttribute([0,-5000,0,0,5000,0],3));
    source.setAttribute('uv',new T.Float32BufferAttribute([0,0,.5,1],2));
    const texture=new T.DataTexture(relief.heightData,relief.width,relief.height,T.RedFormat,T.HalfFloatType);
    const geometry=makeRingTerrainGeometry(T,source,texture,{around:256,across:64});
    const p=geometry.getAttribute('position'),info=geometry.userData.ringRelief,first=info.rows[0],last=info.rows.at(-1);
    for(let j=0;j<=first.segments;j++)for(let a=0;a<3;a++)assert.ok(Math.abs(p.array[j*3+a]-p.array[(last.offset+j)*3+a])<.001);
    let water=0;for(let i=0;i<p.count;i++){const radius=Math.hypot(p.getY(i),p.getZ(i));assert.ok(radius<=5000.001&&radius>=4820);if(Math.abs(radius-5000)<.001)water++;}
    assert.ok(water>1000,'water remains on the authored cylinder');
    const a=new T.Vector3(),b=new T.Vector3(),c=new T.Vector3(),inward=new T.Vector3();
    for(let i=0;i<geometry.index.count;i+=81){
        a.fromBufferAttribute(p,geometry.index.array[i]);b.fromBufferAttribute(p,geometry.index.array[i+1]);c.fromBufferAttribute(p,geometry.index.array[i+2]);
        if(geometry.getAttribute('ringSkirt').getX(geometry.index.array[i]))continue;
        inward.set(0,-a.y,-a.z);assert.ok(b.sub(a).cross(c.sub(a)).dot(inward)>0);
    }
    assert.ok(geometry.index.count<256*64*6,'distant rows retain less geometry');
    geometry.dispose();source.dispose();texture.dispose();
});
