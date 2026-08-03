#!/usr/bin/env node

// CPU-only structural audit for the two user-supplied desert cliff assets.
// The parser reads the GLB directly so it never creates a renderer or uploads
// the unusually high-resolution baked textures to the GPU.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ASSETS = [
    'assets/terrain/Desert_Cliff_Wide_Mesa_Low.glb',
    'assets/terrain/Desert_Cliff_Mesa_High.glb',
];

const COMPONENTS = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };
const COMPONENT_BYTES = { 5121: 1, 5123: 2, 5125: 4, 5126: 4 };

function parseGlb(filename) {
    const bytes = fs.readFileSync(filename);
    if (bytes.toString('ascii', 0, 4) !== 'glTF') throw new Error(`${filename} is not a GLB`);
    if (bytes.readUInt32LE(4) !== 2) throw new Error(`${filename} is not glTF 2.0`);
    if (bytes.readUInt32LE(8) !== bytes.length) throw new Error(`${filename} has an invalid byte length`);
    let offset = 12;
    let json = null;
    let binary = null;
    while (offset < bytes.length) {
        const length = bytes.readUInt32LE(offset); offset += 4;
        const type = bytes.readUInt32LE(offset); offset += 4;
        const chunk = bytes.subarray(offset, offset + length); offset += length;
        if (type === 0x4e4f534a) json = JSON.parse(chunk.toString('utf8').replace(/\0+$/g, '').trim());
        if (type === 0x004e4942) binary = chunk;
    }
    if (!json || !binary) throw new Error(`${filename} is missing JSON or BIN data`);
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
    if (binary.subarray(offset, offset + 8).toString('hex') !== '89504e470d0a1a0a') return null;
    return {
        width: binary.readUInt32BE(offset + 16),
        height: binary.readUInt32BE(offset + 20),
        bitDepth: binary[offset + 24],
        colorType: binary[offset + 25],
        encodedBytes: view.byteLength,
    };
}

function vectorBounds(reader) {
    const components = COMPONENTS[reader.accessor.type];
    const minimum = Array(components).fill(Infinity);
    const maximum = Array(components).fill(-Infinity);
    for (let index = 0; index < reader.accessor.count; index++) {
        for (let component = 0; component < components; component++) {
            const value = reader.get(index, component);
            minimum[component] = Math.min(minimum[component], value);
            maximum[component] = Math.max(maximum[component], value);
        }
    }
    return { minimum, maximum, extent: minimum.map((value, index) => maximum[index] - value) };
}

function geometryReport(gltf, binary, primitive) {
    const position = accessorReader(gltf, binary, primitive.attributes.POSITION);
    const normal = accessorReader(gltf, binary, primitive.attributes.NORMAL);
    const uv = accessorReader(gltf, binary, primitive.attributes.TEXCOORD_0);
    const indices = accessorReader(gltf, binary, primitive.indices);
    const bounds = vectorBounds(position);
    const uvBounds = vectorBounds(uv);
    let minimumNormalLength = Infinity;
    let maximumNormalLength = -Infinity;
    let sumNormalLength = 0;
    for (let index = 0; index < normal.accessor.count; index++) {
        const length = Math.hypot(normal.get(index, 0), normal.get(index, 1), normal.get(index, 2));
        minimumNormalLength = Math.min(minimumNormalLength, length);
        maximumNormalLength = Math.max(maximumNormalLength, length);
        sumNormalLength += length;
    }
    let degenerateTriangles = 0;
    let opposedNormalTriangles = 0;
    let minimumFaceNormalDot = Infinity;
    let signedVolume6 = 0;
    const rawEdges = new Map();
    const weldedEdges = new Map();
    const weldedVertex = new Map();
    const weldedIndex = [];
    const weldScale = 1e6;
    for (let index = 0; index < position.accessor.count; index++) {
        const key = `${Math.round(position.get(index, 0) * weldScale)}:${Math.round(position.get(index, 1) * weldScale)}:${Math.round(position.get(index, 2) * weldScale)}`;
        if (!weldedVertex.has(key)) weldedVertex.set(key, weldedVertex.size);
        weldedIndex[index] = weldedVertex.get(key);
    }
    const addEdge = (map, a, b) => {
        const key = a < b ? `${a}:${b}` : `${b}:${a}`;
        map.set(key, (map.get(key) ?? 0) + 1);
    };
    for (let offset = 0; offset < indices.accessor.count; offset += 3) {
        const a = indices.get(offset), b = indices.get(offset + 1), c = indices.get(offset + 2);
        const ax = position.get(a, 0), ay = position.get(a, 1), az = position.get(a, 2);
        const abx = position.get(b, 0) - ax, aby = position.get(b, 1) - ay, abz = position.get(b, 2) - az;
        const acx = position.get(c, 0) - ax, acy = position.get(c, 1) - ay, acz = position.get(c, 2) - az;
        const nx = aby * acz - abz * acy;
        const ny = abz * acx - abx * acz;
        const nz = abx * acy - aby * acx;
        const faceLength = Math.hypot(nx, ny, nz);
        if (faceLength <= 1e-12) degenerateTriangles++;
        else {
            const averageX = normal.get(a, 0) + normal.get(b, 0) + normal.get(c, 0);
            const averageY = normal.get(a, 1) + normal.get(b, 1) + normal.get(c, 1);
            const averageZ = normal.get(a, 2) + normal.get(b, 2) + normal.get(c, 2);
            const averageLength = Math.hypot(averageX, averageY, averageZ) || 1;
            const dot = (nx * averageX + ny * averageY + nz * averageZ) / (faceLength * averageLength);
            minimumFaceNormalDot = Math.min(minimumFaceNormalDot, dot);
            if (dot < -1e-4) opposedNormalTriangles++;
        }
        const bx = position.get(b, 0), by = position.get(b, 1), bz = position.get(b, 2);
        const cx = position.get(c, 0), cy = position.get(c, 1), cz = position.get(c, 2);
        signedVolume6 += ax * (by * cz - bz * cy)
            + ay * (bz * cx - bx * cz)
            + az * (bx * cy - by * cx);
        for (const [u, v] of [[a, b], [b, c], [c, a]]) {
            addEdge(rawEdges, u, v);
            addEdge(weldedEdges, weldedIndex[u], weldedIndex[v]);
        }
    }
    const countBadEdges = (edges) => [...edges.values()].filter((count) => count !== 2).length;
    return {
        vertices: position.accessor.count,
        triangles: indices.accessor.count / 3,
        bounds,
        pivotOffsetFromBoundsCenter: bounds.minimum.map((value, index) => (
            -(value + bounds.maximum[index]) * 0.5
        )),
        uvBounds,
        normals: {
            minimumLength: minimumNormalLength,
            maximumLength: maximumNormalLength,
            meanLength: sumNormalLength / normal.accessor.count,
            opposedTriangles: opposedNormalTriangles,
            minimumFaceNormalDot,
        },
        degenerateTriangles,
        rawNonTwoManifoldEdges: countBadEdges(rawEdges),
        weldedVertices: weldedVertex.size,
        weldedNonTwoManifoldEdges: countBadEdges(weldedEdges),
        signedVolume: signedVolume6 / 6,
    };
}

