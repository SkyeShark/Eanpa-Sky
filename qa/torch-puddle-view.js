(async()=>{
    _eanpaTest.pauseAfterFrame=true;while(!_eanpaTest.paused)await new Promise(r=>setTimeout(r,10));
    const T=THREE,r=_reflectionPipeline.pipeline.renderer,w=__eanpaWeatherByScene.get(_c.parent);
    const saved=T.RendererUtils.saveRendererState(r),target=new T.RenderTarget(256,256,{type:T.FloatType,depthBuffer:true});
    const scene=new T.Scene(),camera=new T.OrthographicCamera(-40,40,40,-40,.1,200);
    camera.position.set(20,100,30);camera.up.set(0,0,-1);camera.lookAt(20,0,30);
    const material=new T.MeshBasicNodeMaterial();material.metalness=0;
    const response=w.getSurfaceNodes(_terrain.material);
    material.positionNode=_terrain.material.positionNode;
    material.fragmentNode=T.vec4(response.puddle,T.positionWorld.x,T.positionWorld.y,T.positionWorld.z);
    const mesh=new T.Mesh(_terrain.geometry,material);mesh.matrixAutoUpdate=false;
    mesh.matrix.copy(_terrain.matrixWorld);scene.add(mesh);
    let candidate=null;
    try{
        r.setMRT(null);r.setRenderTarget(target);await r.renderAsync(scene,camera);
        const pixels=await r.readRenderTargetPixelsAsync(target,0,0,256,256);
        for(let i=0;i<pixels.length;i+=4){
            if(pixels[i]<.98)continue;const p=Array.from(pixels.slice(i+1,i+4));
            const distance=Math.hypot(p[0]-_c.position.x,p[2]-_c.position.z);
            if(!candidate||distance<candidate.distance)candidate={p,distance,mask:pixels[i]};
        }
        if(!candidate)throw new Error('No fully filled puddle found in ground capture');
    }finally{T.RendererUtils.restoreRendererState(r,saved);target.dispose();material.dispose();}
    const p=candidate.p;_c.position.set(p[0],_terrain.heightAt(p[0],p[2]+3)+1.82,p[2]+3);
    _c.lookAt(...p);_c.updateMatrixWorld(true);_look.pitch=_c.rotation.x;_look.yaw=_c.rotation.y;
    _flashlight.setEnabled(true);
    await w.prepareFrame(r,_c,{force:true});
    for(let i=0;i<12;i++){await new Promise(requestAnimationFrame);await _reflectionPipeline.render()}
    return{candidate,camera:_c.position.toArray(),flashlight:_flashlight.state.enabled};
})()
