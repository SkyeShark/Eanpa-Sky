// Ekigar's textureBase surfacing classifier, ported to Eanpa's metric terrain.
//
// Source of truth: Ekigar src/core/registry.js `textureBase` (the "node standing
// between the material stack and a plausible terrain"). Five independent signals
// — slope, soil deposition, patches, chaos, peaks — compose SIGNED around a
// mid-grey 0.5 base, so every weight moves its own term visibly everywhere
// instead of flipping thin classifier boundaries. Every derivative term comes
// from FINITE DIFFERENCES of a real height field, never from mesh normals or
// screen-space dFdx: second derivatives need real neighbour samples (dFdx of a
// dFdx is identically zero), and Eanpa's baked R32F height field supplies the
// nine-tap stencil the same way Ekigar's ctx.sampleInput does.
//
// METRIC DIVERGENCES from the Ekigar original (which operates on a unit-height
// field over a unit tile) — every one is deliberate and documented here:
// * Gradients are true meters/meter (rise over run), so slopeAngle/soilAngle
//   keep Ekigar's defaults (0.55 / 0.35) but now read as literal tangents
//   (~29 deg fully steep, ~19 deg where soil stops holding).
// * peakLevel is in METERS above the valley datum (default 30 — the elevation
//   band where Eanpa's own rock gates begin), not Ekigar's 0.6 unit height.
//   The soft window's falling edge sits far above any Eanpa summit; it exists
//   only to mirror smoothstepSoft's shape, never to engage.
// * Curvature (1/m) is orders of magnitude smaller than unit-field curvature,
//   so the free gains adapt: chaosGain defaults to 30 (Ekigar 1) and the fixed
//   0.02 Laplacian scale of the peaks term gains an explicit peakConvexGain
//   (default 30). Deposition keeps Ekigar's literal curvatureGain 0.05; its
//   +0.25 floor keeps the term alive while curvature modulation stays subtle.
// * radius is rounded to WHOLE texels: the field is nearest-filtered, so a
//   fractional radius would land taps on texel boundaries and alias, where
//   Ekigar's continuous field re-evaluation cannot.
// * The patch noise is UNTILED (period vec2(0,0)) and world-anchored; Ekigar
//   tiles it because its fields tile. `reverse`, `seed` and the optional guide
//   input are omitted — Eanpa steers placement with its authored gates instead.
// * Outside the baked ±halfExtent coverage the value fades to the neutral 0.5,
//   so clamped edge taps can never invent geology on the far horizon.
//
// TSL RULE this file obeys: no .assign()/.addAssign() anywhere — outside Fn()
// they silently drop. Everything is a pure expression chain; .toVar() (which is
// safe outside Fn) pins the nine taps so WGSL declares each read once.

import { fractalNoise } from './noise.js';

const EPS = 1e-4;

// Defaults mirror Ekigar's textureBase params where units carry over, with the
// metric adaptations called out above. The five signal weights are typically
// passed in as live uniform nodes; everything structural must stay a JS number.
export const TEXTURE_BASE_DEFAULTS = Object.freeze({
    slope: 0.6,             // steep ground
    soil: 0.5,              // where soil settles — flat AND concave
    patches: 0.3,           // blotchy variation, so a material band is not uniform
    chaos: 0.4,             // broken, high-curvature ground
    peaks: 0.35,            // high and convex at once
    slopeAngle: 0.55,       // |grad| (m/m) that reads as fully steep
    soilAngle: 0.35,        // |grad| (m/m) above which soil no longer holds
    patchMeters: 90,        // world meters per patch lattice cell (Ekigar: cells/tile)
    patchContrast: 2.5,
    chaosGain: 30,          // metric adaptation — Hessian norm is 1/m here
    peakConvexGain: 30,     // metric adaptation of the fixed 0.02 Laplacian scale
    peakLevelMeters: 30,    // METERS above the valley floor (Ekigar: 0.6 unit height)
    peakCeilingMeters: 400, // unreachable falling edge, kept for smoothstepSoft parity
    peakFalloffMeters: 8,   // soft knee width in meters (Ekigar: 0.12 unit height)
    radiusTexels: 2,        // whole texels; nearest sampling snaps taps to centers
    accentuate: 0.35,       // separates strong from weak evidence before banding
});

