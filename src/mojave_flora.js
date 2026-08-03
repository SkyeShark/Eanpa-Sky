// mojave_flora — Mojave ground-flora library for the Eanpa desert.
//
// Ported from the Eidoverse grasstest workbench:
//   grass2.js    — species registry, blade/bunch/yucca bodies, aPosRot/
//                  aScaleVar/aPhase instancing decoded in a TSL positionNode,
//                  3-layer wind + pusher displacement, SSS foliage materials.
//   shrub_gen.js — SeedThree's dichotomous shrub math: stochastic L-system
//                  skeleton, welded tube wood with bark UVs, baked spray cards
//                  anchored on terminal twigs (shrub_anchors.json alignment).
// Motion is derived from CK42BB/procedural-grass-threejs (MIT): global sway /
// gust fronts with a noise envelope / per-instance flutter and quadratic-
// falloff pushers, all ×height², constants kept.
//
// Eanpa adaptations (deliberate deviations from the grasstest source):
//   • Browser I/O — globalThis.loadImageTexture(url) + fetch for JSON. The
//     source's missing-asset fallbacks silently degraded; here they THROW.
//   • No runtime PRNG — placement records arrive fully specified from
//     desert_dressing.js's seeded generator; geometry jitter uses seeded LCG/
//     splitmix streams only. No Math.random anywhere.
//   • No self-registration — the field exposes setTime/setPushers/
//     updateVisibility and desert_dressing drives them from its update().
//   • Distance-tiered instance compaction — signature-diffed rewrites of the
//     instanced attribute buffers (the analogue of vegetation.js's
//     instanceMatrix rewrite): full wood+spray detail inside woodRange,
//     spray-cards-only out to farCull, culled beyond.
//   • Scene-MRT overrides follow vegetation.js's contract
//     (userData.preserveSceneMrtOverride + explicit N8AO acceptance).
// Dropped from the source: rosette/tuft card archetypes (unused here), corn,
// VRM/harness code, Deno env flags, eidoverse audit userData stamps.

const T3 = globalThis.THREE;
const {
    positionLocal, attribute, uniform, uniformArray, texture: texNode,
    float, vec2, vec3, sin, cos, dot, normalize, smoothstep, max: tmax,
    pow, saturate, step, positionWorld, cameraPosition, Fn, tanh, luminance,
    normalLocal, transformNormalToView,
} = T3;

const ASSET_DIR = './assets/grass/';

// grass colours — the seasonal palette from the grasstest bench, one word
// each. Values are LUMINANCE-PRESERVING vs the blade atlas mean — a hue swap,
// not a darkening. galleta_dry uses `straw`.
export const GRASS_COLORS = {
    lime:          [1.15, 1.13, 0.48],
    emerald:       [0.56, 1.04, 0.61],
    blue:          [0.64, 1.05, 1.61],
    'blue-green':  [0.6, 1.07, 1.18],
    'gray-green':  { recolor: [0.92, 0.97, 0.83] },
    burgundy:      { recolor: [1.95, 0.57, 0.81] },
    rust:          { recolor: [1.93, 0.79, 0.32] },
    copper:        { recolor: [1.72, 0.93, 0.3] },
    orange:        { recolor: [1.83, 0.98, 0.19] },
    straw:         { recolor: [1.35, 1.14, 0.64] },
    brown:         { recolor: [1.24, 0.91, 0.52] },
};

// ── species registry (grasstest-approved tuning, Mojave subset) ──────────────
export const FLORA_SPECIES = {
    galleta_dry: {
        // Mojave BUNCH grass (big galleta / indian ricegrass): the bunch habit
        // is the realistic one for desert. Shares the blade atlas — a species
        // is habit params + colour, not its own texture set.
        archetype: 'blades', maps: 'blades_meadow',
        leafRecolor: GRASS_COLORS.straw.recolor,
        blades: { perBunch: 34, bunchR: 0.26, h: 0.44, w: 0.036, lean: 0.75 },
        baseScale: [0.7, 1.25], clump: 0.55,
        wind: { base: 0.28, gust: 0.5, gustFreq: 0.3, flutter: 0.7 },
        sss: 0.55, rough: 0.7, pushScale: 1.0,
    },
    // the three Mojave shrubs grow from the vendored SeedThree dichotomous
    // math: a real multi-stem crown skeleton, welded tube wood with bark maps,
    // spray cards anchored on the terminal twigs.
    blackbrush: {
        archetype: 'shrub', gen: 'blackbrush', maps: 'blackbrush',
        stem: 'blackbrush_stem', stemColor: 0x6d5a46,
        // halfway between the dark namesake tile and the sheet's pale spiny
        // twigs — old wood dark, young growth pale
        stemTint: [1.7, 1.75, 1.6],
        footRadius: 0.75,
        baseScale: [0.7, 1.25], clump: 0.5,
        wind: { base: 0.06, gust: 0.14, gustFreq: 0.3, flutter: 1.1 },
        sss: 0.35, rough: 0.9, pushScale: 0.4,
    },
    creosote: {
        archetype: 'shrub', gen: 'creosote', maps: 'creosote',
        stem: 'creosote_stem', stemColor: 0x8a7358,
        // linear lift matching the bark tile to the sheet's own painted stem —
        // the wood must read as the same branch the card art continues
        stemTint: [2.6, 2.7, 1.7],
        footRadius: 1.1,
        baseScale: [0.7, 1.3], clump: 0.3,
        wind: { base: 0.10, gust: 0.22, gustFreq: 0.3, flutter: 1.3 },
        sss: 0.45, rough: 0.85, pushScale: 0.7,
    },
    sagebrush: {
        archetype: 'shrub', gen: 'sagebrush', maps: 'sagebrush',
        stem: 'blackbrush_stem', stemColor: 0x8b8378,  // no own bark set yet — borrows blackbrush's
        // lift toward the sheet's pale shredded-silver stem while keeping the
        // fissure grain readable
        stemTint: [3.2, 3.5, 3.3],
        footRadius: 0.65,
        baseScale: [0.75, 1.3], clump: 0.45,
        wind: { base: 0.08, gust: 0.18, gustFreq: 0.3, flutter: 1.0 },
        sss: 0.4, rough: 0.9, pushScale: 0.45,
    },
    yucca: {
        // real geometry rosette — dense golden-spiral crown of V-folded
        // bayonets over a thatch trunk with a dried-leaf skirt
        archetype: 'yucca', maps: 'yucca_kit',
        rosette: { r: 0.55, spikes: 64 },   // density is what hides the crown bases
        footRadius: 0.6,
        baseScale: [1.0, 1.6], clump: 0.15,
        wind: { base: 0.03, gust: 0.06, gustFreq: 0.3, flutter: 0.5 },
        sss: 0.5, rough: 0.8, pushScale: 0.12,
    },
};

// ── seeded rng (SeedThree rng.js verbatim: xmur3 + splitmix32) ───────────────
function xmur3(str) {
    let h = 1779033703 ^ str.length;
    for (let i = 0; i < str.length; i++) {
        h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
        h = (h << 13) | (h >>> 19);
    }
    return function () {
        h = Math.imul(h ^ (h >>> 16), 2246822507);
        h = Math.imul(h ^ (h >>> 13), 3266489909);
        h ^= h >>> 16;
        return h >>> 0;
    };
}

export class Rng {
    constructor(seed) {
        const seedStr = typeof seed === 'number' ? `n:${seed}` : String(seed);
        this._state = xmur3(seedStr)() >>> 0;
    }
    next() {
        let z = (this._state = (this._state + 0x9e3779b9) | 0);
        z ^= z >>> 16; z = Math.imul(z, 0x21f0aaad);
        z ^= z >>> 15; z = Math.imul(z, 0x735a2d97);
        z ^= z >>> 15;
        return (z >>> 0) / 4294967296;
    }
    range(min, max) { return min + (max - min) * this.next(); }
    vary(base, spread) { return base + (this.next() * 2 - 1) * spread; }
}

// ── shrub skeleton (SeedThree dichotomous.js, shrub paths) ───────────────────
const UP = new T3.Vector3(0, 1, 0);
const Y = new T3.Vector3(0, 1, 0);
const X = new T3.Vector3(1, 0, 0);
const DOWN = new T3.Vector3(0, -1, 0);
const GOLDEN = (137.5 * Math.PI) / 180;

const DEFAULTS = {
    firstForkHeight: 1.6,   // trunk length to the first fork (m)
    armLength: 0.9,         // segment length per generation (m)
    armFalloff: 0.86,       // each generation's segment a bit shorter
    forkGenerations: 6,     // L-system depth
    branchiness: 0.62,      // P(a junction forks) — NOT every junction
    forkSpread: 32,         // divergence half-angle at a fork (deg)
    forkTriChance: 0.15,    // chance a fork is a trident instead of a Y
    curlUp: 0.35,           // tropism toward vertical per segment
    armBend: 16,            // programmatic elbow curve along each segment (deg)
    gnarliness: 12,         // random per-segment direction jitter (deg)
    continuationKink: 8,    // how hard a single-bud continuation veers (deg)
    forkRadiusKeep: 0.86,   // arms stay nearly as thick as the trunk per fork
    forkBaseScale: 1.0,     // arm base-ring radius as a fraction of the parent
    trunkRadius: 0.16,
    trunkFlare: 1.7,        // ground-contact base swell
    trunkSegRes: 9,         // extra rings on the trunk for organic flare
    branchRepel: 0.7,       // arms steer AWAY from existing branches
    tipClearance: 0,        // crown-ball radius for crown-vs-crown repel
    minRadius: 0.02,
    radialSegs: 10,
    segCurveRes: 4,         // rings along one bent segment
    trunks: 1,
    trunkSplayDeg: 14,
    tileWorldSize: 0.8,     // bark UV tile (m)
};

