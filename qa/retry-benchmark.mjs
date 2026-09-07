// Repeat one contended unrestricted capture without discarding its first result.
// Use the already loaded matching world/quality in the single owned browser.
import {connect} from './cdp.mjs';
import {readFile,writeFile,copyFile} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
const [sky,quality,weather]=process.argv.slice(2);
if(!['earth','ringworld','shieldworld'].includes(sky)||!['balanced','performance','high'].includes(quality)
    ||!['none','rain','cyclone'].includes(weather))throw new Error('Invalid scenario');
const root='artifacts/overhaul/benchmarks/',stem=`final-${sky}-${quality}-${weather}`;
const json=async file=>JSON.parse(await readFile(root+file+'.json','utf8'));
const original=await json(stem+'-full');
if(original.cleanGpuWindow)throw new Error('This capture already passed the isolation gate');
const originalSha256=createHash('sha256').update(await readFile(root+stem+'-full.json')).digest('hex');
const run=promisify(execFile),c=await connect();
const command=async(file,...args)=>(await run(process.execPath,[`qa/${file}.mjs`,...args],
    {windowsHide:true,maxBuffer:8*1024*1024,timeout:240000})).stdout;
try{
    const current=await c.evaluate(`({sky:document.getElementById('skybox').value,quality:document.getElementById('quality').value})`);
    if(current.sky!==sky||current.quality!==quality)throw new Error('Load the matching world and quality first');
    await command('review-view',stem+'-repeat','cumulus',weather,'10.5','wide');
    await c.evaluate(`(()=>{const u=__eanpaWeatherByScene.get(_c.parent).uniforms;
        u.wetness.value=u.wetTarget.value;u.surfaceWater.value=Math.pow(Math.max(0,u.wetTarget.value),1.8);
        globalThis.__benchmarkScenario=${JSON.stringify(original.metadata.scenario)};
        _eanpaTest.pauseAfterFrame=false;_eanpaTest.paused=false;})()`);
    await new Promise(r=>setTimeout(r,5000));
    await command('benchmark','repeat-'+stem+'-full','20','1','observed');
    await command('gpu-profile','repeat-'+stem,'90');
    const repeat=await json('repeat-'+stem+'-full'),gpu=await json('repeat-'+stem+'-gpu');
    const adopted=repeat.valid&&repeat.cleanGpuWindow&&!repeat.errors
        &&repeat.metadata.revision===original.metadata.revision&&!repeat.metadata.workingTreeDiffSha256;
    if(adopted){
        await copyFile(root+stem+'-full.json',root+stem+'-full-contended-first.json');
        await copyFile(root+'repeat-'+stem+'-full.json',root+stem+'-full.json');
        const route=await json(`final-${sky}-route`),row=route.find(r=>r.name===stem+'-full');
        if(!row)throw new Error('Missing original route entry');
        row.benchmark=repeat;row.gpuProfile=gpu.summary;
        await writeFile(root+`final-${sky}-route.json`,JSON.stringify(route,null,2));
    }
    await writeFile(root+stem+'-retest.json',JSON.stringify({adopted,originalSha256,original,repeat,gpu},null,2));
    console.log(JSON.stringify({adopted,originalFps:original.meanFps,repeatFps:repeat.meanFps,
        clean:repeat.cleanGpuWindow,background:repeat.resources.during.busy,gpu:gpu.summary}));
}finally{c.close()}
