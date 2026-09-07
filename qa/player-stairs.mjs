import { connect } from './cdp.mjs';
import { writeFile } from 'node:fs/promises';
const cdp=await connect();
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const samples=[];
try {
    const route=await cdp.evaluate(`(() => {
        _inputState.keys.clear();
        const nav=_temple.group.userData.navigation;
        const start=_temple.group.localToWorld(new THREE.Vector3(0,0,nav.stairFrontZ+2));
        const end=_temple.group.localToWorld(new THREE.Vector3(0,0,nav.stairBackZ-1));
        const floor=Math.max(_terrain.heightAt(start.x,start.z),_temple.walkSurfaceAt(start.x,start.z)?.height??-Infinity);
        _c.position.set(start.x,floor+1.82,start.z);
        Object.assign(_movementState,{physicalEyeY:_c.position.y,verticalVelocity:0,grounded:true,bobOffset:0,stepViewOffset:0});
        _look.yaw=0;_look.pitch=.12;_look.vyaw=0;_look.vpitch=0;
        _eanpaTest.pauseAfterFrame=false;_eanpaTest.paused=false;
        return {start:start.toArray(),end:end.toArray(),nav};
    })()`);
    await sleep(1500);
    await cdp.evaluate(`_inputState.keys.add('KeyW');_inputState.keys.add('ShiftLeft');`);
    const deadline=Date.now()+30000;
    while(Date.now()<deadline){
        await sleep(150);
        const sample=await cdp.evaluate(`(() => {
            const p=_c.position,s=_temple.walkSurfaceAt(p.x,p.z);
            return {position:p.toArray(),feet:_movementState.physicalEyeY-_movementState.eyeHeight,
                floor:s?.height??_terrain.heightAt(p.x,p.z),kind:s?.kind,grounded:_movementState.grounded,
                speed:_movementState.horizontalSpeed,contact:_movementState.contact};
        })()`);
        samples.push(sample);
        if(sample.position[2]<=route.end[2])break;
    }
    await cdp.evaluate('_inputState.keys.clear()');await sleep(1500);
    const end=samples.at(-1);
    const landed=await cdp.evaluate(`({feet:_movementState.physicalEyeY-_movementState.eyeHeight,
        floor:_temple.walkSurfaceAt(_c.position.x,_c.position.z)?.height,grounded:_movementState.grounded})`);
    const pass=end.position[2]<=route.end[2]+.4 && end.feet>18
        && landed.grounded && Math.abs(landed.feet-landed.floor)<.08
        && samples.every(s=>Number.isFinite(s.feet)&&s.feet>=s.floor-.045);
    const result={pass,route,samples,landed};
    await writeFile('artifacts/overhaul/player-stairs.json',JSON.stringify(result,null,2));
    const shot=await cdp.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
    await writeFile('artifacts/overhaul/player-stairs.png',Buffer.from(shot.data,'base64'));
    console.log(JSON.stringify({pass,first:samples[0],last:end,landed,samples:samples.length}));
    if(!pass)process.exitCode=1;
} finally {
    await cdp.evaluate('_inputState.keys.clear();_eanpaTest.paused=false').catch(()=>{});cdp.close();
}
