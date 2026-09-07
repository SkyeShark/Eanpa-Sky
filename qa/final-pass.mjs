// One serialized review route in the existing owned browser. No new browser.
import { connect } from './cdp.mjs';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const run = promisify(execFile), cdp = await connect();
const stateSource = await readFile('qa/state.js', 'utf8');
const reset = await readFile('qa/reset-view.js', 'utf8');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const records = [];
const set = async (id, value) => cdp.evaluate(`(() => {
    const el=document.getElementById(${JSON.stringify(id)});
    if(el.value===${JSON.stringify(String(value))})return;
    el.value=${JSON.stringify(String(value))};el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));
})()`);
const settled = async () => {
    const end = Date.now()+240000;
    while(Date.now()<end){
        const state=await cdp.evaluate(stateSource);
        if(state.errors||state.pointerLocked||state.frames?.failedFrames)throw new Error(JSON.stringify(state));
        if(state.ready&&!state.transition?.active&&!state.weather?.active)return state;
        await sleep(1000);
    }
    throw new Error('Scene did not settle');
};
const capture = async name => {
    await sleep(1500);
    const state=await cdp.evaluate(stateSource);
    const shot=await cdp.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
    await writeFile(`artifacts/overhaul/final/${name}.png`,Buffer.from(shot.data,'base64'));
    await writeFile(`artifacts/overhaul/final/${name}.json`,JSON.stringify({date:new Date().toISOString(),state},null,2));
    console.log(`Captured ${name}`);
    return state;
};
const task = async (script,...args) => {
    const result=await run(process.execPath,[`qa/${script}.mjs`,...args],{windowsHide:true,maxBuffer:8*1024*1024});
    console.log(`${script} ${args.join(' ')}: ${result.stdout.trim()}`);
};
try {
    await mkdir('artifacts/overhaul/final',{recursive:true});
    await cdp.send('Page.reload',{ignoreCache:true});
    await sleep(1000); await settled();
    for(const sky of (process.argv.slice(2).length ? process.argv.slice(2) : ['earth','ringworld','shieldworld'])){
        await set('weather','none');await set('skybox',sky);await settled();
        await set('cloud-type','cumulus');await set('tod',10.5);await settled();
        await cdp.evaluate(reset);await capture(`${sky}-dry`);
        // Same canvas/tier/content; CDP slows the CPU, not the GPU.
        await task('benchmark',`${sky}-balanced-cpu4`,'30','4');
        await task('benchmark',`${sky}-balanced-full`,'30','1');
        await task('gpu-profile',`${sky}-balanced-full`,'120');
        await task('ssr-motion',`${sky}-final-dry`);
        await cdp.evaluate(reset);
        await set('weather','rain');await settled();
        await sleep(12000);
        await capture(`${sky}-rain`);
        await cdp.evaluate('_look.pitch=-0.48');await capture(`${sky}-puddles`);
        await cdp.evaluate('_look.pitch=.16');
        await set('weather','cyclone');await settled();
        await capture(`${sky}-cyclone`);
        await cdp.evaluate(reset);
        await task('benchmark',`${sky}-cyclone-full`,'30','1');
        await task('gpu-profile',`${sky}-cyclone-full`,'120');
        if(sky==='earth'){
            const before=await cdp.evaluate(stateSource);
            await set('weather','none');await settled();
            const after=await capture('earth-after-rain');
            const drying={before:before.wetness,after:after.wetness,
                pass:after.wetness.wetness>0&&after.wetness.wetness<before.wetness.wetness
                    &&after.wetness.surfaceWater>after.wetness.wetness};
            if(!drying.pass)throw new Error(`Drying check failed: ${JSON.stringify(drying)}`);
            await writeFile('artifacts/overhaul/final/drying.json',JSON.stringify(drying,null,2));
        }
        records.push({sky,state:await cdp.evaluate(stateSource)});
        await writeFile('artifacts/overhaul/final/route.json',JSON.stringify(records,null,2));
    }
} finally {
    await cdp.send('Emulation.setCPUThrottlingRate',{rate:1}).catch(()=>{});
    await cdp.evaluate('_eanpaTest.paused=false').catch(()=>{});
    cdp.close();
}
