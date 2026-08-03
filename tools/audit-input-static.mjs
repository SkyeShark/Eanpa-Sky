import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
    MAX_WALK_STEP_RISE,
    FLOOR_CONTACT_TOLERANCE,
    createAssistedStepState,
    tryBeginAssistedStep,
    advanceAssistedStep,
    shouldBlockHighSurfaceEntry,
    cancelAssistedStep,
} from '../src/movement_step.js';

const mainSource = await readFile(new URL('../src/main.js', import.meta.url), 'utf8');
let checks = 0;
const ok = (value, message) => { assert.ok(value, message); checks++; };
const equal = (actual, expected, message) => { assert.deepEqual(actual, expected, message); checks++; };

class EventTargetMock {
    constructor() { this.listeners = new Map(); }
    addEventListener(type, listener) {
        if (!this.listeners.has(type)) this.listeners.set(type, []);
        this.listeners.get(type).push(listener);
    }
    dispatch(type, event = {}) {
        event.type ??= type;
        event.target ??= { closest: () => null };
        event.preventDefault ??= () => { event.defaultPrevented = true; };
        for (const listener of this.listeners.get(type) ?? []) listener(event);
        return event;
    }
}

class Vec3 {
    constructor(x = 0, y = 0, z = 0) { this.set(x, y, z); }
    set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
    copy(v) { return this.set(v.x, v.y, v.z); }
}

const inputStart = mainSource.indexOf('const keys = new Set();');
const inputEndMarker = 'globalThis._movementState = movementState;';
const inputEnd = mainSource.indexOf(inputEndMarker, inputStart) + inputEndMarker.length;
const controlsStart = mainSource.indexOf('const controls = {', inputEnd);
const controlsEnd = mainSource.indexOf('const sun =', controlsStart);
ok(inputStart >= 0 && inputEnd > inputStart, 'physical input block is extractable');
ok(controlsStart >= 0 && controlsEnd > controlsStart, 'movement update block is extractable');

const compileHarness = Function(
    'THREE', 'camera', 'look', 'canvas', 'document', 'addEventListener',
    'terrain', 'temple', 'vegetation', 'performance',
    'MAX_WALK_STEP_RISE', 'FLOOR_CONTACT_TOLERANCE',
    'createAssistedStepState', 'tryBeginAssistedStep', 'advanceAssistedStep',
    'shouldBlockHighSurfaceEntry', 'cancelAssistedStep',
    `${mainSource.slice(inputStart, inputEnd)}\n${mainSource.slice(controlsStart, controlsEnd)}\n`
        + 'return { keys, movementState, clearInputState, controls };',
);

const windowTarget = new EventTargetMock();
const canvas = new EventTargetMock();
const panel = new EventTargetMock();
const document = new EventTargetMock();
document.hidden = false;
document.getElementById = (id) => id === 'panel' ? panel : null;
const camera = {
    position: new Vec3(0, 1.82, 0),
    rotation: { x: 0, y: 0, z: 0, set(x, y, z) { this.x = x; this.y = y; this.z = z; } },
};
const look = { yaw: 0, pitch: 0.035, vyaw: 0, vpitch: 0, locked: false };
const terrain = { terrainBounds: null, heightAt: () => 0 };
let nowMs = 0;
const fakePerformance = { now: () => nowMs };
const savedInput = globalThis._inputState;
const savedMovement = globalThis._movementState;

