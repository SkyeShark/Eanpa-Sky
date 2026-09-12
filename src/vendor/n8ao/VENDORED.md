Vendored from npm `n8ao-webgpu@0.1.0` (github.com/marioandf/n8ao-webgpu, CC0-1.0),
a three.js WebGPU port of N8AO by N8python — endorsed by the original author.
The bare `three` / `three/tsl` / `three/webgpu` import specifiers resolve through
the browser import map to this repository's vendored r184 build, guaranteeing one
Three.js instance even though the package's peer range is ^0.182.0.

Local compatibility patch: the half-resolution depth/normal downsample exposes
its MRT at the fragment-node root. Wrapping the output struct in Fn/context
caused r184 to declare a single color output and emit invalid WGSL member writes.
The chosen depth/normal values and sampling algorithm are unchanged.
