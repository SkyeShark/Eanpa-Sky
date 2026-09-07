(async()=>{
    _eanpaTest.pauseAfterFrame=true;_eanpaTest.paused=false;
    while(!_eanpaTest.paused)await new Promise(r=>setTimeout(r,20));
    const T=THREE,renderer=_reflectionPipeline.pipeline.renderer,sky=_sky;
    const size=256,extent=4096;
    const target=new T.RenderTarget(size,size,{type:T.HalfFloatType,depthBuffer:false});
    const material=new T.MeshBasicNodeMaterial();
    const p=T.vec3(T.uv().x.sub(.5).mul(extent),0,T.uv().y.sub(.5).mul(extent));
    material.fragmentNode=T.vec4(T.vec3(sky.tslCloudShadow(p,1)),1);
    const quad=new T.QuadMesh(material);
    const saved={target:renderer.getRenderTarget(),mrt:renderer.getMRT(),context:renderer.contextNode};
    try{
        await new Promise(requestAnimationFrame);
        renderer.setMRT(null);renderer.contextNode=T.context({});renderer.setRenderTarget(target);
        await quad.renderAsync(renderer);
        const pixels=await renderer.readRenderTargetPixelsAsync(target,0,0,size,size);
        const values=[];for(let i=0;i<pixels.length;i+=4)values.push(T.DataUtils.fromHalfFloat(pixels[i]));
        const ordered=[...values].sort((a,b)=>a-b);
        return {date:new Date().toISOString(),size,extent,values,
            stats:{min:ordered[0],p05:ordered[Math.floor(ordered.length*.05)],median:ordered[ordered.length>>1],
                p95:ordered[Math.floor(ordered.length*.95)],max:ordered.at(-1),mean:values.reduce((a,b)=>a+b,0)/values.length},
            state:sky.state,sun:sky.uniforms.cloudLightDir.value.toArray(),time:sky.uniforms.time.value};
    }finally{renderer.contextNode=saved.context;renderer.setRenderTarget(saved.target);renderer.setMRT(saved.mrt);target.dispose();material.dispose();}
})()
