import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const ROOT = new URL('../', import.meta.url);
const read = (path) => readFile(new URL(path, ROOT), 'utf8');
const [weatherSource, wrapperSource, audioSource, skySource] = await Promise.all([
    read('engine/weather_system.js'),
    read('src/weathersky.js'),
    read('src/audio_system.js'),
    read('engine/sky_system.js'),
]);

let checks = 0;
const ok = (value, message) => { assert.ok(value, message); checks++; };
const equal = (actual, expected, message) => {
    assert.deepEqual(actual, expected, message);
    checks++;
};

// Evaluate only the weather module's top-level declaration path. No Three
// class is constructed until makeWeatherSystem() is called, so an empty THREE
// namespace is sufficient to exercise the real deterministic selector.
const context = vm.createContext({
    THREE: {},
    console: { log() {}, warn() {}, error() {} },
});
vm.runInContext(weatherSource, context, { filename: 'engine/weather_system.js' });
const profile = context.EANPA_LIGHTNING_PROFILE;
ok(profile, 'weather module exposes its deterministic lightning profile');

const plainPalettes = JSON.parse(JSON.stringify(profile.palettes));
const plainCadence = JSON.parse(JSON.stringify(profile.cadence));
equal(plainPalettes.darkstorm, [
    ['white', 0.40],
    ['blue', 0.36],
    ['purple', 0.16],
    ['red', 0.04],
    ['green', 0.04],
], 'Dark Storm palette keeps the exact requested five-color weights');
equal(plainPalettes.standard, [
    ['white', 0.52],
    ['blue', 0.44],
    ['purple', 0.04],
], 'ordinary lightning weather excludes red and green exactly');
equal(plainCadence.darkstorm.initialGapMinSeconds, 6,
    'Dark Storm exposes its first testable event after at least six seconds');
equal(plainCadence.darkstorm.initialGapMaxSeconds, 9,
    'Dark Storm exposes its first testable event within nine seconds');
equal(plainCadence.darkstorm.minGapSeconds, 12,
    'Dark Storm events retain at least twelve seconds of darkness');
equal(plainCadence.darkstorm.maxGapSeconds, 28,
    'Dark Storm event gaps vary up to twenty-eight seconds');
equal(plainCadence.darkstorm.maxStrokes, 2,
    'one Dark Storm event has at most two return strokes');
equal(plainCadence.standard.minGapSeconds, 16,
    'ordinary lightning weather has a longer minimum pause');
equal(plainCadence.standard.maxStrokes, 2,
    'ordinary lightning clusters remain bounded to two strokes');

for (const paletteName of ['standard', 'darkstorm']) {
    const cadence = plainCadence[paletteName];
    let eventTime = 0;
    let previousEventTime = -Infinity;
    for (let event = 1; event <= 10000; event++) {
        const gap = profile.eventGapAt(event, paletteName, cadence.referenceLevel);
        ok(Number.isFinite(gap)
            && gap >= cadence.minGapSeconds
            && gap <= cadence.maxGapSeconds,
        `${paletteName} event ${event} obeys its authored pause range`);
        eventTime += gap;
        ok(eventTime - previousEventTime >= cadence.minGapSeconds,
            `${paletteName} event ${event} cannot retrigger frame-by-frame`);
        previousEventTime = eventTime;

        const plan = profile.strokePlanAt(event, paletteName);
        ok(plan.count >= 1 && plan.count <= cadence.maxStrokes,
            `${paletteName} event ${event} has a bounded return-stroke count`);
        ok(plan.offsets.length === plan.count
            && plan.amplitudes.length === plan.count,
        `${paletteName} event ${event} has one offset/amplitude per stroke`);
        ok(plan.offsets[0] === 0
            && plan.offsets.every((offset, index) => (
                index === 0 || offset > plan.offsets[index - 1]
            ))
            && plan.durationSeconds < 0.6,
        `${paletteName} event ${event} is one short ordered cluster`);
        for (let sample = 0; sample <= 12; sample++) {
            const flash = profile.flashAt(sample * 0.05, plan);
            ok(Number.isFinite(flash) && flash >= 0 && flash <= 1,
                `${paletteName} event ${event} flash sample stays finite and bounded`);
        }
    }
}
for (let event = 1; event <= 10000; event++) {
    const gap = profile.initialEventGapAt(event, 'darkstorm', 0.01);
    ok(gap >= plainCadence.darkstorm.initialGapMinSeconds
        && gap <= plainCadence.darkstorm.initialGapMaxSeconds,
    `Dark Storm initial event ${event} stays inside the explicit entry window`);
}
ok(profile.eventGapAt(31, 'standard', 0.05)
    >= profile.eventGapAt(31, 'standard', 0.30),
'less electrical weather can only lengthen, never shorten, its pause');
ok(profile.localCandidateAt(1, 0.16),
    'the deterministic Dark Storm sequence exposes a local candidate on its first event');
