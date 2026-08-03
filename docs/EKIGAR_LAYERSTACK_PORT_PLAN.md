# Ekigar layer-stack + phacelle port plan (from agent survey, 2026-08-02)

Goal: adopt Ekigar's height-blend material fold + phacelle surface detail into
Eanpa's terrain material, keeping Eanpa's selection machinery, LOD policy, and
texture assets. Backup of pre-surgery terrain: `src/terrain_real.js.backup_pre_layerstack`.

## Key facts

- Ekigar layer_stack: ordered bands over ONE scalar driver; per-layer
  LAYER_PARAMS incl. heightOffset (m), blendDepth (m), physicalScale (m),
  heightMetres (m). Pairwise Substance-style layerBlend fold
  (`layer_kernel.js:262-287`): `d=(hTop-hBot)/max(blendRadius,1e-5); x=cov+d*cov*(1-cov);
  m=saturate((x-0.5)*max(contrast,1e-3)+0.5)` folded over a NEUTRAL stream —
  cov=0 stays absent by construction (fixes all-black degenerate case).
- Ekigar sampleLayerStream expects 4 samplers (diff/nor/arm/disp). Eanpa has 2:
  `albedo` (RGB sRGB albedo, A = linear relative height) and `packed`
  (R=normalX, G=normalY, B=roughness, A=AO). samplerCount=3 (incl. blendBrush).
- Eanpa terrain material: `makeTerrainMaterial` terrain_real.js:1590-2116.
  14 layers (:1322-1393), 3 families (ground[0,1,2,3,10], wash[4,7,9],
  rock[5,6,8,11,12,13] at :2017-2021), sparseFamily top-2 argmax + crossfade,
  top-5 selection before texture reads (:1824-1850, dynamicSamplesPerArray=5),
  height-sheared XZ projection + explicit .grad() (:1872-1912),
  height bias block :1921-1935, weighted mix :1940-1948, normal tail
  :1950-2014 (decodePackedNormal :1950-1957, TBN around normalWorldGeometry,
  view-space out), roughness contrast remap :2004-2008, aoNode = packed.a*0.84+0.16.
- Eanpa heights exist (albedo.a + 4K displacement masters in
  assets/pbr/eanpa_southwest_ground_v3/sources, catalogued spomHeightSources
  :1573-1586) but have NO metric scale — must author heightMetres/blendDepth.
- ecologyAt masks (compound/route/wash/crater/cliff/rockiness, :3079-3089) are
  CPU-only; shader only sees splat attributes + fragment wash reconstruction
  (:1772-1787).

## Steps

1. DONE — vendored verbatim to src/materials/: layer_kernel.js, ops.js,
   triplanar.js, noise.js, phacelle.js. All syntax-checked; imports resolve
   ('three/tsl' via import map; phacelle imports './noise.js').
2. NEW src/materials/eanpa_stream.js — sampleEanpaLayerStream mirroring kernel
   signature over Eanpa's 2-array packing:
   diff.rgb←albedo.rgb; height←albedo.a * heightMetres; AO←packed.a;
   rough←packed.b; normal←decodePackedNormal(packed.rg). PHASE 1: keep Eanpa's
   single height-sheared projection + existing normal path (NOT Ekigar
   triplanar — 3x reads and breaks .grad()).
3. NEW src/materials/eanpa_layer_meta.js — SURFACE_HEIGHT_METERS /
   SURFACE_BLEND_DEPTH_METERS for the 14 layers (guess rule: height≈scale*0.006,
   blend≈scale*0.002, floored up for rock scans):
   idx0 RockyTrail02 4.0m ~0.05/0.02 | idx1 DryGroundRocks 8.0 ~0.10/0.04 |
   idx2 RedLateriteSoilStones 4.0 ~0.05/0.02 | idx3 CrackedRedGround 6.0 ~0.04/0.02 |
   idx4 MudCrackedDryRiverbed002 (wash) 6.0 ~0.03/0.015 | idx5 Rock029 8.0 ~0.25/0.09 |
   idx6 Rock061 8.0 ~0.25/0.09 | idx7 GravellySand (wash) 5.0 ~0.05/0.02 |
   idx8 RockFace03 8.0 ~0.35/0.12 | idx9 SandyGravel02 (wash) 5.0 ~0.05/0.02 |
   idx10 RockyTrail 4.0 ~0.06/0.025 | idx11 RockFace 8.0 ~0.35/0.12 |
   idx12 RockBoulderCracked 6.0 ~0.30/0.10 | idx13 RocksGround02 (talus) 7.0 ~0.20/0.07
   Per-layer scalars must be selected like dynamicTransformFor (:1852-1859) —
   pack [heightMetres, blendDepth] into layerTransforms vec3→vec4 or a select chain.
