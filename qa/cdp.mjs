import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export async function connect() {
    let target;
    for (let i=0;i<40&&!target;i++) {
        const targets = await fetch('http://127.0.0.1:9223/json/list').then(r => r.json());
        const pages = targets.filter(t => t.type === 'page');
        if (pages.length > 1) throw new Error('Expected one owned inspection page');
        target = pages.find(t => t.url.startsWith('http://127.0.0.1:8378/')
            || (t.url.startsWith('https://skyeshark.github.io/Eanpa-Sky/')
                && new URL(t.url).searchParams.has('automated')));
        if (!target) await new Promise(r=>setTimeout(r,250));
    }
    if (!target) throw new Error('Owned Eanpa QA page not found');
    const socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((done, reject) => {
        socket.addEventListener('open', done, { once: true });
        socket.addEventListener('error', reject, { once: true });
    });
    const pending = new Map(),listeners=new Map(); let nextId = 0;
    socket.addEventListener('message', ({ data }) => {
        const message = JSON.parse(data), call = pending.get(message.id);
        if(message.method)for(const listener of listeners.get(message.method)??[])listener(message.params);
        if (!call) return;
        clearTimeout(call.timeout); pending.delete(message.id);
        if (message.error) call.reject(new Error(JSON.stringify(message.error)));
        else call.done(message.result);
    });
    const send = (method, params = {}, timeoutMs = 45000) => new Promise((done, reject) => {
        const id = ++nextId;
        const timeout = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)); }, timeoutMs);
        pending.set(id, { done, reject, timeout });
        socket.send(JSON.stringify({ id, method, params }));
    });
    const evaluate = async expression => {
        const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
        if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
        return result.result.value;
    };
    return { send, evaluate, on(method,listener){
        const set=listeners.get(method)??new Set();listeners.set(method,set);set.add(listener);
        return ()=>{set.delete(listener);if(!set.size)listeners.delete(method);};
    }, close() {
        for (const call of pending.values()) { clearTimeout(call.timeout); call.reject(new Error('CDP closed')); }
        pending.clear();listeners.clear(); socket.close();
    } };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const cdp = await connect();
    try {
        const [action, argument, value] = process.argv.slice(2);
        if (action === 'eval') console.log(JSON.stringify(await cdp.evaluate(await readFile(argument, 'utf8')), null, 2));
        else if (action === 'shot') {
            const result = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
            await mkdir(dirname(resolve(argument)), { recursive: true });
            await writeFile(argument, Buffer.from(result.data, 'base64'));
            console.log(resolve(argument));
        } else if (action === 'set') {
            console.log(await cdp.evaluate(`(() => { const element = document.getElementById(${JSON.stringify(argument)});
                if (!element) throw new Error('Missing control'); element.value = ${JSON.stringify(value)};
                element.dispatchEvent(new Event('input', { bubbles: true }));
                element.dispatchEvent(new Event('change', { bubbles: true })); return element.value; })()`));
        } else if (action === 'reload') await cdp.send('Page.reload', { ignoreCache: true });
        else if (action === 'viewport') await cdp.send('Emulation.setDeviceMetricsOverride', {
            width: Number(argument), height: Number(value), deviceScaleFactor: 1, mobile: false,
        });
        else throw new Error('Use eval <expression-file>, shot <png>, set <id> <value>, reload, viewport <width> <height>');
    } finally { cdp.close(); }
}
