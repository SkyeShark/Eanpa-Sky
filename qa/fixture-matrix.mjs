// Serial measurements in one owned browser. Child processes are command-line
// clients of that page; none starts a browser or changes system power settings.
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFile} from 'node:fs/promises';
const run=promisify(execFile),[name='final-effects',seconds='20']=process.argv.slice(2);
if(!/^[a-z0-9_-]+$/i.test(name)||Number(seconds)<5||Number(seconds)>60)throw new Error('Invalid matrix arguments');
const command=(...args)=>run(process.execPath,args,{windowsHide:true,timeout:300000,maxBuffer:4e6});
for(const tier of ['performance','balanced','high']){
    await command('qa/load-fixture.mjs','earth',tier,'rain','11');
    for(const level of ['native','moderate','limited']){
        await command('qa/sky-benchmark.mjs',name+'-'+tier,level,seconds);
        const r=JSON.parse(await readFile(`artifacts/feedback-20260909/benchmarks/${name}-${tier}-${level}.json`,'utf8'));
        console.log(JSON.stringify({tier,level,fps:r.fps,p95Ms:r.p95Ms,maxMs:r.maxMs,
            cleanCpu:r.cleanCpuWindow,cleanGpu:r.cleanGpuWindow,environmentRefreshes:r.environment.capturesDuringRun,
            externalCpuPercent:[r.resources.before.cpu.externalMeanPercent,r.resources.during.cpu.externalMeanPercent]}));
    }
    console.log(tier+' GPU timestamps: '+(await command('qa/gpu-profile.mjs',name+'-'+tier,'120')).stdout.trim());
}
