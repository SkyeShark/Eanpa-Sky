#!/usr/bin/env node

// Renderer-free CPU simulation of temple traversal/collision contracts.

import { makeTempleScene } from '../src/temple_real.js';
import {
    MAX_WALK_STEP_RISE,
    createAssistedStepState,
    tryBeginAssistedStep,
    advanceAssistedStep,
    shouldBlockHighSurfaceEntry,
} from '../src/movement_step.js';

// Match the exact namespace the live app passes into the scene builders.
globalThis.self = globalThis;
const [WEBGPU, TSL] = await Promise.all([
    import('../vendor/three/three.webgpu.js'),
    import('three/tsl'),
]);
const THREE = Object.assign({}, WEBGPU, TSL);

const checks = [];
const close = (a, b, tolerance = 1e-4) => Math.abs(a - b) <= tolerance;
function check(label, condition, detail = '') {
    if (!condition) throw new Error(`${label}${detail ? `: ${detail}` : ''}`);
    checks.push(label);
}

function material(name, emissive = 0x000000) {
    const value = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive });
    value.name = name;
    return value;
}

function mesh(name, dimensions, sourceMaterial, position = [0, 0, 0]) {
    const object = new THREE.Mesh(new THREE.BoxGeometry(...dimensions), sourceMaterial);
    object.name = name;
    object.position.set(...position);
    return object;
}

const shared = material('Material.001');
const pbrPixel = (rgba) => {
    const texture = new THREE.DataTexture(new Uint8Array(rgba), 1, 1);
    texture.needsUpdate = true;
    return texture;
};
shared.map = pbrPixel([128, 116, 104, 255]);
shared.normalMap = pbrPixel([128, 128, 255, 255]);
shared.roughnessMap = pbrPixel([180, 180, 180, 255]);
shared.metalnessMap = pbrPixel([220, 220, 220, 255]);
const fixtureMetalTextures = {
    albedo: pbrPixel([148, 151, 154, 255]),
    normal: pbrPixel([128, 128, 255, 255]),
    roughness: pbrPixel([184, 184, 184, 255]),
    metalness: pbrPixel([230, 230, 230, 255]),
};
const fastenerDecalTexture = pbrPixel([122, 126, 129, 255]);
const gate = new THREE.Group();
gate.add(mesh('Cube000', [4, 7.3, 24], shared, [0, 3.65, 0]));
gate.add(mesh('Cube001', [0.516, 6.38, 18.32], shared, [0, 3.19, 0]));
const wall = mesh('Cube003', [4, 7, 10], material('wall_placeholder'), [0, 3.5, 0]);
const pillar = mesh('Cube002', [4, 7, 4], material('pillar_placeholder'), [0, 3.5, 0]);
const watchtower = mesh('Cube004', [8, 9.5, 8], material('tower_placeholder'), [0, 4.75, 0]);

const orb = new THREE.Group();
orb.name = 'Sphere';
orb.add(new THREE.Mesh(new THREE.SphereGeometry(1, 20, 12), material('inanna')));
const inannaShellMaterial = orb.children[0].material;
const inannaShellSnapshot = {
    roughness: inannaShellMaterial.roughness,
    metalness: inannaShellMaterial.metalness,
    envMapIntensity: inannaShellMaterial.envMapIntensity,
    map: inannaShellMaterial.map,
    roughnessMap: inannaShellMaterial.roughnessMap,
    metalnessMap: inannaShellMaterial.metalnessMap,
    normalMap: inannaShellMaterial.normalMap,
};
const orbRedMaterial = material('light', 0xff0000);
const orbBlueMaterial = material('light.001', 0x0000ff);
orb.add(mesh('Sphere_red_light_primitive', [0.052, 0.113, 0.139], orbRedMaterial, [0.974, 0, 0]));
orb.add(mesh('Sphere_blue_light_primitive', [0.052, 0.113, 0.139], orbBlueMaterial, [-0.974, 0, 0]));

