# Eanpa Southwest ground v3

This pack replaces the rejected v2 terrain material without modifying or
deleting v2. It contains fourteen user-requested CC0 surfaces:

1. Poly Haven Rocky Trail 02 — dominant gravel/stony ground.
2. Poly Haven Dry Ground Rocks — stony transition aggregate.
3. Poly Haven Red Laterite Soil Stones — warm gravel/soil transition.
4. Poly Haven Cracked Red Ground — compacted flats.
5. Poly Haven Mud Cracked Dry Riverbed 002 — authored washes only.
6. ambientCG Rock029 — orange bedrock and steep/outcrop accents.
7. ambientCG Rock061 — tan bedrock/outcrop transition.
8. Poly Haven Gravelly Sand — sandy gravel restricted to authored washes.
9. Poly Haven Rock Face 03 — elevated weathered rock faces.
10. Poly Haven Sandy Gravel 02 — warm sandy gravel restricted to authored washes.
11. Poly Haven Rocky Trail — general gravel and broken talus.
12. Poly Haven Rock Face — elevated reddish rock faces.
13. Poly Haven Rock Boulder Cracked — cracked orange outcrop accents.
14. Poly Haven Rocks Ground 02 — coarse elevated scree/talus and rocky shoulders only.

## Reproducible sources and build

Run python tools/download-southwest-ground-v3.py to download the official 4K
masters. Red Laterite is copied byte-for-byte from v2 only after every source
hash matches that retained manifest. The --check option performs an offline
inventory and dimension verification.

Run python tools/build-southwest-ground-v3.py to regenerate the two true 2048
runtime maps per layer and the complete hash manifest. The --check option
verifies all 70 source hashes, all 28 runtime hashes, dimensions, modes,
source/capture spans, scene repeats, texel densities, layer order, packing,
active blend height, and disabled SPOM.

The 28 lossless 2K PNGs are the authoritative runtime-build inputs. The albedo
set packs sRGB color in RGB and normalized linear displacement height in alpha;
the packed set stores NormalGL X/Y, roughness, and AO in linear RGBA. Uploading
both raw fourteen-layer 2K arrays would cost 469,762,048 bytes at base level and
626,349,398 bytes with complete mips, so that is retained only as an honest
source-pack cost record—not the normal GPU path.

Run the following to build the preferred two 14-layer, 2048-square UASTC KTX2
arrays with complete authored mips:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools/build-southwest-ground-v3-ktx2.ps1 -Threads 4
```

Three r184 transcodes them to a supported 4x4 GPU format (BC7, ASTC, or ETC2
RGBA). Both
arrays together use 117,440,512 bytes at base level and 156,588,096 bytes with
block-aligned complete mips. The runtime validates dimensions, depth, mips, and
the actual compressed format before accepting either texture.

Run `python tools/build-southwest-ground-v3-fallback.py` to regenerate the 1K
lossless compatibility set; `--check` verifies its 28 hashes and NormalGL
validity without rebuilding. If KTX2 compression is unavailable or fails, the
loader inflates these RGBA8 PNGs one at a time into two 14-layer arrays. They
use 117,440,512 bytes at base level and 156,587,312 bytes with complete mips.
The exact PNG decoder supports filters 0–4 and never passes numeric terrain
channels through canvas premultiplication or display-color conversion.

## Color and scale

Each albedo receives its own linear-light chroma target, exposure, and contrast
setting. Local scan luminance is retained, so the treatment aligns the fourteen
surfaces into a tan-to-orange family without applying a flat global tint or
painting away gravel/crack detail. The manifest records parameters plus
source/runtime luminance quantiles for every layer.

`physical_span_m` records source/capture provenance; it is not fed to the
shader. `scene_repeat_m` is the complete world-XZ runtime repeat. SeedThree's
560 m terrain repeats its base UV 140 times (4.0 m), then multiplies rock UV by
0.55 (7.27 m). Those values anchor this pass, with larger crack/stone motifs
rounded upward after the rejected overly dense projection:

| Layer | Source/capture reference | Runtime repeat | Runtime density |
| --- | ---: | ---: | ---: |
| RockyTrail02 | 2 m | 4 m | 512 texels/m |
| DryGroundRocks | 4 m | 8 m | 256 texels/m |
| RedLateriteSoilStones | 2 m | 4 m | 512 texels/m |
| CrackedRedGround | 2 m | 6 m | 341.333 texels/m |
| MudCrackedDryRiverbed002 | 2 m | 6 m | 341.333 texels/m |
| Rock029 | prior 4 m calibration; no published span | 8 m | 256 texels/m |
| Rock061 | prior 4 m calibration; no published span | 8 m | 256 texels/m |
| GravellySand | 2.5 m | 5 m | 409.6 texels/m |
| RockFace03 | 2.7 m | 8 m | 256 texels/m |
| SandyGravel02 | 2.5 m | 5 m | 409.6 texels/m |
| RockyTrail | 2 m | 4 m | 512 texels/m |
| RockFace | 2.4 m | 8 m | 256 texels/m |
| RockBoulderCracked | 1.4 m | 6 m | 341.333 texels/m |
| RocksGround02 | 2 m | 4 m | 512 texels/m |

Seven independently transformed samples of SeedThree's authored grayscale
brush shape five ordinary-ground, three wash, and six rock/talus children into
organic interlocking deposits. RocksGround02 is excluded exactly from low flat
ground and enters only through its elevation/grade talus gate. Each family
uses a continuous relative-gap crossfade so secondary materials fade away
instead of switching along a hard line. The shader then keeps the strongest
five global weights without sampling all fourteen PBR layers per fragment.

## Height-aware transitions / future SPOM

Every layer retains its 4096-square displacement master. A 1st-99th percentile
normalized 2048-square derivative is packed into albedo alpha; the compressed
path preserves it at 2K and the compatibility pack provides its verified 1K
derivative. The selected runtime height is used only as a bounded +/-22% near /
+/-10% far bias between already-painted transition weights. Zero paint remains
zero, all PBR channels share the resulting weights, and height does not displace
or emboss terrain geometry. Full runtime SPOM remains disabled; the authored 4K
masters remain the authority for that later implementation.

Runtime pixels retain top-left image row order. World +Z maps to increasing
image V, so the shader negates NormalGL Y exactly once and constructs an
explicit world-XZ tangent frame around the geometric normal. It does not depend
on near-grid UVs or missing horizon UVs.

## License

All fourteen sources are released under CC0 1.0 Universal. Exact asset pages,
local filenames, SHA-256 hashes, byte sizes, and image metadata are recorded in
manifest.json.
