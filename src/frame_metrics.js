// Opt-in CPU-side frame submission timing. These are not GPU timestamp queries
// or hardware emulation. Fixed storage keeps capture cost and memory bounded.
export class FrameMetrics {
    constructor(capacity = 32768) {
        if (!Number.isInteger(capacity) || capacity < 2) throw new RangeError('Invalid sample capacity');
        this.intervals = new Float64Array(capacity);
        this.tasks = new Float64Array(capacity);
        this.active = false;
    }
    start(metadata = {}) {
        this.metadata = structuredClone(metadata);
        this.count = 0;
        this.previousStart = null;
        this.reasons = new Set();
        this.active = true;
    }
    invalidate(reason) {
        if (this.active) this.reasons.add(reason);
    }
    record(startMs, endMs, visible = true) {
        if (!this.active) return;
        if (!visible) this.invalidate('page hidden during capture');
        if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) {
            this.invalidate('invalid clock sample');
            return;
        }
        if (this.previousStart !== null) {
            const interval = startMs - this.previousStart;
            if (interval <= 0) { this.invalidate('non-monotonic frame clock'); return; }
            if (this.count === this.intervals.length) {
                this.invalidate('sample capacity exceeded');
                return;
            }
            this.intervals[this.count] = interval;
            this.tasks[this.count] = endMs - startMs;
            this.count++;
        }
        this.previousStart = startMs;
    }
    stop() {
        if (!this.active) throw new Error('No active frame capture');
        this.active = false;
        if (this.count < 2) this.reasons.add('insufficient completed frames');
        const summarize = values => {
            if (values.length === 0) return null;
            const sorted = [...values].sort((a, b) => a - b);
            const percentile = p => sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)];
            return {
                mean: sorted.reduce((sum, value) => sum + value, 0) / sorted.length,
                median: percentile(0.5), p95: percentile(0.95), p99: percentile(0.99),
                max: sorted.at(-1),
            };
        };
        const frameIntervalMs = summarize(this.intervals.subarray(0, this.count));
        return {
            metadata: this.metadata,
            valid: this.reasons.size === 0,
            invalidReasons: [...this.reasons],
            samples: this.count,
            timingSource: 'CPU frame starts and async render-task completion; not GPU timestamps',
            frameIntervalMs,
            renderTaskMs: summarize(this.tasks.subarray(0, this.count)),
            meanFps: frameIntervalMs ? 1000 / frameIntervalMs.mean : null,
            // Retain raw intervals for plots and investigation of periodic bakes.
            intervalsMs: [...this.intervals.subarray(0, this.count)],
        };
    }
}
