# Performance cloud correction

Only Performance changes. Balanced and High / Insane retain their previous
preset values and live cloud rendering. Runtime checkpoints: `e34257e` (dense
capture and continuous motion), `8c6070f` (capture latency after frame-rate
changes). Comparison: the rejected first capture implementation, `0d20366`.

Open the [visual review](index.html) or [Performance in the engine](../../../?quality=performance).

## What caused the problem

The first capture implementation still used the old Performance budget: 20
march steps, two passes and six light samples. It baked the resulting sparse
volume rather than using the capture to afford a detailed volume.

It also held each panorama and then blended to the next in half a second.
The source volume's erosion keeps moving during those three-second intervals.
The old reprojection accounted for wind alone, missing the extra erosion
motion and cloud stretch. Several seconds of changed shape were therefore
compressed into each short fade. Sparse sampling amplified the differences.

## Correction

- Performance captures 64 march steps with four interleaved passes and 14
  light samples. Its cloud-shadow, sky-reflection, rain, surface-capture and
  density/light-cache budgets match Balanced. Balanced and High are unchanged.
- Captures refresh about every nine seconds, using 32 bands. Interpolation
  spans the interval continuously. Weather, sun direction and camera changes
  can shorten the cadence and interpolation to about three seconds without
  jumping the blend weight.
- Reprojection follows wind, the main erosion field, captured cloud stretch
  and visible cloud distance. Cirrus and storm volumes use their own motion.
  The distance moment is stored premultiplied by opacity; filtering straight
  depth against empty texels caused edge outlines during development.
- Only complete captures publish. Capture lead time measures drawing, excluding
  time waiting for the previous fade, so latency recovers when frame rate rises.
- Cloud shadows, rain, impacts, puddles, lightning, celestial motion and native
  local PBR reflections continue updating independently. Environment bakes
  sample completed cloud images and retain native PMREM filtering.

The three 2048 × 1024 RGBA16F colour captures plus R16F distance moments use
60 MiB. This is still a sampled panorama: angular resolution, fine erosion and
exact parallax through overlapping volumes are reduced. Cloud shadows use the
current density field, so display/shadow alignment remains approximate.

## Motion evidence

The review includes two 18-second recordings at normal simulation speed and
30-second opacity traces with a stationary camera. Large frame changes in the
rejected mode recur around its half-second fades. The corrected trace has
continuous change through publication boundaries: its 95th-percentile change
is about 1.13 times its median, versus about 10.6 times in the rejected run.

These measurements compare periodicity within each run; the cloud layouts and
simulation phases are not identical. Diagnostic GPU readback is not included
in the FPS measurements. Full traces: [before](temporal-before.json.gz),
[after](temporal-after.json.gz).

## Resource measurements

RTX 5090 Laptop GPU, Three r186, 1578 × 846. Each throughput run uses Earth rain,
a moving camera, six generic host meshes and a scheduled sky/environment
refresh over 20 seconds. There are no demonstration asset optimizations.

| Performance version | Native FPS | Constrained FPS | Constrained p95 | GPU work/frame |
| --- | ---: | ---: | ---: | ---: |
| Rejected sparse capture | 173.7 | 77.9 | 16.7 ms | 0.966 ms |
| Corrected dense capture | 173.5 / 173.9 repeat | 86.4 | 16.9 ms | 1.011 ms |

Constrained means 4× CDP CPU throttling plus a synthetic GPU workload targeted
at 8 ms, with the actual workload timing recorded. This stresses available
resources; it does not emulate a named lower-end GPU. Most throughput windows
contained background CPU activity. These numbers do not establish a precise
speedup or a performance guarantee for another machine.

An earlier baseline after other QA measured 237 FPS. Repeating it from the same
fresh-page setup as the corrected run gave 173.7 FPS. All results are retained;
the initial sample is not used to claim a regression or speedup.

Separate 20-second GPU timestamp windows cover seven rejected-mode captures
and three corrected-mode captures. Cloud capture work averaged 0.0076 and
0.0066 ms/frame respectively. Total submitted GPU work rose about 0.045 ms;
the restored supporting effects and the new panorama lookup are included.
Timestamps exclude queue idle time and are separate from throughput tests.

Timing samples were taken on `e34257e`, before the capture-lead accounting
follow-up. Sample counts, shaders and refresh intervals are the same. See
[measurements](measurements.json) for revisions, qualifications and raw data.

## Validation

- 92 Node tests passed.
- 14 GPU publication, scissoring, crossfade, retry and disposal checks passed.
- Six analytical cloud-motion checks passed, including transparent edges,
  observer translation, erosion/wind/stretch alignment and recovery after
  a host frame-rate change.
- Eight checks confirmed live lighting, eclipse, lightning, wind, translation
  and reflection sampling between captures.
- All 13 cloud/weather transition cases passed on each of the three skies.
- A real 45-second rain-to-dark-storm transition completed without runtime
  pipeline compilation or GPU errors; maximum observed frame interval 14.2 ms.
- Sunset shadow publication passed on ground and 25 m roofs. Rain/shelter
  surface cases and native reflection motion checks passed.
- Static views cover Earth cumulus/cirrus/rain/storm, Ringworld clouds/cirrus/
  eclipse and Shieldworld clouds/star. The full-demo startup result is linked
  in [validation](validation.json).

The older capture experiment remains in Git and the local checkout at
`qa/review/cached-performance/`. Its large review archive is omitted from the hosted
package in favour of this correction; runtime assets remain included.
