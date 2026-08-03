// Periodic gradient noise in TSL — the GPU twin of field_cpu.js's noised()/hash2().
//
// Every function here takes an explicit `period` in LATTICE CELLS (not world units)
// and wraps the integer lattice coordinate before hashing. period <= 0 on an axis
// means "not periodic on that axis", which is how the ring band gets x-only wrap.
//
// The one trap worth naming: WGSL's `%` on floats is fmod — its sign follows the
// dividend — so a negative lattice coordinate would hash to the wrong cell and seam
// on one side only, which reads like a bug in the landform rather than in the wrap.
// wrapCell() is floor-based for exactly that reason and nothing here may use `%`.

import { Fn, float, uint, vec2, vec3, floor, fract, dot, select } from 'three/tsl';

const K0 = 0.3183099;
const K1 = 0.3678794;

/** Floor-based lattice wrap. Mirrors wrapCell() in field_cpu.js. */
export const wrapCell = Fn(([v, period]) => {
    // The divisor is floored away from zero so the non-periodic path can't produce
    // a NaN that some backend might propagate out of the unselected branch.
    const p = period.max(float(1e-9));
    const wrapped = v.sub(p.mul(v.div(p).floor()));
    return select(period.greaterThan(float(0)), wrapped, v);
});

/**
 * Integer lattice hash. Returns a gradient in [-1,1)^2. Must stay bit-identical to
 * hash2() in field_cpu.js — test/gpu asserts exactly that.
 *
 * This deliberately does NOT use the reference's fract-product hash. That form's
 * intermediate grows as the cube of the lattice coordinate (~2.1e6 at a 320-cell
 * period), and f32's spacing there is 0.125, so fract() returns noise. It cost the
 * GPU's finest erosion octaves entirely while the f64 CPU looked fine — see the long
 * note on hash2() in field_cpu.js for the measurements. An integer hash is exact in
 * both float widths and cheaper.
 */
const HASH_BIAS = 8388608;   // 2^23 — keeps the input non-negative so shifts are logical

export const hash2 = Fn(([cell, period]) => {
    const wx = uint(wrapCell(cell.x, period.x).add(HASH_BIAS));
    const wy = uint(wrapCell(cell.y, period.y).add(HASH_BIAS));

    const h = wx.mul(uint(0x27d4eb2d)).bitXor(wy.mul(uint(0x85ebca6b))).toVar();
    h.assign(h.bitXor(h.shiftRight(uint(15))));
    h.assign(h.mul(uint(0x2c1b3c6d)));
    h.assign(h.bitXor(h.shiftRight(uint(13))));
    h.assign(h.mul(uint(0x297a2d39)));
    h.assign(h.bitXor(h.shiftRight(uint(16))));

    const lo = float(h.bitAnd(uint(0xFFFF)));
    const hi = float(h.shiftRight(uint(16)).bitAnd(uint(0xFFFF)));
    return vec2(lo, hi).div(32767.5).sub(1);
});

/**
 * Gradient noise with analytic derivatives. Returns vec3(value, d/dx, d/dy).
 * The derivatives are exact — see test/field.test.js, which locks that against
 * central differences on the CPU twin.
 */
export const noised = Fn(([p, period]) => {
    const i = floor(p).toVar();
    const f = fract(p).toVar();

    const u = f.mul(f).mul(f).mul(f.mul(f.mul(6).sub(15)).add(10)).toVar();
    const du = f.mul(f).mul(30).mul(f.mul(f.sub(2)).add(1)).toVar();

    const ga = hash2(i, period).toVar();
    const gb = hash2(i.add(vec2(1, 0)), period).toVar();
    const gc = hash2(i.add(vec2(0, 1)), period).toVar();
    const gd = hash2(i.add(vec2(1, 1)), period).toVar();

    const va = dot(ga, f).toVar();
    const vb = dot(gb, f.sub(vec2(1, 0))).toVar();
    const vc = dot(gc, f.sub(vec2(0, 1))).toVar();
    const vd = dot(gd, f.sub(vec2(1, 1))).toVar();

    const q = va.sub(vb).sub(vc).add(vd).toVar();

    const value = va
        .add(u.x.mul(vb.sub(va)))
        .add(u.y.mul(vc.sub(va)))
        .add(u.x.mul(u.y).mul(q));

    const deriv = ga
        .add(u.x.mul(gb.sub(ga)))
        .add(u.y.mul(gc.sub(ga)))
        .add(u.x.mul(u.y).mul(ga.sub(gb).sub(gc).add(gd)))
        .add(du.mul(vec2(u.y, u.x).mul(q).add(vec2(vb, vc)).sub(va)));

    return vec3(value, deriv.x, deriv.y);
});

/**
 * fBM over noised(). Unrolled in JS: `octaves` is a stack-entry global that cannot
 * vary per pixel (§4/§5 of the plan), so there is nothing to gain from a shader
 * loop and unrolling avoids the nested-Loop API entirely.
 *
 * `tile` is in the SAME units as `p` (world); each octave's cell period is derived
 * as tile*freq, which is why tile*freq0 must be whole and lacunarity integral.
 */
export function fractalNoise(p, { frequency, octaves, lacunarity, gain }, tile) {
    let acc = null;
    let nf = frequency;
    let na = 1;
    for (let o = 0; o < octaves; o++) {
        const period = vec2(tile.x * nf, tile.y * nf);
        const n = noised(p.mul(nf), period);
        const term = vec3(n.x.mul(na), n.y.mul(na * nf), n.z.mul(na * nf));
        acc = acc === null ? term : acc.add(term);
        na *= gain;
        nf *= lacunarity;
    }
    return acc ?? vec3(0);
}
