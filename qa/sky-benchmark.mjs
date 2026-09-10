import {connect} from './cdp.mjs';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
const [name='fixture',level='native',seconds='15']=process.argv.slice(2);
const levels={native:{cpu:1,gpu:0},moderate:{cpu:2,gpu:4},limited:{cpu:4,gpu:8}};
if(!/^[a-z0-9_-]+$/i.test(name)||!levels[level]||Number(seconds)<5||Number(seconds)>60)throw new Error('Invalid benchmark arguments');
const c=await connect(),run=promisify(execFile),profile=levels[level];
const resources=async count=>JSON.parse((await run('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',
    fileURLToPath(new URL('./resource-check.ps1',import.meta.url)),'-SampleCount',String(count)],{windowsHide:true,maxBuffer:4e6})).stdout);
try{
    if(!await c.evaluate('globalThis.__skyFixture?.ready===true'))throw new Error('Wait for the engine fixture to finish loading');
    await c.evaluate('_eanpaTest.pauseAfterFrame=false;_eanpaTest.paused=false;');
    await c.send('Emulation.setCPUThrottlingRate',{rate:profile.cpu});
    if(profile.gpu){await c.evaluate(`__requestedGpuContentionMs=${profile.gpu};__gpuContentionPipelined=true;`);
        await c.evaluate(await readFile('qa/gpu-contention.js','utf8'));}
    await new Promise(done=>setTimeout(done,2500));
    const before=await resources(3),during=resources(Number(seconds));
    await c.evaluate(`(()=>{
        const f=__skyFixture,old=f.frame,starts=[],ends=[],completed=[];
        f.animateCamera=true;
        const wrapper=async function(...args){const start=performance.now();starts.push(start);const value=await old.apply(this,args);
            ends.push(performance.now()-start);this.renderer.backend.device.queue.onSubmittedWorkDone().then(()=>completed.push(performance.now()));return value;};
        f.frame=wrapper;globalThis.__fixtureCapture={starts,ends,completed,stop(){if(f.frame===wrapper)f.frame=old;f.animateCamera=false;}};
    })()`);
    await new Promise(done=>setTimeout(done,Number(seconds)*1000));
    const result=await c.evaluate(`(async()=>{
        const f=__skyFixture,c=__fixtureCapture;c.stop();await f.renderer.backend.device.queue.onSubmittedWorkDone();
        const intervals=c.starts.slice(1).map((v,i)=>v-c.starts[i]);const sorted=[...intervals].sort((a,b)=>a-b);
        const cpu=[...c.ends].sort((a,b)=>a-b),n=sorted.length;
        return {date:new Date().toISOString(),kind:f.kind,tier:f.tier,weather:f.weather.state.name,scope:'reusable sky/weather/ground effects with six generic host meshes; no demo assets',
            size:[f.renderer.domElement.width,f.renderer.domElement.height],movingCamera:true,frames:n,
            fps:n*1000/intervals.reduce((a,b)=>a+b,0),medianMs:sorted[Math.floor(n*.5)],p95Ms:sorted[Math.floor(n*.95)],maxMs:sorted.at(-1),
            completedFps:(c.completed.length-1)*1000/(c.completed.at(-1)-c.completed[0]),
            cpuAndSubmitMedianMs:cpu[Math.floor(cpu.length*.5)],intervalsMs:intervals,errors:[...f.errors],
            constraints:globalThis.__gpuContention?.metadata??null,cloudShadows:f.sky.cloudShadowMap.stats,
            surface:f.weather.surfaceField?.stats??null,quality:f.quality,geometry:f.pipeline.ssrImplementation};
    })()`);
    result.profile={name:level,...profile};result.resources={before,during:await during};
    result.cleanCpuWindow=before.cpu.clean&&result.resources.during.cpu.clean;
    result.cleanGpuWindow=before.clean&&result.resources.during.clean;
    result.interpretation=level==='native'?'Local GPU at its current clocks; browser CPU unthrottled.':'Synthetic available-resource stress, not emulation or an FPS prediction for a named lower-end device. GPU work is calibrated in milliseconds, with two submissions allowed in flight.';
    await mkdir('artifacts/feedback-20260909/benchmarks',{recursive:true});
    await writeFile(`artifacts/feedback-20260909/benchmarks/${name}-${level}.json`,JSON.stringify(result,null,2));
    const {intervalsMs,resources:rawResources,quality,constraints,...summary}=result;
    console.log(JSON.stringify({...summary,gpuCalibration:constraints?.calibration,runtimeGpuMs:constraints?.runtimeSamples?.map(s=>s.ms)},null,2));
}finally{
    await c.evaluate('globalThis.__fixtureCapture?.stop();globalThis.__gpuContention?.stop();').catch(()=>{});
    await c.send('Emulation.setCPUThrottlingRate',{rate:1}).catch(()=>{});c.close();
}
