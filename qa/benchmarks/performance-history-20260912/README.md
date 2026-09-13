# Original versus new Performance — 12 September 2026

The original live-cloud Performance mode and the new panorama mode were effectively tied natively in this 1080p rain fixture. Under synthetic resource pressure, the new mode averaged 5.1% higher FPS (0.62 ms saved per frame). Its measured application GPU work was 13.7% lower (0.23 ms saved). Background activity and the variation between constrained repeats limit the precision of the throughput gain.

| Measurement | Original Performance | New Performance | Observed change |
|---|---:|---:|---:|
| Native RTX 5090 Laptop GPU | 239.4 FPS / 4.18 ms | 239.4 FPS / 4.18 ms | Effectively tied |
| 4× CPU throttle + fixed GPU workload | 79.0 FPS / 12.65 ms | 83.1 FPS / 12.04 ms | 5.1% FPS; 0.62 ms saved |
| Application GPU work per frame | 1.66 ms | 1.43 ms | 13.7% less GPU work |

These are fresh measurements of both versions, collected in the same owned browser session. They are not inferred from the earlier Balanced comparison. The baseline is **31a107fae72a61adcd392440d6f7bdc5a6fb986e**, the r186 version immediately before panorama Performance was introduced. The new engine is **c52697b5a8323fb9dca83c0a8be4b2c653a9f762**. Only the QA helpers and result artifacts changed in the working tree; engine files and Balanced/High settings were not edited.

Both runs used the same generic six-mesh fixture, Earth at 11:00 with settled Rain, 1920×1080, camera field of view and orbit phase, native SSR/PBR, rain, impacts, puddles and cloud shadows. No terrain, temple, vegetation or player assets were included. Each page warmed for 30 real-time seconds, then measured for 30 seconds; time was not accelerated. Native and constrained order was old → new → new → old. The helpers scheduled one sky/PMREM refresh in every window; the original reflection preset normally refreshes every 24 seconds and the new one every 16. New Performance completed three cloud captures in every measured run, including its GPU profile.

| Preset budget | Original | New |
|---|---:|---:|
| Cloud samples / passes | 20 / 2 | 64 / 4 |
| Cloud lighting samples | 6 | 14 |
| Display strategy | Live march at one-third resolution | 2048×1024 panoramas, 32 bands, 9-second refresh/blend |
| Cloud shadow resolution | 256 | 384 |
| Sky reflection bake | 256×128, 2 passes | 384×192, 3 passes |
| Rain / impact instances | 5,500 / 320 | 10,000 / 700 |
| Rain surface field | 512 at 6 Hz | 768 at 8 Hz |
| Cloud light cache | 72×20×72, 0.33 s | 112×28×112, 0.22 s |
| Panorama/distance texture storage | None | 60 MiB |

The comparison includes all these budget differences. The new mode spends part of its cloud saving on more detailed clouds and larger supporting-effect budgets. Its volume is still temporally sampled, with approximate motion/parallax reprojection. These tests do not establish quality equivalence or performance across every sky, weather, camera path or host game. The [old](old-rain.png) and [new](new-rain.png) screenshots were captured after timing and visually inspected; their cloud edges and rain densities differ as expected from the presets.

| Profile | Version | Run | FPS | Mean ms | p95 ms |
|---|---|---:|---:|---:|---:|
| native | old | 1 | 239.3 | 4.18 | 4.30 |
| native | old | 2 | 239.5 | 4.18 | 4.30 |
| native | new | 1 | 239.3 | 4.18 | 4.30 |
| native | new | 2 | 239.5 | 4.18 | 4.30 |
| limited | old | 1 | 76.8 | 13.02 | 20.00 |
| limited | old | 2 | 81.3 | 12.31 | 17.00 |
| limited | new | 1 | 83.2 | 12.02 | 16.80 |
| limited | new | 2 | 82.9 | 12.06 | 16.90 |

Aggregate FPS is total frames divided by total measured time across the two runs, and mean frame ms is the reciprocal. The constrained paired gains were 8.4% in the first pair and 2.0% in the reverse pair. The old runs varied more; the averaged gain should be treated as an observation under this load, not a guaranteed speedup.

GPU timings are separate sums of WebGPU begin/end timestamps for all frame render/compute passes. They include the periodic reflection refresh and amortized cloud captures, but exclude idle time; reciprocal GPU milliseconds is not measured FPS. The dedicated live-cloud pass averaged 0.292 ms/frame; new panorama capture passes averaged 0.005 ms/frame. Panorama display and compositing are included in the application total, not the dedicated-pass number. There were 3,611 original and 3,599 new GPU samples.

The first GPU pair was excluded from the speedup calculation because machine load changed sharply: the original run saw 98% total GPU utilization and roughly 17 GiB in use, while the subsequent new run saw 37–45% utilization and roughly 11 GiB. Both were repeated in reverse order with process counters during the measurements. 0/2 replacement GPU runs passed the strict external-GPU peak check: desktop compositor/terminal peaks were 5.14–6.11%, with per-process means of 1.29–3.56%. The repeat distributions were much steadier, but the reported delta remains a measurement under ambient desktop activity. Both exploratory runs remain archived and identified in the JSON; their timings were not blended into the reported GPU comparison.

All 8 throughput runs exceeded the CPU quiet threshold in a before/during sampling window. During-run external CPU activity ranged from 7.7% to 10.7% of total logical CPU capacity. 6/8 passed the external-GPU peak check; all four constrained runs passed. Other processes and accounts were left alone. Runtime error lists were empty in every throughput run and both GPU final-state checks.

The constrained profile applied CDP CPU rate 4 to the owned page plus the same seeded 1818-iteration GPU memory-latency workload for every old/new run. Calibration targeted 8 ms once; recorded per-run workload means were 8.81–9.19 ms. This tests resource contention on the same architecture and VRAM, rather than emulating a named lower-end GPU. Hardware power and clock settings were unchanged.

GPU: NVIDIA GeForce RTX 5090 Laptop GPU, driver 610.88. Browser: Chrome/153.0.8010.36. [Measurements, presets and hashes](measurements.json) include compressed raw evidence under [raw](raw/). This folder is excluded from the hosted demo package.

Reproduce in the one owned QA page with `node qa/performance-comparison-run.mjs performance native 1 31a107f performance-history-20260912 old`, then `node qa/performance-comparison-run.mjs performance native 1 current performance-history-20260912 new`. Repeat in reverse order using run `2`. Replace `native` with `limited` for resource pressure, or `gpu` for separate GPU profiles. The reported GPU pair uses repeat `2` (new then old); repeat `1` is retained as the exploratory pair described above. The series-specific fixed GPU workload is saved at `.artifacts/performance-history-20260912/gpu-workload.json`. Windows resource counters need CIM/performance-counter access. Throttling and GPU contention are restored after each run. `node qa/summarize-performance-history.mjs` validates and archives the results.
