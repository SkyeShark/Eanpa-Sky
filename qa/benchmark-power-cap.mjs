import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {connect} from './cdp.mjs';
const [name='reduced-gpu-cpu',seconds='30',rate='4',capText='75']=process.argv.slice(2);
if(!/^[a-z0-9_-]+$/i.test(name)||!(Number(seconds)>=5&&Number(seconds)<=60)||!(Number(rate)>=1&&Number(rate)<=8))throw new Error('Invalid benchmark settings');
const exec=promisify(execFile),smi=args=>exec('nvidia-smi.exe',args,{windowsHide:true});
const power=async()=>Number((await smi(['--query-gpu=enforced.power.limit','--format=csv,noheader,nounits'])).stdout.trim());
const original=await power(),cap=Number(capText);
if(!Number.isFinite(original)||!(cap>=20&&cap<original))throw new Error('Cannot establish a safe lower power limit');
await mkdir('artifacts/overhaul/benchmarks',{recursive:true});
const journal={date:new Date().toISOString(),originalWatts:original,requestedWatts:cap,cpuSlowdown:Number(rate),applied:false,restored:false};
let watchdog;
try{
    const result=await smi(['-pl',String(cap)]);
    journal.driverResponse=result.stdout.trim();journal.observedLimitWatts=await power();
    if(Math.abs(journal.observedLimitWatts-cap)>.1)throw new Error('Driver did not apply the requested GPU power cap');
    journal.applied=true;
    watchdog=spawn(process.execPath,[fileURLToPath(new URL('./restore-gpu-power.mjs',import.meta.url)),String(process.pid),String(original),String(cap)],{windowsHide:true,stdio:'ignore'});
    const c=await connect();try{await c.evaluate('_eanpaTest.pauseAfterFrame=false;_eanpaTest.paused=false;')}finally{c.close()}
    const capture=await exec(process.execPath,[fileURLToPath(new URL('./benchmark.mjs',import.meta.url)),name,seconds,rate,'observed'],{windowsHide:true,maxBuffer:4*1024*1024,timeout:150000});
    const file=`artifacts/overhaul/benchmarks/${name}.json`,data=JSON.parse(await readFile(file,'utf8'));
    data.hardwareConstraint={powerLimitWatts:cap,originalPowerLimitWatts:original};
    data.metadata.constraint=`GPU power limited to ${cap} W; ${rate}x browser CPU slowdown. Same GPU architecture and memory bandwidth.`;
    await writeFile(file,JSON.stringify(data,null,2));console.log(capture.stdout);
}catch(error){journal.error=[error.message,error.stdout,error.stderr].filter(Boolean).join('\n');}
finally{
    const current=await power();
    if(Math.abs(current-cap)<.1)await smi(['-pl',String(original)]);
    journal.finalLimitWatts=await power();journal.restored=Math.abs(journal.finalLimitWatts-original)<.1;
    if(journal.restored)watchdog?.kill();
    await writeFile(`artifacts/overhaul/benchmarks/${name}-power-control.json`,JSON.stringify(journal,null,2));
    console.log(JSON.stringify(journal,null,2));
    if(!journal.restored)throw new Error('Original GPU power limit could not be verified after restoration');
}
