# Terrain and geological PBR materials

The active ground v3 pack retains 4K masters and builds true 2K runtime arrays.
Legacy 1K sets remain for older cliff/library paths. Every active ground set
includes albedo/diffuse, OpenGL normal, roughness, ambient-occlusion, and a
retained displacement map. The active runtime derivative places normalized
2K displacement height in albedo alpha for bounded transition weighting while
retaining the authored 4K displacement master for future geometric SPOM.

## Poly Haven (CC0 1.0 Universal)

- [dry_ground_rocks](https://polyhaven.com/a/dry_ground_rocks)
- [red_laterite_soil_stones](https://polyhaven.com/a/red_laterite_soil_stones)
- [cracked_red_ground](https://polyhaven.com/a/cracked_red_ground)
- [rocky_trail_02](https://polyhaven.com/a/rocky_trail_02)
- [mud_cracked_dry_riverbed_002](https://polyhaven.com/a/mud_cracked_dry_riverbed_002)
- [gravelly_sand](https://polyhaven.com/a/gravelly_sand)
- [cliff_side](https://polyhaven.com/a/cliff_side)
- [rock_face](https://polyhaven.com/a/rock_face)
- [worn_rock_natural_01](https://polyhaven.com/a/worn_rock_natural_01)
- [sandy_gravel_02](https://polyhaven.com/a/sandy_gravel_02) (library variant)

## ambientCG (CC0 1.0 Universal)

- [Rock 029](https://ambientcg.com/view?id=Rock029)
- [Rock 061](https://ambientcg.com/view?id=Rock061)
- [Ground 080](https://ambientcg.com/view?id=Ground080)
- [Ground 081](https://ambientcg.com/view?id=Ground081)
- [Ground 022](https://ambientcg.com/view?id=Ground022) (library variant)

Poly Haven and ambientCG release these materials under the Creative Commons
CC0 1.0 Universal Public Domain Dedication. Material identifiers are retained
in folder names and runtime pbrSource metadata.
