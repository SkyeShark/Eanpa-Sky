// Shared lazy weather attachment plus the standard Earth-style weather sky.
// The attachment keeps one stable facade while rain assets load, so consumers
// such as Ringworld's far cloud layer never retain a stale null-weather object.

function stripMrt(scene) {
    let n = 0;
    scene.traverse((o) => {
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of mats) {
            if (m && m.isNodeMaterial && m.mrtNode
                && m.userData?.preserveSceneMrtOverride !== true) {
                m.mrtNode = null;
                m.needsUpdate = true;
                n++;
            }
        }
    });
    if (n) console.log('[eanpa] stripped mrt stamps from', n, 'materials');
}

const CLOUD_PRESETS = new Set(['clear', 'cumulus', 'stratus', 'cirrus']);
const resolveCloudPreset = (name) => CLOUD_PRESETS.has(name) ? name : 'cumulus';

/**
 * Attach the full weather system lazily to any makeSkySystem instance.
 *
 * Cloud Type and Weather are independent state axes: changing Cloud Type while
 * weather is active updates the persisted base/None target but does not cancel
 * rain or replace the active weather front. With Weather=None, the same call
 * starts the sky engine's continuous cloud-only morph.
 */
export async function makeLazyWeatherAttachment({
    scene,
    camera,
    sky,
    sun,
    hemi,
    loadEngine,
    quality,
    baseCloudPreset = 'cumulus',
    initialWeatherState = 'none',
    weatherOptions = {},
}) {
    let selectedCloudPreset = resolveCloudPreset(baseCloudPreset);
    let requestedWeatherState = initialWeatherState || 'none';
    const transitionSeconds = Math.max(10, quality.weather?.transitionSeconds ?? 45);
    const nullWeather = {
        state: {
            name: 'none',
            k: 1,
            def: { grey: 0, dark: 1, rain: 0, wet: 0, lightning: 0 },
        },
        uniforms: { rainK: { value: 0 } },
        bolt: { intensity: 0 },
        diagnostics: {
            transition: {
                active: false,
                from: 'none',
                target: 'none',
                durationSeconds: 0,
                elapsedSeconds: 0,
                rawProgress: 1,
                easedProgress: 1,
            },
            precipitation: { rainVisible: false, intensity: 0 },
            wetness: { wetness: 0, wrappedMaterials: 0, receiverMeshes: 0 },
        },
        update() {},
        sunDim() { return 1; },
        hemiDim() { return 1; },
        transitionTo: null,
        dispose: null,
    };

    let weather = nullWeather;
    let weatherPromise = null;
    let weatherRequestId = 0;
    let disposed = false;
    let controller = null;
    const mrtStripTimers = new Set();

    const stripWeatherMrt = () => {
        if (disposed) return;
        (globalThis.eanpaStripMrt ?? stripMrt)(scene);
        for (const timer of mrtStripTimers) clearTimeout(timer);
        mrtStripTimers.clear();
        const timer = setTimeout(() => {
            mrtStripTimers.delete(timer);
            if (!disposed) (globalThis.eanpaStripMrt ?? stripMrt)(scene);
        }, 100);
        mrtStripTimers.add(timer);
    };

    const updateNoneTarget = (targetWeather) => {
        targetWeather.WEATHER.none = {
            ...targetWeather.WEATHER.clear,
            clouds: selectedCloudPreset,
            over: {},
        };
    };

    const ensureWeather = async () => {
        if (weather.transitionTo) return weather;
        if (!weatherPromise) {
            weatherPromise = (async () => {
                await loadEngine('weather_system.js');
                const boltTex = await globalThis.loadImageTexture('./assets/weather/trace_06.png', {});
                const dropTex = await globalThis.loadImageTexture('./assets/weather/rain_streak.png', { srgb: true });
                // The attachment may be retired while either texture is in
                // flight. A stale request must stop before makeWeatherSystem:
                // constructing it would dispose the newer scene owner through
                // the one-system registry, then immediately dispose itself.
                if (disposed) return null;
                const made = await globalThis.makeWeatherSystem({
                    scene,
                    sky,
                    opts: {
                        ...quality.weather,
                        textures: { bolt: boltTex, drop: dropTex },
                        // Read the live roots only when a rare local-strike
                        // candidate is evaluated. Terrain and authored temple
                        // roofs/terraces are the sole raycast receivers; sky,
                        // weather FX, vegetation, and the player are excluded.
                        strikeTargets: () => [
                            globalThis._terrain,
                            globalThis._temple?.group,
                        ].filter(Boolean),
                        // Raycast authored temple/terrain meshes first. The
                        // height sampler is a deterministic fallback for terrain
                        // chunks that are currently culled or use a GPU-only LOD;
                        // a promised local strike must still reach a real upward
                        // surface instead of silently becoming remote.
                        strikeHeightAt: (x, z) => globalThis._terrain?.heightAt?.(x, z),
                        onLocalStrike: (impact) => {
                            // Keep a durable, renderer-independent world signal
                            // beside the pooled VFX/scorch. Terrain heightfield
                            // fallback hits have no raycast object to annotate,
                            // so explicitly attach the record to the live terrain.
                            const terrain = globalThis._terrain;
                            if (impact?.kind === 'terrain_heightfield' && terrain?.userData) {
                                const damage = terrain.userData.lightningDamage
                                    ?? { strikes: 0, lastImpact: null };
                                damage.strikes++;
                                damage.lastImpact = impact;
                                terrain.userData.lightningDamage = damage;
                            }
                            globalThis._lastLightningImpact = impact;
                            if (typeof globalThis.dispatchEvent === 'function'
                                && typeof globalThis.CustomEvent === 'function') {
                                globalThis.dispatchEvent(new globalThis.CustomEvent(
                                    'eanpa:lightning-impact', { detail: impact },
                                ));
                            }
                        },
                        // Hosts can supply their own collision roots, surface
                        // sampler and impact callback without demo globals.
                        ...weatherOptions,
                    },
                });
                updateNoneTarget(made);
                if (disposed) {
                    made.dispose?.();
                    return null;
                }
                try {
                    made.wrapScene();
                } catch (error) {
                    made.dispose?.();
                    throw error;
                }
                weather = made;
                stripWeatherMrt();

                // A stale async rain request may have been superseded by None
                // while its textures loaded. Retarget from the current cloud
                // values rather than snapping the sky or rewinding rain motion.
                if (requestedWeatherState === 'none') {
                    made.transitionTo('none', 1, transitionSeconds);
                    stripWeatherMrt();
                }
                return made;
            })().catch((error) => {
                weatherPromise = null;
                throw error;
            });
        }
        return weatherPromise;
    };

    const beginWeatherTransition = (readyWeather, state, requestId, onTransitionStart) => {
        if (disposed || !readyWeather || weatherRequestId !== requestId) return false;
        readyWeather.transitionTo(state, 1, transitionSeconds);
        stripWeatherMrt();
        if (typeof onTransitionStart === 'function') {
            onTransitionStart({ state, duration: transitionSeconds });
        }
        return true;
    };

    controller = {
        supportsWeather: true,
        weatherTransitionSeconds: transitionSeconds,
        get state() { return weather.state; },
        get uniforms() { return weather.uniforms; },
        get bolt() { return weather.bolt; },
        get diagnostics() { return weather.diagnostics; },
        get WEATHER() { return weather.WEATHER; },
        get _trans() { return weather._trans; },
        get _transS() { return weather._transS; },
        get cloudPreset() { return selectedCloudPreset; },
        get requestedWeatherState() { return requestedWeatherState; },
        setCloudPreset(name, onTransitionStart) {
            if (disposed || !CLOUD_PRESETS.has(name)) return false;
            selectedCloudPreset = name;
            if (weather.transitionTo) updateNoneTarget(weather);

            // Active weather owns the visible cloud front. Preserve it and only
            // change the base style that a later transition to None restores.
            if (requestedWeatherState !== 'none') return true;

            if (weather.transitionTo) {
                weather.transitionTo('none', 1, transitionSeconds);
                stripWeatherMrt();
            } else if (sky.transitionClouds) {
                sky.transitionClouds(name, transitionSeconds);
            } else {
                sky.setClouds?.(name);
            }
            if (typeof onTransitionStart === 'function') {
                onTransitionStart({
                    state: 'none',
                    cloudPreset: name,
                    duration: transitionSeconds,
                });
            }
            return true;
        },
        // Load the weather engine (and, critically, add its lightning scene
        // light) ahead of any weather request. A light joining the scene
        // later regenerates every pipeline — the boot screen is the only
        // acceptable place for that cost. Visually inert: the None retarget
        // keeps rain and every storm uniform at rest.
        preloadWeather() {
            if (disposed) return Promise.resolve(false);
            return ensureWeather()
                .then((readyWeather) => {
                    // Boot-time preload: finish the wetness/cloud-shadow wrap
                    // SYNCHRONOUSLY while the boot screen still covers the
                    // cost, so every material's graph reaches its final shape
                    // before its first compile ("no graph surgery after first
                    // compile"). The default 4/frame incremental drain remains
                    // only for lazy switch-time loads, where a live frame loop
                    // must stay responsive. wrapMaterial is idempotent, so
                    // re-invoking over the queued set is safe.
                    readyWeather?.wrapScene?.({ budget: Infinity });
                    // Preload runs behind the boot curtain. None should open
                    // with the selected cloud preset already settled, rather
                    // than advertise an artificial 45-second weather morph.
                    if(requestedWeatherState==='none')readyWeather?.setWeather?.('none',1);
                    return Boolean(readyWeather);
                })
                .catch((error) => {
                    console.error('[weather] preload failed', error);
                    return false;
                });
        },
        weatherWarmupObjects() {
            return weather.pipelineWarmupObjects?.() ?? [];
        },
        setWeather(state, onTransitionStart) {
            if (!state || disposed) return false;
            requestedWeatherState = state;
            const requestId = ++weatherRequestId;
            if (weather.transitionTo) {
                beginWeatherTransition(weather, state, requestId, onTransitionStart);
                return true;
            }

            // The untouched sky already represents None. Incrementing the
            // request token still cancels any stale activation in flight.
            if (state === 'none' && !weatherPromise) return true;
            if (state === 'none') {
                void weatherPromise.then((readyWeather) => {
                    if (disposed || !readyWeather || weatherRequestId !== requestId) return;
                    // ensureWeather already began the continuous None retarget.
                    if (typeof onTransitionStart === 'function') {
                        onTransitionStart({ state, duration: transitionSeconds });
                    }
                }).catch((error) => console.error('[weather] None activation failed', error));
                return true;
            }

            void ensureWeather().then((readyWeather) => {
                beginWeatherTransition(readyWeather, state, requestId, onTransitionStart);
            }).catch((error) => console.error('[weather] activation failed', error));
            return true;
        },
        update(t) {
            weather.update(t, camera);
        },
        prepareFrame(renderer, viewCamera = camera, options) {
            return weather.prepareFrame?.(renderer, viewCamera, options) ?? false;
        },
        sunDim() {
            return weather.sunDim();
        },
        forceStrike() {
            return weather.debugForceLocalStrike?.() ?? false;
        },
        applyLightDim() {
            const dim = weather.sunDim();
            if (sun) sun.intensity *= dim;
            const skylightDim = weather.hemiDim?.() ?? (0.5 + dim * 0.5);
            if (hemi) hemi.intensity *= skylightDim;
            // Fog is scattered skylight. applyToLights repaints it from the
            // clear-sky palette every frame; without this dim a sealed storm
            // left the bright daytime horizon color on the fog, painting
            // distant terrain with a glowing pale band while nearby ground
            // was correctly dark.
            if (scene.fog?.color) scene.fog.color.multiplyScalar(skylightDim);
            return dim;
        },
        dispose() {
            if (disposed) return;
            disposed = true;
            weatherRequestId++;
            for (const timer of mrtStripTimers) clearTimeout(timer);
            mrtStripTimers.clear();
            weather.dispose?.();
            weather = nullWeather;
            if (globalThis._weather === controller) globalThis._weather = null;
        },
    };

    globalThis._weather = controller;
    try {
        if (requestedWeatherState !== 'none') {
            const readyWeather = await ensureWeather();
            readyWeather?.setWeather(requestedWeatherState, 1);
            stripWeatherMrt();
        }
    } catch (error) {
        controller.dispose();
        throw error;
    }
    return controller;
}

