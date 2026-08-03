#!/usr/bin/env node

// Reproducible, renderer-free builder for the fixed desert vegetation layout.
// Runtime code consumes the checked-in JSON and never scatters plants per load.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const MANIFEST_PATH = path.join(
    ROOT, 'assets', 'vegetation', 'desert_vegetation_layout_v1.json',
);
export const FORMAT = 'eanpa-desert-vegetation-layout/1';
export const SEED = 0x51f15e5d;
export const PAIR_MARGIN = 0.35;
export const SPECIES = Object.freeze({
    saguaro: Object.freeze({
        count: 760,
        minRadius: 62,
        maxRadius: 860,
        minScale: 0.72,
        maxScale: 1.34,
        slopeLimit: 0.30,
        // Conservative circle enclosing both the body and spine LOD0 AABBs.
        authoredFootprintRadius: 2.60,
        asset: 'assets/vegetation/saguaro_seed555.glb',
    }),
    joshua: Object.freeze({
        count: 430,
        minRadius: 72,
        maxRadius: 820,
        minScale: 0.68,
        maxScale: 1.30,
        slopeLimit: 0.26,
        // Conservative circle enclosing the full LOD0 branch/leaf AABBs.
        authoredFootprintRadius: 5.20,
        asset: 'assets/vegetation/joshuaTree_seed555.glb',
    }),
});

class AuditBufferAttribute {
    constructor(array, itemSize) {
        this.array = array;
        this.itemSize = itemSize;
        this.count = array.length / itemSize;
        this.needsUpdate = false;
    }
    getX(index) { return this.array[index * this.itemSize]; }
    getY(index) { return this.array[index * this.itemSize + 1]; }
    getZ(index) { return this.array[index * this.itemSize + 2]; }
    setY(index, value) { this.array[index * this.itemSize + 1] = value; }
    setXYZ(index, x, y, z) {
        this.array[index * this.itemSize] = x;
        this.array[index * this.itemSize + 1] = y;
        this.array[index * this.itemSize + 2] = z;
    }
}

class AuditBufferGeometry {
    constructor() {
        this.attributes = {};
        this.index = null;
    }
    setAttribute(name, attribute) { this.attributes[name] = attribute; return this; }
    getAttribute(name) { return this.attributes[name]; }
    setIndex(index) { this.index = index; return this; }
    computeVertexNormals() {
        const position = this.attributes.position;
        this.attributes.normal = new AuditBufferAttribute(
            new Float32Array(position.count * 3), 3,
        );
    }
    computeBoundingBox() {}
    computeBoundingSphere() {}
}

const FakeT3 = Object.freeze({
    BufferAttribute: AuditBufferAttribute,
    Float32BufferAttribute: class extends AuditBufferAttribute {
        constructor(array, itemSize) { super(Float32Array.from(array), itemSize); }
    },
    BufferGeometry: AuditBufferGeometry,
});

const round = (value, places = 6) => {
    const scale = 10 ** places;
    return Math.round(value * scale) / scale;
};

const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

export function loadTerrainSampler() {
    const terrainPath = path.join(ROOT, 'src', 'terrain_real.js');
    let source = fs.readFileSync(terrainPath, 'utf8');
    source = source.replace('export async function makeTerrain', 'async function makeTerrain');
    source += `
;globalThis.__vegetationLayoutTerrain = {
    HALF_NEAR, terrainHeightAt, craterFieldsAt, authoredCliffMaskAt,
    processionalMaskAt, makeHorizonGeometry, makeHorizonHeightSampler
};
`;
    const context = vm.createContext({ console });
    new vm.Script(source, { filename: terrainPath }).runInContext(context);
    const api = context.__vegetationLayoutTerrain;
    if (!api) throw new Error('Unable to expose terrain samplers');
    const horizonGeometry = api.makeHorizonGeometry(FakeT3);
    const horizonHeightAt = api.makeHorizonHeightSampler(horizonGeometry);
    const heightAt = (x, z) => (
        Math.max(Math.abs(x), Math.abs(z)) > api.HALF_NEAR
            ? horizonHeightAt(x, z)
            : api.terrainHeightAt(x, z)
    );
    const sampleAt = (x, z) => {
        const step = 0.8;
        const dx = (heightAt(x + step, z) - heightAt(x - step, z)) / (step * 2);
        const dz = (heightAt(x, z + step) - heightAt(x, z - step)) / (step * 2);
        return {
            slope: Math.atan(Math.hypot(dx, dz)),
            crater: api.craterFieldsAt(x, z).exclusion,
            cliff: api.authoredCliffMaskAt(x, z),
            route: api.processionalMaskAt(x, z),
        };
    };
    return { heightAt, sampleAt };
}

