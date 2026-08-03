#!/usr/bin/env node
// Structural acceptance for the articulated Aletheia first-person viewmodel.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const ROOT = new URL('../', import.meta.url);
const sourceUrl = new URL('assets/player/Aletheia_Chrome_1p_arms.glb', ROOT);
const authoringUrl = new URL('assets/player/Aletheia_Chrome_1p_arms_rigged.blend', ROOT);
const runtimeUrl = new URL('assets/player/runtime/Aletheia_Chrome_1p_arms_viewmodel.glb', ROOT);
const manifestUrl = new URL('assets/player/runtime/first_person_viewmodel_manifest.json', ROOT);
const topologyRecordsUrl = new URL('assets/player/runtime/Aletheia_Chrome_1p_arms_viewmodel_topology.json', ROOT);
const rigAuditUrl = new URL('artifacts/first-person-viewmodel/rig_audit.json', ROOT);
const skinZonesUrl = new URL('assets/player/Aletheia_Chrome_1p_arms_skin_zones.json', ROOT);
const hingeSeamsUrl = new URL('assets/player/Aletheia_Chrome_1p_arms_hinge_seams.json', ROOT);
const referenceUrl = new URL('assets/player/rig_reference/Drillimpact_PSX_First_Person_Arms_CC0.glb', ROOT);
const referenceNoticeUrl = new URL('assets/player/rig_reference/DRILLIMPACT_CC0_SOURCE.md', ROOT);

const DIGITS = ['thumb', 'index', 'middle', 'ring', 'pinky'];
const DIGIT_SEGMENTS = new Map([
    ['thumb', ['metacarpal', 'proximal', 'distal']],
    ['index', ['proximal', 'intermediate', 'distal']],
    ['middle', ['proximal', 'intermediate', 'distal']],
    ['ring', ['proximal', 'intermediate', 'distal']],
    ['pinky', ['proximal', 'intermediate', 'distal']],
]);
const DIGIT_CHAIN_PARTS = DIGITS.flatMap((digit) => (
    DIGIT_SEGMENTS.get(digit).map((segment) => `${digit}_${segment}`)
));
const CHAIN_PARTS = [
    'upper_arm', 'forearm', 'hand',
    ...DIGIT_CHAIN_PARTS,
];
const REQUIRED_BONES = [
    'viewmodel_root',
    ...['left', 'right'].flatMap((side) => CHAIN_PARTS.map((part) => `${side}_${part}`)),
].sort();
const REQUIRED_DIGIT_BONES = new Set(
    ['left', 'right'].flatMap((side) => DIGIT_CHAIN_PARTS.map((part) => `${side}_${part}`)),
);
const REQUIRED_CLIPS = [
    'Climb', 'ContactRecoil', 'Idle', 'Jump', 'Land', 'PushLeft', 'PushRight', 'Run', 'Walk',
];
const SAFE_REFERENCE_ACTIONS = ['rest', 'relax', 'push.L', 'push.R'];
const EXPECTED_SOURCE_SHA256 = 'c0b9c6cba54c316111d29878493a7a65ba94010a2756addd6f5a18a6c9fd5c1d';
const EXPECTED_HINGE_SHA256 = '23f873676fb704c8f02375bd4dd948229e0eb4f25a13a3df7fe6b99222e8219f';
const POSITION_QUANTIZATION = 1_000_000;
const SOURCE_RAW_VERTICES = 37_963;
const SOURCE_UNIQUE_POSITIONS = 27_739;
const SOURCE_TRIANGLES = 55_446;
const HAND_MINIMUM_Y = 0.64;
const HAND_RAW_VERTICES = 5_354;
const HAND_UNIQUE_POSITIONS = 3_533;
const HAND_SIDE_UNIQUE_POSITIONS = { left: 1_783, right: 1_750 };
const EXPECTED_MEASURED_THUMB_G0 = {
    left: [-0.21440955614108972, 0.7315297678786776, 0.27297088339979564],
    right: [0.21283561137302615, 0.7348357569955959, 0.28554807787474834],
};
const SKIN_ZONE_NAMES = new Set(['H', 'G0', 'S0', 'G1', 'S1', 'G2', 'S2']);
const EXPECTED_GASKET_NAMES = new Set(
    ['left', 'right'].flatMap((side) => (
        DIGITS.flatMap((digit) => [0, 1, 2].map((index) => `${side}_${digit}_G${index}`))
    )),
);
const EXPECTED_CONTOUR_NAMES = new Set(
    ['left', 'right'].flatMap((side) => (
        DIGITS.flatMap((digit) => (
            [0, 1, 2].flatMap((index) => (
                ['proximalBoundary', 'center', 'distalBoundary'].map(
                    (role) => `${side}_${digit}_G${index}_${role}`,
                )
            ))
        ))
    )),
);

let assertions = 0;
function check(value, message) {
    assert.ok(value, message);
    assertions++;
}
function equal(actual, expected, message) {
    assert.equal(actual, expected, message);
    assertions++;
}
function deepEqual(actual, expected, message) {
    assert.deepEqual(actual, expected, message);
    assertions++;
}
function sha256(buffer) {
    return createHash('sha256').update(buffer).digest('hex');
}

function validateFixedFrameSummary(record, sourceDocument, label) {
    check(record && typeof record === 'object' && !Array.isArray(record), `${label} exists`);
    equal(record.schemaVersion, 2, `${label} uses schema v2`);
    equal(record.jointProjectionCount, 30, `${label} covers all 30 joints`);
    equal(record.traceRecordCount, 90, `${label} covers all 90 contour traces`);
    check(Number.isFinite(record.maximumFitResidualMeters) && record.maximumFitResidualMeters <= 2e-7, `${label} trace fit stays within 0.2 micrometers`);
    equal(record.orderingViolationCount, 0, `${label} preserves proximal/center/distal ordering`);
    equal(record.widthContractViolationCount, 0, `${label} preserves measured gasket widths`);
    equal(record.adjacentGapViolationCount, 0, `${label} preserves rigid intervals between hinges`);
    equal(record.maximumAdditionalSeparationCorrectionMeters, 0, `${label} applies no fixed-frame position correction`);
    check(Number.isFinite(record.maximumAngularGapRadians) && record.maximumAngularGapRadians <= Math.PI * 0.5, `${label} has complete angular evidence`);
    check(
        Number.isFinite(record.maximumAngularGapDegrees)
        && Math.abs(record.maximumAngularGapDegrees - record.maximumAngularGapRadians * 180 / Math.PI) <= 1e-10,
        `${label} angular-gap units agree`,
    );

    check(Array.isArray(record.pivotRelocations), `${label} records evidence-backed pivot relocations`);
    const relocationKeys = record.pivotRelocations.map(
        (item) => `${item.side}/${item.digit}/${item.gasket}`,
    ).sort();
    deepEqual(relocationKeys, ['left/thumb/G0', 'right/thumb/G0'], `${label} relocates only the two measured thumb bases`);
    const expectedShift = { left: 0.027546875, right: 0.028671875 };
    for (const relocation of record.pivotRelocations) {
        deepEqual(relocation.oldHead, sourceDocument.jointPoints[relocation.side].thumb[0], `${label} ${relocation.side} thumb keeps its immutable source head`);
        deepEqual(relocation.newHead, EXPECTED_MEASURED_THUMB_G0[relocation.side], `${label} ${relocation.side} thumb uses the measured center-ring head`);
        check(Math.abs(relocation.shiftMeters - expectedShift[relocation.side]) <= 1e-12, `${label} ${relocation.side} thumb shift matches the measured offset`);
        check(relocation.selectionRule.includes('>2mm') && relocation.selectionRule.includes('<25%'), `${label} ${relocation.side} thumb records the strict evidence gate`);
    }
    check(Array.isArray(record.largeG0PivotOffsets), `${label} records the large-G0 evidence inventory`);
    deepEqual(
        record.largeG0PivotOffsets.map((item) => `${item.side}/${item.digit}/${item.gasket}`).sort(),
        ['left/thumb/G0', 'right/thumb/G0'],
        `${label} has exactly the two independently confirmed large G0 offsets`,
    );
}

function compareIntegerKeys(first, second) {
    for (let axis = 0; axis < 3; axis++) {
        if (first[axis] !== second[axis]) return first[axis] - second[axis];
    }
    return 0;
}

function parseGlb(buffer) {
    equal(buffer.toString('ascii', 0, 4), 'glTF', 'GLB magic');
    equal(buffer.readUInt32LE(4), 2, 'GLB version');
    equal(buffer.readUInt32LE(8), buffer.length, 'GLB declared length');
    let offset = 12;
    let json = null;
    let binary = null;
    while (offset < buffer.length) {
        const length = buffer.readUInt32LE(offset);
        const type = buffer.readUInt32LE(offset + 4);
        const data = buffer.subarray(offset + 8, offset + 8 + length);
        if (type === 0x4e4f534a) json = JSON.parse(data.toString('utf8').replace(/[\0\s]+$/g, ''));
        if (type === 0x004e4942) binary = data;
        offset += 8 + length;
    }
    check(json && binary, 'GLB has JSON and BIN chunks');
    return { json, binary };
}

function pngSize(buffer) {
    equal(buffer.toString('ascii', 1, 4), 'PNG', 'image is PNG');
    return [buffer.readUInt32BE(16), buffer.readUInt32BE(20)];
}

function imageBytes(glb, image) {
    const view = glb.json.bufferViews[image.bufferView];
    return glb.binary.subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength);
}

const sourceBuffer = readFileSync(sourceUrl);
const authoringBuffer = readFileSync(authoringUrl);
const runtimeBuffer = readFileSync(runtimeUrl);
const topologyRecordsBuffer = readFileSync(topologyRecordsUrl);
const referenceBuffer = readFileSync(referenceUrl);
const skinZonesBuffer = readFileSync(skinZonesUrl);
const hingeSeamsBuffer = readFileSync(hingeSeamsUrl);
const source = parseGlb(sourceBuffer);
const runtime = parseGlb(runtimeBuffer);
const manifest = JSON.parse(readFileSync(manifestUrl, 'utf8'));
const topologyRecords = JSON.parse(topologyRecordsBuffer.toString('utf8'));
const rigAudit = JSON.parse(readFileSync(rigAuditUrl, 'utf8'));
const skinZones = JSON.parse(skinZonesBuffer.toString('utf8'));
const hingeSeams = JSON.parse(hingeSeamsBuffer.toString('utf8'));
const referenceNotice = readFileSync(referenceNoticeUrl, 'utf8');

equal(sha256(sourceBuffer), EXPECTED_SOURCE_SHA256, 'authored Chrome source matches the fixed mechanical-zone lock');
equal(skinZones.schemaVersion, 1, 'mechanical skin-zone schema v1');
equal(skinZones.quantization, POSITION_QUANTIZATION, 'mechanical skin-zone integer quantization');
deepEqual(skinZones.source, {
    file: 'assets/player/Aletheia_Chrome_1p_arms.glb',
    sha256: EXPECTED_SOURCE_SHA256,
    rawVertexCount: SOURCE_RAW_VERTICES,
    uniquePositionCount: SOURCE_UNIQUE_POSITIONS,
}, 'mechanical skin-zone source metadata is exact');
deepEqual(skinZones.handRegion, {
    minimumY: HAND_MINIMUM_Y,
    rawVertexCount: HAND_RAW_VERTICES,
    uniquePositionCount: HAND_UNIQUE_POSITIONS,
    leftUniquePositionCount: HAND_SIDE_UNIQUE_POSITIONS.left,
    rightUniquePositionCount: HAND_SIDE_UNIQUE_POSITIONS.right,
}, 'mechanical skin-zone hand-region metadata is exact');
check(skinZones.jointPoints && typeof skinZones.jointPoints === 'object', 'mechanical skin-zone joint points exist');
deepEqual(Object.keys(skinZones.jointPoints).sort(), ['left', 'right'], 'mechanical skin-zone joint points cover both sides');
for (const side of ['left', 'right']) {
    deepEqual(Object.keys(skinZones.jointPoints[side]).sort(), [...DIGITS].sort(), `${side} mechanical joint points cover five digits`);
    for (const digit of DIGITS) {
        const points = skinZones.jointPoints[side][digit];
        equal(points.length, 4, `${side} ${digit} has three pivots and one tip point`);
        check(
            points.every((point) => (
                Array.isArray(point)
                && point.length === 3
                && point.every(Number.isFinite)
            )),
            `${side} ${digit} mechanical joint points are finite vec3s`,
        );
    }
}

check(Array.isArray(skinZones.records), 'mechanical skin-zone records are a list');
equal(skinZones.records.length, HAND_UNIQUE_POSITIONS, 'mechanical skin-zone map covers all 3,533 unique hand positions');
const skinZoneRecordKeys = [];
const skinZoneKeyStrings = new Set();
const skinZoneCounts = {};
const skinZoneSideCounts = { left: 0, right: 0 };
for (const [index, record] of skinZones.records.entries()) {
    check(record && typeof record === 'object' && !Array.isArray(record), `skin-zone record ${index} is an object`);
    check(
        Array.isArray(record.key)
        && record.key.length === 3
        && record.key.every(Number.isInteger),
        `skin-zone record ${index} has an integer vec3 key`,
    );
    const key = record.key;
    const keyString = key.join(',');
    check(!skinZoneKeyStrings.has(keyString), `skin-zone key ${keyString} is unique`);
    skinZoneKeyStrings.add(keyString);
    skinZoneRecordKeys.push(key);
    check(key[0] !== 0, `skin-zone key ${keyString} is unambiguously sided`);
    const expectedSide = key[0] < 0 ? 'left' : 'right';
    equal(record.side, expectedSide, `skin-zone key ${keyString} side matches its coordinate`);
    check(SKIN_ZONE_NAMES.has(record.zone), `skin-zone key ${keyString} uses a known mechanical zone`);
    if (record.zone === 'H') {
        equal(record.digit, null, `hand-zone key ${keyString} has no digit owner`);
        equal(record.blend, null, `hand-zone key ${keyString} has no blend`);
    } else {
        check(DIGITS.includes(record.digit), `digit-zone key ${keyString} has a valid digit owner`);
        if (record.zone.startsWith('S')) {
            equal(record.blend, null, `rigid-zone key ${keyString} has no blend`);
        } else {
            check(
                Number.isFinite(record.blend) && record.blend >= 0 && record.blend <= 1,
                `gasket-zone key ${keyString} has a normalized blend`,
            );
        }
    }
    skinZoneSideCounts[record.side]++;
    const countName = `${record.side}/${record.digit ?? 'hand'}/${record.zone}`;
    skinZoneCounts[countName] = (skinZoneCounts[countName] ?? 0) + 1;
}
deepEqual(skinZoneRecordKeys, [...skinZoneRecordKeys].sort(compareIntegerKeys), 'mechanical skin-zone records are lexicographically key-sorted');
equal(skinZoneKeyStrings.size, HAND_UNIQUE_POSITIONS, 'mechanical skin-zone keys are all unique');
deepEqual(skinZoneSideCounts, HAND_SIDE_UNIQUE_POSITIONS, 'mechanical skin-zone record counts match both hands');
check(
    skinZones.evidenceSummary.status.includes('temporary rejected vertex-only baseline'),
    'source skin zones are explicitly limited to ownership seeding',
);

