// Owns an isolated browser and server for startup, texture upgrades, and UI switches.
// Usage: node qa/performance-review.mjs LABEL
import {spawn} from 'node:child_process';
import {createConnection} from 'node:net';
import {mkdir, mkdtemp, open, readFile, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {basename, dirname, join, resolve} from 'node:path';
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
if (dirname(resolve(profile)) !== resolve(tmpdir()) || !basename(profile).startsWith('eanpa-performance-'))
    throw new Error('Unexpected owned profile directory');
const children = [];
let cdp;
const runtimeErrors = [];
const launch = async (command, args, name) => {
    const log = await open(join(output, `${name}.log`), 'w');
    try {
        const child = spawn(command, args, {cwd: root, windowsHide: true, stdio: ['ignore', log.fd, log.fd]});
        child.role = name;
        child.completed = new Promise(done => child.once('exit', done));
        await new Promise((done, reject) => {child.once('spawn', done); child.once('error', reject)});
        children.push(child);
        return child;
    } finally {await log.close()}
};
const healthExpression = `({
    failedFrames:globalThis._eanpaTest?.failedFrames??0,
    pipelineFailures:globalThis.__startupProfile?.pipelines.filter(p=>p.failed).length??0,
    cloudFailures:globalThis._spatialClouds?.captureStats?.failures??0,
    errors:[...document.body.children].filter(e=>e.style?.zIndex==='99').map(e=>e.textContent).filter(Boolean)
})`;
const checkHealth = async () => {
    const health = await cdp.evaluate(healthExpression);
    const errors = [...health.errors, ...runtimeErrors];
    if (health.failedFrames || health.pipelineFailures || health.cloudFailures || errors.length)
        throw new Error(`Invalid rendered frame: ${JSON.stringify({...health, errors})}`);
    return health;
};
const waitUntil = async (expression, timeout = 180000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
        await checkHealth();
        if (await cdp.evaluate(expression)) { await checkHealth(); return; }
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
        '--enable-unsafe-webgpu', '--force-device-scale-factor=1',
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
    if (initial.valid !== true || initial.warmup?.weatherGraphReady !== true || (initial.failedFrames ?? 0) > 0)
        throw new Error('Initial startup did not finish valid GPU warmup; see the startup artifact');
    report.startup = {readyMs: initial.profile.readyAt, warmup: initial.warmup, settings: initial.settings,
        transferBytes: initial.resources.reduce((sum, r) => sum + (r.bytes ?? 0), 0)};
    cdp = await connect();
    cdp.on('Runtime.consoleAPICalled', event => {
        if (event.type === 'error') runtimeErrors.push(event.args.map(arg => arg.value ?? arg.description).join(' '));
    });
    cdp.on('Runtime.exceptionThrown', event => runtimeErrors.push(event.exceptionDetails.exception?.description ?? event.exceptionDetails.text));
    await cdp.send('Runtime.enable');
    await checkHealth();
    report.adapter = await cdp.evaluate(`(async()=>{const a=await navigator.gpu.requestAdapter({powerPreference:'high-performance'});
        return {vendor:a.info.vendor,architecture:a.info.architecture,description:a.info.description,features:[...a.features]}})()`);
    const snapshot = () => cdp.evaluate(`({frames:_eanpaTest.completedFrames,pipelines:__startupProfile.pipelines.length,
        stream:_terrain.userData.textureStreaming??null,effects:_reflectionPipeline.effectsQuality??null})`);
    const shot = async name => {const r=await cdp.send('Page.captureScreenshot',{format:'png'});await writeFile(join(output,name+'.png'),Buffer.from(r.data,'base64'))};
    report.preview = await snapshot();
    if (report.preview.stream && !['preview','disabled'].includes(report.preview.stream.state)) throw new Error('Texture upgrade started before preview capture');
    await shot('initial');
    report.textureUpgrade = null;
    if (report.preview.stream?.state === 'preview') {
      await cdp.evaluate(`(()=>{
        const m=globalThis.__textureUpgradeMeasurement={start:performance.now(),maxInterval:0,done:false};
        let last=m.start;
        const sample=()=>{const now=performance.now();m.maxInterval=Math.max(m.maxInterval,now-last);last=now;
            const state=_terrain.userData.textureStreaming?.state;
            if(!state || ['complete','disabled','failed'].includes(state)){m.done=true;m.end=now;return;}
            requestAnimationFrame(sample);};
        requestAnimationFrame(sample);_eanpaTest.paused=false;
      })()`);
      await waitUntil(`['complete','failed'].includes(_terrain.userData.textureStreaming?.state)`);
      report.textures = await snapshot();
      if (report.textures.stream.state === 'failed') throw new Error(report.textures.stream.error);
      await waitUntil('__textureUpgradeMeasurement.done');
      report.textureUpgrade = await cdp.evaluate(`(()=>{const m=__textureUpgradeMeasurement;return {
        durationMs:m.end-m.start,maxAnimationFrameIntervalMs:m.maxInterval,
        completedResourceBytes:performance.getEntriesByType('resource').reduce((sum,r)=>sum+r.transferSize,0)}})()`);
    } else {
      await cdp.evaluate('_eanpaTest.paused=false');
      report.textures = await snapshot();
    }
    await shot('full-textures');
    await checkHealth();
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
        await checkHealth();
    }
    report.finalHealth = await checkHealth();
    report.valid = true;
} catch (error) {
    report.valid = false; report.error = String(error.stack ?? error); process.exitCode = 1;
    console.error(error.message);
} finally {
    // A failed report or cleanup step must not bypass the remaining resources.
    const cleanupErrors = [];
    const attempt = async action => { try { await action(); } catch (error) { cleanupErrors.push(error); } };
    const exited = child => child.exitCode !== null || child.signalCode !== null;
    const waitForExit = async child => {
        let timer;
        try { await Promise.race([child.completed, new Promise(done => {timer=setTimeout(done,3000)})]); }
        finally { clearTimeout(timer); }
    };
    await attempt(() => writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2)));
    const browser = children.find(child => child.role === 'browser');
    if (cdp && browser && !exited(browser)) {
        // Browser.close can close the socket before its acknowledgement arrives.
        await cdp.send('Browser.close', {}, 3000).catch(() => {});
    }
    await attempt(() => cdp?.close());
    for (const child of [...children].reverse()) {
        await attempt(async () => {
            if (exited(child)) return;
            if (child.role === 'browser' && cdp) await waitForExit(child);
            if (!exited(child)) { child.kill(); await waitForExit(child); }
            if (!exited(child)) { child.kill('SIGKILL'); await waitForExit(child); }
            if (!exited(child)) throw new Error(`Owned ${child.role} did not exit`);
        });
    }
    // Only remove this run's verified mkdtemp directory after its browser exits.
    if (!browser || exited(browser))
        await attempt(() => rm(profile, {recursive: true, force: true, maxRetries: 5, retryDelay: 200}));
    if (cleanupErrors.length) throw new AggregateError(cleanupErrors, 'Benchmark report/cleanup failed');
    console.log(join(output, 'report.json'));
}
