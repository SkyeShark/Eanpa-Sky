// Owns an isolated browser and server for startup, texture upgrades, and UI switches.
// Usage: node qa/performance-review.mjs LABEL
import {spawn} from 'node:child_process';
import {createConnection} from 'node:net';
import {mkdir, mkdtemp, open, readFile, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {connect} from './cdp.mjs';

const label = process.argv[2] ?? 'local';
if (!/^[a-z0-9_-]+$/i.test(label)) throw new Error('Use a simple artifact label');
const maxSwitchMs = Number(process.env.MAX_SWITCH_MS ?? 180000);
if (!Number.isFinite(maxSwitchMs) || maxSwitchMs <= 0) throw new Error('Invalid MAX_SWITCH_MS');
const root = fileURLToPath(new URL('../', import.meta.url));
const output = resolve(root, '.artifacts/performance', label);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const listening = port => new Promise(done => {
    const socket = createConnection({host: '127.0.0.1', port});
    const finish = value => {socket.destroy(); done(value)};
    socket.setTimeout(500);
    socket.once('connect', () => finish(true)); socket.once('error', () => finish(false));
    socket.once('timeout', () => finish(false));
});
if (await listening(8378) || await listening(9223)) throw new Error('QA ports occupied; no existing session will be modified');
await mkdir(output, {recursive: true});
const profile = await mkdtemp(join(tmpdir(), 'eanpa-performance-'));
const children = [];
let cdp;
const launch = async (command, args, name) => {
    const log = await open(join(output, `${name}.log`), 'w');
    try {
        const child = spawn(command, args, {cwd: root, stdio: ['ignore', log.fd, log.fd]});
        child.completed = new Promise(done => child.once('exit', done));
        await new Promise((done, reject) => {child.once('spawn', done); child.once('error', reject)});
        children.push(child);
        return child;
    } finally {await log.close()}
};
const errorsExpression = `[...document.body.children].filter(e=>e.style?.zIndex==='99').map(e=>e.textContent).filter(Boolean)`;
const waitUntil = async (expression, timeout = 180000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
        const errors = await cdp.evaluate(errorsExpression);
        if (errors.length) throw new Error(errors.join('\n'));
        if (await cdp.evaluate(expression)) return;
        await sleep(100);
    }
    throw new Error(`Timed out: ${expression}`);
};
const report = {label, conditions: 'Isolated headless Chrome; localhost no-store server; DPR 1. Browser shader cache cleared initially; driver caches and external workload uncontrolled.', switches: []};
try {
    await launch(process.env.PYTHON_PATH ?? (process.platform === 'win32' ? 'python' : 'python3'), ['qa/dev-server.py', '8378'], 'server');
    const browser = process.env.BROWSER_PATH ?? (process.platform === 'darwin'
        ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
        : process.platform === 'win32' ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : 'google-chrome');
    await launch(browser, ['--headless=new', '--remote-debugging-port=9223', '--remote-debugging-address=127.0.0.1',
        `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
        '--mute-audio', '--window-size=1280,800', 'about:blank'], 'browser');
    for (let i = 0; i < 80 && (!await listening(8378) || !await listening(9223)); i++) await sleep(100);
    if (!await listening(8378) || !await listening(9223)) throw new Error('Owned browser/server failed to start');
    const startupLabel = `review-${label}`;
    console.log('Measuring initial startup…');
    const startup = await launch(process.execPath, ['qa/startup-profile.mjs',
        'http://127.0.0.1:8378/?automated=1&benchmark=1', startupLabel, 'cold', '1', '--pause-at-ready'], 'startup');
    const code = await startup.completed;
    if (code !== 0) throw new Error(`Startup failed; see ${output}/startup.log`);
    const initial = JSON.parse(await readFile(resolve(root, '.artifacts/startup', `${startupLabel}.json`)));
    report.startup = {readyMs: initial.profile.readyAt, warmup: initial.warmup, settings: initial.settings,
        transferBytes: initial.resources.reduce((sum, r) => sum + (r.bytes ?? 0), 0)};
    cdp = await connect();
    report.adapter = await cdp.evaluate(`(async()=>{const a=await navigator.gpu.requestAdapter({powerPreference:'high-performance'});
        return {vendor:a.info.vendor,architecture:a.info.architecture,description:a.info.description,features:[...a.features]}})()`);
    const snapshot = () => cdp.evaluate(`({frames:_eanpaTest.completedFrames,pipelines:__startupProfile.pipelines.length,
        stream:_terrain.userData.textureStreaming??null,effects:_reflectionPipeline.effectsQuality??null})`);
    const shot = async name => {const r=await cdp.send('Page.captureScreenshot',{format:'png'});await writeFile(join(output,name+'.png'),Buffer.from(r.data,'base64'))};
    report.preview = await snapshot();
    if (report.preview.stream && !['preview','disabled'].includes(report.preview.stream.state)) throw new Error('Texture upgrade started before preview capture');
    await shot('initial');
    await cdp.evaluate(`(()=>{
        const m=globalThis.__textureUpgradeMeasurement={start:performance.now(),intervals:[],done:false};
        let last=m.start;
        const sample=()=>{const now=performance.now();m.intervals.push(now-last);last=now;
            const state=_terrain.userData.textureStreaming?.state;
            if(!state || ['complete','disabled','failed'].includes(state)){m.done=true;m.end=now;return;}
            requestAnimationFrame(sample);};
        requestAnimationFrame(sample);_eanpaTest.paused=false;
    })()`);
    await waitUntil(`!_terrain.userData.textureStreaming || ['complete','disabled','failed'].includes(_terrain.userData.textureStreaming.state)`);
    report.textures = await snapshot();
    if (report.textures.stream?.state === 'failed') throw new Error(report.textures.stream.error);
    await waitUntil('__textureUpgradeMeasurement.done');
    report.textureUpgrade = await cdp.evaluate(`(()=>{const m=__textureUpgradeMeasurement;return {
        durationMs:m.end-m.start,maxAnimationFrameIntervalMs:Math.max(0,...m.intervals),
        completedResourceBytes:performance.getEntriesByType('resource').reduce((sum,r)=>sum+r.transferSize,0)}})()`);
    await shot('full-textures');
    const cases = [['quality','performance'],['skybox','ringworld'],['skybox','earth'],['quality','balanced']];
    if (await cdp.evaluate(`!!document.getElementById('effects-quality')`)) cases.push(['effects-quality','performance'],['effects-quality','balanced']);
    for (const [id,value] of cases) {
        console.log(`Measuring ${id} → ${value}…`);
        const before = await cdp.evaluate(`(()=>{const e=document.getElementById(${JSON.stringify(id)});
            if(![...e.options].some(o=>o.value===${JSON.stringify(value)}))throw Error('Unknown control value');
            const result={at:performance.now(),frames:_eanpaTest.completedFrames,pipelines:__startupProfile.pipelines.length,stageIndex:__startupProfile.stages.length};
            globalThis.__switchReady=null;
            const boot=document.getElementById('boot');
            const observer=new MutationObserver(()=>{if(boot.style.display==='none'){
                globalThis.__switchReady={at:performance.now(),frames:_eanpaTest.completedFrames};observer.disconnect();}});
            observer.observe(boot,{attributes:true,attributeFilter:['style']});
            e.value=${JSON.stringify(value)};e.dispatchEvent(new Event('change',{bubbles:true}));return result})()`);
        await waitUntil(`__switchReady && _eanpaTest.completedFrames>__switchReady.frames`, maxSwitchMs);
        const after = await cdp.evaluate(`({at:performance.now(),pipelines:__startupProfile.pipelines.length,warmup:_shaderWarmupStats,
            stages:__startupProfile.stages.slice(${before.stageIndex}),effects:_reflectionPipeline.effectsQuality??null})`);
        const ready = after.stages.find(stage => stage.text === 'ready');
        if (!ready || !after.warmup.weatherGraphReady) throw new Error('Switch did not finish a valid GPU frame');
        const result = {id,value,curtainMs:ready.at-before.at,firstFrameObservedMs:after.at-before.at,
            newPipelines:after.pipelines-before.pipelines,warmup:after.warmup,effects:after.effects};
        report.switches.push(result);console.log(JSON.stringify(result));
        await shot(`${id}-${value}`);
    }
    report.valid = true;
} catch (error) {
    report.valid = false; report.error = String(error.stack ?? error); process.exitCode = 1;
    console.error(error.message);
} finally {
    await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2));
    cdp?.close();
    for (const child of children.reverse()) {
        if (child.exitCode !== null || child.signalCode !== null) continue;
        child.kill();
        await Promise.race([new Promise(done => child.once('exit', done)), sleep(3000)]);
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
    // The profile is an owned mkdtemp directory, never a user browser profile.
    await rm(profile, {recursive: true, force: true, maxRetries: 5, retryDelay: 200});
    console.log(join(output, 'report.json'));
}
