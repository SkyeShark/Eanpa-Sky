// Serialized quality-tier checks in the one existing QA page.
import { connect } from './cdp.mjs';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const run = promisify(execFile), cdp = await connect();
const stateSource = await readFile('qa/state.js', 'utf8');
const reset = await readFile('qa/reset-view.js', 'utf8');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const set = async (id, value) => cdp.evaluate(`(() => {
    const el=document.getElementById(${JSON.stringify(id)});
    if(el.value===${JSON.stringify(String(value))})return;
    el.value=${JSON.stringify(String(value))};
    el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));
})()`);
const settled = async () => {
    const end = Date.now() + 240000;
    while (Date.now() < end) {
        const s = await cdp.evaluate(stateSource);
        if (s.errors || s.pointerLocked || s.frames?.failedFrames) throw new Error(JSON.stringify(s));
        if (s.ready && !s.transition?.active && !s.weather?.active) return;
        await sleep(1000);
    }
    throw new Error('Scene did not settle');
};
const task = async (script, ...args) => {
    const r = await run(process.execPath, [`qa/${script}.mjs`, ...args], { windowsHide: true, maxBuffer: 8*1024*1024 });
    console.log(`${script}: ${r.stdout.trim()}`);
};
const records = [];
const capture = async stem => {
    await sleep(1500);
    const image=await cdp.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
    await writeFile(`artifacts/overhaul/quality/${stem}.png`,Buffer.from(image.data,'base64'));
    await writeFile(`artifacts/overhaul/quality/${stem}.json`,JSON.stringify(await cdp.evaluate(stateSource),null,2));
    console.log(`Captured ${stem}`);
};
const benchmark = async (stem, rate=1) => {
    for(let attempt=1;attempt<=3;attempt++){
        const label=attempt===1?stem:`${stem}-retry${attempt}`;
        try { await task('benchmark',label,'30',String(rate)); }
        catch(error){
            if(!String(error).includes('GPU contention before capture')||attempt===3)throw error;
            console.log(`Contention before ${label}; retrying after a quiet interval`);
            await sleep(5000);continue;
        }
        const result=JSON.parse(await readFile(`artifacts/overhaul/benchmarks/${label}.json`,'utf8'));
        if(result.valid||attempt===3)return result;
        console.log(`Invalid sample retained: ${label}`);await sleep(5000);
    }
};
try {
    await mkdir('artifacts/overhaul/quality', { recursive: true });
    await set('weather', 'none'); await settled();
    for (const sky of ['earth', 'ringworld', 'shieldworld']) {
        await set('skybox', sky); await settled();
        await set('cloud-type', 'cumulus'); await set('tod', 10.5); await settled();
        for (const tier of ['balanced', 'high', 'performance']) {
            await set('quality', tier); await settled();
            await cdp.evaluate(reset); await sleep(6000);
            const stem = `${sky}-${tier}-review`;
            await capture(stem);
            if(tier==='balanced'){
                await task('cloud-shadow-compare',sky);
                await task('ssr-motion',`${sky}-review-dry`);
                await cdp.evaluate(reset);
                const constrained=await benchmark(`${stem}-cpu4`,4);
                records.push({sky,tier,constraint:4,benchmark:constrained});
            }
            const full=await benchmark(stem);
            await task('gpu-profile', stem, '120');
            records.push({ sky, tier, benchmark:full, state: await cdp.evaluate(stateSource) });
            await writeFile('artifacts/overhaul/quality/route.json', JSON.stringify(records, null, 2));
        }
        await set('quality','balanced');await settled();await cdp.evaluate(reset);
        await set('weather','rain');await settled();await sleep(12000);
        await capture(`${sky}-rain-review`);
        await cdp.evaluate('_look.pitch=-.48');await capture(`${sky}-puddles-review`);
        await cdp.evaluate(reset);await set('weather','cyclone');await settled();
        await capture(`${sky}-cyclone-review`);
        const storm=await benchmark(`${sky}-cyclone-review`);
        await task('gpu-profile',`${sky}-cyclone-review`,'120');
        records.push({sky,tier:'balanced',weather:'cyclone',benchmark:storm});
        await writeFile('artifacts/overhaul/quality/route.json',JSON.stringify(records,null,2));
        await set('weather','none');await settled();
    }
    await set('quality', 'balanced'); await settled();
} finally {
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 }).catch(() => {});
    await cdp.evaluate('_eanpaTest.paused=false').catch(() => {});
    cdp.close();
}
