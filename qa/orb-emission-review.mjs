import{connect}from'./cdp.mjs';import{mkdir,writeFile}from'node:fs/promises';
const c=await connect(),results=[];
try{
    await c.evaluate(`(()=>{_eanpaTest.pauseAfterFrame=false;_eanpaTest.paused=false;_flashlight.setEnabled(false);
        for(const[id,value]of [['weather','darkstorm'],['tod','10.5']]){const e=document.getElementById(id);e.value=value;e.dispatchEvent(new Event(id==='tod'?'input':'change',{bubbles:true}))}
        __eanpaWeatherByScene.get(_c.parent).setWeather('darkstorm');})()`);
    await new Promise(r=>setTimeout(r,6000));
    await mkdir('artifacts/feedback-20260908',{recursive:true});
    for(const name of ['light','light.001']){
        const state=await c.evaluate(`(async()=>{
            _eanpaTest.pauseAfterFrame=true;while(!_eanpaTest.paused)await new Promise(r=>setTimeout(r,10));
            const orb=_c.parent.getObjectByName('authored_inanna_orb_pivot');orb.updateWorldMatrix(true,true);
            const center=new THREE.Box3().setFromObject(orb).getCenter(new THREE.Vector3());let source;
            orb.traverse(o=>{if(o.material?.name===${JSON.stringify(name)})source=o});
            if(!source)throw new Error('Missing authored emitter');source.geometry.computeBoundingBox();
            const target=source.geometry.boundingBox.getCenter(new THREE.Vector3()).applyMatrix4(source.matrixWorld);
            _c.position.copy(center).add(target.clone().sub(center).normalize().multiplyScalar(6.2));
            _c.lookAt(target);_c.fov=52;_c.updateProjectionMatrix();_c.updateMatrixWorld(true);
            _look.pitch=_c.rotation.x;_look.yaw=_c.rotation.y;
            const r=_reflectionPipeline.pipeline.renderer,w=__eanpaWeatherByScene.get(_c.parent),t=_sky.uniforms.time.value;
            _sky.update(t,_c);w.update(t,_c);await w.prepareFrame(r,_c,{force:true});await _sky.prepareCloudShadows(r,_c,true);await _spatialClouds?.render();
            for(let i=0;i<12;i++){await new Promise(requestAnimationFrame);await _reflectionPipeline.render()}
            return{material:source.material.name,color:source.material.emissive.getHexString(),intensity:source.material.emissiveIntensity,
                nightLevel:_temple.nightLevel,hours:document.getElementById('tod').value,weather:w.state.name,
                camera:_c.position.toArray(),target:target.toArray(),pointerLocked:!!document.pointerLockElement};
        })()`);
        const shot=await c.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
        await writeFile(`artifacts/feedback-20260908/orb-${name==='light'?'red':'blue'}.png`,Buffer.from(shot.data,'base64'));
        results.push(state);
    }
    await writeFile('artifacts/feedback-20260908/orb-colors.json',JSON.stringify(results,null,2));console.log(JSON.stringify(results));
}finally{c.close()}
