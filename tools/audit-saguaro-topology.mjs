#!/usr/bin/env node

// CPU-only acceptance audit for the repaired saguaro body LODs. It compares
// the production GLB with the hash-preserved SeedThree original, proves that
// non-body payloads stayed intact, and derives topology/frame metrics directly
// from accessors instead of trusting the Blender staging report.

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const currentPath = resolve(process.argv[2] ?? 'assets/vegetation/saguaro_seed555.glb');
const originalPath = resolve(process.argv[3] ?? 'artifacts/saguaro-topology-repair/saguaro_seed555_seedthree-original.glb');
const manifestPath = resolve('assets/vegetation/seed555-exports.json');

const COMPONENTS = {
    5120: { bytes: 1, get: 'getInt8' },
    5121: { bytes: 1, get: 'getUint8' },
    5122: { bytes: 2, get: 'getInt16' },
    5123: { bytes: 2, get: 'getUint16' },
    5125: { bytes: 4, get: 'getUint32' },
    5126: { bytes: 4, get: 'getFloat32' },
};
const WIDTHS = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };
const BODY_MESHES = [0, 2, 4];
const EXPECTED_TRIANGLES = [12640, 4352, 2016];
const BODY_BUDGETS = [12800, 4416, 2048];
const EXPECTED_SOURCE_DEFECTS = [
    // Boundary counts are measured after position canonicalisation and after
    // excluding zero-area triangles: they are the genuinely open root loops.
    { degenerateTriangles: 1664, boundaryEdges: 64, nonManifoldEdges: 192, oppositeNormalFaces: 140 },
    { degenerateTriangles: 832, boundaryEdges: 32, nonManifoldEdges: 96, oppositeNormalFaces: 89 },
    { degenerateTriangles: 416, boundaryEdges: 16, nonManifoldEdges: 48, oppositeNormalFaces: 47 },
];

const parseGlb = async (path) => {
    const bytes = await readFile(path);
    if (bytes.toString('ascii', 0, 4) !== 'glTF' || bytes.readUInt32LE(4) !== 2) {
        throw new Error(`${path} is not a glTF 2 GLB`);
    }
    if (bytes.readUInt32LE(8) !== bytes.length) throw new Error(`${path}: header length mismatch`);
    let cursor = 12;
    let json = null;
    let binary = null;
    while (cursor < bytes.length) {
        const length = bytes.readUInt32LE(cursor);
        const type = bytes.readUInt32LE(cursor + 4);
        const payload = bytes.subarray(cursor + 8, cursor + 8 + length);
        cursor += 8 + length;
        if (type === 0x4e4f534a) json = JSON.parse(payload.toString('utf8').replace(/[\0 ]+$/, ''));
        if (type === 0x004e4942) binary = payload;
    }
    if (!json || !binary) throw new Error(`${path}: missing JSON or BIN chunk`);
    return { bytes, json, binary };
};

const [current, original, manifest] = await Promise.all([
    parseGlb(currentPath),
    parseGlb(originalPath),
    readFile(manifestPath, 'utf8').then(JSON.parse),
]);
const currentHash = createHash('sha256').update(current.bytes).digest('hex');
const manifestEntry = manifest.exports?.find(({ file }) => file === 'saguaro_seed555.glb');

const readAccessor = (glb, index) => {
    const accessor = glb.json.accessors[index];
    const view = glb.json.bufferViews[accessor.bufferView];
    const component = COMPONENTS[accessor.componentType];
    const width = WIDTHS[accessor.type];
    if (!component || !width) throw new Error(`Unsupported accessor ${index}`);
    const stride = view.byteStride ?? component.bytes * width;
    const offset = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
    const data = new DataView(glb.binary.buffer, glb.binary.byteOffset, glb.binary.byteLength);
    const rows = new Array(accessor.count);
    for (let row = 0; row < accessor.count; row++) {
        const values = new Array(width);
        for (let column = 0; column < width; column++) {
            values[column] = data[component.get](
                offset + row * stride + column * component.bytes,
                true,
            );
        }
        rows[row] = values;
    }
    return rows;
};

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const length = (value) => Math.hypot(...value);

