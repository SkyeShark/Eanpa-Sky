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
at a bounded rate. It is a surface approximation, not a fluid solver: moisture
timing is shared, exposure is local, and it does not simulate runoff, trapped
volumes or water carried by moving objects. A host that aggressively removes
off-screen geometry must retain nearby roof/occluder geometry for this pass.
Puddles blend the native PBR surface parameters toward water; this is not a
separate refractive water volume or a complete optical model of two material
layers. The surface field resolves the first obstruction along the rain ray.

The GPU fixture in `qa/rain-surface-contract.js` checks open/sheltered surfaces,
slopes, instances, skinned/deformed roofs, cutout openings, wind and state rollback.
`qa/final-pass.mjs` uses the existing owned browser for visual and performance
review; it never launches another browser.

Reference: [Sébastien Lagarde's observations of rainy surfaces](https://seblagarde.wordpress.com/2012/12/10/observe-rainy-world/)
inform the wetting, drying, water-reflectance and ripple behavior.
