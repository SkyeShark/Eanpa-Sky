import { connect } from './cdp.mjs';
import { mkdir, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const [version = 'current', capture = 'stills'] = process.argv.slice(2);
if (!['current', 'before', 'radiant'].includes(version) || !['stills', 'motion'].includes(capture)) {
    throw new Error('Use current|before|radiant and stills|motion');
}
const c = await connect();
const directory = '.artifacts/redgiant-20260910';
try {
    await mkdir(directory, { recursive: true });
    const reference = { before: '3708772', radiant: '2cfca90' }[version];
    if (reference) {
        const { stdout } = await promisify(execFile)('git', [
            '-c', `safe.directory=${process.cwd().replaceAll('\\', '/')}`,
            'show', `${reference}:engine/redgiant.js`,
        ], { windowsHide: true, maxBuffer: 1024 * 1024 });
        await writeFile(`${directory}/${version}.js`, stdout);
    }
    await c.send('Page.navigate', { url: `http://127.0.0.1:8378/qa/redgiant-fixture.html?version=${version}` });
    const deadline = Date.now() + 55000;
    while (!await c.evaluate(`globalThis.__starFixture?.ready === true && __starFixture.version === '${version}'`)) {
        if (Date.now() > deadline) throw new Error('Star shader preparation timed out');
        await new Promise(resolve => setTimeout(resolve, 500));
    }
    const result = await c.evaluate(`(async () => {
        const f = __starFixture, canvas = f.renderer.domElement, frames = [];
        for (const time of [8, 8.5, 9, 10, 12, 16]) {
            await f.frame(time);
            frames.push({ time, png: canvas.toDataURL('image/png') });
        }
        let video = null, actualSeconds = null;
        if ('${capture}' === 'motion') {
            await f.frame(8);
            const stream = canvas.captureStream(30), chunks = [];
            const recorder = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8', videoBitsPerSecond: 7000000 });
            recorder.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
            const finished = new Promise(resolve => recorder.onstop = resolve);
            const wall = performance.now(); recorder.start();
            try {
                while (performance.now() - wall < 8000) {
                    const frameStart = performance.now();
                    await f.frame(8 + (frameStart - wall) / 1000);
                    await new Promise(resolve => setTimeout(resolve, Math.max(1, 1000 / 30 - (performance.now() - frameStart))));
                }
            } finally { recorder.stop(); await finished; stream.getTracks().forEach(track => track.stop()); }
            actualSeconds = (performance.now() - wall) / 1000;
            video = await new Promise(resolve => {
                const reader = new FileReader(); reader.onload = () => resolve(reader.result);
                reader.readAsDataURL(new Blob(chunks, { type: recorder.mimeType }));
            });
        }
        return { version: f.version, date: new Date().toISOString(), frames, video, actualSeconds,
            simulationSpeed: 1, flares: f.star.flares, errors: f.errors,
            scope: 'Production celestial shader in isolation, ACES at exposure 1, 52 degree FOV',
            pointerLocked: !!document.pointerLockElement };
    })()`);
    for (const frame of result.frames) {
        await writeFile(`${directory}/${version}-${frame.time}.png`, Buffer.from(frame.png.split(',')[1], 'base64'));
    }
    if (result.video) await writeFile(`${directory}/${version}.webm`, Buffer.from(result.video.split(',')[1], 'base64'));
    delete result.video;
    result.frames = result.frames.map(({ time }) => ({ time }));
    await writeFile(`${directory}/${version}.json`, JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result));
    if (result.errors.length) throw new Error('Star render reported errors');
} finally { c.close(); }
