// One owned browser + loopback server for the overhaul. Never attach to the
// user's Chrome profile. `stop` closes our browser through CDP, then our server.
import { spawn } from 'node:child_process';
import { open, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const directory = resolve(root, '.artifacts/overhaul-20260906');
const stateFile = resolve(directory, 'processes.json');
const serverPort = 8378, cdpPort = 9223;
const listening = port => new Promise(resolvePort => {
    const socket = createConnection({ host: '127.0.0.1', port });
    socket.setTimeout(1000);
    const finish = value => { socket.destroy(); resolvePort(value); };
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.once('timeout', () => finish(false));
});
const sleep = ms => new Promise(resolveWait => setTimeout(resolveWait, ms));
const action = process.argv[2] ?? 'status';
if (action === 'start' || action === 'preview') {
    let existing = null;
    if (action === 'preview') {
        existing = JSON.parse(await readFile(stateFile, 'utf8'));
        if (existing.serverPort !== serverPort || existing.cdpPort !== cdpPort
            || !await listening(serverPort)) throw new Error('Existing owned server not available');
        process.kill(existing.serverPid, 0);
        try {
            process.kill(existing.browserPid, 0);
            throw new Error('Owned browser is still alive; no second browser launched');
        } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
    if ((!existing && await listening(serverPort)) || await listening(cdpPort)) {
        throw new Error('QA port already occupied; inspect/reuse the existing session. No process launched.');
    }
    await mkdir(directory, { recursive: true });
    // Windows environment dictionaries are case insensitive; some hosts expose
    // both Path and PATH, which breaks PowerShell Start-Process.
    const env = Object.fromEntries(Object.entries(process.env)
        .filter(([key], index, entries) => entries.findIndex(([other]) =>
            other.toLowerCase() === key.toLowerCase()) === index));
    const start = async (executable, args, name) => {
        const stdout = await open(resolve(directory, `${name}.out.log`), 'a');
        const stderr = await open(resolve(directory, `${name}.err.log`), 'a');
        try {
            const child = spawn(executable, args, {
                cwd: root, env, windowsHide: true, detached: true,
                stdio: ['ignore', stdout.fd, stderr.fd],
            });
            await new Promise((resolveSpawn, reject) => {
                child.once('spawn', resolveSpawn); child.once('error', reject);
            });
            child.unref();
            return child;
        } finally { await stdout.close(); await stderr.close(); }
    };
    const profile = resolve(directory, 'browser');
    const owned = [];
    try {
        const server = existing ? { pid: existing.serverPid }
            : await start('C:/Python314/python.exe', ['tools/dev-server.py', String(serverPort)], 'server');
        if (!existing) owned.push(server);
        const browser = await start('C:/Program Files/Google/Chrome/Application/chrome.exe', [
            '--headless=new', `--remote-debugging-port=${cdpPort}`,
            '--remote-debugging-address=127.0.0.1', `--user-data-dir=${profile}`,
            '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
            '--enable-unsafe-webgpu', '--window-size=1600,1000',
            `http://127.0.0.1:${serverPort}/?benchmark=1&automated=1`,
        ], 'chrome');
        owned.push(browser);
        const state = { serverPid: server.pid, browserPid: browser.pid, profile,
            serverPort, cdpPort, headless: true, started: new Date().toISOString() };
        await writeFile(stateFile, JSON.stringify(state, null, 2));
        for (let i = 0; i < 40; i++) {
            if (await listening(serverPort) && await listening(cdpPort)) break;
            await sleep(250);
        }
        if (!await listening(serverPort) || !await listening(cdpPort)) throw new Error('QA startup failed; see owned process logs');
        console.log(JSON.stringify(state, null, 2));
    } catch (error) {
        for (const child of owned.reverse()) child.kill();
        throw error;
    }
} else if (action === 'review') {
    const state = JSON.parse(await readFile(stateFile, 'utf8'));
    if (!await listening(serverPort) || !await listening(cdpPort)) {
        throw new Error('Review handoff requires the existing owned browser and server. Nothing launched.');
    }
    const targets = await fetch(`http://127.0.0.1:${cdpPort}/json/list`).then(r => r.json());
    if (!targets.some(t => t.type === 'page' && t.url.startsWith(`http://127.0.0.1:${serverPort}/`))) {
        throw new Error('Owned preview identity does not match; nothing closed or launched.');
    }
    const version = await fetch(`http://127.0.0.1:${cdpPort}/json/version`).then(r => r.json());
    const socket = new WebSocket(version.webSocketDebuggerUrl);
    await new Promise((done, reject) => {
        socket.addEventListener('open', done, { once: true });
        socket.addEventListener('error', reject, { once: true });
    });
    socket.send(JSON.stringify({ id: 1, method: 'Browser.close' }));
    await new Promise(done => {
        socket.addEventListener('close', done, { once: true });
        setTimeout(() => { socket.close(); done(); }, 2000);
    });
    const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) {
        if (error.code === 'ESRCH') return false; throw error;
    } };
    for (let i = 0; i < 60 && (alive(state.browserPid) || await listening(cdpPort)); i++) await sleep(250);
    if (alive(state.browserPid) || await listening(cdpPort)) {
        throw new Error('The owned headless browser has not exited. No second browser launched.');
    }
    const stdout = await open(resolve(directory, 'chrome-review.out.log'), 'a');
    const stderr = await open(resolve(directory, 'chrome-review.err.log'), 'a');
    let browser;
    try {
        // The user explicitly requested a visible, interactable review window.
        // Reuse our dedicated profile and the original server; remove only the
        // automation flag that intentionally prevents mouse capture in QA.
        browser = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', [
            `--remote-debugging-port=${cdpPort}`, '--remote-debugging-address=127.0.0.1',
            `--user-data-dir=${state.profile}`, '--no-first-run', '--no-default-browser-check',
            '--disable-background-networking', '--enable-unsafe-webgpu', '--window-size=1600,1000',
            `http://127.0.0.1:${serverPort}/?benchmark=1`,
        ], { cwd: root, windowsHide: false, detached: true, stdio: ['ignore', stdout.fd, stderr.fd] });
        await new Promise((done, reject) => { browser.once('spawn', done); browser.once('error', reject); });
        browser.unref();
        Object.assign(state, { browserPid: browser.pid, headless: false, reviewStarted: new Date().toISOString() });
        await writeFile(stateFile, JSON.stringify(state, null, 2));
    } finally { await stdout.close(); await stderr.close(); }
    console.log(JSON.stringify(state, null, 2));
} else if (action === 'stop') {
    const state = JSON.parse(await readFile(stateFile, 'utf8'));
    if (await listening(cdpPort)) {
        const version = await fetch(`http://127.0.0.1:${cdpPort}/json/version`).then(r => r.json());
        const socket = new WebSocket(version.webSocketDebuggerUrl);
        await new Promise((resolveOpen, reject) => {
            socket.addEventListener('open', resolveOpen, { once: true });
            socket.addEventListener('error', reject, { once: true });
        });
        socket.send(JSON.stringify({ id: 1, method: 'Browser.close' }));
        await new Promise(resolveClose => {
            socket.addEventListener('close', resolveClose, { once: true });
            setTimeout(() => { socket.close(); resolveClose(); }, 2000);
        });
    }
    if (state.serverPid) {
        try { process.kill(state.serverPid); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
    state.stopped = new Date().toISOString();
    await writeFile(stateFile, JSON.stringify(state, null, 2));
    console.log('Owned QA browser and server stopped.');
} else if (action === 'status') {
    console.log(JSON.stringify({ server: await listening(serverPort), browser: await listening(cdpPort),
        state: JSON.parse(await readFile(stateFile, 'utf8').catch(() => 'null')) }, null, 2));
} else throw new Error('Use start, preview, status, review, or stop');
