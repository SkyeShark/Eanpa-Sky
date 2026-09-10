(async()=>{
    const f=__skyFixture,T=THREE,r=f.renderer;
    if(!_eanpaTest.paused){_eanpaTest.pauseAfterFrame=true;while(!_eanpaTest.paused)await new Promise(done=>setTimeout(done,10));}
    f.animateCamera=false;f.active.setTime(17.7);f.sky.setClouds('cumulus');f.weather.setWeather('none');
    await new Promise(requestAnimationFrame);await f.frame(f.time);
    await f.sky.prepareCloudShadows(r,f.camera,true);
    const n=256,extent=3600,world=T.vec3(T.uv().x.sub(.5).mul(extent),0,T.uv().y.sub(.5).mul(extent));
    const target=new T.RenderTarget(n,n,{type:T.HalfFloatType,depthBuffer:false});
    const material=new T.MeshBasicNodeMaterial();material.fragmentNode=T.vec4(T.vec3(f.sky.tslCloudShadow(world)),1);
    const quad=new T.QuadMesh(material),saved=T.RendererUtils.saveRendererState(r);
    try{
        r.setMRT(null);r.setRenderTarget(target);await quad.renderAsync(r);
        const data=await r.readRenderTargetPixelsAsync(target,0,0,n,n);let chosen=null;
        for(let y=0;y<n;y++)for(let x=0;x<n;x++){
            const v=T.DataUtils.fromHalfFloat(data[(y*n+x)*4]);if(v<.2||v>.8)continue;
            const px=((x+.5)/n-.5)*extent,pz=((y+.5)/n-.5)*extent,score=Math.hypot(px,pz);
            if(!chosen||score<chosen.score)chosen={x:px,z:pz,value:v,score};
        }
        if(!chosen)throw new Error('No shadow boundary in this scan; choose a different sky time');
        T.RendererUtils.restoreRendererState(r,saved);
        f.host.position.set(chosen.x,0,chosen.z);f.camera.position.set(chosen.x+5,6.5,chosen.z+20);
        f.camera.lookAt(chosen.x,2,chosen.z-9);f.camera.fov=62;f.camera.updateProjectionMatrix();
        const frames=[],series=[],t0=f.time,point=T.uniform(new T.Vector3(chosen.x,0,chosen.z));
        const probeMat=new T.MeshBasicNodeMaterial();probeMat.fragmentNode=T.vec4(T.vec3(f.sky.tslCloudShadow(point)),1);
        const probe=new T.QuadMesh(probeMat),probeTarget=new T.RenderTarget(1,1,{type:T.FloatType,depthBuffer:false});
        try{for(let i=0;i<121;i++){
            await new Promise(requestAnimationFrame);await f.frame(t0+i/30);
            if(i%30===0)frames.push({time:f.time,png:r.domElement.toDataURL('image/png')});
            const state=T.RendererUtils.saveRendererState(r);r.setMRT(null);r.setRenderTarget(probeTarget);await probe.renderAsync(r);
            const value=(await r.readRenderTargetPixelsAsync(probeTarget,0,0,1,1))[0];T.RendererUtils.restoreRendererState(r,state);
            series.push({time:f.time,captures:f.sky.cloudShadowMap.stats.captures,value});
        }}finally{probeTarget.dispose();probeMat.dispose();}
        const betweenCaptures=series.slice(1).filter((s,i)=>s.captures===series[i].captures);
        let advectedFrames=0;for(let i=1;i<series.length;i++)if(series[i].captures===series[i-1].captures&&Math.abs(series[i].value-series[i-1].value)>1e-6)advectedFrames++;
        return{date:new Date().toISOString(),chosen,sun:f.sky.sunDir.toArray(),map:f.sky.cloudShadowMap.stats,
            span:f.sky.cloudShadowMap.projection.span.value.toArray(),betweenCaptureFrames:betweenCaptures.length,advectedFrames,series,frames};
    }finally{T.RendererUtils.restoreRendererState(r,saved);target.dispose();material.dispose();}
})()
