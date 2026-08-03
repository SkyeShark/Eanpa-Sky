#!/usr/bin/env node

// Losslessly patch the CPU/Blender-repaired body LODs into SeedThree's GLB.
// The source JSON hierarchy, MSFT_lod extension, spine/billboard accessors,
// materials, textures, and embedded images stay byte-for-byte referenced as
// authored. New body accessors are appended to the BIN chunk; the original body
// bytes remain in place as inert provenance.

import { createHash } from 'node:crypto';
import {
    copyFile,
    mkdir,
    readFile,
    stat,
    writeFile,
} from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const parseArgs = (argv) => {
    const values = {};
    for (let index = 0; index < argv.length; index += 2) {
        const key = argv[index];
        const value = argv[index + 1];
        if (!key?.startsWith('--') || value === undefined) {
            throw new Error(`Expected --key value arguments; got ${key ?? '<end>'}`);
        }
        values[key.slice(2)] = value;
    }
    return values;
};

const args = parseArgs(process.argv.slice(2));
const inputPath = resolve(args.input ?? 'assets/vegetation/saguaro_seed555.glb');
const repairPath = resolve(args.repair ?? 'artifacts/saguaro-topology-repair/repaired-meshes.json');
const outputPath = resolve(args.output ?? inputPath);
const backupPath = resolve(args.backup ?? 'artifacts/saguaro-topology-repair/saguaro_seed555_seedthree-original.glb');
const reportPath = resolve(args.report ?? 'artifacts/saguaro-topology-repair/patch-report.json');

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const exists = async (path) => stat(path).then(() => true, () => false);
const align4 = (value) => (value + 3) & ~3;

const parseGlb = (bytes) => {
    if (bytes.toString('ascii', 0, 4) !== 'glTF') throw new Error('Input is not a GLB');
    if (bytes.readUInt32LE(4) !== 2) throw new Error('Input is not glTF 2');
    if (bytes.readUInt32LE(8) !== bytes.length) throw new Error('GLB header length mismatch');
    let cursor = 12;
    let document = null;
    let binary = null;
    while (cursor < bytes.length) {
        const length = bytes.readUInt32LE(cursor);
        const type = bytes.readUInt32LE(cursor + 4);
        const payload = bytes.subarray(cursor + 8, cursor + 8 + length);
        cursor += 8 + length;
        if (type === 0x4e4f534a) {
            document = JSON.parse(payload.toString('utf8').replace(/[\0 ]+$/, ''));
        } else if (type === 0x004e4942) {
            binary = Buffer.from(payload);
        }
    }
    if (!document || !binary) throw new Error('GLB lacks JSON or BIN chunk');
    return { document, binary };
};

const expect = (condition, message) => {
    if (!condition) throw new Error(message);
};

const finiteArray = (values, width, count, label) => {
    expect(Array.isArray(values), `${label} is not an array`);
    expect(values.length === count, `${label} count ${values.length} != ${count}`);
    const flat = new Float32Array(count * width);
    for (let row = 0; row < count; row++) {
        const value = values[row];
        expect(Array.isArray(value) && value.length === width, `${label}[${row}] is not VEC${width}`);
        for (let column = 0; column < width; column++) {
            expect(Number.isFinite(value[column]), `${label}[${row}][${column}] is not finite`);
            flat[row * width + column] = value[column];
        }
    }
    return flat;
};

const componentBounds = (array, width) => {
    const min = new Array(width).fill(Infinity);
    const max = new Array(width).fill(-Infinity);
    for (let index = 0; index < array.length; index++) {
        const component = index % width;
        min[component] = Math.min(min[component], array[index]);
        max[component] = Math.max(max[component], array[index]);
    }
    return { min, max };
};

const sourceBytes = await readFile(inputPath);
const sourceHash = sha256(sourceBytes);
const repair = JSON.parse(await readFile(repairPath, 'utf8'));
expect(repair.format === 'eanpa-saguaro-manifold-repair/1', `Unsupported repair format ${repair.format}`);
expect(repair.sourceSha256 === sourceHash, `Repair source ${repair.sourceSha256} does not match input ${sourceHash}`);
expect(Array.isArray(repair.meshes) && repair.meshes.length === 3, 'Expected exactly three repaired body LODs');

await mkdir(dirname(backupPath), { recursive: true });
if (await exists(backupPath)) {
    const backupHash = sha256(await readFile(backupPath));
    expect(backupHash === sourceHash, `Existing backup hash ${backupHash} does not match source ${sourceHash}`);
} else {
    await copyFile(inputPath, backupPath);
}

