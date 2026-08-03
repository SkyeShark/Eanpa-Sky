#!/usr/bin/env node

// CPU-only audit for the immutable 12-rock master and its reusable LOD library.

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MASTER = path.join(ROOT, 'assets/terrain/Desert_rock_chunks_12_pieces.glb');
const RUNTIME = path.join(
    ROOT,
    'assets/terrain/Desert_rock_chunks_12_pieces_runtime_2k_lods.glb',
);
const TEXTURE_MANIFEST = JSON.parse(fs.readFileSync(
    path.join(ROOT, 'assets/terrain/desert_rock_chunks_runtime_2k.json'),
    'utf8',
));
const LOD_MANIFEST = JSON.parse(fs.readFileSync(
    path.join(ROOT, 'assets/terrain/desert_rock_chunks_runtime_lods.json'),
    'utf8',
));
const TERRAIN_SOURCE = fs.readFileSync(path.join(ROOT, 'src', 'terrain_real.js'), 'utf8');
const MASTER_SHA256 =
    '233a8c11fb0e281b38a6e7df1ff0fe20f3ff00f3fe31b858971041637e89714f';
const RUNTIME_SHA256 =
    '781d4ed5816140066d3e1c793385c42c037cf00dec996206c11e91810922721d';
const COMPONENTS = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };
const COMPONENT_BYTES = { 5121: 1, 5123: 2, 5125: 4, 5126: 4 };
let assertions = 0;

function check(value, message) {
    assertions++;
    assert.ok(value, message);
}

function equal(actual, expected, message) {
    assertions++;
    assert.equal(actual, expected, message);
}

function deepEqual(actual, expected, message) {
    assertions++;
    assert.deepEqual(actual, expected, message);
}

function parseGlb(filename) {
    const bytes = fs.readFileSync(filename);
    equal(bytes.toString('ascii', 0, 4), 'glTF', `${filename} magic`);
    equal(bytes.readUInt32LE(4), 2, `${filename} glTF version`);
    equal(bytes.readUInt32LE(8), bytes.length, `${filename} declared length`);
    let offset = 12;
    let json = null;
    let binary = null;
    while (offset < bytes.length) {
        const length = bytes.readUInt32LE(offset); offset += 4;
        const type = bytes.readUInt32LE(offset); offset += 4;
        const chunk = bytes.subarray(offset, offset + length); offset += length;
        if (type === 0x4e4f534a) {
            json = JSON.parse(chunk.toString('utf8').replace(/\0+$/g, '').trim());
        } else if (type === 0x004e4942) {
            binary = chunk;
        }
    }
    check(json && binary, `${filename} contains JSON and BIN chunks`);
    return { bytes, json, binary };
}

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

function pngHeader(binary, view) {
    const offset = view.byteOffset ?? 0;
    equal(
        binary.subarray(offset, offset + 8).toString('hex'),
        '89504e470d0a1a0a',
        'embedded texture is PNG',
    );
    return {
        width: binary.readUInt32BE(offset + 16),
        height: binary.readUInt32BE(offset + 20),
        encodedBytes: view.byteLength,
    };
}

function sha256(bytes) {
    return crypto.createHash('sha256').update(bytes).digest('hex');
}

function meshNodes(gltf) {
    return (gltf.nodes ?? []).filter((node) => Number.isInteger(node.mesh));
}

function primitiveFor(gltf, node) {
    const mesh = gltf.meshes[node.mesh];
    equal(mesh.primitives.length, 1, `${node.name} primitive count`);
    return mesh.primitives[0];
}

function weldedComponentCount(gltf, binary, primitive) {
    const position = accessorReader(gltf, binary, primitive.attributes.POSITION);
    const indices = accessorReader(gltf, binary, primitive.indices);
    const keys = Array.from({ length: position.accessor.count }, (_, index) => (
        [0, 1, 2]
            .map((component) => Math.round(position.get(index, component) * 1e6))
            .join(':')
    ));
    const parents = new Map();
    const find = (key) => {
        if (!parents.has(key)) parents.set(key, key);
        let root = key;
        while (parents.get(root) !== root) root = parents.get(root);
        while (parents.get(key) !== key) {
            const next = parents.get(key);
            parents.set(key, root);
            key = next;
        }
        return root;
    };
    const union = (left, right) => {
        const leftRoot = find(left);
        const rightRoot = find(right);
        if (leftRoot !== rightRoot) parents.set(rightRoot, leftRoot);
    };
    const used = new Set();
    for (let offset = 0; offset < indices.accessor.count; offset += 3) {
        const a = keys[indices.get(offset)];
        const b = keys[indices.get(offset + 1)];
        const c = keys[indices.get(offset + 2)];
        used.add(a); used.add(b); used.add(c);
        union(a, b); union(a, c);
    }
    return new Set([...used].map(find)).size;
}

