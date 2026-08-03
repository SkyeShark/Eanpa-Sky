// Phacelle erosion in TSL — the GPU twin of field_cpu.js's phacelleNoise()/
// erosionFilter(). Credit: Rune Skovbo Johansen (see reference/, README).
//
// Directional stripe noise aligned perpendicular to the slope, carrying its phase
// derivative, with each octave feeding its gradient back into gullySlope so the
// next octave's gullies follow the terrain the previous one carved. Single pass,
// analytic, no iteration — which is what makes it realtime and, once the lattice is
// wrapped, tileable.
//
// Both loops are unrolled in JS. The 4x4 cell neighbourhood is fixed, and octaves /
// scale / lacunarity are stack-entry globals that cannot vary per pixel, so there is
// nothing a shader loop would buy.

import { Fn, float, vec2, vec3, vec4, floor, fract, dot, exp, cos, sin, max, abs, sign, mix, clamp, select } from 'three/tsl';

import { hash2, fractalNoise } from './noise.js';

const TAU = 6.28318530717959;

/**
 * Returns vec4(cos, sin, sideDirX, sideDirY). `freq` here is the cell scale, not the
 * octave frequency — the caller has already scaled p by the octave frequency.
 */
export const phacelleNoise = Fn(([p, normDir, freq, offset, normalization, period]) => {
    // Orthogonal to the slope, magnitude proportional to stripe frequency.
    const sideDir = vec2(normDir.y.negate(), normDir.x).mul(freq).mul(TAU).toVar();
    const off = offset.mul(TAU).toVar();

    const pInt = floor(p).toVar();
    const pFrac = fract(p).toVar();

    const phase = vec2(0).toVar();
    const weightSum = float(0).toVar();

    // 4x4 neighbourhood. Because cell points are jittered by up to 0.5, the nearest
    // point OUTSIDE this window is 1.5 away, where the bell weight is already 0 —
    // so 4x4 is exact, not an approximation.
    for (let i = -1; i <= 2; i++) {
        for (let j = -1; j <= 2; j++) {
            const gridPoint = pInt.add(vec2(i, j));
            const randomOffset = hash2(gridPoint, period).mul(0.5);
            const v = pFrac.sub(vec2(i, j)).sub(randomOffset).toVar();

            const sqrDist = dot(v, v);
            // Subtracting 0.01111 makes the weight reach exactly 0 at 1.5, which is
            // what removes the (otherwise very subtle) grid-line artifact.
            const w = max(float(0), exp(sqrDist.mul(-2)).sub(0.01111)).toVar();
            weightSum.addAssign(w);

            const wave = dot(v, sideDir).add(off).toVar();
            phase.addAssign(vec2(cos(wave), sin(wave)).mul(w));
        }
    }

    const interp = phase.div(weightSum).toVar();
    // Floor the magnitude before normalising, so near-zero interpolations don't blow
    // up; `normalization` picks how aggressively that is applied.
    const mag = max(float(1).sub(normalization), interp.length()).toVar();

    return vec4(interp.div(mag), sideDir);
});

// `detail` is genuinely fractional (1.5 by default) so pow() is required here.
const pow_inv = Fn(([t, power]) => float(1).sub(clamp(t, 0, 1).oneMinus().pow(power)));

// ease_out squares, and it must square by MULTIPLICATION, not pow(x, 2). WGSL's pow
// is typically exp2(y*log2(x)): inexact, and log2(0) is undefined — and this hits
// x == 0 exactly whenever the clamp saturates. Using pow(x,2) here disagreed with the
// f64 oracle on ~0.1% of pixels by up to 6e-3, which is 300x the float-width noise
// floor, and the error compounds because combiMask is multiplied by newMask every
// octave. The reference writes `v * v`; match it literally.
const ease_out = Fn(([t]) => {
    const v = clamp(t, 0, 1).oneMinus().toVar();
    return v.mul(v).oneMinus();
});

