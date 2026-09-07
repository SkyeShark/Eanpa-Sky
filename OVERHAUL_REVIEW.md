# Standalone overhaul review

**Reopened after the September 7 visual review.** The first pass did not meet
the requested visual or performance standard. The reflection artifact remains
reproducible, ring relief and cloud shadows were not convincingly improved,
moon fragments intersect during animation, and rain still needs visible falling
drops, impacts and puddles on arbitrary exposed geometry. The sections below
record the first pass; they are not acceptance evidence for the revised work.
The CPU-throttled runs did not simulate a weaker GPU, and the shadow-cache A/B
comparison did not establish a speedup over the original engine.

The work is on local branch `overhaul/2026-09-06`. Starting checkpoint `e2e6496`
preserves the 15 files already modified when this overhaul began. Subsequent
commits preserve the rendering, terrain, weather, physics, audio and validation
changes. Nothing has been pushed to a remote. Eidoverse integration is a later
stage; the standalone and its reusable weather interface are the current scope.

The review browser uses the existing server at **http://127.0.0.1:8378/**.
`node qa/browser-session.mjs review` replaces the one owned headless browser
with one visible browser using its dedicated profile. It waits for the old
process and debugging port to exit before launching the review window.
The process record is `.artifacts/overhaul-20260906/processes.json`.

## What changed

**Reflections.** Local SSR and the directional sky reflection now share a
single coverage budget. The sampled local scene holds out its native directional
environment lobe, avoiding a second, differently mapped sky reflection at the
hit. Grazing rays, background depth, receiving pixels and subpixel rays have
explicit guards. Only explicitly convex groups reject their own hits; concave
objects and instances retain legitimate self-reflection behavior. Rough surfaces
fade to filtered PMREM, with a wider roughness blur on accepted local reflections.
The orb has been inspected from multiple moving-camera poses in all three skies.

**Ring terrain.** The new deterministic erosion bake preserves the original
shoreline and water level while adding drainage and ridge detail. Half-float
height storage avoids the former 16-bit PNG to 8-bit canvas conversion. Normals
and directional horizon occlusion derive from that same height field and share
one packed texture. The compressed asset adds about 6.3 MB to the repository.
Regenerate it with `node qa/bake-ring-relief.mjs`; its manifest records the hash.

**Local terrain.** Two dominant world projections replace the stretched mapping
on steep slopes, with explicit texture gradients and correctly reoriented normals.
Stationary rock/cliff LODs reuse their instance data, and size thresholds use the
actual drawing buffer. All 711 authored rock transforms now feed the convex-hull
collision streamer, including bounds-aware activation for large boulders.

**Sky and lighting.** Cloud shadows modulate the celestial direct light through
the native PBR light model. Ambient/environment light, emissive materials and
local lamps retain their own response. Imported Standard/Physical materials
participate too. Visible high clouds and their shadows share the same feathered
wisp field and the appropriate spherical or curved-ring intersection. Low ring
cloud shadows use the visible cloud deck. Clouds, the scene key and the visible
moon share their active light direction and spectrum through weather changes.

**Shieldworld.** The shattered moon has a particulate reflectance blend, a
controlled terminator, consistent fragment/dust fading, and correct ordering
behind the shield and clouds. Hidden moon debris avoids 7,000 instance-matrix
updates. The red giant has larger, slower convection cells, spherical edge
foreshortening and a broader warm palette. These remain artistic celestial
shaders rather than calibrated astronomical simulations.

**Rain and water.** A local depth/normal capture follows incoming rain and supplies
shelter, impact positions and material exposure on arbitrary geometry. It handles
ordinary, instanced, skinned, vertex-deformed and alpha-cutout meshes. Thin rain
streaks use two continuous fall-speed populations and a stable pixel footprint;
small splash crowns orient to the captured surface. Wetness darkens porous
surfaces moderately. Puddles use water reflectance, flatter normals and expanding
normal ripples. Dampness and accumulated water build and dry at different rates.
Dry materials skip the wet-mask sampling work.

A GPU inspection caught and fixed a circular normal dependency in this new
wetness path: pooling now uses the geometric slope, so dry mapped materials
never inherit a zero normal. This also keeps normal-map bumps from incorrectly
deciding where a level puddle can form. See [engine/RAIN.md](engine/RAIN.md) for
the host render-loop integration, receiver flags and geometry exclusions.

**Physics and audio.** The simulation delta includes display callbacks skipped
while GPU work is in flight, preserving walking/falling speed under load.
Wall contacts retain their incoming normal velocity for the brace animation.
Walkable sloped rock tops support landing without pulling players through tall
sides; rock footsteps use the supporting surface height. Rain and wind recordings
receive a short seam blend at decode time while retaining one looping voice.
All 38 runtime audio assets decode with finite samples and runtime-trimmed
sample peaks below 0 dBFS.