function tropism(dir, amount) {
    if (amount <= 0) return dir;
    const dot = Math.max(-1, Math.min(1, dir.dot(UP)));
    const decl = Math.acos(dot);
    if (decl < 1e-4) return dir;
    const axis = new T3.Vector3().crossVectors(dir, UP);
    if (axis.lengthSq() < 1e-8) return dir;
    axis.normalize();
    return dir.clone().applyAxisAngle(axis, amount * decl).normalize();
}
function tropismInPlace(dir, amount) { dir.copy(tropism(dir, amount)); }

function perp(dir) {
    const a = Math.abs(dir.y) < 0.9 ? UP : X;
    return new T3.Vector3().crossVectors(dir, a).normalize();
}

// One bent segment as a curved polyline: armBend elbow + gnarliness jitter +
// tropism, so the segment bends WITHOUT introducing extra L-system forks.
function growSegment(origin, dir0, length, radius0, radius1, p, rng, resOverride) {
    const res = Math.max(1, resOverride ?? p.segCurveRes);
    const points = [origin.clone()];
    const radii = [radius0];
    const dir = dir0.clone().normalize();
    const pos = origin.clone();
    const bendPer = ((p.armBend + rng.vary(0, p.gnarliness)) * Math.PI) / 180 / res;
    const bendAxis = perp(dir); // curve the elbow within one plane per segment
    for (let i = 1; i <= res; i++) {
        dir.applyAxisAngle(bendAxis, bendPer);
        if (p.gnarliness > 0) {
            dir.applyAxisAngle(perp(dir), (rng.vary(0, p.gnarliness) * Math.PI) / 180 / res);
        }
        tropismInPlace(dir, p.curlUp / res);
        pos.addScaledVector(dir, length / res);
        points.push(pos.clone());
        radii.push(radius0 + (radius1 - radius0) * (i / res));
    }
    return { points, radii, endDir: dir.clone().normalize() };
}

// Rotation-minimizing frame → per-point orientation quaternions (local +Y =
// tangent), for placing spray cards and for tube rings.
function framesFor(points) {
    const orients = [];
    const tangents = [];
    const n = points.length;
    for (let i = 0; i < n; i++) {
        const t = new T3.Vector3();
        if (i === 0) t.subVectors(points[1], points[0]);
        else if (i === n - 1) t.subVectors(points[n - 1], points[n - 2]);
        else t.subVectors(points[i + 1], points[i - 1]);
        t.normalize();
        tangents.push(t);
        orients.push(new T3.Quaternion().setFromUnitVectors(Y, t));
    }
    return { orients, tangents };
}

function makeStem(seg, level, windBase, flexGain) {
    const { orients } = framesFor(seg.points);
    // Clamp to 1 so the parent tip weight == the child base weight and forks
    // stay welded under wind (SeedThree's fork-continuous wind field).
    const winds = seg.points.map((_, i) => {
        const f = seg.points.length > 1 ? i / (seg.points.length - 1) : 0;
        return Math.min(1, windBase + flexGain * Math.pow(f, 1.15));
    });
    return {
        points: seg.points, radii: seg.radii, orients, winds,
        level, terminal: false, children: [],
    };
}

export function generateShrubSkeleton(userParams, rng) {
    const p = { ...DEFAULTS, ...userParams };
    const stems = [];
    const terminalStems = [];

    // Anti-intersection: steer a new arm's initial direction AWAY from existing
    // branch points near where it's headed; crown-vs-crown keeps spray balls clear.
    const allPts = [];
    const tips = [];
    const _rep = new T3.Vector3(), _probe = new T3.Vector3(), _d = new T3.Vector3();
    function repelDir(pos, dir, len) {
        const strength = p.branchRepel ?? 0;
        if (strength <= 0) return dir;
        const clr = p.tipClearance ?? 0;
        _probe.copy(pos).addScaledVector(dir, len * 0.8);
        const reach = len * 0.6 + clr;
        const R2 = reach ** 2, near2 = (len * 0.5) ** 2;
        _rep.set(0, 0, 0);
        for (const pt of allPts) {
            if (pt.distanceToSquared(pos) < near2) continue; // skip the parent neighborhood
            const dsq = _probe.distanceToSquared(pt);
            if (dsq < R2 && dsq > 1e-4) _rep.add(_d.subVectors(_probe, pt).multiplyScalar(1 / dsq));
        }
        const crownGap2 = (clr * 1.7) ** 2;
        for (const t of tips) {
            if (t.distanceToSquared(pos) < near2) continue;
            const dsq = _probe.distanceToSquared(t);
            if (dsq < crownGap2 && dsq > 1e-4) _rep.add(_d.subVectors(_probe, t).multiplyScalar(crownGap2 / dsq));
        }
        if (_rep.lengthSq() < 1e-8) return dir;
        return dir.clone().addScaledVector(_rep.normalize(), strength).normalize();
    }

    function grow(origin, dir, radius, length, depth, level, windBase, flareBase, baseIsFork = false, isGroundBase = false) {
        const flexGain = [0.3, 0.4, 0.5, 0.55][Math.min(level, 3)];
        const r1 = Math.max(p.minRadius, radius * 0.96); // arms barely taper along a segment
        const seg = growSegment(origin, dir, length, radius, r1, p, rng, level === 0 ? (p.trunkSegRes ?? 9) : undefined);
        // Blend the base ring toward flareBase over the first 40% of the segment
        // (a continuation widens to weld the seam; a fork arm can neck IN).
        if (flareBase) {
            for (let i = 0; i < seg.radii.length; i++) {
                const z = i / (seg.radii.length - 1);
                if (z < 0.4) seg.radii[i] = flareBase * (1 - z / 0.4) + seg.radii[i] * (z / 0.4);
            }
        }
        // Only the ground-contact segment flares — organic undulating root swell.
        if (level === 0 && isGroundBase && (p.trunkFlare ?? 0) > 0) {
            for (let i = 0; i < seg.radii.length; i++) {
                const z = i / (seg.radii.length - 1);
                const flare = z < 0.35 ? 1 + p.trunkFlare * (1 - z / 0.35) : 1;
                const amp = 0.10 + 0.16 * (1 - z);
                const und = 1 + amp * (Math.sin(z * 8.3) * 0.6 + Math.sin(z * 21.7 + 1.9) * 0.4);
                seg.radii[i] *= flare * und;
            }
        }
        const stem = makeStem(seg, level, windBase, flexGain);
        stem.baseIsFork = baseIsFork;
        stems.push(stem);
        for (const pt of seg.points) allPts.push(pt);
        const endPos = seg.points[seg.points.length - 1];
        const endDir = seg.endDir;
        const endRadius = seg.radii[seg.radii.length - 1];
        const windTip = Math.min(1, windBase + flexGain);

        if (depth <= 1) { stem.terminal = true; terminalStems.push(stem); tips.push(endPos.clone()); return stem; }

        const fork = rng.next() < p.branchiness;
        if (fork) {
            const nc = rng.next() < p.forkTriChance ? 3 : 2;
            const planeAz = rng.range(0, Math.PI * 2);
            const axis = perp(endDir);
            const childR = Math.max(p.minRadius, endRadius * p.forkRadiusKeep);
            const childLen = level === 0 ? p.armLength : length * p.armFalloff;
            for (let k = 0; k < nc; k++) {
                const az = planeAz + (k * Math.PI * 2) / nc;
                const spin = new T3.Quaternion().setFromAxisAngle(endDir, az);
                const tiltAxis = axis.clone().applyQuaternion(spin);
                const spread = ((p.forkSpread + rng.vary(0, 6)) * Math.PI) / 180;
                let cdir = endDir.clone().applyAxisAngle(tiltAxis, spread).normalize();
                cdir = repelDir(endPos, cdir, childLen);
                stem.children.push(grow(endPos, cdir, childR, childLen, depth - 1, level + 1, windTip, endRadius * (p.forkBaseScale ?? 1), nc >= 2));
            }
        } else {
            // single continuation — a dead node redirects growth into a stem
            // that VEERS off at an angle (continuationKink), not a smooth curve
            let cdir = endDir.clone();
            cdir.applyAxisAngle(perp(cdir), (rng.vary(0, p.continuationKink ?? 8) * Math.PI) / 180).normalize();
            cdir = repelDir(endPos, tropism(cdir, p.curlUp * 0.4), length);
            stem.children.push(grow(endPos, cdir, endRadius * 0.98, length, depth - 1, level, windTip, endRadius, false));
        }
        return stem;
    }

    const trunkLen = p.firstForkHeight;
    const nTrunks = Math.max(1, p.trunks | 0);
    for (let t = 0; t < nTrunks; t++) {
        const dir = UP.clone();
        if (nTrunks > 1) {
            const az = (Math.PI * 2 * t) / nTrunks;
            dir.applyAxisAngle(X, (p.trunkSplayDeg * Math.PI) / 180).applyAxisAngle(UP, az).normalize();
        }
        grow(new T3.Vector3(0, 0, 0), dir, p.trunkRadius, trunkLen, p.forkGenerations, 0, 0.05, 0, false, true);
    }
    return { stems, terminalStems, params: p };
}

// ── merged tube mesh (SeedThree buildMergedMesh, smooth tubes) ───────────────
// One connected surface: each stem is a tube of rings; a stem's LAST ring is
// stitched to EACH child's FIRST ring so the parent feeds its children through
// the fork. Rotation-minimizing frames avoid twist; terminal tips close with a
// cone cap. Wind weights land in aH (the shared height factor) — no extra
// attributes, keeping the instanced mesh inside the 7-vertex-buffer budget.

