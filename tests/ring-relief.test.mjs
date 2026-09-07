import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { DataUtils } from '../vendor/three/three.core.js';
import { decodeRingRelief } from '../src/ring_relief.js';
import { readPng } from '../qa/png-data.mjs';

const bytes = gunzipSync(await readFile(new URL('../assets/ringworld/ring_relief_v3.bin.gz', import.meta.url)));
const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
const manifest = JSON.parse(await readFile(new URL('../assets/ringworld/ring_relief_v3.json', import.meta.url)));

test('baked relief matches its manifest and has finite height and unit normals', () => {
    assert.equal(createHash('sha256').update(bytes).digest('hex'), manifest.sha256);
    const decoded = decodeRingRelief(buffer);
    assert.equal(decoded.width, manifest.width); assert.equal(decoded.height, manifest.height);
    for (let i = 0; i < decoded.heightData.length; i++) {
        const h = DataUtils.fromHalfFloat(decoded.heightData[i]);
        assert.ok(Number.isFinite(h) && h >= 0 && h <= 1);
        const n = decoded.normalAoData.subarray(i * 4, i * 4 + 3);
        const length = Math.hypot(...Array.from(n, c => c / 127.5 - 1));
        assert.ok(Math.abs(length - 1) < 0.007, 'normal quantization stays bounded');
    }
});

test('the original water/shore field survives the bake and vertical storage flip', async () => {
    const source = await readPng(new URL('../assets/ringworld/ring_band_height.png', import.meta.url));
    const decoded = decodeRingRelief(buffer);
    let samples = 0;
    for (let y = 0; y < source.height; y++) for (let x = 0; x < source.width; x++) {
        const original = source.data[(y * source.width + x) * source.channels] / 255;
        if (original >= 0.045) continue;
        const h = DataUtils.fromHalfFloat(decoded.heightData[(source.height - 1 - y) * source.width + x]);
        assert.ok(Math.abs(h - original) < 0.00004);
        samples++;
    }
    assert.ok(samples > 1000);
});

test('invalid terrain payloads fail before texture allocation', () => {
    assert.throws(() => decodeRingRelief(new ArrayBuffer(8)), /header/);
    assert.throws(() => decodeRingRelief(new ArrayBuffer(16)), /format/);
    assert.throws(() => decodeRingRelief(buffer.slice(0, buffer.byteLength - 1)), /length/);
});
