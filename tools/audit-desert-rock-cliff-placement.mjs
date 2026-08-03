#!/usr/bin/env node

// CPU-only audit for the evidence-based 12-rock roles, deterministic ground and
// embedded placement budgets, and whole-footprint seating of the authored cliffs.

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TERRAIN_PATH = path.join(ROOT, 'src', 'terrain_real.js');
const ROCK_PATH = path.join(
    ROOT,
    'assets',
    'terrain',
    'Desert_rock_chunks_12_pieces_runtime_2k_lods.glb',
);
const failures = [];
let assertions = 0;

function check(condition, message, details = '') {
    assertions++;
    if (!condition) failures.push(message + (details ? ': ' + details : ''));
}

function normalize(value) {
    return JSON.parse(JSON.stringify(value));
}

function same(actual, expected, message) {
    const a = JSON.stringify(normalize(actual));
    const b = JSON.stringify(expected);
    check(a === b, message, `${a} != ${b}`);
}

function parseGlb(filename) {
    const bytes = fs.readFileSync(filename);
    check(bytes.toString('ascii', 0, 4) === 'glTF', 'GLB has valid magic', filename);
    check(bytes.readUInt32LE(4) === 2, 'GLB uses glTF 2.0', filename);
    check(bytes.readUInt32LE(8) === bytes.length, 'GLB declares exact byte length', filename);
    let offset = 12;
    let json = null;
    let binary = null;
    while (offset < bytes.length) {
        const length = bytes.readUInt32LE(offset); offset += 4;
        const type = bytes.readUInt32LE(offset); offset += 4;
        const payload = bytes.subarray(offset, offset + length); offset += length;
        if (type === 0x4e4f534a) {
            json = JSON.parse(payload.toString('utf8').replace(/\0+$/g, '').trim());
        } else if (type === 0x004e4942) {
            binary = payload;
        }
    }
    check(Boolean(json && binary), 'GLB contains JSON and BIN chunks', filename);
    return { json, binary };
}

const COMPONENTS = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };
const COMPONENT_BYTES = { 5121: 1, 5123: 2, 5125: 4, 5126: 4 };

function accessorReader(gltf, binary, accessorIndex) {
    const accessor = gltf.accessors[accessorIndex];
    const view = gltf.bufferViews[accessor.bufferView];
    const components = COMPONENTS[accessor.type];
    const componentBytes = COMPONENT_BYTES[accessor.componentType];
    const stride = view.byteStride ?? components * componentBytes;
    const start = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
    const read = accessor.componentType === 5126
        ? (offset) => binary.readFloatLE(offset)
        : accessor.componentType === 5125
            ? (offset) => binary.readUInt32LE(offset)
            : accessor.componentType === 5123
                ? (offset) => binary.readUInt16LE(offset)
                : (offset) => binary.readUInt8(offset);
    return {
        accessor,
        get(index, component = 0) {
            return read(start + index * stride + component * componentBytes);
        },
    };
}

function meshPositionReader(parsed, node) {
    const primitive = parsed.json.meshes[node.mesh].primitives[0];
    return accessorReader(parsed.json, parsed.binary, primitive.attributes.POSITION);
}

function actualBounds(position) {
    const minimum = [Infinity, Infinity, Infinity];
    const maximum = [-Infinity, -Infinity, -Infinity];
    for (let index = 0; index < position.accessor.count; index++) {
        for (let axis = 0; axis < 3; axis++) {
            const value = position.get(index, axis);
            minimum[axis] = Math.min(minimum[axis], value);
            maximum[axis] = Math.max(maximum[axis], value);
        }
    }
    return { minimum, maximum };
}

const terrainSource = fs.readFileSync(TERRAIN_PATH, 'utf8');
const placementStart = terrainSource.indexOf('const NEAR_SIZE');
const placementEnd = terrainSource.indexOf('function macroAt');
check(placementStart >= 0 && placementEnd > placementStart,
    'Placement-only terrain source slice is available');

