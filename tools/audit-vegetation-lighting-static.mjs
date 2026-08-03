#!/usr/bin/env node

// CPU-only acceptance audit for vegetation material/light integration.
// It parses source text and the JSON chunks of the authored GLBs; it never
// constructs a renderer, opens a browser, or submits GPU work.

import { readFile } from 'node:fs/promises';

const readText = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const readGlb = async (path) => {
    const bytes = await readFile(new URL(`../${path}`, import.meta.url));
    if (bytes.toString('ascii', 0, 4) !== 'glTF') throw new Error(`${path}: not a GLB`);
    let cursor = 12;
    let json = null;
    let binary = null;
    while (cursor < bytes.length) {
        const length = bytes.readUInt32LE(cursor);
        const type = bytes.readUInt32LE(cursor + 4);
        const payload = bytes.subarray(cursor + 8, cursor + 8 + length);
        cursor += 8 + length;
        if (type === 0x4e4f534a) {
            json = JSON.parse(payload.toString('utf8').replace(/[\0 ]+$/, ''));
        } else if (type === 0x004e4942) {
            binary = payload;
        }
    }
    if (!json || !binary) throw new Error(`${path}: missing JSON or BIN chunk`);
    return { json, binary };
};

const [
    vegetation, main, weatherSky, sky, joshuaAsset, saguaroAsset, placementLayoutText,
] = await Promise.all([
    readText('src/vegetation.js'),
    readText('src/main.js'),
    readText('src/weathersky.js'),
    readText('engine/sky_system.js'),
    readGlb('assets/vegetation/joshuaTree_seed555.glb'),
    readGlb('assets/vegetation/saguaro_seed555.glb'),
    readText('assets/vegetation/desert_vegetation_layout_v1.json'),
]);
const joshua = joshuaAsset.json;
const saguaro = saguaroAsset.json;
const placementLayout = JSON.parse(placementLayoutText);

const checks = [];
const check = (condition, label) => {
    checks.push({ label, pass: Boolean(condition) });
};
const materials = (gltf) => gltf.materials ?? [];
const hasDiffuseTransmission = (material) => (
    material.extensions?.KHR_materials_diffuse_transmission
);
const emissiveIsBlack = (material) => (
    (material.emissiveFactor ?? [0, 0, 0]).every((value) => value === 0)
    && material.emissiveTexture === undefined
);
const billboardTriangles = (gltf) => (gltf.nodes ?? [])
    .filter((node) => /billboard_(front|side)/i.test(node.name ?? ''))
    .map((node) => (gltf.meshes?.[node.mesh]?.primitives ?? [])
        .reduce((sum, primitive) => {
            const accessor = gltf.accessors?.[
                primitive.indices ?? primitive.attributes?.POSITION
            ];
            return sum + (accessor?.count ?? 0) / 3;
        }, 0));
const meshTriangles = (gltf, meshIndex) => (gltf.meshes?.[meshIndex]?.primitives ?? [])
    .reduce((sum, primitive) => {
        const accessor = gltf.accessors?.[
            primitive.indices ?? primitive.attributes?.POSITION
        ];
        return sum + (accessor?.count ?? 0) / 3;
    }, 0);
const lodTriangles = (gltf) => (gltf.nodes ?? [])
    .filter((node) => /_LOD[0-2]$/i.test(node.name ?? ''))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((root) => (root.children ?? [])
        .reduce((sum, childIndex) => {
            const child = gltf.nodes?.[childIndex];
            return sum + meshTriangles(gltf, child?.mesh);
        }, 0));

