# Terrain authoring sources

nuclear_crater_heightmap.png is a deterministic 1024 x 1024, 16-bit
grayscale height source covering 320 x 320 metres. Black/white normalization
maps from -24 m to +18 m relative to the local pre-impact datum, preserving the
complete -23.5 m to +16.47 m analytic profile without clipping. It contains
the irregular excavation bowl, asymmetric raised rim, and the complete radial
ejecta field with a zero-height border for seamless terrain-tool import.

Regenerate it from the repository root with:

    python tools/generate-crater-heightmap.py

The browser evaluates the same analytic profile in src/terrain_real.js; this
keeps collision exact while retaining a source that can be imported into
Blender, sculpted, or used to rebuild the terrain mesh.

## Imported desert cliffs

`Desert_Cliff_Wide_Mesa_Low.glb` and `Desert_Cliff_Mesa_High.glb` are the
untouched user-authored source assets. Runtime derivatives preserve their
geometry proportions and baked PBR material while reducing the embedded maps
to 2048 x 2048 and providing three offline-generated geometry LODs:

- `Desert_Cliff_Wide_Mesa_Low_runtime_2k_lods.glb`
- `Desert_Cliff_Mesa_High_runtime_2k_lods.glb`

The intermediate `_runtime_2k.glb` files are inputs to the Blender LOD build,
not files loaded by the browser. Build metadata and source/output hashes are
recorded in `desert_cliff_runtime_2k.json` and
`desert_cliff_runtime_lods.json`.

Rebuild and audit the imported-cliff pipeline from the repository root with:

    python tools/build-desert-cliff-runtime.py
    Blender --background --factory-startup --python tools/build-desert-cliff-lods-blender.py
    node tools/audit-desert-cliff-assets.mjs
    node tools/audit-desert-cliff-runtime.mjs
    node tools/audit-terrain-static.mjs

At runtime, `src/terrain_real.js` uses one instanced batch per asset and LOD.
Each placement keeps a uniform scale and rigid transform; terrain foundation
aprons conceal the buried bases. The cliffs remain outside player bounds and
have no collision geometry.

## Imported desert rock chunks

`Desert_rock_chunks_12_pieces.glb` is the untouched user-authored rock
library master. The offline pipeline identifies its 12 welded connected
pieces, preserves their baked PBR UVs, gives every piece a bottom-centered
reusable pivot, and exports three geometry LODs (100%, 32%, and 10% of the
source triangle count) in:

- `Desert_rock_chunks_12_pieces_runtime_2k_lods.glb`

`Desert_rock_chunks_12_pieces_runtime_2k.glb` is the texture-optimized
intermediate. Its three shared maps are capped at 2048 x 2048; the normal map
is vector-renormalized after filtering. Hashes, per-piece bounds, triangle
counts, and repairs are recorded in `desert_rock_chunks_runtime_2k.json` and
`desert_rock_chunks_runtime_lods.json`.

Rebuild and audit the rock library from the repository root with:

    python tools/build-desert-rock-runtime.py
    Blender --background --factory-startup --python tools/build-desert-rock-library-blender.py
    node tools/audit-desert-rock-runtime.mjs
    node tools/audit-terrain-static.mjs

The browser creates at most 36 true instanced buckets (12 pieces times three
LODs) with one shared embedded 2K PBR material. Ground scatter contains 656
deterministic terrain-seated placements; cliff dressing has a non-blocking
target of 64 and retains any valid partial cluster rather than aborting world
loading. Pieces use the visually inspected contact-sheet roles:

- flat/wide pieces 02, 04, 08, and 09: 2.0-5.8 m ground scatter
- irregular pieces 00, 05, 06, and 07: 0.95-2.75 m ground scatter
- smooth round pieces 01 and 10: 0.30-0.80 m ground scatter
- tall/narrow pieces 03 and 11: 6-14 m clustered cliff dressing only

LOD selection is based on projected diameter rather than fixed distance:
LOD0 at 72 pixels and above, LOD1 from 18 pixels, and LOD2 below 18 pixels.
Instances below one projected pixel are culled. Per-instance frustum tests use
the uniformly scaled authored bounding spheres, so both LOD and visibility
track the actual on-screen size of each placement.

The temple, processional route, washes, crater, steep slopes, and cliff
foundations are excluded. The former procedural `desert_boulders_0` through
`desert_boulders_3` and `desert_scree` populations are retired; the imported
12-piece library is the live rock dressing system. Rock dressing intentionally
has no physics or collision geometry.

## Authored escarpments v1

`painted_escarpment_height_source_v1.png` is the retained, versioned output
from OpenAI's built-in image-generation mode. It is never sampled directly at
runtime. `painted_escarpment_height_v1.png` is the deterministic 1024 x 1024
gray16 scalar source normalized from it, with a verified zero-height border.
Its hashes, orientation, and normalization parameters are recorded in
`painted_escarpment_height_v1.json`.

`authored_escarpments_v1.blend` is the retained editable mesh authority.
`authored_escarpments_v1.glb` is a retired texture-free export and is not
loaded by the current runtime. It contains
four unique rock masses with LOD0/1/2 meshes. COLOR_0 RGBA carries cap,
exposed-face, talus, and broad geological variation so every baked LOD can use
the shared photographed PBR texture arrays in `src/terrain_real.js`.

Rebuild both retained sources and the authored mesh export from the repository
root with:

    python tools/prepare-escarpment-heightmap.py
    Blender --background --factory-startup --python tools/build-authored-escarpments-blender.py
    node tools/audit-terrain-static.mjs

The exact image-generation prompt is retained below:

> GAME ENVIRONMENT ASSET SOURCE — Create one square orthographic top-down
> grayscale scalar heightmap for a long asymmetrical Colorado Plateau / Mojave
> desert escarpment, intended to drive a real 3D mesh in Blender. Pure height
> data only: black is exact surrounding ground elevation, white is the highest
> rock, continuous neutral-gray elevation values between. The outer 8% border
> must be solid black so the mesh buries cleanly into terrain. Shape: one broad
> broken escarpment running mostly left-to-right, split into three unequal
> connected rock masses; irregular receding back slope; a sharp discontinuous
> front rim; multiple wide stepped benches; narrow drainage gullies cutting
> backward through the rim; scalloped ends; broad talus aprons and fallen-rock
> lobes at the front; no radial symmetry, no isolated cone, no smooth loaf
> silhouette. Use large geological forms first and restrained smaller erosion
> detail; preserve broad flat-ish cap areas but break every long edge. Strictly
> no perspective, no directional lighting, no cast shadows, no ambient
> occlusion, no color, no surface texture, no contour lines, no labels, no
> frame, no text, no objects. Full-frame 1:1 PNG, clean continuous values
> suitable for 16-bit-style height interpretation.
