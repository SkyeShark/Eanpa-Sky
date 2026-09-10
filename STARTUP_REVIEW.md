# Startup patch — 0.2.1

The hosted 0.2.0 demo spent most of its startup preparing GPU pipelines. On the
local RTX 5090 Laptop GPU (driver 610.88), the initial instrumented Earth visit
took 132.2 seconds; assets finished arriving around 14 seconds. A repeated hosted
visit with the browser shader cache cleared took 77.8 seconds, including 58.4
seconds in the final warmup. These are observed runs, not universal load times.

The patch makes four changes in the renderer and shared sky:

- Build TSL graphs sequentially, but prepare up to four GPU pipelines together.
  Drain pending work on failure; keep validation scopes attached to their jobs.
  Cached draws yield on an 8 ms CPU budget, and the local probe compiles its
  shared material variant once before rendering all six cube faces.
- Precompile the same context, attachments, layers and material override used
  by each render pass. Visit visible materials independently of the previous
  probe camera's frustum.
- Express the existing 20 × 6 light-shaft/rain samples as GPU loops. The main
  cloud fragment shrank from 523,164 to 169,309 characters. Sample counts and
  the atmospheric model are unchanged.
- Share pure analytic noise through explicit shader functions and show actual
  startup phases while compilation runs.

No sample-scene meshes were batched, removed or simplified for this patch.
Earth remains the default, with all three skyboxes and every weather/quality
option available.

Validation uses one isolated headless browser with a 1258 × 646 CSS viewport
at device pixel ratio 1 (1280 × 800 outer window). The retained
[measurements](qa/review/startup-0.2.1/measurements.json) distinguish local files
from the hosted demo, CPU throttling from GPU emulation, and browser cache
clearing from uncontrolled driver caches. Repeat visits vary considerably;
compare the recorded conditions rather than inferring a speedup from the first
run alone. Post-deployment measurements accompany the
[0.2.1 release](https://github.com/SkyeShark/Eanpa-Sky/releases/tag/v0.2.1).

The 77 Node regression checks cover scheduling bounds, failed-job cleanup,
validation-scope ownership and exact pass/attachment reuse. A GPU comparison of
32,768 positions matched both the old noise and FBM outputs exactly. Earth and
Ringworld completed normal 45-second transitions from None to Rain without a
new pipeline compilation; their worst recorded frame intervals were 20.8 and
20.9 ms. Shieldworld also completed its rain transitions without shader builds.
A run after CPU-throttled startup averaged 23.3 ms; a fresh normal-CPU load
averaged 10.4 ms, versus 8.7 ms in a hosted 0.2.0 observation. A subsequent
controlled benchmark rejected the comparison: unrelated background shader
compilation was consuming about 68% of system CPU, with external GPU activity
also above the 5% gate. These observations do not establish a runtime speedup
or regression. The final rain capture's GPU pass sum averaged 3.72 ms over
120 frames, separately from CPU scheduling and queue idle time.

The fresh local Shieldworld startup completed in 42.2 seconds; the hosted
0.2.0 observation took 279.0 seconds. Different asset sources and uncontrolled
background/driver state prevent attributing that entire difference to this
patch. Selected screenshots retain the clouds, chrome, lighting and rain
response for visual comparison.

Startup is still substantial. A fresh default visit transfers about 345 MB,
and a new sky/quality selection still needs its own shader preparation. This
patch does not stream assets or predict performance on a named lower-end GPU.
CPU-throttled checks retain the physical 5090 and its memory. At 4× CPU
throttling, local Shieldworld startup fell from 328.1 to 183.8 seconds after
the final scheduling changes (312.0 to 157.8 seconds of warmup). Both runs
already include the compact cloud shader changes; this is not a comparison
against unmodified 0.2.0. It remains a long wait on slower CPUs.

To reproduce, attach the single inspection browser on port 9223 to the existing
local server and run:

```sh
node qa/startup-profile.mjs 'http://127.0.0.1:8378/?automated=1&benchmark=1' local cold
node qa/startup-profile.mjs 'https://skyeshark.github.io/Eanpa-Sky/?automated=1' hosted cold
node qa/startup-profile.mjs 'http://127.0.0.1:8378/?automated=1&benchmark=1' cpu4 cold 4
node qa/weather-transition.mjs startup
```

The profiler creates no browser or server, checks visible shader errors before
accepting a timing, pauses its page afterward and restores CPU throttling.
Its raw network, pipeline and optional CPU profiles go under `.artifacts/startup/`.

Relevant primary references are Three's [renderer compilation
contract](https://threejs.org/docs/pages/Renderer.html), the
[WebGPU pipeline API](https://gpuweb.github.io/gpuweb/#dom-gpudevice-createrenderpipelineasync),
and Chromium's [storage/cache
controls](https://chromedevtools.github.io/devtools-protocol/tot/Storage/#method-clearDataForOrigin).
The pinned renderer changes are recorded in
[EANPA_PATCHES.md](vendor/three/EANPA_PATCHES.md).
