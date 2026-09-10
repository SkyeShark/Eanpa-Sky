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
