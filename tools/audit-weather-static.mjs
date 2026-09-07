import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { blendAmbienceLoop } from '../src/audio_loop.js';

const ROOT = new URL('../', import.meta.url);
const read = (path) => readFile(new URL(path, ROOT), 'utf8');
const sources = Object.fromEntries(await Promise.all([
    'engine/weather_system.js',
    'engine/sky_system.js',
    'engine/ringworld.js',
    'src/cloudspatial.js',
    'src/weathersky.js',
    'src/ringsky.js',
    'src/shieldworld.js',
    'src/desert_dressing.js',
    'src/audio_system.js',
    'src/main.js',
].map(async (path) => [path, await read(path)])));

let checks = 0;
const ok = (value, message) => { assert.ok(value, message); checks++; };
const equal = (actual, expected, message) => { assert.deepEqual(actual, expected, message); checks++; };
const near = (actual, expected, epsilon, message) => {
    assert.ok(Math.abs(actual - expected) <= epsilon, `${message}: ${actual} != ${expected}`);
    checks++;
};
const codeOnly = (source) => source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');

function literal(source, name) {
    const match = source.match(new RegExp(`const\\s+${name}\\s*=\\s*(\\{[\\s\\S]*?\\n\\s*\\});`));
    assert.ok(match, `could not extract ${name}`);
    return Function(`"use strict"; return (${match[1]});`)();
}

const weatherSource = sources['engine/weather_system.js'];
const skySource = sources['engine/sky_system.js'];
const ringEngineSource = sources['engine/ringworld.js'];
const wrapperSource = sources['src/weathersky.js'];
const spatialSource = sources['src/cloudspatial.js'];
const audioSource = sources['src/audio_system.js'];
const shieldSource = sources['src/shieldworld.js'];
const desertSource = sources['src/desert_dressing.js'];
const mainSource = sources['src/main.js'];
const mainCode = codeOnly(mainSource);
const indexSource = await read('index.html');
const WEATHER = literal(weatherSource, 'WEATHER');
const PRESETS = literal(skySource, 'PRESETS');

// Weather definitions and authored high-cloud styles.
equal(WEATHER.darkstorm.rain, 1, 'Dark Storm must retain full rain');
ok(WEATHER.darkstorm.lightning >= 0.8, 'Dark Storm must retain frequent lightning');
ok(WEATHER.darkstorm.distant > 0, 'Dark Storm must retain distant sheet lightning');
ok(WEATHER.darkstorm.over.finalMul >= 0.25,
    'settled Dark Storm keeps a dense volumetric underlayer running beneath the canopy');
equal(WEATHER.darkstorm.over.largeT, 0,
    'the Dark Storm volumetric underlayer opens no clear-sky holes');
equal(WEATHER.darkstorm.over.wispOn, 1,
    'settled Dark Storm runs the upper canopy sheet as its textured gap ceiling');
ok(WEATHER.darkstorm.over.wispFloor >= 0.4,
    'the Dark Storm canopy sheet keeps a guaranteed organic coverage floor');
ok(Math.max(...WEATHER.darkstorm.over.wispTint) <= 0.45,
    'the Dark Storm canopy sheet is tinted dark — it can never read as a bright cirrus deck');
equal(WEATHER.darkstorm.over.stormCanopy, 1,
    'settled Dark Storm seals the sky behind the volumetric underlayer');
ok(WEATHER.darkstorm.stormTopMeters >= 19000,
    'Dark Storm retains real cumulonimbus top semantics without rendering the invisible mass');
equal(WEATHER.darkstorm.sunDim, 0,
    'settled Dark Storm fully removes direct sun/moon key illumination');
equal(WEATHER.darkstorm.celestialVisibility, 0,
    'settled Dark Storm fully removes celestial discs and coronae');
ok(WEATHER.darkstorm.hemiDim <= 0.20,
    'Dark Storm retains only restrained non-directional storm skylight');
ok(WEATHER.darkstorm.cloudRadiance <= 0.15,
    'Dark Storm underside remains genuinely dark between lightning strikes');
ok(WEATHER.darkstorm.over.wispTint[2] > WEATHER.darkstorm.over.wispTint[1]
    && WEATHER.darkstorm.over.wispTint[1] > WEATHER.darkstorm.over.wispTint[0],
    'Dark Storm transition tint uses a neutral cool-slate progression, not olive green');
ok(Math.max(...WEATHER.darkstorm.greyTint) - Math.min(...WEATHER.darkstorm.greyTint) <= 0.11
    && WEATHER.darkstorm.greyTint[1] <= WEATHER.darkstorm.greyTint[2],
    'Dark Storm atmosphere remains near-neutral with only a restrained cool bias');
equal(WEATHER.darkstorm.over.lightCacheDirect, 0,
    'sealed Dark Storm cannot request the obsolete live light march');
