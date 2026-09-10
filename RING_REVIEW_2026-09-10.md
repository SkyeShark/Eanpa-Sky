# Ringworld eclipse and distant surface banding

Local review after v0.2.1; rendering changes saved in `a87c839`.
These changes have not been published to the live demo.

[Visual comparison and eclipse recording](qa/review/ring-depth-20260910/index.html)

## Causes and corrections

The broad lighting break on one arc came from the analytic eclipse cylinder
using the imported group's pivot `(0, 4940, 0)`. The generated sea/land cylinder
is actually centered at `(0, 4921.660889, -0.458740)` in world space. That mismatch
made water intersect its own shadow cylinder on one side. The CPU observer
visibility, band lighting, and local surface shadow now use the geometry center.

The finer stripes were land/water depth conflicts in the private celestial
capture. Its former 0.18-to-60,000-metre range loses metre-scale separation ten
kilometres away: the regression test maps depths at 10,000 and 10,001 metres to
the same float value. Raising only this capture's near plane to 20 metres keeps
them distinct. The main camera retains its 0.18-metre near plane, with the same
framing, zoom, and local reflection depth convention. The private camera also
preserves a parented camera's world pose without cloning its attached objects.
This follows Three.js's [near/far precision guidance](https://threejs.org/manual/en/cameras.html).

SPOM is not enabled in the standalone Ringworld path; this terrain is displaced
geometry. The water shader, textures, and animated waves are unchanged.

The local eclipse now attenuates the celestial light at each PBR surface using
the same analytic visibility as the band. Ground, buildings, and roofs can cross
the shadow edge at different moments. The observer's visibility controls the
sun disc and ambient sky; it no longer scales sunlight on every receiver.
Local lamps and planetshine keep their own lighting response. Fixture darkness
sensing still follows the observer's illumination.

## Verification

- Matched paused views isolated the center correction and depth correction
  separately. The gallery retains all three diagnostic states, plus the final
  implementation after a clean reload with temporary hooks removed.
- Visually inspected both arcs in daylight, eclipse entry, totality, eclipse
  exit, and the bright nighttime water reflection. The opposite-side moving
  shadow and night illumination remain present.
- Recorded the actual 120-second day cycle through eclipse entry and exit,
  including normal surface lighting, clouds, and environment refreshes.
- 264 GPU/CPU visibility comparisons across eight sun positions, ground,
  elevated receivers, and both arcs pass. Maximum absolute discrepancy is
  0.000456 with half-float readback. [Raw checks](qa/review/ring-depth-20260910/checks.json).
- All 82 Node tests pass. Coverage includes metre-scale distant depth,
  parented/off-center camera framing, shared capture camera ownership,
  translated eclipse geometry, and independent cloud/solar/local-light response.

The fixes reuse the existing celestial render target and add a small analytic
receiver calculation; no additional shadow capture, terrain search, or texture
is needed. Screenshot frame-rate overlays are not benchmark results. Existing
resource-constrained measurements remain documented in the earlier overhaul
reports; this batch makes no new lower-end hardware throughput claim.

The shadow model remains a finite axis-X cylinder with an approximate finite-sun
penumbra. Individual mountain peaks do not become separate solar occluders, and
ambient atmospheric dimming remains observer-wide. Integration details are in
[the sky guide](docs/SKY_SYSTEM_INTEGRATION.md#ring-eclipses-on-local-surfaces).

Reproduce with one already-running automated Ringworld inspection page:

```sh
node --test tests/*.test.mjs
node qa/ring-depth-eclipse-review.mjs
node qa/ring-eclipse-motion.mjs
```
