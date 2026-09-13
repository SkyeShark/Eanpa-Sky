These 512px, fourteen-layer previews retain mip levels 2–11 of the full 2K
UASTC/Zstd arrays without re-encoding. Layer order, height alpha, packed normal
channels, color metadata, orientation, and licensing match the parent assets.

Regenerate with `node qa/build-terrain-previews.mjs`. Both previews total about
9.2 MB on disk and 9.3 MiB on the GPU including mipmaps. The standalone loads
them before presentation, downloads the full arrays during play, uploads one
array per frame, and swaps both bindings together. A failed upgrade retains the
preview. `?textures=full` retains the full-resolution blocking path for comparison.

Hosts using `makeTerrain` should call `terrain.updateTextureStreaming()` inside
their serialized frame loop, after the first frame. It returns true when the
full-resolution pair is published; invalidate reflection history/probes then.
Use `{progressiveTextures: false}` as the third argument for blocking loading.
