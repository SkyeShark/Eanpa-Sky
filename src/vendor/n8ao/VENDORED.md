Vendored from npm `n8ao-webgpu@0.1.0` (github.com/marioandf/n8ao-webgpu, CC0-1.0),
a three.js WebGPU port of N8AO by N8python — endorsed by the original author.
The bare `three` / `three/tsl` / `three/webgpu` import specifiers resolve through
the browser import map to this repository's vendored r186 build, guaranteeing one
Three.js instance even though the package's peer range is ^0.182.0.
The scene-pass helper uses the current `packNormalToRGB` TSL name in place of
the deprecated `directionToColor` alias. AO sampling and quality settings remain
unchanged by the Three upgrade.