const _rmfAxis = new T3.Vector3();
function ringVertices(center, tangent, refDir, radius, seg, uvY, uScale, out, prevTangent = null) {
    // Parallel-transport the carried frame by the rotation that turns the
    // previous tangent into this one (re-projecting a fixed refDir collapses on
    // strong bends and shears the UVs).
    const n = new T3.Vector3().copy(refDir);
    if (prevTangent) {
        const dot = Math.max(-1, Math.min(1, prevTangent.dot(tangent)));
        if (dot < 0.999999) {
            _rmfAxis.crossVectors(prevTangent, tangent);
            if (_rmfAxis.lengthSq() > 1e-12) n.applyAxisAngle(_rmfAxis.normalize(), Math.acos(dot));
        }
    }
    n.addScaledVector(tangent, -n.dot(tangent));
    if (n.lengthSq() < 1e-8) n.copy(perp(tangent));
    n.normalize();
    const b = new T3.Vector3().crossVectors(n, tangent).normalize();
    for (let j = 0; j <= seg; j++) {
        const a = (j / seg) * Math.PI * 2;
        const dir = new T3.Vector3().copy(n).multiplyScalar(Math.cos(a)).addScaledVector(b, Math.sin(a));
        out.pos.push(center.x + dir.x * radius, center.y + dir.y * radius, center.z + dir.z * radius);
        out.nrm.push(dir.x, dir.y, dir.z);
        // Bark grain must run ALONG the branch — sampled the other way, a thin
        // tube cuts a strip ACROSS the painted grain and its shadow gaps wrap
        // into dark rings around every branch. Tiles differ in authored grain
        // direction, so out.grainU says which image axis is the grain.
        if (out.grainU) out.uv.push(uvY, (j / seg) * uScale);
        else out.uv.push((j / seg) * uScale, uvY);
        out.wind.push(0);
    }
    return n; // carry for the next ring (parallel transport)
}

export function buildWoodMesh(stems, params) {
    const p = { ...DEFAULTS, ...params };
    p.radialSegs = Math.max(3, Math.round(Number.isFinite(p.radialSegs) ? p.radialSegs : 3));
    const seg = p.radialSegs;
    const ringLen = seg + 1;
    const out = { pos: [], nrm: [], uv: [], wind: [], idx: [], grainU: p.barkGrainU !== false };
    const P = out.pos;
    const dsq = (i, k) => { const a3 = i * 3, b3 = k * 3; const dx = P[a3] - P[b3], dy = P[a3 + 1] - P[b3 + 1], dz = P[a3 + 2] - P[b3 + 2]; return dx * dx + dy * dy + dz * dz; };
    const stitch = (a, b) => {
        for (let j = 0; j < seg; j++) {
            const a0 = a + j, a1 = a + j + 1, b0 = b + j, b1 = b + j + 1;
            // split each quad along its SHORTER diagonal — twisted fork quads
            // stay well-shaped instead of creasing into a bowtie
            if (dsq(a1, b0) <= dsq(a0, b1)) out.idx.push(a0, b0, a1, a1, b0, b1);
            else out.idx.push(a0, b0, b1, a0, b1, a1);
        }
    };

    function emitStem(stem, refDir0, vY0, tan0 = null) {
        const { tangents } = framesFor(stem.points);
        // A CONTINUATION child shares the parent's END tangent for its first
        // ring so the rings are bit-identical and weld without a shading crease.
        if (tan0) tangents[0] = tan0.clone();
        let ref = refDir0.clone();
        let vY = vY0;
        const rings = [];
        // U wrap from a radius ABOVE the base flare; square texels (V advances
        // by the same world tile as U) so bark furrows keep constant aspect.
        const refIdx = Math.min(stem.radii.length - 1, Math.floor(stem.radii.length * 0.5));
        const circRef = 2 * Math.PI * stem.radii[refIdx];
        const wraps = circRef / p.tileWorldSize;
        const uScale = wraps >= 0.75 ? Math.max(1, Math.round(wraps)) : wraps; // integer on stems, fractional on thin twigs
        const tileV = Math.max(0.02, circRef / Math.max(uScale, 1e-4));
        for (let i = 0; i < stem.points.length; i++) {
            const base = out.pos.length / 3;
            if (i > 0) vY += stem.points[i].distanceTo(stem.points[i - 1]) / tileV;
            ref = ringVertices(stem.points[i], tangents[i], ref, stem.radii[i], seg, vY, uScale, out, i > 0 ? tangents[i - 1] : null);
            for (let j = 0; j < ringLen; j++) out.wind[out.wind.length - ringLen + j] = stem.winds[i];
            rings.push(base);
            if (i > 0) stitch(rings[i - 1], base);
        }
        const lastBase = rings[rings.length - 1];
        const lastTan = tangents[tangents.length - 1];
        for (const child of stem.children) {
            const isContinuation = child.level === stem.level;
            const childFirst = emitStem(child, ref, vY, isContinuation ? lastTan : null);
            stitch(lastBase, childFirst.first);
        }
        // Cone cap: ONE degenerate apex ring (every vertex at the tip point,
        // each keeping its own U — standard pole UV handling) closes the tube
        // with radialSegs triangles.
        if (stem.children.length === 0) {
            const capR = stem.radii[stem.radii.length - 1];
            const capC = stem.points[stem.points.length - 1];
            const capWind = stem.winds[stem.winds.length - 1];
            const aC = capC.clone().addScaledVector(lastTan, capR * 1.2);
            const apexBase = out.pos.length / 3;
            const apexVY = vY + (capR * 1.2) / tileV;
            for (let j = 0; j <= seg; j++) {
                out.pos.push(aC.x, aC.y, aC.z);
                out.nrm.push(lastTan.x, lastTan.y, lastTan.z);
                if (out.grainU) out.uv.push(apexVY, (j / seg) * uScale);
                else out.uv.push((j / seg) * uScale, apexVY);
                out.wind.push(capWind);
            }
            stitch(lastBase, apexBase);
        }
        return { first: rings[0], last: lastBase };
    }

    const childSet = new Set();
    for (const s of stems) for (const c of s.children) childSet.add(c);
    for (const s of stems) {
        if (childSet.has(s)) continue;
        const t0 = new T3.Vector3().subVectors(s.points[1], s.points[0]).normalize();
        emitStem(s, perp(t0), 0);
    }

    const g = new T3.BufferGeometry();
    g.setAttribute('position', new T3.BufferAttribute(new Float32Array(out.pos), 3));
    g.setAttribute('normal', new T3.BufferAttribute(new Float32Array(out.nrm), 3));
    g.setAttribute('uv', new T3.BufferAttribute(new Float32Array(out.uv), 2));
    // fork-continuous wind weight → the shared aH height factor; ×0.3 keeps
    // wood stiffer than foliage and card bases pick up the same value at their
    // anchors for weld-tight motion
    const aH = new Float32Array(out.wind.length);
    for (let i = 0; i < out.wind.length; i++) aH[i] = out.wind[i] * 0.3;
    g.setAttribute('aH', new T3.BufferAttribute(aH, 1));
    g.setIndex(out.idx);
    g.computeVertexNormals();
    // Weld SHADING normals across coincident positions (fork joints, U-wrap
    // seam) so computeVertexNormals' hard edges don't read as seams.
    {
        const pos = g.attributes.position.array, nrm = g.attributes.normal.array;
        const buckets = new Map();
        const Q = 1e4;
        for (let v = 0; v < pos.length / 3; v++) {
            const k = `${Math.round(pos[v * 3] * Q)},${Math.round(pos[v * 3 + 1] * Q)},${Math.round(pos[v * 3 + 2] * Q)}`;
            let b = buckets.get(k); if (!b) buckets.set(k, b = []); b.push(v);
        }
        for (const b of buckets.values()) {
            if (b.length < 2) continue;
            let nx = 0, ny = 0, nz = 0;
            for (const v of b) { nx += nrm[v * 3]; ny += nrm[v * 3 + 1]; nz += nrm[v * 3 + 2]; }
            const l = Math.hypot(nx, ny, nz) || 1; nx /= l; ny /= l; nz /= l;
            for (const v of b) { nrm[v * 3] = nx; nrm[v * 3 + 1] = ny; nrm[v * 3 + 2] = nz; }
        }
        g.attributes.normal.needsUpdate = true;
    }
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
}

// ── spray cards on terminal stems (leaf-cards buildFoliage 'clusters') ───────
const CARD_DEFAULTS = {
    sizeVar: 0.3,
    taper: 0.25,           // tip sprays only slightly smaller
    startFrac: 0.35,       // sprays cover the leafy zone, not the bare branch base
    downAngle: 52,         // card pitch off the branch (deg), forward of the tangent
    downAngleV: 18,
    droop: 22,             // gravity sag toward the ground (deg)
    droopV: 12,
    clustersPerBranch: 3,
    clusterSize: 1.3,      // spray card span (m)
    clusterSizeVar: 0.3,
    clusterQuads: 2,       // crossed base-anchored planes per spray
};

