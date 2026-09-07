// EANPA scene audio — lazy Web Audio controller for Foley, weather and temple SFX.
// The AudioContext is deliberately not created until a real user gesture. This
// keeps boot/autoplay clean while still allowing all game state to update muted.
import { blendAmbienceLoop } from './audio_loop.js';

const ASSET_ROOT = new URL('../assets/audio/', import.meta.url);
const ASSET_REVISION = 'scene-audio-v4';
const assetUrl = (name) => {
    const url = new URL(name, ASSET_ROOT);
    url.searchParams.set('v', ASSET_REVISION);
    return url;
};

const FILES = {
    sand: ['footstep_sand_01.ogg', 'footstep_sand_02.ogg', 'footstep_sand_03.ogg', 'footstep_sand_04.ogg'],
    gravel: ['footstep_gravel_01.ogg', 'footstep_gravel_02.ogg', 'footstep_gravel_03.ogg', 'footstep_gravel_04.ogg'],
    sandstone: ['footstep_sandstone_01.ogg', 'footstep_sandstone_02.ogg', 'footstep_sandstone_03.ogg', 'footstep_sandstone_04.ogg'],
    stone: ['footstep_stone_01.ogg', 'footstep_stone_02.ogg', 'footstep_stone_03.ogg', 'footstep_stone_04.ogg'],
    land: ['landing_soft.ogg', 'landing_medium.ogg', 'landing_heavy.ogg'],
    gateOpen: ['gate_open.ogg'],
    gateClose: ['gate_close.ogg'],
    flashlightOn: ['flashlight_click_on.ogg'],
    flashlightOff: ['flashlight_click_off.ogg'],
    desertWind: ['ambience_desert_wind.wav'],
    desertBirds: [
        'bird_cactus_wren_01.mp3',
        'bird_cactus_wren_02.mp3',
        'bird_roadrunner_01.mp3',
        'bird_roadrunner_02.mp3',
    ],
    rain: ['rain_desert_loop.ogg'],
    thunderClose: ['thunder_close_01.ogg', 'thunder_close_02.ogg', 'thunder_close_03.ogg'],
    thunderDistant: ['thunder_distant_01.ogg', 'thunder_distant_02.ogg', 'thunder_distant_03.ogg'],
    // Synthesized in-repo (tools/generate-explosive-thunder.py, CPU numpy,
    // no source recordings): the licensed thunder takes are rolling/distant
    // by nature and cannot be made to read as a strike landing 35-60 m away.
    thunderExplosive: ['thunder_explosive_01.wav', 'thunder_explosive_02.wav', 'thunder_explosive_03.wav'],
};

// Retain the original CC0 derivatives byte-for-byte and correct only proven
// outliers at playback. Corsica gravel contact 04 was recorded roughly 12 dB
// hotter than its siblings; the shared export boost consequently decodes at
// +7.91 dBFS. A -13.15 dB trim brings its active RMS/peak back inside the
// natural four-contact family without changing the source or re-encoding it.
const ASSET_GAIN_TRIM = Object.freeze({
    'footstep_gravel_04.ogg': 0.22,
});

const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const randomBetween = (low, high) => low + Math.random() * (high - low);
const DESERT_WIND_LEVEL = 0.06;
const BIRD_INITIAL_GAP_SECONDS = Object.freeze([70, 150]);
const BIRD_QUIET_GAP_SECONDS = Object.freeze([140, 320]);
const BIRD_DISTANCE_METERS = Object.freeze([48, 105]);
const BIRD_GAIN_RANGE = Object.freeze([0.08, 0.14]);
// Quiet-boundary exports retain a small lead-in before the electrical crack.
// Close thunder starts just before these measured onsets, while a short
// high-passed parallel voice supplies the immediate crack over the long body.
const THUNDER_CLOSE_ONSETS = Object.freeze([0.156, 0.118, 0.274]);
const THUNDER_BODY_CAP = 6;
const THUNDER_CRACK_CAP = 2;