**Resource lifetime.** The standalone now owns one filtered environment target
and reuses it across matching bake sizes. A paused before/after comparison
produced identical pixels. At a complete sky rebuild, an adapter for the pinned
Three r184 renderer retires obsolete draw contexts and generated instance buffers
while preserving the local scene geometry. This addresses the growth found
during repeated quality changes. Seven tier selections returned to 111 geometries,
149 textures, 35 render targets and 360 vertex attributes at each Balanced
checkpoint (48,462,108 tracked vertex-buffer bytes). Cached shader programs
settled at 303. The adapter does not replace Three with a new version.

**CPU cost.** The shared Three r184 shadow override switched between opaque and
alpha-tested states, repeatedly invalidating casters' material cache keys. Stable
variants per source material remove that churn while preserving Three's shadow
rendering. The helper handles source changes, custom shadow roots, disposal and
failed draws. A paused before/after capture verified unchanged pixels.

## Performance evidence

Hardware: **NVIDIA GeForce RTX 5090 Laptop GPU, 24 GB**, driver 610.88.
All reported scene comparisons use a **1600 x 900** drawing buffer at DPR 1,
the same camera at `[0, 1.82, 96]`, cumulus at 10.5 h, and the complete local
scene. A quality tier changes sky/cloud/reflection-bake and rain-capture budgets;
the benchmark does not hide architecture, terrain or vegetation.

Each throughput capture lasts 30 seconds. CPU frame-start intervals, p95/p99,
raw samples, camera/quality/weather metadata and process/GPU activity are retained.
Frame intervals use successful-frame rAF timestamps. The retained `renderTaskMs`
field includes callback scheduling delay as well as CPU work before completion;
it is not an isolated CPU or GPU execution duration.
Separate 120-frame WebGPU timestamp runs measure render/compute pass execution;
they exclude queue idle time and are not the throughput measurement. Samples
with external GPU activity above the 5% gate are marked invalid and retained.

The reduced-resource case uses **4x CDP CPU slowdown with the same GPU**.
It is a CPU constraint, not an emulation of a weaker graphics card.

<!-- FINAL_BENCHMARK_TABLE -->
Final quality/weather sweep: revision `16ab2c9`. All 15 throughput captures
passed the activity and render-error gates. GPU pass times are from separate
120-frame runs immediately following each unrestricted throughput capture.

| World | Quality | Mean FPS | Frame p95 (ms) | GPU mean / p95 (ms) |
| --- | --- | ---: | ---: | ---: |
| Earth | balanced | 126.4 | 12.5 | 6.24 / 6.75 |
| Earth | high | 60.9 | 20.7 | 14.05 / 15.15 |
| Earth | performance | 155.3 | 8.4 | 4.71 / 5.07 |
| Ringworld | balanced | 117.0 | 12.5 | 6.77 / 7.25 |
| Ringworld | high | 52.4 | 20.9 | 16.69 / 17.96 |
| Ringworld | performance | 150.1 | 8.4 | 4.98 / 5.50 |
| Shieldworld | balanced | 121.7 | 12.5 | 6.55 / 7.13 |
| Shieldworld | high | 57.2 | 20.9 | 14.89 / 15.86 |
| Shieldworld | performance | 155.2 | 8.4 | 4.79 / 5.18 |

| World, Balanced | 4x CPU slowdown FPS | Cyclone FPS | Cyclone GPU mean (ms) |
| --- | ---: | ---: | ---: |
| Earth | 21.3 | 114.4 | 6.52 |
| Ringworld | 22.9 | 105.3 | 7.38 |
| Shieldworld | 21.3 | 104.8 | 6.67 |

The later environment-ownership cleanup was compared against the automatic
path using an identical paused frame. Its resource-cycle check and the final
shadow-cache comparison are recorded separately in [qa/results-20260907.json](qa/results-20260907.json).
<!-- END_FINAL_BENCHMARK_TABLE -->

On the final resource-cleanup revision `3ad13eb`, an additional paired Earth /
Balanced check measured **93.4 FPS with the shadow cache disabled and 123.8 FPS
with it enabled**, a 32.6% throughput improvement in that view. Both 30-second
captures passed the GPU activity gate; their paused-frame comparison was pixel
identical. This isolates the shadow-cache change and is not a claimed speedup
for the entire overhaul against the original repository.

## Inspection and checks

- Four cloud types, all weather selections, and day/night or twilight views were
  rendered across Earth, Ringworld and Shieldworld. Shieldworld has close star
  and shattered-moon views. The final quality route repeats the three skies,
  dry/wet/cyclone states, and all three quality tiers after the wet-normal fix.
- SSR motion readbacks preserve thousands of orb-to-scene hits while reporting
  zero same-convex-group hits. Native-only and local-only captures support visual
  inspection of the handoff. These checks do not claim that screen-space
  reflections can see geometry outside the image.
