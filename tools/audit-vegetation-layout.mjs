#!/usr/bin/env node

// CPU-only acceptance audit for the checked-in, non-overlapping vegetation
// placement manifest and its authored-GLB runtime integration.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
    FORMAT,
    MANIFEST_PATH,
    ROOT,
    SPECIES,
    buildManifest,
    measureSpacing,
    serializeManifest,
} from './build-vegetation-placement-manifest.mjs';

const failures = [];
let assertions = 0;
const check = (condition, label, details = '') => {
    assertions++;
    if (!condition) failures.push(`${label}${details ? `: ${details}` : ''}`);
};
const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const readText = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8');

const parseGlbJson = (relative) => {
    const bytes = fs.readFileSync(path.join(ROOT, relative));
    check(bytes.toString('ascii', 0, 4) === 'glTF', `${relative} is a GLB`);
    const jsonLength = bytes.readUInt32LE(12);
    return {
        bytes,
        json: JSON.parse(
            bytes.subarray(20, 20 + jsonLength).toString('utf8').replace(/[\0 ]+$/, ''),
        ),
    };
};

const lod0AabbCircle = (gltf) => {
    const rootIndex = (gltf.nodes ?? []).findIndex((node) => /_LOD0$/i.test(node.name ?? ''));
    if (rootIndex < 0) return Infinity;
    const pending = [rootIndex];
    const meshIndices = [];
    while (pending.length) {
        const node = gltf.nodes[pending.pop()];
        if (node.mesh !== undefined) meshIndices.push(node.mesh);
        pending.push(...(node.children ?? []));
    }
    let radius = 0;
    for (const meshIndex of meshIndices) {
        for (const primitive of gltf.meshes?.[meshIndex]?.primitives ?? []) {
            const accessor = gltf.accessors?.[primitive.attributes?.POSITION];
            if (!accessor?.min || !accessor?.max || accessor.min.length < 3) continue;
            const x = Math.max(Math.abs(accessor.min[0]), Math.abs(accessor.max[0]));
            const z = Math.max(Math.abs(accessor.min[2]), Math.abs(accessor.max[2]));
            radius = Math.max(radius, Math.hypot(x, z));
        }
    }
    return radius;
};

const currentBytes = fs.readFileSync(MANIFEST_PATH);
const currentText = currentBytes.toString('utf8');
const currentHash = sha256(currentBytes);
const manifest = JSON.parse(currentText);
const regenerated = buildManifest();
const regeneratedText = serializeManifest(regenerated);
const vegetation = readText('src/vegetation.js');
const main = readText('src/main.js');

check(manifest.format === FORMAT, 'manifest format is versioned and recognized');
check(manifest.version === 1, 'manifest version is one');
check(manifest.policy?.layout === 'baked-once-no-runtime-randomness',
    'manifest explicitly records one-time baked layout policy');
check(currentText === regeneratedText,
    'checked-in manifest is byte-identical to a fresh deterministic build');
check(manifest.stats?.total === 1190, 'manifest retains the complete 1,190-plant population');

for (const [species, config] of Object.entries(SPECIES)) {
    const placements = manifest.species?.[species];
    check(Array.isArray(placements), `${species} placements are present`);
    check(placements?.length === config.count,
        `${species} count is fixed at ${config.count}`, `${placements?.length}`);
    check(placements?.every((placement) => (
        Array.isArray(placement)
        && placement.length === 5
        && placement.every(Number.isFinite)
        && placement[2] >= config.minScale
        && placement[2] <= config.maxScale
    )), `${species} transforms are finite and within authored scale policy`);

    const asset = parseGlbJson(config.asset);
    const metadata = manifest.sourceAssets?.[species];
    check(metadata?.path === config.asset, `${species} manifest points at authored GLB`);
    check(metadata?.role === 'authored-visible-glb-lod-source',
        `${species} GLB is explicitly classified as the visible LOD source`);
    check(metadata?.bytes === asset.bytes.length, `${species} GLB byte length is pinned`);
    check(metadata?.sha256 === sha256(asset.bytes), `${species} GLB SHA-256 is pinned`);
    const aabbRadius = lod0AabbCircle(asset.json);
    check(config.authoredFootprintRadius >= aabbRadius,
        `${species} clearance circle encloses every authored LOD0 primitive AABB`,
        `${config.authoredFootprintRadius} < ${aabbRadius}`);
}

const spacing = measureSpacing(manifest.species);
check(spacing.minimumEdgeClearance >= 0,
    'all same- and cross-species authored visual footprint circles are disjoint',
    `${spacing.minimumEdgeClearance}m`);
check(Object.values(spacing.minimumByPair).every((gap) => gap >= 0),
    'saguaro/saguaro, Joshua/Joshua, and cross-species clearances all pass');
check(JSON.stringify(spacing) === JSON.stringify(manifest.stats.spacing),
    'reported spacing metrics exactly match recomputation');

check(
    /loadAsync\('\.\/assets\/vegetation\/saguaro_seed555\.glb'\)/.test(main)
        && /loadAsync\(joshuaUrl\)/.test(main)
        && /joshuaTree_seed555\.glb/.test(main),
    'main loads both authored SeedThree GLBs for visible vegetation',
);
check(
    /findLodRoots\(gltf\.scene\)/.test(vegetation)
        && /source\.geometry\.clone\(\)/.test(vegetation)
        && /new T3\.InstancedMesh\(/.test(vegetation),
    'runtime batches authored GLB LOD geometry into GPU instances',
);
check(
    /desert_vegetation_layout_v1\.json/.test(vegetation)
        && /placementLayout\.species\.saguaro/.test(vegetation)
        && /placementLayout\.species\.joshua/.test(vegetation),
    'runtime consumes the checked-in placement manifest for both species',
);
const runtimeRevision = /desert_vegetation_layout_v1\.json\?v=([a-f0-9]+)/
    .exec(vegetation)?.[1];
check(runtimeRevision === currentHash.slice(0, runtimeRevision?.length ?? 0),
    'runtime URL revision matches the checked-in manifest content hash');
check(
    !/scatterState|const scatter\s*=|scatter\(760|scatter\(430/.test(vegetation),
    'runtime contains no per-load vegetation scatter generator',
);
check(
    /collisionStreamer\.registerSpecies\(item\.name, item\.placements\)/.test(vegetation),
    'close-range collision streamer receives the exact rendered placement objects',
);
check(
    /placementManifest:\s*group\.userData\.placementManifest/.test(vegetation),
    'runtime diagnostics expose the active fixed-layout identity and spacing policy',
);

const report = {
    suite: 'vegetation-layout',
    assertions,
    failures,
    manifest: {
        path: path.relative(ROOT, MANIFEST_PATH).replaceAll('\\', '/'),
        bytes: currentBytes.length,
        sha256: currentHash,
        counts: manifest.stats.counts,
        spacing,
        generation: manifest.stats.generation,
    },
};
console.log(JSON.stringify(report, null, 2));
if (failures.length) process.exitCode = 1;
