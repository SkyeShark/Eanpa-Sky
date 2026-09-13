// Retain existing UASTC mip payloads: no new lossy encoding or channel conversion.
import {read, write} from '../vendor/three/addons/libs/ktx-parse.module.js';
import {readFile, writeFile, mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';

export function terrainPreview(bytes, size = 512) {
    const texture = read(bytes);
    const drop = Math.log2(texture.pixelWidth / size);
    if (texture.pixelWidth !== texture.pixelHeight || !Number.isInteger(drop) || drop < 1
        || texture.dataFormatDescriptor[0]?.colorModel !== 166 || texture.globalData
        || texture.supercompressionScheme !== 2 || texture.layerCount !== 14
        || texture.faceCount !== 1 || texture.pixelDepth !== 0 || drop >= texture.levels.length) {
        throw new Error('Expected a mipmapped 14-layer UASTC/Zstd terrain array');
    }
    texture.pixelWidth = texture.pixelHeight = size;
    texture.levels = texture.levels.slice(drop);
    texture.levelCount = texture.levels.length;
    return write(texture);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const root = new URL('../assets/pbr/eanpa_southwest_ground_v3/runtime/', import.meta.url);
    await mkdir(new URL('preview_512/', root), {recursive: true});
    for (const channels of ['AlbedoHeight', 'PackedNxyRoughAO']) {
        const stem = `SouthwestGroundV3_${channels}`;
        const bytes = terrainPreview(await readFile(new URL(`${stem}_14x2K_UASTC.ktx2`, root)));
        await writeFile(new URL(`preview_512/${stem}_14x512_UASTC.ktx2`, root), bytes);
        console.log(`${stem}: ${bytes.length} preview bytes`);
    }
}