const ziggurat = new THREE.Group();
ziggurat.name = 'ziggurat_architecture_root';
const authoredMetadata = new THREE.Group();
authoredMetadata.name = 'ziggurat_authored_export_metadata';
authoredMetadata.userData.panel_corner_fasteners = 176;
ziggurat.add(authoredMetadata);
ziggurat.add(mesh('stone_entry_threshold', [17.3890533, 0.24, 1.2], material('SandstonePBR'), [0, -0.32, 43.95]));
ziggurat.add(mesh('stone_summit_landing', [15.3298225, 0.30, 0.75], material('SandstonePBR'), [0, 21.65, 5.175]));
ziggurat.add(mesh('tile_lapis_inlays', [1, 0.38, 0.075], material('LapisPBR'), [20, 6.32, 34]));
ziggurat.add(mesh('tile_carnelian_inlays', [1, 0.38, 0.075], material('CarnelianPBR'), [-20, 6.32, 34]));
ziggurat.add(mesh('scifi_inset_metal_panels', [3, 1, 0.1], material('SciFiMetal'), [18, 3, 34]));
ziggurat.add(mesh('scifi_panel_corner_fasteners', [0.235, 0.235, 0.005], material('FastenerDecal'), [18, 3, 33.9]));
ziggurat.add(mesh('scifi_processional_cheek_insets_integrated_v2_flight_01_pos_x', [0.18, 0.05, 12.8], material('SciFiMetal'), [7.95, 3, 39]));
ziggurat.add(mesh('stone_processional_rail_flight_01_pos_x', [0.44, 0.38, 13.03], material('SandstonePBR'), [7.95, 3, 39]));
ziggurat.add(mesh('scifi_dais_inset_metal_reveal', [5, 0.18, 5], material('SciFiMetal'), [0, 22.8, 0]));

const terrain = {
    position: new THREE.Vector3(),
    heightAt: () => 0,
};

const temple = await makeTempleScene(THREE, {
    terrain,
    fixtureMetalTextures,
    fastenerDecalTexture,
    inannaModel: orb,
    zigguratModel: ziggurat,
    perimeterModels: { gate, wall, pillar, watchtower },
});

const { group } = temple;
group.updateMatrixWorld(true);
const architecture = group.userData.architecture;
const runtimeInannaShell = group.getObjectByName('authored_inanna_orb_pivot')
    ?.children?.[0]?.children?.[0]?.material;
check('architectural reflection calibration leaves the Inanna shell exactly untouched',
    runtimeInannaShell === inannaShellMaterial
    && runtimeInannaShell.roughness === inannaShellSnapshot.roughness
    && runtimeInannaShell.metalness === inannaShellSnapshot.metalness
    && runtimeInannaShell.envMapIntensity === inannaShellSnapshot.envMapIntensity
    && runtimeInannaShell.map === inannaShellSnapshot.map
    && runtimeInannaShell.roughnessMap === inannaShellSnapshot.roughnessMap
    && runtimeInannaShell.metalnessMap === inannaShellSnapshot.metalnessMap
    && runtimeInannaShell.normalMap === inannaShellSnapshot.normalMap);
check('authored ziggurat selected', architecture.authoredZiggurat === true);
check('procedural fallback hidden', architecture.proceduralFallbackVisible === false);
check('runtime exposes 110 treads', architecture.stairTreads === 110);
check('runtime exposes four flights', architecture.stairFlights === 4);
check('runtime exposes three landings', architecture.stairLandings === 3);
check('runtime exposes the authoritative 15.5030928 m stair/collision width',
    close(architecture.stairWidth, 15.5030928));
check('runtime documents preserved user rail seams and enables double-sided safety',
    architecture.userRailOpenSurfaceSeamsPreserved === true
    && architecture.userRailDoubleSided === true);
check('runtime uses mapped fixture metal PBR', architecture.mappedFixtureMetalPbr === true);
check('runtime fixture PBR initializes independently of perimeter wall maps',
    architecture.fixtureMetalPbrReady === true
    && architecture.fixtureMetalSource === 'ambientCG Metal010 1K JPG (CC0)'
    && architecture.fixtureMetalSeparateChannels === true);
check('runtime uses distinct mapped rail and dais PBR',
    architecture.mappedRailMetalPbr === true && architecture.mappedDaisMetalPbr === true);
