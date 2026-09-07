import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import * as steps from '../src/movement_step.js';

// Execute the real controller against a simple solid wall. This verifies
// incoming velocity survives collision resolution, independently of rendering.
const main = await readFile(new URL('../src/main.js', import.meta.url), 'utf8');
const inputStart = main.indexOf('const keys = new Set();');
const inputEnd = main.indexOf('globalThis._movementState = movementState;')
    + 'globalThis._movementState = movementState;'.length;
const controlsStart = main.indexOf('const controls = {');
const controlsEnd = main.indexOf('const sun =', controlsStart);
assert.ok(inputStart >= 0 && controlsStart > inputEnd && controlsEnd > controlsStart);
const stepNames = Object.keys(steps);
const runController = Function('THREE', 'camera', 'look', 'canvas', 'document',
    'addEventListener', 'terrain', 'temple', 'vegetation', ...stepNames,
    `${main.slice(inputStart, inputEnd)}\n${main.slice(controlsStart, controlsEnd)}
    return { keys, movementState, controls };`);

class Vector3 {
    constructor(x = 0, y = 0, z = 0) { Object.assign(this, { x, y, z }); }
    copy(v) { Object.assign(this, { x: v.x, y: v.y, z: v.z }); return this; }
}
function createController(yaw = 0) {
    const target = { addEventListener() {}, getElementById() { return null; } };
    const camera = { position: new Vector3(0, 1.82, 0.001), rotation: {
        set(x, y, z) { Object.assign(this, { x, y, z }); },
    } };
    const temple = { resolveCamera(c) {
        const collided = c.position.z < 0;
        c.position.z = Math.max(0, c.position.z);
        return { collided };
    } };
    const state = runController({ Vector3 }, camera,
        { yaw, pitch: 0, vyaw: 0, vpitch: 0 }, target, target, () => {},
        { heightAt: () => 0 }, temple, null, ...stepNames.map(name => steps[name]));
    return { ...state, camera };
}

for (const hz of [30, 60, 120, 240]) {
    test(`frontal impact preserves approach speed at ${hz} Hz`, () => {
        const { keys, movementState: movement, controls } = createController();
        keys.add('KeyW');
        controls.update(1 / hz);
        assert.equal(movement.contactSerial, 1);
        assert.equal(movement.contactSide, 0);
        assert.ok(Math.abs(movement.contactImpactSpeed - 3.6) < 1e-8);
        assert.ok(movement.horizontalSpeed < 0.25, 'collision stopped forward movement');
        controls.update(1 / hz);
        assert.equal(movement.contactSerial, 1, 'held contact does not retrigger');
    });
}
test('a sprint produces a stronger incoming impact', () => {
    const { keys, movementState: movement, controls } = createController();
    keys.add('KeyW'); keys.add('ShiftLeft');
    controls.update(1 / 60);
    assert.ok(Math.abs(movement.contactImpactSpeed - 7.2) < 1e-8);
});
test('glancing collision measures normal velocity while preserving slide', () => {
    const { keys, movementState: movement, controls } = createController(Math.PI / 3);
    keys.add('KeyW');
    controls.update(1 / 60);
    assert.ok(Math.abs(movement.contactImpactSpeed - 1.8) < 1e-8);
    assert.ok(movement.horizontalSpeed > 3, 'tangential movement remains available');
    assert.notEqual(movement.contactSide, 0);
});
