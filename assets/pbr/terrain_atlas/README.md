# Eanpa terrain PBR atlases

Runtime 2x2 atlases for four independently painted desert surfaces:

1. Poly Haven `gravelly_sand`
2. ambientCG `Ground080`
3. ambientCG `Ground081`
4. ambientCG `Ground022`

Each 1024 px source tile has a four-pixel smeared gutter. The resulting 2064
px albedo, OpenGL normal, roughness, ambient-occlusion, and displacement maps
preserve the source PBR channels while reducing the terrain shader from sixteen
samplers to four. Source attribution remains alongside the original material
directories and in `../ADDITIONAL_DESERT_MATERIALS.md`.
