# Ringworld eclipse and distant surface banding

Reviewed follow-up to v0.2.1. The initial center/depth corrections are in
`a87c839`; the remaining solar-tangent cutoff correction is in `dfc9c94`.
Approved for publication on September 10; available in the
[live demo](https://skyeshark.github.io/Eanpa-Sky/).

[Before/after comparison, current captures and recordings](qa/review/ring-depth-20260910/index.html)

## Follow-up: the cutoff missed by the first review

The earlier review incorrectly called both arcs fixed. Its own 10.5h capture
still showed the water shadow ending abruptly on the arc facing away from the
temple. The center and depth corrections addressed real problems but left this
separate intersection error.

The eclipse helper discarded cylinder exits at distances of one metre or less,
assuming they were self-intersections. At the local solar tangent, the valid
exit approaches zero: the nearby ring ground blocks the sun. Sea-level water
was classified as unoccluded while raised land continued to intersect the
cylinder and stayed dark. A grayscale rendering of solar visibility reproduced
exactly the horizontal boundary and the bright-water/dark-land pattern.

The CPU and GPU helpers now classify the origin radially and retain those short
exits. A float-sized radial tolerance (five millimetres at the standalone ring's
radius) prevents numerical surface error reopening the seam. Truly exterior
rays pointing away and rays escaping the ring's width still remain unoccluded.
This is a small analytic tolerance, not full interval arithmetic; the motivation
is consistent with PBRT's discussion of [valid near intersections lost to fixed
ray epsilons](https://pbr-book.org/4ed/Shapes/Managing_Rounding_Error).

The old day/night switch also became visibly abrupt on the newly shadowed arc
at sunset. Its handoff into the authored night lighting now blends over the
last 2.9 degrees of observer solar elevation, symmetrically at sunrise. The
midday eclipse still follows the geometric shadow at each receiver.

## Retained center, depth and local-light corrections

The analytic cylinder uses the generated band's actual world-space center
`(0, 4921.660889, -0.458740)`, rather than the imported group pivot `(0, 4940, 0)`.
The observer visibility, band lighting and local surface shadow share this frame.

Fine distant stripes were land/water depth conflicts in the private celestial
capture. Its former 0.18-to-60,000-metre range mapped depths at 10,000 and 10,001
metres to the same float value. Only that capture's near plane is now 20 metres.
The player camera retains its 0.18-metre near plane. The private capture preserves
framing and parented camera pose. This follows Three.js's [near/far precision
guidance](https://threejs.org/manual/en/cameras.html).

Local PBR receivers use the same spatial solar visibility as the band. Ground,
buildings and roofs cross the edge at their own positions. The observer's
visibility controls the sun disc and ambient sky. Local lamps and planetshine
retain their separate response.

SPOM is disabled in this standalone path; the terrain is displaced geometry.
The water shader, textures and moving waves are retained.

## Current verification

- Matched 10.5h captures compare `63b035f` with `dfc9c94`, including isolated
  visibility masks. Camera, sun and ring animation time match; hand idle pose
  can differ. [Capture provenance](qa/review/ring-depth-20260910/tangent-comparison.json).
- Visually inspected 17 current engine views: both arcs in morning, eclipse
  entry, totality, exit and afternoon; the former cutoff close up; the distant
  reverse arc; sunrise and sunset pairs; and the bright nighttime water glint.
  The flagged horizontal cutoff is absent in these captures.
- Recorded both directions through the normal 120-second day cycle, including
  regular surface lighting and environment updates, and inspected sampled
  frames through entry, totality and exit. Neither recording reported engine
  errors or pointer capture. [Forward metadata](qa/review/ring-depth-20260910/motion.json)
  and [reverse metadata](qa/review/ring-depth-20260910/motion-reverse.json).
- 5,148 GPU/CPU comparisons across 13 sun positions pass. Maximum absolute
  discrepancy is 0.000456 with half-float readback. Unlike the earlier check,
  these include sea-level points on the cylinder and 525 tangent samples with
  an independent expectation of zero visibility, all of which are blocked.
  [Raw checks](qa/review/ring-depth-20260910/checks.json).
- All 86 Node tests pass. New coverage includes 915 tangent/elevation samples,
  radial rounding and open edges, and the twilight handoff. An independent
  triangulated-cylinder raycast agrees with 574 analytic daylight classifications;
  two partial edge samples are excluded from that binary comparison. The new
  tangent regression failed against the previous implementation.

The runtime change adds no shadow capture, texture, terrain search or scene-asset
batching. Frame-rate overlays in visual captures are not controlled benchmarks;
this correction makes no new lower-end hardware throughput claim.

The model remains a finite axis-X cylinder with an approximate finite-sun
penumbra. Mountain peaks are not individual solar occluders, and atmospheric
ambient dimming remains observer-wide. Night illumination is an authored mode,
not a full planetary illumination simulation. Integration details are in
[the sky guide](docs/SKY_SYSTEM_INTEGRATION.md#ring-eclipses-on-local-surfaces).

Reproduce current captures and checks with one already-loaded automated
Ringworld page, after its loading screen finishes:

```sh
node --test tests/*.test.mjs
node qa/ring-depth-eclipse-review.mjs
node qa/ring-eclipse-motion.mjs artifacts/ring-motion-forward forward
node qa/ring-eclipse-motion.mjs artifacts/ring-motion-reverse reverse
```