try {
    const harness = compileHarness(
        { Vector3: Vec3 }, camera, look, canvas, document,
        windowTarget.addEventListener.bind(windowTarget),
        terrain, null, null, fakePerformance,
        MAX_WALK_STEP_RISE, FLOOR_CONTACT_TOLERANCE,
        createAssistedStepState, tryBeginAssistedStep, advanceAssistedStep,
        shouldBlockHighSurfaceEntry, cancelAssistedStep,
    );
    const key = (type, code, repeat = false, target = { closest: () => null }) => (
        windowTarget.dispatch(type, { code, repeat, target })
    );

    // No-repeat is intentional: a physical hold is state, not a repeat-event
    // lease. The fake clock advances past the deleted 1.8 second failure point
    // while the real controls update executes 600 simulation frames.
    key('keydown', 'KeyW');
    const startZ = camera.position.z;
    let maximumWalkBob = 0;
    for (let frame = 1; frame <= 600; frame++) {
        nowMs = frame * (10000 / 600);
        harness.controls.update(1 / 60);
        maximumWalkBob = Math.max(
            maximumWalkBob,
            Math.abs(harness.movementState.bobOffset),
        );
    }
    ok(harness.keys.has('KeyW'), '10-second continuous W hold remains physically down');
    ok(camera.position.z < startZ - 35.9, '10-second hold continues moving for the full interval');
    ok(maximumWalkBob > 0.02, 'grounded walking produces a readable view bob');

    const release = key('keyup', 'KeyW');
    ok(release.defaultPrevented, 'handled release is consumed');
    ok(!harness.keys.has('KeyW'), 'normal keyup stops immediately');
    const stoppedX = camera.position.x, stoppedZ = camera.position.z;
    nowMs += 1000;
    harness.controls.update(1 / 60);
    equal([camera.position.x, camera.position.z], [stoppedX, stoppedZ], 'released direction produces no further horizontal movement');
    for (let frame = 0; frame < 90; frame++) harness.controls.update(1 / 60);
    ok(Math.abs(harness.movementState.bobOffset) < 0.0001,
        'walk bob eases back to a stable neutral eye height after stopping');

    // Space queues exactly one grounded impulse. The ballistic arc must have
    // readable airtime and progressive gravity rather than snapping back to
    // the floor on the next frame.
    ok(harness.movementState.grounded, 'flat-ground harness is grounded before jump');
    key('keydown', 'Space');
    harness.controls.update(1 / 60);
    key('keyup', 'Space');
    ok(harness.movementState.verticalVelocity > 0,
        'Space begins an upward physical impulse');
    let jumpPeak = harness.movementState.physicalEyeY;
    let airborneFrames = harness.movementState.grounded ? 0 : 1;
    for (let frame = 0; frame < 180 && !harness.movementState.grounded; frame++) {
        harness.controls.update(1 / 60);
        jumpPeak = Math.max(jumpPeak, harness.movementState.physicalEyeY);
        airborneFrames++;
    }
    ok(jumpPeak > 2.9, 'jump reaches a useful but restrained height');
    ok(airborneFrames > 45, 'jump/fall arc remains airborne long enough to read');
    ok(harness.movementState.grounded
        && Math.abs(harness.movementState.physicalEyeY - 1.82) < 1e-6,
    'jump lands exactly on the physical floor');

    // Holding Space never refreshes jumpQueued. One physical press produces
    // one arc even if the key remains down through the landing.
    key('keydown', 'Space');
    let groundedTransitions = 0;
    let previousGrounded = harness.movementState.grounded;
    for (let frame = 0; frame < 180; frame++) {
        harness.controls.update(1 / 60);
        if (!previousGrounded && harness.movementState.grounded) groundedTransitions++;
        previousGrounded = harness.movementState.grounded;
    }
    ok(groundedTransitions === 1, 'held Space produces one landing and no hold-repeat jump');
    ok(harness.movementState.grounded
        && Math.abs(harness.movementState.physicalEyeY - 1.82) < 1e-6,
    'held Space remains grounded after its single completed arc');
    key('keyup', 'Space');

    // Teleporting above the ground exercises the generic fall path. The first
    // frame moves only millimetres, then acceleration accumulates over time.
    camera.position.y = 11.82;
    harness.controls.update(1 / 60);
    const firstFallDistance = 11.82 - harness.movementState.physicalEyeY;
    ok(firstFallDistance > 0 && firstFallDistance < 0.02,
        'generic falling begins progressively instead of snapping instantly');
    let fallFrames = 1;
    while (!harness.movementState.grounded && fallFrames < 300) {
        harness.controls.update(1 / 60);
        fallFrames++;
    }
    ok(fallFrames > 45 && harness.movementState.grounded,
        'a ten-metre fall has sustained acceleration and eventually lands');

    // Shift is its own physical key. Pressing it before a direction must not
    // be inferred as released by an idle frame.
    key('keydown', 'ShiftLeft');
    harness.controls.update(1 / 60);
    ok(harness.keys.has('ShiftLeft'), 'held Shift survives an idle frame before W');
    key('keyup', 'ShiftLeft');

    // A swallowed keyup is reconciled on real lifecycle boundaries.
    key('keydown', 'KeyD');
    windowTarget.dispatch('blur');
    ok(!harness.keys.has('KeyD'), 'focus loss clears a direction whose keyup was swallowed');
    ok(harness.movementState.lifecycleInputClears >= 1, 'lifecycle reconciliation is observable');

    key('keydown', 'KeyA');
    document.hidden = true;
    document.dispatch('visibilitychange');
    ok(!harness.keys.has('KeyA'), 'hidden-page transition clears physical input');
    document.hidden = false;

    key('keydown', 'KeyS');
    panel.dispatch('pointerdown');
    ok(!harness.keys.has('KeyS'), 'native panel interaction clears physical input');

    const editable = { closest: () => ({ tagName: 'SELECT' }) };
    key('keydown', 'KeyW', false, editable);
    ok(!harness.keys.has('KeyW'), 'editable controls never latch movement');
    key('keydown', 'KeyW');
    document.dispatch('focusin', { target: editable });
    ok(!harness.keys.has('KeyW'), 'editable focus reconciles an already-held direction');
} finally {
    if (savedInput === undefined) delete globalThis._inputState;
    else globalThis._inputState = savedInput;
    if (savedMovement === undefined) delete globalThis._movementState;
    else globalThis._movementState = savedMovement;
}

// Source guards make the old lease/inferred-release regression fail loudly.
ok(!mainSource.includes('keyHeartbeats'), 'no repeat-heartbeat lease remains');
ok(!mainSource.includes('staleInputClears'), 'no stale-timeout counter remains');
ok(!/inputNow[\s\S]{0,500}1800/.test(mainSource), 'no 1.8-second physical-key expiry remains');
ok(!/keys\.delete\(['"]Shift(?:Left|Right)['"]\)/.test(mainSource), 'Shift is never inferred released from direction state');
ok(mainSource.includes('canvas.requestPointerLock?.()'),
    'one primary canvas click requests persistent pointer lock');
ok(mainSource.includes('document.addEventListener(\'mousemove\'')
    && mainSource.includes('e.movementX')
    && mainSource.includes('e.movementY'),
    'locked relative mouse deltas drive look without a held button');
ok(mainSource.includes('document.addEventListener(\'pointerlockchange\'')
    && mainSource.includes('document.pointerLockElement === canvas'),
    'pointer-lock lifecycle follows the browser and therefore Escape release');
ok(!mainSource.includes('setPointerCapture(') && !mainSource.includes('look.dragging'),
    'legacy hold-to-drag pointer capture is removed');

console.log(`input static/VM audit: PASS (${checks} assertions, 10 s hold, no GPU/browser)`);