const horizonAuditSource = `
function makeAuditRenderedHeightSampler() {
    const edgeSegments = NEAR_SEGMENTS;
    const row = edgeSegments + 1;
    const verticesPerSide = (HORIZON_RADIAL_SEGMENTS + 1) * row;
    const positions = new Float32Array(verticesPerSide * 4 * 3);
    const halfSteps = Array.from({ length: HORIZON_RADIAL_SEGMENTS + 1 }, (_, ring) => (
        HALF_NEAR + (HORIZON_HALF - HALF_NEAR)
            * Math.pow(ring / HORIZON_RADIAL_SEGMENTS, 1.46)
    ));
    let cursor = 0;
    for (let side = 0; side < 4; side++) {
        for (let ring = 0; ring <= HORIZON_RADIAL_SEGMENTS; ring++) {
            const half = halfSteps[ring];
            for (let edge = 0; edge <= edgeSegments; edge++) {
                const u = edge / edgeSegments * 2 - 1;
                let x;
                let z;
                if (side === 0) { x = u * half; z = half; }
                else if (side === 1) { x = half; z = -u * half; }
                else if (side === 2) { x = -u * half; z = -half; }
                else { x = -half; z = u * half; }
                positions[cursor * 3] = x;
                positions[cursor * 3 + 1] = terrainHeightAt(x, z);
                positions[cursor * 3 + 2] = z;
                cursor++;
            }
        }
    }
    const value = (index, axis) => positions[index * 3 + axis];
    const triangle = (x, z, a, b, c) => {
        const ax = value(a, 0), az = value(a, 2);
        const bx = value(b, 0), bz = value(b, 2);
        const cx = value(c, 0), cz = value(c, 2);
        const denominator = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
        const wa = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / denominator;
        const wb = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / denominator;
        const wc = 1 - wa - wb;
        return {
            inside: wa >= -1e-7 && wb >= -1e-7 && wc >= -1e-7,
            minimumWeight: Math.min(wa, wb, wc),
            height: value(a, 1) * wa + value(b, 1) * wb + value(c, 1) * wc,
        };
    };
    return (x, z) => {
        const absX = Math.abs(x), absZ = Math.abs(z);
        const half = Math.max(absX, absZ);
        if (half <= HALF_NEAR || half > HORIZON_HALF) return terrainHeightAt(x, z);
        let side;
        let u;
        if (z >= absX) { side = 0; u = x / z; }
        else if (x >= absZ) { side = 1; u = -z / x; }
        else if (-z >= absX) { side = 2; u = -x / -z; }
        else { side = 3; u = z / -x; }
        u = Math.max(-1, Math.min(1, u));
        let ring = 0;
        while (ring < HORIZON_RADIAL_SEGMENTS - 1 && half > halfSteps[ring + 1]) ring++;
        const edge = Math.max(0, Math.min(
            edgeSegments - 1,
            Math.floor((u + 1) * 0.5 * edgeSegments),
        ));
        const base = side * verticesPerSide + ring * row + edge;
        const a = base;
        const b = base + 1;
        const c = base + row;
        const d = c + 1;
        const first = triangle(x, z, a, b, c);
        if (first.inside) return first.height;
        const second = triangle(x, z, b, d, c);
        return second.inside || second.minimumWeight >= first.minimumWeight
            ? second.height
            : first.height;
    };
}
const auditRenderedHeightAt = makeAuditRenderedHeightSampler();
globalThis.auditApi = {
    DESERT_CLIFF_ASSETS,
    DESERT_CLIFF_PLACEMENTS,
    DESERT_CLIFF_BASE_SUPPORT_BAND_FRACTION,
    DESERT_CLIFF_BASE_EMBED_METRES,
    DESERT_ROCK_PIECE_COUNT,
    DESERT_ROCK_INSTANCE_TARGET,
    DESERT_ROCK_GROUND_INSTANCE_TARGET,
    DESERT_ROCK_CLIFF_CLUSTER_TARGET,
    DESERT_ROCK_CLIFF_CLUSTER_COUNT,
    DESERT_ROCK_CLIFF_CLUSTER_MEMBERS,
    DESERT_ROCK_MAXIMUM_DRAWS,
    DESERT_ROCK_PIECE_GROUPS,
    DESERT_ROCK_PIECE_CLASS,
    DESERT_ROCK_DIAMETER_RANGES,
    DESERT_ROCK_VISUAL_INDEX,
    DESERT_ROCK_GROUND_MAX_GRADE,
    DESERT_ROCK_CLIFF_CLUSTER_MIN_GRADE,
    DESERT_ROCK_CLIFF_SHOULDER_MASK_RANGE,
    DESERT_ROCK_CLIFF_CLUSTER_RADIUS_METRES,
    DESERT_ROCK_CLIFF_CLUSTER_BURY_FRACTION_RANGE,
    authoredCliffPlacementMaskAt,
    buildDesertCliffClusterPlacements,
    buildDesertRockPlacements,
    auditRenderedHeightAt,
};
`;