check('runtime uses mapped fastener metal PBR', architecture.mappedFastenerMetalPbr === true);
check('runtime exposes measured normal-mapped flush fastener treatment',
    architecture.fastenerTreatment.includes('176 Metal010-normal-mapped recessed RGBA decals')
    && architecture.fastenerTreatment.includes('0.090 m visible diameter')
    && architecture.fastenerTreatment.includes('0.235 m'));
check('runtime exposes saturated true-blue orb source', architecture.orbBlueEmitterHex === '#007cff');
check('runtime reads all 176 nested authored panel fasteners', architecture.panelCornerFasteners === 176);
check('runtime exposes two gradient beam volumes', architecture.gradientBeamVolumes === 2);
check('runtime keeps subtle local beam volumes at 52 m', architecture.beamLength === 52);
check('runtime exposes two 600 m spotlights',
    architecture.longRangeSpotLights === 2 && architecture.spotlightRange === 600);
check('runtime exposes one blue sphere anchor', architecture.sphereEmitterAnchors.blue === 1);
check('runtime exposes one red sphere anchor', architecture.sphereEmitterAnchors.red === 1);
check('runtime wall grammar is exact',
    architecture.perimeterGrammar.gateModules === 1
    && architecture.perimeterGrammar.wallBays === 32
    && architecture.perimeterGrammar.standalonePillars === 27
    && architecture.perimeterGrammar.watchtowers === 4
    && architecture.perimeterGrammar.gateAdjacentStandalonePillars === 0
    && architecture.perimeterGrammar.unsupportedWallEnds === 0);

const mappedPbrChannels = (objectName, expectedMaterialName, expectedRoughness, expectedMetalness) => {
    const object = group.getObjectByName(objectName);
    const mapped = object?.material;
    check(`${objectName} uses ${expectedMaterialName}`, mapped?.name === expectedMaterialName);
    check(`${objectName} exposes mapped basecolor/normal/roughness/metalness metadata`,
        mapped?.userData?.pbrMaps?.baseColor === true
        && mapped?.userData?.pbrMaps?.normalGL === true
        && mapped?.userData?.pbrMaps?.roughness === true
        && mapped?.userData?.pbrMaps?.metalness === true
        && mapped?.userData?.pbrMaps?.separateChannelTextures === true
        && mapped?.userData?.pbrMaps?.channelDecoding === 'roughness.r + metalness.r'
        && mapped?.userData?.pbrSource === 'ambientCG Metal010 1K JPG (CC0)');
    check(`${objectName} uses node-mapped PBR channels`,
        Boolean(mapped?.colorNode && mapped?.normalNode
            && mapped?.roughnessNode && mapped?.metalnessNode));
    check(`${objectName} has its calibrated non-mirror scalar fallback`,
        close(mapped.roughness, expectedRoughness)
        && close(mapped.metalness, expectedMetalness));
    return mapped;
};
const panelMapped = mappedPbrChannels(
    'scifi_inset_metal_panels', 'ambientCG_Metal010_dark_panel_metal', 0.66, 0.72,
);
const railMapped = mappedPbrChannels(
    'scifi_processional_cheek_insets_integrated_v2_flight_01_pos_x', 'ambientCG_Metal010_satin_rail_metal', 0.56, 0.68,
);
const daisMapped = mappedPbrChannels(
    'scifi_dais_inset_metal_reveal', 'ambientCG_Metal010_burnished_dais_metal', 0.43, 0.74,
);
check('panels, rails, and dais use three distinct materials',
    new Set([panelMapped, railMapped, daisMapped]).size === 3);
check('panels, rails, and dais expose visibly distinct roughness calibration',
    daisMapped.roughness < railMapped.roughness
    && railMapped.roughness < panelMapped.roughness);
