// All three tiers, same scene/view, with unrestricted and explicitly synthetic
// CPU/GPU stress runs. Background counters remain part of every saved result.
import{connect}from'./cdp.mjs';import{execFile}from'node:child_process';
import{promisify}from'node:util';import{mkdir,readFile,writeFile}from'node:fs/promises';
const [sky='ringworld',label='feedback',tierList='performance,balanced,high']=process.argv.slice(2);
const tiers=tierList.split(',');
if(!['earth','ringworld','shieldworld'].includes(sky)||!/^[a-z0-9_-]+$/.test(label)
    ||tiers.some(t=>!['performance','balanced','high'].includes(t)))throw new Error('Invalid route');
const c=await connect(),run=promisify(execFile),records=[];
const task=async(name,...args)=>{
    const result=await run(process.execPath,[`qa/${name}.mjs`,...args],{windowsHide:true,timeout:360000,maxBuffer:4*1024*1024});
    return result.stdout;
};
const ready=async()=>{
    const deadline=Date.now()+300000;
    while(Date.now()<deadline){
        const s=await c.evaluate(`({ready:document.getElementById('boot')?.style.display==='none',
            errors:[...document.body.children].filter(e=>e.style?.zIndex==='99').map(e=>e.textContent).filter(Boolean)})`);
        if(s.errors.length)throw new Error(s.errors.join('\n'));if(s.ready)return;
        await new Promise(r=>setTimeout(r,1000));
    }throw new Error('Tier rebuild timed out');
};
try{
    await ready();
    if(await c.evaluate("document.getElementById('skybox').value")!==sky)await task('load-scene',sky,'10.5','balanced','none');
    await mkdir('artifacts/feedback-20260908',{recursive:true});
    for(const tier of tiers){
        await c.evaluate(`(()=>{_eanpaTest.pauseAfterFrame=false;_eanpaTest.paused=false;
            const e=document.getElementById('quality');if(e.value!==${JSON.stringify(tier)}){e.value=${JSON.stringify(tier)};e.dispatchEvent(new Event('change',{bubbles:true}))}})()`);
        await ready();
        for(const [cloud,weather]of [['cumulus','none'],['stratus','rain']]){
            const stem=`${label}-${sky}-${tier}-${weather}`;
            await task('review-view',stem,cloud,weather,'10.5','wide');
            for(const constraint of ['full','reduced']){
                const name=`${stem}-${constraint}`;
                if(constraint==='full')await task('benchmark',name,'20','1','observed');
                else await task('benchmark-contention',name,'20','4','8');
                const data=JSON.parse(await readFile(`artifacts/overhaul/benchmarks/${name}.json`,'utf8'));
                const row={name,tier,weather,constraint,valid:data.valid,reasons:data.invalidReasons,
                    fps:data.meanFps,ms:data.frameIntervalMs,renderTaskMs:data.renderTaskMs,
                    cpuBackground:data.resources.during.cpu.externalMeanPercent,
                    gpuBackground:data.resources.during.busy,gpuConstraint:data.metadata.gpuConstraint??null};
                records.push(row);console.log(JSON.stringify(row));
                await writeFile(`artifacts/feedback-20260908/${label}-${sky}-benchmarks.json`,JSON.stringify(records,null,2));
            }
        }
    }
}finally{
    await c.send('Emulation.setCPUThrottlingRate',{rate:1}).catch(()=>{});
    await c.evaluate('globalThis.__gpuContention?.stop()').catch(()=>{});c.close();
}