// Base-anchored unit quad pair with the measured art alignment BAKED IN:
// u-centre the painted stem, roll to lie along the branch (shrub_anchors.json).
// Returns flat arrays; quads rotated about the length (Y) axis for volume.
function cardTemplate(quads, anchor) {
    const base = [[-0.5, 0], [0.5, 0], [0.5, 1], [-0.5, 1]];
    const uvB = [[0, 0], [1, 0], [1, 1], [0, 1]];
    const roll = anchor ? (anchor.rollDeg * Math.PI) / 180 : 0;
    const du = anchor ? -(anchor.u - 0.5) : 0;
    const cr = Math.cos(roll), sr = Math.sin(roll);
    const pos = [], nrm = [], uv = [], idx = [];
    let b = 0;
    for (let q = 0; q < quads; q++) {
        const a = (q * Math.PI) / quads;
        const ca = Math.cos(a), sa = Math.sin(a);
        for (let i = 0; i < 4; i++) {
            let [x, y] = base[i];
            x += du;                                 // art u-centring
            const xr = x * cr - y * sr, yr = x * sr + y * cr;   // art roll (Z)
            pos.push(xr * ca, yr, xr * sa);          // spin quad about length axis
            nrm.push(-sa, 0, ca);
            uv.push(uvB[i][0], uvB[i][1]);
        }
        idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
        b += 4;
    }
    return { pos, nrm, uv, idx };
}

export function bakeSprayCards(terminalStems, parentStems, cfgIn, rng, anchor) {
    const cIn = { ...CARD_DEFAULTS, ...cfgIn };
    // Cluster sprays ride the same placement grammar as single leaves — same
    // branch-frame anchoring, down-angle, phyllotaxy, droop — fewer, bigger cards.
    const c = {
        ...cIn,
        perBranch: cIn.clustersPerBranch,
        size: cIn.clusterSize,
        sizeVar: cIn.clusterSizeVar,
        quads: cIn.clusterQuads,
        startFrac: cfgIn.startFrac ?? 0.35,
    };
    if (!terminalStems.length || c.perBranch <= 0) return null;

    const tpl = cardTemplate(c.quads, anchor);
    const vmin = anchor?.vmin ?? 0.05;
    const pos = [], nrm = [], uv = [], aH = [], idx = [];
    let vb = 0;

    const q = new T3.Quaternion(), qFrame = new T3.Quaternion(),
        q1 = new T3.Quaternion(), q2 = new T3.Quaternion(), qb = new T3.Quaternion();
    const pA = new T3.Vector3(), n = new T3.Vector3(), droopAxis = new T3.Vector3(),
        vtx = new T3.Vector3(), nv = new T3.Vector3(), cardY = new T3.Vector3();
    let minY = Infinity, maxY = -Infinity;

    // Terminals carry the full spray density; sub-terminal parents (shrubs are
    // leafy through the middle, not pom-poms on sticks) take a fraction of it,
    // slightly smaller — same grammar, same anchoring.
    const jobs = [{ list: terminalStems, per: c.perBranch, sizeMul: 1 }];
    const parentPer = Math.round(c.perBranch * (cIn.parentSprays ?? 0));
    if (parentStems?.length && parentPer > 0) {
        jobs.push({ list: parentStems, per: parentPer, sizeMul: 0.85 });
    }
    for (const job of jobs)
    for (const stem of job.list) {
        const pts = stem.points, oris = stem.orients;
        const segN = pts.length - 1;
        let phyllo = rng.range(0, Math.PI * 2);
        for (let i = 0; i < job.per; i++) {
            const frac = c.startFrac + (1 - c.startFrac) * ((i + rng.next()) / job.per);
            const fseg = Math.min(segN - 1, Math.floor(frac * segN));
            const ft = frac * segN - fseg;
            pA.copy(pts[fseg]).lerp(pts[fseg + 1], ft);
            qFrame.copy(oris[fseg]).slerp(oris[fseg + 1], ft); // branch frame: local +Y = tangent
            const wAnchor = stem.winds
                ? stem.winds[fseg] * (1 - ft) + stem.winds[fseg + 1] * ft
                : 0.9;

            // qCard = frame · phyllo(about tangent Y) · downAngle(about X)
            phyllo += GOLDEN + rng.vary(0, 0.3);
            q2.setFromAxisAngle(Y, phyllo);
            const down = ((c.downAngle + rng.vary(0, c.downAngleV)) * Math.PI) / 180;
            q1.setFromAxisAngle(X, down);
            q.copy(qFrame).multiply(q2).multiply(q1);

            // gravity droop: sag the spray toward the ground
            if (c.droop > 0) {
                n.set(0, 1, 0).applyQuaternion(q);
                droopAxis.crossVectors(n, DOWN);
                if (droopAxis.lengthSq() > 1e-6) {
                    droopAxis.normalize();
                    qb.setFromAxisAngle(droopAxis, ((c.droop + rng.vary(0, c.droopV)) * Math.PI) / 180);
                    q.premultiply(qb);
                }
            }

            const s = c.size * job.sizeMul * (1 - c.taper * frac) * (1 + rng.vary(0, c.sizeVar));
            // the sink consumes the sheet's transparent margin below the art
            // (plus a hair) along the card's own growth axis — visible art
            // STARTS inside the wood, never hovering off the branch
            cardY.set(0, 1, 0).applyQuaternion(q);
            const org = pA.clone().addScaledVector(cardY, -(vmin * s + 0.015));

            const s0 = vb;
            for (let v = 0; v < tpl.pos.length / 3; v++) {
                vtx.set(tpl.pos[v * 3] * s, tpl.pos[v * 3 + 1] * s, tpl.pos[v * 3 + 2] * s)
                    .applyQuaternion(q).add(org);
                nv.set(tpl.nrm[v * 3], tpl.nrm[v * 3 + 1], tpl.nrm[v * 3 + 2]).applyQuaternion(q);
                pos.push(vtx.x, vtx.y, vtx.z);
                nrm.push(nv.x, nv.y, nv.z);
                uv.push(tpl.uv[v * 2], tpl.uv[v * 2 + 1]);
                // base = the wood's aH at the anchor (weld-tight motion), tip flutters more
                const tLocal = Math.max(0, Math.min(1, tpl.pos[v * 3 + 1]));
                aH.push(wAnchor * 0.3 + tLocal * 0.45);
                minY = Math.min(minY, vtx.y); maxY = Math.max(maxY, vtx.y);
                vb++;
            }
            for (const ix of tpl.idx) idx.push(s0 + ix);
        }
    }
    if (!pos.length) return null;

    // Bent vertex normals: every foliage-card normal points outward from the
    // canopy centre (pure spherical) so the whole crown shades as one soft
    // volume — no per-card lighting disagreement, no crosshatch.
    const cy = minY + (maxY - minY) * 0.45;
    const bent = new T3.Vector3();
    for (let v = 0; v < pos.length / 3; v++) {
        bent.set(pos[v * 3], pos[v * 3 + 1] - cy, pos[v * 3 + 2]).normalize();
        nrm[v * 3] = bent.x; nrm[v * 3 + 1] = bent.y; nrm[v * 3 + 2] = bent.z;
    }

    const g = new T3.BufferGeometry();
    g.setAttribute('position', new T3.Float32BufferAttribute(pos, 3));
    g.setAttribute('normal', new T3.Float32BufferAttribute(nrm, 3));
    g.setAttribute('uv', new T3.Float32BufferAttribute(uv, 2));
    g.setAttribute('aH', new T3.Float32BufferAttribute(aH, 1));
    g.setIndex(idx);
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
}

// ── shrub species presets (tuned in the SeedThree shrub dive, 2026-07-29) ────
export const SHRUB_GEN = {
    // The wood is a LOWPOLY armature that stops where the card takes over —
    // each card is a WHOLE painted branch assembly (twig + leaves + blooms),
    // so the skeleton grows one generation less and the art carries the
    // terminal branching. Big cards, few of them.
    creosote: {
        // open wiry vase: multi-stem root crown, low V-forks, no leader
        params: {
            trunks: 5, trunkSplayDeg: 38, firstForkHeight: 0.12,
            armLength: 0.55, armFalloff: 0.85, forkGenerations: 4,
            branchiness: 0.78, forkSpread: 30, forkTriChance: 0.1,
            curlUp: 0.15, armBend: 12, gnarliness: 14, continuationKink: 10,
            forkRadiusKeep: 0.78, trunkRadius: 0.022, trunkFlare: 1.2,
            branchRepel: 0.6, minRadius: 0.004, radialSegs: 4,
            segCurveRes: 2, trunkSegRes: 3, tileWorldSize: 0.5,
            barkGrainU: true,   // twig-pile tile: grain along image X
        },
        foliage: {
            // reference (Furnace Creek): foliage SLEEVES the outer third of
            // each wand — dense sprigs along the terminal runs, real sky gaps
            // between branch systems. Not a uniform fuzz ball.
            clustersPerBranch: 8, clusterSize: 0.58, clusterSizeVar: 0.35,
            clusterQuads: 2, downAngle: 24, downAngleV: 12, droop: 14,
            startFrac: 0.22, parentSprays: 0.5,
        },
    },
    blackbrush: {
        // dense gnarled low dome: many short stems, twiggy thicket habit
        params: {
            trunks: 6, trunkSplayDeg: 42, firstForkHeight: 0.08,
            armLength: 0.32, armFalloff: 0.82, forkGenerations: 4,
            branchiness: 0.85, forkSpread: 34, forkTriChance: 0.12,
            curlUp: 0.1, armBend: 14, gnarliness: 22, continuationKink: 14,
            forkRadiusKeep: 0.76, trunkRadius: 0.015, trunkFlare: 1.15,
            branchRepel: 0.5, minRadius: 0.0035, radialSegs: 4,
            segCurveRes: 2, trunkSegRes: 3, tileWorldSize: 0.4,
            barkGrainU: false,  // fissure tile: grain along image Y
        },
        foliage: {
            clustersPerBranch: 3, clusterSize: 0.5, clusterSizeVar: 0.3,
            clusterQuads: 2, downAngle: 32, downAngleV: 14, droop: 16,
            startFrac: 0.2, parentSprays: 0.6,    // twiggy cover to the crown
        },
    },
    sagebrush: {
        // upswept silver vase: few stout fibrous stems, foliage starting low
        params: {
            trunks: 3, trunkSplayDeg: 26, firstForkHeight: 0.15,
            armLength: 0.36, armFalloff: 0.86, forkGenerations: 4,
            branchiness: 0.8, forkSpread: 24, forkTriChance: 0.08,
            curlUp: 0.28, armBend: 10, gnarliness: 10, continuationKink: 8,
            forkRadiusKeep: 0.78, trunkRadius: 0.02, trunkFlare: 1.15,
            branchRepel: 0.55, minRadius: 0.004, radialSegs: 5,
            segCurveRes: 2, trunkSegRes: 3, tileWorldSize: 0.45,
            barkGrainU: false,  // borrows blackbrush's fissure tile
        },
        foliage: {
            clustersPerBranch: 3, clusterSize: 0.48, clusterSizeVar: 0.3,
            clusterQuads: 2, downAngle: 30, downAngleV: 12, droop: 10,
            startFrac: 0.15, parentSprays: 0.6,   // leafy through the middle
        },
    },
};

