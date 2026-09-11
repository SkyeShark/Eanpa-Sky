// Matched revision/ablation runs in the one owned browser. Old sources are
// substituted only in this CDP session; the working tree and server stay intact.
import {connect} from './cdp.mjs';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
const [name='comparison',variant='current',path='/?benchmark=1&automated=1&skybox=earth',seconds='12',rate='1']=process.argv.slice(2);
const origin='http://127.0.0.1:8378',url=new URL(path,origin),baseline='9a69e7cfa42ad659520e3e88705f8fdcffe4bc07';
if(!/^[a-z0-9_-]+$/i.test(name)||!['baseline','shadow','current'].includes(variant)||url.origin!==origin
    ||!['/','/qa/sky-fixture.html'].includes(url.pathname)||!(Number(seconds)>=5&&Number(seconds)<=30)
    ||!(Number(rate)>=1&&Number(rate)<=8))throw new Error('Invalid comparison arguments');
url.searchParams.set('automated','1');url.searchParams.set('benchmark','1');
const run=promisify(execFile),git=['-c',`safe.directory=${process.cwd().replaceAll('\\','/')}`];
const revision=(await run('git',[...git,'rev-parse','HEAD'],{windowsHide:true})).stdout.trim();
const engineFiles=['engine/sky_system.js','engine/weather_system.js','engine/cloud_shadow_map.js',
    'engine/rain_accumulation_field.js','engine/rain_surface_field.js','engine/weather_listener.js',
    'engine/ring_cloud_field.js','engine/ringworld.js','src/native_reflection_pipeline.js','src/local_reflection_probe.js'];
