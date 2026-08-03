#!/usr/bin/env node
/**
 * Renderer-free audit for the sparse independent terrain-material ownership
 * policy. It samples the real CPU terrain/selector fields and the existing
 * SeedThree brush; it does not start a server, browser, renderer, or GPU and
 * does not write files.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TERRAIN_FILE = path.join(ROOT, 'src', 'terrain_real.js');
const BRUSH_FILE = path.join(ROOT, 'assets', 'terrain', 'masks', 'seedthree_blend_brush.png');
const FAMILY_LAYERS = Object.freeze({
    ground: Object.freeze([0, 1, 2, 3, 10]),
    wash: Object.freeze([4, 7, 9]),
    rock: Object.freeze([5, 6, 8, 11, 12, 13]),
});
const LAYER_NAMES = Object.freeze([
    'RockyTrail02', 'DryGroundRocks', 'RedLateriteSoilStones',
    'CrackedRedGround', 'MudCrackedDryRiverbed002', 'Rock029', 'Rock061',
    'GravellySand', 'RockFace03', 'SandyGravel02', 'RockyTrail',
    'RockFace', 'RockBoulderCracked', 'RocksGround02',
]);
const FAMILY_LIMITS = Object.freeze({
    ground: Object.freeze({ eligibility: 0.35, winner: 0.05, corePerWinner: 0.50,
        eroded2m: 0.18, p90InteriorM: 2 }),
    wash: Object.freeze({ eligibility: 0.20, winner: 0.10, corePerWinner: 0.35,
        eroded2m: 0.12, p90InteriorM: 2 }),
    rock: Object.freeze({ eligibility: 0.35, winner: 0.08, corePerWinner: 0.50,
        eroded2m: 0.18, p90InteriorM: 2 }),
});
const ACTIVE_EPSILON = 0.03;
const FAMILY_MAX_SIGNIFICANT_CHILDREN = 4;
const CORE_MARGIN = 0.08 - 1e-6;
const NON_ROCK_LAYERS = Object.freeze([0, 1, 2, 3, 4, 7, 9, 10]);
const NON_FACE_LAYERS = Object.freeze([0, 1, 2, 3, 4, 5, 6, 7, 9, 10, 12, 13]);
const MACRO_WINDOW_LIMITS = Object.freeze({
    32: 0.80,
    64: 0.58,
    128: 0.45,
    256: 0.35,
});

function parseArguments(argv) {
    let step = 2;
    let calibrate = false;
    let stepWasExplicit = false;
    for (let index = 0; index < argv.length; index++) {
        const argument = argv[index];
        if (argument === '--help' || argument === '-h') {
            console.log([
                'Usage: node tools/audit-terrain-ownership.mjs [--step METERS] [--calibrate]',
                '',
                'Default/acceptance sampling is a 2 m grid. The audit is read-only.',
                '--calibrate evaluates direct-field constants in memory; it never edits terrain source.',
            ].join('\n'));
            process.exit(0);
        }
        const inline = argument.match(/^--step=(.+)$/);
        if (inline) { step = Number(inline[1]); stepWasExplicit = true; }
        else if (argument === '--step') { step = Number(argv[++index]); stepWasExplicit = true; }
        else if (argument === '--calibrate') calibrate = true;
        else throw new Error(`Unknown argument: ${argument}`);
    }
    if (!Number.isFinite(step) || step < 1 || step > 8) {
        throw new Error(`--step must be between 1 and 8 metres; received ${step}`);
    }
    if (calibrate && !stepWasExplicit) step = 4;
    return { step, calibrate };
}

function sha256(filename) {
    return crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex');
}

function staticCpuTslParity(source) {
    const specifications = [
        {
            name: 'bounded-grade attribute',
            cpu: /splatB\[index \* 4 \+ 3\] = grade \/ \(1 \+ grade\);/,
            tsl: /const selectorB = T3\.attribute\('terrainSplatB', 'vec4'\)[\s\S]*?const gradeSignal = selectorB\.w;/,
        },
        {
            name: 'authored organic feature mix',
            cpu: /rawShapeShare = 1 - SURFACE_ORGANIC_POLICY\.authoredShapeShare[\s\S]{0,220}?selector \* rawShapeShare[\s\S]{0,120}?shaped\[index\] \* SURFACE_ORGANIC_POLICY\.authoredShapeShare/,
            tsl: /selector\.mul\(1 - SURFACE_ORGANIC_POLICY\.authoredShapeShare\)[\s\S]{0,140}?shapedSelectors\[index\]\.mul\(SURFACE_ORGANIC_POLICY\.authoredShapeShare\)/,
        },
        {
            name: 'field score 0.08+0.92f cubed',
            cpu: /0\.08 \+ clamp01\(value\) \* 0\.92,[\s\S]{0,40}?3,/,
            tsl: /value\.clamp\(0, 1\)[\s\S]{0,60}?\.mul\(0\.92\)\.add\(0\.08\)\.pow\(3\)/,
        },
        {
            name: 'softness and f0 modulation',
            cpu: /sparseFamily = \([\s\S]{0,100}?softness = SURFACE_ORGANIC_POLICY\.familyCrossfade[\s\S]{0,1800}?softness \* \(0\.88 \+ features\[0\] \* 0\.24\)/,
            tsl: /sparseFamily = \([\s\S]{0,100}?softness = SURFACE_ORGANIC_POLICY\.familyCrossfade[\s\S]{0,2400}?features\[0\]\.mul\(0\.24\)\.add\(0\.88\)\.mul\(softness\)/,
        },
        {
            name: 'five-ground continuous organic scores and soft elevation bias',
            cpu: /const groundPrimaries = \[[\s\S]{0,180}?features\[1\], features\[6\], features\[2\], features\[3\],[\s\S]{0,80}?1 - features\[1\],[\s\S]{0,260}?SURFACE_ORGANIC_POLICY\.groundElevationTrends\[index\] \* groundHeightSignal/,
            tsl: /const groundPrimaries = \[[\s\S]{0,180}?features\[1\], features\[6\], features\[2\], features\[3\],[\s\S]{0,80}?features\[1\]\.oneMinus\(\)[\s\S]{0,300}?groundHeightSignal\.mul\(groundElevationTrends\[index\]\)\.add\(1\)/,
        },
        {
            name: 'wash direct fields',
            cpu: /const washScores = \[\s*fieldScore\(features\[1\]\),\s*fieldScore\(features\[2\]\),\s*fieldScore\(features\[6\]\),\s*\];/,
            tsl: /const washScores = \[\s*fieldScore\(features\[1\]\),\s*fieldScore\(features\[2\]\),\s*fieldScore\(features\[6\]\),\s*\];/,
        },
        {
            name: 'face gate and strength',
            cpu: /faceGate = smooth\(0\.305556, 0\.444444, gradeSignal\)[\s\S]{0,4000}?faceStrength = Math\.max\(faceCandidate \* 1\.30, faceGate\)/,
            tsl: /faceGate = T3\.smoothstep\(0\.305556, 0\.444444, gradeSignal\)[\s\S]{0,4000}?faceStrength = T3\.max\(faceCandidate\.mul\(1\.30\), faceGate\)/,
        },
        {
            name: 'rock direct fields, complementary faces, and gated talus',
            cpu: /const rockScores = \[[\s\S]{0,700}?fieldScore\(features\[5\]\)[\s\S]*?fieldScore\(features\[2\]\)[\s\S]*?fieldScore\(features\[1\]\)[\s\S]*?fieldScore\(1 - features\[1\]\)[\s\S]*?fieldScore\(features\[3\]\)[\s\S]*?fieldScore\(features\[6\]\) \* talusGate \* 1\.15[\s\S]*?\];/,
            tsl: /const rockScores = \[[\s\S]{0,800}?fieldScore\(features\[5\]\)[\s\S]*?fieldScore\(features\[2\]\)[\s\S]*?fieldScore\(features\[1\]\)[\s\S]*?fieldScore\(features\[1\]\.oneMinus\(\)\)[\s\S]*?fieldScore\(features\[3\]\)[\s\S]*?fieldScore\(features\[6\]\)\.mul\(talusGate\)\.mul\(1\.15\)[\s\S]*?\];/,
        },
        {
            name: 'crater exposure and rock-only soft crossfade',
            cpu: /const craterExposure = smooth\([\s\S]*?const rockOwnership = sparseFamily\(\s*rockScores, SURFACE_ORGANIC_POLICY\.rockFamilyCrossfade/,
            tsl: /const craterExposure = T3\.smoothstep\([\s\S]*?const rockOwnership = sparseFamily\(\s*rockScores, SURFACE_ORGANIC_POLICY\.rockFamilyCrossfade/,
        },
        {
            name: 'elevation purity thresholds',
            cpu: /smooth\(35, 50, elevation\)[\s\S]{0,1400}?summitPure = smooth\(35, 50, elevation\)/,
            tsl: /T3\.smoothstep\(35, 50, elevation\)[\s\S]{0,1400}?summitPure = T3\.smoothstep\(35, 50, elevation\)/,
        },
    ];
    const checks = specifications.map(({ name, cpu, tsl }) => ({
        name,
        cpu: cpu.test(source),
        tsl: tsl.test(source),
    })).map((check) => ({ ...check, pass: check.cpu && check.tsl }));
    const noSquareCellPath = !/GROUND_CELLULAR_POLICY|groundCellularWeightsAt|terrainGroundCell[AB]/
        .test(source);
    checks.push({
        name: 'square-cell ownership path absent',
        cpu: noSquareCellPath,
        tsl: noSquareCellPath,
        pass: noSquareCellPath,
    });
    return {
        pass: checks.every((check) => check.pass),
        checkCount: checks.length,
        checks,
        failures: checks.filter((check) => !check.pass).map((check) => (
            'CPU/TSL static parity failed for ' + check.name
            + ' (cpu=' + check.cpu + ', tsl=' + check.tsl + ')'
        )),
    };
}

function loadTerrainInternals() {
    let source = fs.readFileSync(TERRAIN_FILE, 'utf8');
    if (!/function resolvePaintOwnership\s*\(/.test(source)) {
        throw new Error(
            'src/terrain_real.js does not yet define resolvePaintOwnership; '
            + 'land the sparse ownership implementation before running this audit.',
        );
    }
    source = source.replace('export async function makeTerrain', 'async function makeTerrain');
    source += `\n;globalThis.__terrainOwnershipAudit = {
        NEAR_SEGMENTS, HORIZON_RADIAL_SEGMENTS, HALF_NEAR,
        terrainHeightAt, paintAt, resolvePaintOwnership,
        TERRAIN_BLEND_BRUSH_TRANSFORMS, SURFACE_ORGANIC_POLICY,
        washMaskAt, fbm, valueNoise
    };\n`;
    const context = vm.createContext({ console, Blob, Response, DecompressionStream });
    new vm.Script(source, { filename: TERRAIN_FILE }).runInContext(context);
    return context.__terrainOwnershipAudit;
}

function decodeGray8Png(filename) {
    const data = fs.readFileSync(filename);
    const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    if (!data.subarray(0, 8).equals(signature)) throw new Error(`Invalid PNG: ${filename}`);
    let offset = 8;
    let width = 0, height = 0, bitDepth = 0, colorType = -1, interlace = -1;
    const chunks = [];
    while (offset < data.length) {
        const length = data.readUInt32BE(offset); offset += 4;
        const type = data.toString('ascii', offset, offset + 4); offset += 4;
        const payload = data.subarray(offset, offset + length); offset += length + 4;
        if (type === 'IHDR') {
            width = payload.readUInt32BE(0);
            height = payload.readUInt32BE(4);
            bitDepth = payload[8];
            colorType = payload[9];
            interlace = payload[12];
        } else if (type === 'IDAT') chunks.push(payload);
        else if (type === 'IEND') break;
    }
    if (width !== 1024 || height !== 1024 || bitDepth !== 8
        || colorType !== 0 || interlace !== 0) {
        throw new Error(
            `Expected 1024-square non-interlaced Gray8 brush; got `
            + `${width}x${height}, depth=${bitDepth}, type=${colorType}, interlace=${interlace}`,
        );
    }
    const inflated = zlib.inflateSync(Buffer.concat(chunks));
    const samples = new Uint8Array(width * height);
    let cursor = 0;
    let previous = Buffer.alloc(width);
    for (let y = 0; y < height; y++) {
        const filter = inflated[cursor++];
        const current = Buffer.allocUnsafe(width);
        for (let x = 0; x < width; x++) {
            const raw = inflated[cursor++];
            const left = x ? current[x - 1] : 0;
            const up = previous[x];
            const upLeft = x ? previous[x - 1] : 0;
            let predictor = 0;
            if (filter === 1) predictor = left;
            else if (filter === 2) predictor = up;
            else if (filter === 3) predictor = Math.floor((left + up) * 0.5);
            else if (filter === 4) {
                const estimate = left + up - upLeft;
                const dl = Math.abs(estimate - left);
                const du = Math.abs(estimate - up);
                const dul = Math.abs(estimate - upLeft);
                predictor = dl <= du && dl <= dul ? left : (du <= dul ? up : upLeft);
            } else if (filter !== 0) throw new Error(`Unsupported PNG filter ${filter}`);
            current[x] = (raw + predictor) & 255;
        }
        samples.set(current, y * width);
        previous = current;
    }
    return { width, height, samples };
}

function sampleRepeatedBrush(image, x, z, transform) {
    const fract = (value) => value - Math.floor(value);
    const u = fract(x / transform.repeatMeters + transform.offset[0]);
    const v = fract(z / transform.repeatMeters + transform.offset[1]);
    const pixelX = u * image.width - 0.5;
    const pixelY = v * image.height - 0.5;
    const x0 = Math.floor(pixelX), y0 = Math.floor(pixelY);
    const fx = pixelX - x0, fy = pixelY - y0;
    const wrapX = (value) => ((value % image.width) + image.width) % image.width;
    const wrapY = (value) => ((value % image.height) + image.height) % image.height;
    const at = (px, py) => image.samples[wrapY(py) * image.width + wrapX(px)] / 255;
    const top = at(x0, y0) * (1 - fx) + at(x0 + 1, y0) * fx;
    const bottom = at(x0, y0 + 1) * (1 - fx) + at(x0 + 1, y0 + 1) * fx;
    return top * (1 - fy) + bottom * fy;
}

function near(left, right, epsilon = 1e-6) {
    return Math.abs(left - right) <= epsilon;
}

function quantile(sorted, fraction) {
    if (!sorted.length) return 0;
    const position = (sorted.length - 1) * fraction;
    const lower = Math.floor(position), upper = Math.ceil(position);
    const mix = position - lower;
    return sorted[lower] * (1 - mix) + sorted[upper] * mix;
}

function makeFamilyState(sampleCount) {
    return Object.fromEntries(Object.entries(FAMILY_LAYERS).map(([name, layers]) => [name, {
        layers,
        eligible: 0,
        winners: new Uint32Array(layers.length),
        cores: new Uint32Array(layers.length),
        winnerMap: new Int16Array(sampleCount).fill(-1),
        maximumActive: 0,
        tooManyActive: 0,
    }]));
}

function contractCheck(result, failures, sampleLabel) {
    const fail = (message) => failures.push(`${sampleLabel}: ${message}`);
    if (!result || typeof result !== 'object') return fail('ownership result is not an object');
    if (!Array.isArray(result.weights) || result.weights.length !== 14) {
        return fail('weights must be a 14-element array');
    }
    for (const key of ['families', 'familyMembers', 'familyScores', 'familyMargins']) {
        if (!result[key] || typeof result[key] !== 'object') fail(`${key} is missing`);
    }
    for (const key of ['faceGate', 'highFlat', 'coarseGround', 'talusGate']) {
        if (!Number.isFinite(result[key])) fail(`${key} is not finite`);
    }
    const weightSum = result.weights.reduce((sum, value) => sum + value, 0);
    if (!result.weights.every((value) => Number.isFinite(value) && value >= 0)) {
        fail('weights contain a negative or non-finite value');
    }
    if (!near(weightSum, 1, 2e-6)) fail(`weights sum to ${weightSum}, not one`);
    if (result.talusGate === 0 && result.weights[13] !== 0) {
        fail('RocksGround02 is nonzero while its talus gate is exactly zero');
    }
    if (result.families) {
        const familySum = ['ground', 'wash', 'rock']
            .reduce((sum, name) => sum + Number(result.families[name]), 0);
        if (!near(familySum, 1, 2e-6)) fail(`family masses sum to ${familySum}, not one`);
    }
    for (const [name, layers] of Object.entries(FAMILY_LAYERS)) {
        const members = result.familyMembers?.[name];
        const scores = result.familyScores?.[name];
        const margin = result.familyMargins?.[name];
        if (!Array.isArray(members) || members.length !== layers.length) {
            fail(`${name} familyMembers length is not ${layers.length}`);
            continue;
        }
        if (!Array.isArray(scores) || scores.length !== layers.length) {
            fail(`${name} familyScores length is not ${layers.length}`);
        }
        if (!Number.isFinite(margin) || margin < -1e-7) fail(`${name} margin is invalid: ${margin}`);
        const memberSum = members.reduce((sum, value) => sum + value, 0);
        if (!near(memberSum, 1, 2e-6)) fail(`${name} members sum to ${memberSum}, not one`);
        const familyMass = Number(result.families?.[name]);
        for (let local = 0; local < layers.length; local++) {
            const expected = familyMass * members[local];
            if (!near(result.weights[layers[local]], expected, 3e-6)) {
                fail(`${name} layer ${layers[local]} disagrees with family mass/member weight`);
            }
        }
    }
}

function syntheticGateAudit(api, brush) {
    const failures = [];
    let state = 0x7f4a7c15;
    const random = () => {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        return state / 0x100000000;
    };
    let verticalCases = 0;
    let elevationPurityCases = 0;
    let elevationPurityViolations = 0;
    let gradeFacePurityCases = 0;
    let gradeFacePurityViolations = 0;
    let summitCases = 0;
    let summitNonFaceMass = 0;
    let summitNonFaceWinners = 0;
    for (let sample = 0; sample < 256; sample++) {
        const selectors = Array.from({ length: 7 }, () => random());
        const brushValues = Array.from({ length: 7 }, () => random());
        selectors[0] = 0.80 + random() * 0.10;
        selectors[4] = random();
        const vertical = api.resolvePaintOwnership(selectors, brushValues, 100, 30, 1);
        contractCheck(vertical, failures, `synthetic vertical ${sample}`);
        verticalCases++;
        if (vertical.faceGate !== 1) failures.push(`synthetic vertical ${sample}: faceGate is not exactly one`);
        if (NON_FACE_LAYERS.some((layer) => vertical.weights[layer] !== 0)) {
            failures.push(`synthetic vertical ${sample}: a suppressed layer is not exactly zero`);
        }
        if (!near(vertical.weights[8] + vertical.weights[11], 1, 2e-6)) {
            failures.push(`synthetic vertical ${sample}: face layers do not sum to one`);
        }

        const elevationPure = api.resolvePaintOwnership(
            selectors, brushValues, random() * 0.79, 50 + random() * 80, 1,
        );
        contractCheck(elevationPure, failures, `synthetic elevation purity ${sample}`);
        elevationPurityCases++;
        const elevationViolation = elevationPure.families.ground !== 0
            || elevationPure.families.wash !== 0
            || elevationPure.families.rock !== 1
            || NON_ROCK_LAYERS.some((layer) => elevationPure.weights[layer] !== 0)
            || !near(FAMILY_LAYERS.rock.reduce(
                (sum, layer) => sum + elevationPure.weights[layer], 0,
            ), 1, 2e-6);
        if (elevationViolation) {
            elevationPurityViolations++;
            failures.push(
                `synthetic elevation purity ${sample}: elevation>=50 was not exactly all-rock`,
            );
        }

        const gradePure = api.resolvePaintOwnership(
            selectors, brushValues, 0.80 + random() * 4, -20 + random() * 69, 1,
        );
        contractCheck(gradePure, failures, `synthetic grade purity ${sample}`);
        gradeFacePurityCases++;
        const gradeViolation = gradePure.faceGate !== 1
            || gradePure.families.ground !== 0
            || gradePure.families.wash !== 0
            || gradePure.families.rock !== 1
            || NON_FACE_LAYERS.some((layer) => gradePure.weights[layer] !== 0)
            || !near(gradePure.weights[8] + gradePure.weights[11], 1, 2e-6);
        if (gradeViolation) {
            gradeFacePurityViolations++;
            failures.push(
                `synthetic grade purity ${sample}: grade>=.80 was not exactly face-only`,
            );
        }

        selectors[4] = 0;
        const summit = api.resolvePaintOwnership(selectors, brushValues, 0, 30, 0);
        contractCheck(summit, failures, `synthetic summit ${sample}`);
        const rock = summit.familyMembers.rock;
        const nonFaceMass = rock[0] + rock[1] + rock[4] + rock[5];
        summitNonFaceMass += nonFaceMass;
        const winner = rock.indexOf(Math.max(...rock));
        if (winner === 0 || winner === 1 || winner === 4 || winner === 5) {
            summitNonFaceWinners++;
        }
        summitCases++;
    }
    const meanNonFaceMass = summitNonFaceMass / summitCases;
    const nonFaceWinnerFraction = summitNonFaceWinners / summitCases;
    if (meanNonFaceMass < 0.75) failures.push(
        `synthetic summits: non-face rock mass ${meanNonFaceMass} is below 0.75`,
    );
    if (nonFaceWinnerFraction < 0.75) failures.push(
        `synthetic summits: non-face winner fraction ${nonFaceWinnerFraction} is below 0.75`,
    );
    return {
        verticalCases,
        elevationPurityCases,
        elevationPurityViolations,
        gradeFacePurityCases,
        gradeFacePurityViolations,
        summitCases,
        meanNonFaceMass,
        nonFaceWinnerFraction,
        failures,
    };
}

function interiorThickness(winnerMap, columns, rows, child, step) {
    const count = winnerMap.length;
    const distances = new Int32Array(count).fill(-1);
    const queue = new Int32Array(count);
    let head = 0, tail = 0, area = 0;
    for (let row = 0; row < rows; row++) {
        for (let column = 0; column < columns; column++) {
            const index = row * columns + column;
            if (winnerMap[index] !== child) continue;
            area++;
            const boundary = row === 0 || column === 0 || row === rows - 1 || column === columns - 1
                || winnerMap[index - 1] !== child || winnerMap[index + 1] !== child
                || winnerMap[index - columns] !== child || winnerMap[index + columns] !== child;
            if (boundary) {
                distances[index] = 0;
                queue[tail++] = index;
            }
        }
    }
    while (head < tail) {
        const index = queue[head++];
        const row = Math.floor(index / columns), column = index - row * columns;
        const nextDistance = distances[index] + 1;
        if (column > 0) visit(index - 1, nextDistance);
        if (column + 1 < columns) visit(index + 1, nextDistance);
        if (row > 0) visit(index - columns, nextDistance);
        if (row + 1 < rows) visit(index + columns, nextDistance);
    }
    function visit(index, distance) {
        if (winnerMap[index] !== child || distances[index] >= 0) return;
        distances[index] = distance;
        queue[tail++] = index;
    }
    const values = [];
    let eroded = 0;
    const erosionCells = Math.max(1, Math.ceil(2 / step));
    for (let index = 0; index < count; index++) {
        if (winnerMap[index] !== child) continue;
        const metres = distances[index] * step;
        values.push(metres);
        if (distances[index] >= erosionCells) eroded++;
    }
    values.sort((left, right) => left - right);
    return {
        areaSamples: area,
        areaSquareMeters: area * step * step,
        eroded2mRatio: area ? eroded / area : 0,
        medianInteriorM: quantile(values, 0.5),
        p90InteriorM: quantile(values, 0.9),
        boundaryOnlyRatio: area ? values.filter((value) => value === 0).length / area : 1,
    };
}

function summarizeOrganicBoundaries(
    memberFields, eligibleMap, winnerMap, columns, rows, step, start,
) {
    const orientationBins = new Uint32Array(12);
    const xCrossings = [];
    const zCrossings = [];
    let eligibleSamples = 0;
    let decisiveInteriors = 0;
    let transitionCells = 0;
    let orientationSamples = 0;
    let fourfoldSum = 0;
    for (let row = 0; row < rows; row++) {
        for (let column = 0; column < columns; column++) {
            const index = row * columns + column;
            if (!eligibleMap[index]) continue;
            eligibleSamples++;
            let strongest = 0;
            for (const field of memberFields) strongest = Math.max(strongest, field[index]);
            if (strongest >= 0.80) decisiveInteriors++;

            let transition = false;
            if (column + 1 < columns && eligibleMap[index + 1]
                && winnerMap[index] !== winnerMap[index + 1]) {
                transition = true;
                xCrossings.push(start + column * step + step * 0.5);
            }
            if (row + 1 < rows && eligibleMap[index + columns]
                && winnerMap[index] !== winnerMap[index + columns]) {
                transition = true;
                zCrossings.push(start + row * step + step * 0.5);
            }
            if (transition) transitionCells++;

            if (row === 0 || column === 0 || row + 1 >= rows || column + 1 >= columns
                || !eligibleMap[index - 1] || !eligibleMap[index + 1]
                || !eligibleMap[index - columns] || !eligibleMap[index + columns]) continue;
            for (const field of memberFields) {
                const value = field[index];
                if (value <= 0.05 || value >= 0.95) continue;
                const dx = field[index + 1] - field[index - 1];
                const dz = field[index + columns] - field[index - columns];
                if (Math.hypot(dx, dz) < 0.04) continue;
                let theta = Math.atan2(dz, dx);
                if (theta < 0) theta += Math.PI;
                if (theta >= Math.PI) theta -= Math.PI;
                const bin = Math.min(11, Math.floor(theta / Math.PI * 12));
                orientationBins[bin]++;
                fourfoldSum += Math.cos(theta * 4);
                orientationSamples++;
            }
        }
    }
    let entropy = 0;
    for (const count of orientationBins) {
        if (!count || !orientationSamples) continue;
        const probability = count / orientationSamples;
        entropy -= probability * Math.log(probability);
    }
    entropy /= Math.log(orientationBins.length);
    const phaseResultant = (coordinates, period) => {
        if (!coordinates.length) return 1;
        let cosine = 0, sine = 0;
        for (const coordinate of coordinates) {
            const phase = coordinate / period * Math.PI * 2;
            cosine += Math.cos(phase);
            sine += Math.sin(phase);
        }
        return Math.hypot(cosine, sine) / coordinates.length;
    };
    return {
        eligibleSamples,
        decisiveInteriors,
        decisiveInteriorFraction: eligibleSamples ? decisiveInteriors / eligibleSamples : 0,
        transitionCells,
        crossingCount: xCrossings.length + zCrossings.length,
        orientationSamples,
        orientationEntropy12: entropy,
        fourfoldAxisLock: orientationSamples
            ? Math.abs(fourfoldSum / orientationSamples) : 1,
        phaseLock6m: Math.max(
            phaseResultant(xCrossings, 6), phaseResultant(zCrossings, 6),
        ),
        phaseLock12m: Math.max(
            phaseResultant(xCrossings, 12), phaseResultant(zCrossings, 12),
        ),
        orientationBins: Array.from(orientationBins),
    };
}

const CALIBRATION_CANDIDATE = Object.freeze({
    featureRawShare: 0.80,
    fieldBase: 0.08,
    fieldScale: 0.92,
    fieldPower: 3,
    softness: 0.24,
    useBreakupF0: false,
    lowGroundSecondary: null,
    prototypeAssignment: null,
    rbfScale: 0,
    lowGroundGains: Object.freeze([1, 1, 1]),
    cellSize: 0,
    cellJitter: 0,
    cellSharpness: 0,
    cellCategories: 3,
    cellClusterSize: 1,
    cellWarpAmplitude: 0,
    cellularSeed: 1229,
    modulationForm: 'none',
    modulationValue: 0,
    groundSubgroupFloor: 0,
    faceStrengthScale: 1.30,
    boulderBase: 0.78,
    boulderHighFlat: 0.50,
});

function smoothCpu(edge0, edge1, value) {
    const t = Math.max(0, Math.min(1, (value - edge0) / (edge1 - edge0)));
    return t * t * (3 - 2 * t);
}

function dedicatedBreakupSelectorAt(api, x, z, seed = 947) {
    const warpX = (api.fbm(
        x * 0.0151 + seed, z * 0.0139 - seed, seed + 11, 3,
    ) - 0.5) * 11;
    const warpZ = (api.fbm(
        x * 0.0137 - seed, z * 0.0157 + seed, seed + 23, 3,
    ) - 0.5) * 11;
    const patches = api.fbm(
        (x + warpX) * 0.075 + seed * 0.097,
        (z + warpZ) * 0.068 - seed * 0.073,
        seed + 47, 3,
    );
    const chips = api.fbm(
        (x - warpZ * 0.24) * 0.160 + seed * 0.13,
        (z + warpX * 0.24) * 0.143 - seed * 0.11,
        seed + 79, 2,
    );
    return smoothCpu(0.20, 0.80, patches * 0.45 + chips * 0.55);
}

function shaderHash2d(x, z, seed) {
    const value = Math.sin(x * 127.1 + z * 311.7 + seed * 74.7) * 43758.5453123;
    return value - Math.floor(value);
}

function balancedCellularWeights(x, z, candidate, warpX = 0, warpZ = 0) {
    const size = candidate.cellSize;
    const px = (x + warpX) / size, pz = (z + warpZ) / size;
    const baseX = Math.floor(px), baseZ = Math.floor(pz);
    const categories = candidate.cellCategories ?? 3;
    const scores = Array.from({ length: categories }, () => 0);
    const mod = (value, divisor) => ((value % divisor) + divisor) % divisor;
    for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
            const cellX = baseX + dx, cellZ = baseZ + dz;
            const clusterSize = candidate.cellClusterSize ?? 1;
            const categoryX = Math.floor(cellX / clusterSize);
            const categoryZ = Math.floor(cellZ / clusterSize);
            const superSize = categories === 6 ? 6 : 3;
            const superX = Math.floor(categoryX / superSize);
            const superZ = Math.floor(categoryZ / superSize);
            const localX = mod(categoryX, superSize);
            const localZ = mod(categoryZ, superSize);
            const rotation = Math.floor(
                shaderHash2d(superX, superZ, candidate.cellularSeed) * categories,
            );
            const orientation = Math.floor(
                shaderHash2d(superX, superZ, candidate.cellularSeed + 53) * 4,
            );
            const phase = categories === 6
                ? [
                    localX + localZ * 3,
                    -localX + localZ * 3,
                    localZ + localX * 3,
                    -localZ + localX * 3,
                ][orientation]
                : localX + localZ * 2;
            const category = mod(phase + rotation, categories);
            const jitterX = (shaderHash2d(
                cellX, cellZ, candidate.cellularSeed + 17,
            ) * 2 - 1) * candidate.cellJitter;
            const jitterZ = (shaderHash2d(
                cellX, cellZ, candidate.cellularSeed + 31,
            ) * 2 - 1) * candidate.cellJitter;
            const offsetX = px - (cellX + 0.5 + jitterX);
            const offsetZ = pz - (cellZ + 0.5 + jitterZ);
            const distanceSquared = offsetX * offsetX + offsetZ * offsetZ;
            scores[category] += Math.exp(-candidate.cellSharpness * distanceSquared);
        }
    }
    const total = scores.reduce((sum, score) => sum + score, 0);
    const normalized = scores.map((score) => score / Math.max(total, 1e-8));
    const packed = normalized.map((weight) => Math.round(
        Math.max(0, Math.min(1, weight)) * 255,
    ));
    const decoded = packed.map((weight) => weight / 255);
    const decodedTotal = decoded.reduce((sum, weight) => sum + weight, 0);
    return decoded.map((weight) => weight / Math.max(decodedTotal, 1e-8));
}

function calibrationOwnership(sample, candidate = CALIBRATION_CANDIDATE) {
    const selectors = Array.from(sample.selectors);
    if (candidate.useBreakupF0) selectors[0] = sample.breakupSelector;
    const shaped = selectors.map((selector, index) => {
        const threshold = sample.brushValues[index] * 0.70 + 0.15;
        return smoothCpu(threshold - 0.22, threshold + 0.22, selector);
    });
    const features = selectors.map((selector, index) => (
        Math.max(0, Math.min(1,
            selector * candidate.featureRawShare
                + shaped[index] * (1 - candidate.featureRawShare)))
    ));
    const fieldScore = (value) => Math.pow(
        candidate.fieldBase + Math.max(0, Math.min(1, value)) * candidate.fieldScale,
        candidate.fieldPower,
    );
    const secondarySignals = [
        features[0],
        1 - features[0],
        features[0] * features[5],
        (1 - features[0]) * features[5],
        features[0] * (1 - features[5]),
        (1 - features[0]) * (1 - features[5]),
        features[5],
    ];
    const prototypeWeights = candidate.modulationForm === 'rbf'
        ? LOW_GROUND_PROTOTYPE_CENTERS.map((center) => {
            const distanceSquared = (features[0] - center[0]) ** 2
                + (features[5] - center[1]) ** 2;
            return Math.exp(-candidate.rbfScale * distanceSquared);
        }) : null;
    if (prototypeWeights) {
        const total = prototypeWeights.reduce((sum, value) => sum + value, 0);
        for (let index = 0; index < prototypeWeights.length; index++) {
            prototypeWeights[index] /= Math.max(total, 1e-8);
        }
    }
    const warpAmplitude = candidate.cellWarpAmplitude ?? 0;
    const cellularWeights = candidate.modulationForm === 'cellular'
        ? balancedCellularWeights(
            sample.x,
            sample.z,
            candidate,
            (selectors[0] * 2 - 1) * warpAmplitude,
            (selectors[5] * 2 - 1) * warpAmplitude,
        ) : null;
    const lowGroundScore = (primary, slot) => {
        const base = fieldScore(primary);
        if (candidate.modulationForm === 'cellular') {
            const category = candidate.prototypeAssignment?.[slot];
            const secondary = cellularWeights?.[category];
            if (!Number.isFinite(secondary)) return base;
            const share = candidate.modulationValue;
            return base * (1 - share) + secondary * share;
        }
        if (candidate.modulationForm === 'rbf') {
            const prototypeIndex = candidate.prototypeAssignment?.[slot];
            const secondary = prototypeWeights?.[prototypeIndex];
            if (!Number.isFinite(secondary)) return base;
            const share = candidate.modulationValue;
            return base * (1 - share) + secondary * share;
        }
        const signalIndex = candidate.lowGroundSecondary?.[slot];
        if (!Number.isInteger(signalIndex)) return base;
        const secondary = fieldScore(secondarySignals[signalIndex]);
        if (candidate.modulationForm === 'multiply') {
            const floor = candidate.modulationValue;
            return base * (floor + (1 - floor) * secondary);
        }
        if (candidate.modulationForm === 'average') {
            const share = candidate.modulationValue;
            return base * (1 - share) + secondary * share;
        }
        return base;
    };
    const groundPrimaries = [
        features[1], features[6], features[2], features[3],
        1 - features[1], 1 - features[3],
    ];
    const elevationTrends = candidate.groundElevationTrends
        ?? [-0.18, 0.10, -0.14, -0.10, 0.18, 0.22];
    const heightSignal = sample.coarseGround * 2 - 1;
    const groundScores = groundPrimaries.map((primary, slot) => {
        let score = fieldScore(primary);
        if (candidate.modulationForm === 'cellular') {
            const cellular = cellularWeights?.[slot];
            if (Number.isFinite(cellular)) {
                const share = candidate.modulationValue;
                score = score * (1 - share) + cellular * share;
            }
        }
        return score * (1 + elevationTrends[slot] * heightSignal);
    });
    const washScores = [
        fieldScore(features[1]),
        fieldScore(features[2]),
        fieldScore(features[6]),
    ];
    const gradeSignal = sample.physicalGrade / (1 + sample.physicalGrade);
    const faceCandidate = smoothCpu(0.137931, 0.305556, gradeSignal);
    const nonFace = 1 - sample.faceGate;
    const faceStrength = Math.max(
        sample.faceGate,
        faceCandidate * candidate.faceStrengthScale,
    );
    const rockScores = [
        fieldScore(features[5]) * nonFace,
        fieldScore(features[2]) * nonFace,
        fieldScore(features[1]) * faceStrength + sample.faceGate * 0.01,
        fieldScore(1 - features[1]) * faceStrength + sample.faceGate * 0.01,
        fieldScore(features[3]) * nonFace
            * (candidate.boulderBase + sample.highFlat * candidate.boulderHighFlat),
    ];
    const sparse = (scores) => {
        let first = scores[0] > scores[1] ? 0 : 1;
        let second = first === 0 ? 1 : 0;
        for (let index = 2; index < scores.length; index++) {
            if (scores[index] > scores[first]) {
                second = first;
                first = index;
            } else if (scores[index] > scores[second]) second = index;
        }
        const margin = (scores[first] - scores[second])
            / Math.max(scores[first] + scores[second], 1e-5);
        const edgeSoftness = candidate.softness * (0.88 + features[0] * 0.24);
        const separation = smoothCpu(0, edgeSoftness, margin);
        const weights = scores.map(() => 0);
        weights[first] = 0.5 + 0.5 * separation;
        weights[second] = 0.5 - 0.5 * separation;
        return { weights, margin, first };
    };
    return {
        ground: sparse(groundScores),
        wash: sparse(washScores),
        rock: sparse(rockScores),
    };
}

function summarizeMacroFootprints(
    weights, columns, rows, step,
    layerIndices = Array.from({ length: LAYER_NAMES.length }, (_, index) => index),
    integralWorkspace = null,
) {
    const layerCount = LAYER_NAMES.length;
    const integralColumns = columns + 1;
    const integralSize = (rows + 1) * integralColumns;
    const reports = Object.fromEntries(Object.entries(MACRO_WINDOW_LIMITS).map(
        ([meters, limit]) => [meters, {
            meters: Number(meters),
            limit,
            maximumMean: 0,
            maximumLayer: -1,
            maximumLayerName: null,
            maximumWindow: null,
            pass: true,
        }],
    ));
    const integral = integralWorkspace ?? new Float64Array(integralSize);
    if (integral.length !== integralSize) {
        throw new Error('Macro integral workspace has the wrong dimensions');
    }
    for (const layer of layerIndices) {
        integral.fill(0);
        for (let row = 0; row < rows; row++) {
            let rowSum = 0;
            const targetOffset = (row + 1) * integralColumns;
            const previousOffset = row * integralColumns;
            for (let column = 0; column < columns; column++) {
                rowSum += weights[(row * columns + column) * layerCount + layer];
                integral[targetOffset + column + 1]
                    = integral[previousOffset + column + 1] + rowSum;
            }
        }
        for (const report of Object.values(reports)) {
            const side = Math.max(1, Math.round(report.meters / step));
            const stride = Math.max(1, Math.round(side / 4));
            if (side > columns || side > rows) continue;
            const inverseCount = 1 / (side * side);
            for (let row = 0; row + side <= rows; row += stride) {
                const bottom = (row + side) * integralColumns;
                const top = row * integralColumns;
                for (let column = 0; column + side <= columns; column += stride) {
                    const right = column + side;
                    const sum = integral[bottom + right] - integral[bottom + column]
                        - integral[top + right] + integral[top + column];
                    const mean = sum * inverseCount;
                    if (mean > report.maximumMean) {
                        report.maximumMean = mean;
                        report.maximumLayer = layer;
                        report.maximumLayerName = LAYER_NAMES[layer];
                        report.maximumWindow = {
                            row, column, sideCells: side,
                            boundsMeters: [
                                column * step,
                                row * step,
                                (column + side) * step,
                                (row + side) * step,
                            ],
                        };
                    }
                }
            }
        }
    }
    let failureCount = 0;
    let normalizedExcess = 0;
    for (const report of Object.values(reports)) {
        report.pass = report.maximumMean <= report.limit + 1e-9;
        if (!report.pass) failureCount++;
        normalizedExcess += Math.max(0, report.maximumMean - report.limit) / report.limit;
    }
    return { failureCount, normalizedExcess, windows: reports };
}

function summarizeFeatureWindow(samples, window, candidate) {
    const totals = {
        selectors: Array(7).fill(0),
        shaped: Array(7).fill(0),
        features: Array(7).fill(0),
        featureScores: Array(7).fill(0),
        inverseFeatureScores: Array(7).fill(0),
    };
    let count = 0;
    const rawShare = candidate.featureRawShare;
    const score = (value) => Math.pow(
        candidate.fieldBase + Math.max(0, Math.min(1, value)) * candidate.fieldScale,
        candidate.fieldPower,
    );
    for (let row = window.row; row < window.row + window.sideCells; row++) {
        for (let column = window.column;
            column < window.column + window.sideCells; column++) {
            const sample = samples[row * Math.round(Math.sqrt(samples.length)) + column];
            if (!sample) continue;
            const selectors = Array.from(sample.selectors);
            if (candidate.useBreakupF0) selectors[0] = sample.breakupSelector;
            for (let index = 0; index < 7; index++) {
                const selector = selectors[index];
                const threshold = sample.brushValues[index] * 0.70 + 0.15;
                const shaped = smoothCpu(threshold - 0.22, threshold + 0.22, selector);
                const feature = Math.max(0, Math.min(
                    1, selector * rawShare + shaped * (1 - rawShare),
                ));
                totals.selectors[index] += selector;
                totals.shaped[index] += shaped;
                totals.features[index] += feature;
                totals.featureScores[index] += score(feature);
                totals.inverseFeatureScores[index] += score(1 - feature);
            }
            count++;
        }
    }
    for (const values of Object.values(totals)) {
        for (let index = 0; index < values.length; index++) values[index] /= count;
    }
    return { samples: count, ...totals };
}

const LOW_GROUND_PROTOTYPE_CENTERS = Object.freeze([
    Object.freeze([0.18, 0.25]),
    Object.freeze([0.82, 0.25]),
    Object.freeze([0.50, 0.82]),
]);

function mergeMacroFootprints(ground, fixed) {
    const windows = {};
    let failureCount = 0;
    let normalizedExcess = 0;
    for (const [meters, limit] of Object.entries(MACRO_WINDOW_LIMITS)) {
        const groundWindow = ground.windows[meters];
        const fixedWindow = fixed.windows[meters];
        const selected = groundWindow.maximumMean >= fixedWindow.maximumMean
            ? groundWindow : fixedWindow;
        const report = { ...selected, limit };
        report.pass = report.maximumMean <= limit + 1e-9;
        if (!report.pass) failureCount++;
        normalizedExcess += Math.max(0, report.maximumMean - limit) / limit;
        windows[meters] = report;
    }
    return { failureCount, normalizedExcess, windows };
}

function searchLowGroundMappings(samples, columns, rows, step) {
    const count = samples.length;
    const candidate = { ...CALIBRATION_CANDIDATE, useBreakupF0: false };
    const primaryScores = new Float32Array(count * 6);
    const feature0 = new Float32Array(count);
    const feature5 = new Float32Array(count);
    const coarseGround = new Float32Array(count);
    const groundFamily = new Float32Array(count);
    const fixedWeights = new Float32Array(count * LAYER_NAMES.length);
    const candidateWeights = new Float32Array(count * LAYER_NAMES.length);
    const fieldScore = (value) => Math.pow(
        candidate.fieldBase + Math.max(0, Math.min(1, value)) * candidate.fieldScale,
        candidate.fieldPower,
    );
    const groundLayerSet = new Set(FAMILY_LAYERS.ground);
    for (let index = 0; index < count; index++) {
        const sample = samples[index];
        const selectors = Array.from(sample.selectors);
        const shaped = selectors.map((selector, featureIndex) => {
            const threshold = sample.brushValues[featureIndex] * 0.70 + 0.15;
            return smoothCpu(threshold - 0.22, threshold + 0.22, selector);
        });
        const features = selectors.map((selector, featureIndex) => (
            Math.max(0, Math.min(1,
                selector * candidate.featureRawShare
                    + shaped[featureIndex] * (1 - candidate.featureRawShare)))
        ));
        const primaryValues = [
            features[1], features[6], features[2],
            features[3], 1 - features[1], 1 - features[3],
        ];
        for (let local = 0; local < primaryValues.length; local++) {
            primaryScores[index * 6 + local] = fieldScore(primaryValues[local]);
        }
        feature0[index] = features[0];
        feature5[index] = features[5];
        coarseGround[index] = sample.coarseGround;
        groundFamily[index] = sample.families.ground;
        for (let layer = 0; layer < LAYER_NAMES.length; layer++) {
            if (!groundLayerSet.has(layer)) {
                fixedWeights[index * LAYER_NAMES.length + layer] = sample.weights[layer];
            }
        }
    }

    const integralWorkspace = new Float64Array((rows + 1) * (columns + 1));
    const fixedMacro = summarizeMacroFootprints(
        fixedWeights, columns, rows, step,
        [...FAMILY_LAYERS.wash, ...FAMILY_LAYERS.rock],
        integralWorkspace,
    );
    const searchResults = [];
    const assignments = [
        [0, 1, 2], [0, 2, 1], [1, 0, 2],
        [1, 2, 0], [2, 0, 1], [2, 1, 0],
    ];
    for (const cellSize of [10, 12, 14]) {
        for (const cellJitter of [0.22, 0.38]) {
            for (const cellSharpness of [3, 6]) {
                for (const value of [0.70, 0.85]) {
                    for (const assignment of assignments) {
                        const cellularCandidate = {
                            ...candidate,
                            prototypeAssignment: assignment,
                            modulationForm: 'cellular',
                            modulationValue: value,
                            cellSize,
                            cellJitter,
                            cellSharpness,
                        };
                    for (let index = 0; index < count; index++) {
                        const sourceOffset = index * 6;
                        const low = 1 - coarseGround[index];
                        const high = coarseGround[index];
                        const cellularWeights = balancedCellularWeights(
                            samples[index].x, samples[index].z, cellularCandidate,
                        );
                        const modulate = (base, prototypeIndex) => (
                            base * (1 - value) + cellularWeights[prototypeIndex] * value
                        );
                        const scores = [
                            modulate(
                                primaryScores[sourceOffset],
                                assignment[0],
                            ) * low,
                            primaryScores[sourceOffset + 1] * high,
                            modulate(
                                primaryScores[sourceOffset + 2],
                                assignment[1],
                            ) * low,
                            modulate(
                                primaryScores[sourceOffset + 3],
                                assignment[2],
                            ) * low,
                            primaryScores[sourceOffset + 4] * high,
                            primaryScores[sourceOffset + 5] * high,
                        ];
                        let winner = scores[0] > scores[1] ? 0 : 1;
                        let runnerUp = winner === 0 ? 1 : 0;
                        for (let local = 2; local < scores.length; local++) {
                            if (scores[local] > scores[winner]) {
                                runnerUp = winner;
                                winner = local;
                            } else if (scores[local] > scores[runnerUp]) runnerUp = local;
                        }
                        const margin = (scores[winner] - scores[runnerUp])
                            / Math.max(scores[winner] + scores[runnerUp], 1e-5);
                        const edgeSoftness = candidate.softness
                            * (0.88 + feature0[index] * 0.24);
                        const separation = smoothCpu(0, edgeSoftness, margin);
                        const targetOffset = index * LAYER_NAMES.length;
                        for (const layer of FAMILY_LAYERS.ground) {
                            candidateWeights[targetOffset + layer] = 0;
                        }
                        const mass = groundFamily[index];
                        candidateWeights[targetOffset + FAMILY_LAYERS.ground[winner]]
                            = mass * (0.5 + 0.5 * separation);
                        candidateWeights[targetOffset + FAMILY_LAYERS.ground[runnerUp]]
                            = mass * (0.5 - 0.5 * separation);
                    }
                    const groundMacro = summarizeMacroFootprints(
                        candidateWeights, columns, rows, step,
                        FAMILY_LAYERS.ground, integralWorkspace,
                    );
                    const macroFootprints = mergeMacroFootprints(groundMacro, fixedMacro);
                    searchResults.push({
                        candidate: {
                            ...cellularCandidate,
                        },
                        macroFootprints,
                    });
                    }
                }
            }
        }
    }
    searchResults.sort((left, right) => (
        left.macroFootprints.failureCount - right.macroFootprints.failureCount
        || left.macroFootprints.normalizedExcess - right.macroFootprints.normalizedExcess
    ));
    const finalists = [10, 12, 14].flatMap((cellSize) => (
        searchResults.filter((result) => result.candidate.cellSize === cellSize).slice(0, 8)
    ));
    return {
        prototypeCenters: LOW_GROUND_PROTOTYPE_CENTERS,
        evaluatedCandidates: searchResults.length,
        best: searchResults[0],
        finalists,
        summary: searchResults.slice(0, 20).map((result) => ({
            prototypeAssignment: result.candidate.prototypeAssignment,
            modulationForm: result.candidate.modulationForm,
            modulationValue: result.candidate.modulationValue,
            cellSize: result.candidate.cellSize,
            cellJitter: result.candidate.cellJitter,
            cellSharpness: result.candidate.cellSharpness,
            macroFailures: result.macroFootprints.failureCount,
            normalizedExcess: result.macroFootprints.normalizedExcess,
            macroMaximumMeans: Object.fromEntries(Object.entries(
                result.macroFootprints.windows,
            ).map(([meters, report]) => [meters, report.maximumMean])),
        })),
    };
}

function evaluateCalibration(samples, columns, rows, step, candidate = CALIBRATION_CANDIDATE) {
    const states = makeFamilyState(samples.length);
    const candidateWeights = new Float32Array(samples.length * LAYER_NAMES.length);
    let summitSamples = 0, summitNonFaceMass = 0, summitNonFaceWinners = 0;
    for (let index = 0; index < samples.length; index++) {
        const sample = samples[index];
        const owners = calibrationOwnership(sample, candidate);
        for (const [name, state] of Object.entries(states)) {
            const result = owners[name];
            for (let local = 0; local < state.layers.length; local++) {
                candidateWeights[index * LAYER_NAMES.length + state.layers[local]]
                    = sample.families[name] * result.weights[local];
            }
            state.maximumActive = Math.max(
                state.maximumActive,
                result.weights.filter((value) => value > ACTIVE_EPSILON).length,
            );
            if (sample.families[name] < FAMILY_LIMITS[name].eligibility) continue;
            state.eligible++;
            state.winners[result.first]++;
            state.winnerMap[index] = result.first;
            if (result.margin >= CORE_MARGIN) state.cores[result.first]++;
        }
        if (sample.highFlat >= 0.70 && sample.faceGate <= 0.10
            && sample.families.rock >= FAMILY_LIMITS.rock.eligibility) {
            const rock = owners.rock;
            summitSamples++;
            summitNonFaceMass += rock.weights[0] + rock.weights[1] + rock.weights[4];
            if (rock.first === 0 || rock.first === 1 || rock.first === 4) summitNonFaceWinners++;
        }
    }
    const families = {};
    let islandFailures = 0;
    for (const [name, state] of Object.entries(states)) {
        const limits = FAMILY_LIMITS[name];
        const layers = {};
        for (let local = 0; local < state.layers.length; local++) {
            const winnerFraction = state.eligible ? state.winners[local] / state.eligible : 0;
            const corePerWinner = state.winners[local]
                ? state.cores[local] / state.winners[local] : 0;
            const thickness = interiorThickness(state.winnerMap, columns, rows, local, step);
            const pass = winnerFraction >= limits.winner
                && corePerWinner >= limits.corePerWinner
                && thickness.eroded2mRatio >= limits.eroded2m
                && thickness.p90InteriorM >= limits.p90InteriorM;
            if (!pass) islandFailures++;
            layers[LAYER_NAMES[state.layers[local]]] = {
                winnerFraction, corePerWinner, ...thickness, pass,
            };
        }
        families[name] = {
            eligibleSamples: state.eligible,
            maximumActiveChildren: state.maximumActive,
            layers,
        };
    }
    const summit = {
        samples: summitSamples,
        meanNonFaceRockMass: summitSamples ? summitNonFaceMass / summitSamples : 0,
        nonFaceRockWinnerFraction: summitSamples ? summitNonFaceWinners / summitSamples : 0,
    };
    if (summitSamples < 32 || summit.meanNonFaceRockMass < 0.75
        || summit.nonFaceRockWinnerFraction < 0.75) islandFailures++;
    const summarizeDiversityAt = (windowMeters) => {
        const windowCells = Math.max(1, Math.round(windowMeters / step));
        const counts = [];
        for (let row0 = 0; row0 + windowCells <= rows; row0 += windowCells) {
            for (let column0 = 0; column0 + windowCells <= columns; column0 += windowCells) {
                const winners = new Set();
                let eligible = 0;
                for (let row = row0; row < row0 + windowCells; row++) {
                    for (let column = column0; column < column0 + windowCells; column++) {
                        const index = row * columns + column;
                        const sample = samples[index];
                        if (sample.families.ground < FAMILY_LIMITS.ground.eligibility
                            || sample.coarseGround > 0.90) continue;
                        eligible++;
                        const winner = states.ground.winnerMap[index];
                        if (winner >= 0) winners.add(winner);
                    }
                }
                if (eligible >= windowCells * windowCells * 0.20) counts.push(winners.size);
            }
        }
        counts.sort((left, right) => left - right);
        return {
            windowMeters,
            windows: counts.length,
            minimum: counts[0] ?? 0,
            p10: quantile(counts, 0.10),
            median: quantile(counts, 0.50),
            fractionAtLeastFive: counts.length
                ? counts.filter((count) => count >= 5).length / counts.length : 0,
            fractionAllSix: counts.length
                ? counts.filter((count) => count === 6).length / counts.length : 0,
        };
    };
    const localDiversity = {
        activeGroundChildren: states.ground.winners.filter((count) => count > 0).length,
        windows64m: summarizeDiversityAt(64),
        windows96m: summarizeDiversityAt(96),
    };
    let diversityFailures = 0;
    if (localDiversity.activeGroundChildren < 6) diversityFailures++;
    if (localDiversity.windows64m.median < 5
        || localDiversity.windows64m.fractionAtLeastFive < 0.80) diversityFailures++;
    if (localDiversity.windows96m.median < 6) diversityFailures++;
    const macroFootprints = summarizeMacroFootprints(
        candidateWeights, columns, rows, step,
    );
    for (const report of Object.values(macroFootprints.windows)) {
        report.maximumWindow.featureStats = summarizeFeatureWindow(
            samples, report.maximumWindow, candidate,
        );
    }
    return {
        candidate,
        failures: islandFailures + diversityFailures + macroFootprints.failureCount,
        islandFailures,
        diversityFailures,
        macroFailures: macroFootprints.failureCount,
        macroFootprints,
        localDiversity,
        summit,
        families,
    };
}

function evaluateCalibrationVariants(samples, columns, rows, step) {
    const sizes = step <= 2.01 ? [5, 6, 7] : [4, 5, 6, 7];
    const shares = step <= 2.01 ? [0.74] : [0.68, 0.74];
    const warpFractions = [0, 0.22];
    const variants = [];
    for (const cellSize of sizes) {
        for (const share of shares) {
            for (const warpFraction of warpFractions) {
                variants.push(evaluateCalibration(samples, columns, rows, step, {
                    ...CALIBRATION_CANDIDATE,
                    modulationForm: 'cellular',
                    modulationValue: share,
                    cellSize,
                    cellJitter: 0.22,
                    cellSharpness: 3,
                    cellCategories: 6,
                    cellClusterSize: 2,
                    cellWarpAmplitude: cellSize * warpFraction,
                    groundElevationTrends: [-0.18, 0.10, -0.14, -0.10, 0.18, 0.22],
                }));
            }
        }
    }
    variants.sort((left, right) => (
        left.failures - right.failures
        || left.macroFootprints.normalizedExcess - right.macroFootprints.normalizedExcess
        || left.candidate.cellSize - right.candidate.cellSize
        || right.candidate.modulationValue - left.candidate.modulationValue
    ));
    return {
        best: variants[0],
        sizeComparisons: variants,
        mappingSearch: {
            mode: step <= 2.01 ? 'decisive-2m-six-ground' : 'broad-six-ground',
            evaluatedCandidates: variants.length,
        },
        summary: variants.map((variant) => ({
            cellSize: variant.candidate.cellSize,
            effectiveClusterMeters: variant.candidate.cellSize
                * variant.candidate.cellClusterSize,
            share: variant.candidate.modulationValue,
            warpAmplitude: variant.candidate.cellWarpAmplitude,
            failures: variant.failures,
            islandFailures: variant.islandFailures,
            diversityFailures: variant.diversityFailures,
            macroFailures: variant.macroFailures,
            localDiversity: variant.localDiversity,
            groundLayers: variant.families.ground.layers,
            macroMaximumMeans: Object.fromEntries(Object.entries(
                variant.macroFootprints.windows,
            ).map(([meters, report]) => [meters, report.maximumMean])),
        })),
    };
}

function main() {
    const { step, calibrate } = parseArguments(process.argv.slice(2));
    const terrainSource = fs.readFileSync(TERRAIN_FILE, 'utf8');
    const staticParity = staticCpuTslParity(terrainSource);
    const api = loadTerrainInternals();
    const brush = decodeGray8Png(BRUSH_FILE);
    if (!Array.isArray(api.TERRAIN_BLEND_BRUSH_TRANSFORMS)
        || api.TERRAIN_BLEND_BRUSH_TRANSFORMS.length !== 7) {
        throw new Error('Expected seven existing authored-brush transforms');
    }
    const side = api.HALF_NEAR * 2;
    const columns = Math.floor(side / step);
    const rows = columns;
    const count = columns * rows;
    const start = -api.HALF_NEAR + step * 0.5;
    const familyState = makeFamilyState(count);
    const organicGroundEligible = new Uint8Array(count);
    const organicGroundMembers = FAMILY_LAYERS.ground.map(() => new Float32Array(count));
    const failures = [...staticParity.failures];
    const expectedOrganicPolicy = {
        authoredShapeShare: 0.68,
        familyCrossfade: 0.16,
        familyCrossfadePower: 4,
        rockFamilyCrossfade: 0.22,
        craterExposureSelector: [0.11, 0.15],
        craterRockEligibility: 0.20,
        craterRock061Bias: 0.30,
        groundElevationTrends: [-0.18, 0.10, -0.14, -0.10, 0.18],
        talusElevationMeters: [8, 24],
        talusGradeSignal: [0.107143, 0.230769],
        talusSummitFadeMeters: [32, 50],
    };
    for (const [key, expected] of Object.entries(expectedOrganicPolicy)) {
        const actual = api.SURFACE_ORGANIC_POLICY?.[key];
        const matches = Array.isArray(expected)
            ? expected.every((value, index) => actual?.[index] === value)
            : actual === expected;
        if (!matches) failures.push(
            `SURFACE_ORGANIC_POLICY.${key}=${JSON.stringify(actual)} `
            + `expected ${JSON.stringify(expected)}`,
        );
    }
    const contractFailures = [];
    let invalidSamples = 0;
    let realVerticalSamples = 0;
    let realVerticalViolations = 0;
    let realElevationPuritySamples = 0;
    let realElevationPurityViolations = 0;
    let realGradePuritySamples = 0;
    let realGradePurityViolations = 0;
    let summitSamples = 0;
    let summitNonFaceMass = 0;
    let summitNonFaceWinners = 0;
    let lowFlatSamples = 0;
    let lowFlatTalusViolations = 0;
    let lowFlatMaximumTalusMass = 0;
    let eligibleTalusSamples = 0;
    let eligibleTalusWinners = 0;
    let eligibleTalusMass = 0;
    let talusGateZeroViolations = 0;
    const retainedMass5 = [];
    const calibrationSamples = calibrate ? [] : null;

    for (let row = 0; row < rows; row++) {
        const z = start + row * step;
        for (let column = 0; column < columns; column++) {
            const x = start + column * step;
            const index = row * columns + column;
            const elevation = api.terrainHeightAt(x, z);
            const delta = 0.8;
            const dx = (api.terrainHeightAt(x + delta, z) - api.terrainHeightAt(x - delta, z))
                / (delta * 2);
            const dz = (api.terrainHeightAt(x, z + delta) - api.terrainHeightAt(x, z - delta))
                / (delta * 2);
            const physicalGrade = Math.hypot(dx, dz);
            const paint = api.paintAt(x, z, physicalGrade, elevation);
            const brushValues = api.TERRAIN_BLEND_BRUSH_TRANSFORMS.map(
                (transform) => sampleRepeatedBrush(brush, x, z, transform),
            );
            const washSupport = api.washMaskAt(x, z);
            const ownership = api.resolvePaintOwnership(
                paint.selectors, brushValues, physicalGrade, elevation, washSupport,
                x, z,
            );
            if (calibrationSamples) calibrationSamples.push({
                x,
                z,
                selectors: Array.from(paint.selectors),
                brushValues,
                breakupSelector: dedicatedBreakupSelectorAt(api, x, z),
                physicalGrade,
                elevation,
                families: { ...ownership.families },
                weights: Array.from(ownership.weights),
                faceGate: ownership.faceGate,
                highFlat: ownership.highFlat,
                coarseGround: ownership.coarseGround,
            });
            if (contractFailures.length < 100) contractCheck(
                ownership, contractFailures, `terrain (${x}, ${z})`,
            );
            if (!ownership?.weights || ownership.weights.some((value) => !Number.isFinite(value))) {
                invalidSamples++;
                continue;
            }
            retainedMass5.push([...ownership.weights]
                .sort((left, right) => right - left)
                .slice(0, 5)
                .reduce((sum, weight) => sum + weight, 0));

            if (ownership.talusGate === 0 && ownership.weights[13] !== 0) {
                talusGateZeroViolations++;
            }
            if (washSupport === 0 && ownership.families.ground >= 0.90) {
                organicGroundEligible[index] = 1;
                for (let local = 0; local < organicGroundMembers.length; local++) {
                    organicGroundMembers[local][index] = ownership.familyMembers.ground[local];
                }
            }
            if (elevation <= 6 && physicalGrade <= 0.10 && washSupport === 0
                && ownership.families.ground >= 0.98) {
                lowFlatSamples++;
                lowFlatMaximumTalusMass = Math.max(
                    lowFlatMaximumTalusMass, ownership.weights[13],
                );
                if (ownership.talusGate !== 0 || ownership.weights[13] !== 0) {
                    lowFlatTalusViolations++;
                }
            }
            if (ownership.talusGate >= 0.25 && ownership.families.rock >= 0.35
                && ownership.faceGate < 0.50) {
                eligibleTalusSamples++;
                eligibleTalusMass += ownership.weights[13];
                const rockMembers = ownership.familyMembers.rock;
                if (rockMembers.indexOf(Math.max(...rockMembers)) === 5) {
                    eligibleTalusWinners++;
                }
            }

            if (ownership.faceGate === 1) {
                realVerticalSamples++;
                const suppressed = [0, 1, 2, 3, 4, 5, 6, 7, 9, 10, 12, 13];
                if (suppressed.some((layer) => ownership.weights[layer] !== 0)
                    || !near(ownership.weights[8] + ownership.weights[11], 1, 2e-6)) {
                    realVerticalViolations++;
                }
            }
            if (elevation >= 50) {
                realElevationPuritySamples++;
                if (ownership.families.ground !== 0
                    || ownership.families.wash !== 0
                    || ownership.families.rock !== 1
                    || NON_ROCK_LAYERS.some((layer) => ownership.weights[layer] !== 0)) {
                    realElevationPurityViolations++;
                }
            }
            if (physicalGrade >= 0.80) {
                realGradePuritySamples++;
                if (ownership.faceGate !== 1
                    || ownership.families.ground !== 0
                    || ownership.families.wash !== 0
                    || ownership.families.rock !== 1
                    || NON_FACE_LAYERS.some((layer) => ownership.weights[layer] !== 0)) {
                    realGradePurityViolations++;
                }
            }

            for (const [name, state] of Object.entries(familyState)) {
                const members = ownership.familyMembers[name];
                const active = members.filter((value) => value > ACTIVE_EPSILON).length;
                state.maximumActive = Math.max(state.maximumActive, active);
                if (active > FAMILY_MAX_SIGNIFICANT_CHILDREN) state.tooManyActive++;
                if (ownership.families[name] < FAMILY_LIMITS[name].eligibility) continue;
                state.eligible++;
                let winner = 0;
                for (let local = 1; local < members.length; local++) {
                    if (members[local] > members[winner]) winner = local;
                }
                state.winners[winner]++;
                state.winnerMap[index] = winner;
                if (ownership.familyMargins[name] >= CORE_MARGIN) state.cores[winner]++;
            }

            if (ownership.highFlat >= 0.70 && ownership.faceGate <= 0.10
                && ownership.families.rock >= FAMILY_LIMITS.rock.eligibility) {
                const rock = ownership.familyMembers.rock;
                summitSamples++;
                summitNonFaceMass += rock[0] + rock[1] + rock[4] + rock[5];
                const winner = rock.indexOf(Math.max(...rock));
                if (winner === 0 || winner === 1 || winner === 4 || winner === 5) {
                    summitNonFaceWinners++;
                }
            }
        }
    }

    if (invalidSamples) failures.push(`${invalidSamples} sampled terrain ownership results were invalid`);
    if (contractFailures.length) failures.push(...contractFailures.slice(0, 100));
    if (realVerticalViolations) failures.push(
        `${realVerticalViolations}/${realVerticalSamples} sampled faceGate=1 cells violated vertical purity`,
    );
    if (realElevationPurityViolations) failures.push(
        `${realElevationPurityViolations}/${realElevationPuritySamples} sampled elevation>=50 cells violated exact rock purity`,
    );
    if (realGradePurityViolations) failures.push(
        `${realGradePurityViolations}/${realGradePuritySamples} sampled grade>=0.80 cells violated exact face purity`,
    );
    const organicBoundaries = summarizeOrganicBoundaries(
        organicGroundMembers, organicGroundEligible, familyState.ground.winnerMap,
        columns, rows, step, start,
    );
    if (organicBoundaries.eligibleSamples < 1000
        || organicBoundaries.decisiveInteriorFraction < 0.30
        || organicBoundaries.transitionCells < 500
        || organicBoundaries.orientationSamples < 500) {
        failures.push(
            'Organic-boundary audit lacks decisive interiors or sufficient transitions: '
            + JSON.stringify(organicBoundaries),
        );
    }
    if (organicBoundaries.orientationEntropy12 < 0.72
        || organicBoundaries.fourfoldAxisLock > 0.45) {
        failures.push(
            'Ground material boundaries are excessively axis-aligned: '
            + JSON.stringify(organicBoundaries),
        );
    }
    if (organicBoundaries.phaseLock6m > 0.30
        || organicBoundaries.phaseLock12m > 0.30) {
        failures.push(
            'Ground material crossings are phase-locked to the rejected 6/12 m grid: '
            + JSON.stringify(organicBoundaries),
        );
    }
    if (talusGateZeroViolations) failures.push(
        `${talusGateZeroViolations} samples had RocksGround02 mass while talusGate was zero`,
    );
    if (lowFlatSamples < 32) failures.push(
        `Only ${lowFlatSamples} exact low-flat non-wash samples were available; need at least 32`,
    );
    if (lowFlatTalusViolations) failures.push(
        `${lowFlatTalusViolations} low-flat samples admitted RocksGround02`,
    );
    if (eligibleTalusSamples < 32) failures.push(
        `Only ${eligibleTalusSamples} eligible talus samples were available; need at least 32`,
    );
    if (eligibleTalusWinners === 0 || eligibleTalusMass <= 0) failures.push(
        'RocksGround02 never contributes on eligible elevated/slope talus terrain',
    );
    retainedMass5.sort((left, right) => left - right);
    const topKRetainedMass = {
        samples: retainedMass5.length,
        minimum: retainedMass5[0] ?? 0,
        p01: quantile(retainedMass5, 0.01),
        median: quantile(retainedMass5, 0.50),
        mean: retainedMass5.length
            ? retainedMass5.reduce((sum, value) => sum + value, 0) / retainedMass5.length
            : 0,
    };
    if (topKRetainedMass.minimum < 0.70
        || topKRetainedMass.p01 < 0.99
        || topKRetainedMass.mean < 0.999) failures.push(
        'Five dynamic layers discard too much ownership beyond a vanishing junction: '
        + JSON.stringify(topKRetainedMass),
    );

    const familyReports = {};
    for (const [name, state] of Object.entries(familyState)) {
        const limits = FAMILY_LIMITS[name];
        if (state.maximumActive > FAMILY_MAX_SIGNIFICANT_CHILDREN + 1
            || state.tooManyActive / count > 0.0001) failures.push(
            `${name}: ${state.tooManyActive} samples exceeded `
            + `${FAMILY_MAX_SIGNIFICANT_CHILDREN} significant children `
            + `(maximum ${state.maximumActive}, threshold ${ACTIVE_EPSILON})`,
        );
        if (!state.eligible) failures.push(`${name}: no samples reached family eligibility`);
        const layers = {};
        for (let local = 0; local < state.layers.length; local++) {
            const layer = state.layers[local];
            const winnerFraction = state.eligible ? state.winners[local] / state.eligible : 0;
            const corePerWinner = state.winners[local]
                ? state.cores[local] / state.winners[local] : 0;
            const thickness = interiorThickness(
                state.winnerMap, columns, rows, local, step,
            );
            layers[LAYER_NAMES[layer]] = { layer, winnerFraction, corePerWinner, ...thickness };
            if (winnerFraction < limits.winner) failures.push(
                `${name}/${LAYER_NAMES[layer]} winner fraction ${winnerFraction.toFixed(4)} `
                + `is below ${limits.winner}`,
            );
            if (corePerWinner < limits.corePerWinner) failures.push(
                `${name}/${LAYER_NAMES[layer]} core/winner ${corePerWinner.toFixed(4)} `
                + `is below ${limits.corePerWinner}`,
            );
            if (thickness.eroded2mRatio < limits.eroded2m) failures.push(
                `${name}/${LAYER_NAMES[layer]} 2 m erosion survival `
                + `${thickness.eroded2mRatio.toFixed(4)} is below ${limits.eroded2m}`,
            );
            if (thickness.p90InteriorM < limits.p90InteriorM) failures.push(
                `${name}/${LAYER_NAMES[layer]} p90 interior thickness `
                + `${thickness.p90InteriorM.toFixed(2)} m is below ${limits.p90InteriorM} m`,
            );
        }
        familyReports[name] = {
            eligibleSamples: state.eligible,
            significantChildThreshold: ACTIVE_EPSILON,
            maximumAllowedSignificantChildren: FAMILY_MAX_SIGNIFICANT_CHILDREN,
            maximumActiveChildren: state.maximumActive,
            samplesAboveFourActive: state.tooManyActive,
            layers,
        };
    }

    const summit = {
        samples: summitSamples,
        meanNonFaceRockMass: summitSamples ? summitNonFaceMass / summitSamples : 0,
        nonFaceRockWinnerFraction: summitSamples ? summitNonFaceWinners / summitSamples : 0,
    };
    if (summitSamples < 32) failures.push(
        `Only ${summitSamples} sampled high-flat rock cells were available; need at least 32`,
    );
    if (summit.meanNonFaceRockMass < 0.75) failures.push(
        `Sampled summit non-face rock mass ${summit.meanNonFaceRockMass.toFixed(4)} is below 0.75`,
    );
    if (summit.nonFaceRockWinnerFraction < 0.75) failures.push(
        `Sampled summit non-face rock winner fraction `
        + `${summit.nonFaceRockWinnerFraction.toFixed(4)} is below 0.75`,
    );

    const synthetic = syntheticGateAudit(api, brush);
    failures.push(...synthetic.failures);
    const calibration = calibrationSamples
        ? evaluateCalibrationVariants(calibrationSamples, columns, rows, step) : undefined;
    const report = {
        pass: failures.length === 0,
        source: { file: path.relative(ROOT, TERRAIN_FILE), sha256: sha256(TERRAIN_FILE) },
        authoredBrush: { file: path.relative(ROOT, BRUSH_FILE), sha256: sha256(BRUSH_FILE) },
        sampling: {
            spacingMeters: step,
            bounds: [-api.HALF_NEAR, api.HALF_NEAR],
            columns, rows, samples: count,
            gradeFiniteDifferenceMeters: 0.8,
        },
        verticalPurity: { sampledGateOneCells: realVerticalSamples, violations: realVerticalViolations },
        elevationPurity: {
            sampledElevationAtLeast50Cells: realElevationPuritySamples,
            violations: realElevationPurityViolations,
        },
        gradePurity: {
            sampledGradeAtLeast080Cells: realGradePuritySamples,
            violations: realGradePurityViolations,
        },
        talusRole: {
            layer: 13,
            lowFlatSamples,
            lowFlatViolations: lowFlatTalusViolations,
            lowFlatMaximumMass: lowFlatMaximumTalusMass,
            gateZeroViolations: talusGateZeroViolations,
            eligibleSamples: eligibleTalusSamples,
            eligibleWinners: eligibleTalusWinners,
            eligibleMeanMass: eligibleTalusSamples
                ? eligibleTalusMass / eligibleTalusSamples : 0,
        },
        topKRetainedMass,
        organicBoundaries,
        staticCpuTslParity: { ...staticParity, failures: undefined },
        surfaceOrganicPolicy: {
            ...api.SURFACE_ORGANIC_POLICY,
            relativeGapCrossfade: api.SURFACE_ORGANIC_POLICY.familyCrossfade,
            squareCellLattice: false,
            additionalAttributeBytesPerVertex: 0,
            fragmentBrushSamples: 7,
        },
        summit,
        syntheticGateContract: { ...synthetic, failures: undefined },
        families: familyReports,
        calibration,
        failureCount: failures.length,
        failures,
    };
    console.log(JSON.stringify(report, null, 2));
    if (failures.length) process.exitCode = 1;
}

try {
    main();
} catch (error) {
    console.error(`Terrain ownership audit failed to run: ${error.stack ?? error}`);
    process.exitCode = 1;
}
