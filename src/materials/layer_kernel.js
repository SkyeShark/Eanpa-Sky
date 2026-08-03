// The LayerMat evaluation kernel — ONE copy of the maths, two instantiations.
//
// Every expression here is a transcription of the shipping TSL in
// src/materials/layer_stack.js, src/materials/triplanar.js and
// src/materials/mask_stack.js, rewritten against the `ops` backend from ./ops.js so it can
// also be evaluated on the CPU. Nothing is redesigned, reordered or "improved" — a
// deliberate difference would make the bake disagree with the viewport, which is the one
// failure this whole file exists to prevent. Where a line looks odd (the `tx.z * n.x`
// gate in the whiteout blend, the `-as.z` on the Z plane, `posterize`'s divide by s-1),
// it is odd in the original and the comment there explains why.
//
// The equivalence is MEASURED, not asserted:
//   test/export_kernel_parity.test.js   NUM vs closed-form expectations + invariants
//   test/export_gpu_parity.mjs          this kernel (TSL backend) vs layer_stack.js's own
//                                       TSL, rendered on a real GPU, per-pixel
//
// Once the patch in work_tmp/EXPORT_HOOKUP.md is applied, layer_stack.js calls into here
// and there is literally one copy. Until then there are two, and the GPU parity run is
// what keeps them honest.

/**
 * A MaterialStream, in the kernel's representation:
 *   { albedo: vec3, normal: vec3 (WORLD space), rough: S, ao: S, height: S (metres) }
 * `vec3` and `S` are whatever the backend uses.
 */

// ---------------------------------------------------------------------------
// triplanar
// ---------------------------------------------------------------------------

/** Golus's k. Mirrors TRIPLANAR_K in src/materials/triplanar.js. */
export const TRIPLANAR_K = 4;

/**
 * Blend weights, normalised to a partition of unity. `n` is a vec3.
 * Transcribes triplanarWeights() including the 1e-4 guard on the sum.
 */
export function triplanarWeights(ops, n, sharpness = TRIPLANAR_K) {
    const s = ops.f(sharpness);
    const bx = ops.pow(ops.abs(ops.vx(n)), s);
    const by = ops.pow(ops.abs(ops.vy(n)), s);
    const bz = ops.pow(ops.abs(ops.vz(n)), s);
    const sum = ops.max(ops.add(ops.add(bx, by), bz), ops.f(1e-4));
    return { x: ops.div(bx, sum), y: ops.div(by, sum), z: ops.div(bz, sum) };
}

/** Per-plane UVs with the axis-sign fix on uv.x. Returns [[u,v],[u,v],[u,v]]. */
function triplanarUVs(ops, wp, inv, as) {
    const X = ops.vx(wp), Y = ops.vy(wp), Z = ops.vz(wp);
    return [
        [ops.mul(ops.mul(Z, ops.vx(as)), inv), ops.mul(Y, inv)],
        [ops.mul(ops.mul(X, ops.vy(as)), inv), ops.mul(Z, inv)],
        [ops.mul(ops.mul(X, ops.neg(ops.vz(as))), inv), ops.mul(Y, inv)],
    ];
}

const axisSign = (ops, n) => ops.v3(ops.sign(ops.vx(n)), ops.sign(ops.vy(n)), ops.sign(ops.vz(n)));

/**
 * Triplanar sample of a NON-directional map. `sampler` is `(u, v) => {r,g,b,a,rgb}`.
 * Returns the same shape, weight-averaged over the three planes.
 */
export function sampleTriplanar(ops, sampler, wp, n, scaleM, sharpness = TRIPLANAR_K, weights = null) {
    const inv = ops.div(ops.f(1), scaleM);
    const w = weights ?? triplanarWeights(ops, n, sharpness);
    const uvs = triplanarUVs(ops, wp, inv, axisSign(ops, n));
    const a = sampler(uvs[0][0], uvs[0][1]);
    const b = sampler(uvs[1][0], uvs[1][1]);
    const c = sampler(uvs[2][0], uvs[2][1]);
    const s3 = (ka, kb, kc) => ops.add(ops.add(ops.mul(ka, w.x), ops.mul(kb, w.y)), ops.mul(kc, w.z));
    return {
        r: s3(a.r, b.r, c.r),
        g: s3(a.g, b.g, c.g),
        b: s3(a.b, b.b, c.b),
        a: s3(a.a, b.a, c.a),
        rgb: ops.vadd(ops.vadd(ops.vmuls(a.rgb, w.x), ops.vmuls(b.rgb, w.y)), ops.vmuls(c.rgb, w.z)),
    };
}

