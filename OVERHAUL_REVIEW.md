# Standalone overhaul — September 2026

Local branch: `overhaul/2026-09-06`. Starting checkpoint: `e2e6496`.
That commit preserves the 15 previously modified files. No remote operations
are authorized until the user's final review.

## Validation conditions

- Hardware detected: NVIDIA GeForce RTX 5090 **Laptop GPU**, 24 GB, driver 610.88.
  Results must identify this configuration rather than imply desktop 5090 performance.
- Prior performance claims are retracted in the existing acceptance ledger.
- The user explicitly authorized one controlled browser and one local server
  on September 6, superseding the old prohibition on automated/CDP browsers.
  Record their PIDs, reuse this instance, and close the test browser when
  finished. Do not control existing user pages or launch competing instances.
- A reduced-resource test must state its actual constraints. CPU throttling
  does not emulate a slower GPU. Quality-tier comparisons are separate from
  hardware constraints; do not silently remove scene content.
- Source checks are not visual, interaction, listening, or performance acceptance.

## Work and evidence

- During inspection the user reported desktop cursor confinement. The owned
  headless page reported no pointer lock and zero lock requests; its browser
  and server were closed immediately. Cause is unconfirmed. Automated previews
  now use `?automated=1`, which prevents pointer lock even for trusted input.
  Capture helpers neither request foreground focus nor grant script evaluation
  a synthetic user gesture. The browser remains closed while this is checked.
- Player contacts now preserve incoming velocity along the contact normal;
  the wall-brace animation previously read speed after collision stopped the
  player. Executable controller tests cover frontal, sprint, sliding, held
  contact, and multiple frame rates.
- SSR skips its receiving pixel and clear-depth receivers, rejects subpixel
  projected rays, and guards grazing-angle and step-count denominators.
  Earth and Ringworld compiled and rendered with these guards. Isolated raw
  SSR captures still show the Inanna shell's engraved pattern in its own hit
  buffer. A further candidate fix gives explicitly convex groups exact IDs in
  opaque normal-buffer alpha and rejects hits on the same group. Concave meshes
  and instances retain self reflections. This candidate still needs runtime,
  motion, and positive-control checks; the reflection issue is not accepted as fixed.
- Cloud shadows now attenuate the celestial direct light through the native
  lighting model, preserving indirect light, emissive, alpha tests, and local
  lamps. Earth shaders compiled with this path. Tests cover light isolation,
  shared-material exclusions, and repeated wrapping. Ring shadow integration
  now uses the visible deck height/depth, and the active moon/sun direction is
  shared with the volume. Cross-sky/weather visual acceptance is still pending.
- Ring relief now has an offline deterministic uplift/erosion bake, with
  normals and directional-horizon AO derived from the same height field.
  `node qa/bake-ring-relief.mjs` regenerates the asset and its hash manifest.
  Float height storage bypasses the old canvas loader's reduction of the
  original 16-bit height PNG to 8-bit. Normal/AO share one texture. Numerical
  tests verify finite data, unit normals, storage orientation, and unchanged
  shore/water elevations. The diagnostic plot is at
  `artifacts/overhaul/ring-relief-data.png`; in-engine visual acceptance is pending.
- The frame scheduler now includes callbacks skipped during an in-flight
  render in the next simulation delta. Previously walking/falling slowed down
  when rendering missed display frames. Pauses and sky rebuilds discard elapsed
  input time; failed renders no longer count as completed frames.
- Opt-in `?benchmark=1` exposes `_benchmark.start(metadata)` and
  `_benchmark.stop()`. Reports retain raw frame intervals, median/p95/p99,
  render-task duration, and invalidation reasons. These are CPU submission
  timings, not GPU timestamps. No benchmark has been run yet.
- Static rock/cliff LODs reuse instance data when the camera/projection/viewport
  is unchanged. Rock pixel thresholds now use the actual drawing-buffer size
  instead of display DPR (the app renders at DPR 1).

## Remaining review scope

- SSR at the Inanna orb, close architectural metal, camera motion, occlusion
  boundaries, weather changes, and environment refreshes.
- Ring terrain relief: the source height field visibly contains blurred
  plateaus. Height, normals, AO, sampling, and tangent conventions need to agree.
- Local terrain projection/material placement, rocks and player collisions.
- Consistent sun/ambient/environment lighting across all skies and weather.
  Validate the new direct-light cloud attenuation across day/night and weather.
- Cloud forms/shadows, shattered moon, red giant, sound and interaction feel.
- Clean reduced-resource and unrestricted local GPU runs, repeatable capture
  routes, frame-time percentiles, error logs, and screenshots for final review.

## Technical references

- McGuire and Mara, [Efficient GPU Screen-Space Ray Tracing](https://jcgt.org/published/0003/04/04/):
  perspective-correct depth intervals and finite ray traversal.
- Hillaire, [Physically Based Sky, Atmosphere and Cloud Rendering in Frostbite](https://blog.selfshadow.com/publications/s2016-shading-course/):
  common extinction and lighting for skies, clouds, and their environment.
