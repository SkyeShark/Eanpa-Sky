(async()=>{
    _eanpaTest.pauseAfterFrame=true;_eanpaTest.paused=false;
    while(!_eanpaTest.paused)await new Promise(r=>setTimeout(r,20));
    const T=THREE,w=__eanpaWeatherByScene.get(_c.parent),r=_reflectionPipeline.pipeline.renderer;
    if(!w)throw new Error('Select rain first');
    const target=new T.RenderTarget(128,128,{type:T.HalfFloatType,depthBuffer:false});
    const height=T.uniform(22).setGroup(T.renderGroup);
    const p=T.vec3(T.uv().x.sub(.5).mul(80),height,T.uv().y.sub(.5).mul(80).sub(70));
    const material=new T.MeshBasicNodeMaterial();
    material.fragmentNode=T.vec4(w.surfaceField.visibilityAt(p,T.float(.15)),w.surfaceField.impactAt(p).y,
        T.smoothstep(w.uniforms.cellLo,w.uniforms.cellHi,_sky.tslCoverage(p.xz)),1);
    const quad=new T.QuadMesh(material),saved={target:r.getRenderTarget(),mrt:r.getMRT(),context:r.contextNode};
    const results=[];
    try{
        await new Promise(requestAnimationFrame);await w.prepareFrame(r,_c,{force:true});
        r.setMRT(null);r.contextNode=T.context({});r.setRenderTarget(target);
        for(const y of [0,20,22,25,32]){
            height.value=y;await new Promise(requestAnimationFrame);await quad.renderAsync(r);
            const data=await r.readRenderTargetPixelsAsync(target,0,0,128,128);
            const channels=[[],[],[]];for(let i=0;i<data.length;i+=4)for(let c=0;c<3;c++)channels[c].push(T.DataUtils.fromHalfFloat(data[i+c]));
            results.push({y,...Object.fromEntries(channels.map((values,i)=>{
                values.sort((a,b)=>a-b);return [['exposure','impactHeight','rainCell'][i],{min:values[0],mean:values.reduce((a,b)=>a+b)/values.length,max:values.at(-1),median:values[8192]}];
            }))});
        }
        return{date:new Date().toISOString(),results,diagnostics:w.diagnostics};
    }finally{r.contextNode=saved.context;r.setRenderTarget(saved.target);r.setMRT(saved.mrt);target.dispose();material.dispose();}
})()
