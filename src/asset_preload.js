// Observe failures immediately: consumers await this batch later in boot.
export function preloadTasks(tasks, concurrency = 4) {
    if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error('Invalid preload concurrency');
    const result = new Array(tasks.length);
    let next = 0, failed = false;
    const worker = async () => {
        while (!failed && next < tasks.length) {
            const index = next++;
            try { result[index] = await tasks[index](); }
            catch (error) { failed = true; throw error; }
        }
    };
    const pending = Promise.all(Array.from({length: Math.min(concurrency, tasks.length)}, worker))
        .then(() => result);
    pending.catch(() => {});
    return pending;
}

export async function loadOptionalGLTF(loader, url, {request = fetch, baseURL = globalThis.location?.href} = {}) {
    const response = await request(url);
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`Model ${url}: HTTP ${response.status}`);
    const path = new URL('.', new URL(url, baseURL)).href;
    return loader.parseAsync(await response.arrayBuffer(), path);
}