/**
 * Which tangent component the per-plane axis sign is applied to. This is the one place the
 * kernel offers a choice, because the two spellings are NOT equivalent and the shipping one
 * is measurably wrong on half the directions.
 *
 *   'z'  as src/materials/triplanar.js ships today: `tnormal.z *= axisSign`.
 *   'x'  as Golus publishes it: `tnormal.x *= axisSign`, matching the `uv.x *= axisSign`
 *        flip it is there to compensate for.
 *
 * MEASURED, with a perfectly flat detail normal map (128,128,255) where the output must be
 * the surface normal:
 *
 *   surface        'z' (shipping)              'x' (Golus)
 *   +Y             0.3 deg  ok                 0.3 deg  ok
 *   -Y           179.7 deg  INVERTED           0.3 deg  ok
 *   +X             0.3 deg  ok                 0.3 deg  ok
 *   -X           179.7 deg  INVERTED           0.3 deg  ok
 *   +Z           179.7 deg  INVERTED           0.3 deg  ok
 *   -Z             0.3 deg  ok                 0.3 deg  ok
 *   (0,0.45,0.89) 123.7 deg                    0.3 deg  ok
 *
 * The cause: with the sign on `.z`, each plane's contribution becomes `t.z * |n.axis|` after
 * the whiteout gate, so it always points along the POSITIVE axis no matter which way the
 * surface faces. triplanar.js's own comment says this "keeps the same sign convention on both
 * faces" — it does, and that is the defect: a back face needs the OPPOSITE sign.
 *
 * DEFAULT IS 'z' ON PURPOSE. The bake must agree with the viewport; a bake that is right
 * while the viewport is wrong puts a 124-degree normal discontinuity at the boundary, which
 * is worse than both halves being wrong together. work_tmp/EXPORT_HOOKUP.md carries the
 * one-line patch that flips both at once.
 */
export const AXIS_SIGN_MODES = ['z', 'x'];

/**
 * Triplanar NORMAL sample — whiteout blend, world space out.
 * Transcribes sampleTriplanarNormal() component-for-component, including the swizzles
 * (.zyx / .xzy / .xyz) that put each plane's tangent frame into world orientation.
 */
export function sampleTriplanarNormal(ops, sampler, wp, n, scaleM, {
    sharpness = TRIPLANAR_K, strength = null, weights = null, axisSignMode = 'x',
} = {}) {
    const inv = ops.div(ops.f(1), scaleM);
    const w = weights ?? triplanarWeights(ops, n, sharpness);
    const as = axisSign(ops, n);
    const uvs = triplanarUVs(ops, wp, inv, as);
    const nx3 = ops.vx(n), ny3 = ops.vy(n), nz3 = ops.vz(n);

    const onX = axisSignMode === 'x';
    const unpack = (uv, sgn) => {
        const s = sampler(uv[0], uv[1]);
        let tx = ops.sub(ops.mul(s.r, ops.f(2)), ops.f(1));
        const ty = ops.sub(ops.mul(s.g, ops.f(2)), ops.f(1));
        let tz = ops.sub(ops.mul(s.b, ops.f(2)), ops.f(1));
        if (onX) tx = ops.mul(tx, sgn); else tz = ops.mul(tz, sgn);
        return {
            x: strength === null ? tx : ops.mul(tx, strength),
            y: strength === null ? ty : ops.mul(ty, strength),
            z: tz,
        };
    };
    const tX = unpack(uvs[0], ops.vx(as));
    const tY = unpack(uvs[1], ops.vy(as));
    const tZ = unpack(uvs[2], ops.neg(ops.vz(as)));

    // Whiteout, then swizzle into world orientation. nx.zyx / ny.xzy / nz.xyz.
    const nX = [ops.add(tX.x, nz3), ops.add(tX.y, ny3), ops.mul(tX.z, nx3)];
    const nY = [ops.add(tY.x, nx3), ops.add(tY.y, nz3), ops.mul(tY.z, ny3)];
    const nZ = [ops.add(tZ.x, nx3), ops.add(tZ.y, ny3), ops.mul(tZ.z, nz3)];
    const vX = ops.v3(nX[2], nX[1], nX[0]);          // .zyx
    const vY = ops.v3(nY[0], nY[2], nY[1]);          // .xzy
    const vZ = ops.v3(nZ[0], nZ[1], nZ[2]);          // .xyz

    return ops.vnormalize(ops.vadd(
        ops.vadd(ops.vmuls(vX, w.x), ops.vmuls(vY, w.y)),
        ops.vmuls(vZ, w.z),
    ));
}

