import { connect } from './cdp.mjs';
import { readFile, writeFile, mkdir } from 'node:fs/promises';

const scenarios = JSON.parse(await readFile(process.argv[2], 'utf8'));
const stateSource = await readFile(new URL('./state.js', import.meta.url), 'utf8');
const resetSource = await readFile(new URL('./reset-view.js', import.meta.url), 'utf8');
const cdp = await connect();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const set = async (id, value) => cdp.evaluate(`(() => {
    const el = document.getElementById(${JSON.stringify(id)});
    if(el.value === ${JSON.stringify(String(value))}) return;
    el.value = ${JSON.stringify(String(value))};
    el.dispatchEvent(new Event('input', {bubbles:true}));
    el.dispatchEvent(new Event('change', {bubbles:true}));
})()`);
async function waitSettled() {
    const deadline = Date.now() + 240000;
    while (true) {
        const s = await cdp.evaluate(stateSource);
        if (s.errors || s.pointerLocked) throw new Error(JSON.stringify(s));
        if (s.ready && !s.transition?.active && !s.weather?.active) return s;
        if (Date.now() > deadline) throw new Error(`Scene transition timed out: ${JSON.stringify(s)}`);
        await sleep(1000);
    }
}
try {
    await mkdir('artifacts/overhaul/matrix', {recursive:true});
    for (const s of scenarios) {
        await cdp.evaluate('_eanpaTest.paused=false');
        await set('skybox', s.sky);
        await waitSettled();
        await set('cloud-type', s.cloud ?? 'cumulus');
        await set('weather', s.weather ?? 'none');
        await set('tod', s.hours ?? 10.5);
        await waitSettled();
        await cdp.evaluate(resetSource);
        if (s.aim) await cdp.evaluate(await readFile(new URL(`./aim-${s.aim}.js`, import.meta.url), 'utf8'));
        else await cdp.evaluate(`_look.pitch=${s.pitch ?? 0.16};_look.yaw=${s.yaw ?? 0};`);
        await sleep(2000);
        const state = await cdp.evaluate(stateSource);
        const shot = await cdp.send('Page.captureScreenshot', {format:'png',captureBeyondViewport:false});
        const stem = `artifacts/overhaul/matrix/${s.name}`;
        await writeFile(`${stem}.png`, Buffer.from(shot.data, 'base64'));
        await writeFile(`${stem}.json`, JSON.stringify({scenario:s, date:new Date().toISOString(), state}, null, 2));
        console.log(`Captured ${s.name}; ${state.frames.completedFrames} completed frames, ${state.memory.total} tracked GPU bytes`);
    }
} finally { cdp.close(); }
