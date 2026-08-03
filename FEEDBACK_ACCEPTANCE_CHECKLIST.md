# Eanpa scene feedback acceptance checklist

This file is the durable source of truth across context compaction. An item is
only complete after a fresh live visual/interaction test; a code patch alone
does not close it.

> **Browser/server safety rule (2026-07-17):** Run exactly one local preview
> server and at most one user-visible, normal browser window. Never launch a
> headless, hidden, CDP/remote-debugging, audit-profile, or additional browser
> instance for this project. Never control or reload the user's visible browser;
> ask the user to refresh when a live retest is needed. On 2026-07-17, 29 stale
> Chrome processes from repeated hidden audit launches were closed. Consequently,
> every FPS, frame-time, GPU-time, memory, and runtime performance measurement
> from the affected period is invalid and must not be cited as evidence.

> **User-owned Blender authority / integrated_v2 completed (2026-07-16):**
> Never overwrite `assets/temple/eanpa_ziggurat_area_editable.blend`. The user
> saved a stable 17,647,169-byte revision at 08:19:11 (SHA-256
> `66C6F1C925CC77D51F32F10FDC4B771E96B9E19F5DD993ADDA1880FBFA55F228`)
> with rebuilt stair/railing pieces, top-surface z-fighting fixes, repositioned
> panel geometry, added assets, and face-area-weighted normal repairs. Its
> immutable snapshot is `artifacts/ziggurat-user-edit-snapshots/`.
> Both original and snapshot still match that hash. The processed authority is
> `assets/temple/eanpa_ziggurat_area_integrated_v2.blend`; the runtime source is
> `assets/temple/ziggurat_architecture.blend` and the optimized payload is
> `assets/temple/ziggurat_architecture.glb`. The integration preserves all user
> geometry/transforms/normals, changes UVs only on the eight new rail pieces,
> restores eight closed Metal010 flush trims and 176 shifted panel fasteners,
> and does not regenerate the rejected retaining-wall/old-cheek objects.
> `artifacts/ziggurat-integration/integrated_v2_report.json` is the authoritative
> machine-readable audit. Subjective live appearance/traversal items remain
> open until the current runtime has been viewed and walked.
>
> **Fastener corner_v2 refinement (2026-07-17):** the same allowlist processor
> keeps all 176 components and the exact -0.2402391/+0.2852621 m upper-panel
> shifts, but reduces each support from 0.340 m to 0.235 m and the visible
> detail from 0.130 m to 0.090 m. All four fasteners on each of the 44 actual
> panels measure 0.226199-0.235001 m from both panel bounds with 0.015 m
> chamfer-line clearance. The existing Metal010 NormalGL map is bound through
> `FastenerDecalUV` in both editable and runtime materials; no new bitmap load.
> Promoted hashes: GLB `F3A51214FD35A3625E77757083BDE23E1C0B72C03C2608CE258770C1EBD1403D`,
> canonical Blend `A5739B49F20076616E6A882AAE0E75225F97D1BE30AEA8C8AAA1B9269A988929`,
> versioned Blend `E08AFD73EA72B819F596DECE7D686ED35971551A9EC300A845BA3D728812D3B6`,
> and area Blend `545E69FBE7D146F5C7AA8CD0D8D09197073C786E2BECAD6E3B21303E83ADBA9F`.
> Static/runtime/integration audits pass 140/843/192; independent GLB import
> confirms 31 meshes / 70,192 triangles, zero degenerates or nonpositive
> volumes, and only the eight documented 24-edge user-rail seams. Focused live
> evidence is `artifacts/ziggurat-fastener-corner-v2-live-close.jpg`.

## Live feedback tranche — 2026-07-17

This is the no-drop ledger for the user's running comments from the current
session. It supersedes older implementation notes where they disagree, while
leaving subjective visual/listening sign-off open when only structural tests
exist.

- [x] Current source state was checkpointed before the large refinement pass.
- [x] Cloud reflections no longer use the full-screen receiver-pixel blur that
  produced iridescent/oil colours. Moving clouds are included in a reusable
  equirectangular environment and filtered by Three's native PMREM/material
  BRDF, so authored normal, base/specular colour, metalness, roughness,
  Fresnel, multiscattering, and IBL occlusion remain material-owned. Local
  geometry SSR still consumes the final MRT metalness/roughness channels.
  Balanced refreshes the slow cloud environment every 16 seconds (High 10,
  Performance 24) instead of raymarching and blurring it every frame.
  Controlled chrome-sphere/pedestal and real 2K mapped-wall captures are
  artifacts/cloud-reflection-probe-native-pmrem-small.jpg and
  artifacts/cloud-reflection-native-pbr-mapped-wall-small.jpg. The PMREM
  revision advanced live while frames continued, and a hard WebGPU reload
  reported no shader/pipeline/resource errors.
- [x] Architectural metals now expose those native cloud reflections without
  replacing their PBR response: panels, rails, dais metal, fasteners, and the
  imported perimeter kit retain their existing colour/metalness/roughness/
  normal maps and use bounded roughness/env-intensity calibrations. The Inanna
  orb remains untouched. Fresh live close evidence is
  artifacts/architectural-reflections-close-calibrated.png; subjective user
  sign-off on the exact blur/contrast remains open.
- [x] The two user Desert_Cliff assets replace the authored stand-ins as eight
  terrain-seated copies. They use six true asset-and-LOD InstancedMesh buckets,
  three real geometry levels, 2K PBR maps, hysteresis, and at most six cliff
  draws; unreachable placement means no needless physics.
- [ ] The authored Desert_rock_chunks source is now structurally rebuilt but
  still needs the user''s requested live polish pass. The immutable 12-piece
  master feeds 656 deterministic ground instances plus up to 64 validated
  cliff-cluster members; invalid decorative members now degrade gracefully
  instead of blocking scene load. All 20,220 procedural boulder/scree copies
  are retired. Its 36 InstancedMesh buckets
  are 12 pieces x three real 100%/32%/10% LODs, selected at 72/18 projected
  pixels and culled below one pixel. Composition, burial, apparent scale,
  repetition, and transition quality remain open until the corrected ground
  material is live and the browser has been hard-reloaded.