const stormCanopySource = skySource.slice(
    skySource.indexOf('// SEALED LOW CUMULONIMBUS VOLUME'),
    skySource.indexOf('// distance fade into horizon haze'),
);
const stormFieldSource = skySource.slice(
    skySource.indexOf('// Lowest visible Dark Thunderstorm layers.'),
    skySource.indexOf('// ---------------- optimized light/froxel cache'),
);
ok(stormCanopySource.length > 0
    && stormFieldSource.length > 0
    && /If\(u\.stormCanopy\.greaterThan\(0\.0001\)\.and\(dir\.y\.greaterThan\(0\.0005\)\)/.test(stormCanopySource),
    'Dark Storm owns a statically discoverable bounded low-volume branch');
ok(/const N_STORM_STEPS = Math\.max\(4, Math\.round\(Number\(\s*opts\.stormSamples \?\? 12\)\)\)/.test(skySource)
    && /const N_STORM_PASSES = 2/.test(skySource)
    && /stormPass < N_STORM_PASSES/.test(stormCanopySource)
    && /Loop\(\{ start: 0, end: N_STORM_STEPS, type: 'int' \}/.test(stormCanopySource)
    && /stormJitter = fract\(baseJit\.add\(stormPass \/ N_STORM_PASSES\)\)/.test(stormCanopySource),
    'twenty-four interleaved stratified samples resolve the bounded low storm layers without static per-pixel speckle');
ok(/stormLayerBottom = \(\) => u\.cloudStart\.sub\(280\)/.test(stormFieldSource)
    && /stormLayerDepth = \(\) => clamp\(u\.cloudHeight\.mul\(2\.85\), 1100, 1450\)/.test(stormFieldSource),
    'rendered storm volume is materially deep but remains limited to its lowest 1.1-1.45 km');
ok([0.00031, 0.00062, 0.00185, 0.0054]
    .every((frequency) => stormFieldSource.includes(`mul(${frequency})`))
    && (stormFieldSource.match(/noise3A\(/g) ?? []).length >= 4
    && !/(?:weatherNode|wSampleL|wSampleS|fbmE)\(/.test(stormFieldSource),
    'storm warp, macro, billow, and fine cells are analytic 3D fields rather than a repeated 2D texture');
ok(/const organicCore = smoothstep\([\s\S]*const guaranteedCore = smoothstep\([\s\S]*const core = max\(/.test(stormFieldSource)
    && /const lowerWindow = smoothstep\([\s\S]*const middleWindow = smoothstep\([\s\S]*const scud = max\(/.test(stormFieldSource),
    'continuous deep core and two lower scud windows create overlapping vertical structure');
ok(/const deepCoreH = h[\s\S]*macro\.sub\(0\.5\)\.mul\(0\.14\)[\s\S]*billow\.sub\(0\.5\)\.mul\(0\.04\)/.test(stormFieldSource)
    && /float\(0\.00035\), float\(0\.0160\), smoothstep\(0\.38, 0\.55, deepCoreH\)/.test(stormFieldSource)
    && /const extinction = envelope[\s\S]*floorExtinction\.add\(coreExtinction\)\.add\(scudExtinction\)/.test(stormFieldSource)
    && !/\.greaterThan\([^)]*extinction|extinction[^;]*\.greaterThan/.test(stormFieldSource),
    'ruffled deep mass integrates smooth continuous extinction without binary density slices');

// Independent worst-case floor integration: delay the ruffled deep boundary by
// its full macro+billow displacement. This proves sealed coverage from
// extinction rather than accepting a source comment or a forced alpha token.
const smoothScalar = (edge0, edge1, value) => {
    const t = Math.max(0, Math.min(1, (value - edge0) / (edge1 - edge0)));
    return t * t * (3 - 2 * t);
};
let minimumFloorOpticalDepth = 0;
const floorIntegrationSteps = 20000;
for (let stepIndex = 0; stepIndex < floorIntegrationSteps; stepIndex++) {
    const h = (stepIndex + 0.5) / floorIntegrationSteps;
    const envelope = smoothScalar(0.0, 0.045, h)
        * (1 - smoothScalar(0.94, 1.0, h));
    const worstRuffle = -0.5 * 0.14 - 0.5 * 0.04;
    const floorExtinction = 0.00035
        + (0.0160 - 0.00035) * smoothScalar(0.38, 0.55, h + worstRuffle);
    minimumFloorOpticalDepth += envelope * floorExtinction
        * 1100 / floorIntegrationSteps;
}
ok(minimumFloorOpticalDepth > 7.4
    && 1 - Math.exp(-minimumFloorOpticalDepth) > 0.999,
    'worst-ruffled 1.1 km storm column seals >99.9% of sky using Beer extinction alone');
const skyCode = codeOnly(skySource);
ok(!/(?:stormLastTone|backstopBase|backstopStrike|sealedRadiance|N_STORM_UNDERSIDE)/.test(skyCode)
    && /stormA\.assign\(float\(1\)\.sub\(stormTr\)\.mul\(stormBoundary\)\)/.test(stormCanopySource)
    && !/stormA\.assign\(u\.stormCanopy/.test(stormCanopySource),
    'rejected painted backstop and alpha independent of Beer transmittance are absent');
ok(/stormVolumeRgb\.addAssign\([\s\S]*stormTr\.mul\(sampleRadiance\)[\s\S]*stormTr\.assign\(stormTr\.mul\(stormTrStep\)\)/.test(stormCanopySource)
    && /overheadTau[\s\S]*groundTau[\s\S]*upwardVisibility[\s\S]*groundVisibility/.test(stormCanopySource),
    'front-to-back Beer accumulation and continuous ambient self-occlusion shade core/scud depth');
ok(/stormMediumRange = float\(1\)\.sub\([\s\S]*smoothstep\(6500, 16000, stormNearT\)/.test(stormCanopySource)
    && /stormFineRange = float\(1\)\.sub\([\s\S]*smoothstep\(3000, 10500, stormNearT\)/.test(stormCanopySource)
    && /const billow = mix\([\s\S]*rawBillow, clamp\(mediumDetail, 0, 1\)/.test(stormFieldSource)
    && /const detail = mix\(float\(0\.5\), rawDetail, clamp\(fineDetail, 0, 1\)\)/.test(stormFieldSource)
    && !/mix\(float\(0\.5\), macro/.test(stormFieldSource),
    'medium/fine storm octaves filter at grazing distance while macro form remains spatial');
ok(/stormShadowExtinctionAt\(sampleP\)/.test(skySource)
    && !/stormFieldAt\(\s*sampleP/.test(skySource)
    && /const stormShadowExtinctionAt = \(pIn\) => \{[\s\S]*return envelope\.mul\(extinction\)\.mul\(stormContainAt\(pIn\)\)/.test(skySource)
    && /smoothstep\(0\.0001, 0\.02, u\.stormCanopy\)/.test(skySource)
    && /If\(u\.celestialVisibility\.greaterThan\(0\.001\)/.test(skySource)
    && /daylight = smoothstep\(0\.02, 0\.16, u\.cloudLightDir\.y\)[\s\S]*u\.celestialVisibility/.test(skySource),
    'a cheap continuous storm mass shadows the transition key without cloning sky noise into world materials');
ok(/transientLightningInBake: false/.test(skySource)
    && /cloudBody\([\s\S]*dir, vec3\(0, 2, 0\), bopts\.cloudPasses, null, float\(0\)/.test(skySource),
    'periodic PMREM bakes cannot freeze a transient flash into wet PBR receivers');
ok(/belowHorizon = float\(1\)\.sub\([\s\S]*smoothstep\(-0\.35, 0\.0, dir\.y\)/.test(skySource)
    && !/smoothstep\(0\.0, -0\.35, dir\.y\)/.test(skyCode),
    'PMREM lower-hemisphere fade uses ordered smoothstep edges and cannot emit undefined radiance');
ok(/const cloudA = stormA\.add\(ordinaryA\.mul\(float\(1\)\.sub\(stormA\)\)\)/.test(skySource),
    'Beer storm opacity and ordinary volume retain order-independent premultiplied union alpha');
ok(/const stormFrontRgb = stormRgb\.add\(\s*ordinaryRgb\.mul\(float\(1\)\.sub\(stormA\)\),?\s*\)/.test(skySource)
    && /const underlayerFrontRgb = ordinaryRgb\.add\(\s*stormRgb\.mul\(float\(1\)\.sub\(ordinaryA\)\),?\s*\)/.test(skySource)
    && /const settledUnderlayerFront = smoothstep\(\s*0\.96,\s*0\.995,\s*u\.stormCanopy,?\s*\)[\s\S]*?smoothstep\(\s*0\.005,\s*0\.08,\s*u\.celestialVisibility,?\s*\)/.test(skySource)
    && /const cloudRgb = mix\(\s*stormFrontRgb,\s*underlayerFrontRgb,\s*settledUnderlayerFront,?\s*\)/.test(skySource),
    'partial and transitioning canopy remains foreground; only near-settled no-celestial Dark Storm places volumetric understructure in front of the Beer seal');
ok(/cloudDome\.visible = p\.finalMul > 0 \|\| p\.wispOn > 0 \|\| \(p\.stormCanopy \?\? 0\) > 0/.test(skySource),
    'bounded storm volume keeps the shared cloud dome alive with ordinary volume and wisps disabled');
ok((skySource.match(/\.mul\(u\.celestialVisibility\)/g) ?? []).length >= 3,
    'weather celestial visibility attenuates the sun disc and both corona lobes');
ok(/sunDim\(\) \{[\s\S]*No intensity floor:[\s\S]*return Math\.max\(0, Math\.min\(1, 1 - \(1 - target\) \* amount\)\)/.test(weatherSource)
    && /weather\.hemiDim\?\.\(\)/.test(wrapperSource),
    'weather can fully suppress direct light while retaining bounded hemisphere fill');
equal(WEATHER.darkstorm.lightningPalette, 'darkstorm',
    'Dark Storm selects the full five-color lightning table');
for (const name of ['storm', 'cyclone']) {
    equal(WEATHER[name].lightningPalette, 'standard',
        `${name} selects the white/blue/purple-only lightning table`);
    ok(WEATHER[name].localStrikeChance > 0 && WEATHER[name].localStrikeChance < 0.02,
        `${name} local surface strikes remain rare`);
}
equal(WEATHER.darkstorm.localStrikeChance, 0.16,
    'Dark Storm tests local impacts as a minority of naturally spaced events');
ok(/const LIGHTNING_LIGHT_PEAK = 12000[\s\S]*const LIGHTNING_LIGHT_RANGE = 900[\s\S]*new T3\.PointLight\([\s\S]*LIGHTNING_LIGHT_RANGE, 2/.test(weatherSource)
    && /flash = Number\.isFinite\(flash\)[\s\S]*boundedSceneFlash[\s\S]*bolt\.intensity = boundedSceneFlash \* LIGHTNING_LIGHT_PEAK/.test(weatherSource),
    'every bolt retains a finite bounded inverse-square scene light without terrain-white saturation');
ok(/boltColor\.value\.set\([\s\S]*bolt\.color\.copy\(activeStrikeColor\)/.test(weatherSource)
    && /lightningFlashColor\.value\.set\([\s\S]*lightningStrike\.value\.set\(/.test(weatherSource),
    'bolt ribbon, scene light, and shallow cloud volume share one selected color event');
ok(/const IMPACT_POOL_SIZE = 2[\s\S]*const SCORCH_POOL_SIZE = 4[\s\S]*const SCORCH_LIFETIME = 90/.test(weatherSource),
    'local strike effects and temporary scorch decals have fixed bounded pools');
ok(/new T3\.Raycaster\(\)[\s\S]*normal\.y < 0\.72[\s\S]*LOCAL_STRIKE_PLAYER_GUARD/.test(weatherSource),
    'rare local strikes raycast only upward surfaces outside the player guard');
ok(/finiteT - lastLocalStrikeAt >= LOCAL_STRIKE_COOLDOWN/.test(weatherSource)
    && /rebuildBolt\(I, camera, sx, sz, bottomY\)/.test(weatherSource),
    'local impact cadence is cooled down and the visible channel terminates at its hit');
ok(/scene\.remove\(rainInst, splashInst, bolt, boltMesh, \.\.\.impactObjects\)/.test(weatherSource)
    && /impactSparkGeometry\.dispose\(\)[\s\S]*scorchGeometry\.dispose\(\)/.test(weatherSource),
    'weather disposal removes and releases every preallocated impact resource');
ok(/strikeTargets: \(\) => \[[\s\S]*globalThis\._terrain[\s\S]*globalThis\._temple\?\.group/.test(wrapperSource),
    'shared weather attachment supplies only live terrain and temple strike roots');
for (const [name, def] of Object.entries(WEATHER)) {
    ok(def.rain >= 0 && def.rain <= 1, `${name} rain is normalized`);
    ok(def.lightning >= 0, `${name} lightning is nonnegative`);
    if (name === 'clear') continue;
    for (const key of ['wispOn', 'wispThreshold', 'wispStrength', 'wispOpacity', 'wispFilament', 'wispStretch', 'wispTint']) {
        ok(Object.hasOwn(def.over, key), `${name} authors ${key} for its 2D/high layer`);
    }
}
const styleSignatures = new Set(Object.entries(WEATHER)
    .filter(([name]) => name !== 'clear')
    .map(([, def]) => JSON.stringify([
        def.over.wispOn, def.over.wispThreshold, def.over.wispFilament,
        def.over.wispStretch, def.over.wispTint,
    ])));
equal(styleSignatures.size, Object.keys(WEATHER).length - 1, 'weather high-cloud styles are distinct');
for (const [name, preset] of Object.entries(PRESETS)) {
    for (const key of ['lightCacheDirect', 'wispOn', 'wispScale', 'wispThreshold', 'wispStrength', 'wispOpacity', 'wispFloor', 'wispStretch', 'wispFilament', 'wispTint']) {
        ok(Object.hasOwn(preset, key), `${name} preset defines ${key}`);
    }
}
const presetStyleSignatures = new Set(Object.values(PRESETS).map((preset) => JSON.stringify([
    preset.wispOn, preset.wispScale, preset.wispThreshold, preset.wispStrength,
    preset.wispOpacity, preset.wispFilament, preset.wispStretch, preset.wispTint,
])));
equal(presetStyleSignatures.size, Object.keys(PRESETS).length, 'base presets have distinct high-layer style signatures');
for (const name of ['cumulus', 'stratus', 'cirrus']) {
    const preset = PRESETS[name];
    ok(preset.finalMul > 0 || preset.wispOn > 0, `${name} retains cloud content for every quality tier`);
}
equal(PRESETS.cirrus.finalMul, 0, 'cirrus avoids a flattened volumetric slab');
equal(PRESETS.cirrus.wispFilament, 1, 'cirrus selects finite filament plumes');
ok(PRESETS.cirrus.start >= 3000 && PRESETS.cirrus.height <= 250, 'cirrus is a thin high-altitude layer');
ok(PRESETS.cirrus.wispOpacity > 0 && PRESETS.cirrus.wispOpacity <= 1, 'cirrus remains a translucent ice veil');
ok(PRESETS.cirrus.wispStrength >= 1 && PRESETS.cirrus.wispOpacity >= 1, 'cirrus remains visibly present as an ice veil');
ok(PRESETS.cirrus.wispTint[2] >= PRESETS.cirrus.wispTint[0], 'cirrus tint is neutral-to-cool ice rather than charcoal');

// Every style value setClouds writes must be part of the weather morph.
const transitionCapture = weatherSource.slice(
    weatherSource.indexOf('const _transScalars'),
    weatherSource.indexOf('const _capture'),
);
for (const key of [
    'largeT', 'largeA', 'weatherT', 'finalMul', 'wScale', 'dScale',
    'cloudStart', 'cloudHeight', 'stretch', 'lightK', 'wispOn',
    'wispScale', 'wispThreshold', 'wispStrength', 'wispOpacity',
    'wispFloor', 'wispFilament', 'wispStretch', 'wispTint', 'wispColor',
    'lightCacheDirect', 'stormCanopy',
]) {
    ok(transitionCapture.includes(`sky.uniforms.${key}`), `transition captures sky ${key}`);
}
for (const key of ['rainK', 'wetTarget', 'denseA', 'streakLen', 'fallMul', 'dashK', 'cellLo', 'cellHi', 'windVec']) {
    ok(transitionCapture.includes(`u.${key}`), `transition captures weather ${key}`);
}
for (const key of ['cloudDim', 'cloudRadiance', 'sunDiscI', 'precipK', 'precipLo', 'precipHi', 'skyWind', 'celestialVisibility']) {
    ok(transitionCapture.includes(`sky.uniforms.${key}`), `transition captures coupled ${key}`);
}
ok(!transitionCapture.includes('lightningFlashColor')
    && !transitionCapture.includes('lightningStrike'),
    'instantaneous lightning pulse uniforms are never weather-transition captured');
ok(/transitionTo\(name, k = 1, dur = 45\)/.test(weatherSource), 'weather-system transition default is 45 seconds');
ok(/transitionSeconds\s*=\s*Math\.max\(10, quality\.weather\?\.transitionSeconds \?\? 45\)/.test(wrapperSource), 'weather wrapper defaults to 45 seconds');
ok(/new Set\(\[\.\.\.Object\.keys\(a\), \.\.\.Object\.keys\(b\)\]\)/.test(weatherSource), 'live weather definition interpolates the union of fields');
ok(/transitionHasRain[\s\S]*rainInst\.visible = transitionHasRain/.test(weatherSource), 'rain geometry remains present through fades');
ok(/transitionHasClouds[\s\S]*state\.preset = transitionHasClouds \? 'transition'/.test(weatherSource), 'cloud dome remains present through fades');
ok(/const rawS = Math\.max\(0, Math\.min\(1, \(t - tr\.t0\) \/ tr\.dur\)\)/.test(weatherSource), 'transition exposes unclipped linear progress before easing');
ok(/diagnostics\.transition\.rawProgress = rawS[\s\S]*diagnostics\.transition\.easedProgress = s/.test(weatherSource), 'runtime diagnostics expose both user-facing and eased weather progress');
ok(/target: resolvedName,[\s\S]*rawProgress: 1,[\s\S]*easedProgress: 1/.test(weatherSource), 'immediate and completed weather applications report settled progress');

// Cloud Type has its own complete 45-second morph when Weather=None. It uses
// the persistent graph and captures the same authored cloud fields as weather.
const cloudTransitionSource = skySource.slice(
    skySource.indexOf('const CLOUD_SCALAR_KEYS'),
    skySource.indexOf('applyToLights({ sun, hemi, fog }'),
);
for (const key of [
    'largeT', 'largeA', 'weatherT', 'finalMul', 'wScale', 'dScale',
    'cloudStart', 'cloudHeight', 'lightK', 'wispOn', 'wispScale',
    'wispThreshold', 'wispStrength', 'wispOpacity', 'wispFloor', 'wispFilament',
    'stretch', 'wispStretch', 'wispTint', 'lightCacheDirect', 'stormCanopy',
]) {
    ok(cloudTransitionSource.includes(`'${key}'`), `cloud-only transition captures ${key}`);
}
ok(/transitionClouds\(name, duration = 45, over = \{\}\)/.test(skySource), 'cloud-only transition defaults to 45 seconds');
ok(/const eased = raw \* raw \* \(3 - 2 \* raw\)[\s\S]*applyCloudState\(transition\.from, transition\.to, eased\)/.test(skySource), 'cloud-only transition continuously eases captured uniforms');
ok(/cloudDome\.visible = transitionHasClouds;[\s\S]*state\.preset = transitionHasClouds \? 'transition'/.test(skySource), 'cloud-only transition keeps source/target content visible until completion');
ok(/updateWispColor\(\);[\s\S]*cloudTransitionInfo\.rawProgress = raw[\s\S]*cloudTransitionInfo\.easedProgress = eased/.test(skySource), 'cloud-only transition tracks live TOD radiance and exposes progress');
ok(/id='weather-status'[^>]*role='status'/.test(indexSource), 'weather selector has an accessible live progress status');
ok(/updateWeatherStatus\(\);[\s\S]*audio\.update/.test(sources['src/main.js']), 'weather progress status refreshes from the live frame state');
ok(/setWeatherStatus\(state === 'none'[\s\S]*owner\?\.setWeather\?\.\(state/.test(sources['src/main.js']), 'direct selection acknowledges loading before lazy weather activation');

// Rain motion is integrated from positive delta-time velocity. It must never
// use absolute-time × interpolating speed, which visually reverses when a
// transition reduces wind or fall speed.
ok(/totalFallDistance \+= fallVelocity \* motionDt/.test(weatherSource), 'rain fall distance integrates velocity');
ok(/totalWindDistance\.x \+= u\.windVec\.value\.x \* motionDt[\s\S]*totalWindDistance\.z \+= u\.windVec\.value\.z \* motionDt/.test(weatherSource), 'rain wind distance integrates both horizontal axes');
ok(/const motionDt = lastMotionT === null[\s\S]*Math\.max\(0, Math\.min\(finiteT - lastMotionT, 0\.1\)\)/.test(weatherSource), 'rain integration rejects negative and unbounded frame deltas');
ok(!/u\.time\.mul\([^)]*(?:fall|wind)|(?:fall|wind)[^;\n]*u\.time/.test(codeOnly(weatherSource)), 'rain motion contains no absolute-time × changing-velocity path');
ok(/verticalDirection: 'downward-only'/.test(weatherSource), 'runtime diagnostics declare the rain vertical-direction contract');
let monotonicFall = 0;
for (const [fallMul, dt] of [[1.6, 0.016], [1.25, 0.1], [0.5, 0.033], [0.05, 0.1]]) {
    const before = monotonicFall;
    monotonicFall += Math.max(0.05, 11 * Math.max(0.05, fallMul)) * Math.max(0, Math.min(dt, 0.1));
    ok(monotonicFall >= before, 'integrated fall remains downward while fall multiplier changes (' + fallMul + ')');
}

// A conventional edge ordering makes the circular rain/splash feather
// portable across WGSL/GLSL. Reversed smoothstep edges are undefined.
equal((weatherSource.match(/float\(1\)\.sub\(smoothstep\((?:RAD|SP) \* 0\.70, (?:RAD|SP), fieldDistance\)\)/g) ?? []).length, 2, 'rain and splash fields use circular one-minus feathers');
ok(!/smoothstep\((RAD|SP), \1 \* 0\.70, fieldDistance\)/.test(codeOnly(weatherSource)), 'rain fields contain no reversed smoothstep edges');
ok(/opacityBaseRange: \[0\.14, 0\.40\]/.test(weatherSource), 'runtime diagnostics expose the thin-streak alpha range');
ok(/u\.rainColor\.value\.set\(\s*litRain\[0\] \* rc\[0\], litRain\[1\] \* rc\[1\], litRain\[2\] \* rc\[2\]\)/.test(weatherSource),
    'rain color follows live sky chroma with the color override applied last');
ok(/u\.rainLight\.value = Math\.min\([\s\S]*ambientRain \* weatherLight[\s\S]*flash/.test(weatherSource), 'rain brightness follows TOD, weather attenuation, and lightning');
ok(/darkstormCoverage: 'sealed-canopy-independent'[\s\S]*volumetricCurtains: true/.test(weatherSource),
    'precipitation diagnostics expose the sealed-storm local and volumetric rain contract');
ok(/stormRainCover = sky[\s\S]*clamp\(sky\.uniforms\.stormCanopy, 0, 1\)[\s\S]*cellGate = mix\(ordinaryCellGate, stormCellGate, stormRainCover\)/.test(weatherSource)
    && /cellGateS = mix\([\s\S]*ordinaryCellGateS, stormCellGateS, stormSplashCover/.test(weatherSource),
    'settled Dark Storm local drops and splashes do not depend on its disabled ordinary cloud field');
ok(/ordinaryPrecipGate = smoothstep\(u\.precipLo, u\.precipHi, cellCov\)[\s\S]*stormPrecipGate = mix\(float\(0\.72\), float\(1\.0\), colTex\)[\s\S]*precipGate = mix\([\s\S]*clamp\(u\.stormCanopy, 0, 1\)/.test(skySource),
    'wind-advected volumetric rain curtains retain nonzero sealed-canopy coverage');
ok(/sky\.uniforms\.precipK\.value = w\.rain \* k \* \(w\.dense \?\? 1\)/.test(weatherSource)
    && /_transScalars[\s\S]*sky\.uniforms\.precipK/.test(weatherSource),
    'Dark Storm rain density is nonzero when settled and continuously interpolated during transitions');

// Wetness wraps every eligible node material and evaluates shape/up-facing
// eligibility from the fragment's world position/normal, not a terrain-only
// projection or object-name allowlist.
ok(/incidence = clamp\(dot\(normalWorld, surfaceField\.uniforms\.sourceDirection\)/.test(weatherSource)
    && /wetAmount = incidence[\s\S]*mul\(u\.wetness\)\.mul\(wetGate\)\.mul\(exposure\)/.test(weatherSource),
    'wetness uses world normals, incoming rain direction, and surface shelter');
ok(/vnoise2\(positionWorld\.xz/.test(weatherSource), 'puddles use per-fragment world position');
ok(/if \(!o\.isMesh \|\| o\.userData\.noWet\) return;[\s\S]*wrapMaterial\(m, o\)/.test(weatherSource), 'all eligible scene meshes enter arbitrary-geometry wetness wrapping');
ok(/supportsArbitraryUpwardGeometry: true/.test(weatherSource), 'runtime wetness diagnostics expose arbitrary upward receiver support');
ok(/const puddleGate = uniform\(1\)\.onObjectUpdate\([\s\S]*object\.userData\.noPuddles \|\| mat\.userData\?\.noPuddles/.test(weatherSource), 'shared material exclusions follow the actual receiver');
ok(/pShape = smoothstep\([\s\S]*\.mul\(puddleGate\)/.test(weatherSource), 'puddle receiver gate is applied before water shape and depth');
ok(/float\(1\)\.sub\(smoothstep\(160, 450, pDist\)\)/.test(weatherSource), 'puddle distance fade uses ordered smoothstep edges');
ok(/const baseColor4 = vec4\(mat\.colorNode \?\? materialColor\)[\s\S]*const baseRgb = baseColor4\.rgb[\s\S]*mat\.colorNode = vec4\(finalWetRgb, baseColor4\.a\)/.test(weatherSource), 'weather wrapping preserves RGBA cutout silhouettes');
ok(/const finalWetRgb = mix\(wetCol, waterFloor, puddle\)/.test(weatherSource)
    && !/mix\(waterFloor, vec3\(0\.92, 0\.94, 0\.97\)/.test(weatherSource),
    'puddles retain darkened wet-ground albedo without a near-white color injection');
ok(/mat\.metalnessNode = mix\(baseMetal, float\(0\), puddle\)/.test(weatherSource)
    && !/mat\.metalnessNode = mix\(baseMetal, fres, puddle\)/.test(weatherSource),
    'puddles remain dielectric and leave Fresnel response to the native PBR BRDF');
ok(/mesh\.userData\.noPuddles = true/.test(desertSource), 'desert scrub opts out of ground puddles while retaining wet sheen');
ok(/material\.userData\.noPuddles = true/.test(desertSource), 'shared shrub materials retain puddle exclusion across receiver deduplication');
equal((spatialSource.match(/userData\.noWet = true/g) ?? []).length, 2, 'both non-local spatial sky shells are excluded from weather receivers');

// One stable, non-directional hash path is used by all volumetric presets;
// high clouds restore the organic field and advect the complete domain.
ok(/const OUTPUT_DITHER = Math\.max\(0, opts\.outputDither \?\? 0\)/.test(skySource), 'animated HDR output dither ships disabled');
ok(/: hashScreen\(screenCoordinate\.xy\)\)/.test(skySource), 'volumetric fallback uses the shared screen hash');
ok(/const wispAdvected = pC\.add\(vec3\([\s\S]*u\.skyWind\.x\.mul\(u\.time\)[\s\S]*u\.skyWind\.z\.mul\(u\.time\)[\s\S]*const wispPatch = fbmE\(wispAdvected\.mul\(0\.00016\)[\s\S]*const wispWarp = fbmE\(wispAdvected\.mul\(0\.00031\)[\s\S]*const wispBend = fbmE\(wispAdvected\.mul\(0\.00009\)[\s\S]*const wispN = fbmE\(wispP\)/.test(skySource), 'high clouds use the organic domain-warped field and full world-wind advection');
ok(/const RING_ZFLAT\s*=\s*RING_R\s*\*\s*0\.84;[\s\S]*const RING_ZCREST\s*=\s*RING_R\s*\*\s*0\.98;[\s\S]*const RING_RISE\s*=\s*RING_R\s*\*\s*0\.07;[\s\S]*const RING_ZEND\s*=\s*RING_R\s*\*\s*0\.995;/.test(skySource),
    'Ringworld retains the recovered wide authored profile');
ok(/Math\.abs\(z\) - RING_ZFLAT[\s\S]*zq\.abs\(\)\.sub\(float\(RING_ZFLAT\)\)/.test(skySource),
    'Ringworld JS and TSL profiles remain centered and symmetric');
near(5000 * 0.84, 4200, 1e-9, 'Ringworld flat half-span');
near(5000 * 0.98, 4900, 1e-9, 'Ringworld curve crest');
near(5000 * 0.07, 350, 1e-9, 'Ringworld curve rise');
near(5000 * 0.995, 4975, 1e-9, 'Ringworld terminal fade');
ok(/const highCloudHit = Fn\([\s\S]*const flatY = u\.cloudStart\.add\(u\.cloudHeight\)\.add\(1000\)/.test(skySource)
    && /ringWispYAt = zq => ringDeckY\(zq\)\.sub\(RING_BASE\)\.add\(flatY\)/.test(skySource)
    && /step < 8[\s\S]*lo\.assign\(mid\)[\s\S]*hi\.assign\(mid\)/.test(skySource),
    'Ringworld high clouds retain preset semantic altitude with a bracketed curved-deck intersection');
ok(/const RING_VISIBLE_END = Math\.min\(RING_ZEND, RING_ZCREST\);[\s\S]*const RING_END_FADE = Math\.max\(RING_ARC_W \* 0\.20, 1\);/.test(skySource),
    'Ringworld cloud density ends on the crest with only the final fifth feathered');
ok(/const uLocalHalf = uniform\(opts\.ringLocalHalf \?\? 4000\);[\s\S]*const uWispCurveHalf = uniform\([\s\S]*\(opts\.ringLocalHalf \?\? 4000\) \* 0\.5/.test(skySource),
    'Ringworld local weather keeps its wide 4 km open-side half-width through the flat run');
ok(/const ringWispProgress = smoothstep\([\s\S]*float\(RING_ZFLAT\), float\(RING_VISIBLE_END\), p\.z\.abs\(\)[\s\S]*const ringWispHalf = mix\(uLocalHalf, uWispCurveHalf, ringWispProgress\);/.test(skySource),
    'Ringworld upper clouds taper from 4 km to 2 km only across the authored curved ends');
ok(/if \(rw && rw\.halfWidth\) uBandHalf\.value = rw\.halfWidth;[\s\S]*if \(rw && rw\.localHalf\) uLocalHalf\.value = rw\.localHalf;/.test(skySource)
    && !/uLocalHalf\.value = rw\.halfWidth/.test(skySource),
    'vista mesh width never shrink-wraps the local cloud volume');
ok(/const width =[\s\S]*const ends =[\s\S]*width\.mul\(ends\)/.test(skySource)
    && /wispAlpha = highCloudAlphaAt\([\s\S]*\.mul\(hit\.y\)\.mul\(wispRange\)/.test(skySource),
    'Ringworld high clouds retain shared curved-deck width/end containment');
ok(/smoothstep\(0\.55, 0\.85, u\.wispFilament\)/.test(skySource), 'sheet-to-cirrus style change crossfades');
ok(/cirrusPresence[\s\S]*cirrusTaper[\s\S]*cirrusBreakMask/.test(skySource), 'cirrus plume cells have finite envelopes and breakup');

const hashScreenBody = skySource.match(/const hashScreen = \(pIn\) => \{([\s\S]*?)\n\s*\};/)?.[1] ?? '';
const hash3Body = skySource.match(/const hash3 = \(pIn\) => \{([\s\S]*?)\n\s*\};/)?.[1] ?? '';
ok(hashScreenBody.length > 0 && !/\bsin\s*\(/.test(hashScreenBody), 'screen jitter hash is bounded and sin-free');
ok(hash3Body.length > 0 && !/\bsin\s*\(/.test(hash3Body), 'wisp/cirrus lattice hash is bounded and sin-free');
ok(/const stablePhase = opts\.stableCloudPhase \?\? opts\.worldRayDir;[\s\S]*\? float\(0\.5 \/ M_PASS\)[\s\S]*opts\.blueNoise[\s\S]*hashScreen\(screenCoordinate\.xy\)/.test(skySource), 'no-history optimized march uses deterministic centered strata before any screen-space phase');
ok(/cloudBody\(reflDir, reflRO, 1, float\(0\.5\)\)/.test(skySource), 'live reflected clouds use a deterministic midpoint instead of rerolling screen-pixel jitter under motion');
for (const path of ['src/weathersky.js', 'src/ringsky.js', 'src/shieldworld.js']) {
    ok(!/\b(?:dirJitter|outputDither)\s*:/.test(codeOnly(sources[path])), `${path} does not opt into legacy direction jitter or HDR dither`);
    ok(!/\btexSliceNoise\s*:/.test(codeOnly(sources[path])), `${path} does not opt into correlated texture-slice erosion`);
    ok(/stableCloudPhase:\s*!!worldRayDir/.test(sources[path]), `${path} selects stable centered strata for the current-frame optimized pass`);
}
ok(/weatherTex\.wrapS = weatherTex\.wrapT = T3\.RepeatWrapping;[\s\S]*weatherTex\.minFilter = weatherTex\.magFilter = T3\.LinearFilter/.test(skySource), 'shared high-layer weather fields use repeat-safe linear filtering');
ok(/densityBasisTex\.wrapS = densityBasisTex\.wrapT = densityBasisTex\.wrapR = T3\.RepeatWrapping;[\s\S]*densityBasisTex\.minFilter = densityBasisTex\.magFilter = T3\.LinearFilter/.test(skySource), 'optimized density basis uses trilinear repeat-safe filtering');
ok(/const fbmE = fbm3Cached \?\? \(opts\.texSliceNoise \? fbm3 : fbm3A\)/.test(skySource), 'production/no-cache erosion falls back to the artifact-free 3D ALU lattice');
ok(/atmoHeight\(p\)\.sub\(u\.cloudStart\)\.div\(max\(u\.cloudHeight, 1\)\)/.test(skySource), 'Ringworld light-cache lookup addresses normalized curved-deck cloud height');
ok(/ringDeckY\(flatP\.z\)\.add\(uvw\.y\.mul\(RING_THICK\)\.div\(ringCos\)\)/.test(skySource), 'Ringworld light-cache fill reconstructs the same curved physical deck');
ok(/const yMin = RING_R \? 0 :[\s\S]*const yMax = RING_R \? 1 :/.test(skySource), 'Ringworld gives the full cache Y resolution to its local cloud thickness');
ok(/const cachedDen = float\(0\)\.toVar\(\);[\s\S]*const directDen = float\(0\)\.toVar\(\);[\s\S]*sampleLightCache\(p\)[\s\S]*addMassLight\(directDen\)[\s\S]*den\.assign\(mix\(cachedDen, directDen, clamp\(u\.lightCacheDirect, 0, 1\)\)\)/.test(skySource),
    'Dark Storm smoothly replaces cached lighting with calibrated live cloud-mass marching');
ok(/\} else \{[\s\S]*const detailedDen = float\(0\)\.toVar\(\);[\s\S]*const massDen = float\(0\)\.toVar\(\);[\s\S]*addDetailedLight\(detailedDen\)[\s\S]*addMassLight\(massDen\)[\s\S]*mix\(detailedDen, massDen, clamp\(u\.lightCacheDirect, 0, 1\)\)/.test(skySource),
    'cache-disabled Dark Storm retains the same calibrated cloud-mass lighting semantics');
ok(/async prepareOptimizedCaches\(renderer, camera, force = false\) \{[\s\S]*u\.lightCacheDirect\.value >= 0\.999\) return false;/.test(skySource),
    'direct-light weather does not waste work filling the light cache');
ok(/async bakeEnv\(renderer, bopts = \{\}\) \{[\s\S]*u\.lightCacheDirect\.value < 0\.999/.test(skySource),
    'environment baking also respects the direct-light bypass');

// Preset setters only change uniforms. Every non-clear preset therefore uses
// the same compiled cloudBody graph and current-frame spatial compositor;
// quality changes its fixed budgets, never swaps in a separate rough shader.
const cloudBodySource = skySource.slice(
    skySource.indexOf('const cloudBody ='),
    skySource.indexOf('const cloudOut ='),
);
const highLayerSource = skySource.slice(
    skySource.indexOf('const highCloudAlphaAt ='),
    skySource.indexOf('const cloudBody ='),
);
const setCloudsSource = skySource.slice(
    skySource.indexOf('setClouds(name, over = {})'),
    skySource.indexOf('applyToLights({ sun, hemi, fog }'),
);
ok(cloudBodySource.length > 0 && highLayerSource.length > 0 && setCloudsSource.length > 0, 'shared cloud graph and preset setter are statically discoverable');
ok(/const M_PASS = Math\.max\(1, passesIn \?\? opts\.cloudPasses \?\? 8\)/.test(cloudBodySource), 'all presets share the same fixed multi-pass marcher');
ok(!/\bnew\s+T3\.|\.colorNode\s*=|\.opacityNode\s*=/.test(codeOnly(setCloudsSource)), 'preset changes do not replace the optimized cloud material graph');
for (const key of ['wispOn', 'wispScale', 'wispThreshold', 'wispStrength', 'wispOpacity', 'wispFloor', 'wispStretch', 'wispFilament']) {
    ok(highLayerSource.includes(`u.${key}`), `2D/high shader consumes authored ${key}`);
}
ok(/u\.wispFloor\.value = p\.wispFloor \?\? 0/.test(setCloudsSource), 'preset/weather setter authors the canopy floor');
ok(/u\.lightCacheDirect\.value = p\.lightCacheDirect \?\? 0/.test(setCloudsSource), 'preset/weather setter authors the light-cache routing mode');
ok(/cloudDim\.value = Math\.max\(0\.1, 1 - \(1 - w\.sunDim\) \* k\);[\s\S]*const authoredCloudRadiance = w\.cloudRadiance \?\? w\.sunDim;[\s\S]*cloudRadiance\.value = Math\.max\(0\.1, 1 - \(1 - authoredCloudRadiance\) \* k\)/.test(weatherSource),
    'weather can preserve cloud readability without lifting scene sunlight');
ok(!/\bmarchDither\b/.test(skySource + weatherSource),
    'the ineffective screen-space density dither cannot return');
ok(/const DIRECT_LIGHT_MASS_SCALE = 0\.25;[\s\S]*const addDetailedLight = \(target\)[\s\S]*cheapDensity\([\s\S]*const addMassLight = \(target\)[\s\S]*smoothDensity\(p\.add\(u\.cloudLightDir\.mul\(stepL\)\.mul\(j0\.add\(j\)\)\)\)\.mul\(DIRECT_LIGHT_MASS_SCALE\)/.test(skySource),
    'Dark Storm live lighting samples a calibrated low-frequency cloud mass instead of erosion froth');
ok(/const jitK = fract\(baseJit\.add\(k \/ M_PASS\)\)[\s\S]*lightRay\([\s\S]*baseJit\.mul\(73\.1063\)[\s\S]*stepH\)\.mul\(baseJit\.mul\(0\.5\)\.add\(0\.3\)\)/.test(skySource),
    'visible, direct-light, shaft, and rain phases remain deterministic and uncoupled');
ok(/radiance = ambGrey\.add\(u\.cloudLightColor\.mul\(intensity\)\.mul\(celestialK\)\)[\s\S]{0,160}\.mul\(u\.cloudRadiance\)(\.mul\(u\.cloudRadianceScale\))?\.add\(canopySkylight\)\.mul\(s\.density\)[\s\S]*wispColor\)\.mul\(wispAlpha\)\.mul\(u\.cloudRadiance\)/.test(skySource)
    && /const celestialK = clamp\(u\.celestialVisibility, 0, 1\)/.test(skySource)
    && /const canopyGate = smoothstep\(0\.6, 0\.98, u\.stormCanopy\)[\s\S]{0,40}?float\(1\)\.sub\(celestialK\)/.test(skySource)
    && /canopySkylight = vec3\([\s\S]{0,160}?\.mul\(canopyGate\)/.test(skySource)
    && /const ambGrey = mix\(\s*amb,[\s\S]{0,120}?canopyGate,\s*\)/.test(skySource),
    'cloud-form readability stays on cloudRadiance; a sealed canopy removes direct sun, greys the blue skylight ambient, and substitutes a dim neutral canopy skylight');
ok(/const canopyField = smoothstep\([\s\S]*wispPatch\.mul\(0\.72\)\.add\(wispBend\.add\(0\.44\)\.mul\(0\.28\)\)[\s\S]*const canopyDetail = smoothstep\(0\.20, 0\.82, wispN\)\.mul\(0\.45\)\.add\(0\.55\);[\s\S]*const canopyShape = max\(wispShape, canopyField\.mul\(u\.wispFloor\)\.mul\(canopyDetail\)\);[\s\S]*return min\(canopyShape/.test(highLayerSource),
    'severe canopy coverage comes from the organic low-frequency field');
ok(!/max\(wispShape,\s*u\.wispFloor\)/.test(codeOnly(highLayerSource)),
    'wispFloor cannot return as a constant-opacity canopy');

// The high layer is authored with the volume rather than being one universal
// grey card: cumulus is warm/broken, stratus is broad/cool, and cirrus switches
// to sparse, strongly anisotropic finite ice plumes.
ok(PRESETS.cumulus.wispFilament < 0.55 && PRESETS.cumulus.wispTint[0] > PRESETS.cumulus.wispTint[2], 'cumulus high layer is a warm broken sheet');
ok(PRESETS.stratus.wispFilament < 0.55 && PRESETS.stratus.wispStretch[0] >= 0.8 && PRESETS.stratus.wispTint[2] > PRESETS.stratus.wispTint[0], 'stratus high layer is a broad cool sheet');
ok(PRESETS.cirrus.wispFilament > 0.85 && PRESETS.cirrus.wispStretch[2] / PRESETS.cirrus.wispStretch[0] > 20, 'cirrus high layer selects long narrow ice plumes');
ok(/const cirrusCellP = wispAdvected\.xz\.mul\([^)]+\);[\s\S]*const cirrusLocal = fract\(cirrusCellP\)[\s\S]*const cirrusPresence = smoothstep/.test(skySource), 'cirrus uses advected finite cells rather than an infinite stripe field');
ok(/const cirrusCoreW =[\s\S]*\.mul\(0\.34\)/.test(skySource), 'cirrus keeps a visible feathered core after optimized downsampling');
ok(/const cirrusPlumeW = cirrusWidth\.mul\(2\.85\)[\s\S]*wispN\.mul\(0\.08\)\.add\(0\.12\)/.test(skySource), 'cirrus carries a broad varied translucent plume around its fibers');
ok(/const cirrusPresence = smoothstep\(0\.20, 0\.48, cirrusPresenceR\)/.test(skySource), 'cirrus cell population is dense enough to read as a varied veil');
ok(/const updateWispColor = \(\) => \{[\s\S]*u\.wispColor\.value\.set\(\.\.\.pal\.sun\)\.lerp\(_neutral, 0\.62\)[\s\S]*\.multiply\(u\.wispTint\.value\)/.test(skySource)
    && /const _neutral = V\(pal\.sun\[0\] \/ _pk, pal\.sun\[1\] \/ _pk, pal\.sun\[2\] \/ _pk\)/.test(skySource),
    'high-cloud radiance follows live TOD light, desaturating toward the star chromaticity, with its authored style tint');
ok(/col\.addAssign\(Tr\.mul\(u\.wispColor\)\.mul\(wispAlpha\)\.mul\(u\.cloudRadiance\)(\.mul\(u\.cloudRadianceScale\))?\)/.test(skySource), 'high-cloud RGB is premultiplied by its real coverage');
ok(/premultipliedAlpha: false,[\s\S]*blendSrc: T3\.OneFactor,[\s\S]*blendDst: T3\.OneMinusSrcAlphaFactor/.test(skySource), 'cloud dome uses one-pass premultiplied blending without double-darkening thin sheets');
ok(!/(?:ringWispGeo|ringWispMat|ringworld_curved_high_cloud_sheet|scene\.add\(ringWisp\))/.test(codeOnly(skySource)), 'no standalone Ringworld high-cloud mesh can return');
ok(/domes:\s*\[bgDome, cloudDome\]/.test(skySource), 'high clouds share the owned cloud dome');

// Ringworld has one cloud owner: the shared high/volumetric field above.
// A second cylinder used to overlap it with unrelated satellite morphology
// and could leak opacity even when its nominal coverage was zero.
const ringEngineCode = codeOnly(ringEngineSource);
// The prealpha backport reintroduced a ring cloud sheet BY DESIGN — a
// satellite-imagery deck on the distant band. The invariant is no longer
// "none exists" but "it is slaved to the shared weather state": coverage
// derives from the live largeT uniform and greying from the weather def,
// so it can never disagree with the local volumetric field's weather.
ok(/RING CLOUD LAYER/.test(ringEngineSource)
    && /cu\.grey\.value = \(wx\.state\.def\.grey \?\? 0\) \* \(wx\.state\.k \?\? 1\)/.test(ringEngineCode)
    && /cu\.cover\.value = Math\.max\(0, Math\.min\(1, 1 - U\.largeT\.value\)\)/.test(ringEngineCode),
    'the Ringworld cloud sheet is slaved to the shared weather state rather than running an independent weather vocabulary');
ok(/the shared sky cloud field is a CAMERA-CENTERED dome and so[\s\S]{0,120}cannot reach the far arc/.test(ringEngineSource)
    && /The near fade above keeps it out of[\s\S]{0,20}\/\/ the local scene, where the volumetric deck is the right owner/.test(ringEngineSource),
    'Ringworld cloud ownership split is documented: sheet owns the far arc/overhead crossing, volumetric deck owns the local scene');
ok(PRESETS.clear.finalMul === 0 && PRESETS.clear.wispOn === 0
    && PRESETS.clear.wispStrength === 0 && PRESETS.clear.wispOpacity === 0,
    'Clear Sky zeros volume density and every upper-layer visibility term');
ok(/cloudDome\.visible = p\.finalMul > 0 \|\| p\.wispOn > 0/.test(skySource),
    'settled Clear Sky removes the shared cloud dome entirely');

// Optimized composition is current-frame spatial reconstruction, never the
// old camera-pinned temporal feedback path. Both targets are refreshed with
// the current camera before their same-frame screen-UV composite.
const spatialCode = codeOnly(spatialSource);
ok(!/\b(?:historyTarget|historyTexture|previousFrame|prevFrame|reproject(?:ion)?|feedbackTexture|accumulationTexture)\b/i.test(spatialCode), 'spatial compositor contains no temporal history or reprojection state');
ok(/const backgroundTarget = makeTarget\('eanpa_current_spatial_background'\);[\s\S]*const cloudTarget = makeTarget\('eanpa_current_spatial_clouds'\);/.test(spatialSource), 'background and cloud use separate current-frame targets');
ok(/await sky\.prepareOptimizedCaches\?\.\(renderer, camera\);[\s\S]*backgroundProxy\.position\.copy\(camera\.position\);[\s\S]*proxy\.position\.copy\(camera\.position\);/.test(spatialSource), 'spatial pass updates cache/proxy state from the current camera');
ok(/renderer\.setRenderTarget\(backgroundTarget\);[\s\S]*await renderer\.renderAsync\(backgroundScene, camera\);[\s\S]*renderer\.setRenderTarget\(cloudTarget\);[\s\S]*await renderer\.renderAsync\(cloudScene, camera\);/.test(spatialSource), 'both current-frame targets are freshly rendered every spatial pass');
ok(/T3\.texture\(backgroundTarget\.texture\)\.sample\(T3\.screenUV\)/.test(spatialSource), 'background proxy composites the current background texture');
ok(/const source = T3\.texture\(cloudTarget\.texture\);[\s\S]*source\.sample\(T3\.screenUV\)/.test(spatialSource), 'cloud proxy composites the current cloud texture');
ok((spatialSource.match(/frameJit\.value = 0/g) ?? []).length >= 2, 'spatial attach and render both pin temporal jitter to zero');
ok(/backgroundProxy\.renderOrder = -100;[\s\S]*proxy\.renderOrder = -98;/.test(spatialSource), 'spatial proxies preserve the background/ring/cloud authored order');
ok(/ring\.group\.traverse\([\s\S]*o\.renderOrder = -99;[\s\S]*scene\.add\(ring\.group\)/.test(sources['src/ringsky.js']), 'Ringworld band remains between the background and shared local clouds');
ok(!/ring\.clouds/.test(codeOnly(sources['src/ringsky.js'])), 'Ringworld wrapper cannot restore a second far-cloud owner');
ok(/const screenRayDir = \(\) => \{[\s\S]*T3\.getViewPosition\(T3\.screenUV, float\(0\.5\), u\.projInv\)[\s\S]*u\.camWorld\.mul\(vec4\(normalize\(vp\), 0\)\)\.xyz/.test(skySource), 'sky directions reconstruct from current screen UV and camera matrices');
ok(/const cloudOut = Fn\(\(\) => cloudBody\(screenRayDir\(\), cameraPosition\)\)/.test(skySource), 'cloud dome uses current-frame direction reconstruction');
ok(/const bgOut = Fn\(\(\) => bgBody\(screenRayDir\(\)\)\)/.test(skySource), 'background dome uses current-frame direction reconstruction');
ok(/u\.projInv\.value\.copy\(camera\.projectionMatrixInverse\);[\s\S]*u\.camWorld\.value\.copy\(camera\.matrixWorld\);/.test(skySource), 'camera matrices are refreshed during every sky update');
ok(/backgroundDome\.material\.toneMapped = false[\s\S]*cloudDome\.material\.toneMapped = false/.test(spatialSource), 'optimized target preserves linear HDR sky/high-layer color');
ok(/proxyMaterial\.toneMapped = true/.test(spatialSource), 'optimized cloud proxy tone-maps exactly once with the local scene');
ok(/backgroundDome\.material\.toneMapped = originalBackgroundToneMapped[\s\S]*cloudDome\.material\.toneMapped = originalCloudToneMapped/.test(spatialSource), 'optimized pass restores authored tone-map state on disposal');

// Quality profiles alter sky/weather budgets only, with every element kept.
// Fixed divisors are deliberately not runtime-adaptive: a full-scene timing
// loop used to punish clouds for vegetation/post cost or unrelated GPU load.
const qualityProfiles = new Map();
for (const [name, expectedFps, expectedSky, expectedLight, expectedPasses, expectedDivisor, expectedRain, expectedSplashes] of [
    ['high', 30, 60, 18, 5, 1, 16000, 1100],
    ['balanced', 60, 44, 14, 3, 2, 10000, 700],
    ['performance', 120, 20, 6, 2, 3, 5500, 320],
]) {
    const match = sources['src/main.js'].match(new RegExp(
        `${name}:\\s*\\{[\\s\\S]*?fpsTarget:\\s*(\\d+)[\\s\\S]*?skySamples:\\s*(\\d+),\\s*lightSamples:\\s*(\\d+),\\s*cloudPasses:\\s*(\\d+),\\s*cloudDiv:\\s*(\\d+)[\\s\\S]*?reflectionBake:\\s*\\{[\\s\\S]*?cloudPasses:\\s*(\\d+)[\\s\\S]*?weather:\\s*\\{\\s*rainCount:\\s*(\\d+),\\s*splashCount:\\s*(\\d+),\\s*transitionSeconds:\\s*(\\d+)`,
    ));
    ok(match, `${name} quality profile exists`);
    equal(Number(match[1]), expectedFps, `${name} FPS target`);
    equal(Number(match[2]), expectedSky, `${name} fixed visible sky samples`);
    equal(Number(match[3]), expectedLight, `${name} fixed cloud-light samples`);
    equal(Number(match[4]), expectedPasses, `${name} fixed visible cloud passes`);
    equal(Number(match[5]), expectedDivisor, `${name} fixed cloud divisor`);
    ok(Number(match[6]) > 0, `${name} keeps cloud reflections`);
    equal(Number(match[7]), expectedRain, `${name} fixed nonzero rain population`);
    equal(Number(match[8]), expectedSplashes, `${name} fixed nonzero splash population`);
    equal(Number(match[9]), 45, `${name} keeps the full transition duration`);
    qualityProfiles.set(name, {
        skySamples: Number(match[2]),
        lightSamples: Number(match[3]),
        cloudPasses: Number(match[4]),
        cloudDiv: Number(match[5]),
        reflectionPasses: Number(match[6]),
        rainCount: Number(match[7]),
        splashCount: Number(match[8]),
    });
}
for (const presetName of ['cumulus', 'stratus', 'cirrus']) {
    for (const [qualityName, profile] of qualityProfiles) {
        ok(
            profile.skySamples > 0 && profile.lightSamples > 0
                && profile.cloudPasses > 0 && profile.cloudDiv > 0,
            `${presetName}/${qualityName} retains the shared smooth current-frame cloud path`,
        );
    }
}
ok(/spatialCandidate = q\.cloudDiv[\s\S]*makeSpatialCloudPass\(THREE, renderer, camera, \{ div: q\.cloudDiv \}\)[\s\S]*spatialCandidate\?\.attach\(scene, active\.sky\)/.test(mainSource), 'every nonzero fixed tier attaches the same current-frame spatial compositor');
ok(!/cloudDivMax|updateSkyAdaptive/.test(sources['src/main.js']), 'no full-scene adaptive cloud degradation remains');
ok(!/\.setDivisor\s*\(/.test(codeOnly(sources['src/main.js'])), 'runtime never mutates the selected fixed cloud divisor');
ok(!/cloudgraph/i.test(codeOnly(sources['src/main.js'])), 'active app never imports the obsolete temporal cloud graph');
ok(/import\('\.\/cloudspatial\.js'\)/.test(sources['src/main.js']), 'active app imports the current-frame spatial compositor through one canonical ESM URL');
ok(/mode:\s*'fixed-clean-benchmark'/.test(sources['src/main.js']), 'cloud resolution policy is explicitly fixed');
ok(/makeDesertDressing[\s\S]*quality:\s*'balanced'[\s\S]*makeVegetationScene[\s\S]*quality:\s*'balanced'/.test(sources['src/main.js']), 'local dressing and vegetation use authored fixed quality');
const qualityMarkup = indexSource.match(/<select id="quality">([\s\S]*?)<\/select>/)?.[1] ?? '';
equal([...qualityMarkup.matchAll(/option value="([^"]+)"/g)].map((match) => match[1]), ['high', 'balanced', 'performance'], 'quality UI exposes exactly High/Balanced/Performance');
ok(!/cinematic/i.test(qualityMarkup), 'removed Cinematic mode cannot be selected');
ok(/document\.getElementById\('quality'\)\.addEventListener\('change', buildSkybox\)/.test(mainSource), 'quality selector only rebuilds the scoped sky stack');
ok(/makeReflectionPipeline\([\s\S]*active\.sky, 'balanced'/.test(mainSource), 'sky quality never lowers local SSR/N8AO/bloom quality');
ok(/reflectionPipeline\.setAOEnabled\?\.\(aoPreference\)/.test(mainSource), 'AO preference is restored after every sky-quality rebuild');
for (const token of ['const temple = await makeTempleScene', 'const dressing = await makeDesertDressing', 'const vegetation = await makeVegetationScene']) {
    ok(mainSource.indexOf(token) >= 0 && mainSource.indexOf(token) < mainSource.indexOf('const QUALITY ='), `${token.split(' =')[0].replace('const ', '')} is constructed outside the quality rebuild`);
}
const buildSkyboxSource = mainSource.slice(
    mainSource.indexOf('async function buildSkybox()'),
    mainSource.indexOf("document.getElementById('skybox').addEventListener"),
);
for (const localRoot of ['terrain', 'temple', 'dressing', 'vegetation']) {
    ok(!new RegExp(`${localRoot}\\.dispose`).test(codeOnly(buildSkyboxSource)), `quality rebuild never disposes local ${localRoot}`);
}
for (const path of ['engine/weather_system.js', 'engine/sky_system.js', 'engine/ringworld.js', 'src/weathersky.js', 'src/ringsky.js', 'src/shieldworld.js']) {
    ok(!/if\s*\([^)]*quality(?:\.name)?[^)]*\)/i.test(sources[path]), `${path} has no quality-driven element-removal branch`);
}
for (const path of ['src/weathersky.js', 'src/ringsky.js', 'src/shieldworld.js']) {
    for (const key of ['skySamples', 'lightSamples', 'cloudPasses', 'densityCache', 'lightCache']) {
        ok(sources[path].includes(`${key}: quality.${key}`), `${path} forwards the fixed ${key} budget`);
    }
}
ok(/const hit = highCloudHit\(org, dir\)/.test(skySource), 'Ringworld high clouds use the shared quality-independent curved field');

// One lazy controller supplies identical weather semantics to every celestial
// skybox while Cloud Type remains an independent persisted state axis.
ok(/export async function makeLazyWeatherAttachment/.test(wrapperSource), 'shared lazy weather attachment is exported');
ok(/selectedCloudPreset = name;[\s\S]*if \(requestedWeatherState !== 'none'\) return true;/.test(wrapperSource), 'active weather preserves itself while Cloud Type updates the persisted None target');
ok(/sky\.transitionClouds\(name, transitionSeconds\)/.test(wrapperSource), 'Weather=None routes Cloud Type through the continuous sky morph');
ok(/totalFallDistance|fallPhase/.test(weatherSource), 'shared attachment retains the integrated downward rain engine');
for (const path of ['src/ringsky.js', 'src/shieldworld.js']) {
    const source = sources[path];
    ok(/import \{ makeLazyWeatherAttachment \} from '\.\/weathersky\.js';/.test(source), `${path} imports the shared lazy weather attachment`);
    ok(/supportsWeather:\s*true/.test(source), `${path} exposes functional weather`);
    ok(/setCloudPreset\(name, onTransitionStart\)/.test(source), `${path} exposes independent Cloud Type changes`);
    ok(/setWeather\(state, onTransitionStart\)/.test(source), `${path} exposes direct weather transitions`);
    ok(/weatherAttachment\.update\(t\)/.test(source), `${path} advances the real weather system every frame`);
    ok(/weatherAttachment\.applyLightDim\(\)/.test(source), `${path} applies weather attenuation after celestial lighting`);
}
ok(/ring\.bindWeather\(weatherAttachment, sky\)/.test(sources['src/ringsky.js']), 'Ringworld far clouds bind the stable live-weather facade');
ok(/o\.userData\.noWet = true/.test(sources['src/ringsky.js']), 'Ringworld sky structure is excluded from local wetness wrapping');
ok(/moon\.traverse[\s\S]*o\.userData\.noWet = true;[\s\S]*o\.userData\.noCloudShadow = true;/.test(shieldSource), 'Shieldworld moon remains a celestial body under lazy weather wrapping');

// Ringworld water motion is a preserved skybox element in every tier. The
// realtime wrapper selects two filtered reads of the existing normal texture;
// it never selects the heavier procedural field and never disables waves.
const ringWrapperSource = sources['src/ringsky.js'];
ok(/loadRingRelief/.test(ringWrapperSource) && /\.\.\.relief/.test(ringWrapperSource), 'Ringworld consumes paired height and derived normal/AO from the validated relief payload');
ok(/opts: \{ waves: 'lightweight', planetShineColor: \[1\.00, 0\.92, 0\.82\]/.test(ringWrapperSource), 'Ringworld wrapper always selects lightweight animated water with the authored planet-shine');
ok(/loadRingRelief\(THREE\)/.test(ringWrapperSource)
    && /globalThis\.parallaxOcclusionUV \?\?= \(await import\('\.\/parallax_occlusion\.js'\)\)\.parallaxOcclusionUV/.test(ringWrapperSource),
    'Ringworld band arms the engine SPOM gate: height field supplied and parallaxOcclusionUV installed before makeRingworld');
ok(!/waves:\s*false/.test(codeOnly(ringWrapperSource)), 'Ringworld wrapper never removes the water-wave element');
ok(!/waves:\s*quality|quality[^\n]*waves|waves[^\n]*quality/i.test(codeOnly(ringWrapperSource)), 'Ringworld water mode is independent of sky quality');
ok(/const waterWaveMode = opts\.waves === false \? 'off'[\s\S]*opts\.waves === 'lightweight' \? 'lightweight' : 'full'/.test(ringEngineSource), 'Ringworld engine exposes an explicit lightweight wave path');
ok(/const waveClock = tU\.mul\(opts\.lightweightWaveSpeed \?\? 0\.0065\);[\s\S]*waveUv0[\s\S]*waveUv1/.test(ringEngineSource), 'lightweight water has two independently scrolling normal fields');
ok((ringEngineSource.match(/texture\(lightweightWaveTexture, waveUv[01]\)/g) ?? []).length === 2, 'lightweight water costs exactly two existing-normal texture reads');
ok(/const Tn = T3\.normalize\(vec3\(0, posL\.z\.negate\(\), posL\.y\)\);[\s\S]*const Bn = vec3\(1, 0, 0\);[\s\S]*const Nn = opts\.analyticBandNormal === false\s*\? T3\.normalLocal\s*: T3\.normalize\(vec3\(float\(0\), posL\.y, posL\.z\)\)\.negate\(\);/.test(ringEngineSource),
    'water normals use the analytic cylindrical tangent frame (explicit authored-normal comparison escape)');
ok(/mix\(float\(1\), float\(0\.42\), farK\)/.test(ringEngineSource), 'distant water retains a nonzero moving-normal floor');
ok(/const waterNight = vec3\(0\.30, 0\.36, 0\.55\)\.mul\(glintW\)[\s\S]*\.mul\(k\)\.mul\(float\(1\)\.sub\(A\.dayF\)\)[\s\S]*bandMat\.emissiveNode = bandMat\.emissiveNode\.add\(waterNight\)/.test(ringEngineSource), 'night water glint remains animated, water-masked, and night-gated');
ok(/waterWaveMode,[\s\S]*waterWavesActive,/.test(ringEngineSource), 'Ringworld exposes water-wave mode and activation state for live acceptance');
ok(/globalThis\._ringworld = ring;/.test(ringWrapperSource) && /globalThis\._ringworld === ring/.test(ringWrapperSource), 'Ringworld wave diagnostics are live-inspectable and cleared on disposal');

function compileWeatherModule() {
    const transformed = wrapperSource
        .replace('export async function makeLazyWeatherAttachment', 'async function makeLazyWeatherAttachment')
        .replace('export async function makeWeatherSky', 'async function makeWeatherSky');
    return Function(`${transformed}\nreturn { makeLazyWeatherAttachment, makeWeatherSky };`)();
}

async function withGlobals(names, body) {
    const saved = names.map((name) => [name, Object.hasOwn(globalThis, name), globalThis[name]]);
    try { return await body(); }
    finally {
        for (const [name, had, value] of saved) {
            if (had) globalThis[name] = value;
            else delete globalThis[name];
        }
    }
}

const fakeScene = () => ({ fog: null, traverse() {} });
const fakeSky = (events = []) => ({
    state: { preset: 'cumulus', palette: { star: 1 } }, uniforms: {},
    setTime() {}, update() {}, applyToLights() {}, dispose() {}, wrapCloudShadows() {},
    setClouds(name) { events.push(['cloud-set', name]); this.state.preset = name; },
    transitionClouds(name, duration) { events.push(['cloud-transition', name, duration]); this.state.preset = 'transition'; return true; },
});
const fakeWeather = (events) => ({
    WEATHER: { clear: { clouds: 'clear', over: {}, rain: 0, wet: 0, lightning: 0 } },
    state: { name: 'clear' }, uniforms: { rainK: { value: 0 } }, bolt: { intensity: 0 },
    setWeather(name, k) { events.push(['set', name, k]); this.state.name = name; },
    transitionTo(name, k, duration) { events.push(['transition', name, k, duration]); this.state.name = name; },
    wrapScene() { events.push(['wrap']); }, update() {}, sunDim() { return 1; }, dispose() {},
});

// Execute the real wrapper with inert scene/sky objects: direct changes never
// pass through None, and the latest async request wins.
await withGlobals(['loadImageTexture', 'makeSkySystem', 'makeWeatherSystem', '_weather', '_sky', 'eanpaStripMrt'], async () => {
    const events = [];
    const made = fakeWeather(events);
    globalThis.loadImageTexture = async () => ({});
    globalThis.makeSkySystem = async () => fakeSky(events);
    const loadEngine = async (name) => { if (name === 'weather_system.js') globalThis.makeWeatherSystem = async () => made; };
    const { makeWeatherSky } = compileWeatherModule();
    const skybox = await makeWeatherSky({
        THREE: {}, scene: fakeScene(), camera: {}, sun: { intensity: 1 }, hemi: { intensity: 1 },
        loadEngine, quality: { skySamples: 1, lightSamples: 1, cloudPasses: 1, weather: { transitionSeconds: 45 } }, hours: 12,
    }, 'cirrus', 'rain');
    equal(events.filter((e) => e[0] === 'set'), [['set', 'rain', 1]], 'initial weather applies once');
    equal(made.WEATHER.none.clouds, 'cirrus', 'None restores the selected base cloud style');
    skybox.setCloudPreset('stratus');
    equal(made.WEATHER.none.clouds, 'stratus', 'Cloud Type updates the persisted None target under active weather');
    equal(events.filter((e) => e[0] === 'cloud-transition'), [], 'Cloud Type does not cancel or replace active weather');
    skybox.setWeather('darkstorm');
    skybox.setWeather('none');
    equal(events.filter((e) => e[0] === 'transition'), [
        ['transition', 'darkstorm', 1, 45],
        ['transition', 'none', 1, 45],
    ], 'direct weather changes morph straight to their targets');
    skybox.dispose();
});

await withGlobals(['loadImageTexture', 'makeSkySystem', 'makeWeatherSystem', '_weather', '_sky', 'eanpaStripMrt'], async () => {
    const events = [];
    const made = fakeWeather(events);
    let releaseWeather;
    const weatherGate = new Promise((resolve) => { releaseWeather = resolve; });
    globalThis.loadImageTexture = async () => ({});
    globalThis.makeSkySystem = async () => fakeSky(events);
    const loadEngine = async (name) => {
        if (name === 'weather_system.js') {
            await weatherGate;
            globalThis.makeWeatherSystem = async () => made;
        }
    };
    const { makeWeatherSky } = compileWeatherModule();
    const skybox = await makeWeatherSky({
        THREE: {}, scene: fakeScene(), camera: {}, sun: { intensity: 1 }, hemi: { intensity: 1 },
        loadEngine, quality: { skySamples: 1, lightSamples: 1, cloudPasses: 1, weather: { transitionSeconds: 45 } }, hours: 12,
    }, 'cumulus', 'none');
    skybox.setCloudPreset('cirrus');
    equal(events.filter((e) => e[0] === 'cloud-transition'), [['cloud-transition', 'cirrus', 45]], 'Weather=None morphs Cloud Type in place for the full duration');
    skybox.setWeather('rain');
    skybox.setWeather('darkstorm');
    skybox.setWeather('none');
    releaseWeather();
    for (let i = 0; i < 8; i++) await new Promise((resolve) => setImmediate(resolve));
    equal(events.filter((e) => e[0] === 'transition'), [['transition', 'none', 1, 45]], 'None continuously retargets a stale in-flight weather activation');
    skybox.setWeather('darkstorm');
    equal(events.filter((e) => e[0] === 'transition'), [
        ['transition', 'none', 1, 45],
        ['transition', 'darkstorm', 1, 45],
    ], 'loaded weather accepts the next direct request without a reset state');
    skybox.dispose();
});

function compileAudioSystem() {
    const transformed = audioSource
        .replace("import { blendAmbienceLoop } from './audio_loop.js';", '')
        .replace("const ASSET_ROOT = new URL('../assets/audio/', import.meta.url);", "const ASSET_ROOT = new URL('file:///assets/audio/');")
        .replace('export function makeAudioSystem', 'function makeAudioSystem');
    return Function('blendAmbienceLoop', `${transformed}\nreturn makeAudioSystem;`)(blendAmbienceLoop);
}

class Param {
    constructor(value = 0) { this.value = value; this.targets = []; }
    cancelScheduledValues() {}
    setTargetAtTime(value, time, smoothing) { this.value = value; this.targets.push({ value, time, smoothing }); }
    setValueAtTime(value) { this.value = value; }
    linearRampToValueAtTime(value) { this.value = value; }
}
class Node {
    constructor() { this.connections = []; }
    connect(target) { this.connections.push(target); return target; }
}
class Source extends Node {
    constructor() { super(); this.playbackRate = { value: 1 }; this.starts = []; this.loop = false; }
    start(when = 0, offset = 0) { this.starts.push({ when, offset }); }
    stop() {}
}
class Vec3 {
    constructor(x = 0, y = 0, z = 0) { this.set(x, y, z); this.isVector3 = true; }
    set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
    clone() { return new Vec3(this.x, this.y, this.z); }
    copy(v) { return this.set(v.x, v.y, v.z); }
    applyQuaternion() { return this; }
}
class FakeAudioContext {
    static last = null;
    constructor() {
        FakeAudioContext.last = this;
        this.state = 'running'; this.currentTime = 10; this.destination = new Node();
        this.gains = []; this.sources = []; this.panners = [];
        this.listener = Object.fromEntries(['positionX', 'positionY', 'positionZ', 'forwardX', 'forwardY', 'forwardZ', 'upX', 'upY', 'upZ'].map((key) => [key, new Param()]));
    }
    createGain() { const node = new Node(); node.gain = new Param(); this.gains.push(node); return node; }
    createBufferSource() { const node = new Source(); this.sources.push(node); return node; }
    createPanner() {
        const node = new Node();
        node.positionX = new Param(); node.positionY = new Param(); node.positionZ = new Param();
        this.panners.push(node); return node;
    }
    createBiquadFilter() { const node = new Node(); node.frequency = new Param(); node.Q = new Param(); return node; }
    createBuffer(numberOfChannels, length, sampleRate) {
        const channels = Array.from({ length: numberOfChannels }, () => new Float32Array(length));
        return { numberOfChannels, length, sampleRate, duration: length / sampleRate,
            getChannelData: channel => channels[channel] };
    }
    async decodeAudioData() { return this.createBuffer(2, 4000, 1000); }
    async resume() { this.state = 'running'; }
    async close() { this.state = 'closed'; }
}

await withGlobals(['AudioContext', 'webkitAudioContext', 'fetch', 'addEventListener', 'removeEventListener', '_weather', '_movementState'], async () => {
    globalThis.AudioContext = FakeAudioContext;
    delete globalThis.webkitAudioContext;
    globalThis.fetch = async () => ({ ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(8) });
    globalThis.addEventListener = () => {};
    globalThis.removeEventListener = () => {};
    const camera = { position: new Vec3(0, 2, 0), quaternion: {}, updateMatrixWorld() {} };
    const audio = compileAudioSystem()({ camera });
    equal(await audio.unlock({ isTrusted: true }), true, 'audio unlock succeeds after a trusted gesture');
    for (let i = 0; i < 20 && audio.stats.loaded < audio.stats.expected; i++) await new Promise((resolve) => setImmediate(resolve));
    equal(audio.stats.loaded, audio.stats.expected, 'all mocked audio assets decode');
    const context = FakeAudioContext.last;
    const rainSource = context.sources.find((source) => source.loop);
    ok(rainSource, 'rain loop starts after decode');
    equal([rainSource.loopStart, rainSource.loopEnd], [0, 3.82], 'rain source loops the complete seam-blended buffer');

    globalThis._weather = { uniforms: { rainK: { value: 0.5 } }, state: {}, bolt: { intensity: 0 } };
    audio.update(0.016, 20, null);
    const rainParam = context.gains[3].gain.targets.at(-1);
    near(rainParam.value, 0.18, 1e-12, 'rain gain follows the live interpolated intensity');
    equal(rainParam.smoothing, 1.4, 'rain fades in smoothly');
    globalThis._weather.uniforms.rainK.value = 0;
    audio.update(0.016, 21, null);
    equal(context.gains[3].gain.targets.at(-1).smoothing, 2.8, 'rain fades out smoothly');

    globalThis._weather = {
        uniforms: { rainK: { value: 1 } },
        state: { strike: { id: 1, x: 100, y: 2, z: 0, flash: 1, local: true } },
        bolt: { intensity: 60000 },
    };
    const beforeThunder = context.sources.length;
    audio.update(0.016, 23, null);
    equal(audio.stats.lastEvent, 'thunderClose', 'a visible nearby strike triggers close thunder');
    equal(context.sources.length, beforeThunder + 2,
        'a local strike schedules one explosive blast and one rolling tail');
    near(context.sources.at(-2).starts[0].when, 10 + 100 / 343, 1e-12,
        'explosive blast uses exact 3D speed-of-sound delay');
    near(context.sources.at(-1).starts[0].when, 10 + 100 / 343 + 0.35, 1e-12,
        'rolling tail blends in behind the blast on the same propagation clock');
    equal(audio.stats.thunder.cracks, 1, 'local thunder exposes one crack layer in diagnostics');
    audio.update(0.016, 25, null);
    equal(context.sources.length, beforeThunder + 2, 'one strike schedules thunder only once');
    globalThis._weather.state.strike = { id: 2, x: 686, y: 2, z: 0, flash: 1, local: false };
    audio.update(0.016, 27, null);
    equal(audio.stats.lastEvent, 'thunderDistant', 'a new distant strike selects distant thunder');
    near(context.sources.at(-1).starts[0].when, 12, 1e-12, 'distant thunder retains distance delay');
    for (let id = 3; id <= 11; id++) {
        globalThis._weather.state.strike = {
            id, x: 220 + id, y: 2, z: 0, flash: 1, local: false,
        };
        audio.update(0.016, 27 + id, null);
    }
    equal(audio.stats.thunder.activeBodies, 6,
        'long thunder bodies remain at the fixed runtime voice cap');
    await audio.dispose();
});

// Shieldworld moon is both night- and elevation-gated; star pollution must be
// derived from TOD rather than compounded frame over frame.
ok(/const visibility = nightEase \* extEase;[\s\S]*moonFade\.value = visibility;[\s\S]*moon\.visible = visibility > 0\.001/.test(shieldSource), 'Shieldworld moon visibility is night/elevation gated');
ok(/starFade\.value = \(sky\.state\.palette\?\.star \?\? 0\) \* \(1 - 0\.85 \* nightK\)/.test(shieldSource), 'Shieldworld star dimming is stable and TOD-derived');
ok(!/starFade\.value \*=/.test(shieldSource), 'Shieldworld no longer compounds star fade every frame');

console.log(`weather/audio static audit: PASS (${checks} assertions, no GPU/browser)`);