// The reference's branch: with smoothing == 0 the t >= smoothing arm returns t, and
// that is what keeps this from dividing by zero (t is a length or an abs at both call
// sites, so t >= 0 always holds). select() evaluates both arms, so the divisor is
// floored as well — belt and braces, and identical wherever smoothing > 0.
const smooth_start = Fn(([t, smoothing]) => select(
    t.greaterThanEqual(smoothing),
    t.sub(smoothing.mul(0.5)),
    t.mul(t).mul(0.5).div(max(smoothing, float(1e-20))),
));

const safeNormalize = Fn(([n]) => {
    const l = n.length();
    return select(l.greaterThan(float(1e-10)), n.div(l), n);
});

/**
 * The full field: vec4(height, dh/dx, dh/dy, ridgeMap).
 *
 * IMPORTANT — the returned gradient is the erosion's CARRIED gradient, which is
 * approximate by the reference's design (it drops the spatial derivative of its own
 * onset mask and of the cell-weight blend). Measured: exact with erosion off, ~29 deg
 * off and ~0.42x magnitude at default strength. It is here because the octave chain
 * needs it and because it is a faithful port. Slope/aspect/curvature MASKS must be
 * derived from finite differences of the height channel instead — see gradientFD()
 * in field_cpu.js and §6 of the plan.
 *
 * `cfg` is a plain JS object of numbers (compile-time constants), matching
 * defaultConfig() in field_cpu.js. Promoting the per-pixel-safe subset to uniforms
 * is M1 work; baking them in keeps M0b's parity comparison unambiguous.
 */
export function ekigarField(p, cfg) {
    // The body MUST live inside Fn(): TSL's .assign()/.addAssign() write into the
    // enclosing function's statement stack, and outside one they are silently
    // dropped with only a console warning. That failure is quiet and nasty — the
    // shader still compiles and still tiles, it just discards every erosion octave,
    // which measured as a 41% height error against the CPU oracle. cfg is captured
    // at build time (compile-time constants), so only `p` crosses as a TSL arg.
    return Fn(([pIn]) => buildField(pIn, cfg))(p);
}

