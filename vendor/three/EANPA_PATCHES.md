# Three.js r186 and local renderer changes

The standalone vendors stable **three@0.186.0 (r186)**, verified against npm's
`latest` tag on September 12, 2026. Core, WebGPU, TSL, addons and the Basis
JavaScript/WASM transcoder come from the same integrity-checked package.
[UPSTREAM.json](UPSTREAM.json) records provenance and upstream file hashes.
The [MIT license](LICENSE) belongs to the Three.js authors.

Migration references: [r186 release](https://github.com/mrdoob/three.js/releases/tag/r186)
and [r184 → r186 migration guide](https://github.com/mrdoob/three.js/wiki/Migration-Guide#184--185).
The previous reviewed Eanpa renderer is preserved at commit `c8a3571`.

## Retained patches

- `TextureNode.clone()` preserves the explicit `updateMatrix` policy. Screen
  buffers and PMREM samples must not regain per-object UV matrices through
  sample/LOD chains. Covered by `tests/texture-node-policy.test.mjs`.
- PCF and point-shadow filters share map-size/radius references per `LightShadow`.
  This retains the CPU submission optimization while using r186's own filtering
  equations and samples. References stay live across resize and replacement;
  separate lights remain independent. Covered by `tests/shadow-filter-uniforms.test.mjs`.
- `ShadowNode` initializes its shadow target before depth views are bound, so
  waking a zero-intensity light cannot replace an already-bound attachment.
  A map resize also bypasses the once-per-frame shadow guard: deferring the
  resize after a second receiver pass records its dimensions can leave static
  receivers sampling a destroyed depth view on the next frame. The unchanged
  size retains the normal update cadence. Covered by the shadow-filter unit
  test and `qa/shadow-uniform-validation.mjs` GPU readbacks.
- `Renderer.compileAsync()` builds node graphs sequentially and prepares up to
  four driver pipelines concurrently. It drains outstanding work on success or
  failure, restores precompile flags across exceptions, yields cached work on an
  8 ms CPU budget, and visits visible objects outside the current frustum.
  Offscreen depth/stencil settings match the actual target. The r186 progress
  callback is retained.
- `PassNode.compileAsync()` uses the rendering context, target format, layers,
  override material and lighting system of its actual draw. State restores on
  failure as well as success.
- WebGPU render-pipeline validation scopes close before awaiting driver work,
  preserving error ownership across overlapping compilations. The r186 shared
  descriptor reset and shader diagnostics are retained. Compiler/pass cases are
  covered by `tests/async-compilation.test.mjs`.
- `textureCubeUV` remains exposed through TSL for Eanpa's box-projected local
  probes. The implementation is r186's own PMREM sampler; only the export is
  retained. This avoids per-material PMREM wrappers and preserves shared probe
  texture bindings, explicit world directions and atomic probe publication.

## Superseded patches and application migration

r186 provides the MRT `blendModes` repair, restoration of light lists after
shadow renders, precompile shadow suppression, and shared skeletal history.
Their r184 backports are removed. The skinning regression test now exercises
r186's TSL callback instead of the removed `SkinningNode` class.

The application selects `PCFShadowMap`, since r186 removed `PCFSoftShadowMap` and
made PCF soft. Normal MRT writers use `packNormalToRGB` / `unpackRGBToNormal`.
Native PBR, PMREM filtering and the other upstream r186 improvements remain in
use; application quality presets and scene assets are not reduced.

The vendored SSR addon is stock r186. The optional `legacy_reflections` diagnostic
compositor needs radiance plus hit coverage, whereas r186 SSR outputs ray
distance in alpha. That compositor now uses `src/screen_space_trace.js`, sharing
the continuous crossing and receiver rejection with the default native PBR path.
It no longer depends on the old SSR addon patches or its positional arguments.
The optional path is exercised with `qa/legacy-reflection-contract.js` and
`qa/sky-fixture.html?legacy_reflections=1`. Runtime validation and captures
are recorded in [the upgrade review](../../qa/review/three-r186/README.md).

Resource retirement, shadow-material variants and environment ownership remain
in Eanpa adapters. They depend on pinned renderer interfaces and must be reviewed
alongside vendor updates. Host integrations using another Three build must
carry the applicable patches; importing sky/weather modules alone does not
apply the native renderer fixes. These are local changes, not an upstream release.