4. EDIT terrain_real.js — replace ONLY :1921-1948 (heightBiasedWeights →
   weightedMix) with a 5-entry fold over top-K slots:
   entries[k] = { stream: sampleEanpaLayerStream(slot k),
     blend: { mask: slot.weight (already saturate-ranged), blendRadius:
     blendDepthFor(layer), contrast: uniform, opacity 1, invert 0 } };
   blended = blendLayerStack(ops, entries, neutralStream). Keep selection,
   gates, families, UV/grad exactly as-is. DO NOT port bandWindow (band model
   doesn't fit Eanpa's 3-family selection).
5. Feed blended.* into existing normal/rough/AO tail (:1950-2014) instead of
   mixedPacked. Re-apply LOD policy after fold: reliefDistanceFade (:1976),
   normalStrength near/far, roughness remap, broadVariation, far amplitude
   split; widen/lower blendRadius with distance (2cm is sub-pixel past ~200m).
6. Phacelle surface detail — use phacelleNoise ONLY (not ekigarField/
   erosionOperator; they need an rgba32float field target Eanpa lacks).
   Inputs: p = positionWorld.xz/detailScale; normDir = safeNormalize(vec2(-n.x,-n.z))
   from geometric world normal; freq ~0.7-1.0; offset 0.25; normalization 0.35;
   period vec2(0) — UNTILED (wrapCell supports period<=0; nonzero would seam).
   Outputs: gully stripe ph.x*0.5+0.5; sloping |ph.y|. Uses: wear mask →
   roughness offset + albedo darkening; ridge (2 octaves, ridgeFade*(1-ridgeMask))
   → normalStrength + AO; gully mask → bias WASH family weight (shader-side
   hydrology). BUDGET 1-2 octaves (16 hash2 + 16 cos/sin per octave), gate
   behind reliefDistanceFade. Helpers ease_out/smooth_start/safeNormalize are
   not exported from phacelle.js — export or inline. CRITICAL: assigns must be
   inside Fn() or silently dropped.
7. userData: extend, never replace (:2015-2114 asserted by
   tools/audit-southwest-ground-v3-runtime.py). Namespace as userData.layerStack.
   Keep AO floor 0.16 (not Ekigar's 0.15). normalNode stays VIEW space.
   No mrtNode on terrain (scene MRT in reflection_pipeline.js:238-257 is the
   contract; partial mrtNode would be stripped by main.js eanpaStripMrt).
8. NEW tools/audit-terrain-layer-stack.mjs following existing audit pattern.

## Risks

- UASTC alpha (height) is the weakest channel — validate on 1K PNG fallback
  first; may need wider blendDepth to hide quantisation.
- SURFACE_TILE_METERS is scene-calibrated, NOT publisher physical scale —
  accept divergence, do not "fix".
- Never copy layer_stack.js's positionNode (unit preview plane — would
  flatten terrain). Never assign userData.layers (collides with texture
  userData.layers slug list).
- Albedo already pre-graded by v3 builder — wire albedoTint/Brightness but
  default identity.
- Pre-existing dead-code bug: makeCliffMaterial (:2118-2262) samples
  maps.surfaceArray['roughness'] which loadGroundTextures never produces;
  currently uncalled; will throw if wired. Same defect in
  terrain_real.rock-role-patch.js:2025.

## Remaining queue after this port

- Mojave shrubbery port (grasstest → replace desert_dressing scrub; needs LOD,
  fetch I/O, dispose, baked placement; survey highlights in earlier session).
- Physics reconciliation: tree/rock collision misaligned with visuals; holes
  in temple/wall collision.
- User will clean up Ekigar's CPU/GPU duplication themselves (do NOT port
  field_cpu.js; heightfield algos NOT wanted — only phacelle + material stack).


## Ringworld lighting verification (2026-08-02)

User reported eclipses + "underground sun" from eidoverse missing in Eanpa.
VERIFIED PRESENT AND ARMED — engine/ringworld.js is md5-identical to the
prealpha's (067163d694a89d997dadbc0fed662785) and contains the whole rig:
- bandSun DirectionalLight (intensity 3.2) tracking the TRUE sun at full
  intensity day AND night — the "underground sun" lighting the far arc at
  local midnight (:1121-1200). Isolated on light layer 5 via
  bandMat.lightsNode = lights([bandSun, bandShine]) so it can never touch
  the local scene.
- Lights SELF-ATTACH to the scene root on first update (:1273-1277) — no
  host call needed. Eanpa host wiring verified equivalent to sky_worlds:
  ring.bindWeather(weatherAttachment, sky) at ringsky.js:156 and
  ring.update(t) per frame at :182 (matches band.bindWeather + band.update).
- eclipseK arch-night solver (:1426) present; neither host calls it for
  local-sun garnish (identical behavior both sides).
- RING_LIT gate: RINGLIT env unset and litBand not passed => TRUE. Good.
Conclusion: the user's "last seen state" predated the backport or the
SPOM/mip warping masked it. With material parity + SPOM armed (done), the
full system should be visible on reload. If the arc still looks unlit at
night, check RINGEMISSIVE/RINGLIT knobs and whether bandMat fell back
(watch console log for pipeline errors).

