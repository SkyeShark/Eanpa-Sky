#!/usr/bin/env node

// Read-only GLB metadata audit. This intentionally avoids constructing a
// renderer so vegetation LOD diagnostics cannot contaminate GPU benchmarks.

import { readFile } from 'node:fs/promises';

const files = process.argv.slice(2);
if (!files.length) {
    files.push(
        'assets/vegetation/joshuaTree_seed555.glb',
        'assets/vegetation/saguaro_seed555.glb',
    );
}

for (const file of files) {
    const bytes = await readFile(file);
    if (bytes.toString('ascii', 0, 4) !== 'glTF') {
        throw new Error(`${file} is not a binary glTF file`);
    }
    const jsonLength = bytes.readUInt32LE(12);
    const jsonType = bytes.toString('ascii', 16, 20);
    if (jsonType !== 'JSON') throw new Error(`${file} has no leading JSON chunk`);
    const gltf = JSON.parse(bytes.subarray(20, 20 + jsonLength).toString('utf8').replace(/\0+$/, ''));
    const nodes = (gltf.nodes ?? []).map((node, index) => ({
        index,
        name: node.name ?? '',
        mesh: node.mesh ?? null,
        children: node.children ?? [],
        extensions: Object.keys(node.extensions ?? {}),
    }));
    const meshes = (gltf.meshes ?? []).map((mesh, index) => {
        let positions = 0;
        let triangles = 0;
        const primitives = (mesh.primitives ?? []).map((primitive) => {
            const positionCount = gltf.accessors?.[primitive.attributes?.POSITION]?.count ?? 0;
            const indexCount = primitive.indices === undefined
                ? 0
                : gltf.accessors?.[primitive.indices]?.count ?? 0;
            positions += positionCount;
            triangles += (indexCount || positionCount) / 3;
            return {
                positionCount,
                indexCount,
                material: primitive.material ?? null,
                mode: primitive.mode ?? 4,
            };
        });
        return { index, name: mesh.name ?? '', positions, triangles, primitives };
    });
    const materials = (gltf.materials ?? []).map((material, index) => ({
        index,
        name: material.name ?? '',
        doubleSided: Boolean(material.doubleSided),
        alphaMode: material.alphaMode ?? 'OPAQUE',
        alphaCutoff: material.alphaCutoff ?? 0.5,
        emissiveFactor: material.emissiveFactor ?? [0, 0, 0],
        pbr: material.pbrMetallicRoughness ?? {},
        normalTexture: material.normalTexture ?? null,
        occlusionTexture: material.occlusionTexture ?? null,
        emissiveTexture: material.emissiveTexture ?? null,
        extensions: material.extensions ?? {},
    }));
    console.log(JSON.stringify({
        file,
        counts: {
            nodes: nodes.length,
            meshes: meshes.length,
            accessors: gltf.accessors?.length ?? 0,
            materials: gltf.materials?.length ?? 0,
        },
        lodNodes: nodes.filter((node) => /lod|billboard/i.test(node.name)
            || node.extensions.includes('MSFT_lod')),
        materials,
        textures: gltf.textures ?? [],
        images: (gltf.images ?? []).map((image, index) => ({
            index,
            name: image.name ?? '',
            mimeType: image.mimeType ?? null,
            uri: image.uri ?? null,
            bufferView: image.bufferView ?? null,
        })),
        meshes,
    }, null, 2));
}
