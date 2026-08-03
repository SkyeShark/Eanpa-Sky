# Vegetation asset attribution

`saguaro_seed555.glb` and `joshuaTree_seed555.glb` were generated from the
seed-555 Saguaro and Joshua Tree presets with
[SeedThree](https://github.com/SkyeShark/SeedThree), then exported through its
production Three.js GLTF pipeline. Export hashes and authored LOD statistics
are recorded in `seed555-exports.json`.

The runtime `saguaro_seed555.glb` is the exact original SeedThree export; its
size and SHA-256 are recorded in `seed555-exports.json`. A rejected Eanpa-only
topology experiment is retained under `artifacts/saguaro-topology-repair/` for
diagnostic provenance, but it is not loaded by the scene and no SeedThree
source file was modified.

The supplemental files in `materials/` are exact copies of the corresponding
SeedThree source PBR maps. They restore shader-driven data that glTF cannot
encode directly: the Joshua tree's dry and driest frond stages, and the
saguaro's clean skin used by its healthy/scarred world-space blend.

SeedThree is distributed under the MIT License:

MIT License

Copyright (c) 2026 SkyeShark

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
