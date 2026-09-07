// A continuous height-displaced inner cylinder. Water texels stay on the same
// base cylinder; triangles connect every shoreline with no discarded fragments.
export function makeRingTerrainGeometry(T, source, heightTexture, {
    radius=5000,halfWidth=483,heightMeters=180,around=2048,across=128,repeat=8,
}={}) {
    const data=heightTexture.image.data,W=heightTexture.image.width,H=heightTexture.image.height;
    const sample=(u,v)=>{
        const x=((u%1)+1)%1*W-.5,y=((v%1)+1)%1*H-.5;
        const ix=Math.floor(x),iy=Math.floor(y),fx=x-ix,fy=y-iy;
        const at=(a,b)=>T.DataUtils.fromHalfFloat(data[((b%H+H)%H)*W+(a%W+W)%W]);
        return (at(ix,iy)*(1-fx)+at(ix+1,iy)*fx)*(1-fy)+(at(ix,iy+1)*(1-fx)+at(ix+1,iy+1)*fx)*fy;
    };
    // Retain the export's angular UV origin instead of rotating continents
    // relative to the authored walls and celestial reflection atlas.
    const sourceP=source.getAttribute('position'),sourceUV=source.getAttribute('uv');
    let phaseX=0,phaseY=0;
    for(let i=0;i<sourceP.count;i++){
        const delta=Math.atan2(sourceP.getZ(i),sourceP.getY(i))-(.5-sourceUV.getX(i))*Math.PI*2;
        phaseX+=Math.cos(delta);phaseY+=Math.sin(delta);
    }
    const phase=Math.atan2(phaseY,phaseX);
    const columns=across+1,count=(around+1)*columns;
    const positions=new Float32Array(count*3),normals=new Float32Array(count*3),uv=new Float32Array(count*2);
    let minHeight=Infinity,maxHeight=-Infinity;
    for(let i=0;i<=around;i++){
        const u=i/around,angle=(.5-u)*Math.PI*2+phase,cy=Math.cos(angle),cz=Math.sin(angle);
        for(let j=0;j<=across;j++){
            const v=j/across,index=i*columns+j;
            const h=sample(u*repeat,1-v)*heightMeters;
            minHeight=Math.min(minHeight,h);maxHeight=Math.max(maxHeight,h);
            positions.set([(v-.5)*halfWidth*2,(radius-h)*cy,(radius-h)*cz],index*3);
            // The matching normal map carries the full height gradient. Use
            // the cylindrical frame here so macro slopes are not applied twice.
            normals.set([0,-cy,-cz],index*3);uv.set([u,v],index*2);
        }
    }
    const indices=new Uint32Array(around*across*6);let k=0;
    for(let i=0;i<around;i++)for(let j=0;j<across;j++){
        const a=i*columns+j,b=a+columns;
        indices[k++]=a;indices[k++]=b;indices[k++]=a+1;
        indices[k++]=a+1;indices[k++]=b;indices[k++]=b+1;
    }
    const geometry=new T.BufferGeometry();
    geometry.setAttribute('position',new T.BufferAttribute(positions,3));
    geometry.setAttribute('normal',new T.BufferAttribute(normals,3));
    geometry.setAttribute('uv',new T.BufferAttribute(uv,2));
    geometry.setIndex(new T.BufferAttribute(indices,1));
    geometry.computeBoundingBox();geometry.computeBoundingSphere();
    geometry.userData.ringRelief={around,across,vertices:count,triangles:indices.length/3,heightMeters,minHeight,maxHeight,phase};
    return geometry;
}