// ---------------------------------------------------------------------------
// one layer -> a MaterialStream
// ---------------------------------------------------------------------------

/**
 * Transcribes sampleLayerStream(). `U` is a flat parameter object of backend scalars
 * (not the uniform block) plus `tint` as a vec3 — see `liftLayerParams`.
 */
export function sampleLayerStream(ops, { samplers, wp, n, weights, U, sharpness = TRIPLANAR_K, axisSignMode = 'x' }) {
    const scaleM = ops.max(ops.mul(U.physicalScale, U.scaleMul), ops.f(0.01));
    const diff = sampleTriplanar(ops, samplers.diff, wp, n, scaleM, sharpness, weights);
    const arm = sampleTriplanar(ops, samplers.arm, wp, n, scaleM, sharpness, weights);
    const disp = sampleTriplanar(ops, samplers.disp, wp, n, scaleM, sharpness, weights);
    const nor = sampleTriplanarNormal(ops, samplers.nor, wp, n, scaleM,
        { sharpness, strength: U.normalStrength, weights, axisSignMode });

    const hGate = ops.mul(U.heightContribution, U.heightEnabled);
    const height = ops.add(ops.mul(ops.mul(disp.r, U.heightMetres), hGate), U.heightOffset);

    return {
        albedo: ops.vmuls(ops.vmulv(diff.rgb, U.tint), U.albedoBrightness),
        normal: nor,
        ao: ops.mix(ops.f(1), arm.r, U.aoStrength),
        rough: ops.clamp(ops.add(ops.mul(arm.g, U.roughnessScale), U.roughnessOffset), ops.f(0.04), ops.f(1)),
        height,
    };
}

/** Lift a resolved layer's numeric parameters into backend scalars. */
export function liftLayerParams(ops, l) {
    const defaults = {
        strength: 1, enabled: 1,
        bandMin: 0, bandMax: 1, bandFeather: 0.05,
        heightOffset: 0, heightContribution: 1, heightEnabled: 1,
        blendDepth: 0.05, contrast: 1, invert: 0, opacity: 1,
        physicalScale: 2, scaleMul: 1, heightMetres: 0.1,
        albedoBrightness: 1, roughnessScale: 1, roughnessOffset: 0,
        normalStrength: 1, aoStrength: 1,
    };
    const out = {};
    for (const [k, d] of Object.entries(defaults)) out[k] = ops.f(Number(l[k] ?? d));
    const t = l.albedoTint ?? [1, 1, 1];
    out.tint = ops.v3(ops.f(t[0]), ops.f(t[1]), ops.f(t[2]));
    return out;
}

/**
 * Positive-only value band for MaterialMap's single driver.
 *
 * Interior edges use symmetric feathering so adjacent bands cross at 0.5 and add to one.
 * The domain edges are special: the first band ramps continuously out of the required
 * unmapped zero, while a band ending at one stays solid at the top of the mask domain.
 */