function geometryReport(gltf, binary, primitive) {
    const position = accessorReader(gltf, binary, primitive.attributes.POSITION);
    const normal = accessorReader(gltf, binary, primitive.attributes.NORMAL);
    const uv = accessorReader(gltf, binary, primitive.attributes.TEXCOORD_0);
    const indices = accessorReader(gltf, binary, primitive.indices);
    const minimum = [Infinity, Infinity, Infinity];
    const maximum = [-Infinity, -Infinity, -Infinity];
    for (let index = 0; index < position.accessor.count; index++) {
        for (let component = 0; component < 3; component++) {
            const value = position.get(index, component);
            minimum[component] = Math.min(minimum[component], value);
            maximum[component] = Math.max(maximum[component], value);
        }
    }
    let degenerate = 0;
    let opposed = 0;
    for (let offset = 0; offset < indices.accessor.count; offset += 3) {
        const a = indices.get(offset), b = indices.get(offset + 1), c = indices.get(offset + 2);
        const ax = position.get(a, 0), ay = position.get(a, 1), az = position.get(a, 2);
        const abx = position.get(b, 0) - ax;
        const aby = position.get(b, 1) - ay;
        const abz = position.get(b, 2) - az;
        const acx = position.get(c, 0) - ax;
        const acy = position.get(c, 1) - ay;
        const acz = position.get(c, 2) - az;
        const nx = aby * acz - abz * acy;
        const ny = abz * acx - abx * acz;
        const nz = abx * acy - aby * acx;
        if (Math.hypot(nx, ny, nz) <= 1e-12) {
            degenerate++;
            continue;
        }
        const authoredX = normal.get(a, 0) + normal.get(b, 0) + normal.get(c, 0);
        const authoredY = normal.get(a, 1) + normal.get(b, 1) + normal.get(c, 1);
        const authoredZ = normal.get(a, 2) + normal.get(b, 2) + normal.get(c, 2);
        if (nx * authoredX + ny * authoredY + nz * authoredZ < 0) opposed++;
    }
    return {
        vertices: position.accessor.count,
        triangles: indices.accessor.count / 3,
        uvCount: uv.accessor.count,
        minimum,
        maximum,
        degenerate,
        opposed,
    };
}

const master = parseGlb(MASTER);
const masterNodes = meshNodes(master.json);
equal(masterNodes.length, 1, 'master mesh node count');
equal(sha256(master.bytes), MASTER_SHA256, 'immutable master SHA-256');
equal(master.bytes.length, 140184988, 'immutable master byte length');
const masterPrimitive = primitiveFor(master.json, masterNodes[0]);
equal(
    weldedComponentCount(master.json, master.binary, masterPrimitive),
    12,
    'master welded connected-piece count',
);
equal(
    accessorReader(master.json, master.binary, masterPrimitive.indices).accessor.count / 3,
    54638,
    'master triangle count',
);
const masterImages = master.json.images.map((image) => (
    pngHeader(master.binary, master.json.bufferViews[image.bufferView])
));
equal(masterImages.length, 3, 'master embedded PBR image count');
check(masterImages.some((image) => image.width === 8192), 'master keeps 8K base color');
equal(TEXTURE_MANIFEST.asset.sourceSha256, MASTER_SHA256, 'texture manifest source hash');
equal(TEXTURE_MANIFEST.asset.runtimeBytes, 17840300, '2K intermediate byte count');
const normalTreatment = TEXTURE_MANIFEST.asset.images.find(
    (image) => image.roles.includes('normal'),
);
equal(
    normalTreatment?.treatment,
    'lanczos_then_unit_vector_renormalization',
    'normal-map resize treatment',
);

