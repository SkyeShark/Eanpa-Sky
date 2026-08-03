import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const ROOT = new URL('../', import.meta.url);
const read = (path) => readFile(new URL(path, ROOT), 'utf8');
const [indexSource, mainSource, earthSource, ringSource, shieldSource] = await Promise.all([
    read('index.html'),
    read('src/main.js'),
    read('src/weathersky.js'),
    read('src/ringsky.js'),
    read('src/shieldworld.js'),
]);

let assertions = 0;
const ok = (value, message) => { assert.ok(value, message); assertions++; };
const equal = (actual, expected, message) => { assert.deepEqual(actual, expected, message); assertions++; };
const codeOnly = (source) => source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');

function selectOptions(id) {
    const body = indexSource.match(new RegExp(`<select\\s+id=["']${id}["'][^>]*>([\\s\\S]*?)<\\/select>`))?.[1] ?? '';
    ok(body.length > 0, `${id} select exists`);
    return [...body.matchAll(/<option\s+([^>]*)>([\s\S]*?)<\/option>/g)].map((match) => {
        const attrs = match[1];
        return {
            value: attrs.match(/value=["']([^"']+)["']/)?.[1] ?? '',
            label: match[2].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim(),
            selected: /\bselected\b/.test(attrs),
        };
    });
}

const expectedSkyboxes = [
    { value: 'earth', label: 'Earth' },
    { value: 'ringworld', label: 'Orbital / Halo' },
    { value: 'shieldworld', label: 'Earth 5129323011 CE (Red Giant)' },
];
const expectedCloudTypes = [
    { value: 'clear', label: 'Clear Sky' },
    { value: 'cumulus', label: 'Cumulus' },
    { value: 'stratus', label: 'Stratus' },
    { value: 'cirrus', label: 'High Cirrus' },
];
const expectedWeatherValues = ['none', 'fair', 'sunshower', 'overcast', 'rain', 'storm', 'cyclone', 'darkstorm'];