equal(sha256(hingeSeamsBuffer), EXPECTED_HINGE_SHA256, 'measured hinge specification hash is fixed');
equal(hingeSeams.schemaVersion, 1, 'measured hinge specification schema v1');
equal(hingeSeams.angleSampleCount, 32, 'measured hinge specification has 32 angular samples');
deepEqual(hingeSeams.source, {
    file: 'assets/player/Aletheia_Chrome_1p_arms.glb',
    sha256: EXPECTED_SOURCE_SHA256,
    rawVertexCount: SOURCE_RAW_VERTICES,
    rawTriangleCount: SOURCE_TRIANGLES,
}, 'measured hinge specification has the exact source lock');
deepEqual(hingeSeams.jointPoints, skinZones.jointPoints, 'measured traces and source ownership use identical joint points');
equal(hingeSeams.angleSamplesRadians.length, 32, 'measured hinge angular coordinate list is complete');
for (const [index, angle] of hingeSeams.angleSamplesRadians.entries()) {
    check(
        Number.isFinite(angle) && Math.abs(angle - (Math.PI * 2 * index / 32)) <= 1e-12,
        `measured hinge angle ${index} is exact`,
    );
}
let measuredJointCount = 0;
let measuredContourCount = 0;
let measuredFaceSegmentCount = 0;
let measuredUniqueIntersectionCount = 0;
let measuredMinimumWidth = Number.POSITIVE_INFINITY;
let measuredMaximumWidth = 0;
const measuredContourRoles = new Map([
    ['proximalBoundary', 0],
    ['center', 0.5],
    ['distalBoundary', 1],
]);
for (const side of ['left', 'right']) {
    deepEqual(Object.keys(hingeSeams.seams[side]).sort(), [...DIGITS].sort(), `${side} measured traces cover five digits`);
    for (const digit of DIGITS) {
        const digitRecord = hingeSeams.seams[side][digit];
        deepEqual(digitRecord.chainPoints, skinZones.jointPoints[side][digit], `${side} ${digit} trace chain matches the rig`);
        check(
            Number.isFinite(digitRecord.radialLimit)
            && digitRecord.radialLimit >= 0.02
            && digitRecord.radialLimit <= 0.10,
            `${side} ${digit} radial limit is bounded`,
        );
        deepEqual(Object.keys(digitRecord.joints).sort(), ['G0', 'G1', 'G2'], `${side} ${digit} has three measured gaskets`);
        for (const gasket of ['G0', 'G1', 'G2']) {
            const joint = digitRecord.joints[gasket];
            equal(joint.subdivision, 'required', `${side} ${digit} ${gasket} requires seam-aligned subdivision`);
            for (const field of ['proximal', 'center', 'distal', 'halfWidth']) {
                check(
                    Array.isArray(joint[field])
                    && joint[field].length === 32
                    && joint[field].every(Number.isFinite),
                    `${side} ${digit} ${gasket} ${field} has 32 finite samples`,
                );
            }
            for (let sample = 0; sample < 32; sample++) {
                const proximal = joint.proximal[sample];
                const center = joint.center[sample];
                const distal = joint.distal[sample];
                const width = distal - proximal;
                check(proximal <= center + 1e-10 && center <= distal + 1e-10, `${side} ${digit} ${gasket} sample ${sample} is ordered`);
                check(width >= 0.002 - 1e-10 && width <= 0.007 + 1e-10, `${side} ${digit} ${gasket} sample ${sample} stays within 2-7 mm`);
                check(Math.abs(joint.halfWidth[sample] - width * 0.5) <= 1e-9, `${side} ${digit} ${gasket} sample ${sample} half-width is exact`);
                measuredMinimumWidth = Math.min(measuredMinimumWidth, width);
                measuredMaximumWidth = Math.max(measuredMaximumWidth, width);
            }
            equal(joint.contours.length, 3, `${side} ${digit} ${gasket} has three recorded contours`);
            const roles = new Set();
            for (const contour of joint.contours) {
                check(measuredContourRoles.has(contour.role), `${side} ${digit} ${gasket} contour role is known`);
                check(!roles.has(contour.role), `${side} ${digit} ${gasket} contour role is unique`);
                roles.add(contour.role);
                equal(contour.rawBlendT, measuredContourRoles.get(contour.role), `${side} ${digit} ${gasket} ${contour.role} raw blend is exact`);
                check(Array.isArray(contour.segments) && contour.segments.length > 0, `${side} ${digit} ${gasket} ${contour.role} records source face crossings`);
                equal(contour.crossedFaceCount, contour.segments.length, `${side} ${digit} ${gasket} ${contour.role} face count is exact`);
                const intersections = new Set();
                for (const segment of contour.segments) {
                    check(Number.isInteger(segment.faceIndex) && segment.faceIndex >= 0 && segment.faceIndex < SOURCE_TRIANGLES, `${side} ${digit} ${gasket} segment face index is valid`);
                    check(Array.isArray(segment.rawVertexIndices) && segment.rawVertexIndices.length === 3, `${side} ${digit} ${gasket} segment records its source triangle`);
                    equal(segment.intersections.length, 2, `${side} ${digit} ${gasket} segment has two edge intersections`);
                    for (const intersection of segment.intersections) {
                        check(
                            Array.isArray(intersection.position)
                            && intersection.position.length === 3
                            && intersection.position.every(Number.isFinite)
                            && Array.isArray(intersection.uv)
                            && intersection.uv.length === 2
                            && intersection.uv.every(Number.isFinite)
                            && Array.isArray(intersection.normal)
                            && intersection.normal.length === 3
                            && intersection.normal.every(Number.isFinite),
                            `${side} ${digit} ${gasket} intersection attributes are finite`,
                        );
                        let [first, second] = intersection.edgeRawVertexIndices;
                        let alpha = intersection.alphaFromFirst;
                        check(
                            Number.isInteger(first)
                            && Number.isInteger(second)
                            && segment.rawVertexIndices.includes(first)
                            && segment.rawVertexIndices.includes(second)
                            && Number.isFinite(alpha)
                            && alpha >= 0
                            && alpha <= 1,
                            `${side} ${digit} ${gasket} intersection lies on its source edge`,
                        );
                        if (first > second) {
                            [first, second] = [second, first];
                        }
                        intersections.add(`${first}/${second}`);
                    }
                }
                equal(intersections.size, contour.uniqueRawEdgeIntersectionCount, `${side} ${digit} ${gasket} ${contour.role} unique intersections are exact`);
                measuredFaceSegmentCount += contour.segments.length;
                measuredUniqueIntersectionCount += intersections.size;
                measuredContourCount++;
            }
            deepEqual(roles, new Set(measuredContourRoles.keys()), `${side} ${digit} ${gasket} contour roles are complete`);
            measuredJointCount++;
        }
    }
}
equal(measuredJointCount, 30, 'measured hinge specification covers all 30 joints');
equal(measuredContourCount, 90, 'measured hinge specification contains 90 contours');
equal(measuredFaceSegmentCount, 3_544, 'measured hinge specification records 3,544 source face segments');
equal(measuredUniqueIntersectionCount, 4_191, 'measured hinge specification records 4,191 contour edge intersections');
equal(hingeSeams.crossSeamFaceOverlaps.length, 201, 'measured hinge specification inventories all 201 cross-joint face overlaps');

equal(source.json.skins?.length ?? 0, 0, 'authored Aletheia source remains unrigged');
equal(source.json.animations?.length ?? 0, 0, 'authored Aletheia source remains unanimated');
equal(runtime.json.skins?.length ?? 0, 1, 'runtime has one skin');
equal(runtime.json.animations?.length ?? 0, 9, 'runtime has nine articulated clips');
equal(runtime.json.meshes?.length ?? 0, 1, 'runtime contains only the Aletheia Chrome mesh');
equal(runtime.json.meshes[0].primitives.length, 1, 'runtime contains one complete skinned primitive');
check(runtimeBuffer.length < sourceBuffer.length * 0.4, 'runtime payload remains below 40% of source');

const primitive = runtime.json.meshes[0].primitives[0];
check(Number.isInteger(primitive.attributes.JOINTS_0), 'runtime mesh has JOINTS_0');
check(Number.isInteger(primitive.attributes.WEIGHTS_0), 'runtime mesh has WEIGHTS_0');
const runtimeTriangleCount = runtime.json.accessors[primitive.indices].count / 3;
equal(runtimeTriangleCount, manifest.runtime.triangles, 'runtime triangle count matches the manifest');
check(runtimeTriangleCount > SOURCE_TRIANGLES, 'runtime contains the seam-subdivided triangle topology');

const clipNames = runtime.json.animations.map((animation) => animation.name).sort();
deepEqual(clipNames, REQUIRED_CLIPS, 'all locomotion, airborne, push, recoil, and climb clips exported');
const skin = runtime.json.skins[0];
const jointNames = skin.joints.map((node) => runtime.json.nodes[node].name).sort();
deepEqual(jointNames, REQUIRED_BONES, '37-bone anatomical arm/hand rig exported');
equal(jointNames.length, 37, 'runtime joint count');

const nodeIndex = new Map(runtime.json.nodes.map((node, index) => [node.name, index]));
const parentIndex = new Map();
runtime.json.nodes.forEach((node, parent) => {
    for (const child of node.children ?? []) parentIndex.set(child, parent);
});
for (const side of ['left', 'right']) {
    equal(parentIndex.get(nodeIndex.get(`${side}_upper_arm`)), nodeIndex.get('viewmodel_root'), `${side} upper arm parent`);
    equal(parentIndex.get(nodeIndex.get(`${side}_forearm`)), nodeIndex.get(`${side}_upper_arm`), `${side} forearm parent`);
    equal(parentIndex.get(nodeIndex.get(`${side}_hand`)), nodeIndex.get(`${side}_forearm`), `${side} hand parent`);
    for (const digit of DIGITS) {
        const segments = DIGIT_SEGMENTS.get(digit);
        let expectedParent = `${side}_hand`;
        for (const segment of segments) {
            const bone = `${side}_${digit}_${segment}`;
            equal(parentIndex.get(nodeIndex.get(bone)), nodeIndex.get(expectedParent), `${bone} parent`);
            expectedParent = bone;
        }
    }
}

for (const animation of runtime.json.animations) {
    const rotationTargets = new Set(
        animation.channels
            .filter((channel) => channel.target.path === 'rotation')
            .map((channel) => runtime.json.nodes[channel.target.node]?.name)
            .filter(Boolean),
    );
    check(rotationTargets.has('left_upper_arm') && rotationTargets.has('right_upper_arm'), `${animation.name} rotates both upper arms`);
    check(rotationTargets.has('left_forearm') && rotationTargets.has('right_forearm'), `${animation.name} rotates both forearms`);
    check(rotationTargets.has('left_hand') && rotationTargets.has('right_hand'), `${animation.name} rotates both hands`);
    check(
        [...rotationTargets].filter((name) => REQUIRED_DIGIT_BONES.has(name)).length >= 30,
        `${animation.name} carries all three-segment digit rotation channels`,
    );
}

const expectedImages = new Map([
    ['Aletheia_Chrome_Viewmodel_BaseColor_4K', [4096, 4096]],
    ['Aletheia_Chrome_Viewmodel_Normal_2K', [2048, 2048]],
    ['Aletheia_Chrome_Viewmodel_MetallicRoughness_2K', [2048, 2048]],
]);
equal(runtime.json.images.length, 3, 'runtime embeds exactly three Aletheia PBR images');
for (const image of runtime.json.images) {
    check(expectedImages.has(image.name), `known embedded Aletheia image ${image.name}`);
    deepEqual(pngSize(imageBytes(runtime, image)), expectedImages.get(image.name), `${image.name} dimensions`);
    equal(image.mimeType, 'image/png', `${image.name} MIME`);
}
for (const record of manifest.textures) {
    const bytes = readFileSync(new URL(record.file, ROOT));
    deepEqual(pngSize(bytes), record.runtimeSize, `${record.role} standalone PBR master dimensions`);
}

