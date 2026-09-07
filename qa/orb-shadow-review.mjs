// Matched views of a local metallic receiver and its emissive accents.
import {connect} from './cdp.mjs';
import {writeFile,mkdir} from 'node:fs/promises';
const c=await connect();
try{
    await c.evaluate(`(async()=>{
        _eanpaTest.pauseAfterFrame=true;_eanpaTest.paused=false;
        while(!_eanpaTest.paused)await new Promise(r=>setTimeout(r,20));
        const orb=_c.parent.getObjectByName('authored_inanna_orb_pivot');
        const center=new THREE.Box3().setFromObject(orb).getCenter(new THREE.Vector3());
        _c.position.copy(center).add(new THREE.Vector3(5,4,6));_c.fov=52;_c.lookAt(center);
        _c.updateProjectionMatrix();_c.updateMatrixWorld(true);
        const t=205.77,r=_reflectionPipeline.pipeline.renderer,w=__eanpaWeatherByScene.get(_c.parent);
        w.setWeather('none');w.uniforms.wetness.value=0;w.uniforms.surfaceWater.value=0;
        _sky.update(t,_c);w.update(t,_c);globalThis._ringworld?.update(t);await globalThis._ringworld?.prepareFrame(r);
        await w.prepareFrame(r,_c,{force:true});await _sky.prepareCloudShadows(r,_c,true);await _spatialClouds.render();
        _reflectionPipeline.setAuditContributions();
        for(let i=0;i<12;i++){await new Promise(requestAnimationFrame);await _reflectionPipeline.render()}
    })()`);
    await mkdir('artifacts/overhaul/shadows',{recursive:true});
    for(const strength of [0,1]){
        await c.evaluate(`(async()=>{_sky.uniforms.cloudShadowStrength.value=${strength};
            for(let i=0;i<4;i++){await new Promise(requestAnimationFrame);await _reflectionPipeline.render()}})()`);
        const shot=await c.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
        await writeFile(`artifacts/overhaul/shadows/orb-final-${strength}.png`,Buffer.from(shot.data,'base64'));
    }
    const result=await c.evaluate(`({date:new Date().toISOString(),sky:document.getElementById('skybox').value,
        camera:_c.position.toArray(),time:_sky.uniforms.time.value,mode:_reflectionPipeline.mode,
        errors:[...document.body.children].filter(e=>e.style?.zIndex==='99').map(e=>e.textContent).filter(Boolean),
        pointerLocked:!!document.pointerLockElement})`);
    await writeFile('artifacts/overhaul/shadows/orb-final.json',JSON.stringify(result,null,2));
    console.log(JSON.stringify(result));if(result.errors.length||result.pointerLocked)process.exitCode=1;
}finally{await c.evaluate('_sky.uniforms.cloudShadowStrength.value=1').catch(()=>{});c.close()}
