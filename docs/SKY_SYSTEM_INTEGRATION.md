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
