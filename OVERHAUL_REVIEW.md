# Standalone overhaul review

The [September 8 feedback report](REVIEW_2026-09-08.md) and
[motion gallery](qa/review/feedback-20260908/index.html) contain the newer
weather, eclipse, star, rain, orb-light and benchmark corrections.

This is the revised pass after the September 7 feedback. The earlier report and
CPU-only measurements did not establish that the requested overhaul was complete.
The current work replaces the reflection path, adds shared cloud shadows and
geometry-aware rain, rebuilds the ring relief, and corrects the moon's motion.

This work is included in v0.2.0. It was reviewed on branch
`overhaul/2026-09-06`. Checkpoint `e2e6496`
preserves the 15 files already modified when work began. The implementation is
saved in the subsequent commits. Eidoverse porting
remains a later task.

## Reflections

The default pipeline injects local reflected radiance into Three's native PBR
lighting model before its BRDF is evaluated. It preserves material roughness,
metalness, Fresnel/IOR, clearcoat, anisotropy, iridescence, and the native indirect
diffuse response. It no longer composites a second shaded reflection over an
already completed material.

The screen-space trace uses continuous nearest/bilinear depth crossings,
bounded refinement, receiver separation, first-occluder termination, and explicit
convex-group rejection. Reprojected history provides local scene radiance.
A local cubemap publishes only after all six faces have completed, and filtered
sky radiance remains the fallback. Rough lobes use mip filtering.

A conservative nearest-depth gate skips the four interpolation reads on march
steps that cannot cross a surface. Off/on images on wet ground, the roof, and the
orb were byte-identical. An off/on/off 150-frame rain profile measured total GPU
pass means of 7.11 / 5.57 / 7.03 ms in that view. Throughput results below are
reported separately; this profile does not imply the same FPS gain in every view.

The close underside view from the reported gold-orb failure has been checked in
Earth, Ringworld, and Shieldworld, including camera/orb motion and isolated
sky/probe/SSR contributions. A four-material fixture shows a local red emitter
and sky on silver, water-IOR clearcoat, anisotropic gold, and iridescent metal.
See the selected [reflection view](qa/review/reflections.png) and
[native-material comparison](qa/review/native-materials.png).

This remains a real-time screen-space/probe approximation: hidden geometry,
newly exposed pixels, and multiple reflection bounces are not ray-traced.
The material response uses the native PBR implementation; that does not make
the scene's approximate reflection visibility an exact transport solution.

## Cloud shadows and lighting

Buildings, roofs, props, imported meshes, and ground all use the same shadow
path. The sky needs no terrain name, height callback, or knowledge of the temple.
A host wraps its scene's Standard/Physical materials once, registers later-loaded
objects, and prepares the shared map in its serialized frame.
The standalone's old opt-outs on the orb, PBR light fixtures, and light strips
are removed too. Their native emission is preserved separately from direct light.

A 384² map integrates the actual cloud extinction at 10 Hz over a 6,144 m region.
Each receiver projects its world position along the celestial light direction
and reads the filtered map. Elevated roofs therefore sample their own cloud
column. Only celestial direct light is attenuated; sky light, local lamps,
and emissive materials retain their respective lighting response.
The map fades at its border and uses a height-weighted approximation within
the cloud deck.

The distant ring sheet has a separate cylindrical coverage atlas shared by its
visible clouds and band shadows. Its near section also receives the local map.
The atlas refreshes at 5 Hz instead of evaluating nine procedural octaves for
every visible cloud-sheet pixel. The panel walls retain their authored emissive
appearance.

Matched cloud-shadow-off/on images show broad attenuation across temple roofs,
walls, vegetation, and terrain in all three skies. A Ringworld rain GPU profile
at revision `77274ba` measured 0.195 ms per cloud-map capture, or 0.030 ms per
application frame over 90 frames. This is the capture cost; receiver sampling
is included in the scene pass. All GPU passes summed to 6.24 ms on average in
that separate timestamp profile.

Clouds, environment lighting, and hemisphere fill now use weathered colors and
the active celestial spectrum. Overcast and rainy cloud radiance is controlled
separately from direct sunlight, retaining readable gray Earth clouds and the
Shieldworld star's warm illumination. Cirrus uses irregular curved ice trails
from a deterministic, mipmapped opacity field shared with its shadows.

Integration: [docs/SKY_SYSTEM_INTEGRATION.md](docs/SKY_SYSTEM_INTEGRATION.md).
Cloud-shape provenance: [assets/weather/README.md](assets/weather/README.md).

## Terrain and celestial appearance