equal(manifest.schemaVersion, 3, 'manifest schema v3');
equal(manifest.source.file, 'assets/player/Aletheia_Chrome_1p_arms.glb', 'manifest Chrome source path');
equal(manifest.source.bytes, sourceBuffer.length, 'manifest Chrome source byte count');
equal(manifest.source.sha256, sha256(sourceBuffer), 'manifest Chrome source hash');
equal(manifest.authoring.file, 'assets/player/Aletheia_Chrome_1p_arms_rigged.blend', 'manifest authored Blend path');
equal(manifest.authoring.bytes, authoringBuffer.length, 'manifest authored Blend byte count');
equal(manifest.authoring.sha256, sha256(authoringBuffer), 'manifest authored Blend hash');
check(/^\d+\.\d+\.\d+$/.test(manifest.authoring.blenderVersion), 'manifest records the authoring Blender version');
equal(manifest.authoring.containsMotionReference, true, 'authored Blend retains the CC0 motion reference');
equal(manifest.runtime.file, 'assets/player/runtime/Aletheia_Chrome_1p_arms_viewmodel.glb', 'manifest Chrome runtime path');
equal(manifest.runtime.sha256, sha256(runtimeBuffer), 'manifest runtime hash');
equal(manifest.motionReference.sha256, sha256(referenceBuffer), 'manifest CC0 motion reference hash');
equal(manifest.motionReference.license, 'CC0 / Public Domain', 'motion reference license');
deepEqual(manifest.motionReference.usedActions, SAFE_REFERENCE_ACTIONS, 'only safe source actions retargeted');
check(manifest.motionReference.excludedActionPrefixes.includes('finger_gun_'), 'finger-gun actions explicitly excluded');
check(manifest.motionReference.excludedActionPrefixes.includes('knife_'), 'weapon actions explicitly excluded');
check(referenceNotice.includes('CC0 / Public Domain'), 'checked-in CC0 notice');
check(referenceNotice.includes('drillimpact.itch.io/psx-first-person-arms-free'), 'checked-in official source URL');
equal(manifest.runtime.animationCount, 9, 'manifest animation count');
deepEqual([...manifest.rig.bones].sort(), REQUIRED_BONES, 'manifest bone list');
equal(manifest.rig.restPose.bakedAsArmatureRest, false, 'clean source modeling pose remains the stable bind pose');
check(manifest.rig.restPose.authoredNaturalPose.includes('every clip'), 'natural posture is the common authored clip basis');
check(manifest.rig.weighting.includes('source-hash-locked mechanical hinge topology'), 'manifest records the measured hinge-topology contract');
check(manifest.rig.weighting.includes('three measured non-planar contours'), 'manifest records all three inserted contour roles');
check(manifest.rig.weighting.includes('palm and chrome phalanges are rigid'), 'manifest records rigid mechanical panel weighting');
check(manifest.rig.weighting.includes('measured 2-7 mm gasket strips'), 'manifest confines blending to measured narrow gasket strips');
check(manifest.rig.weighting.includes('every UV/normal duplicate shares one exact weight vector'), 'manifest records coherent attribute-island weight assignment');
check(manifest.rig.weighting.includes('at most two influences'), 'manifest records the mechanical influence limit');
equal(manifest.rig.skinZones.file, 'assets/player/Aletheia_Chrome_1p_arms_skin_zones.json', 'manifest mechanical skin-zone path');
equal(manifest.rig.skinZones.sha256, sha256(skinZonesBuffer), 'manifest mechanical skin-zone hash');
equal(manifest.rig.skinZones.schemaVersion, 1, 'manifest mechanical skin-zone schema');
equal(manifest.rig.skinZones.sourceSha256, EXPECTED_SOURCE_SHA256, 'manifest mechanical skin-zone source lock');
equal(manifest.rig.skinZones.quantization, POSITION_QUANTIZATION, 'manifest mechanical skin-zone quantization');
deepEqual(manifest.rig.skinZones.handRegion, skinZones.handRegion, 'manifest mechanical hand-region provenance');
equal(manifest.rig.skinZones.recordCount, HAND_UNIQUE_POSITIONS, 'manifest mechanical skin-zone record count');
deepEqual(manifest.rig.skinZones.zoneCounts, skinZoneCounts, 'manifest records every side/digit/zone count');
check(manifest.rig.skinZones.assignment.includes('one weight vector shared'), 'manifest records exact duplicate weight sharing');
equal(manifest.rig.skinZones.sourcePositionGroupCount, SOURCE_UNIQUE_POSITIONS, 'manifest records every pre-cut source position group');
const topologyRecordMetadata = manifest.rig.topologyRecords;
check(topologyRecordMetadata && typeof topologyRecordMetadata === 'object', 'manifest records the exact post-cut topology sidecar');
equal(topologyRecordMetadata.file, 'assets/player/runtime/Aletheia_Chrome_1p_arms_viewmodel_topology.json', 'manifest topology-record sidecar path');
equal(topologyRecordMetadata.bytes, topologyRecordsBuffer.length, 'manifest topology-record sidecar byte count');
equal(topologyRecordMetadata.sha256, sha256(topologyRecordsBuffer), 'manifest topology-record sidecar hash');
equal(topologyRecordMetadata.schemaVersion, 1, 'manifest topology-record sidecar schema');
equal(topologyRecordMetadata.quantization, POSITION_QUANTIZATION, 'manifest topology-record key quantization');
equal(topologyRecordMetadata.handRegionMinimumY, HAND_MINIMUM_Y, 'manifest topology-record hand cutoff');
equal(topologyRecordMetadata.sourceSha256, EXPECTED_SOURCE_SHA256, 'manifest topology-record source lock');
equal(topologyRecordMetadata.runtimeSha256, sha256(runtimeBuffer), 'manifest topology records lock the exact runtime GLB');
equal(topologyRecords.schemaVersion, 1, 'topology-record sidecar schema v1');
equal(topologyRecords.coordinateSystem, 'Blender source-mesh local coordinates', 'topology-record sidecar coordinate system');
equal(topologyRecords.quantization, POSITION_QUANTIZATION, 'topology-record sidecar key quantization');
equal(topologyRecords.handRegionMinimumY, HAND_MINIMUM_Y, 'topology-record sidecar hand cutoff');
deepEqual(topologyRecords.source, {
    file: 'assets/player/Aletheia_Chrome_1p_arms.glb',
    sha256: EXPECTED_SOURCE_SHA256,
}, 'topology-record sidecar source lock');
deepEqual(topologyRecords.runtime, {
    file: 'assets/player/runtime/Aletheia_Chrome_1p_arms_viewmodel.glb',
    sha256: sha256(runtimeBuffer),
}, 'topology-record sidecar runtime lock');
const fixedFrameSummary = manifest.rig.hingeSeams.fixedFrameReparameterization;
validateFixedFrameSummary(fixedFrameSummary, hingeSeams, 'manifest fixed-frame hinge summary');
deepEqual(manifest.rig.hingeSeams, {
    file: 'assets/player/Aletheia_Chrome_1p_arms_hinge_seams.json',
    sha256: EXPECTED_HINGE_SHA256,
    schemaVersion: 1,
    sourceSha256: EXPECTED_SOURCE_SHA256,
    angleSampleCount: 32,
    jointCount: 30,
    contoursPerJoint: 3,
    recordedSourceFaceSegments: measuredFaceSegmentCount,
    fixedFrameReparameterization: fixedFrameSummary,
}, 'manifest records exact measured hinge-spec provenance');
const subdividedTopology = manifest.rig.subdividedTopology;
equal(subdividedTopology.method, 'three measured non-planar contours per authored hinge in continuous joint-local frames', 'manifest records the subdivision method');
equal(subdividedTopology.jointCount, 30, 'manifest subdivision covers 30 joints');
equal(subdividedTopology.contourCount, 90, 'manifest subdivision contains 90 contour cuts');
equal(subdividedTopology.sourceRawVertexCount, SOURCE_RAW_VERTICES, 'manifest subdivision starts from the exact raw source vertices');
equal(subdividedTopology.sourceTriangleCount, SOURCE_TRIANGLES, 'manifest subdivision starts from the exact source triangles');
check(Number.isInteger(subdividedTopology.insertedRawVertexCount) && subdividedTopology.insertedRawVertexCount > 0, 'manifest records inserted raw vertices');
equal(subdividedTopology.subdividedRawVertexCount, SOURCE_RAW_VERTICES + subdividedTopology.insertedRawVertexCount, 'manifest post-cut raw vertices equal source plus insertions');
check(Number.isInteger(subdividedTopology.subdividedFaceCount) && subdividedTopology.subdividedFaceCount > SOURCE_TRIANGLES, 'manifest records additional subdivided faces');
check(Number.isInteger(subdividedTopology.insertedUniqueHandPositionCount) && subdividedTopology.insertedUniqueHandPositionCount > 0, 'manifest records inserted unique hand positions');
equal(
    Object.values(subdividedTopology.zoneCounts).reduce((sum, count) => sum + count, 0),
    HAND_UNIQUE_POSITIONS + subdividedTopology.insertedUniqueHandPositionCount,
    'manifest final zone counts cover source and inserted hand positions',
);
check(subdividedTopology.attributePolicy.includes('UV/custom-normal') && subdividedTopology.attributePolicy.includes('no welding'), 'manifest preserves source attribute islands through subdivision');
check(subdividedTopology.weightPolicy.includes('rigid chrome') && subdividedTopology.weightPolicy.includes('raw t') && subdividedTopology.weightPolicy.includes('smoothstep'), 'manifest records rigid panels and one eased gasket blend');
const fixedFrameProjection = subdividedTopology.fixedFrameProjection;
check(fixedFrameProjection && typeof fixedFrameProjection === 'object', 'manifest retains the full independently generated fixed-frame audit');
equal(fixedFrameProjection.schemaVersion, 2, 'fixed-frame projection audit uses schema v2');
equal(fixedFrameProjection.jointCount, 30, 'fixed-frame projection audit covers all 30 joints');
equal(fixedFrameProjection.traceRecordCount, 90, 'fixed-frame projection audit covers all 90 traces');
equal(fixedFrameProjection.angleSampleCount, 32, 'fixed-frame projection audit preserves the 32-angle source correspondence');
equal(fixedFrameProjection.preCorrectionMaximumFitResidualMeters, 5.551115123125783e-17, 'fixed-frame source migration retains its independently reproduced fit residual');
check(Number.isFinite(fixedFrameProjection.maximumFitResidualMeters) && fixedFrameProjection.maximumFitResidualMeters <= 2e-7, 'fixed-frame projection stays within the 0.2 micrometer fit gate');
equal(fixedFrameProjection.maximumAdditionalSeparationCorrectionMeters, 0, 'fixed-frame projection applies no geometric separation correction');
equal(fixedFrameProjection.orderingViolationCount, 0, 'fixed-frame projection preserves contour ordering');
equal(fixedFrameProjection.widthContractViolationCount, 0, 'fixed-frame projection preserves the measured width contract');
equal(fixedFrameProjection.adjacentGapViolationCount, 0, 'fixed-frame projection preserves all rigid inter-hinge gaps');
deepEqual(fixedFrameProjection.fixedFrameSeparationAdjustments, [], 'fixed-frame projection has no arbitrary station adjustment');
equal(fixedFrameProjection.traceAudits.length, 90, 'fixed-frame projection reports every contour fit');
equal(fixedFrameProjection.mappingAudits.length, 30, 'fixed-frame projection reports every irregular joint map');
equal(fixedFrameProjection.pivotAudits.length, 30, 'fixed-frame projection reports every authored pivot');
equal(fixedFrameProjection.orderAudits.length, 30, 'fixed-frame projection reports every joint width/order audit');
equal(new Set(fixedFrameProjection.traceAudits.map((item) => `${item.side}/${item.digit}/${item.gasket}/${item.field}`)).size, 90, 'fixed-frame contour-fit records are unique');
deepEqual(
    new Set(fixedFrameProjection.mappingAudits.map((item) => `${item.side}_${item.digit}_${item.gasket}`)),
    EXPECTED_GASKET_NAMES,
    'fixed-frame maps cover exactly the 30 authored joints',
);
deepEqual(fixedFrameProjection.pivotRelocations, fixedFrameSummary.pivotRelocations, 'full fixed-frame audit and compact hinge provenance agree on measured pivot relocation');
deepEqual(fixedFrameProjection.largeG0PivotOffsets, fixedFrameSummary.largeG0PivotOffsets, 'full fixed-frame audit and compact hinge provenance agree on large-G0 evidence');
deepEqual(fixedFrameProjection.validation, fixedFrameSummary, 'topology fixed-frame validation exactly matches canonical hinge provenance');
validateFixedFrameSummary(fixedFrameProjection.validation, hingeSeams, 'topology fixed-frame validation');
equal(fixedFrameProjection.adjacentGapAudits.length, 20, 'fixed-frame projection audits all 20 adjacent joint pairs');
for (const gapAudit of fixedFrameProjection.adjacentGapAudits) {
    equal(gapAudit.correspondence, 'shared legacy/source angle', 'adjacent hinge gap uses common source-angle correspondence');
    equal(gapAudit.evaluationCount, 2048, 'adjacent hinge gap receives dense angular evaluation');
    equal(gapAudit.violationCount, 0, 'adjacent hinge gap has no rigid-interval violation');
    check(Number.isFinite(gapAudit.minimumGapMeters) && gapAudit.minimumGapMeters >= 0.0005 - 1e-10, 'adjacent hinge gap retains at least 0.5 mm');
}
equal(subdividedTopology.cuts.length, 90, 'manifest contains every contour cut record');
const manifestCutNames = new Set();
let manifestInsertedByCuts = 0;
for (const cut of subdividedTopology.cuts) {
    const name = `${cut.side}_${cut.digit}_${cut.gasket}_${cut.field}`;
    check(!manifestCutNames.has(name), `${name} cut is unique`);
    manifestCutNames.add(name);
    check(['left', 'right'].includes(cut.side) && DIGITS.includes(cut.digit), `${name} ownership is valid`);
    check(['G0', 'G1', 'G2'].includes(cut.gasket), `${name} gasket is valid`);
    check(['proximal', 'center', 'distal'].includes(cut.field), `${name} contour field is valid`);
    const fieldIndex = ['proximal', 'center', 'distal'].indexOf(cut.field);
    const expectedRole = ['proximalBoundary', 'center', 'distalBoundary'][fieldIndex];
    const expectedRawBlend = [0, 0.5, 1][fieldIndex];
    const expectedContourIndex = ((cut.side === 'left' ? 0 : 1) * DIGITS.length + DIGITS.indexOf(cut.digit)) * 9
        + Number(cut.gasket.slice(1)) * 3 + fieldIndex;
    equal(cut.method, 'cached-source-vertex-piecewise-affine', `${name} uses the immutable-source P1 field`);
    equal(cut.role, expectedRole, `${name} keeps its authored contour role`);
    equal(cut.rawBlendT, expectedRawBlend, `${name} keeps exact raw boundary blend semantics`);
    equal(cut.contourIndex, expectedContourIndex, `${name} has deterministic persistent edge-tag identity`);
    check(Number.isInteger(cut.consideredSignCrossings) && cut.consideredSignCrossings > 0, `${name} considers real crossings`);
    check(Number.isInteger(cut.insertedVertices) && cut.insertedVertices > 0, `${name} inserts vertices`);
    check(Number.isInteger(cut.contourVertices) && cut.contourVertices >= 3, `${name} has a usable contour`);
    check(Number.isInteger(cut.connectedEdges) && cut.connectedEdges >= 0, `${name} records newly connected edges`);
    const marching = cut.faceLocalMarching;
    const refinement = cut.adaptiveChordRefinement;
    check(marching && typeof marching === 'object', `${name} records face-local contour marching`);
    check(refinement && typeof refinement === 'object', `${name} records adaptive chord refinement`);
    equal(marching.mode, 'cached-source-vertex-piecewise-affine', `${name} marches one cached affine field per immutable source face`);
    deepEqual(refinement, marching.refinement, `${name} refinement summaries agree`);
    equal(refinement.tolerance, 0.00015, `${name} uses the 150 micrometer contour-chord tolerance`);
    equal(refinement.maximumDepth, 0, `${name} needs no nonlinear adaptive refinement`);
    deepEqual(refinement.rounds, [], `${name} remains affine without refinement rounds`);
    equal(refinement.remainingFailingFaceCount, 0, `${name} affine field has no failing face`);
    deepEqual(refinement.remainingReasonCounts, {}, `${name} leaves no unresolved refinement reason`);
    check(Number.isFinite(refinement.remainingMaximumChordResidual) && refinement.remainingMaximumChordResidual <= refinement.tolerance, `${name} unresolved chord residual is bounded`);
    equal(cut.consideredSignCrossings, marching.requestedEdgeRootCount, `${name} reports its exact edge-root requests`);
    equal(cut.contourVertices, marching.contourEdgeCount, `${name} reports its exact face-local contour edges`);
    equal(cut.connectedEdges, marching.splitFaceCount, `${name} reports its exact split-face connections`);
    equal(cut.reusedContourEdges, marching.existingContourEdgeCount, `${name} reports reused on-contour edges`);
    equal(cut.singleRootFaceCount, marching.singleRootFaceCount, `${name} reports shell-terminal single-root faces`);
    equal(cut.maximumSharedEdgeRootDisagreementMeters, marching.maximumSharedEdgeRootDisagreementMeters, `${name} publishes exact shared-child-edge root disagreement`);
    check(Number.isFinite(marching.maximumSharedEdgeRootDisagreementMeters) && marching.maximumSharedEdgeRootDisagreementMeters <= 1e-6, `${name} reconciles shared-edge roots within one micrometer`);
    check(Number.isFinite(marching.maximumPreinsertChordResidual) && marching.maximumPreinsertChordResidual <= refinement.tolerance, `${name} pre-insert chord residual is bounded`);
    check(Number.isFinite(marching.maximumPostinsertChordResidual) && marching.maximumPostinsertChordResidual <= refinement.tolerance, `${name} post-insert chord residual is bounded`);
    equal(cut.maximumScalarResidual, marching.maximumPostinsertChordResidual, `${name} publishes the post-insert chord residual`);
    manifestInsertedByCuts += cut.insertedVertices;
}
equal(manifestCutNames.size, 90, 'manifest cut domain covers 30 joints by three contours');
equal(subdividedTopology.adaptiveOverlapSubdivision.sourceOverlapFaceCount, hingeSeams.crossSeamFaceOverlaps.length, 'manifest refines every overlapping source face');
equal(subdividedTopology.adaptiveOverlapSubdivision.remainingLongOverlapFaceCount, 0, 'no long overlapping source-face child remains');
check(subdividedTopology.adaptiveOverlapSubdivision.maximumChildEdgeLength <= 0.006, 'overlap refinement bounds child edge length');
const manifestAdaptiveInsertions = subdividedTopology.adaptiveOverlapSubdivision.rounds.reduce(
    (sum, round) => sum + round.insertedVertices,
    0,
);
const manifestClosureInsertions = (subdividedTopology.topologyClassification.closureFixedPoint ?? []).reduce(
    (sum, closure) => sum + (closure.virtualInsertions ?? []).reduce(
        (inner, insertion) => inner + (insertion.insertedRootVertexCount ?? 0),
        0,
    ),
    0,
);
equal(manifestInsertedByCuts + manifestAdaptiveInsertions + manifestClosureInsertions, subdividedTopology.insertedRawVertexCount, 'adaptive refinement, contour cuts, and closure insertions sum to the post-cut raw-vertex delta');
const builderContourTopology = subdividedTopology.contourTopologyAudit;
equal(builderContourTopology.schemaVersion, 2, 'builder tagged-contour audit uses schema v2');
equal(builderContourTopology.method, 'persistent contour-bit edge tags; 1-micron position collapse', 'builder audits persistent cut edges rather than rediscovered scalar chords');
equal(builderContourTopology.contourCount, 90, 'builder closure audit covers all contours');
equal(builderContourTopology.closedContourCount, 90, 'builder closure audit accepts all 90 absolute or shell-relative contours');
equal(builderContourTopology.allContoursClosed, true, 'builder closure audit accepts every contour');
equal(builderContourTopology.crossJointContourIntersectionCount, 0, 'effective contours have no cross-joint intersection');
equal(builderContourTopology.contours.length, 90, 'builder closure report contains every contour');
const capSpanningContours = builderContourTopology.contours.filter(
    (contour) => contour.pairedExclusiveAdjacentGasketCapSpanning === true,
);
const capComponentCount = capSpanningContours.reduce((sum, contour) => sum + contour.componentCount, 0);
const capEndpointCount = capSpanningContours.reduce((sum, contour) => sum + contour.boundaryEndpointCount, 0);
equal(capSpanningContours.length, builderContourTopology.pairedExclusiveAdjacentGasketCapContourCount, 'cap-spanning contour aggregate matches contour reports');
equal(capSpanningContours.length, 1, 'exactly one proven paired exclusive adjacent-gasket cap contour');
equal(
    builderContourTopology.componentCount,
    builderContourTopology.absoluteComponentCount
        + builderContourTopology.boundaryRelativeComponentCount
        + capComponentCount,
    'every tagged contour component is an absolute, boundary-relative, or proven cap-spanning chain',
);
equal(
    builderContourTopology.boundaryEndpointCount,
    builderContourTopology.boundaryRelativeComponentCount * 2 + capEndpointCount,
    'every boundary-relative or cap-spanning component contributes exactly two endpoints',
);
equal(
    builderContourTopology.absoluteClosedContourCount,
    builderContourTopology.contours.filter((contour) => contour.absoluteClosed).length,
    'absolute-contour aggregate matches component reports',
);
equal(
    builderContourTopology.boundaryRelativeClosedContourCount,
    builderContourTopology.contours.filter((contour) => contour.boundaryRelativeClosed).length,
    'boundary-relative-contour aggregate matches component reports',
);
for (const contour of builderContourTopology.contours) {
    equal(contour.closed, true, `${contour.id} builder topology is valid`);
    check(Number.isInteger(contour.componentCount) && contour.componentCount >= 1, `${contour.id} has at least one connected component`);
    equal(contour.components.length, contour.componentCount, `${contour.id} reports every connected component`);
    equal(contour.invalidComponentCount, 0, `${contour.id} has no invalid component`);
    const contourCapComponents = contour.components.filter(
        (component) => component.pairedExclusiveAdjacentGasketCap === true,
    ).length;
    equal(
        contour.absoluteComponentCount + contour.boundaryRelativeComponentCount + contourCapComponents,
        contour.componentCount,
        `${contour.id} classifies every component`,
    );
    equal(
        contour.components.reduce((sum, component) => sum + component.collapsedVertexCount, 0),
        contour.collapsedVertexCount,
        `${contour.id} component vertices cover its collapsed graph`,
    );
    equal(
        contour.components.reduce((sum, component) => sum + component.endpointCount, 0),
        contour.boundaryEndpointCount,
        `${contour.id} component endpoints match its contour summary`,
    );
    check(contour.collapsedVertexCount >= 3, `${contour.id} has a usable collapsed contour graph`);
    check(Number.isInteger(contour.rawTaggedEdgeCount) && contour.rawTaggedEdgeCount >= contour.collapsedEdgeCount, `${contour.id} retains real persistent tagged edges`);
    equal(contour.edgesWithoutSourceFieldCount, 0, `${contour.id} tagged edges all retain source-field provenance`);
    check(Number.isFinite(contour.maximumChordResidual) && contour.maximumChordResidual <= 0.00015, `${contour.id} tagged chords stay within 150 micrometers`);
    equal(contour.absoluteClosed, contour.absoluteComponentCount === contour.componentCount, `${contour.id} absolute summary matches its components`);
    equal(contour.boundaryRelativeClosed, contour.boundaryRelativeComponentCount > 0, `${contour.id} relative summary matches its components`);
    equal(contour.degreeHistogram['1'] ?? 0, (contour.boundaryRelativeComponentCount + contourCapComponents) * 2, `${contour.id} has exactly two endpoints per relative or cap component`);
    equal(contour.degreeHistogram['2'] ?? 0, contour.collapsedVertexCount - contour.boundaryEndpointCount, `${contour.id} has only degree-two interior or cycle vertices`);
    deepEqual(
        Object.keys(contour.degreeHistogram).filter((degree) => contour.degreeHistogram[degree]).sort(),
        contour.boundaryEndpointCount ? ['1', '2'] : ['2'],
        `${contour.id} has no branch or web vertex`,
    );
    equal(contour.collapsedEdgeCount, contour.collapsedVertexCount - contour.boundaryRelativeComponentCount - contourCapComponents, `${contour.id} has cycle/relative-chain Euler topology`);
    equal(contour.boundaryEndpointEvidence.length, contour.boundaryEndpointCount, `${contour.id} records every true boundary contact`);
    for (const component of contour.components) {
        equal(component.valid, true, `${contour.id} component ${component.index} is valid`);
        if (component.pairedExclusiveAdjacentGasketCap === true) {
            check(!component.absolute && !component.relative, `${contour.id} component ${component.index} is a pure cap-spanning chain`);
        } else {
            equal(component.absolute, !component.relative, `${contour.id} component ${component.index} has one closure mode`);
        }
        if (component.pairedExclusiveAdjacentGasketCap === true) {
            equal(component.endpointCount, 2, `${contour.id} component ${component.index} has two cap-spanning endpoints`);
            equal(component.boundaryEndpointEvidence.length, 2, `${contour.id} component ${component.index} records both cap boundary contacts`);
            deepEqual(
                component.boundaryEndpointEvidence.map((endpoint) => endpoint.component).sort(),
                [0, 1],
                `${contour.id} component ${component.index} spans both exclusive cap boundaries`,
            );
            for (const endpoint of component.boundaryEndpointEvidence) {
                check(Number.isFinite(endpoint.distanceMeters) && endpoint.distanceMeters <= 1e-7, `${contour.id} component ${component.index} cap endpoint is within 0.1 micrometer of its boundary`);
            }
        } else if (component.relative) {
            equal(component.endpointCount, 2, `${contour.id} component ${component.index} has two relative endpoints`);
            equal(component.boundaryEndpointEvidence.length, 2, `${contour.id} component ${component.index} records both boundary contacts`);
            equal(component.boundaryEndpointEvidence[0].component, component.boundaryEndpointEvidence[1].component, `${contour.id} component ${component.index} endpoints share one boundary component`);
            for (const endpoint of component.boundaryEndpointEvidence) {
                check(Number.isFinite(endpoint.distanceMeters) && endpoint.distanceMeters <= 1e-7, `${contour.id} component ${component.index} endpoint is within 0.1 micrometer of its routed boundary`);
            }
        } else {
            equal(component.endpointCount, 0, `${contour.id} component ${component.index} is an absolute cycle`);
            deepEqual(component.boundaryEndpointEvidence, [], `${contour.id} component ${component.index} borrows no boundary closure`);
        }
    }
}
equal(subdividedTopology.stationSeparation.minimumRigidGap, 0.0005, 'effective adjacent hinges retain a 0.5 mm rigid interval');
check(Array.isArray(subdividedTopology.stationSeparation.adjustments), 'manifest records deterministic trace-separation adjustments');
deepEqual(subdividedTopology.stationSeparation.adjustments, fixedFrameProjection.sourceTraceSeparationAdjustments, 'topology station separation exactly matches the independently generated source-trace adjustments');
deepEqual(
    fixedFrameProjection.sourceTraceSeparationAdjustments.map((item) => `${item.side}/${item.digit}/${item.proximalJoint}/${item.distalJoint}`).sort(),
    ['left/thumb/G0/G1', 'right/thumb/G0/G1'],
    'only the two measured thumb G0/G1 source traces require rigid-gap separation',
);
for (const adjustment of subdividedTopology.stationSeparation.adjustments) {
    check(['left', 'right'].includes(adjustment.side) && DIGITS.includes(adjustment.digit), 'trace adjustment ownership is valid');
    check(['G0', 'G1'].includes(adjustment.proximalJoint) && ['G1', 'G2'].includes(adjustment.distalJoint), 'trace adjustment joint pair is adjacent');
    check(Array.isArray(adjustment.adjustedSamples) && adjustment.adjustedSamples.every((sample) => Number.isInteger(sample) && sample >= 0 && sample < 32), 'trace adjustment samples are valid');
    check(Number.isFinite(adjustment.maximumOneSidedShift) && adjustment.maximumOneSidedShift > 0, 'trace adjustment shift is finite and positive');
}
const topologyClassification = subdividedTopology.topologyClassification;
check(topologyClassification && typeof topologyClassification === 'object', 'manifest records topology-only hand classification');
equal(topologyClassification.schemaVersion, 1, 'topology classification uses schema v1');
equal(topologyClassification.coordinateEligibilityCount, 0, 'no hand coordinate is eligible to choose a digit or mechanical state');
equal(topologyClassification.contourIndexCount, 90, 'topology classification indexes all 90 persistent contour identities');
equal(topologyClassification.eligibleHandFaceCount, topologyClassification.floodedHandFaceCount, 'topology flood covers every eligible hand face');
equal(topologyClassification.recordCount, topologyClassification.postcutHandKeyCount, 'topology records cover every exact post-cut hand key');
equal(topologyClassification.postcutHandKeyMismatchCount, 0, 'topology and exported post-cut hand keys agree exactly');
equal(topologyClassification.insertedUniqueHandPositionCount, subdividedTopology.insertedUniqueHandPositionCount, 'topology classification reports every inserted hand position');
deepEqual(topologyClassification.zoneCounts, subdividedTopology.zoneCounts, 'topology classification owns the manifest zone inventory');
for (const field of [
    'markerMaskCopyConflictCount',
    'multiContourGeometricEdgeCount',
    'traversableStateConflictCount',
    'virtualNonAdjacentStateCount',
    'recordConflictCount',
    'activeOneSidedVirtualEdgeCount',
    'inactiveVirtualConnectivityViolationCount',
    'inactiveVirtualExactInterfaceLeakCount',
    'inactiveUnprovenStateCount',
    'inactiveProtectedAnchorCrossingCount',
    'inactiveExactInterfaceLeakCount',
    'rigidBlendViolationCount',
    'missingOrderedStateCount',
]) equal(topologyClassification[field], 0, `topology classification clears ${field}`);
for (const field of [
    'inactiveVirtualTangentEdgeCount',
    'inactiveVirtualTangentPositionCount',
    'inactiveVirtualAttachmentPositionCount',
    'inactiveVirtualTangentComponentCount',
]) check(Number.isInteger(topologyClassification[field]) && topologyClassification[field] >= 0, `topology classification publishes nonnegative ${field}`);
const inactiveVirtualCounts = [
    topologyClassification.inactiveVirtualTangentPositionCount,
    topologyClassification.inactiveVirtualAttachmentPositionCount,
    topologyClassification.inactiveVirtualTangentComponentCount,
];
if (topologyClassification.inactiveVirtualTangentEdgeCount === 0) {
    check(inactiveVirtualCounts.every((value) => value === 0), 'zero inactive virtual edges have zero positions, attachments, and components');
} else {
    check(inactiveVirtualCounts.every((value) => value > 0), 'real inactive virtual edges retain positive positions, attachments, and components');
}
check(Array.isArray(topologyClassification.closureFixedPoint), 'topology classification publishes closure fixed-point passes');
equal(topologyClassification.closureFixedPoint.length, topologyClassification.closureFixedPointPassCount, 'closure fixed-point publishes every pass');
let prunedVirtualTangentEdges = 0;
let prunedVirtualTangentComponents = 0;
let recordedRootEndpointReuseInsertions = 0;
let recordedRootEndpointReuseCount = 0;
let maximumRecordedRootEndpointReuseDisplacementMeters = 0;
let centralConstraintSearchCount = 0;
let centralConstraintRawEdgeCount = 0;
let centralConstraintOptimalActiveEdgeCount = 0;
let centralConstraintVisitedNodeCount = 0;
let centralConstraintPeakRollbackLogSize = 0;
for (const [passIndex, closurePass] of topologyClassification.closureFixedPoint.entries()) {
    equal(closurePass.pass, passIndex, `closure pass ${passIndex} is ordered`);
    const prunedEdges = closurePass.prunedVirtualTangentEdgeCount ?? 0;
    const components = closurePass.prunedVirtualTangentComponents ?? [];
    check(Number.isInteger(prunedEdges) && prunedEdges >= 0, `closure pass ${passIndex} has a valid pruned tangent edge count`);
    check(Array.isArray(components), `closure pass ${passIndex} has tangent component evidence`);
    equal(components.reduce((sum, component) => sum + component.edgeCount, 0), prunedEdges, `closure pass ${passIndex} accounts for every pruned tangent edge`);
    if (prunedEdges) {
        equal(closurePass.mixedComponentCount, 0, `tangent-only closure pass ${passIndex} has no mixed component action`);
        equal(closurePass.qualifiedComponentCount, 0, `tangent-only closure pass ${passIndex} has no qualified insertion action`);
        deepEqual(closurePass.virtualInsertions, [], `tangent-only closure pass ${passIndex} inserts no interface`);
        equal(closurePass.newInactiveEdgeCount, 0, `tangent-only closure pass ${passIndex} demotes no physical contour`);
    }
    for (const component of components) {
        check(Array.isArray(component.owner) && ['left', 'right'].includes(component.owner[0]) && DIGITS.includes(component.owner[1]), 'pruned tangent has one immutable owner');
        check([2, 3].includes(component.rank), 'pruned tangent is one of the topology-proven central continuation ranks');
        check(Number.isInteger(component.edgeCount) && component.edgeCount > 0, 'pruned tangent contains real edges');
        equal(component.nodeCount, component.edgeCount + 1, 'pruned tangent is an unbranched path');
        check(Array.isArray(component.attachment) && component.attachment.length === 3 && component.attachment.every(Number.isInteger), 'pruned tangent has one exact attachment key');
        check(Number.isInteger(component.keptComponentNodeCount) && component.keptComponentNodeCount >= 3, 'pruned tangent leaves a real closed kept interface');
        check(['terminalTangentTail', 'redundantTangentChord'].includes(component.class), 'pruned tangent declares its proven topology class');
        check([component.rank, component.rank + 1].includes(component.semanticState), 'pruned tangent retains one adjacent semantic state');
        check([0, 2].includes(component.keptEndpointCount), 'pruned tangent reports valid kept-interface endpoint cardinality');
        check(Array.isArray(component.keptBoundaryEvidence), 'pruned tangent publishes kept-boundary evidence');
        if (component.class === 'terminalTangentTail') {
            equal(component.keptEndpointCount, 0, 'terminal tangent leaves a closed kept interface');
            deepEqual(component.keptBoundaryEvidence, [], 'terminal tangent needs no relative-boundary endpoint proof');
        } else {
            equal(component.keptBoundaryEvidence.length, component.keptEndpointCount, 'redundant chord accounts for every kept endpoint');
            if (component.keptBoundaryEvidence.length) {
                equal(component.keptBoundaryEvidence.length, 2, 'open redundant-chord path has two kept endpoints');
                check(component.keptBoundaryEvidence.every((item) => (
                    item && Number.isInteger(item.component)
                    && Number.isFinite(item.distanceMeters)
                    && item.distanceMeters >= 0
                    && item.distanceMeters <= 1e-7
                )), 'redundant-chord endpoints lie on measured source boundaries');
                equal(component.keptBoundaryEvidence[0].component, component.keptBoundaryEvidence[1].component, 'redundant-chord endpoints lie on one source boundary component');
            }
        }
    }
    check(Array.isArray(closurePass.virtualInsertions), `closure pass ${passIndex} publishes virtual insertion evidence`);
    for (const insertion of closurePass.virtualInsertions) {
        recordedRootEndpointReuseInsertions++;
        check(Array.isArray(insertion.owner) && ['left', 'right'].includes(insertion.owner[0]) && DIGITS.includes(insertion.owner[1]), 'virtual insertion has one immutable owner');
        check([2, 3].includes(insertion.rank), 'virtual insertion is a central continuation rank');
        check(Number.isInteger(insertion.recordedRootEndpointReuseCount) && insertion.recordedRootEndpointReuseCount >= 0, 'virtual insertion reports recorded-root endpoint reuse count');
        check(Number.isFinite(insertion.maximumRecordedRootEndpointReuseDisplacementMeters) && insertion.maximumRecordedRootEndpointReuseDisplacementMeters >= 0 && insertion.maximumRecordedRootEndpointReuseDisplacementMeters <= 1e-6, 'recorded-root endpoint reuse remains within one micron');
        equal(insertion.ambiguousRecordedRootEndpointReuseCount, 0, 'recorded-root endpoint reuse is unambiguous');
        equal(insertion.crossOwnerRankEndpointReuseCount, 0, 'recorded-root endpoint reuse never crosses joint ownership/rank');
        check(Array.isArray(insertion.recordedRootEndpointReuseEvidence), 'virtual insertion publishes exact endpoint reuse evidence');
        equal(insertion.recordedRootEndpointReuseEvidence.length, insertion.recordedRootEndpointReuseCount, 'virtual insertion accounts for every recorded-root endpoint reuse');
        const expectedContourIndex = (insertion.owner[0] === 'left' ? 0 : 45) + DIGITS.indexOf(insertion.owner[1]) * 9 + insertion.rank;
        const reuseIdentities = new Set();
        let measuredMaximum = 0;
        for (const evidence of insertion.recordedRootEndpointReuseEvidence) {
            for (const field of ['sourceFaceIndex', 'descendantFaceIndex', 'requestedEdgeIndex', 'endpointVertexIndex']) {
                check(Number.isInteger(evidence[field]) && evidence[field] >= 0, `recorded-root endpoint evidence has valid ${field}`);
            }
            const identity = [evidence.sourceFaceIndex, evidence.descendantFaceIndex, evidence.requestedEdgeIndex, evidence.endpointVertexIndex].join('/');
            check(!reuseIdentities.has(identity), 'recorded-root endpoint reuse evidence is unique');
            reuseIdentities.add(identity);
            check(Number.isFinite(evidence.displacementMeters) && evidence.displacementMeters >= 0 && evidence.displacementMeters <= 1e-6, 'recorded-root endpoint evidence remains within one micron');
            check(Array.isArray(evidence.physicalContourIndices) && evidence.physicalContourIndices.length > 0 && evidence.physicalContourIndices.every((value) => value === expectedContourIndex), 'recorded-root endpoint evidence matches the physical contour owner/rank');
            measuredMaximum = Math.max(measuredMaximum, evidence.displacementMeters);
        }
        check(Math.abs(measuredMaximum - insertion.maximumRecordedRootEndpointReuseDisplacementMeters) <= 1e-12, 'recorded-root endpoint reuse maximum matches its evidence');
        recordedRootEndpointReuseCount += insertion.recordedRootEndpointReuseCount;
        maximumRecordedRootEndpointReuseDisplacementMeters = Math.max(maximumRecordedRootEndpointReuseDisplacementMeters, measuredMaximum);
    }
    const constraint = closurePass.centralConstraint;
    if (constraint !== undefined && constraint !== null) {
        check(constraint && typeof constraint === 'object' && !Array.isArray(constraint), `closure pass ${passIndex} has central-constraint provenance`);
        const search = constraint.globalConstraintSearch;
        if (search === undefined || search === null) {
            equal(constraint.relevantComponentCount, 0, `closure pass ${passIndex} needs no central search when it has no relevant components`);
        } else {
            check(search && typeof search === 'object' && !Array.isArray(search), `closure pass ${passIndex} publishes a central bounded-search proof`);
            centralConstraintSearchCount++;
            equal(search.solver, 'weighted-rollback-dsu-branch-and-bound', `closure pass ${passIndex} uses the memory-bounded exact solver`);
            equal(search.objective, 'maximum total active physical edge count; ties use rank priority 1,4,2,3 then geometric edge key', `closure pass ${passIndex} locks the weighted raw-edge objective`);
            check(typeof search.boundProof === 'string' && search.boundProof.includes('future assignments and unions only remove support'), `closure pass ${passIndex} publishes the monotone upper-bound proof`);
            equal(search.tieCountEnumerated, false, `closure pass ${passIndex} does not enumerate tied optima`);
            equal(search.optimalityProven, true, `closure pass ${passIndex} proves optimality`);
            const searchIntegerFields = [
                'clusterCount',
                'rawEdgeCount',
                'relationGroupCount',
                'visitedNodeCount',
                'upperBoundPruneCount',
                'infeasibleBranchCount',
                'feasibleLeafCount',
                'infeasibleLeafCount',
                'rejectedFallbackLeafCount',
                'maximumDepth',
                'peakRollbackLogSize',
                'optimalActiveEdgeCount',
                'optimalInactiveEdgeCount',
                'completeLeafCount',
            ];
            check(searchIntegerFields.every((field) => Number.isInteger(search[field]) && search[field] >= 0), `closure pass ${passIndex} has nonnegative bounded-search counters`);
            check(Array.isArray(search.clusters), `closure pass ${passIndex} publishes every bounded-search cluster`);
            equal(search.clusters.length, search.clusterCount, `closure pass ${passIndex} accounts for every bounded-search cluster`);
            check(Array.isArray(search.selectedSignature), `closure pass ${passIndex} publishes a raw-edge decision signature`);
            equal(search.selectedSignature.length, search.rawEdgeCount, `closure pass ${passIndex} decides every raw central edge`);
            check(search.selectedSignature.every((value) => value === 0 || value === 1), `closure pass ${passIndex} raw-edge signature is binary`);
            equal(search.selectedSignature.reduce((sum, value) => sum + value, 0), search.optimalActiveEdgeCount, `closure pass ${passIndex} raw-edge signature reproduces the optimum`);
            equal(search.optimalActiveEdgeCount + search.optimalInactiveEdgeCount, search.rawEdgeCount, `closure pass ${passIndex} partitions every raw edge into active/inactive decisions`);
            equal(search.completeLeafCount, search.feasibleLeafCount + search.infeasibleLeafCount, `closure pass ${passIndex} accounts for every complete search leaf`);
            check(search.feasibleLeafCount > 0, `closure pass ${passIndex} contains a feasible bounded-search leaf`);
            const clusterIntegerFields = [
                'clusterIndex',
                'quotientNodeCount',
                'rawEdgeCount',
                'initialRelationGroupCount',
                'postForcedRelationGroupCount',
                'postForcedOptionalRawEdgeCount',
                'fixedPointForcedInactiveRawEdgeCount',
                'visitedNodeCount',
                'upperBoundPruneCount',
                'infeasibleBranchCount',
                'feasibleLeafCount',
                'infeasibleLeafCount',
                'rejectedFallbackLeafCount',
                'maximumDepth',
                'peakRollbackLogSize',
                'greedyVisitedNodeCount',
                'greedyIncumbentActiveEdgeCount',
                'optimalActiveEdgeCount',
            ];
            for (const [clusterIndex, cluster] of search.clusters.entries()) {
                check(cluster && typeof cluster === 'object' && !Array.isArray(cluster), `closure pass ${passIndex} cluster ${clusterIndex} is an object`);
                check(clusterIntegerFields.every((field) => Number.isInteger(cluster[field]) && cluster[field] >= 0), `closure pass ${passIndex} cluster ${clusterIndex} has nonnegative audit counters`);
                equal(cluster.clusterIndex, clusterIndex, `closure pass ${passIndex} cluster ${clusterIndex} is ordered`);
                check(cluster.quotientNodeCount > 0, `closure pass ${passIndex} cluster ${clusterIndex} contains quotient nodes`);
                check(cluster.postForcedRelationGroupCount <= cluster.initialRelationGroupCount, `closure pass ${passIndex} cluster ${clusterIndex} only removes relation groups at the forced fixed point`);
                check(cluster.greedyIncumbentActiveEdgeCount <= cluster.optimalActiveEdgeCount, `closure pass ${passIndex} cluster ${clusterIndex} exact optimum dominates its greedy incumbent`);
                check(Array.isArray(cluster.selectedSignature), `closure pass ${passIndex} cluster ${clusterIndex} publishes an optional raw-edge signature`);
                equal(cluster.selectedSignature.length, cluster.postForcedOptionalRawEdgeCount, `closure pass ${passIndex} cluster ${clusterIndex} expands decisions to every optional raw edge`);
                check(cluster.selectedSignature.every((value) => value === 0 || value === 1), `closure pass ${passIndex} cluster ${clusterIndex} signature is binary`);
                equal(cluster.selectedSignature.reduce((sum, value) => sum + value, 0), cluster.optimalActiveEdgeCount, `closure pass ${passIndex} cluster ${clusterIndex} signature reproduces its optimum`);
            }
            equal(search.clusters.reduce((sum, cluster) => sum + cluster.rawEdgeCount, 0), search.rawEdgeCount, `closure pass ${passIndex} cluster raw edges reproduce the global count`);
            equal(search.clusters.reduce((sum, cluster) => sum + cluster.initialRelationGroupCount, 0), search.relationGroupCount, `closure pass ${passIndex} clusters reproduce every initial relation group`);
            equal(search.clusters.reduce((sum, cluster) => sum + cluster.optimalActiveEdgeCount, 0), search.optimalActiveEdgeCount, `closure pass ${passIndex} cluster optima reproduce the global optimum`);
            equal(search.clusters.reduce((sum, cluster) => sum + cluster.visitedNodeCount, 0), search.visitedNodeCount, `closure pass ${passIndex} clusters reproduce the visited-node count`);
            equal(Math.max(0, ...search.clusters.map((cluster) => cluster.maximumDepth)), search.maximumDepth, `closure pass ${passIndex} clusters reproduce the maximum search depth`);
            equal(Math.max(0, ...search.clusters.map((cluster) => cluster.peakRollbackLogSize)), search.peakRollbackLogSize, `closure pass ${passIndex} clusters reproduce peak rollback storage`);
            equal(constraint.rawCentralConstraintEdgeCount, search.rawEdgeCount, `closure pass ${passIndex} constraint inventory matches bounded-search raw edges`);
            equal(constraint.rawRelationValidationEdgeCount, search.rawEdgeCount, `closure pass ${passIndex} relation validation covers every raw edge`);
            equal(constraint.centralRelationGroupCount, search.relationGroupCount, `closure pass ${passIndex} relation grouping matches bounded-search provenance`);
            equal(constraint.activeCentralEdgeCount, search.optimalActiveEdgeCount, `closure pass ${passIndex} active constraint edges match the exact optimum`);
            equal(constraint.inactiveCentralEdgeCount, search.optimalInactiveEdgeCount, `closure pass ${passIndex} inactive constraint edges complete the exact decision set`);
            centralConstraintRawEdgeCount += search.rawEdgeCount;
            centralConstraintOptimalActiveEdgeCount += search.optimalActiveEdgeCount;
            centralConstraintVisitedNodeCount += search.visitedNodeCount;
            centralConstraintPeakRollbackLogSize = Math.max(centralConstraintPeakRollbackLogSize, search.peakRollbackLogSize);
        }
    }
    prunedVirtualTangentEdges += prunedEdges;
    prunedVirtualTangentComponents += components.length;
}
equal(prunedVirtualTangentEdges, topologyClassification.inactiveVirtualTangentEdgeCount, 'closure proof accounts for all inactive virtual tangent edges');
equal(prunedVirtualTangentComponents, topologyClassification.inactiveVirtualTangentComponentCount, 'closure proof accounts for all inactive virtual tangent components');
check(recordedRootEndpointReuseInsertions > 0, 'closure proof contains central virtual insertion records');
check(recordedRootEndpointReuseCount > 0, 'closure proof reuses the authored physical root endpoint');
check(centralConstraintSearchCount > 0, 'closure proof contains bounded central-constraint search provenance');
const expectedTopologyStateKeys = ['left', 'right'].flatMap((side) => (
    DIGITS.flatMap((digit) => Array.from({ length: 10 }, (_, state) => `${side}/${digit}/${state}`))
)).sort();
deepEqual(Object.keys(topologyClassification.stateFaceCounts).sort(), expectedTopologyStateKeys, 'topology flood contains every ordered state for every digit');
deepEqual(Object.keys(topologyClassification.stateComponentCounts).sort(), expectedTopologyStateKeys, 'topology component map contains every ordered state for every digit');
for (const [state, count] of Object.entries(topologyClassification.stateFaceCounts)) {
    check(Number.isInteger(count) && count > 0, `${state} contains real flooded faces`);
}
for (const [state, count] of Object.entries(topologyClassification.stateComponentCounts)) {
    check(Number.isInteger(count) && count > 0, `${state} contains real flooded components`);
}
equal(Object.values(topologyClassification.stateFaceCounts).reduce((sum, count) => sum + count, 0), topologyClassification.eligibleHandFaceCount, 'ordered state faces partition the complete eligible hand');
equal(Object.values(topologyClassification.stateComponentCounts).reduce((sum, count) => sum + count, 0), topologyClassification.componentCount, 'ordered state components partition the complete flood');
check(Array.isArray(topologyRecords.records), 'topology sidecar records are a list');
equal(topologyRecords.records.length, topologyClassification.recordCount, 'topology sidecar covers every classified hand key');
equal(topologyRecordMetadata.recordCount, topologyRecords.records.length, 'manifest topology-record count matches the sidecar');
equal(topologyRecords.classification.schemaVersion, topologyClassification.schemaVersion, 'sidecar and manifest use one topology-classification schema');
equal(topologyRecords.classification.method, topologyClassification.method, 'sidecar and manifest use one topology-classification method');
equal(topologyRecords.classification.coordinateEligibilityCount, 0, 'sidecar classification never authorizes coordinate eligibility');
equal(topologyRecords.classification.recordCount, topologyRecords.records.length, 'sidecar classification count covers all records');
const topologyRecordKeys = [];
const topologyRecordKeyStrings = new Set();
const topologyRecordZoneCounts = {};
const topologyDispositionCounts = {};
const topologyInterfaceRankCounts = {};
for (const [index, record] of topologyRecords.records.entries()) {
    check(record && typeof record === 'object' && !Array.isArray(record), `topology record ${index} is an object`);
    check(Array.isArray(record.key) && record.key.length === 3 && record.key.every(Number.isInteger), `topology record ${index} has an integer vec3 key`);
    const keyString = record.key.join(',');
    check(!topologyRecordKeyStrings.has(keyString), `topology key ${keyString} is unique`);
    topologyRecordKeyStrings.add(keyString);
    topologyRecordKeys.push(record.key);
    check(['left', 'right'].includes(record.side), `topology key ${keyString} has a valid side owner`);
    check(['source', 'inserted'].includes(record.origin), `topology key ${keyString} has a valid origin`);
    check(SKIN_ZONE_NAMES.has(record.zone), `topology key ${keyString} has a known mechanical zone`);
    check(
        ['none', 'activeInterface', 'virtualContinuation', 'inactiveIncompleteTripletCap', 'inactiveVirtualTangent'].includes(record.interfaceDisposition),
        `topology key ${keyString} has canonical explicit interface disposition`,
    );
    if (record.zone === 'H') {
        equal(record.digit, null, `topology hand key ${keyString} has no digit`);
        equal(record.blend, null, `topology hand key ${keyString} has no blend`);
    } else {
        check(DIGITS.includes(record.digit), `topology key ${keyString} has a valid digit owner`);
        if (record.zone.startsWith('S')) {
            equal(record.blend, null, `topology rigid key ${keyString} has no blend`);
        } else {
            check(Number.isFinite(record.blend) && record.blend >= 0 && record.blend <= 1, `topology gasket key ${keyString} has normalized blend`);
        }
    }
    if (record.topologyInterfaceRank !== undefined) {
        check(Number.isInteger(record.topologyInterfaceRank) && record.topologyInterfaceRank >= 0 && record.topologyInterfaceRank < 9, `topology key ${keyString} has a valid interface rank`);
        const expectedZone = `G${Math.floor(record.topologyInterfaceRank / 3)}`;
        const expectedBlend = [0, 0.5, 1][record.topologyInterfaceRank % 3];
        equal(record.zone, expectedZone, `topology key ${keyString} interface rank selects its gasket`);
        equal(record.blend, expectedBlend, `topology key ${keyString} interface rank retains exact t=0/0.5/1`);
        check(
            ['activeInterface', 'virtualContinuation'].includes(record.interfaceDisposition),
            `ranked topology key ${keyString} is physical or a virtual continuation`,
        );
        topologyInterfaceRankCounts[record.topologyInterfaceRank] = (topologyInterfaceRankCounts[record.topologyInterfaceRank] ?? 0) + 1;
    } else {
        check(
            ['none', 'inactiveIncompleteTripletCap', 'inactiveVirtualTangent'].includes(record.interfaceDisposition),
            `unranked topology key ${keyString} is ordinary or a proven inactive branch`,
        );
        check(Number.isInteger(record.topologyState) && record.topologyState >= 0 && record.topologyState <= 9, `unranked topology key ${keyString} has a proven topology state`);
        const rigidStateZones = new Map([[0, 'H'], [3, 'S0'], [6, 'S1'], [9, 'S2']]);
        if (rigidStateZones.has(record.topologyState)) {
            equal(record.zone, rigidStateZones.get(record.topologyState), `unranked topology key ${keyString} retains its proven rigid state`);
            equal(record.blend, null, `unranked rigid key ${keyString} has no blend`);
        } else {
            const gasketIndex = Math.floor((record.topologyState - 1) / 3);
            const lowerHalf = record.topologyState === 3 * gasketIndex + 1;
            equal(record.zone, `G${gasketIndex}`, `unranked topology key ${keyString} retains its proven gasket state`);
            check(
                Number.isFinite(record.blend)
                && (lowerHalf ? record.blend >= 0 && record.blend <= 0.5 : record.blend >= 0.5 && record.blend <= 1),
                `unranked topology key ${keyString} remains inside its proven gasket half`,
            );
        }
    }
    if (record.interfaceDisposition === 'inactiveIncompleteTripletCap') {
        equal(record.topologyInterfaceRank, undefined, `inactive cap key ${keyString} has no active contour rank`);
    }
    const zoneKey = `${record.side}/${record.digit ?? 'hand'}/${record.zone}`;
    topologyRecordZoneCounts[zoneKey] = (topologyRecordZoneCounts[zoneKey] ?? 0) + 1;
    topologyDispositionCounts[record.interfaceDisposition] = (topologyDispositionCounts[record.interfaceDisposition] ?? 0) + 1;
}
const compareTopologyKeys = (first, second) => (
    first[0] - second[0] || first[1] - second[1] || first[2] - second[2]
);
deepEqual(topologyRecordKeys, [...topologyRecordKeys].sort(compareTopologyKeys), 'topology records are deterministically key-sorted');
deepEqual(Object.keys(topologyInterfaceRankCounts).sort(), Array.from({ length: 9 }, (_, rank) => String(rank)), 'topology sidecar contains every ordered interface rank');
check(Object.values(topologyInterfaceRankCounts).every((count) => Number.isInteger(count) && count > 0), 'every ordered topology interface rank contains real positions');
deepEqual(topologyRecordZoneCounts, topologyClassification.zoneCounts, 'topology sidecar reproduces every classified zone count');
deepEqual(topologyRecords.classification.zoneCounts, topologyRecordZoneCounts, 'sidecar classification publishes exact zone counts');
deepEqual(topologyRecordMetadata.zoneCounts, topologyRecordZoneCounts, 'manifest topology metadata publishes exact zone counts');
deepEqual(topologyRecords.classification.interfaceDispositionCounts, topologyDispositionCounts, 'sidecar classification publishes exact interface dispositions');
deepEqual(topologyRecordMetadata.interfaceDispositionCounts, topologyDispositionCounts, 'manifest topology metadata publishes exact interface dispositions');
deepEqual(topologyClassification.interfaceDispositionCounts, topologyDispositionCounts, 'topology flood publishes exact interface dispositions');
deepEqual(topologyRecords.classification.interfaceRankPositionCounts, topologyInterfaceRankCounts, 'sidecar classification publishes exact interface-rank counts');
deepEqual(topologyRecordMetadata.interfaceRankPositionCounts, topologyInterfaceRankCounts, 'manifest topology metadata publishes exact interface-rank counts');
deepEqual(topologyClassification.interfaceRankPositionCounts, topologyInterfaceRankCounts, 'topology flood publishes exact interface-rank counts');
equal(Object.values(topologyInterfaceRankCounts).reduce((sum, count) => sum + count, 0), topologyClassification.exactContourBlendPositionCount, 'sidecar active interfaces match the topology exact-blend count');
equal(topologyDispositionCounts.activeInterface ?? 0, topologyClassification.exactRecordedContourBlendPositionCount, 'physical interface positions match the exact recorded-contour count');
equal(topologyDispositionCounts.virtualContinuation ?? 0, topologyClassification.exactVirtualContinuationBlendPositionCount, 'virtual interface positions match the exact continuation count');
equal(topologyDispositionCounts.inactiveIncompleteTripletCap ?? 0, topologyClassification.inactiveOnlyPositionCount, 'inactive cap positions match the topology flood');
equal(topologyDispositionCounts.inactiveVirtualTangent ?? 0, topologyClassification.inactiveVirtualTangentPositionCount, 'inactive virtual tangent positions match the topology flood');
const coveredWeight = Object.values(manifest.rig.weightCoverage).reduce((sum, record) => sum + record.totalWeight, 0);
check(Math.abs(coveredWeight - subdividedTopology.subdividedRawVertexCount) <= 0.01, 'manifest normalized weight coverage spans every post-cut raw vertex');
check(manifest.rig.pivotPlacement.source.includes('32-sample cyclic'), 'manifest records measured cyclic pivot and contour evidence');
deepEqual(manifest.rig.pivotPlacement.sourceChainPoints, hingeSeams.jointPoints, 'manifest keeps the immutable four-point trace frames separate from bone pivots');
const measuredJointCenters = manifest.rig.pivotPlacement.measuredJointCenters;
const pivotEvidencePolicy = manifest.rig.pivotPlacement.evidencePolicy;
check(typeof pivotEvidencePolicy.derivation === 'string' && pivotEvidencePolicy.derivation.includes('derive_measured_digit_pivots'), 'manifest names the measured-pivot derivation');
deepEqual(pivotEvidencePolicy.radialAcceptance, {
    maximumFitRmsMeters: 0.0016,
    maximumAngularGapRadians: Math.PI / 4,
    maximumCorrectionMeters: 0.008,
}, 'manifest records the measured-pivot radial acceptance gates');
equal(pivotEvidencePolicy.axialSanityCapMeters, 0.04, 'manifest records the measured-pivot axial sanity cap');
const pivotJointCorrections = pivotEvidencePolicy.jointCorrections;
equal(pivotJointCorrections.length, 30, 'manifest records one measured correction per digit joint');
const pivotCorrectionByKey = new Map();
for (const correction of pivotJointCorrections) {
    const key = `${correction.side}/${correction.digit}/${correction.gasket}`;
    pivotCorrectionByKey.set(key, correction);
    check(['axial-only', 'axial+radial'].includes(correction.method), `${key} uses a declared measured-pivot method`);
    equal(correction.method === 'axial+radial', correction.radialAccepted === true, `${key} method matches its radial acceptance`);
    check(Math.abs(correction.axialOffsetMeters) <= 0.04, `${key} axial correction stays within the sanity cap`);
    const appliedRadial = correction.radialAccepted ? correction.radialOffsetMeters : 0;
    const expectedDistance = Math.hypot(correction.axialOffsetMeters, appliedRadial);
    const actualDistance = Math.hypot(...correction.pivot.map((value, index) => value - correction.anchorPoint[index]));
    check(Math.abs(actualDistance - expectedDistance) <= 1e-9, `${key} pivot matches its recorded axial/radial decomposition`);
    if (correction.radialAccepted) {
        check(
            correction.ringFitRmsMeters <= 0.0016
            && correction.ringMaximumAngularGapRadians <= Math.PI / 4 + 1e-12
            && correction.radialOffsetMeters <= 0.008,
            `${key} accepted radial correction satisfies every gate`,
        );
    }
}
for (const side of ['left', 'right']) {
    for (const digit of ['thumb', 'index', 'middle', 'ring', 'pinky']) {
        const points = measuredJointCenters[side][digit];
        equal(points.length, 4, `${side}/${digit} measured joint centers keep four chain points`);
        deepEqual(points[3], hingeSeams.jointPoints[side][digit][3], `${side}/${digit} fingertip stays the authored chain tip`);
        ['G0', 'G1', 'G2'].forEach((gasket, index) => {
            const correction = pivotCorrectionByKey.get(`${side}/${digit}/${gasket}`);
            check(correction !== undefined, `${side}/${digit}/${gasket} has a measured correction record`);
            deepEqual(points[index], correction.pivot, `${side}/${digit}/${gasket} bone center equals its derived measured pivot`);
        });
    }
}
check(
    pivotCorrectionByKey.get('left/thumb/G0').axialOffsetMeters > 0.025
    && pivotCorrectionByKey.get('right/thumb/G0').axialOffsetMeters > 0.025,
    'both displaced thumb G0 heads keep their large measured axial corrections',
);
equal(manifest.integration.worldCollision, false, 'manifest excludes world collision');
equal(manifest.integration.worldSceneAttachment, true, 'manifest uses camera-child world submission');
deepEqual(manifest.integration.modelRotation, [0, 0, 0], 'identity model orientation');
equal(manifest.integration.recommendedScale, 0.275, 'bounded viewmodel scale');
deepEqual(manifest.integration.recommendedCameraLocalOffset, [0, -0.19, -0.385], 'bounded camera-local placement');
deepEqual(manifest.integration.contact.clips, ['PushLeft', 'PushRight', 'ContactRecoil'], 'contact clips declared');

