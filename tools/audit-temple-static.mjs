#!/usr/bin/env node

// CPU-only acceptance audit for the authored temple, wall kit, navigation
// contract, orb emitter anchors, and editable architecture handoff.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => fs.readFileSync(path.join(root, relative));
const text = (relative) => read(relative).toString('utf8');
const close = (a, b, tolerance = 1e-5) => Math.abs(a - b) <= tolerance;
const checks = [];

function check(label, condition, detail = null) {
    if (!condition) throw new Error(`${label}${detail ? `: ${detail}` : ''}`);
    checks.push(label);
}

function glb(relative) {
    const bytes = read(relative);
    check(`${relative} is GLB`, bytes.toString('ascii', 0, 4) === 'glTF');
    const jsonLength = bytes.readUInt32LE(12);
    const json = JSON.parse(bytes.subarray(20, 20 + jsonLength).toString('utf8').trimEnd());
    return { bytes, json };
}

const isBlend = (bytes) => bytes.subarray(0, 7).toString('ascii') === 'BLENDER'
    || bytes.readUInt32LE(0) === 0xFD2FB528;

function meshBounds(json, meshIndex) {
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (const primitive of json.meshes[meshIndex].primitives) {
        const accessor = json.accessors[primitive.attributes.POSITION];
        for (let axis = 0; axis < 3; axis++) {
            min[axis] = Math.min(min[axis], accessor.min[axis]);
            max[axis] = Math.max(max[axis], accessor.max[axis]);
        }
    }
    return { min, max, size: max.map((value, axis) => value - min[axis]) };
}

function sceneBounds(json) {
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (let index = 0; index < json.meshes.length; index++) {
        const bounds = meshBounds(json, index);
        for (let axis = 0; axis < 3; axis++) {
            min[axis] = Math.min(min[axis], bounds.min[axis]);
            max[axis] = Math.max(max[axis], bounds.max[axis]);
        }
    }
    return { min, max, size: max.map((value, axis) => value - min[axis]) };
}

const templeSource = text('src/temple_real.js');
const mainSource = text('src/main.js');
const movementSource = text('src/movement_step.js');
const audioSource = text('src/audio_system.js');
const builderSource = text('tools/build-ziggurat-blender.py');
const integratorSource = text('tools/integrate-user-ziggurat-v2.py');
const integrationReport = JSON.parse(text('artifacts/ziggurat-integration/integrated_v2_report.json'));
const integratedDiff = JSON.parse(text('artifacts/ziggurat-integration/integrated_v2_vs_user_object_diff.json'));
const fileSha256 = (relative) => crypto.createHash('sha256').update(read(relative)).digest('hex').toUpperCase();

const ziggurat = glb('assets/temple/ziggurat_architecture.glb').json;
const architectureRoot = ziggurat.nodes.find((node) => node.name === 'ziggurat_architecture_root');
check('authored architecture root exists', architectureRoot);
const extras = architectureRoot.extras ?? {};
check('GLB embeds 110-step schedule', extras.stair_steps === 110);
check('GLB embeds four flights', extras.stair_flights === 4);
check('GLB embeds three landings', extras.stair_landings === 3);
check('GLB embeds 0.20 m riser', close(extras.stair_riser_m, 0.20));
check('GLB embeds 0.30 m tread', close(extras.stair_tread_m, 0.30));
check('GLB embeds 1.60 m landing', close(extras.landing_depth_m, 1.60));
check('GLB embeds user-authoritative 15.5030928 m stair width',
    close(extras.walkable_stair_half_width * 2, 15.5030928));
check('GLB records sphere-side lighting source',
    extras.lighting_source === 'Inanna sphere emissive side meshes; no detached fixtures');
check('GLB topology audit preserves only the eight user open-surface rail seams',
    extras.audit_zero_degenerate_faces === true
    && extras.audit_zero_nonmanifold_edges === false
    && extras.audit_nonmanifold_edges_preserved_user_rails === 192
    && extras.audit_meshes === 31
    && extras.audit_triangles === 70192);
check('GLB records integrated_v2 user authority',
    extras.integration_version === 'integrated_v2'
    && extras.user_edit_authority === true
    && extras.integration_source_sha256
        === '66C6F1C925CC77D51F32F10FDC4B771E96B9E19F5DD993ADDA1880FBFA55F228'
    && extras.old_generated_cheek_geometry === false
    && extras.rail_trim_pieces === 8);
