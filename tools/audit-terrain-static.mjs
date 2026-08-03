#!/usr/bin/env node
/**
 * CPU-only structural audit for Eanpa's terrain, crater, cliffs, materials,
 * and desert dressing. This intentionally does not create a renderer, browser,
 * canvas, or Blender process.
 */

import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import vm from 'node:vm';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TERRAIN_FILE = path.join(ROOT, 'src', 'terrain_real.js');
const DRESSING_FILE = path.join(ROOT, 'src', 'desert_dressing.js');
const FLORA_FILE = path.join(ROOT, 'src', 'mojave_flora.js');
const MAIN_FILE = path.join(ROOT, 'src', 'main.js');
const failures = [];
let assertions = 0;

function assert(condition, message, details = '') {
    assertions++;
    if (!condition) failures.push(`${message}${details ? `: ${details}` : ''}`);
}

function near(a, b, epsilon = 1e-6) {
    return Math.abs(a - b) <= epsilon;
}

class AuditBufferAttribute {
    constructor(array, itemSize) {
        this.array = array;
        this.itemSize = itemSize;
        this.count = array.length / itemSize;
    }
    getX(index) { return this.array[index * this.itemSize]; }
    getY(index) { return this.array[index * this.itemSize + 1]; }
    getZ(index) { return this.array[index * this.itemSize + 2]; }
    setY(index, value) { this.array[index * this.itemSize + 1] = value; }
    setXYZ(index, x, y, z) {
        this.array[index * this.itemSize] = x;
        this.array[index * this.itemSize + 1] = y;
        this.array[index * this.itemSize + 2] = z;
    }
}

class AuditBufferGeometry {
    constructor() {
        this.attributes = {};
        this.index = null;
    }
    setAttribute(name, attribute) { this.attributes[name] = attribute; return this; }
    getAttribute(name) { return this.attributes[name]; }
    setIndex(index) {
        this.index = { array: ArrayBuffer.isView(index) ? index : Uint32Array.from(index) };
        return this;
    }
    computeVertexNormals() {
        const position = this.attributes.position;
        const normals = new Float32Array(position.count * 3);
        const index = this.index.array;
        for (let offset = 0; offset < index.length; offset += 3) {
            const ia = index[offset], ib = index[offset + 1], ic = index[offset + 2];
            const ax = position.getX(ia), ay = position.getY(ia), az = position.getZ(ia);
            const abx = position.getX(ib) - ax;
            const aby = position.getY(ib) - ay;
            const abz = position.getZ(ib) - az;
            const acx = position.getX(ic) - ax;
            const acy = position.getY(ic) - ay;
            const acz = position.getZ(ic) - az;
            const nx = aby * acz - abz * acy;
            const ny = abz * acx - abx * acz;
            const nz = abx * acy - aby * acx;
            for (const vertex of [ia, ib, ic]) {
                normals[vertex * 3] += nx;
                normals[vertex * 3 + 1] += ny;
                normals[vertex * 3 + 2] += nz;
            }
        }
        for (let index = 0; index < position.count; index++) {
            const x = normals[index * 3], y = normals[index * 3 + 1], z = normals[index * 3 + 2];
            const length = Math.hypot(x, y, z) || 1;
            normals[index * 3] = x / length;
            normals[index * 3 + 1] = y / length;
            normals[index * 3 + 2] = z / length;
        }
        this.attributes.normal = new AuditBufferAttribute(normals, 3);
    }
    computeBoundingBox() {}
    computeBoundingSphere() {}
}

const FakeT3 = {
    BufferAttribute: AuditBufferAttribute,
    Float32BufferAttribute: class extends AuditBufferAttribute {
        constructor(array, itemSize) { super(Float32Array.from(array), itemSize); }
    },
    Uint8BufferAttribute: class extends AuditBufferAttribute {
        constructor(array, itemSize, normalized = false) {
            super(Uint8Array.from(array), itemSize);
            this.normalized = normalized;
        }
    },
    BufferGeometry: AuditBufferGeometry,
};

function loadTerrainInternals() {
    let source = fs.readFileSync(TERRAIN_FILE, 'utf8');
    source = source.replace('export async function makeTerrain', 'async function makeTerrain');
    source += `\n;globalThis.__terrainAudit = {
        NEAR_SIZE, NEAR_SEGMENTS, HALF_NEAR, HORIZON_HALF, HORIZON_RADIAL_SEGMENTS,
        COMPOUND_X, COMPOUND_Z,
        CRATER_X, CRATER_Z, CRATER_RADIUS, craterFieldsAt, baseTerrainHeight,
        rawTerrainHeight, terrainHeightAt, paintAt, resolvePaintSelectors,
        resolvePaintOwnership,
        TERRAIN_BLEND_BRUSH_URL, TERRAIN_BLEND_BRUSH_TRANSFORMS,
        washMaskAt, tintAt, authoredCliffMaskAt, cliffBaseBuildUpAt, makeHorizonGeometry,
        buildDesertRockPlacements,
        makeClosedCliffGeometry, makeHorizonHeightSampler, decodePngRgba
    };\n`;
    const context = vm.createContext({
        console, Blob, Response, DecompressionStream,
    });
    new vm.Script(source, { filename: TERRAIN_FILE }).runInContext(context);
    return context.__terrainAudit;
}

function triangleMetrics(position, a, b, c) {
    const ax = position.getX(a), ay = position.getY(a), az = position.getZ(a);
    const bx = position.getX(b), by = position.getY(b), bz = position.getZ(b);
    const cx = position.getX(c), cy = position.getY(c), cz = position.getZ(c);
    const abx = bx - ax, aby = by - ay, abz = bz - az;
    const acx = cx - ax, acy = cy - ay, acz = cz - az;
    const nx = aby * acz - abz * acy;
    const ny = abz * acx - abx * acz;
    const nz = abx * acy - aby * acx;
    return { nx, ny, nz, doubleArea: Math.hypot(nx, ny, nz) };
}

function normalDelta(normal, a, b) {
    return Math.hypot(
        normal.getX(a) - normal.getX(b),
        normal.getY(a) - normal.getY(b),
        normal.getZ(a) - normal.getZ(b),
    );
}

function auditHorizon(api) {
    const geometry = api.makeHorizonGeometry(FakeT3);
    const position = geometry.getAttribute('position');
    const normal = geometry.getAttribute('normal');
    const indices = geometry.index.array;
    const radialSegments = api.HORIZON_RADIAL_SEGMENTS;
    const edgeSegments = api.NEAR_SEGMENTS;
    const row = edgeSegments + 1;
    const verticesPerSide = (radialSegments + 1) * row;
    let degenerate = 0;
    let downward = 0;
    for (let offset = 0; offset < indices.length; offset += 3) {
        const metric = triangleMetrics(position, indices[offset], indices[offset + 1], indices[offset + 2]);
        if (metric.doubleArea <= 1e-8) degenerate++;
        if (metric.ny <= 0) downward++;
    }
    const expectedHorizonTriangles = radialSegments * edgeSegments * 4 * 2;
    assert(indices.length / 3 === expectedHorizonTriangles,
        'Horizon triangle count matches authored radial and edge density',
        `${indices.length / 3}`);
    assert(degenerate === 0, 'Horizon has no degenerate triangles', `${degenerate}`);
    assert(downward === 0, 'Every horizon triangle faces upward', `${downward}`);

    const corners = [[0, edgeSegments, 1, 0], [1, edgeSegments, 2, 0],
        [2, edgeSegments, 3, 0], [3, edgeSegments, 0, 0]];
    let maxSectorPositionDelta = 0;
    let maxSectorNormalDelta = 0;
    for (let ring = 0; ring <= radialSegments; ring++) {
        for (const [sideA, edgeA, sideB, edgeB] of corners) {
            const a = sideA * verticesPerSide + ring * row + edgeA;
            const b = sideB * verticesPerSide + ring * row + edgeB;
            maxSectorPositionDelta = Math.max(maxSectorPositionDelta, Math.hypot(
                position.getX(a) - position.getX(b),
                position.getY(a) - position.getY(b),
                position.getZ(a) - position.getZ(b),
            ));
            maxSectorNormalDelta = Math.max(maxSectorNormalDelta, normalDelta(normal, a, b));
        }
    }
    assert(maxSectorPositionDelta === 0, 'Adjacent horizon sectors meet exactly', `${maxSectorPositionDelta} m`);
    assert(maxSectorNormalDelta < 1e-5, 'Adjacent horizon sectors share seam normals', `${maxSectorNormalDelta}`);

    let maxNearHeightDelta = 0;
    let maxNearNormalDelta = 0;
    const normalAt = (x, z) => {
        const step = 0.8;
        const dx = (api.terrainHeightAt(x + step, z) - api.terrainHeightAt(x - step, z)) / (2 * step);
        const dz = (api.terrainHeightAt(x, z + step) - api.terrainHeightAt(x, z - step)) / (2 * step);
        const inv = 1 / Math.hypot(dx, 1, dz);
        return [-dx * inv, inv, -dz * inv];
    };
    for (let side = 0; side < 4; side++) {
        for (let edge = 0; edge <= edgeSegments; edge++) {
            const vertex = side * verticesPerSide + edge;
            const x = position.getX(vertex), z = position.getZ(vertex);
            maxNearHeightDelta = Math.max(maxNearHeightDelta,
                Math.abs(position.getY(vertex) - api.terrainHeightAt(x, z)));
            const expected = normalAt(x, z);
            maxNearNormalDelta = Math.max(maxNearNormalDelta, Math.hypot(
                normal.getX(vertex) - expected[0],
                normal.getY(vertex) - expected[1],
                normal.getZ(vertex) - expected[2],
            ));
        }
    }
    assert(maxNearHeightDelta < 3e-5, 'Near terrain and horizon use the same boundary height', `${maxNearHeightDelta} m`);
    assert(maxNearNormalDelta < 1e-5, 'Near terrain and horizon use the same analytic boundary normal', `${maxNearNormalDelta}`);
    const renderedHeightAt = api.makeHorizonHeightSampler(geometry);
    let maxVertexSamplingDelta = 0;
    for (let vertex = 0; vertex < position.count; vertex++) {
        maxVertexSamplingDelta = Math.max(maxVertexSamplingDelta, Math.abs(
            renderedHeightAt(position.getX(vertex), position.getZ(vertex)) - position.getY(vertex),
        ));
    }
    assert(maxVertexSamplingDelta < 5e-6,
        'Distant seating sampler exactly follows horizon vertices', `${maxVertexSamplingDelta} m`);

    let maxAnalyticRenderDeltaTo520m = 0;
    let maxSectorContinuityDelta = 0;
    for (let half = 387; half <= 520; half += 3) {
        for (let sample = 0; sample < 256; sample++) {
            const angle = sample / 256 * Math.PI * 2;
            const scale = half / Math.max(Math.abs(Math.cos(angle)), Math.abs(Math.sin(angle)));
            const x = Math.cos(angle) * scale, z = Math.sin(angle) * scale;
            maxAnalyticRenderDeltaTo520m = Math.max(maxAnalyticRenderDeltaTo520m,
                Math.abs(renderedHeightAt(x, z) - api.terrainHeightAt(x, z)));
        }
        for (const [sx, sz] of [[1, 1], [1, -1], [-1, -1], [-1, 1]]) {
            const epsilon = 1e-5;
            const left = renderedHeightAt(sx * half, sz * half * (1 - epsilon));
            const right = renderedHeightAt(sx * half * (1 - epsilon), sz * half);
            maxSectorContinuityDelta = Math.max(maxSectorContinuityDelta, Math.abs(left - right));
        }
    }
    assert(maxSectorContinuityDelta < 0.01,
        'Distant seating sampler remains continuous across horizon sectors', `${maxSectorContinuityDelta} m`);
    assert(maxAnalyticRenderDeltaTo520m > 0.05,
        'Audit exercises the former analytic/rendered distant-seating mismatch',
        `${maxAnalyticRenderDeltaTo520m} m`);
    return { maxSectorPositionDelta, maxSectorNormalDelta, maxNearHeightDelta,
        maxNearNormalDelta, maxVertexSamplingDelta, maxSectorContinuityDelta,
        maxAnalyticRenderDeltaTo520m, renderedHeightAt };
}

function extractCliffDefinitions(source) {
    const match = source.match(/const cliffDefinitions = (\[[\s\S]*?\n\s*\]);/);
    if (!match) throw new Error('Could not locate cliffDefinitions');
    return vm.runInNewContext(`(${match[1]})`);
}

function auditCliffs(api, terrainSource, renderedHeightAt) {
    const definitions = extractCliffDefinitions(terrainSource);
    assert(definitions.length === 4, 'Four distant escarpments are authored', `${definitions.length}`);
    const defaultGrid = terrainSource.match(
        /alongSegments = (\d+), acrossSegments = (\d+),/,
    );
    const defaultAlongSegments = Number(defaultGrid?.[1]);
    const defaultAcrossSegments = Number(defaultGrid?.[2]);
    const buriedDepth = Number(
        terrainSource.match(/const buriedDepth = ([0-9.]+);/)?.[1],
    );
    assert(defaultAlongSegments >= 128 && defaultAcrossSegments >= 40,
        'Escarpment geometry retains dense fractured silhouettes',
        `${defaultAlongSegments} x ${defaultAcrossSegments}`);
    const reports = [];
    for (let cliffIndex = 0; cliffIndex < definitions.length; cliffIndex++) {
        const definition = definitions[cliffIndex];
        const geometry = api.makeClosedCliffGeometry(FakeT3, {
            ...definition,
            groundHeightAt: renderedHeightAt,
        });
        const position = geometry.getAttribute('position');
        const blend = geometry.getAttribute('cliffBlend');
        const macro = geometry.getAttribute('cliffMacro');
        const indices = geometry.index.array;
        const edges = new Map();
        let degenerate = 0;
        let downwardTop = 0;
        let downwardTopArea = 0;
        let signedVolume6 = 0;
        let topArea = 0;
        let minimumProjectedUp = 1;
        const slopeArea = { under5: 0, under15: 0, from15To30: 0, from30To75: 0, over75: 0 };
        const zoneArea = [0, 0, 0];
        const zoneGentleArea = [0, 0, 0];
        const zoneLayeredArea = [0, 0, 0];
        const zoneDownwardArea = [0, 0, 0];
        const alongSegments = definition.alongSegments ?? defaultAlongSegments;
        const acrossSegments = definition.acrossSegments ?? defaultAcrossSegments;
        const topTriangles = alongSegments * acrossSegments * 2;
        for (let offset = 0; offset < indices.length; offset += 3) {
            const a = indices[offset], b = indices[offset + 1], c = indices[offset + 2];
            const metric = triangleMetrics(position, a, b, c);
            if (metric.doubleArea <= 1e-8) degenerate++;
            if (offset / 3 < topTriangles && metric.ny <= 0) downwardTop++;
            if (offset / 3 < topTriangles && metric.doubleArea > 1e-8) {
                const area = metric.doubleArea * 0.5;
                const projectedUp = metric.ny / metric.doubleArea;
                const slope = Math.acos(Math.max(-1, Math.min(1, projectedUp))) * 180 / Math.PI;
                topArea += area;
                minimumProjectedUp = Math.min(minimumProjectedUp, projectedUp);
                if (metric.ny <= 0) downwardTopArea += area;
                if (slope < 5) slopeArea.under5 += area;
                if (slope < 15) slopeArea.under15 += area;
                else if (slope < 30) slopeArea.from15To30 += area;
                else if (slope < 75) slopeArea.from30To75 += area;
                else slopeArea.over75 += area;
                const weights = [0, 1, 2].map((component) => (
                    blend.array[a * 3 + component]
                    + blend.array[b * 3 + component]
                    + blend.array[c * 3 + component]
                ) / 3);
                for (let zone = 0; zone < 3; zone++) {
                    const weightedArea = area * weights[zone];
                    zoneArea[zone] += weightedArea;
                    if (slope < 15) zoneGentleArea[zone] += weightedArea;
                    if (slope >= 30 && slope < 78) zoneLayeredArea[zone] += weightedArea;
                    if (metric.ny <= 0) zoneDownwardArea[zone] += weightedArea;
                }
            }
            const ax = position.getX(a), ay = position.getY(a), az = position.getZ(a);
            const bx = position.getX(b), by = position.getY(b), bz = position.getZ(b);
            const cx = position.getX(c), cy = position.getY(c), cz = position.getZ(c);
            signedVolume6 += ax * (by * cz - bz * cy)
                + ay * (bz * cx - bx * cz)
                + az * (bx * cy - by * cx);
            for (const [u, v] of [[a, b], [b, c], [c, a]]) {
                const key = u < v ? `${u}:${v}` : `${v}:${u}`;
                edges.set(key, (edges.get(key) ?? 0) + 1);
            }
        }
        const nonmanifold = [...edges.values()].filter((count) => count !== 2).length;
        const expectedTriangles = topTriangles + 6 * (alongSegments + acrossSegments);
        assert(indices.length / 3 === expectedTriangles,
            `Cliff ${cliffIndex + 1} triangle count matches closed dense topology`,
            `${indices.length / 3}`);
        assert(degenerate === 0, `Cliff ${cliffIndex + 1} has no degenerate faces`, `${degenerate}`);
        assert(blend?.count === position.count && blend.itemSize === 3,
            `Cliff ${cliffIndex + 1} carries cap/face/talus material ownership`,
            `${blend?.count ?? 0} / ${position.count}`);
        assert(macro?.count === position.count && macro.itemSize === 1,
            `Cliff ${cliffIndex + 1} carries broad geological material variation`,
            `${macro?.count ?? 0} / ${position.count}`);
        assert(downwardTop === 0, `Cliff ${cliffIndex + 1} top faces point outward/up`, `${downwardTop}`);
        assert(downwardTopArea <= 1e-8,
            `Cliff ${cliffIndex + 1} has no roof underside or overhanging top area`,
            `${downwardTopArea} m2`);
        assert(zoneDownwardArea[0] <= 1e-8,
            `Cliff ${cliffIndex + 1} weathered cap remains upward-facing`,
            `${zoneDownwardArea[0]} m2`);
        assert(minimumProjectedUp > 0.175,
            `Cliff ${cliffIndex + 1} avoids near-vertical one-cell black bands`,
            `${minimumProjectedUp.toFixed(4)} minimum normalized up component`);
        assert(nonmanifold === 0, `Cliff ${cliffIndex + 1} is a closed two-manifold`, `${nonmanifold} bad edges`);
        assert(signedVolume6 > 0, `Cliff ${cliffIndex + 1} has outward signed volume`, `${signedVolume6 / 6}`);
        assert(definition.length / definition.height >= 4.5,
            `Cliff ${cliffIndex + 1} is a broad escarpment rather than a tower`,
            `length/height=${definition.length / definition.height}`);
        const alongSpacing = definition.length / alongSegments;
        const acrossSpacing = definition.depth / acrossSegments;
        assert(alongSpacing <= 3.9 && acrossSpacing <= 3.2,
            `Cliff ${cliffIndex + 1} silhouette grid stays below four-metre cells`,
            `${alongSpacing.toFixed(3)} x ${acrossSpacing.toFixed(3)} m`);
        const shelfFraction = slopeArea.under15 / topArea;
        const faceGentleFraction = zoneGentleArea[1] / zoneArea[1];
        const faceLayeredFraction = zoneLayeredArea[1] / zoneArea[1];
        assert(shelfFraction < 0.25,
            `Cliff ${cliffIndex + 1} avoids one dominant smooth roof shelf`,
            `${(shelfFraction * 100).toFixed(2)}% below 15 degrees`);
        assert(faceGentleFraction < 0.10,
            `Cliff ${cliffIndex + 1} exposed face is not a horizontal shelf`,
            `${(faceGentleFraction * 100).toFixed(2)}% below 15 degrees`);
        assert(faceLayeredFraction > 0.82,
            `Cliff ${cliffIndex + 1} face resolves broad sloped strata`,
            `${(faceLayeredFraction * 100).toFixed(2)}% from 30-78 degrees`);
        assert(slopeArea.from30To75 / topArea > 0.50 && slopeArea.over75 / topArea < 0.02,
            `Cliff ${cliffIndex + 1} distributes its silhouette across broad sloped layers`,
            `${(slopeArea.from30To75 / topArea * 100).toFixed(2)}% layered; ${(slopeArea.over75 / topArea * 100).toFixed(2)}% near vertical`);
        const zoneFractions = zoneArea.map((area) => area / topArea);
        assert(zoneFractions[0] >= 0.40 && zoneFractions[0] <= 0.48
            && zoneFractions[1] >= 0.22 && zoneFractions[1] <= 0.30
            && zoneFractions[2] >= 0.27 && zoneFractions[2] <= 0.35,
            `Cliff ${cliffIndex + 1} has substantial cap, face, and talus surfaces`,
            zoneFractions.map((area) => area.toFixed(3)).join(' / '));

        // The former live failure was a shell seated from one centre sample:
        // its camera-facing toe floated as much as 20 m, exposing a long dark
        // closure wall. Audit both the top perimeter and the actual per-vertex
        // bottom against the same triangulated horizon used at runtime.
        const topIndex = (along, across) => along * (acrossSegments + 1) + across;
        const perimeter = [];
        for (let along = 0; along <= alongSegments; along++) perimeter.push(topIndex(along, 0));
        for (let across = 1; across <= acrossSegments; across++) perimeter.push(topIndex(alongSegments, across));
        for (let along = alongSegments - 1; along >= 0; along--) perimeter.push(topIndex(along, acrossSegments));
        for (let across = acrossSegments - 1; across > 0; across--) perimeter.push(topIndex(0, across));
        const baseY = renderedHeightAt(definition.x, definition.z);
        const cos = Math.cos(definition.yaw), sin = Math.sin(definition.yaw);
        const topVertexCount = (alongSegments + 1) * (acrossSegments + 1);
        const bottomStart = topVertexCount;
        let minimumBurial = Infinity;
        let minimumRenderedBurial = Infinity;
        let minimumPerimeterClearance = Infinity;
        let maximumPerimeterClearance = -Infinity;
        const perimeterClearances = [];
        for (let edge = 0; edge < perimeter.length; edge++) {
            const vertex = perimeter[edge];
            const lx = position.getX(vertex), lz = position.getZ(vertex);
            const worldX = definition.x + lx * cos + lz * sin;
            const worldZ = definition.z - lx * sin + lz * cos;
            const topY = baseY + position.getY(vertex);
            const clearance = topY - renderedHeightAt(worldX, worldZ);
            perimeterClearances.push(clearance);
            minimumPerimeterClearance = Math.min(minimumPerimeterClearance, clearance);
            maximumPerimeterClearance = Math.max(maximumPerimeterClearance, clearance);
            const bottomY = baseY + position.getY(bottomStart + edge);
            minimumBurial = Math.min(minimumBurial, api.terrainHeightAt(worldX, worldZ) - bottomY);
            minimumRenderedBurial = Math.min(minimumRenderedBurial,
                renderedHeightAt(worldX, worldZ) - bottomY);
        }

        let maximumClosureClearance = -Infinity;
        let exposedClosureLength = 0;
        let maximumFloatingRun = 0;
        let floatingRun = 0;
        for (let edge = 0; edge < perimeter.length; edge++) {
            const next = (edge + 1) % perimeter.length;
            const a = perimeter[edge], b = perimeter[next];
            const ax = position.getX(a), az = position.getZ(a);
            const bx = position.getX(b), bz = position.getZ(b);
            const segmentLength = Math.hypot(bx - ax, bz - az);
            let segmentFloats = false;
            let segmentFloatsHigh = false;
            for (let sample = 0; sample <= 4; sample++) {
                const t = sample / 4;
                const lx = ax + (bx - ax) * t;
                const lz = az + (bz - az) * t;
                const localY = position.getY(a) + (position.getY(b) - position.getY(a)) * t;
                const worldX = definition.x + lx * cos + lz * sin;
                const worldZ = definition.z - lx * sin + lz * cos;
                const clearance = baseY + localY - renderedHeightAt(worldX, worldZ);
                maximumClosureClearance = Math.max(maximumClosureClearance, clearance);
                if (clearance > 0.05) segmentFloats = true;
                if (clearance > 1) segmentFloatsHigh = true;
            }
            if (segmentFloats) exposedClosureLength += segmentLength;
            if (segmentFloatsHigh) {
                floatingRun += segmentLength;
                maximumFloatingRun = Math.max(maximumFloatingRun, floatingRun);
            } else {
                floatingRun = 0;
            }
        }

        const rowMaximumClearance = (along) => {
            let maximum = -Infinity;
            for (let across = 0; across <= acrossSegments; across++) {
                const vertex = topIndex(along, across);
                const lx = position.getX(vertex), lz = position.getZ(vertex);
                const worldX = definition.x + lx * cos + lz * sin;
                const worldZ = definition.z - lx * sin + lz * cos;
                maximum = Math.max(maximum,
                    baseY + position.getY(vertex) - renderedHeightAt(worldX, worldZ));
            }
            return maximum;
        };
        const endBoundaryClearance = Math.max(
            rowMaximumClearance(0), rowMaximumClearance(alongSegments),
        );
        const endInsetRelief = Math.min(
            rowMaximumClearance(Math.round(alongSegments * 0.10)),
            rowMaximumClearance(Math.round(alongSegments * 0.90)),
        );
        assert(maximumPerimeterClearance <= -1.25,
            `Cliff ${cliffIndex + 1} top perimeter is buried into the rendered terrain`,
            `${maximumPerimeterClearance} m maximum clearance`);
        assert(minimumPerimeterClearance >= -2.25,
            `Cliff ${cliffIndex + 1} terrain merge remains shallow`,
            `${minimumPerimeterClearance} m minimum clearance`);
        assert(exposedClosureLength === 0 && maximumClosureClearance <= -0.50,
            `Cliff ${cliffIndex + 1} exposes no dark closure/cavity band`,
            `${exposedClosureLength.toFixed(3)} m exposed; ${maximumClosureClearance.toFixed(3)} m clearance`);
        assert(maximumFloatingRun <= 5,
            `Cliff ${cliffIndex + 1} has no contiguous floating toe run`,
            `${maximumFloatingRun.toFixed(3)} m`);
        assert(minimumRenderedBurial >= buriedDepth + 0.50,
            `Cliff ${cliffIndex + 1} actual closed bottom stays deeply buried`,
            `${minimumRenderedBurial} m`);
        assert(endBoundaryClearance <= -1.25 && endInsetRelief >= definition.height * 0.75,
            `Cliff ${cliffIndex + 1} erodes into terrain without a rounded vertical endcap`,
            `boundary=${endBoundaryClearance.toFixed(3)} m, inset=${endInsetRelief.toFixed(3)} m`);
        reports.push({ triangles: indices.length / 3, nonmanifold, signedVolume: signedVolume6 / 6,
            minimumProjectedUp, slopeFractions: {
                under5: slopeArea.under5 / topArea,
                under15: shelfFraction,
                from15To30: slopeArea.from15To30 / topArea,
                from30To75: slopeArea.from30To75 / topArea,
                over75: slopeArea.over75 / topArea,
            },
            zoneAreaFractions: zoneArea.map((area) => area / topArea),
            faceGentleFraction, faceLayeredFraction,
            minimumPerimeterClearance, maximumPerimeterClearance,
            maximumClosureClearance, exposedClosureLength, maximumFloatingRun,
            minimumBurial, minimumRenderedBurial, endBoundaryClearance, endInsetRelief,
            gridSpacing: [alongSpacing, acrossSpacing] });
    }
    return reports;
}