const COMPONENTS = {
    5120: { bytes: 1, get: 'getInt8' },
    5121: { bytes: 1, get: 'getUint8' },
    5122: { bytes: 2, get: 'getInt16' },
    5123: { bytes: 2, get: 'getUint16' },
    5125: { bytes: 4, get: 'getUint32' },
    5126: { bytes: 4, get: 'getFloat32' },
};
const WIDTHS = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };
const makeAccessorReader = (asset) => {
    const cache = new Map();
    const data = new DataView(
        asset.binary.buffer,
        asset.binary.byteOffset,
        asset.binary.byteLength,
    );
    return (index) => {
        if (cache.has(index)) return cache.get(index);
        const accessor = asset.json.accessors[index];
        const view = asset.json.bufferViews[accessor.bufferView];
        const component = COMPONENTS[accessor.componentType];
        const width = WIDTHS[accessor.type];
        const stride = view.byteStride ?? component.bytes * width;
        const start = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
        const rows = Array.from({ length: accessor.count }, (_, row) => (
            Array.from({ length: width }, (_, column) => data[component.get](
                start + row * stride + column * component.bytes,
                true,
            ))
        ));
        cache.set(index, rows);
        return rows;
    };
};
const joshuaLeafOrientation = (asset) => {
    const readAccessor = makeAccessorReader(asset);
    return [1, 3, 5].map((meshIndex, lod) => {
        let positive = 0, negative = 0, ambiguous = 0, degenerate = 0;
        let doubleArea = 0, signedArea = 0;
        for (const primitive of asset.json.meshes[meshIndex].primitives) {
            const position = readAccessor(primitive.attributes.POSITION);
            const normal = readAccessor(primitive.attributes.NORMAL);
            const indices = readAccessor(primitive.indices).flat();
            for (let offset = 0; offset < indices.length; offset += 3) {
                const [ia, ib, ic] = indices.slice(offset, offset + 3);
                const a = position[ia], b = position[ib], c = position[ic];
                const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
                const ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
                const face = [
                    ab[1] * ac[2] - ab[2] * ac[1],
                    ab[2] * ac[0] - ab[0] * ac[2],
                    ab[0] * ac[1] - ab[1] * ac[0],
                ];
                const area = Math.hypot(...face);
                if (area <= 1e-10) { degenerate++; continue; }
                const authored = [0, 1, 2].map((axis) => (
                    normal[ia][axis] + normal[ib][axis] + normal[ic][axis]
                ) / 3);
                const authoredLength = Math.hypot(...authored);
                const alignment = (
                    face[0] * authored[0] + face[1] * authored[1] + face[2] * authored[2]
                ) / (area * authoredLength);
                if (alignment < -0.02) negative++;
                else if (alignment > 0.02) positive++;
                else ambiguous++;
                doubleArea += area;
                signedArea += area * alignment;
            }
        }
        const oriented = positive + negative + ambiguous;
        return {
            lod, positive, negative, ambiguous, degenerate,
            positiveFraction: positive / oriented,
            negativeFraction: negative / oriented,
            areaWeightedAlignment: signedArea / doubleArea,
        };
    });
};

const joshuaBentNormalStats = (asset) => {
    const readAccessor = makeAccessorReader(asset);
    return [1, 3, 5].map((meshIndex, lod) => {
        const seen = new Set();
        let count = 0;
        let upward = 0;
        let meanY = 0;
        for (const primitive of asset.json.meshes[meshIndex].primitives) {
            const normalAccessor = primitive.attributes.NORMAL;
            const normals = readAccessor(normalAccessor);
            const indices = readAccessor(primitive.indices).flat();
            for (const index of indices) {
                const key = `${normalAccessor}:${index}`;
                if (seen.has(key)) continue;
                seen.add(key);
                const normal = normals[index];
                const length = Math.hypot(...normal);
                if (length <= 1e-10) continue;
                const y = normal[1] / length;
                count++;
                meanY += y;
                if (y > 0) upward++;
            }
        }
        return {
            lod,
            vertices: count,
            meanY: meanY / count,
            upwardFraction: upward / count,
        };
    });
};

