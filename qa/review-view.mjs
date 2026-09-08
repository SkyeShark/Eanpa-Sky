// Reproducible steady-state look review in the one owned page. This deliberately
// applies weather immediately; transition behavior is exercised separately.
import {connect} from './cdp.mjs';
import {mkdir,writeFile} from 'node:fs/promises';
const [name='review',cloud='cumulus',weather='none',hours='10.5',view='wide']=process.argv.slice(2);
if(!/^[a-z0-9_-]+$/i.test(name))throw new Error('Invalid artifact name');
const views={
    wide:{camera:[0,1.82,96],pitch:.16,yaw:0,fov:62},
    ring:{camera:[0,1.82,96],pitch:.55,yaw:0,fov:62},
    overhead:{camera:[0,1.82,96],pitch:1.3,yaw:0,fov:62},
    reverse:{camera:[0,1.82,96],pitch:.28,yaw:Math.PI,fov:62},
    roof:{camera:[8,23.754446588,-75],pitch:-.22,yaw:-Math.PI/2,fov:62},
    roofwide:{camera:[90,65,20],target:[0,12,-70],fov:62},
    terrain:{camera:[38,1.82,40],pitch:-.38,yaw:.45,fov:62},
    star:{camera:[0,1.82,96],sun:true,fov:52},
    starclose:{camera:[0,1.82,96],sun:true,fov:34},
    rainclose:{camera:[8,22.40,-75],pitch:-.48,yaw:-Math.PI/2,fov:62},
};
if(!views[view])throw new Error('Unknown view');
const c=await connect();
try{
    if(!await c.evaluate("document.getElementById('boot')?.style.display==='none'"))throw new Error('Wait for scene initialization before a look capture');
    await c.evaluate(`(()=>{
        _eanpaTest.pauseAfterFrame=false;_eanpaTest.paused=false;
        for(const [id,value]of ${JSON.stringify([['cloud-type',cloud],['weather',weather],['tod',hours]])}){
            const control=document.getElementById(id);
            if(control.value===String(value))continue;
            control.value=value;control.dispatchEvent(new Event('input',{bubbles:true}));
            control.dispatchEvent(new Event('change',{bubbles:true}));
        }
    })()`);
    await new Promise(r=>setTimeout(r,500));
    await c.evaluate(`(()=>{
        const w=globalThis.__eanpaWeatherByScene?.get(_c.parent);
        if(!w)throw new Error('Weather was not preloaded');
        w.setWeather(${JSON.stringify(weather)});
        w.uniforms.wetness.value=w.uniforms.wetTarget.value;
        w.uniforms.surfaceWater.value=Math.pow(w.uniforms.wetTarget.value,1.8);
    })()`);
    await new Promise(r=>setTimeout(r,4000));
    const state=await c.evaluate(`(async()=>{
        _eanpaTest.pauseAfterFrame=true;while(!_eanpaTest.paused)await new Promise(r=>setTimeout(r,20));
        const v=${JSON.stringify(views[view])};_c.position.fromArray(v.camera);_c.rotation.order='YXZ';
        if(v.sun)_c.lookAt(_c.position.clone().addScaledVector(_sky.sunDir,1000));
        else if(v.target)_c.lookAt(...v.target);else _c.rotation.set(v.pitch,v.yaw,0,'YXZ');
        _look.pitch=_c.rotation.x;_look.yaw=_c.rotation.y;_look.vpitch=0;_look.vyaw=0;
        Object.assign(_movementState,{physicalEyeY:_c.position.y,verticalVelocity:0,grounded:true,bobOffset:0,stepViewOffset:0});
        _c.fov=v.fov;_c.updateProjectionMatrix();_c.updateMatrixWorld(true);
        const t=_sky.uniforms.time.value,r=_reflectionPipeline.pipeline.renderer;
        const w=__eanpaWeatherByScene.get(_c.parent);
        _sky.update(t,_c);w.update(t,_c);globalThis._ringworld?.update(t);await globalThis._ringworld?.prepareFrame(r);
        await w.prepareFrame(r,_c,{force:true});await _sky.prepareCloudShadows(r,_c,true);
        await _spatialClouds?.render();
        for(let i=0;i<12;i++){await new Promise(requestAnimationFrame);await _reflectionPipeline.render();}
        const errors=[...document.body.children].filter(e=>e.style?.zIndex==='99').map(e=>e.textContent).filter(Boolean);
        if(errors.length||document.pointerLockElement)throw new Error(JSON.stringify(errors));
        return {date:new Date().toISOString(),steadyStateApplied:true,sky:document.getElementById('skybox').value,
            cloud:${JSON.stringify(cloud)},weather:${JSON.stringify(weather)},hours:${Number(hours)},
            camera:_c.position.toArray(),look:{pitch:_look.pitch,yaw:_look.yaw},time:t,
            wetness:w.uniforms.wetness.value,water:w.uniforms.surfaceWater.value,
            shadows:globalThis._cloudShadowStats,errors};
    })()`);
    await mkdir('artifacts/overhaul/look-review',{recursive:true});
    const path='artifacts/overhaul/look-review/'+name;
    const shot=await c.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
    await writeFile(path+'.png',Buffer.from(shot.data,'base64'));
    await writeFile(path+'.json',JSON.stringify(state,null,2));
    console.log(JSON.stringify(state));
}finally{c.close()}