const files=variant==='baseline'?[...engineFiles,'vendor/three/three.webgpu.js']:variant==='shadow'?engineFiles:[];
const sources=new Map();for(const file of files){
    const {stdout}=await run('git',[...git,'show',baseline+':'+file],{encoding:'buffer',maxBuffer:10e6,windowsHide:true});
    sources.set('/'+file,stdout);
}
const c=await connect(),errors=[];let removeListener=null,resourcePromise=null;
const sourceSha256={};
for(const file of [...engineFiles,'vendor/three/three.webgpu.js']){
    const bytes=sources.get('/'+file)??await readFile(file);
    sourceSha256[file]=createHash('sha256').update(bytes).digest('hex');
}
const wait=ms=>new Promise(done=>setTimeout(done,ms));
try{
    await c.send('Emulation.setCPUThrottlingRate',{rate:1});
    if(files.length){
        removeListener=c.on('Fetch.requestPaused',async request=>{
            try{
                const body=sources.get(new URL(request.request.url).pathname);
                if(!body)return await c.send('Fetch.continueRequest',{requestId:request.requestId});
                await c.send('Fetch.fulfillRequest',{requestId:request.requestId,responseCode:200,
                    responseHeaders:[{name:'Content-Type',value:'text/javascript'},{name:'Cache-Control',value:'no-store'}],body:body.toString('base64')});
            }catch(error){errors.push(String(error));await c.send('Fetch.continueRequest',{requestId:request.requestId}).catch(()=>{});}
        });
        await c.send('Fetch.enable',{patterns:files.map(file=>({urlPattern:origin+'/'+file+'*',requestStage:'Request'}))});
    }
    const started=Date.now();await c.send('Page.navigate',{url:url.href});let previous='';
    while(true){
        if(Date.now()-started>360000)throw new Error('Scene initialization exceeded six minutes');
        const state=await c.evaluate(`({ready:document.getElementById('boot')?.style.display==='none'||globalThis.__skyFixture?.ready===true,
            progress:document.getElementById('boot')?.textContent??document.getElementById('progress')?.textContent,
            errors:[...document.body.children].find(e=>e.style?.zIndex==='99')?.textContent||document.getElementById('error')?.textContent||''})`).catch(()=>null);
        if(state?.errors)throw new Error(state.errors);if(errors.length)throw new Error(errors.join('\n'));
        if(state?.ready)break;if(state?.progress&&state.progress!==previous){previous=state.progress;console.log(previous);}
        await wait(1000);
    }
    const bootMs=Date.now()-started;
    await c.send('Emulation.setCPUThrottlingRate',{rate:Number(rate)});await wait(6000);
    await c.send('Performance.enable',{timeDomain:'threadTicks'});
    const metadata=await c.evaluate(`({url:location.href,canvas:[_reflectionPipeline.pipeline.renderer.domElement.width,_reflectionPipeline.pipeline.renderer.domElement.height],
        camera:_c.position.toArray(),fov:_c.getEffectiveFOV(),quality:document.getElementById('quality')?.value??__skyFixture.tier,
        clouds:document.getElementById('cloud-type')?.value??_sky.state.preset,weather:document.getElementById('weather')?.value??__skyFixture.weather.state.name,
        simulationTime:_sky.uniforms.time.value,renderInfo:{..._reflectionPipeline.pipeline.renderer.info.render},memory:_reflectionPipeline.pipeline.renderer.info.memory})`);
    // Resource sampling is concurrent but never changes/terminates workloads.
    resourcePromise=run('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',
        fileURLToPath(new URL('./resource-check.ps1',import.meta.url)),'-SampleCount',String(Math.ceil(Number(seconds)))],{windowsHide:true,maxBuffer:4e6})
        .then(r=>JSON.parse(r.stdout),error=>({error:String(error)}));
    await c.evaluate(`(async()=>{
        if(globalThis.__skyFixture){const {FrameMetrics}=await import('/src/frame_metrics.js');globalThis._benchmark=new FrameMetrics();
            const f=__skyFixture,original=f.frame;globalThis.__cpuVariantRestore=()=>f.frame=original;
            f.frame=async function(...args){const start=performance.now();const result=await original.apply(this,args);_benchmark.record(start,performance.now());return result;};}
        _benchmark.start({purpose:'Matched CPU submission comparison'});
    })()`);
    const before=Object.fromEntries((await c.send('Performance.getMetrics')).metrics.map(m=>[m.name,m.value]));
    const initial=await c.evaluate('_eanpaTest.completedFrames');await wait(Number(seconds)*1000);
    const completed=await c.evaluate('_eanpaTest.completedFrames')-initial;
    const after=Object.fromEntries((await c.send('Performance.getMetrics')).metrics.map(m=>[m.name,m.value]));
    const metrics=await c.evaluate('_benchmark.stop()');
    const browserErrors=await c.evaluate(`[...document.body.children].find(e=>e.style?.zIndex==='99')?.textContent||document.getElementById('error')?.textContent||''`);
    const resources=await resourcePromise;
    const diff=(await run('git',[...git,'diff','HEAD','--','src','engine','vendor'],{windowsHide:true,maxBuffer:8e6})).stdout;
    const result={date:new Date().toISOString(),name,variant,baseline,revision,sourceSha256,bootMs,metadata,
        cpuThrottleRate:Number(rate),gpuConstraint:'Local GPU unchanged; no GPU emulation',metrics,
        completedFrames:completed,cpuTaskMsPerFrame:(after.TaskDuration-before.TaskDuration)*1000/completed,
        cpuTimeDomain:'DevTools Performance threadTicks; main-thread task CPU duration / completed application frames',
        resources,cleanCpuWindow:resources.cpu?.clean===true,cleanGpuWindow:resources.clean===true,
        errors:[...errors,...(browserErrors?[browserErrors]:[])],sourceOverrides:files,
        workingTreeDiffSha256:createHash('sha256').update(diff).digest('hex')};
    const directory='artifacts/cpu-optimization-20260910';await mkdir(directory,{recursive:true});
    const shot=await c.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
    await writeFile(directory+'/'+name+'.png',Buffer.from(shot.data,'base64'));
    await writeFile(directory+'/'+name+'.json',JSON.stringify(result,null,2));
    console.log(JSON.stringify({name,variant,bootMs,fps:metrics.meanFps,cpuTaskMsPerFrame:result.cpuTaskMsPerFrame,
        p95:metrics.frameIntervalMs.p95,cleanCpuWindow:result.cleanCpuWindow,cleanGpuWindow:result.cleanGpuWindow,errors:result.errors},null,2));
}finally{
    await c.evaluate('globalThis.__cpuVariantRestore?.();delete globalThis.__cpuVariantRestore;').catch(()=>{});
    await c.send('Performance.disable').catch(()=>{});
    await c.send('Emulation.setCPUThrottlingRate',{rate:1}).catch(()=>{});
    await c.send('Fetch.disable').catch(()=>{});removeListener?.();c.close();
    // The loaded page remains the captured variant; reload before inspecting
    // working-tree changes. Interception and throttling never remain enabled.
}