check('mapped metal calibration keeps cloud-legible role-specific roughness ranges',
    JSON.stringify(panelMapped.userData.metalCalibration.roughRange) === '[0.52,0.78]'
    && JSON.stringify(railMapped.userData.metalCalibration.roughRange) === '[0.45,0.68]'
    && JSON.stringify(daisMapped.userData.metalCalibration.roughRange) === '[0.32,0.54]'
    && close(panelMapped.userData.metalCalibration.roughScale, 0.26)
    && close(panelMapped.userData.metalCalibration.roughBias, 0.52)
    && close(railMapped.userData.metalCalibration.roughScale, 0.23)
    && close(railMapped.userData.metalCalibration.roughBias, 0.45)
    && close(daisMapped.userData.metalCalibration.roughScale, 0.22)
    && close(daisMapped.userData.metalCalibration.roughBias, 0.32));
check('mapped architectural metals expose conservative native-PMREM energy',
    close(panelMapped.envMapIntensity, 0.78)
    && close(railMapped.envMapIntensity, 0.80)
    && close(daisMapped.envMapIntensity, 0.84)
    && panelMapped.envNode === null
    && railMapped.envNode === null
    && daisMapped.envNode === null);
const userRailMapped = group.getObjectByName('stone_processional_rail_flight_01_pos_x')?.material;
check('preserved user rail shell uses object-specific double-sided sandstone',
    userRailMapped?.name === 'PolyHaven_sandstone_blocks_05_double_sided_user_rails'
    && userRailMapped.side === THREE.DoubleSide,
    JSON.stringify({
        name: userRailMapped?.name,
        side: userRailMapped?.side,
        expectedSide: THREE.DoubleSide,
        nodes: Boolean(userRailMapped?.colorNode && userRailMapped?.normalNode && userRailMapped?.roughnessNode),
    }),
);
const fastenerMapped = group.getObjectByName('scifi_panel_corner_fasteners')?.material;
check('fasteners use generated recessed decal material',
    fastenerMapped?.name === 'generated_recessed_fastener_decal');
check('fasteners bind the generated RGBA source', fastenerMapped?.map === fastenerDecalTexture);
check('fasteners bind the shared Metal010 NormalGL map through authored decal UVs',
    fastenerMapped?.normalMap === fixtureMetalTextures.normal
    && close(fastenerMapped?.normalScale?.x, 0.34)
    && close(fastenerMapped?.normalScale?.y, 0.34)
    && fastenerMapped?.userData?.pbrSource
        === 'ImageGen recessed fastener RGBA decal v1 + ambientCG Metal010 NormalGL (CC0)'
    && fastenerMapped?.userData?.pbrMaps?.baseColorAlpha === true
    && fastenerMapped?.userData?.pbrMaps?.normalGL === true
    && fastenerMapped?.userData?.pbrMaps?.roughness === 'calibrated-scalar-0.40'
    && fastenerMapped?.userData?.pbrMaps?.projection === 'authored-decal-uv');
check('fasteners are restrained alpha-tested metal, not mirror studs',
    fastenerMapped?.transparent === true && close(fastenerMapped.alphaTest, 0.10)
    && close(fastenerMapped.roughness, 0.40)
    && close(fastenerMapped.metalness, 0.78)
    && close(fastenerMapped.envMapIntensity, 0.82)
    && fastenerMapped.envNode === null);

const perimeterMapped = group.getObjectByName('Cube000')?.material;
check('perimeter metal keeps its imported PBR textures under cloud-legible calibration',
    perimeterMapped?.name === 'Eidoverse_perimeter_shared_2K_PBR'
    && perimeterMapped.map === shared.map
    && perimeterMapped.normalMap === shared.normalMap
    && perimeterMapped.roughnessMap === shared.roughnessMap
    && perimeterMapped.metalnessMap === shared.metalnessMap
    && close(perimeterMapped.roughness, 0.42)
    && close(perimeterMapped.envMapIntensity, 0.86)
    && perimeterMapped.envNode === undefined);

