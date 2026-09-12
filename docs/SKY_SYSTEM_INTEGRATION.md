# Cloud shadows on scene geometry

Cloud shadows do not need a terrain object, terrain name, height callback, or
Eanpa temple. They attenuate the celestial direct light on PBR materials in the
scene supplied by the host. Sky light, emissive materials, and local lamps keep
their separate lighting response.

```js
const sky = await makeSkySystem({scene, textures, opts});
sky.applyToLights({sun, hemi, fog: scene.fog});
sky.wrapCloudShadows(scene);

// In the host's serialized frame, before any scene or reflection captures:
sky.update(timeSeconds, camera);
sky.applyToLights({sun, hemi, fog: scene.fog});
await sky.prepareCloudShadows(renderer, camera);
renderer.render(scene, camera);

// Register later-loaded buildings, props, or terrain once after adding them:
sky.wrapCloudShadows(loadedObject);
```

Standard and Physical materials retain their native lighting, maps, and alpha
tests. Meshes may share materials. `object.userData.noCloudShadow = true` opts a
receiver out; celestial meshes use this because clouds already occlude their
view rays. Custom lighting shaders can use `sky.tslCloudShadow(positionWorld)`
to multiply their celestial direct light.

The expensive density integration is shared in a camera-centred 6,144-metre
map, refreshed at 10 Hz. Receivers project their actual world position along
the light direction onto its reference plane. That plane is a coordinate
system, not a terrain proxy: a roof 200 metres up samples a different cloud
column from the ground directly below it. Each material then uses one filtered
texture lookup. The outer map border fades smoothly; applications with longer
visible distances should configure an appropriate shadow extent and resolution.
Above the cloud deck, attenuation fades out. Within-cloud receivers use a
height-weighted column approximation.

Dispose the sky when replacing it. This releases its shadow target/material
and restores the material lighting hooks it owns. Call wrapping before shader
warmup, and call preparation in the same serialized frame as other GPU passes.

The standalone ring also has a distant cloud sheet on the curved band. Its
coverage is evaluated into a mipmapped cylindrical atlas at 5 Hz and shared by
the visible sheet and the band's celestial-light attenuation. The ring owner
calls `await ring.prepareFrame(renderer)` before rendering. Local buildings and
props still use the ordinary world-space shadow map above; the band's near
section receives that local field too.

`opts.cloudShadowResolution`, `opts.cloudShadowExtent`, and
`opts.cloudShadowRefreshSeconds` configure the shared map. A capture failure
restores renderer state and retains the last complete map. No scene-wide
material scan or cloud march runs for each receiver on each frame.

Cloud visibility and the map use the same wind, extinction, celestial light
direction, weather transition, and high-cloud field. Cirrus uses a periodic
linear-opacity texture from `assets/weather/cirrus_ice_trails.png`; supply
`textures.cirrus` to override it. A supplied texture remains host-owned.

## Ring eclipses on local surfaces

The standalone ring registers `sky.setSolarOcclusion(position =>
ring.solarVisibilityNode(position))` before material warmup. This applies the
same analytic cylinder shadow to each PBR receiver and the visible band. It
adds no shadow texture, geometry search, or capture pass. The ring's geometry
center, rather than the imported group's pivot, defines the cylinder. A radial
roundoff tolerance retains zero-length surface exits at the local solar tangent;
discarding short rays here incorrectly lights sea-level water. The authored
night lighting remains in place, with its handoff blended over the last 0.05
of solar elevation sine (about 2.9 degrees) before the local observer's sunset.

With this hook installed, `applyToLights` leaves the daytime key at its normal
intensity; the material shadows each surface. `solarVisibility` still controls
the observer's sun disc, and `solarSkyVisibility` controls the surrounding sky
and ambient fill. Moonlight and local lamps retain their separate response.
`object.userData.noSolarShadow` opts out independently of cloud shadows. Use
`setSolarOcclusion(null)` to detach the occluder; adding/removing the hook
invalidates the registered shaders once.

The standalone celestial geometry layer uses its own camera/depth buffer. Its
Ringworld near plane is 20 metres, keeping metre-scale shoreline depth distinct
ten kilometres away. The first-person camera remains at 0.18 metres; framing,
zoom, and the local reflection depth convention are unchanged.