const context = {};
vm.createContext(context);
vm.runInContext(
    terrainSource.slice(placementStart, placementEnd) + horizonAuditSource,
    context,
    { timeout: 120000 },
);
const api = context.auditApi;

const expectedGroups = {
    largeFlatWide: [2, 4, 8, 9],
    mediumIrregular: [0, 5, 6, 7],
    smallSmoothRound: [1, 10],
    cliffFaceTallNarrow: [3, 11],
};
const expectedClasses = [
    'mediumIrregular', 'smallSmoothRound', 'largeFlatWide',
    'cliffFaceTallNarrow', 'largeFlatWide', 'mediumIrregular',
    'mediumIrregular', 'mediumIrregular', 'largeFlatWide', 'largeFlatWide',
    'smallSmoothRound', 'cliffFaceTallNarrow',
];
const expectedRanges = {
    largeFlatWide: [2.0, 5.8],
    mediumIrregular: [0.95, 2.75],
    smallSmoothRound: [0.30, 0.80],
    cliffFaceTallNarrow: [6.0, 14.0],
};
same(api.DESERT_ROCK_PIECE_GROUPS, expectedGroups,
    'Rock role map matches the inspected contact sheet exactly');
same(api.DESERT_ROCK_PIECE_CLASS, expectedClasses,
    'Per-piece role lookup matches the inspected contact sheet exactly');
same(api.DESERT_ROCK_DIAMETER_RANGES, expectedRanges,
    'Ground footprint and cliff-cluster long-axis ranges are exact');
same(api.DESERT_ROCK_VISUAL_INDEX.map((item) => item.role), expectedClasses,
    'Runtime visual-index metadata preserves every inspected piece role');
check(api.DESERT_ROCK_MAXIMUM_DRAWS === 36,
    'Twelve pieces across three LOD buckets retain a 36-draw maximum');
check(api.DESERT_ROCK_CLIFF_CLUSTER_TARGET
    === api.DESERT_ROCK_CLIFF_CLUSTER_COUNT * api.DESERT_ROCK_CLIFF_CLUSTER_MEMBERS,
'Configured cliff-cluster target is internally consistent');

const rock = parseGlb(ROCK_PATH);
const rockMetrics = [];
for (let piece = 0; piece < api.DESERT_ROCK_PIECE_COUNT; piece++) {
    const nodeName = `DesertRockPiece${piece.toString().padStart(2, '0')}_LOD0`;
    const node = rock.json.nodes.find((item) => item.name === nodeName);
    check(Boolean(node), 'Rock runtime contains measured LOD0 piece', nodeName);
    const bounds = actualBounds(meshPositionReader(rock, node));
    const dimensions = bounds.maximum.map((value, axis) => value - bounds.minimum[axis]);
    const horizontalWidth = Math.max(dimensions[0], dimensions[2]);
    const planAspect = horizontalWidth / Math.min(dimensions[0], dimensions[2]);
    const heightOverWidth = dimensions[1] / horizontalWidth;
    const isotropy = Math.min(...dimensions) / Math.max(...dimensions);
    rockMetrics.push({ piece, dimensions, planAspect, heightOverWidth, isotropy });
}

check(rockMetrics.every((item) => item.dimensions.every((value) => value > 0)),
    'Every visually indexed LOD0 piece has finite positive dimensions');
check(expectedRanges.largeFlatWide[1] > expectedRanges.mediumIrregular[1]
    && expectedRanges.mediumIrregular[1] > expectedRanges.smallSmoothRound[1],
'Flat/wide pieces have the largest ground scale ceiling and smooth rounds the smallest');
check(expectedGroups.cliffFaceTallNarrow.every(
    (piece) => !expectedGroups.largeFlatWide.includes(piece)
        && !expectedGroups.mediumIrregular.includes(piece)
        && !expectedGroups.smallSmoothRound.includes(piece),
), 'Both tall/narrow pieces are excluded from every ground-scatter role');