- [x] Visible saguaros and Joshua trees are the authored SeedThree GLBs, batched
  as instances across their authored LODs; no procedural visible plant mesh is
  created in the browser. Runtime scatter/PRNG is gone. One checked-in manifest
  fixes all 760 saguaro and 430 Joshua transforms on every reload, enforces
  conservative full-asset clearance within/across species, and feeds the exact
  same transforms to close-range collision streaming.
- [x] Joshua bark reversed winding is repaired locally in all three geometry
  LODs with no remaining strong face/normal disagreements; foliage normals and
  authored material separation remain intact.
- [x] Vegetation collision uses very-close analytic capsule proxies only:
  activate at 7 m, release at 9.5 m. Temple, wall, and orb narrowphase physics
  are likewise proximity-culled by component.
- [x] The Inanna dais climb uses a grounded time-eased assisted step instead of
  a one-frame teleport, while ordinary stairs keep their exact 0.20 m behavior.
- [ ] The exclusive ziggurat routing is structurally correct: a stone contact
  replaces the previous terrain contact with a 12 ms fade, so gravel/sand
  cannot play on top. The generated stone assets themselves were explicitly
  rejected on 2026-07-17 as a metallic asphalt scrape rather than footsteps;
  replacement from four retained real CC0 boot-on-stone recordings is in
  progress and requires fresh live listening.
- [ ] The 1K/512 AmbientCG ground-array pass was explicitly rejected on
  2026-07-17. The first seven-slot v3 integration was then live-rejected because
  Rocky Trail dominated 8,030 of 9,409 samples, Dry Ground/Laterite never won a
  point, height was unused, and rotated world-XZ normals were passed through an
  incompatible mesh-UV TBN. Corrected v3.1 retains all 4K masters and uses true
  2K runtime albedo-height plus packed normalXY/roughness/AO for the exact seven
  requested sources. A further live review rejected using the scans' 2-4 m
  capture footprints directly as runtime repeats. The runtime now uses
  scene-calibrated 4/8/4/6/6/8/8 m repeats while preserving source spans
  separately in the manifest; true-2K density remains 256-512 texels/m.
  SeedThree's measured 4.0 m ground and 7.27 m rock periods anchor that scale.
  RockyTrail's anti-tiling divisor is three, preserving 12 m stochastic cells.
  The near/horizon seam blends phased and unphased sampled values instead of
  interpolating a 17-tile UV offset, which previously compressed/warped texture
  scale in the 336-376 m boundary ring. Deliberate warped geographic deposits now give every
  surface ownership; riverbed remains wash-only. Linear height occupies the
  previously wasted albedo alpha and applies only a bounded shared-weight bias,
  adding no sampler or decoded memory. NormalGL Y is compensated once for the
  retained pixel rows and an explicit world-XZ basis works on both the near grid
  and UV-less horizon. Runtime SPOM remains disabled while all seven 4K height
  masters are retained. The two decoded base arrays still cost 234,881,024 bytes
  and estimated complete mips still cost 313,174,699 bytes. Live appearance and
  performance acceptance remain open.
- [x] All 176 panel fasteners are 0.090 m visible details on 0.235 m supports,
  inset 0.226199-0.235001 m from actual panel corners, with the existing
  Metal010 NormalGL map bound in editable and runtime materials.
- [x] One primary click enters pointer lock; mouse movement looks without
  holding the button; Escape releases it and clears movement input.
- [ ] **Recovered first-person-arms backlog (prior-session log, recovered
  2026-07-17):** use the user-supplied
  `assets/player/First_Person_Aletheia_Arms_Hands.glb`; rig, animate, optimize,
  and attach it as an explorer-camera-only viewmodel; reduce its 8K texture to
  4K or 2K as appropriate; provide a hand/forearm rig and small animation set;
  solve near-plane/depth behavior; and keep it isolated from movement physics
  and world collision. The source remains byte-identical and read-only. The
  reproducible background Blender builder now creates one five-bone skin,
  Idle/Walk/Run/Jump/Land clips, a 4K base-colour map, 2K normal and 2K
  metallic/roughness maps, and the dedicated runtime GLB under
  `assets/player/runtime/`. `src/first_person_viewmodel.js` owns a separate
  0.015--8 m camera/scene and a serialized depth-cleared overlay pass; the
  model is never attached to the world scene, shadow/reflection captures, or
  collision/navigation systems. A fresh background Blender re-import verifies
  normalized finite weights on all 34,899 vertices and five distinct bounded
  mesh deformations. **The first live framing was rejected on 2026-07-17:** its
  Y-axis half-turn left the upper-arm/proximal mass facing the viewer and the
  old raw-accessor framing test did not apply the GLTF node hierarchy. The
  integration now uses `rotation.x = PI`, scale 0.44, viewmodel translation
  `(0, -0.240, -0.02)`, and a viewmodel-only 66-degree FOV. A matched 16:9
  background-Blender probe places both hands in the lower-middle, keeps each
  hand on its anatomical side, brings the wrists in from below, and excludes
  both upper-arm cut ends. The replacement Blender audit evaluates the fully
  imported/evaluated node transforms in camera space and asserts proximal
  clipping plus fingertip depth along camera -Z; it passes 11 checks. The
  focused static audit passes 92 assertions, including
  a visible nonfatal load-error fallback so missing arms cannot brick world
  boot. Geometry
  remains at the authored 52,559 triangles intentionally because hands occupy
  the near field. **Fresh live visual sign-off on the corrected framing,
  skin/material appearance,
  sway strength, and clip feel remains open; structural tests do not close it.**
- [x] SeedThree desert wind and four sparse spatial bird calls are integrated.
  Birds wait 70-150 seconds initially and then leave 140-320 seconds of actual
  quiet. Important distribution constraint: the four xeno-canto recordings
  are CC BY-NC-SA, and the local Stable Audio checkpoint's redistribution
  terms still require confirmation.
- [x] The shrub wetness wrapper preserves atlas alpha and both shrub instances
  and shared materials reject ground-only puddle replacement, preventing
  distant crossed cards from becoming opaque rectangular planes.
