#!/usr/bin/env node

// Remove embedded duplicate materials/images from a perimeter GLB while
// preserving its exact mesh/accessor/node data. The four Eidoverse modules
// carry byte-identical 2K PBR textures; the browser loads them once from the
// gate, and temple_real.js shares that material across these geometry GLBs.

import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const JSON_CHUNK = 0x4e4f534a;
const BIN_CHUNK = 0x004e4942;
const GLB_MAGIC = 0x46546c67;

function align4(value) {
    return (value + 3) & ~3;
}

function parseGlb(bytes) {
    if (bytes.readUInt32LE(0) !== GLB_MAGIC || bytes.readUInt32LE(4) !== 2) {
        throw new Error('Expected a glTF 2.0 GLB');
    }
    let json = null;
    let binary = Buffer.alloc(0);
    for (let offset = 12; offset < bytes.length;) {
        const length = bytes.readUInt32LE(offset);
        const type = bytes.readUInt32LE(offset + 4);
        const body = bytes.subarray(offset + 8, offset + 8 + length);
        if (type === JSON_CHUNK) {
            json = JSON.parse(body.toString('utf8').replace(/[\u0000\u0020]+$/g, ''));
        } else if (type === BIN_CHUNK) {
            binary = body;
        }
        offset += 8 + length;
    }
    if (!json) throw new Error('GLB has no JSON chunk');
    return { json, binary };
}

function collectGeometryViews(json) {
    const views = new Set();
    for (const accessor of json.accessors ?? []) {
        if (accessor.bufferView !== undefined) views.add(accessor.bufferView);
        if (accessor.sparse?.indices?.bufferView !== undefined) views.add(accessor.sparse.indices.bufferView);
        if (accessor.sparse?.values?.bufferView !== undefined) views.add(accessor.sparse.values.bufferView);
    }
    for (const mesh of json.meshes ?? []) {
        for (const primitive of mesh.primitives ?? []) {
            const draco = primitive.extensions?.KHR_draco_mesh_compression;
            if (draco?.bufferView !== undefined) views.add(draco.bufferView);
        }
    }
    return views;
}

function remapGeometryViews(json, binary) {
    const wanted = [...collectGeometryViews(json)].sort((a, b) => a - b);
    const mapping = new Map();
    const chunks = [];
    let byteOffset = 0;
    const bufferViews = [];

    for (const oldIndex of wanted) {
        const source = json.bufferViews?.[oldIndex];
        if (!source) throw new Error(`Missing bufferView ${oldIndex}`);
        if (source.extensions?.EXT_meshopt_compression) {
            throw new Error('EXT_meshopt_compression is not supported by this exact-data stripper');
        }
        const start = source.byteOffset ?? 0;
        const end = start + source.byteLength;
        const payload = binary.subarray(start, end);
        const aligned = align4(byteOffset);
        if (aligned > byteOffset) chunks.push(Buffer.alloc(aligned - byteOffset));
        byteOffset = aligned;
        mapping.set(oldIndex, bufferViews.length);
        bufferViews.push({ ...source, buffer: 0, byteOffset });
        chunks.push(payload);
        byteOffset += payload.length;
    }

    for (const accessor of json.accessors ?? []) {
        if (accessor.bufferView !== undefined) accessor.bufferView = mapping.get(accessor.bufferView);
        if (accessor.sparse?.indices?.bufferView !== undefined) {
            accessor.sparse.indices.bufferView = mapping.get(accessor.sparse.indices.bufferView);
        }
        if (accessor.sparse?.values?.bufferView !== undefined) {
            accessor.sparse.values.bufferView = mapping.get(accessor.sparse.values.bufferView);
        }
    }
    for (const mesh of json.meshes ?? []) {
        for (const primitive of mesh.primitives ?? []) {
            const draco = primitive.extensions?.KHR_draco_mesh_compression;
            if (draco?.bufferView !== undefined) draco.bufferView = mapping.get(draco.bufferView);
        }
    }

    const compact = Buffer.concat(chunks);
    json.bufferViews = bufferViews;
    json.buffers = [{ byteLength: compact.length }];
    return compact;
}

function removeMaterialPayload(json) {
    delete json.images;
    delete json.textures;
    delete json.samplers;
    json.materials = [{
        name: 'shared_perimeter_material_placeholder',
        pbrMetallicRoughness: {
            baseColorFactor: [1, 1, 1, 1],
            metallicFactor: 0,
            roughnessFactor: 1,
        },
    }];
    for (const mesh of json.meshes ?? []) {
        for (const primitive of mesh.primitives ?? []) primitive.material = 0;
    }
    const stillUsed = (name) => !name.startsWith('KHR_materials_')
        && name !== 'KHR_texture_transform' && name !== 'EXT_texture_webp';
    if (json.extensionsUsed) json.extensionsUsed = json.extensionsUsed.filter(stillUsed);
    if (json.extensionsRequired) json.extensionsRequired = json.extensionsRequired.filter(stillUsed);
    if (!json.extensionsUsed?.length) delete json.extensionsUsed;
    if (!json.extensionsRequired?.length) delete json.extensionsRequired;
}

function encodeGlb(json, binary) {
    const jsonBytes = Buffer.from(JSON.stringify(json), 'utf8');
    const jsonLength = align4(jsonBytes.length);
    const binLength = align4(binary.length);
    const total = 12 + 8 + jsonLength + 8 + binLength;
    const output = Buffer.alloc(total, 0);
    output.writeUInt32LE(GLB_MAGIC, 0);
    output.writeUInt32LE(2, 4);
    output.writeUInt32LE(total, 8);
    output.writeUInt32LE(jsonLength, 12);
    output.writeUInt32LE(JSON_CHUNK, 16);
    jsonBytes.copy(output, 20);
    output.fill(0x20, 20 + jsonBytes.length, 20 + jsonLength);
    const binHeader = 20 + jsonLength;
    output.writeUInt32LE(binLength, binHeader);
    output.writeUInt32LE(BIN_CHUNK, binHeader + 4);
    binary.copy(output, binHeader + 8);
    return output;
}

const [inputArg, outputArg] = process.argv.slice(2);
if (!inputArg || !outputArg) {
    throw new Error('Usage: node tools/strip-perimeter-glb.mjs <input.glb> <output.glb>');
}

const input = resolve(inputArg);
const output = resolve(outputArg);
const { json, binary } = parseGlb(await readFile(input));
removeMaterialPayload(json);
const compactBinary = remapGeometryViews(json, binary);
const encoded = encodeGlb(json, compactBinary);
await writeFile(output, encoded);
console.log(JSON.stringify({ input, output, bytes: encoded.length }, null, 2));