const inspectMesh = (glb, meshIndex) => {
    const primitive = glb.json.meshes[meshIndex].primitives[0];
    const position = readAccessor(glb, primitive.attributes.POSITION);
    const normal = readAccessor(glb, primitive.attributes.NORMAL);
    const uv = readAccessor(glb, primitive.attributes.TEXCOORD_0);
    const tangent = primitive.attributes.TANGENT === undefined
        ? null
        : readAccessor(glb, primitive.attributes.TANGENT);
    const indices = readAccessor(glb, primitive.indices).flat();
    const canonicalByPosition = new Map();
    const canonical = position.map((value) => {
        const key = value.map((component) => Math.round(component * 1e4)).join(':');
        if (!canonicalByPosition.has(key)) canonicalByPosition.set(key, canonicalByPosition.size);
        return canonicalByPosition.get(key);
    });
    const edges = new Map();
    const adjacency = Array.from({ length: canonicalByPosition.size }, () => []);
    let degenerateTriangles = 0;
    let oppositeNormalFaces = 0;
    let signedVolume = 0;
    let minFaceNormalDot = Infinity;
    for (let offset = 0; offset < indices.length; offset += 3) {
        const ids = indices.slice(offset, offset + 3);
        const topologyIds = ids.map((id) => canonical[id]);
        const [a, b, c] = ids.map((id) => position[id]);
        const face = cross(sub(b, a), sub(c, a));
        const faceLength = length(face);
        if (new Set(topologyIds).size < 3 || faceLength <= 1e-9) {
            degenerateTriangles++;
            continue;
        }
        const averageNormal = [0, 1, 2].map((axis) => (
            normal[ids[0]][axis] + normal[ids[1]][axis] + normal[ids[2]][axis]
        ) / 3);
        const faceNormalDot = dot(face, averageNormal) / faceLength;
        minFaceNormalDot = Math.min(minFaceNormalDot, faceNormalDot);
        if (faceNormalDot < -1e-7) oppositeNormalFaces++;
        signedVolume += dot(a, cross(b, c)) / 6;
        for (const [left, right] of [
            [topologyIds[0], topologyIds[1]],
            [topologyIds[1], topologyIds[2]],
            [topologyIds[2], topologyIds[0]],
        ]) {
            const low = Math.min(left, right);
            const high = Math.max(left, right);
            const key = `${low}:${high}`;
            const entry = edges.get(key) ?? { count: 0, direction: 0 };
            entry.count++;
            entry.direction += left === low ? 1 : -1;
            edges.set(key, entry);
            adjacency[left].push(right);
            adjacency[right].push(left);
        }
    }
    let components = 0;
    const visited = new Uint8Array(canonicalByPosition.size);
    for (let start = 0; start < canonicalByPosition.size; start++) {
        if (visited[start] || adjacency[start].length === 0) continue;
        components++;
        const pending = [start];
        visited[start] = 1;
        while (pending.length) {
            const vertex = pending.pop();
            for (const next of adjacency[vertex]) if (!visited[next]) {
                visited[next] = 1;
                pending.push(next);
            }
        }
    }
    let invalidNormals = 0;
    let invalidTangents = 0;
    let maxNormalLengthError = 0;
    let maxTangentLengthError = 0;
    let maxNormalTangentDot = 0;
    for (let index = 0; index < position.length; index++) {
        const nLength = length(normal[index]);
        maxNormalLengthError = Math.max(maxNormalLengthError, Math.abs(nLength - 1));
        if (!normal[index].every(Number.isFinite) || Math.abs(nLength - 1) >= 2e-4) invalidNormals++;
        if (!uv[index].every(Number.isFinite)) invalidTangents++;
        if (tangent) {
            const tLength = length(tangent[index].slice(0, 3));
            const orthogonality = Math.abs(dot(normal[index], tangent[index].slice(0, 3)));
            maxTangentLengthError = Math.max(maxTangentLengthError, Math.abs(tLength - 1));
            maxNormalTangentDot = Math.max(maxNormalTangentDot, orthogonality);
            if (!tangent[index].every(Number.isFinite)
                || Math.abs(tLength - 1) >= 2e-4
                || orthogonality >= 2e-4
                || Math.abs(Math.abs(tangent[index][3]) - 1) >= 1e-6) invalidTangents++;
        }
    }
    return {
        vertices: position.length,
        triangles: indices.length / 3,
        material: primitive.material,
        attributes: Object.keys(primitive.attributes).sort(),
        degenerateTriangles,
        boundaryEdges: [...edges.values()].filter(({ count }) => count === 1).length,
        nonManifoldEdges: [...edges.values()].filter(({ count }) => count > 2).length,
        orientationConflictEdges: [...edges.values()].filter(({ count, direction }) => count === 2 && direction !== 0).length,
        maxEdgeIncidence: Math.max(...[...edges.values()].map(({ count }) => count)),
        components,
        signedVolume,
        oppositeNormalFaces,
        minFaceNormalDot,
        invalidNormals,
        invalidTangents,
        maxNormalLengthError,
        maxTangentLengthError,
        maxNormalTangentDot,
        bounds: {
            min: [0, 1, 2].map((axis) => Math.min(...position.map((value) => value[axis]))),
            max: [0, 1, 2].map((axis) => Math.max(...position.map((value) => value[axis]))),
        },
    };
};

