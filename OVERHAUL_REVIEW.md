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
  a synthetic user gesture. One owned headless preview is now running with that guard; its PIDs are recorded in `.artifacts/overhaul-20260906/processes.json`.
- Player contacts now preserve incoming velocity along the contact normal;
  the wall-brace animation previously read speed after collision stopped the
  player. Executable controller tests cover frontal, sprint, sliding, held
  contact, and multiple frame rates.
- SSR skips its receiving pixel and clear-depth receivers, rejects subpixel
  projected rays, and guards grazing-angle and step-count denominators.
  Earth and Ringworld compiled and rendered with these guards. Isolated raw
  SSR captures still show the Inanna shell's engraved pattern in its own hit
  buffer. Explicitly convex groups now carry exact IDs in opaque normal-buffer alpha. GPU hit-coordinate readback found 2,154 valid orb-to-scene hits, 105 scene-to-orb hits, and zero same-group hits in the diagnostic view. Remaining engraved patterns reflected the dais/terrain; the original screenshot alone did not distinguish those from self hits. Concave meshes and instances retain self reflections. Motion review remains pending.
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
  `artifacts/overhaul/ring-relief-data.png`; the new relief has also been inspected on the rendered ring. Higher-resolution drainage/ridges are visible; the water level and shore remain intact.
- The frame scheduler now includes callbacks skipped during an in-flight
  render in the next simulation delta. Previously walking/falling slowed down
  when rendering missed display frames. Pauses and sky rebuilds discard elapsed
  input time; failed renders no longer count as completed frames.
- Opt-in `?benchmark=1` exposes `_benchmark.start(metadata)` and
  `_benchmark.stop()`. Reports retain raw frame intervals, median/p95/p99,
  render-task duration, and invalidation reasons. These are CPU submission
  timings, not GPU timestamps. Preliminary unthrottled samples exist for Ringworld (54.2 FPS before the rough-SSR cutoff) and Earth (96.9 FPS after it), both Balanced at 1600?900. These different scenes are not a before/after comparison or a clean final benchmark.
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

## September 7 checkpoint

- Local terrain uses the two strongest world projections with explicit gradients and world-space normal blending. Flat ground retains five reads per texture array; slopes conditionally use ten. The real TSL backend audit passes 89 checks, and the default Earth ground view was inspected.
- SSR ray marching skips roughness >= 0.75 and smoothly hands the directional reflection back to native filtered PMREM between 0.55 and 0.75.
- All 711 authored rock placements now feed their exact rendered transforms to the existing convex hull streamer. Bounds-aware activation supports large boulders; walkable hull tops support landing. Four controller tests cover large extents, sweeping/sliding, landing, and tilted planes.
- Imported Standard/Physical materials now carry the celestial-only cloud shadow hook through Three's node conversion. The same high-cloud density and curved/spherical intersections drive visible wisps and faint ice-cloud shadows. Disposal restores original hooks.
- Shieldworld's visible moon supplies the scene/cloud light direction. Its surface reflects the star's constant spectrum instead of the observer's night palette, uses a particulate reflectance blend, and draws behind the shield/clouds while fading. Hidden daytime debris avoids 7,000 matrix updates/uploads. Red-giant convection is slower, larger, and projected over the spherical disc, with corrected ordered smoothstep edges and broader warm light.
- Settled Shieldworld clear/star, clear/moon, cumulus/moon, cumulus, stratus and cirrus screenshots are in `artifacts/overhaul/matrix/`. Star and moon details were inspected at full resolution. Cirrus still reads too much like smooth strokes and needs another form pass.
- Rock footsteps now select stone only at the supporting height. The gait audit passes 17 checks. Web Audio decoded all 38 runtime assets with finite samples and runtime-trimmed sample peaks below 0 dBFS. This is a decoder/level check, not a listening acceptance. The ffmpeg/ffprobe audit cannot run because neither executable is on PATH.
- 29 executable unit tests pass; reflection topology (95), sky resource lifecycle (69), state-axis behavior (328), input (33), and sky stability (34) source checks pass. These counts do not replace engine inspection.
- Added user scope: improve falling rain, puddles and wetness on arbitrary geometry after the current scene/reflection checks. Rain exposure/occlusion and material mapping are part of that stage.

References for these changes:
- [Blending in Detail](https://blog.selfshadow.com/publications/blending-in-detail/) describes normal reorientation and whiteout blending.
- [Epic SSR settings](https://dev.epicgames.com/documentation/en-us/unreal-engine/screen-space-reflections-in-unreal-engine) describe roughness fading and its cost tradeoff.
- [USGS photometric models](https://isis.astrogeology.usgs.gov/8.3.0/Application/presentation/PrinterFriendly/photemplate/photemplate.html) give Lommel-Seeliger/Lambert particulate reflectance; the moon shader is an artistic blend, not calibrated photometry.
- [ALMA observations of Betelgeuse](https://www.almaobservatory.org/en/audiences/alma-reveals-long-lived-hotspots-on-betelgeuses-bubbling-surface/) inform large, slowly evolving convection and persistent hot regions.
- [Lagarde and Harduin: The Art and Rendering of Remember Me](https://seblagarde.wordpress.com/wp-content/uploads/2013/08/gdce13_lagarde_harduin_light.pdf) covers wet material response, rain and surface water.

## Rain and CPU profiling checkpoint

- Rain now shares a bounded local depth/normal capture with wetness and splashes.
  The GPU contract passes 14 surface cases, two wind cases, and renderer/material
  rollback after an injected failure. Cases include skinned/vertex-deformed roofs,
  instances, slopes and alpha-cutout openings. Tangent-plane reconstruction reduced
  the tilted fixture's height error from 3.9 cm to 0.05 cm. Integration and limits
  are documented in `engine/RAIN.md`.
- Thin streaks use two continuous integrated fall phases and a stable pixel
  footprint. Splash crowns land on captured surfaces. Puddles flatten the mapped
  normal, use water F0, and receive small normal ripples. Wetness and surface water
  build/dry at different rates; the weather selector changes their target supply.
  Dry materials skip wet-mask sampling. This is not a runoff/fluid simulation.
- Earth wet-orb motion retained 4,071–4,800 orb-to-scene SSR hits in the five
  sampled poses, with zero same-convex-group hits. Dry stone may correctly have
  zero floor-to-orb hits because its roughness exceeds the SSR cutoff.
- A CPU profile found shared shadow override alpha-test changes repeatedly
  invalidating all casters' material keys. Stable variants per source material
  remove this churn while retaining the renderer's native shadow implementation.
  The paused before/after engine screenshots are byte-identical. Three executable
  tests cover mixed opaque/cutout casters, invalidation and disposal/rollback.
- Before the shadow-cache change, a clean Earth Balanced run at 1600×900 measured
  101.2 FPS (p95 interval 12.6 ms); separate GPU timestamps averaged 4.24 ms.
  The first 4× CPU-slowdown result is **invalid** under the contamination gate:
  Windows Terminal reached 5.45% GPU usage. Raw data is retained; it is not a clean
  constrained-performance claim. Final comparisons are being rerun.
- Source audits: weather/audio 503, reflection 95, sky lifecycle 69 and terrain
  TSL 89 passed. The audio gait audit still passes all 17 checks.
