// Accelerated simulation of every weather and cloud transition. This catches
// graph/lifecycle failures; the separate real-time transition measures hitches.
import {connect} from './cdp.mjs';
import {mkdir,writeFile} from 'node:fs/promises';
const c=await connect(),results=[];
try{
    await c.evaluate(`(async()=>{if(!__skyFixture?.ready)throw new Error('Fixture not ready');
        if(!_eanpaTest.paused){_eanpaTest.pauseAfterFrame=true;while(!_eanpaTest.paused)await new Promise(r=>setTimeout(r,10));}})()`);
    const cases=await c.evaluate(`Object.keys(__skyFixture.weather.WEATHER).map(name=>({axis:'weather',name}))
        .concat(['clear','cumulus','stratus','cirrus'].map(name=>({axis:'cloud',name})))`);
    for(const item of cases){
        const result=await c.evaluate(`(async()=>{
            const f=__skyFixture,w=f.weather,u=f.sky.uniforms,item=${JSON.stringify(item)};
            if(item.axis==='cloud')w.setWeather('none');
            const start=f.time,phase=u.cloudDisplacement.value.clone(),wall=performance.now();
            if(item.axis==='weather')w.transitionTo(item.name,1,45);else f.active.setCloudPreset(item.name);
            const initialShift=phase.distanceTo(u.cloudDisplacement.value),durations=[];
            let backwards=0,maxStep=0,last=u.cloudDisplacement.value.clone();
            for(let i=1;i<=182;i++){
                await new Promise(requestAnimationFrame);const before=performance.now();await f.frame(start+i*.25);
                durations.push(performance.now()-before);const next=u.cloudDisplacement.value;
                if(next.x<last.x-1e-6||next.z<last.z-1e-6)backwards++;
                maxStep=Math.max(maxStep,last.distanceTo(next));last.copy(next);
            }
            durations.sort((a,b)=>a-b);
            return{...item,initialShift,backwards,maxStep,transition:{...w.diagnostics.transition},
                cloudTransition:f.sky.cloudTransitionInfo,elapsedWallSeconds:(performance.now()-wall)/1000,
                p95CpuSubmitMs:durations[Math.floor(durations.length*.95)],maxCpuSubmitMs:durations.at(-1),errors:[...f.errors],
                pass:initialShift===0&&backwards===0&&maxStep<100&&!w.diagnostics.transition.active&&!f.errors.length};
        })()`);
        results.push(result);console.log(JSON.stringify(result));
    }
    const metadata=await c.evaluate(`({sky:__skyFixture.kind,quality:__skyFixture.tier,pointerLocked:!!document.pointerLockElement})`);
    await mkdir('artifacts/feedback-20260909',{recursive:true});
    await writeFile(`artifacts/feedback-20260909/${metadata.sky}-all-transitions.json`,JSON.stringify({
        date:new Date().toISOString(),...metadata,method:'45.5 simulated seconds per case in 182 rendered frames; not a real-time frame pacing benchmark',
        pass:results.every(r=>r.pass)&&!metadata.pointerLocked,results},null,2));
    if(results.some(r=>!r.pass))process.exitCode=1;
}finally{c.close()}
