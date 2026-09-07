#!/usr/bin/env node
/**
 * Renderer-free construction and WGSL-generation check for the active terrain
 * v3 TSL materials. This instantiates the real node graph with tiny stand-in
 * array textures and asks the vendored WebGPU backend to emit WGSL. It does not
 * create a browser, DOM canvas, GPU device/context, or server.
 */

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { register } from 'node:module';
import { fileURLToPath } from 'node:url';
import * as WEBGPU from '../vendor/three/three.webgpu.js';
import { TSL as makeOpsBackend } from '../src/materials/ops.js';
import { layerBlend, neutralMaterialStream } from '../src/materials/layer_kernel.js';
import {
    SURFACE_HEIGHT_METERS, SURFACE_BLEND_DEPTH_METERS,
} from '../src/materials/eanpa_layer_meta.js';

// texture_base.js reaches bare 'three/tsl' (through src/materials/noise.js),
// which Node would otherwise resolve to an unrelated installed three of a
// different revision. The hook maps it onto the SAME vendored r184 files this
// audit already imported statically, so one three instance builds the graph.
register('./resolve-vendored-three-hooks.mjs', import.meta.url);
const { makeTextureBaseValue, TEXTURE_BASE_DEFAULTS } =
    await import('../src/materials/texture_base.js');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourcePath = path.join(ROOT, 'src', 'terrain_real.js');
let source = fs.readFileSync(sourcePath, 'utf8');
source = source.replace('export async function makeTerrain', 'async function makeTerrain');
source += '\n;globalThis.__terrainV3MaterialFactory = makeTerrainMaterial;\n';
// vm scripts cannot execute dynamic import(); pre-inject the Ekigar kernel
// through the same global escape hatch terrain_real.js checks at load.
const context = vm.createContext({ console, __EANPA_EKIGAR_KERNEL: {
    makeOpsBackend, layerBlend, neutralMaterialStream,
    SURFACE_HEIGHT_METERS, SURFACE_BLEND_DEPTH_METERS,
    makeTextureBaseValue, TEXTURE_BASE_DEFAULTS,
} });
new vm.Script(source, { filename: sourcePath }).runInContext(context);

// The browser import map exposes WEBGPU.TSL as the individual three/tsl
// exports. Using that same vendored object avoids Node resolving an unrelated
// installed bare three/webgpu package.
const T3 = Object.assign({}, WEBGPU, WEBGPU.TSL);
const makeArray = (name, srgb) => {
    const texture = new T3.DataArrayTexture(new Uint8Array(4 * 14), 1, 1, 14);
    texture.name = name;
    texture.format = T3.RGBAFormat;
    texture.type = T3.UnsignedByteType;
    texture.colorSpace = srgb ? T3.SRGBColorSpace : T3.NoColorSpace;
    texture.needsUpdate = true;
    return texture;
};
const albedo = makeArray('terrain_v3_test_albedo', true);
const packed = makeArray('terrain_v3_test_packed', false);
const blendBrush = new T3.DataTexture(
    new Uint8Array([128, 128, 128, 255]), 1, 1, T3.RGBAFormat, T3.UnsignedByteType,
);
blendBrush.name = 'terrain_v3_test_authored_blend_brush';
blendBrush.colorSpace = T3.NoColorSpace;
blendBrush.wrapS = blendBrush.wrapT = T3.RepeatWrapping;
blendBrush.minFilter = T3.LinearMipmapLinearFilter;
blendBrush.magFilter = T3.LinearFilter;
blendBrush.generateMipmaps = true;
blendBrush.anisotropy = 8;
blendBrush.needsUpdate = true;
// Stand-in for the R32F height field makeTerrain bakes from terrainHeightAt.
// A tiny flat field exercises the identical node graph and WGSL declarations;
// the real 1024 x 1024 bake differs only in texel content.
const heightFieldTexture = new T3.DataTexture(
    new Float32Array(8 * 8), 8, 8, T3.RedFormat, T3.FloatType,
);
heightFieldTexture.name = 'terrain_v3_test_height_field_r32f';
heightFieldTexture.colorSpace = T3.NoColorSpace;
heightFieldTexture.wrapS = heightFieldTexture.wrapT = T3.ClampToEdgeWrapping;
heightFieldTexture.minFilter = T3.NearestFilter;
heightFieldTexture.magFilter = T3.NearestFilter;
heightFieldTexture.generateMipmaps = false;
heightFieldTexture.needsUpdate = true;
const heightField = { texture: heightFieldTexture, halfExtent: 800, size: 8 };
const maps = { surfaceArray: { albedo, packed }, blendBrush, heightField };
const threeWebGpuSource = fs.readFileSync(
    path.join(ROOT, 'vendor', 'three', 'three.webgpu.js'), 'utf8',
);
const inertCanvas = {
    width: 1,
    height: 1,
    style: {},
    addEventListener() {},
    removeEventListener() {},
    setAttribute() {},
    getContext() { return null; },
};
const renderer = new T3.WebGPURenderer({ canvas: inertCanvas });
// No device is initialized in this CPU-only audit. The texture feature query
// only selects a shader declaration variant, so use the conservative path.
renderer.hasFeature = () => false;
let assertions = 0;
const assert = (condition, message) => {
    assertions++;
    if (!condition) throw new Error(message);
};
const graphHas = (root, predicate, seen = new Set()) => {
    if (root === null || root === undefined || typeof root !== 'object') return false;
    if (predicate(root)) return true;
    if (seen.has(root)) return false;
    seen.add(root);
    for (const value of Object.values(root)) {
        if (Array.isArray(value)) {
            if (value.some((item) => graphHas(item, predicate, seen))) return true;
        } else if (graphHas(value, predicate, seen)) return true;
    }
    return false;
};