const profile = architecture.stairProfile;
let treadChecks = 0;
for (const flight of profile) {
    const run = (flight.frontZ - flight.backZ) / flight.steps;
    const rise = (flight.backY - flight.frontY) / flight.steps;
    for (let index = 0; index < flight.steps; index++) {
        const localZ = flight.frontZ - (index + 0.5) * run;
        const expectedLocalY = flight.frontY + (index + 1) * rise;
        const actualWorldY = temple.walkSurfaceHeightAt(
            group.position.x,
            group.position.z + localZ,
        );
        check(`tread ${treadChecks + 1} collision top matches geometry schedule`,
            close(actualWorldY, group.position.y + expectedLocalY));
        treadChecks++;
    }
    if (flight.landingBackZ !== null) {
        const localZ = (flight.backZ + flight.landingBackZ) * 0.5;
        const actualWorldY = temple.walkSurfaceHeightAt(
            group.position.x,
            group.position.z + localZ,
        );
        check(`landing after flight ${profile.indexOf(flight) + 1} is walkable`,
            close(actualWorldY, group.position.y + flight.backY));
    }
}
check('all 110 visible treads were sampled', treadChecks === 110);

let previousHeight = null;
let maxAscent = 0;
let pathSamples = 0;
for (let localZ = 43.34; localZ >= 5.56; localZ -= 0.06) {
    const height = temple.walkSurfaceHeightAt(group.position.x, group.position.z + localZ);
    check('continuous stair path has a surface', Number.isFinite(height));
    if (previousHeight !== null) maxAscent = Math.max(maxAscent, height - previousHeight);
    previousHeight = height;
    pathSamples++;
}
check('forward traversal never requires more than one 0.20 m riser', maxAscent <= 0.2001, String(maxAscent));
check('stair traversal samples all flights densely', pathSamples > 600);

const summitSurface = temple.walkSurfaceAt(
    group.position.x + 4.51,
    group.position.z,
);
const lowerDaisSurface = temple.walkSurfaceAt(
    group.position.x + 4.49,
    group.position.z,
);
const upperDaisSurface = temple.walkSurfaceAt(
    group.position.x + 3.29,
    group.position.z,
);
check('summit terrace exposes a rich navigation surface',
    summitSurface?.kind === 'ziggurat_terrace_4');
check('lower Inanna dais is the only 1.05 m assisted course',
    lowerDaisSurface?.kind === 'inanna_dais_lower');
check('upper Inanna dais is the assisted 0.72 m course',
    upperDaisSurface?.kind === 'inanna_dais_upper');
check('ziggurat summit reports stone at foot height',
    temple.walkSurfaceTypeAt(
        group.position.x + 4.51,
        group.position.z,
        summitSurface.height,
    ) === 'stone');
check('temple surface type rejects a foot well above its top',
    temple.walkSurfaceTypeAt(
        group.position.x + 4.51,
        group.position.z,
        summitSurface.height + 2,
    ) === null);
check('temple surface type is null outside architecture',
    temple.walkSurfaceTypeAt(group.position.x + 90, group.position.z + 90, 0) === null);

const simulateAssistedCourse = (previousSurface, nextSurface, fromX, toX) => {
    const state = createAssistedStepState();
    const started = tryBeginAssistedStep(state, {
        previousSurface,
        nextSurface,
        previousX: group.position.x + fromX,
        previousZ: group.position.z,
        candidateX: group.position.x + toX,
        candidateZ: group.position.z,
        physicalEyeY: previousSurface.height + 1.82,
        eyeHeight: 1.82,
        grounded: true,
        jumpQueued: false,
    });
    check(`${nextSurface.kind} begins only through explicit assisted metadata`, started);
    let samples = 0;
    let previousEyeY = previousSurface.height + 1.82;
    let maxFrameRise = 0;
    let output = null;
    for (let frame = 0; frame < 120; frame++) {
        output = advanceAssistedStep(state, 1 / 60, {});
        maxFrameRise = Math.max(maxFrameRise, output.eyeY - previousEyeY);
        previousEyeY = output.eyeY;
        samples++;
        if (output.done) break;
    }
    check(`${nextSurface.kind} takes multiple visible frames`, samples > 24);
    check(`${nextSurface.kind} never teleports a large eye-height slice`, maxFrameRise < 0.06);
    check(`${nextSurface.kind} converges exactly to its top`,
        close(output.eyeY, nextSurface.height + 1.82));
    check(`${nextSurface.kind} converges exactly across its edge`,
        close(output.x, group.position.x + toX));
    return { samples, maxFrameRise, duration: state.lastDuration };
};