// One plant → { leaf, stem } merged geometries ready for field instancing.
export function buildShrubGeometry(name, seed, anchor) {
    const preset = SHRUB_GEN[name];
    if (!preset) throw new Error(`[mojave_flora] unknown shrub '${name}' — have: ${Object.keys(SHRUB_GEN).join(', ')}`);
    const rng = new Rng(`${name}:${seed}`);
    const params = {
        ...preset.params,
        // crown-ball radius for crown-vs-crown repel — sprays get room
        tipClearance: (preset.foliage.clusterSize ?? 0.5) * 0.9,
    };
    const { stems, terminalStems } = generateShrubSkeleton(params, rng);
    const stem = buildWoodMesh(stems, params);
    // sub-terminal parents (feed the mid-canopy when foliage.parentSprays > 0)
    const parents = stems.filter((s) => !s.terminal && s.children.some((ch) => ch.terminal));
    const leaf = bakeSprayCards(terminalStems, parents, preset.foliage, rng, anchor);
    return { leaf, stem, stats: { stems: stems.length, terminals: terminalStems.length,
        woodVerts: stem.attributes.position.count, leafVerts: leaf ? leaf.attributes.position.count : 0 } };
}

// ── map loading — browser URLs; MISSING ASSETS THROW ─────────────────────────
async function loadMap(name, { srgb = false, repeat = false } = {}) {
    if (typeof globalThis.loadImageTexture !== 'function') {
        throw new Error('[mojave_flora] globalThis.loadImageTexture is required (defined in src/main.js)');
    }
    let t;
    try {
        t = await globalThis.loadImageTexture(ASSET_DIR + name, { srgb, mipmaps: true });
    } catch (error) {
        // The grasstest source silently fell back to flat colour on a missing
        // sheet; in Eanpa a missing flora asset is a build defect.
        throw new Error(`[mojave_flora] required asset ${ASSET_DIR}${name} failed to load: ${error?.message ?? error}`);
    }
    t.wrapS = t.wrapT = repeat ? T3.RepeatWrapping : T3.ClampToEdgeWrapping;
    t.anisotropy = 4;
    t.needsUpdate = true;
    return t;
}

async function loadSpeciesMaps(base) {
    const [albedo, normal, rough, transl] = await Promise.all([
        loadMap(`${base}_albedo.png`, { srgb: true }),
        loadMap(`${base}_normal.png`),
        loadMap(`${base}_roughness.png`),
        loadMap(`${base}_translucency.png`, { srgb: true }),
    ]);
    return { albedo, normal, rough, transl };
}

// bark map set for shrub wood — the tube UVs wrap, so these tile
async function loadStemMaps(base) {
    const [albedo, rough] = await Promise.all([
        loadMap(`${base}_albedo.png`, { srgb: true, repeat: true }),
        loadMap(`${base}_roughness.png`, { repeat: true }),
    ]);
    return { albedo, rough };
}

async function loadJson(name) {
    const response = await fetch(ASSET_DIR + name);
    if (!response.ok) {
        throw new Error(`[mojave_flora] required asset ${ASSET_DIR}${name} failed to load (${response.status})`);
    }
    return response.json();
}

// ── card geometry helpers ────────────────────────────────────────────────────
// grass cards light like a ground carpet when their normals lean world-up —
// per-card normals leave half the yaw-rotated instances facing away from the
// sun and the field goes near-black in the mid-distance
function blendNormalsUp(g, k = 0.65) {
    const nor = g.attributes.normal;
    for (let i = 0; i < nor.count; i++) {
        const nx = nor.getX(i) * (1 - k), ny = nor.getY(i) * (1 - k) + k, nz = nor.getZ(i) * (1 - k);
        const l = Math.hypot(nx, ny, nz) || 1;
        nor.setXYZ(i, nx / l, ny / l, nz / l);
    }
    return g;
}

// blade cards, the Halo hybrid: each blade is a segmented plane whose
// silhouette lives in the ALPHA of an individual-blade atlas column — and the
// card's loop widths/centres are FITTED to the measured envelope of that
// column's art (blades_meadow_fit.json) so the empty-alpha margin, and with it
// the overdraw, mostly disappears.
function bunchGeometry(spec, rng, fit) {
    const { perBunch, bunchR, h, w, lean } = spec.blades;
    const COLS = 8;
    const cardW = w * 2;                  // full card width the atlas column maps to
    const pos = [], aH = [], uv = [], idx = [];
    let vb = 0;
    const LOOPS = 4;                      // horizontal segments carry the bend
    for (let b = 0; b < perBunch; b++) {
        const ang = rng() * Math.PI * 2, rad = Math.sqrt(rng()) * bunchR;
        const bx = Math.cos(ang) * rad, bz = Math.sin(ang) * rad;
        const bh = h * (0.6 + rng() * 0.8), bw = cardW * (0.85 + rng() * 0.4);
        const roll = rng() * Math.PI * 2;
        const leanAmt = (0.25 + rng() * 0.75) * lean * bh;
        const cr = Math.cos(roll), sr = Math.sin(roll);
        const c = Math.floor(rng() * COLS);
        const bands = fit ? fit[c] : null;
        const s0 = vb;
        for (let lp = 0; lp <= LOOPS; lp++) {
            const t = lp / LOOPS;
            const [fcx, fhw] = bands ? bands[lp] : [0, 0.5];
            const bend = leanAmt * t * t;                 // pose lean (quadratic)
            const artC = fcx * bw;                        // follow the art's curve
            const px = bx + cr * (bend + artC), pz = bz + sr * (bend + artC);
            const py = t * bh;
            const hwW = fhw * bw;                         // fitted half-width
            pos.push(px - sr * hwW, py, pz + cr * hwW);
            pos.push(px + sr * hwW, py, pz - cr * hwW);
            // UVs sample exactly the strip of art the fitted card covers
            uv.push((c + 0.5 + fcx - fhw) / COLS, t, (c + 0.5 + fcx + fhw) / COLS, t);
            aH.push(t, t);
            vb += 2;
        }
        for (let lp = 0; lp < LOOPS; lp++) {
            const a = s0 + lp * 2;
            idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
        }
    }
    const g = new T3.BufferGeometry();
    g.setAttribute('position', new T3.Float32BufferAttribute(pos, 3));
    g.setAttribute('aH', new T3.Float32BufferAttribute(aH, 1));
    g.setAttribute('uv', new T3.Float32BufferAttribute(uv, 2));
    g.setIndex(idx);
    g.computeVertexNormals();
    return blendNormalsUp(g, 1.0);   // blades: normals straight up — light like the ground plane
}