ok(profile.localCandidateAt(3001, 0, {
    paletteName: 'darkstorm',
    entryEventCount: plainCadence.darkstorm.firstLocalCandidateWithinEvents,
    remoteEventsSinceLocal: 2,
    hasLocalStrike: false,
}), 'Dark Storm guarantees a candidate on its first event after entry');
ok(profile.localCandidateAt(3002, 0, {
    paletteName: 'darkstorm',
    entryEventCount: 20,
    remoteEventsSinceLocal: plainCadence.darkstorm.maxRemoteEventsBetweenLocalCandidates,
    hasLocalStrike: true,
}), 'Dark Storm caps the remote-event run even when the random chance is zero');
ok(!profile.localCandidateAt(3002, 0, {
    paletteName: 'standard',
    entryEventCount: 20,
    remoteEventsSinceLocal: 20,
    hasLocalStrike: false,
}), 'ordinary storms do not inherit Dark Storm local-strike guarantees');
let localCandidates = 0;
for (let event = 1; event <= 100000; event++) {
    if (profile.localCandidateAt(event, 0.16)) localCandidates++;
}
ok(Math.abs(localCandidates / 100000 - 0.16) < 0.012,
    'observable Dark Storm local candidates remain much rarer than remote events');

for (const paletteName of ['standard', 'darkstorm']) {
    for (let interval = -250; interval <= 250; interval++) {
        equal(
            profile.styleKeyAt(interval, paletteName),
            profile.styleKeyAt(interval, paletteName),
            `${paletteName} interval ${interval} is reproducible`,
        );
    }
}