const lowerCourseTrace = simulateAssistedCourse(
    summitSurface,
    lowerDaisSurface,
    4.51,
    4.49,
);
const lowerInteriorSurface = temple.walkSurfaceAt(
    group.position.x + 3.31,
    group.position.z,
);
const upperCourseTrace = simulateAssistedCourse(
    lowerInteriorSurface,
    upperDaisSurface,
    3.31,
    3.29,
);

const untaggedWall = { height: summitSurface.height + 1.05, kind: 'untagged_wall' };
const rejectedState = createAssistedStepState();
check('untagged vertical wall cannot start assisted climbing',
    tryBeginAssistedStep(rejectedState, {
        previousSurface: summitSurface,
        nextSurface: untaggedWall,
        previousX: 5,
        previousZ: 0,
        candidateX: 4.9,
        candidateZ: 0,
        physicalEyeY: summitSurface.height + 1.82,
        eyeHeight: 1.82,
        grounded: true,
        jumpQueued: false,
    }) === false);
check('feet below an untagged high top are blocked',
    shouldBlockHighSurfaceEntry({
        previousSurface: summitSurface,
        nextSurface: untaggedWall,
        physicalEyeY: summitSurface.height + 1.82,
        eyeHeight: 1.82,
    }));
check('an airborne player may enter after feet genuinely clear the top',
    shouldBlockHighSurfaceEntry({
        previousSurface: summitSurface,
        nextSurface: untaggedWall,
        physicalEyeY: untaggedWall.height + 1.82 + 0.03,
        eyeHeight: 1.82,
    }) === false);
check('ordinary 0.20 m stair rise remains below assisted-step threshold',
    MAX_WALK_STEP_RISE > 0.20);

const camera = new THREE.PerspectiveCamera();
const previous = new THREE.Vector3();
previous.set(group.position.x + 180, group.position.y + 1.82, group.position.z + 180);
camera.position.copy(previous);
let collision = temple.resolveCamera(camera, previous);
check('far temple resolver culls every narrowphase component',
    Object.values(collision.physicsActive).every((active) => active === false));
check('far temple resolver performs zero component narrowphase checks',
    Object.values(group.userData.physicsStreaming.narrowphaseChecks)
        .every((count) => count === 0));
check('far temple navigation query is culled', temple.walkSurfaceAt(
    group.position.x + 180,
    group.position.z + 180,
) === null);
const tierTests = [
    { halfX: 35, eyeLocalY: 1.82 },
    { halfX: 29, eyeLocalY: 6.8 + 1.82 },
    { halfX: 23, eyeLocalY: 12.4 + 1.82 },
    { halfX: 17, eyeLocalY: 17.4 + 1.82 },
];
for (const [index, tier] of tierTests.entries()) {
    previous.set(group.position.x + tier.halfX + 1.2, group.position.y + tier.eyeLocalY, group.position.z);
    camera.position.set(group.position.x + tier.halfX - 0.2, group.position.y + tier.eyeLocalY, group.position.z);
    const result = temple.resolveCamera(camera, previous);
    check(`tier ${index + 1} side rejects auto-climb`, result.zigguratBlocked === true);
    check(`tier ${index + 1} pushes camera outside mass`,
        camera.position.x >= group.position.x + tier.halfX + 0.419);
}

const gatePlaneWorldZ = group.position.z + 48;
previous.set(group.position.x, group.position.y + 1.82, gatePlaneWorldZ + 2);
camera.position.set(group.position.x, group.position.y + 1.82, gatePlaneWorldZ);
collision = temple.resolveCamera(camera, previous);
check('closed authored gate leaf blocks player', collision.gateBlocked === true);

camera.position.set(group.position.x, group.position.y + 1.82, gatePlaneWorldZ + 8);
for (let frame = 0; frame < 180; frame++) temple.update(frame / 60, camera, 1 / 60);
check('proximity drives gate target open', temple.state.gateTarget === 1);
check('proximity fully retracts authored gate leaf', temple.state.gateProgress > 0.999);
previous.set(group.position.x, group.position.y + 1.82, gatePlaneWorldZ + 2);
camera.position.set(group.position.x, group.position.y + 1.82, gatePlaneWorldZ);
collision = temple.resolveCamera(camera, previous);
check('retracted gate leaf clears aperture', collision.gateBlocked === false);