function buildField(p, cfg) {
    const { tile, base, erosion, heightOffset } = cfg;

    const n = fractalNoise(p, base, tile).toVar();
    const h0 = n.x.mul(base.amplitude).toVar();
    const dx0 = n.y.mul(base.amplitude).toVar();
    const dy0 = n.z.mul(base.amplitude).toVar();

    // Aim for -1 in valleys and +1 on peaks; overshoot is fine and gets clamped.
    const fadeTarget0 = clamp(h0.div(base.amplitude * 0.6), -1, 1).toVar();

    // [-1,1] -> [0,1] on the value; derivatives keep their scale, halved.
    const hx = h0.mul(0.5).add(0.5).toVar();
    const hy = dx0.mul(0.5).toVar();
    const hz = dy0.mul(0.5).toVar();

    const inX = hx.toVar(), inY = hy.toVar(), inZ = hz.toVar();

    let strength = erosion.strength * erosion.scale;
    let freq = 1 / (erosion.scale * erosion.cellScale);
    let roundingMult = 1;

    const R = erosion.rounding, O = erosion.onset, AS = erosion.assumedSlope;

    const slopeLength = max(vec2(hy, hz).length(), float(1e-10)).toVar();
    const magnitude = float(0).toVar();
    const fadeTarget = fadeTarget0.toVar();

    const roundingForInput = mix(float(R[1]), float(R[0]), clamp(fadeTarget.add(0.5), 0, 1)).mul(R[2]).toVar();
    const combiMask = ease_out(smooth_start(slopeLength.mul(O[0]), roundingForInput.mul(O[0]))).toVar();

    const ridgeMask = ease_out(slopeLength.mul(O[2])).toVar();
    const ridgeFade = fadeTarget0.toVar();

    // Assumed slope often beats the real one for seeding gully directions, because
    // the final terrain can be shaped very differently from the field that seeds it.
    const gs = vec2(
        mix(hy, hy.div(slopeLength).mul(AS[0]), AS[1]),
        mix(hz, hz.div(slopeLength).mul(AS[0]), AS[1]),
    ).toVar();

    const lastSloping = float(0).toVar();
    const lastGulX = float(0).toVar();
    for (let o = 0; o < erosion.octaves; o++) {
        const period = vec2(tile.x * freq, tile.y * freq);
        const ph = phacelleNoise(
            p.mul(freq), safeNormalize(gs), float(erosion.cellScale),
            float(0.25), float(erosion.normalization), period,
        ).toVar();

        // p was scaled by freq so the phase derivative must be too; negated because
        // these slope directions point downhill.
        const pz = ph.z.mul(-freq).toVar();
        const pw = ph.w.mul(-freq).toVar();
        const sloping = abs(ph.y).toVar();

        lastSloping.assign(sloping);
        gs.addAssign(vec2(pz, pw).mul(sign(ph.y)).mul(strength * erosion.gullyWeight));

        const gulX = ph.x.toVar();
        const gulY = ph.y.mul(pz).toVar();
        const gulZ = ph.y.mul(pw).toVar();

        lastGulX.assign(gulX);
        const fgX = mix(fadeTarget, gulX.mul(erosion.gullyWeight), combiMask).toVar();
        const fgY = mix(float(0), gulY.mul(erosion.gullyWeight), combiMask).toVar();
        const fgZ = mix(float(0), gulZ.mul(erosion.gullyWeight), combiMask).toVar();

        hx.addAssign(fgX.mul(strength));
        hy.addAssign(fgY.mul(strength));
        hz.addAssign(fgZ.mul(strength));
        magnitude.addAssign(float(strength));

        fadeTarget.assign(fgX);

        const roundingForOctave = mix(float(R[1]), float(R[0]), clamp(gulX.add(0.5), 0, 1)).mul(roundingMult).toVar();
        const newMask = ease_out(smooth_start(sloping.mul(O[1]), roundingForOctave.mul(O[1]))).toVar();
        combiMask.assign(pow_inv(combiMask, float(erosion.detail)).mul(newMask));

        ridgeFade.assign(mix(ridgeFade, gulX, ridgeMask));
        ridgeMask.mulAssign(ease_out(sloping.mul(O[3])));

        strength *= erosion.gain;
        freq *= erosion.lacunarity;
        roundingMult *= R[3];
    }

    if (cfg._debug === 'combiMask') return vec4(combiMask, 0, 0, 0);
    if (cfg._debug === 'sloping') return vec4(lastSloping, 0, 0, 0);
    if (cfg._debug === 'gulX') return vec4(lastGulX, 0, 0, 0);
    const dh = hx.sub(inX).toVar();
    const ridge = ridgeFade.mul(ridgeMask.oneMinus()).toVar();

    const offset = mix(float(heightOffset[0]), fadeTarget.negate(), float(heightOffset[1])).toVar();
    const height = inX.add(dh).add(offset.mul(magnitude));

    return vec4(height, hy, hz, ridge);
}

// ---------------------------------------------------------------------------
// Registry form
// ---------------------------------------------------------------------------

/**
 * Phacelle erosion as a stack operator: takes the incoming field vec4
 * (height, dh/dx, dh/dy, aux) and returns an eroded one, writing the ridge mask
 * into aux.
 *
 * This is the same maths as buildField's erosion half, but decoupled from the base
 * fBm so it can sit anywhere in the stack — which is the whole point of the
 * reference returning a DELTA rather than a height. Erode a warped ridged
 * multifractal, erode twice at different scales, erode only inside a mask.
 *
 * Param types are mixed by design and that is load-bearing: `scale`, `cellScale`,
 * `octaves` and `lacunarity` arrive as plain JS numbers because they set each
 * octave's lattice PERIOD, which has to be a whole number of cells and is therefore
 * resolved (and snapped) on the CPU side. Everything else arrives as a TSL node and
 * can be mask-driven or live on a slider.
 */