The subsequent terrain, star and rain-impact correction is shown in the
[visual feedback comparisons](qa/review/corrections.html).

The ring uses a new 4,344 × 1,448 erosion bake with 3,145,056 hydraulic droplets.
Height, normals, and terrain shading derive from the same field. Adaptive,
stitched land geometry has a closed angular seam and submerged side skirts.
Following visual feedback, an independent sea cylinder now shares the land draw:
water shading never interpolates onto a displaced mountain triangle. Terrain
height scale is 85 m, with the baked peak below 76 m and an eight-neighbour
slope constraint in physical metres to remove coastal cliffs and thin spikes.
The normal frame also follows the actual directions of the band's texture axes.
Relief blends into the local playable patch between 700 and 2,000 m, avoiding
mountains intersecting the foreground terrain.

Both horizon directions and the overhead band have been inspected. The original
coastline source and animated water shader are retained; actual land/sea depth
intersections now define the visible coast. The corrected terrain payload is
37.7 MB uncompressed; compressed height/normal data and albedo total approximately
19.3 MB.
Regenerate it with [qa/bake-ring-terrain.py](qa/bake-ring-terrain.py).

Local ground has less repetitive world-space material sampling, broader natural
variation, softer material-family transitions, and two correctly oriented
projections on steep slopes. Zero-weight material families skip sampling.
The steep authored height-field view has been checked for stretched mapping.

