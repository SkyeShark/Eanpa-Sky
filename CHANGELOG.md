# Release notes

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

Validation includes 70 Node tests, numerical GPU contracts, visual captures and
normal-speed motion recordings. Shared sky/effects benchmarks include native
5090 runs and explicit CPU/GPU stress conditions; those simulations do not
represent a named lower-end device. Quality labels are workload targets, not
frame-rate caps. Startup compilation can still be expensive.

See [known limitations](KNOWN_ISSUES.md), the
[overhaul report](OVERHAUL_REVIEW.md), and the September
[8](REVIEW_2026-09-08.md), [9](REVIEW_2026-09-09.md) and
[10](REVIEW_2026-09-10.md) follow-up reports for evidence and scope.
