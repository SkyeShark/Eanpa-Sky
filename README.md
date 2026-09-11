<img src="assets/brand/eanpa_wordmark.png" alt="Eanpa Engine" width="520">

# Eanpa Sky Engine — v0.2.1

**[▶ Live demo](https://skyeshark.github.io/Eanpa-Sky/)** (WebGPU required — Chrome or Edge)

A real-time volumetric **sky and weather engine** for Three.js WebGPU (TSL),
demonstrated inside a full interactive first-person desert world. The world
exists to prove the point: authored volumetric skies, live weather fronts,
lightning with surface impact, day/night, and three different skyboxes —
running at high frame rates with a complete playable scene underneath.

## Running

Serve the folder with any static file server and open it in a
WebGPU-capable browser (Chrome/Edge), e.g.:

```sh
python qa/dev-server.py 8378
```

Open http://127.0.0.1:8378/. The included server binds to loopback and supplies
JavaScript/WASM content types explicitly. If the review server is already
running, reuse it. The first load warms the WebGPU pipelines before revealing
the world.

The v0.2 release includes the sky, reflection, weather and surface-water overhaul.
The 0.2.1 patch reduces shader preparation delays and shows each startup stage.
See [the release notes](CHANGELOG.md) for its changes and remaining limits.
Implementation details and retained measurements are in
[OVERHAUL_REVIEW.md](OVERHAUL_REVIEW.md). The selected capture gallery is at
[qa/review/index.html](qa/review/index.html), with the latest red giant and rain
corrections in [the September 10 report](REVIEW_2026-09-10.md).

## What to try

- **Skybox**: Earth / Orbital Halo (with displaced, eroded terrain, eclipse and
  band lighting) / Shieldworld with its red giant and shattered moon
- **Weather**: eight states from clear to Dark Storm — sealed volumetric
  storm canopy, forced lightning strikes (⚡ button), burn scorch decals
- **Time of day** slider and day/night cycle; the moon is NASA LROC imagery
- **Walk** the desert: eroded mountain terrain, Mojave flora with wind and
  touch response, a climbable ziggurat temple

Controls are on-screen. Quality tiers in the panel; Balanced targets 60+ FPS.

Cloud shadows work on scene PBR geometry without a terrain callback; see
[the integration guide](docs/SKY_SYSTEM_INTEGRATION.md). Rain shelter, impacts,
wetness and puddles use nearby surface geometry; see [engine/RAIN.md](engine/RAIN.md).

## State of the project

This is an early 0.2 release — see [KNOWN_ISSUES.md](KNOWN_ISSUES.md).

## Publishing the demo

Pushes to `main` run the Node tests and deploy through GitHub Actions to Pages.
`node qa/build-pages.mjs` creates the static site in `.artifacts/pages/site` and
checks its version, module dependencies and size. The package retains the complete
demo, compressed terrain arrays, PNG fallbacks and review galleries. Editor
files, unused 2K source PNGs and the superseded non-LOD terrain exports remain in
GitHub but are excluded from the hosted package to fit Pages' 1 GB site limit.
Full CPU investigation archives also remain in GitHub, linked from the release
notes; the hosted package retains the existing visual review galleries.
The output directory must be new; use a different output path for a second build.
`release-manifest.json` identifies the deployed commit and packaged files.

## Credits & licenses

- Code: MIT (see LICENSE)
- Three.js (vendored, r184): MIT
- Audio: see `assets/audio/README.md` — mostly CC0; four desert-bird
  recordings are CC BY-NC-SA (xeno-canto) and are **not** CC0
- PBR surfaces: Poly Haven / ambientCG (CC0); moon: NASA CGI Moon Kit;
  starmap: Tycho
- Wind/grass techniques derived in part from CK42BB's
  procedural-grass-threejs (MIT)
