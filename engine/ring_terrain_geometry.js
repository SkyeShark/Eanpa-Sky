// A continuous height-displaced inner cylinder. Water texels stay on the same
// base cylinder; triangles connect every shoreline with no discarded fragments.
export function makeRingTerrainGeometry(T, source, heightTexture, {
    radius=5000,halfWidth=483,heightMeters=180,around=4096,across=512,repeat=8,localReliefBlend=[0,0],
}={}) {
    around=Math.max(16,Math.round(around));
    across=Math.max(8,Math.round(across/8)*8);
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
    // Concentrate vertices near the observer's part of the ring. Distant rows
    // need fewer cross-band samples; stitched transitions share every edge.
    const rows=[];let surfaceCount=0;
    for(let i=0;i<=around;i++){
        const t=i/around*2-1,s=Math.sign(t)*Math.pow(Math.abs(t),1.8);
        const distance=Math.abs(s)*Math.PI*radius;
        const segments=Math.max(8,across/(distance<300?1:distance<1000?2:distance<3500?4:8));
        rows.push({u:s*.5+phase/(Math.PI*2),angle:Math.PI-s*Math.PI,segments,offset:surfaceCount});
        surfaceCount+=segments+1;
    }
    const count=surfaceCount+(around+1)*4;
    const positions=new Float32Array(count*3),normals=new Float32Array(count*3),uv=new Float32Array(count*2),skirt=new Float32Array(count);
    let minHeight=Infinity,maxHeight=-Infinity;
    for(let i=0;i<=around;i++){
        const row=rows[i],{u,angle,segments,offset}=row,cy=Math.cos(angle),cz=Math.sin(angle);
        // The standalone's local terrain owns the nearby playable patch.
        // Ease the sky ring's relief into it without overlapping the
        // player with 180-metre foreground peaks. Sea level is unchanged.
        const arcDistance=Math.abs(Math.atan2(cz,-cy))*radius;
        let reliefWeight=localReliefBlend[1]>localReliefBlend[0]
            ? Math.max(0,Math.min(1,(arcDistance-localReliefBlend[0])/(localReliefBlend[1]-localReliefBlend[0]))) : 1;
        reliefWeight=reliefWeight*reliefWeight*(3-2*reliefWeight);
        for(let j=0;j<=segments;j++){
            const v=j/segments,index=offset+j;
            const h=sample(u*repeat,1-v)*heightMeters*reliefWeight;
            minHeight=Math.min(minHeight,h);maxHeight=Math.max(maxHeight,h);
            positions.set([(v-.5)*halfWidth*2,(radius-h)*cy,(radius-h)*cz],index*3);
            // The matching normal map carries the full height gradient. Use
            // the cylindrical frame here so macro slopes are not applied twice.
            normals.set([0,-cy,-cz],index*3);uv.set([u,v],index*2);
        }
        for(let side=0;side<2;side++){
            const top=offset+(side?segments:0),edge=surfaceCount+i*4+side*2;
            positions.set(positions.subarray(top*3,top*3+3),edge*3);
            positions.set([(side-.5)*halfWidth*2,radius*cy,radius*cz],(edge+1)*3);
            for(const index of [edge,edge+1]){
                normals.set([side?1:-1,0,0],index*3);uv.set([u,side],index*2);skirt[index]=1;
            }
        }
    }
    const triangleCount=rows.slice(1).reduce((n,row,i)=>n+row.segments+rows[i].segments,0)+around*4;
    const indices=new Uint32Array(triangleCount*3);let k=0;
    const triangle=(a,b,c)=>{indices[k++]=a;indices[k++]=b;indices[k++]=c};
    for(let i=0;i<around;i++){
        const a=rows[i],b=rows[i+1];let j=0,l=0;
        while(j<a.segments||l<b.segments){
            const nextA=(j+1)/a.segments,nextB=(l+1)/b.segments;
            if(nextA<=nextB&&j<a.segments){triangle(a.offset+j,b.offset+l,a.offset+j+1);j++;}
            else{triangle(a.offset+j,b.offset+l,b.offset+l+1);l++;}
        }
        for(let side=0;side<2;side++){
            const a=surfaceCount+i*4+side*2,b=a+4;
            if(side){triangle(a,a+1,b);triangle(b,a+1,b+1);}
            else{triangle(a,b,a+1);triangle(b,b+1,a+1);}
        }
    }
    const geometry=new T.BufferGeometry();
    geometry.setAttribute('position',new T.BufferAttribute(positions,3));
    geometry.setAttribute('normal',new T.BufferAttribute(normals,3));
    geometry.setAttribute('uv',new T.BufferAttribute(uv,2));
    geometry.setAttribute('ringSkirt',new T.BufferAttribute(skirt,1));
    geometry.setIndex(new T.BufferAttribute(indices,1));
    geometry.computeBoundingBox();geometry.computeBoundingSphere();
    geometry.userData.ringRelief={around,across,vertices:count,triangles:indices.length/3,heightMeters,minHeight,maxHeight,phase,localReliefBlend,
        rows:rows.map(row=>({offset:row.offset,segments:row.segments})),surfaceVertices:surfaceCount};
    return geometry;
}
