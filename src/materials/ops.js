// An arithmetic BACKEND, so one expression can be a shader and a CPU oracle at once.
//
// WHY THIS EXISTS. The mixed export has to bake the distance surround from the *same*
// layered stack the viewport shows, or the two halves disagree at the boundary and the
// whole feature is pointless. The stack currently lives only as TSL nodes
// (src/materials/layer_stack.js), which means it can only be evaluated on a GPU inside a
// render pass. A second, hand-written CPU copy of the height blend would be exactly the
// "two authored paths" failure mixed.js's own header warns about: it would agree today
// and drift silently the first time either side is touched, and nothing would catch it.
//
// So the maths is written ONCE against this interface and INSTANTIATED twice:
//
//   TSL(tslModule)  ->  three/tsl nodes    ->  compiles to WGSL, runs in the viewport
//   NUM             ->  plain JS numbers   ->  runs under `node --test`, no GPU needed
//
// test/export_kernel_parity.test.js asserts the two instantiations agree, and
// test/export_gpu_parity.mjs asserts the TSL instantiation agrees with the *existing*
// src/materials/layer_stack.js implementation pixel-for-pixel on a real GPU. That second
// check is what makes the factoring a refactor rather than a rewrite: the claim "same
// maths" is measured, not asserted.
//
// DESIGN NOTES
//
// * Function style (`ops.add(a, b)`), not method style (`a.add(b)`), because JS numbers
//   have no `.add`. The TSL backend re-wraps into method calls.
// * Vectors are first class (`v3`, `vmix`, `vmuls`) rather than three scalars, so the TSL
//   instantiation still emits vec3 ops and the proposed patch to layer_stack.js does not
//   de-vectorise the viewport shader. NUM represents a vec3 as a 3-element array.
// * `stepGT(a, b)` instead of a boolean type: TSL comparisons are nodes, JS comparisons
//   are booleans, and there is no need for either — every use here immediately selects
//   between two numbers.
// * A texture SAMPLER is `(u, v) => { r, g, b, a, rgb }`. Both backends can honour that;
//   neither has to expose a vec2 type across the seam.