// Mojave yucca (Yucca schidigera) — a DENSE golden-spiral crown of straight
// stiff bayonets — near-vertical at the centre grading to sub-horizontal at
// the rim, each base on its own point of a small dome — over a thatch-skinned
// trunk whose upper half wears a thick skirt of downswept dried leaves.
function yuccaGeometry(spec, rng) {
    const { r, spikes } = spec.rosette;
    const pos = [], uv = [], aH = [], idx = [];
    let vb = 0;
    const S = new T3.Vector3(), A = new T3.Vector3(), UPL = new T3.Vector3(), RAD = new T3.Vector3();
    const YUP = new T3.Vector3(0, 1, 0);
    const GA = 2.399963;   // golden angle
    // atlas thirds (the approved composition sheet): live fronds | dry fronds
    // | trunk thatch — each spike maps its column window; the art's alpha
    // carves the silhouettes
    const LIVE = [0.012, 0.32], DRY = [0.345, 0.655], BARK = [0.67, 0.996];
    const liveCol = () => LIVE;
    const dryCol = () => DRY;
    // a real column, not a ground collar; heroes scale this up per instance
    const trunkH = 0.22 + rng() * 0.28;
    const trunkR = 0.06 + rng() * 0.02;
    // decades of lean baked into the column: a smooth arc — the crown rides
    // the arc's END tangent, so the whole head tips off-vertical
    const bendA = rng() * Math.PI * 2;
    const bendAmt = (0.1 + rng() * 0.55) * trunkH;
    const bcx = Math.cos(bendA) * bendAmt, bcz = Math.sin(bendA) * bendAmt;
    const trunkPoint = (t) => [bcx * t * t, t * trunkH, bcz * t * t];
    const qAt = (t) => {                    // frame of the arc at height fraction t
        A.set(2 * bcx * t, trunkH, 2 * bcz * t).normalize();
        return new T3.Quaternion().setFromUnitVectors(YUP, A);
    };

    // one straight V-folded bayonet from an explicit base point; qRot tips its
    // whole frame (axis, side, fold) with the column so leaves follow the lean
    function spike(yaw, pitch, len, u0, u1, bx, by, bz, droopK, qRot) {
        const w0 = len * 0.145 * (0.9 + rng() * 0.3);    // fuller blades, mild jitter
        A.set(Math.cos(yaw) * Math.cos(pitch), Math.sin(pitch), Math.sin(yaw) * Math.cos(pitch));
        S.set(-Math.sin(yaw), 0, Math.cos(yaw));
        UPL.set(0, 1, 0);
        if (qRot) { A.applyQuaternion(qRot); S.applyQuaternion(qRot); UPL.applyQuaternion(qRot); }
        const segs = 3, s0 = vb;
        for (let sg = 0; sg <= segs; sg++) {
            const t = sg / segs;
            const wHere = w0 * (1 - t * 0.94);
            const droop = droopK * len * t * t;   // gravity sag stays world-down
            const cxp = bx + A.x * len * t, cyp = by + A.y * len * t + droop, czp = bz + A.z * len * t;
            const foldUp = wHere * 0.55;
            pos.push(cxp - S.x * wHere, cyp - S.y * wHere, czp - S.z * wHere); uv.push(u0, t); aH.push(t * 0.3);
            pos.push(cxp + UPL.x * foldUp, cyp + UPL.y * foldUp, czp + UPL.z * foldUp); uv.push((u0 + u1) / 2, t); aH.push(t * 0.3);
            pos.push(cxp + S.x * wHere, cyp + S.y * wHere, czp + S.z * wHere); uv.push(u1, t); aH.push(t * 0.3);
            vb += 3;
        }
        for (let sg = 0; sg < segs; sg++) {
            const a = s0 + sg * 3, b = a + 3;
            idx.push(a, a + 1, b, a + 1, b + 1, b, a + 1, a + 2, b + 1, a + 2, b + 2, b + 1);
        }
    }

    // trunk: rings along the arc, base sunk below grade, real thatch skin
    {
        const n = 10, rings = 4, s0 = vb;
        for (let g = 0; g <= rings; g++) {
            const t = g / rings;
            const [cx, cy, cz] = trunkPoint(t);
            const rad = trunkR * (1.12 - 0.27 * t);
            const y = g === 0 ? -0.05 : cy;
            for (let i = 0; i <= n; i++) {
                const a = (i / n) * Math.PI * 2;
                const u = BARK[0] + (BARK[1] - BARK[0]) * (i / n);
                pos.push(cx + Math.cos(a) * rad, y, cz + Math.sin(a) * rad);
                uv.push(u, 0.02 + t * trunkH * 0.9); aH.push(0);
                vb += 1;
            }
        }
        for (let g = 0; g < rings; g++) for (let i = 0; i < n; i++) {
            const a = s0 + g * (n + 1) + i, b = a + n + 1;
            idx.push(a, b, a + 1, a + 1, b, b + 1);
        }
        const [tx, ty, tz] = trunkPoint(1);
        const cTop = vb;
        pos.push(tx, ty + 0.01, tz); uv.push((BARK[0] + BARK[1]) / 2, 0.6); aH.push(0); vb += 1;
        const lastRing = s0 + rings * (n + 1);
        for (let i = 0; i < n; i++) idx.push(lastRing + i, cTop, lastRing + i + 1);
    }

    // dried skirt: dense, in a tight band just under the crown, downswept and
    // hugging the column — bases and directions follow the arc's local frame
    const nSkirt = Math.round(spikes * 0.8);
    for (let i = 0; i < nSkirt; i++) {
        const tS = i / nSkirt;
        const yaw = i * GA + rng() * 0.3;
        const hFrac = Math.min(1, 0.72 + 0.26 * tS + rng() * 0.04);
        const [cx, cy, cz] = trunkPoint(hFrac);
        const qR = qAt(hFrac);
        const pitch = -(0.35 + rng() * 0.8);
        const len = r * (0.3 + 0.2 * tS + rng() * 0.14);          // oldest (lowest) slightly shorter
        const col = tS < 0.35 ? BARK : dryCol();                  // oldest thatch weathers to trunk colour
        RAD.set(Math.cos(yaw) * trunkR * 0.9, 0, Math.sin(yaw) * trunkR * 0.9).applyQuaternion(qR);
        spike(yaw, pitch, len, col[0], col[1], cx + RAD.x, cy + RAD.y, cz + RAD.z, -0.28, qR);
    }

    // live crown: golden-spiral spherical burst riding the arc's end tangent.
    // t=0 centre → near-vertical bayonets, t=1 rim plunging into the skirt;
    // each base on its own dome point. Mid-dome leaves run longest.
    const qTop = qAt(1);
    const [tpx, tpy, tpz] = trunkPoint(1);
    for (let i = 0; i < spikes; i++) {
        const t = (i + 0.5) / spikes;
        const yaw = i * GA + rng() * 0.25;
        const pitch = 1.45 - t * 2.1 + rng() * 0.12;              // ~83° → ~-37°
        const baseR = trunkR * (0.15 + 0.8 * Math.sqrt(t));
        const hDome = 0.02 + 0.055 * (1 - t * t);                 // dome: centre sits higher
        const len = r * (0.6 + 0.42 * Math.sin(Math.min(Math.PI, (0.25 + t * 0.75) * Math.PI)) + rng() * 0.12);
        RAD.set(Math.cos(yaw) * baseR, hDome, Math.sin(yaw) * baseR).applyQuaternion(qTop);
        const lc = liveCol();
        spike(yaw, pitch, len, lc[0], lc[1], tpx + RAD.x, tpy + RAD.y, tpz + RAD.z, -0.04, qTop);
    }

    const g = new T3.BufferGeometry();
    g.setAttribute('position', new T3.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new T3.Float32BufferAttribute(uv, 2));
    g.setAttribute('aH', new T3.Float32BufferAttribute(aH, 1));
    g.setIndex(idx);
    g.computeVertexNormals();
    return blendNormalsUp(g, 0.35);
}

// ── cross-field occupancy — content-aware overlap ───────────────────────────
// Structural plants (species with footRadius) claim their canopy footprint
// here as they place; later fields skip candidates that would clip an
// existing claim. One registry per scene build; reset on dispose.
// Shrub canopies may touch (×0.75 of summed radii); grasses ignore it all.
const _placedPlants = [];
export function resetFloraOccupancy() { _placedPlants.length = 0; }
export function claimPlantFootprint(x, z, r) { _placedPlants.push({ x, z, r }); }
export function occupancyConflict(x, z, r) {
    for (let i = 0; i < _placedPlants.length; i++) {
        const p = _placedPlants[i];
        const rr = (r + p.r) * 0.75;
        const dx = x - p.x, dz = z - p.z;
        if (dx * dx + dz * dz < rr * rr) return true;
    }
    return false;
}

// ── shared noise (placement clumping + the gust envelope texture) ────────────
export function valueNoise2D(seed) {
    const h = (x, y) => { const s = Math.sin(x * 12.9898 + y * 78.233 + seed * 37.719) * 43758.5453; return s - Math.floor(s); };
    return (x, y) => {
        const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
        const ux = xf * xf * (3 - 2 * xf), uy = yf * yf * (3 - 2 * yf);
        return (h(xi, yi) * (1 - ux) + h(xi + 1, yi) * ux) * (1 - uy)
            + (h(xi, yi + 1) * (1 - ux) + h(xi + 1, yi + 1) * ux) * uy;
    };
}

// the shared gust-envelope noise texture (proven on-stack pattern)
let _gustTex = null;
function gustTex() {
    if (_gustTex) return _gustTex;
    const n = 256, d = new Uint8Array(n * n * 4);
    const nz = valueNoise2D(3);
    for (let i = 0; i < n * n; i++) {
        const x = i % n, y = (i / n) | 0;
        let v = 0, amp = 0.55, f = 0.035;
        for (let o = 0; o < 4; o++) { v += nz(x * f, y * f) * amp; amp *= 0.5; f *= 2; }
        const c = Math.max(0, Math.min(255, v * 255)) | 0;
        d[i * 4] = c; d[i * 4 + 1] = c; d[i * 4 + 2] = c; d[i * 4 + 3] = 255;
    }
    _gustTex = new T3.DataTexture(d, n, n, T3.RGBAFormat);
    _gustTex.wrapS = _gustTex.wrapT = T3.RepeatWrapping;
    _gustTex.magFilter = _gustTex.minFilter = T3.LinearFilter;
    _gustTex.needsUpdate = true;
    return _gustTex;
}

// Module-global shared state teardown: the gust texture and the occupancy
// registry outlive individual fields; the dressing owner calls this once.
export function disposeSharedFloraResources() {
    if (_gustTex) { _gustTex.dispose(); _gustTex = null; }
    resetFloraOccupancy();
}

// Scene-MRT override following vegetation.js's contract: a full four-
// attachment stamp whose metalrough.b carries the per-material N8AO
// acceptance, preserved through main.js's eanpaStripMrt pass.
function stampSceneMrtOverride(material, n8aoAcceptance) {
    if (!(T3.mrt && T3.output && T3.normalView)) return;
    material.mrtNode = T3.mrt({
        output: T3.output,
        normal: T3.vec4(T3.directionToColor(T3.normalView), T3.float(1)),
        metalrough: T3.vec4(
            T3.metalness, T3.roughness,
            T3.float(n8aoAcceptance), T3.float(1),
        ),
        emissive: T3.vec4(T3.emissive, T3.float(1)),
    });
    material.userData.n8aoAcceptance = n8aoAcceptance;
    material.userData.preserveSceneMrtOverride = true;
}