const makeRandom = () => {
    let state = SEED;
    return () => {
        state += 0x6d2b79f5;
        let value = state;
        value = Math.imul(value ^ (value >>> 15), value | 1);
        value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
        return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
    };
};

const placementRadius = (species, scale) => (
    SPECIES[species].authoredFootprintRadius * scale + PAIR_MARGIN
);

const pairKey = (a, b) => [a, b].sort().join('-');

export function measureSpacing(speciesPlacements) {
    const all = Object.entries(speciesPlacements).flatMap(([species, placements]) => (
        placements.map((placement, index) => ({ species, placement, index }))
    ));
    const minima = {
        'saguaro-saguaro': Infinity,
        'joshua-saguaro': Infinity,
        'joshua-joshua': Infinity,
    };
    let closest = null;
    for (let a = 0; a < all.length; a++) {
        const left = all[a];
        for (let b = a + 1; b < all.length; b++) {
            const right = all[b];
            const distance = Math.hypot(
                left.placement[0] - right.placement[0],
                left.placement[1] - right.placement[1],
            );
            const gap = distance
                - placementRadius(left.species, left.placement[2])
                - placementRadius(right.species, right.placement[2]);
            const key = pairKey(left.species, right.species);
            if (gap < minima[key]) minima[key] = gap;
            if (!closest || gap < closest.edgeClearance) {
                closest = {
                    speciesA: left.species,
                    indexA: left.index,
                    speciesB: right.species,
                    indexB: right.index,
                    centerDistance: distance,
                    edgeClearance: gap,
                };
            }
        }
    }
    return {
        minimumEdgeClearance: round(closest?.edgeClearance ?? Infinity),
        minimumByPair: Object.fromEntries(
            Object.entries(minima).map(([key, value]) => [key, round(value)]),
        ),
        closestPair: closest ? {
            ...closest,
            centerDistance: round(closest.centerDistance),
            edgeClearance: round(closest.edgeClearance),
        } : null,
    };
}

