# CPU optimization: shared native shadow uniforms

The retained runtime change is local commit `10301fd`. It fixes duplicated
shadow-filter references in the pinned Three r184 renderer. No demonstration
meshes, material appearance, quality presets, render resolution, reflection
passes or weather update frequencies were changed.

## What was costing CPU time

PCF, PCFSoft and point-shadow filter expansion created fresh `mapSize` and
`radius` reference nodes for each receiving material. Those different node IDs
prevented otherwise equivalent native lighting uniform buffers from being
shared. In the default Earth view, the main lighting group was updated roughly
68 times per frame across its receivers.

The renderer now caches these reference nodes per `LightShadow` in a WeakMap.
The properties remain live: lights can resize or replace their map dimensions,
and separate lights retain separate values. Filtering equations and samples
are unchanged. Hosts using another Three build must carry the patch described
in [the vendor notes](../../../vendor/three/EANPA_PATCHES.md).

## Same-view measurements

One owned headless Chrome, RTX 5090 Laptop GPU, 1578 × 846, DPR 1. Earth,
Balanced, Cumulus, no rain, 10.5 h, default camera `[0, 1.82, 96]`, FOV 52.
The baseline source is `9a69e7c`; old sources were substituted through CDP in
the same page, without changing the server or working tree. Every capture
restores interception and instrumentation before returning.

| Work per completed frame | Baseline | Retained fix |
| --- | ---: | ---: |
| GPU buffer upload calls | 842.75 | 291.67 |
| Uniform values compared | 12,313 | 5,190 |
| Uploaded bytes | 2,873,539 | 2,820,692 |
| Main-thread task CPU time | 13.28 ms | 10.24 ms |
| Throughput in those CPU captures | 74.01 FPS | 95.95 FPS |

Upload calls fell 65.4%; uniform comparisons fell 57.9%. Uploaded bytes fell
only 1.8%: this primarily removes repeated CPU preparation and small API calls.
Operation counts have instrumentation overhead and are captured separately
from throughput. CPU execution uses DevTools `Performance` with
[`timeDomain: threadTicks`](https://chromedevtools.github.io/devtools-protocol/tot/Performance/#method-enable),
dividing the task-duration delta by completed application frames. The
FrameMetrics render-task field is elapsed submission time, not isolated CPU
execution time.

These are **contended comparison samples**, not clean hardware benchmarks.
External CPU use was 23.01% in the baseline and 24.07% in the retained-fix
capture; Blender and Python were active. A later final-source run reached
120.46 FPS / 8.21 CPU ms per frame while external CPU use had fallen to 7.38%.
That later result cannot all be attributed to the code change. Other processes
and power settings were left alone. Uncapped rendering can continue occupying
a CPU core while using the savings to submit more frames.

## Experiments omitted from the final implementation

- Separating all Eanpa effect uniforms into a new shared group reduced some
  duplicated work on its own. After the shadow fix, it added little and its
  measured CPU time was worse (10.84 versus 10.24 ms/frame). It was removed.
- Skipping the generic cache lookup for object-scoped uniform groups showed
  only about a 1% difference in an alternating runtime trial. It was omitted.
- The earlier dirty-upload consolidation experiment remains rejected; this
  change avoids redundant buffer preparation before reaching the upload path.

## Validation and resource stress

The CPU pass uses `qa/cpu-fixture-matrix.mjs` for before/after runs on all three
quality tiers. The fixture contains six ordinary host meshes and the reusable
sky, rain, wetness, reflections and cloud shadows. Its camera moves and every
10-second stress window schedules an environment-map refresh. It contains no
demonstration assets or player simulation. Its FPS must not be compared to the
full demonstration's FPS.

- Native: CPU unthrottled, local GPU unchanged.
- Moderate: 2× DevTools CPU slowdown plus approximately 4 ms of calibrated
  competing GPU work per frame.
- Limited: 4× CPU slowdown plus approximately 8 ms of competing GPU work.

These are available-resource stress profiles, not emulation of a named device,
GPU architecture, memory capacity or driver. Each JSON retains calibration,
actual GPU timings, external process utilization and source hashes. Samples
with external GPU activity are marked and cannot establish an optimization
win or regression. Small host scenes already have little submission overhead;
the native fixture reaches the browser's approximately 240 Hz cadence.

All 18 matrix cases completed with no rendering errors and at least one
environment refresh. Observed final-source results are below; they are not
clean-device performance guarantees.

| Quality | Native FPS | Moderate FPS | Limited FPS / p95 interval |
| --- | ---: | ---: | ---: |
| Performance | 237.7* | 138.3 | 82.1 / 16.6 ms |
| Balanced | 239.5 | 160.3 | 78.6 / 16.9 ms (retry) |
| High | 176.2 | 107.3 | 76.8 / 16.8 ms |

`*` External GPU activity contaminated this native sample. Most windows also
exceeded the external CPU-use gate; flags remain in every file. The initial
Balanced/Limited sample fell to 33.1 FPS while external CPU utilization rose
to 62.34% and Blender GPU activity appeared. It remains in the raw matrix. The
retry had no external GPU gate violation and reached 78.6 FPS, but external CPU
activity still prevents a clean hardware claim. The six-mesh fixture provides
no convincing isolated native CPU improvement; the demonstrated saving is the
larger scene's repeated material/light buffer preparation.

`npm.cmd test` passes all 88 tests. GPU checks pass for motion-reprojected
reflection geometry, cloud-shadow publication at low sun angles on both ground
and 25 m roofs, and rain reception/shelter on ordinary, instanced, skinned,
cutout and vertex-deformed geometry.

`qa/shadow-uniform-validation.mjs` verifies that distinct PBR shader graphs use
one native PCF/PCFSoft lighting buffer instead of two, preserve separate red and
blue material colors, and match the original renderer's pixels before/after a
light-intensity change. Shadow-map replacement remains live. Point filters
retain other per-graph depth uniforms, so caching their mapSize/radius alone
does not fully merge their lighting groups.

### Separate existing renderer finding

The optional `identical` variant of that GPU check reproduces stale light
output with two identical plain PBR shader graphs when changing intensity
around an offscreen shadow-map resize. It fails in **both** the original and
patched renderer; the distinct-graph check passes in both. The failure is
retained in [the baseline failure](shadow-uniform-validation-baseline-identical.json)
and [the current failure](shadow-uniform-validation-identical.json), alongside
the reproducer. It is not counted as a passing test. Its cause is not yet
resolved. Eanpa's effect-wrapped material paths use custom shader nodes and
pass the checks above; this does not prove the separate plain-material case
is harmless in other host integrations.

The application weather sweep completed all 14 cases with frame progress,
zero failed frames and zero new pipeline compilations. The retained motion
captures show wet-ground/flashlight response and chrome surfaces during camera
movement. Screenshots cover Earth day/night, Ringworld cirrus and both arcs
during the eclipse, plus Shieldworld's red giant and its normal-time motion.
Instantaneous HUD values in those images are not benchmarks. The changed shader
uniform layouts required fresh GPU shader preparation on the first Ringworld
and Shieldworld loads; this pass does not claim to solve cold shader compilation.

Raw captures and visual review images accompany this report. The older
`qa/ssr-motion.mjs` diagnostic still targets the legacy SSR node and cannot run
against the current native reflection pipeline; the current geometry/motion
contract above was used instead. The puddle-search helper also found no fully
filled nearby puddle in its search region, so the flashlight image documents
wet terrain rather than claiming a measured puddle specular highlight.
