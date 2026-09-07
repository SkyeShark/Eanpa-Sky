import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('../src/main.js', import.meta.url), 'utf8');
const start = source.indexOf('function frame(now) {');
const end = source.indexOf('\nrequestAnimationFrame(frame);', start);
assert.ok(start >= 0 && end > start);
const compile = Function('tick', 'requestAnimationFrame', 'console', `
    let last = 0, t = 0, inFlight = false, building = false;
    const benchmark = null;
    const testFrameState = { completedFrames: 0, paused: false };
    ${source.slice(start, end)}
    return { frame, state: testFrameState,
        setBuilding(value) { building = value; },
        get time() { return t; } };
`);
const settle = () => new Promise(resolve => setImmediate(resolve));

test('GPU-skipped callbacks contribute elapsed time to the next simulation step', async () => {
    const deltas = [];
    let finish;
    const harness = compile((now, dt) => {
        deltas.push(dt);
        return new Promise(resolve => { finish = resolve; });
    }, () => {}, console);
    harness.frame(16);
    harness.frame(32);
    harness.frame(48);
    assert.equal(deltas.length, 1, 'GPU submissions stay serialized');
    finish(); await settle();
    harness.frame(64);
    assert.deepEqual(deltas, [0.016, 0.048]);
    assert.equal(harness.time, 0.064);
    finish(); await settle();
    assert.equal(harness.state.completedFrames, 2);
});
test('explicit pause and sky rebuild discard elapsed input time', async () => {
    const deltas = [];
    const harness = compile(async (now, dt) => { deltas.push(dt); }, () => {}, console);
    harness.state.paused = true;
    harness.frame(1000);
    harness.state.paused = false;
    harness.frame(1016); await settle();
    harness.setBuilding(true);
    harness.frame(3000);
    harness.setBuilding(false);
    harness.frame(3016); await settle();
    assert.deepEqual(deltas, [0.016, 0.016]);
});
test('a failed render is recorded as failure and releases the frame lock', async () => {
    let attempts = 0;
    const harness = compile(async () => {
        if (++attempts === 1) throw new Error('simulated render failure');
    }, () => {}, { error() {} });
    harness.frame(16); await settle();
    assert.equal(harness.state.completedFrames, 0);
    assert.equal(harness.state.failedFrames, 1);
    harness.frame(32); await settle();
    assert.equal(harness.state.completedFrames, 1);
});

test('a stale first display timestamp cannot rewind simulation',async()=>{
    const deltas=[];
    const harness=compile(async(now,dt)=>{deltas.push(dt);},()=>{},console);
    harness.frame(-2000);await settle();
    assert.equal(harness.time,0);assert.deepEqual(deltas,[0]);
});