equal(rigAudit.pass, true, 'background Blender deformation audit passes');
deepEqual([...rigAudit.bones].sort(), REQUIRED_BONES, 'Blender re-import sees the exact 37-bone rig');
equal(rigAudit.bones.length, 37, 'Blender re-import sees 37 bones');
equal(rigAudit.clips.length, 9, 'Blender re-import evaluates nine clips');
equal(rigAudit.cameraSpace.camera.fovDegrees, 52, 'Blender audit uses live 52-degree camera');
deepEqual(rigAudit.cameraSpace.model.rotation, [0, 0, 0], 'Blender audit uses identity model rotation');
equal(rigAudit.cameraSpace.model.scale, 0.275, 'Blender audit uses bounded scale');
deepEqual(rigAudit.cameraSpace.model.translation, [0, -0.19, -0.385], 'Blender audit uses bounded placement');
check(rigAudit.mesh.maximumInfluences <= 2, 'runtime mechanical skin uses at most two influences');
equal(Object.keys(rigAudit.mesh.digitBoneSupport).length, 30, 'audit records anatomical support for all digit bones');
const sourceOwnershipBaseline = rigAudit.mesh.sourceOwnershipBaseline;
check(sourceOwnershipBaseline && typeof sourceOwnershipBaseline === 'object', 'Blender audit reports the source ownership baseline');
equal(sourceOwnershipBaseline.schemaVersion, 1, 'Blender audit uses source ownership schema v1');
equal(sourceOwnershipBaseline.sourceFile, skinZones.source.file, 'Blender audit reports the source-locked GLB path');
equal(sourceOwnershipBaseline.sourceSha256, EXPECTED_SOURCE_SHA256, 'Blender audit reports the fixed source hash');
equal(sourceOwnershipBaseline.quantization, POSITION_QUANTIZATION, 'Blender audit reports exact coordinate quantization');
equal(sourceOwnershipBaseline.sourceRawVertices, SOURCE_RAW_VERTICES, 'Blender audit verifies source raw vertices');
equal(sourceOwnershipBaseline.sourceUniquePositions, SOURCE_UNIQUE_POSITIONS, 'Blender audit verifies source unique positions');
equal(sourceOwnershipBaseline.handMinimumY, HAND_MINIMUM_Y, 'Blender audit verifies hand-region cutoff');
equal(sourceOwnershipBaseline.handRawVertices, HAND_RAW_VERTICES, 'Blender audit verifies source hand raw vertices');
equal(sourceOwnershipBaseline.handUniquePositions, HAND_UNIQUE_POSITIONS, 'Blender audit verifies source hand unique positions');
deepEqual(sourceOwnershipBaseline.sideUniquePositions, HAND_SIDE_UNIQUE_POSITIONS, 'Blender audit verifies both source hand components');
equal(sourceOwnershipBaseline.recordCount, HAND_UNIQUE_POSITIONS, 'Blender audit verifies exact source ownership coverage');

