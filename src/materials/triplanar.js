// Triplanar projection — and the normal handling the old code got wrong.
//
// Three separate defects lived in one four-line function (docs/MATERIAL_RESEARCH.md §4):
//
// 1. NORMALS WERE BLENDED AS RAW VECTORS. Golus is explicit that naive mesh-tangent
//    blending is "always wrong": each plane's tangent normal is expressed in a DIFFERENT
//    tangent frame, so a weighted sum of the three is a weighted sum of three different
//    coordinate systems. It does not merely soften — it tilts detail the wrong way on two
//    of the three planes, and the error is largest exactly where the blend is widest.
//    Fixed with the WHITEOUT blend: `float3(t.xy + n.zy, t.z * n.x)`, then swizzle each
//    plane into world orientation (.zyx / .xzy / .xyz) before weighting.
//
// 2. NO AXIS SIGN. The three planes are sampled from the same world position regardless
//    of which way the surface faces, so back faces read a mirrored projection and the
//    tangent frame is left-handed there. `axisSign = sign(n)` applied to each plane's
//    `uv.x` and to its `tnormal.z`, with `-axisSign.z` on the Z plane, is the standard
//    correction and it is required for EITHER blend to be right.
//
// 3. BLEND WEIGHTS CAME FROM A SMOOTHED NORMAL. Jason Booth blames smoothed vertex
//    normals for the 45-degree seams, and the fix is geometric normals —
//    `normalize(cross(ddy(worldPos), ddx(worldPos)))`. Ekigar's old weights came from
//    masks.geoNormal, which is an ANALYTIC finite-difference normal of the heightfield:
//    smooth by construction, and not the normal of the triangle actually being shaded.
//
// k = 4 is kept: Golus's hard-coded recommendation, "just as fast… looks better".
//
// The sampler indirection (`plainSampler` / `arraySampler`) is what lets exactly this
// code serve both the DataArrayTexture path and the per-layer CPU fallback. Two copies
// would drift, and a normal blend that differs between the two paths is unfalsifiable.

import {
    texture, vec2, vec3, float, int, abs, max, pow, sign, normalize, cross,
    dFdx, dFdy, dot, clamp, select,
} from 'three/tsl';

/** Golus's recommendation. Do not lower it to 1 or 2 "for speed"; it is not the cost. */
export const TRIPLANAR_K = 4;

/**
 * Sample one 2D texture. `(uv) => vec4`.
 *
 * The per-layer fallback path: one binding and one sampler per map, so the layer count
 * is capped by the device limits.
 */
export const plainSampler = (tex) => (uvNode) => texture(tex, uvNode);

/**
 * Sample one layer of a DataArrayTexture. `(uv) => vec4`.
 *
 * `layer` may be a plain number or an int uniform. A uniform makes MATERIAL SELECTION a
 * live uniform write rather than a shader rebuild, because every layer shares the one
 * binding — the second, less obvious payoff of the array path.
 */
export const arraySampler = (arrayTex, layer) => {
    const idx = typeof layer === 'number' ? int(Math.max(0, layer | 0)) : layer;
    return (uvNode) => texture(arrayTex, uvNode).depth(idx);
};

/**
 * The GEOMETRIC normal of the surface being shaded, in the same space as `wp`.
 *
 * Faceted on purpose. This is only ever used for triplanar blend WEIGHTS, where a
 * smoothed normal is what produces the 45-degree seams.
 *
 * `ref` resolves the winding ambiguity: cross(ddy, ddx) points the right way only for one
 * triangle winding and uv orientation, and guessing wrong inverts every weight. Pass the
 * analytic surface normal (which is known to point outward) and the sign is settled
 * without assuming anything about the mesh.
 *
 * Fragment stage only — dFdx/dFdy are illegal in a vertex shader.
 */
export function geometricNormal(wp, ref = null) {
    const gn = normalize(cross(dFdy(wp), dFdx(wp)));
    if (!ref) return gn;
    return gn.mul(select(dot(gn, ref).greaterThanEqual(float(0)), float(1), float(-1)));
}

/**
 * Triplanar blend weights, normalised to a partition of unity.
 *
 * `biplanarRemap` applies Quilez's `clamp((w - 0.5773) / (1 - 0.5773), 0, 1)` before
 * normalising, which kills the three-way overlap at the eight (+-1,+-1,+-1) diagonals
 * where seams are worst. Off by default: it changes the look, and raising k is the other
 * documented option.
 */
export function triplanarWeights(n, sharpness = TRIPLANAR_K, biplanarRemap = false) {
    let bw = pow(abs(n), float(sharpness));
    if (biplanarRemap) {
        const k = float(1 / (1 - 0.5773));
        bw = clamp(abs(n).sub(float(0.5773)).mul(k), 0, 1).mul(bw);
    }
    const wsum = max(bw.x.add(bw.y).add(bw.z), float(1e-4));
    return bw.div(wsum);
}