const JOSHUA_BARK_WINDING_THRESHOLD = -0.02;
const joshuaBarkWindingRepairStats = (asset) => {
    const readAccessor = makeAccessorReader(asset);
    const alignmentAt = (position, normal, indices, offset) => {
        const ia = indices[offset];
        const ib = indices[offset + 1];
        const ic = indices[offset + 2];
        const abx = position[ib][0] - position[ia][0];
        const aby = position[ib][1] - position[ia][1];
        const abz = position[ib][2] - position[ia][2];
        const acx = position[ic][0] - position[ia][0];
        const acy = position[ic][1] - position[ia][1];
        const acz = position[ic][2] - position[ia][2];
        const faceX = aby * acz - abz * acy;
        const faceY = abz * acx - abx * acz;
        const faceZ = abx * acy - aby * acx;
        const normalX = normal[ia][0] + normal[ib][0] + normal[ic][0];
        const normalY = normal[ia][1] + normal[ib][1] + normal[ic][1];
        const normalZ = normal[ia][2] + normal[ib][2] + normal[ic][2];
        const faceLengthSq = faceX * faceX + faceY * faceY + faceZ * faceZ;
        const normalLengthSq = normalX * normalX + normalY * normalY + normalZ * normalZ;
        if (faceLengthSq <= 1e-24 || normalLengthSq <= 1e-24) return null;
        return (faceX * normalX + faceY * normalY + faceZ * normalZ)
            / Math.sqrt(faceLengthSq * normalLengthSq);
    };

    return [0, 2, 4].map((meshIndex, lod) => {
        let indexCount = 0;
        let repairedTriangles = 0;
        let degenerateTriangles = 0;
        let remainingStrongDisagreements = 0;
        for (const primitive of asset.json.meshes[meshIndex].primitives) {
            const position = readAccessor(primitive.attributes.POSITION);
            const normal = readAccessor(primitive.attributes.NORMAL);
            const indices = readAccessor(primitive.indices).flat();
            const repaired = indices.slice();
            indexCount += indices.length;
            for (let offset = 0; offset < repaired.length; offset += 3) {
                const alignment = alignmentAt(position, normal, repaired, offset);
                if (alignment === null) {
                    degenerateTriangles++;
                    continue;
                }
                if (alignment < JOSHUA_BARK_WINDING_THRESHOLD) {
                    [repaired[offset + 1], repaired[offset + 2]] = [
                        repaired[offset + 2], repaired[offset + 1],
                    ];
                    repairedTriangles++;
                }
            }
            for (let offset = 0; offset < repaired.length; offset += 3) {
                const alignment = alignmentAt(position, normal, repaired, offset);
                if (alignment !== null
                    && alignment < JOSHUA_BARK_WINDING_THRESHOLD) {
                    remainingStrongDisagreements++;
                }
            }
        }
        return {
            lod,
            repairedTriangles,
            degenerateTriangles,
            remainingStrongDisagreements,
            indexCountBefore: indexCount,
            indexCountAfter: indexCount,
        };
    });
};

const joshuaLodTriangles = lodTriangles(joshua);
const saguaroLodTriangles = lodTriangles(saguaro);
const joshuaBillboardTriangles = billboardTriangles(joshua);
const saguaroBillboardTriangles = billboardTriangles(saguaro);
const joshuaOrientation = joshuaLeafOrientation(joshuaAsset);
const joshuaBentNormals = joshuaBentNormalStats(joshuaAsset);
const joshuaBarkWindingRepair = joshuaBarkWindingRepairStats(joshuaAsset);