const mechanicalHingeTopology = rigAudit.mesh.mechanicalHingeTopology;
check(mechanicalHingeTopology && typeof mechanicalHingeTopology === 'object', 'Blender audit reports measured hinge topology');
const auditedSpecification = mechanicalHingeTopology.specification;
equal(auditedSpecification.file, manifest.rig.hingeSeams.file, 'Blender audit uses the measured hinge file');
equal(auditedSpecification.sha256, EXPECTED_HINGE_SHA256, 'Blender audit uses the fixed measured hinge hash');
equal(auditedSpecification.schemaVersion, 1, 'Blender audit uses measured hinge schema v1');
equal(auditedSpecification.sourceSha256, EXPECTED_SOURCE_SHA256, 'Blender audit source-locks the measured hinges');
equal(auditedSpecification.angleSampleCount, 32, 'Blender audit uses 32 angular samples');
equal(auditedSpecification.jointCount, 30, 'Blender audit validates all 30 joints');
equal(auditedSpecification.contourCount, 90, 'Blender audit validates all 90 contours');
equal(auditedSpecification.contoursPerJoint, 3, 'Blender audit validates three contours per joint');
equal(auditedSpecification.recordedSourceFaceSegments, measuredFaceSegmentCount, 'Blender audit sees every recorded source face segment');
equal(auditedSpecification.recordedUniqueRawEdgeIntersections, measuredUniqueIntersectionCount, 'Blender audit sees every recorded edge intersection');
equal(auditedSpecification.crossSeamFaceOverlaps, 201, 'Blender audit sees the cross-joint overlap inventory');
check(auditedSpecification.minimumWidth >= 0.002 - 1e-10, 'Blender audit minimum measured strip is at least 2 mm');
check(auditedSpecification.maximumWidth <= 0.007 + 1e-10, 'Blender audit maximum measured strip is at most 7 mm');
deepEqual(auditedSpecification.fixedFrameReparameterization, fixedFrameSummary, 'Blender audit independently reproduces canonical fixed-frame provenance');
validateFixedFrameSummary(auditedSpecification.fixedFrameReparameterization, hingeSeams, 'Blender fixed-frame specification audit');