export function erosionOperator(f, p, ctx) {
    return Fn(([fin]) => {
        const hx = fin.x.toVar();
        const hy = fin.y.toVar();
        const hz = fin.z.toVar();
        const inX = fin.x.toVar();

        // Aim for -1 in valleys and +1 on peaks. The reference derives this from its
        // own base amplitude; as a free-standing operator we take the incoming field
        // as roughly 0..1 and centre on 0.5, which is the convention every generator
        // in the registry emits.
        const fadeTarget = clamp(hx.sub(0.5).mul(2).div(0.6), -1, 1).toVar();

        const R0 = p.ridgeRounding, R1 = p.creaseRounding;
        const R2 = 0.1, R3 = 2.0;                 // input mult, per-octave mult
        // Onset: input, octave, ridge-in, ridge-oct. The input onset is the
        // author's demo value 0.7 — ours was 1.25, which switched gullying on at
        // much gentler slopes than the reference tuning and roughened ground
        // that should have stayed smooth.
        const O = [0.7, 1.25, 2.8, 1.5];
        const AS = [0.7, 1.0];                    // assumed slope, and how far to trust it

        const slopeLength = max(vec2(hy, hz).length(), float(1e-10)).toVar();
        const magnitude = float(0).toVar();

        const roundingForInput = mix(R1, R0, clamp(fadeTarget.add(0.5), 0, 1)).mul(R2).toVar();
        const combiMask = ease_out(smooth_start(slopeLength.mul(O[0]), roundingForInput.mul(O[0]))).toVar();
        const ridgeMask = ease_out(slopeLength.mul(O[2])).toVar();
        const ridgeFade = fadeTarget.toVar();

        const gs = vec2(
            mix(hy, hy.div(slopeLength).mul(AS[0]), AS[1]),
            mix(hz, hz.div(slopeLength).mul(AS[0]), AS[1]),
        ).toVar();

        let strength = p.strength.mul(p.scale);
        let freq = 1 / (p.scale * p.cellScale);
        let roundingMult = 1;

        for (let o = 0; o < p.octaves; o++) {
            const period = vec2(ctx.tile.x * freq, ctx.tile.y * freq);
            const ph = phacelleNoise(ctx.p.mul(freq), safeNormalize(gs), float(p.cellScale),
                float(0.25), p.normalization, period).toVar();

            const pz = ph.z.mul(-freq).toVar();
            const pw = ph.w.mul(-freq).toVar();
            const sloping = abs(ph.y).toVar();

            gs.addAssign(vec2(pz, pw).mul(sign(ph.y)).mul(strength).mul(p.gullyWeight));

            const gulX = ph.x.toVar();
            const fgX = mix(fadeTarget, gulX.mul(p.gullyWeight), combiMask).toVar();
            const fgY = mix(float(0), ph.y.mul(pz).mul(p.gullyWeight), combiMask).toVar();
            const fgZ = mix(float(0), ph.y.mul(pw).mul(p.gullyWeight), combiMask).toVar();

            hx.addAssign(fgX.mul(strength));
            hy.addAssign(fgY.mul(strength));
            hz.addAssign(fgZ.mul(strength));
            magnitude.addAssign(strength);
            fadeTarget.assign(fgX);

            const rfo = mix(R1, R0, clamp(gulX.add(0.5), 0, 1)).mul(roundingMult).toVar();
            combiMask.assign(pow_inv(combiMask, p.detail).mul(ease_out(smooth_start(sloping.mul(O[1]), rfo.mul(O[1])))));

            ridgeFade.assign(mix(ridgeFade, gulX, ridgeMask));
            ridgeMask.mulAssign(ease_out(sloping.mul(O[3])));

            strength = strength.mul(p.gain);
            freq *= p.lacunarity;
            roundingMult *= R3;
        }

        // Peak-preserving raise/lower, the reference's TERRAIN_HEIGHT_OFFSET:
        // mix a flat bias toward the NEGATED fade target, which raises valleys
        // and lowers peaks so the terrain's extrema survive the erosion. The
        // previous fixed -0.65 constant just shoved everything down and let
        // strong erosion dish the terrain out.
        const offset = mix(p.offset ?? float(0), fadeTarget.negate(), p.preserve ?? float(1));
        return vec4(inX.add(hx.sub(inX)).add(offset.mul(magnitude)), hy, hz,
            ridgeFade.mul(ridgeMask.oneMinus()));
    })(f);
}