const runtime = parseGlb(RUNTIME);
equal(LOD_MANIFEST.schema, 'eanpa-desert-rock-chunks-instanced-lods-v4', 'LOD manifest schema');
deepEqual(LOD_MANIFEST.lodRatios, [1, 0.32, 0.1], 'three authored LOD ratios');
deepEqual(
    LOD_MANIFEST.lodProjectedDiameterPixels,
    [72, 18, 1],
    'projected-diameter LOD thresholds',
);
equal(LOD_MANIFEST.subpixelCullDiameterPixels, 1, 'subpixel cull diameter');
deepEqual(
    LOD_MANIFEST.pieceClasses,
    {
        largeFlatWide: [2, 4, 8, 9],
        mediumIrregular: [0, 5, 6, 7],
        smallSmoothRound: [1, 10],
        cliffFaceTallNarrow: [3, 11],
    },
    'semantic piece classes',
);
deepEqual(
    LOD_MANIFEST.pieceDiameterMetres,
    {
        largeFlatWide: [2.0, 5.8],
        mediumIrregular: [0.95, 2.75],
        smallSmoothRound: [0.30, 0.80],
    },
    'ground-scatter footprint diameter ranges',
);
deepEqual(
    LOD_MANIFEST.pieceLongAxisMetres,
    { cliffFaceTallNarrow: [6.0, 14.0] },
    'cliff-face long-axis range',
);
const rockMetadata = TERRAIN_SOURCE.slice(
    TERRAIN_SOURCE.indexOf('terrain.userData.desertRockChunks'),
    TERRAIN_SOURCE.indexOf('terrain.userData.nuclearCrater'),
);
check(
    /profile: 'user-12-piece-instanced-terrain-dressing-v4'/.test(rockMetadata)
        && /groundDiameterRangesMetres: Object\.fromEntries/.test(rockMetadata)
        && /cliffClusterLongAxisRangesMetres: \{/.test(rockMetadata)
        && /gracefulPartialClusters: true/.test(rockMetadata)
        && /placementVersion: 'desert-rock-authored-v5-graceful-visual-index-clusters'/.test(rockMetadata)
        && !/largeUpright|mediumChunky|smallFlat|diameterRangesMetres:/.test(rockMetadata),
    'runtime integration metadata uses the inspected v4 roles and graceful cluster schema',
);
check(
    /DESERT_ROCK_GROUND_INSTANCE_TARGET = 656/.test(TERRAIN_SOURCE)
        && /DESERT_ROCK_CLIFF_CLUSTER_TARGET = 64/.test(TERRAIN_SOURCE)
        && /DESERT_ROCK_CLIFF_CLUSTER_MEMBERS = 8/.test(TERRAIN_SOURCE)
        && /bestPartialCluster/.test(TERRAIN_SOURCE)
        && !TERRAIN_SOURCE.includes('could not be filled'),
    'runtime retains 656 ground instances and a non-blocking 64-member cliff target',
);
equal(runtime.bytes.length, 18707644, 'final runtime byte count');
equal(runtime.bytes.length, LOD_MANIFEST.asset.runtimeBytes, 'runtime manifest byte count');
equal(sha256(runtime.bytes), RUNTIME_SHA256, 'final runtime SHA-256');
equal(sha256(runtime.bytes), LOD_MANIFEST.asset.runtimeSha256, 'runtime manifest SHA-256');
check(runtime.bytes.length < master.bytes.length * 0.14, 'runtime stays below 14% of master');
const runtimeNodes = meshNodes(runtime.json);
equal(runtimeNodes.length, 36, '12 pieces times three LOD mesh nodes');
equal(runtime.json.materials?.length, 1, 'one shared baked PBR material');
const material = runtime.json.materials[0];
check(
    Number.isInteger(material.pbrMetallicRoughness?.baseColorTexture?.index),
    'shared material base-color map',
);
check(
    Number.isInteger(material.pbrMetallicRoughness?.metallicRoughnessTexture?.index),
    'shared material metallic/roughness map',
);
check(Number.isInteger(material.normalTexture?.index), 'shared material normal map');
equal(runtime.json.images?.length, 3, 'runtime embedded PBR image count');
const runtimeImages = runtime.json.images.map((image) => (
    pngHeader(runtime.binary, runtime.json.bufferViews[image.bufferView])
));
for (const image of runtimeImages) {
    equal(image.width, 2048, 'runtime texture width');
    equal(image.height, 2048, 'runtime texture height');
}

const reports = Array.from({ length: 12 }, () => Array(3));
const materialIndices = new Set();
for (const node of runtimeNodes) {
    const match = /^DesertRockPiece(\d{2})_LOD([012])$/.exec(node.name);
    check(match, `runtime node name ${node.name}`);
    const piece = Number(match[1]);
    const lod = Number(match[2]);
    check(piece < 12, `${node.name} piece index`);
    const primitive = primitiveFor(runtime.json, node);
    materialIndices.add(primitive.material);
    const report = geometryReport(runtime.json, runtime.binary, primitive);
    equal(report.uvCount, report.vertices, `${node.name} complete UVs`);
    equal(report.degenerate, 0, `${node.name} degenerate triangles`);
    equal(report.opposed, 0, `${node.name} opposed winding`);
    check(
        report.minimum[1] > (lod === 0 ? -1e-5 : -0.02),
        `${node.name} bottom pivot tolerance`,
    );
    if (lod === 0) {
        check(Math.abs(report.minimum[1]) < 1e-5, `${node.name} exact seated bottom`);
        check(
            Math.abs(report.minimum[0] + report.maximum[0]) < 1e-5,
            `${node.name} centered X pivot`,
        );
        check(
            Math.abs(report.minimum[2] + report.maximum[2]) < 1e-5,
            `${node.name} centered Z pivot`,
        );
    }
    equal(
        report.triangles,
        LOD_MANIFEST.asset.pieces[piece].lods[lod].triangles,
        `${node.name} manifest triangle count`,
    );
    reports[piece][lod] = report;
}
equal(materialIndices.size, 1, 'all piece LODs reference one material');
for (let piece = 0; piece < reports.length; piece++) {
    check(reports[piece].every(Boolean), `piece ${piece} has all three LODs`);
    const lod1Ratio = reports[piece][1].triangles / reports[piece][0].triangles;
    const lod2Ratio = reports[piece][2].triangles / reports[piece][0].triangles;
    check(lod1Ratio > 0.28 && lod1Ratio < 0.35, `piece ${piece} true LOD1 reduction ratio`);
    check(lod2Ratio >= 0.08 && lod2Ratio <= 0.12, `piece ${piece} true LOD2 reduction ratio`);
}
equal(LOD_MANIFEST.asset.sourceConnectedComponents, 12, 'manifest source components');
equal(LOD_MANIFEST.asset.pieceCount, 12, 'manifest reusable pieces');
equal(LOD_MANIFEST.trianglesByLod[0], 54638, 'manifest LOD0 total triangles');
equal(LOD_MANIFEST.trianglesByLod[1], 17475, 'manifest LOD1 total triangles');
equal(LOD_MANIFEST.trianglesByLod[2], 5457, 'manifest LOD2 total triangles');
equal(LOD_MANIFEST.decodedTextureMemoryMiB, 48, 'decoded shared texture budget');
const derivativeRepairs = LOD_MANIFEST.asset.lodWindingRepairs.reduce(
    (sum, item) => sum + item.repairs,
    0,
);
equal(LOD_MANIFEST.asset.lodWindingRepairs.length, 36, 'winding audit covers every LOD node');
equal(derivativeRepairs, 31, 'offline decimation winding repairs');
equal(LOD_MANIFEST.asset.masterSha256, MASTER_SHA256, 'LOD manifest master hash');
equal(LOD_MANIFEST.originalUntouched, true, 'manifest preserves original');

console.log(`Desert rock runtime audit passed: ${assertions} assertions`);
console.log(JSON.stringify({
    assertions,
    masterSha256: MASTER_SHA256,
    masterBytes: master.bytes.length,
    masterConnectedPieces: 12,
    runtimeSha256: sha256(runtime.bytes),
    runtimeBytes: runtime.bytes.length,
    textureMaximum: 2048,
    decodedTextureMemoryMiB: 48,
    sharedMaterials: materialIndices.size,
    reusablePieces: reports.length,
    realGeometryLods: 3,
    trianglesByLod: reports.reduce(
        (totals, piece) => [
            totals[0] + piece[0].triangles,
            totals[1] + piece[1].triangles,
            totals[2] + piece[2].triangles,
        ],
        [0, 0, 0],
    ),
    maximumRuntimeDrawCalls: 36,
    configuredInstances: 720,
}, null, 2));