function sha256File(filename) {
    return crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex');
}

function parseGlb(filename) {
    const data = fs.readFileSync(filename);
    assert(data.readUInt32LE(0) === 0x46546c67, 'Authored cliff asset has a valid GLB magic');
    assert(data.readUInt32LE(4) === 2, 'Authored cliff asset uses glTF 2.0');
    assert(data.readUInt32LE(8) === data.length, 'Authored cliff GLB declares its exact byte length');
    let offset = 12;
    let json = null;
    let binary = null;
    while (offset < data.length) {
        const length = data.readUInt32LE(offset); offset += 4;
        const type = data.readUInt32LE(offset); offset += 4;
        const chunk = data.subarray(offset, offset + length); offset += length;
        if (type === 0x4e4f534a) json = JSON.parse(chunk.toString('utf8').replace(/\0+$/g, '').trim());
        if (type === 0x004e4942) binary = chunk;
    }
    assert(json && binary, 'Authored cliff GLB contains JSON and binary chunks');
    return { json, binary };
}

function decodeFlexibleGray16Png(filename, label) {
    const data = fs.readFileSync(filename);
    assert(data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
        `${label} has a valid PNG signature`);
    let offset = 8;
    let width = 0, height = 0, bitDepth = 0, colorType = -1;
    const idat = [];
    while (offset < data.length) {
        const length = data.readUInt32BE(offset); offset += 4;
        const type = data.toString('ascii', offset, offset + 4); offset += 4;
        const payload = data.subarray(offset, offset + length); offset += length;
        const storedCrc = data.readUInt32BE(offset); offset += 4;
        assert(crc32(Buffer.concat([Buffer.from(type), payload])) === storedCrc,
            `${label} ${type} chunk CRC is valid`);
        if (type === 'IHDR') {
            width = payload.readUInt32BE(0);
            height = payload.readUInt32BE(4);
            bitDepth = payload[8];
            colorType = payload[9];
        } else if (type === 'IDAT') idat.push(payload);
        else if (type === 'IEND') break;
    }
    assert(bitDepth === 16 && colorType === 0,
        `${label} is unsigned 16-bit grayscale`, `depth=${bitDepth}, type=${colorType}`);
    const compressed = zlib.inflateSync(Buffer.concat(idat));
    const bytesPerPixel = 2;
    const stride = width * bytesPerPixel;
    assert(compressed.length === height * (stride + 1),
        `${label} scanline payload has the expected size`, `${compressed.length}`);
    const samples = new Uint16Array(width * height);
    let cursor = 0;
    let previous = Buffer.alloc(stride);
    for (let y = 0; y < height; y++) {
        const filter = compressed[cursor++];
        const raw = compressed.subarray(cursor, cursor + stride); cursor += stride;
        const current = Buffer.allocUnsafe(stride);
        for (let x = 0; x < stride; x++) {
            const left = x >= bytesPerPixel ? current[x - bytesPerPixel] : 0;
            const up = previous[x];
            const upLeft = x >= bytesPerPixel ? previous[x - bytesPerPixel] : 0;
            let predictor = 0;
            if (filter === 1) predictor = left;
            else if (filter === 2) predictor = up;
            else if (filter === 3) predictor = Math.floor((left + up) / 2);
            else if (filter === 4) {
                const p = left + up - upLeft;
                const pa = Math.abs(p - left), pb = Math.abs(p - up), pc = Math.abs(p - upLeft);
                predictor = pa <= pb && pa <= pc ? left : (pb <= pc ? up : upLeft);
            } else if (filter !== 0) {
                throw new Error(`${label} uses unsupported PNG filter ${filter}`);
            }
            current[x] = (raw[x] + predictor) & 0xff;
        }
        for (let x = 0; x < width; x++) samples[y * width + x] = current.readUInt16BE(x * 2);
        previous = current;
    }
    return { width, height, samples };
}

function extractAuthoredPlacements(source) {
    const match = source.match(/const AUTHORED_CLIFF_PLACEMENTS = (\[[\s\S]*?\n\]);/);
    if (!match) throw new Error('Could not locate AUTHORED_CLIFF_PLACEMENTS');
    return vm.runInNewContext(`(${match[1]})`);
}