const currentMetrics = BODY_MESHES.map((mesh) => inspectMesh(current, mesh));
const originalMetrics = BODY_MESHES.map((mesh) => inspectMesh(original, mesh));
const checks = [];
const check = (condition, label, evidence = undefined) => checks.push({
    label,
    pass: Boolean(condition),
    ...(evidence === undefined ? {} : { evidence }),
});

check(
    current.binary.subarray(0, original.binary.length).equals(original.binary),
    'original BIN chunk is an exact prefix; spine, billboard, image, and source bytes are untouched',
);
check(
    JSON.stringify(current.json.nodes) === JSON.stringify(original.json.nodes),
    'node hierarchy and MSFT_lod links are unchanged',
);
for (const key of ['materials', 'textures', 'images', 'samplers']) check(
    JSON.stringify(current.json[key]) === JSON.stringify(original.json[key]),
    `${key} are unchanged`,
);
for (const mesh of [1, 3, 5, 6]) check(
    JSON.stringify(current.json.meshes[mesh]) === JSON.stringify(original.json.meshes[mesh]),
    `non-body mesh ${mesh} (spines/billboards) is unchanged`,
);
check(
    JSON.stringify(current.json.accessors.slice(0, original.json.accessors.length))
        === JSON.stringify(original.json.accessors),
    'all original accessors remain unchanged',
);
check(
    JSON.stringify(current.json.bufferViews.slice(0, original.json.bufferViews.length))
        === JSON.stringify(original.json.bufferViews),
    'all original buffer views remain unchanged',
);
check(
    current.json.extensionsUsed?.includes('MSFT_lod')
        && current.json.extensionsUsed?.includes('KHR_materials_diffuse_transmission'),
    'MSFT_lod and authored spine transmission extensions remain declared',
);
check(
    current.json.asset?.extras?.eanpaTopologyRepair?.sourceSha256
        === '11518ba347df150bb7d9cc5efb207e98d9388523a7c8cfa38a03a427ec3d6761',
    'repair provenance identifies the exact SeedThree source hash',
);
check(
    manifestEntry?.sha256 === currentHash && manifestEntry?.bytes === current.bytes.length,
    'vegetation export manifest matches the repaired GLB hash and byte length',
    {
        hash: currentHash,
        bytes: current.bytes.length,
        manifestHash: manifestEntry?.sha256,
        manifestBytes: manifestEntry?.bytes,
    },
);
check(
    manifestEntry?.postprocess?.sourceSha256
        === '11518ba347df150bb7d9cc5efb207e98d9388523a7c8cfa38a03a427ec3d6761'
        && manifestEntry?.postprocess?.pipeline?.includes('tools/repair-saguaro-blender.py')
        && manifestEntry?.postprocess?.pipeline?.includes('tools/patch-saguaro-glb.mjs'),
    'manifest records the exact original and both deterministic repair stages',
);