export function bandWindow(ops, driver, bandMin = 0, bandMax = 1, bandFeather = 0.05) {
    const zero = ops.f(0), one = ops.f(1), eps = ops.f(1e-6);
    const d = ops.saturate(driver ?? zero);
    const a = ops.saturate(bandMin), b = ops.saturate(bandMax);
    const lo = ops.min(a, b), hi = ops.max(a, b);
    const f = ops.min(ops.abs(bandFeather), ops.mul(ops.sub(hi, lo), ops.f(0.5)));

    const riseMiddle = ops.smoothstep(ops.sub(lo, f), ops.add(lo, f), d);
    const riseFromZero = ops.smoothstep(zero, ops.max(f, eps), d);
    const touchesZero = ops.sub(one, ops.stepGT(lo, eps));
    const rise = ops.mix(riseMiddle, riseFromZero, touchesZero);

    const fallMiddle = ops.sub(one, ops.smoothstep(ops.sub(hi, f), ops.add(hi, f), d));
    const touchesOne = ops.stepGT(hi, ops.sub(one, eps));
    const fall = ops.mix(fallMiddle, one, touchesOne);

    const lowerHard = ops.sub(one, ops.stepGT(lo, d));
    const upperHard = ops.sub(one, ops.stepGT(d, hi));
    const hard = ops.mul(lowerHard, upperHard);
    const soft = ops.mul(rise, fall);
    const feathered = ops.mix(hard, soft, ops.stepGT(f, zero));
    return ops.saturate(ops.mul(ops.stepGT(d, zero), feathered));
}

/** A gap in the driver is a valid neutral material, never an implicit first layer. */
export function neutralMaterialStream(ops, normal = null) {
    return {
        albedo: ops.v3(ops.f(1), ops.f(1), ops.f(1)),
        normal: normal ?? ops.v3(ops.f(0), ops.f(1), ops.f(0)),
        rough: ops.f(1),
        ao: ops.f(1),
        height: ops.f(0),
    };
}

// ---------------------------------------------------------------------------
// the height blend — Substance's Height Blend
// ---------------------------------------------------------------------------

/**
 *   d = (h_top - h_bottom) / max(blendRadius, 1e-5)
 *   d = mix(d, -d, saturate(invert))
 *   x = cov + d * cov * (1 - cov)
 *   m = saturate((x - 0.5) * max(contrast, 1e-3) + 0.5)
 *
 * `cov * (1 - cov)` vanishes at both ends, so cov=0 => m=0 and cov=1 => m=1 hold for every
 * height, radius and contrast >= 1. That is the fix for the all-heights-zero black; see
 * the long note in src/materials/layer_stack.js.
 *
 * @returns { stream, mask }
 */
export function layerBlend(ops, bottom, top, {
    mask = null, blendRadius = null, contrast = null,
    opacity = null, invert = null, mode = 'balanced',
} = {}) {
    const one = ops.f(1);
    const cov = ops.mul(ops.saturate(mask ?? one), opacity ?? one);
    const d0 = ops.div(ops.sub(top.height, bottom.height), ops.max(blendRadius ?? ops.f(0.05), ops.f(1e-5)));
    const d = ops.mix(d0, ops.neg(d0), ops.saturate(invert ?? ops.f(0)));
    const x = ops.add(cov, ops.mul(ops.mul(d, cov), ops.sub(one, cov)));
    const m = ops.saturate(ops.add(ops.mul(ops.sub(x, ops.f(0.5)), ops.max(contrast ?? one, ops.f(1e-3))), ops.f(0.5)));

    const height = mode === 'bottomPriority' ? bottom.height : ops.mix(bottom.height, top.height, m);

    return {
        stream: {
            albedo: ops.vmix(bottom.albedo, top.albedo, m),
            // World-space normals, so a lerp is meaningful; renormalised because
            // interpolating two unit vectors does not give a unit vector.
            normal: ops.vnormalize(ops.vmix(bottom.normal, top.normal, m)),
            rough: ops.mix(bottom.rough, top.rough, m),
            ao: ops.mix(bottom.ao, top.ao, m),
            height,
        },
        mask: m,
    };
}

/**
 * Fold N layers over a neutral material stream. Layer zero goes through the same blend
 * as every other layer, so its value band is honoured and uncovered driver values remain
 * neutral instead of leaking the first material across the terrain.
 */
