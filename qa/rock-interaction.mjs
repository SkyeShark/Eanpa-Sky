import { connect } from './cdp.mjs';
import { mkdir, writeFile } from 'node:fs/promises';
const cdp=await connect();
try{
    const result=await cdp.evaluate(`(async()=>{
        _eanpaTest.paused=false;_eanpaTest.pauseAfterFrame=true;
        while(!_eanpaTest.paused)await new Promise(r=>setTimeout(r,10));
        const diagnostic=_vegetation.diagnostics.collision;
        const candidates=[..._terrain.rockCollisionPlacements]
            .filter(r=>r.boundsRadius<9&&Math.abs(r.x)<180&&Math.abs(r.z)<180)
            .sort((a,b)=>Math.hypot(a.x,a.z-96)-Math.hypot(b.x,b.z-96));
        let chosen;
        for(const r of candidates){
            diagnostic.forceRefresh(r,_sky.uniforms.time.value);
            const top=_vegetation.walkSurfaceAt(r.x,r.z,Infinity),ground=_terrain.heightAt(r.x,r.z);
            if(top&&top.height>ground+.6&&top.height<ground+4){chosen={...r,top:top.height,ground};break;}
        }
        if(!chosen)throw new Error('No suitable actual rock landing target');
        _c.position.set(chosen.x,chosen.top+1.82+2,chosen.z);
        Object.assign(_movementState,{physicalEyeY:_c.position.y,verticalVelocity:0,grounded:false,bobOffset:0,stepViewOffset:0});
        _look.pitch=-.72;_look.yaw=0;_look.vpitch=0;_look.vyaw=0;
        _eanpaTest.pauseAfterFrame=false;_eanpaTest.paused=false;
        await new Promise(r=>setTimeout(r,1800));
        const feet=_movementState.physicalEyeY-_movementState.eyeHeight;
        if(!_movementState.grounded||Math.abs(feet-chosen.top)>.08)throw new Error('Rock landing failed: '+JSON.stringify({feet,chosen}));
        return {chosen,feet,grounded:_movementState.grounded,collision:diagnostic.state};
    })()`);
    await mkdir('artifacts/overhaul',{recursive:true});
    await writeFile('artifacts/overhaul/rock-interaction.json',JSON.stringify(result,null,2));
    const shot=await cdp.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
    await writeFile('artifacts/overhaul/rock-landing.png',Buffer.from(shot.data,'base64'));
    console.log(JSON.stringify(result,null,2));
}finally{await cdp.evaluate('_eanpaTest.paused=false').catch(()=>{});cdp.close();}
