#!/usr/bin/env node

// Isolated regression coverage for the real gait scheduler. No browser, GPU,
// audio device, or asset decoding is required: a small Web Audio double records
// the exact buffers that audio_system.js schedules.

import { makeAudioSystem } from '../src/audio_system.js';

let assertions = 0;
const failures = [];
const check = (condition, message) => {
    assertions++;
    if (!condition) failures.push(message);
};

class Param {
    constructor(value = 0) { this.value = value; }
    cancelScheduledValues() {}
    setTargetAtTime(value) { this.value = value; }
    setValueAtTime(value) { this.value = value; }
    linearRampToValueAtTime(value) { this.value = value; }
}

class Node {
    connect(target) { return target; }
}

class Source extends Node {
    constructor(context) {
        super();
        this.context = context;
        this.buffer = null;
        this.playbackRate = new Param(1);
        this.onended = null;
        this.stopTimes = [];
    }
    start(when = 0, offset = 0) {
        this.context.starts.push({
            source: this,
            name: this.buffer?.name ?? null,
            when,
            offset,
        });
    }
    stop(when = 0) {
        this.stopTimes.push(when);
        this.context.stops.push({
            source: this,
            name: this.buffer?.name ?? null,
            when,
        });
    }
}

class Vec3 {
    constructor(x = 0, y = 0, z = 0) {
        this.x = x;
        this.y = y;
        this.z = z;
    }
    clone() { return new Vec3(this.x, this.y, this.z); }
    set(x, y, z) {
        this.x = x;
        this.y = y;
        this.z = z;
        return this;
    }
    copy(other) { return this.set(other.x, other.y, other.z); }
    applyQuaternion() { return this; }
    distanceTo(other) {
        return Math.hypot(this.x - other.x, this.y - other.y, this.z - other.z);
    }
    toArray() { return [this.x, this.y, this.z]; }
}

class FakeAudioContext {
    constructor() {
        this.currentTime = 10;
        this.state = 'running';
        this.starts = [];
        this.stops = [];
        this.destination = new Node();
        this.listener = {
            positionX: new Param(),
            positionY: new Param(),
            positionZ: new Param(),
            forwardX: new Param(),
            forwardY: new Param(),
            forwardZ: new Param(),
            upX: new Param(),
            upY: new Param(),
            upZ: new Param(),
        };
    }
    createGain() {
        const node = new Node();
        node.gain = new Param(1);
        return node;
    }
    createBiquadFilter() {
        const node = new Node();
        node.type = 'lowpass';
        node.frequency = new Param();
        node.Q = new Param();
        return node;
    }
    createPanner() {
        const node = new Node();
        node.positionX = new Param();
        node.positionY = new Param();
        node.positionZ = new Param();
        return node;
    }
    createBufferSource() { return new Source(this); }
    async decodeAudioData(payload) {
        return { name: payload.name, duration: 0.65 };
    }
    async resume() { this.state = 'running'; }
    async close() { this.state = 'closed'; }
}

const previous = {
    AudioContext: globalThis.AudioContext,
    fetch: globalThis.fetch,
    addEventListener: globalThis.addEventListener,
    removeEventListener: globalThis.removeEventListener,
    weather: globalThis._weather,
};

globalThis.AudioContext = FakeAudioContext;
globalThis.addEventListener = () => {};
globalThis.removeEventListener = () => {};
globalThis._weather = null;
globalThis.fetch = async (request) => {
    const name = new URL(String(request)).pathname.split('/').pop();
    return {
        ok: true,
        async arrayBuffer() { return { name }; },
    };
};

let templeSurface = null;
const camera = {
    position: new Vec3(0, 1.82, 0),
    quaternion: {},
    updateMatrixWorld() {},
};
const temple = {
    state: { gateTarget: 0, gateProgress: 0 },
    walkSurfaceTypeAt() { return templeSurface; },
    walkSurfaceHeightAt() { return null; },
};
const terrain = {
    ecologyAt(x, z, target) {
        target.wash = 0;
        return target;
    },
};

let rockSurface = null;
const audio = makeAudioSystem({ camera, temple, terrain, surfaceAt: () => rockSurface });
await audio.unlock({ isTrusted: true });
for (let attempt = 0; attempt < 40 && audio.stats.loaded < audio.stats.expected; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
}

check(audio.stats.loaded === audio.stats.expected,
    'all fake buffers finish loading before the gait assertions');
