# Known limitations and review targets

The revised standalone overhaul and its measured evidence are documented in
[OVERHAUL_REVIEW.md](OVERHAUL_REVIEW.md). The latest motion, lighting and
sky-only benchmark pass is in [REVIEW_2026-09-09.md](REVIEW_2026-09-09.md).
Changes are local pending review.

- **Startup and sky/quality replacement are expensive.** Shader compilation and
  environment preparation can take tens of seconds behind the loading screen.
  These costs are separate from steady-state frame rates. Final rain capture
  variants now warm after all material wrapping, before the scene is revealed.
- **Reflection visibility is approximate.** Native PBR receives screen-space,
  local-probe, and sky radiance, but screen space cannot see hidden geometry and
  the probe updates over time. Newly revealed surfaces can briefly use the
  fallback. This is not multi-bounce ray tracing.
- **Cloud shadows have a finite extent.** The shared map fades at its border;
  hosts with larger worlds should configure its extent and resolution. Receivers
  inside the cloud deck use a height-weighted column approximation. Standard and
  Physical materials participate through scene registration; custom lighting
  shaders must apply the supplied attenuation to their celestial direct light.
- **Surface water is a shading model.** The local rain field resolves the first
  exposed surface along the rain direction. It does not simulate runoff, trapped
  water volumes, per-object moisture history, or a separate refractive water layer.
- **Constrained performance remains demanding.** The recorded CPU-plus-GPU stress
  runs are much slower than unrestricted runs. They retain the 5090 Laptop GPU's
  architecture and memory and do not stand in for a named lower-power device.
  The High sky tier and detailed terrain also carry substantial GPU/memory costs.
  Benchmark files record unrelated CPU/GPU activity. Contended runs must not
  be used to rank quality tiers against quiet runs or to claim a speedup.
- **The ring's sharper relief increases the asset payload.** Compressed terrain
  height/normal data and albedo total approximately 19.3 MB after the terrain
  slope correction. The current standalone
  loads this dataset as a whole; it does not stream terrain tiles.
- **Player collision coverage is bounded.** The actual temple stair flight,
  authored convex rock landing, and impact behavior have passed checks. Decorative
  stair trim, unusual corners, and every possible hand-authored cliff placement
  have not all been exhaustively traversed. Cliff placement remains authored.
- **Audio still needs a listening review.** Decode, gain/peak, loop seam, and shelter
  behavior were checked numerically. Those checks cannot establish subjective mix
  quality or spatial impression through the user's speakers or headphones.

The earlier gold-orb reflection stripes, terrain slope mapping, missing roof
cloud shadows, missing arbitrary-geometry rain response, rock support, and
intersecting solid moon fragments have specific fixes and retained checks in the
review report. The interactive review remains the place to report any missed
view, motion, material, or collision case.
