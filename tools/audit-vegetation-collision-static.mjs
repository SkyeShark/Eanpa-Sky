#!/usr/bin/env node

// Source-contract audit: guards the integration points that keep physics
// proximity-streamed and independent from visual LOD/render geometry.

import { readFile } from 'node:fs/promises';

const [collision, vegetation, main] = await Promise.all([
    readFile('src/vegetation_collision.js', 'utf8'),
    readFile('src/vegetation.js', 'utf8'),
    readFile('src/main.js', 'utf8'),
]);
const results = [];
const check = (condition, name) => {
    results.push({ ok: Boolean(condition), name });
    if (!condition) throw new Error(name);
};

check(
    /activeRadius:\s*7/.test(collision)
        && /releaseRadius:\s*9\.5/.test(collision)
        && /refreshInterval:\s*0\.12/.test(collision)
        && /refreshTravel:\s*1\.25/.test(collision),
    'stream uses very-close activation, hysteresis release, and sprint-safe cadence',
);
check(
    /const grid = new Map\(\)/.test(collision)
        && /const active = new Map\(\)/.test(collision)
        && /grid\.get\(cellKey/.test(collision),
    'placements are spatially indexed and active proxies are a separate set',
);
check(
    /makeVegetationCollisionProxy[\s\S]*active\.set\(entry\.key, proxy\)/.test(collision),
    'proxy capsule unions are allocated only on proximity activation',
);
check(
    /active\.delete\(key\)[\s\S]*unloadCount\+\+/.test(collision),
    'proxies unload beyond the release radius',
);
check(
    /COLLISION_TEMPLATES[\s\S]*saguaro[\s\S]*'trunk'[\s\S]*'arm-left-lower'/.test(collision)
        && /joshua[\s\S]*'trunk'[\s\S]*'branch-west'/.test(collision),
    'both species use trunk plus major-arm/branch capsule unions',
);
check(
    !/new\s+(?:THREE|T3)\.(?:Mesh|BufferGeometry|InstancedMesh)/.test(collision),
    'physics streaming never duplicates visual render meshes or GPU geometry',
);
check(
    /createVegetationCollisionStreamer/.test(vegetation)
        && /collisionStreamer\.registerSpecies\(item\.name, item\.placements\)/.test(vegetation)
        && /collisionStreamer\.refresh\(camera\.position, t, force\)/.test(vegetation),
    'vegetation registers authored placements and refreshes collision independently of visual LOD',
);
check(
    /const resolveCamera = \(camera, previous, time = 0, eyeHeight = 1\.82\)/.test(vegetation)
        && /collisionStreamer\.resolve\(/.test(vegetation)
        && /collisionStreamer\.dispose\(\)/.test(vegetation),
    'scene API resolves player collision and disposes streamed state',
);
check(
    /collision:\s*\{[\s\S]*activeProxies[\s\S]*forceRefresh/.test(vegetation)
        && /collision:\s*collisionStreamer\.snapshot\(\)/.test(vegetation),
    'live diagnostics expose active proxies and stream counters',
);

const templeResolve = main.indexOf('temple?.resolveCamera?.(camera, movementStart)');
const vegetationResolve = main.indexOf('vegetation?.resolveCamera?.(');
const floorSample = main.indexOf(
    'const targetSurface = navigationSurfaceAt(camera.position.x, camera.position.z)',
    vegetationResolve,
);
check(
    templeResolve >= 0
        && vegetationResolve > templeResolve
        && floorSample > vegetationResolve,
    'vegetation solids resolve after architecture and before floor sampling',
);

console.log(JSON.stringify({
    ok: true,
    suite: 'vegetation-collision-static',
    checks: results.length,
}, null, 2));