- [ ] User visual sign-off remains needed for the Ringworld shape, but the
  requested geometry is now explicit and statically guarded: the flat portion
  is 8 km wide across the open sides, the curved ends taper to 4 km, and taper
  begins only at 84% of the visible arc. The hand-authored parallel direction
  remains symmetric via abs(z), flat through +/-4.2 km, cresting at +/-4.9 km
  with a 350 m rise. Both cloud layers share that transform; settled Clear
  hides the upper/cloud dome too. Evidence:
  artifacts/ringworld-wide-flat-narrow-curve-final.png and
  artifacts/ringworld-clear-layer-parity.png.
- [ ] Dark Thunderstorm visual sign-off is explicitly reopened after the user
  rejected both the original one-hit texture and the subsequent seven-sample
  shallow/backstop version as the same repeating 2D/Jedi-Knight-style skybox.
  The rejected constant-alpha and constant-color backstop paths are now removed.
  Only the lowest 1.1--1.45 km of the semantic 19.3 km cumulonimbus is rendered,
  using 16 interleaved stratified samples through a warped four-scale analytic
  3D field. Two low scud windows overlap a ruffled deep core; continuous Beer
  self-occlusion separates their tones and `1 - transmittance` supplies alpha.
  Even the worst-delayed core floor integrates to 7.50 optical depths at the
  minimum depth (>99.9% cover), so no painted plane is needed to seal the sky.
  A matching continuous low-layer mass proxy participates in transition cloud
  shadows without cloning the full noise graph into every world material, and
  transient lightning remains excluded from PMREM while still lighting the
  live volume. CPU-only graph construction and focused static audits pass; no
  browser/GPU was launched, so fresh user visual sign-off is still required.
- [ ] Dark Thunderstorm wet-ground sign-off is reopened for the reported solid
  white/glitching terrain. The puddle wrapper no longer injects near-white
  albedo or converts water Fresnel into metalness; puddles retain wet-ground
  albedo, dielectric metalness zero, low roughness, and native PMREM/SSR. Scene
  lightning is finite-clamped at a 12,000 peak with 900 m range, and transient
  flashes are excluded from periodic PMREM bakes so they cannot remain frozen
  on every PBR receiver. Static audit passes; visual confirmation remains
  outstanding.
- [ ] User live sign-off is reopened for lightning cadence, illumination, and
  local impacts. The user re-rejected the first scheduler patch after still
  seeing near-continuous live illumination and no visible ground impact, so its
  helper-only audit did not close this item. The rejected 1.9 Hz strike / 3.3 Hz
  sheet samplers remain removed. A scene now owns exactly one weather scheduler.
  Registry/disposal gating prevents a retained retired reference from writing
  the shared sky flash channel, and a disposed lazy texture request stops before
  construction so it cannot evict the newer owner. Dark
  Thunderstorm exposes one first event after 6--9 seconds, then separates events
  by a deterministic randomized 12--28 seconds; one event may contain only 1--2
  return strokes in a sub-0.6-second
  cluster, and a late frame can begin at most one event. Sheet glow belongs to
  that event instead of running an independent rapid sampler. Local surface
  candidates are 16% of settled events, the first event after entry is forced
  forward within a safe 34--58 m range for acceptance visibility, and later
  candidates occur after at most six remote events while retaining the 45-second
  safety cooldown. Authored terrain/temple raycasts remain primary; a culled or
  GPU-only terrain chunk, including an empty visual-root list, falls back to the
  real terrain height/normal sampler
  instead of silently converting the promised hit into a remote event. One event atomically
  owns the surface bolt endpoint, pooled sparks/closed 3D puffs, irregular
  temporary scorch, a 4.5 m receiver/world surface-damage event, bounded scene
  light, and distance-delayed thunder/close crack. The focused profile audit
  passes 371,062 assertions. A real CPU runtime/lifecycle harness also proves
  that 1,000 consecutive 1 ms updates cannot retrigger, transition blending
  preserves one deadline, the first event reaches the heightfield and activates
  puff/scorch, replacement gates stale updates, and stale async loading cannot
  construct.
  Visual cadence, local-hit readability, and mix still require the user's
  foreground-window judgment.
- [ ] Final clean performance sweep remains separate from ordinary live
  telemetry. All prior runtime performance numbers from the contaminated
  multi-Chrome period are retracted. No target claim is accepted unless one
  foreground, user-visible Eanpa page is the only Eanpa browser workload and no
  other meaningful agent/GPU work is active.

Current reflection acceptance is 58 static assertions plus the live WebGPU sky
suite. The retired src/cloud_reflection_filter.js module has been removed. The
production compose is native cloud PMREM/IBL followed by Three SSR; there is no
screen-resolution cloud reflection target or additive signed cloud-colour
delta left to create the reported oil bands.

## Live feedback tranche — 2026-07-16

These are deliberately duplicated as one compact no-drop ledger. They stay
unchecked until the specific live view/interaction has been retested.

- [x] Direct weather selection visibly responds and the authored 45-second morph completes without requiring a None reset.
- [x] Rain always travels downward during every storm-to-storm morph; changing wind/fall speed never sucks drops upward/backward.
- [x] Local rain and volumetric precipitation have no visible square/block boundary.
- [ ] Drops are more transparent and their brightness/color follows TOD, storm attenuation, and lightning instead of looking self-emissive.
- [ ] Wetness and puddles appear per-fragment on arbitrary upward-facing building tops as well as terrain.
- [x] Moving cloud cover casts coherent sun-aligned shadows over terrain, vegetation, and architecture in every quality tier.
- [x] Sky reflections remain stable during camera translation/rotation with no jitter or camera-pinned layer.
- [x] Local SSR composites cleanly over the sky environment with no z-fighting/flicker.
- [x] Far horizon has no stretched or duplicated-cloud band.
- [x] Normal Earth skies retain their moon across cloud presets/quality tiers with natural night/elevation/weather visibility.
- [x] Shieldworld rocky moon remains night-only and its moonlight is warm red/amber-brown from the red giant, never blue.
- [ ] Joshua trees have readable, calibrated trunk/leaf/skirt lighting and are not crushed to near-black.
- [ ] Terrain and rocks no longer read as N64/low-resolution geometry or materials.
- [ ] Giant straight terrain tiling/seam lines are absent at near, middle, and horizon distances.
- [ ] Ziggurat panels, railings, and under-orb accent use real mapped PBR metals—not metalness 1 / roughness 0 placeholders.
- [ ] Ziggurat metal panels use their own intentional metal PBR maps; no wall/stone texture is mapped onto the panels.
- [ ] Panel corner fasteners read as subtle flush/recessed alpha/normal decal detail, not chunky low-poly bolt geometry.
- [ ] Metal reflections visibly and correctly respond to distinct roughness/metalness values instead of collapsing to washed-out mirror chrome.
- [ ] Railing-to-stair, railing-to-summit, and railing-to-side gaps are closed without blocking traversal.
- [ ] Existing red/blue orb emitters produce selective bloom plus transparent soft-gradient volumetric beams.
- [ ] Existing orb emitters drive very large, long-distance red/blue spotlights that illuminate terrain/architecture at night.
- [ ] The blue Inanna emitter surface remains a true saturated blue (not violet/purple); the accepted red emitter remains unchanged.
- [ ] Stair ascent camera motion is smoothed while physical tread collision remains exact.
- [ ] Terrain grading does not bury the gate asset's authored threshold/input-texture strip beneath its moving leaf.
- [ ] F toggles a shadowed player flashlight and a persistent bottom legend lists movement/look/jump/run/flashlight controls.
- [ ] Current synthetic-sounding Foley/weather/gate set is replaced or improved using auditioned license-verified CC0 sources with provenance retained.