- The rain GPU fixture passes 14 surface cases, two slanted-wind cases, renderer
  rollback after an injected failure, and capture-material disposal/recreation.
  A second GPU fixture checks unit normals through dry/wet/dry transitions on
  native, mapped, custom-normal and flat-shaded materials.
- The actual player controller climbed the temple stairs and settled on the
  upper support surface. A separate in-engine drop lands on an authored rock.
  Executable tests cover swept contacts, sliding, large hull bounds and slopes.
- 38 executable unit tests pass. Supplemental audits cover weather/audio (503),
  reflection topology (95), terrain TSL compilation (89), sky resource lifecycle
  (69), state-axis behavior (328), input (33), sky stability (34), and audio gait
  (17). Source checks supplement the engine captures rather than replacing them.
- Audio decoding and level/seam checks passed through Web Audio. Listening and
  subjective movement feel should be part of the interactive review. No audio
  listening acceptance is claimed; ffmpeg/ffprobe are not installed on PATH.

Six representative captures are preserved in version control:

| View | Capture |
| --- | --- |
| Ring terrain, High tier | [Relief](qa/review/ring-relief.png) |
| Steep local terrain | [Surface mapping](qa/review/terrain-steep.png) |
| SSR and sky handoff | [Reflective orb](qa/review/reflections.png) |
| Rain on local ground | [Wetness and puddles](qa/review/rain-puddles.png) |
| Red giant | [Convection](qa/review/red-giant.png) |
| Shattered moon | [Fragments and dust](qa/review/shattered-moon.png) |

Additional local evidence paths:

- `artifacts/overhaul/quality/`: final quality/weather screenshots and route data.
- `artifacts/overhaul/benchmarks/`: throughput and separate GPU timestamp reports.
- `artifacts/overhaul/shadows/`: paused cloud-shadow isolation pairs.
- `artifacts/overhaul/ssr-motion/`: orb camera sweeps and hit readbacks.
- `artifacts/overhaul/matrix/`: the wider cloud/weather/day-night inspection matrix.
- `artifacts/overhaul/terrain-steep.png` and `ring-relief.png`: terrain detail views.
- `artifacts/overhaul/wet-normal-contract.json`, `rain-surface-contract.json`,
  `player-stairs.json`, `rock-interaction.json`, and `audio-levels.json`.

Code, generated terrain assets, representative screenshots and QA tools are
committed locally. Large transient
captures and raw measurements stay in the ignored local `artifacts` directory;
the compact final measurements are preserved with this review document.

## Practical limits and review controls

Rain capture covers a camera-local region, 72 m half-width by default. Moisture
timing is shared; this implementation does not simulate runoff, trapped water
volumes or water transported by moving objects. Hosts must retain nearby roofs
even when those roofs are outside the main camera frustum. Transparent roofs
can explicitly opt into rain obstruction.

SSR still needs a filtered sky fallback at image boundaries and disocclusions.
The celestial palette, giant shield and moon debris remain authored art. The
performance figures describe the recorded views and hardware, not every possible
camera position or another GPU. The Performance tier has visibly coarser cloud
edges than Balanced and High.

In the review window: WASD moves, Shift runs, Space jumps, F toggles the flashlight,
and the wheel changes the field of view. A real click captures look; Escape
releases it. Automated QA pages use `?automated=1` to deny pointer capture. The
earlier reported desktop mouse confinement was not conclusively attributed to
the preview, and QA does not focus the page or synthesize trusted clicks.

## Technical references

- [Three: draw-object resource ownership](https://github.com/mrdoob/three.js/issues/32409)
- [McGuire and Mara: Efficient GPU Screen-Space Ray Tracing](https://jcgt.org/published/0003/04/04/)
- [Hillaire: Physically Based Sky, Atmosphere and Cloud Rendering](https://blog.selfshadow.com/publications/s2016-shading-course/)
- [Hill: Blending in Detail](https://blog.selfshadow.com/publications/blending-in-detail/)
- [Epic: Screen Space Reflections](https://dev.epicgames.com/documentation/en-us/unreal-engine/screen-space-reflections-in-unreal-engine)
- [USGS: Photometric models](https://isis.astrogeology.usgs.gov/8.3.0/Application/presentation/PrinterFriendly/photemplate/photemplate.html)
- [ALMA: Long-lived hotspots on Betelgeuse](https://www.almaobservatory.org/en/audiences/alma-reveals-long-lived-hotspots-on-betelgeuses-bubbling-surface/)
- [Lagarde: Observe a rainy world](https://seblagarde.wordpress.com/2012/12/10/observe-rainy-world/)
- [Lagarde and Harduin: The Art and Rendering of Remember Me](https://seblagarde.wordpress.com/wp-content/uploads/2013/08/gdce13_lagarde_harduin_light.pdf)
