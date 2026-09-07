// Paired CPU+GPU stress and unrestricted runs in the existing owned browser.
// Background activity is retained in each result, never silently accepted as
// an isolated GPU baseline. No driver settings or other processes are changed.
import {connect} from './cdp.mjs';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
const sky=process.argv[2]??'earth';
if(!['earth','ringworld','shieldworld'].includes(sky))throw new Error('Unknown sky');
const prefix=process.argv[3]??'overhaul';
if(!/^[a-z0-9_-]+$/i.test(prefix))throw new Error('Invalid capture prefix');
const run=promisify(execFile),c=await connect(),records=[];
const command=async(file,...args)=>{
    const r=await run(process.execPath,[`qa/${file}.mjs`,...args],
        {windowsHide:true,maxBuffer:8*1024*1024,timeout:300000});
    return r.stdout;
};
const read=async name=>JSON.parse(await readFile(`artifacts/overhaul/benchmarks/${name}.json`,'utf8'));
try{
    await mkdir('artifacts/overhaul/benchmarks',{recursive:true});
    for(const [quality,weathers]of [['balanced',['none','rain','cyclone']],['performance',['rain']],['high',['none']]]){
        console.log(`Loading ${sky} / ${quality}`);
        await command('load-scene',sky,'10.5',quality,'none');
        for(const weather of weathers){
            const stem=`${prefix}-${sky}-${quality}-${weather}`;
            await command('review-view',stem,'cumulus',weather,'10.5','wide');
            // Compare settled surface states, rather than a wetter second run.
            // This is a steady-state workload; transition tests are separate.
            await c.evaluate(`(()=>{
                const u=__eanpaWeatherByScene.get(_c.parent).uniforms;
                u.wetness.value=u.wetTarget.value;
                u.surfaceWater.value=Math.pow(Math.max(0,u.wetTarget.value),1.8);
                globalThis.__benchmarkScenario={surfaceState:'Preset steady-state wetness and pooled-water targets',
                    camera:'Ground-level temple view',fov:62,cloudMotion:'Live; start simulation time recorded',
                    geometry:'Complete authored local scene retained in every quality tier'};
                _eanpaTest.pauseAfterFrame=false;_eanpaTest.paused=false;
            })()`);
            await new Promise(r=>setTimeout(r,5000));
            const names=[];
            if(quality!=='high'){
                console.log(`Measuring ${stem}: 4x CPU + 8 ms target GPU competition`);
                await command('benchmark-contention',stem+'-reduced','20','4','8');
                names.push(stem+'-reduced');
            }
            console.log(`Measuring ${stem}: unrestricted CPU and GPU settings`);
            await command('benchmark',stem+'-full','20','1','observed');
            names.push(stem+'-full');
            await command('gpu-profile',stem,'90');
            const gpu=await read(stem+'-gpu');
            for(const name of names){
                const b=await read(name);
                const otherReasons=b.invalidReasons.filter(reason=>!reason.includes('External GPU activity'));
                if(otherReasons.length||b.errors)throw new Error('Unusable benchmark: '+JSON.stringify(otherReasons));
                records.push({name,benchmark:b,gpuProfile:name.endsWith('-full')?gpu.summary:null});
                console.log(JSON.stringify({name,fps:b.meanFps,p95:b.frameIntervalMs.p95,
                    isolated:b.cleanGpuWindow,background:b.resources.during.busy}));
            }
            await writeFile(`artifacts/overhaul/benchmarks/${prefix}-${sky}-route.json`,JSON.stringify(records,null,2));
            await c.evaluate(`(async()=>{_eanpaTest.pauseAfterFrame=true;
                while(!_eanpaTest.paused)await new Promise(r=>setTimeout(r,20));})()`);
            const shot=await c.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
            await writeFile(`artifacts/overhaul/benchmarks/${stem}.png`,Buffer.from(shot.data,'base64'));
        }
    }
}finally{
    await c.send('Emulation.setCPUThrottlingRate',{rate:1}).catch(()=>{});
    await c.evaluate('globalThis.__gpuContention?.stop()').catch(()=>{});
    c.close();
}