const analyticA = api.buildDesertRockPlacements();
const analyticB = api.buildDesertRockPlacements();
check(JSON.stringify(normalize(analyticA)) === JSON.stringify(normalize(analyticB)),
    'Rock placement build is bit-for-bit deterministic');
const renderedPlacements = api.buildDesertRockPlacements(api.auditRenderedHeightAt);
const flatCliffPlacements = api.buildDesertCliffClusterPlacements(() => 0);
check(Array.isArray(flatCliffPlacements) && flatCliffPlacements.length === 0,
    'A height sampler with no qualifying slopes yields no cliff dressing without throwing');

function auditPlacementSet(placements, label) {
    const ground = placements.filter((item) => item.placementKind === 'ground');
    const cliff = placements.filter((item) => item.placementKind === 'cliffFaceCluster');
    check(placements.length === ground.length + cliff.length,
        `${label} placement set contains only ground and cliff-cluster roles`);
    check(placements.length <= api.DESERT_ROCK_INSTANCE_TARGET,
        `${label} placement total stays within the configured maximum`, placements.length);
    check(ground.length === api.DESERT_ROCK_GROUND_INSTANCE_TARGET,
        `${label} ground budget is exact`, ground.length);
    check(cliff.length <= api.DESERT_ROCK_CLIFF_CLUSTER_TARGET,
        `${label} cliff dressing stays within its non-blocking target`, cliff.length);
    check(ground.every((item) => !expectedGroups.cliffFaceTallNarrow.includes(item.piece)
        && item.pieceClass === expectedClasses[item.piece]),
    `${label} general scatter excludes both tall/narrow pieces and preserves role purity`);
    check(cliff.every((item) => (
        expectedGroups.cliffFaceTallNarrow.includes(item.piece)
        && item.pieceClass === 'cliffFaceTallNarrow'
        && item.embedding === 'authoredCliffShoulderCluster'
    )), `${label} cliff clusters use only the two visually indexed tall/narrow pieces`);
    check(ground.every((item) => {
        const range = expectedRanges[item.pieceClass];
        return item.desiredDiameter >= range[0] && item.desiredDiameter <= range[1];
    }), `${label} every ground footprint stays inside its role range`);
    check(cliff.every((item) => (
        item.desiredLongAxis >= expectedRanges.cliffFaceTallNarrow[0]
        && item.desiredLongAxis <= expectedRanges.cliffFaceTallNarrow[1]
        && item.buryFraction >= api.DESERT_ROCK_CLIFF_CLUSTER_BURY_FRACTION_RANGE[0]
        && item.buryFraction <= api.DESERT_ROCK_CLIFF_CLUSTER_BURY_FRACTION_RANGE[1]
    )), `${label} cliff long axes and transverse burial fractions stay bounded`);
    check(ground.every((item) => item.grade <= api.DESERT_ROCK_GROUND_MAX_GRADE + 1e-12),
        `${label} general ground scatter stays off steep slopes`);
    check(cliff.every((item) => (
        item.grade >= api.DESERT_ROCK_CLIFF_CLUSTER_MIN_GRADE
        && item.cliffPlacementMask >= api.DESERT_ROCK_CLIFF_SHOULDER_MASK_RANGE[0]
        && item.cliffPlacementMask <= api.DESERT_ROCK_CLIFF_SHOULDER_MASK_RANGE[1]
    )), `${label} cliff detail stays on its own bounded shoulder with grade >= 0.35`);
    const cliffsByName = new Map(api.DESERT_CLIFF_PLACEMENTS.map((item) => [item.name, item]));
    check(cliff.every((item) => {
        const placement = cliffsByName.get(item.cliffPlacement);
        const placementMask = placement
            ? api.authoredCliffPlacementMaskAt(placement, item.x, item.z)
            : -1;
        return placement
            && Math.abs(placementMask - item.cliffPlacementMask) < 1e-12
            && placementMask >= api.DESERT_ROCK_CLIFF_SHOULDER_MASK_RANGE[0]
            && placementMask <= api.DESERT_ROCK_CLIFF_SHOULDER_MASK_RANGE[1];
    }), `${label} every cliff rock belongs to its recorded cliff-specific shoulder`);
    const clusterSizes = [];
    for (let clusterId = 0; clusterId < api.DESERT_ROCK_CLIFF_CLUSTER_COUNT; clusterId++) {
        const members = cliff.filter((item) => item.clusterId === clusterId);
        clusterSizes.push(members.length);
        check(members.length <= api.DESERT_ROCK_CLIFF_CLUSTER_MEMBERS,
            `${label} cluster ${clusterId} never exceeds its target`, members.length);
        check(members.every((item) => item.clusterSize === members.length
            && item.clusterTargetSize === api.DESERT_ROCK_CLIFF_CLUSTER_MEMBERS
            && item.clusterComplete
                === (members.length === api.DESERT_ROCK_CLIFF_CLUSTER_MEMBERS)),
        `${label} cluster ${clusterId} reports its actual size and completion state`);
        check(new Set(members.map((item) => item.clusterMember)).size === members.length,
            `${label} cluster ${clusterId} has unique member indices`);
    }
    check(clusterSizes.reduce((sum, count) => sum + count, 0) === cliff.length,
        `${label} per-cliff sizes account for every cliff instance`);
    const pieceCounts = Array.from(
        { length: api.DESERT_ROCK_PIECE_COUNT },
        (_, piece) => placements.filter((item) => item.piece === piece).length,
    );
    check(pieceCounts.every((count) => count > 0),
        `${label} instanced capacity covers every source piece`, pieceCounts.join(','));
    return {
        total: placements.length,
        ground: ground.length,
        cliff: cliff.length,
        cliffShortfall: api.DESERT_ROCK_CLIFF_CLUSTER_TARGET - cliff.length,
        clusterSizes,
        pieceCounts,
    };
}

