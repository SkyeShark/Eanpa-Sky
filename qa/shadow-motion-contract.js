(async()=>{
    const f=__skyFixture,T=THREE,r=f.renderer;
    if(!_eanpaTest.paused){_eanpaTest.pauseAfterFrame=true;while(!_eanpaTest.paused)await new Promise(done=>setTimeout(done,10));}
    f.active.setTime(17.7);f.weather.setWeather('none');f.sky.setClouds('cumulus');
    f.active.update(f.time);await f.sky.prepareCloudShadows(r,f.camera,true);
    const size=64,target=new T.RenderTarget(size,size,{type:T.FloatType,depthBuffer:false});
    const material=new T.MeshBasicNodeMaterial();
    const world=T.vec3(T.uv().x.sub(.5).mul(2400),T.step(.5,T.uv().y).mul(25),T.uv().y.sub(.5).mul(2400));
    material.fragmentNode=T.vec4(T.vec3(f.sky.tslCloudShadow(world)),1);
    const quad=new T.QuadMesh(material),state=T.RendererUtils.saveRendererState(r),records=[];
    const sample=async()=>{r.setMRT(null);r.setRenderTarget(target);await quad.renderAsync(r);return r.readRenderTargetPixelsAsync(target,0,0,size,size);};
    try{
        for(let i=0;i<20;i++){
            f.time+=.11;f.active.update(f.time);await new Promise(requestAnimationFrame);
            const before=await sample();await f.sky.prepareCloudShadows(r,f.camera);const after=await sample();
            let max=0,sum=0,nontrivial=0;for(let j=0;j<before.length;j+=4){const d=Math.abs(before[j]-after[j]);max=Math.max(max,d);sum+=d;if(before[j]>.02&&before[j]<.98)nontrivial++;}
            records.push({time:f.time,maxPublicationChange:max,meanPublicationChange:sum/(size*size),nontrivialReceivers:nontrivial});
        }
        return{date:new Date().toISOString(),sky:f.kind,quality:f.tier,sun:f.sky.sunDir.toArray(),
            method:'Same world receiver and simulation time immediately before/after each new cloud capture; ground and 25 m roofs across 2400 m.',
            pass:records.every(x=>x.maxPublicationChange<.003)&&records.some(x=>x.nontrivialReceivers>100),records};
    }finally{T.RendererUtils.restoreRendererState(r,state);target.dispose();material.dispose();}
})()
