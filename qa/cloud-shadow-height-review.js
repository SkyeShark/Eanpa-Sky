(async()=>{
    _eanpaTest.pauseAfterFrame=true;_eanpaTest.paused=false;
    while(!_eanpaTest.paused)await new Promise(r=>setTimeout(r,20));
    const T=THREE,r=_reflectionPipeline.pipeline.renderer;
    const target=new T.RenderTarget(128,128,{type:T.HalfFloatType,depthBuffer:false});
    const height=T.uniform(0).setGroup(T.renderGroup);
    const world=T.vec3(T.uv().x.sub(.5).mul(1200),height,T.uv().y.sub(.5).mul(1200));
    const cached=_sky.tslCloudShadow(world),direct=_sky.tslCloudTransmittance(world);
    const material=new T.MeshBasicNodeMaterial();material.fragmentNode=T.vec4(cached,direct,T.abs(cached.sub(direct)),1);
    const quad=new T.QuadMesh(material),saved={target:r.getRenderTarget(),mrt:r.getMRT(),context:r.contextNode};
    const results=[];
    try{
        await _sky.prepareCloudShadows(r,_c,{force:true});
        r.setMRT(null);r.contextNode=T.context({});r.setRenderTarget(target);
        for(const y of [0,25,200,1400]){
            height.value=y;await new Promise(requestAnimationFrame);await quad.renderAsync(r);
            const data=await r.readRenderTargetPixelsAsync(target,0,0,128,128);
            let error=0,maximum=0,clouded=0;const differences=[];
            for(let i=0;i<data.length;i+=4){const e=T.DataUtils.fromHalfFloat(data[i+2]);error+=e;maximum=Math.max(maximum,e);differences.push(e);if(T.DataUtils.fromHalfFloat(data[i])<.5)clouded++;}
            differences.sort((a,b)=>a-b);
            results.push({height:y,meanAbsoluteError:error/16384,p95:differences[Math.floor(differences.length*.95)],maximum,cloudedPixels:clouded});
        }
        return {date:new Date().toISOString(),results,sun:_sky.uniforms.cloudLightDir.value.toArray(),map:_sky.cloudShadowMap.stats};
    }finally{r.contextNode=saved.context;r.setRenderTarget(saved.target);r.setMRT(saved.mrt);target.dispose();material.dispose();}
})()
