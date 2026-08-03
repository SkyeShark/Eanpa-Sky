# Desert dressing assets

The scrub/ albedo, normal, roughness, and translucency maps for sagebrush,
blackbrush, and creosote were copied without modification from the local
[SeedThree](https://github.com/SkyeShark/SeedThree) asset library. SeedThree is
distributed under the MIT License, copyright (c) 2026 SkyeShark.

Poly Haven's
[worn_rock_natural_01](https://polyhaven.com/a/worn_rock_natural_01) and
[rock_face](https://polyhaven.com/a/rock_face) 1K PBR sets are retained under
CC0 1.0 Universal. Their complete albedo, OpenGL normal, roughness,
ambient-occlusion, and displacement channels remain in the asset library.
The former procedural `desert_boulders_0` through `desert_boulders_3` and
`desert_scree` populations are retired, and `src/desert_dressing.js` no
longer loads these maps for live procedural rocks. Runtime rock dressing now
uses the user-authored 12-piece GLB library and its shared embedded 2K PBR
material, as documented in `assets/terrain/README.md`.