const _m4 = new T3.Matrix4();

// ── field factory ────────────────────────────────────────────────────────────
// Builds one instanced flora field from EXPLICIT placement records:
//   { x, y, z, yaw, scale, colorVar, phase, tx, tz }
// (all values pre-rolled by the caller's seeded generator — this module never
// invents randomness at load). Options:
//   species   FLORA_SPECIES key
//   seed      geometry-jitter seed (deterministic LCG / splitmix streams)
//   farCull   metres beyond which instances are compacted out entirely
//   woodRange metres inside which shrub tube wood renders (shrubs only);
//             between woodRange and farCull the baked spray cards carry the
//             silhouette alone
export async function createFloraField(opts = {}) {
    const spec = FLORA_SPECIES[opts.species];
    if (!spec) throw new Error(`[mojave_flora] unknown species '${opts.species}' — have: ${Object.keys(FLORA_SPECIES).join(', ')}`);
    const placements = opts.placements;
    if (!Array.isArray(placements) || !placements.length) {
        throw new Error(`[mojave_flora] '${opts.species}' received no placements — the desert placement pass is defective`);
    }
    const seed = opts.seed ?? 7;
    const farCull = opts.farCull ?? 520;
    const woodRange = opts.woodRange ?? 0;
    const windDir = opts.windDir ?? [1, 0.3];
    const sunDir = opts.sunDir ?? [-0.5, 0.8, 0.3];

    const maps = await loadSpeciesMaps(spec.maps);
    let bladeFit = null;
    if (spec.archetype === 'blades') {
        bladeFit = await loadJson(spec.maps + '_fit.json');
    }
    let shrubAnchor = null;
    if (spec.archetype === 'shrub') {
        shrubAnchor = (await loadJson('shrub_anchors.json'))[spec.maps] ?? null;
        if (!shrubAnchor) {
            throw new Error(`[mojave_flora] shrub_anchors.json has no measured anchor for '${spec.maps}'`);
        }
    }

    // base geometry: one bunch / shrub / yucca (seeded, so fields differ by seed)
    const gRng = (() => { let s = (seed + 13) * 48271 % 2147483647;
        return () => { s = (s * 48271) % 2147483647; return s / 2147483647; }; })();
    let shrubGeos = null;
    if (spec.archetype === 'shrub') {
        shrubGeos = buildShrubGeometry(spec.gen, `${spec.gen}:${seed}:0`, shrubAnchor);
        console.log(`[mojave_flora] ${spec.gen} skeleton: ${shrubGeos.stats.stems} stems, ${shrubGeos.stats.terminals} terminals, ${shrubGeos.stats.woodVerts}+${shrubGeos.stats.leafVerts} verts`);
    }
    const leafGeo = shrubGeos ? shrubGeos.leaf
        : spec.archetype === 'yucca' ? yuccaGeometry(spec, gRng)
        : bunchGeometry(spec, gRng, bladeFit);
    const stemGeo = shrubGeos?.stem ?? null;

    // packed instance records (the CK42BB attribute layout)
    const count = placements.length;
    const posRotAll = new Float32Array(count * 4);
    const scaleVarAll = new Float32Array(count * 4);
    const phaseAll = new Float32Array(count * 3);
    const rootX = new Float32Array(count), rootY = new Float32Array(count), rootZ = new Float32Array(count);
    for (let i = 0; i < count; i++) {
        const p = placements[i];
        posRotAll.set([p.x, p.y, p.z, p.yaw], i * 4);
        scaleVarAll.set([p.scale, p.scale * (0.85 + p.colorVar * 0.3), 0, p.colorVar], i * 4);
        phaseAll.set([p.phase, p.tx ?? 0, p.tz ?? 0], i * 3);
        rootX[i] = p.x; rootY[i] = p.y; rootZ[i] = p.z;
    }
    const attachInstancing = (geo) => {
        const posRot = new T3.InstancedBufferAttribute(posRotAll.slice(), 4);
        const scaleVar = new T3.InstancedBufferAttribute(scaleVarAll.slice(), 4);
        const phase = new T3.InstancedBufferAttribute(phaseAll.slice(), 3);
        for (const attr of [posRot, scaleVar, phase]) attr.setUsage(T3.DynamicDrawUsage);
        geo.setAttribute('aPosRot', posRot);
        geo.setAttribute('aScaleVar', scaleVar);
        geo.setAttribute('aPhase', phase);
        return { posRot, scaleVar, phase };
    };
    const leafAttrs = attachInstancing(leafGeo);
    const stemAttrs = stemGeo ? attachInstancing(stemGeo) : null;

    // ── material (grasstest recipe: SSS foliage, instanced transform in TSL) ─
    const isBlades = spec.archetype === 'blades';
    const mat = new T3.MeshSSSNodeMaterial({
        side: T3.DoubleSide, metalness: 0, roughness: spec.rough,
        alphaTest: 0.35, transparent: false,
    });
    mat.envMapIntensity = 0.32;
    // (vertex colour is read in colorNode below — setting material.vertexColors
    // too would apply it twice and square the colour toward black)

    const uT = uniform(0);
    const uWindDir = uniform(new T3.Vector2(windDir[0], windDir[1]).normalize());
    const uBase = uniform(spec.wind.base * (opts.wind ?? 1));
    const uGust = uniform(spec.wind.gust * (opts.wind ?? 1));
    const uGustFreq = uniform(spec.wind.gustFreq);
    const uSunDir = uniform(new T3.Vector3(...sunDir).normalize());
    const pushArr = uniformArray([new T3.Vector4(0, 0, 0, 0), new T3.Vector4(0, 0, 0, 0),
        new T3.Vector4(0, 0, 0, 0), new T3.Vector4(0, 0, 0, 0)]);

    const aPR = attribute('aPosRot', 'vec4'), aSV = attribute('aScaleVar', 'vec4'),
        aPh = attribute('aPhase', 'vec3'), aHgt = attribute('aH', 'float');

    // full instance transform in the vertex stage (the CK42BB layout):
    // scale → yaw(Y) → world tilt → translate → wind → push
    mat.positionNode = Fn(() => {
        let p = positionLocal.mul(vec3(aSV.x, aSV.y, aSV.x)).toVar();
        const cR = cos(aPR.w), sR = sin(aPR.w);
        p = vec3(p.x.mul(cR).sub(p.z.mul(sR)), p.y, p.x.mul(sR).add(p.z.mul(cR))).toVar();
        // world tilt (aPhase.yz): random lean applied post-yaw about world X
        // then Z — plants follow the geometry they grow from
        const cX = cos(aPh.y), sX = sin(aPh.y);
        p = vec3(p.x, p.y.mul(cX).sub(p.z.mul(sX)), p.y.mul(sX).add(p.z.mul(cX))).toVar();
        const cZ = cos(aPh.z), sZ = sin(aPh.z);
        p = vec3(p.x.mul(cZ).sub(p.y.mul(sZ)), p.x.mul(sZ).add(p.y.mul(cZ)), p.z).toVar();
        const world = p.add(aPR.xyz).toVar();

        const hF = aHgt, h2 = hF.mul(hF);
        // layer 1 — global sway
        const gPhase = dot(world.xz, uWindDir).mul(0.5).add(uT.mul(1.2));
        const gSway = uWindDir.mul(sin(gPhase)).mul(uBase).toVar();
        // layer 2 — gust fronts rolled by a noise envelope
        const gustPhase = dot(world.xz, uWindDir).mul(uGustFreq).add(uT.mul(2.5));
        const env = smoothstep(0.3, 0.7,
            texNode(gustTex(), world.xz.mul(0.02).add(vec2(uT.mul(0.3 / 8)))).r);
        const gustSway = uWindDir.mul(sin(gustPhase)).mul(uGust).mul(env).toVar();
        // layer 3 — per-instance flutter
        const tPhase = uT.mul(3.0).add(aPh.x);
        const turb = vec2(sin(tPhase), cos(tPhase.mul(0.7))).mul(0.1 * spec.wind.flutter).toVar();

        const windXZ = gSway.add(gustSway).add(turb).mul(h2).toVar();

        // pushers — quadratic falloff ×h² (CK42BB layout), evaluated PER
        // INSTANCE from the plant's root so the whole plant leans coherently
        // away, with a species stiffness and a SOFT lean ceiling
        const pushK = spec.pushScale ?? 1.0;
        const push = vec2(0, 0).toVar();
        for (let i = 0; i < 4; i++) {
            const P = pushArr.element(i);
            const delta = aPR.xz.sub(P.xz);                 // root → pusher, stable per plant
            const dTrue = delta.length();
            // direction floor: delta/0.3 fades the response smoothly to zero
            // at the pusher centre instead of whipping 180° as the character
            // steps over a root — the field stays continuous through the
            // origin, so plants ease around a passing body
            const d = tmax(dTrue, 0.3);
            const live = step(0.001, P.w);                  // 0 when this pusher slot is off
            const s = float(1).sub(smoothstep(0.0, tmax(P.w, 0.001), dTrue)).toVar();
            push.addAssign(delta.div(d).mul(s.mul(s)).mul(1.35 * pushK).mul(live));
        }
        // soft saturation: tanh approaches the 0.6 lean ceiling asymptotically.
        // A hard min() would park every close plant AT the cap, so walking by
        // snapped them between capped and easing states
        const pLen = tmax(push.length(), 1e-4);
        const pushCapped = push.mul(float(0.6).mul(tanh(pLen.div(0.6))).div(pLen));
        // push yields the WHOLE plant (roots 30%, tips 100%) — pure h² left
        // low branches pinned through a character's legs mid-crossing
        const pushH = hF.mul(0.7).add(0.3);
        const disp = windXZ.add(pushCapped.mul(pushH));
        return world.add(vec3(disp.x, float(0), disp.y));
    })();

    // per-instance yaw-rotated normals — the geometry turns in positionNode,
    // so the authored (bent) normals must turn with it or every plant is lit
    // as if the sun sat somewhere else (and the SSS lobe points wrong)
    const rotNormal = Fn(() => {
        const cR = cos(aPR.w), sR = sin(aPR.w);
        return transformNormalToView(vec3(
            normalLocal.x.mul(cR).sub(normalLocal.z.mul(sR)),
            normalLocal.y,
            normalLocal.x.mul(sR).add(normalLocal.z.mul(cR))));
    })();
    // base = instance-rotated vertex normal (up for grass, bent for shrub
    // sprays — a LIGHT-GATHER direction); detail = the tangent map's deviation
    // from the interpolated surface normal. base + delta keeps the volume
    // shading AND the surface relief.
    const relief = T3.normalMap(texNode(maps.normal)).sub(T3.normalView);
    mat.normalNode = normalize(rotNormal.add(relief.mul(0.85)));

    // colour: sheet albedo × per-instance shade
    const shade = float(1.0).add(aSV.w.sub(0.5).mul(0.15));
    let albRGB = texNode(maps.albedo).rgb;
    if (spec.leafTint) albRGB = albRGB.mul(vec3(...spec.leafTint));
    // recolor mode: hue from the target, detail from the atlas luminance —
    // the atlas's own hue is fully discarded (multiply can't unmake green)
    if (spec.leafRecolor) albRGB = luminance(albRGB).mul(vec3(...spec.leafRecolor));
    mat.colorNode = albRGB.mul(shade);
    mat.opacityNode = texNode(maps.albedo).a;
    mat.roughnessNode = texNode(maps.rough).r.mul(spec.rough);

    // backlit translucency: light coming from behind glows through the sheet —
    // real per-light translucency (Barre-Brisebois via MeshSSSNodeMaterial),
    // SeedThree's tuned foliage values verbatim
    const sssAmt = (opts.sss ?? 1) * spec.sss;
    mat.thicknessColorNode = texNode(maps.transl).r.mul(float(sssAmt * 2.2));
    mat.thicknessDistortionNode = float(0.3);
    mat.thicknessAmbientNode = float(0.0);
    mat.thicknessAttenuationNode = float(1.0);
    mat.thicknessPowerNode = float(6.0);
    mat.thicknessScaleNode = float(3.0);
    mat.emissiveNode = albRGB.mul(0.08);     // faint fill so backfaces never go dead
    // thin cutout cards reject the N8AO cavity term like vegetation billboards;
    // structural card volumes accept it like real Joshua geometry
    stampSceneMrtOverride(mat, isBlades ? 0 : 0.8);

    // shrub wood: second instanced mesh, same placement, real bark maps riding
    // the tube network's wrapped UVs
    let stemMesh = null;
    let smat = null;
    let stemMaps = null;
    if (stemGeo) {
        stemMaps = await loadStemMaps(spec.stem);
        smat = new T3.MeshStandardNodeMaterial({
            metalness: 0, roughness: 0.9,
            color: spec.stemColor ?? 0x7a6a55,
        });
        smat.envMapIntensity = 0.34;
        const tint = spec.stemTint ?? [1, 1, 1];
        smat.colorNode = texNode(stemMaps.albedo).rgb.mul(vec3(...tint)).mul(shade);
        smat.roughnessNode = texNode(stemMaps.rough).r.mul(0.95);
        smat.positionNode = mat.positionNode;           // same instance transform + wind
        smat.normalNode = mat.normalNode;               // same rotated lighting
        stemMesh = new T3.InstancedMesh(stemGeo, smat, count);
        for (let i = 0; i < count; i++) stemMesh.setMatrixAt(i, _m4.identity());
        stemMesh.instanceMatrix.needsUpdate = true;
        stemMesh.frustumCulled = false;                 // camera-spanning field
        stemMesh.name = `mojave_${opts.species}_wood`;
        stemMesh.castShadow = true;                     // solid wood casts honestly
        stemMesh.receiveShadow = true;
    }

    const leafMesh = new T3.InstancedMesh(leafGeo, mat, count);
    for (let i = 0; i < count; i++) leafMesh.setMatrixAt(i, _m4.identity());
    leafMesh.instanceMatrix.needsUpdate = true;
    leafMesh.frustumCulled = false;                     // camera-spanning field
    leafMesh.name = `mojave_${opts.species}`;
    leafMesh.receiveShadow = true;
    leafMesh.castShadow = false;                 // alpha cards stamp rectangles in the shadow pass

    // ── distance-tiered instance compaction ─────────────────────────────────
    // The analogue of vegetation.js's signature-diffed instanceMatrix rewrite:
    // survivors are compacted to the FRONT of the instanced attribute buffers
    // and mesh.count trims the draw. A rolling FNV hash of the surviving ids
    // detects membership changes so unmoved frames upload nothing.
    const visible = { leaf: count, stem: stemMesh ? count : 0 };
    let leafSig = -1, stemSig = -1;
    const compactInto = (attrs, ids, n) => {
        const pr = attrs.posRot.array, sv = attrs.scaleVar.array, ph = attrs.phase.array;
        for (let k = 0; k < n; k++) {
            const i = ids[k];
            const s4 = i * 4, d4 = k * 4, s3 = i * 3, d3 = k * 3;
            pr[d4] = posRotAll[s4]; pr[d4 + 1] = posRotAll[s4 + 1];
            pr[d4 + 2] = posRotAll[s4 + 2]; pr[d4 + 3] = posRotAll[s4 + 3];
            sv[d4] = scaleVarAll[s4]; sv[d4 + 1] = scaleVarAll[s4 + 1];
            sv[d4 + 2] = scaleVarAll[s4 + 2]; sv[d4 + 3] = scaleVarAll[s4 + 3];
            ph[d3] = phaseAll[s3]; ph[d3 + 1] = phaseAll[s3 + 1]; ph[d3 + 2] = phaseAll[s3 + 2];
        }
        for (const attr of [attrs.posRot, attrs.scaleVar, attrs.phase]) {
            if (attr.clearUpdateRanges) {
                attr.clearUpdateRanges();
                attr.addUpdateRange(0, n * attr.itemSize);
            }
            attr.needsUpdate = true;
        }
    };
    const leafIds = new Int32Array(count);
    const stemIds = stemMesh ? new Int32Array(count) : null;
    const far2 = farCull * farCull;
    const wood2 = woodRange * woodRange;
    const updateVisibility = (camPos, force = false) => {
        let nLeaf = 0, nStem = 0;
        let hLeaf = 0x811c9dc5 >>> 0, hStem = 0x811c9dc5 >>> 0;
        const cx = camPos.x, cy = camPos.y, cz = camPos.z;
        for (let i = 0; i < count; i++) {
            const dx = cx - rootX[i], dy = cy - rootY[i], dz = cz - rootZ[i];
            const d2 = dx * dx + dy * dy + dz * dz;
            if (d2 >= far2) continue;
            leafIds[nLeaf++] = i;
            hLeaf = Math.imul(hLeaf ^ i, 0x01000193) >>> 0;
            if (stemIds && d2 < wood2) {
                stemIds[nStem++] = i;
                hStem = Math.imul(hStem ^ i, 0x01000193) >>> 0;
            }
        }
        const leafKey = (hLeaf ^ nLeaf) >>> 0;
        if (force || leafKey !== leafSig) {
            leafSig = leafKey;
            compactInto(leafAttrs, leafIds, nLeaf);
            leafMesh.count = nLeaf;
        }
        if (stemMesh) {
            const stemKey = (hStem ^ nStem) >>> 0;
            if (force || stemKey !== stemSig) {
                stemSig = stemKey;
                compactInto(stemAttrs, stemIds, nStem);
                stemMesh.count = nStem;
            }
        }
        visible.leaf = nLeaf;
        visible.stem = stemMesh ? nStem : 0;
        return visible;
    };

    const setTime = (t) => { uT.value = t || 0; };
    const setPushers = (list = []) => {
        for (let i = 0; i < 4; i++) {
            const p = list[i];
            pushArr.array[i].set(p ? p.x : 0, p ? (p.y ?? 0) : 0, p ? p.z : 0, p ? (p.r ?? 1.2) : 0);
        }
    };

    const meshes = stemMesh ? [leafMesh, stemMesh] : [leafMesh];
    const materials = smat ? [mat, smat] : [mat];
    const geometries = stemGeo ? [leafGeo, stemGeo] : [leafGeo];
    const textures = [maps.albedo, maps.normal, maps.rough, maps.transl];
    if (stemMaps) textures.push(stemMaps.albedo, stemMaps.rough);

    console.log(`[mojave_flora] ${opts.species}: ${count} instances × ${leafGeo.attributes.position.count} verts (${spec.archetype}${stemMesh ? '+stems' : ''}, farCull ${farCull} m${woodRange ? `, wood ${woodRange} m` : ''})`);
    return {
        species: opts.species,
        archetype: spec.archetype,
        count,
        farCull,
        woodRange,
        meshes,
        materials,
        geometries,
        textures,
        visible,
        setTime,
        setPushers,
        updateVisibility,
        uniforms: { time: uT, windDir: uWindDir, base: uBase, gust: uGust, sunDir: uSunDir },
    };
}
