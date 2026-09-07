import test from 'node:test';
import assert from 'node:assert/strict';
import { blendAmbienceLoop } from '../src/audio_loop.js';
const context = { createBuffer(channels, length, sampleRate) {
    const data = Array.from({ length: channels }, () => new Float32Array(length));
    return { numberOfChannels: channels, length, sampleRate, getChannelData: c => data[c] };
} };
test('ambience seam follows adjacent source samples without a new peak or channel change', () => {
    const source = context.createBuffer(2, 1000, 1000);
    for (let c = 0; c < 2; c++) {
        const samples = source.getChannelData(c);
        for (let i = 0; i < samples.length; i++) samples[i] = (i / 999 * 1.6 - 0.8) * (c ? -0.5 : 1);
    }
    const original = source.getChannelData(0).slice();
    const result = blendAmbienceLoop(context, source, 0.18);
    assert.equal(result.numberOfChannels, 2); assert.equal(result.sampleRate, 1000);
    for (let c = 0; c < 2; c++) {
        const samples = result.getChannelData(c);
        assert.ok(Math.abs(samples[0] - samples.at(-1)) < 0.002, 'loop edge is one ordinary source step');
        assert.ok(samples.every(v => Number.isFinite(v) && Math.abs(v) <= 0.801));
    }
    assert.deepEqual(source.getChannelData(0), original);
});
test('tiny clips are left intact', () => {
    const source = context.createBuffer(1, 4, 48000);
    assert.equal(blendAmbienceLoop(context, source), source);
});