assert(/attribute\('terrainSplatB', 'vec4'\)/.test(source)
    && /const gradeSignal = selectorB\.w;/.test(source)
    && /splatB\[index \* 4 \+ 3\] = grade \/ \(1 \+ grade\);/.test(source),
'Terrain selector B is a four-channel attribute whose W channel carries bounded physical grade');
assert(!/GROUND_CELLULAR_POLICY|groundCellularWeightsAt|terrainGroundCell[AB]/.test(source)
    && /SURFACE_ORGANIC_POLICY/.test(source),
'Terrain material ownership uses continuous organic selectors with no square-cell attributes');

for (const far of [false, true]) {
    const material = context.__terrainV3MaterialFactory(T3, maps, { far });
    assert(material.isNodeMaterial === true, 'Factory returns a node material');
    assert(material.colorNode?.isNode === true, 'Albedo splat graph is a node');
    assert(material.normalNode?.isNode === true, 'Normal splat graph is a node');
    assert(material.roughnessNode?.isNode === true, 'Roughness splat graph is a node');
    assert(material.aoNode?.isNode === true, 'AO splat graph is a node');
    assert(material.userData.arrayLayers.length === 14
        && material.userData.arrayLayers.every((layer, index) => layer === index),
    'All fourteen array layers are dynamically reachable in fixed order');
    assert(material.userData.samplerCount === 3,
        'Material declares two PBR arrays plus the authored threshold brush');
    assert(material.userData.transitionBrush.fragmentSamples === 7,
        'Material records seven independent authored-brush threshold taps');
    assert(material.userData.organicOwnershipPolicy.authoredShapeShare === 0.68
        && Math.abs(material.userData.organicOwnershipPolicy.continuousSelectorShare - 0.32)
            < 1e-12
        && material.userData.organicOwnershipPolicy.relativeGapCrossfade === 0.16
        && material.userData.organicOwnershipPolicy.relativeGapCrossfadePower === 4
        && material.userData.organicOwnershipPolicy.rockRelativeGapCrossfade === 0.22
        && JSON.stringify(material.userData.organicOwnershipPolicy.craterExposureSelector)
            === '[0.11,0.15]'
        && material.userData.organicOwnershipPolicy.craterRockEligibility === 0.20
        && material.userData.organicOwnershipPolicy.craterRock061Bias === 0.30
        && material.userData.organicOwnershipPolicy.continuousSecondaryFade === true
        && material.userData.organicOwnershipPolicy.squareCellLattice === false
        && material.userData.organicOwnershipPolicy.evaluation
            === 'continuous-domain-warped-vertex-selectors_plus-authored-per-fragment-brush',
    'Material records the authored-brush-dominant organic ownership policy');
    assert(JSON.stringify(material.userData.familyLayers.ground) === '[0,1,2,3,10]'
        && JSON.stringify(material.userData.familyLayers.wash) === '[4,7,9]'
        && JSON.stringify(material.userData.familyLayers.rock) === '[5,6,8,11,12,13]',
    'Material records five ground, three wash, and six rock/talus layers');
    assert(material.userData.sceneRepeatMeters.RockyTrail02[0] === 4,
        'Dominant gravel uses its 4 m scene-calibrated repeat');
    assert(material.userData.sceneRepeatMeters.Rock061[0] === 8,
        'Bedrock accent uses its 8 m scene-calibrated repeat');
    assert(material.userData.sceneRepeatMeters.RocksGround02[0] === 7,
        'Fourteenth talus layer uses its enlarged 7 m slope-only scene repeat');
    assert(material.userData.topK === 5 && material.userData.dynamicSamplesPerArray === 5,
        'Material records exactly five pre-height dynamic samples per PBR array');
    assert(material.userData.preHeightSelection === true
        && material.userData.topKRetainedMass.minimum >= 0.82
        && material.userData.topKRetainedMass.p01 >= 0.999,
    'Material records measured pre-height K5 retained mass');
    assert(material.userData.reliefDistanceFadeMeters[0] === 70
        && material.userData.reliefDistanceFadeMeters[1] === 520,
    'Surface relief carries the 70-520 m distance fade');
    assert(material.userData.heightBlendAmplitude === (far ? 0.10 : 0.22),
        'Height blending retains its bounded near/far amplitude');
    assert(material.userData.normalBasis.startsWith('per-projection-whiteout-world-normal')
        && material.userData.surfaceProjection
            === 'world-biplanar_geometric-axis-selection_conditional-secondary-sample'
        && material.userData.maximumDynamicSamplesPerArray === 10,
    'Terrain declares bounded biplanar sampling and normals reoriented for each projection');
    for (const [name, root] of [
        ['color', material.colorNode],
        ['normal', material.normalNode],
        ['roughness', material.roughnessNode],
        ['AO', material.aoNode],
    ]) {
        assert(graphHas(root, (value) => value === albedo),
            name + ' graph reaches albedo/linear-height array');
        assert(graphHas(root, (value) => value === blendBrush),
            name + ' graph reaches the authored transition brush');
        if (name !== 'color') assert(graphHas(root, (value) => value === packed),
            name + ' graph reaches packed normal/roughness/AO array');
    }
    assert(!graphHas(material.normalNode, (value) => value?.isNormalMapNode === true),
        'Final normal graph has no implicit mesh-UV NormalMapNode');

    const geometry = new T3.PlaneGeometry(1, 1, 1, 1);
    const vertexCount = geometry.getAttribute('position').count;
    geometry.setAttribute('terrainSplatA', new T3.Float32BufferAttribute(
        new Float32Array(vertexCount * 4).fill(0.25), 4,
    ));
    geometry.setAttribute('terrainSplatB', new T3.Float32BufferAttribute(
        new Float32Array(vertexCount * 4).fill(0.25), 4,
    ));
    geometry.setAttribute('terrainMacro', new T3.Float32BufferAttribute(
        new Float32Array(vertexCount).fill(1), 1,
    ));
    geometry.setAttribute('terrainTint', new T3.Float32BufferAttribute(
        new Float32Array(vertexCount * 3).fill(1), 3,
    ));
    const mesh = new T3.Mesh(geometry, material);
    const builder = renderer.backend.createNodeBuilder(mesh, renderer);
    builder.scene = new T3.Scene();
    builder.camera = new T3.PerspectiveCamera();
    builder.lightsNode = T3.lights([]);
    builder.build();
    const arrayDeclarations = builder.fragmentShader.match(/texture_2d_array<f32>/g) ?? [];
    const explicitGradientSamples = builder.fragmentShader.match(/textureSampleGrad/g) ?? [];
    const textureDeclarationLines = builder.fragmentShader.split('\n')
        .filter((line) => line.includes('texture_2d'));
    // Three plain 2D textures share the fragment stage: the authored threshold
    // brush (seven explicit-LOD selector taps), the baked R32F height field
    // (the classifier's nine-tap finite-difference stencil, emitted as
    // sampler-free clamped textureLoad), and the standard material's own DFG
    // environment LUT. Identify each by its contractual read signature rather
    // than declaration order.
    const plainDeclarations = textureDeclarationLines.filter((line) => (
        line.includes('texture_2d<f32>') && !line.includes('texture_2d_array')
    ));
    const plainReads = plainDeclarations.map((declaration) => {
        const binding = declaration.match(/var\s+(\w+)\s*:/)?.[1];
        return builder.fragmentShader.split('\n')
            .filter((line) => binding && line.includes(binding)
                && (line.includes('textureSample') || line.includes('textureLoad')));
    });
    const brushReads = plainReads.find((reads) => (
        reads.length === 7 && reads.every((line) => line.includes('textureSampleLevel'))
    ));
    assert(builder.vertexShader.length > 1000 && builder.fragmentShader.length > 10000,
        'Vendored WebGPU backend emits complete vertex and fragment WGSL');
    assert(arrayDeclarations.length === 2,
        'Generated WGSL declares exactly two 2D-array texture resources');
    assert(plainDeclarations.length === 2 && Boolean(brushReads),
    'Generated WGSL reads seven authored-brush selector taps '
        + `(reads=${plainReads.map((reads) => reads.length).join(',')})`);
    assert(explicitGradientSamples.length === 20,
        'Generated WGSL contains five pairs of primary and conditional secondary samples');
    assert(builder.fragmentShader.includes('terrainSecondaryPlaneWeight > 0.0001'),
        'Flat terrain skips secondary texture reads through a real shader branch');
    assert(!/textureSampleGrad\([^\n]+,\s*(?:0|1|2|3|4|5|6|7|8|9|10|11|12|13),/.test(
        builder.fragmentShader,
    ), 'Generated WGSL has no statically indexed PBR array sample');
    for (let slot = 0; slot < 5; slot++) {
        const slotReads = builder.fragmentShader.split('\n').filter((line) => (
            line.includes('textureSampleGrad')
                && line.includes(`terrainTopUv${slot}`)
                && line.includes(`terrainTopLayer${slot}`)
                && line.includes(`terrainTopGradX${slot}`)
                && line.includes(`terrainTopGradY${slot}`)
        ));
        assert(slotReads.length === 2,
            `Top-K slot ${slot} shares one dynamic layer/UV/gradient across both PBR arrays`);
    }
    assert(/slot\.transform\.y/.test(source)
        && /slot\.transform\.z/.test(source)
        && !/layerTransforms\[index\]\[1\]/.test(source),
    'Normal rotation follows the selected dynamic layer transform, never top-K slot order');
    assert(!builder.fragmentShader.includes('NORMAL_TBNViewMatrix'),
        'Generated WGSL does not synthesize a mesh-UV TBN');
    geometry.dispose();
    material.dispose();
}
albedo.dispose();
packed.dispose();
blendBrush.dispose();
heightFieldTexture.dispose();
assert(/case RGBAFormat:[\s\S]{0,120}transfer === SRGBTransfer[\s\S]{0,120}RGBA8UnormSRGB/.test(
    threeWebGpuSource,
), 'Vendored r184 selects rgba8unorm-srgb for the albedo RGBA array; GPU sRGB formats decode RGB while retaining linear alpha');
console.log('Terrain v3 material-node audit passed: ' + assertions + ' assertions');
