// Deterministic numerical terrain bake. The source coastlines remain fixed;
// ridged uplift and sediment transport add connected highland drainage.
// Run: node qa/bake-ring-relief.mjs
import { mkdir, writeFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { DataUtils } from '../vendor/three/three.core.js';
import { readPng } from './png-data.mjs';

const source = await readPng('assets/ringworld/ring_band_height.png');
const { width: W, height: H } = source, N = W * H;
const original = Float32Array.from({ length: N }, (_, i) => source.data[i * source.channels] / 255);
const height = new Float32Array(N);
const clamp = (v, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, v));
const smooth = (a, b, v) => { const t = clamp((v - a) / (b - a)); return t * t * (3 - 2 * t); };
const wrap = (v, period) => ((v % period) + period) % period;
const at = (x, y) => wrap(y, H) * W + wrap(x, W);
const hash = (x, y, salt) => {
    let n = Math.imul(x ^ salt, 374761393) ^ Math.imul(y, 668265263);
    n = Math.imul(n ^ (n >>> 13), 1274126177);
    return ((n ^ (n >>> 16)) >>> 0) / 4294967295;
};
function noise(x, y, cells, salt) {
    const periodX = cells * 3, periodY = cells;
    const px = x / W * periodX, py = y / H * periodY;
    const ix = Math.floor(px), iy = Math.floor(py);
    const fx = px - ix, fy = py - iy;
    const sx = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
    const sy = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
    const h = (dx, dy) => hash(wrap(ix + dx, periodX), wrap(iy + dy, periodY), salt);
    return (h(0, 0) * (1 - sx) + h(1, 0) * sx) * (1 - sy)
        + (h(0, 1) * (1 - sx) + h(1, 1) * sx) * sy;
}
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x, base = original[i], land = smooth(0.07, 0.42, base);
    const wx = x + (noise(x, y, 5, 193) - 0.5) * 42;
    const wy = y + (noise(x, y, 5, 317) - 0.5) * 42;
    const ridge = (cells, salt) => Math.pow(1 - Math.abs(noise(wx, wy, cells, salt) * 2 - 1), 3);
    const r0 = ridge(13, 7919), r1 = ridge(29, 1543), r2 = ridge(61, 2749);
    const uplift = 0.60 * r0 + 0.28 * r0 * r1 + 0.12 * r1 * r2;
    height[i] = clamp(base + land * (0.15 * (uplift - 0.30)
        + 0.006 * (noise(wx, wy, 137, 1009) - 0.5)), 0, 0.985);
}

