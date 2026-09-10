// The optimized tiers retain Eidoverse's world-space cloud dome. Their speed
// comes from bounded march counts and density/light caches, never from the old
// screen-space history proxy that pinned cloud copies to camera pixels.
export function skyQualityPresets(cacheMode='all'){
const CACHE_MODE = cacheMode;
const useDensityCache = CACHE_MODE === 'all' || CACHE_MODE === 'density';
const useLightCache = CACHE_MODE === 'all' || CACHE_MODE === 'light';
const optimizedCaches = (lightSize, refreshSeconds) => ({
    densityCache: useDensityCache ? { size: 128 } : null,
    lightCache: useLightCache ? { size: lightSize, refreshSeconds } : null,
});
// These profiles budget only sky, skybox reflections, spatial clouds, and
// weather particles. All tiers retain terrain, architecture, N8AO and native
// reflections. Sun-shadow resolution is fixed; refresh cadence follows the tier.
const QUALITY = {
    high: {
        name: 'high', label: 'High / Insane', fpsTarget: 30,
        skySamples: 60, lightSamples: 18, cloudPasses: 5, cloudDiv: 1,
        cloudShadowResolution:384,
        reflectionBake: { width: 512, height: 256, cloudPasses: 4 },
        cloudReflectionRefreshSeconds: 10,
        weather: { rainCount: 16000, splashCount: 1100, transitionSeconds: 45, surfaceResolution: 1024, surfaceRefreshHz: 12 },
        ...optimizedCaches([160, 40, 160], 0.12),
    },
    balanced: {
        name: 'balanced', label: 'Balanced', fpsTarget: 60,
        skySamples: 44, lightSamples: 14, cloudPasses: 3, cloudDiv: 2,
        cloudShadowResolution:384,
        reflectionBake: { width: 384, height: 192, cloudPasses: 3 },
        cloudReflectionRefreshSeconds: 16,
        weather: { rainCount: 10000, splashCount: 700, transitionSeconds: 45, surfaceResolution: 768, surfaceRefreshHz: 8 },
        ...optimizedCaches([112, 28, 112], 0.22),
    },
    performance: {
        name: 'performance', label: 'Performance', fpsTarget: 120,
        skySamples: 20, lightSamples: 6, cloudPasses: 2, cloudDiv: 3,
        cloudShadowResolution:256,
        reflectionBake: { width: 256, height: 128, cloudPasses: 2 },
        cloudReflectionRefreshSeconds: 24,
        weather: { rainCount: 5500, splashCount: 320, transitionSeconds: 45, surfaceResolution: 512, surfaceRefreshHz: 6 },
        ...optimizedCaches([72, 20, 72], 0.33),
    },
};
return QUALITY;
}