check(
    placementLayout.policy?.ecologyExclusions?.cliffMaximum === 0.025,
    'baked vegetation layout rejects authored cliff footprints',
);
check(
    placementLayout.policy?.ecologyExclusions?.routeMaximum === 0.035,
    'baked vegetation layout preserves the complete processional route',
);
check(
    /authoredProfile\s*=\s*\{\s*cuts:\s*\[60,\s*160,\s*420\]/.test(vegetation),
    'authored 60/160/420 geometry LOD cuts remain independent of sky quality',
);
check(
    /new T3\.InstancedMesh\(/.test(vegetation),
    'plant population remains GPU-instanced',
);
check(
    joshuaOrientation.every(({ positiveFraction, negativeFraction }) => (
        positiveFraction > 0.10 && negativeFraction > 0.10
    )),
    'authored Joshua/yucca shells demonstrably contain mixed winding in every mesh LOD',
);
check(
    !/reverseIndexedTriangleWinding/.test(vegetation)
        && /if \(isJoshua && !billboard\)/.test(vegetation)
        && /material\.normalNode = normalViewGeometry\.normalize\(\)/.test(vegetation)
        && !/positionViewDirection|facesViewer|authoredNormal\.negate\(\)/.test(vegetation)
        && !/faceForward\(/.test(vegetation),
    'Joshua mesh LODs use unflipped authored normals independent of winding and camera',
);
check(
    joshuaBentNormals.every(({ meanY, upwardFraction }) => (
        meanY > 0.75 && upwardFraction > 0.95
    )),
    'authored Joshua mesh normals are deliberately bent upward in every real LOD',
);
const barkRepairHelperStart = vegetation.indexOf(
    'const repairIndexedWindingToAuthoredNormals = (geometry) =>',
);
const barkRepairHelperEnd = vegetation.indexOf(
    'const ownMaterialResources = (material) =>',
    barkRepairHelperStart,
);
const barkRepairHelper = vegetation.slice(barkRepairHelperStart, barkRepairHelperEnd);
const barkRepairCall = vegetation.indexOf(
    'if (materialRole === \'joshua_bark\') {',
);
const barkBatchingStart = vegetation.indexOf('roleCounts.set(materialRole', barkRepairCall);
check(
    barkRepairHelperStart >= 0
        && /JOSHUA_BARK_WINDING_THRESHOLD\s*=\s*-0\.02/.test(vegetation)
        && /faceLengthSq\s*<=\s*1e-24/.test(barkRepairHelper)
        && /alignment\s*<\s*JOSHUA_BARK_WINDING_THRESHOLD/.test(barkRepairHelper)
        && /index\.setX\(offset \+ 1, ic\)/.test(barkRepairHelper)
        && /index\.setX\(offset \+ 2, ib\)/.test(barkRepairHelper),
    'Joshua bark repair swaps only strongly opposed nondegenerate triangle winding',
);
check(
    barkRepairCall > barkRepairHelperEnd
        && barkRepairCall < barkBatchingStart
        && (vegetation.match(/repairIndexedWindingToAuthoredNormals\(geometry\)/g) ?? []).length === 1
        && /geometry\.userData\.joshuaBarkWindingRepair/.test(vegetation)
        && /barkWindingRepairs\.push\(\{ lod: levelIndex/.test(vegetation),
    'winding repair is called only for classified Joshua bark before batching and records each LOD',
);
check(
    !/setAttribute|computeVertexNormals|normal\.set|position\.set/.test(barkRepairHelper),
    'bark repair preserves positions, authored normals, UVs, wind data, and stem centres',
);
check(
    joshuaBarkWindingRepair.map(({ repairedTriangles }) => repairedTriangles).join(',')
        === '1073,652,652'
        && joshuaBarkWindingRepair.every(({ remainingStrongDisagreements }) => (
            remainingStrongDisagreements === 0
        )),
    'raw LOD0/1/2 bark reproduces 1073/652/652 repairs and zero strong disagreements afterward',
);
check(
    joshuaBarkWindingRepair.every(({ indexCountBefore, indexCountAfter }) => (
        indexCountBefore === indexCountAfter
    ))
        && joshua.materials?.[0]?.doubleSided !== true
        && joshua.materials?.[0]?.normalTexture?.index !== undefined,
    'bark repair preserves triangle counts, FrontSide material intent, and authored normal map',
);
check(
    /isDenseJoshuaFoliage/.test(vegetation)
        && /batch\.castShadow\s*=\s*levelIndex\s*<=\s*1\s*&&\s*!isDenseJoshuaFoliage/.test(vegetation)
        && /batch\.receiveShadow\s*=\s*true/.test(vegetation),
    'dense Joshua/yucca foliage receives scene shadows without casting a self-blackening shell stack',
);
check(
    /SHADOW_PROXY_LAYER\s*=\s*3/.test(vegetation)
        && /SHADOW_PROXY_TARGET_LOD\s*=\s*2/.test(vegetation)
        && /SHADOW_PROXY_SOURCE_LOD\s*=\s*3/.test(vegetation),
    'LOD2 uses authored LOD3 cards on dedicated shadow-only layer 3',
);
check(
    /sourceMesh\.geometry,\s*sourceMesh\.material,\s*placements\.length/s.test(vegetation),
    'shadow proxy shares authored billboard geometry/material instead of duplicating dense LOD2',
);
check(
    /proxy\.layers\.set\(SHADOW_PROXY_LAYER\)/.test(vegetation)
        && /proxy\.castShadow\s*=\s*true/.test(vegetation)
        && /proxy\.receiveShadow\s*=\s*false/.test(vegetation),
    'proxy is shadow-only and cannot add a second lit plant surface',
);
check(
    /sun\.shadow\.camera\.layers\.enable\(3\)/.test(main)
        && (main.match(/\.camera\.layers\.enable\(3\)/g) ?? []).length === 1,
    'only the sun shadow camera enables vegetation proxy layer 3',
);
check(
    !/sun\.intensity\s*\*=/.test(main),
    'no post-sky multiplicative sun overdrive remains',
);
check(
    /sun\.intensity\s*=\s*Math\.max\(0\.08,\s*pal\.int\s*\*\s*1\.15\)/.test(sky),
    'sun intensity comes from the Eidoverse time-of-day calibration',
);
check(
    /material\.emissiveIntensity\s*=\s*0/.test(vegetation)
        && /material\.emissive\?\.set\?\.\(0x000000\)/.test(vegetation),
    'runtime vegetation explicitly disables emissive output',
);
check(
    /material\.diffuseTransmission\s*=\s*0/.test(vegetation)
        && /material\.transmission\s*=\s*0/.test(vegetation),
    'unshadowed exported transmission lobe is disabled',
);
check(
    /const n8aoAcceptance = !billboard && name === 'joshua' \? 0\.80 : 0/.test(vegetation)
        && /T3\.float\(n8aoAcceptance\)/.test(vegetation)
        && /material\.userData\.preserveSceneMrtOverride = true/.test(vegetation)
        && /m\.userData\?\.preserveSceneMrtOverride !== true/.test(main)
        && /m\.userData\?\.preserveSceneMrtOverride !== true/.test(weatherSky),
    'real Joshua LODs retain calibrated AO while card/spine masks survive both strippers',
);
check(
    /material\.userData\.noPuddles = true/.test(vegetation),
    'thin vegetation cutouts reject ground-only puddles while retaining wet sheen',
);
check(
    /const baseColor4 = T3\.vec4\(original \?\? T3\.materialColor\)[\s\S]*T3\.vec4\(baseColor4\.rgb\.mul\(shade\), baseColor4\.a\)/.test(sky),
    'cloud shadows shade foliage RGB without changing alpha-tested silhouettes',
);
check(
    ['joshua_green', 'joshua_dry', 'joshua_driest', 'healthy_damage_skin']
        .every((role) => vegetation.includes(role)),
    'Joshua green/dry/driest and saguaro healthy/damage roles remain distinct',
);
check(
    /projection:\s*'plant-local-3d-intersection'/.test(vegetation)
        && /positionLocal\.mul\(vec3\(2\.4, 0\.72, 2\.4\)\)/.test(vegetation)
        && /macroPatch\.mul\(detailPatch\)\.mul\(0\.28\)/.test(vegetation),
    'saguaro scars use bounded plant-local 3D patches with a 28% maximum blend',
);
check(
    vegetation.includes('yucca_rosette_dry_albedo.png')
        && vegetation.includes('yucca_rosette_dryest_albedo.png')
        && vegetation.includes('saguaro_skin_clean_albedo.png'),
    'supplemental authored role textures remain wired',
);
check(
    materials(joshua).every(emissiveIsBlack)
        && materials(saguaro).every(emissiveIsBlack),
    'raw GLB materials contain no emissive factor or texture',
);
check(
    materials(joshua).every((material) => !hasDiffuseTransmission(material)),
    'raw Joshua materials do not contain diffuse transmission',
);
const saguaroTransmission = materials(saguaro)
    .map(hasDiffuseTransmission)
    .filter(Boolean);
check(
    saguaroTransmission.length === 1
        && saguaroTransmission[0].diffuseTransmissionFactor === 1,
    'raw saguaro spine material is the sole full-strength transmission export',
);
check(
    joshuaBillboardTriangles.length === 2
        && joshuaBillboardTriangles.every((triangles) => triangles === 2)
        && saguaroBillboardTriangles.length === 2
        && saguaroBillboardTriangles.every((triangles) => triangles === 2),
    'each species provides exactly two two-triangle authored billboard cards for cheap shadows',
);
check(
    /ownedInstances\.add\(proxy\)/.test(vegetation)
        && /for \(const instance of ownedInstances\) instance\.dispose/.test(vegetation),
    'shadow-proxy instance buffers participate in normal vegetation disposal',
);
check(
    /const diagnosticState = \{\s*spinesVisible: true,\s*spinesCastShadow: true,\s*lod2ProxyCastShadow: true,\s*skinCastShadow: true,\s*skinReceiveShadow: true,\s*skinDoubleSided: false,/s.test(vegetation),
    'saguaro diagnostics default to the authored visible/shadowed/front-side behavior',
);
check(
    /mesh\.userData\.authoredCastShadow && diagnosticState\.spinesCastShadow/.test(vegetation)
        && /diagnosticState\.lod2ProxyCastShadow/.test(vegetation)
        && /diagnosticState\.skinDoubleSided/.test(vegetation),
    'diagnostics independently isolate spine shadows, LOD2 proxy shadows, and skin culling',
);
check(
    /globalThis\._vegetationDiagnostics = diagnosticApi/.test(vegetation)
        && /nearestSaguaro/.test(vegetation)
        && /globalThis\._vegetationDiagnostics === diagnosticApi/.test(vegetation),
    'CPU/CDP diagnostic API exposes nearest-instance lookup and is released on disposal',
);

const failed = checks.filter(({ pass }) => !pass);
console.log(JSON.stringify({
    suite: 'vegetation-lighting-static',
    assertions: checks.length,
    passed: checks.length - failed.length,
    failed,
    evidence: {
        instancing: true,
        authoredTriangles: {
            joshua: joshuaLodTriangles,
            saguaro: saguaroLodTriangles,
        },
        joshuaMixedWinding: joshuaOrientation,
        joshuaBentNormals,
        joshuaBarkWindingRepair,
        joshuaRuntimeLighting: {
            normalPolicy: 'unflipped-authored-vertex-normal',
            denseFoliageCastShadow: false,
            denseFoliageReceiveShadow: true,
            emissiveFill: false,
            n8aoAcceptance: 0.8,
        },
        lodCuts: [60, 160, 420],
        shadowProxy: {
            targetLod: 2,
            sourceLod: 3,
            layer: 3,
            trianglesPerInstance: {
                joshua: joshuaBillboardTriangles.reduce((sum, value) => sum + value, 0),
                saguaro: saguaroBillboardTriangles.reduce((sum, value) => sum + value, 0),
            },
        },
        rawEmissiveMaterials: 0,
        rawFullDiffuseTransmissionMaterials: saguaroTransmission.length,
    },
}, null, 2));

if (failed.length) process.exitCode = 1;