export function makeAudioSystem({ camera, temple, terrain, surfaceAt } = {}) {
    const AudioContextClass = globalThis.AudioContext || globalThis.webkitAudioContext;
    const buffers = new Map();
    const bufferLoads = new Map();
    const warned = new Set();
    const gateWorld = camera?.position?.clone?.() ?? { x: 0, y: 2, z: 48 };
    const scratch = camera?.position?.clone?.() ?? null;
    const ecologyScratch = {};
    const gateRoot = temple?.group?.getObjectByName?.('authored_main_gate') ?? null;
    const gateRuntimeName = temple?.group?.userData?.gate?.runtimeMesh;
    const gateDoor = gateRoot?.getObjectByName?.(gateRuntimeName)
        ?? gateRoot?.getObjectByName?.('Cube001')
        ?? gateRoot?.getObjectByName?.('Cube.001')
        ?? null;
    gateDoor?.geometry?.computeBoundingBox?.();
    const gateDoorCenterLocal = gateDoor?.geometry?.boundingBox?.getCenter?.(
        camera?.position?.clone?.(),
    ) ?? null;
    let context = null;
    let master = null;
    let effectsBus = null;
    let weatherBus = null;
    let rainGain = null;
    let rainSource = null;
    let windGain = null;
    let windSource = null;
    let birdVoice = null;
    let birdLastAsset = null;
    let birdNextAt = Infinity;
    let loading = null;
    let disposed = false;
    let unlocked = false;
    let lastFootIndex = null;
    let lastLoggedSurface = null;
    let footstepVoice = null;
    let previousGrounded = true;
    let previousPhysicalY = null;
    let peakFallSpeed = 0;
    let previousGateTarget = Number(temple?.state?.gateTarget ?? 0);
    let gatePending = null;
    let gateVoice = null;
    let pendingFlashlightToggle = null;
    let flashlightVoice = null;
    let previousStrike = null;
    const thunderBodies = [];
    const thunderCracks = [];
    let variation = 0;

    const stats = {
        supported: !!AudioContextClass,
        unlocked: false,
        loaded: 0,
        expected: Object.values(FILES).flat().length,
        rain: 0,
        surface: 'gravel',
        lastEvent: null,
        footsteps: {
            gaitEvents: 0,
            plays: 0,
            retired: 0,
            active: false,
            surface: null,
            asset: null,
        },
        ambience: {
            wind: {
                ready: false,
                active: false,
                level: DESERT_WIND_LEVEL,
                loopSeconds: null,
            },
            birds: {
                ready: false,
                active: false,
                plays: 0,
                lastAsset: null,
                nextInSeconds: null,
                initialGapSeconds: [...BIRD_INITIAL_GAP_SECONDS],
                quietGapSeconds: [...BIRD_QUIET_GAP_SECONDS],
                distanceRangeMeters: [...BIRD_DISTANCE_METERS],
                lastDistanceMeters: null,
                lastPosition: null,
                suppressedByRain: false,
            },
        },
        gate: {
            target: previousGateTarget,
            progress: Number(temple?.state?.gateProgress ?? 0),
            direction: null,
            pending: null,
            ready: false,
            active: false,
            plays: 0,
            rate: 1,
            offset: 0,
            distance: null,
            position: null,
        },
        flashlight: {
            enabled: false,
            pending: null,
            ready: false,
            active: false,
            plays: 0,
        },
        thunder: {
            bodies: 0,
            cracks: 0,
            distant: 0,
            local: 0,
            lastDistanceMeters: null,
            lastDelaySeconds: null,
            activeBodies: 0,
            activeCracks: 0,
            bodyCap: THUNDER_BODY_CAP,
            crackCap: THUNDER_CRACK_CAP,
        },
    };

    const setParam = (param, value, now, smoothing = 0.02) => {
        if (!param) return;
        param.cancelScheduledValues(now);
        param.setTargetAtTime(value, now, smoothing);
    };

    const setPannerPosition = (panner, position, now = context?.currentTime ?? 0, smooth = false) => {
        if (!panner || !position) return;
        const x = Number(position.x) || 0;
        const y = Number(position.y) || 0;
        const z = Number(position.z) || 0;
        if (panner.positionX) {
            if (smooth) {
                setParam(panner.positionX, x, now, 0.025);
                setParam(panner.positionY, y, now, 0.025);
                setParam(panner.positionZ, z, now, 0.025);
            } else {
                panner.positionX.setValueAtTime(x, now);
                panner.positionY.setValueAtTime(y, now);
                panner.positionZ.setValueAtTime(z, now);
            }
        } else {
            panner.setPosition(x, y, z);
        }
    };

    const configurePanner = (position, {
        refDistance = 5,
        maxDistance = 900,
        rolloffFactor = 0.72,
    } = {}) => {
        const panner = context.createPanner();
        panner.panningModel = 'HRTF';
        panner.distanceModel = 'inverse';
        panner.refDistance = refDistance;
        panner.maxDistance = maxDistance;
        panner.rolloffFactor = rolloffFactor;
        panner.coneInnerAngle = 360;
        setPannerPosition(panner, position);
        return panner;
    };

    const play = (group, {
        index = null,
        gain = 1,
        rate = 1,
        position = null,
        delay = 0,
        offset = 0,
        spatial = null,
        lowpassHz = null,
        highpassHz = null,
        stopAfter = null,
    } = {}) => {
        if (!context || context.state !== 'running' || disposed) return null;
        const names = FILES[group] ?? [];
        if (!names.length) return null;
        const chosen = index === null
            ? names[(variation++) % names.length]
            : names[clamp(Math.floor(index), 0, names.length - 1)];
        const buffer = buffers.get(chosen);
        if (!buffer) return null;
        const startOffset = clamp(Number(offset) || 0, 0, Math.max(0, buffer.duration - 0.01));
        if (startOffset >= buffer.duration - 0.009) return null;
        const source = context.createBufferSource();
        const voiceGain = context.createGain();
        source.buffer = buffer;
        source.playbackRate.value = clamp(rate, 0.55, 2.5);
        const assetTrim = ASSET_GAIN_TRIM[chosen] ?? 1;
        voiceGain.gain.value = clamp(gain, 0, 1.4) * assetTrim;
        source.connect(voiceGain);
        let voiceOutput = voiceGain;
        let filter = null;
        if (Number.isFinite(lowpassHz) || Number.isFinite(highpassHz)) {
            filter = context.createBiquadFilter();
            filter.type = Number.isFinite(highpassHz) ? 'highpass' : 'lowpass';
            const cutoff = Number.isFinite(highpassHz) ? highpassHz : lowpassHz;
            filter.frequency.value = clamp(cutoff, 80, 18000);
            filter.Q.value = 0.52;
            voiceGain.connect(filter);
            voiceOutput = filter;
        }
        let panner = null;
        if (position) {
            panner = configurePanner(position, spatial ?? {});
            voiceOutput.connect(panner).connect(effectsBus);
        } else {
            voiceOutput.connect(effectsBus);
        }
        const startAt = context.currentTime + Math.max(0, delay);
        source.start(startAt, startOffset);
        if (Number.isFinite(stopAfter) && stopAfter > 0) {
            source.stop(startAt + stopAfter);
        }
        stats.lastEvent = group;
        stats.lastAsset = chosen;
        stats.lastAssetTrim = assetTrim;
        stats.lastGain = voiceGain.gain.value;
        stats.lastRate = source.playbackRate.value;
        return {
            source,
            gainNode: voiceGain,
            filter,
            panner,
            group,
            name: chosen,
            buffer,
            offset: startOffset,
        };
    };

    const stopVoice = (voice, fadeSeconds = 0.08) => {
        if (!voice?.source || !context) return;
        const now = context.currentTime;
        const fade = Math.max(0.01, Number(fadeSeconds) || 0.08);
        try {
            const gain = voice.gainNode?.gain;
            if (gain) {
                gain.cancelScheduledValues(now);
                gain.setValueAtTime(gain.value, now);
                gain.linearRampToValueAtTime(0, now + fade);
            }
            voice.source.stop(now + fade + 0.01);
        } catch { /* source already ended */ }
    };

    // A gait contact owns one exclusive Foley voice. The authored clips last
    // 0.37-0.79 s while an ordinary walking stride schedules a contact about
    // every 0.44 s, so leaving old one-shots unmanaged layers a terrain tail
    // under the next material (most visibly gravel beneath ziggurat stone).
    // Retire the preceding contact before resolving the next one; the tiny
    // de-click fade is short enough to preserve cadence without an audible
    // double surface.
    const retireFootstep = (fadeSeconds = 0.012) => {
        if (!footstepVoice) return;
        const retiring = footstepVoice;
        footstepVoice = null;
        stats.footsteps.active = false;
        stats.footsteps.retired++;
        stopVoice(retiring, fadeSeconds);
    };

    const playFootstep = (surface, options) => {
        retireFootstep();
        const voice = play(surface, options);
        if (!voice) return null;
        footstepVoice = voice;
        stats.footsteps.plays++;
        stats.footsteps.active = true;
        stats.footsteps.surface = surface;
        stats.footsteps.asset = voice.name;
        const ownedVoice = voice;
        voice.source.onended = () => {
            if (footstepVoice !== ownedVoice) return;
            footstepVoice = null;
            stats.footsteps.active = false;
        };
        return voice;
    };

    const beginRain = () => {
        if (!context || rainSource || disposed) return;
        const buffer = buffers.get(FILES.rain[0]);
        if (!buffer) return;
        rainSource = context.createBufferSource();
        rainSource.buffer = buffer;
        rainSource.loop = true;
        rainSource.loopStart = 0;
        rainSource.loopEnd = buffer.duration;
        rainSource.connect(rainGain);
        rainSource.start();
    };

    const beginDesertWind = () => {
        if (!context || !windGain || windSource || disposed) return;
        const buffer = buffers.get(FILES.desertWind[0]);
        if (!buffer) return;
        windSource = context.createBufferSource();
        windSource.buffer = buffer;
        windSource.loop = true;
        windSource.loopStart = 0;
        windSource.loopEnd = buffer.duration;
        windSource.connect(windGain);
        windSource.start();
        setParam(windGain.gain, DESERT_WIND_LEVEL, context.currentTime, 1.8);
        stats.ambience.wind.ready = true;
        stats.ambience.wind.active = true;
        stats.ambience.wind.loopSeconds = buffer.duration;
    };

    const armNextBird = (initial = false, afterTime = context?.currentTime ?? 0) => {
        const range = initial ? BIRD_INITIAL_GAP_SECONDS : BIRD_QUIET_GAP_SECONDS;
        const gap = randomBetween(range[0], range[1]);
        birdNextAt = afterTime + gap;
        stats.ambience.birds.nextInSeconds = gap;
        stats.ambience.birds.suppressedByRain = false;
    };

    const updateDesertBirds = (rain = 0) => {
        if (!context || context.state !== 'running' || disposed) return;
        const birdStats = stats.ambience.birds;
        birdStats.ready = FILES.desertBirds.every((name) => buffers.has(name));
        if (!birdStats.ready) return;
        if (!Number.isFinite(birdNextAt)) armNextBird(true);

        const now = context.currentTime;
        birdStats.nextInSeconds = Math.max(0, birdNextAt - now);
        if (now < birdNextAt) return;

        // Birds shelter during material rain. Missing a due call starts a fresh
        // long quiet interval instead of firing immediately after the storm.
        if (rain > 0.14) {
            armNextBird(false, now);
            birdStats.suppressedByRain = true;
            return;
        }

        const candidates = FILES.desertBirds.filter((name) => name !== birdLastAsset);
        const chosen = candidates[Math.floor(Math.random() * candidates.length)];
        const index = FILES.desertBirds.indexOf(chosen);
        const angle = randomBetween(0, Math.PI * 2);
        const distance = randomBetween(BIRD_DISTANCE_METERS[0], BIRD_DISTANCE_METERS[1]);
        const x = Number(camera?.position?.x ?? 0) + Math.cos(angle) * distance;
        const z = Number(camera?.position?.z ?? 0) + Math.sin(angle) * distance;
        const sampledGround = Number(terrain?.heightAt?.(x, z));
        const y = Number.isFinite(sampledGround)
            ? sampledGround + randomBetween(10, 26)
            : Number(camera?.position?.y ?? 2) + randomBetween(8, 20);
        const position = { x, y, z };
        const voice = play('desertBirds', {
            index,
            gain: randomBetween(BIRD_GAIN_RANGE[0], BIRD_GAIN_RANGE[1]),
            rate: randomBetween(0.97, 1.035),
            position,
            lowpassHz: randomBetween(6200, 8200),
            spatial: { refDistance: 22, maxDistance: 260, rolloffFactor: 0.48 },
        });

        if (!voice) {
            armNextBird(false, now);
            return;
        }

        birdVoice = voice;
        birdLastAsset = voice.name;
        birdStats.active = true;
        birdStats.plays++;
        birdStats.lastAsset = voice.name;
        birdStats.lastDistanceMeters = distance;
        birdStats.lastPosition = [x, y, z];
        birdStats.lastGain = voice.gainNode.gain.value;
        birdStats.lastRate = voice.source.playbackRate.value;
        const quietGapStartsAt = now + voice.buffer.duration / voice.source.playbackRate.value;
        armNextBird(false, quietGapStartsAt);
        const ownedVoice = voice;
        voice.source.onended = () => {
            if (birdVoice !== ownedVoice) return;
            birdVoice = null;
            birdStats.active = false;
        };
    };

    const reportLoadResults = (results) => {
        results.forEach((result) => {
            if (result.status !== 'rejected') return;
            const message = String(result.reason?.message ?? result.reason);
            if (!warned.has(message)) {
                warned.add(message);
                console.warn('[audio] optional asset unavailable:', message);
            }
        });
    };

    const loadBuffer = (name) => {
        if (!context || disposed) return Promise.reject(new Error(`audio context unavailable for ${name}`));
        if (buffers.has(name)) return Promise.resolve(buffers.get(name));
        if (bufferLoads.has(name)) return bufferLoads.get(name);
        const request = (async () => {
            const response = await fetch(assetUrl(name));
            if (!response.ok) throw new Error(`${response.status} ${name}`);
            const decoded = await context.decodeAudioData(await response.arrayBuffer());
            if (disposed) return decoded;
            const ready = FILES.rain.includes(name) || FILES.desertWind.includes(name)
                ? blendAmbienceLoop(context, decoded) : decoded;
            buffers.set(name, ready);
            stats.loaded = buffers.size;
            if (FILES.gateOpen.includes(name) || FILES.gateClose.includes(name)) {
                stats.gate.ready = buffers.has(FILES.gateOpen[0]) && buffers.has(FILES.gateClose[0]);
                flushPendingGate();
            }
            if (FILES.flashlightOn.includes(name) || FILES.flashlightOff.includes(name)) {
                stats.flashlight.ready = buffers.has(FILES.flashlightOn[0]) && buffers.has(FILES.flashlightOff[0]);
                flushPendingFlashlight();
            }
            if (FILES.desertWind.includes(name)) beginDesertWind();
            if (FILES.desertBirds.includes(name)) {
                stats.ambience.birds.ready = FILES.desertBirds.every((bird) => buffers.has(bird));
                if (stats.ambience.birds.ready && !Number.isFinite(birdNextAt)) armNextBird(true);
            }
            // Rain should become audible as soon as its own buffer decodes;
            // waiting for every long thunder asset made active precipitation
            // appear silent during the rest of the background load.
            if (FILES.rain.includes(name)) beginRain();
            return ready;
        })().finally(() => bufferLoads.delete(name));
        bufferLoads.set(name, request);
        return request;
    };

    const loadAssets = async () => {
        if (!context || loading) return loading;
        // Decode interaction transients first. A flashlight key press can be
        // queued while its tiny click is decoding, then played as soon as the
        // current on/off asset is ready; gate motion retains the same policy.
        loading = (async () => {
            const priority = [
                ...FILES.flashlightOn, ...FILES.flashlightOff,
                ...FILES.gateOpen, ...FILES.gateClose,
                ...FILES.stone,
            ];
            const priorityResults = await Promise.allSettled(priority.map(loadBuffer));
            reportLoadResults(priorityResults);
            flushPendingGate();
            const rest = Object.values(FILES).flat().filter((name) => !priority.includes(name));
            const results = await Promise.allSettled(rest.map(loadBuffer));
            reportLoadResults(results);
            beginRain();
            beginDesertWind();
            return buffers;
        })();
        return loading;
    };

    const unlock = async (event) => {
        if (disposed || !event?.isTrusted || !AudioContextClass) return false;
        try {
            if (!context) {
                context = new AudioContextClass({ latencyHint: 'interactive' });
                master = context.createGain();
                effectsBus = context.createGain();
                weatherBus = context.createGain();
                rainGain = context.createGain();
                windGain = context.createGain();
                master.gain.value = 0.78;
                effectsBus.gain.value = 0.88;
                weatherBus.gain.value = 0.62;
                rainGain.gain.value = 0;
                windGain.gain.value = 0;
                effectsBus.connect(master);
                rainGain.connect(weatherBus);
                windGain.connect(weatherBus);
                weatherBus.connect(master);
                master.connect(context.destination);
            }
            if (context.state !== 'running') await context.resume();
            unlocked = context.state === 'running';
            stats.unlocked = unlocked;
            if (unlocked) void loadAssets();
            return unlocked;
        } catch (error) {
            const message = String(error?.message ?? error);
            if (!warned.has(message)) {
                warned.add(message);
                console.warn('[audio] user-gesture unlock failed:', message);
            }
            return false;
        }
    };

    const gesture = (event) => { void unlock(event); };
    addEventListener('pointerdown', gesture, { passive: true });
    addEventListener('keydown', gesture, { passive: true });
    addEventListener('touchstart', gesture, { passive: true });

    const updateListener = () => {
        if (!context || context.state !== 'running' || !camera) return;
        camera.updateMatrixWorld?.();
        const now = context.currentTime;
        const listener = context.listener;
        const p = camera.position;
        if (listener.positionX) {
            setParam(listener.positionX, p.x, now);
            setParam(listener.positionY, p.y, now);
            setParam(listener.positionZ, p.z, now);
            if (scratch?.set) {
                scratch.set(0, 0, -1).applyQuaternion(camera.quaternion);
                setParam(listener.forwardX, scratch.x, now);
                setParam(listener.forwardY, scratch.y, now);
                setParam(listener.forwardZ, scratch.z, now);
                scratch.set(0, 1, 0).applyQuaternion(camera.quaternion);
                setParam(listener.upX, scratch.x, now);
                setParam(listener.upY, scratch.y, now);
                setParam(listener.upZ, scratch.z, now);
            }
        } else if (scratch?.set) {
            listener.setPosition(p.x, p.y, p.z);
            scratch.set(0, 0, -1).applyQuaternion(camera.quaternion);
            const fx = scratch.x, fy = scratch.y, fz = scratch.z;
            scratch.set(0, 1, 0).applyQuaternion(camera.quaternion);
            listener.setOrientation(fx, fy, fz, scratch.x, scratch.y, scratch.z);
        }
    };

    const surfaceAtCamera = (movement) => {
        if (!camera) return 'gravel';
        const x = camera.position.x;
        const z = camera.position.z;
        const footY = Number(movement?.physicalEyeY) - Number(movement?.eyeHeight ?? 1.82);
        const ground = surfaceAt?.(x, z);
        if (ground?.kind === 'rock' && Math.abs(footY - ground.height) < 0.38) return 'stone';
        const authoredTempleSurface = temple?.walkSurfaceTypeAt?.(x, z, footY);
        if (authoredTempleSurface === 'stone' || authoredTempleSurface === 'sandstone') return 'stone';

        // Backward-compatible height fallback for a temple implementation
        // that has not yet exposed walkSurfaceTypeAt(). Height proximity is
        // deliberately secondary because the terrain may pass beneath upper
        // ziggurat tiers at the same x/z coordinate.
        const templeY = temple?.walkSurfaceHeightAt?.(x, z);
        if (Number.isFinite(templeY) && Math.abs(footY - templeY) < 0.38) return 'stone';

        // The authored valley floor is desert pavement/gravel by default.
        // Sand is reserved for the two actual dry-wash masks exposed by the
        // terrain ecology sampler; no noise-based sand patches are invented
        // independently of the visible surface paint.
        ecologyScratch.wash = 0;
        const ecology = terrain?.ecologyAt?.(x, z, ecologyScratch);
        const wash = Number(ecology?.wash ?? ecologyScratch.wash ?? 0);
        return Number.isFinite(wash) && wash >= 0.42 ? 'sand' : 'gravel';
    };

    const updateMovement = (dt, movement) => {
        if (!movement) return;
        const frameDt = clamp(Number(dt) || 0.016, 0.001, 0.1);
        const grounded = !!movement.grounded;
        const physicalY = Number(movement.physicalEyeY);
        if (!grounded) {
            const ySpeed = previousPhysicalY === null
                ? 0
                : Math.max(0, (previousPhysicalY - physicalY) / frameDt);
            peakFallSpeed = Math.max(peakFallSpeed, ySpeed, Math.max(0, -Number(movement.verticalVelocity || 0)));
        } else if (!previousGrounded) {
            if (peakFallSpeed > 2.2) {
                const strength = peakFallSpeed > 9 ? 2 : peakFallSpeed > 5 ? 1 : 0;
                play('land', {
                    index: strength,
                    gain: 0.18 + clamp(peakFallSpeed / 18, 0, 0.34),
                    rate: 0.98 + (variation % 5 - 2) * 0.012,
                });
            }
            peakFallSpeed = 0;
        }
        previousGrounded = grounded;
        previousPhysicalY = physicalY;

        const phase = Number(movement.bobPhase);
        const moving = grounded && Number(movement.horizontalSpeed) > 0.32;
        const footIndex = Number.isFinite(phase) ? Math.floor(phase / Math.PI) : 0;
        if (moving && lastFootIndex !== null && footIndex !== lastFootIndex) {
            stats.footsteps.gaitEvents++;
            const surface = surfaceAtCamera(movement);
            stats.surface = surface;
            if (surface !== lastLoggedSurface) {
                lastLoggedSurface = surface;
                console.log('[audio] footstep surface ->', surface);
            }
            const speed = Number(movement.horizontalSpeed) || 0;
            playFootstep(surface, {
                // Close player Foley should sit well below weather, machinery,
                // and the scene rather than reading as giant cinematic impacts.
                gain: clamp(0.085 + speed * 0.014, 0.10, 0.22),
                rate: 0.97 + ((variation * 17) % 7) * 0.008
                    + clamp((speed - 3.6) * 0.006, 0, 0.045),
                // Stone keeps its high band: the old 5000 Hz cut removed the
                // hard click that separates masonry from packed terrain, so
                // temple steps read as dirt even with the right samples.
                lowpassHz: surface === 'sand' ? 3600
                    : surface === 'stone' || surface === 'sandstone' ? 7800
                        : 5600,
            });
        }
        lastFootIndex = footIndex;
    };

    const updateGateWorld = () => {
        if (gateDoor?.isObject3D && gateDoorCenterLocal?.isVector3) {
            gateDoor.updateWorldMatrix?.(true, false);
            gateWorld.copy(gateDoorCenterLocal);
            gateDoor.localToWorld(gateWorld);
        } else if (temple?.group && gateWorld?.set) {
            gateWorld.set(0, 2.8, Number(temple.group.userData?.gate?.frontZ ?? 48));
            temple.group.localToWorld(gateWorld);
        }
        stats.gate.position = gateWorld?.toArray?.() ?? [gateWorld.x, gateWorld.y, gateWorld.z];
        stats.gate.distance = camera?.position?.distanceTo?.(gateWorld) ?? null;
        if (gateVoice?.panner && context?.state === 'running') {
            setPannerPosition(gateVoice.panner, gateWorld, context.currentTime, true);
        }
    };

    const GATE_SETTLED_EPSILON = 0.0005;
    const gateTiming = (direction, progress, buffer) => {
        const opening = direction === 'open';
        const response = opening ? 3.8 : 2.7;
        const residual = opening ? 1 - progress : progress;
        const elapsed = -Math.log(clamp(residual, GATE_SETTLED_EPSILON, 1)) / response;
        const total = -Math.log(GATE_SETTLED_EPSILON) / response;
        const rate = buffer.duration / total;
        // If decoding completed after the physical gate settled, retain a
        // short end-latch instead of either replaying the whole move or going
        // silent. Otherwise offset/rate map audio time exactly to motion time.
        const tail = opening ? 0.18 : 0.22;
        const offset = Math.min(elapsed * rate, Math.max(0, buffer.duration - tail));
        return { rate, offset, total, elapsed };
    };

    const playGateDirection = (direction) => {
        const target = Number(temple?.state?.gateTarget ?? temple?.gateTarget ?? 0);
        const progress = clamp(Number(temple?.state?.gateProgress ?? temple?.gateProgress ?? 0), 0, 1);
        const stillCurrent = direction === 'open' ? target > 0.5 : target <= 0.5;
        if (!stillCurrent) {
            if (gatePending?.direction === direction) gatePending = null;
            stats.gate.pending = gatePending?.direction ?? null;
            return false;
        }
        const group = direction === 'open' ? 'gateOpen' : 'gateClose';
        const name = FILES[group][0];
        const buffer = buffers.get(name);
        if (!context || context.state !== 'running' || !buffer) {
            gatePending = { direction };
            stats.gate.pending = direction;
            return false;
        }

        updateGateWorld();
        if (gateVoice) stopVoice(gateVoice, 0.07);
        const timing = gateTiming(direction, progress, buffer);
        const voice = play(group, {
            gain: 0.72,
            rate: timing.rate,
            offset: timing.offset,
            position: gateWorld,
            spatial: { refDistance: 18, maxDistance: 600, rolloffFactor: 0.25 },
        });
        if (!voice) {
            gatePending = { direction };
            stats.gate.pending = direction;
            return false;
        }

        gateVoice = voice;
        gatePending = null;
        stats.gate.direction = direction;
        stats.gate.pending = null;
        stats.gate.active = true;
        stats.gate.plays++;
        stats.gate.rate = timing.rate;
        stats.gate.offset = timing.offset;
        const ownedVoice = voice;
        voice.source.onended = () => {
            if (gateVoice !== ownedVoice) return;
            gateVoice = null;
            stats.gate.active = false;
        };
        return true;
    };

    function flushPendingGate() {
        if (!gatePending || disposed) return false;
        return playGateDirection(gatePending.direction);
    }

    function flushPendingFlashlight() {
        if (pendingFlashlightToggle === null || disposed) return false;
        const enabled = pendingFlashlightToggle;
        const group = enabled ? 'flashlightOn' : 'flashlightOff';
        const name = FILES[group][0];
        if (!context || context.state !== 'running' || !buffers.has(name)) return false;
        if (flashlightVoice) stopVoice(flashlightVoice, 0.012);
        const voice = play(group, { gain: 0.12 });
        if (!voice) return false;
        flashlightVoice = voice;
        pendingFlashlightToggle = null;
        stats.flashlight.pending = null;
        stats.flashlight.active = true;
        stats.flashlight.plays++;
        const ownedVoice = voice;
        voice.source.onended = () => {
            if (flashlightVoice !== ownedVoice) return;
            flashlightVoice = null;
            stats.flashlight.active = false;
        };
        return true;
    }

    function playFlashlightToggle(enabled) {
        const next = Boolean(enabled);
        pendingFlashlightToggle = next;
        stats.flashlight.enabled = next;
        stats.flashlight.pending = next ? 'on' : 'off';
        return flushPendingFlashlight();
    }

    const queueGateDirection = (direction) => {
        if (gateVoice) {
            stopVoice(gateVoice, 0.07);
            gateVoice = null;
            stats.gate.active = false;
        }
        gatePending = { direction };
        stats.gate.pending = direction;
        playGateDirection(direction);
    };

    const updateGate = () => {
        const target = Number(temple?.state?.gateTarget ?? temple?.gateTarget ?? 0);
        const progress = clamp(Number(temple?.state?.gateProgress ?? temple?.gateProgress ?? 0), 0, 1);
        updateGateWorld();
        stats.gate.target = target;
        stats.gate.progress = progress;
        if (target > 0.5 && previousGateTarget <= 0.5) {
            queueGateDirection('open');
        } else if (target <= 0.5 && previousGateTarget > 0.5) {
            queueGateDirection('close');
        }
        previousGateTarget = target;
    };

    const trackThunderVoice = (voice, pool, cap, statKey) => {
        if (!voice) return null;
        while (pool.length >= cap) stopVoice(pool.shift(), 0.06);
        pool.push(voice);
        stats.thunder[statKey] = pool.length;
        const owned = voice;
        voice.source.onended = () => {
            const index = pool.indexOf(owned);
            if (index >= 0) pool.splice(index, 1);
            stats.thunder[statKey] = pool.length;
        };
        return voice;
    };

    const triggerThunder = ({
        position = null,
        distant = false,
        local = false,
        distance = Infinity,
        delay = 0,
    } = {}) => {
        const safeDistance = Math.max(0, Number(distance) || 0);
        const eventIndex = variation++;
        const rate = 0.93 + ((eventIndex * 11) % 11) * 0.014;
        stats.thunder.lastDistanceMeters = safeDistance;
        stats.thunder.lastDelaySeconds = Math.max(0, Number(delay) || 0);
        if (local) stats.thunder.local++;
        if (distant) {
            const index = eventIndex % FILES.thunderDistant.length;
            const body = play('thunderDistant', {
                index,
                gain: 0.64,
                position,
                delay,
                rate,
                spatial: { refDistance: 100, maxDistance: 2600, rolloffFactor: 0.38 },
            });
            stats.thunder.bodies += body ? 1 : 0;
            stats.thunder.distant += body ? 1 : 0;
            return trackThunderVoice(
                body, thunderBodies, THUNDER_BODY_CAP, 'activeBodies',
            );
        }

        // Strikes near the player get the synthesized explosive clap — sharp
        // crack, tearing mid, deep sub boom — with the licensed rolling take
        // blended in behind it as the long tail. The rolling recordings alone
        // read as distant thunder at any gain; that mismatch was the repeated
        // "no quick loud thunder on close strikes" report. Distant strikes are
        // untouched, and every path keeps the physical distance/343 delay.
        if (local || safeDistance <= 150) {
            const blastIndex = eventIndex % FILES.thunderExplosive.length;
            const blast = play('thunderExplosive', {
                index: blastIndex,
                gain: 1.9,
                position,
                delay,
                rate,
                spatial: { refDistance: 80, maxDistance: 1600, rolloffFactor: 0.4 },
            });
            stats.thunder.cracks += blast ? 1 : 0;
            trackThunderVoice(blast, thunderCracks, THUNDER_CRACK_CAP, 'activeCracks');
            const tailIndex = eventIndex % FILES.thunderClose.length;
            const tail = play('thunderClose', {
                index: tailIndex,
                gain: 0.62,
                position,
                delay: delay + 0.35,
                offset: Math.max(0, (THUNDER_CLOSE_ONSETS[tailIndex] ?? 0) - 0.035),
                rate,
                lowpassHz: 5200,
                spatial: { refDistance: 90, maxDistance: 2200, rolloffFactor: 0.34 },
            });
            stats.thunder.bodies += tail ? 1 : 0;
            trackThunderVoice(tail, thunderBodies, THUNDER_BODY_CAP, 'activeBodies');
            return blast ?? tail;
        }

        const index = eventIndex % FILES.thunderClose.length;
        const onset = THUNDER_CLOSE_ONSETS[index] ?? 0;
        const body = play('thunderClose', {
            index,
            gain: 0.90,
            position,
            delay,
            offset: Math.max(0, onset - 0.035),
            rate,
            lowpassHz: 8200,
            spatial: { refDistance: 90, maxDistance: 2200, rolloffFactor: 0.34 },
        });
        stats.thunder.bodies += body ? 1 : 0;
        trackThunderVoice(body, thunderBodies, THUNDER_BODY_CAP, 'activeBodies');

        // The 150-360 m ring still layers an immediate high-passed crack over
        // the rolling body so mid-range strikes keep some electrical snap.
        if (safeDistance <= 180) {
            const crack = play('thunderClose', {
                index,
                gain: 0.92,
                position,
                delay,
                offset: onset,
                rate,
                highpassHz: 1150,
                stopAfter: 0.72,
                spatial: { refDistance: 55, maxDistance: 1400, rolloffFactor: 0.44 },
            });
            stats.thunder.cracks += crack ? 1 : 0;
            trackThunderVoice(
                crack, thunderCracks, THUNDER_CRACK_CAP, 'activeCracks',
            );
        }
        return body;
    };

    const updateWeather = (nowSeconds) => {
        const weather = globalThis._weather;
        const rain = clamp(Number(weather?.uniforms?.rainK?.value ?? 0), 0, 1);
        stats.rain = rain;
        if (context && rainGain) {
            beginRain();
            setParam(rainGain.gain, rain * rain * 0.72, context.currentTime, rain > 0 ? 1.4 : 2.8);
        }

        const strike = weather?.state?.strike;
        const strikeKey = strike?.id ?? (strike
            ? `${strike.x.toFixed(2)},${strike.y ?? 0},${strike.z.toFixed(2)}`
            : null);
        // `strike.flash` is the authoritative v2 event gate. Retain the old
        // light-intensity fallback for mocked/legacy weather facades.
        const flashLevel = Number(strike?.flash
            ?? (Number(weather?.bolt?.intensity ?? 0) > 0 ? 1 : 0));
        if (strikeKey !== null && strikeKey !== previousStrike && flashLevel > 0.03) {
            previousStrike = strikeKey;
            const dx = Number(strike.x) - Number(camera?.position?.x ?? 0);
            const dy = Number(strike.y ?? 0) - Number(camera?.position?.y ?? 0);
            const dz = Number(strike.z) - Number(camera?.position?.z ?? 0);
            const distance = Math.hypot(dx, dy, dz);
            const thunderPosition = gateWorld?.clone?.();
            thunderPosition?.set?.(
                Number(strike.x), Number(strike.y ?? 0), Number(strike.z),
            );
            triggerThunder({
                position: thunderPosition,
                distant: distance > 360,
                local: strike.local === true,
                distance,
                delay: distance / 343,
            });
        }
        return rain;
    };

    return {
        stats,
        get context() { return context; },
        get unlocked() { return unlocked; },
        unlock,
        triggerThunder,
        playFlashlightToggle,
        setMasterVolume(value) {
            if (context && master) setParam(master.gain, clamp(Number(value) || 0, 0, 1), context.currentTime, 0.04);
        },
        update(dt = 0.016, nowSeconds = performance.now() * 0.001, movement = globalThis._movementState) {
            if (disposed) return;
            updateListener();
            updateMovement(dt, movement);
            updateGate();
            const rain = updateWeather(Number(nowSeconds) || 0);
            updateDesertBirds(rain);
        },
        async dispose() {
            if (disposed) return;
            disposed = true;
            removeEventListener('pointerdown', gesture);
            removeEventListener('keydown', gesture);
            removeEventListener('touchstart', gesture);
            gatePending = null;
            retireFootstep(0.01);
            if (gateVoice) stopVoice(gateVoice, 0.01);
            gateVoice = null;
            pendingFlashlightToggle = null;
            if (flashlightVoice) stopVoice(flashlightVoice, 0.01);
            flashlightVoice = null;
            if (birdVoice) stopVoice(birdVoice, 0.04);
            birdVoice = null;
            for (const voice of thunderBodies.splice(0)) stopVoice(voice, 0.01);
            for (const voice of thunderCracks.splice(0)) stopVoice(voice, 0.01);
            stats.thunder.activeBodies = 0;
            stats.thunder.activeCracks = 0;
            try { rainSource?.stop(); } catch { /* already stopped */ }
            try { windSource?.stop(); } catch { /* already stopped */ }
            windSource = null;
            birdNextAt = Infinity;
            buffers.clear();
            bufferLoads.clear();
            if (context && context.state !== 'closed') await context.close();
            context = null;
        },
    };
}