## Performance cloud display

The existing three presets remain. Performance uses a periodically captured
cloud panorama; Balanced and High retain the current-frame volumetric pass.
Only the displayed cloud layer, including its distant atmospheric shafts, is
captured. Sun, moon, star, ring, day/night authority, weather transitions,
lightning, rain particles, surface impacts, puddles and cloud-shadow maps keep
their independent live updates. Cloud-shadow receivers still use their world
positions; no terrain identification or demonstration assets are involved.

`skyQualityPresets().performance.cloudDisplayCapture` supplies a 2048 × 1024
HDR panorama and a filtered distance moment, 32 horizontal bands, a nine-second
refresh interval and continuous nine-second interpolation. The capture uses
64 march steps with four interleaved passes and 14 light samples. Supporting
shadow, reflection, rain and density/light-cache budgets match Balanced;
Performance saves work by amortizing its volume capture, rather than retaining
the former 20-step, two-pass live march. Balanced and High are unchanged.
One band renders per host frame. Significant weather, sun-direction or observer
changes shorten the cadence and remaining interpolation to about three seconds
without jumping the blend weight. The next capture can start as a fade finishes.
A capture freezes its uniforms and light-density cache until every band is
complete. It publishes only then; unfinished bands never appear on screen or
in an environment bake. The first full capture completes during shader warmup.

The display looks up a world ray, so camera rotation remains immediate. Between
captures, integrated wind, density erosion motion, cloud stretch and observer
translation approximately reproject the image using its visible cloud distance.
The extra R16F channel stores a premultiplied distance moment so filtering at
clear edges does not collapse depth toward zero. Thin edges use a conservative
altitude prior. Current light colour and eclipse
visibility affect radiance immediately; lightning adds a transient spatial
flash. Reflection bakes sample the completed cloud images without that flash,
then use the existing native PMREM convolution and stable environment target.
Local screen-space reflections retain their normal per-frame geometry and PBR
response. The Performance environment refresh budget is 16 seconds,
with earlier refreshes for weather/time changes in the standalone host.

This trades fine angular detail, exact multilayer parallax and continuously
evolving cloud shape for less repeated ray marching. Fast travel, close cloud
fly-throughs and abrupt weather cuts suit the live modes better. Cloud shadows
use the true current density field, so their cadence remains 10 Hz; approximate
display reprojection can leave a spatial mismatch. One depth per ray cannot
reconstruct multiple intersecting layers, and fine erosion between captures is
interpolated rather than evaluated live. The three RGBA16F plus R16F captures
consume 60 MiB at the default size. Hosts can lower the capture size
through the option above at the cost of visibly softer clouds.

The standalone sky factories forward these options to `makeSkySystem`.
`makeSpatialCloudPass` owns the display and its targets:

```js
const display = makeSpatialCloudPass(THREE, renderer, camera, {
    div: quality.cloudDiv,
});
display.attach(scene, sky); // before the first sky.bakeEnv()
await display.compileAsync();

// In the host's serialized frame, after updating sky/weather uniforms:
await sky.prepareCloudShadows(renderer, camera);
await display.render();
await hostReflectionPipeline.render();

// Dispose the display before replacing its sky.
display.dispose();
sky.dispose();
```

Custom hosts can instead import `makeCachedCloudDisplay` from
`engine/cached_cloud_display.js`, register it with
`sky.setCachedCloudDisplay(display)`, await `display.ensureReady()`, call
`display.update()` once per frame, and composite
`display.sample(worldDirection, observerPosition)` as premultiplied cloud RGBA.
Keep capture/render work serialized on the renderer. Detach with
`sky.setCachedCloudDisplay(null)` and dispose the display when changing paths.
The provider exposes capture counters through `stats`; the spatial adapter
exposes them through `captureStats`.

This implementation uses Eanpa's existing cloud shader rather than copied
third-party rendering code. The scheduling approach follows the general
separation of cloud display, shadows and time-sliced environment capture
described in [Epic's volumetric-cloud documentation](https://dev.epicgames.com/documentation/unreal-engine/volumetric-cloud-component-in-unreal-engine).
