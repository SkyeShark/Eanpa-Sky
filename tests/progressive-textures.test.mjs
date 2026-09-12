import test from 'node:test';
import assert from 'node:assert/strict';
import {makeProgressiveTextures} from '../src/progressive_textures.js';
import {Texture, TextureNode, TSL} from '../vendor/three/three.webgpu.js';

function fixture(loadOverride, uploadOverride) {
    const texture = () => {const t = new Texture(); t.disposals = 0; t.addEventListener('dispose', () => t.disposals++); return t};
    const initial = {albedo: texture(), packed: texture()}, full = {albedo: texture(), packed: texture()};
    const textures = {...initial}, nodes = Object.fromEntries(Object.entries(initial).map(([k, t]) => [k, new TextureNode(t)]));
    const samples = Object.fromEntries(Object.entries(nodes).map(([k, n]) => [k, n.sample(TSL.vec2(.5)).depth(2).level(1)]));
    const uploads = [];
    let loads = 0, publications = 0;
    const stream = makeProgressiveTextures({textures, nodes, load: async () => {loads++; return loadOverride ? loadOverride() : full},
        upload: uploadOverride ?? (t => uploads.push(t)), onPublish: () => publications++});
    return {stream, textures, samples, initial, full, uploads, counts: () => ({loads, publications})};
}
const settle = () => new Promise(resolve => setTimeout(resolve, 0));

test('first frame starts loading; one upload per frame; pair and chained samples publish together', async () => {
    const f = fixture();
    assert.equal(f.counts().loads, 0);
    f.stream.update(); await settle();
    for (let i = 0; i < 2; i++) {
        assert.equal(f.stream.update(), false);
        assert.equal(f.uploads.length, i + 1);
        for (const key of ['albedo', 'packed']) assert.equal(f.samples[key].value, f.initial[key]);
    }
    assert.equal(f.stream.update(), true);
    for (const key of ['albedo', 'packed']) {
        assert.equal(f.samples[key].value, f.full[key]);
        assert.equal(f.initial[key].disposals, 1);
    }
    f.stream.update(); assert.deepEqual(f.counts(), {loads: 1, publications: 1});
    f.stream.dispose(); f.stream.dispose();
    for (const texture of Object.values(f.full)) assert.equal(texture.disposals, 1);
});

test('download and upload failures keep the preview usable', async () => {
    const failed = fixture(async () => {throw new Error('offline')});
    failed.stream.update(); await settle();
    assert.equal(failed.stream.stats.state, 'failed');
    assert.equal(failed.stream.stats.error, 'offline');
    const upload = fixture(null, () => {throw new Error('upload failed')});
    upload.stream.update(); await settle(); upload.stream.update();
    for (const key of ['albedo', 'packed']) {
        assert.equal(upload.samples[key].value, upload.initial[key]);
        assert.equal(upload.initial[key].disposals, 0);
        assert.equal(upload.full[key].disposals, 1);
    }
    failed.stream.dispose(); upload.stream.dispose();
});

test('disposal during download retires late resources without publication', async () => {
    let resolve;
    const f = fixture(() => new Promise(r => {resolve = r}));
    f.stream.update(); await settle();
    f.stream.dispose(); resolve(f.full); await settle();
    assert.equal(f.stream.stats.state, 'disposed');
    assert.equal(f.counts().publications, 0);
    for (const set of [f.initial, f.full]) for (const texture of Object.values(set)) assert.equal(texture.disposals, 1);
});

test('disposal after a partial upload releases both pending textures', async () => {
    const f = fixture(); f.stream.update(); await settle(); f.stream.update(); f.stream.dispose();
    for (const set of [f.initial, f.full]) for (const texture of Object.values(set)) assert.equal(texture.disposals, 1);
});
