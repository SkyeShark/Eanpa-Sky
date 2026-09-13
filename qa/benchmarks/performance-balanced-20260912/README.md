# Performance versus Balanced — 12 September 2026

Performance reduced measured application GPU work by **44.5% (1.15 ms per frame)** in this 1080p rainy Earth fixture. Throughput improved approximately **1.7% natively** and **10.2% under synthetic resource pressure**. The small native difference should be treated cautiously because of background CPU activity and browser scheduling variation.

| Measurement | Balanced | Performance | Observed change |
|---|---:|---:|---:|
| Native RTX 5090 Laptop GPU | 227.9 FPS / 4.39 ms | 231.7 FPS / 4.32 ms | +1.7% FPS; 0.07 ms saved |
| 4× CPU slowdown + fixed competing GPU workload | 66.4 FPS / 15.06 ms | 73.2 FPS / 13.66 ms | +10.2% FPS; 1.39 ms saved |
| Application GPU work per frame | 2.59 ms | 1.44 ms | 44.5% less GPU time |

Frame times in throughput rows are total measured time divided by total frames across the two runs. GPU time is the sum of actual WebGPU timestamps across render and compute passes, including the periodic sky/PMREM refresh; it excludes idle time and does not imply reciprocal FPS. Dedicated cloud volume passes cost 0.880 ms/frame for Balanced versus 0.005 ms/frame amortized for Performance's captures. Panorama display/compositing is included in the application GPU total, not that dedicated-pass figure.

Both tiers used Earth at 11:00, settled Rain, 1920×1080 at device scale 1, and the same orbit phase at measurement start. The fixture retains cloud shadows, native PBR/SSR reflections, rain, impacts, wetness, surface-aware puddles, and six generic surfaces. It contains no temple, terrain assets, vegetation or player simulation. These FPS figures apply to that reusable-effects fixture, not the full demo.

Each fresh page received 30 seconds of real-time warmup followed by 30 seconds of measurement. There was no accelerated simulation clock. Native order was Balanced → Performance → Performance → Balanced; constrained order was the same. Every throughput and GPU run included one sky reflection/PMREM refresh. Performance completed three or four cloud captures in each throughput run and three during its GPU profile. Both tiers use their unchanged current preset definitions; no engine source was edited for these tests.

| Profile | Tier | Run | FPS | Mean frame ms | p95 frame ms |
|---|---|---:|---:|---:|---:|
| native | balanced | 1 | 228.7 | 4.37 | 5.60 |
| native | balanced | 2 | 227.1 | 4.40 | 5.80 |
| native | performance | 1 | 234.0 | 4.27 | 4.80 |
| native | performance | 2 | 229.5 | 4.36 | 5.40 |
| limited | balanced | 1 | 68.9 | 14.51 | 19.00 |
| limited | balanced | 2 | 63.9 | 15.64 | 20.70 |
| limited | performance | 1 | 73.5 | 13.60 | 17.10 |
| limited | performance | 2 | 72.9 | 13.72 | 19.30 |

All throughput runs passed the external-GPU quiet check. Background CPU usage during measurements ranged from 5.4% to 9.8% of total logical CPU capacity; every run exceeded the 5% quiet threshold in its before/during windows. The later empty-page RAF measurement averaged 226.1 callbacks/s (4.42 ms). That is consistent with scheduling limiting this native comparison, but does not establish an exact cap or isolate a CPU bottleneck. The 44% GPU reduction is the clearer result.

The constrained runs used CDP CPU throttling at 4× on the owned page and the same seeded GPU workload at 1,983 iterations. It was calibrated once toward 8 ms and then held fixed for both tiers. Runtime sample means ranged from 8.70 to 9.42 ms. This is resource contention on the same 5090 Laptop GPU, not a prediction for any specific lower-end device. Hardware clocks/power settings and other applications were left alone.

Performance's three HDR panorama/distance pairs allocate 60 MiB. Its clouds remain temporally sampled with approximate reprojection; this test measures cost and does not establish quality equivalence or gains for every cloud type, sky, resolution or host game. The two included screenshots were visually inspected for active rain, reflections and surface effects after measurements. Screenshots and GPU timing readbacks were collected separately from throughput measurements. Every throughput run used the same Windows resource-counter monitor. No runtime errors were recorded in the throughput runs or final fixture state.

Runtime commit: `6104d2db1aefb5960112e3d7973df44e3f7f7c79`. Browser: Chrome/153.0.8010.36; GPU: NVIDIA GeForce RTX 5090 Laptop GPU, driver 610.88. [Exact measurements](measurements.json), [Balanced view](balanced-rain.png), [Performance view](performance-rain.png). Raw JSON is gzip-compressed under [raw](raw/), with SHA-256 hashes in the measurements file. This directory is outside the hosted demo's `qa/review` packaging path.

Reproduce using the one owned QA browser and existing loopback server:

`node qa/performance-comparison-run.mjs balanced native 1`

Replace the tier with `performance`, the profile with `limited`, and repeat with `2` to reproduce the four runs per profile in the recorded order. The first constrained run writes the fixed-workload calibration to `.artifacts/performance-balanced-20260912/gpu-workload.json`; subsequent runs reuse it. GPU profiles use `balanced gpu 1` and `performance gpu 1`. `node qa/raf-baseline.mjs` measures the empty-page scheduling context after the engine tests. Resource counters require permission to read Windows CIM/performance data. The helpers restore the owned page's throttle and GPU contention after measurement.
