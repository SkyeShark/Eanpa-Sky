// Dense, grounded desert scrub dressing. Geological dressing is owned
// exclusively by terrain_real.js, which instances the user's authored
// 12-piece GLB library. This module owns the living ground flora: the Mojave
// shrubbery system ported from the Eidoverse grasstest workbench
// (src/mojave_flora.js — procedural welded-tube shrubs with baked spray
// cards, bunch grass, yucca; CK42BB-derived wind and pushers), replacing the
// former flat crossed-card scrub while keeping this module's placement
// policy: deterministic seeded generation, authored-scene exclusion zones,
// slope rejection, and 9-tap footprint seating over terrain_real heights.

import {
    createFloraField,
    FLORA_SPECIES,
    occupancyConflict,
    claimPlantFootprint,
    resetFloraOccupancy,
    disposeSharedFloraResources,
    valueNoise2D,
} from './mojave_flora.js';

class Rng {
    constructor(seed = 1) {
        const text = String(seed);
        let state = 2166136261;
        for (let index = 0; index < text.length; index++) {
            state ^= text.charCodeAt(index);
            state = Math.imul(state, 16777619);
        }
        this.state = state >>> 0 || 1;
    }

    next() {
        let value = this.state;
        value ^= value << 13;
        value ^= value >>> 17;
        value ^= value << 5;
        this.state = value >>> 0;
        return this.state / 4294967296;
    }

    range(min, max) { return min + (max - min) * this.next(); }
    vary(center, radius) { return center + (this.next() * 2 - 1) * radius; }
}

function makeTerrainReader(terrain) {
    const fallback = { height: 0, slope: 0, grade: 0, rockiness: 0, compound: 0, route: 0, wash: 0, crater: 0 };
    return (x, z, out = {}) => {
        if (terrain?.ecologyAt) return terrain.ecologyAt(x, z, out);
        if (terrain?.sampleTerrain) terrain.sampleTerrain(x, z, out);
        else {
            out.height = terrain?.heightAt?.(x, z) ?? 0;
            out.slope = terrain?.slopeAt?.(x, z) ?? 0;
            out.grade = Math.tan(out.slope);
        }
        out.rockiness ??= fallback.rockiness;
        out.compound ??= fallback.compound;
        out.route ??= fallback.route;
        out.wash ??= fallback.wash;
        out.crater ??= fallback.crater;
        return out;
    };
}

