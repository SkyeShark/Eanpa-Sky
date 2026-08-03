#!/usr/bin/env node

// Tiny dependency-free Chrome DevTools Protocol helper for visual smoke tests.
// Usage:
//   node tools/cdp-eanpa.mjs state
//   node tools/cdp-eanpa.mjs eval "document.title"
//   node tools/cdp-eanpa.mjs shot artifacts/current.png

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const port = process.env.CDP_PORT || '9223';
const host = process.env.CDP_HOST || '127.0.0.1';
const fetchHost = host.includes(':') ? `[${host}]` : host;
const targets = await fetch(`http://${fetchHost}:${port}/json/list`).then((r) => r.json());
const target = targets.find((item) => item.type === 'page' && (
    item.url.includes('localhost:8377')
    || item.url.includes('localhost:8378')
    || item.url.includes('127.0.0.1:8378')
))
    ?? targets.find((item) => item.type === 'page');

if (!target?.webSocketDebuggerUrl) {
    throw new Error(`No debuggable page found on CDP port ${port}`);
}

const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolveOpen, rejectOpen) => {
    socket.addEventListener('open', resolveOpen, { once: true });
    socket.addEventListener('error', rejectOpen, { once: true });
});

let nextId = 1;
const pending = new Map();
socket.addEventListener('message', ({ data }) => {
    const message = JSON.parse(data);
    if (!message.id || !pending.has(message.id)) return;
    const { resolve: resolveCall, reject: rejectCall } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) rejectCall(new Error(message.error.message));
    else resolveCall(message.result);
});

function send(method, params = {}) {
    const id = nextId++;
    socket.send(JSON.stringify({ id, method, params }));
    return new Promise((resolveCall, rejectCall) => pending.set(id, { resolve: resolveCall, reject: rejectCall }));
}

async function evaluate(expression) {
    const result = await send('Runtime.evaluate', {
        expression,
        awaitPromise: true,
        returnByValue: true,
        userGesture: true,
    });
    if (result.exceptionDetails) {
        throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    }
    return result.result.value;
}

const command = process.argv[2] ?? 'state';

