#!/usr/bin/env node

import assert from 'node:assert/strict';

const port = process.env.CDP_PORT || '9223';
const host = process.env.CDP_HOST || '127.0.0.1';
const fetchHost = host.includes(':') ? '[' + host + ']' : host;
const targets = await fetch('http://' + fetchHost + ':' + port + '/json/list')
    .then((response) => response.json());
const target = targets.find((item) => item.type === 'page' && item.url.includes('localhost:8377'))
    || targets.find((item) => item.type === 'page');
assert.ok(target?.webSocketDebuggerUrl, 'no Eanpa page on CDP');

const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
});

let nextId = 1;
const pending = new Map();
socket.addEventListener('message', ({ data }) => {
    const message = JSON.parse(data);
    if (!message.id || !pending.has(message.id)) return;
    const pair = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) pair.reject(new Error(message.error.message));
    else pair.resolve(message.result);
});
const send = (method, params = {}) => {
    const id = nextId++;
    socket.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
};

const expression = '(() => ({'
    + ' ready: document.getElementById(\'boot\')?.style.display === \'none\','
    + ' skybox: document.getElementById(\'skybox\')?.value,'
    + ' cloudType: document.getElementById(\'cloud-type\')?.value,'
    + ' weather: document.getElementById(\'weather\')?.value,'
    + ' quality: document.getElementById(\'quality\')?.value,'
    + ' pipeline: {'
    + '   compose: globalThis._reflectionPipeline?.reflectionCompose,'
    + '   environmentSuppressed: globalThis._reflectionPipeline?.environmentSuppressedMaterials'
    + ' },'
    + ' reflectionStats: globalThis._reflectionStats,'
    + ' skyReflection: globalThis._sky?.reflectionInfo,'
    + ' cloudShadow: globalThis._cloudShadowStats,'
    + ' earthMoon: globalThis._sky?.celestialInfo,'
    + ' shieldMoon: globalThis._shieldworldMoonStats'
    + ' }))()';
const evaluated = await send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
});
if (evaluated.exceptionDetails) throw new Error(evaluated.exceptionDetails.text);
const state = evaluated.result.value;

const pbrEvaluated = await send('Runtime.evaluate', {
    expression: '(() => ({'
        + ' cloudSource: globalThis._reflectionPipeline?.cloudReflectionMaterialSource,'
        + ' cloudWeighting: globalThis._reflectionPipeline?.cloudReflectionWeighting,'
        + ' cloudAo: globalThis._reflectionPipeline?.cloudReflectionAo,'
        + ' cloudScale: globalThis._reflectionPipeline?.cloudReflectionResolutionScale,'
        + ' cloudUpdate: globalThis._reflectionPipeline?.cloudReflectionUpdate,'
        + ' ssrScale: globalThis._reflectionPipeline?.ssrNode?.resolutionScale'
        + ' }))()',
    returnByValue: true,
    awaitPromise: true,
});
if (pbrEvaluated.exceptionDetails) throw new Error(pbrEvaluated.exceptionDetails.text);
const pbr = pbrEvaluated.result.value;

assert.equal(state.ready, true, 'scene is still building');
assert.equal(state.pipeline.compose, 'native-cloud-pmrem-ibl_then-three-ssr');
assert.equal(state.pipeline.environmentSuppressed, 0, 'opaque PBR environments must remain native');
assert.equal(state.reflectionStats.cloudPbr, 'three-native-pmrem-material-brdf');
assert.equal(state.reflectionStats.cloudsIncluded, true);
assert.ok([10, 16, 24].includes(state.reflectionStats.cloudRefreshSeconds));
assert.equal(pbr.cloudSource, 'native-material-brdf-final-maps');
assert.equal(pbr.cloudWeighting, 'three-pmrem-environment-brdf');
assert.equal(pbr.cloudAo, 'native-material-ibl-occlusion');
assert.equal(pbr.cloudScale, null, 'a screen-resolution cloud reflection target still exists');
assert.equal(pbr.cloudUpdate, 'periodic-equirectangular-pmrem');
assert.ok(pbr.ssrScale > 0 && pbr.ssrScale <= 1);
assert.equal(state.skyReflection.mode, 'native-equirectangular-pmrem');
assert.equal(state.skyReflection.cloudSamplePhase, 'quality-budgeted-multipass-bake');
assert.equal(state.skyReflection.temporalHistory, false);
assert.equal(state.skyReflection.highLayerHorizonFade, 'own-shell-distance');
assert.equal(state.skyReflection.materialSource, 'three-native-resolved-material-brdf');
assert.equal(state.skyReflection.materialWeighting, 'pmrem-environment-brdf');
assert.equal(state.skyReflection.roughnessResponse, 'three-pmrem-angular-prefilter');
assert.equal(state.skyReflection.receiverAoResponse, 'three-native-ibl-occlusion');
assert.equal(state.skyReflection.screenSpaceCloudLayer, false);
assert.equal(state.cloudShadow.mode, 'world-space-sun-column');
assert.equal(state.cloudShadow.installedWithoutWeather, true);
assert.ok(state.cloudShadow.materials > 0, 'no local PBR cloud-shadow receivers');
assert.equal({ high: 6, balanced: 4, performance: 2 }[state.quality], state.cloudShadow.samples);
assert.ok(['clear', 'cumulus', 'stratus', 'cirrus'].includes(state.cloudType),
    'invalid independent Cloud Type');
assert.ok(['none', 'fair', 'sunshower', 'overcast', 'rain', 'storm', 'noreaster', 'darkstorm']
    .includes(state.weather), 'invalid independent Weather state');

if (state.skybox === 'shieldworld') {
    assert.equal(state.shieldMoon.reflectedKey, 'red-giant-warm-amber-brown');
    const [r, g, b] = state.shieldMoon.keyColor;
    assert.ok(r > g && g > b, 'Shieldworld rocky moon key is not warm red/amber');
} else if (state.skybox === 'earth') {
    assert.equal(state.earthMoon.earthMoonTexture, true);
    assert.equal(state.earthMoon.earthMoonTone, 'neutral-cool-lunar-albedo');
}

socket.close();
console.log('[sky-stability-runtime-audit] PASS');
console.log(JSON.stringify(state, null, 2));