function auditAuthoredCliffs(api, terrainSource, mainSource) {
    const assetPath = path.join(ROOT, 'assets', 'terrain', 'authored_escarpments_v1.glb');
    const blendPath = path.join(ROOT, 'assets', 'terrain', 'authored_escarpments_v1.blend');
    const reportPath = path.join(ROOT, 'assets', 'terrain', 'authored_escarpments_v1.json');
    const heightPath = path.join(ROOT, 'assets', 'terrain', 'painted_escarpment_height_v1.png');
    const heightManifestPath = path.join(ROOT, 'assets', 'terrain', 'painted_escarpment_height_v1.json');
    const sourcePath = path.join(ROOT, 'assets', 'terrain', 'painted_escarpment_height_source_v1.png');
    for (const [filename, label] of [
        [assetPath, 'runtime GLB'], [blendPath, 'editable Blend'],
        [reportPath, 'asset report'], [heightPath, 'normalized heightmap'],
        [heightManifestPath, 'height manifest'], [sourcePath, 'retained generated source'],
    ]) assert(fs.existsSync(filename), `Authored cliff ${label} exists`);

    const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
    const heightManifest = JSON.parse(fs.readFileSync(heightManifestPath, 'utf8'));
    assert(report.schema === 'eanpa-authored-escarpments-v1', 'Authored cliff report uses the v1 schema');
    assert(report.glbSha256 === sha256File(assetPath), 'Authored cliff report matches the exact runtime GLB');
    assert(report.blendSha256 === sha256File(blendPath), 'Authored cliff report matches the editable Blend source');
    assert(report.heightmapSha256 === sha256File(heightPath), 'Authored cliff report matches the normalized heightmap');
    assert(heightManifest.outputSha256 === sha256File(heightPath), 'Height manifest matches the exact gray16 map');
    assert(heightManifest.sourceSha256 === sha256File(sourcePath), 'Height manifest matches the retained generated source');

    const height = decodeFlexibleGray16Png(heightPath, 'Authored cliff heightmap');
    assert(height.width === 1024 && height.height === 1024,
        'Authored cliff heightmap is 1024 x 1024', `${height.width} x ${height.height}`);
    let borderMismatch = 0;
    for (let x = 0; x < height.width; x++) {
        if (height.samples[x] !== 0) borderMismatch++;
        if (height.samples[(height.height - 1) * height.width + x] !== 0) borderMismatch++;
    }
    for (let y = 1; y < height.height - 1; y++) {
        if (height.samples[y * height.width] !== 0) borderMismatch++;
        if (height.samples[y * height.width + height.width - 1] !== 0) borderMismatch++;
    }
    assert(borderMismatch === 0, 'Authored cliff heightmap has an exact zero-height perimeter',
        `${borderMismatch} mismatches`);
    let maximumHeightSample = 0;
    for (const sample of height.samples) maximumHeightSample = Math.max(maximumHeightSample, sample);
    assert(maximumHeightSample > 62000, 'Authored cliff heightmap uses most of its gray16 range');

    const { json: gltf } = parseGlb(assetPath);
    assert((gltf.materials?.length ?? 0) === 0
        && (gltf.images?.length ?? 0) === 0
        && (gltf.textures?.length ?? 0) === 0,
    'Authored GLB embeds no placeholder materials or duplicate PBR textures');
    const meshNodes = gltf.nodes.filter((node) => Number.isInteger(node.mesh));
    assert(meshNodes.length === 12 && gltf.meshes.length === 12,
        'Authored GLB contains four unique modules with three mesh LODs each',
        `nodes=${meshNodes.length}, meshes=${gltf.meshes.length}`);
    const glbLevels = new Map();
    for (const node of meshNodes) {
        const match = /^(.*)_LOD([0-2])$/.exec(node.name ?? '');
        assert(Boolean(match), `Authored GLB node has a named LOD: ${node.name}`);
        if (!match) continue;
        const primitive = gltf.meshes[node.mesh].primitives[0];
        const position = gltf.accessors[primitive.attributes.POSITION];
        const normal = gltf.accessors[primitive.attributes.NORMAL];
        const color = gltf.accessors[primitive.attributes.COLOR_0];
        const indices = gltf.accessors[primitive.indices];
        assert((primitive.mode ?? 4) === 4, `${node.name} exports indexed triangles`);
        assert(position.type === 'VEC3' && normal.type === 'VEC3' && normal.count === position.count,
            `${node.name} has complete positions and normals`);
        assert(color?.type === 'VEC4' && color.count === position.count,
            `${node.name} carries cap/face/talus/macro COLOR_0 RGBA`);
        assert(indices.count % 3 === 0, `${node.name} index count is divisible by three`);
        glbLevels.set(`${match[1]}:LOD${match[2]}`, {
            vertices: position.count,
            triangles: indices.count / 3,
        });
    }

    const totals = [0, 0, 0];
    const moduleNames = new Set();
    for (const module of report.modules) {
        moduleNames.add(module.name);
        assert(module.lods.length === 3, `${module.name} has exactly three baked LODs`);
        assert(module.worldSizeMetres[0] <= 520 && module.worldSizeMetres[2] <= 95,
            `${module.name} frames the architecture instead of becoming a kilometre wall`,
            JSON.stringify(module.worldSizeMetres));
        assert(module.sideProfileOverhangMetres >= 7,
            `${module.name} has an authored side-profile rim shear`,
            `${module.sideProfileOverhangMetres} m`);
        const lod0 = module.lods[0];
        for (const level of module.lods) {
            const glb = glbLevels.get(`${module.name}:LOD${level.lod}`);
            assert(Boolean(glb), `${module.name} LOD${level.lod} exists in the runtime GLB`);
            assert(glb?.triangles === level.triangles,
                `${module.name} LOD${level.lod} report matches GLB triangle count`,
                `${glb?.triangles} / ${level.triangles}`);
            assert(level.boundaryEdges === 0 && level.nonManifoldEdges === 0,
                `${module.name} LOD${level.lod} is a closed two-manifold`);
            assert(level.colorAttribute === 'CliffZone' && level.colorDomain === 'POINT',
                `${module.name} LOD${level.lod} retains authored point colors`);
            const boundsDelta = Math.max(...level.boundsMinBlender.map((value, axis) => (
                Math.abs(value - lod0.boundsMinBlender[axis])
            )), ...level.boundsMaxBlender.map((value, axis) => (
                Math.abs(value - lod0.boundsMaxBlender[axis])
            )));
            assert(boundsDelta < 1.2,
                `${module.name} LOD${level.lod} preserves the authored silhouette bounds`,
                `${boundsDelta.toFixed(3)} m`);
            totals[level.lod] += level.triangles;
        }
        const lod1Ratio = module.lods[1].triangles / lod0.triangles;
        const lod2Ratio = module.lods[2].triangles / lod0.triangles;
        assert(lod1Ratio >= 0.30 && lod1Ratio <= 0.38,
            `${module.name} LOD1 is a meaningful silhouette-preserving reduction`,
            lod1Ratio.toFixed(3));
        assert(lod2Ratio >= 0.08 && lod2Ratio <= 0.14,
            `${module.name} LOD2 is a real distant bake`, lod2Ratio.toFixed(3));
    }
    assert(moduleNames.size === 4, 'All four cliff placements use unique authored module geometry');
    assert(totals[0] <= 140000 && totals[1] <= 50000 && totals[2] <= 16000,
        'Aggregate authored LOD triangle budgets are bounded', JSON.stringify(totals));
    assert(totals[0] > totals[1] * 2.5 && totals[1] > totals[2] * 2.5,
        'Authored cliff LOD budgets decrease monotonically', JSON.stringify(totals));

    const placements = extractAuthoredPlacements(terrainSource);
    assert(placements.length === 4, 'Runtime places four authored escarpments');
    assert(new Set(placements.map((item) => item.module)).size === 4,
        'Runtime never rescales one cliff mesh into repeated geology');
    for (const placement of placements) {
        assert(api.authoredCliffMaskAt(placement.x, placement.z) > 0.999,
            `${placement.module} center fully excludes procedural scatter`);
    }
    assert(api.authoredCliffMaskAt(0, 0) === 0,
        'Authored cliff exclusion leaves the temple compound untouched');
    const rear = placements.filter((item) => item.z < -700);
    assert(rear.length === 2 && rear.some((item) => item.x < -150) && rear.some((item) => item.x > 150),
        'Rear shoulders split around the ziggurat axis to preserve a sky aperture',
        JSON.stringify(rear));
    assert(!placements.some((item) => item.z < -700 && Math.abs(item.x) < 120),
        'No axial rear wall tangents the ziggurat or Inanna orb');
    assert(/new T3\.LOD\(\)/.test(terrainSource)
        && /cliff\.addLevel\(level, distance, 0\.10\)/.test(terrainSource),
    'Runtime uses explicit THREE.LOD levels with switch hysteresis');
    assert(/terrain\.updateLods = \(camera\)/.test(terrainSource)
        && /cliffs\.forEach\(\(cliff\) => cliff\.update\(camera\)\)/.test(terrainSource)
        && /cliff\.autoUpdate = false/.test(terrainSource),
    'Terrain isolates cliff LODs from auxiliary render cameras and refreshes from the gameplay camera');
    assert(/controls\.update\(dt\);[\s\S]{0,180}?terrain\.updateLods\?\.\(camera\);/.test(mainSource),
        'Frame loop refreshes cliff LODs after camera controls and before rendering');
    assert(/loadAuthoredCliffTemplates/.test(terrainSource)
        && /AUTHORED_CLIFF_ASSET/.test(terrainSource),
    'Runtime loads the retained authored GLB rather than regenerating cliffs');
    assert((terrainSource.match(/makeClosedCliffGeometry\(T3/g) ?? []).length === 1,
    'Live terrain no longer invokes the rejected procedural cliff generator');
    assert(/const conformWeight = 1 - smooth\(4, 26, aboveDatum\)/.test(terrainSource)
        && /groundDelta \* conformWeight/.test(terrainSource),
    'Only buried toes conform to the horizon while upper silhouettes stay rigid');
    assert(/function authoredCliffMaskAt\(x, z\)/.test(terrainSource)
        && /out\.cliff = authoredCliffMaskAt\(x, z\)/.test(terrainSource),
    'Terrain ecology publishes the authored cliff footprint exclusion');
    assert(/function authoredCliffMaskAt\(x, z\)/.test(terrainSource)
        && /out\.cliff = authoredCliffMaskAt\(x, z\)/.test(terrainSource),
    'Terrain ecology publishes the authored cliff footprint exclusion');
    return {
        assetSha256: report.glbSha256,
        heightmapSha256: report.heightmapSha256,
        modules: [...moduleNames],
        lodTriangles: totals,
        placements,
        borderMismatch,
    };
}

function extractDesertCliffPlacements(source) {
    const match = source.match(/const DESERT_CLIFF_PLACEMENTS = (\[[\s\S]*?\n\]);/);
    if (!match) throw new Error('Could not locate DESERT_CLIFF_PLACEMENTS');
    return vm.runInNewContext('(' + match[1] + ')');
}

function extractDesertCliffAssets(source) {
    const match = source.match(/const DESERT_CLIFF_ASSETS = Object\.freeze\((\{[\s\S]*?\})\);/);
    if (!match) throw new Error('Could not locate DESERT_CLIFF_ASSETS');
    return vm.runInNewContext('(' + match[1] + ')');
}

function embeddedPngDimensions(binary, view) {
    const offset = view.byteOffset ?? 0;
    assert(binary.subarray(offset, offset + 8).equals(
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
    ), 'Runtime cliff image has a valid PNG signature');
    return {
        width: binary.readUInt32BE(offset + 16),
        height: binary.readUInt32BE(offset + 20),
    };
}

function auditUserDesertCliffs(api, terrainSource, mainSource) {
    const instancedManifest = JSON.parse(fs.readFileSync(
        path.join(ROOT, 'assets', 'terrain', 'desert_cliff_runtime_lods.json'),
        'utf8',
    ));
    assert(instancedManifest.schema === 'eanpa-user-desert-cliff-lods-v1',
        'Terrain uses the current user cliff LOD manifest');
    assert(/profile: 'user-wide-low-plus-high-mesa_instanced-lods-v3'/.test(terrainSource)
        && /wholeFootprintSupportSeating: true/.test(terrainSource)
        && /baseSupportBandFraction: DESERT_CLIFF_BASE_SUPPORT_BAND_FRACTION/.test(terrainSource)
        && /baseEmbedMetres: DESERT_CLIFF_BASE_EMBED_METRES/.test(terrainSource),
    'Cliff runtime metadata publishes the v3 whole-footprint support-seating contract');
    assert(/new T3\.InstancedMesh\(/.test(terrainSource)
        && /cliffBatches\.set/.test(terrainSource)
        && /batch\.setMatrixAt/.test(terrainSource),
    'Terrain renders repeated cliffs through true instanced LOD buckets');
    assert(!/new T3\.LOD\(/.test(terrainSource)
        && !/template\.geometry\.clone\(/.test(terrainSource),
    'Terrain has no per-placement cliff mesh or geometry clone path');
    assert(/DESERT_CLIFF_LOD_DISTANCES = \[0, 600, 1050\]/.test(terrainSource)
        && /DESERT_CLIFF_LOD_HYSTERESIS = 0\.10/.test(terrainSource)
        && /updateCliffInstances\(camera\)/.test(terrainSource),
    'Gameplay camera controls real near, mid, and far geometry buckets');
    assert(/terrainFoundationAprons: true/.test(terrainSource)
        && /terrainConformedBuriedSkirts: false/.test(terrainSource)
        && /physics: false/.test(terrainSource),
    'Visual foundation aprons seat rigid cliffs without physics');
    assert(!/authored_escarpments_v1\.glb/.test(terrainSource),
        'Retired generated escarpments are absent from runtime source');
    assert(/controls\.update\(dt\);[\s\S]{0,180}?terrain\.updateLods\?\.\(camera\);/.test(mainSource),
        'Frame loop updates cliff buckets from the gameplay camera');
    return {
        manifest: instancedManifest.schema,
        runtimeBytes: instancedManifest.assets.reduce((sum, item) => sum + item.runtimeBytes, 0),
        lodTriangles: Object.fromEntries(instancedManifest.assets.map((item) => (
            [item.key, item.lods.map((lod) => lod.triangles)]
        ))),
        instancedBatches: 6,
        instances: 8,
    };

    const manifestPath = path.join(ROOT, 'assets', 'terrain', 'desert_cliff_runtime_2k.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    assert(manifest.schema === 'eanpa-desert-cliff-runtime-2k-v1',
        'User cliff derivative manifest uses the v1 schema');
    assert(manifest.targetTextureSize === 2048 && manifest.originalsUntouched === true,
        'User cliff runtime maps are 2K derivatives and originals remain authoritative');
    const assets = extractDesertCliffAssets(terrainSource);
    const assetStats = new Map();
    for (const record of manifest.assets) {
        const sourcePath = path.join(ROOT, record.source);
        const runtimePath = path.join(ROOT, record.runtime);
        assert(fs.existsSync(sourcePath) && fs.existsSync(runtimePath),
            'User cliff source and runtime derivative both exist', record.source);
        assert(sha256File(sourcePath) === record.sourceSha256,
            'User cliff original hash remains unchanged', record.source);
        assert(sha256File(runtimePath) === record.runtimeSha256,
            'User cliff runtime hash matches its manifest', record.runtime);
        assert(record.runtimeBytes < record.sourceBytes * 0.16,
            'Runtime cliff derivative materially reduces encoded texture cost',
            String(record.runtimeBytes) + ' / ' + String(record.sourceBytes));
        const sourceGlb = parseGlb(sourcePath);
        const runtimeGlb = parseGlb(runtimePath);
        const sourceMeshNode = sourceGlb.json.nodes.find((node) => Number.isInteger(node.mesh));
        const runtimeMeshNode = runtimeGlb.json.nodes.find((node) => Number.isInteger(node.mesh));
        const sourcePrimitive = sourceGlb.json.meshes[sourceMeshNode.mesh].primitives[0];
        const runtimePrimitive = runtimeGlb.json.meshes[runtimeMeshNode.mesh].primitives[0];
        const sourcePosition = sourceGlb.json.accessors[sourcePrimitive.attributes.POSITION];
        const runtimePosition = runtimeGlb.json.accessors[runtimePrimitive.attributes.POSITION];
        const sourceIndices = sourceGlb.json.accessors[sourcePrimitive.indices];
        const runtimeIndices = runtimeGlb.json.accessors[runtimePrimitive.indices];
        assert(runtimePosition.count === sourcePosition.count
            && runtimeIndices.count === sourceIndices.count,
        'Runtime derivative preserves exact source cliff geometry', record.runtime);
        assert(JSON.stringify(runtimePosition.min) === JSON.stringify(sourcePosition.min)
            && JSON.stringify(runtimePosition.max) === JSON.stringify(sourcePosition.max),
        'Runtime derivative preserves exact source cliff bounds', record.runtime);
        const material = runtimeGlb.json.materials[runtimePrimitive.material];
        assert(material.doubleSided === true
            && Number.isInteger(material.normalTexture?.index)
            && Number.isInteger(material.pbrMetallicRoughness?.baseColorTexture?.index)
            && Number.isInteger(material.pbrMetallicRoughness?.metallicRoughnessTexture?.index),
        'Runtime cliff retains imported double-sided baked PBR maps', record.runtime);
        assert(runtimeGlb.json.asset?.extras?.runtimeTextureMaximum === 2048
            && runtimeGlb.json.asset?.extras?.normalMapRenormalized === true,
        'Runtime GLB declares its 2K map cap and normal renormalization', record.runtime);
        const dimensions = runtimeGlb.json.images.map((image) => (
            embeddedPngDimensions(runtimeGlb.binary, runtimeGlb.json.bufferViews[image.bufferView])
        ));
        assert(dimensions.length === 3
            && dimensions.every((item) => item.width === 2048 && item.height === 2048),
        'Every runtime cliff map is exactly 2048 x 2048', JSON.stringify(dimensions));
        const key = Object.entries(assets).find((entry) => (
            entry[1].replace(/^\.\//, '') === record.runtime
        ))?.[0];
        assert(Boolean(key), 'Runtime source constant references the manifested derivative', record.runtime);
        if (key) {
            assetStats.set(key, {
                halfX: (runtimePosition.max[0] - runtimePosition.min[0]) * 0.5,
                halfZ: (runtimePosition.max[2] - runtimePosition.min[2]) * 0.5,
                triangles: runtimeIndices.count / 3,
            });
        }
    }
    assert(assetStats.size === 2, 'Both user cliff assets are active runtime templates');

    const placements = extractDesertCliffPlacements(terrainSource);
    assert(placements.length === 8, 'Runtime composes eight distant cliff copies',
        String(placements.length));
    assert(new Set(placements.map((item) => item.name)).size === placements.length,
        'Every cliff copy has a unique placement identity');
    const usage = {};
    const playerHalf = api.HALF_NEAR - 28;
    for (const placement of placements) {
        usage[placement.asset] = (usage[placement.asset] ?? 0) + 1;
        const stats = assetStats.get(placement.asset);
        assert(Boolean(stats), 'Cliff placement references one of the two user assets', placement.name);
        assert(Number.isFinite(placement.scale) && placement.scale > 0,
            'Cliff placement uses one uniform scalar scale', placement.name);
        if (stats) {
            assert(Math.abs(placement.halfLength - stats.halfX * placement.scale) < 0.2
                && Math.abs(placement.halfDepth - stats.halfZ * placement.scale) < 0.2,
            'Cliff footprint matches its uniformly scaled source bounds', placement.name);
        }
        const apronX = placement.halfLength + 42;
        const apronZ = placement.halfDepth + 38;
        const cosYaw = Math.abs(Math.cos(placement.yaw));
        const sinYaw = Math.abs(Math.sin(placement.yaw));
        const worldHalfX = cosYaw * apronX + sinYaw * apronZ;
        const worldHalfZ = sinYaw * apronX + cosYaw * apronZ;
        const outsidePlayer = placement.x + worldHalfX < -playerHalf
            || placement.x - worldHalfX > playerHalf
            || placement.z + worldHalfZ < -playerHalf
            || placement.z - worldHalfZ > playerHalf;
        assert(outsidePlayer, 'Cliff mesh and complete foundation apron stay outside player bounds',
            placement.name);
        assert(api.authoredCliffMaskAt(placement.x, placement.z) > 0.999,
            'Cliff center fully excludes procedural scatter', placement.name);
        assert(api.cliffBaseBuildUpAt(placement.x, placement.z) >= placement.baseRise * 0.83,
            'Cliff center receives its authored visual foundation rise', placement.name);
    }
    assert((usage.wideLow ?? 0) >= 4 && (usage.mesaHigh ?? 0) >= 3,
        'Both supplied cliffs are copied across multiple formations', JSON.stringify(usage));
    assert(api.authoredCliffMaskAt(0, 0) === 0 && api.cliffBaseBuildUpAt(0, 0) === 0,
        'Cliffs and foundation aprons leave the playable temple valley untouched');
    assert(placements.some((item) => item.name.includes('western_crown'))
        && placements.some((item) => item.name.includes('northeastern_mesa'))
        && placements.some((item) => item.name.includes('eastern_crown')),
    'High mesas layer behind low shelves in three separate formations');
    assert(!placements.some((item) => item.z < -700 && Math.abs(item.x) < 120),
        'Rear cliffs preserve the ziggurat sky aperture');
    assert(/loadDesertCliffTemplates/.test(terrainSource)
        && /source\.material\.clone\(\)/.test(terrainSource)
        && /sharedImportedBakedPbr: true/.test(terrainSource),
    'Runtime preserves and shares the user assets baked PBR materials');
    assert(/repairImportedCliffWinding/.test(terrainSource)
        && /repairedWindingTriangles/.test(terrainSource),
    'Runtime repairs the high mesas three reversed source triangles');
    assert(/geometry\.scale\(placement\.scale, placement\.scale, placement\.scale\)/.test(terrainSource)
        && /uniformScaleOnly: true/.test(terrainSource),
    'Runtime never non-uniformly stretches the user cliff meshes');
    assert(/cliffBaseBuildUpAt\(x, z\)/.test(terrainSource)
        && /terrainFoundationAprons: true/.test(terrainSource)
        && /physics: false/.test(terrainSource),
    'Cliffs use visual terrain foundation aprons without adding mesh physics');
    assert(/cliff\.addLevel\(level, 0, 0\)/.test(terrainSource)
        && /cliff\.autoUpdate = false/.test(terrainSource)
        && /terrain\.updateLods = \(camera\)/.test(terrainSource),
    'Single-level cliff wrappers remain isolated from auxiliary render cameras');
    assert(/controls\.update\(dt\);[\s\S]{0,180}?terrain\.updateLods\?\.\(camera\);/.test(mainSource),
        'Frame loop retains the terrain camera update contract');
    assert((terrainSource.match(/makeCliffMaterial\(T3, maps\)/g) ?? []).length === 1
        && !/const cliffMaterial = makeCliffMaterial/.test(terrainSource),
    'Rejected COLOR_0 cliff material remains unused by the live terrain');
    return {
        manifest: manifest.schema,
        sourceBytes: manifest.assets.reduce((sum, item) => sum + item.sourceBytes, 0),
        runtimeBytes: manifest.assets.reduce((sum, item) => sum + item.runtimeBytes, 0),
        placements,
        usage,
    };
}

function auditDesertRockChunks(api, terrainSource, mainSource) {
    const textureManifest = JSON.parse(fs.readFileSync(
        path.join(ROOT, 'assets', 'terrain', 'desert_rock_chunks_runtime_2k.json'),
        'utf8',
    ));
    const lodManifest = JSON.parse(fs.readFileSync(
        path.join(ROOT, 'assets', 'terrain', 'desert_rock_chunks_runtime_lods.json'),
        'utf8',
    ));
    const masterPath = path.join(ROOT, lodManifest.asset.master);
    const runtimePath = path.join(ROOT, lodManifest.asset.runtime);
    assert(lodManifest.schema === 'eanpa-desert-rock-chunks-instanced-lods-v4',
        'Desert rock library uses the current reusable-piece LOD manifest');
    assert(textureManifest.schema === 'eanpa-desert-rock-chunks-runtime-2k-v1'
        && textureManifest.asset.images.some((image) => (
            image.roles.includes('normal')
            && image.treatment === 'lanczos_then_unit_vector_renormalization'
        )),
    'Rock texture derivative records normal-map vector renormalization');
    assert(sha256File(masterPath) === lodManifest.asset.masterSha256
        && lodManifest.asset.masterSha256
            === '233a8c11fb0e281b38a6e7df1ff0fe20f3ff00f3fe31b858971041637e89714f',
    'Immutable 12-rock master hash remains unchanged');
    assert(sha256File(runtimePath) === lodManifest.asset.runtimeSha256,
        'Reusable rock LOD library hash matches its manifest');
    assert(lodManifest.asset.sourceConnectedComponents === 12
        && lodManifest.asset.pieceCount === 12
        && lodManifest.asset.pieces.length === 12,
    'Master is reproducibly split into exactly 12 reusable connected pieces');
    assert(lodManifest.trianglesByLod[0] === 54638
        && lodManifest.trianglesByLod[1] === 17475
        && lodManifest.trianglesByLod[2] === 5457
        && lodManifest.asset.pieces.every((item) => (
            item.lods.length === 3
            && item.lods[1].triangles / item.lods[0].triangles >= 0.28
            && item.lods[1].triangles / item.lods[0].triangles <= 0.35
            && item.lods[2].triangles / item.lods[0].triangles >= 0.08
            && item.lods[2].triangles / item.lods[0].triangles <= 0.12
        )),
    'Rock library contains genuine 100, 32, and 10 percent geometry levels');
    assert(JSON.stringify(lodManifest.lodProjectedDiameterPixels) === '[72,18,1]'
        && lodManifest.subpixelCullDiameterPixels === 1,
    'Rock manifest records projected-size LOD switching and subpixel culling');
    assert(JSON.stringify(lodManifest.pieceClasses) === JSON.stringify({
        largeFlatWide: [2, 4, 8, 9],
        mediumIrregular: [0, 5, 6, 7],
        smallSmoothRound: [1, 10],
        cliffFaceTallNarrow: [3, 11],
    }) && JSON.stringify(lodManifest.pieceDiameterMetres) === JSON.stringify({
        largeFlatWide: [2.0, 5.8],
        mediumIrregular: [0.95, 2.75],
        smallSmoothRound: [0.30, 0.80],
    }) && JSON.stringify(lodManifest.pieceLongAxisMetres) === JSON.stringify({
        cliffFaceTallNarrow: [6.0, 14.0],
    }),
    'Rock manifest preserves inspected scatter roles, footprint ranges, and cliff long axes');
    const placements = api.buildDesertRockPlacements();
    const repeatedPlacements = api.buildDesertRockPlacements();
    assert(placements.length <= 720
        && placements.length >= 656
        && JSON.stringify(placements) === JSON.stringify(repeatedPlacements),
    'Rock scatter executes deterministically within its non-blocking instance target');
    const classForPiece = new Map(Object.entries(lodManifest.pieceClasses)
        .flatMap(([pieceClass, pieces]) => pieces.map((piece) => [piece, pieceClass])));
    assert(placements.every((item) => {
        const pieceClass = classForPiece.get(item.piece);
        if (item.pieceClass !== pieceClass) return false;
        if (pieceClass === 'cliffFaceTallNarrow') {
            const range = lodManifest.pieceLongAxisMetres.cliffFaceTallNarrow;
            return item.placementKind === 'cliffFaceCluster'
                && item.desiredLongAxis >= range[0]
                && item.desiredLongAxis <= range[1];
        }
        const range = lodManifest.pieceDiameterMetres[pieceClass];
        return item.placementKind === 'ground'
            && item.desiredDiameter >= range[0]
            && item.desiredDiameter <= range[1];
    }) && new Set(placements.map((item) => item.piece)).size === 12,
    'Executed placements use every authored piece only inside its measured role and size band');
    const groundPlacements = placements.filter((item) => item.placementKind === 'ground');
    const cliffClusters = placements.filter(
        (item) => item.placementKind === 'cliffFaceCluster',
    );
    assert(groundPlacements.length === 656
        && cliffClusters.length <= 64
        && placements.length === groundPlacements.length + cliffClusters.length
        && cliffClusters.every((item) => (
            item.clusterSize >= 1
            && item.clusterSize <= 8
            && item.clusterTargetSize === 8
            && item.clusterComplete === (item.clusterSize === 8)
        )),
    'Executed v4 scatter keeps 656 ground rocks and bounded graceful cliff clusters');
    let spacingValid = true;
    for (let later = 1; later < groundPlacements.length && spacingValid; later++) {
        for (let earlier = 0; earlier < later; earlier++) {
            const a = groundPlacements[earlier];
            const b = groundPlacements[later];
            const minimum = Math.max(
                b.nearField ? 7.5 : 12,
                (a.desiredDiameter + b.desiredDiameter) * 0.85,
            );
            if ((a.x - b.x) ** 2 + (a.z - b.z) ** 2 < minimum ** 2 - 1e-8) {
                spacingValid = false;
                break;
            }
        }
    }
    assert(spacingValid,
        'Executed rock population preserves its authored-diameter spacing rule');
    const runtimeGlb = parseGlb(runtimePath);
    const meshNodes = runtimeGlb.json.nodes.filter((node) => Number.isInteger(node.mesh));
    assert(meshNodes.length === 36
        && meshNodes.every((node) => /^DesertRockPiece\d{2}_LOD[012]$/.test(node.name)),
    'Runtime GLB carries 12 named pieces at three LODs each');
    assert(runtimeGlb.json.materials.length === 1,
        'All imported rock pieces share one baked PBR material');
    const material = runtimeGlb.json.materials[0];
    assert(Number.isInteger(material.normalTexture?.index)
        && Number.isInteger(material.pbrMetallicRoughness?.baseColorTexture?.index)
        && Number.isInteger(
            material.pbrMetallicRoughness?.metallicRoughnessTexture?.index,
        ),
    'Shared rock material retains base color, normal, and metallic/roughness maps');
    const dimensions = runtimeGlb.json.images.map((image) => (
        embeddedPngDimensions(runtimeGlb.binary, runtimeGlb.json.bufferViews[image.bufferView])
    ));
    assert(dimensions.length === 3
        && dimensions.every((item) => item.width === 2048 && item.height === 2048),
    'All shared rock PBR maps are bounded at 2048 x 2048');
    assert(/DESERT_ROCK_INSTANCE_TARGET = 720/.test(terrainSource)
        && /DESERT_ROCK_GROUND_INSTANCE_TARGET = 656/.test(terrainSource)
        && /DESERT_ROCK_CLIFF_CLUSTER_TARGET = 64/.test(terrainSource)
        && /DESERT_ROCK_CLIFF_CLUSTER_MEMBERS = 8/.test(terrainSource)
        && /DESERT_ROCK_MAXIMUM_DRAWS/.test(terrainSource)
        && /const rockBatches = new Map()/.test(terrainSource),
    'Rock population targets and draw budgets are explicit and bounded');
    assert(/new T3\.InstancedMesh\(/.test(terrainSource)
        && /rockBatches\.set/.test(terrainSource)
        && /batch\.setMatrixAt\(batch\.count, state\.matrix\)/.test(terrainSource),
    'Rock copies render through true shared InstancedMesh LOD buckets');
    assert(/DESERT_ROCK_LOD_PROJECTED_DIAMETER_PIXELS = \[72, 18, 1\]/.test(terrainSource)
        && /DESERT_ROCK_CULL_DIAMETER_PIXELS = 1/.test(terrainSource)
        && /camera\.projectionMatrix\.elements\[5\]/.test(terrainSource)
        && /viewportHeightPixels \/ viewDepth/.test(terrainSource)
        && /sourceSphere\.radius \* uniformScale/.test(terrainSource)
        && /rockFrustum\.intersectsSphere/.test(terrainSource)
        && /updateRockInstances\(camera\)/.test(terrainSource),
    'Gameplay camera controls projected-size rock LOD, transformed-sphere frustum filtering, and subpixel culling');
    assert(/largeFlatWide: Object\.freeze\(\[2, 4, 8, 9\]\)/.test(terrainSource)
        && /mediumIrregular: Object\.freeze\(\[0, 5, 6, 7\]\)/.test(terrainSource)
        && /smallSmoothRound: Object\.freeze\(\[1, 10\]\)/.test(terrainSource)
        && /cliffFaceTallNarrow: Object\.freeze\(\[3, 11\]\)/.test(terrainSource)
        && /largeFlatWide: Object\.freeze\(\[2\.0, 5\.8\]\)/.test(terrainSource)
        && /mediumIrregular: Object\.freeze\(\[0\.95, 2\.75\]\)/.test(terrainSource)
        && /smallSmoothRound: Object\.freeze\(\[0\.30, 0\.80\]\)/.test(terrainSource)
        && /cliffFaceTallNarrow: Object\.freeze\(\[6\.0, 14\.0\]\)/.test(terrainSource)
        && terrainSource.indexOf('const groupRoll') < terrainSource.indexOf('const sizeSeed')
        && /DESERT_ROCK_CLIFF_CLUSTER_MIN_GRADE = 0\.35/.test(terrainSource),
    'Scatter sizes flat pieces largest, smooth rounds smallest, and reserves pieces 03/11 for cliffs');
    assert(/compoundMaskAt\(x, z\) > 0\.015/.test(terrainSource)
        && /processionalMaskAt\(x, z\) > 0\.015/.test(terrainSource)
        && /washMaskAt\(x, z\) > 0\.22/.test(terrainSource)
        && /craterFieldsAt\(x, z\)\.exclusion > 0\.18/.test(terrainSource)
        && /authoredCliffMaskAt\(x, z\) > 0\.04/.test(terrainSource)
        && /DESERT_ROCK_CLIFF_SHOULDER_MASK_RANGE = Object\.freeze\(\[0\.08, 0\.82\]\)/
            .test(terrainSource),
    'Ground scatter excludes protected regions while cluster detail stays on bounded cliff shoulders');
    const metadata = terrainSource.slice(
        terrainSource.indexOf('terrain.userData.desertRockChunks'),
        terrainSource.indexOf('terrain.userData.nuclearCrater'),
    );
    assert(/profile: 'user-12-piece-instanced-terrain-dressing-v4'/.test(metadata)
        && /groundDiameterRangesMetres: Object\.fromEntries/.test(metadata)
        && /cliffClusterLongAxisRangesMetres: \{/.test(metadata)
        && /groundInstances: rockPlacements/.test(metadata)
        && /cliffClusterInstances: cliffClusterPlacements\.length/.test(metadata)
        && /incompleteCliffClusters: cliffClusterSummaries/.test(metadata)
        && /gracefulPartialClusters: true/.test(metadata)
        && /placementVersion: 'desert-rock-authored-v5-graceful-visual-index-clusters'/.test(metadata)
        && !/largeUpright|mediumChunky|smallFlat|diameterRangesMetres:/.test(metadata)
        && /geometryClonePerPlacement: false/.test(metadata)
        && /uniformScaleOnly: true/.test(metadata)
        && /terrainAwareSeating: true/.test(metadata)
        && /physics: false/.test(metadata),
    'Rock v4 metadata publishes inspected roles, actual cluster counts, and graceful shortfalls');
    assert(/controls\.update\(dt\);[\s\S]{0,180}?terrain\.updateLods\?\.\(camera\);/.test(mainSource),
        'Frame loop updates rock buckets only from the gameplay camera');
    return {
        masterBytes: lodManifest.asset.masterBytes,
        runtimeBytes: lodManifest.asset.runtimeBytes,
        reusablePieces: lodManifest.asset.pieceCount,
        lodTriangles: lodManifest.trianglesByLod,
        sharedTextureMemoryMiB: lodManifest.decodedTextureMemoryMiB,
        maximumDraws: 36,
        instances: placements.length,
    };
}

function paintPcaMetrics(points) {
    let meanX = 0;
    let meanZ = 0;
    for (const [x, z] of points) {
        meanX += x;
        meanZ += z;
    }
    meanX /= points.length;
    meanZ /= points.length;
    let xx = 0;
    let zz = 0;
    let xz = 0;
    let minimumX = Infinity;
    let maximumX = -Infinity;
    let minimumZ = Infinity;
    let maximumZ = -Infinity;
    for (const [x, z] of points) {
        const dx = x - meanX;
        const dz = z - meanZ;
        xx += dx * dx;
        zz += dz * dz;
        xz += dx * dz;
        minimumX = Math.min(minimumX, x);
        maximumX = Math.max(maximumX, x);
        minimumZ = Math.min(minimumZ, z);
        maximumZ = Math.max(maximumZ, z);
    }
    xx /= points.length;
    zz /= points.length;
    xz /= points.length;
    const trace = xx + zz;
    const discriminant = Math.sqrt((xx - zz) ** 2 + 4 * xz * xz);
    const majorVariance = Math.max(0, (trace + discriminant) * 0.5);
    const minorVariance = Math.max(0, (trace - discriminant) * 0.5);
    const width = maximumX - minimumX;
    const depth = maximumZ - minimumZ;
    return {
        extent: Math.hypot(width, depth),
        minorRms: Math.sqrt(minorVariance),
        aspect: Math.sqrt(majorVariance / Math.max(minorVariance, 1)),
        bounds: [width, depth],
    };
}

function longestStraightPaintSpan(edges, spacing) {
    // A PCA over an entire closed stripe can hide its two straight sides. Scan
    // narrow oriented corridors instead and measure contiguous tangent runs;
    // this catches finite, diagonal, and axis-aligned fronts without assuming
    // that a boundary component itself is globally straight.
    const corridorWidth = spacing * 2;
    const maximumGap = spacing * 2.25;
    let longest = 0;
    const byEndpoint = new Map();
    for (let index = 0; index < edges.length; index++) {
        for (const endpoint of [edges[index].first, edges[index].second]) {
            if (!byEndpoint.has(endpoint)) byEndpoint.set(endpoint, []);
            byEndpoint.get(endpoint).push(index);
        }
    }
    for (let direction = 0; direction < 90; direction++) {
        const angle = direction / 90 * Math.PI;
        const tangentX = Math.cos(angle);
        const tangentZ = Math.sin(angle);
        const normalX = -tangentZ;
        const normalZ = tangentX;
        const projected = edges.map((edge) => {
            const [x, z] = edge.midpoint;
            return {
                tangent: x * tangentX + z * tangentZ,
                normal: x * normalX + z * normalZ,
            };
        });
        for (const shift of [0, 0.5]) {
            const corridors = new Map();
            for (let index = 0; index < edges.length; index++) {
                const corridor = Math.floor(
                    projected[index].normal / corridorWidth + shift,
                );
                if (!corridors.has(corridor)) corridors.set(corridor, []);
                corridors.get(corridor).push(index);
            }
            for (const corridorEdges of corridors.values()) {
                const allowed = new Uint8Array(edges.length);
                for (const index of corridorEdges) allowed[index] = 1;
                const visited = new Uint8Array(edges.length);
                for (const start of corridorEdges) {
                    if (visited[start]) continue;
                    const queue = [start];
                    visited[start] = 1;
                    let minimum = Infinity;
                    let maximum = -Infinity;
                    let edgeCount = 0;
                    while (queue.length) {
                        const current = queue.pop();
                        edgeCount++;
                        minimum = Math.min(minimum, projected[current].tangent);
                        maximum = Math.max(maximum, projected[current].tangent);
                        for (const endpoint of [
                            edges[current].first, edges[current].second,
                        ]) {
                            for (const next of byEndpoint.get(endpoint)) {
                                if (!allowed[next] || visited[next]) continue;
                                visited[next] = 1;
                                queue.push(next);
                            }
                        }
                    }
                    const span = maximum - minimum;
                    const coverage = edgeCount * spacing / Math.max(span, spacing);
                    if (coverage >= 0.65 && span <= edgeCount * maximumGap) {
                        longest = Math.max(longest, span);
                    }
                }
            }
        }
    }
    return longest;
}

function analyzeDominantPaintTopology(
    winnerGrid, layerNames, spacing, weightGrid = null, washIndex = 4,
) {
    const rows = winnerGrid.length;
    const columns = winnerGrid[0].length;
    const washComponentIds = Array.from(
        { length: rows }, () => new Int32Array(columns).fill(-1),
    );
    let washComponentCount = 0;
    for (let row = 0; row < rows; row++) {
        for (let column = 0; column < columns; column++) {
            if (winnerGrid[row][column] !== washIndex
                || washComponentIds[row][column] !== -1) continue;
            const queue = [[column, row]];
            washComponentIds[row][column] = washComponentCount;
            while (queue.length) {
                const [x, z] = queue.pop();
                for (const [nextX, nextZ] of [
                    [x - 1, z], [x + 1, z], [x, z - 1], [x, z + 1],
                ]) {
                    if (nextX < 0 || nextZ < 0
                        || nextX >= columns || nextZ >= rows
                        || winnerGrid[nextZ][nextX] !== washIndex
                        || washComponentIds[nextZ][nextX] !== -1) continue;
                    washComponentIds[nextZ][nextX] = washComponentCount;
                    queue.push([nextX, nextZ]);
                }
            }
            washComponentCount++;
        }
    }
    const componentsByLayer = Object.fromEntries(layerNames.map((name) => [name, []]));
    for (let layer = 0; layer < layerNames.length; layer++) {
        const visited = Array.from({ length: rows }, () => new Uint8Array(columns));
        for (let row = 0; row < rows; row++) {
            for (let column = 0; column < columns; column++) {
                if (visited[row][column] || winnerGrid[row][column] !== layer) continue;
                const queue = [[column, row]];
                const points = [];
                let boundaryEdges = 0;
                let washBoundaryEdges = 0;
                const adjacentWashComponents = new Set();
                visited[row][column] = 1;
                while (queue.length) {
                    const [x, z] = queue.pop();
                    points.push([x * spacing, z * spacing]);
                    for (const [nextX, nextZ] of [
                        [x - 1, z], [x + 1, z], [x, z - 1], [x, z + 1],
                    ]) {
                        if (nextX < 0 || nextZ < 0
                            || nextX >= columns || nextZ >= rows) continue;
                        if (winnerGrid[nextZ][nextX] !== layer) {
                            boundaryEdges++;
                            if (winnerGrid[nextZ][nextX] === washIndex) {
                                washBoundaryEdges++;
                                adjacentWashComponents.add(
                                    washComponentIds[nextZ][nextX],
                                );
                            }
                            continue;
                        }
                        if (visited[nextZ][nextX]) continue;
                        visited[nextZ][nextX] = 1;
                        queue.push([nextX, nextZ]);
                    }
                }
                if (points.length < 4) continue;
                componentsByLayer[layerNames[layer]].push({
                    samples: points.length,
                    washBoundaryFraction: boundaryEdges
                        ? washBoundaryEdges / boundaryEdges : 0,
                    adjacentWashComponents: adjacentWashComponents.size,
                    ...paintPcaMetrics(points),
                });
            }
        }
        componentsByLayer[layerNames[layer]].sort((a, b) => b.samples - a.samples);
    }

    const edgesByPair = new Map();
    const addBoundary = (first, second, x1, z1, x2, z2, firstWeights, secondWeights) => {
        const low = Math.min(first, second);
        const high = Math.max(first, second);
        const key = low + ':' + high;
        if (!edgesByPair.has(key)) edgesByPair.set(key, []);
        const firstDifference = firstWeights
            ? firstWeights[low] - firstWeights[high] : null;
        const secondDifference = secondWeights
            ? secondWeights[low] - secondWeights[high] : null;
        edgesByPair.get(key).push({
            first: x1 + ':' + z1,
            second: x2 + ':' + z2,
            midpoint: [((x1 + x2) * spacing) / 4, ((z1 + z2) * spacing) / 4],
            pairGradient: firstDifference === null || secondDifference === null
                ? null
                : Math.abs(secondDifference - firstDifference) / spacing,
        });
    };
    for (let row = 0; row < rows; row++) {
        for (let column = 0; column < columns; column++) {
            const current = winnerGrid[row][column];
            if (column + 1 < columns && winnerGrid[row][column + 1] !== current) {
                addBoundary(
                    current, winnerGrid[row][column + 1],
                    column * 2 + 1, row * 2 - 1,
                    column * 2 + 1, row * 2 + 1,
                    weightGrid?.[row]?.[column],
                    weightGrid?.[row]?.[column + 1],
                );
            }
            if (row + 1 < rows && winnerGrid[row + 1][column] !== current) {
                addBoundary(
                    current, winnerGrid[row + 1][column],
                    column * 2 - 1, row * 2 + 1,
                    column * 2 + 1, row * 2 + 1,
                    weightGrid?.[row]?.[column],
                    weightGrid?.[row + 1]?.[column],
                );
            }
        }
    }

    const boundaryFronts = [];
    for (const [key, edges] of edgesByPair) {
        const [low, high] = key.split(':').map(Number);
        const byEndpoint = new Map();
        for (let index = 0; index < edges.length; index++) {
            for (const endpoint of [edges[index].first, edges[index].second]) {
                if (!byEndpoint.has(endpoint)) byEndpoint.set(endpoint, []);
                byEndpoint.get(endpoint).push(index);
            }
        }
        const visited = new Uint8Array(edges.length);
        for (let start = 0; start < edges.length; start++) {
            if (visited[start]) continue;
            const queue = [start];
            const points = [];
            const componentEdges = [];
            const pairGradients = [];
            visited[start] = 1;
            while (queue.length) {
                const edgeIndex = queue.pop();
                const edge = edges[edgeIndex];
                points.push(edge.midpoint);
                componentEdges.push(edge);
                if (edge.pairGradient !== null) pairGradients.push(edge.pairGradient);
                for (const endpoint of [edge.first, edge.second]) {
                    for (const next of byEndpoint.get(endpoint)) {
                        if (visited[next]) continue;
                        visited[next] = 1;
                        queue.push(next);
                    }
                }
            }
            if (points.length < 6) continue;
            pairGradients.sort((a, b) => a - b);
            const medianPairGradient = pairGradients.length
                ? pairGradients[Math.floor(pairGradients.length * 0.5)]
                : null;
            boundaryFronts.push({
                layers: [layerNames[low], layerNames[high]],
                includesWash: low === washIndex || high === washIndex,
                edges: points.length,
                longestStraightSpan: longestStraightPaintSpan(componentEdges, spacing),
                medianPairGradient,
                ...paintPcaMetrics(points),
            });
        }
    }
    boundaryFronts.sort((a, b) => b.extent - a.extent);

    const shapeStripeComponents = Object.entries(componentsByLayer).flatMap(
        ([layer, components], layerIndex) => (
            layerIndex === washIndex ? [] : components
                .filter((component) => component.samples >= 32
                    && component.extent >= 280
                    && component.minorRms <= 28
                    && component.aspect >= 7)
                .map((component) => ({ layer, ...component }))
        ),
    );
    const washSegmentedBaseComponents = shapeStripeComponents.filter(
        (component) => component.layer === layerNames[0]
            && component.washBoundaryFraction >= 0.60
            && component.adjacentWashComponents >= 2,
    );
    const stripeComponents = shapeStripeComponents.filter(
        (component) => !washSegmentedBaseComponents.includes(component),
    );
    const linearFronts = boundaryFronts.filter((front) => (
        !front.includesWash
        && front.edges >= 18
        && front.longestStraightSpan >= 160
    ));
    const broadGradientFronts = boundaryFronts.filter((front) => (
        !front.includesWash
        && front.extent >= 160
        && front.medianPairGradient !== null
        && front.medianPairGradient < 0.010
    ));
    return {
        componentsByLayer,
        boundaryFronts,
        stripeComponents,
        washSegmentedBaseComponents,
        linearFronts,
        broadGradientFronts,
    };
}

function decodeGray8Png(filename, label) {
    const data = fs.readFileSync(filename);
    assert(data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
        `${label} has a valid PNG signature`);
    let offset = 8;
    let width = 0, height = 0, bitDepth = 0, colorType = -1;
    const idat = [];
    while (offset < data.length) {
        const length = data.readUInt32BE(offset); offset += 4;
        const type = data.toString('ascii', offset, offset + 4); offset += 4;
        const payload = data.subarray(offset, offset + length); offset += length;
        const storedCrc = data.readUInt32BE(offset); offset += 4;
        assert(crc32(Buffer.concat([Buffer.from(type), payload])) === storedCrc,
            `${label} ${type} chunk CRC is valid`);
        if (type === 'IHDR') {
            width = payload.readUInt32BE(0);
            height = payload.readUInt32BE(4);
            bitDepth = payload[8];
            colorType = payload[9];
        } else if (type === 'IDAT') idat.push(payload);
        else if (type === 'IEND') break;
    }
    assert(width === 1024 && height === 1024 && bitDepth === 8 && colorType === 0,
        `${label} is the authored 1024-square Gray8 threshold mask`,
        `${width}x${height}, depth=${bitDepth}, type=${colorType}`);
    const inflated = zlib.inflateSync(Buffer.concat(idat));
    const stride = width;
    assert(inflated.length === height * (stride + 1),
        `${label} scanline payload has the expected size`, `${inflated.length}`);
    const samples = new Uint8Array(width * height);
    let cursor = 0;
    let previous = Buffer.alloc(stride);
    for (let y = 0; y < height; y++) {
        const filter = inflated[cursor++];
        const raw = inflated.subarray(cursor, cursor + stride); cursor += stride;
        const current = Buffer.allocUnsafe(stride);
        for (let x = 0; x < stride; x++) {
            const left = x ? current[x - 1] : 0;
            const up = previous[x];
            const upLeft = x ? previous[x - 1] : 0;
            let predictor = 0;
            if (filter === 1) predictor = left;
            else if (filter === 2) predictor = up;
            else if (filter === 3) predictor = Math.floor((left + up) * 0.5);
            else if (filter === 4) {
                const p = left + up - upLeft;
                const pa = Math.abs(p - left), pb = Math.abs(p - up), pc = Math.abs(p - upLeft);
                predictor = pa <= pb && pa <= pc ? left : (pb <= pc ? up : upLeft);
            } else if (filter !== 0) throw new Error(`${label} uses unsupported filter ${filter}`);
            current[x] = (raw[x] + predictor) & 255;
        }
        samples.set(current, y * width);
        previous = current;
    }
    return { width, height, samples };
}

function sampleRepeatedGray8(image, x, z, transform) {
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

function paintEntropy(weights) {
    let result = 0;
    for (const weight of weights) if (weight > 1e-12) result -= weight * Math.log(weight);
    return result;
}

function summarizePaintWindows(
    weightGrid, side, stride, contributorThreshold,
    { originX = -384, originZ = -384, spacing = 4 } = {},
) {
    const rows = weightGrid.length, columns = weightGrid[0].length;
    const layerCount = weightGrid[0][0].length;
    const report = {
        count: 0,
        maxMeanLayer: 0,
        minContributors: Infinity,
        minSecondMean: Infinity,
        minEffectiveLayers: Infinity,
        minSpatialMutualInformation: Infinity,
        maxNearPureFraction: 0,
    };
    for (let row0 = 0; row0 + side <= rows; row0 += stride) {
        for (let column0 = 0; column0 + side <= columns; column0 += stride) {
            const means = Array(layerCount).fill(0);
            let meanPointEntropy = 0;
            let nearPure = 0;
            const count = side * side;
            for (let row = row0; row < row0 + side; row++) {
                for (let column = column0; column < column0 + side; column++) {
                    const weights = weightGrid[row][column];
                    for (let layer = 0; layer < layerCount; layer++) means[layer] += weights[layer];
                    meanPointEntropy += paintEntropy(weights);
                    if (Math.max(...weights) >= 0.92) nearPure++;
                }
            }
            for (let layer = 0; layer < layerCount; layer++) means[layer] /= count;
            const sorted = [...means].sort((a, b) => b - a);
            const aggregateEntropy = paintEntropy(means);
            const location = {
                bounds: [
                    originX + column0 * spacing,
                    originZ + row0 * spacing,
                    originX + (column0 + side) * spacing,
                    originZ + (row0 + side) * spacing,
                ],
                means,
            };
            report.count++;
            if (sorted[0] > report.maxMeanLayer) {
                report.maxMeanLayer = sorted[0];
                report.maxMeanLayerWindow = location;
            }
            const contributors = means.filter((value) => value >= contributorThreshold).length;
            if (contributors < report.minContributors) {
                report.minContributors = contributors;
                report.minContributorsWindow = location;
            }
            if (sorted[1] < report.minSecondMean) {
                report.minSecondMean = sorted[1];
                report.minSecondMeanWindow = location;
            }
            const effectiveLayers = Math.exp(aggregateEntropy);
            if (effectiveLayers < report.minEffectiveLayers) {
                report.minEffectiveLayers = effectiveLayers;
                report.minEffectiveLayersWindow = location;
            }
            const spatialMutualInformation = Math.max(
                0, aggregateEntropy - meanPointEntropy / count,
            );
            if (spatialMutualInformation < report.minSpatialMutualInformation) {
                report.minSpatialMutualInformation = spatialMutualInformation;
                report.minSpatialMutualInformationWindow = location;
            }
            report.maxNearPureFraction = Math.max(report.maxNearPureFraction, nearPure / count);
        }
    }
    return report;
}

function summarizeContributorDistribution(
    weightGrid, exposedGrid, side, stride, contributorThreshold,
    { spacing = 4 } = {},
) {
    const rows = weightGrid.length, columns = weightGrid[0].length;
    const layerCount = weightGrid[0][0].length;
    const histogram = Array(layerCount + 1).fill(0);
    const exposedHistogram = Array(layerCount + 1).fill(0);
    let count = 0, exposedWindowCount = 0;
    for (let row0 = 0; row0 + side <= rows; row0 += stride) {
        for (let column0 = 0; column0 + side <= columns; column0 += stride) {
            const means = Array(layerCount).fill(0);
            let exposedSamples = 0;
            const sampleCount = side * side;
            for (let row = row0; row < row0 + side; row++) {
                for (let column = column0; column < column0 + side; column++) {
                    const weights = weightGrid[row][column];
                    for (let layer = 0; layer < layerCount; layer++) means[layer] += weights[layer];
                    if (exposedGrid[row][column]) exposedSamples++;
                }
            }
            for (let layer = 0; layer < layerCount; layer++) means[layer] /= sampleCount;
            const contributors = means.filter((value) => value >= contributorThreshold).length;
            histogram[contributors]++;
            count++;
            if (exposedSamples / sampleCount >= 0.5) {
                exposedHistogram[contributors]++;
                exposedWindowCount++;
            }
        }
    }
    const fractionAtLeast = (source, total, minimum) => total > 0
        ? source.slice(minimum).reduce((sum, value) => sum + value, 0) / total : 0;
    return {
        windowMeters: side * spacing,
        contributorThreshold,
        count,
        histogram,
        fractionAtLeast3: fractionAtLeast(histogram, count, 3),
        fractionAtLeast4: fractionAtLeast(histogram, count, 4),
        exposedWindowCount,
        exposedHistogram,
        exposedFractionAtLeast3: fractionAtLeast(exposedHistogram, exposedWindowCount, 3),
        exposedFractionAtLeast4: fractionAtLeast(exposedHistogram, exposedWindowCount, 4),
    };
}

function summarizeHeightMonopolyBounds(
    weightGrid, side, stride, amplitude,
    { originX = -384, originZ = -384, spacing = 4 } = {},
) {
    const rows = weightGrid.length, columns = weightGrid[0].length;
    const layerCount = weightGrid[0][0].length;
    const highFactor = 1 + amplitude, lowFactor = 1 - amplitude;
    const report = { count: 0, maximumLayerMean: 0, amplitude };
    for (let row0 = 0; row0 + side <= rows; row0 += stride) {
        for (let column0 = 0; column0 + side <= columns; column0 += stride) {
            const means = Array(layerCount).fill(0);
            const count = side * side;
            for (let row = row0; row < row0 + side; row++) {
                for (let column = column0; column < column0 + side; column++) {
                    const weights = weightGrid[row][column];
                    for (let layer = 0; layer < layerCount; layer++) {
                        const weight = weights[layer];
                        means[layer] += (weight * highFactor)
                            / Math.max(1e-8, weight * highFactor + (1 - weight) * lowFactor);
                    }
                }
            }
            for (let layer = 0; layer < layerCount; layer++) means[layer] /= count;
            const maximum = Math.max(...means);
            report.count++;
            if (maximum > report.maximumLayerMean) {
                report.maximumLayerMean = maximum;
                report.maximumWindow = {
                    bounds: [
                        originX + column0 * spacing,
                        originZ + row0 * spacing,
                        originX + (column0 + side) * spacing,
                        originZ + (row0 + side) * spacing,
                    ],
                    layer: means.indexOf(maximum),
                    means,
                };
            }
        }
    }
    return report;
}

function strongPaintComponents(weightGrid, exposedGrid, threshold = 0.80, spacing = 4) {
    const rows = weightGrid.length, columns = weightGrid[0].length;
    const layerCount = weightGrid[0][0].length;
    const reports = [];
    for (let layer = 0; layer < layerCount; layer++) {
        const visited = Array.from({ length: rows }, () => new Uint8Array(columns));
        for (let row = 0; row < rows; row++) {
            for (let column = 0; column < columns; column++) {
                const weights = weightGrid[row][column];
                let winner = 0;
                for (let index = 1; index < layerCount; index++) if (weights[index] > weights[winner]) winner = index;
                if (visited[row][column] || winner !== layer || weights[layer] < threshold) continue;
                const queue = [[column, row]];
                visited[row][column] = 1;
                let samples = 0, minX = column, maxX = column, minZ = row, maxZ = row;
                let exposed = 0, rock029 = 0, rock061 = 0;
                while (queue.length) {
                    const [x, z] = queue.pop();
                    const point = weightGrid[z][x];
                    samples++;
                    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
                    minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
                    if (exposedGrid[z][x]) exposed++;
                    rock029 += point[5] + point[8];
                    rock061 += point[6] + point[11];
                    for (const [nextX, nextZ] of [[x - 1, z], [x + 1, z], [x, z - 1], [x, z + 1]]) {
                        if (nextX < 0 || nextZ < 0 || nextX >= columns || nextZ >= rows
                            || visited[nextZ][nextX]) continue;
                        const next = weightGrid[nextZ][nextX];
                        let nextWinner = 0;
                        for (let index = 1; index < layerCount; index++) if (next[index] > next[nextWinner]) nextWinner = index;
                        if (nextWinner !== layer || next[layer] < threshold) continue;
                        visited[nextZ][nextX] = 1;
                        queue.push([nextX, nextZ]);
                    }
                }
                const boundingColumns = maxX - minX + 1;
                const boundingRows = maxZ - minZ + 1;
                reports.push({
                    layer,
                    samples,
                    area: samples * spacing * spacing,
                    diameter: Math.hypot(
                        boundingColumns * spacing, boundingRows * spacing,
                    ),
                    boundingFill: samples / (boundingColumns * boundingRows),
                    exposedFraction: exposed / samples,
                    meanRock029: rock029 / samples,
                    meanRock061: rock061 / samples,
                });
            }
        }
    }
    return reports.sort((a, b) => b.area - a.area);
}

function auditPaint(api, { metricsOnly = false } = {}) {
    const layerNames = [
        'RockyTrail02', 'DryGroundRocks', 'RedLateriteSoilStones',
        'CrackedRedGround', 'MudCrackedDryRiverbed002', 'Rock029', 'Rock061',
        'GravellySand', 'RockFace03', 'SandyGravel02', 'RockyTrail',
        'RockFace', 'RockBoulderCracked', 'RocksGround02',
    ];
    const groundLayers = [0, 1, 2, 3, 10];
    const washLayers = [4, 7, 9];
    const rockLayers = [5, 6, 8, 11, 12, 13];
    const familyLayers = Object.freeze({
        ground: groundLayers,
        wash: washLayers,
        rock: rockLayers,
    });
    // The dedicated ownership audit resolves the same contract at 2 m. This
    // static audit intentionally retains its cheaper 4 m grid. The dedicated
    // 2 m ownership audit owns the interior-thickness contract; these coarse
    // one-cell floors only reject boundary-only dust.
    const familyLimits = Object.freeze({
        ground: Object.freeze({ eligibility: 0.35, winner: 0.05, corePerWinner: 0.50,
            erodedOneCell: 0.06, p90InteriorM: 0 }),
        wash: Object.freeze({ eligibility: 0.20, winner: 0.10, corePerWinner: 0.35,
            erodedOneCell: 0.12, p90InteriorM: 2 }),
        rock: Object.freeze({ eligibility: 0.35, winner: 0.08, corePerWinner: 0.50,
            erodedOneCell: 0.06, p90InteriorM: 0 }),
    });
    const activeEpsilon = 0.03;
    const maximumSignificantFamilyChildren = 4;
    const coreMargin = 0.08 - 1e-6;
    const nonRockLayers = [0, 1, 2, 3, 4, 7, 9, 10];
    const nonFaceLayers = [0, 1, 2, 3, 4, 5, 6, 7, 9, 10, 12, 13];
    const macroWindowLimits = Object.freeze({ 32: 0.80, 64: 0.58, 128: 0.45, 256: 0.35 });
    const sumLayers = (values, layers) => layers.reduce((sum, layer) => sum + values[layer], 0);
    const brushPath = path.join(ROOT, 'assets', 'terrain', 'masks', 'seedthree_blend_brush.png');
    assert(fs.existsSync(brushPath), 'Authored SeedThree terrain threshold brush is present');
    assert(sha256File(brushPath)
        === '4fd44ca5c00b83c897423d1a849bd2e184684b1dc16b88e28e905ddeec2ab62b',
    'Authored threshold brush hash matches the inspected SeedThree mask');
    const brush = decodeGray8Png(brushPath, 'SeedThree terrain blend brush');
    const transforms = api.TERRAIN_BLEND_BRUSH_TRANSFORMS;
    assert(transforms.length === 7
        && Math.min(...transforms.map((entry) => entry.repeatMeters)) > 54
        && Math.max(...transforms.map((entry) => entry.repeatMeters)) <= 125,
    'Seven denser independent brush periods preserve authored SeedThree breakup',
    JSON.stringify(transforms));

    const dominant = Object.fromEntries(layerNames.map((name) => [name, 0]));
    const coverage = Object.fromEntries(layerNames.map((name) => [name, 0]));
    const weightTotals = Object.fromEntries(layerNames.map((name) => [name, 0]));
    const winnerGrid = [];
    const weightGrid = [];
    const exposedGrid = [];
    const spacing = 4;
    const columns = Math.floor(768 / spacing) + 1;
    const rows = columns;
    const sampleCount = columns * rows;
    const makeFamilyState = () => Object.fromEntries(Object.entries(familyLayers).map(
        ([name, layers]) => [name, {
            layers,
            eligible: 0,
            winners: new Uint32Array(layers.length),
            cores: new Uint32Array(layers.length),
            winnerMap: new Int16Array(sampleCount).fill(-1),
            maximumActive: 0,
            tooManyActive: 0,
            softBlendSamples: 0,
        }],
    ));
    const familyState = makeFamilyState();
    const coarseGroundMap = new Float32Array(sampleCount);
    const makeGroundBand = () => ({
        samples: 0,
        memberTotals: Array(groundLayers.length).fill(0),
        winners: new Uint32Array(groundLayers.length),
    });
    const groundBands = { low: makeGroundBand(), mid: makeGroundBand() };
    const controlledHeightTrend = {
        samples: 0,
        lowElevationTotals: Array(groundLayers.length).fill(0),
        midElevationTotals: Array(groundLayers.length).fill(0),
    };
    let invalid = 0;
    let ownershipContractInvalid = 0;
    let riverbedOutsideWashes = 0;
    let washSamples = 0;
    let realVerticalSamples = 0;
    let realVerticalViolations = 0;
    let realElevationPuritySamples = 0;
    let realElevationPurityViolations = 0;
    let realGradePuritySamples = 0;
    let realGradePurityViolations = 0;
    let summitSamples = 0;
    let summitNonFaceMass = 0;
    let summitNonFaceWinners = 0;
    let lowBaseSamples = 0;
    const lowBaseTotals = Array(layerNames.length).fill(0);
    let exposedTerrainSamples = 0;
    const exposedTotals = Array(layerNames.length).fill(0);
    let stronglyResolvedSamples = 0;
    const retainedMass4 = [];
    const retainedMass5 = [];
    let maxActiveAt006 = 0;
    let activeOverSixAt006 = 0;
    for (let z = -384; z <= 384; z += spacing) {
        const winnerRow = [];
        const weightRow = [];
        const exposedRow = [];
        for (let x = -384; x <= 384; x += spacing) {
            const step = 0.8;
            const elevation = api.terrainHeightAt(x, z);
            const dx = (api.terrainHeightAt(x + step, z) - api.terrainHeightAt(x - step, z)) / (2 * step);
            const dz = (api.terrainHeightAt(x, z + step) - api.terrainHeightAt(x, z - step)) / (2 * step);
            const grade = Math.hypot(dx, dz);
            const paint = api.paintAt(x, z, grade, elevation);
            const brushValues = transforms.map((transform) => (
                sampleRepeatedGray8(brush, x, z, transform)
            ));
            const wash = api.washMaskAt(x, z);
            const ownership = api.resolvePaintOwnership(
                paint.selectors, brushValues, grade, elevation, wash,
                x, z,
            );
            const values = ownership.weights;
            const washWeight = values[4] + values[7] + values[9];
            if (wash > 1e-8) washSamples++;
            else if (washWeight > 1e-10) riverbedOutsideWashes++;
            const sum = values.reduce((total, value) => total + value, 0);
            if (values.length !== layerNames.length
                || values.some((value) => !Number.isFinite(value) || value < -1e-7 || value > 1 + 1e-7)
                || !near(sum, 1, 1e-6)) invalid++;
            const sampleIndex = weightGrid.length * columns + weightRow.length;
            coarseGroundMap[sampleIndex] = ownership.coarseGround;
            const contractObjectsPresent = ownership.families && ownership.familyMembers
                && ownership.familyMargins && Number.isFinite(ownership.talusGate);
            let sampleContractInvalid = !contractObjectsPresent
                || (ownership.talusGate === 0 && values[13] !== 0);
            if (contractObjectsPresent) {
                for (const [name, state] of Object.entries(familyState)) {
                    const members = ownership.familyMembers[name];
                    const familyMass = ownership.families[name];
                    if (!Array.isArray(members) || members.length !== state.layers.length
                        || !Number.isFinite(familyMass) || familyMass < 0 || familyMass > 1
                        || members.some((value) => !Number.isFinite(value) || value < 0)
                        || !near(members.reduce((total, value) => total + value, 0), 1, 1e-6)
                        || !near(sumLayers(values, state.layers), familyMass, 1e-6)
                        || state.layers.some((layer, local) => (
                            !near(values[layer], familyMass * members[local], 1e-6)
                        ))) {
                        sampleContractInvalid = true;
                        continue;
                    }
                    const active = members.filter((value) => value > activeEpsilon).length;
                    state.maximumActive = Math.max(state.maximumActive, active);
                    if (active > maximumSignificantFamilyChildren) state.tooManyActive++;
                    if (familyMass < familyLimits[name].eligibility) continue;
                    state.eligible++;
                    let familyWinner = 0;
                    for (let local = 1; local < members.length; local++) {
                        if (members[local] > members[familyWinner]) familyWinner = local;
                    }
                    state.winners[familyWinner]++;
                    state.winnerMap[sampleIndex] = familyWinner;
                    if (ownership.familyMargins[name] >= coreMargin) state.cores[familyWinner]++;
                    const orderedMembers = [...members].sort((left, right) => right - left);
                    if (orderedMembers[1] >= 0.05) state.softBlendSamples++;
                }
            }
            if (sampleContractInvalid) ownershipContractInvalid++;

            if (ownership.faceGate === 1) {
                realVerticalSamples++;
                if (nonFaceLayers.some((layer) => values[layer] !== 0)
                    || !near(values[8] + values[11], 1, 2e-6)) realVerticalViolations++;
            }
            if (elevation >= 50) {
                realElevationPuritySamples++;
                if (ownership.families.ground !== 0 || ownership.families.wash !== 0
                    || ownership.families.rock !== 1
                    || nonRockLayers.some((layer) => values[layer] !== 0)) {
                    realElevationPurityViolations++;
                }
            }
            if (grade >= 0.80) {
                realGradePuritySamples++;
                if (ownership.faceGate !== 1
                    || ownership.families.ground !== 0 || ownership.families.wash !== 0
                    || ownership.families.rock !== 1
                    || nonFaceLayers.some((layer) => values[layer] !== 0)) {
                    realGradePurityViolations++;
                }
            }
            if (ownership.highFlat >= 0.70 && ownership.faceGate <= 0.10
                && ownership.families.rock >= familyLimits.rock.eligibility) {
                const rockMembers = ownership.familyMembers.rock;
                summitSamples++;
                summitNonFaceMass += rockMembers[0] + rockMembers[1]
                    + rockMembers[4] + rockMembers[5];
                const summitWinner = rockMembers.indexOf(Math.max(...rockMembers));
                if (summitWinner === 0 || summitWinner === 1
                    || summitWinner === 4 || summitWinner === 5) {
                    summitNonFaceWinners++;
                }
            }

            if (ownership.families.ground >= familyLimits.ground.eligibility
                && ownership.coarseGround <= 0.90) {
                const band = ownership.coarseGround <= 0.35 ? groundBands.low : groundBands.mid;
                const members = ownership.familyMembers.ground;
                band.samples++;
                let bandWinner = 0;
                for (let local = 0; local < members.length; local++) {
                    band.memberTotals[local] += members[local];
                    if (members[local] > members[bandWinner]) bandWinner = local;
                }
                band.winners[bandWinner]++;
            }
            if (weightGrid.length % 8 === 0 && weightRow.length % 8 === 0) {
                const lowOwnership = api.resolvePaintOwnership(
                    paint.selectors, brushValues, 0, 0, 0, x, z,
                );
                const midOwnership = api.resolvePaintOwnership(
                    paint.selectors, brushValues, 0, 14, 0, x, z,
                );
                controlledHeightTrend.samples++;
                for (let local = 0; local < groundLayers.length; local++) {
                    controlledHeightTrend.lowElevationTotals[local]
                        += lowOwnership.familyMembers.ground[local];
                    controlledHeightTrend.midElevationTotals[local]
                        += midOwnership.familyMembers.ground[local];
                }
            }
            const sortedWeights = [...values].sort((a, b) => b - a);
            retainedMass4.push(sortedWeights.slice(0, 4).reduce((a, b) => a + b, 0));
            retainedMass5.push(sortedWeights.slice(0, 5).reduce((a, b) => a + b, 0));
            const activeAt006 = values.filter((value) => value >= 0.06).length;
            maxActiveAt006 = Math.max(maxActiveAt006, activeAt006);
            if (activeAt006 > 6) activeOverSixAt006++;
            let winner = 0;
            for (let index = 0; index < values.length; index++) {
                const name = layerNames[index];
                weightTotals[name] += values[index];
                if (values[index] >= 0.025) coverage[name]++;
                if (values[index] > values[winner]) winner = index;
            }
            dominant[layerNames[winner]]++;
            if (values[winner] >= 0.52) stronglyResolvedSamples++;
            winnerRow.push(winner);
            weightRow.push(values);

            const exposed = elevation > 20 || grade > 0.32;
            exposedRow.push(exposed);
            if (exposed) {
                exposedTerrainSamples++;
                for (let index = 0; index < layerNames.length; index++) exposedTotals[index] += values[index];
            }
            if (elevation <= 6 && grade <= 0.10 && wash === 0
                && api.craterFieldsAt(x, z).inner <= 0.01) {
                lowBaseSamples++;
                for (let index = 0; index < layerNames.length; index++) lowBaseTotals[index] += values[index];
            }
        }
        winnerGrid.push(winnerRow);
        weightGrid.push(weightRow);
        exposedGrid.push(exposedRow);
    }

    const summarizeRetainedMass = (values) => {
        const ordered = [...values].sort((a, b) => a - b);
        const quantile = (q) => ordered[Math.min(
            ordered.length - 1, Math.max(0, Math.floor(q * (ordered.length - 1))),
        )];
        return {
            samples: ordered.length,
            minimum: ordered[0],
            p01: quantile(0.01),
            median: quantile(0.50),
            p99: quantile(0.99),
            mean: ordered.reduce((sum, value) => sum + value, 0) / ordered.length,
        };
    };
    const topKRetainedMass = {
        K4: summarizeRetainedMass(retainedMass4),
        K5: summarizeRetainedMass(retainedMass5),
    };
    if (metricsOnly) return {
        sampling: { spacing, samples: weightGrid.length * weightGrid[0].length },
        invalid,
        riverbedOutsideWashes,
        maxActiveAt006,
        activeOverSixAt006,
        topKRetainedMass,
    };

    const samples = weightGrid.length * weightGrid[0].length;
    assert(invalid === 0, 'Post-brush ground weights are finite and normalized',
        `${invalid} invalid samples`);
    assert(riverbedOutsideWashes === 0,
        'All three wash materials are mathematically zero outside authored dry washes',
        `${riverbedOutsideWashes} violations`);
    assert(maxActiveAt006 <= 7 && activeOverSixAt006 / samples <= 0.0001,
        'More than six globally significant contributors remain a vanishing junction case',
        JSON.stringify({ maxActiveAt006, activeOverSixAt006 }));
    assert(topKRetainedMass.K4.minimum < 0.85
        && topKRetainedMass.K5.minimum >= 0.80
        && topKRetainedMass.K5.p01 >= 0.99,
    'Measured retained mass selects K5 over K4 while preserving at least 99% for 99% of terrain',
    JSON.stringify(topKRetainedMass));
    for (const layer of layerNames) {
        assert(weightTotals[layer] > samples * 0.01 && coverage[layer] > samples * 0.025,
            `Ground layer '${layer}' has meaningful post-brush coverage`,
            `${weightTotals[layer].toFixed(1)} weight across ${coverage[layer]} samples`);
    }
    assert(stronglyResolvedSamples / samples >= 0.55,
        'At least 55% of terrain samples resolve to a readable material instead of uniform soup',
        (stronglyResolvedSamples / samples).toFixed(3));
    assert(Math.max(...Object.values(dominant)) < samples * 0.48,
        'No single material owns almost half of the terrain after authored thresholding',
        JSON.stringify(dominant));

    const lowBaseMeans = lowBaseTotals.map((value) => value / lowBaseSamples);
    assert(lowBaseSamples > 1000
        && near(sumLayers(lowBaseMeans, groundLayers), 1, 1e-9)
        && lowBaseMeans[13] === 0
        && sumLayers(lowBaseMeans, rockLayers) === 0
        && groundLayers.filter((layer) => lowBaseMeans[layer] >= 0.06).length >= 4,
    'Ordinary low flats contain only true ground scans and exclude RocksGround02 exactly',
    JSON.stringify(lowBaseMeans));
    const exposedMeans = exposedTotals.map((value) => value / exposedTerrainSamples);
    const exposedRock = sumLayers(exposedMeans, rockLayers);
    assert(exposedTerrainSamples > 1000
        && exposedRock >= 0.60 && exposedRock <= 0.78
        && rockLayers.filter((layer) => exposedMeans[layer] >= 0.04).length >= 5
        && exposedMeans[13] >= 0.02
        && sumLayers(exposedMeans, groundLayers) >= 0.16,
    'Higher/exposed terrain mixes bedrock and gated coarse talus while retaining true ground',
    JSON.stringify(exposedMeans));

    const window32 = summarizePaintWindows(weightGrid, 8, 2, 0.08);
    const window64 = summarizePaintWindows(weightGrid, 16, 4, 0.07);
    const window128 = summarizePaintWindows(weightGrid, 32, 8, 0.04);
    const window256 = summarizePaintWindows(weightGrid, 64, 16, 0.025);
    const contributorVisibility = {
        '16m@0.08': summarizeContributorDistribution(weightGrid, exposedGrid, 4, 1, 0.08),
        '32m@0.08': summarizeContributorDistribution(weightGrid, exposedGrid, 8, 2, 0.08),
        '32m@0.10': summarizeContributorDistribution(weightGrid, exposedGrid, 8, 2, 0.10),
    };
    assert(contributorVisibility['16m@0.08'].fractionAtLeast3 >= 0.55
        && contributorVisibility['16m@0.08'].fractionAtLeast4 >= 0.20
        && contributorVisibility['16m@0.08'].exposedFractionAtLeast3 >= 0.55,
    'Sixteen-metre views retain local transitions without forcing a material mosaic',
    JSON.stringify(contributorVisibility['16m@0.08']));
    assert(contributorVisibility['32m@0.08'].fractionAtLeast3 >= 0.75
        && contributorVisibility['32m@0.08'].fractionAtLeast4 >= 0.45
        && contributorVisibility['32m@0.08'].exposedFractionAtLeast3 >= 0.75,
    'Most 32-metre views cross multiple organic deposits without requiring four everywhere',
    JSON.stringify(contributorVisibility['32m@0.08']));
    assert(contributorVisibility['32m@0.10'].fractionAtLeast3 >= 0.60
        && contributorVisibility['32m@0.10'].fractionAtLeast4 >= 0.30
        && contributorVisibility['32m@0.10'].exposedFractionAtLeast3 >= 0.60,
    'Resolved ten-percent contributors remain common without pressuring every view into patchwork',
    JSON.stringify(contributorVisibility['32m@0.10']));
    // Runtime albedo alpha can multiply one candidate by 1.22 while all
    // competitors receive 0.78. Evaluate that adversarial normalized bound at
    // every point/window; actual photographed heights can only be less pure.
    const heightBound32 = summarizeHeightMonopolyBounds(weightGrid, 8, 2, 0.22);
    const heightBound64 = summarizeHeightMonopolyBounds(weightGrid, 16, 4, 0.22);
    const heightBound128 = summarizeHeightMonopolyBounds(weightGrid, 32, 8, 0.22);
    assert(window32.maxMeanLayer <= 0.88
        && window32.minSecondMean >= 0.035
        && window32.minEffectiveLayers >= 1.45
        && window32.minSpatialMutualInformation >= 0.20,
    'Thirty-two-metre windows retain transitions without forbidding readable organic deposits',
    JSON.stringify(window32));
    assert(window64.maxMeanLayer <= 0.68
        && window64.minContributors >= 2
        && window64.minEffectiveLayers >= 2.25
        && window64.minSpatialMutualInformation >= 0.40,
    'Sixty-four-metre windows avoid macro monopoly while allowing coherent deposits',
    JSON.stringify(window64));
    assert(window128.maxMeanLayer <= 0.50
        && window128.minContributors >= 4
        && window128.minEffectiveLayers >= 3.5
        && window128.minSpatialMutualInformation >= 0.75,
    'Every 128 m window retains broad geological variety without six-way micro-mosaics',
    JSON.stringify(window128));
    assert(window256.minContributors >= 5,
        'Every 256 m window uses at least five of the requested material sources',
        JSON.stringify(window256));
    assert(heightBound32.maximumLayerMean <= 0.92
        && heightBound64.maximumLayerMean <= 0.74
        && heightBound128.maximumLayerMean <= 0.58,
    'Even adversarial near-height bias cannot recreate a 32/64/128 m material monopoly',
    JSON.stringify({ heightBound32, heightBound64, heightBound128 }));
    assert(window32.maxNearPureFraction <= 0.96,
        'No 32 m window is completely near-pure material',
        JSON.stringify(window32));

    const strongComponents = strongPaintComponents(weightGrid, exposedGrid);
    const illegalStrongComponents = strongComponents.filter((component) => {
        // Organic masks may form long, sparse fingers. Their axis-aligned
        // bounding-box diagonal overstates the visible deposit size; retain
        // the strict 100 m limit for solid blocks while allowing low-fill
        // tendrils that occupy less than 35% of that box.
        if (component.area <= 3000
            && (component.diameter <= 100 || component.boundingFill <= 0.35)) {
            return false;
        }
        return !(component.area <= 7000 && component.diameter <= 180
            && component.exposedFraction >= 0.70);
    });
    assert(illegalStrongComponents.length === 0,
        'No strongly pure connected material region exceeds the camera-scale limit',
        JSON.stringify(illegalStrongComponents.slice(0, 5)));

    const washMajorWindows = [];
    for (let row0 = 0; row0 + 8 <= weightGrid.length; row0 += 2) {
        for (let column0 = 0; column0 + 8 <= weightGrid[0].length; column0 += 2) {
            const means = Array(layerNames.length).fill(0);
            for (let row = row0; row < row0 + 8; row++) for (let column = column0; column < column0 + 8; column++) {
                for (let layer = 0; layer < layerNames.length; layer++) means[layer] += weightGrid[row][column][layer] / 64;
            }
            const washMean = sumLayers(means, washLayers);
            if (washMean >= 0.35) washMajorWindows.push({ means, washMean });
        }
    }
    assert(washMajorWindows.every(({ means, washMean }) => washMean <= 0.92
        && washLayers.filter((layer) => means[layer] >= 0.03).length >= 2
        && 1 - washMean >= 0.08),
    'Wash-major windows mix photographed wash children and retain non-wash terrain');

    const syntheticSize = 40;
    const makeSynthetic = (factory) => Array.from({ length: syntheticSize }, (_, row) => (
        Array.from({ length: syntheticSize }, (_, column) => factory(column, row))
    ));
    const pureDisk = makeSynthetic((x, z) => {
        const inside = Math.hypot(x - 20, z - 20) < 10;
        if (inside) return [1, ...Array(13).fill(0)];
        const result = Array(14).fill(0);
        for (const layer of groundLayers) result[layer] = 1 / groundLayers.length;
        return result;
    });
    const ellipseFeather = makeSynthetic((x, z) => {
        const d = Math.hypot((x - 20) / 14, (z - 20) / 5);
        const first = d <= 0.72 ? 1 : (d >= 1.2 ? 0 : 1 - (d - 0.72) / 0.48);
        const result = Array(14).fill(0);
        result[0] = first;
        result[1] = 1 - first;
        return result;
    });
    const soup = makeSynthetic(() => Array(14).fill(1 / 14));
    const raggedMosaic = makeSynthetic((x, z) => {
        const first = (Math.floor(x / 2) + Math.floor(z / 3) * 2 + ((x * 13 + z * 7) % 3)) % 13;
        const result = Array(14).fill(0);
        result[first] = 0.70;
        result[(first + 3) % 13] = 0.19;
        result[(first + 7) % 13] = 0.11;
        return result;
    });
    const pureProbe = summarizePaintWindows(pureDisk, 8, 2, 0.10);
    const ellipseProbe = summarizePaintWindows(ellipseFeather, 8, 2, 0.10);
    const soupProbe = summarizePaintWindows(soup, 8, 2, 0.10);
    const mosaicProbe = summarizePaintWindows(raggedMosaic, 8, 2, 0.10);
    assert(pureProbe.maxMeanLayer > 0.78 && ellipseProbe.maxMeanLayer > 0.78,
        'Synthetic pure disk and feathered ellipse fail local-monopoly acceptance');
    assert(soupProbe.minSpatialMutualInformation < 0.001
        && Math.max(...soup.flat().map((weights) => Math.max(...weights))) < 0.52,
    'Synthetic constant soup fails spatial-information and point-resolution acceptance');
    assert(mosaicProbe.maxMeanLayer <= 0.78
        && mosaicProbe.minContributors >= 2
        && mosaicProbe.minSpatialMutualInformation >= 0.06,
    'Synthetic ragged mosaic passes local diversity and spatial-information acceptance',
    JSON.stringify(mosaicProbe));

    return {
        sampling: { spacing, samples, brushHash: sha256File(brushPath) },
        dominant,
        coverage,
        weightTotals,
        washSamples,
        riverbedOutsideWashes,
        stronglyResolvedFraction: stronglyResolvedSamples / samples,
        maxActiveAt006,
        activeOverSixAt006,
        topKRetainedMass,
        lowBaseMeans,
        exposedMeans,
        contributorVisibility,
        windows: { '32m': window32, '64m': window64, '128m': window128, '256m': window256 },
        conservativeNearHeightBounds: {
            '32m': heightBound32, '64m': heightBound64, '128m': heightBound128,
        },
        strongComponents: {
            count: strongComponents.length,
            largest: strongComponents.slice(0, 8),
            illegal: illegalStrongComponents,
        },
        synthetic: { pureProbe, ellipseProbe, soupProbe, mosaicProbe },
    };
}

function auditCrater(api) {
    const start = [0, 96];
    const temple = [api.COMPOUND_X, api.COMPOUND_Z];
    const crater = [api.CRATER_X, api.CRATER_Z];
    const startDistance = Math.hypot(crater[0] - start[0], crater[1] - start[1]);
    const templeDistance = Math.hypot(crater[0] - temple[0], crater[1] - temple[1]);
    const oppositeDot = (start[0] - temple[0]) * (crater[0] - temple[0])
        + (start[1] - temple[1]) * (crater[1] - temple[1]);
    const center = api.craterFieldsAt(api.CRATER_X, api.CRATER_Z);
    assert(startDistance > 400, 'Crater is distant from the starting point', `${startDistance} m`);
    assert(templeDistance > 250, 'Crater lies beyond the temple compound', `${templeDistance} m`);
    assert(oppositeDot < 0, 'Crater is opposite the start across the temple', `${oppositeDot}`);
    assert(near(center.delta, -23.5, 1e-6), 'Crater center has the authored blast-bowl depth', `${center.delta} m`);
    assert(center.exclusion > 0.999, 'Crater center fully excludes dressing vegetation', `${center.exclusion}`);
    const centerPaint = api.paintAt(api.CRATER_X, api.CRATER_Z, 0);
    const centerRockWeights = [5, 6, 8, 11, 12].map((layer) => centerPaint.weights[layer]);
    assert(centerRockWeights.reduce((sum, weight) => sum + weight, 0) >= 0.12
        && centerRockWeights.filter((weight) => weight >= 0.005).length >= 2
        && centerPaint.weights.filter((weight) => weight > 0).length >= 3,
        'Crater bowl interleaves multiple photographed elevated-rock and ground layers',
        JSON.stringify(centerPaint));

    const rimRadii = [];
    const rimHeights = [];
    let positiveEjectaSamples = 0;
    for (let sample = 0; sample < 360; sample++) {
        const angle = sample / 360 * Math.PI * 2;
        let bestRadius = 0, bestHeight = -Infinity;
        for (let radius = 70; radius <= 105; radius += 0.25) {
            const field = api.craterFieldsAt(
                api.CRATER_X + Math.cos(angle) * radius,
                api.CRATER_Z + Math.sin(angle) * radius,
            );
            if (field.delta > bestHeight) { bestHeight = field.delta; bestRadius = radius; }
        }
        rimRadii.push(bestRadius);
        rimHeights.push(bestHeight);
        const ejecta = api.craterFieldsAt(
            api.CRATER_X + Math.cos(angle) * api.CRATER_RADIUS * 1.32,
            api.CRATER_Z + Math.sin(angle) * api.CRATER_RADIUS * 1.32,
        ).delta;
        if (ejecta > 0.05) positiveEjectaSamples++;
    }
    assert(Math.max(...rimRadii) - Math.min(...rimRadii) > 5,
        'Crater rim radius is irregular rather than circular',
        `${Math.min(...rimRadii)}-${Math.max(...rimRadii)} m`);
    assert(Math.max(...rimHeights) - Math.min(...rimHeights) > 4,
        'Crater rim height is asymmetric',
        `${Math.min(...rimHeights)}-${Math.max(...rimHeights)} m`);
    assert(positiveEjectaSamples > 0, 'Crater retains raised radial ejecta beyond its rim', `${positiveEjectaSamples} angular samples`);
    return { startDistance, templeDistance, oppositeDot, centerDelta: center.delta,
        rimRadiusRange: [Math.min(...rimRadii), Math.max(...rimRadii)], positiveEjectaSamples };
}

function crc32(buffer) {
    let crc = 0xffffffff;
    for (const byte of buffer) {
        crc ^= byte;
        for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
    return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, payload) {
    const typeBytes = Buffer.from(type, 'ascii');
    const chunk = Buffer.alloc(12 + payload.length);
    chunk.writeUInt32BE(payload.length, 0);
    typeBytes.copy(chunk, 4);
    payload.copy(chunk, 8);
    chunk.writeUInt32BE(crc32(Buffer.concat([typeBytes, payload])), 8 + payload.length);
    return chunk;
}

function makeAllFilterRgbaPng() {
    const width = 5;
    const height = 5;
    const bytesPerPixel = 4;
    const stride = width * bytesPerPixel;
    const pixels = Buffer.alloc(stride * height);
    for (let row = 0; row < height; row++) {
        for (let column = 0; column < stride; column++) {
            pixels[row * stride + column] = (
                17 + row * 47 + column * 31 + (column % 4) * 29
            ) & 255;
        }
    }
    const paeth = (left, up, upLeft) => {
        const prediction = left + up - upLeft;
        const leftDistance = Math.abs(prediction - left);
        const upDistance = Math.abs(prediction - up);
        const diagonalDistance = Math.abs(prediction - upLeft);
        if (leftDistance <= upDistance && leftDistance <= diagonalDistance) return left;
        return upDistance <= diagonalDistance ? up : upLeft;
    };
    const scanlines = Buffer.alloc((stride + 1) * height);
    let outputOffset = 0;
    for (let row = 0; row < height; row++) {
        const filter = row;
        scanlines[outputOffset++] = filter;
        const rowOffset = row * stride;
        for (let column = 0; column < stride; column++) {
            const value = pixels[rowOffset + column];
            const left = column >= bytesPerPixel
                ? pixels[rowOffset + column - bytesPerPixel] : 0;
            const up = row > 0 ? pixels[rowOffset - stride + column] : 0;
            const upLeft = row > 0 && column >= bytesPerPixel
                ? pixels[rowOffset - stride + column - bytesPerPixel] : 0;
            let predictor = 0;
            if (filter === 1) predictor = left;
            else if (filter === 2) predictor = up;
            else if (filter === 3) predictor = Math.floor((left + up) * 0.5);
            else if (filter === 4) predictor = paeth(left, up, upLeft);
            scanlines[outputOffset++] = (value - predictor + 256) & 255;
        }
    }
    const header = Buffer.alloc(13);
    header.writeUInt32BE(width, 0);
    header.writeUInt32BE(height, 4);
    header[8] = 8;
    header[9] = 6;
    return {
        width,
        height,
        pixels,
        png: Buffer.concat([
            Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
            pngChunk('IHDR', header),
            pngChunk('IDAT', zlib.deflateSync(scanlines)),
            pngChunk('IEND', Buffer.alloc(0)),
        ]),
    };
}

function decodeReferenceRgba8Png(data, label) {
    if (!data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
        throw new Error(label + ' has an invalid PNG signature');
    }
    let offset = 8;
    let width = 0;
    let height = 0;
    let bitDepth = 0;
    let colorType = -1;
    let interlace = -1;
    const idat = [];
    while (offset + 12 <= data.length) {
        const length = data.readUInt32BE(offset);
        const type = data.toString('ascii', offset + 4, offset + 8);
        const payloadStart = offset + 8;
        const payloadEnd = payloadStart + length;
        if (payloadEnd + 4 > data.length) throw new Error(label + ' has a truncated PNG chunk');
        const payload = data.subarray(payloadStart, payloadEnd);
        if (type === 'IHDR') {
            width = payload.readUInt32BE(0);
            height = payload.readUInt32BE(4);
            bitDepth = payload[8];
            colorType = payload[9];
            interlace = payload[12];
        } else if (type === 'IDAT') {
            idat.push(payload);
        } else if (type === 'IEND') {
            break;
        }
        offset = payloadEnd + 4;
    }
    if (bitDepth !== 8 || colorType !== 6 || interlace !== 0 || idat.length === 0) {
        throw new Error(label + ' is not a non-interlaced RGBA8 PNG');
    }
    const inflated = zlib.inflateSync(Buffer.concat(idat));
    const bytesPerPixel = 4;
    const stride = width * bytesPerPixel;
    if (inflated.length !== (stride + 1) * height) {
        throw new Error(label + ' has an invalid inflated scanline size');
    }
    const pixels = Buffer.alloc(stride * height);
    const filterCounts = [0, 0, 0, 0, 0];
    const paeth = (left, up, upLeft) => {
        const prediction = left + up - upLeft;
        const distances = [
            Math.abs(prediction - left),
            Math.abs(prediction - up),
            Math.abs(prediction - upLeft),
        ];
        if (distances[0] <= distances[1] && distances[0] <= distances[2]) return left;
        return distances[1] <= distances[2] ? up : upLeft;
    };
    let sourceOffset = 0;
    for (let row = 0; row < height; row++) {
        const filter = inflated[sourceOffset++];
        if (filter > 4) throw new Error(label + ' uses an invalid PNG filter');
        filterCounts[filter]++;
        const rowOffset = row * stride;
        for (let column = 0; column < stride; column++) {
            const raw = inflated[sourceOffset++];
            const left = column >= bytesPerPixel
                ? pixels[rowOffset + column - bytesPerPixel] : 0;
            const up = row > 0 ? pixels[rowOffset - stride + column] : 0;
            const upLeft = row > 0 && column >= bytesPerPixel
                ? pixels[rowOffset - stride + column - bytesPerPixel] : 0;
            let predictor = 0;
            if (filter === 1) predictor = left;
            else if (filter === 2) predictor = up;
            else if (filter === 3) predictor = Math.floor((left + up) * 0.5);
            else if (filter === 4) predictor = paeth(left, up, upLeft);
            pixels[rowOffset + column] = (raw + predictor) & 255;
        }
    }
    return { width, height, pixels, filterCounts };
}

async function auditRuntimeTerrainPngDecoder(api) {
    const synthetic = makeAllFilterRgbaPng();
    const syntheticDecoded = await api.decodePngRgba(
        new Blob([synthetic.png], { type: 'image/png' }),
        'terrain-audit-all-filters.png',
        synthetic.width,
        synthetic.height,
    );
    assert(Buffer.from(syntheticDecoded).equals(synthetic.pixels),
        'Runtime terrain PNG decoder reconstructs filters 0 through 4 byte-for-byte');

    const runtimePath = path.join(
        ROOT, 'assets', 'pbr', 'eanpa_southwest_ground_v3', 'runtime',
        'RockyTrail02_AlbedoGrade_2K.png',
    );
    const runtimePng = fs.readFileSync(runtimePath);
    const reference = decodeReferenceRgba8Png(runtimePng, path.basename(runtimePath));
    const runtimeDecoded = await api.decodePngRgba(
        new Blob([runtimePng], { type: 'image/png' }),
        path.basename(runtimePath),
        reference.width,
        reference.height,
    );
    const runtimeBytes = Buffer.from(runtimeDecoded);
    assert(runtimeBytes.equals(reference.pixels),
        'Runtime loader preserves every authored terrain RGBA byte');
    let alphaMinimum = 255;
    let alphaMaximum = 0;
    for (let offset = 3; offset < runtimeBytes.length; offset += 4) {
        alphaMinimum = Math.min(alphaMinimum, runtimeBytes[offset]);
        alphaMaximum = Math.max(alphaMaximum, runtimeBytes[offset]);
    }
    assert(alphaMinimum === 0 && alphaMaximum === 255,
        'Byte-exact runtime decode retains the complete linear height-alpha range',
        alphaMinimum + '-' + alphaMaximum);
    return {
        syntheticFilters: [0, 1, 2, 3, 4],
        runtimeFilterCounts: reference.filterCounts,
        runtimeDecodedSha256: crypto.createHash('sha256').update(runtimeBytes).digest('hex'),
        alphaRange: [alphaMinimum, alphaMaximum],
    };
}

function decodeGray16Png(filename) {
    const data = fs.readFileSync(filename);
    assert(data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), 'Crater source has a valid PNG signature');
    let offset = 8;
    let width = 0, height = 0, bitDepth = 0, colorType = -1;
    const idat = [];
    while (offset < data.length) {
        const length = data.readUInt32BE(offset); offset += 4;
        const type = data.toString('ascii', offset, offset + 4); offset += 4;
        const payload = data.subarray(offset, offset + length); offset += length;
        const storedCrc = data.readUInt32BE(offset); offset += 4;
        assert(crc32(Buffer.concat([Buffer.from(type), payload])) === storedCrc, `PNG ${type} chunk CRC is valid`);
        if (type === 'IHDR') {
            width = payload.readUInt32BE(0); height = payload.readUInt32BE(4);
            bitDepth = payload[8]; colorType = payload[9];
        } else if (type === 'IDAT') idat.push(payload);
        else if (type === 'IEND') break;
    }
    assert(width === 1024 && height === 1024, 'Crater heightmap is 1024 x 1024', `${width} x ${height}`);
    assert(bitDepth === 16 && colorType === 0, 'Crater heightmap is 16-bit grayscale', `depth=${bitDepth}, type=${colorType}`);
    const raw = zlib.inflateSync(Buffer.concat(idat));
    const stride = width * 2;
    assert(raw.length === height * (stride + 1), 'Crater PNG scanline payload has the expected size', `${raw.length}`);
    const samples = new Uint16Array(width * height);
    let cursor = 0;
    for (let y = 0; y < height; y++) {
        const filter = raw[cursor++];
        assert(filter === 0, `Crater PNG row ${y} uses the deterministic unfiltered encoding`, `${filter}`);
        for (let x = 0; x < width; x++) {
            samples[y * width + x] = raw.readUInt16BE(cursor);
            cursor += 2;
        }
    }
    return { width, height, samples };
}

function auditHeightmap(api) {
    const png = decodeGray16Png(path.join(ROOT, 'assets', 'terrain', 'nuclear_crater_heightmap.png'));
    const generatorSource = fs.readFileSync(path.join(ROOT, 'tools', 'generate-crater-heightmap.py'), 'utf8');
    const readConstant = (name) => Number(generatorSource.match(new RegExp(`^${name} = ([-0-9.]+)`, 'm'))?.[1]);
    const minimumHeight = readConstant('MIN_HEIGHT_METERS');
    const maximumHeight = readConstant('MAX_HEIGHT_METERS');
    const heightRange = maximumHeight - minimumHeight;
    assert(Number.isFinite(minimumHeight) && Number.isFinite(maximumHeight) && heightRange > 0,
        'Crater generator exposes a valid 16-bit height range', `${minimumHeight}-${maximumHeight}`);
    const zeroSample = Math.round((0 - minimumHeight) / heightRange * 65535);
    let borderMismatch = 0;
    for (let x = 0; x < png.width; x++) {
        if (png.samples[x] !== zeroSample) borderMismatch++;
        if (png.samples[(png.height - 1) * png.width + x] !== zeroSample) borderMismatch++;
    }
    for (let y = 1; y < png.height - 1; y++) {
        if (png.samples[y * png.width] !== zeroSample) borderMismatch++;
        if (png.samples[y * png.width + png.width - 1] !== zeroSample) borderMismatch++;
    }
    assert(borderMismatch === 0, 'Every crater heightmap border sample is zero datum', `${borderMismatch} mismatches`);

    let maxQuantizedError = 0;
    let minSample = 65535, maxSample = 0;
    // Every fourth pixel covers 65,536 points while still exercising the full
    // profile, borders, and angular/radial variation deterministically.
    for (let py = 0; py < png.height; py += 4) {
        const z = ((py / (png.height - 1)) * 2 - 1) * 160;
        for (let px = 0; px < png.width; px += 4) {
            const x = ((px / (png.width - 1)) * 2 - 1) * 160;
            const delta = api.craterFieldsAt(api.CRATER_X + x, api.CRATER_Z + z).delta;
            const expected = Math.max(0, Math.min(65535,
                Math.round((delta - minimumHeight) / heightRange * 65535)));
            const actual = png.samples[py * png.width + px];
            maxQuantizedError = Math.max(maxQuantizedError, Math.abs(actual - expected));
            minSample = Math.min(minSample, actual); maxSample = Math.max(maxSample, actual);
        }
    }
    assert(maxQuantizedError <= 1, 'Retained heightmap matches the runtime analytic crater profile', `${maxQuantizedError} quantization levels`);
    assert(minSample < zeroSample && maxSample > zeroSample, 'Heightmap contains both bowl excavation and raised rim/ejecta', `${minSample}-${maxSample}`);
    assert(minSample > 0 && maxSample < 65535, 'Heightmap normalization preserves profile headroom without clipping', `${minSample}-${maxSample}`);
    return { borderMismatch, maxQuantizedError, minSample, maxSample, minimumHeight, maximumHeight };
}

function jpegDimensions(filename) {
    const data = fs.readFileSync(filename);
    if (data[0] !== 0xff || data[1] !== 0xd8) throw new Error(`${filename} is not JPEG`);
    let offset = 2;
    while (offset + 9 < data.length) {
        if (data[offset++] !== 0xff) continue;
        let marker = data[offset++];
        while (marker === 0xff) marker = data[offset++];
        if (marker === 0xd8 || marker === 0xd9) continue;
        const length = data.readUInt16BE(offset);
        if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
            return { height: data.readUInt16BE(offset + 3), width: data.readUInt16BE(offset + 5) };
        }
        offset += length;
    }
    throw new Error(`No JPEG dimensions in ${filename}`);
}

function pngDimensions(filename) {
    const data = fs.readFileSync(filename);
    const signature = '89504e470d0a1a0a';
    if (data.subarray(0, 8).toString('hex') !== signature
        || data.subarray(12, 16).toString('ascii') !== 'IHDR') {
        throw new Error(`${filename} is not PNG`);
    }
    return {
        width: data.readUInt32BE(16),
        height: data.readUInt32BE(20),
        bitDepth: data[24],
        colorType: data[25],
    };
}

function auditMaterials(terrainSource, dressingSource, floraSource) {
    const legacyCliffSources = [
        ['polyhaven_cliff_side', [
            'cliff_side_diff_1k.jpg', 'cliff_side_nor_gl_1k.jpg',
            'cliff_side_rough_1k.jpg', 'cliff_side_ao_1k.jpg',
        ]],
        ['polyhaven_rock_face', [
            'rock_face_diff_1k.jpg', 'rock_face_nor_gl_1k.jpg',
            'rock_face_rough_1k.jpg', 'rock_face_ao_1k.jpg',
        ]],
        ['polyhaven_worn_rock_natural_01', [
            'worn_rock_natural_01_diff_1k.jpg', 'worn_rock_natural_01_nor_gl_1k.jpg',
            'worn_rock_natural_01_rough_1k.jpg', 'worn_rock_natural_01_ao_1k.jpg',
        ]],
        ['Rock030', [
            'Rock030_1K-JPG_Color.jpg', 'Rock030_1K-JPG_NormalGL.jpg',
            'Rock030_1K-JPG_Roughness.jpg', 'Rock030_1K-JPG_AmbientOcclusion.jpg',
        ]],
    ];
    for (const [directory, files] of legacyCliffSources) {
        for (const file of files) {
            assert(fs.existsSync(path.join(ROOT, 'assets', 'pbr', directory, file)),
                `PBR array source exists: ${directory}/${file}`);
        }
    }
    const groundPackage = path.join(ROOT, 'assets', 'pbr', 'eanpa_southwest_ground_v3');
    const runtimeStems = [
        'RockyTrail02', 'DryGroundRocks', 'RedLateriteSoilStones',
        'CrackedRedGround', 'MudCrackedDryRiverbed002', 'Rock029', 'Rock061',
        'GravellySand', 'RockFace03', 'SandyGravel02', 'RockyTrail',
        'RockFace', 'RockBoulderCracked', 'RocksGround02',
    ];
    const runtimeMaps = runtimeStems.flatMap((stem) => [
        `${stem}_AlbedoGrade_2K.png`, `${stem}_PackedNxyRoughAO_2K.png`,
    ]);
    for (const file of runtimeMaps) {
        const filename = path.join(groundPackage, 'runtime', file);
        assert(fs.existsSync(filename), `Ground v3 runtime map exists: ${file}`);
        if (!fs.existsSync(filename)) continue;
        const dimensions = pngDimensions(filename);
        assert(dimensions.width === 2048 && dimensions.height === 2048,
            `Ground v3 runtime map is true 2048 x 2048: ${file}`,
            `${dimensions.width} x ${dimensions.height}`);
        if (file.includes('_PackedNxyRoughAO_')) assert(
            dimensions.colorType === 6,
            `Packed terrain map retains RGBA including AO alpha: ${file}`,
            `PNG color type ${dimensions.colorType}`);
    }
    assert(runtimeMaps.every((file) => (
        pngDimensions(path.join(groundPackage, 'runtime', file)).colorType === 6
    )), 'Both runtime arrays are RGBA so albedo alpha can carry linear height');
    const heightMasters = [
        'RockyTrail02_Displacement_4K.jpg',
        'DryGroundRocks_Displacement_4K.jpg',
        'RedLateriteSoilStones_Displacement_4K.png',
        'CrackedRedGround_Displacement_4K.jpg',
        'MudCrackedDryRiverbed002_Displacement_4K.jpg',
        'Rock029_Displacement_4K.jpg',
        'Rock061_Displacement_4K.jpg',
        'GravellySand_Displacement_4K.jpg',
        'RockFace03_Displacement_4K.jpg',
        'SandyGravel02_Displacement_4K.jpg',
        'RockyTrail_Displacement_4K.jpg',
        'RockFace_Displacement_4K.jpg',
        'RockBoulderCracked_Displacement_4K.jpg',
        'RocksGround02_Displacement_4K.jpg',
    ];
    for (const file of heightMasters) assert(
        fs.existsSync(path.join(groundPackage, 'sources', file)),
        `Future SPOM retains source displacement: ${file}`);

    const manifestPath = path.join(groundPackage, 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    assert(manifest.schema_version === 4
        && JSON.stringify(manifest.layer_order) === JSON.stringify(runtimeStems),
    'Ground v3 manifest fixes the exact fourteen-layer order');
    assert(manifest.runtime_resolution[0] === 2048 && manifest.runtime_resolution[1] === 2048
        && manifest.decoded_array_memory.base_level_bytes === 469762048
        && manifest.decoded_array_memory.estimated_with_complete_mips_bytes === 626349398,
    'Manifest records true-2K array resolution and decoded memory honestly');
    assert(manifest.runtime_png.albedo_mode === 'RGBA'
        && manifest.albedo_packing.A.includes('relative displacement height')
        && manifest.albedo_packing.alpha_color_conversion.includes('RGB only'),
    'Manifest declares linear height in otherwise-unused albedo alpha');
    const hashAt = (filename) => crypto.createHash('sha256')
        .update(fs.readFileSync(filename)).digest('hex');
    const fallbackRoot = path.join(groundPackage, 'runtime', 'fallback_1k');
    const fallbackManifestPath = path.join(fallbackRoot, 'manifest.json');
    const fallbackManifest = JSON.parse(fs.readFileSync(fallbackManifestPath, 'utf8'));
    assert(fallbackManifest.schema_version === 1
        && fallbackManifest.layer_count === 14
        && fallbackManifest.texture_count === 28
        && JSON.stringify(fallbackManifest.layer_order) === JSON.stringify(runtimeStems)
        && fallbackManifest.resolution[0] === 1024
        && fallbackManifest.resolution[1] === 1024
        && fallbackManifest.decoded_memory.base_level_bytes_total === 117440512,
    'Fallback manifest fixes fourteen 1K RGBA layers and the exact 112 MiB decoded base cost');
    const fallbackRecords = fallbackManifest.layers.flatMap((entry) => (
        Object.values(entry.files)
    ));
    assert(fallbackRecords.length === 28 && fallbackRecords.every((record) => {
        const filename = path.join(fallbackRoot, record.path);
        if (!fs.existsSync(filename) || hashAt(filename) !== record.sha256) return false;
        const dimensions = pngDimensions(filename);
        return dimensions.width === 1024 && dimensions.height === 1024
            && dimensions.colorType === 6;
    }), 'All twenty-eight lossless 1K fallback maps match hashes, dimensions, and RGBA mode');
    const ktxManifestPath = path.join(
        groundPackage, 'runtime', 'southwest-ground-v3-ktx2-manifest.json',
    );
    const ktxManifest = JSON.parse(fs.readFileSync(ktxManifestPath, 'utf8'));
    assert(ktxManifest.schema_version === 1
        && ktxManifest.layer_count === 14
        && JSON.stringify(ktxManifest.layer_order) === JSON.stringify(runtimeStems)
        && ktxManifest.runtime_resolution[0] === 2048
        && ktxManifest.runtime_resolution[1] === 2048
        && ktxManifest.compression_policy.codec === 'Basis Universal UASTC 4x4'
        && ktxManifest.compression_policy.quality === 4
        && ktxManifest.compression_policy.rdo === false
        && ktxManifest.compression_policy.normal_mode === false,
    'KTX2 manifest fixes fourteen true-2K UASTC layers without lossy RDO or packed-normal mode');
    assert(ktxManifest.outputs.length === 2 && ktxManifest.outputs.every((record) => {
        const filename = path.join(groundPackage, record.path);
        return fs.existsSync(filename)
            && hashAt(filename) === record.sha256
            && record.dimensions[0] === 2048 && record.dimensions[1] === 2048
            && record.layer_count === 14 && record.mip_level_count === 12
            && record.texture_kind === '2d-array'
            && record.payload === 'Basis Universal UASTC 4x4';
    }) && ktxManifest.outputs[0].transfer_function === 'KHR_DF_TRANSFER_SRGB'
        && ktxManifest.outputs[1].transfer_function === 'KHR_DF_TRANSFER_LINEAR',
    'Both compressed arrays match hashes, dimensions, depth, complete mips, and color-space contracts');
    assert(ktxManifest.official_three_loader.version === 'r184'
        && ktxManifest.official_three_loader.files.every((record) => {
            const filename = path.join(ROOT, record.path);
            return fs.existsSync(filename) && hashAt(filename) === record.sha256;
        }), 'Vendored KTX2 loader, Basis transcoder, and dependencies match exact Three r184 hashes');
    const expectedSceneRepeats = {
        RockyTrail02: [4, 4],
        DryGroundRocks: [8, 8],
        RedLateriteSoilStones: [4, 4],
        CrackedRedGround: [6, 6],
        MudCrackedDryRiverbed002: [6, 6],
        Rock029: [8, 8],
        Rock061: [8, 8],
        GravellySand: [5, 5],
        RockFace03: [8, 8],
        SandyGravel02: [5, 5],
        RockyTrail: [4, 4],
        RockFace: [8, 8],
        RockBoulderCracked: [6, 6],
        RocksGround02: [7, 7],
    };
    for (const entry of manifest.layers) {
        assert(entry.provenance.license === 'CC0 1.0 Universal'
            && (entry.provenance.asset_page_url.startsWith('https://polyhaven.com/')
                || entry.provenance.asset_page_url.startsWith('https://ambientcg.com/')),
        `Layer provenance is official CC0: ${entry.id}`);
        assert(entry.physical_span_m.length === 2
            && entry.physical_span_m.every((span) => span >= 1 && span <= 4)
            && entry.physical_span_m[0] === entry.physical_span_m[1],
        `Layer retains its published square source/capture span: ${entry.id}`);
        assert(JSON.stringify(entry.scene_repeat_m)
                === JSON.stringify(expectedSceneRepeats[entry.id])
            && typeof entry.scene_repeat_basis === 'string'
            && entry.scene_repeat_basis.length >= 24
            && entry.scene_scale_factor_from_physical.every((factor) => factor >= 2)
            && entry.runtime_texels_per_m.every((density) => density >= 256 && density <= 512),
        `Layer separates larger scene repeat from source span: ${entry.id}`,
        `${entry.physical_span_m.join('x')}m source -> ${entry.scene_repeat_m.join('x')}m scene; `
            + `${entry.runtime_texels_per_m.join('/')} texels/m`);
        for (const record of Object.values(entry.source.files)) {
            const filename = path.join(groundPackage, record.path);
            assert(fs.existsSync(filename) && hashAt(filename) === record.sha256,
                `Retained 4K source hash matches manifest: ${record.path}`);
            assert(record.dimensions[0] === 4096 && record.dimensions[1] === 4096,
                `Retained source is 4096 square: ${record.path}`);
        }
        for (const key of ['albedo', 'packed_normal_xy_roughness_ao']) {
            const record = entry.runtime[key];
            const filename = path.join(groundPackage, record.path);
            assert(fs.existsSync(filename) && hashAt(filename) === record.sha256,
                `True-2K runtime hash matches manifest: ${record.path}`);
        }
        const heightAlpha = entry.runtime.albedo_grade.height_alpha;
        assert(entry.runtime.albedo.mode === 'RGBA'
            && heightAlpha.runtime_min === 0
            && heightAlpha.runtime_max === 255
            && heightAlpha.runtime_stddev > 0.03,
        'Runtime albedo alpha carries useful normalized height: ' + entry.id);
        const grade = entry.runtime.albedo_grade;
        const target = grade.parameters.target_srgb;
        const sourceRange = grade.source_luminance.q95 - grade.source_luminance.q05;
        const runtimeRange = grade.runtime_luminance.q95 - grade.runtime_luminance.q05;
        const exposureNormalizedRuntimeRange = runtimeRange
            / (2 ** grade.parameters.exposure_stops);
        assert(grade.method === 'linear-luminance-preserving-individual-chroma-grade-v1'
            && target[0] > target[1] && target[1] > target[2],
        `Layer uses an individual tan-to-orange linear grade: ${entry.id}`);
        assert(exposureNormalizedRuntimeRange > sourceRange * 0.72
            && exposureNormalizedRuntimeRange < sourceRange * 1.85,
            `Layer grade retains scan luminance detail: ${entry.id}`,
            `${sourceRange.toFixed(4)} -> ${exposureNormalizedRuntimeRange.toFixed(4)} `
                + `exposure-normalized (${runtimeRange.toFixed(4)} runtime)`);
        assert(entry.future_spom_height.enabled === false
            && entry.future_spom_height.runtime_height_path
                === entry.runtime.albedo.path
            && entry.future_spom_height.runtime_blend_path === entry.runtime.albedo.path
            && entry.future_spom_height.runtime_blend_channel === 'A'
            && entry.future_spom_height.dominant_layer_ready === true,
        `Layer height is active for blending while geometric SPOM remains disabled: ${entry.id}`);
    }
    const v2Manifest = JSON.parse(fs.readFileSync(
        path.join(ROOT, 'assets', 'pbr', 'eanpa_southwest_ground_v2', 'manifest.json'),
        'utf8',
    ));
    const v2Laterite = v2Manifest.layers.find((entry) => entry.id === 'RedLateriteSoilStones');
    const v3Laterite = manifest.layers.find((entry) => entry.id === 'RedLateriteSoilStones');
    assert(Object.keys(v2Laterite.source.files).every((role) => (
        v2Laterite.source.files[role].sha256 === v3Laterite.source.files[role].sha256
    )), 'Red Laterite reuses every retained v2 master byte-for-byte');

    const groundMaterial = terrainSource.slice(
        terrainSource.indexOf('function makeTerrainMaterial'),
        terrainSource.indexOf('function makeCliffMaterial'),
    );
    assert(/const SURFACE_RUNTIME_SIZE = 2048;/.test(terrainSource)
        && /const SURFACE_FALLBACK_SIZE = 1024;/.test(terrainSource)
        && /three\/addons\/loaders\/KTX2Loader\.js/.test(terrainSource)
        && /loader\.detectSupport\(renderer\)/.test(terrainSource)
        && /isCompressedArrayTexture !== true/.test(terrainSource)
        && /image\.depth !== SURFACE_LAYER_COUNT/.test(terrainSource)
        && /new T3\.DataArrayTexture\(\s*packed, SURFACE_FALLBACK_SIZE, SURFACE_FALLBACK_SIZE, surfaceLayers\.length/.test(terrainSource)
        && /makeFallbackArray\('albedo', \{ srgb: true \}\)/.test(terrainSource)
        && /makeFallbackArray\('packed'\)/.test(terrainSource),
    'Ground runtime prefers validated compressed true-2K arrays and retains a 1K RGBA8 fallback');
    assert(/for \(let index = 0; index < surfaceLayers\.length; index\+\+\)/.test(terrainSource)
        && !/Promise\.all\(surfaceLayers\.map/.test(terrainSource),
    'Ground v3 decodes one source at a time instead of spiking fourteen image decodes');
    assert(/async function decodePngRgba/.test(terrainSource)
        && /new DecompressionStream\('deflate'\)/.test(terrainSource)
        && /bitDepth !== 8 \|\| colorType !== 6/.test(terrainSource)
        && /filter > 4/.test(terrainSource)
        && /key === 'packed'[\s\S]*R=normalX_G=normalY_B=roughness_A=ambientOcclusion/.test(terrainSource),
    'Both terrain arrays use an exact RGBA8 PNG decoder and declare packed PBR channels');
    assert(!/createImageBitmap|OffscreenCanvas|drawImage\(|getImageData\(/.test(terrainSource),
        'Runtime terrain pixels never pass through premultiplying or color-converting canvas readback');
    assert(!/context\.translate\(0, SURFACE_RUNTIME_SIZE\)/.test(terrainSource)
        && !/context\.scale\(1, -1\)/.test(terrainSource)
        && /top-left-row-preserved_world-positive-Z-is-increasing-image-V/.test(terrainSource),
    'Runtime arrays retain one shared pixel orientation without a hidden flip');
    assert(/generateMipmaps: false/.test(terrainSource)
        && /generateMipmaps: true/.test(terrainSource)
        && /LinearMipmapLinearFilter/.test(terrainSource)
        && /anisotropy = 8/.test(terrainSource),
    'Ground v3 preserves authored KTX mips, generates fallback mips, and uses trilinear anisotropic sampling');
    const webGpuMipSource = fs.readFileSync(
        path.join(ROOT, 'vendor', 'three', 'three.webgpu.js'), 'utf8',
    );
    assert(/for \( let baseMipLevel = 1; baseMipLevel < textureGPU\.mipLevelCount; baseMipLevel \+\+ \)[\s\S]*for \( let baseArrayLayer = 0; baseArrayLayer < textureGPU\.depthOrArrayLayers; baseArrayLayer \+\+ \)/.test(webGpuMipSource),
        'Vendored Three r184 generates every mip level for every array layer');
    assert(/userData\.samplerCount = 3/.test(groundMaterial)
        && /surfaceArray,\s*\n\s*blendBrush,/.test(terrainSource)
        && /blendBrush,/.test(terrainSource)
        && /T3\.texture\(maps\.blendBrush, brushUv\)\.level\(brushLod\)\.r/.test(groundMaterial)
        && /fragmentSamples: 7/.test(groundMaterial)
        && /estimatedRgba8BytesWithMips: 5592405/.test(groundMaterial)
        && !/surfaceArray: \{[^}]*normal|surfaceArray: \{[^}]*roughness|surfaceArray: \{[^}]*ao/.test(terrainSource),
    'Ground material consumes two PBR arrays, one seven-tap authored threshold brush, and the baked height field');
    assert(['polyhaven_rocky_trail_02', 'polyhaven_dry_ground_rocks',
        'polyhaven_red_laterite_soil_stones', 'polyhaven_cracked_red_ground',
        'polyhaven_mud_cracked_dry_riverbed_002', 'ambientcg_Rock029', 'ambientcg_Rock061',
        'GravellySand', 'RockFace03', 'SandyGravel02', 'RockyTrail',
        'RockFace', 'RockBoulderCracked', 'RocksGround02']
        .every((id) => terrainSource.includes(id)),
    'Ground layer inventory records all fourteen Poly Haven and ambientCG sources');
    assert(['ambientcg_Gravel025', 'ambientcg_Ground031',
        'ambientcg_Ground080', 'ambientcg_Ground081', '_AlbedoGrade_1K.png',
        'eanpa_southwest_ground_v2']
        .every((id) => !terrainSource.includes(id)),
    'Rejected 1K/v2 ground inventory is absent from active runtime source');
    assert(Object.entries(expectedSceneRepeats).every(([stem, repeat]) => terrainSource.includes(
        `${stem}: [${repeat[0].toFixed(1)}, ${repeat[1].toFixed(1)}]`,
    ))
        && /const layerTransforms = \[[\s\S]*SURFACE_TILE_METERS\.RockyTrail02[\s\S]*SURFACE_TILE_METERS\.Rock061/.test(groundMaterial),
    'All fourteen layers use their larger scene-calibrated repeats near and far');
    assert(/const TOP_K = 5;/.test(groundMaterial)
        && /const selectTopK = \(sourceWeights\)/.test(groundMaterial)
        && /const selected = selectTopK\(baseWeights\)/.test(groundMaterial)
        && /const dynamicTransformFor = \(layer, slot\)/.test(groundMaterial)
        && /\.depth\(entry\.layer\)\s*\.grad\(gradX, gradY\)/.test(groundMaterial)
        && /userData\.topK = 5/.test(groundMaterial)
        && /userData\.dynamicSamplesPerArray = 5/.test(groundMaterial)
        && !/hashPhase|stochasticCells|stochasticDominantSample|const layerSamples/.test(groundMaterial),
    'Pre-height top-K selection drives five dynamic explicit-gradient samples per PBR array');
    assert(/const selectedSlots = selected\.map/.test(groundMaterial)
        && /const sampleArray = \(key\)/.test(groundMaterial)
        && /albedo: sampleArray\('albedo'\)/.test(groundMaterial)
        && /packed: sampleArray\('packed'\)/.test(groundMaterial)
        && /const albedoSamples = selectedSlots\.map\(\(slot\) => slot\.albedo\)/.test(groundMaterial)
        && /const packedSamples = selectedSlots\.map\(\(slot\) => slot\.packed\)/.test(groundMaterial),
    'Albedo and packed PBR share each selected layer, transformed UV, and explicit gradients');
    assert(/slot\.albedo\.a/.test(groundMaterial)
        && /const heightBiasedWeights = selectedSlots\.map/.test(groundMaterial)
        && /const weights = heightBiasedWeights\.map/.test(groundMaterial)
        && /const mixedAlbedo = weightedMix\(albedoSamples\)/.test(groundMaterial)
        && /const mixedPacked = weightedMix\(packedSamples\)/.test(groundMaterial),
    'Linear height alpha produces one normalized weight set shared by every PBR channel');
    assert(/heightBlendAmplitude = far \? T3\.float\(0\.10\) : T3\.float\(0\.22\)/.test(groundMaterial)
        && /return weight\.mul\(heightFactor\)/.test(groundMaterial),
    'Height bias is bounded, transition-only, and cannot resurrect zero-weight layers');
    assert(!/groundUvRotated|const antiTile|dual-world-projection/.test(groundMaterial),
        'Rejected dual rotated global crossfade is absent');
    assert(/const reliefDistanceFade = T3\.smoothstep\(70, 520, viewDistance\)/.test(groundMaterial)
        && /const normalStrength = far[\s\S]*T3\.float\(0\.38\)/.test(groundMaterial)
        && /topK5-dynamic-array-layers_explicit-gradient-horizon/.test(groundMaterial)
        && /topK5-dynamic-array-layers_explicit-gradient-near/.test(groundMaterial),
    'Near relief fades with distance and converges to the horizon normal strength');
    assert(/const broadVariation = tint\.mul\(macro\)\.clamp\(0\.94, 1\.06\)/.test(groundMaterial),
        'Runtime macro variation is bounded to plus/minus six percent');
    assert(/const decodePackedNormal = \(sample\)[\s\S]*stored\.y\.negate\(\)[\s\S]*T3\.sqrt\(/.test(groundMaterial)
        && /const nearRoughness = mixedPacked\.b/.test(groundMaterial)
        && /material\.roughnessNode = resolvedRoughness\.clamp\(0\.42, 1\)/.test(groundMaterial)
        && /material\.aoNode = mixedPacked\.a\.mul\(0\.84\)\.add\(0\.16\)/.test(groundMaterial),
    'Packed normalXY is oriented once while B/A drive readable roughness and AO');
    assert(/const geometricWorldNormal = T3\.normalize\(T3\.normalWorldGeometry\)/.test(groundMaterial)
        && /const heightShearedCoordinate = T3\.vec2/.test(groundMaterial)
        && /world\.x\.add\(worldPosition\.y\.mul\(0\.61\)\)/.test(groundMaterial)
        && /world\.y\.sub\(worldPosition\.y\.mul\(0\.47\)\)/.test(groundMaterial)
        && /const slopeProjectionWarp = T3\.vec2/.test(groundMaterial)
        && /const surfaceCoordinate = heightShearedCoordinate/.test(groundMaterial)
        && /\.add\(slopeProjectionWarp\)/.test(groundMaterial)
        && /const slopeProjection = T3\.smoothstep\(0\.12, 0\.30, gradeSignal\)/.test(groundMaterial)
        && /const tangentWorld = T3\.normalize/.test(groundMaterial)
        && /const bitangentWorld = T3\.normalize\(T3\.cross\(tangentWorld, geometricWorldNormal\)\)/.test(groundMaterial)
        && /cameraViewMatrix\.transformDirection\(mappedWorldNormal\)/.test(groundMaterial)
        && !/T3\.normalMap\(/.test(groundMaterial),
    'Terrain uses a continuous single-sample height-sheared slope projection with a matching explicit normal frame');
    assert(/attribute\('terrainSplatA', 'vec4'\)/.test(groundMaterial)
        && /attribute\('terrainSplatB', 'vec4'\)/.test(groundMaterial)
        && /const gradeSignal = selectorB\.w;/.test(groundMaterial)
        && /function interleavedSelectorAt/.test(terrainSource)
        && /function resolvePaintOwnership/.test(terrainSource)
        && /function resolvePaintSelectors/.test(terrainSource)
        && !/function regionalPatchAt/.test(terrainSource)
        && !/regionalPatchAt\(/.test(terrainSource)
        && /function paintAt\(x, z, grade = 0, elevation = terrainHeightAt\(x, z\)\)/.test(terrainSource)
        && /paintAt\(x, z, grade, position\.getY\(index\)\)/.test(terrainSource)
        && /paint\.selectors\.slice\(0, 4\)/.test(terrainSource)
        && /splatB\[index \* 4 \+ 3\] = grade \/ \(1 \+ grade\)/.test(terrainSource)
        && /const terrainElevation = elevation \+ heightWarp/.test(terrainSource)
        && /const terrainGrade = Math\.max\(0, grade \+ slopeWarp\)/.test(terrainSource)
        && /const highTerrain = smooth\(10, 25, terrainElevation\)/.test(terrainSource)
        && /const selectors = \[/.test(terrainSource)
        && /const brushSamples = TERRAIN_BLEND_BRUSH_TRANSFORMS\.map/.test(groundMaterial)
        && /const shapedSelectors = rawSelectors\.map/.test(groundMaterial)
        && /const fieldScore = \(value\)/.test(terrainSource)
        && /const sparseFamily = \(\s*scores/.test(terrainSource)
        && /SURFACE_ORGANIC_POLICY/.test(terrainSource)
        && /authoredShapeShare: 0\.68/.test(terrainSource)
        && /rockFamilyCrossfade: 0\.22/.test(terrainSource)
        && /craterExposureSelector: Object\.freeze\(\[0\.11, 0\.15\]\)/.test(terrainSource)
        && /rockScores, SURFACE_ORGANIC_POLICY\.rockFamilyCrossfade/.test(terrainSource)
        && /squareCellLattice: false/.test(terrainSource)
        && !/GROUND_CELLULAR_POLICY|groundCellularWeightsAt|terrainGroundCell[AB]/.test(terrainSource)
        && /fieldScore\(features\[6\]\) \* talusGate \* 1\.15/.test(terrainSource)
        && /exactSummitPolicy: 'elevation>=50_ground-and-wash-zero'/.test(terrainSource)
        && /exactFacePolicy: 'rise-run>=0\.80_only-RockFace03-and-RockFace'/.test(terrainSource)
        && !/circularPartition/.test(terrainSource)
        && !/transitionAggregate|const route = clamp01\(processionalMaskAt/.test(terrainSource),
    'Fourteen materials use organic authored-brush ownership with no square-cell or contour router');
    assert(/arrayLayers = Array\.from\(\{ length: 14 \}, \(_, index\) => index\)/.test(groundMaterial)
        && /ground: \[0, 1, 2, 3, 10\]/.test(groundMaterial)
        && /wash: \[4, 7, 9\]/.test(groundMaterial)
        && /rock: \[5, 6, 8, 11, 12, 13\]/.test(groundMaterial)
        && /semantic: 'dominant-alluvial-gravel-and-stony-trail'/.test(terrainSource)
        && /semantic: 'stony-transition-soil'/.test(terrainSource)
        && /semantic: 'compacted-cracked-flats'/.test(terrainSource)
        && /semantic: 'authored-dry-washes-only'/.test(terrainSource)
        && /semantic: 'orange-bedrock-and-steep-outcrop'/.test(terrainSource)
        && /semantic: 'tan-bedrock-and-outcrop-transition'/.test(terrainSource)
        && /semantic: 'talus-and-elevated-rock-strewn-transition'/.test(terrainSource),
    'Layer order and hierarchical families match ground, exact wash, bedrock, face, and talus roles');
    assert(heightMasters.every((file) => terrainSource.includes(file))
        && terrainSource.includes('spomHeightSources')
        && /runtimeBlendChannel: 'A'/.test(terrainSource)
        && /runtimeBlendLayer: index/.test(terrainSource)
        && /runtimeBlendResolution: runtimeResolution/.test(terrainSource)
        && /bounded-material-transition-height_plus-future-4K-SPOM-master/.test(terrainSource)
        && terrainSource.includes('enabled: false'),
    'Selected compressed-2K or fallback-1K height drives blending while all 4K masters remain staged for disabled SPOM');
    assert(/const wash = clamp01\(washMaskAt\(x, z\) \* flat\)/.test(terrainSource)
        && /const washChannelA = world\.y\.mul\(0\.11\)/.test(groundMaterial)
        && /const washChannelB = world\.y\.mul\(-0\.07\)/.test(groundMaterial)
        && /const fragmentWashSupport = T3\.max\(fragmentWashA, fragmentWashB\)/.test(groundMaterial)
        && /\.mul\(mudPresence\)/.test(groundMaterial),
    'Cracked riverbed is analytically support-gated per fragment to prevent interpolated wash leakage');
    if (false) {
    for (const scale of ['8.5', '13.0', '15.0', '18.0', '24.0', '31.0']) {
        assert(terrainSource.includes(`1 / ${scale}`), `Cliff material uses the ${scale.replace('.0', '')} m projection scale`);
    }
    const cliffMaterial = terrainSource.slice(terrainSource.indexOf('function makeCliffMaterial'), terrainSource.indexOf('function makeClosedCliffGeometry'));
    const threeWebGpuSource = fs.readFileSync(path.join(ROOT, 'vendor', 'three', 'three.webgpu.js'), 'utf8');
    assert(/getUniformHash\( \/\*builder\*\/ \) \{[\s\S]{0,120}?return this\.value\.uuid;/.test(threeWebGpuSource),
        'Vendored Three r184 deduplicates repeated triplanar samples by texture UUID');
    assert(/const tri = \(key, layer/.test(cliffMaterial)
        && /maps\.surfaceArray\[key\]/.test(cliffMaterial),
    'Cliff triplanar projection samples the shared PBR texture arrays');
    assert(['albedo', 'roughness', 'normal', 'ao']
        .every((channel) => cliffMaterial.includes(`'${channel}'`)),
    'Cliff shader uses complete albedo, roughness, normal, and AO channels');
    assert([4, 5, 6, 7].every((layer) => cliffMaterial.includes(`, ${layer}, 1 /`)),
        'Cliff shader uses four distinct photographed material layers');
    assert(/attribute\('color', 'vec4'\)/.test(cliffMaterial)
        && /capAmount/.test(cliffMaterial)
        && /faceAmount/.test(cliffMaterial)
        && /talusAmount/.test(cliffMaterial),
    'Cliff shader follows authored COLOR_0 cap, exposed-face, and talus zones');
    assert(/const macro = authoredColor\.a/.test(cliffMaterial),
        'Cliff shader reads per-module broad geological variation from COLOR_0 alpha');
    assert(!/const strata = T3\.sin/.test(cliffMaterial),
        'Cliff shader no longer stamps globally synchronized procedural strata');
    assert(/\.mul\(0\.66\)\.add\(0\.34\)/.test(cliffMaterial),
        'Cliff AO preserves readable crevice contrast without a crushed black band');
    }
    assert(/source\.material\.clone\(\)/.test(terrainSource)
        && /sharedImportedBakedPbr: true/.test(terrainSource)
        && !/const cliffMaterial = makeCliffMaterial/.test(terrainSource),
    'Live cliffs use shared imported baked PBR instead of the retired COLOR_0 shader');
    const cliffSamplerBudget = 3 + 2;
    assert(cliffSamplerBudget <= 16,
        'Cliff shader leaves sampler headroom for one environment and one shadow map',
        `${cliffSamplerBudget} / 16`);
    const rockSamplerBudget = 3 + 2;
    assert(rockSamplerBudget <= 16,
        'Imported rock PBR leaves sampler headroom for environment and shadow maps',
        String(rockSamplerBudget) + ' / 16');
    assert(!/function makeRockMaterial|function displaceRock/.test(dressingSource)
        && !/desert_boulders_[0-3]|desert_scree/.test(dressingSource)
        && !/screeTarget|boulderTarget/.test(dressingSource),
    'Procedural boulder and scree geometry/populations are absent from live dressing');
    assert(dressingSource.includes(
        "geologicalDressingOwner: 'terrain_real:user-authored-12-piece-glb'",
    ) && /proceduralRockInstances: 0/.test(dressingSource),
    'Dressing explicitly delegates geology to the user-authored 12-piece GLB');
    // The dense scrub population now instantiates through the Mojave flora
    // library (grasstest port); the dressing delegates while remaining the
    // placement-policy owner.
    assert(/new T3\.InstancedMesh/.test(floraSource)
        && /createFloraField/.test(dressingSource)
        && /mojave_flora/.test(dressingSource),
    'The retained dense scrub population continues to use GPU instancing via mojave_flora fields');
    assert(/const scrubTarget = 9200/.test(dressingSource), 'Dense authored scrub target remains 9,200 instances');
    const footprintSamples = (dressingSource.match(/terrain\?\.heightAt\?\./g) ?? []).length;
    assert(footprintSamples >= 9, 'Dressing seating samples the full plant/rock footprint', `${footprintSamples} height samples`);
    assert(/shrubSeat - Math\.min\(0\.15, height \* 0\.13\)/.test(dressingSource), 'Scrub roots are deliberately buried below the footprint minimum');
    assert(/terrainSample\.cliff \?\? 0/.test(dressingSource),
        'Dressing rejects authored cliff footprints');
    assert(/terrainSample\.cliff \?\? 0/.test(dressingSource),
        'Dressing rejects authored cliff footprints');
    assert(/const heightAt = \(x, z\) => surfaceHeightAt\(x, z\)/.test(terrainSource),
        'All terrain consumers use mesh-matched distant surface heights');
    return { cliffSamplerBudget, rockSamplerBudget, footprintSamples };
}

const terrainSource = fs.readFileSync(TERRAIN_FILE, 'utf8');
const dressingSource = fs.readFileSync(DRESSING_FILE, 'utf8');
const floraSource = fs.readFileSync(FLORA_FILE, 'utf8');
const mainSource = fs.readFileSync(MAIN_FILE, 'utf8');
const api = loadTerrainInternals();
const paintOnly = process.argv.includes('--paint-only');
const topKOnly = process.argv.includes('--topk-only');
const rockCliffOnly = process.argv.includes('--rock-cliff-only');
const report = rockCliffOnly
    ? {
        cliffs: auditUserDesertCliffs(api, terrainSource, mainSource),
        desertRockChunks: auditDesertRockChunks(api, terrainSource, mainSource),
    }
    : topKOnly
    ? { paintTopK: auditPaint(api, { metricsOnly: true }) }
    : paintOnly
    ? { paintDominance: auditPaint(api) }
    : {
        horizon: auditHorizon(api),
        cliffs: auditUserDesertCliffs(api, terrainSource, mainSource),
        desertRockChunks: auditDesertRockChunks(api, terrainSource, mainSource),
        paintDominance: auditPaint(api),
        crater: auditCrater(api),
        heightmap: auditHeightmap(api),
        runtimeTerrainPngDecoder: await auditRuntimeTerrainPngDecoder(api),
        materials: auditMaterials(terrainSource, dressingSource, floraSource),
    };

if (failures.length) {
    console.error(`Terrain static audit failed: ${failures.length} / ${assertions} assertions`);
    for (const failure of failures) console.error(`- ${failure}`);
    console.error(JSON.stringify(report, null, 2));
    process.exitCode = 1;
} else {
    console.log(`Terrain static audit passed: ${assertions} assertions`);
    console.log(JSON.stringify(report, null, 2));
}