const auditedSubdivision = mechanicalHingeTopology.subdivision;
equal(auditedSubdivision.sourceRawVertexCount, SOURCE_RAW_VERTICES, 'runtime topology begins with exact raw source vertices');
equal(auditedSubdivision.sourceUniquePositionCount, SOURCE_UNIQUE_POSITIONS, 'runtime topology begins with every source coordinate');
check(
    auditedSubdivision.subdividedRawVertexCount >= subdividedTopology.subdividedRawVertexCount
    && auditedSubdivision.subdividedRawVertexCount <= subdividedTopology.subdividedRawVertexCount + 8,
    'Blender runtime raw vertices match subdivision provenance within the bounded exporter split excess',
);
equal(auditedSubdivision.subdividedFaceCount, subdividedTopology.subdividedFaceCount, 'Blender audit retains pre-export subdivided face provenance');
equal(auditedSubdivision.runtimeTriangleCount, manifest.runtime.triangles, 'Blender runtime triangulation matches export provenance');
check(
    auditedSubdivision.insertedRawVertexCount >= subdividedTopology.insertedRawVertexCount
    && auditedSubdivision.insertedRawVertexCount <= subdividedTopology.insertedRawVertexCount + 8,
    'Blender runtime inserted vertices match subdivision provenance within the bounded exporter split excess',
);
equal(auditedSubdivision.insertedUniqueHandPositionCount, subdividedTopology.insertedUniqueHandPositionCount, 'Blender runtime inserted hand positions match subdivision provenance');
equal(auditedSubdivision.preservedOriginalSourceKeys, SOURCE_UNIQUE_POSITIONS, 'every original source position survives subdivision');
equal(auditedSubdivision.missingOriginalSourceKeys, 0, 'no original source position is lost');
check(auditedSubdivision.maximumOriginalSourcePositionDelta <= 2e-6, 'source positions remain within two micrometers');
check(auditedSubdivision.preservedSourceAttributeSignatures > 0, 'source UV/normal attribute islands are audited');
check(auditedSubdivision.maximumSourceUvDelta <= 2e-4, 'source UVs remain neutral through subdivision');
check(auditedSubdivision.maximumSourceNormalAngleDegrees <= 1, 'source normals remain neutral through subdivision');
deepEqual(auditedSubdivision.zoneCounts, subdividedTopology.zoneCounts, 'Blender runtime zones match final post-cut zone counts');
check(
    rigAudit.mesh.vertices >= subdividedTopology.subdividedRawVertexCount
    && rigAudit.mesh.vertices <= subdividedTopology.subdividedRawVertexCount + 8,
    'Blender report raw vertices match manifest topology within the bounded exporter split excess',
);
equal(rigAudit.mesh.triangles, manifest.runtime.triangles, 'Blender report triangles match exported runtime topology');
const auditedTopologyRecords = mechanicalHingeTopology.topologyRecords;
equal(auditedTopologyRecords.file, topologyRecordMetadata.file, 'Blender audit names the exact topology sidecar');
equal(auditedTopologyRecords.sha256, topologyRecordMetadata.sha256, 'Blender audit locks the exact topology sidecar hash');
equal(auditedTopologyRecords.recordCount, topologyRecords.records.length, 'Blender audit joins every topology-sidecar record');
equal(auditedTopologyRecords.coordinateEligibilityCount, 0, 'Blender topology-sidecar join never uses coordinates for joint eligibility');
deepEqual(auditedTopologyRecords.zoneCounts, topologyRecordZoneCounts, 'Blender audit reproduces exact topology-sidecar zones');
deepEqual(auditedTopologyRecords.interfaceDispositionCounts, topologyDispositionCounts, 'Blender audit reproduces exact topology dispositions');
deepEqual(auditedTopologyRecords.interfaceRankPositionCounts, topologyInterfaceRankCounts, 'Blender audit reproduces exact topology ranks');
equal(auditedTopologyRecords.inactiveIncompleteTripletCapPositionCount, topologyDispositionCounts.inactiveIncompleteTripletCap ?? 0, 'Blender audit reproduces inactive cap positions');
equal(auditedTopologyRecords.inactiveVirtualTangentPositionCount, topologyDispositionCounts.inactiveVirtualTangent ?? 0, 'Blender audit reproduces inactive virtual tangent positions');
equal(auditedTopologyRecords.inactiveVirtualTangentEdgeCount, topologyClassification.inactiveVirtualTangentEdgeCount, 'Blender audit proves every pruned virtual tangent edge');
equal(auditedTopologyRecords.inactiveVirtualAttachmentPositionCount, topologyClassification.inactiveVirtualAttachmentPositionCount, 'Blender audit proves every valid tangent attachment');
equal(auditedTopologyRecords.inactiveVirtualTangentComponentCount, topologyClassification.inactiveVirtualTangentComponentCount, 'Blender audit proves every terminal tangent component');
equal(auditedTopologyRecords.recordedRootEndpointReuseInsertionCount, recordedRootEndpointReuseInsertions, 'Blender audit reproduces every central virtual insertion record');
equal(auditedTopologyRecords.recordedRootEndpointReuseCount, recordedRootEndpointReuseCount, 'Blender audit proves every authored physical-root endpoint reuse');
check(Math.abs(auditedTopologyRecords.maximumRecordedRootEndpointReuseDisplacementMeters - maximumRecordedRootEndpointReuseDisplacementMeters) <= 1e-12, 'Blender audit reproduces the recorded-root endpoint displacement maximum');
equal(auditedTopologyRecords.ambiguousRecordedRootEndpointReuseCount, 0, 'Blender audit rejects ambiguous physical-root endpoint reuse');
equal(auditedTopologyRecords.crossOwnerRankEndpointReuseCount, 0, 'Blender audit rejects cross-owner/rank endpoint reuse');
equal(auditedTopologyRecords.centralConstraintSearchCount, centralConstraintSearchCount, 'Blender audit reproduces every bounded central-constraint search');
equal(auditedTopologyRecords.centralConstraintRawEdgeCount, centralConstraintRawEdgeCount, 'Blender audit reproduces every raw central-constraint edge');
equal(auditedTopologyRecords.centralConstraintOptimalActiveEdgeCount, centralConstraintOptimalActiveEdgeCount, 'Blender audit reproduces the exact active-edge optimum');
equal(auditedTopologyRecords.centralConstraintVisitedNodeCount, centralConstraintVisitedNodeCount, 'Blender audit reproduces bounded-search node visits');
equal(auditedTopologyRecords.centralConstraintPeakRollbackLogSize, centralConstraintPeakRollbackLogSize, 'Blender audit reproduces peak rollback storage');
equal(auditedTopologyRecords.centralConstraintTieCountEnumerated, false, 'Blender audit confirms tied optima were not enumerated');
equal(auditedTopologyRecords.centralConstraintOptimalityProven, true, 'Blender audit confirms bounded-search optimality');