## Reflections and rendering

- [ ] Match Eidoverse's known-good sky reflection orientation and content.
- [x] No camera-pinned/sliding sky object; reflective sphere is not upside-down.
- [ ] Ringworld and red giant appear correctly in reflections.
- [ ] SSR visibly reflects local walls, ziggurat, terrain/rocks, and props—not only the sky environment.
- [ ] WebGPU N8AO defaults on, toggles off, and skips AO GPU work when disabled.
- [ ] Selective bloom works without sky halos or emissive MRT erasure.
- [ ] High / Insane targets at least 30 FPS on desktop and is smooth/error-free.
- [ ] Balanced targets at least 60 FPS on desktop and is smooth/error-free.
- [ ] Performance targets at least 120 FPS on desktop and is smooth/error-free.
- [ ] Performance evidence is captured with one foreground Eanpa WebGPU page and no other agent/GPU workload.
- [ ] The performance evidence above is newly recaptured after the 2026-07-17
  multi-Chrome cleanup; no earlier FPS/frame-time/GPU-time baseline is reused.
- [ ] Quality affects only sky/weather/skyboxes, never local-scene detail or post FX.
- [ ] Every sky/skybox/weather visual element remains present in every quality mode.

Static rendering evidence (2026-07-15; live visual/performance acceptance is
still open): the Eidoverse-style post graph uses one single-sample scene MRT,
WebGPU N8AO, local-geometry SSR, selective emissive bloom, and the donor r184
FXAA after display conversion. Pipeline-owned RTTs are tracked separately from
hook/pass-owned resources and explicitly released on every sky rebuild. The
former adaptive cloud-resolution loop was removed because it timed the whole
serialized local-scene/post frame: vegetation, SSR/N8AO, or another GPU process
could therefore make it degrade only the clouds. High/Balanced/Performance are
now fixed at cloud divisors 1/2/3 (Balanced and Performance restored from the
over-aggressive 3/5); they cannot silently downshift under contention. No FPS
claim is accepted until GPU-engine counters prove Eanpa is the sole meaningful
foreground workload.
`node tools/audit-reflection-static.mjs` passes 52 CPU-only assertions over
the exact inverse equirectangular bake direction, per-material environment,
local SSR compose, single scene MRT, N8AO, selective emissive bloom, final
donor FXAA hash/order, current-frame spatial clouds, and owned RTT teardown.
The live-sky lobe now preserves the hook's continuous `(1 - roughness)^2`
intensity response and follows the donor's two-stage `roughness^2` curve:
sharp -> light blur over 0..0.25, then light -> heavy blur over 0.25..1. Its
vendored box-blur fallback uses separate 5x5 separation-2/separation-8 kernels,
so the rejected roughness-0.58 panel is fully in the light-blur lobe rather
than retaining a 66% sharp mirror. The result is re-gated by receiver
metalness and owns no independent target. The audit also proves blur/denoise
are not force-disabled and that native Three SSR still consumes MRT R/G as
metalness/roughness with its own roughness-squared mip chain.
Before any live timing, `tools/check-gpu-free.ps1` must exit 0; exit 2 means
the result is contaminated and must not be recorded or used for tuning.

Fresh live stability/reflection acceptance (2026-07-16; no FPS claim): opaque
PBR environment suppression now matches Eidoverse's two-knob contract
(envNode = vec3(0) plus envMapIntensity = 0) while transmissive and keepEnv
materials retain the bake. Live diagnostics report all 32 opaque PBR materials
suppressed and opaque-env-suppressed_geometry-hit-over-live-sky. The explicit
chrome probe was captured with live sky only and local SSR only in
artifacts/reflection-probe-live-sky-only.png and
artifacts/reflection-probe-local-ssr-only.png: sky owns misses while walls and
terrain own geometry hits, with no surviving baked-sky layer underneath. A
controlled camera move to z=23.5 and return to z=24 at identical sky time
produced byte-identical before/after images (SHA-256
6A1FD4B8C09857EDA929BC4554DC686268981FAD97DE8583EA4DA93D6CEF4A67);
there is no temporal reflection state or screen-pixel reroll left. Reflected
clouds use a fixed current-frame stratified midpoint; visible clouds retain
their no-history current-frame screen hash.

## Clouds and weather

- [ ] All volumetric presets use the smooth optimized path in all three qualities.
- [ ] Ringworld, Dark Storm, and High Cirrus have no line-shaped grain.
- [ ] 2D clouds follow volumetric style instead of staying identical dark grey.
- [ ] Cirrus looks like realistic high ice cloud.
- [ ] Dark Storm has rain plus lightning-synchronized thunder.
- [x] Direct weather switching and 45-second transitions to/from None work.
- [x] Shieldworld rocky moon is visible only at night.

