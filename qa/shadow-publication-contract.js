(async()=>{
    if(!_eanpaTest.paused){_eanpaTest.pauseAfterFrame=true;while(!_eanpaTest.paused)await new Promise(done=>setTimeout(done,10));}
    const T=THREE,r=_reflectionPipeline.pipeline.renderer;
    const {makeCloudShadowMap}=await import('/engine/cloud_shadow_map.js?contract='+Date.now());
    const light=T.uniform(new T.Vector3(.8,.08,.59).normalize()),time=T.uniform(0),value=T.uniform(.2),drift=T.uniform(new T.Vector3());
    const camera=new T.PerspectiveCamera();camera.position.set(0,2,0);camera.updateMatrixWorld(true);
    const map=makeCloudShadowMap(T,{transmittance:()=>value,lightDirection:light,time,displacement:drift,resolution:64});
    const target=new T.RenderTarget(1,1,{type:T.FloatType,depthBuffer:false}),material=new T.MeshBasicNodeMaterial();
    material.fragmentNode=T.vec4(T.vec3(map.sample(T.vec3(0))),1);
    const quad=new T.QuadMesh(material),saved=T.RendererUtils.saveRendererState(r),samples=[];
    const sample=async label=>{r.setMRT(null);r.setRenderTarget(target);await quad.renderAsync(r);samples.push({label,time:time.value,value:(await r.readRenderTargetPixelsAsync(target,0,0,1,1))[0]});};
    try{
        await map.prepare(r,camera,true);await sample('initial');
        time.value=.1;value.value=.8;await map.prepare(r,camera);await sample('new capture published');
        time.value=.15;await sample('halfway');
        time.value=.2;await sample('settled');
        const expected=[.2,.2,.5,.8];return{passed:samples.every((s,i)=>Math.abs(s.value-expected[i])<.003),samples};
    }finally{T.RendererUtils.restoreRendererState(r,saved);map.dispose();target.dispose();material.dispose();}
})()
