#!/usr/bin/env node

// Attribute-level acceptance audit for the authoritative user Blend handoff.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const load = (relative) => JSON.parse(fs.readFileSync(path.join(root, relative), 'utf8'));
const bytes = (relative) => fs.readFileSync(path.join(root, relative));
const sha256 = (relative) => crypto.createHash('sha256').update(bytes(relative)).digest('hex').toUpperCase();
const checks = [];
const check = (label, condition, detail = '') => {
    if (!condition) throw new Error(`${label}${detail ? `: ${detail}` : ''}`);
    checks.push(label);
};
const close = (left, right, tolerance = 1e-6) => Math.abs(left - right) <= tolerance;
const matrixClose = (left, right) => left.every((row, rowIndex) => (
    row.every((value, columnIndex) => close(value, right[rowIndex][columnIndex]))
));
const byName = (items) => new Map(items.map((item) => [item.name, item]));

const user = load('artifacts/ziggurat-integration/user_area_inventory.json');
const integrated = load('artifacts/ziggurat-integration/integrated_v2_area_inventory.json');
const architecture = load('artifacts/ziggurat-integration/integrated_v2_architecture_inventory.json');
const report = load('artifacts/ziggurat-integration/integrated_v2_report.json');
const diff = load('artifacts/ziggurat-integration/integrated_v2_vs_user_object_diff.json');

const userObjects = byName(user.objects);
const integratedObjects = byName(integrated.objects);
const architectureObjects = byName(architecture.objects);

check('immutable user original hash is unchanged',
    sha256('assets/temple/eanpa_ziggurat_area_editable.blend') === report.authority.sha256);
check('immutable user snapshot hash is unchanged',
    sha256('artifacts/ziggurat-user-edit-snapshots/eanpa_ziggurat_area_user_2026-07-16_0800.blend')
        === report.authority.sha256);
check('report records source immutability after every output',
    report.authority.source_untouched === true
    && report.authority.source_untouched_after_all_outputs === true);

for (const [label, relative] of [
    ['area', 'assets/temple/eanpa_ziggurat_area_integrated_v2.blend'],
    ['glb', 'assets/temple/ziggurat_architecture.glb'],
    ['architecture_blend', 'assets/temple/ziggurat_architecture_integrated_v2.blend'],
    ['canonical_architecture_blend', 'assets/temple/ziggurat_architecture.blend'],
]) {
    check(`${label} hash matches integration report`, sha256(relative) === report.outputs[label].sha256);
}

check('processor allowlist audit passes',
    report.allowlist_audit.pass === true
    && report.allowlist_audit.protected_object_count === 156
    && report.allowlist_audit.protected_changed.length === 0);
check('independent object diff has only one changed root and the rail rename/addition sets',
    diff.summary.unchanged === 156
    && diff.summary.changed === 1
    && diff.summary.user_only === 17
    && diff.summary.runtime_only === 8);
const changedNames = diff.object_diffs.filter((item) => item.status === 'changed').map((item) => item.name);
check('only the architecture root changes in place',
    JSON.stringify(changedNames) === '["ziggurat_architecture_root"]');

const railPairs = [
    ['Cube.075', 'stone_processional_rail_flight_01_pos_x'],
    ['Cube.076', 'stone_processional_rail_flight_01_neg_x'],
    ['Cube', 'stone_processional_rail_flight_02_pos_x'],
    ['Cube.070', 'stone_processional_rail_flight_02_neg_x'],
    ['Cube.071', 'stone_processional_rail_flight_03_pos_x'],
    ['Cube.072', 'stone_processional_rail_flight_03_neg_x'],
    ['Cube.073', 'stone_processional_rail_flight_04_pos_x'],
    ['Cube.074', 'stone_processional_rail_flight_04_neg_x'],
];

