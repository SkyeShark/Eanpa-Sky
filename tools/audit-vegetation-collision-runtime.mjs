#!/usr/bin/env node

// Renderer-free CPU acceptance audit for proximity-streamed vegetation
// collision. It executes the same dependency-free streamer used by the scene.

import {
    VEGETATION_COLLISION_CONFIG,
    createVegetationCollisionStreamer,
    makeVegetationCollisionProxy,
} from '../src/vegetation_collision.js';

const checks = [];
const check = (condition, name, details = '') => {
    checks.push({ ok: Boolean(condition), name, details });
    if (!condition) throw new Error(`${name}${details ? `: ${details}` : ''}`);
};

check(
    VEGETATION_COLLISION_CONFIG.releaseRadius
        > VEGETATION_COLLISION_CONFIG.activeRadius,
    'release radius is larger than activation radius for hysteresis',
);
check(
    VEGETATION_COLLISION_CONFIG.activeRadius <= 7
        && VEGETATION_COLLISION_CONFIG.releaseRadius <= 10,
    'resident physics stays within a very-close explorer radius',
);
check(
    VEGETATION_COLLISION_CONFIG.refreshInterval <= 0.15
        && VEGETATION_COLLISION_CONFIG.refreshTravel <= 1.5,
    'tight radius uses a sprint-safe refresh cadence and travel threshold',
);

const saguaroPlacement = { id: 7, x: 0, y: 0, z: 0, scale: 1, yaw: 0 };
const joshuaPlacement = { id: 11, x: 40, y: 0.4, z: 0, scale: 1.1, yaw: 0.6 };
const distantPlacement = { id: 99, x: 220, y: 0, z: 0, scale: 0.8, yaw: 0 };
const saguaroProxy = makeVegetationCollisionProxy('saguaro', saguaroPlacement);
const joshuaProxy = makeVegetationCollisionProxy('joshua', joshuaPlacement);
check(saguaroProxy?.primitives.length === 5, 'saguaro proxy is a trunk/arm capsule union');
check(joshuaProxy?.primitives.length === 5, 'Joshua proxy is a trunk/branch capsule union');
check(
    saguaroProxy.primitives.some(({ role }) => role.startsWith('arm-')),
    'saguaro proxy retains authored major arms',
);
check(
    joshuaProxy.primitives.some(({ role }) => role.startsWith('branch-')),
    'Joshua proxy retains woody crown branches without solid foliage',
);

const streamer = createVegetationCollisionStreamer();
streamer.registerSpecies('saguaro', [saguaroPlacement, distantPlacement]);
streamer.registerSpecies('joshua', [joshuaPlacement]);
let state = streamer.snapshot();
check(state.registered === 3, 'all plant placements are spatially indexed');
check(state.active === 0 && state.loadCount === 0, 'no proxy is loaded before proximity activation');

const nearOrigin = { x: 2, y: 1.82, z: 0 };
check(streamer.refresh(nearOrigin, 0, true), 'forced initial stream refresh runs');
state = streamer.snapshot();
check(state.active === 1, 'only the near saguaro proxy loads');
check(state.activeBySpecies.saguaro === 1, 'active species diagnostic is correct');
check(!state.activeKeys.includes('saguaro:99'), 'distant plant has no active collision allocation');

check(
    streamer.refresh({ x: 2.2, y: 1.82, z: 0 }, 0.1, false) === false,
    'sub-interval/sub-travel refresh is skipped',
);
check(
    streamer.refresh({ x: 5.8, y: 1.82, z: 0 }, 0.11, false) === true,
    'large explorer travel refreshes even inside cadence window',
);

streamer.refresh({ x: 8.2, y: 1.82, z: 0 }, 1, true);
check(
    streamer.snapshot().activeKeys.includes('saguaro:7'),
    'active proxy survives outside activation radius but inside release radius',
);
streamer.refresh({ x: 10, y: 1.82, z: 0 }, 2, true);
check(
    !streamer.snapshot().activeKeys.includes('saguaro:7'),
    'proxy unloads beyond release radius',
);

streamer.refresh({ x: 0, y: 1.82, z: 0 }, 3, true);
const target = { x: 0.02, y: 1.82, z: 0 };
const previous = { x: -2, y: 1.82, z: 0 };
const collision = streamer.resolve(target, previous, 3.01, 1.82);
const expectedTrunkClearance = 0.34 + VEGETATION_COLLISION_CONFIG.playerRadius;
check(collision.contacts > 0, 'swept player path contacts the saguaro trunk');
check(
    Math.hypot(target.x, target.z) >= expectedTrunkClearance - 1e-6,
    'trunk contact resolves to player-plus-trunk clearance',
    `clearance=${Math.hypot(target.x, target.z)}`,
);

streamer.refresh({ x: 40, y: 3.2, z: 0 }, 4, true);
state = streamer.snapshot();
check(state.active === 1 && state.activeBySpecies.joshua === 1, 'stream swaps to nearby Joshua only');

streamer.refresh({ x: 100, y: 1.82, z: 100 }, 5, true);
const beforeEmptyResolve = streamer.snapshot().primitiveChecks;
const emptyResult = streamer.resolve(
    { x: 100.1, y: 1.82, z: 100 },
    { x: 100, y: 1.82, z: 100 },
    5.01,
    1.82,
);
state = streamer.snapshot();
check(emptyResult.active === 0, 'no proxies remain loaded away from vegetation');
check(
    state.primitiveChecks === beforeEmptyResolve,
    'empty active set performs zero per-frame primitive collision checks',
);
check(state.peakActive === 1, 'test stream never loaded an unrelated plant');
check(state.loadCount >= 2 && state.unloadCount >= 2, 'load/unload diagnostics track streamed lifetime');

streamer.dispose();
state = streamer.snapshot();
check(state.registered === 0 && state.gridCells === 0 && state.active === 0, 'dispose releases spatial and active state');

console.log(JSON.stringify({
    ok: true,
    suite: 'vegetation-collision-runtime',
    checks: checks.length,
    config: VEGETATION_COLLISION_CONFIG,
}, null, 2));
