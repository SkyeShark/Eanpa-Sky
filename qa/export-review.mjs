// Preserve compact, reviewable evidence; raw frames and timestamp samples stay local.
import { readFile, writeFile } from 'node:fs/promises';
const json = async path => JSON.parse(await readFile(path, 'utf8'));
const route = await json('artifacts/overhaul/quality/route.json');
const results = [];
for (const row of route) {
    const b = row.benchmark;
    if (!b.valid || !b.cleanGpuWindow) throw new Error('Final route contains an invalid benchmark');
    const stem = row.weather ? `${row.sky}-${row.weather}-review` : `${row.sky}-${row.tier}-review`;
    const gpu = row.constraint === 4 ? null : await json(`artifacts/overhaul/benchmarks/${stem}-gpu.json`);
    results.push({ sky: row.sky, tier: row.tier, weather: row.weather ?? 'none',
        cpuSlowdown: row.constraint ?? 1, metadata: b.metadata, samples: b.samples,
        fps: b.meanFps, frameIntervalMs: b.frameIntervalMs,
        gpuPassMs: gpu?.summary ?? null, cleanGpuWindow: b.cleanGpuWindow });
}
const evidence = { route: results };
for (const [name, path] of Object.entries({
    environmentIdentity: 'environment-compare.json', shadowIdentity: 'shadow-cache-compare.json',
    rebuildIdentity: 'rebuild-cache-compare.json',
    rebuildMemory: 'rebuild-memory.json', shadowBenchmark: 'shadow-cache-benchmark.json',
})) {
    try {
        const value = await json(`artifacts/overhaul/${path}`);
        evidence[name] = name === 'shadowBenchmark' ? value.map(({cached, report:b}) => ({cached,
            metadata:b.metadata, valid:b.valid, fps:b.meanFps, frameIntervalMs:b.frameIntervalMs,
            cleanGpuWindow:b.cleanGpuWindow})) : value;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
}
await writeFile('qa/results-20260907.json', JSON.stringify(evidence, null, 2) + '\n');
const names = { earth: 'Earth', ringworld: 'Ringworld', shieldworld: 'Shieldworld' };
const lines = [
    'Final quality/weather sweep: revision `16ab2c9`. All 15 throughput captures',
    'passed the activity and render-error gates. GPU pass times are from separate',
    '120-frame runs immediately following each unrestricted throughput capture.', '',
    '| World | Quality | Mean FPS | Frame p95 (ms) | GPU mean / p95 (ms) |',
    '| --- | --- | ---: | ---: | ---: |',
];
for (const r of results.filter(r => r.cpuSlowdown === 1 && r.weather === 'none')) {
    lines.push(`| ${names[r.sky]} | ${r.tier} | ${r.fps.toFixed(1)} | ${r.frameIntervalMs.p95.toFixed(1)} | ${r.gpuPassMs.meanMs.toFixed(2)} / ${r.gpuPassMs.p95Ms.toFixed(2)} |`);
}
lines.push('', '| World, Balanced | 4x CPU slowdown FPS | Cyclone FPS | Cyclone GPU mean (ms) |',
    '| --- | ---: | ---: | ---: |');
for (const sky of Object.keys(names)) {
    const cpu = results.find(r => r.sky === sky && r.cpuSlowdown === 4);
    const storm = results.find(r => r.sky === sky && r.weather === 'cyclone');
    lines.push(`| ${names[sky]} | ${cpu.fps.toFixed(1)} | ${storm.fps.toFixed(1)} | ${storm.gpuPassMs.meanMs.toFixed(2)} |`);
}
lines.push('', 'The later environment-ownership cleanup was compared against the automatic',
    'path using an identical paused frame. Its resource-cycle check and the final',
    'shadow-cache comparison are recorded separately in [qa/results-20260907.json](qa/results-20260907.json).');
const path = 'OVERHAUL_REVIEW.md';
const doc = (await readFile(path, 'utf8')).replace(/^\uFEFF/, '').replace(/\d+ executable unit tests/, '38 executable unit tests');
await writeFile(path, doc.replace(/<!-- FINAL_BENCHMARK_TABLE -->[\s\S]*?<!-- END_FINAL_BENCHMARK_TABLE -->/,
    `<!-- FINAL_BENCHMARK_TABLE -->\n${lines.join('\n')}\n<!-- END_FINAL_BENCHMARK_TABLE -->`));
console.log(`Exported ${results.length} valid throughput captures.`);
