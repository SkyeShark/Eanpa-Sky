# Earth / Balanced performance investigation

Investigated the report of a static Earth view falling from the user's earlier
120–160 FPS to roughly 60 FPS. This capture reproduces reduced throughput, but
does **not** establish which change caused the historical regression or measure
the user's exact browser/view. No runtime changes were retained from this
investigation.

Revision: `73b421b86c4994aed93ed69a35ed0333af8a7f7d` (v0.2.1).
Local capture: September 10, 2026, Pacific time. The JSON clocks use UTC.

## Reproduction

One dedicated headless Chrome, local server, unthrottled CPU, RTX 5090 Laptop
GPU, 1578 × 846 drawing buffer, DPR 1. Earth, Balanced, Cumulus, weather None,
10.5 h, fixed day cycle. Default camera `[0, 1.82, 96]`, FOV 52 degrees.
The screenshot records the view; its instantaneous HUD is not the benchmark.

| Measurement | Result |
| --- | --- |
| Completed-frame throughput, 12-second sample | 80.75 FPS |
| Frame interval, mean / median / p95 | 12.38 / 12.50 / 20.90 ms |
| Sum of GPU pass timestamps, separate 120-frame capture | 4.71 ms mean, 4.64 ms median |
| Volumetric cloud GPU pass | 1.08 ms per frame |
| Main scene PBR GPU pass | 2.75 ms per frame |
| Current reflection geometry GPU pass | 0.30 ms per frame |
| Buffer writes, instrumented 4-second sample | 257,837 over 311 frames (829/frame) |

GPU readback intentionally waits during the timestamp capture. Its FPS must not
be used as throughput. FrameMetrics' render-task field includes the interval
from the rAF timestamp until completion, including callback scheduling latency;
it is not isolated CPU execution time.

The normal throughput sample's DevTools TaskDuration increased by 11.97 seconds
over 12.01 wall-clock seconds. A separate OS CPU-time sample measured the owned
renderer process at 1.11 cores and its GPU process at 0.81 cores. On 24 logical
processors, one busy core is only about 4.2% of total CPU capacity. The CPU
sampling profile concentrates in draw preparation, uniform comparisons,
binding updates and native WebGPU writeBuffer calls. Together these indicate
a CPU submission bottleneck in this reproduction despite available GPU time.

This is **not a clean hardware benchmark**: a simultaneous OS sample found
external processes consuming 23.72% of aggregate CPU capacity, including
Blender at 4.07 cores and Python at 0.96 cores. These processes were untouched.
External GPU use stayed below the existing 5% gate. The influence of CPU
contention, scheduling and laptop power sharing has not been isolated.

## Upload experiment

A temporary browser hook combined multiple dirty ranges of small uniform
buffers into one upload. Every hook was restored after each experiment. No
material, shader, geometry, resolution or quality option was changed.

The first instrumented comparison reduced upload calls from about 830–850 to
322–325 per frame, but subsequent measurements **without upload instrumentation**
did not show a consistent throughput benefit:

| CPU setting | Original FPS | Combined FPS |
| --- | --- | --- |
| Native, first pair | 88.66 | 78.35 |
| Native, second pair | 81.80 | 85.38 |
| 2× DevTools CPU slowdown | 26.96 | 24.38 |

The synthetic CPU slowdown leaves the local GPU unchanged and is neither a
lower-end device simulation nor an FPS prediction for one. Concurrent CPU work
also makes these observations unsuitable for accepting an optimization. The
upload experiment was rejected; fewer API calls alone did not demonstrate a fix.

## What this does and does not establish

- Balanced's 60+ FPS label is a target, not an application frame limiter. The
  measured independent rAF cadence matched completed-frame cadence; there was
  no evidence of systematic alternate-frame skipping in that capture.
- An unmoving camera still renders animated skies, shadows, material lighting,
  reflections and postprocessing. The observed CPU cost belongs primarily to
  the shared renderer/material/reflection integration, rather than the cloud
  raymarch's GPU cost.
- Source comparison with `f2a3594` found that the reviewed ring changes add no
  ring eclipse shader to Earth: its optional solar occluder remains null, and
  Earth has no ring geometry capture layer. This is source inspection, **not**
  a measured old/new revision performance comparison.
- Earlier generic-host sky benchmarks and full demonstration benchmarks used
  different views/workloads. They cannot establish a 120–160-to-80 FPS
  regression in this exact view. The user's live/local URL, browser, resolution,
  cloud type and weather were requested and remain unconfirmed.

The next useful optimization work is to measure and reduce repeated material
and binding preparation across the reflection and scene passes, with matched
before/after views and external workload records. Preserve per-surface PBR,
motion-aware reflections and universal weather reception. Demo mesh batching
and reductions in cloud quality do not address the identified integration cost.

Three's [r184 CPU performance audit](https://github.com/mrdoob/three.js/issues/33797)
independently identifies per-object binding/cache work and small uniform uploads
as renderer costs. It supports investigating these paths; it does not prove the
cause of this application's historical FPS drop. See also Chrome's
[performance profiling reference](https://developer.chrome.com/docs/devtools/performance/reference).

## Evidence

- `default-earth.png`: inspected reproduction view.
- `baseline.json`: raw frame intervals and DevTools timing capture.
- `gpu.json`: per-pass GPU timestamps and metadata.
- `cpu.cpuprofile`: load in Chrome DevTools to inspect CPU samples.
- `upload-counts.json`, `upload-abba.json`, `upload-uninstrumented.json`: the
  diagnostic experiment and its unsuccessful throughput validation.

No engine source changes, visual downgrades, sample asset edits or remote
publication accompany these findings. The owned inspection browser is closed
after capture; the existing local server remains available.