const contourTopology = mechanicalHingeTopology.contourTopology;
equal(contourTopology.jointCount, 30, 'runtime contains 30 separated measured joints');
equal(contourTopology.contourCount, 90, 'runtime contains 90 exact ranked measured interfaces');
equal(contourTopology.coordinateEligibilityCount, 0, 'runtime contour audit never rediscovers joint eligibility from coordinates');
equal(contourTopology.activeInterfaceUniquePositionCount, topologyClassification.exactContourBlendPositionCount, 'runtime contour audit covers every exact topology interface position');
equal(contourTopology.activePhysicalInterfaceUniquePositionCount, topologyClassification.exactRecordedContourBlendPositionCount, 'runtime contour audit covers every active physical interface position');
equal(contourTopology.virtualContinuationUniquePositionCount, topologyClassification.exactVirtualContinuationBlendPositionCount, 'runtime contour audit covers every virtual continuation position');
equal(contourTopology.inactiveIncompleteTripletCapUniquePositionCount, topologyClassification.inactiveOnlyPositionCount, 'runtime contour audit reports every inactive incomplete cap position');
equal(contourTopology.inactiveVirtualTangentUniquePositionCount, topologyClassification.inactiveVirtualTangentPositionCount, 'runtime contour audit reports every pruned virtual tangent position');
check(contourTopology.minimumGasketWidth >= 0.002 - 1e-10, 'runtime gasket strips remain at least 2 mm');
check(contourTopology.maximumGasketWidth <= 0.007 + 1e-10, 'runtime gasket strips remain at most 7 mm');
equal(contourTopology.cuts.length, 90, 'Blender report retains all contour-cut evidence');
deepEqual(new Set(Object.keys(contourTopology.contours)), EXPECTED_CONTOUR_NAMES, 'runtime reports every proximal/center/distal contour');
deepEqual(new Set(Object.keys(contourTopology.separations)), EXPECTED_GASKET_NAMES, 'runtime reports separation for every gasket');
const builderContoursById = new Map(
    builderContourTopology.contours.map((contour) => [contour.id, contour]),
);
for (const [name, contour] of Object.entries(contourTopology.contours)) {
    const expectedBlend = name.endsWith('_proximalBoundary') ? 0 : name.endsWith('_center') ? 0.5 : 1;
    const nameParts = name.split('_');
    const gasketIndex = Number(nameParts[2].slice(1));
    const expectedInterfaceRank = gasketIndex * 3 + (expectedBlend === 0 ? 0 : expectedBlend === 0.5 ? 1 : 2);
    equal(contour.rawBlendT, expectedBlend, `${name} has exact raw contour blend semantics`);
    equal(contour.interfaceRank, expectedInterfaceRank, `${name} has the exact topology-interface rank`);
    check(contour.activeInterfaceUniquePositions >= 2 && contour.activeInterfaceRawVertices >= contour.activeInterfaceUniquePositions, `${name} contains exact ranked runtime topology`);
    equal(
        contour.activeInterfaceUniquePositions,
        contour.activePhysicalUniquePositions + contour.virtualContinuationUniquePositions,
        `${name} ranked positions partition into physical and virtual evidence`,
    );
    check(contour.activePhysicalUniquePositions >= 2, `${name} contains a real active physical interface edge`);
    check(contour.runtimeActivePhysicalEdges >= 1 && contour.runtimeInterfaceEdges >= contour.runtimeActivePhysicalEdges, `${name} exact interface positions remain connected in the export`);
    equal(contour.taggedGeometryId, nameParts.join('/'), `${name} references its own persistent tagged geometry`);
    const builderContour = builderContoursById.get(contour.taggedGeometryId);
    check(builderContour, `${name} references builder persistent-tag geometry`);
    equal(contour.taggedGeometryRawEdges, builderContour.rawTaggedEdgeCount, `${name} retains its tagged raw-edge count`);
    equal(contour.taggedGeometryUniquePositions, builderContour.collapsedVertexCount, `${name} retains its tagged unique-position count`);
    equal(contour.taggedGeometryCollapsedEdges, builderContour.collapsedEdgeCount, `${name} retains its tagged collapsed-edge count`);
    equal(contour.taggedGeometryComponentCount, builderContour.componentCount, `${name} retains its tagged component count`);
    equal(contour.taggedGeometryAbsoluteClosed, builderContour.absoluteClosed, `${name} retains its absolute-closure evidence`);
    equal(contour.taggedGeometryBoundaryRelativeClosed, builderContour.boundaryRelativeClosed, `${name} retains its boundary-relative closure evidence`);
    equal(contour.taggedGeometryClosed, true, `${name} persistent tagged geometry is closed`);
    equal(contour.maximumTaggedChordResidual, builderContour.maximumChordResidual, `${name} publishes the persistent-tag chord residual`);
    check(contour.maximumTaggedChordResidual <= 0.00015, `${name} persistent-tag chord residual is bounded`);
    check(contour.maximumWeightError <= 2e-6, `${name} reproduces exact t=0/0.5/1 weights`);
}
const weldedRigidAdjacency = contourTopology.weldedRigidAdjacency ?? {};
let weldedBridgeEdgeTotal = 0;
for (const [name, separation] of Object.entries(contourTopology.separations)) {
    check(separation.minimumWidth >= 0.002 - 1e-10 && separation.maximumWidth <= 0.007 + 1e-10, `${name} stays within its measured narrow strip`);
    const adjacencyKey = name.replace(/_/g, '/');
    const welded = weldedRigidAdjacency[adjacencyKey];
    const edgeBound = welded?.capWelded ? 32 : 12;
    const faceBound = welded?.capWelded ? 48 : 16;
    check(separation.directProximalDistalEdges <= edgeBound, `${name} keeps proximal-to-distal bridging within its bounded welded arc`);
    check(separation.proximalDistalBridgeFaces <= faceBound, `${name} keeps bridge faces within its bounded welded arc`);
    if (separation.directProximalDistalEdges > 0) {
        check(welded !== undefined && welded.edges === separation.directProximalDistalEdges, `${name} welded adjacency is reported in the rig audit`);
    }
    weldedBridgeEdgeTotal += separation.directProximalDistalEdges;
}
check(weldedBridgeEdgeTotal <= 64, 'global welded rigid adjacency stays within the bounded arc');

const attributePreservation = mechanicalHingeTopology.attributePreservation;
check(attributePreservation.auditedContourUniquePositions > 0, 'audit checks real effective contour positions');
check(attributePreservation.auditedContourRawVertices >= attributePreservation.auditedContourUniquePositions, 'audit covers contour UV/normal duplicates');
check(attributePreservation.insertedContourUniquePositions > 0, 'effective contours contain inserted positions');
equal(attributePreservation.nonFiniteUvValues, 0, 'effective contour UVs remain finite');
equal(attributePreservation.nonFiniteNormals, 0, 'effective contour normals remain finite');
check(attributePreservation.maximumNormalLengthError <= attributePreservation.normalLengthTolerance && attributePreservation.normalLengthTolerance <= 1e-5, 'effective contour normals remain unit length');
check(attributePreservation.effectiveTraceNote.includes('source UV/normal signatures'), 'audit explains neutral attribute handling for adjusted contours');

const mechanicalWeights = mechanicalHingeTopology.weights;
check(mechanicalWeights.runtimeRawVertices > HAND_RAW_VERTICES && mechanicalWeights.runtimeRawVertices <= rigAudit.mesh.vertices, 'runtime hand weights include inserted seam vertices');
equal(mechanicalWeights.runtimeUniquePositions, HAND_UNIQUE_POSITIONS + subdividedTopology.insertedUniqueHandPositionCount, 'runtime weights cover every source and inserted hand position');
check(mechanicalWeights.duplicatePositionGroups >= 1_492, 'runtime audit covers source and inserted UV/normal duplicate groups');
check(mechanicalWeights.maximumDuplicateWeightDifference <= 1e-7, 'all duplicate coordinates have the same weight vector');
equal(mechanicalWeights.handCoordinateSideEligibilityCount, 0, 'hand weighting never chooses a side from vertex coordinates');
equal(mechanicalWeights.topologyRecordSideUniquePositions, mechanicalWeights.runtimeUniquePositions, 'every hand position takes its side from an exact topology record');
equal(mechanicalWeights.topologyRecordSideRawVertices, mechanicalWeights.runtimeRawVertices, 'every hand UV/normal copy inherits its topology-record side');
equal(mechanicalWeights.crossRecordSideLeakageVertices, 0, 'no hand vertex leaks across its topology-record side');
check(mechanicalWeights.maximumCrossRecordSideLeakage <= 2e-6, 'topology-record side leakage stays below weight tolerance');
check(mechanicalWeights.maximumZoneWeightError <= 2e-4, 'runtime weights reproduce the measured post-cut zone map within export weight-cull precision');
equal(mechanicalWeights.mixedNonGasketVertices, 0, 'no non-gasket vertex mixes mechanical spaces');
equal(mechanicalWeights.rigidZoneNonUnitVertices, 0, 'every rigid palm/phalange vertex has unit weight');
equal(mechanicalWeights.wrongGasketPairs, 0, 'every gasket uses only its intended adjacent bone pair');
equal(mechanicalWeights.gasketBlendMismatches, 0, 'every gasket reproduces its single authored smoothstep');
deepEqual(new Set(Object.keys(mechanicalWeights.rawZoneCounts)), SKIN_ZONE_NAMES, 'runtime reports all seven mechanical zone classes');
equal(
    Object.values(mechanicalWeights.rawZoneCounts).reduce((sum, count) => sum + count, 0),
    mechanicalWeights.runtimeRawVertices,
    'runtime raw mechanical zone counts cover the complete subdivided hand region',
);
deepEqual(new Set(Object.keys(mechanicalWeights.gaskets)), EXPECTED_GASKET_NAMES, 'runtime reports all 30 MCP/CMC/PIP/DIP gaskets');
for (const [name, gasket] of Object.entries(mechanicalWeights.gaskets)) {
    check(gasket.uniqueRecords > 0, `${name} has post-subdivision gasket positions`);
    check(gasket.rawVertices >= gasket.uniqueRecords, `${name} covers its UV/normal duplicates`);
    check(gasket.mixedVertices > 0, `${name} contains real two-weight vertices`);
    check(gasket.mixedVertices <= gasket.rawVertices, `${name} mixed-vertex count is bounded`);
    check(gasket.minimumBlend >= 0 && gasket.maximumBlend <= 1, `${name} blend range is normalized`);
    check(gasket.minimumBlend <= gasket.maximumBlend, `${name} blend range is ordered`);
}

