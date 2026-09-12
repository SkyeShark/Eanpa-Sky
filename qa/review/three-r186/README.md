# Three.js r186 upgrade validation

Eanpa now vendors **three@0.186.0**, the stable release verified on September 12,
2026. The runtime upgrade is local commit `5b3cc5d`; the reviewed r184 baseline
is `c8a3571`. Application version remains 0.2.1 pending a separate release.
Core, WebGPU, TSL and addons come from the same integrity-checked npm package.
See [provenance and retained patches](../../../vendor/three/EANPA_PATCHES.md),
the [official release](https://github.com/mrdoob/three.js/releases/tag/r186), and
the [capture viewer](index.html).

## Compatibility and correctness

All 92 Node tests pass. They cover the renderer preparation queue and progress
callback, pass lighting/context restoration, shared shadow uniforms, r186
skeletal history, explicit texture-matrix policy, and package consistency,
alongside the existing engine tests.

The GPU checks in [validation.json](validation.json) pass. They verify current
reflection depth/motion on six host meshes, cloud-shadow publication at sunset,
surface normals through wet/dry changes, rain accumulation, roof sheltering,
instancing, cutouts, vertex deformation, skinned roofs, and impact smoke.
All 13 accelerated weather/cloud transition cases complete without a phase
jump, reversed wind or rendering error. These are lifecycle checks, not
measurements of real-time transition smoothness.

The shadow diagnostic from the earlier CPU work exposed a real resize-order
problem. Rendering a second receiver pass with new shadow dimensions could
defer allocation until the next frame, after the material observer had already
recorded the new size. Static receivers then kept a destroyed GPU depth view.
The resize now finishes in that second pass; the ordinary once-per-frame
guard remains. Both identical and distinct shader graphs pass the PCF and
point-light GPU readbacks, with zero WebGPU validation errors. This does not
force native light intensity to update more than once per animation frame.

The optional legacy compositor uses the existing Eanpa tracer because the new
upstream SSR addon stores ray distance in alpha instead of hit coverage. Its
GPU contract confirms 268 local-hit samples with finite coverage in [0,1].
It remains a diagnostic compositor with a different lighting composition;
ordinary launches continue to use native PBR reflection transport.

## Visual review and timing limits

One owned headless Chrome page and one existing local server were used. Earth,
Ringworld and Shieldworld rendered successfully; captures cover daylight,
night, rain, ring eclipse/cirrus, chrome, and animated red-giant plasma/flares.
The chrome motion clip begins just after an inspection teleport and a time
change, so its initial environment refresh is visible. Screenshots are look
checks; they cannot prove the absence of every temporal artifact.

The initial default Earth/Balanced comparison at 1578 × 846 measured 116.25 FPS
on r184 and 119.70 FPS on r186, with 12.5 ms p95 intervals for both. Those
10-second samples had uncontrolled external load and driver caches. They
support similar observed throughput, not a statistically established gain.
Raw captures are [r184](r184-baseline.json) and [r186](r186-comparison.json).

Shader preparation remains slow. Observed page/rebuild waits were about 55 s
for a repeat Earth boot, 156 s for Ringworld and 299 s for Shieldworld. These
are individual waits with uncontrolled caches and system load; they do not
establish a version-to-version startup regression or improvement.

## Resource stress on the reusable engine

The fixture has six generic host meshes, moving camera, sky, weather, wetness,
cloud shadows and reflections. It excludes demonstration assets/player
simulation. Each 10-second sample includes an environment-map refresh.
Native uses unthrottled browser CPU; limited uses 4× CPU slowdown and about
8 ms of calibrated competing GPU work per frame. Stress is restored afterward.

| Quality | Native FPS | Limited FPS | Limited p95 ms |
| --- | ---: | ---: | ---: |
| performance | 127.1 | 49.1 | 25.0 |
| balanced | 160.3 | 44.8 | 28.3 |
| high | 168.6 | 53.3 | 23.7 |

These are **contended stress observations**, not clean tier comparisons or
predictions for named devices. The physical GPU remains an RTX 5090 Laptop
GPU, including its architecture and VRAM. Another application used roughly
65% of the GPU during an early sample; every sample had substantial external
CPU activity. The inverted tier ordering illustrates that changing external
load dominates comparisons here. All six runs finished with no rendering
errors and an environment refresh; process-utilization and calibration data
are retained in the per-profile JSON files. No other workloads or power
settings were changed.

## Reproducing the checks

Use the existing owned QA page and run `npm.cmd test`.
Load `/qa/sky-fixture.html?sky=earth&quality=high&weather=rain` for native
contracts, and append `&legacy_reflections=1` for
`qa/legacy-reflection-contract.js`. `qa/fixture-transitions.mjs` exercises
the weather/cloud matrix. `qa/sky-benchmark.mjs <name> native|limited 10`
records stress and external utilization. GPU contracts are browser expressions
run using `qa/cdp.mjs eval <file>`.