/** Plain-number backend. Scalars are `number`, vec3 is `[x, y, z]`. */
export const NUM = {
    name: 'num',
    isNum: true,

    f: (x) => (typeof x === 'number' ? x : Number(x)),
    add: (a, b) => a + b,
    sub: (a, b) => a - b,
    mul: (a, b) => a * b,
    div: (a, b) => a / b,
    neg: (a) => -a,
    min: (a, b) => Math.min(a, b),
    max: (a, b) => Math.max(a, b),
    abs: Math.abs,
    sign: Math.sign,
    sqrt: Math.sqrt,
    pow: Math.pow,
    floor: Math.floor,
    clamp: (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x),
    saturate: (x) => (x < 0 ? 0 : x > 1 ? 1 : x),
    mix: (a, b, t) => a + (b - a) * t,
    /** Hermite, matching TSL/WGSL smoothstep including the clamp. */
    smoothstep: (e0, e1, x) => {
        const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0 || 1e-30)));
        return t * t * (3 - 2 * t);
    },
    /** 1 when a > b, else 0. Replaces a boolean type across the seam. */
    stepGT: (a, b) => (a > b ? 1 : 0),

    v3: (x, y, z) => [x, y, z],
    vx: (v) => v[0],
    vy: (v) => v[1],
    vz: (v) => v[2],
    vadd: (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
    vsub: (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
    /** Component-wise vec3 * vec3. */
    vmulv: (a, b) => [a[0] * b[0], a[1] * b[1], a[2] * b[2]],
    /** vec3 * scalar. */
    vmuls: (a, s) => [a[0] * s, a[1] * s, a[2] * s],
    vmix: (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t],
    vnormalize: (a) => {
        const l = Math.hypot(a[0], a[1], a[2]) || 1e-30;
        return [a[0] / l, a[1] / l, a[2] / l];
    },
    vdot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
};

/**
 * TSL backend.
 *
 * `tsl` is the imported `three/tsl` module, passed in rather than imported so this file
 * stays loadable in a runtime with no three (and so `node --test` never pulls the GPU
 * backend in just to run the CPU oracle).
 */
export function TSL(tsl) {
    const {
        float, vec3, add, sub, mul, div, min, max, abs, sign, sqrt, pow, floor,
        clamp, saturate, mix, smoothstep, normalize, dot,
    } = tsl;
    // TSL accepts numbers in most positions, but not all — `float()` on every literal is
    // the only spelling that is uniformly safe, and it is free (it folds at compile time).
    const F = (x) => (typeof x === 'number' ? float(x) : x);

    return {
        name: 'tsl',
        isNum: false,

        f: F,
        add: (a, b) => add(F(a), F(b)),
        sub: (a, b) => sub(F(a), F(b)),
        mul: (a, b) => mul(F(a), F(b)),
        div: (a, b) => div(F(a), F(b)),
        neg: (a) => F(a).negate(),
        min: (a, b) => min(F(a), F(b)),
        max: (a, b) => max(F(a), F(b)),
        abs: (a) => abs(F(a)),
        sign: (a) => sign(F(a)),
        sqrt: (a) => sqrt(F(a)),
        pow: (a, b) => pow(F(a), F(b)),
        floor: (a) => floor(F(a)),
        clamp: (x, lo, hi) => clamp(F(x), F(lo), F(hi)),
        saturate: (x) => saturate(F(x)),
        mix: (a, b, t) => mix(F(a), F(b), F(t)),
        smoothstep: (e0, e1, x) => smoothstep(F(e0), F(e1), F(x)),
        stepGT: (a, b) => F(a).greaterThan(F(b)).select(float(1), float(0)),

        v3: (x, y, z) => vec3(F(x), F(y), F(z)),
        vx: (v) => v.x,
        vy: (v) => v.y,
        vz: (v) => v.z,
        vadd: (a, b) => a.add(b),
        vsub: (a, b) => a.sub(b),
        vmulv: (a, b) => a.mul(b),
        vmuls: (a, s) => a.mul(F(s)),
        vmix: (a, b, t) => mix(a, b, F(t)),
        vnormalize: (a) => normalize(a),
        vdot: (a, b) => dot(a, b),
    };
}

/**
 * Bilinear sampler over a decoded RGBA byte plane, for the NUM backend.
 *
 * Repeat wrap and bilinear filter, to match the DataArrayTexture setup in
 * texture_arrays.js (RepeatWrapping + LinearFilter). `srgb` decodes the sRGB transfer
 * function, which is what three's WGSL backend does per-sample from
 * `texture.colorSpace = SRGBColorSpace` — so the albedo array must be decoded here too or
 * the CPU oracle compares linear GPU values against encoded CPU ones and reports a
 * fictional error of ~0.2 in mid grey.
 *
 * @param plane  Uint8Array, size*size*4, one material layer
 * @param size   square edge in texels
 */
export function planeSampler(plane, size, { srgb = false } = {}) {
    const dec = srgb ? SRGB_TO_LINEAR : IDENTITY_255;
    return (u, v) => {
        // Repeat wrap in continuous space first, then the half-texel shift, so a uv of
        // exactly 1.0 lands on texel 0 rather than clamping to size-1.
        const fu = (u - Math.floor(u)) * size - 0.5;
        const fv = (v - Math.floor(v)) * size - 0.5;
        const x0 = Math.floor(fu), y0 = Math.floor(fv);
        const tx = fu - x0, ty = fv - y0;
        const wrap = (i) => ((i % size) + size) % size;
        const x1 = wrap(x0 + 1), y1 = wrap(y0 + 1);
        const xa = wrap(x0), ya = wrap(y0);
        const o00 = (ya * size + xa) * 4, o10 = (ya * size + x1) * 4;
        const o01 = (y1 * size + xa) * 4, o11 = (y1 * size + x1) * 4;
        const out = [0, 0, 0, 0];
        for (let c = 0; c < 4; c++) {
            // Alpha is never transfer-encoded, in sRGB or anywhere else.
            const d = c === 3 ? IDENTITY_255 : dec;
            const a = d[plane[o00 + c]], b = d[plane[o10 + c]];
            const e = d[plane[o01 + c]], g = d[plane[o11 + c]];
            out[c] = (a + (b - a) * tx) + ((e + (g - e) * tx) - (a + (b - a) * tx)) * ty;
        }
        return { r: out[0], g: out[1], b: out[2], a: out[3], rgb: [out[0], out[1], out[2]] };
    };
}

const IDENTITY_255 = (() => {
    const t = new Float64Array(256);
    for (let i = 0; i < 256; i++) t[i] = i / 255;
    return t;
})();

/** The real sRGB EOTF, not pow(2.2). The piecewise toe matters below ~0.04. */
const SRGB_TO_LINEAR = (() => {
    const t = new Float64Array(256);
    for (let i = 0; i < 256; i++) {
        const c = i / 255;
        t[i] = c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    }
    return t;
})();

export { SRGB_TO_LINEAR };

/** The sRGB OETF. Used when writing an 8-bit albedo PNG that declares itself sRGB. */
export function linearToSRGB(v) {
    const c = v < 0 ? 0 : v > 1 ? 1 : v;
    return c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055;
}