const analyticSummary = auditPlacementSet(analyticA, 'Analytic');
const renderedSummary = auditPlacementSet(renderedPlacements, 'Rendered-horizon');

check(!terrainSource.includes('DESERT_CLIFF_BURY_DEPTH')
    && !/sourceBottom\s*=\s*template\.levels\[0\]\.boundingBox\.min\.y/.test(terrainSource),
'Fixed center/12m cliff seating is fully retired');
check(/collectCliffBaseSupportSamples\(levels\[0\]\)/.test(terrainSource)
    && /for \(const sample of template\.baseSupportSamples\)/.test(terrainSource)
    && /seatingHeight = Math\.min\(/.test(terrainSource),
'Runtime seats cliffs from all LOD0 bottom-support samples');
check(/placement\.piece === 3[\s\S]*dimensions\.widthZ[\s\S]*dimensions\.height/.test(terrainSource)
    && /Math\.min\(dimensions\.widthX, dimensions\.height\)/.test(terrainSource)
    && /upslope\.multiplyScalar\(0\.97\)/.test(terrainSource)
    && /\.addScaledVector\(normal, -0\.24\)/.test(terrainSource),
'Runtime scales both cliff pieces by long axis, leans them upslope, and buries by thickness');
check(/buildDesertRockPlacements\(surfaceHeightAt\)/.test(terrainSource),
'Runtime placement grades use the rendered near/horizon surface');
check(/bestPartialCluster/.test(terrainSource)
    && /gracefulPartialClusters: true/.test(terrainSource)
    && !terrainSource.includes('could not be filled')
    && !terrainSource.includes('requested total placements'),
'Decorative cluster shortfalls are retained and cannot abort world loading');

const cliffAssets = normalize(api.DESERT_CLIFF_ASSETS);
const cliffPlacementSummaries = [];
const parsedCliffs = new Map();
for (const [key, url] of Object.entries(cliffAssets)) {
    parsedCliffs.set(key, parseGlb(path.join(ROOT, url.replace(/^\.\//, ''))));
}
for (const placement of normalize(api.DESERT_CLIFF_PLACEMENTS)) {
    const parsed = parsedCliffs.get(placement.asset);
    const node = parsed.json.nodes.find((item) => /_LOD0$/.test(item.name ?? ''));
    check(Boolean(node), 'Cliff runtime contains LOD0 support source', placement.asset);
    check(!node.matrix && !node.translation && !node.rotation && !node.scale,
        'Cliff LOD0 node requires no unmirrored transform in the CPU audit', placement.asset);
    const position = meshPositionReader(parsed, node);
    const bounds = actualBounds(position);
    const bandTop = bounds.minimum[1]
        + (bounds.maximum[1] - bounds.minimum[1])
            * api.DESERT_CLIFF_BASE_SUPPORT_BAND_FRACTION;
    const supports = [];
    for (let index = 0; index < position.accessor.count; index++) {
        const y = position.get(index, 1);
        if (y > bandTop) continue;
        supports.push({
            x: position.get(index, 0),
            y,
            z: position.get(index, 2),
        });
    }
    check(supports.length > 100,
        'Cliff LOD0 provides a dense whole-footprint support band',
        `${placement.name} ${supports.length}`);
    const supportMinX = Math.min(...supports.map((item) => item.x));
    const supportMaxX = Math.max(...supports.map((item) => item.x));
    const supportMinZ = Math.min(...supports.map((item) => item.z));
    const supportMaxZ = Math.max(...supports.map((item) => item.z));
    check((supportMaxX - supportMinX) / (bounds.maximum[0] - bounds.minimum[0]) > 0.90
        && (supportMaxZ - supportMinZ) / (bounds.maximum[2] - bounds.minimum[2]) > 0.90,
    'Cliff support samples span the authored base in both horizontal axes', placement.name);

    const cosYaw = Math.cos(placement.yaw);
    const sinYaw = Math.sin(placement.yaw);
    const transformed = supports.map((sample) => {
        const scaledX = sample.x * placement.scale;
        const scaledZ = sample.z * placement.scale;
        const worldX = placement.x + scaledX * cosYaw + scaledZ * sinYaw;
        const worldZ = placement.z - scaledX * sinYaw + scaledZ * cosYaw;
        const terrain = api.auditRenderedHeightAt(worldX, worldZ);
        return { sample, worldX, worldZ, terrain };
    });
    const seatingHeight = Math.min(...transformed.map(({ sample, terrain }) => (
        terrain - sample.y * placement.scale
    ))) - api.DESERT_CLIFF_BASE_EMBED_METRES;
    const clearances = transformed.map(({ sample, terrain }) => (
        seatingHeight + sample.y * placement.scale - terrain
    ));
    const maximumClearance = Math.max(...clearances);
    check(maximumClearance <= -1.5,
        'Transformed cliff base has no hovering support point',
        `${placement.name} max=${maximumClearance.toFixed(4)}m`);
    check(Math.abs(maximumClearance + api.DESERT_CLIFF_BASE_EMBED_METRES) < 1e-6,
        'Whole-footprint seating reaches the requested two-metre embed',
        `${placement.name} max=${maximumClearance.toFixed(6)}m`);
    cliffPlacementSummaries.push({
        name: placement.name,
        supports: supports.length,
        seatingHeight,
        terrainMinimum: Math.min(...transformed.map((item) => item.terrain)),
        terrainMaximum: Math.max(...transformed.map((item) => item.terrain)),
        maximumClearance,
    });
}

if (failures.length) {
    console.error(`Rock/cliff placement audit failed (${failures.length}/${assertions}):`);
    for (const failure of failures) console.error(`- ${failure}`);
    process.exit(1);
}

console.log(`Rock/cliff placement audit passed (${assertions} assertions).`);
console.log(JSON.stringify({
    analytic: analyticSummary,
    renderedHorizon: renderedSummary,
    silhouettes: rockMetrics.map((item) => ({
        piece: item.piece,
        heightOverWidth: Number(item.heightOverWidth.toFixed(3)),
        planAspect: Number(item.planAspect.toFixed(3)),
        isotropy: Number(item.isotropy.toFixed(3)),
    })),
    cliffs: cliffPlacementSummaries.map((item) => ({
        name: item.name,
        supports: item.supports,
        seatingHeight: Number(item.seatingHeight.toFixed(3)),
        terrainEnvelope: [
            Number(item.terrainMinimum.toFixed(3)),
            Number(item.terrainMaximum.toFixed(3)),
        ],
        maximumClearance: Number(item.maximumClearance.toFixed(3)),
    })),
}, null, 2));
