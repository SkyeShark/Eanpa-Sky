# Performance cloud display review

This is the superseded first capture implementation. See the
[Performance cloud correction](../performance-cloud-motion/index.html) for the
denser sampling, continuous motion, and new validation.

The existing Performance preset now displays periodically captured volumetric
clouds. Balanced and High retain the live volume pass. There are still three
quality settings. Runtime tested: `8a8ad67`; comparison: published r186 `31a107f`.

Cloud shadows, receiver geometry, rain, impacts, puddles, lightning, celestial
motion and local reflections keep their independent updates. Environment bakes
sample the completed cloud images and retain native PMREM/PBR filtering. No
demonstration assets were changed for these measurements.

Open [the visual review](index.html), or start the engine with
`/?quality=performance`. [Integration and limitations](../../../docs/SKY_SYSTEM_INTEGRATION.md#performance-cloud-display).

## What Performance trades

The cloud volume is captured into three 2048 by 1024 RGBA16F panoramas: previous,
current and staging. Captures refresh every three seconds, or sooner for
significant changes. Thirty-two bands spread work over host frames, followed by
a half-second crossfade. Unfinished bands never enter the display or reflections.
The first full image completes during startup warmup.

World-direction lookup makes camera rotation immediate. Wind and translation
approximately warp the captured image at a representative cloud altitude;
current lighting, eclipse visibility and lightning still affect the display.
Fine detail and exact multilayer parallax are reduced. Cloud shape evolves
between captures through blending. Fast flight through clouds and abrupt weather
cuts suit Balanced/High better. The three cloud targets add 48 MiB. Live shadows
can differ slightly from the approximate displayed position between captures.
Performance's existing 24-second regular environment-refresh budget is retained;
the standalone also requests earlier weather/time refreshes.

## Measurements

RTX 5090 **Laptop** GPU, Three r186, 1578 by 846, Earth rain at 11 h. The fixture
contains six simple host meshes, including a roof, slope and chrome receivers.
Each throughput run lasts 12 seconds, moves the camera and schedules one real
sky/environment refresh. All windows included background CPU activity; some
also flagged external GPU work. These samples do **not** establish a reliable
percentage FPS improvement or a clean ranking of the tiers.

| Setting | Native FPS | Constrained FPS | Constrained p95 frame |
| --- | ---: | ---: | ---: |
| Previous Performance | 167.7 | 70.6 | 18.8 ms |
| Cached Performance | 210.5 | 72.0 | 17.4 ms |
| Balanced | 172.1 | 40.4 / 59.2 repeat | 38.1 / 21.0 ms |
| High | 169.8 | 60.3 | 20.9 ms |

The Balanced repeat followed an anomalous first run whose warmup overlapped
43% external CPU activity. Both results are retained. Constrained means 4x CDP
CPU throttling plus a synthetic GPU workload calibrated to 8 ms. Its actual cost
varied roughly from 7 to 11 ms, recorded in each JSON. This limits available
resources; it does not emulate another GPU's architecture, bandwidth or memory.

Separate 600-frame WebGPU timestamp captures measured total fixture GPU work at
**1.117 ms before and 0.935 ms after**, about **16% less**. The cloud-generation
pass fell from **0.2063 to 0.00844 ms per frame**, about **96% less**; the new
panorama lookup/composite remains included in the total. These timings exclude
queue idle time. Readback changes pacing, so they are separate from throughput.
The live timestamp window included one sky environment refresh and the cached
window none; that difference contributed less than 0.002 ms per frame.

Full measurements, resource qualifications and compressed raw timestamp logs
are linked in [measurements.json](measurements.json). The constrained FPS gain
was modest. This change mainly saves cloud GPU work; it is not a large CPU fix.

## Validation

- Existing 92 Node tests passed on the runtime changes.
- GPU contracts: 14 publication/scissoring/lifecycle checks, five frozen-uniform
  checks, eight real-sky live-response checks; all passed.
- All 13 cloud/weather transitions passed for each of Earth, Ringworld and
  Shieldworld (39 cases). These accelerated cases check lifecycle, not FPS.
- An actual 45-second rain-to-dark-storm transition completed with no runtime
  pipeline builds or GPU errors; 11,297 frames, maximum interval 24.9 ms.
- Sunset cloud-shadow publication stayed continuous on ground and 25 m roofs
  across 2.4 km. All 55 rain-surface/shelter cases passed. Local reflection
  reprojection passed for all six host meshes, with zero depth mismatch.
- Captured views were inspected for Earth day/cirrus/rain/storm/night, the
  Ringworld eclipse and cirrus, and Shieldworld clouds and star. The nine-second
  normal-speed cloud clip has four separately inspected keyframes. These images
  show representative results; they do not constitute exhaustive flight testing.

The full demo's quality-switch warmup remains slow: the switch into Balanced
spent 175.7 seconds preparing its surface/weather rendering, of which 160.9
seconds were the scene MRT shader compile. It completed without errors. This
work improves steady-state cloud cost; it does not resolve that full-scene
compilation delay. This is separate from the weather-preset transitions tested
above, which changed no shader pipelines.

## Reproduce with one browser

Use the existing owned CDP session at port 9223 and loopback server at 8378.
The commands below reuse its one page. Run them sequentially, waiting for each
to finish. Resource counters require Windows permission to read performance data.

```text
node qa/compare-cloud-revision.mjs 31a107f performance rain earth
node qa/sky-benchmark.mjs comparison-before native 12
node qa/sky-benchmark.mjs comparison-before limited 12
node qa/gpu-profile.mjs comparison-before 600
node qa/compare-cloud-revision.mjs current performance rain earth
node qa/sky-benchmark.mjs comparison-after native 12
node qa/sky-benchmark.mjs comparison-after limited 12
node qa/gpu-profile.mjs comparison-after 600
node qa/run-gpu-contract.mjs qa/cloud-panorama-contract.js .artifacts/panorama.json
node qa/run-gpu-contract.mjs qa/cloud-snapshot-contract.js .artifacts/snapshot.json
node qa/run-gpu-contract.mjs qa/cached-cloud-live-contract.js .artifacts/live-response.json
node qa/fixture-transitions.mjs
```

The revision comparison serves the old tracked source into that same page
through CDP request overrides; it does not modify the checkout. The benchmark
restores CPU throttling and removes its GPU contention work in `finally`.
