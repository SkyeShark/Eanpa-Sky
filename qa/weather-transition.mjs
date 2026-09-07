// Exercise the real 45-second user transition, including its scheduled IBL
// refreshes. This is separate from steady-state throughput and look captures.
import {connect} from './cdp.mjs';
import {writeFile,mkdir} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
const label=process.argv[2]??'';
if(label&&!/^[a-z0-9_-]+$/i.test(label))throw new Error('Invalid capture label');
const revision=execFileSync('git',['-c',`safe.directory=${process.cwd().replaceAll('\\','/')}`,'rev-parse','HEAD'],{encoding:'utf8'}).trim();
const c=await connect(),samples=[];
try{
    await c.evaluate(`(()=>{
        _eanpaTest.pauseAfterFrame=false;_eanpaTest.paused=false;
        const w=__eanpaWeatherByScene.get(_c.parent);w.setWeather('none');
        document.getElementById('weather').value='none';
        globalThis._transitionCosts={};globalThis._transitionRestores=[];
        const hook=(owner,key,name)=>{
            if(!owner?.[key])return;
            const original=owner[key],s=_transitionCosts[name]={calls:0,maxMs:0,slowCalls:[]};
            owner[key]=async function(...args){
                const started=performance.now();
                try{return await original.apply(this,args)}finally{
                    const ms=performance.now()-started;s.calls++;s.maxMs=Math.max(s.maxMs,ms);
                    if(ms>12)s.slowCalls.push({ms,time:_sky.uniforms.time.value,rain:w.uniforms.rainK.value});
                }
            };
            _transitionRestores.push(()=>{owner[key]=original});
        };
        hook(w,'prepareFrame','rain');hook(_reflectionPipeline,'render','reflections');
        hook(globalThis._spatialClouds,'render','spatialClouds');hook(_sky,'prepareCloudShadows','cloudShadows');
        const p=GPUDevice.prototype;
        for(const key of ['createRenderPipeline','createRenderPipelineAsync']){
            const original=p[key],s=_transitionCosts[key]={calls:0,builds:[]};
            p[key]=function(...args){
                const started=performance.now(),stage=globalThis._frameStage;
                const done=()=>{s.calls++;s.builds.push({ms:performance.now()-started,stage,label:args[0]?.label??'',time:_sky.uniforms.time.value})};
                const result=original.apply(this,args);
                if(key.endsWith('Async'))return result.finally(done);
                done();return result;
            };
            _transitionRestores.push(()=>{p[key]=original});
        }
    })()`);
    await new Promise(r=>setTimeout(r,4000));
    const sky=await c.evaluate("document.getElementById('skybox').value");
    const initial=await c.evaluate(`({quality:document.getElementById('quality').value,
        clouds:document.getElementById('cloud-type').value,camera:_c.position.toArray(),
        wetness:_weather.uniforms.wetness.value,water:_weather.uniforms.surfaceWater.value,
        warmup:globalThis._shaderWarmupStats,surfaceCapture:{...__eanpaWeatherByScene.get(_c.parent).surfaceField.stats}})`);
    await c.evaluate(`(()=>{
        _benchmark.start({purpose:'Actual 45-second weather transition',sky:${JSON.stringify(sky)},revision:${JSON.stringify(revision)}});
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
    const costs=await c.evaluate('_transitionCosts'),rainCapture=costs.rain;
    const last=samples.at(-1);
    const pass=!last.transition.active&&last.rain>.5&&samples.every(s=>!s.errors.length&&!s.pointerLocked);
    const responsivenessPass=frames.frameIntervalMs.max<250&&frames.frameIntervalMs.p99<50;
    await mkdir('artifacts/overhaul/transitions',{recursive:true});
    await writeFile(`artifacts/overhaul/transitions/${sky}-rain${label?'-'+label:''}.json`,JSON.stringify({pass,responsivenessPass,
        responsivenessBudgetMs:{max:250,p99:50},initial,samples,frames,rainCapture,costs},null,2));
    const costSummary=Object.fromEntries(Object.entries(costs).map(([key,value])=>[key,value.builds
        ?{calls:value.calls,slowest:value.builds.toSorted((a,b)=>b.ms-a.ms).slice(0,4)}
        :{calls:value.calls,maxMs:value.maxMs,slowCount:value.slowCalls.length,
            slowest:value.slowCalls.toSorted((a,b)=>b.ms-a.ms).slice(0,3)}]));
    console.log(JSON.stringify({sky,pass,responsivenessPass,last,frameIntervalMs:frames.frameIntervalMs,costs:costSummary}));
    if(!pass)process.exitCode=1;
}finally{
    await c.evaluate(`(()=>{for(const restore of globalThis._transitionRestores??[])restore();delete globalThis._transitionRestores;})()`).catch(()=>{});
    c.close();
}
