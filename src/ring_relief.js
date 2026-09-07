const MAGIC = 0x464c5245; // ERLF, little endian

export function decodeRingRelief(buffer) {
    if (!(buffer instanceof ArrayBuffer) || buffer.byteLength < 16) throw new Error('Truncated ring relief header');
    const header = new DataView(buffer);
    const width = header.getUint32(8, true), height = header.getUint32(12, true);
    if (header.getUint32(0, true) !== MAGIC || header.getUint32(4, true) !== 1) {
        throw new Error('Unsupported ring relief format');
    }
    if (!width || !height || width > 8192 || height > 8192 || buffer.byteLength !== 16 + width * height * 6) {
        throw new Error('Invalid ring relief dimensions or payload length');
    }
    return { width, height, heightData: new Uint16Array(buffer, 16, width * height),
        normalAoData: new Uint8Array(buffer, 16 + width * height * 2, width * height * 4) };
}

// Immutable source textures survive sky/quality rebuilds just like the shared
// image cache. Float height values bypass the canvas's 8-bit color conversion.
let pendingTextures = null;
export function loadRingRelief(THREE) {
    if (!pendingTextures) pendingTextures = (async () => {
        const response = await fetch(new URL('../assets/ringworld/ring_relief_v4.bin.gz', import.meta.url));
        if (!response.ok) throw new Error(`Ring relief fetch failed: ${response.status}`);
        const compressed = await response.arrayBuffer();
        const bytes = new Uint8Array(compressed);
        const buffer = bytes[0] === 0x1f && bytes[1] === 0x8b
            ? await new Response(new Blob([compressed]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer()
            : compressed;
        const { width, height, heightData, normalAoData } = decodeRingRelief(buffer);
        const bandHeight = new THREE.DataTexture(heightData, width, height, THREE.RedFormat, THREE.HalfFloatType);
        const bandNormal = new THREE.DataTexture(normalAoData, width, height, THREE.RGBAFormat);
        for (const texture of [bandHeight, bandNormal]) {
            texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
            texture.colorSpace = THREE.NoColorSpace;
            texture.minFilter = THREE.LinearMipmapLinearFilter;
            texture.magFilter = THREE.LinearFilter;
            texture.generateMipmaps = true;
            texture.needsUpdate = true;
        }
        bandHeight.name = 'ring_relief_v4_height';
        bandNormal.name = 'ring_relief_v4_normal_ao';
        const bandColor = await globalThis.loadImageTexture('./assets/ringworld/ring_albedo_v4.png', {srgb:true,mipmaps:true});
        bandColor.wrapS = bandColor.wrapT = THREE.RepeatWrapping;
        return { bandHeight, bandNormal, bandAO: bandNormal, bandColor };
    })().catch(error => { pendingTextures = null; throw error; });
    return pendingTextures;
}