export async function makeWeatherSky({
    scene,
    camera,
    sun,
    hemi,
    loadEngine,
    quality,
    hours,
    blueNoise,
    worldRayDir,
    cloudPreset,
    weatherState: contextualWeatherState,
    weatherOptions = {},
}, preset = cloudPreset, weatherState = contextualWeatherState) {
    await loadEngine('sky_system.js');
    const selectedPreset = resolveCloudPreset(preset);
    const selectedWeather = weatherState || 'none';
    const stars = await globalThis.loadImageTexture('./assets/starmap_tycho_4k.jpg', { srgb: true });
    // NASA CGI Moon Kit LROC color map (public domain, svs.gsfc.nasa.gov/4720).
    // The moon disc renders at ~3.2 deg (and larger under wheel zoom); the old
    // 1k source left only ~512 texels across the visible hemisphere — blurry.
    const moon = await globalThis.loadImageTexture('./assets/moon_color_4k.jpg', { srgb: true });
    const sky = await globalThis.makeSkySystem({
        scene,
        textures: { stars, moon },
        opts: {
            hours,
            clouds: selectedPreset,
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

    let attachment = null;
    let disposed = false;
    const disposeWeatherSky = () => {
        if (disposed) return;
        disposed = true;
        attachment?.dispose();
        sky.dispose?.();
        if (globalThis._sky === sky) globalThis._sky = null;
    };

    try {
        attachment = await makeLazyWeatherAttachment({
            scene,
            camera,
            sky,
            sun,
            hemi,
            loadEngine,
            quality,
            baseCloudPreset: selectedPreset,
            initialWeatherState: selectedWeather,
            weatherOptions,
        });
    } catch (error) {
        disposeWeatherSky();
        throw error;
    }

    return {
        sky,
        supportsWeather: true,
        weatherTransitionSeconds: attachment.weatherTransitionSeconds,
        setTime(h) { sky.setTime(h); },
        setCloudPreset(name, onTransitionStart) {
            return attachment.setCloudPreset(name, onTransitionStart);
        },
        setWeather(state, onTransitionStart) {
            return attachment.setWeather(state, onTransitionStart);
        },
        preloadWeather() {
            return attachment.preloadWeather?.() ?? Promise.resolve(false);
        },
        weatherWarmupObjects() {
            return attachment.weatherWarmupObjects?.() ?? [];
        },
        update(t) {
            sky.update(t, camera);
            attachment.update(t);
            sky.applyToLights({ sun, hemi, fog: scene.fog });
            attachment.applyLightDim();
        },
        dispose: disposeWeatherSky,
    };
}