const skyboxOptions = selectOptions('skybox');
const cloudOptions = selectOptions('cloud-type');
const weatherOptions = selectOptions('weather');
equal(skyboxOptions.map(({ value, label }) => ({ value, label })), expectedSkyboxes, 'Skybox exposes exactly the three environment choices');
equal(cloudOptions.map(({ value, label }) => ({ value, label })), expectedCloudTypes, 'Cloud Type exposes Clear Sky plus the three cloud morphologies');
equal(weatherOptions.map(({ value }) => value), expectedWeatherValues, 'Weather retains every authored state');
equal(skyboxOptions.filter((option) => option.selected).map((option) => option.value), ['earth'], 'default environment remains Earth');
equal(cloudOptions.filter((option) => option.selected).map((option) => option.value), ['cumulus'], 'former Cumulus Day default remains Cumulus');
equal(weatherOptions.filter((option) => option.selected).map((option) => option.value), ['none'], 'default weather remains None');
ok(!/<select\s+id=["']weather["'][^>]*\bdisabled\b/.test(indexSource), 'Weather is never disabled in markup');

const mainCode = codeOnly(mainSource);
ok(!/weatherControl(?:\?|)\.disabled/.test(mainCode), 'main never disables Weather');
ok(!/weatherControl\.value\s*=\s*['"]none['"]/.test(mainCode), 'main never forces Weather to None');
ok(!/supportsWeather\s*=\s*kind\s*!==/.test(mainCode), 'main contains no environment-specific Weather gate');
ok(!/setWeatherStatus\(['"]Unavailable['"]\)/.test(mainCode), 'Weather status never masquerades as unavailable');
ok(/cloudPreset,\s*\n\s*weatherState: wx/.test(mainSource), 'every wrapper context receives selected Cloud Type and Weather');
ok(/active = await \(SKYBOX_FACTORIES\[kind\] \?\? SKYBOX_FACTORIES\.earth\)\(ctx, cloudPreset, wx\)/.test(mainSource), 'build uses one generic three-axis factory dispatch');
ok(/active\?\.supportsWeather !== true \|\| typeof active\.setWeather !== ['"]function['"]/.test(mainSource), 'build enforces the shared Weather contract for every environment');

const factorySource = mainSource.slice(
    mainSource.indexOf('const SKYBOX_FACTORIES ='),
    mainSource.indexOf('// The optimized tiers retain', mainSource.indexOf('const SKYBOX_FACTORIES =')),
);
for (const [skybox, factory] of [['earth', 'makeWeatherSky'], ['ringworld', 'makeRingworld'], ['shieldworld', 'makeShieldworld']]) {
    ok(new RegExp(`${skybox}: \\(ctx, cloudPreset, weatherState\\) => ${factory}`).test(factorySource), `${skybox} factory accepts both independent atmospheric axes`);
}

const buildSource = mainSource.slice(
    mainSource.indexOf('async function buildSkybox()'),
    mainSource.indexOf("document.getElementById('skybox').addEventListener"),
);
ok(/const selection = syncSceneSelection\(\)/.test(buildSource), 'every skybox/quality rebuild snapshots the durable selection');
ok(/const kind = selection\.skybox[\s\S]*const cloudPreset = selection\.cloudType[\s\S]*const wx = selection\.weather/.test(buildSource), 'build reads all axes independently');
ok(!/(?:skyboxControl|cloudTypeControl|weatherControl)\.value\s*=/.test(codeOnly(buildSource)), 'rebuild never rewrites any selection axis');

const cloudHandler = mainSource.slice(
    mainSource.indexOf("cloudTypeControl.addEventListener('change'"),
    mainSource.indexOf("aoControl?.addEventListener('change'"),
);
ok(/syncSceneSelection\(\)/.test(cloudHandler), 'Cloud Type updates the durable selection');
ok(/owner\?\.setCloudPreset\?\.\(cloudType/.test(cloudHandler), 'Cloud Type uses the in-place wrapper API when available');
ok(/if \(handled\)[\s\S]*return;[\s\S]*void buildSkybox\(\)/.test(cloudHandler), 'Cloud Type rebuild is fallback-only');
ok(!/setWeather/.test(codeOnly(cloudHandler)), 'Cloud Type never changes Weather');

const weatherHandler = mainSource.slice(
    mainSource.indexOf("weatherControl.addEventListener('change'"),
    mainSource.indexOf("document.getElementById('tod').addEventListener"),
);
ok(/const \{ weather: state \} = syncSceneSelection\(\)/.test(weatherHandler), 'Weather updates only its durable axis');
ok(/owner\?\.setWeather\?\.\(state/.test(weatherHandler), 'Weather transitions through the active shared wrapper');
ok(!/(?:skyboxControl|cloudTypeControl)\.value\s*=/.test(codeOnly(weatherHandler)), 'Weather never rewrites Skybox or Cloud Type');

const wrapperSources = { earth: earthSource, ringworld: ringSource, shieldworld: shieldSource };
for (const [name, source] of Object.entries(wrapperSources)) {
    ok(/supportsWeather:\s*true/.test(source), `${name} advertises full Weather support`);
    ok(/setCloudPreset\(name, onTransitionStart\)/.test(source), `${name} exposes independent Cloud Type changes`);
    ok(/setWeather\(state, onTransitionStart\)/.test(source), `${name} exposes independent Weather changes`);
}

const selectionStart = mainSource.indexOf('const SCENE_SELECTION_VALUES =');
const selectionEnd = mainSource.indexOf('let aoPreference', selectionStart);
ok(selectionStart >= 0 && selectionEnd > selectionStart, 'independent state implementation is statically discoverable');
const selectionSource = mainSource.slice(selectionStart, selectionEnd);
const makeSelectionHarness = Function(
    'skyboxControl', 'cloudTypeControl', 'weatherControl',
    `"use strict";\n${selectionSource}\nreturn { SCENE_SELECTION_VALUES, sceneSelection, syncSceneSelection };`,
);

const hadDiagnostics = Object.hasOwn(globalThis, '_eanpaSceneSelection');
const savedDiagnostics = globalThis._eanpaSceneSelection;
try {
    for (let skyIndex = 0; skyIndex < expectedSkyboxes.length; skyIndex++) {
        for (const cloud of expectedCloudTypes) {
            for (const weather of expectedWeatherValues) {
                const skyboxControl = { value: expectedSkyboxes[skyIndex].value };
                const cloudTypeControl = { value: cloud.value };
                const weatherControl = { value: weather };
                const harness = makeSelectionHarness(skyboxControl, cloudTypeControl, weatherControl);
                const selected = harness.syncSceneSelection();
                equal(selected, {
                    skybox: skyboxControl.value,
                    cloudType: cloud.value,
                    weather,
                }, `${skyboxControl.value} × ${cloud.value} × ${weather} is available`);

                skyboxControl.value = expectedSkyboxes[(skyIndex + 1) % expectedSkyboxes.length].value;
                const afterSkyboxRebuild = harness.syncSceneSelection();
                equal(afterSkyboxRebuild.cloudType, cloud.value, `${cloud.value} persists across ${selected.skybox} skybox changes`);
                equal(afterSkyboxRebuild.weather, weather, `${weather} persists across ${selected.skybox} skybox changes`);
            }
        }
    }
} finally {
    if (hadDiagnostics) globalThis._eanpaSceneSelection = savedDiagnostics;
    else delete globalThis._eanpaSceneSelection;
}

console.log(JSON.stringify({
    ok: true,
    assertions,
    matrix: {
        skyboxes: expectedSkyboxes.length,
        cloudTypes: expectedCloudTypes.length,
        weatherStates: expectedWeatherValues.length,
        combinations: expectedSkyboxes.length * expectedCloudTypes.length * expectedWeatherValues.length,
    },
}, null, 2));