check('preserved user open-surface rail seams have an object-specific double-sided safeguard',
    String(extras.user_rail_topology).includes('runtime uses object-specific double-sided')
    && templeSource.includes('userRailSandstone.side = T3.DoubleSide')
    && templeSource.includes("objectKey.includes('stoneprocessionalrailflight')")
    && integrationReport.integration.user_rail_topology.nonmanifold_edges === 192);
check('GLB embeds four corner fasteners on every metal access panel',
    extras.panel_corner_fasteners === 176
    && extras.fastener_revision === 'corner_v2'
    && close(extras.fastener_support_plate_size_m, 0.235)
    && close(extras.fastener_visible_diameter_m, 0.090)
    && close(extras.fastener_chamfer_clearance_m, 0.015)
    && extras.fastener_normal_map === 'ambientCG Metal010 NormalGL (CC0)'
    && String(extras.material_language).includes('ambientCG CC0 Metal010')
    && String(extras.material_language).includes('generated flush fastener decals')
    && String(extras.fastener_style).includes('5 mm proud')
    && String(extras.fastener_style).includes('0.090 m visible diameter')
    && String(extras.fastener_style).includes('0.235 m support'));

check('GLB declares external optimized runtime material payload',
    extras.runtime_material_payload === 'named scalar slots; external optimized PBR/decal maps');
check('GLB does not duplicate externally loaded PBR/decal images',
    (ziggurat.images ?? []).length === 0
    && (ziggurat.textures ?? []).length === 0);

const glbProfile = String(extras.stair_profile).split(';').map((entry) => {
    const [frontZ, backZ, frontY, backY, steps, landingBackZ] = entry.split(',');
    return {
        frontZ: Number(frontZ), backZ: Number(backZ),
        frontY: Number(frontY), backY: Number(backY),
        steps: Number(steps),
        landingBackZ: landingBackZ === 'None' ? null : Number(landingBackZ),
    };
});
const runtimeProfileBlock = templeSource.match(/const stairProfile = \[([\s\S]*?)\n\s*\];/)?.[1] ?? '';
const runtimeProfile = [...runtimeProfileBlock.matchAll(
    /\{ frontZ: ([\d.-]+), backZ: ([\d.-]+), frontY: ([\w.-]+), backY: ([\w.-]+), steps: (\d+), landingBackZ: ([\w.-]+) \}/g,
)].map((match) => ({
    frontZ: Number(match[1]), backZ: Number(match[2]),
    frontY: match[3] === 'stairFrontY' ? -0.20 : Number(match[3]),
    backY: match[4] === 'stairTopY' ? 21.80 : Number(match[4]),
    steps: Number(match[5]),
    landingBackZ: match[6] === 'null' ? null : Number(match[6]),
}));
check('runtime exposes four authored stair flights', runtimeProfile.length === 4);
check('runtime and GLB stair schedules match exactly',
    JSON.stringify(runtimeProfile) === JSON.stringify(glbProfile));
check('runtime stair schedule totals 110 treads',
    runtimeProfile.reduce((sum, flight) => sum + flight.steps, 0) === 110);
for (const [index, flight] of runtimeProfile.entries()) {
    check(`flight ${index + 1} has 0.20 m rise`,
        close((flight.backY - flight.frontY) / flight.steps, 0.20));
    check(`flight ${index + 1} has 0.30 m run`,
        close((flight.frontZ - flight.backZ) / flight.steps, 0.30));
    if (flight.landingBackZ !== null) {
        check(`landing ${index + 1} is 1.60 m deep`,
            close(flight.backZ - flight.landingBackZ, 1.60));
    }
}