export function buildManifest() {
    const terrain = loadTerrainSampler();
    const random = makeRandom();
    const accepted = [];
    const speciesPlacements = { saguaro: [], joshua: [] };
    const generation = {};

    for (const [species, config] of Object.entries(SPECIES)) {
        const placements = speciesPlacements[species];
        let attempts = 0;
        let spacingRejected = 0;
        while (placements.length < config.count && attempts < config.count * 150) {
            attempts++;
            const angle = random() * Math.PI * 2;
            const radius = Math.sqrt(
                random() * (config.maxRadius ** 2 - config.minRadius ** 2)
                + config.minRadius ** 2,
            );
            const x = Math.cos(angle) * radius + Math.sin(angle * 2.7) * 18;
            const z = Math.sin(angle) * radius - 55 + Math.cos(angle * 1.9) * 22;
            const inCompound = Math.abs(x) < 69 && z > -124 && z < -18;
            const inApproach = Math.abs(x) < 19 && z >= 70 && z < 230;
            const inWash = Math.abs(x + 0.36 * z - 48) < 14;
            if (inCompound || inApproach || inWash) continue;

            const ecology = terrain.sampleAt(x, z);
            if (ecology.crater > 0.035) continue;
            if (ecology.cliff > 0.025) continue;
            if (ecology.route > 0.035) continue;
            if (ecology.slope > config.slopeLimit) continue;
            const cluster = Math.sin(x * 0.031 + Math.sin(z * 0.019) * 2.1)
                + Math.cos(z * 0.026 - x * 0.012);
            if (cluster < -0.62 && random() > 0.18) continue;

            const scale = config.minScale + random() * (config.maxScale - config.minScale);
            const yaw = random() * Math.PI * 2;
            const rank = random();
            const clearanceRadius = placementRadius(species, scale);
            const intersects = accepted.some((other) => (
                Math.hypot(x - other.x, z - other.z)
                    < clearanceRadius + other.clearanceRadius
            ));
            if (intersects) {
                spacingRejected++;
                continue;
            }

            const placement = [
                round(x), round(z), round(scale), round(yaw), round(rank),
            ];
            placements.push(placement);
            accepted.push({
                species,
                x: placement[0],
                z: placement[1],
                scale: placement[2],
                clearanceRadius: placementRadius(species, placement[2]),
            });
        }
        if (placements.length !== config.count) {
            throw new Error(
                `Only placed ${placements.length}/${config.count} ${species} after ${attempts} attempts`,
            );
        }
        generation[species] = { attempts, spacingRejected };
    }

    const assetMetadata = Object.fromEntries(
        Object.entries(SPECIES).map(([species, config]) => {
            const bytes = fs.readFileSync(path.join(ROOT, config.asset));
            return [species, {
                path: config.asset,
                bytes: bytes.length,
                sha256: sha256(bytes),
                role: 'authored-visible-glb-lod-source',
            }];
        }),
    );
    const spacing = measureSpacing(speciesPlacements);
    if (spacing.minimumEdgeClearance < -0.00001) {
        throw new Error(`Rounded placement data overlaps by ${spacing.minimumEdgeClearance}m`);
    }

    return {
        format: FORMAT,
        version: 1,
        seed: `0x${SEED.toString(16)}`,
        generatedBy: 'tools/build-vegetation-placement-manifest.mjs',
        sourceAssets: assetMetadata,
        policy: {
            layout: 'baked-once-no-runtime-randomness',
            clearance: {
                authoredFootprintRadius: Object.fromEntries(
                    Object.entries(SPECIES).map(([species, config]) => [
                        species, config.authoredFootprintRadius,
                    ]),
                ),
                perPlantMargin: PAIR_MARGIN,
                rule: 'centerDistance >= radiusA + radiusB',
            },
            ecologyExclusions: {
                compoundRectangle: { halfWidth: 69, minZ: -124, maxZ: -18 },
                approachRectangle: { halfWidth: 19, minZ: 70, maxZ: 230 },
                washLine: { xPlusZFactor: 0.36, offset: 48, halfWidth: 14 },
                craterMaximum: 0.035,
                cliffMaximum: 0.025,
                routeMaximum: 0.035,
            },
        },
        species: speciesPlacements,
        stats: {
            total: accepted.length,
            counts: Object.fromEntries(
                Object.entries(speciesPlacements).map(([species, values]) => [species, values.length]),
            ),
            generation,
            spacing,
        },
    };
}

// Keep each generated placement on one line. This stays reviewable and
// patch-friendly without the large five-lines-per-transform expansion of
// ordinary pretty JSON.
export const serializeManifest = (manifest) => {
    const printable = {
        ...manifest,
        species: { saguaro: '__SAGUARO_ROWS__', joshua: '__JOSHUA_ROWS__' },
    };
    let serialized = JSON.stringify(printable, null, 2);
    for (const species of Object.keys(SPECIES)) {
        const token = JSON.stringify(`__${species.toUpperCase()}_ROWS__`);
        const rows = manifest.species[species]
            .map((placement) => `      ${JSON.stringify(placement)}`)
            .join(',\n');
        serialized = serialized.replace(token, `[\n${rows}\n    ]`);
    }
    return `${serialized}\n`;
};

const isMain = process.argv[1]
    && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
    const serialized = serializeManifest(buildManifest());
    if (process.argv.includes('--check')) {
        if (!fs.existsSync(MANIFEST_PATH)) throw new Error(`Missing ${MANIFEST_PATH}`);
        const current = fs.readFileSync(MANIFEST_PATH, 'utf8');
        if (current !== serialized) throw new Error('Vegetation placement manifest is stale');
        const hash = sha256(Buffer.from(current));
        process.stdout.write(`vegetation layout current: ${hash}\n`);
    } else if (process.argv.includes('--write')) {
        fs.writeFileSync(MANIFEST_PATH, serialized);
        process.stdout.write(`wrote ${MANIFEST_PATH}\n`);
    } else {
        process.stdout.write(serialized);
    }
}
