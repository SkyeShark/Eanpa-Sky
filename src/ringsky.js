// Ringworld skybox: the megastructure arc overhead, land/ocean band with
// day-night terminator, solar-panel inner surfaces — the sky runs in ring
// mode (cloud deck bows up along the band). Faithful port of the vista
// wiring with browser-safe per-material baked reflections (never a global
// scene.environment, which kills the Basic-family domes).
import { makeLazyWeatherAttachment } from './weathersky.js';
import { loadRingRelief } from './ring_relief.js';

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

export async function makeRingworld({
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
    weatherOptions = {},
}) {
    await loadEngine('sky_system.js');
    await loadEngine('ringworld.js');
    // The band now uses displaced geometry; the engine's optional parallax
    // path remains available to other hosts that provide that helper.

    const load = globalThis.loadImageTexture;
    const stars = await load('./assets/starmap_tycho_4k.jpg', { srgb: true });
    const moon = await load('./assets/ringworld/alien_planet_or_moon.png', { srgb: true });

    const sky = await globalThis.makeSkySystem({
        scene,
        textures: { stars, moon },
        opts: {
            hours, clouds: cloudPreset, ringCurve: 5000, moonAngularDeg: 16,
            noonAzimuth: Math.PI/2,
            // planet-shine: the rock-giant companion reflects warm near-white
            // onto the night side (eidoverse sky_worlds parity — the same
            // value the band material receives as planetShineColor below).
            moonLightColor: [1.00, 0.92, 0.82],
            skySamples: quality.skySamples,
            lightSamples: quality.lightSamples,
            cloudPasses: quality.cloudPasses,
            densityCache: quality.densityCache,
            lightCache: quality.lightCache,
            cloudShadowResolution: quality.cloudShadowResolution,
            blueNoise,
            worldRayDir: !!worldRayDir,
            stableCloudPhase: !!worldRayDir,
        },
    });
    globalThis._sky = sky;
    sky.wrapCloudShadows?.(scene);

    let ring = null;
    let weatherAttachment = null;
    let disposed = false;
    const disposeRingworld = () => {
        if (disposed) return;
        disposed = true;
        weatherAttachment?.dispose();
        if (ring?.group) scene.remove(ring.group);
        ring?.disposeLights?.();
        disposeObject(ring?.group);
        sky.dispose?.();
        // These came from GLTFLoader, not the shared loadImageTexture
        // cache. Material.dispose() does not dispose texture storage.
        for (const texture of ring?.info?.sourceTextures ?? []) texture.dispose?.();
        if (globalThis._sky === sky) globalThis._sky = null;
        if (globalThis._ringworld === ring) globalThis._ringworld = null;
    };

    try {

    const [glbBuffer, landmask, solarColor, solarNormal, solarRough, solarMetal, relief] = await Promise.all([
        fetch('./assets/ringworld/RINGWORLDskyelement.glb').then(response => response.arrayBuffer()),
        load('./assets/ringworld/ringworldlandmask.png', {}),
        load('./assets/ringworld/solarpanel/SolarPanel001_1K-JPG_Color.jpg', { srgb: true }),
        load('./assets/ringworld/solarpanel/SolarPanel001_1K-JPG_NormalGL.jpg', {}),
        load('./assets/ringworld/solarpanel/SolarPanel001_1K-JPG_Roughness.jpg', {}),
        load('./assets/ringworld/solarpanel/SolarPanel001_1K-JPG_Metalness.jpg', {}),
        loadRingRelief(THREE),
    ]);
    const glbBytes = new Uint8Array(glbBuffer);
    ring = await globalThis.makeRingworld({
        glbBytes,
        textures: {
            landmask, solarColor, solarNormal, solarRough, solarMetal,
            ...relief,
        },
        // Preserve animated water/glint identically in every sky quality. This
        // path uses two existing-normal reads, not the full procedural ALU field.
        // planetShineColor states the engine default explicitly (prealpha parity).
        opts: { waves: 'lightweight', planetShineColor: [1.00, 0.92, 0.82],
            localReliefBlend:[700,2000],
            cloudAtlas: quality.name==='high'?{width:4096,height:128}:{width:2048,height:64},
            bandNormalScale: 1, bandAOPackedNormal: true },
    });
    globalThis._ringworld = ring;
    // authored placement: band rises from the horizon, crests ~9.8 km overhead
    ring.group.position.set(0, 4940, 0);
    // Celestial meshes use a private depth layer, composited behind local geometry.
    ring.group.traverse((o) => {
        if (!o.isMesh) return;
        o.userData.noCloudShadow = true;
        o.userData.noSolarShadow = true;
        o.userData.noWet = true;
        o.renderOrder = -99;
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of mats) if (m) m.depthWrite = false;
    });
    scene.add(ring.group);
    sky.setSolarOcclusion(point => ring.solarVisibilityNode(point));
    const observer = new THREE.Vector3();
    // The clouds must be in the same depth layer as their land. Leaving them
    // in the main scene drew them before the opaque band reconstruction and
    // erased their contribution, even though their coverage atlas was valid.
    sky.depthLayers = [{objects:[ring.band,ring.walls,ring.clouds].filter(Boolean),renderOrder:-99,near:20}];

    // The band lights itself. The engine owns a real directional "underground
    // sun" plus planetshine that track the sky's TRUE sun vector, so the arc
    // warms at its own sunset and the arch shadow sweeps around the ring as the
    // sun travels beneath it. They attach themselves to the scene root on the
    // first update() and are isolated to the band via the material's own light
    // list, so nothing here needs wiring per frame.
    //
    // This replaces a fixed layer-2 DirectionalLight that used to live here. It
    // was wrong twice over. Its position was constant, so the band's lighting
    // never moved with the day cycle. And the isolation it claimed did not
    // exist: three.js light layers are tested against the CAMERA
    // (`light.layers.test(camera.layers)`), not against the objects a light may
    // touch — so once the camera enabled layer 2, that light lit the WHOLE
    // scene from below. Layer 2 had no other user, so it is gone entirely.

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
        weatherOptions,
    });
    // bindWeather keeps this stable facade. Its getters proxy the real system
    // after lazy activation, so the far Ringworld cloud/rain layers transition
    // on the same state as the local volumetric deck.
    ring.bindWeather(weatherAttachment, sky);

    return {
        sky,
        reflectionBake: {
            ringworld: {
                centerY: ring.group.position.y,
                radius: ring.info.radius,
                halfWidth: ring.info.halfWidth,
                map: ring.info.mapTex,
                mask: ring.info.maskTex,
                repeat: ring.info.repeat,
            },
        },
        supportsWeather: true,
        weatherTransitionSeconds: weatherAttachment.weatherTransitionSeconds,
        setTime(h) { sky.setTime(h); },
        setCloudPreset(name, onTransitionStart) {
            return weatherAttachment.setCloudPreset(name, onTransitionStart);
        },
        setWeather(state, onTransitionStart) {
            return weatherAttachment.setWeather(state, onTransitionStart);
        },
        preloadWeather(){return weatherAttachment.preloadWeather();},
        weatherWarmupObjects(){return weatherAttachment.weatherWarmupObjects();},
        prepareFrame(renderer){return ring.prepareFrame(renderer);},
        update(t) {
            const solar=ring.eclipseK(sky.sunDir,camera.getWorldPosition(observer));
            sky.uniforms.solarVisibility.value=solar;
            sky.uniforms.solarSkyVisibility.value=.16+.84*solar;
            globalThis._ringEclipse={solarVisibility:solar,skyVisibility:sky.uniforms.solarSkyVisibility.value};
            sky.update(t, camera);
            weatherAttachment.update(t);
            ring.update(t);
            sky.applyToLights({ sun, hemi, fog: scene.fog });
            weatherAttachment.applyLightDim();
        },
        dispose: disposeRingworld,
    };
    } catch (error) {
        // The sky is already live before the GLB and its textures finish
        // loading. Roll back that partial preset if any later stage rejects.
        disposeRingworld();
        throw error;
    }
}