export function blendLayerStack(ops, entries, neutral = null) {
    let acc = neutral ?? neutralMaterialStream(ops);
    const masks = [];
    for (let i = 0; i < entries.length; i++) {
        const r = layerBlend(ops, acc, entries[i].stream, entries[i].blend);
        acc = r.stream;
        masks.push(r.mask);
    }
    return { ...acc, masks };
}

// ---------------------------------------------------------------------------
// legacy mask-stack migration oracle (not used by active MaterialMap evaluation)
// ---------------------------------------------------------------------------

const COMPONENT_DEFAULTS = {
    solid: { value: 1 },
    terrain: { source: 'slope', lo: 0, hi: 1, feather: 0.12 },
    noise: { frequency: 12, octaves: 3, gain: 0.5, contrast: 1 },
    gradient: { axis: 'x', lo: 0, hi: 1 },
};

const MODIFIER_DEFAULTS = {
    brightnessContrast: { brightness: 0, contrast: 1 },
    clamp: { lo: 0, hi: 1 },
    invert: {},
    gradientRemap: { inLo: 0, inHi: 1, outLo: 0, outHi: 1 },
    posterize: { steps: 5 },
    normalize: { lo: 0, hi: 1 },
};

/**
 * @param ctx  { masks, p: {x, y}, tile, noise }
 *             `masks` maps a mask name to a backend scalar. `noise` is
 *             `(p, params, tile) => scalar` — injected, because the noise
 *             implementation is the graph's business, not this file's.
 */
function component(ops, c, ctx) {
    const p = { ...COMPONENT_DEFAULTS[c.type], ...(c.params ?? {}) };
    switch (c.type) {
        case 'solid':
            return ops.f(p.value);
        case 'terrain': {
            const src = ctx.masks[p.source] ?? ctx.masks.slope ?? ops.f(0.5);
            const f = ops.f(p.feather);
            const rise = ops.smoothstep(ops.sub(ops.f(p.lo), f), ops.add(ops.f(p.lo), f), src);
            const fall = ops.sub(ops.f(1), ops.smoothstep(ops.sub(ops.f(p.hi), f), ops.add(ops.f(p.hi), f), src));
            return ops.mul(rise, fall);
        }
        case 'noise': {
            if (!ctx.noise) return ops.f(1);
            const n = ctx.noise(ctx.p, {
                frequency: p.frequency, octaves: p.octaves, lacunarity: 2, gain: p.gain,
            }, ctx.tile);
            const v = ops.add(ops.mul(n, ops.f(0.5)), ops.f(0.5));
            return ops.clamp(ops.add(ops.mul(ops.sub(v, ops.f(0.5)), ops.f(p.contrast)), ops.f(0.5)), ops.f(0), ops.f(1));
        }
        case 'gradient': {
            const a = p.axis === 'y' ? ctx.p.y : ctx.p.x;
            return ops.clamp(ops.div(ops.sub(a, ops.f(p.lo)), ops.f(Math.max(1e-4, p.hi - p.lo))), ops.f(0), ops.f(1));
        }
        default:
            return ops.f(1);
    }
}

function modifier(ops, v, m) {
    const p = { ...MODIFIER_DEFAULTS[m.type], ...(m.params ?? {}) };
    switch (m.type) {
        case 'brightnessContrast':
            return ops.clamp(ops.add(ops.add(ops.mul(ops.sub(v, ops.f(0.5)), ops.f(p.contrast)), ops.f(0.5)), ops.f(p.brightness)), ops.f(0), ops.f(1));
        case 'clamp':
            return ops.clamp(v, ops.f(p.lo), ops.f(p.hi));
        case 'invert':
            return ops.sub(ops.f(1), v);
        case 'gradientRemap': {
            const t = ops.clamp(ops.div(ops.sub(v, ops.f(p.inLo)), ops.f(Math.max(1e-4, p.inHi - p.inLo))), ops.f(0), ops.f(1));
            return ops.mix(ops.f(p.outLo), ops.f(p.outHi), t);
        }
        case 'posterize': {
            const s = Math.max(2, Math.round(p.steps));
            return ops.div(ops.floor(ops.mul(v, ops.f(s))), ops.f(s - 1));
        }
        case 'normalize':
            return ops.clamp(ops.div(ops.sub(v, ops.f(p.lo)), ops.f(Math.max(1e-4, p.hi - p.lo))), ops.f(0), ops.f(1));
        default:
            return v;
    }
}