Static/headless acceptance evidence (updated 2026-07-17; live visual quality
and audio mix sign-off remain open): `node tools/audit-weather-static.mjs` passes 518
assertions without a browser/GPU. It executes the real weather wrapper and
proves direct Rain -> Dark Storm -> None morphs use 45 seconds without an
intermediate None rebuild; a rapid async Rain -> Dark Storm -> None sequence
cancels both stale loads, and the next direct Dark Storm request succeeds. All
34 cloud, high-wisp, rain, wind, precipitation, and coupled style uniforms
written by the preset/weather setters are in the transition capture, including
the union-interpolated lightning/distant-storm definition. Dark Storm retains
rain 1.0, wetness 1.0, lightning 0.85, and distant lightning 0.8. Rain-streak
and splash fallback masks now use ordered backend-defined smoothstep edges;
the two reversed/undefined forms that could erase/corrupt precipitation are
forbidden by audit. Settled Dark Storm alone gets a rainK-gated maximum 1.28x
opacity lift (hard alpha cap 0.72) and restrained diffuse rain-light floor from
0.08 to 0.22; ordinary weather is unchanged. Every non-clear weather authors a
distinct high-cloud stretch/tint/filament style;
cirrus is a thin 3.4 km finite-plume layer with sheet/plume crossfade. The
production cloud marcher defaults to the shared stable 2D screen hash, HDR
output dither defaults to zero, and ordinary/Ringworld high sheets use filtered
weather textures. A full Cumulus/Stratus/Cirrus x High/Balanced/Performance
matrix proves every non-clear base preset retains content, uses the same
compiled multi-pass `cloudBody` graph, and attaches the same current-frame
spatial compositor; preset setters change uniforms rather than materials.
The separate Ringworld far-arc 2D sheet is now covered too: its lattice is
sin-free, physically aspect-correct and domain-warped, while coverage, wind,
storm greying, sun/ambient tint, and TOD palette come from its bound
weather/sky state. The optimized target keeps sky/high-layer output linear HDR
and tone-maps once at the main-scene proxy, preventing the old dull-grey
double transform. High/Balanced/Performance keep nonzero cloud, rain, and
splash budgets; no scoped sky/weather source has a quality-driven element
removal branch. Their complete visible-sky/light/pass/rain/splash contracts are
fixed in source, the divisors are exactly 1/2/3, and no runtime caller mutates
the selected divisor. The spatial compositor has no history/reprojection
state: it freshly renders separate background and cloud targets from current
camera matrices every frame, holds temporal jitter at zero, and preserves the
Ringworld background/structure/cloud/high-sheet order. The production screen
and cirrus hashes are sin-free, and no wrapper opts into legacy direction
jitter, correlated texture-slice erosion, or HDR dither. The quality UI exposes
only High/Balanced/Performance; temple, terrain dressing, and vegetation are
constructed outside sky rebuilds, local roots are never disposed by a quality
change, and local SSR/N8AO/bloom remain on their authored Balanced graph with
the AO preference restored. Ringworld water is no longer globally disabled: every
quality selects the same lightweight animated path, with two scrolling reads
of the existing mip-filtered band normal, an analytic cylindrical tangent
frame, a nonzero distant-motion floor, and water-masked night glint. The old
procedural ALU wave field remains lookdev-only. The real audio controller,
under a mocked Web Audio context,
loops the complete rain buffer, follows live rain intensity with 1.4/2.8 s
gain smoothing, de-duplicates each strike, chooses close/distant spatial
thunder, and applies speed-of-sound delay. The rain asset is a retained 16.0 s
Ogg; its audible boundary still needs listening sign-off. Shieldworld moon
opacity and root visibility are both night/elevation gated. Its star-pollution
fade is now derived from the current TOD palette each frame instead of
irreversibly multiplying itself to zero.

Fresh live weather acceptance (2026-07-16): on the isolated project preview,
the UI completed direct None -> Rain -> Dark Storm -> None changes without a
None reset between Rain and Dark Storm. Each leg exposed raw/eased progress,
the authored 45.0 second duration, and a visible countdown; the final return
settled to state/preset `none`/`cumulus` with rain 0, wetness 0, and particle
geometry hidden. The hardest decreasing-speed Dark Storm -> None leg retained
the rain field while fading: 12 samples over six seconds increased integrated
fall distance on every sample while rain intensity fell from 0.759 to 0.584.
`artifacts/weather-darkstorm-transition-review.jpg` and
`artifacts/weather-darkstorm-ziggurat-settled.jpg` show thin translucent rain
without a square/block edge. The settled Dark Storm retained full rain 1.0.
Runtime receiver diagnostics found 23 wrapped local materials across 89 meshes,
including `stone_summit_landing`, while both current-frame sky shells were
correctly excluded. Arbitrary-roof puddle sign-off and multi-TOD/lightning
raindrop color sign-off remain deliberately open until those exact looks are
captured clearly.

Fresh live sky stability acceptance (2026-07-16): the high sheet now fades
from its own shell-hit distance rather than the low deck's nearer entry
distance; artifacts/reflection-sky-before.png and
artifacts/reflection-sky-shadow-final.png retain nearby/overhead clouds
without the former far-horizon stretched copy. Cloud shadows are installed
when Weather is None (14 local PBR receiver materials), trace arbitrary world
positions toward sunDir, and sample the first-erosion visible cloud mass so
they travel as patches rather than pulsing the whole scene. Controlled
camera-identical captures are retained as
artifacts/cloud-shadow-patch-t000.png and
artifacts/cloud-shadow-patch-t015.png. Live tier rebuilds reported the same
effect with 6/4/2 samples in High/Balanced/Performance; quality changes budget
only. tools/audit-sky-stability-static.mjs passes 22 assertions and
tools/audit-sky-stability-runtime.mjs passes on the restored
Cumulus/Balanced/None default.

The normal wrapper now loads Eidoverse's LROC moon texture (SHA-256
B246064F217F8D479DF78C49C7C8595A8F5FBDA008A72FD539978D2E121E0109);
clear/cumulus/stratus/cirrus and all three quality rebuilds reported the branch
present, while TOD/elevation and real cloud alpha control visibility. A clear
dusk live capture is retained at
artifacts/earth-moon-clear-balanced-unobscured.png. Shieldworld remains a
separate shattered rocky moon: at 00:00 its night/elevation gate reported
visible with opacity 1, its analytic key was warm RGB
[0.70455, 0.19448, 0.0798], and its bounced scene moonlight is amber-brown
#d06a3c.

