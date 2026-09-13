// One fresh, matched run in the existing owned browser. No runtime tuning.
// Usage: node qa/performance-comparison-run.mjs balanced|performance native|limited|gpu 1 [revision] [series] [label]
import {connect} from './cdp.mjs';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
const [tier,level,repeat='1',revision='current',series='performance-balanced-20260912',label=tier]=process.argv.slice(2);
if(!['balanced','performance'].includes(tier)||!['native','limited','gpu'].includes(level)||!/^\d+$/.test(repeat))throw Error('Invalid comparison run');
if((revision!=='current'&&!/^[a-f0-9]{7,40}$/i.test(revision))||![series,label].every(s=>/^[a-z0-9_-]+$/i.test(s)))throw Error('Invalid revision, series or label');
const run=promisify(execFile),name=`${series}-${label}-r${repeat}`;
const child=async(file,args)=>run(process.execPath,[file,...args],{windowsHide:true,maxBuffer:16e6});
const c=await connect();
try{
    await c.send('Emulation.setDeviceMetricsOverride',{width:1920,height:1080,deviceScaleFactor:1,mobile:false});
    const loaded=JSON.parse((await child('qa/compare-cloud-revision.mjs',[revision,tier,'rain','earth'])).stdout.trim());
    console.log(JSON.stringify(loaded));
    if(loaded.source!==revision)throw Error('Loaded source revision differs from requested revision');
    const initial=await c.evaluate(`(()=>{
        const f=__skyFixture;
        f.active.setTime(11);f.weather.setWeather('rain');
        f.weather.uniforms.wetness.value=f.weather.uniforms.wetTarget.value;
        f.weather.uniforms.surfaceWater.value=Math.pow(f.weather.uniforms.wetTarget.value,1.8);
        f.cameraMotionStartTime=f.time;f.animateCamera=true;
        return {time:f.time,completedFrames:_eanpaTest.completedFrames,captures:f.spatial.captureStats?.captures??0};
    })()`);
    // Real time only: accelerating then returning to the RAF clock changes
    // capture deadlines and wind integration, invalidating the comparison.
    console.log(JSON.stringify({stage:'real-time warmup',tier,level,seconds:30}));
    await new Promise(r=>setTimeout(r,30000));
    const warmup=await c.evaluate(`(()=>{
        const f=__skyFixture;
        return {time:f.time,completedFrames:_eanpaTest.completedFrames,captures:f.spatial.captureStats?.captures??0,
            errors:f.errors,weather:f.weather.state.name,rain:f.weather.uniforms.rainK.value,wetness:f.weather.uniforms.wetness.value};
    })()`);
    if(warmup.errors.length||warmup.time-initial.time<29)throw Error('Invalid warmup: '+JSON.stringify(warmup));
    const workloadPath=`.artifacts/${series}/gpu-workload.json`;
    if(level==='limited'){
        const saved=await readFile(workloadPath,'utf8').catch(e=>{if(e.code==='ENOENT')return null;throw e;});
        if(saved){const {iterations}=JSON.parse(saved);await c.evaluate(`__fixedGpuContentionIterations=${Number(iterations)};`);}
    }
    console.log(JSON.stringify({stage:'measuring',tier,level,warmup}));
    let path,gpuHardwareBefore=null,gpuHardwareAfter=null,gpuResources=null;
    const hardware=async()=>(await run('nvidia-smi',[
        '--query-gpu=name,driver_version,memory.used,utilization.gpu,temperature.gpu,clocks.current.graphics,power.draw',
        '--format=csv,noheader,nounits'],{windowsHide:true})).stdout.trim();
    if(level==='gpu'){
        const resources=async count=>JSON.parse((await run('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',
            fileURLToPath(new URL('./resource-check.ps1',import.meta.url)),'-SampleCount',String(count)],{windowsHide:true,maxBuffer:4e6})).stdout);
        const before=await resources(3),during=resources(30);
        gpuHardwareBefore=await hardware();
        await c.evaluate('__skyFixture.cameraMotionStartTime=__skyFixture.time;__skyFixture.animateCamera=true;__skyFixture.nextEnvironmentAt=__skyFixture.time+15;');
        console.log((await child('qa/gpu-profile.mjs',[name,'600','30'])).stdout.trim());
        gpuHardwareAfter=await hardware();
        gpuResources={before,during:await during};
        path=`artifacts/overhaul/benchmarks/${name}-gpu.json`;
    }else{
        await child('qa/sky-benchmark.mjs',[name,level,'30']);
        path=`artifacts/feedback-20260909/benchmarks/${name}-${level}.json`;
    }
    const result=JSON.parse(await readFile(path,'utf8'));
    const finalState=await c.evaluate('({errors:[...__skyFixture.errors],quality:__skyFixture.quality,mode:__skyFixture.spatial.mode,cloudShadows:__skyFixture.sky.cloudShadowMap.stats,surface:__skyFixture.weather.surfaceField.stats})');
    result.comparison={series,label,revision,loaded,finalState,gpuHardwareBefore,gpuHardwareAfter,gpuResources,
        gpuHardwareCsvColumns:'name,driver_version,memory.used MiB,utilization.gpu %,temperature.gpu C,clocks.current.graphics MHz,power.draw W',
        warmupSeconds:30,measurementSeconds:30,initial,warmup,repeat:Number(repeat),
        motion:'Same orbit phase at measurement start; 30 seconds real-time camera and weather warmup; no clock acceleration.'};
    await writeFile(path,JSON.stringify(result,null,2));
    await mkdir(`.artifacts/${series}`,{recursive:true});
    if(level==='limited')await writeFile(workloadPath,JSON.stringify({iterations:result.constraints.iterations,
        note:'One calibrated workload reused across both tiers and repeat order; timestamp samples retain clock-dependent runtime drift.'},null,2));
    if(finalState.errors.length)throw Error('Runtime errors: '+JSON.stringify(finalState.errors));
    if(level==='gpu')console.log(JSON.stringify({path,label,summary:result.summary,captures:result.cloudCapturesDuringRun}));
    else console.log(JSON.stringify({path,label,tier,level,fps:result.fps,meanMs:1000/result.fps,p95Ms:result.p95Ms,
        cloudCaptures:result.cloudDisplay.capturesDuringRun,environment:result.environment,
        cleanCpu:result.cleanCpuWindow,cleanGpu:result.cleanGpuWindow,errors:result.errors}));
}finally{await c.evaluate('if(globalThis.__skyFixture)__skyFixture.animateCamera=false;delete globalThis.__fixedGpuContentionIterations;').catch(()=>{});c.close();}
