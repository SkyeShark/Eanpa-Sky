// Red Giant Shieldworld skybox: procedural red giant riding the sun, hex
// radiation shield, shattered moon with granular debris river. Faithful
// port of the vista's frame block (moon arc, extinction, night lighting),
// minus the offline camera/weather machinery.
import { makeLazyWeatherAttachment } from './weathersky.js';

function disposeObject(root) {
    const geometries = new Set(), materials = new Set();
    root?.traverse?.((o) => {
        if (o.geometry) geometries.add(o.geometry);
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of mats) if (m) materials.add(m);
    });
    for (const g of geometries) g.dispose?.();
    for (const m of materials) m.dispose?.();
}

export async function makeShieldworld({
    THREE,
    scene,
    camera,
    sun,
    hemi,
    loadEngine,
    quality,
    hours,
    blueNoise,
    worldRayDir,
    cloudPreset = 'cumulus',
    weatherState = 'none',
}) {
    await loadEngine('sky_system.js');
    await loadEngine('redgiant.js');
    await loadEngine('asteroid_moon.js');

    const rg = await globalThis.makeRedGiant({ opts: { shield: true } });

    let moonSys = null;
    let moon = null;
    let sky = null;
    let rgSys = null;
    let nightAmbient = null;
    let moonAmbient = null;
    let weatherAttachment = null;
    let disposed = false;
    const disposeShieldworld = () => {
        if (disposed) return;
        disposed = true;
        weatherAttachment?.dispose();
        if (moon) scene.remove(moon);
        if (nightAmbient) scene.remove(nightAmbient);
        if (moonAmbient) scene.remove(moonAmbient);
        if (rgSys?.shield) scene.remove(rgSys.shield);
        disposeObject(moon);
        moonSys?.disposeTextures?.();
        disposeObject(rgSys?.shield);
        sky?.dispose?.();
        if (globalThis._sky === sky) globalThis._sky = null;
        if (globalThis._asteroidMoon === moon) globalThis._asteroidMoon = null;
        if (globalThis._moonSys === moonSys) globalThis._moonSys = null;
        globalThis._shieldworldMoonStats = null;
    };

    try {

    // shattered moon cluster (GLB carries the packed material)
    const glbBytes = new Uint8Array(await (await fetch('./assets/asteroid_cluster_v3.glb')).arrayBuffer());
    moonSys = await globalThis.makeShatteredMoon({ glbBytes, spread: 1.75 });
    moon = moonSys.group;
    moon.scale.setScalar(1400);
    // The shattered moon is a night-sky body. Fade the opaque fragments and
    // debris river with one GPU uniform so day/night cycling never hard-pops.
    // The volumetric dust is premultiplied, so both of its roots must fade;
    // ordinary fragments use alpha blending and only need opacity.
    const moonFade = THREE.uniform(0);
    const moonMaterials = new Set();
    moon.traverse((o) => {
        if (!o.isMesh || !o.material) return;
        // Transparent fading moves fragments out of the opaque queue. Keep
        // every part of this distant body behind the shield (-99) and clouds
        // (-98), including the fragments imported with default renderOrder 0.
        o.renderOrder = -99.5;
        o.userData.noWet = true;
        o.userData.noCloudShadow = true;
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        for (const material of mats) {
            if (!material || moonMaterials.has(material)) continue;
            moonMaterials.add(material);
            if (o === moonSys.dust) {
                material.colorNode = material.colorNode.mul(moonFade);
                material.opacityNode = material.opacityNode.mul(moonFade);
            } else {
                const baseOpacity = material.opacityNode ?? THREE.float(material.opacity ?? 1);
                material.opacityNode = baseOpacity.mul(moonFade);
                material.transparent = true;
                material.depthWrite = false;
            }
            material.needsUpdate = true;
        }
    });
    moon.userData.nightFade = moonFade;
    moon.visible = false;
    scene.add(moon);
    globalThis._asteroidMoon = moon;
    globalThis._moonSys = moonSys;

    const stars = await globalThis.loadImageTexture('./assets/starmap_tycho_4k.jpg', { srgb: true });
    sky = await globalThis.makeSkySystem({
        scene,
        textures: { stars },
        opts: {
            hours, clouds: cloudPreset,
            celestial: rg.celestial,
            paletteTint: rg.paletteTint,
            moonLightColor: [1.0, 0.62, 0.35],
            skySamples: quality.skySamples,
            lightSamples: quality.lightSamples,
            cloudPasses: quality.cloudPasses,
            densityCache: quality.densityCache,
            lightCache: quality.lightCache,
            blueNoise,
            worldRayDir: !!worldRayDir,
            stableCloudPhase: !!worldRayDir,
        },
    });
    globalThis._sky = sky;
    rgSys = rg.attach({ scene, sky });
    rgSys?.shield?.traverse?.((o) => {
        if (!o.isMesh) return;
        o.userData.noWet = true;
        o.userData.noCloudShadow = true;
    });
    sky.wrapCloudShadows?.(scene, 0.42);

    // faint diffuse night fills: cyan shield light pollution + orange
    // moonlight when the cluster is up (pure diffuse — no fake speculars)
    nightAmbient = new THREE.AmbientLight(0x4abaff, 0); scene.add(nightAmbient);
    // This moon reflects the red giant, not an Earth-like cool key. Its
    // bounced scene light stays amber-brown even after the giant sets.
    moonAmbient = new THREE.AmbientLight(0xd06a3c, 0); scene.add(moonAmbient);
    const hemiCyan = new THREE.Color(0.29, 0.73, 1.0);
    let curHours = hours;

    weatherAttachment = await makeLazyWeatherAttachment({
        scene,
        camera,
        sky,
        sun,
        hemi,
        loadEngine,
        quality,
        baseCloudPreset: cloudPreset,
        initialWeatherState: weatherState,
    });

    return {
        sky,
        supportsWeather: true,
        weatherTransitionSeconds: weatherAttachment.weatherTransitionSeconds,
        setTime(h) { curHours = h; sky.setTime(h); },
        setCloudPreset(name, onTransitionStart) {
            return weatherAttachment.setCloudPreset(name, onTransitionStart);
        },
        setWeather(state, onTransitionStart) {
            return weatherAttachment.setWeather(state, onTransitionStart);
        },
        update(t) {
            // moon rides its celestial arc OUTSIDE the 21k shield at every
            // point; rises 22.3h, transits in 6.2h
            const th = (((curHours - 22.3) + 24) % 24) / 6.2 * Math.PI;
            moon.position.set(Math.cos(th) * 34000, Math.sin(th) * 22000 + 2000, -12000);
            moon.rotation.set(t * 0.01, t * 0.017, 0);
            sky.setMoonDirection(moon.position);

            sky.update(t, camera);
            weatherAttachment.update(t);
            rg.update(t);

            // per-frame engine light model + shieldworld night specifics
            sky.applyToLights({ sun, hemi, fog: scene.fog });
            const nightK = Math.max(0, Math.min(1, (0.06 - sky.sunDir.y) / 0.24));
            hemi.color.lerp(hemiCyan, nightK * 0.8);
            hemi.intensity = Math.max(hemi.intensity, 0.20 * nightK);
            nightAmbient.intensity = 0.16 * nightK;
            const moonUpK = Math.max(0, Math.min(1, moon.position.y / 16000)) * nightK;
            moonAmbient.intensity = 0.22 * moonUpK;
            // Lattice glow washes the milky way and lifts the sky floor.  Base
            // this on the current time-of-day palette every frame: multiplying
            // the live uniform here compounded the dimming to zero and could
            // not recover until setTime() happened to run again.
            if (sky.uniforms.starFade) {
                sky.uniforms.starFade.value = (sky.state.palette?.star ?? 0) * (1 - 0.85 * nightK);
            }
            if (sky.uniforms.skyGlow) sky.uniforms.skyGlow.value.setRGB(0.29, 0.73, 1.0).multiplyScalar(0.014 * nightK);

            // Moon lighting: star direction/spectrum and atmospheric extinction
            // pins visibility above the lattice's horizon-fade band
            const mu = moonSys.uniforms;
            mu.sunDir.value.copy(sky.sunDir).normalize();
            // The moon receives the star's spectrum even while the observer
            // is on the planet's night side. The local twilight palette is
            // atmospheric attenuation at the observer, not at the moon.
            mu.sunCol.value.setRGB(1.0, 0.62, 0.35);
            globalThis._shieldworldMoonStats = {
                kind: 'rocky-shattered-moon',
                visibility: 'night-only-elevation-gated',
                reflectedKey: 'red-giant-warm-amber-brown',
                sceneMoonlight: '#d06a3c',
                keyColor: mu.sunCol.value.toArray(),
            };
            const mp = moon.position;
            const elev = mp.y / Math.max(mp.length(), 1);
            const ext = Math.max(0, Math.min(1, (elev - 0.36) / 0.14));
            const extEase = ext * ext * (3 - 2 * ext);
            const nightEase = nightK * nightK * (3 - 2 * nightK);
            const visibility = nightEase * extEase;
            moonFade.value = visibility;
            moon.visible = visibility > 0.001;
            mu.gain.value = 2.0 * extEase;
            // Absolute-time animation resumes in place when visible. Avoid
            // rebuilding/uploading 7,000 debris matrices on daytime frames.
            if (moon.visible && moonSys.update) moonSys.update(t);
            // Apply the live weather attenuation after the wrapper restores
            // red-giant/shield-specific lighting, so neither update silently
            // overwrites the other.
            weatherAttachment.applyLightDim();
        },
        dispose: disposeShieldworld,
    };
    } catch (error) {
        // The moon is attached before the starmap, sky, and shield finish.
        // Retire every completed stage if a later asset or constructor fails.
        disposeShieldworld();
        throw error;
    }
}