## Execution order agreed with user (2026-08-02)
1. Ring material parity + SPOM + lighting verify — DONE (test pending user)
2. Terrain: heightmap bake (R32F from terrainHeightAt at boot) -> textureBase
   port (5-signal classifier driving bands) -> materialMap bands over 14
   layers with authored-zone overrides -> height-blend fold -> phacelle detail
3. Mojave shrubbery port (grasstest)
4. Physics fixes: tree/rock collision alignment, temple/wall collision holes

## DONE 2026-08-03 — heightmap bake + textureBase classification phase

Ported Ekigar's `textureBase` operator (Ekigar src/core/registry.js:1603-1733)
into the terrain material as a family-class bias. Height-blend fold untouched.

Implementation:
- src/terrain_real.js:49-55 — HEIGHT_FIELD_SIZE 1024 / HEIGHT_FIELD_HALF_EXTENT
  800 (texel 1.5625 m); :1626-1657 `bakeTerrainHeightField(T3)` fills an R32F
  RedFormat DataTexture (Nearest, ClampToEdge, flipY false, raw meters) from
  `terrainHeightAt`; :2833 `maps.heightField = bakeTerrainHeightField(T3)` in
  makeTerrain; :3568 disposed with the other maps. Bake measured 2.0 s native
  for 1024² (the 4-minute number seen under vm.Script is a vm-context V8
  artifact ~100x; browser executes the real module natively).
- src/materials/texture_base.js — `makeTextureBaseValue(T3, heightField,
  params)` (:75) + `TEXTURE_BASE_DEFAULTS` (:47). Faithful port: 9-tap
  finite-difference stencil (gx/gy/rr/tt/ss at snapped texel centers, :94),
  slopeT, deposition (flat AND concave, curvatureGain 0.05 literal), patches
  (2-octave `fractalNoise` from ./noise.js, period vec2(0,0) UNTILED, /1.5
  fbmField normalisation), chaos (Hessian Frobenius, 0.02 scale), peaks
  (convex AND high via smoothstepSoft shape), Ekigar's exact composition
  weights 0.42/0.55/0.45/0.42/0.30 signed around 0.5 (:166), accentuate
  s-curve (sstep(0,1,v) == plain Hermite). No assigns anywhere (pure chains;
  .toVar only). METRIC DIVERGENCES (documented in the file header): gradients
  are true m/m so slopeAngle 0.55 / soilAngle 0.35 read as tangents;
  peakLevelMeters 30 (METERS above the valley floor — terrain spans −2..106 m
  — not Ekigar's 0.6 unit height); curvature is 1/m so chaosGain defaults 30
  and peaks gain an explicit peakConvexGain 30; radius rounds to WHOLE texels
  (default 2) because taps are nearest; value fades to neutral 0.5 outside the
  baked ±800 m (:186) so clamped edge taps never invent horizon geology.
- Wiring (both near and far materials, terrain_real.js:1876-1916): five signal
  weights are live uniforms (:1887-1893, stored at
  material.userData.textureBase.uniforms); class biases ground
  mix(0.65,1.55,v), rock mix(0.65,1.55,1−v), wash mix(0.80,1.40,v)
  (deposition-leaning) multiply the ALREADY-GATED family weights (:1910-1912)
  before selectTopK (:1953) — authored zeros (compound/route flats, exact wash
  support, summit/face exclusions) stay exactly zero, and the shared neutral
  factor 1.10 at v=0.5 cancels in weight normalization, so outside coverage
  the material is bit-identical to the pre-classifier contest.
- Module loading: texture_base.js rides `loadEkigarKernel()` (:19-40) into
  EKIGAR_KERNEL with the `globalThis.__EANPA_EKIGAR_KERNEL` vm escape hatch.
  tools/audit-terrain-v3-material-nodes.mjs injects it (:25-31 registers
  tools/resolve-vendored-three-hooks.mjs, mapping bare 'three/tsl' onto the
  vendored r184 build — Node would otherwise resolve a stray global three
  0.170 and mix node classes across revisions).
- userData: layerStack.textureBase (:2152), material.userData.textureBase
  (:2159), samplerCount 3→4 (:2240 — the height field is a fourth texture,
  though WGSL emits its stencil as sampler-free clamped textureLoad),
  terrain.userData.groundSamplerCount 4 + groundHeightFieldClassifier (:3281).
  All pre-existing keys intact.
- Audits (all passing): audit-terrain-static.mjs 1565 assertions (new
  textureBase block :2989-3021 pins bake constants, gate-preserving bias, and
  kernel threading; samplerCount regex updated :2930);
  audit-terrain-ownership.mjs 0 failures; audit-terrain-v3-material-nodes.mjs
  99 assertions (heightField stand-in :72, userData contract :136-155, WGSL
  read signature :270 — 7 brush textureSampleLevel + 9 height-field
  textureLoad + the standard material's own 2-read DFG LUT, which the old
  find-first brush probe silently skipped past).
Next per the agreed order: materialMap bands over the 14 layers with
authored-zone overrides, then phacelle detail. GPU-visual check pending user
(browser verification is user-driven by project rule).
