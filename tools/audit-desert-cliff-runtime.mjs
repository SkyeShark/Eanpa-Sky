#!/usr/bin/env node

// CPU-only audit for the immutable user cliff masters, optimized maps, baked
// geometry LODs, and the true-instanced runtime integration.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TERRAIN_PATH = path.join(ROOT, 'src', 'terrain_real.js');
const MANIFEST_PATH = path.join(ROOT, 'assets', 'terrain', 'desert_cliff_runtime_lods.json');
const failures = [];
let assertions = 0;

function assert(condition, message, details = '') {
    assertions++;
    if (!condition) failures.push(message + (details ? ': ' + details : ''));
}

function sha256(filename) {
    return crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex');
}

function parseGlb(filename) {
    const data = fs.readFileSync(filename);
    assert(data.toString('ascii', 0, 4) === 'glTF', 'GLB has valid magic', filename);
    assert(data.readUInt32LE(4) === 2, 'GLB uses glTF 2.0', filename);
    assert(data.readUInt32LE(8) === data.length, 'GLB declares exact byte length', filename);
    let offset = 12;
    let json = null;
    let binary = null;
    while (offset < data.length) {
        const length = data.readUInt32LE(offset); offset += 4;
        const type = data.readUInt32LE(offset); offset += 4;
        const payload = data.subarray(offset, offset + length); offset += length;
        if (type === 0x4e4f534a) json = JSON.parse(payload.toString('utf8').replace(/\0+$/g, '').trim());
        if (type === 0x004e4942) binary = payload;
    }
    assert(Boolean(json && binary), 'GLB contains JSON and BIN chunks', filename);
    return { data, json, binary };
}

const COMPONENT_BYTES = { 5123: 2, 5125: 4, 5126: 4 };

function accessorReader(gltf, binary, index) {
    const accessor = gltf.accessors[index];
    const view = gltf.bufferViews[accessor.bufferView];
    const components = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }[accessor.type];
    const componentBytes = COMPONENT_BYTES[accessor.componentType];
    const stride = view.byteStride ?? components * componentBytes;
    const start = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
    const read = accessor.componentType === 5126
        ? (offset) => binary.readFloatLE(offset)
        : accessor.componentType === 5125
            ? (offset) => binary.readUInt32LE(offset)
            : (offset) => binary.readUInt16LE(offset);
    return {
        accessor,
        get(vertex, component = 0) {
            return read(start + vertex * stride + component * componentBytes);
        },
    };
}

function primitiveMetrics(gltf, binary, primitive) {
    const position = accessorReader(gltf, binary, primitive.attributes.POSITION);
    const normal = accessorReader(gltf, binary, primitive.attributes.NORMAL);
    const uv = accessorReader(gltf, binary, primitive.attributes.TEXCOORD_0);
    const index = accessorReader(gltf, binary, primitive.indices);
    let opposed = 0;
    let degenerate = 0;
    for (let offset = 0; offset < index.accessor.count; offset += 3) {
        const a = index.get(offset), b = index.get(offset + 1), c = index.get(offset + 2);
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
        const area2 = Math.hypot(nx, ny, nz);
        if (area2 <= 1e-12) degenerate++;
        const authoredX = normal.get(a, 0) + normal.get(b, 0) + normal.get(c, 0);
        const authoredY = normal.get(a, 1) + normal.get(b, 1) + normal.get(c, 1);
        const authoredZ = normal.get(a, 2) + normal.get(b, 2) + normal.get(c, 2);
        if (nx * authoredX + ny * authoredY + nz * authoredZ < 0) opposed++;
    }
    return {
        vertices: position.accessor.count,
        triangles: index.accessor.count / 3,
        opposed,
        degenerate,
        boundsMin: position.accessor.min,
        boundsMax: position.accessor.max,
        uvCount: uv.accessor.count,
    };
}

function pngDimensions(binary, view) {
    const offset = view.byteOffset ?? 0;
    assert(binary.subarray(offset, offset + 8).toString('hex') === '89504e470d0a1a0a',
        'Embedded runtime image is PNG');
    return [binary.readUInt32BE(offset + 16), binary.readUInt32BE(offset + 20)];
}

function extractConstant(source, name, wrapper = '') {
    const pattern = wrapper === 'freeze'
        ? new RegExp('const ' + name + ' = Object\\.freeze\\((\\{[\\s\\S]*?\\})\\);')
        : new RegExp('const ' + name + ' = (\\[[\\s\\S]*?\\n\\]);');
    const match = source.match(pattern);
    if (!match) throw new Error('Missing source constant ' + name);
    return vm.runInNewContext('(' + match[1] + ')');
}

