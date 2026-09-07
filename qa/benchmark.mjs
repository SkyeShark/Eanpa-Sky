import { connect } from './cdp.mjs';
import { mkdir, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import {createHash} from 'node:crypto';
const [name='current',seconds='30',rate='1',mode='controlled']=process.argv.slice(2);
if(!/^[a-z0-9_-]{1,80}$/i.test(name) || !(Number(seconds)>=5&&Number(seconds)<=120)
    || !(Number(rate)>=1&&Number(rate)<=20) || !['controlled','observed'].includes(mode)) throw new Error('Invalid benchmark name, duration, CPU rate, or capture mode');
const runFile=promisify(execFile);
const resources=async samples=>JSON.parse((await runFile('powershell.exe',[
    '-NoProfile','-ExecutionPolicy','Bypass','-File',fileURLToPath(new URL('./resource-check.ps1',import.meta.url)),
    '-SampleCount',String(samples),
],{windowsHide:true,maxBuffer:4*1024*1024})).stdout);
const cdp=await connect();
try {
    const before=await resources(4);
    if(!before.clean && mode==='controlled') throw new Error(`GPU contention before capture: ${JSON.stringify(before)}`);
    await cdp.send('Emulation.setCPUThrottlingRate',{rate:Number(rate)});
    await cdp.evaluate('_eanpaTest.pauseAfterFrame=false;_eanpaTest.paused=false;');
    await new Promise(r=>setTimeout(r,4000));
    const metadata=await cdp.evaluate(`({date:new Date().toISOString(),skybox:document.getElementById('skybox').value,
        clouds:document.getElementById('cloud-type').value,weather:document.getElementById('weather').value,
        hours:document.getElementById('tod').value,quality:document.getElementById('quality').value,
        canvas:[document.getElementById('view').width,document.getElementById('view').height],
        camera:_c.position.toArray(),look:{yaw:_look.yaw,pitch:_look.pitch},verticalFov:_c.getEffectiveFOV(),
        ready:document.getElementById('boot').style.display==='none',pointerLocked:!!document.pointerLockElement,
        transitioning:!!(_weather?.diagnostics?.transition?.active||_sky?.cloudTransitionInfo?.active),
        gpuMemory:_reflectionPipeline?.pipeline.renderer.info.memory??null,
        wetness:_weather?.uniforms?.wetness?.value, surfaceWater:_weather?.uniforms?.surfaceWater?.value})`);
    if(!metadata.ready||metadata.pointerLocked||metadata.transitioning)throw new Error('Preview not settled for capture');
    metadata.cpuThrottleRate=Number(rate); metadata.gpu='NVIDIA GeForce RTX 5090 Laptop GPU, 24GB';
    metadata.captureMode=mode;
    metadata.revision=(await runFile('git',['-c',`safe.directory=${process.cwd().replaceAll('\\','/')}`,
        'rev-parse','HEAD'],{windowsHide:true})).stdout.trim();
    const diff=(await runFile('git',['-c',`safe.directory=${process.cwd().replaceAll('\\','/')}`,
        'diff','HEAD','--','src','engine','vendor'],{windowsHide:true,maxBuffer:8*1024*1024})).stdout;
    metadata.workingTreeDiffSha256=diff?createHash('sha256').update(diff).digest('hex'):null;
    metadata.constraint=Number(rate)===1?'Unthrottled browser CPU; local GPU unchanged':`${rate}x CDP CPU slowdown; local GPU unchanged`;
    const duringPromise=resources(Math.ceil(Number(seconds)));
    await cdp.evaluate(`_eanpaTest.pauseAfterFrame=false;_eanpaTest.paused=false;_benchmark.start(${JSON.stringify(metadata)});`);
    await new Promise(r=>setTimeout(r,Number(seconds)*1000));
    const result=await cdp.evaluate('_benchmark.stop()');
    result.endingCamera=await cdp.evaluate('_c.position.toArray()');
    result.resources={before,during:await duringPromise};
    result.cleanGpuWindow=result.resources.before.clean&&result.resources.during.clean;
    result.errors=await cdp.evaluate(`[...document.body.children].find(e=>e.style?.zIndex==='99')?.textContent`);
    if(!result.cleanGpuWindow){
        result.valid=false;result.invalidReasons.push('External GPU activity exceeded the 5% gate during capture');
    }
    if(result.errors){result.valid=false;result.invalidReasons.push('Browser reported a render error');}
    await mkdir('artifacts/overhaul/benchmarks',{recursive:true});
    await writeFile(`artifacts/overhaul/benchmarks/${name}.json`,JSON.stringify(result,null,2));
    const {intervalsMs,resources:resourceDetails,...summary}=result;
    console.log(JSON.stringify({...summary,resourceSummary:{beforeClean:resourceDetails.before.clean,
        duringClean:resourceDetails.during.clean,gpu:resourceDetails.during.gpuAfter}},null,2));
}finally{await cdp.send('Emulation.setCPUThrottlingRate',{rate:1}).catch(()=>{});cdp.close();}
