# Rain and surface water integration

The weather layer supports the standalone Earth, Ringworld and Shieldworld
skies, and ordinary WebGPU scenes using Three Standard/Physical materials.
It requires no terrain height callback for rain collision or splash placement.

Load `weather_system.js` as an ES module after the shared sky engine. Install
material wrappers before the first shader warmup, then call the GPU preparation
step from the host's serialized render loop:

```js
const weather = await makeWeatherSystem({ scene, sky, opts: {
    rainCount: 10000,
    splashCount: 700,
    surfaceResolution: 768,
    surfaceRefreshHz: 8,
    moistureRadius: 1024,
    moistureResolution: 256,
} });
weather.wrapScene({ budget: Infinity });
weather.transitionTo('rain', 1, 45);

// Each frame, after animation/geometry updates and before world rendering:
weather.update(elapsedSeconds, camera);
await weather.prepareFrame(renderer, camera);
await renderer.renderAsync(scene, camera);

// Detach before replacing the weather owner:
weather.dispose();
```

The three sky factories in `src/weathersky.js`, `src/ringsky.js` and
`src/shieldworld.js` also accept `weatherOptions`. A host can supply its own
lightning collision roots and impact callback:

```js
const active = await makeRingworld({
    // ...scene, camera, lights, loader, quality and sky options...
    weatherOptions: {
        strikeTargets: () => [worldGeometry],
        strikeHeightAt: null, // use the actual meshes for strike collision
        onLocalStrike: impact => damageSystem.lightning(impact),
    },
});
```

`impact.point` and `impact.normal` are world-space arrays. Supplying an optional
`strikeHeightAt(x, z)` is useful for a host's GPU-only heightfield fallback;
return a finite height only where that surface exists. Rain exposure, puddles,
splashes and cloud-shadow receivers do not require this lightning callback.

`prepareFrame` captures the first surface seen along the incoming rain direction.
One depth/normal target serves rain visibility, slope-aligned impacts and material
exposure. Ordinary meshes, instances, skinning, vertex deformation, displacement
and alpha-cutout silhouettes use the same capture. Renderer state and original
materials are restored even if the capture fails. The standalone warms the target
once during boot and skips further capture work while fully dry.

Receiver controls apply to each draw, including meshes sharing one material:

| Control | Meaning |
| --- | --- |
| `object.userData.noWet = true` | Keep this object's authored material response. |
| `object.userData.noPuddles = true` | Permit wet sheen but exclude accumulated puddles, useful for foliage. |
| `object.userData.wetnessFactor = 0.5` | Scale wetting for this receiver, from 0 to 1. |
| `material.userData.noWet / noPuddles` | Apply either exclusion to all users of the material. |
| `material.userData.wetPorosity` | Darkening strength for porous dielectrics, from 0 to 1; default 0.65. |
| `material.userData.puddleMaskNode` | Optional TSL cavity mask; 1 fills first. Set before wrapping. |
| `object.userData.noRainOcclusion = true` | Exclude this object and its children from rain obstruction. |
| `material.userData.rainOccluder = true` | Treat a transparent material, such as a glass roof, as an obstruction. |
| `material.userData.rainCapturePositionNode` | Optional capture-specific vertex deformation. |

Scene sky shells, first-person view models and support-check-excluded effects do
not obstruct rain. `noWet` alone does **not** exclude an opaque roof from the
capture. When adding receivers later, use `wrapMaterial(material, mesh)` or the
budgeted `wrapScene()` queue; call `weather.surfaceField.invalidate()` when a
geometry change must appear before the regular capture interval. Disposal of a
source material also releases its capture material.

Water reduces roughness and flattens the surface normal, with small expanding
normal ripples while rain falls. Its base reflectance uses water's IOR of 1.333
(F0 approximately 0.0204), and the regular lighting/reflection pipeline supplies
the reflected scene. Porous ground darkens moderately; metallic surfaces retain
their conductor response. Thin wetness builds faster than puddles, and puddles
outlast the rain instead of disappearing with the weather selector.

Moisture accumulates from the local rain cell, rather than starting everywhere
as soon as a rainy weather transition begins. A world-aligned GPU history stores
thin wetness and pooled water separately. Drops and listener audio retain their
local cloud gating; an initially dry surface starts wetting when rain reaches
its area, then develops puddles. Water stays behind after that cloud passes.
Rain-free overcast humidity can still damp surfaces without creating puddles.

The history uses two 256-square RGBA16F textures (1 MiB total), or 128-square
textures (0.25 MiB) on Performance. It refreshes four times per simulation second;
receivers advance the cached moisture analytically every displayed frame, so
that cadence does not step the wetness animation. Its snapped world grid stays
fixed during ordinary walking, and recentering retains overlapping history.
No per-object update or CPU readback is needed for accumulation. The 1024 m
half-width is configurable with `moistureRadius`; `moistureResolution` controls
its spatial sampling. `weather.accumulation.reset()` explicitly clears history
when resetting a scene; normal weather changes preserve it.

Falling drops use independent PCG random channels and a denser near-camera
population. Cloud coverage at the upwind emission position gates precipitation;
the same captured surface stops the falling streak and places its impact.
Brief contact flashes and six independently seeded ballistic droplets use that
surface's position and normal, including roofs. Each event changes location;
droplet directions, launch speeds and lifetimes vary instead of making dotted
circles. Projected velocity shapes each droplet's short streak, and subpixel
coverage compensation prevents oversized distant dots. The surface field also produces a throttled, asynchronous
listener-exposure sample for rain gain and shelter filtering in the standalone.

The capture covers a camera-local region (72 m half-width by default), refreshed
at a bounded rate. Its world grid remains fixed within a guard area while the
camera walks; moving occluders still refresh at the configured cadence.
It is a surface approximation, not a fluid solver. Rainfall history is tracked
in horizontal columns at reference height zero, while obstruction, incidence
and material masks remain surface-specific. The column approximation can differ
from the exact rain cell on very tall structures under strong wind. Newly entered
regions outside the retained history start dry; moisture fades at its outer edge.
It does not simulate runoff, trapped volumes, persistent per-object water, or
water carried by moving objects. A host that aggressively removes
off-screen geometry must retain nearby roof/occluder geometry for this pass.
Puddles blend the native PBR surface parameters toward water; this is not a
separate refractive water volume or a complete optical model of two material
layers. The surface field resolves the first obstruction along the rain ray.

The GPU fixture in `qa/rain-surface-contract.js` checks open/sheltered surfaces,
slopes, instances, skinned/deformed roofs, cutout openings, wind and state rollback.
`qa/rain-accumulation-contract.js` checks dry/raining columns, filling and drying,
continuous response between history updates, recentering and simulation rewind.
`node qa/rain-timing.mjs <label>` records a real-time 45-second None-to-Rain
transition in the running sky fixture, with GPU moisture probes and screenshots.
`qa/final-pass.mjs` uses the existing owned browser for visual and performance
review; it never launches another browser.

Reference: [Sébastien Lagarde's observations of rainy surfaces](https://seblagarde.wordpress.com/2012/12/10/observe-rainy-world/)
inform the wetting, drying, water-reflectance and ripple behavior.
