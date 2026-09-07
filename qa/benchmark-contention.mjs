import {connect} from './cdp.mjs';
import {readFile,writeFile} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const [name='reduced-synthetic',seconds='30',rate='4',gpuMs='12']=process.argv.slice(2);
if(!/^[a-z0-9_-]+$/i.test(name)||!(Number(gpuMs)>0&&Number(gpuMs)<=20))throw new Error('Invalid settings');
const c=await connect(),exec=promisify(execFile);
try{
    await c.evaluate(`globalThis.__requestedGpuContentionMs=${Number(gpuMs)}`);
    const constraint=await c.evaluate(await readFile('qa/gpu-contention.js','utf8'));console.log(JSON.stringify(constraint));
    const result=await exec(process.execPath,['qa/benchmark.mjs',name,seconds,rate,'observed'],{windowsHide:true,maxBuffer:4*1024*1024,timeout:150000});
    const file=`artifacts/overhaul/benchmarks/${name}.json`,data=JSON.parse(await readFile(file,'utf8'));
    data.metadata.gpuConstraint=await c.evaluate('globalThis.__gpuContention.metadata');
    data.metadata.constraint=`${rate}x CPU slowdown plus calibrated synthetic GPU competition`;
    await writeFile(file,JSON.stringify(data,null,2));
    const {intervalsMs,resources,...summary}=data;console.log(JSON.stringify(summary));
}finally{await c.evaluate('globalThis.__gpuContention?.stop()').catch(()=>{});c.close()}