const zigguratMaterials = new Set((ziggurat.materials ?? []).map((material) => material.name));
check('authored GLB has sandstone PBR slot', zigguratMaterials.has('SandstonePBR'));
check('authored GLB has lapis PBR slot', zigguratMaterials.has('LapisPBR'));
check('authored GLB has carnelian PBR slot', zigguratMaterials.has('CarnelianPBR'));
check('authored GLB has integrated sci-fi metal slot', zigguratMaterials.has('SciFiMetal'));
check('authored GLB has generated fastener decal slot', zigguratMaterials.has('FastenerDecal'));
check('authored GLB has 31 integrated_v2 architecture meshes', ziggurat.meshes.length === 31);
const authoredRailNodes = ziggurat.nodes.filter((node) => /^stone_processional_rail_flight_\d{2}_(?:pos|neg)_x$/.test(node.name ?? ''));
const authoredRailTrimNodes = ziggurat.nodes.filter((node) => /^scifi_processional_cheek_insets_integrated_v2_flight_\d{2}_(?:pos|neg)_x$/.test(node.name ?? ''));
check('GLB retains all eight user-authored rail pieces', authoredRailNodes.length === 8);
check('GLB adds exactly eight flush Metal010 rail trims', authoredRailTrimNodes.length === 8);
check('GLB does not regenerate rejected retaining-wall or old cheek geometry',
    !ziggurat.nodes.some((node) => [
        'stone_processional_retaining_walls',
        'scifi_processional_cheek_insets',
    ].includes(node.name)));
for (const node of [...authoredRailNodes, ...authoredRailTrimNodes]) {
    check(`${node.name} retains exported UV coordinates`,
        ziggurat.meshes[node.mesh].primitives.every((primitive) => (
            Number.isInteger(primitive.attributes.TEXCOORD_0)
        )));
}
const fastenerNode = ziggurat.nodes.find((node) => node.name === 'scifi_panel_corner_fasteners');
check('corner fasteners are retained as an authored mesh', Number.isInteger(fastenerNode?.mesh));
check('corner fasteners use the generated FastenerDecal slot',
    ziggurat.meshes[fastenerNode.mesh].primitives.every((primitive) => (
        ziggurat.materials[primitive.material]?.name === 'FastenerDecal'
    )));
check('generated fastener decals retain exported UV coordinates',
    ziggurat.meshes[fastenerNode.mesh].primitives.every((primitive) => (
        Number.isInteger(primitive.attributes.TEXCOORD_0))));
check('authored GLB has no detached emitter mesh',
    !ziggurat.nodes.some((node) => /light.?emitter|hdr.?emitter/i.test(node.name ?? '')));
check('integrated_v2 processor exports GLB extras', integratorSource.includes('export_extras=True'));

const blend = read('assets/temple/ziggurat_architecture.blend');
check('editable Blend handoff retained', isBlend(blend));
check('editable Blend is nontrivial', blend.length > 4_000_000);
const areaBlend = read('assets/temple/eanpa_ziggurat_area_integrated_v2.blend');
check('versioned integrated_v2 full-area Blend retained',
    isBlend(areaBlend) && areaBlend.length > 10_000_000);
check('integration allowlist audit passes with 156 untouched objects',
    integrationReport.allowlist_audit.pass === true
    && integrationReport.allowlist_audit.protected_object_count === 156
    && integrationReport.allowlist_audit.protected_changed.length === 0
    && integrationReport.authority.source_untouched_after_all_outputs === true);
const fastenerMeasurements = integrationReport.integration.fasteners.measurements_against_actual_panel_bounds;
check('all 176 smaller fasteners are measured inside the 44 actual panel bounds',
    integrationReport.integration.fasteners.revision === 'corner_v2'
    && integrationReport.integration.fasteners.components === 176
    && close(integrationReport.integration.fasteners.support_plate_size_m, 0.235)
    && close(integrationReport.integration.fasteners.visible_diameter_m, 0.090)
    && integrationReport.integration.fasteners.normal_map === true
    && fastenerMeasurements.host_panel_components === 44
    && fastenerMeasurements.fastener_components === 176
    && fastenerMeasurements.fasteners_per_panel === 4
    && fastenerMeasurements.all_fasteners_matched_to_actual_panel_bounds === true
    && fastenerMeasurements.corner_center_horizontal_inset_m.min >= 0.226
    && fastenerMeasurements.corner_center_horizontal_inset_m.max <= 0.236
    && fastenerMeasurements.corner_center_vertical_inset_m.min >= 0.226
    && fastenerMeasurements.corner_center_vertical_inset_m.max <= 0.236);
check('independent post-integration diff contains only allowlisted edits/additions',
    integratedDiff.summary.unchanged === 156
    && integratedDiff.summary.changed === 1
    && integratedDiff.summary.user_only === 17
    && integratedDiff.summary.runtime_only === 8);
check('immutable user snapshot hash is unchanged',
    fileSha256('artifacts/ziggurat-user-edit-snapshots/eanpa_ziggurat_area_user_2026-07-16_0800.blend')
        === integrationReport.authority.sha256);