`node tools/audit-sky-resource-lifecycle.mjs` passes 66 CPU-only lifecycle
assertions. Lightning reuses fixed dynamic buffers; cloud-shadow roots are
restored instead of stacking wrappers; spatial domes are single-owner and
reattached on disposal; Ringworld GLB textures/materials are owned; Weather,
Ringworld, and Shieldworld constructors roll back partial work; and a failed
main build releases every completed pipeline/pass/preset stage.

## Terrain, crater, cliffs, and valley

- [ ] No terrain holes, shells, reversed faces, or horizon seams.
- [ ] Several Poly Haven/ambientCG PBR surfaces produce clear natural breakup.
- [ ] No close repeat tiling and no WebGPU sampler-limit violation.
- [ ] Add a distant nuclear-blast crater beyond/north of the ziggurat, opposite start.
- [ ] Crater has a retained heightmap, irregular bowl/rim/ejecta, fused ground, collision, and vegetation exclusion.
- [x] Cliffs use heightmap-informed broad desert escarpments, not whimsical cylinders.
- [x] Several coherent cliff/rock PBR sets operate at believable projection scale.
- [ ] Dense clustered scrub, saguaros, and Joshua trees with long instanced LODs.
- [ ] Vegetation remains GPU-instanced and uses real-geometry LOD cutovers that avoid the former ~13.2M-triangle plant frame while retaining all 1,190 plants and 1,450 m billboard visibility.
- [ ] Shrubs are footprint-seated and do not hover.
- [ ] Joshua trunk/live-leaf/dry-skirt materials remain distinct at every LOD.
- [ ] Saguaros retain the healthy-skin/damage mix at every LOD.
- [ ] Plant alpha/translucency is naturally shaded, never max-emissive.

Terrain-material v3 static evidence (2026-07-17): the acquisition and build
checks verify 35 immutable 4096-square source maps and 14 true 2048-square
runtime maps. The corrected static terrain audit passes 1,355 CPU-only assertions
across 9,409 samples. Dominant ownership is Rocky Trail 2,182, Dry Ground 991,
Laterite 613, Cracked Ground 1,079, wash-only Riverbed 897, Rock029 1,302, and
Rock061 2,345; riverbed has zero weight outside the authored washes. The 55-check
material-node audit proves near/far WGSL reaches albedo-height from color,
normal, roughness, and AO graphs; reaches packed PBR from every non-color graph;
uses exactly two array resources; samples layer six; and contains no implicit
mesh-UV TBN. It also proves 4/1 dominant near/far taps and the value-space seam
blend at constant UV scale. A vendor guard proves r184 generates every mip for every array
layer. This is shader-generation evidence, not a live GPU compile, visual-quality,
or performance claim. The following 2026-07-16 four-layer evidence is historical
and superseded for active ground materials only.

Static/numeric acceptance evidence (2026-07-16): `node
tools/audit-terrain-static.mjs` passes 1,330 CPU-only
assertions. 9,409 terrain samples exercised all four PBR layers as the
dominant surface (base 1,326; sand 3,994; soil 3,162; stone 927), with no
NaN/invalid weights. The five-channel 2x2 atlases are 2064 square with four
guttered 1024 source tiles; the shader samples four runtime maps. All 86,016
horizon triangles face upward with no degenerates; adjacent square sectors
meet at exactly 0 m with identical analytic seam normals, and the near/horizon
height delta is only Float32 rounding (0.00000381 m). Distant placement now
samples the rendered horizon triangles rather than the smooth analytic field;
the former mismatch reached 6.26 m by 520 m and could visibly float otherwise
correctly footprint-seated plants. Four unique authored escarpment modules
provide 12 closed two-manifold LOD meshes at aggregate budgets of
132,216/44,948/14,540 triangles. Cliff PBR blends cap, exposed-face, talus, and
macro ownership at 8.5-31 m projection scales; dressing rocks retain two sets
at 3.35 m.
The crater is 413.39 m from start and 266.01 m beyond the ziggurat with a
negative start/crater direction dot product, a -23.5 m bowl, asymmetric rim,
fused paint, collision, and exclusion. Its retained source is 1024-square
gray16; the corrected 320 m span now includes the complete 1.72-radius ejecta
field and every border sample is exactly zero datum (no square import seam).
Its -24 m to +18 m 16-bit normalization retains headroom around the complete
-23.5 m to +16.47 m profile instead of clipping the asymmetric rim at +14 m.
Vegetation retains 760 saguaros and 430 Joshua trees with real LOD cuts at
60/160/420 m and billboards to 1450 m, independent of sky quality. Safe index
remapping removes 94.12%/94.12%/93.75% of unused Joshua LOD0/1/2 attribute
records without changing indices, triangles, or green/dry/driest roles;
the dense visible LOD2/billboards no longer traverse the near-only shadow
pass. Instead, current LOD2 membership casts with each asset's authored
two-card LOD3 silhouette on a shadow-only layer (four triangles per plant), so
the LOD1 -> LOD2 cut does not pop flat/bright. `node
tools/audit-vegetation-lighting-static.mjs` passes 26 static assertions:
the raw assets have zero emissive materials, runtime disables the one exported
full-strength saguaro-spine transmission lobe, and the extra 1.45x sun
overdrive is absent. Trees, cacti, boulders, and 9,200 shrubs use footprint
seating; shrub and plant foliage is zero-emissive, alpha-tested PBR.

### Authored escarpment replacement — 2026-07-16

- [x] Four unique rock masses replace the rejected shared procedural profile;
  the two rear shoulders leave a clean sky aperture behind the ziggurat and
  Inanna orb instead of one axial kilometre-wide wall.
- [x] Broken caps, benches, buttresses, undercuts, and talus read at near,
  middle, and horizon range without the former smooth-loaf silhouette, black
  closure shelf, floating toe, or repeated six-band grammar.
- [x] Shared photographed cap/face/talus PBR response remains grounded and
  readable in retained approach, north-boundary, and west-buttress live views.

Retained/repeatable evidence: the 1254-square generated source and deterministic
1024-square gray16 derivative are versioned with exact hashes, orientation, and
normalization in `painted_escarpment_height_v1.json`.
`authored_escarpments_v1.blend` is the editable authority; the texture-free
`authored_escarpments_v1.glb` contains WesternButtress, NorthernShoulder,
EasternFins, and FarOutlier at LOD0/1/2. COLOR_0 RGBA preserves cap,
exposed-face, talus, and macro ownership across every LOD. Runtime conforms only
the buried 4.5 m toe zone, keeps upper silhouettes rigid, excludes cliff
footprints from procedural ecology, and makes the gameplay camera the sole LOD
authority so reflection/cloud cameras cannot overwrite visible levels.

