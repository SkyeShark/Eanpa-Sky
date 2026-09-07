import assert from 'node:assert/strict';
import test from 'node:test';
import { FrameMetrics } from '../src/frame_metrics.js';

test('capture excludes its initial partial interval and reports a hitch', () => {
    const capture = new FrameMetrics();
    capture.start({ constraint: 'none' });
    capture.record(5000, 5002);
    capture.record(5016, 5019);
    capture.record(5032, 5036);
    capture.record(5132, 5137);
    const result = capture.stop();
    assert.equal(result.valid, true);
    assert.deepEqual(result.intervalsMs, [16, 16, 100]);
    assert.equal(result.frameIntervalMs.mean, 44);
    assert.equal(result.frameIntervalMs.median, 16);
    assert.equal(result.frameIntervalMs.p99, 100);
    assert.equal(result.renderTaskMs.mean, 4);
});
test('hidden, paused, or overflowing captures cannot look valid', () => {
    const capture = new FrameMetrics(2);
    capture.start();
    capture.record(0, 1);
    capture.record(16, 17, false);
    capture.invalidate('paused during capture');
    capture.record(32, 33);
    capture.record(48, 49);
    const result = capture.stop();
    assert.equal(result.valid, false);
    assert.equal(result.samples, 2);
    assert.deepEqual(result.invalidReasons, [
        'page hidden during capture', 'paused during capture', 'sample capacity exceeded',
    ]);
});
test('a new capture resets data and takes its own metadata snapshot', () => {
    const capture = new FrameMetrics();
    capture.start(); capture.invalidate('failed'); capture.stop();
    const metadata = { quality: 'balanced' };
    capture.start(metadata); metadata.quality = 'changed';
    capture.record(0, 1); capture.record(10, 11); capture.record(20, 21);
    const result = capture.stop();
    assert.equal(result.valid, true);
    assert.equal(result.metadata.quality, 'balanced');
    assert.equal(result.meanFps, 100);
    assert.throws(() => capture.stop(), /No active/);
});