function assetReport(relativePath) {
    const filename = path.join(ROOT, relativePath);
    const { bytes, json: gltf, binary } = parseGlb(filename);
    const meshNodes = (gltf.nodes ?? []).filter((node) => Number.isInteger(node.mesh));
    if (meshNodes.length !== 1) throw new Error(`${relativePath} must contain one mesh node`);
    const mesh = gltf.meshes[meshNodes[0].mesh];
    if (mesh.primitives.length !== 1) throw new Error(`${relativePath} must contain one primitive`);
    const primitive = mesh.primitives[0];
    return {
        file: relativePath.replaceAll('\\', '/'),
        sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
        encodedBytes: bytes.length,
        generator: gltf.asset?.generator ?? '',
        node: meshNodes[0],
        material: gltf.materials?.[primitive.material] ?? null,
        images: (gltf.images ?? []).map((image) => ({
            name: image.name ?? '',
            mimeType: image.mimeType ?? '',
            ...pngHeader(binary, gltf.bufferViews[image.bufferView]),
        })),
        geometry: geometryReport(gltf, binary, primitive),
    };
}

const reports = ASSETS.map(assetReport);
const failures = [];
for (const report of reports) {
    const geometry = report.geometry;
    if (report.material?.pbrMetallicRoughness?.baseColorTexture === undefined) failures.push(`${report.file}: missing base-color map`);
    if (report.material?.pbrMetallicRoughness?.metallicRoughnessTexture === undefined) failures.push(`${report.file}: missing metallic/roughness map`);
    if (report.material?.normalTexture === undefined) failures.push(`${report.file}: missing normal map`);
    if (geometry.degenerateTriangles !== 0) failures.push(`${report.file}: ${geometry.degenerateTriangles} degenerate triangles`);
    const expectedMasterOpposed = report.file.includes('Mesa_High') ? 3 : 0;
    if (geometry.normals.opposedTriangles !== expectedMasterOpposed) {
        failures.push(`${report.file}: expected ${expectedMasterOpposed} immutable-source opposed faces, found ${geometry.normals.opposedTriangles}`);
    }
    if (geometry.normals.minimumLength < 0.999 || geometry.normals.maximumLength > 1.001) failures.push(`${report.file}: normals are not unit length`);
    if (geometry.bounds.extent[0] < 1.7 || geometry.bounds.extent[2] < 1.7) failures.push(`${report.file}: unexpected normalized horizontal extent`);
    if (report.images.length !== 3 || report.images.some((image) => image.mimeType !== 'image/png')) failures.push(`${report.file}: expected three embedded PNG maps`);
}
if (failures.length) {
    console.error(`Desert cliff asset audit failed (${failures.length})`);
    failures.forEach((failure) => console.error(`- ${failure}`));
    console.error(JSON.stringify(reports, null, 2));
    process.exitCode = 1;
} else {
    console.log(`Desert cliff asset audit passed (${reports.length} assets)`);
    console.log(JSON.stringify(reports, null, 2));
}