check('runtime GLB and canonical Blend hashes match the integration report',
    fileSha256('assets/temple/ziggurat_architecture.glb') === integrationReport.outputs.glb.sha256
    && fileSha256('assets/temple/ziggurat_architecture.blend')
        === integrationReport.outputs.canonical_architecture_blend.sha256);
check('architectural SVG reference retained',
    text('assets/temple/ziggurat_architecture_reference.svg').includes('<svg'));

for (const mineral of ['lapis', 'carnelian']) {
    for (const map of ['diff', 'normal', 'rough', 'height']) {
        const relative = `assets/temple/materials/${mineral}_tiles_${map}.png`;
        check(`${mineral} ${map} Harness map retained`, fs.statSync(path.join(root, relative)).size > 1024);
        check(`${mineral} ${map} map loaded`, mainSource.includes(`${mineral}_tiles_${map}.png`));
    }
}
check('Harness mineral PBR uses 3.25 repeat', templeSource.includes('const mineralUvScale = 3.25'));
check('Harness mineral tiles use full PBR node inputs',
    templeSource.includes('material.colorNode = albedoSample;')
    && templeSource.includes('material.normalNode = T3.normalMap(normalSample')
    && templeSource.includes('material.roughnessNode = roughnessSample')
    && templeSource.includes('material.metalnessNode = T3.float(0.02);')
    && templeSource.includes('material.aoNode = cavityAo;'));
check('Harness height maps drive AO rather than staining base color',
    templeSource.includes('const cavityAo = cavitySample.mul(0.14).add(0.86)')
    && !templeSource.includes('albedoSample.mul(cavitySample'));
check('Harness mineral provenance retained',
    templeSource.includes("new_twitter_harness/city_builder_assets/sumerian"));

const metalReadme = text('assets/temple/materials/ambientcg_metal010/README.md');
check('ambientCG metal source and CC0 license provenance retained',
    metalReadme.includes('https://ambientcg.com/view?id=Metal010')
    && metalReadme.includes('Creative Commons CC0 1.0 Universal'));
check('ambientCG separate grayscale channel semantics documented',
    metalReadme.includes('Roughness.jpg`: linear grayscale, sampled from `.r`')
    && metalReadme.includes('Metalness.jpg`: linear grayscale, sampled independently from `.r`'));
check('generated fastener alpha decal retained',
    fs.statSync(path.join(root, 'assets/temple/decals/panel_fastener_decal-v1.png')).size > 1024);
const orb = glb('assets/temple/inanna_orb.glb').json;
const emissivePrimitives = orb.meshes.flatMap((mesh) => mesh.primitives).filter((primitive) => {
    const factor = orb.materials[primitive.material]?.emissiveFactor ?? [0, 0, 0];
    return Math.max(...factor) > 0.1;
});
check('orb has exactly two authored emissive primitives', emissivePrimitives.length === 2);
const anchors = emissivePrimitives.map((primitive) => {
    const material = orb.materials[primitive.material];
    const bounds = orb.accessors[primitive.attributes.POSITION];
    return {
        channel: material.emissiveFactor[2] > material.emissiveFactor[0] ? 'blue' : 'red',
        centerX: (bounds.min[0] + bounds.max[0]) * 0.5,
    };
});
check('orb blue light island is on -X side', anchors.some((anchor) => anchor.channel === 'blue' && anchor.centerX < -0.9));
check('orb red light island is on +X side', anchors.some((anchor) => anchor.channel === 'red' && anchor.centerX > 0.9));
check('runtime derives anchors from emissive material groups',
    templeSource.includes('const materialGroupCenter = (geometry, materialIndex)'));
check('runtime beams follow lateral/outward material-group anchors',
    templeSource.includes("beam.userData.direction = 'lateral/outward'"));
check('fixture metals use dedicated ambientCG maps with independent channel decoding',
    templeSource.includes("material.userData.pbrSource = 'ambientCG Metal010 1K JPG (CC0)'")
    && templeSource.includes('const roughSample = tri(roughness).r;')
    && templeSource.includes('const metalSample = tri(metalness).r;')
    && templeSource.includes("channelDecoding: 'roughness.r + metalness.r'")
    && templeSource.includes("projection: nodeCapable ? 'world-triplanar-1.61m' : 'authored-uv'")
    && mainSource.includes('Metal010_1K-JPG_')
    && !templeSource.includes('Eidoverse perimeter embedded 2K metal')
    && !templeSource.includes('mrSample'));
