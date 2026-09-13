import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {read} from '../vendor/three/addons/libs/ktx-parse.module.js';
import {terrainPreview} from '../qa/build-terrain-previews.mjs';

test('shipped previews preserve the exact full-resolution mip payloads and channel metadata', async () => {
    const root = new URL('../assets/pbr/eanpa_southwest_ground_v3/runtime/', import.meta.url);
    for (const channels of ['AlbedoHeight', 'PackedNxyRoughAO']) {
        const stem = `SouthwestGroundV3_${channels}`;
        const source = await readFile(new URL(`${stem}_14x2K_UASTC.ktx2`, root));
        const shipped = await readFile(new URL(`preview_512/${stem}_14x512_UASTC.ktx2`, root));
        assert.deepEqual(new Uint8Array(shipped), terrainPreview(source));
        const full = read(source), preview = read(shipped);
        assert.equal(preview.pixelWidth, 512); assert.equal(preview.pixelHeight, 512);
        assert.equal(preview.layerCount, 14); assert.equal(preview.levelCount, 10);
        assert.deepEqual(preview.dataFormatDescriptor, full.dataFormatDescriptor);
        assert.deepEqual(preview.levels, full.levels.slice(2));
        assert.throws(() => terrainPreview(source, 333), /Expected/);
    }
});
