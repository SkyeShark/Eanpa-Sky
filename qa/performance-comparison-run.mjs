// One fresh, matched run in the existing owned browser. No runtime tuning.
// Usage: node qa/performance-comparison-run.mjs balanced|performance native|limited|gpu 1
import {connect} from './cdp.mjs';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
const [tier,level,repeat='1']=process.argv.slice(2);
if(!['balanced','performance'].includes(tier)||!['native','limited','gpu'].includes(level)||!/^\d+$/.test(repeat))throw Error('Invalid comparison run');
const run=promisify(execFile),name=`performance-balanced-20260912-${tier}-r${repeat}`;
const child=async(file,args)=>run(process.execPath,[file,...args],{windowsHide:true,maxBuffer:16e6});
const c=await connect();
try{
    await c.send('Emulation.setDeviceMetricsOverride',{width:1920,height:1080,deviceScaleFactor:1,mobile:false});
    console.log((await child('qa/compare-cloud-revision.mjs',['current',tier,'rain','earth'])).stdout.trim());
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
    const workloadPath='.artifacts/performance-balanced-20260912/gpu-workload.json';
    if(level==='limited'){
        const saved=await readFile(workloadPath,'utf8').catch(e=>{if(e.code==='ENOENT')return null;throw e;});
        if(saved){const {iterations}=JSON.parse(saved);await c.evaluate(`__fixedGpuContentionIterations=${Number(iterations)};`);}
    }
    console.log(JSON.stringify({stage:'measuring',tier,level,warmup}));
    let path;
    if(level==='gpu'){
        await c.evaluate('__skyFixture.cameraMotionStartTime=__skyFixture.time;__skyFixture.animateCamera=true;__skyFixture.nextEnvironmentAt=__skyFixture.time+15;');
        console.log((await child('qa/gpu-profile.mjs',[name,'600','30'])).stdout.trim());
        path=`artifacts/overhaul/benchmarks/${name}-gpu.json`;
    }else{
        await child('qa/sky-benchmark.mjs',[name,level,'30']);
        path=`artifacts/feedback-20260909/benchmarks/${name}-${level}.json`;
    }
    const result=JSON.parse(await readFile(path,'utf8'));
    result.comparison={warmupSeconds:30,measurementSeconds:30,initial,warmup,repeat:Number(repeat),
        motion:'Same orbit phase at measurement start; 30 seconds real-time camera and weather warmup; no clock acceleration.'};
    await writeFile(path,JSON.stringify(result,null,2));
    await mkdir('.artifacts/performance-balanced-20260912',{recursive:true});
    if(level==='limited')await writeFile(workloadPath,JSON.stringify({iterations:result.constraints.iterations,
        note:'One calibrated workload reused across both tiers and repeat order; timestamp samples retain clock-dependent runtime drift.'},null,2));
    if(level==='gpu')console.log(JSON.stringify({path,summary:result.summary,captures:result.cloudCapturesDuringRun}));
    else console.log(JSON.stringify({path,tier,level,fps:result.fps,meanMs:1000/result.fps,p95Ms:result.p95Ms,
        cloudCaptures:result.cloudDisplay.capturesDuringRun,environment:result.environment,
        cleanCpu:result.cleanCpuWindow,cleanGpu:result.cleanGpuWindow,errors:result.errors}));
}finally{await c.evaluate('if(globalThis.__skyFixture)__skyFixture.animateCamera=false;delete globalThis.__fixedGpuContentionIterations;').catch(()=>{});c.close();}
