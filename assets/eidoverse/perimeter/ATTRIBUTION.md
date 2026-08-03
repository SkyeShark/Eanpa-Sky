# Eidoverse perimeter kit

The following bundled GLB assets are copied unmodified from the local
Eidoverse asset library:

- `scifi_perimeter_wall_gate.glb`
- `scifi_perimeter_wall_middle_use_between_two_pillars.glb`
- `scifi_perimeter_wall_pillar.glb`
- `scifi_perimeter_watchtower_standalone_or_with_wall_middle_four_way.glb`

Source: `eidoverse-video-prealpha-0.01/eidoverse/assets/models/`, maintained by
SkyeShark (`skyesharkie`). Eidoverse documents its bundled model library as a
mix of original handmade work by the maintainer and Meshy-generated work,
released under **CC0 1.0 Universal**. Attribution is not required by CC0 but is
included here at the maintainer's request.

Upstream credit record: `eidoverse-video-prealpha-0.01/CREDITS.md`, “Assets”.
License: <https://creativecommons.org/publicdomain/zero/1.0/>

The four files contain repeated copies of the same 2048×2048 PBR material set.
Eanpa retains one runtime material/texture set and shares it across all modules.

The `*_geometry.glb` files are exact-geometry, material-free derivatives of
the corresponding CC0 modules above. Eanpa loads the gate's shared 2K PBR
material once and applies it to these copies, avoiding three byte-identical
embedded texture payloads without changing authored vertices, normals, UVs,
indices, node transforms, dimensions, or scale.