for (let lod = 0; lod < 3; lod++) {
    const metric = currentMetrics[lod];
    const source = originalMetrics[lod];
    const expectedDefects = EXPECTED_SOURCE_DEFECTS[lod];
    check(
        metric.triangles === EXPECTED_TRIANGLES[lod]
            && metric.triangles <= BODY_BUDGETS[lod]
            && metric.triangles >= BODY_BUDGETS[lod] * 0.9,
        `LOD${lod} remains within its authored body budget`,
        { triangles: metric.triangles, budget: BODY_BUDGETS[lod] },
    );
    check(
        metric.degenerateTriangles === 0
            && metric.boundaryEdges === 0
            && metric.nonManifoldEdges === 0
            && metric.orientationConflictEdges === 0
            && metric.maxEdgeIncidence === 2
            && metric.components === 1,
        `LOD${lod} is one closed, consistently oriented two-manifold component`,
        metric,
    );
    check(
        metric.signedVolume > 0
            && metric.oppositeNormalFaces === 0
            && metric.minFaceNormalDot > 0,
        `LOD${lod} winding and authored normals point outward`,
        {
            signedVolume: metric.signedVolume,
            oppositeNormalFaces: metric.oppositeNormalFaces,
            minFaceNormalDot: metric.minFaceNormalDot,
        },
    );
    check(
        metric.invalidNormals === 0
            && metric.invalidTangents === 0
            && metric.maxNormalLengthError < 2e-4
            && metric.maxTangentLengthError < 2e-4
            && metric.maxNormalTangentDot < 2e-4,
        `LOD${lod} has finite unit normals and orthonormal tangent frames`,
        {
            maxNormalLengthError: metric.maxNormalLengthError,
            maxTangentLengthError: metric.maxTangentLengthError,
            maxNormalTangentDot: metric.maxNormalTangentDot,
        },
    );
    check(
        metric.material === 0
            && ['NORMAL', 'POSITION', 'TANGENT', 'TEXCOORD_0', '_ASTEMCENTER', '_AWIND']
                .every((attribute) => metric.attributes.includes(attribute)),
        `LOD${lod} retains skin material 0, UVs, wind data, stem centres, and gains tangents`,
        { material: metric.material, attributes: metric.attributes },
    );
    check(
        ['degenerateTriangles', 'boundaryEdges', 'nonManifoldEdges', 'oppositeNormalFaces']
            .every((key) => source[key] === expectedDefects[key]),
        `LOD${lod} source defects are reproducibly measured`,
        {
            measured: Object.fromEntries(Object.keys(expectedDefects).map((key) => [key, source[key]])),
            expected: expectedDefects,
        },
    );
    const boundDelta = Math.max(
        ...metric.bounds.min.map((value, axis) => Math.abs(value - source.bounds.min[axis])),
        ...metric.bounds.max.map((value, axis) => Math.abs(value - source.bounds.max[axis])),
    );
    check(
        boundDelta < 0.012,
        `LOD${lod} preserves the authored overall silhouette bounds within 1.2 cm`,
        { maximumBoundDelta: boundDelta },
    );
}

const failed = checks.filter(({ pass }) => !pass);
console.log(JSON.stringify({
    suite: 'saguaro-topology-static',
    assertions: checks.length,
    passed: checks.length - failed.length,
    failed,
    current: currentMetrics,
    sourceDefects: originalMetrics.map((metric) => ({
        vertices: metric.vertices,
        triangles: metric.triangles,
        degenerateTriangles: metric.degenerateTriangles,
        boundaryEdges: metric.boundaryEdges,
        nonManifoldEdges: metric.nonManifoldEdges,
        oppositeNormalFaces: metric.oppositeNormalFaces,
    })),
}, null, 2));

if (failed.length) process.exitCode = 1;