const { document, binary: sourceBinary } = parseGlb(sourceBytes);
expect(document.buffers?.length === 1, `Expected one GLB buffer, got ${document.buffers?.length ?? 0}`);
const original = {
    nodes: document.nodes?.length,
    meshes: document.meshes?.length,
    materials: document.materials?.length,
    textures: document.textures?.length,
    images: document.images?.length,
    accessors: document.accessors?.length,
    bufferViews: document.bufferViews?.length,
    extensionsUsed: [...(document.extensionsUsed ?? [])],
};

const chunks = [sourceBinary];
let binaryLength = sourceBinary.length;
const appendBytes = (bytes, target) => {
    const aligned = align4(binaryLength);
    if (aligned !== binaryLength) chunks.push(Buffer.alloc(aligned - binaryLength));
    binaryLength = aligned;
    const byteOffset = binaryLength;
    const payload = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    chunks.push(payload);
    binaryLength += payload.length;
    const viewIndex = document.bufferViews.length;
    document.bufferViews.push({
        buffer: 0,
        byteOffset,
        byteLength: payload.length,
        target,
    });
    return viewIndex;
};

const appendAccessor = ({ array, width, type, componentType, target, bounds = false }) => {
    const bufferView = appendBytes(array, target);
    const accessor = {
        bufferView,
        componentType,
        count: array.length / width,
        type,
    };
    if (bounds) Object.assign(accessor, componentBounds(array, width));
    const index = document.accessors.length;
    document.accessors.push(accessor);
    return index;
};

const patched = [];
for (const meshRepair of [...repair.meshes].sort((a, b) => a.lod - b.lod)) {
    const { lod, meshIndex, triangleBudget } = meshRepair;
    expect([0, 1, 2].includes(lod), `Unexpected LOD ${lod}`);
    expect([0, 2, 4][lod] === meshIndex, `LOD${lod} targets mesh ${meshIndex}, expected ${[0, 2, 4][lod]}`);
    expect(meshRepair.topology?.degenerateTriangles === 0, `LOD${lod} contains degenerate triangles`);
    expect(meshRepair.topology?.boundaryEdges === 0, `LOD${lod} contains boundary edges`);
    expect(meshRepair.topology?.nonManifoldEdges === 0, `LOD${lod} contains non-manifold edges`);
    expect(meshRepair.topology?.maxEdgeIncidence === 2, `LOD${lod} is not exactly two-manifold`);
    expect(meshRepair.triangles <= triangleBudget, `LOD${lod} exceeds ${triangleBudget} triangles`);
    expect(meshRepair.triangles >= triangleBudget * 0.9, `LOD${lod} dropped too far below its authored budget`);

    const count = meshRepair.vertices;
    const position = finiteArray(meshRepair.position, 3, count, `LOD${lod}.position`);
    const normal = finiteArray(meshRepair.normal, 3, count, `LOD${lod}.normal`);
    const texcoord0 = finiteArray(meshRepair.texcoord0, 2, count, `LOD${lod}.texcoord0`);
    const tangent = finiteArray(meshRepair.tangent, 4, count, `LOD${lod}.tangent`);
    const aWind = finiteArray(meshRepair.aWind, 1, count, `LOD${lod}.aWind`);
    const aStemCenter = finiteArray(meshRepair.aStemCenter, 3, count, `LOD${lod}.aStemCenter`);
    expect(Array.isArray(meshRepair.indices), `LOD${lod}.indices is not an array`);
    expect(meshRepair.indices.length === meshRepair.triangles * 3, `LOD${lod} index count mismatch`);
    const IndexArray = count <= 65535 ? Uint16Array : Uint32Array;
    const indices = new IndexArray(meshRepair.indices.length);
    for (let index = 0; index < meshRepair.indices.length; index++) {
        const value = meshRepair.indices[index];
        expect(Number.isInteger(value) && value >= 0 && value < count, `LOD${lod} bad index ${value}`);
        indices[index] = value;
    }

    for (let vertex = 0; vertex < count; vertex++) {
        const ni = vertex * 3;
        const ti = vertex * 4;
        const nLength = Math.hypot(normal[ni], normal[ni + 1], normal[ni + 2]);
        const tLength = Math.hypot(tangent[ti], tangent[ti + 1], tangent[ti + 2]);
        const dot = normal[ni] * tangent[ti]
            + normal[ni + 1] * tangent[ti + 1]
            + normal[ni + 2] * tangent[ti + 2];
        expect(Math.abs(nLength - 1) < 2e-4, `LOD${lod} normal ${vertex} is not unit length`);
        expect(Math.abs(tLength - 1) < 2e-4, `LOD${lod} tangent ${vertex} is not unit length`);
        expect(Math.abs(dot) < 2e-4, `LOD${lod} tangent ${vertex} is not orthogonal to its normal`);
        expect(Math.abs(Math.abs(tangent[ti + 3]) - 1) < 1e-6, `LOD${lod} tangent ${vertex} has invalid handedness`);
    }

    const primitive = document.meshes?.[meshIndex]?.primitives?.[0];
    expect(primitive?.mode === undefined || primitive.mode === 4, `LOD${lod} is not triangles`);
    expect(primitive?.material === meshRepair.material, `LOD${lod} material assignment changed`);
    primitive.attributes = {
        POSITION: appendAccessor({ array: position, width: 3, type: 'VEC3', componentType: 5126, target: 34962, bounds: true }),
        NORMAL: appendAccessor({ array: normal, width: 3, type: 'VEC3', componentType: 5126, target: 34962 }),
        TANGENT: appendAccessor({ array: tangent, width: 4, type: 'VEC4', componentType: 5126, target: 34962 }),
        TEXCOORD_0: appendAccessor({ array: texcoord0, width: 2, type: 'VEC2', componentType: 5126, target: 34962 }),
        _AWIND: appendAccessor({ array: aWind, width: 1, type: 'SCALAR', componentType: 5126, target: 34962 }),
        _ASTEMCENTER: appendAccessor({ array: aStemCenter, width: 3, type: 'VEC3', componentType: 5126, target: 34962 }),
    };
    primitive.indices = appendAccessor({
        array: indices,
        width: 1,
        type: 'SCALAR',
        componentType: count <= 65535 ? 5123 : 5125,
        target: 34963,
        bounds: true,
    });
    primitive.mode = 4;
    patched.push({
        lod,
        meshIndex,
        vertices: count,
        triangles: meshRepair.triangles,
        triangleBudget,
        voxelSize: meshRepair.voxelSize,
        signedVolume: meshRepair.signedVolume,
        nearestSourceDistance: meshRepair.nearestSourceDistance,
        bounds: meshRepair.bounds,
        topology: meshRepair.topology,
    });
}