const terrainSource = fs.readFileSync(TERRAIN_PATH, 'utf8');
const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
assert(manifest.schema === 'eanpa-user-desert-cliff-lods-v1',
    'LOD manifest uses the current schema');
assert(JSON.stringify(manifest.lodRatios) === JSON.stringify([1, 0.4, 0.16]),
    'LOD ratios are conservative near/mid/far reductions');
assert(JSON.stringify(manifest.lodDistancesMetres) === JSON.stringify([0, 600, 1050]),
    'LOD manifest and runtime use meaningful metre thresholds');
assert(manifest.textureMaximum === 2048 && manifest.originalsUntouched,
    'Runtime maps cap at 2K and masters remain immutable');

const assets = extractConstant(terrainSource, 'DESERT_CLIFF_ASSETS', 'freeze');
const placements = extractConstant(terrainSource, 'DESERT_CLIFF_PLACEMENTS');
const summaries = [];
for (const asset of manifest.assets) {
    const masterPath = path.join(ROOT, asset.master);
    const runtimePath = path.join(ROOT, asset.runtime);
    assert(sha256(masterPath) === asset.masterSha256,
        'Immutable master hash matches manifest', asset.key);
    assert(sha256(runtimePath) === asset.runtimeSha256,
        'Runtime LOD hash matches manifest', asset.key);
    assert(assets[asset.key].replace(/^\.\//, '') === asset.runtime,
        'Runtime constant loads final LOD GLB', asset.key);
    const master = parseGlb(masterPath);
    const runtime = parseGlb(runtimePath);
    const masterNode = master.json.nodes.find((node) => Number.isInteger(node.mesh));
    const masterPrimitive = master.json.meshes[masterNode.mesh].primitives[0];
    const masterMetrics = primitiveMetrics(master.json, master.binary, masterPrimitive);
    const expectedMasterOpposed = asset.key === 'mesaHigh' ? 3 : 0;
    assert(masterMetrics.opposed === expectedMasterOpposed,
        'Immutable master has the recorded winding diagnostic', asset.key);
    assert(asset.windingRepairs === expectedMasterOpposed,
        'Offline derivative records master winding repairs', asset.key);

    const meshNodes = runtime.json.nodes.filter((node) => Number.isInteger(node.mesh));
    assert(meshNodes.length === 3, 'Runtime GLB contains three real mesh LODs', asset.key);
    const material = runtime.json.materials[runtime.json.meshes[meshNodes[0].mesh].primitives[0].material];
    assert(material.doubleSided === true
        && Number.isInteger(material.normalTexture?.index)
        && Number.isInteger(material.pbrMetallicRoughness?.baseColorTexture?.index)
        && Number.isInteger(material.pbrMetallicRoughness?.metallicRoughnessTexture?.index),
    'Every LOD shares the imported baked PBR contract', asset.key);
    const imageDimensions = runtime.json.images.map((image) => (
        pngDimensions(runtime.binary, runtime.json.bufferViews[image.bufferView])
    ));
    assert(imageDimensions.length === 3
        && imageDimensions.every(([width, height]) => width === 2048 && height === 2048),
    'All final runtime maps are 2048 x 2048', asset.key);

    const levels = meshNodes.map((node) => {
        const match = /_LOD([0-2])$/.exec(node.name ?? '');
        assert(Boolean(match), 'Runtime node has explicit LOD name', node.name ?? '');
        const lod = Number(match?.[1]);
        const primitive = runtime.json.meshes[node.mesh].primitives[0];
        const metrics = primitiveMetrics(runtime.json, runtime.binary, primitive);
        assert(metrics.opposed === 0, 'Final runtime LOD has no opposed winding', node.name ?? '');
        assert(metrics.degenerate === 0, 'Final runtime LOD has no degenerate triangles', node.name ?? '');
        assert(metrics.uvCount === metrics.vertices, 'Final runtime LOD preserves complete UVs', node.name ?? '');
        assert(metrics.triangles === asset.lods[lod].triangles,
            'Manifest triangle count matches final GLB', node.name ?? '');
        return { lod, ...metrics };
    }).sort((a, b) => a.lod - b.lod);
    assert(levels[0].triangles > levels[1].triangles * 2
        && levels[1].triangles > levels[2].triangles * 2,
    'LOD triangle budgets decrease substantially', asset.key);
    const maxBoundsDelta = Math.max(...levels.slice(1).flatMap((level) => (
        level.boundsMin.map((value, axis) => Math.abs(value - levels[0].boundsMin[axis]))
            .concat(level.boundsMax.map((value, axis) => Math.abs(value - levels[0].boundsMax[axis])))
    )));
    assert(maxBoundsDelta < 0.025, 'LOD decimation conservatively preserves silhouette bounds',
        asset.key + ' ' + maxBoundsDelta.toFixed(5));
    summaries.push({ key: asset.key, bytes: asset.runtimeBytes, levels });
}

assert(placements.length === 8, 'Eight scene placements are retained');
const usage = Object.fromEntries(Object.keys(assets).map((key) => [
    key, placements.filter((placement) => placement.asset === key).length,
]));
assert(usage.wideLow === 5 && usage.mesaHigh === 3,
    'Instanced composition uses five low shelves and three high mesas');
const playerHalf = 356;
for (const placement of placements) {
    assert(Number.isFinite(placement.scale), 'Placement scale is one uniform scalar', placement.name);
    const localX = placement.halfLength + 42;
    const localZ = placement.halfDepth + 38;
    const c = Math.abs(Math.cos(placement.yaw));
    const s = Math.abs(Math.sin(placement.yaw));
    const worldX = c * localX + s * localZ;
    const worldZ = s * localX + c * localZ;
    const outside = placement.x + worldX < -playerHalf
        || placement.x - worldX > playerHalf
        || placement.z + worldZ < -playerHalf
        || placement.z - worldZ > playerHalf;
    assert(outside, 'Complete cliff foundation stays outside player bounds', placement.name);
}

assert(/new T3\.InstancedMesh\(/.test(terrainSource)
    && /cliffBatches\.set/.test(terrainSource)
    && /batch\.setMatrixAt\(batch\.count, state\.matrix\)/.test(terrainSource),
'Runtime uses true asset-and-LOD InstancedMesh buckets');
assert(!/new T3\.LOD\(/.test(terrainSource)
    && !/template\.geometry\.clone\(/.test(terrainSource)
    && /geometryClonePerPlacement: false/.test(terrainSource),
'Runtime has no per-placement mesh or geometry clone path');
assert(/updateCliffInstances\(camera\)/.test(terrainSource)
    && /terrain\.updateLods = \(camera\)/.test(terrainSource)
    && /DESERT_CLIFF_LOD_HYSTERESIS = 0\.10/.test(terrainSource),
'Gameplay camera manually buckets instances with hysteresis');
assert(/instancedBatches: cliffBatches\.size/.test(terrainSource)
    && /maximumCliffDrawCalls: cliffBatches\.size/.test(terrainSource)
    && /totalInstances: cliffInstanceStates\.length/.test(terrainSource),
'Runtime publishes draw-call and instance diagnostics');
assert(/terrainFoundationAprons: true/.test(terrainSource)
    && /terrainConformedBuriedSkirts: false/.test(terrainSource)
    && /profile: 'user-wide-low-plus-high-mesa_instanced-lods-v3'/.test(terrainSource)
    && /wholeFootprintSupportSeating: true/.test(terrainSource)
    && /baseSupportBandFraction: DESERT_CLIFF_BASE_SUPPORT_BAND_FRACTION/.test(terrainSource)
    && /baseEmbedMetres: DESERT_CLIFF_BASE_EMBED_METRES/.test(terrainSource)
    && /rigidUpperSilhouettes: true/.test(terrainSource)
    && /physics: false/.test(terrainSource),
'V3 whole-footprint foundation metadata seats rigid non-physical cliff instances');
assert(!/authored_escarpments_v1\.glb/.test(terrainSource)
    && !/AUTHORED_CLIFF_ASSET/.test(terrainSource),
'Retired authored_escarpments asset is absent from runtime source');

const report = {
    assertions,
    originalBytes: manifest.assets.reduce((sum, asset) => sum + fs.statSync(path.join(ROOT, asset.master)).size, 0),
    runtimeBytes: manifest.assets.reduce((sum, asset) => sum + asset.runtimeBytes, 0),
    decodedTextureMemoryMiB: 96,
    maximumDrawCalls: 6,
    totalInstances: placements.length,
    usage,
    assets: summaries,
};

if (failures.length) {
    console.error('Desert cliff runtime audit failed: ' + failures.length + ' / ' + assertions);
    failures.forEach((failure) => console.error('- ' + failure));
    console.error(JSON.stringify(report, null, 2));
    process.exitCode = 1;
} else {
    console.log('Desert cliff runtime audit passed: ' + assertions + ' assertions');
    console.log(JSON.stringify(report, null, 2));
}