Fresh live evidence: `artifacts/terrain-authored-v1-final3-approach.jpg`
preserves the temple/orb aperture;
`terrain-authored-v1-final2-north-boundary.jpg` shows separated asymmetric
masses and an open valley; `terrain-authored-v1-final3-west-buttress.jpg`
shows the close authored face at LOD0. The final page reports no runtime error;
the west view held LOD0 at 327.78/552.31 m while distant modules remained LOD1.

## Perimeter wall kit and gate

- [x] Gate uses its built-in posts; no duplicate pillars beside it.
- [x] Every wall-wall joint has one standalone pillar.
- [x] Walls inset into gate posts, pillars, and towers.
- [x] Live grammar: 1 gate, 32 walls, 27 pillars, 4 towers, 0 unsupported ends.
- [ ] Approach opens the authored leaf smoothly and collision follows it.
- [ ] Regenerate heavier sci-fi gate open/close audio and synchronize it.
- [ ] Gate audio is audible, spatially correct, and never missed before decode.

Static grammar rerun (2026-07-15): exact source execution produced 64 total
modules, zero duplicate support sockets, zero standalone pillars at either
built-in gate post, and every wall endpoint on a gate-post, pillar, or tower
centerline. Runtime code animates `Cube.001` itself and derives collision from
the same door bounds/progress.

Repeatable CPU audit: `node tools/audit-temple-static.mjs` passes 88 assertions
against the actual Eidoverse GLBs, runtime, controller, and audio wiring. The
loaded kit dimensions are gate 4x7.30x24 m, wall 4x7x10 m, pillar 4x7x4 m, and
tower 8x9.5x8 m. A separate renderer-free simulation,
`node tools/audit-temple-runtime.mjs`, verifies proximity motion and collision
on the authored leaf, including closed/open/closed transitions. Audible timing,
spatial impression, and subjective motion still require the fresh live pass.

## Ziggurat and Inanna sphere

- [ ] Current stair design is rejected; rebuild again from a generated reference.
- [ ] Rectilinear terraced temple massing reads as a ziggurat, never a smooth/battered pyramid.
- [ ] Proper monumental flights, landings, retaining walls, and tier transitions.
- [ ] Every stair tread/riser/cheek/landing has outward winding and correct normals under backface culling.
- [ ] No stair pile, floating pieces, overlapping boxes, missing faces, or low-poly facets.
- [ ] Sandstone PBR plus correctly repeated Harness lapis/carnelian PBR.
- [ ] Mineral courses and dark metal panels are inset/interwoven with masonry.
- [ ] Sci-fi systems are architectural, not loose box clutter.
- [ ] Walk from gate to summit and collide with the Inanna sphere.
- [ ] Existing red/blue sphere-side emissive lights drive lateral night beams.
- [ ] No detached/upward emitter boxes; bloom and beam depth are correct.
- [x] Leave an organized editable `assets/temple/ziggurat_architecture.blend` handoff.

Integrated-v2 structural evidence (2026-07-16; supersedes the older generated-
architecture evidence retained below): the immutable user source and its 08:00
snapshot still hash to
`66C6F1C925CC77D51F32F10FDC4B771E96B9E19F5DD993ADDA1880FBFA55F228`.
The non-destructive result is
`assets/temple/eanpa_ziggurat_area_integrated_v2.blend`; runtime architecture is
exported to `assets/temple/ziggurat_architecture.glb`, with editable standalone
handoffs in `ziggurat_architecture_integrated_v2.blend` and
`ziggurat_architecture.blend`. It preserves all 156 protected user objects and
the user's transforms, topology, and normals; repairs UVs only on the eight new
rail/cap meshes; adds eight closed Metal010 flush trims; and restores 176
panel-corner fastener decal components, including the exact authored offsets of
the two moved upper-front panels. The authoritative stair/collision width is
15.5030928 m.

The integrated GLB contains 31 meshes / 70,192 triangles, with zero degenerate
faces. Its 192 nonmanifold edges are exactly the intentionally retained open
surface seams on the eight user-authored rails (24 each), not missing visible
faces; those meshes alone use an object-specific double-sided triplanar
sandstone runtime material for backface safety. The panel, rail, and dais
Metal010 responses use their approved distinct roughness/metalness calibrations.
Repeatable evidence: `node tools/audit-temple-static.mjs` passes 140 assertions,
`node tools/audit-temple-runtime.mjs` passes 843, and
`node tools/audit-ziggurat-integrated-v2.mjs` passes 192. Exact hashes and the
protected-object allowlist are recorded in
`artifacts/ziggurat-integration/integrated_v2_report.json`. Live architectural
look, traversal feel, and subjective material response remain intentionally
open for the shared-browser acceptance pass.
- [x] Leave a reopen-validated whole-area `assets/temple/eanpa_ziggurat_area_editable.blend` with the exact Eidoverse perimeter and Inanna sphere layout.

Independent Blender acceptance evidence (2026-07-16; live architectural-look
sign-off remains open): both the retained Blend source and a fresh import of
the runtime GLB contain 17 meshes / 75,264 triangles with zero degenerate
faces, zero nonmanifold edges, zero negative-volume components, and zero faces
changed by outward-normal recalculation (runtime flat splits welded at only
0.1 mm for the topology audit). The four load-bearing tier dimensions are
70x68x8.8, 58x50x5.6, 46x34x5.0, and 34x18x4.4 m: equal top/bottom plans and
vertical faces, never a battered pyramid. The measured traversal contract is
110 steps at 0.20 m rise / 0.30 m tread, four flights, and three 1.60 m
landings. Sandstone, lapis, carnelian, and sci-fi metal are distinct authored
slots; Harness minerals repeat 3.25x at runtime. The `.blend` exists and is
organized into masonry, stairs, mineral, and integrated-metal collections.
The 17.8 MB area handoff was independently reopened in Blender 4.3 and contains
one gate, 32 linked wall bays, 27 linked standalone pillars, four linked
watchtowers, the authored architecture, and the normalized 4.9 m Inanna sphere.