const repairedBinary = Buffer.concat(chunks, binaryLength);
document.buffers[0].byteLength = repairedBinary.length;
document.asset.extras = {
    ...(document.asset.extras ?? {}),
    eanpaTopologyRepair: {
        format: repair.format,
        sourceSha256: sourceHash,
        blenderVersion: repair.blenderVersion,
        pipeline: 'tools/repair-saguaro-blender.py + tools/patch-saguaro-glb.mjs',
        bodyLods: patched.map(({ lod, meshIndex, vertices, triangles, triangleBudget, voxelSize }) => ({
            lod,
            meshIndex,
            vertices,
            triangles,
            triangleBudget,
            voxelSize,
        })),
    },
};

expect(document.nodes?.length === original.nodes, 'Node count changed');
expect(document.meshes?.length === original.meshes, 'Mesh count changed');
expect(document.materials?.length === original.materials, 'Material count changed');
expect(document.textures?.length === original.textures, 'Texture count changed');
expect(document.images?.length === original.images, 'Image count changed');
expect(JSON.stringify(document.extensionsUsed ?? []) === JSON.stringify(original.extensionsUsed), 'extensionsUsed changed');

let jsonChunk = Buffer.from(JSON.stringify(document), 'utf8');
const jsonLength = align4(jsonChunk.length);
if (jsonLength !== jsonChunk.length) jsonChunk = Buffer.concat([jsonChunk, Buffer.alloc(jsonLength - jsonChunk.length, 0x20)]);
let binChunk = repairedBinary;
const binLength = align4(binChunk.length);
if (binLength !== binChunk.length) binChunk = Buffer.concat([binChunk, Buffer.alloc(binLength - binChunk.length)]);
const outputBytes = Buffer.alloc(12 + 8 + jsonChunk.length + 8 + binChunk.length);
outputBytes.write('glTF', 0, 4, 'ascii');
outputBytes.writeUInt32LE(2, 4);
outputBytes.writeUInt32LE(outputBytes.length, 8);
let cursor = 12;
outputBytes.writeUInt32LE(jsonChunk.length, cursor);
outputBytes.writeUInt32LE(0x4e4f534a, cursor + 4);
jsonChunk.copy(outputBytes, cursor + 8);
cursor += 8 + jsonChunk.length;
outputBytes.writeUInt32LE(binChunk.length, cursor);
outputBytes.writeUInt32LE(0x004e4942, cursor + 4);
binChunk.copy(outputBytes, cursor + 8);

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, outputBytes);
const outputHash = sha256(outputBytes);
const report = {
    format: 'eanpa-saguaro-glb-patch/1',
    input: inputPath,
    inputBytes: sourceBytes.length,
    inputSha256: sourceHash,
    backup: backupPath,
    repair: repairPath,
    output: outputPath,
    outputBytes: outputBytes.length,
    outputSha256: outputHash,
    preserved: original,
    appended: {
        accessors: document.accessors.length - original.accessors,
        bufferViews: document.bufferViews.length - original.bufferViews,
    },
    patched,
};
await mkdir(dirname(reportPath), { recursive: true });
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(JSON.stringify(report, null, 2));