const sampleDistribution = (paletteName, count = 100000) => {
    const counts = new Map();
    for (let interval = 0; interval < count; interval++) {
        const key = profile.styleKeyAt(interval, paletteName);
        counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return Object.fromEntries([...counts].map(([key, value]) => [key, value / count]));
};
const standardDistribution = sampleDistribution('standard');
const darkstormDistribution = sampleDistribution('darkstorm');
ok(!('red' in standardDistribution) && !('green' in standardDistribution),
    'ordinary lightning never selects red or green across 100k real intervals');
for (const [key, expected] of plainPalettes.standard) {
    ok(Math.abs(standardDistribution[key] - expected) < 0.012,
        `ordinary ${key} empirical weight remains close to ${expected}`);
}
for (const [key, expected] of plainPalettes.darkstorm) {
    ok(Math.abs(darkstormDistribution[key] - expected) < 0.012,
        `Dark Storm ${key} empirical weight remains close to ${expected}`);
}

const triggerImpactSource = weatherSource.slice(
    weatherSource.indexOf('const triggerImpact ='),
    weatherSource.indexOf('const updateImpactPool ='),
);
ok(triggerImpactSource.length > 0 && !/new\s+T3\./.test(triggerImpactSource),
    'impact trigger reuses preallocated GPU and math resources');
ok(/const IMPACT_POOL_SIZE = 2/.test(weatherSource)
    && /const SCORCH_POOL_SIZE = 4/.test(weatherSource)
    && /const SCORCH_LIFETIME = 90/.test(weatherSource),
    'impact and temporary scorch pools are hard capped');
ok(/const strikeRaycaster = new T3\.Raycaster\(\)/.test(weatherSource)
    && /normal\.y < 0\.72/.test(weatherSource)
    && /playerDistance < LOCAL_STRIKE_PLAYER_GUARD/.test(weatherSource),
    'local strike resolution uses one retained raycaster and rejects unsafe faces');
ok(/fallbackTerrainStrike = \(x, z, camera\)[\s\S]*opts\.strikeHeightAt[\s\S]*localStrikeHit\.kind = 'terrain_heightfield'/.test(weatherSource)
    && !/if \(!camera \|\| roots\.length === 0\) return null/.test(weatherSource)
    && /strikeHeightAt: \(x, z\) => globalThis\._terrain\?\.heightAt\?\.\(x, z\)/.test(wrapperSource),
    'culled/GPU-only terrain retains a deterministic real-height local-strike fallback');
ok(/finiteT - lastLocalStrikeAt >= LOCAL_STRIKE_COOLDOWN/.test(weatherSource),
    'local strike selection enforces the shared cooldown');
ok(/lightningLocalCandidateAt\(\s*I,\s*localChance,/.test(weatherSource)
    && /triggerImpact\([\s\S]*state\.strike = \{[\s\S]*rebuildBolt\(I, camera, sx, sz, bottomY\)/.test(weatherSource),
    'one local-candidate event atomically owns impact, strike state, and surface bolt');
ok(/firstLocalCandidateWithinEvents: 1/.test(weatherSource)
    && /maxRemoteEventsBetweenLocalCandidates: 6/.test(weatherSource)
    && /remoteEventsSinceLocalStrike = 0/.test(weatherSource),
    'runtime bounds first-entry and subsequent remote runs without defeating cooldown');
ok(/lightningPalette: 'darkstorm', localStrikeChance: 0\.16/.test(weatherSource),
    'settled Dark Storm exposes local candidates at a noticeable minority rate');
ok(/rebuildBolt\(I, camera, sx, sz, bottomY\)/.test(weatherSource),
    'surface strikes terminate visible bolt geometry at the resolved hit');
ok(/new T3\.IcosahedronGeometry\(1, 1\)/.test(weatherSource)
    && /const puffView = normalize\(cameraPosition\.sub\(positionWorld\)\)/.test(weatherSource)
    && !/const puffMaterial[\s\S]{0,400}side: T3\.DoubleSide/.test(weatherSource),
    'impact puffs are closed front-face 3D volumes with view-thickness shaping');
ok(/const brokenEdge = sin\([\s\S]*const tendrilAngular = pow\(/.test(weatherSource),
    'temporary scorch has deterministic irregular breakup instead of a perfect circle');
ok(/radiusMeters: LOCAL_STRIKE_SURFACE_DAMAGE_RADIUS/.test(weatherSource)
    && /opts\.onLocalStrike\?\.\(surfaceDamage\)/.test(weatherSource)
    && /localHitObject\.userData\.lightningDamage/.test(weatherSource)
    && /eanpa:lightning-impact/.test(wrapperSource),
    'committed local strike exposes one honest receiver/world surface-damage signal');
ok(/scene\.remove\(rainInst, splashInst, bolt, boltMesh, \.\.\.impactObjects\)/.test(weatherSource)
    && /impactSparkGeometry\.dispose\(\)/.test(weatherSource)
    && /scorchGeometry\.dispose\(\)/.test(weatherSource),
    'weather disposal removes and releases all fixed impact resources');

ok(/boltColor\.value\.set\([\s\S]*bolt\.color\.copy\(activeStrikeColor\)/.test(weatherSource),
    'visible ribbon and real PointLight consume one selected linear color');
equal((weatherSource.match(/new T3\.PointLight\(/g) ?? []).length, 1,
    'all events reuse one pooled scene light instead of stacking lights');
ok(/const LIGHTNING_LIGHT_PEAK = 12000/.test(weatherSource)
    && /const LIGHTNING_LIGHT_RANGE = 900/.test(weatherSource)
    && /const boundedSceneFlash = Math\.max\([\s\S]*Math\.min\(1, flash \+ impactAfterglow\)[\s\S]*bolt\.intensity = boundedSceneFlash \* LIGHTNING_LIGHT_PEAK/.test(weatherSource),
    'scene illumination is finite, capped, and below the old ground-blowout peak');
ok(/clearLightningSchedule\(\);[\s\S]*bolt\.intensity = 0[\s\S]*state\.strike\.flash = 0/.test(weatherSource),
    'leaving lightning weather atomically resets light and strike pulse state');
ok(/lightningFlashColor\.value\.set\([\s\S]*lightningStrike\.value\.set\(/.test(weatherSource),
    'weather writes the analytic canopy color and spatial strike pulse');
ok(/u\.lightningFlashColor/.test(skySource)
    && /u\.lightningStrike\.w/.test(skySource),
    'sealed cloud underside consumes both colored flash uniforms');
ok(/localColor = \[[\s\S]*activeStrikeColor\.r[\s\S]*activeStrikeColor\.g[\s\S]*activeStrikeColor\.b/.test(weatherSource),
    'rain inherits the active strike color');
ok(/const stormRainVisibility = sky[\s\S]*stormOpacityBoost = mix\(float\(1\), float\(1\.28\), stormRainVisibility\)[\s\S]*\.mul\(stormOpacityBoost\), 0, 0\.72\)/.test(weatherSource)
    && /const stormCanopyRainLegibility = stormCanopyLegibility \* Math\.max\([\s\S]*const rainAmbientFloor = 0\.08 \+ stormCanopyRainLegibility \* 0\.14[\s\S]*rainAmbientFloor[\s\S]*ambientRain \* weatherLight/.test(weatherSource),
    'sealed Dark Storm rain gets only a rain-gated 1.28x opacity lift and bounded diffuse floor');
ok(/const endFade = smoothstep\(0\.0, 0\.18, uv\(\)\.y\)[\s\S]*float\(1\)\.sub\(smoothstep\(0\.72, 1\.0, uv\(\)\.y\)\)/.test(weatherSource)
    && !/smoothstep\(1\.0, 0\.72, uv\(\)\.y\)/.test(weatherSource),
    'fallback rain streak alpha uses ordered backend-defined smoothstep edges');
ok(/const ring = smoothstep\(0\.55, 0\.8, rr\)[\s\S]*float\(1\)\.sub\(smoothstep\(0\.85, 1\.0, rr\)\)/.test(weatherSource)
    && !/smoothstep\(1\.0, 0\.85, rr\)/.test(weatherSource),
    'rain splash ring alpha uses ordered backend-defined smoothstep edges');
ok(!/Math\.floor\(t \* 1\.9\)|Math\.floor\(t \* 3\.3\)/.test(weatherSource),
    'retired sub-second strike and sheet samplers cannot retrigger');
ok(/nextLightningEventAt = finiteT \+ nextGap/.test(weatherSource)
    && /At most one event can begin in one update/.test(weatherSource),
    'late frames schedule forward once instead of replaying a catch-up burst');
ok(/__eanpaWeatherByScene[\s\S]*weatherRegistry\.get\(scene\)\?\.dispose\?\.\(\)[\s\S]*weatherRegistry\.set\(scene, sys\)/.test(weatherSource),
    'one scene owns exactly one live weather scheduler');
ok(/if \(disposed \|\| weatherRegistry\.get\(scene\) !== sys\) return false/.test(weatherSource),
    'disposed or replaced schedulers cannot continue writing shared sky flash state');
ok(/const dropTex = await globalThis\.loadImageTexture[\s\S]*if \(disposed\) return null;[\s\S]*globalThis\.makeWeatherSystem/.test(wrapperSource),
    'a disposed lazy texture request cannot construct and evict the newer weather owner');
ok(/flash \* lightningSheetScale/.test(weatherSource),
    'sheet illumination belongs to the current separated storm event');
ok(/activeStrokeCount: 0[\s\S]*nextEventAtSeconds: null/.test(weatherSource),
    'runtime diagnostics expose bounded clusters and the next event deadline');
ok(/strikeTargets: \(\) => \[[\s\S]*globalThis\._terrain[\s\S]*globalThis\._temple\?\.group/.test(wrapperSource),
    'all shared weather attachments provide curated terrain/temple receivers');

ok(/const THUNDER_BODY_CAP = 6/.test(audioSource)
    && /const THUNDER_CRACK_CAP = 2/.test(audioSource),
    'long bodies and short cracks have independent fixed voice caps');
ok(/Math\.hypot\(dx, dy, dz\)/.test(audioSource)
    && /delay: distance \/ 343/.test(audioSource),
    'thunder uses full 3D strike-listener distance at 343 m/s');
ok(/highpassHz: 1150[\s\S]*stopAfter: 0\.72/.test(audioSource),
    'close thunder layers a bounded quick electrical crack over its body');
ok(/for \(const voice of thunderBodies\.splice\(0\)\)[\s\S]*thunderCracks\.splice\(0\)/.test(audioSource),
    'audio disposal retires every tracked thunder voice');

console.log(`lightning profile/runtime audit: PASS (${checks} assertions, 200k deterministic samples)`);
