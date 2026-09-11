# Release notes

## 0.2.1 CPU follow-up — 2026-09-11

Reuse native shadow-filter parameter nodes across receiving materials so the
renderer can share equivalent lighting buffers. The default Earth/Balanced
comparison performs about 65% fewer buffer-upload calls and 58% fewer uniform
comparisons, without changing visual quality or demonstration assets.

See [CPU measurements, resource-stress results and validation limits](https://github.com/SkyeShark/Eanpa-Sky/blob/main/qa/review/cpu-optimization-20260910/README.md).

## 0.2.1 follow-up — 2026-09-10

Correct the eclipse cylinder's center to match the displaced band. Keep valid
short shadow rays at the local solar tangent, removing the remaining water-only
lighting cutoff on the arc facing away from the temple. Smooth the existing
twilight handoff to the authored night illumination. Give the existing celestial
depth pass a suitable near plane to prevent distant land and water from producing
stripes. Local PBR
surfaces now receive the same moving eclipse shadow as the ring.

See [the Ringworld validation and visual comparison](RING_REVIEW_2026-09-10.md).

## 0.2.1 — 2026-09-10

Startup prepares independent GPU pipelines in bounded groups instead of waiting
for each one individually. Offscreen targets and native PBR now precompile with
the same attachment settings and pass context used by the first render.

The sky's 20-by-6 light-shaft/rain march uses GPU loops instead of duplicated
shader code. Reusable analytic noise functions keep the existing arithmetic;
32,768 GPU comparisons matched the original noise and FBM exactly. Cloud sample
counts, materials, weather options and the default Earth scene remain intact.

The loading screen reports the active preparation stage. See
[startup validation](STARTUP_REVIEW.md) for timings, cache conditions and the
remaining download/compilation costs.

## 0.2.0 — 2026-09-10

The standalone sky and weather overhaul, including the subsequent visual-review
corrections, is available in the [live demo](https://skyeshark.github.io/Eanpa-Sky/).

- Native PBR reflections combine screen-space geometry, a local probe and the
  sky environment. Motion/depth validation and skinned-mesh history address
  reflection stripes and jitter while preserving chrome and material response.
- Shared cloud shadows cover ordinary scene geometry. Cloud motion, weather
  transitions, sunset projection and shadow publication remain continuous.
- Cirrus and distant Ringworld clouds have revised structure and motion.
  Ringworld terrain uses eroded relief, corrected material projection and level
  seas; the daytime eclipse follows the observer and lights the band consistently.
- Rain uses local cloud coverage and arbitrary surface exposure. Sloped impacts,
  shelter-aware audio, wetness and puddles share the surface system. Moisture
  accumulates after local rain arrives and persists as the cloud moves away.
- The red giant retains animated plasma, finer surface detail and sunspots, with
  radiant flares on its limb and front. Moon fragments keep bounded clearance.
- Weather warmup, renderer resource ownership and shared sky caches reduce
  avoidable stalls and repeated work. Lighting, lightning and player contact
  fixes are included alongside the retained regression checks.
- GitHub Pages now deploys a checked runtime package through Actions. Editor and
  source duplicates stay in GitHub without consuming the hosted site's budget.

Validation includes 70 Node tests, numerical GPU contracts, visual captures and
normal-speed motion recordings. Shared sky/effects benchmarks include native
5090 runs and explicit CPU/GPU stress conditions; those simulations do not
represent a named lower-end device. Quality labels are workload targets, not
frame-rate caps. Startup compilation can still be expensive.

See [known limitations](KNOWN_ISSUES.md), the
[overhaul report](OVERHAUL_REVIEW.md), and the September
[8](REVIEW_2026-09-08.md), [9](REVIEW_2026-09-09.md) and
[10](REVIEW_2026-09-10.md) follow-up reports for evidence and scope.