/** Per-plane UVs with the axis-sign fix applied to uv.x. `inv` = 1/metres. */
function triplanarUVs(wp, inv, axisSign) {
    return {
        x: vec2(wp.z.mul(axisSign.x), wp.y).mul(inv),
        y: vec2(wp.x.mul(axisSign.y), wp.z).mul(inv),
        z: vec2(wp.x.mul(axisSign.z.negate()), wp.y).mul(inv),
    };
}

/**
 * Triplanar sample of a NON-DIRECTIONAL map (albedo, ARM, displacement).
 *
 * Weighted averaging is correct for these: they are scalars/colours, not vectors in a
 * per-plane frame. `scaleM` is the material's real size in metres, so uv repeats every
 * scaleM metres of world and two layers with different physical scales keep their
 * relative grain (which is the thing no amount of blend tuning recovers).
 */
export function sampleTriplanar(sampler, wp, n, scaleM, sharpness = TRIPLANAR_K, weights = null) {
    const inv = float(1).div(scaleM);
    const w = weights ?? triplanarWeights(n, sharpness);
    const uvs = triplanarUVs(wp, inv, sign(n));
    return sampler(uvs.x).mul(w.x).add(sampler(uvs.y).mul(w.y)).add(sampler(uvs.z).mul(w.z));
}

/**
 * Triplanar NORMAL sample — whiteout blend, axis-sign corrected, world space out.
 *
 *   axisSign = sign(n)                        applied to uv.x and to tnormal.z,
 *                                             with -axisSign.z on the Z plane
 *   whiteout = float3(t.xy + n.zy, t.z * n.x) per plane, then .zyx / .xzy / .xyz
 *
 * `normalStrength` scales the tangent XY only, which is the correct place for it: scaling
 * the whole vector before normalising is a no-op, and scaling z inverts the meaning of
 * the slider at high values.
 *
 * CORRECTED: this comment used to claim that applying axisSign to tnormal.z gives
 * `t.z * |n.x|` and "keeps the same sign convention on both faces". The arithmetic is right
 * and the conclusion is wrong — a term that is always positive along the axis is exactly what
 * inverts a back face. The sign belongs on tnormal.x, which is what Golus publishes and what
 * composes with the uv.x flip. See the measurement in `unpack` below.
 *
 * Returns a normalised WORLD-space normal in the space of `wp` and `n`.
 */
export function sampleTriplanarNormal(sampler, wp, n, scaleM, {
    sharpness = TRIPLANAR_K, strength = null, weights = null,
} = {}) {
    const inv = float(1).div(scaleM);
    const w = weights ?? triplanarWeights(n, sharpness);
    const as = sign(n);
    const uvs = triplanarUVs(wp, inv, as);

    const unpack = (uvNode, sgn) => {
        const t = sampler(uvNode).xyz.mul(2).sub(1);
        // The axis sign compensates for `uv.x *= axisSign`, so it belongs on the tangent
        // normal's X — not its Z. The two are NOT equivalent, contrary to the note above,
        // which is now corrected: on .z, the whiteout gate makes each plane contribute
        // `t.z * |n.axis|`, which points every plane along the POSITIVE axis and therefore
        // inverts every back face.
        //
        // Measured with a flat detail map (128,128,255), where the output must equal the
        // surface normal exactly: with the sign on .z the -Y underside, the -X west wall and
        // the +Z north wall each came back 179.7 degrees INVERTED, and two 63-degree slopes
        // came back 123.7 degrees off. With it on .x all eight orientations are within 0.3.
        //
        // Terrain is mostly +Y and the Y plane's weight dominates there, which is why this
        // shipped — it bites on cliffs, exactly where triplanar is the reason for the feature.
        const tx = strength ? t.x.mul(sgn).mul(strength) : t.x.mul(sgn);
        const ty = strength ? t.y.mul(strength) : t.y;
        return vec3(tx, ty, t.z);
    };
    const tx = unpack(uvs.x, as.x);
    const ty = unpack(uvs.y, as.y);
    const tz = unpack(uvs.z, as.z.negate());

    // Whiteout: add the surface normal's other two components into the tangent xy, and
    // gate z by the plane's own component. This is what keeps a plane whose weight is
    // small from dragging the result toward its own frame.
    const nx = vec3(tx.xy.add(n.zy), tx.z.mul(n.x));
    const ny = vec3(ty.xy.add(n.xz), ty.z.mul(n.y));
    const nz = vec3(tz.xy.add(n.xy), tz.z.mul(n.z));

    return normalize(nx.zyx.mul(w.x).add(ny.xzy.mul(w.y)).add(nz.xyz.mul(w.z)));
}
