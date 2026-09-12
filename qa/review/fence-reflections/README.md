# Fence reflection repair

The flat metal bracket faces retained the wrong normal-map tangent after an
instance rotation. At particular camera angles, the tangent became parallel
to the transformed normal, producing invalid shading normals and solid-black
faces. The instancing shader now transforms both directions correctly.
The original geometry, maps, metalness, roughness and instancing remain in use.

Runtime fix: `817c7c8`, based on the local r186 upgrade at `982b946`.
The failure also reproduced on the reviewed r184 baseline `c8a3571`; it was
not introduced by this upgrade. Both vendored versions omitted the instance
tangent transform. The source is documented in
[Three's local patches](../../../vendor/three/EANPA_PATCHES.md).

[Open the visual comparison](index.html). The same camera path is recorded
before and after, including the positions that switched the front faces to
black. Wet metal is also recorded with the flashlight enabled.
[Capture provenance](capture-provenance.json) records the setup and limits.

## Lighting correction

The existing N8AO compositor separately over-darkened the bracket sides. It
multiplied the completed HDR lighting by visibility raised to a default
intensity of five, attenuating direct lights, emission and all reflection
lobes together. Eanpa now feeds denoised visibility through Three's native
material AO hook. Authored AO still combines with it; indirect diffuse and
specular occlusion follow the native material response. Direct illumination
and emission remain intact.

The AO filter also treated exact zero visibility as full visibility. Zero
now remains zero, preventing flashes when the denoised result crosses that
boundary. Its sampling basis handles both parallel and antiparallel normals.

AO uses the current reflection geometry prepass. Packed visibility shares
the existing normal/receiver texture binding, preserving the standalone's
24-texture material limit. The former final-lighting composite pass becomes
the visibility publication pass. Production shading needs three color
attachments; a fourth shaded-normal attachment is allocated only for explicit
diagnostics. No additional geometry pass or material texture binding is added.

## Validation

- All 92 Node tests pass with `npm.cmd test`.
- [Native instancing comparison](instanced-tangent-contract.json): all 15
  rotation, nonuniform-scale and buffer/attribute cases match equivalent
  ordinary meshes. Maximum normal-vector difference is below 0.000001.
  The [unfixed r186 control](instanced-tangent-before.json) fails all 15 cases,
  with normal differences up to 0.53 and mean HDR errors up to 38%.
- [Material AO contract](ambient-occlusion-contract.json): direct diffuse,
  direct specular and emission remain unchanged; indirect diffuse, authored
  AO and chrome/clearcoat match Three's native AO reference. Five unoccluded
  camera views remain unoccluded, and the shipped filter preserves zero.
- Actual fence readbacks in [dry](fence-normal-dry.json) and
  [wet](fence-normal-wet.json) conditions cover more than 2.7 million sampled
  pixels across ten camera poses, with zero nonfinite normals.
- [Packed data in the full scene](ambient-packing-contract.json): over 1.16
  million receiver pixels, no identity errors or invalid data; normal-vector
  error below 0.004. The [generic fixture](ambient-packing-fixture.json)
  also passes on a device requested with a 16-texture limit.
- [Reflection motion/depth](reflection-motion-contract.json): all six generic
  host meshes pass, with zero depth disagreement and under 0.002 pixel motion
  error. No WebGPU validation errors were reported by the GPU contracts.

The images and six-second clips were visually inspected. Videos run at
30 FPS for review, not as frame-rate evidence. Cloud phase differs between
recordings. The rain capture directly selects steady wetness to test material
lighting; it does not test the weather transition.

## Performance sanity check

These 12-second samples use Earth/Balanced/rain at 1578 × 846, moving camera,
six generic host meshes, and one scheduled sky-environment refresh. They
measure the reusable sky/weather/ground effects without demonstration assets
or player simulation. [Intervals, calibration and resource summaries](benchmarks.json)
are retained separately from the visual recordings.

| Source | Available resources | FPS | Median ms | p95 ms |
| --- | --- | ---: | ---: | ---: |
| Before, r186 | Native local GPU/CPU | 236.3 | 4.2 | 4.5 |
| Corrected | Native local GPU/CPU | 231.4 | 4.2 | 5.4 |
| Corrected | 4× CPU slowdown + calibrated GPU contention | 72.6 | 12.6 | 17.3 |

The GPU is an RTX 5090 Laptop GPU. Other applications used about 6.5–8.1%
of total CPU capacity during these samples. None crossed the external GPU
activity threshold during measurement, but clocks and cloud phase were not
locked. These short runs do not establish a small performance gain or loss;
the unchanged median is a sanity check. Synthetic GPU contention targeted
8 ms and measured approximately 7.3–10.1 ms during the stressed run. This
reduces available resources on the local GPU; it does not emulate another
GPU architecture, memory capacity or a named lower-end device. Temporary
throttling and synthetic work were stopped afterward.

## Reproducing

Reuse the single owned QA browser and local server. GPU contracts are browser
expressions run with `node qa/cdp.mjs eval <file>`; the general contracts run
on `/qa/sky-fixture.html?sky=earth&quality=balanced&weather=rain`. The native
instancing comparison needs no scene assets. Run benchmarks before adding
diagnostic MRT attachments, or reload the fixture between them.

For the fence, pause the automated main page, use camera `[24,1.82,-19.5]`,
look at `[22,4,-24]`, FOV 62, Earth/Balanced at 10.5 h. Then run
`node qa/fence-reflection-review.mjs <name>` for the six-second path.
`qa/fence-normal-contract.js` checks the five corresponding poses on the
actual fence, explicitly requesting the diagnostic shaded-normal attachment.
Its initial shader preparation can exceed the CDP helper's 45-second timeout;
allow a longer `Runtime.evaluate` timeout or retrieve `__fenceNormalContract`
after preparation finishes. These inspection helpers never request pointer lock.
