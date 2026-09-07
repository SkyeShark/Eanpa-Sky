// Exercise the real 45-second user transition, including its scheduled IBL
// refreshes. This is separate from steady-state throughput and look captures.
import {connect} from './cdp.mjs';
import {writeFile,mkdir} from 'node:fs/promises';
const c=await connect(),samples=[];
try{
    await c.evaluate(`(()=>{
        _eanpaTest.pauseAfterFrame=false;_eanpaTest.paused=false;
        const w=__eanpaWeatherByScene.get(_c.parent);w.setWeather('none');
        document.getElementById('weather').value='none';
    })()`);
    await new Promise(r=>setTimeout(r,4000));
    const sky=await c.evaluate("document.getElementById('skybox').value");
    await c.evaluate(`(()=>{
        _benchmark.start({purpose:'Actual 45-second weather transition',sky:${JSON.stringify(sky)}});
        const e=document.getElementById('weather');e.value='rain';e.dispatchEvent(new Event('change',{bubbles:true}));
    })()`);
    const start=Date.now();
    for(let step=0;step<11;step++){
        await new Promise(r=>setTimeout(r,5000));
        samples.push(await c.evaluate(`({wallSeconds:${(Date.now()-start)/1000},
            transition:__eanpaWeatherByScene.get(_c.parent).diagnostics.transition,
            wetness:_weather.uniforms.wetness.value,water:_weather.uniforms.surfaceWater.value,
            rain:_weather.uniforms.rainK.value,completedFrames:_eanpaTest.completedFrames,
            errors:[...document.body.children].filter(e=>e.style?.zIndex==='99').map(e=>e.textContent).filter(Boolean),
            pointerLocked:!!document.pointerLockElement})`));
        if(step>=8&&!samples.at(-1).transition.active)break;
    }
    const frames=await c.evaluate('_benchmark.stop()');
    const last=samples.at(-1);
    const pass=!last.transition.active&&last.rain>.5&&samples.every(s=>!s.errors.length&&!s.pointerLocked);
    await mkdir('artifacts/overhaul/transitions',{recursive:true});
    await writeFile(`artifacts/overhaul/transitions/${sky}-rain.json`,JSON.stringify({pass,samples,frames},null,2));
    console.log(JSON.stringify({sky,pass,last,frameIntervalMs:frames.frameIntervalMs}));
    if(!pass)process.exitCode=1;
}finally{c.close();}
