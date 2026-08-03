# Temple panel decal sources

`panel_fastener_decal-v1.png` is the canonical runtime alpha decal for the
ziggurat's flush corner fasteners. It was generated with the built-in image
generation workflow on 2026-07-16, then converted from its flat chroma-key
source with the installed soft-matte/despill helper. The untouched generated
source is retained as `panel_fastener_chromakey-v1.png`.

Prompt intent: one orthographic, centered, dark-gunmetal countersunk Torx
fastener with a thin inset washer, restrained machining wear, and no panel,
wall, masonry, text, protruding hex head, or low-poly geometry. The source used
a uniform `#00ff00` background solely for alpha extraction.

The decal is intended to stay small and nearly flush. It must not be used as a
replacement base color for a panel, and it must not be accompanied by chunky
physical bolt meshes in the runtime or editable Blend deliverables.

`corner_v2` uses a 0.235 m closed support plate, which preserves the decal's
original 0.13/0.34 visible-content ratio at an approximately 0.090 m visible
fastener diameter. Centers sit 0.2262-0.2350 m from the actual panel bounds,
leaving 0.015 m of chamfer-line clearance. The authored `FastenerDecalUV`
continues to drive the RGBA decal and now also samples the existing ambientCG
Metal010 `NormalGL` map at strength 0.34. No synthesized normal bitmap and no
additional runtime texture fetch are introduced.