export async function makeDesertDressing(T3, { terrain, quality = 'balanced' } = {}) {
    const group = new T3.Group();
    group.name = 'eanpa_real_desert_dressing';
    const ownedGeometries = new Set();
    const ownedMaterials = new Set();
    const ownedTextures = new Set();
    const ownedInstances = new Set();
    const sampleTerrain = makeTerrainReader(terrain);
    const sample = {};

    const clearOfAuthoredScene = (x, z, terrainSample, padding = 0) => {
        if (terrainSample.compound > 0.025 || terrainSample.route > 0.035) return false;
        if (terrainSample.crater > 0.035) return false;
        if ((terrainSample.cliff ?? 0) > 0.025) return false;
        if (Math.hypot(x - 20, z - 14) < 9 + padding) return false;
        if (Math.hypot(x, z - 64) < 12 + padding) return false;
        return true;
    };

    const seatHeight = (x, z, footprint) => Math.min(
        terrain?.heightAt?.(x, z) ?? 0,
        terrain?.heightAt?.(x + footprint, z) ?? 0,
        terrain?.heightAt?.(x - footprint, z) ?? 0,
        terrain?.heightAt?.(x, z + footprint) ?? 0,
        terrain?.heightAt?.(x, z - footprint) ?? 0,
        terrain?.heightAt?.(x + footprint * 0.72, z + footprint * 0.72) ?? 0,
        terrain?.heightAt?.(x - footprint * 0.72, z + footprint * 0.72) ?? 0,
        terrain?.heightAt?.(x + footprint * 0.72, z - footprint * 0.72) ?? 0,
        terrain?.heightAt?.(x - footprint * 0.72, z - footprint * 0.72) ?? 0,
    );

    // ── deterministic placement (Eanpa policy, no runtime PRNG drift) ────────
    // One seeded stream consumed in a fixed species order makes every reload
    // byte-identical. Structural species place first so their occupancy claims
    // (mojave_flora's cross-field registry) shape the later, denser fields.
    resetFloraOccupancy();
    const scrubRng = new Rng('eanpa-mojave-scrub-4319');
    const clumpNoise = valueNoise2D(4319);
    const scrubTarget = 9200;
    // Draw policy per species: every field honors the 11..520 m authored scrub
    // disc; shrubs keep tube wood inside a near full-detail ring and carry the
    // silhouette on their baked spray cards alone out to the 520 m far cull.
    // Bunch grass culls at 260 m — a 0.44 m tussock is subpixel long before
    // that, and the far scrub read is owned by the shrub/yucca fields.
    const floraDefinitions = [
        { species: 'yucca',       target: 40,   seed: 4501, farCull: 520, woodRange: 0,   nominalHeight: 1.10, padding: 2.0 },
        { species: 'creosote',    target: 140,  seed: 4502, farCull: 520, woodRange: 150, nominalHeight: 1.35, padding: 1.5 },
        { species: 'sagebrush',   target: 240,  seed: 4503, farCull: 520, woodRange: 150, nominalHeight: 0.90, padding: 1.5 },
        { species: 'blackbrush',  target: 320,  seed: 4504, farCull: 520, woodRange: 150, nominalHeight: 0.70, padding: 1.5 },
        { species: 'galleta_dry', target: 8460, seed: 4505, farCull: 260, woodRange: 0,   nominalHeight: 0.50, padding: 1.5 },
    ];
    const definitionTotal = floraDefinitions.reduce((sum, definition) => sum + definition.target, 0);
    if (definitionTotal !== scrubTarget) {
        throw new Error(`[desert_dressing] species targets sum to ${definitionTotal}, not the authored ${scrubTarget}`);
    }

    const placeSpecies = (definition) => {
        const spec = FLORA_SPECIES[definition.species];
        const structural = Number.isFinite(spec.footRadius);
        const placements = [];
        for (let guard = definition.target * 9; guard > 0 && placements.length < definition.target; guard--) {
            const angle = scrubRng.range(0, Math.PI * 2);
            const radius = 11 + (520 - 11) * Math.sqrt(scrubRng.next());
            const x = Math.cos(angle) * radius;
            const z = Math.sin(angle) * radius;
            sampleTerrain(x, z, sample);
            if (!clearOfAuthoredScene(x, z, sample, definition.padding) || sample.slope > 0.42) continue;
            const openness = 1 - sample.rockiness * 0.78;
            const washBoost = definition.species === 'creosote' ? sample.wash * 0.22 : 0;
            if (scrubRng.next() > 0.42 * openness + washBoost) continue;
            // bare patches + clumping via low-frequency noise (CK42BB gate):
            // bunch grass gathers into stands, shrubs scatter widely
            const clumpField = clumpNoise(x * 0.05, z * 0.05);
            if (clumpField < 0.5 - spec.clump && scrubRng.next() < 0.85) continue;
            const scale = spec.baseScale[0] + scrubRng.next() * (spec.baseScale[1] - spec.baseScale[0]);
            if (structural) {
                const foot = spec.footRadius * scale;
                if (occupancyConflict(x, z, foot)) continue;
                claimPlantFootprint(x, z, foot);
            }
            // Seat the full footprint on nine terrain samples and bury the
            // transparent art margin slightly, preventing outer sprigs from
            // hovering on slopes (the proven flat-scrub seating law).
            const height = definition.nominalHeight * scale;
            const shrubSeat = seatHeight(x, z, Math.max(0.24, (spec.footRadius ?? 0.3) * scale));
            const leanAzimuth = scrubRng.range(0, Math.PI * 2);
            const lean = scrubRng.vary(0, 0.08);
            placements.push({
                x,
                y: shrubSeat - Math.min(0.15, height * 0.13),
                z,
                yaw: scrubRng.range(0, Math.PI * 2),
                scale,
                colorVar: scrubRng.next(),
                phase: scrubRng.range(0, Math.PI * 2),
                tx: Math.cos(leanAzimuth) * lean,
                tz: Math.sin(leanAzimuth) * lean,
            });
        }
        return placements;
    };

    const fields = [];
    for (const definition of floraDefinitions) {
        const placements = placeSpecies(definition);
        const field = await createFloraField({
            species: definition.species,
            seed: definition.seed,
            placements,
            farCull: definition.farCull,
            woodRange: definition.woodRange,
            windDir: [1, 0.3],
        });
        for (const mesh of field.meshes) {
            // Foliage cards carry intentionally upward/bent normals. They can
            // receive wet sheen, but ground puddles must never replace their
            // alpha-tested atlas color.
            mesh.userData.noPuddles = true;
            group.add(mesh);
            ownedInstances.add(mesh);
        }
        for (const material of field.materials) {
            material.userData.noPuddles = true;
            ownedMaterials.add(material);
        }
        for (const geometry of field.geometries) ownedGeometries.add(geometry);
        for (const texture of field.textures) ownedTextures.add(texture);
        fields.push({ definition, field });
    }

    // ── per-frame drive: wind clock, player pusher, throttled LOD rewrite ────
    const pusher = { x: 0, y: 0, z: 0, r: 1.35 };
    let lastLodUpdate = -Infinity;
    let lodDirty = true;
    let disposed = false;
    const refreshStats = () => {
        if (!globalThis._desertDressingStats) return;
        globalThis._desertDressingStats.visible = Object.fromEntries(
            fields.map(({ definition, field }) => [definition.species, { ...field.visible }]),
        );
    };
    const update = (camera = globalThis._c, t = 0, force = false) => {
        if (disposed) return;
        for (const { field } of fields) field.setTime(t);
        if (!camera?.position) return;
        pusher.x = camera.position.x;
        pusher.y = camera.position.y;
        pusher.z = camera.position.z;
        for (const { field } of fields) field.setPushers([pusher]);
        // Same cadence as vegetation.js's signature-diffed instance rewrite.
        if (!force && !lodDirty && t - lastLodUpdate < 0.28) return;
        lastLodUpdate = t;
        for (const { field } of fields) field.updateVisibility(camera.position, force || lodDirty);
        lodDirty = false;
        refreshStats();
    };

    let currentQuality = 'authored';
    const setQuality = (nextQuality = 'balanced') => {
        // The public quality selector budgets only sky/weather/skyboxes.
        // Always retain the complete authored, GPU-instanced desert flora.
        group.userData.requestedSkyQuality = nextQuality;
        group.userData.quality = 'authored';
    };
    setQuality(quality);

    const stats = {
        scrub: Object.fromEntries(fields.map(({ definition, field }) => [definition.species, field.count])),
        scrubTarget,
        floraLibrary: 'mojave_flora (grasstest grass2/shrub_gen port)',
        drawPolicy: Object.fromEntries(fields.map(({ definition }) => [definition.species, {
            farCull: definition.farCull,
            woodRange: definition.woodRange,
        }])),
        geologicalDressingOwner: 'terrain_real:user-authored-12-piece-glb',
        proceduralRockInstances: 0,
    };
    group.userData.stats = stats;
    globalThis._desertDressingStats = { quality: currentQuality, ...stats };

    // Seed the first visibility pass before anything renders so the boot
    // compile sees final instance counts instead of the full-capacity fields.
    update(globalThis._c, 0, true);

    const dispose = () => {
        if (disposed) return;
        disposed = true;
        group.removeFromParent();
        group.clear();
        for (const mesh of ownedInstances) mesh.dispose?.();
        for (const geometry of ownedGeometries) geometry.dispose();
        for (const material of ownedMaterials) material.dispose();
        for (const texture of ownedTextures) texture.dispose();
        ownedInstances.clear();
        ownedGeometries.clear();
        ownedMaterials.clear();
        ownedTextures.clear();
        // shared gust texture + the module-global occupancy registry
        disposeSharedFloraResources();
        globalThis._desertDressingStats = null;
    };

    return {
        group,
        update,
        setQuality(nextQuality) {
            setQuality(nextQuality);
            if (globalThis._desertDressingStats) globalThis._desertDressingStats.quality = nextQuality;
        },
        dispose,
    };
}
