import {connect} from './cdp.mjs';
import {mkdir,writeFile} from 'node:fs/promises';
const [name='fixture-look',hours='11',cloud='cumulus',pose='ring']=process.argv.slice(2);
if(!/^[a-z0-9_-]+$/i.test(name)||!['ring','overhead','reverse','star','starclose','ground'].includes(pose))throw new Error('Invalid view');
const c=await connect();
try{
    const metadata=await c.evaluate(`(async()=>{
        const f=__skyFixture;if(!f?.ready)throw new Error('Fixture not ready');
        if(!_eanpaTest.paused){_eanpaTest.pauseAfterFrame=true;while(!_eanpaTest.paused)await new Promise(r=>setTimeout(r,10));}
        const pose=${JSON.stringify(pose)},cloud=${JSON.stringify(cloud)};
        f.active.setTime(${Number(hours)});f.weather.setWeather('none');f.sky.setClouds(cloud);
        const camera=f.camera;camera.position.set(0,1.82,96);camera.rotation.order='YXZ';
        camera.fov=pose==='starclose'?34:62;
        if(pose.startsWith('star'))camera.lookAt(camera.position.clone().addScaledVector(f.sky.sunDir,1000));
        else camera.rotation.set(({ring:.55,overhead:1.3,reverse:.28,ground:-.2})[pose],pose==='reverse'?Math.PI:0,0,'YXZ');
        camera.updateProjectionMatrix();camera.updateMatrixWorld(true);
        f.nextEnvironmentAt=f.time;await new Promise(requestAnimationFrame);await f.frame(f.time+1/60);
        await f.sky.prepareCloudShadows(f.renderer,camera,true);
        for(let i=0;i<8;i++){await new Promise(requestAnimationFrame);await f.frame(f.time+1/60);}
        return{date:new Date().toISOString(),sky:f.kind,quality:f.tier,hours:${Number(hours)},cloud,pose,
            time:f.time,camera:camera.position.toArray(),fov:camera.fov,errors:[...f.errors],pointerLocked:!!document.pointerLockElement};
    })()`);
    await mkdir('artifacts/feedback-20260909',{recursive:true});
    const shot=await c.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
    await writeFile(`artifacts/feedback-20260909/${name}.png`,Buffer.from(shot.data,'base64'));
    await writeFile(`artifacts/feedback-20260909/${name}.json`,JSON.stringify(metadata,null,2));console.log(JSON.stringify(metadata));
}finally{c.close()}
