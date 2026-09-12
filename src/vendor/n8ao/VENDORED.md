Vendored from npm `n8ao-webgpu@0.1.0` (github.com/marioandf/n8ao-webgpu, CC0-1.0),
a three.js WebGPU port of N8AO by N8python — endorsed by the original author.
The bare `three` / `three/tsl` / `three/webgpu` import specifiers resolve through
the browser import map to this repository's vendored r186 build, guaranteeing one
Three.js instance even though the package's peer range is ^0.182.0.
The scene-pass helper uses the current `packNormalToRGB` TSL name in place of
the deprecated `directionToColor` alias. AO sampling and quality settings remain
unchanged by the initial Three upgrade.

The fence-shading follow-up exposes denoised visibility for material lighting
with `occlusionOnly` / `getOcclusionTextureNode()`. The native pipeline evaluates
AO from its existing current-geometry prepass and lets Three apply diffuse and
roughness-dependent specular occlusion to indirect light. It no longer applies
the default intensity-five multiply to the finished HDR image, which also
darkened direct light, emission and polished reflections. The legacy compositor
retains its postprocessing API.

The denoiser now retains valid zero visibility instead of replacing it with
one, and the hemisphere basis handles both parallel and antiparallel helper
directions. GPU contracts are in `qa/ambient-occlusion-contract.js`; the published
normal/visibility/receiver packing is checked by `qa/ambient-packing-contract.js`.