for (const [sourceName, integratedName] of railPairs) {
    const sourceObject = userObjects.get(sourceName);
    const integratedObject = integratedObjects.get(integratedName);
    check(`${sourceName} maps to ${integratedName}`, sourceObject && integratedObject);
    check(`${integratedName} preserves world transform`,
        matrixClose(sourceObject.matrix_world, integratedObject.matrix_world));
    check(`${integratedName} is parented into the architecture`,
        integratedObject.parent === 'ziggurat_architecture_root'
        && integratedObject.collections.includes('20_PROCESSIONAL_STAIRS_AND_LANDINGS'));
    check(`${integratedName} retains sandstone identity`,
        JSON.stringify(integratedObject.materials) === '["SandstonePBR"]');
    const sourceMesh = user.meshes[sourceObject.data];
    const integratedMesh = integrated.meshes[integratedObject.data];
    for (const key of [
        'vertices', 'edges', 'polygons', 'triangles', 'position_hash',
        'topology_hash', 'smooth_hash', 'sharp_hash', 'corner_normal_hash',
        'degenerate_faces', 'nonmanifold_edges',
    ]) {
        check(`${integratedName} preserves ${key}`, sourceMesh[key] === integratedMesh[key]);
    }
    const sourceUv = sourceMesh.uv_layers[0];
    const integratedUv = integratedMesh.uv_layers[0];
    check(`${integratedName} changes UVs only as authorized`, sourceUv.hash !== integratedUv.hash);
    check(`${integratedName} UV density is repaired at believable scale`,
        integratedUv.median_uv_per_meter > 0.4
        && integratedUv.median_uv_per_meter > sourceUv.median_uv_per_meter * 4.5);
    check(`${integratedName} UVs are finite and cover every face`,
        integratedUv.nonfinite_components === 0 && integratedUv.zero_area_faces === 0);
}

const trimObjects = integrated.objects.filter((item) => (
    /^scifi_processional_cheek_insets_integrated_v2_flight_\d{2}_(?:pos|neg)_x$/.test(item.name)
));
check('exactly eight Metal010 flush trim objects were added', trimObjects.length === 8);
for (const object of trimObjects) {
    const mesh = integrated.meshes[object.data];
    check(`${object.name} uses SciFiMetal`, JSON.stringify(object.materials) === '["SciFiMetal"]');
    check(`${object.name} is a closed nondegenerate trim shell`,
        mesh.nonmanifold_edges === 0 && mesh.degenerate_faces === 0 && mesh.triangles === 188);
    check(`${object.name} has finite real-scale UVs`,
        mesh.uv_layers.length === 1
        && mesh.uv_layers[0].median_uv_per_meter > 0.4
        && mesh.uv_layers[0].nonfinite_components === 0
        && mesh.uv_layers[0].zero_area_faces === 0);
}

const fastenerObject = integratedObjects.get('scifi_panel_corner_fasteners');
const fastenerMesh = integrated.meshes[fastenerObject.data];
check('176 shifted fastener decals are restored against user panels',
    report.integration.fasteners.components === 176
    && report.integration.fasteners.shifted_vertex_count_left === 32
    && report.integration.fasteners.shifted_vertex_count_right === 32
    && close(report.integration.fasteners.left_shift_m, -0.2402391)
    && close(report.integration.fasteners.right_shift_m, 0.2852621));
const fastenerContract = report.integration.fasteners;
const fastenerMeasurements = fastenerContract.measurements_against_actual_panel_bounds;
check('fastener refinement records the exact smaller support and visible detail',
    fastenerContract.revision === 'corner_v2'
    && close(fastenerContract.support_plate_size_m, 0.235)
    && close(fastenerContract.visible_diameter_m, 0.090)
    && close(fastenerContract.surface_proud_m, 0.005)
    && fastenerContract.normal_map === true
    && fastenerContract.normal_map_source === 'ambientCG Metal010 NormalGL (CC0)'
    && fastenerContract.normal_projection === 'authored FastenerDecalUV');
check('all refined fasteners are measured against the actual shifted panel bounds',
    fastenerMeasurements.host_panel_components === 44
    && fastenerMeasurements.fastener_components === 176
    && fastenerMeasurements.fasteners_per_panel === 4
    && fastenerMeasurements.all_fasteners_matched_to_actual_panel_bounds === true
    && fastenerMeasurements.support_tangent_width_m.min >= 0.23499
    && fastenerMeasurements.support_tangent_width_m.max <= 0.23501
    && fastenerMeasurements.support_vertical_height_m.min >= 0.23499
    && fastenerMeasurements.support_vertical_height_m.max <= 0.23501
    && fastenerMeasurements.corner_center_horizontal_inset_m.min >= 0.226
    && fastenerMeasurements.corner_center_horizontal_inset_m.max <= 0.236
    && fastenerMeasurements.corner_center_vertical_inset_m.min >= 0.226
    && fastenerMeasurements.corner_center_vertical_inset_m.max <= 0.236
    && close(fastenerMeasurements.chamfer_line_clearance_m, 0.015));