check('fixture metal calibration is cloud-legible, restrained, and role-specific',
    templeSource.includes('roughScale: 0.26, roughBias: 0.52')
    && templeSource.includes('roughRange: [0.52, 0.78], metalScale: 0.23, metalBias: 0.55')
    && templeSource.includes('roughScale: 0.23, roughBias: 0.45')
    && templeSource.includes('roughRange: [0.45, 0.68], metalScale: 0.20, metalBias: 0.55')
    && templeSource.includes('roughScale: 0.22, roughBias: 0.32')
    && templeSource.includes('roughRange: [0.32, 0.54], metalScale: 0.22, metalBias: 0.58')
    && templeSource.includes('envMapIntensity: 0.78')
    && templeSource.includes('envMapIntensity: 0.80')
    && templeSource.includes('envMapIntensity: 0.84')
    && templeSource.includes('const stairWidth = 15.5030928'));
check('architectural cloud reflections stay in native PMREM with one resolved PBR material',
    templeSource.includes('Native PMREM and Three SSR both consume these same resolved material')
    && templeSource.includes('material.roughnessNode = roughSample')
    && templeSource.includes('material.metalnessNode = metalSample')
    && templeSource.includes('material.normalNode = T3.normalize(')
    && templeSource.includes('fastenerMetal.envMapIntensity = 0.82')
    && templeSource.includes('sharedPerimeterMaterial.roughness = 0.42')
    && templeSource.includes('sharedPerimeterMaterial.envMapIntensity = 0.86')
    && !templeSource.includes('CloudReflectHook')
    && !templeSource.includes('screenSpaceCloud')
    && !templeSource.includes('SSR fallback'));
check('corner fasteners use generated RGBA decal plus shared Metal010 normal on smaller near-flush supports',
    templeSource.includes("fastenerMetal.userData.pbrSource = 'ImageGen recessed fastener RGBA decal v1 + ambientCG Metal010 NormalGL (CC0)'")
    && templeSource.includes("normalMap: fixtureMetalMaps.normal?.isTexture ? fixtureMetalMaps.normal : null")
    && templeSource.includes('normalScale: new T3.Vector2(0.34, 0.34)')
    && templeSource.includes("normalGL: Boolean(fixtureMetalMaps.normal?.isTexture)")
    && templeSource.includes("objectKey.includes('scifipanelcornerfasteners')")
    && templeSource.includes('mappedFastenerMetalPbr')
    && mainSource.includes('panel_fastener_decal-v1.png')
    && builderSource.includes('FASTENER_SUPPORT_SIZE_M = 0.235')
    && builderSource.includes('FASTENER_VISIBLE_DIAMETER_M = 0.090')
    && builderSource.includes('FASTENER_CHAMFER_CLEARANCE_M = 0.015')
    && builderSource.includes('fastener_decal, 0.110, 0.0, 0.0')
    && builderSource.includes('decal_uv=True')
    && !builderSource.includes('0.155, 0.0, 0.045'));
check('orb blue source is saturated true blue and applied to authored material',
    templeSource.includes('new T3.Color(0x007cff)')
    && templeSource.includes('material.emissive.copy(blueLightColor)'));
check('orb beam volume has a transparent distance gradient',
    templeSource.includes("material.userData.gradient = 'source-fade + distance-fade + soft silhouette'")
    && templeSource.includes('const beamLength = 52')
    && templeSource.includes('T3.float(1).sub(')
    && templeSource.includes('T3.smoothstep(0.05, 1.0, axial)')
    && !templeSource.includes('T3.smoothstep(1.0, 0.24, axial)')
    && templeSource.includes('depthWrite: false'));
check('orb lights are shadowed long-range spotlights',
    templeSource.includes('const light = new T3.SpotLight(')
    && templeSource.includes('color, 0, 600, Math.PI * 0.030, 0.92, 1.55')
    && templeSource.includes('light.castShadow = true'));
check('stair curbs overlap tread edges and terminate at summit',
    templeSource.includes('const curbOffset = stairWidth * 0.5 + curbWidth * 0.5 - 0.04')
    && templeSource.includes('processional_summit_landing_curb_')
    && templeSource.includes('processional_summit_curb_return_'));

