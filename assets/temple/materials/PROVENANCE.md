# Ziggurat mineral tile materials

The lapis lazuli and carnelian texture sets in this directory are exact binary
copies of the existing local project assets at:

`new_twitter_harness/generated_videos/ffmpeg/workspace/city_builder_assets/sumerian/`

Each 1254 x 1254 PBR set contains authored diffuse/base-color, OpenGL normal,
roughness, and height maps. Eanpa samples base color in sRGB and all data maps
in linear space. The normal map supplies surface relief. Because the source set
has no dedicated ambient-occlusion image, the height map supplies a low-strength
cavity signal to the material's PBR ambient-occlusion input rather than geometric
displacement or a base-color multiplier. These minerals are dielectric, so their
metalness is the calibrated scalar 0.02 rather than a fabricated texture map. At
runtime Eanpa packs base-color RGB + roughness A and normal RGB + cavity/AO A into two filtered GPU
textures, preserving every source map within WebGPU's 16-sampler shader limit.

Copied into Eanpa on 2026-07-15 at the user's direction. The source files were
already part of the user's local New Twitter Harness/City Builder asset library.