check('fastener mesh keeps generated decal material and UVs',
    JSON.stringify(fastenerObject.materials) === '["FastenerDecal"]'
    && fastenerMesh.uv_layers.length === 1
    && fastenerMesh.uv_layers[0].name === 'FastenerDecalUV'
    && fastenerMesh.uv_layers[0].nonfinite_components === 0
    && fastenerMesh.degenerate_faces === 0
    && fastenerMesh.nonmanifold_edges === 0);
check('fastener object metadata carries its measured revision and normal map',
    fastenerObject.custom_properties.fastener_revision === 'corner_v2'
    && close(fastenerObject.custom_properties.support_plate_size_m, 0.235)
    && close(fastenerObject.custom_properties.visual_fastener_diameter_m, 0.090)
    && close(fastenerObject.custom_properties.chamfer_clearance_m, 0.015)
    && fastenerObject.custom_properties.normal_map === true
    && fastenerObject.custom_properties.normal_map_source
        === 'ambientCG Metal010 NormalGL (CC0)');

const openSurfaceMeshes = architecture.objects.filter((object) => (
    object.type === 'MESH' && architecture.meshes[object.data].nonmanifold_edges > 0
));
check('only the eight authoritative rail shells retain open-surface seams',
    openSurfaceMeshes.length === 8
    && openSurfaceMeshes.every((object) => (
        /^stone_processional_rail_flight_\d{2}_(?:pos|neg)_x$/.test(object.name)
        && architecture.meshes[object.data].nonmanifold_edges === 24
    )));
check('architecture topology totals match Blender audit',
    report.architecture_audit.meshes === 31
    && report.architecture_audit.triangles === 70192
    && report.architecture_audit.degenerate_faces === 0
    && report.architecture_audit.nonmanifold_edges === 192);
check('topology report explains seams and runtime safeguard',
    report.integration.user_rail_topology.nonmanifold_edges === 192
    && report.integration.user_rail_topology.interpretation.includes('24 authored open-surface seam edges')
    && report.integration.user_rail_topology.runtime_safeguard.includes('double-sided'));

for (const forbidden of [
    'stone_processional_retaining_walls',
    'scifi_processional_cheek_insets',
]) {
    check(`${forbidden} is not regenerated`, !architectureObjects.has(forbidden));
}

const materialByName = byName(architecture.materials);
check('editable SciFiMetal contains all four independent Metal010 maps',
    JSON.stringify(materialByName.get('SciFiMetal').images) === JSON.stringify([
        'Metal010_1K-JPG_Color.jpg',
        'Metal010_1K-JPG_Metalness.jpg',
        'Metal010_1K-JPG_NormalGL.jpg',
        'Metal010_1K-JPG_Roughness.jpg',
    ]));
check('editable FastenerDecal contains the generated RGBA and Metal010 NormalGL sources',
    JSON.stringify(materialByName.get('FastenerDecal').images) === JSON.stringify([
        'Metal010_1K-JPG_NormalGL.jpg',
        'panel_fastener_decal-v1.png',
    ])
    && materialByName.get('FastenerDecal').custom_properties.normal_map === true
    && materialByName.get('FastenerDecal').custom_properties.normal_map_source
        === 'ambientCG Metal010_1K-JPG_NormalGL.jpg (CC0)');

const glbBytes = bytes('assets/temple/ziggurat_architecture.glb');
const jsonLength = glbBytes.readUInt32LE(12);
const glb = JSON.parse(glbBytes.subarray(20, 20 + jsonLength).toString('utf8').trimEnd());
check('optimized runtime GLB contains 31 meshes and no duplicate texture payload',
    glb.meshes.length === 31 && (glb.images ?? []).length === 0 && (glb.textures ?? []).length === 0);

console.log(JSON.stringify({
    ok: true,
    assertions: checks.length,
    immutableSha256: report.authority.sha256,
    unchangedObjects: diff.summary.unchanged,
    userRails: railPairs.length,
    metalTrimPieces: trimObjects.length,
    fasteners: report.integration.fasteners.components,
    topology: report.architecture_audit,
}, null, 2));
