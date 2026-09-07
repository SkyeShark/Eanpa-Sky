// Owned watchdog: restore only the exact cap this benchmark installed.
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const exec=promisify(execFile),[parent,original,cap]=process.argv.slice(2).map(Number);
if(!Number.isInteger(parent)||!(original>=5&&original<=200)||!(cap>=5&&cap<=original))throw new Error('Invalid restore arguments');
const deadline=Date.now()+240000;
while(Date.now()<deadline){
    try{process.kill(parent,0)}catch{break}
    await new Promise(r=>setTimeout(r,1000));
}
const read=await exec('nvidia-smi.exe',['--query-gpu=enforced.power.limit','--format=csv,noheader,nounits'],{windowsHide:true});
if(Math.abs(Number(read.stdout.trim())-cap)<.1)await exec('nvidia-smi.exe',['-pl',String(original)],{windowsHide:true});
