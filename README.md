<img src="assets/brand/eanpa_wordmark.png" alt="Eanpa Engine" width="520">

# Eanpa Sky Engine — v0.1

**[▶ Live demo](https://skyeshark.github.io/Eanpa-Sky/)** (WebGPU required — Chrome or Edge)

A real-time volumetric **sky and weather engine** for Three.js WebGPU (TSL),
demonstrated inside a full interactive first-person desert world. The world
exists to prove the point: authored volumetric skies, live weather fronts,
lightning with surface impact, day/night, and three different skyboxes —
running at high frame rates with a complete playable scene underneath.

## Running

Serve the folder with any static file server and open it in a
WebGPU-capable browser (Chrome/Edge), e.g.:

```
npx serve .
```

## What to try

- **Skybox**: Earth / Orbital Halo (with parallax-mapped megastructure band,
  eclipse and underground-sun lighting) / Red Giant far-future Earth
- **Weather**: eight states from clear to Dark Storm — sealed volumetric
  storm canopy, forced lightning strikes (⚡ button), burn scorch decals
- **Time of day** slider and day/night cycle; the moon is NASA LROC imagery
- **Walk** the desert: eroded mountain terrain, Mojave flora with wind and
  touch response, a climbable ziggurat temple

Controls are on-screen. Quality tiers in the panel; Balanced targets 60+ FPS.

## State of the project

This is an early, honest 0.1 — see [KNOWN_ISSUES.md](KNOWN_ISSUES.md).

## Credits & licenses

- Code: MIT (see LICENSE)
- Three.js (vendored, r184): MIT
- Audio: see `assets/audio/README.md` — mostly CC0; four desert-bird
  recordings are CC BY-NC-SA (xeno-canto) and are **not** CC0
- PBR surfaces: Poly Haven / ambientCG (CC0); moon: NASA CGI Moon Kit;
  starmap: Tycho
- Wind/grass techniques derived in part from CK42BB's
  procedural-grass-threejs (MIT)
