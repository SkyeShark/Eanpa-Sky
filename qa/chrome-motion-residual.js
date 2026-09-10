(async()=>{
    _eanpaTest.pauseAfterFrame=true;while(!_eanpaTest.paused)await new Promise(done=>setTimeout(done,10));
    const T=THREE,p=_reflectionPipeline,r=p.pipeline.renderer,c=_c;
    const w=p.history.width,h=p.history.height,half=T.DataUtils.fromHalfFloat;
    const arms=c.getObjectByName('Aletheia_Chrome_Viewmodel_Arms'),armId=p.geometry.objectId(arms);
    const position=c.position.clone(),rotation=c.quaternion.clone();
    const updateProbe=p.localProbe.update;p.localProbe.update=()=>{};
    const read=async()=>{
        const data=await r.readRenderTargetPixelsAsync(p.history,0,0,w,h),stride=Math.ceil(w*8/256)*256/2;
        return {data,stride};
    };
    const records=[],frames=[];
    try{
        for(let i=0;i<4;i++){await new Promise(requestAnimationFrame);await p.render();}
        for(let pose=0;pose<12;pose++){
            const phase=(pose+1)*Math.PI/6;c.position.copy(position).add(new T.Vector3(Math.sin(phase)*.12,0,Math.cos(phase)*.06));
            c.quaternion.copy(rotation);c.rotateY(Math.sin(phase)*.012);c.updateMatrixWorld(true);
            await new Promise(requestAnimationFrame);await p.render();const first=await read();
            const keys=await r.readRenderTargetPixelsAsync(p.geometry.target,0,0,w,h,1),keyStride=Math.ceil(w*16/256)*256/4;
            if(pose%4===0)frames.push({pose,phase:'moving',png:r.domElement.toDataURL('image/png')});
            for(let j=0;j<3;j++){await new Promise(requestAnimationFrame);await p.render();}
            const settled=await read(),errors=[];
            for(let y=0;y<h;y+=2)for(let x=0;x<w;x+=2){
                const k=y*keyStride+x*4;if(Math.round(keys[k+3])!==armId||keys[k+2]>-.1||keys[k+2]<-4)continue;
                const index=y*first.stride+x*4;
                let difference=0,energy=0;for(let channel=0;channel<3;channel++){
                    const a=half(first.data[index+channel]),b=half(settled.data[index+channel]);difference+=Math.abs(a-b);energy+=Math.abs(b);
                }errors.push(difference/(1+energy));
            }
            errors.sort((a,b)=>a-b);records.push({pose,samples:errors.length,meanRelative:errors.reduce((a,b)=>a+b,0)/errors.length,
                p95:errors[Math.floor(errors.length*.95)],p99:errors[Math.floor(errors.length*.99)],max:errors.at(-1)});
            if(pose%4===0)frames.push({pose,phase:'settled',png:r.domElement.toDataURL('image/png')});
        }
        return{date:new Date().toISOString(),implementation:p.ssrImplementation,armId,records,frames,
            material:{type:arms.material.type,metalness:arms.material.metalness,roughness:arms.material.roughness,hasRoughnessMap:!!arms.material.roughnessMap}};
    }finally{p.localProbe.update=updateProbe;}
})()