const rigidDeformationProbes = mechanicalHingeTopology.rigidDeformationProbes;
deepEqual(new Set(Object.keys(rigidDeformationProbes)), EXPECTED_GASKET_NAMES, 'runtime reports all 30 independent rigid-zone deformation probes');
for (const [name, probe] of Object.entries(rigidDeformationProbes)) {
    equal(probe.angleDegrees, 45, `${name} uses the independent 45-degree probe`);
    check(probe.vertices > 0, `${name} probes real rigid chrome vertices`);
    check(probe.maximumResidual <= 1e-6, `${name} rigid chrome residual stays below one micron`);
    check(probe.rmsResidual <= 1e-6, `${name} rigid chrome RMS residual stays below one micron`);
}

const sourcePivotAlignment = rigAudit.mesh.sourcePivotAlignment;
equal(Object.keys(sourcePivotAlignment.bones).length, 40, 'audit checks 30 pivot heads and 10 distal tips');
equal(sourcePivotAlignment.measuredCenterTableCount, 30, 'audit reports a measured-center proposal for every digit head');
const expectedStrictJoints = [];
for (const correction of pivotJointCorrections) {
    const gasketIndex = Number(correction.gasket[1]);
    const sourceHead = hingeSeams.jointPoints[correction.side][correction.digit][gasketIndex];
    const shift = Math.hypot(...correction.pivot.map((value, index) => value - sourceHead[index]));
    if (shift > 0.002) {
        expectedStrictJoints.push(`${correction.side}_${correction.digit}_${DIGIT_SEGMENTS.get(correction.digit)[gasketIndex]}`);
    }
}
expectedStrictJoints.sort();
equal(sourcePivotAlignment.strictMeasuredCenterJointCount, expectedStrictJoints.length, 'strict measured-center joint count matches the derived corrections');
deepEqual(
    sourcePivotAlignment.strictMeasuredCenterJoints,
    expectedStrictJoints,
    'strict measured-center joints match the joints whose derived centers moved over 2 mm',
);
check(
    expectedStrictJoints.includes('left_thumb_metacarpal')
    && expectedStrictJoints.includes('right_thumb_metacarpal'),
    'both displaced thumb G0 heads remain strict measured-center corrections',
);
check(
    sourcePivotAlignment.measuredCenterTolerancePolicy.includes('measured hinge-ring center')
    && sourcePivotAlignment.measuredCenterTolerancePolicy.includes('2 mm'),
    'measured-center pivot policy places every digit joint at its measured ring center',
);
check(Number.isFinite(sourcePivotAlignment.maximumError), 'maximum accepted pivot error is finite');
check(Number.isFinite(sourcePivotAlignment.maximumProposedCenterError), 'maximum proposed-center diagnostic is finite');
check(sourcePivotAlignment.maximumSourceLiteralError >= 0.026, 'runtime rejects the displaced 27-29 mm thumb source-head literals');
check(sourcePivotAlignment.maximumManifestMeasuredCenterError <= 1e-6, 'all 30 runtime bone heads equal manifest measured centers within one micron');
equal(sourcePivotAlignment.manifestMeasuredHeadTolerance, 1e-6, 'manifest measured-head tolerance is one micron');
equal(sourcePivotAlignment.tolerance, 0.001, 'derived measured-center acceptance tolerance is one millimeter');
check(Number.isFinite(sourcePivotAlignment.maximumTipError), 'synthetic leaf-tail diagnostic is finite');
check(sourcePivotAlignment.tipDiagnosticOnly.includes('do not encode'), 'manifest explains why glTF leaf tails are diagnostic-only');
for (const [name, alignment] of Object.entries(sourcePivotAlignment.bones)) {
    if (!name.endsWith('_tip')) {
        check(alignment.sourceHead.length === 3, `${name} records its prior source-head literal`);
        check(alignment.stableTangent.length === 3, `${name} records a branch-continuous joint tangent`);
        check(alignment.proposedMeasuredCenter.length === 3, `${name} records its independently proposed center`);
        check(alignment.acceptedExpected.length === 3 && alignment.actual.length === 3, `${name} alignment records accepted/actual vec3s`);
        check(Number.isFinite(alignment.centerTraceMeanOffset), `${name} center-trace offset is finite`);
        check(alignment.recordedCenterIntersectionCount >= 3, `${name} uses real recorded center intersections`);
        check(Number.isFinite(alignment.recordedCenterAxialMean), `${name} recorded axial center is finite`);
        check(Number.isFinite(alignment.recordedCenterAgreement), `${name} recorded/trace agreement is finite`);
        check(alignment.maximumCenterFitResidual >= 0, `${name} fixed-frame fit residual is finite`);
        check(alignment.p95CenterFitResidual <= alignment.maximumCenterFitResidual, `${name} p95 fit does not exceed its maximum`);
        check(alignment.error <= alignment.acceptanceTolerance, `${name} matches its evidence-selected accepted center`);
        check(alignment.manifestMeasuredCenterError <= 1e-6, `${name} head equals its manifest measured center`);
        check(alignment.derivedMeasuredPivot.length === 3, `${name} records its derived measured pivot`);
        deepEqual(alignment.acceptedExpected, alignment.derivedMeasuredPivot, `${name} accepts the derived measured hinge-ring center`);
        equal(alignment.acceptanceTolerance, 0.001, `${name} uses the one-millimeter measured-center tolerance`);
        if (name === 'left_thumb_metacarpal' || name === 'right_thumb_metacarpal') {
            check(alignment.centerTraceMeanOffset >= 0.027 && alignment.centerTraceMeanOffset <= 0.029, `${name} reports the modeled 27-29 mm G0 displacement`);
            check(Math.abs(alignment.recordedCenterAgreement) <= 0.00037, `${name} trace mean agrees with independent recorded intersections within 0.37 mm`);
            check(alignment.maximumCenterFitResidual <= 0.00121, `${name} fixed-frame center-ring residual is at most 1.21 mm`);
            check(alignment.sourceLiteralError >= 0.026, `${name} no longer accepts its old 27-29 mm displaced head`);
        }
    } else {
        check(Number.isFinite(alignment.error), `${name} reconstructed leaf-tail diagnostic is finite`);
        check(alignment.expected.length === 3 && alignment.actual.length === 3, `${name} tail diagnostic records two vec3s`);
    }
}
for (const [name, support] of Object.entries(rigAudit.mesh.digitBoneSupport)) {
    const buriedThumbCmc = name.endsWith('_thumb_metacarpal');
    check(support.dominantVertices >= (buriedThumbCmc ? 0 : 5), `${name} retains dominant topology`);
    check(support.totalWeight >= (buriedThumbCmc ? 1.0 : 3.5), `${name} retains meaningful total skin weight`);
    check(Math.max(support.headSurfaceDistance, support.tailSurfaceDistance) <= 0.065, `${name} endpoints remain inside its mesh branch`);
    check(support.centroidProjection >= -0.10 && support.centroidProjection <= 1.10, `${name} support stays centered on its segment`);
    check(support.centroidRadialDistance <= 0.05, `${name} support stays close to its bone axis`);
}
check(rigAudit.mesh.digitSeamPairs >= 1000, 'audit covers substantial digit UV seam pairs');
check(rigAudit.mesh.wristSeamPairs >= 1000, 'audit covers substantial wrist UV seam pairs');
for (const [name, record] of Object.entries(rigAudit.mesh.jointBlendSpans)) {
    const limit = name.endsWith('_elbow') ? 0.14 : 0.09;
    check(record.span <= limit, `${name} blend stays inside ${limit}m`);
}
check(rigAudit.cameraSpace.rest.ndcBounds.height < 1.35, 'rest pose stays below bounded screen height');
check(rigAudit.cameraSpace.rest.handSeparation > 0.24, 'rest hands are visibly separated');
for (const side of ['left', 'right']) {
    equal(rigAudit.cameraSpace.rest.arms[side].cutEnd.visibleCount, 0, `${side} proximal cut end is absent`);
    for (const digit of DIGITS) {
        for (const segment of DIGIT_SEGMENTS.get(digit)) {
            const minimumWeightedVertices =
                digit === 'thumb' && segment === 'metacarpal' ? 8 : 20;
            check(
                rigAudit.mesh.weightedVertexCounts[`${side}_${digit}_${segment}`] >= minimumWeightedVertices,
                `${side} ${digit} ${segment} has weighted topology`,
            );
        }
    }
}
for (const clip of rigAudit.clips) {
    check(clip.maximumDisplacementFromRest.max > 0.008, `${clip.name} deforms the real mesh`);
    check(clip.motion.movingBones.length >= 5, `${clip.name} moves multiple articulated bones`);
    check(clip.motion.movingDigitBones.length >= 4, `${clip.name} animates fingers`);
    for (const frame of clip.frames) {
        check(frame.deformation.digitEdges.maximumAbsoluteStretchMeters <= 0.05, `${clip.name} frame ${frame.frame} bounds within-digit absolute stretch`);
        check(frame.deformation.digitEdges.maximumAbsoluteCompressionMeters <= 0.05, `${clip.name} frame ${frame.frame} bounds within-digit absolute compression`);
        check(
            frame.deformation.digitEdges.outside067to150 <= Math.floor(frame.deformation.digitEdges.count * 0.20),
            `${clip.name} frame ${frame.frame} has no exploding finger strips`,
        );
        check(frame.deformation.wristEdges.p999 <= 1.35, `${clip.name} frame ${frame.frame} bounds wrist stretch`);
        check(frame.deformation.digitSeams.maximum <= 0.00001, `${clip.name} frame ${frame.frame} keeps digit seams within the 10-micron threshold`);
        check(frame.deformation.wristSeams.maximum <= 0.0025, `${clip.name} frame ${frame.frame} keeps wrist seams closed`);
    }
}

const moduleSource = readFileSync(new URL('src/first_person_viewmodel.js', ROOT), 'utf8');
const executableModuleSource = moduleSource.replace(/\/\/.*$/gm, '');
for (const token of [
    './assets/player/runtime/Aletheia_Chrome_1p_arms_viewmodel.glb?v=',
    'worldCamera.add(motionRoot)',
    'worldCamera.layers.enable(31)',
    'modelRoot.rotation.set(0, 0, 0)',
    'modelRoot.scale.setScalar(0.275)',
    'const ACTION_VIEWMODEL_Y = -0.19',
    'const IDLE_VIEWMODEL_LIFT = 0.015',
    'const WALK_VIEWMODEL_LIFT = 0.020',
    'const RUN_VIEWMODEL_LIFT = 0.015',
    'const VIEWMODEL_DEPTH = -0.385',
    'let smoothedY = ACTION_VIEWMODEL_Y + IDLE_VIEWMODEL_LIFT',
    "desired === 'Idle'",
    "desired === 'Walk'",
    "desired === 'Run'",
    'motionRoot.position.set(smoothedX, smoothedY, VIEWMODEL_DEPTH)',
    'motionRoot.position.set(0, ACTION_VIEWMODEL_Y + IDLE_VIEWMODEL_LIFT, VIEWMODEL_DEPTH)',
    "play('Idle'",
    "desired = 'Jump'",
    "desired = 'Land'",
    'desired = \'Climb\'',
    'const assistedStep = movement?.assistedStep',
    'const assistedStepActive = Boolean(assistedStep?.active)',
    'const climbDuration = Math.max(0.001, Number(assistedStep?.duration) || 0.001)',
    'const climbElapsed = Math.max(0, Number(assistedStep?.elapsed) || 0)',
    'const completedClimbFrame = !assistedStepActive',
    'const climbing = assistedStepActive || completedClimbFrame',
    'clamp01(climbElapsed / climbDuration)',
    'climbAction.paused = true',
    'climbAction.time = climbProgress * Math.max(authoredDuration, 0)',
    'mixer.update(frameDt)',
    'wasClimbing = assistedStepActive',
    'worldCollision: false',
    'integratedRenderPipeline: true',
    'contactSerial !== lastContactSerial',
    'CONTACT_CLIPS.has(desired)',
    'crossFadeTo(next, fadeSeconds, false)',
    'Number.isFinite(numericDt)',
]) check(moduleSource.includes(token), `viewmodel integration token: ${token}`);
check(/if \(climbing\) \{\s*desired = 'Climb';[\s\S]*?\} else if \(contactTimeRemaining > 0\)/.test(moduleSource),
    'assisted climb selection takes priority over contact and airborne clips');
check(/if \(desired === 'Climb'\) \{[\s\S]*?climbAction\.paused = true;[\s\S]*?climbAction\.time = climbProgress \*[\s\S]*?mixer\.update\(frameDt\)/.test(moduleSource),
    'Climb animation is deterministically scrubbed while mixer crossfade time advances');
check(/const completedClimbFrame = !assistedStepActive[\s\S]*?&& wasClimbing[\s\S]*?climbElapsed >= climbDuration - 1e-6/.test(moduleSource),
    'Climb samples the authored endpoint on assisted-step completion');
check(!/if \(desired === 'Climb'\) \{[\s\S]*?mixer\.update\(0\)/.test(moduleSource),
    'Climb branch does not freeze AnimationMixer global crossfade time');
check(!moduleSource.includes('modelRoot.rotation.x = Math.PI'), 'rejected X-axis half-turn absent');
check(!moduleSource.includes('modelRoot.rotation.y = Math.PI'), 'rejected Y-axis half-turn absent');
check(!/renderer\.renderAsync\s*\(/.test(executableModuleSource), 'viewmodel does not start a second renderer pass');
check(!/renderer\.clearDepth\s*\(/.test(executableModuleSource), 'viewmodel does not clear the world depth buffer');
check(!/_terrain|navigationSurfaceAt|vegetationCollision|collisionWorld/.test(moduleSource), 'viewmodel has no terrain/world collision dependency');

const mainSource = readFileSync(new URL('src/main.js', ROOT), 'utf8');
for (const token of [
    'contactSerial: 0',
    'contactLatched: false',
    'contactSeparationTime: 0',
    'const activeContact = collisionReported && inputLength > 0 && !assistedStepFrame',
    'movementState.contactSerial++',
    'movementState.contactLatched = true',
    'movementState.contactSeparationTime >= 0.12',
    'temple?.resolveCamera?.(camera, contactRecoilStart)',
    'vegetation?.resolveCamera?.(',
    'camera.position.x - appliedContactRecoilX - movementStart.x',
    'camera.position.z - appliedContactRecoilZ - movementStart.z',
]) check(mainSource.includes(token), `movement/contact integration token: ${token}`);
check(/const rightX = -fz;[\s\S]*const rightZ = fx;[\s\S]*Math\.abs\(sideDot\) < 0\.28/.test(mainSource),
    'contact side is selected in camera-relative left/right space');
check(/sprinting \? 0\.055 : 0\.035/.test(mainSource),
    'physical contact recoil remains bounded to 3.5/5.5 cm');
check(/movementState\.contactCooldown = 0\.18/.test(mainSource),
    'contact debounce is short and separation latch owns rearming');

console.log(`FIRST_PERSON_VIEWMODEL_STATIC_AUDIT_PASS ${assertions} assertions`);