const perimeterFiles = {
    gate: 'assets/eidoverse/perimeter/scifi_perimeter_wall_gate.glb',
    wall: 'assets/eidoverse/perimeter/scifi_perimeter_wall_middle_geometry.glb',
    pillar: 'assets/eidoverse/perimeter/scifi_perimeter_wall_pillar_geometry.glb',
    watchtower: 'assets/eidoverse/perimeter/scifi_perimeter_watchtower_geometry.glb',
};
const perimeterJson = Object.fromEntries(
    Object.entries(perimeterFiles).map(([kind, relative]) => [kind, glb(relative).json]),
);
check('authored gate leaf Cube.001 exists',
    perimeterJson.gate.nodes.some((node) => node.name === 'Cube.001' && Number.isInteger(node.mesh)));
const gateDoorNode = perimeterJson.gate.nodes.find((node) => node.name === 'Cube.001');
const gateDoorSize = meshBounds(perimeterJson.gate, gateDoorNode.mesh).size;
check('authored gate leaf is thin retracting geometry',
    gateDoorSize[0] < 0.7 && gateDoorSize[1] > 6.2 && gateDoorSize[2] > 18.0);
const moduleSizes = Object.fromEntries(
    Object.entries(perimeterJson).map(([kind, json]) => [kind, sceneBounds(json).size]),
);
check('wall bay is authored at 10 m socket pitch', close(moduleSizes.wall[2], 10, 0.01));
check('standalone pillar provides 2 m end inset', close(moduleSizes.pillar[2] * 0.5, 2, 0.01));
check('watchtower provides 4 m end inset', close(moduleSizes.watchtower[2] * 0.5, 4, 0.02));
check('gate module retains 24 m outer span', close(moduleSizes.gate[2], 24, 0.02));

const bay = 10;
const frontZ = 48;
const backZ = -42;
const sideX = 40;
const layout = [{ kind: 'gate', x: 0, z: frontZ, alongX: true }];
for (const side of [-1, 1]) {
    for (const x of [15, 25, 35]) layout.push({ kind: 'wall', x: side * x, z: frontZ, alongX: true });
    for (const x of [20, 30]) layout.push({ kind: 'pillar', x: side * x, z: frontZ });
    layout.push({ kind: 'watchtower', x: side * sideX, z: frontZ });
    layout.push({ kind: 'watchtower', x: side * sideX, z: backZ });
    for (let index = 0; index < 9; index++) layout.push({
        kind: 'wall', x: side * sideX, z: frontZ - (index + 0.5) * bay, alongX: false,
    });
    for (let index = 1; index < 9; index++) layout.push({
        kind: 'pillar', x: side * sideX, z: frontZ - index * bay,
    });
}
for (let index = 0; index < 8; index++) layout.push({
    kind: 'wall', x: -sideX + (index + 0.5) * bay, z: backZ, alongX: true,
});
for (let index = 1; index < 8; index++) layout.push({
    kind: 'pillar', x: -sideX + index * bay, z: backZ,
});
const count = (kind) => layout.filter((placement) => placement.kind === kind).length;
check('wall grammar has one authored gate', count('gate') === 1);
check('wall grammar has 32 middle bays', count('wall') === 32);
check('wall grammar has 27 standalone pillars', count('pillar') === 27);
check('wall grammar has four watchtowers', count('watchtower') === 4);
check('wall grammar has no doubled gate pillars',
    !layout.some((placement) => placement.kind === 'pillar'
        && placement.z === frontZ && Math.abs(placement.x) === bay));
const sockets = new Set(layout.filter((placement) => ['pillar', 'watchtower'].includes(placement.kind))
    .map((placement) => `${placement.x},${placement.z}`));
sockets.add(`${-bay},${frontZ}`);
sockets.add(`${bay},${frontZ}`);
const unsupported = layout.filter((placement) => placement.kind === 'wall').flatMap((placement) => {
    const endpoints = placement.alongX
        ? [[placement.x - bay / 2, placement.z], [placement.x + bay / 2, placement.z]]
        : [[placement.x, placement.z - bay / 2], [placement.x, placement.z + bay / 2]];
    return endpoints.filter(([x, z]) => !sockets.has(`${x},${z}`));
});
check('every wall end reaches a support centerline', unsupported.length === 0);
check('runtime asserts the exact perimeter grammar',
    templeSource.includes('perimeterGrammar.wallBays !== 32')
    && templeSource.includes('perimeterGrammar.standalonePillars !== 27'));