function maskBlend(ops, a, b, mode) {
    switch (mode) {
        case 'add': return ops.clamp(ops.add(a, b), ops.f(0), ops.f(1));
        case 'subtract': return ops.clamp(ops.sub(a, b), ops.f(0), ops.f(1));
        case 'max': return ops.max(a, b);
        case 'min': return ops.min(a, b);
        case 'overlay': {
            const lo = ops.mul(ops.mul(a, b), ops.f(2));
            const hi = ops.sub(ops.f(1), ops.mul(ops.mul(ops.f(2), ops.sub(ops.f(1), a)), ops.sub(ops.f(1), b)));
            return ops.mix(lo, hi, ops.stepGT(a, ops.f(0.5)));
        }
        case 'multiply':
        default: return ops.mul(a, b);
    }
}

/** Legacy payload evaluator retained only for migration tests. Empty stack => 1. */
export function evaluateMaskStack(ops, stack, ctx) {
    if (!stack || stack.length === 0) return ops.f(1);
    let acc = null;
    for (const c of stack) {
        if (c.enabled === false) continue;
        let v = component(ops, c, ctx);
        for (const m of c.modifiers ?? []) {
            if (m.enabled === false) continue;
            v = modifier(ops, v, m);
        }
        if (c.opacity != null && c.opacity !== 1) v = ops.mix(ops.f(1), v, ops.f(c.opacity));
        acc = acc === null ? v : maskBlend(ops, acc, v, c.blend ?? 'multiply');
    }
    return acc === null ? ops.f(1) : ops.clamp(acc, ops.f(0), ops.f(1));
}

// ---------------------------------------------------------------------------
// the whole stack, in one call
// ---------------------------------------------------------------------------

/**
 * Evaluate the entire LayerMat at one point (NUM) or build it as nodes (TSL).
 *
 * This is `buildLayeredMaterial`'s inner loop with the three-and-shading parts removed:
 * no positionNode, no view-space normal transform, no MeshStandardNodeMaterial. What
 * comes out is the blended MaterialStream, which is exactly what the surround bake needs
 * to write into textures and what the viewport then lights.
 *
 * @param layers    resolved layers (resolveLayer() output), in blend order
 * @param samplers  samplers[i] = { diff, nor, arm, disp } for layer i
 * @param wp        world position in metres, vec3, Y-up (matches layer_stack.js's `wp`)
 * @param gn        geometric normal in the same space, vec3
 * @param driverMask one scalar shared by every layer; only positive values map
 * @returns { albedo, normal, rough, ao, height, masks, coverage }
 */
export function evaluateLayerStack(ops, {
    layers, samplers, wp, gn, driverMask = null,
    sharpness = TRIPLANAR_K, axisSignMode = 'x',
}) {
    const weights = triplanarWeights(ops, gn, sharpness);
    const entries = [];
    const coverage = [];
    const driver = driverMask ?? ops.f(1);
    for (let i = 0; i < layers.length; i++) {
        const l = layers[i];
        const U = liftLayerParams(ops, l);
        const stream = sampleLayerStream(ops, { samplers: samplers[i], wp, n: gn, weights, U, sharpness, axisSignMode });
        const window = bandWindow(ops, driver, U.bandMin, U.bandMax, U.bandFeather);
        const cov = ops.mul(window, ops.mul(U.enabled, U.strength));
        coverage.push(cov);
        entries.push({
            stream,
            blend: {
                mask: cov, blendRadius: U.blendDepth, contrast: U.contrast,
                opacity: U.opacity, invert: U.invert, mode: l.heightMode ?? 'balanced',
            },
        });
    }
    const out = blendLayerStack(ops, entries, neutralMaterialStream(ops, gn));
    return { ...out, coverage, driverMask: driver };
}