audio.context.starts.length = 0;
audio.context.stops.length = 0;

const movement = {
    eyeHeight: 1.82,
    physicalEyeY: 1.82,
    verticalVelocity: 0,
    grounded: true,
    horizontalSpeed: 3.6,
    bobPhase: 0,
};
const contacts = () => audio.context.starts.filter((event) => (
    event.name?.startsWith('footstep_')
));

// Initial phase establishes the scheduler baseline and must stay silent.
audio.update(0.016, 20, movement);
check(contacts().length === 0, 'baseline gait phase does not fabricate a contact');

// One terrain stride boundary schedules one and only one gravel voice.
movement.bobPhase = Math.PI + 0.01;
audio.context.currentTime += 0.44;
audio.update(0.016, 20.44, movement);
check(contacts().length === 1, 'one gait boundary schedules exactly one contact');
check(contacts()[0]?.name?.startsWith('footstep_gravel_'),
    'ordinary desert pavement schedules the gravel family');
const gravelSource = contacts()[0]?.source;

// The next boundary is on authored architecture. Stone must win and the old
// terrain tail must be explicitly retired before it can remain as a full clip.
templeSurface = 'stone';
movement.bobPhase = Math.PI * 2 + 0.01;
audio.context.currentTime += 0.44;
audio.update(0.016, 20.88, movement);
check(contacts().length === 2, 'second gait boundary adds only one new contact');
check(contacts()[1]?.name?.startsWith('footstep_stone_'),
    'authored ziggurat stone overrides terrain ecology');
check(gravelSource?.stopTimes.length === 1,
    'the preceding gravel tail is retired when stone begins');
check(audio.stats.footsteps.gaitEvents === 2
    && audio.stats.footsteps.plays === 2,
    'scheduler reports one successful playback per gait event');
check(audio.stats.footsteps.retired === 1,
    'exclusive gait ownership records one retired predecessor');
check(audio.stats.footsteps.surface === 'stone'
    && audio.stats.surface === 'stone',
    'runtime telemetry retains the winning authored surface');

// The legacy temple spelling is normalized to the same dedicated stone bank.
templeSurface = 'sandstone';
movement.bobPhase = Math.PI * 3 + 0.01;
audio.context.currentTime += 0.44;
audio.update(0.016, 21.32, movement);
check(contacts().length === 3, 'third gait boundary still schedules one contact');
check(contacts()[2]?.name?.startsWith('footstep_stone_'),
    'sandstone temple identity normalizes to the dedicated stone family');
check(contacts()[1]?.source?.stopTimes.length === 1,
    'the preceding stone voice is also retired at the next gait boundary');

// Phase changes while stationary or airborne cannot leak extra contacts.
movement.horizontalSpeed = 0;
movement.bobPhase = Math.PI * 4 + 0.01;
audio.update(0.016, 21.76, movement);
movement.horizontalSpeed = 3.6;
movement.grounded = false;
movement.bobPhase = Math.PI * 5 + 0.01;
audio.update(0.016, 22.20, movement);
check(contacts().length === 3,
    'stationary and airborne phase changes schedule no footsteps');

// A real rock support selects stone. A nearby rock above the feet does not.
templeSurface = null;
movement.grounded = true;
rockSurface = {kind:'rock',height:0};
movement.bobPhase = Math.PI * 6 + 0.01;
audio.context.currentTime += 0.44;
audio.update(0.016, 22.64, movement);
check(contacts().at(-1)?.name?.startsWith('footstep_stone_'),
    'standing on a rock schedules stone instead of ground gravel');
rockSurface.height = 4;
movement.bobPhase = Math.PI * 7 + 0.01;
audio.context.currentTime += 0.44;
audio.update(0.016, 23.08, movement);
check(contacts().at(-1)?.name?.startsWith('footstep_gravel_'),
    'a rock above the feet cannot override the supporting ground sound');

await audio.dispose();
check(audio.context === null, 'focused audio harness disposes cleanly');

globalThis.AudioContext = previous.AudioContext;
globalThis.fetch = previous.fetch;
globalThis.addEventListener = previous.addEventListener;
globalThis.removeEventListener = previous.removeEventListener;
globalThis._weather = previous.weather;

if (failures.length) {
    console.error('Audio footstep runtime audit FAILED');
    for (const failure of failures) console.error(' - ' + failure);
    process.exitCode = 1;
} else {
    console.log('Audio footstep runtime audit PASS: ' + assertions + ' assertions');
}