camera.position.set(group.position.x + 30, group.position.y + 1.82, gatePlaneWorldZ + 30);
for (let frame = 0; frame < 300; frame++) temple.update(3 + frame / 60, camera, 1 / 60);
check('departing proximity closes gate target', temple.state.gateTarget === 0);
check('authored gate leaf returns closed', temple.state.gateProgress < 0.001);

const orbPivot = group.getObjectByName('authored_inanna_orb_pivot');
const orbCenter = new THREE.Vector3();
orbPivot.getWorldPosition(orbCenter);
for (const [name, axis] of [
    ['X', new THREE.Vector3(1, 0, 0)],
    ['Y', new THREE.Vector3(0, 1, 0)],
    ['Z', new THREE.Vector3(0, 0, 1)],
]) {
    previous.copy(orbCenter).addScaledVector(axis, 4);
    camera.position.copy(orbCenter).addScaledVector(axis, 0.25);
    collision = temple.resolveCamera(camera, previous);
    check(`orb blocks camera along ${name}`, collision.orbBlocked === true);
    check(`orb ${name} collision resolves to full 3D radius`,
        close(camera.position.distanceTo(orbCenter), 2.79, 0.002));
}

temple.update(9, camera, 1 / 60);
const blueBeam = group.getObjectByName('summit_blue_depth_tested_beam');
const redBeam = group.getObjectByName('summit_red_depth_tested_beam');
check('blue beam follows authored blue sphere island',
    blueBeam.userData.sourceMesh === 'Sphere_blue_light_primitive');
check('red beam follows authored red sphere island',
    redBeam.userData.sourceMesh === 'Sphere_red_light_primitive');
check('sphere beams originate on opposite lateral sides',
    Math.sign(blueBeam.position.x) !== Math.sign(redBeam.position.x));
check('sphere beams are tagged lateral/outward',
    blueBeam.userData.direction === 'lateral/outward'
    && redBeam.userData.direction === 'lateral/outward');

temple.setTime(0);
for (let frame = 0; frame < 240; frame++) temple.update(10 + frame / 60, camera, 1 / 60);
check('authored orb blue source is corrected to saturated true blue',
    orbBlueMaterial.emissive.getHex() === 0x007cff);
check('authored orb red source remains unchanged', orbRedMaterial.emissive.getHex() === 0xff0000);
const blueSpot = group.getObjectByName('summit_blue_long_range_spotlight');
const redSpot = group.getObjectByName('summit_red_long_range_spotlight');
for (const [channel, beam, spot] of [
    ['blue', blueBeam, blueSpot],
    ['red', redBeam, redSpot],
]) {
    check(`${channel} night beam is visible`, beam.visible === true);
    check(`${channel} night beam retains transparent gradient`,
        beam.material.transparent === true
        && beam.material.depthWrite === false
        && Boolean(beam.material.userData.gradient)
        && beam.material.userData.beamLevel.value > 0);
    check(`${channel} night spotlight is visible and energized`,
        spot.visible === true && spot.intensity > 0);
    check(`${channel} night spotlight is shadowed at 600 m`,
        spot.castShadow === true && spot.distance === 600 && spot.shadow.camera.far === 600);
}

console.log(JSON.stringify({
    ok: true,
    assertions: checks.length,
    treadsSampled: treadChecks,
    denseTraversalSamples: pathSamples,
    maxAscent,
    assistedStepTrace: {
        legacyOneFrameRise: {
            lowerCourse: lowerDaisSurface.height - summitSurface.height,
            upperCourse: upperDaisSurface.height - lowerInteriorSurface.height,
        },
        lowerCourse: lowerCourseTrace,
        upperCourse: upperCourseTrace,
    },
    gateFinalProgress: temple.state.gateProgress,
    orbCollisionRadius: 2.79,
    beamSources: [blueBeam.userData.sourceMesh, redBeam.userData.sourceMesh],
    panelCornerFasteners: architecture.panelCornerFasteners,
    mappedMetalObjects: 4,
    nightLighting: temple.nightLevel,
}, null, 2));

temple.dispose();
