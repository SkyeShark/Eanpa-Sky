import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');
const sources = {
    sky: read('engine/sky_system.js'),
    weather: read('engine/weather_system.js'),
    ringEngine: read('engine/ringworld.js'),
    spatial: read('src/cloudspatial.js'),
    weatherSky: read('src/weathersky.js'),
    ringSky: read('src/ringsky.js'),
    shield: read('src/shieldworld.js'),
    main: read('src/main.js'),
};

let assertions = 0;
const check = (condition, message) => {
    assertions++;
    if (!condition) throw new Error(`resource lifecycle audit failed: ${message}`);
};
const has = (source, text, message = text) => check(source.includes(text), message);
const lacks = (source, text, message = text) => check(!source.includes(text), message);

// Lightning may rewrite values, never replace GPU-backed attributes per strike.
has(sources.weather, 'const BOLT_MAX_VERTICES = 256;', 'fixed bolt vertex budget');
has(sources.weather, 'boltPositionAttribute.setUsage(T3.DynamicDrawUsage);', 'dynamic bolt vertex buffer');
has(sources.weather, "boltGeo.setAttribute('position', boltPositionAttribute);", 'single owned bolt position attribute');
has(sources.weather, 'boltGeo.setDrawRange(0, idx.length);', 'bolt draw range follows live indices');
lacks(sources.weather, "new T3.Float32BufferAttribute(pos, 3)", 'no per-strike position allocation');
lacks(sources.weather, "new T3.Float32BufferAttribute(uvs, 2)", 'no per-strike uv allocation');
for (const token of ['rainGeo.dispose();', 'splashGeo.dispose();', 'boltGeo.dispose();', 'rainMat.dispose();', 'splashMat.dispose();', 'boltMat.dispose();']) {
    has(sources.weather, token, `weather owns ${token}`);
}

// Replaceable sky resources and persistent-material wrappers have exact owners.
for (const token of ['cloudShadowRoots.clear();', 'noiseTex.dispose();', 'weatherTex.dispose();', 'lightCacheTex?.dispose?.();', 'lightCacheCompute?.dispose?.();', 'sys._envTarget?.dispose?.();']) {
    has(sources.sky, token, `sky cleanup contains ${token}`);
}
has(sources.sky, 'if (disposed) return;', 'sky disposal is idempotent');
has(sources.sky, 'if (material.colorNode !== roots.wrapped) continue;', 'sky restores only its own wrapper');
has(sources.sky, 'domes: [bgDome, cloudDome],', 'shared cloud dome is the only high-cloud owner');
lacks(sources.sky, 'ringworld_curved_high_cloud_sheet', 'no standalone Ringworld high-cloud resource');
lacks(sources.sky, 'ringWispGeo', 'no separately owned Ringworld wisp geometry');

// Spatial targets/materials are owned, and real domes are restored on detach.
for (const token of ['backgroundTarget.dispose();', 'cloudTarget.dispose();', 'proxyGeometry.dispose();', 'backgroundMaterial.dispose();', 'proxyMaterial.dispose();']) {
    has(sources.spatial, token, `spatial cleanup contains ${token}`);
}
has(sources.spatial, 'if (backgroundDome) attachedScene.add(backgroundDome);', 'spatial pass restores background dome');
has(sources.spatial, 'if (cloudDome) attachedScene.add(cloudDome);', 'spatial pass restores cloud dome');
has(sources.spatial, 'if (backgroundDome || cloudDome || attachedScene) return false;', 'spatial pass refuses a second attachment');

// Weather timers and lazy-construction races are cancelled on dispose.
has(sources.weatherSky, 'for (const timer of mrtStripTimers) clearTimeout(timer);', 'weather MRT timers are cleared');
has(sources.weatherSky, 'weatherRequestId++;', 'weather async requests are invalidated');
has(sources.weatherSky, 'disposeWeatherSky();\n        throw error;', 'initial weather failure rolls back');

// GLB-created Ringworld textures are distinct from the shared image cache.
has(sources.ringEngine, 'sourceTextures: [...sourceTextures],', 'Ringworld exports GLB texture ownership');
has(sources.ringEngine, 'for (const material of sourceMaterials) material.dispose?.();', 'Ringworld retires replaced GLB materials');
has(sources.ringEngine, 'if (debugBandMaterial) bandMat.dispose();', 'Ringworld retires the unused authored debug material');
has(sources.ringSky, 'ring?.info?.sourceTextures ?? []', 'Ringworld wrapper disposes GLB textures');
has(sources.ringSky, 'disposeRingworld();\n        throw error;', 'Ringworld constructor rolls back');
has(sources.shield, 'moonSys?.disposeTextures?.();', 'Shieldworld disposes GLB textures');
has(sources.shield, 'disposeShieldworld();\n        throw error;', 'Shieldworld constructor rolls back');

// Rebuild-local work must not install listeners, intervals, or animation loops.
const buildStart = sources.main.indexOf('async function buildSkybox()');
const buildEnd = sources.main.indexOf("document.getElementById('skybox').addEventListener", buildStart);
check(buildStart >= 0 && buildEnd > buildStart, 'buildSkybox source range exists');
const buildBody = sources.main.slice(buildStart, buildEnd);
lacks(buildBody, 'addEventListener(', 'no listener installation inside rebuild');
// Awaited ONE-SHOT rAF yields (paint the boot overlay / chunk the warmup
// compile) resolve immediately and cannot leak across rebuilds. Only a rAF
// outside that exact awaited-promise form counts as loop installation.
const buildBodyNoYields = buildBody
    .replaceAll('await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));', '')
    .replaceAll('await new Promise((r) => requestAnimationFrame(r));', '');
lacks(buildBodyNoYields, 'requestAnimationFrame(', 'no animation-loop installation inside rebuild');
lacks(buildBody, 'setInterval(', 'no interval installation inside rebuild');
has(buildBody, 'spatialCandidate.dispose?.();', 'failed unattached spatial target rolls back');
has(buildBody, 'failedActive?.dispose?.();', 'failed completed preset rolls back');
has(sources.main, 'clearWeatherReflectionTimers();', 'weather reflection timers have central cleanup');

for (const [name, source] of Object.entries(sources)) {
    if (name !== 'main') {
        lacks(source, 'requestAnimationFrame(', `${name} has no private animation loop`);
        lacks(source, 'setInterval(', `${name} has no private interval`);
        lacks(source, 'addEventListener(', `${name} has no private event listener`);
    }
}

console.log(`[sky-resource-audit] ${assertions} static assertions passed`);
