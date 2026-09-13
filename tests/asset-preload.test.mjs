import test from 'node:test';
import assert from 'node:assert/strict';
import {preloadTasks, loadOptionalGLTF} from '../src/asset_preload.js';

test('preload bounds concurrency and preserves asset ordering', async () => {
    let active = 0, peak = 0;
    const values = await preloadTasks(Array.from({length: 12}, (_, i) => async () => {
        peak = Math.max(peak, ++active);
        await new Promise(resolve => setTimeout(resolve, (12 - i) % 3));
        active--;
        return i;
    }), 3);
    assert.equal(peak, 3);
    assert.deepEqual(values, Array.from({length: 12}, (_, i) => i));
});

test('preload failures stop queued work and remain observable by a later consumer', async () => {
    let queuedRan = false;
    const pending = preloadTasks([
        async () => {throw new Error('unavailable')},
        async () => {queuedRan = true},
    ], 1);
    await new Promise(resolve => setTimeout(resolve, 0));
    await assert.rejects(pending, /unavailable/);
    assert.equal(queuedRan, false);
});

test('optional GLB uses one GET, keeps external resource base, and only tolerates missing files', async () => {
    const calls = [], data = new ArrayBuffer(4);
    const loader = {async parseAsync(bytes, path) {assert.equal(bytes, data); return path}};
    const options = {baseURL: 'https://example.com/demo/', request: async url => {
        calls.push(url); return {ok: true, status: 200, arrayBuffer: async () => data};
    }};
    assert.equal(await loadOptionalGLTF(loader, './assets/tree.glb', options), 'https://example.com/demo/assets/');
    assert.deepEqual(calls, ['./assets/tree.glb']);
    assert.equal(await loadOptionalGLTF(loader, './missing.glb', {...options, request: async () => ({status: 404})}), null);
    await assert.rejects(loadOptionalGLTF(loader, './broken.glb', {...options, request: async () => ({status: 500})}), /HTTP 500/);
});