The rebuilt GLB now embeds that schedule and clean-topology evidence in root
extras, preventing a stale export from silently disagreeing with runtime
collision. `node tools/audit-temple-runtime.mjs` passes 816 CPU assertions: all
110 visible tread centers, all three landings, 630 dense traversal samples
(maximum rise 0.20000000000000284 m), all four tier-side auto-climb rejection
cases, and full-3D orb resolution along X/Y/Z at the 2.79 m camera-clearance
radius. The actual orb GLB's emissive primitive centers are independently
verified at red +0.97365 X and blue -0.97428 X; runtime anchors are derived from
the emissive primitive/material-group geometry and tagged lateral/outward.
`audit-ziggurat-blend.py` confirms the editable handoff retains all five named
artist collections, 17 meshes, five material slots, and the same 110/4/3 stair
contract. Live appearance, first-person traversal feel, bloom/beam depth, and
subjective sphere-contact sign-off remain intentionally open.

Material/decal/night diagnostic acceptance (2026-07-16): a fresh live reload
on `http://127.0.0.1:8378/` completed with the boot overlay hidden, weather
`none`, and no transition active. The fixture metals now use dedicated
ambientCG Metal010 CC0 color/NormalGL/roughness/metalness textures with
independent `roughness.r` and `metalness.r` decoding. Panel, rail, and dais
fallback calibrations are intentionally distinct at roughness/metalness
0.58/0.78, 0.69/0.69, and 0.50/0.82. The exact 176 fasteners are authored
UV-mapped RGBA decals on support faces only 5 mm beyond the panel surface. The
superseding `corner_v2` pass measures 0.235 m support plates / 0.090 m visible
detail, moves them closer to actual panel corners, and binds the existing
Metal010 NormalGL map through the same UVs; no old octagonal stud dimensions
or wall-derived material path remain. The authored blue emitter is forced to
true saturated `#007cff` while red remains unchanged; local 52 m gradient
volumes and separate 600 m shadowed spotlights remain present.

Repeatable evidence: `node tools/audit-temple-static.mjs` passes 103 assertions;
`node tools/audit-temple-runtime.mjs` passes 816. The strengthened editable
Blend audit confirms 17 meshes, five material slots, `FastenerDecalUV`, and
five packed source images (four Metal010 maps plus the generated decal). The
exported GLB audit reports 75,264 triangles, 38,960 welded vertices, zero
degenerates/nonmanifold edges, and no nonpositive volumes. Name-preserving
scalar export slots remove all duplicate embedded PBR/decal images, reducing
the GLB from 9,770,696 to 6,188,448 bytes (36.7%) while the full materials stay
packed in the editable Blend. Final SHA-256: GLB
`394A6A36EEDD6DAFBA4063EF7C43725FEB840776EE9E083B0397F3F0993888C6`;
Blend `163EF7F600D3CA8D6EAFFA0F08B330D1AB830E988533C6ECED381C7E0913474B`.
`artifacts/temple-material-decal-stable.png`. Live close-up aesthetic judgement
of metal response, decal subtlety, beam softness, bloom, and terrain reach
remains intentionally unchecked until viewed in the current shared browser.

## Movement and sound

- [x] Input clears on blur/visibility/pointer loss; no endless movement.
- [x] Physical-key state never expires; lifecycle reconciliation prevents forever-walk paths.
- [ ] Grounded walk/sprint bob feels coherent.
- [ ] Progressive gravity/falling and grounded stair descent feel correct.
- [ ] Space performs one grounded jump per press without hold-repeat.
- [ ] Surface-aware sand/gravel/sandstone footsteps are audible.
- [ ] Footstep cadence/tone is natural and walking Foley is appropriately quiet.
- [ ] Landing impact scales with fall velocity.
- [ ] Seamless rain follows live intensity.
- [ ] Thunder follows actual lightning with distance delay.

Static/isolated acceptance evidence (2026-07-15; live subjective sign-off
remains open): `node tools/audit-input-static.mjs` executes the real input and
movement blocks for 600 frames. A W keydown with no repeat events remained
latched for the complete simulated 10.0 seconds and moved 36 m; its normal
keyup stopped horizontal motion on the same event. A keyup swallowed across
blur cleared on lifecycle reconciliation. Hidden-page, native-panel,
editable-focus, pointer-cancel, and unexpected lost-capture paths also clear;
an expected pointer-up capture release correctly preserves a physically held
direction. Shift remains held across an idle frame before W. Source guards
prove the 1.8 s heartbeat lease, stale timeout counter, and inferred Shift
release are absent. A held Space produced one jump across 240 simulated
physics frames; release plus a fresh press produced the next. Walk/sprint
cadence is 2.25/3.0 steps per second. Footstep pre-bus gain is 0.1354/0.1858
at walk/sprint, with an absolute 0.22 ceiling before the effects/master buses.
`python tools/audit-audio-static.py` passes 201 CPU-only decoded-audio checks.
It found the retained fourth gravel contact at +7.91 dBFS and 12-15 dB louder
than its siblings; a non-destructive 0.22 per-asset runtime trim now brings it
to -5.24 dBFS peak / -30.48 dBFS active RMS while preserving the CC0 Ogg.
Post-bus reference-distance peak ceilings are -19.37 dBFS footsteps, -12.32
landings, -8.79 gate, -6.37 close thunder, and -14.77 rain. The decoded rain
seam is 0.876x an ordinary adjacent transition, 42.64% of ordinary transitions
are larger, head/tail energy differs by 0.97 dB, and the master measures -20.41
LUFS / -5.35 dBTP. Rain now begins as soon as its own buffer decodes rather
than waiting for every thunder asset. Existing mocked Web Audio/weather and
gate integration suites pass 310 and 96 assertions; live listening remains
open for cadence/tone, spatial gate character, and weather balance.

## Final live acceptance

- [ ] Test every sky, cloud preset, weather, and all three quality modes.
- [ ] Test AO/bloom, day/night, moon, gate, stairs, orb, jump, and all audio.
- [ ] Inspect screenshots/video from start, crater, ground approach, and summit.
- [ ] Leave http://localhost:8377 in Cumulus/Balanced/None/day/AO-on state.