The shattered moon accounts for each fragment's off-center geometry and swept
motion envelope. The deterministic motion checks preserve positive clearance
through 1,200 sampled times, and several widely spaced animation poses have been
visually reviewed. Its 7,000 smaller fragments now move in the GPU shader from
16 parent transforms. Dust uses depth-aware ordering with the solid fragments.
Following visual feedback, the red giant again has a dark ember palette, fine
boiling detail and a distinct pink-red rim over limb darkening. A rotating 3D
noise field replaces the stretched longitude/latitude mapping. Broad, slower
convection now modulates the fine structure rather than overwhelming it. These
are artistic celestial models; the close-range appearance also draws inspiration
from [SpaceEngine's red giant rendering](https://spaceengine.org/news/blog190703/)
and [an Elite Dangerous planetary view](https://inara.cz/elite/cmdr/381355/).

## Rain, puddles, physics, and sound

A rain-aligned depth/normal field captures arbitrary nearby geometry. It supplies
shelter, falling-drop termination, surface-aligned contacts and ballistic droplets,
wetness exposure, and puddle eligibility. Temple roofs participate without a
terrain callback. Instances, skinning, vertex deformation, alpha-cutout openings,
and wind projection have been checked in an actual GPU fixture.

Rain uses independent PCG placement channels and a denser near-camera population.
Coverage at the upwind cloud location gates precipitation. Thin wetness builds
before pooled water; drying takes longer. Porous materials darken, level puddles
flatten normals and use water reflectance, and falling rain produces expanding
ripples and surface impacts. The native PBR reflection path supplies local and
sky reflections on those surfaces.

The impact correction removes the flat crown and eight equally spaced beads that
read as dotted circles. Events now change location and emit six independently
seeded droplets with unequal angles, speeds, sizes and lifetimes. Gravity and
projected velocity shape the short trajectories and streaks. Pixel-footprint
filtering keeps small drops from vanishing between pixels. This is a stochastic
visual approximation, informed by the distinction between impact distributions
in [Columbia's material-based splash study](https://www.cs.columbia.edu/cg/pdfs/135-splash_egsr07.pdf).

The field covers a camera-local 72 m half-width by default at 8 Hz in Balanced.
It resolves the first surface along the rain ray. This is not runoff, trapped
water-volume simulation, or a separate refractive water layer. Wetness timing is
shared while exposure is local. See [engine/RAIN.md](engine/RAIN.md) for integration
and receiver controls.

The final rain-capture variants now warm after reflection material registration.
Previously, first rain rebuilt 51 capture pipelines after their source versions
changed, producing a measured 1.19-second presentation gap in a cold trace.
The boot curtain now also waits for GPU completion. Cold-start and quality
replacement compilation can still take tens of seconds; this change removes
first-use work from play rather than eliminating the compilation cost.
Startup paint yields also have a bounded fallback: a covered or minimized
window must not hang initialization waiting for suspended animation callbacks.

Player movement and falling retain elapsed time when a GPU frame is skipped.
Wall impacts preserve incoming normal velocity; slope/rock support avoids pulling
players through tall rock sides. The actual temple stair flight and an authored
convex rock landing passed live checks without penetration.

Rain audio follows a throttled asynchronous shelter/exposure sample. Shelter
reduces gain and high frequencies; ambience loop seams are blended, and thunder
pitch variation no longer repeats the same index. All 38 runtime assets decoded
with finite samples and trimmed sample peaks below 0 dBFS. Audio has been analyzed
numerically; listening quality is reserved for the interactive review.

## Performance measurements

Hardware: NVIDIA GeForce RTX 5090 **Laptop** GPU, 24 GB, driver 610.88.
The paired sweep uses 1600 × 900 at DPR 1, 62° vertical FOV, camera
`[0, 1.82, 96]`, cumulus at 10.5 h, and the complete authored local scene.
Surface wetness and pooled water are set to each preset's steady-state targets
before the pair. Clouds continue to move; start simulation time is recorded.

Each pair measures 20 seconds with **4× CDP CPU slowdown plus a calibrated
synthetic GPU workload**, then 20 seconds with unrestricted CPU/GPU settings.
The GPU workload targets 8 ms and retains actual timestamp samples across its
warmup and capture. It adds a completion fence, retains this GPU's architecture
and VRAM, and does not predict performance on a named lower-power card. A hardware power cap
was also attempted earlier; this laptop driver did not support it, so no capped
run is claimed.

Separate 90-frame GPU timestamp captures sum render and compute pass execution.
Their readback overhead makes them separate from throughput measurements.
Throughput uses completed-frame start intervals and retains raw samples,
p95/p99, camera, quality, weather, commit, source-diff hash, and process counters.

Windows Terminal was using the GPU during some measurement windows. Captures above
the 5% external-activity gate are explicitly marked as observed, non-isolated
results. The final sweep also found clean windows, identified per capture below.
This gate measures GPU activity. Those original 27 captures did not record
process CPU-time deltas and do not establish CPU isolation. The later receiver
check adds CPU measurements after a slowdown coincided with multiple busy
Blender processes despite a passing GPU gate.
The earlier CPU-only sweep is preserved as historical first-pass evidence, not as a weaker
GPU simulation or a valid same-view comparison with this implementation.

<!-- OVERHAUL_BENCHMARK_TABLE -->
Rendering revision: `c0a87a0`. 19 of 27 captures passed the external-GPU-activity gate.
An asterisk marks an observed capture that exceeded that gate. Actual GPU
competition times, background processes and raw frame intervals are retained
in [qa/results-20260907.json](qa/results-20260907.json).

| World | Quality / weather | Full FPS | Full p95 ms | Reduced FPS | Reduced p95 ms | GPU mean ms |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| Earth | balanced / none | 165.4 | 6.1 | 16.3* | 78.0 | 4.72 |
| Earth | balanced / rain | 163.1 | 6.1 | 14.1* | 95.5 | 4.75 |
| Earth | balanced / cyclone | 164.0 | 6.1 | 14.6* | 89.0 | 4.56 |
| Earth | performance / rain | 160.5 | 6.2 | 14.0* | 95.6 | 4.21 |
| Earth | high / none | 65.9 | 18.1 | — | — | 13.00 |
| Ringworld | balanced / none | 132.4 | 12.4 | 14.9 | 83.3 | 5.48 |
| Ringworld | balanced / rain | 140.1 | 8.4 | 13.1 | 99.8 | 6.90 |
| Ringworld | balanced / cyclone | 145.1 | 8.4 | 13.3 | 96.0 | 5.48 |
| Ringworld | performance / rain | 135.0 | 8.5 | 12.5 | 104.1 | 4.64 |
| Ringworld | high / none | 56.0 | 20.9 | — | — | 15.46 |
| Shieldworld | balanced / none | 162.5 | 6.1 | 15.3* | 81.8 | 4.80 |
| Shieldworld | balanced / rain | 163.9 | 6.1 | 12.8* | 106.5 | 4.85 |
| Shieldworld | balanced / cyclone | 160.8 | 6.1 | 9.4* | 173.1 | 4.82 |
| Shieldworld | performance / rain | 161.2 | 6.1 | 13.6* | 101.1 | 4.16 |
| Shieldworld | high / none | 66.6 | 18.1 | — | — | 13.09 |
<!-- END_OVERHAUL_BENCHMARK_TABLE -->

The subsequent startup-only fix in `4de3a57` changes preparation order and waits
for GPU completion behind the loading curtain; it does not change steady-state
shaders or per-frame rendering work. `f921f0a` then removes the standalone's old
cloud-shadow opt-outs on the orb, PBR emitters, light strips, and debug sphere.
The table predates that final receiver-registration correction; a further
Ringworld rain pair records its performance separately below. Cold-transition
checks record their own revision.
The contended Shieldworld cyclone measurement was repeated before that change:
115.3 FPS with Blender activity, then 160.8 FPS in a clean window. Both records
are retained; the table uses the clean repeat.

<!-- FINAL_RECEIVER_BENCHMARK -->
Final receiver revision `f921f0a`, Ringworld / Balanced / Rain:
64.7 FPS unrestricted (p95 30.1 ms),
5.1 FPS with CPU+GPU constraints (p95 383.6 ms).
Separate GPU pass mean: 5.76 ms.
External mean CPU usage during the unrestricted capture: 33.6%.
The unrestricted capture exceeded the CPU-activity gate. It is a contended observation, not a CPU-idle throughput baseline.
The earlier 61.0 FPS receiver capture preceded CPU instrumentation and is retained as well.
<!-- END_FINAL_RECEIVER_BENCHMARK -->

Performance changes include shared cloud fields, bounded light/shadow updates,
stable shadow-material variants, filtered-environment target reuse, GPU-driven
moon debris, and skipped zero-weight terrain layers. These changes are described
by their mechanism; no percentage speedup over an unmatched historical view is
claimed.

## Validation and review

- `npm.cmd test`: 53 tests passed, covering reflection ownership/visibility,
  fragment motion, ring seams and relief, cloud-map rollback, material wrapping,
  wet-related texture policy, resource retirement, and player/input behavior.
- GPU rain fixture: exposed/sheltered geometry, elevated surfaces, slopes,
  instances, skinning, displacement, cutouts, wind, listener exposure, and
  failed-capture state restoration.
- GPU material checks: valid normals across dry/wet transitions and native
  reflected radiance on the physical-material fixture.
- Visual review: every weather preset, all three skies, daylight/night/dusk,
  close orb motion, both ring horizons, moon motion, stellar surface, steep
  terrain, roof puddles, falling rain, and impact motion.
- Seven Ringworld quality selections returned to the same Balanced counts:
  130 geometries, 162 textures, 37 render targets, and 73,432,300 vertex-attribute
  bytes. Shader program storage gained about 5.6 KB once, then stabilized.
  No render errors or pointer capture occurred in the rebuild checks.
- Real 45-second weather-transition checks are recorded separately from
  steady-state benchmarks, including the longest frame and rain-capture cost.
  Fresh-load None → Rain completed with no new render pipelines in all three
  skies. Maximum frame intervals were 47.6 ms (Earth), 53.5 ms (Shieldworld),
  and 83.5 ms (Ringworld), versus 1,193.7 ms in the instrumented pre-fix trace.

The one owned review browser uses **http://127.0.0.1:8378/**.
`node qa/browser-session.mjs review` replaces the owned headless browser with
one visible browser and waits for the old debugging port to close. Automated
pages cannot capture the mouse. In the visible review, click the world to look,
Esc releases the mouse, WASD moves, Shift runs, Space jumps, and F toggles the
flashlight. No remote publication or push is part of this review.

## References

The reflection changes follow continuous-depth ray intersection and radiance
fallback ideas in [Stachowiak's depth ray marcher](https://gist.github.com/h3r2tic/9c8356bdaefbe80b1a22ae0aaee192db),
[AMD's SSSR description](https://gpuopen.com/manuals/fidelityfx_sdk/techniques/stochastic-screen-space-reflections/),
and [Three's SSR implementation](https://threejs.org/docs/pages/SSRNode.html).

Shared cloud extinction and amortized shadow integration were compared with
[Unreal's volumetric-cloud system](https://dev.epicgames.com/documentation/unreal-engine/volumetric-cloud-component-in-unreal-engine?lang=en-US)
and the [Nubis presentation](https://advances.realtimerendering.com/s2017/index.html).
Cirrus and stratus morphology were checked against the
[WMO Cloud Atlas](https://cloudatlas.wmo.int/en/explanatory-remarks-and-special-clouds-cirrus.html).

Wet-surface parameters draw on [Lagarde's wet-surface discussion](https://seblagarde.wordpress.com/2013/04/14/water-drop-3b-physically-based-wet-surfaces/);
rain appearance on [Garg and Nayar's rain rendering work](https://cave.cs.columbia.edu/old/projects/rain_ren/pipeline_algorithm.html).
Terrain projections use explicit-gradient principles discussed by
[Ryan DowlingSoka](https://ryandowlingsoka.com/unreal/triplanar-dither-biplanar/).
The star's larger convection structures were compared with
[ESO's observations of R Doradus](https://www.hq.eso.org/public/news/eso2412/).