/**
 * Build the textureBase scalar in [0,1] for the current fragment.
 *
 * @param T3          merged three.webgpu + three/tsl namespace (Eanpa convention)
 * @param heightField { texture, halfExtent, size } — R32F raw-meters bake over
 *                    world XZ [-halfExtent, +halfExtent], nearest/clamped
 * @param params      overrides for TEXTURE_BASE_DEFAULTS; the five signal
 *                    weights (and patchContrast/accentuate) may be uniform nodes
 */
export function makeTextureBaseValue(T3, heightField, params = {}) {
    const p = { ...TEXTURE_BASE_DEFAULTS, ...params };
    const F = (value) => (typeof value === 'number' ? T3.float(value) : value);
    const size = heightField.size;
    const halfExtent = heightField.halfExtent;
    const texelMeters = (halfExtent * 2) / size;
    // Structural, like Ekigar's `structural: true` radius: it moves SAMPLING
    // POSITIONS, so it must be a JS literal, and whole so every tap sits on an
    // exact texel center under nearest filtering.
    const radius = Math.max(1, Math.round(p.radiusTexels));
    const e = radius * texelMeters;
    const inv = 1 / (2 * e);
    const inv2 = 1 / (e * e);

    const world = T3.positionWorld.xz;
    // Snap the fragment onto its texel center, then offset in whole texels —
    // the texture-tap twin of Ekigar's ctx.sampleInput(-e, 0) stencil.
    const centerTexel = world.add(halfExtent).div(texelMeters).floor().add(0.5)
        .toVar('textureBaseCenterTexel');
    const tap = (dx, dy, label) => T3.texture(
        heightField.texture,
        centerTexel.add(T3.vec2(dx, dy)).div(size),
    ).level(0).r.toVar('textureBaseTap' + label);
    const h = tap(0, 0, 'C');
    const hL = tap(-radius, 0, 'L'), hR = tap(radius, 0, 'R');
    const hD = tap(0, -radius, 'D'), hU = tap(0, radius, 'U');
    const hLD = tap(-radius, -radius, 'LD'), hRU = tap(radius, radius, 'RU');
    const hLU = tap(-radius, radius, 'LU'), hRD = tap(radius, -radius, 'RD');

    const gx = hR.sub(hL).mul(inv), gy = hU.sub(hD).mul(inv);
    const rr = hR.add(hL).sub(h.mul(2)).mul(inv2);
    const tt = hU.add(hD).sub(h.mul(2)).mul(inv2);
    const ss = hRU.sub(hLU).sub(hRD).add(hLD).mul(inv2 * 0.25);
    const g = T3.sqrt(T3.max(gx.mul(gx).add(gy.mul(gy)), 1e-12));

    // SLOPE — the signal a cliff material keys off.
    const slopeT = g.div(T3.max(F(p.slopeAngle), EPS)).clamp(0, 1);

    // SOIL — "increased density in crevices or other areas where the slope
    // allows soil to settle": flat enough to hold, and concave so material
    // collects. curvatureGain 0.05 is Ekigar's literal, kept so the two
    // implementations agree about what concave means.
    const p2 = gx.mul(gx), q2 = gy.mul(gy);
    const g2 = T3.max(p2.add(q2), 1e-9);
    const profile = p2.mul(rr).add(gx.mul(gy).mul(ss).mul(2)).add(q2.mul(tt))
        .div(g2).negate();
    const plan = q2.mul(rr).sub(gx.mul(gy).mul(ss).mul(2)).add(p2.mul(tt))
        .div(g2).negate();
    const curvatureGain = 0.05;
    const cavityT = profile.mul(curvatureGain).negate().clamp(0, 1);
    const convergeT = plan.mul(curvatureGain).negate().clamp(0, 1);
    const flat = T3.float(1).sub(g.div(T3.max(F(p.soilAngle), EPS))).clamp(0, 1);
    const depositionT = flat.mul(
        cavityT.add(convergeT.mul(0.5)).add(0.25).clamp(0, 1),
    );

    // PATCHES — blotchy low-frequency variation, contrast-stretched, so a
    // material band breaks up instead of reading as one flat wash. Two octaves,
    // period (0,0): UNTILED, anchored to world meters. The 1/1.5 mirrors
    // Ekigar fbmField's sum-of-gains normalisation for octaves=2, gain=0.5.
    const patchNoise = fractalNoise(
        world.div(p.patchMeters),
        { frequency: 1, octaves: 2, lacunarity: 2, gain: 0.5 },
        { x: 0, y: 0 },
    );
    const patchT = patchNoise.x.div(1.5).mul(0.5).mul(F(p.patchContrast))
        .add(0.5).clamp(0, 1);

    // CHAOS — the Hessian's Frobenius norm: how hard the surface is bending,
    // in any direction. Broken ground scores high; a smooth slope of ANY
    // steepness scores zero, which is what separates chaos from slope.
    const hess = T3.sqrt(
        rr.mul(rr).add(ss.mul(ss).mul(2)).add(tt.mul(tt)).add(1e-12),
    );
    const chaosT = hess.mul(F(p.chaosGain)).mul(0.02).clamp(0, 1);

    // PEAKS — high AND convex, Ekigar's pairing at its 0.02 Laplacian scale
    // times the metric peakConvexGain. `high` is smoothstepSoft: a rise
    // through peakLevel and a fall through the (unreachable) ceiling.
    const convex = rr.add(tt).negate().mul(0.02).mul(F(p.peakConvexGain))
        .clamp(0, 1);
    const lo = p.peakLevelMeters, hi = p.peakCeilingMeters, fw = p.peakFalloffMeters;
    const high = T3.smoothstep(lo - fw, lo + fw, h)
        .mul(T3.float(1).sub(T3.smoothstep(hi - fw, hi + fw, h)));
    const peakT = convex.mul(high);

    // CONTINUOUS VALUE MAP — Ekigar's weighted composition, verbatim weights:
    // every term contributes EVERYWHERE, signed around a mid-grey base.
    // Deposition brightens (settled soil and sediment), slope darkens (exposed
    // rock faces), peaks brighten summits, patches add signed grain, chaos
    // darkens broken ground.
    const composed = T3.float(0.5)
        .add(depositionT.mul(F(p.soil)).mul(0.42))
        .sub(slopeT.mul(F(p.slope)).mul(0.55))
        .add(peakT.mul(F(p.peaks)).mul(0.45))
        .add(patchT.sub(0.5).mul(F(p.patches)).mul(0.42))
        .sub(chaosT.mul(F(p.chaos)).mul(0.30))
        .clamp(0, 1);
    // Accentuate is an s-curve about the midpoint (Ekigar's sstep(0,1,v) is a
    // plain Hermite once v is clamped). Written as arithmetic lerp — mix()
    // with literal-capable arguments trips naga's abstract-type rule.
    const sCurve = composed.mul(composed)
        .mul(T3.float(3).sub(composed.mul(2)));
    const accentuated = composed.add(sCurve.sub(composed).mul(F(p.accentuate)));

    // COVERAGE — Eanpa divergence: beyond the baked extent the clamped stencil
    // degenerates (all taps read one edge texel), so fade to the neutral 0.5
    // before that happens. Neutral cancels exactly in the material's
    // normalized family contest, leaving the far horizon untouched.
    const boundary = T3.max(T3.abs(world.x), T3.abs(world.y));
    const fadeEnd = halfExtent - (radius + 1) * texelMeters;
    const coverage = T3.float(1).sub(T3.smoothstep(fadeEnd - 24, fadeEnd, boundary));
    return T3.float(0.5).add(accentuated.sub(0.5).mul(coverage)).clamp(0, 1);
}