check('authored leaf drives gate motion',
    templeSource.includes("sourceMesh: 'Cube.001'")
    && templeSource.includes('gateDoor.position.y -= gateProgress * gateDoorTravel'));
check('gate opens by player proximity',
    templeSource.includes('const openZone = gateDx < 14.5 && gateDz < 16.0'));
check('gate collision follows animated progress',
    templeSource.includes('gateDoorClosedBottomLocal - gateProgress * gateDoorTravel'));
check('gate sound follows authored leaf in world space',
    audioSource.includes('gateDoor.localToWorld(gateWorld)'));
check('gate sound is spatial with distance rolloff',
    audioSource.includes('spatial: { refDistance: 18, maxDistance: 600, rolloffFactor: 0.25 }'));
check('gate sound state follows open/close target edges',
    audioSource.includes("queueGateDirection('open')")
    && audioSource.includes("queueGateDirection('close')"));

const collisionIndex = mainSource.indexOf('temple?.resolveCamera?.(camera, movementStart)');
const resolvedFloorIndex = mainSource.indexOf(
    'const targetSurface = navigationSurfaceAt(camera.position.x, camera.position.z)',
    collisionIndex,
);
const collisionBeforeFloor = collisionIndex >= 0 && resolvedFloorIndex > collisionIndex;
check('solid collision resolves before floor sampling', collisionBeforeFloor);
check('vegetation collision resolves in the same pre-floor phase',
    mainSource.indexOf('vegetation?.resolveCamera?.(', collisionIndex) > collisionIndex
    && mainSource.indexOf('vegetation?.resolveCamera?.(', collisionIndex) < resolvedFloorIndex);
check('tier collision preserves only authored stair corridor',
    templeSource.includes('const inStairCorridor = Math.abs(collisionScratch.x)'));
check('tier sides use prior eye height to prevent auto-climb',
    templeSource.includes('Math.min(collisionScratch.y, previousScratch.y)'));
check('visible stair surfaces are quantized per tread',
    templeSource.includes('Math.floor(distance / run)'));
check('controller can follow 0.20 m stair descents',
    mainSource.includes('const stairStepDown = 0.38'));
check('normal stair auto-step remains capped at 0.34 m', movementSource.includes('export const MAX_WALK_STEP_RISE = 0.34'));
check('only explicit Inanna dais surfaces authorize assisted climbing', templeSource.includes('inanna_dais_upper'));
check('high surfaces require feet clearance outside the dais transition', movementSource.includes('physicalEyeY - eyeHeight'));
check('dais step uses continuous eased lift', movementSource.includes('const lift = smooth01(t)'));
check('dais step crosses its face after lifting', movementSource.includes('const forward = smooth01'));
check('orb collision resolves full 3D displacement',
    templeSource.includes('let dx = collisionScratch.x - orbPivot.position.x')
    && templeSource.includes('let dy = collisionScratch.y - orbPivot.position.y')
    && templeSource.includes('let dz = collisionScratch.z - orbPivot.position.z'));
check('temple collision is independently close-streamed for tiers, walls, and orb',
    templeSource.includes('per-component-close-proximity-broadphase')
    && templeSource.includes('activationDistance: 7.0')
    && templeSource.includes('releaseDistance: 9.5')
    && templeSource.includes('const zigguratPhysicsActive = updatePhysicsActivation(')
    && templeSource.includes('const wallsPhysicsActive = updatePhysicsActivation(')
    && templeSource.includes('const orbPhysicsActive = updatePhysicsActivation('));
check('far temple navigation queries reject before enumerating authored surfaces',
    templeSource.includes(
        'if (Math.abs(x) > walkHalfX || z < walkBackZ || z > walkFrontZ) return null',
    ));

console.log(JSON.stringify({
    ok: true,
    assertions: checks.length,
    stairSchedule: glbProfile,
    orbAnchors: anchors,
    wallGrammar: {
        gate: count('gate'), walls: count('wall'),
        pillars: count('pillar'), watchtowers: count('watchtower'),
        unsupportedWallEnds: unsupported.length,
    },
    moduleSizes,
    editableBlendBytes: blend.length,
}, null, 2));
