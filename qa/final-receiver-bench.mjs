// Same-view pair after removal of the standalone's legacy receiver opt-outs.
import {connect} from './cdp.mjs';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFile} from 'node:fs/promises';
const run=promisify(execFile),c=await connect(),stem='receiver-final-ringworld-balanced-rain';
const command=async(file,...args)=>(await run(process.execPath,[`qa/${file}.mjs`,...args],
    {windowsHide:true,maxBuffer:8*1024*1024,timeout:240000})).stdout;
try{
    const state=await c.evaluate(`({sky:document.getElementById('skybox').value,quality:document.getElementById('quality').value})`);
    if(state.sky!=='ringworld'||state.quality!=='balanced')throw new Error('Load Ringworld / Balanced first');
    await command('review-view',stem,'cumulus','rain','10.5','wide');
    const previous=JSON.parse(await readFile('artifacts/overhaul/benchmarks/final-ringworld-balanced-rain-full.json','utf8'));
    await c.evaluate(`(()=>{const u=__eanpaWeatherByScene.get(_c.parent).uniforms;
        u.wetness.value=u.wetTarget.value;u.surfaceWater.value=Math.pow(Math.max(0,u.wetTarget.value),1.8);
        globalThis.__benchmarkScenario=${JSON.stringify(previous.metadata.scenario)};
        _eanpaTest.pauseAfterFrame=false;_eanpaTest.paused=false;})()`);
    await new Promise(r=>setTimeout(r,5000));
    await command('benchmark-contention',stem+'-reduced','20','4','8');
    await command('benchmark',stem+'-full','20','1','observed');
    await command('gpu-profile',stem,'90');
    for(const suffix of ['reduced','full']){
        const b=JSON.parse(await readFile(`artifacts/overhaul/benchmarks/${stem}-${suffix}.json`,'utf8'));
        console.log(JSON.stringify({name:stem+'-'+suffix,fps:b.meanFps,p95:b.frameIntervalMs.p95,
            revision:b.metadata.revision,clean:b.cleanGpuWindow,errors:b.errors,invalidReasons:b.invalidReasons}));
    }
}finally{await c.send('Emulation.setCPUThrottlingRate',{rate:1}).catch(()=>{});
    await c.evaluate('globalThis.__gpuContention?.stop()').catch(()=>{});c.close()}
