import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const read = async (path, encoding = 'utf8') => readFile(new URL('../' + path, import.meta.url), encoding);
const [sky, pipeline, main, weatherSky, ringSky, shield, moonBytes] = await Promise.all([
    read('engine/sky_system.js'),
    read('src/reflection_pipeline.js'),
    read('src/main.js'),
    read('src/weathersky.js'),
    read('src/ringsky.js'),
    read('src/shieldworld.js'),
    read('assets/moon_color_1k.jpg', null),
]);

let checks = 0;
const ok = (condition, message) => {
    assert.ok(condition, message);
    checks++;
};

ok(/const N_CLOUD_SHADOW = Math\.max\(12, Math\.min\(16,[\s\S]*N_MARCH \/ 3/.test(sky), 'cloud shadows keep a 12-tap floor so drifting patch edges sweep instead of snapping');
ok(/mode: 'world-space-sun-column'/.test(sky), 'cloud shadows report world-space sun-column mode');
ok(/followsCloudWind: true/.test(sky), 'cloud shadows follow the live moving density field');
ok(/qualityAffectsBudgetOnly: true/.test(sky), 'quality changes shadow budget rather than removing the effect');
ok(/const sampleP = pWorld\.add\(u\.cloudLightDir\.mul\(along\)\)/.test(sky)
    && /cheapDensity\(sampleP\)\.mul\(0\.018\)/.test(sky)
    && /stormShadowExtinctionAt\(sampleP\)/.test(sky)
    && !/stormFieldAt\(\s*sampleP/.test(sky),
    'shadow rays use ordinary density or a compact continuous storm mass without cloning the sky graph');
ok(/smoothstep\(0\.02, 0\.16, u\.cloudLightDir\.y\)/.test(sky), 'cloud shadows naturally fade when the active sun or moon is below the horizon');
ok(/active\.sky\?\.wrapCloudShadows\?\.\(scene, 0\.42\)/.test(main), 'cloud shadows install independently of lazy weather activation');
ok(/sky\.wrapCloudShadows\?\.\(scene, 0\.42\)/.test(weatherSky), 'standard skies establish the same receiver contract before weather');
ok(/return cloudShadowRoots\.size/.test(sky), 'repeated installers report total receivers rather than a misleading zero additions');
const shadowWrapper = sky.slice(sky.indexOf('wrapCloudShadows(sceneRoot,'), sky.indexOf('// JS: sun dimming factor'));
ok(/lightColor: lightData\.lightColor\.mul\(shade\)/.test(shadowWrapper)
    && !/m\.colorNode\s*=/.test(shadowWrapper)
    && !/m\.opacityNode\s*=/.test(shadowWrapper), 'direct-light cloud attenuation preserves material color and alpha-tested silhouettes');
ok(/installedWithoutWeather: true/.test(main), 'runtime diagnostics record weather-independent installation');
ok(/o\.userData\.noCloudShadow = true/.test(ringSky), 'Ringworld sky structure is not treated as local shadow receiver');
ok(/cloudBody\([\s\S]*dir, vec3\(0, 2, 0\), bopts\.cloudPasses, null, float\(0\)/.test(sky),
    'reflected clouds are sampled into the angular environment bake');
ok(/const hit = highCloudHit\(org, dir\);[\s\S]*const wispHitT = hit\.x;[\s\S]*const wispRange = float\(1\)\.sub\(smoothstep\([\s\S]*wispHitT/.test(sky), 'Earth/Shield and curved Ringworld high sheets own ordered-edge distance attenuation');
ok(/const RING_ZFLAT\s*=\s*RING_R\s*\*\s*0\.84;[\s\S]*const RING_ZCREST\s*=\s*RING_R\s*\*\s*0\.98;[\s\S]*const RING_RISE\s*=\s*RING_R\s*\*\s*0\.07;[\s\S]*const RING_ZEND\s*=\s*RING_R\s*\*\s*0\.995;/.test(sky),
    'Ringworld wide centered profile remains stable');
ok(/const flatY = u\.cloudStart\.add\(u\.cloudHeight\)\.add\(1000\);[\s\S]*ringDeckY\(zq\)\.sub\(RING_BASE\)\.add\(flatY\)/.test(sky),
    'Ringworld upper sheet preserves preset semantic altitude');
ok(/const uLocalHalf = uniform\(opts\.ringLocalHalf \?\? 4000\);[\s\S]*const uWispCurveHalf = uniform\([\s\S]*\(opts\.ringLocalHalf \?\? 4000\) \* 0\.5[\s\S]*const ringWispProgress = smoothstep\([\s\S]*const ringWispHalf = mix\(uLocalHalf, uWispCurveHalf, ringWispProgress\);/.test(sky),
    'Ringworld upper sheet stays wide across the flat run and narrows only on the curved ends');
ok(!/ring\.clouds/.test(ringSky), 'Ringworld wrapper has no duplicate cloud presentation');
ok(/const lo =[\s\S]*const hi =[\s\S]*step < 8[\s\S]*lo\.assign\(mid\)[\s\S]*hi\.assign\(mid\)/.test(sky),
    'Ringworld upper sheet uses a bracketed curve intersection rather than fixed-point guesses');
ok(/DIRECT_LIGHT_MASS_SCALE = 0\.25[\s\S]*const addDetailedLight[\s\S]*cheapDensity[\s\S]*const addMassLight[\s\S]*smoothDensity[\s\S]*sampleLightCache\(p\)[\s\S]*addMassLight\(directDen\)[\s\S]*mix\(cachedDen, directDen, clamp\(u\.lightCacheDirect, 0, 1\)\)[\s\S]*addDetailedLight\(detailedDen\)[\s\S]*addMassLight\(massDen\)[\s\S]*mix\(detailedDen, massDen, clamp\(u\.lightCacheDirect, 0, 1\)\)/.test(sky),
    'cached and cache-disabled severe weather share calibrated live cloud-mass self-shadowing');
ok(/const baseJit = jitterOverride[\s\S]*const jitK = fract\(baseJit\.add\(k \/ M_PASS\)\)[\s\S]*lightRay\([\s\S]*baseJit\.mul\(73\.1063\)/.test(sky),
    'cloud integration keeps deterministic centered strata without screen-space dither');
const numericSmoothsteps = [...sky.matchAll(
    /smoothstep\(\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*,/g,
)];
ok(numericSmoothsteps.length > 20
    && numericSmoothsteps.every((match) => Number(match[1]) < Number(match[2])),
    'all literal sky smoothstep calls use strictly ordered WGSL-safe edges');
const forbiddenReversedDynamicSmoothsteps = [
    'smoothstep(uLocalHalf.mul(1.3), uLocalHalf.mul(0.66)',
    'smoothstep(ringWispHalf.mul(1.22), ringWispHalf.mul(0.72)',
    'smoothstep(u.fadeDist, u.fadeDist.mul(0.35), t0)',
    'smoothstep(u.cloudStart, u.cloudStart.mul(0.55)',
    'smoothstep(rw.halfWidth + 30, rw.halfWidth - 30',
];
ok(forbiddenReversedDynamicSmoothsteps.every((token) => !sky.includes(token))
    && !/smoothstep\(\s*float\(RING_VISIBLE_END\),\s*float\(RING_VISIBLE_END - RING_END_FADE\)/.test(sky)
    && !/smoothstep\(\s*u\.fadeDist\.mul\(1\.25\), u\.fadeDist\.mul\(0\.55\)/.test(sky),
    'dynamic Ringworld/cloud distance masks cannot regress to reversed smoothstep edges');
ok(/const canopyField = smoothstep\([\s\S]*const canopyDetail = smoothstep\(0\.20, 0\.82, wispN\)[\s\S]*const canopyShape = max\(wispShape, canopyField\.mul\(u\.wispFloor\)\.mul\(canopyDetail\)\)/.test(sky),
    'severe upper canopy remains organically modulated');
ok(/installReflectionEnvironment[\s\S]*material\.envMap = texture[\s\S]*scene\.environment = null/.test(pipeline),
    'reflection pipeline preserves native per-material environment shading');
ok(/reflectionCompose: 'ssr_plus-same-ray-sky-ground-times-one-minus-ssr'/.test(pipeline)
    && /ssrHitConfidence: 'binary-accepted-hit-ownership-with-screen-edge-fade'/.test(pipeline),
    'native material PMREM hands its directional lobe to one exclusive SSR or fallback owner');
ok(/denoise[\s\S]*gaussianBlur[\s\S]*rough/.test(sky),
    'live sky reflections use depth-aware denoise and roughness filtering');
ok(/moon_color_4k\.jpg/.test(weatherSky) && /textures: \{ stars, moon \}/.test(weatherSky), 'all standard weather skies load the Earth moon');
ok(/earthMoonVisibility: textures\.moon[\s\S]*tod-elevation-cloud-occlusion/.test(sky), 'Earth moon diagnostic records natural TOD/elevation/cloud visibility');
ok(/earthMoonTone: 'neutral-cool-lunar-albedo'/.test(sky), 'Earth moon stays neutral/cool and distinct from Shieldworld');
ok(/0xd06a3c/.test(shield), 'Shieldworld bounced moonlight is warm amber-brown');
ok(/red-giant-warm-amber-brown/.test(shield), 'Shieldworld reports its red-giant reflected key');
ok(/mu\.sunCol\.value\.setRGB\(1\.0, 0\.62, 0\.35\)/.test(shield), 'Shieldworld rocky moon reflects the star spectrum independently of observer twilight');

const moonHash = createHash('sha256').update(moonBytes).digest('hex').toUpperCase();
assert.equal(moonHash, 'B246064F217F8D479DF78C49C7C8595A8F5FBDA008A72FD539978D2E121E0109', 'Earth moon texture differs from Eidoverse LROC donor');
checks++;

console.log('[sky-stability-static-audit] ' + checks + ' assertions passed; no GPU/browser');