if (command === 'eval') {
    console.log(JSON.stringify(await evaluate(process.argv.slice(3).join(' ')), null, 2));
} else if (command === 'set') {
    const id = process.argv[3];
    const value = process.argv[4];
    if (!id || value === undefined) throw new Error('Usage: set <element-id> <value>');
    const result = await evaluate(`(async () => {
        const el = document.getElementById(${JSON.stringify(id)});
        if (!el) throw new Error('Missing element: ' + ${JSON.stringify(id)});
        el.value = ${JSON.stringify(value)};
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        for (let i = 0; i < 600 && document.getElementById('boot').style.display !== 'none'; i++) {
            await new Promise((resolveWait) => setTimeout(resolveWait, 50));
        }
        await new Promise((resolveWait) => setTimeout(resolveWait, 1200));
        return { id: el.id, value: el.value, title: document.title };
    })()`);
    console.log(JSON.stringify(result, null, 2));
} else if (command === 'nav') {
    const url = process.argv[3] ?? 'http://localhost:8377/';
    await send('Page.navigate', { url });
    for (let i = 0; i < 900; i++) {
        try {
            const ready = await evaluate(`document.readyState === 'complete'
                && document.getElementById('boot')?.style.display === 'none'`);
            if (ready) break;
        } catch {}
        await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 1200));
    console.log(url);
} else if (command === 'trusted-click') {
    const x = Number(process.argv[3] ?? 8);
    const y = Number(process.argv[4] ?? 8);
    await send('Input.dispatchMouseEvent', {
        type: 'mousePressed', x, y, button: 'left', clickCount: 1,
    });
    await send('Input.dispatchMouseEvent', {
        type: 'mouseReleased', x, y, button: 'left', clickCount: 1,
    });
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
    console.log(JSON.stringify({ x, y }, null, 2));
} else if (command === 'reload-logs') {
    const events = [];
    socket.addEventListener('message', ({ data }) => {
        const message = JSON.parse(data);
        if (message.method === 'Log.entryAdded') {
            events.push({ type: 'log', level: message.params.entry.level, text: message.params.entry.text });
        } else if (message.method === 'Runtime.consoleAPICalled') {
            const text = message.params.args.map((arg) => arg.value ?? arg.description ?? '').join(' ');
            events.push({ type: 'console', level: message.params.type, text });
        } else if (message.method === 'Runtime.exceptionThrown') {
            events.push({ type: 'exception', level: 'error', text: message.params.exceptionDetails.text });
        }
    });
    await send('Log.enable');
    await send('Runtime.enable');
    await send('Page.reload', { ignoreCache: true });
    for (let i = 0; i < 900; i++) {
        try {
            const ready = await evaluate(`document.readyState === 'complete'
                && document.getElementById('boot')?.style.display === 'none'`);
            if (ready) break;
        } catch {}
        await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 1800));
    console.log(JSON.stringify(events.filter((event) => event.level === 'error'
        || /validation|pipeline|shader|binding|texture/i.test(event.text)), null, 2));
} else if (command === 'rawshot') {
    // Capture the currently submitted canvas exactly as-is. Reflection parity
    // tests pause the app and submit a deliberately isolated raw scene pass,
    // so the normal one-more-frame pause handshake would overwrite it.
    const output = resolve(process.argv[3] ?? 'artifacts/eanpa-raw.png');
    const jpeg = /\.jpe?g$/i.test(output);
    await send('Page.bringToFront');
    const shotScale = Math.max(0.1, Math.min(1, Number(process.env.SHOT_SCALE || 1)));
    const layout = shotScale < 1 ? await send('Page.getLayoutMetrics') : null;
    const viewport = layout?.cssVisualViewport ?? layout?.visualViewport;
    const { data } = await send('Page.captureScreenshot', {
        format: jpeg ? 'jpeg' : 'png',
        quality: jpeg ? Number(process.env.SHOT_QUALITY || 72) : undefined,
        fromSurface: true,
        clip: viewport ? {
            x: viewport.pageX ?? 0,
            y: viewport.pageY ?? 0,
            width: viewport.clientWidth,
            height: viewport.clientHeight,
            scale: shotScale,
        } : undefined,
    });
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, Buffer.from(data, 'base64'));
    console.log(output);
} else if (command === 'shot') {
    const output = resolve(process.argv[3] ?? 'artifacts/eanpa.png');
    const jpeg = /\.jpe?g$/i.test(output);
    await send('Page.bringToFront');
    let paused = false;
    try {
        paused = await evaluate(`(async () => {
            if (!globalThis._eanpaTest) return false;
            globalThis._eanpaTest.pauseAfterFrame = true;
            globalThis._eanpaTest.paused = false;
            for (let i = 0; i < 3000 && !globalThis._eanpaTest.paused; i++) {
                await new Promise((resolveWait) => setTimeout(resolveWait, 10));
            }
            await new Promise((resolveWait) => setTimeout(resolveWait, 80));
            return globalThis._eanpaTest.paused;
        })()`);
        const shotScale = Math.max(0.1, Math.min(1, Number(process.env.SHOT_SCALE || 1)));
        const layout = shotScale < 1 ? await send('Page.getLayoutMetrics') : null;
        const viewport = layout?.cssVisualViewport ?? layout?.visualViewport;
        const { data } = await send('Page.captureScreenshot', {
            format: jpeg ? 'jpeg' : 'png',
            quality: jpeg ? Number(process.env.SHOT_QUALITY || 72) : undefined,
            fromSurface: true,
            clip: viewport ? {
                x: viewport.pageX ?? 0,
                y: viewport.pageY ?? 0,
                width: viewport.clientWidth,
                height: viewport.clientHeight,
                scale: shotScale,
            } : undefined,
        });
        await mkdir(dirname(output), { recursive: true });
        await writeFile(output, Buffer.from(data, 'base64'));
    } finally {
        await evaluate(`(() => {
            if (!globalThis._eanpaTest) return;
            globalThis._eanpaTest.pauseAfterFrame = false;
            globalThis._eanpaTest.paused = false;
        })()`);
    }
    console.log(output);
} else if (command === 'state') {
    const state = await evaluate(`(() => {
        const value = (id) => document.getElementById(id)?.value;
        const errorBox = [...document.body.children].find((el) => el.style?.zIndex === '99');
        const u = globalThis._sky?.uniforms;
        return {
            title: document.title,
            ready: document.getElementById('boot')?.style.display === 'none',
            skybox: value('skybox'),
            quality: value('quality'),
            weather: value('weather'),
            time: value('tod'),
            error: errorBox?.textContent?.trim() || null,
            preset: globalThis._sky?.state?.preset ?? null,
            cloudPasses: globalThis._sky?.domes?.[1]?.material ? 'compiled' : null,
            wispColor: u?.wispColor?.value?.toArray?.() ?? null,
            wispOn: u?.wispOn?.value ?? null,
            sceneEnvironment: globalThis._sky?.domes?.[0]?.parent?.environment?.name ?? null,
        };
    })()`);
    console.log(JSON.stringify(state, null, 2));
} else if (command === 'gesture') {
    // A real CDP input event (unlike dispatchEvent) carries isTrusted=true and
    // a browser user-activation token. Useful for autoplay-gated smoke tests.
    await send('Input.dispatchKeyEvent', {
        type: 'keyDown', code: 'KeyX', key: 'x', text: 'x',
        windowsVirtualKeyCode: 88, nativeVirtualKeyCode: 88,
    });
    await send('Input.dispatchKeyEvent', {
        type: 'keyUp', code: 'KeyX', key: 'x',
        windowsVirtualKeyCode: 88, nativeVirtualKeyCode: 88,
    });
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    console.log(JSON.stringify(await evaluate(`({
        audioContext: globalThis._audio?.context?.state ?? null,
        audio: globalThis._audio?.stats ?? null,
    })`), null, 2));
} else {
    throw new Error(`Unknown command: ${command}`);
}

socket.close();