let randomState = 0x6ea9f371;
const random = () => {
    randomState ^= randomState << 13; randomState ^= randomState >>> 17; randomState ^= randomState << 5;
    return (randomState >>> 0) / 4294967296;
};
function sample(x, y) {
    const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy;
    const a = height[at(ix, iy)], b = height[at(ix + 1, iy)];
    const c = height[at(ix, iy + 1)], d = height[at(ix + 1, iy + 1)];
    return { h: (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy,
        dx: (b - a) * (1 - fy) + (d - c) * fy, dy: (c - a) * (1 - fx) + (d - b) * fx };
}
function deposit(x, y, amount) {
    const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy;
    for (let oy = 0; oy <= 1; oy++) for (let ox = 0; ox <= 1; ox++) {
        const i = at(ix + ox, iy + oy);
        if (original[i] < 0.045) continue;
        height[i] += amount * (ox ? fx : 1 - fx) * (oy ? fy : 1 - fy);
    }
}
const brush = [];
let brushWeight = 0;
for (let y = -2; y <= 2; y++) for (let x = -2; x <= 2; x++) {
    const weight = Math.max(0, 2.3 - Math.hypot(x, y));
    if (weight > 0) { brush.push([x, y, weight]); brushWeight += weight; }
}
for (const entry of brush) entry[2] /= brushWeight;
const droplets = Math.round(N * 0.18);
for (let drop = 0; drop < droplets; drop++) {
    let x = random() * W, y = random() * H;
    if (original[at(Math.floor(x), Math.floor(y))] < 0.12) continue;
    let dx = 0, dy = 0, speed = 0.1, water = 1, sediment = 0;
    for (let age = 0; age < 52; age++) {
        const here = sample(x, y);
        dx = dx * 0.16 - here.dx * 0.84; dy = dy * 0.16 - here.dy * 0.84;
        let length = Math.hypot(dx, dy);
        if (length < 1e-8) { const angle = random() * Math.PI * 2; dx = Math.cos(angle); dy = Math.sin(angle); length = 1; }
        dx /= length; dy /= length;
        const nx = wrap(x + dx, W), ny = wrap(y + dy, H), next = sample(nx, ny);
        const delta = next.h - here.h;
        const capacity = Math.max(-delta, 0.00003) * speed * water * 5;
        if (delta > 0 || sediment > capacity) {
            const amount = delta > 0 ? Math.min(delta, sediment) : (sediment - capacity) * 0.25;
            deposit(x, y, amount); sediment -= amount;
        } else {
            const amount = Math.min((capacity - sediment) * 0.22, -delta * 0.7);
            for (const [ox, oy, weight] of brush) {
                const i = at(Math.floor(x) + ox, Math.floor(y) + oy);
                const erodible = Math.max(0, height[i] - Math.max(0.045, original[i] - 0.05));
                const taken = Math.min(erodible, amount * weight);
                height[i] -= taken; sediment += taken;
            }
        }
        speed = Math.sqrt(Math.max(0, speed * speed - delta * 12));
        water *= 0.965; x = nx; y = ny;
        if (next.h < 0.06 || water < 0.12) break;
    }
    deposit(x, y, sediment);
}
// Preserve original shore/water samples exactly and clamp deposition extremes.
for (let i = 0; i < N; i++) {
    const land = smooth(0.045, 0.12, original[i]);
    height[i] = clamp(original[i] + (height[i] - original[i]) * land, 0, 0.995);
}

const payload = Buffer.alloc(16 + N * 6);
payload.write('ERLF'); payload.writeUInt32LE(1, 4);
payload.writeUInt32LE(W, 8); payload.writeUInt32LE(H, 12);
const pomScale = 0.03, sx = pomScale * W, sy = pomScale * H;
let changeSquared = 0, slopeOriginal = 0, slopeNew = 0, maxQuantizationError = 0;
const normalOffset = 16 + N * 2;
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x, out = (H - 1 - y) * W + x;
    const encoded = DataUtils.toHalfFloat(height[i]);
    payload.writeUInt16LE(encoded, 16 + out * 2);
    maxQuantizationError = Math.max(maxQuantizationError, Math.abs(height[i] - DataUtils.fromHalfFloat(encoded)));
    const dx = (height[at(x + 1, y)] - height[at(x - 1, y)]) * 0.5;
    const dy = (height[at(x, y + 1)] - height[at(x, y - 1)]) * 0.5;
    const inv = 1 / Math.hypot(dx * sx, dy * sy, 1);
    payload[normalOffset + out * 4] = Math.round((-dx * sx * inv * 0.5 + 0.5) * 255);
    payload[normalOffset + out * 4 + 1] = Math.round((dy * sy * inv * 0.5 + 0.5) * 255);
    payload[normalOffset + out * 4 + 2] = Math.round((inv * 0.5 + 0.5) * 255);
    let horizon = 0;
    for (let direction = 0; direction < 8; direction++) {
        const angle = direction * Math.PI / 4;
        let maximum = 0;
        for (const distance of [2, 5, 11, 23]) {
            const px = Math.round(Math.cos(angle) * distance), py = Math.round(Math.sin(angle) * distance);
            const rise = height[at(x + px, y + py)] - height[i];
            const run = Math.hypot(px / sx, py / sy);
            maximum = Math.max(maximum, rise / run);
        }
        horizon += maximum * maximum / (1 + maximum * maximum);
    }
    payload[normalOffset + out * 4 + 3] = Math.round((1 - horizon / 8) * 255);
    changeSquared += (height[i] - original[i]) ** 2;
    slopeNew += dx * dx + dy * dy;
    slopeOriginal += ((original[at(x + 1, y)] - original[at(x - 1, y)]) ** 2
        + (original[at(x, y + 1)] - original[at(x, y - 1)]) ** 2) * 0.25;
}
const compressed = gzipSync(payload, { level: 9 });
await mkdir('assets/ringworld', { recursive: true });
await writeFile('assets/ringworld/ring_relief_v3.bin.gz', compressed);
const manifest = { version: 1, width: W, height: H, source: 'ring_band_height.png',
    seed: '0x6ea9f371', droplets, pomScale, heightFormat: 'r16float', normalAoFormat: 'rgba8unorm',
    rowOrder: 'bottom-to-top', normalConvention: '(-dH/dU,+dH/dV,1); green flipped by band tangent frame',
    compressedBytes: compressed.length, decodedBytes: payload.length,
    sha256: createHash('sha256').update(payload).digest('hex'),
    rmsHeightChange: Math.sqrt(changeSquared / N), rmsSlopeRatio: Math.sqrt(slopeNew / slopeOriginal),
    maxQuantizationError };
await writeFile('assets/ringworld/ring_relief_v3.json', JSON.stringify(manifest, null, 2) + '\n');
console.log(JSON.stringify(manifest, null, 2));
