import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const [source, wrapperSource] = await Promise.all([
    readFile(new URL('../engine/weather_system.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/weathersky.js', import.meta.url), 'utf8'),
]);

// Minimal CPU Three/TSL facade. It executes the real makeWeatherSystem(),
// setWeather(), update(), impact, registry, and dispose paths without creating
// a renderer, browser, GPU device, server, or audio context.
const node = (value = 0) => new Proxy({ value }, {
    get(target, property) {
        if (property === 'value') return target.value;
        if (property in target) return target[property];
        if (['x', 'y', 'z', 'w', 'r', 'g', 'b', 'a', 'rgb', 'xz'].includes(property)) {
            return node();
        }
        return () => node();
    },
    set(target, property, next) {
        target[property] = next;
        return true;
    },
});

class Vector3 {
    constructor(x = 0, y = 0, z = 0) { this.set(x, y, z); }
    set(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; return this; }
    copy(v) { return this.set(v.x, v.y, v.z); }
    clone() { return new Vector3(this.x, this.y, this.z); }
    add(v) { this.x += v.x; this.y += v.y; this.z += v.z; return this; }
    sub(v) { this.x -= v.x; this.y -= v.y; this.z -= v.z; return this; }
    multiplyScalar(s) { this.x *= s; this.y *= s; this.z *= s; return this; }
    addScaledVector(v, s) { this.x += v.x * s; this.y += v.y * s; this.z += v.z * s; return this; }
    lengthSq() { return this.x * this.x + this.y * this.y + this.z * this.z; }
    length() { return Math.sqrt(this.lengthSq()); }
    normalize() { const l = this.length(); return l > 1e-12 ? this.multiplyScalar(1 / l) : this; }
    cross(v) { return this.crossVectors(this.clone(), v); }
    crossVectors(a, b) {
        return this.set(
            a.y * b.z - a.z * b.y,
            a.z * b.x - a.x * b.z,
            a.x * b.y - a.y * b.x,
        );
    }
    lerpVectors(a, b, t) {
        return this.set(
            a.x + (b.x - a.x) * t,
            a.y + (b.y - a.y) * t,
            a.z + (b.z - a.z) * t,
        );
    }
    applyNormalMatrix() { return this; }
}

class Vector4 extends Vector3 {
    constructor(x = 0, y = 0, z = 0, w = 0) { super(x, y, z); this.w = w; }
    set(x = 0, y = 0, z = 0, w = 0) { super.set(x, y, z); this.w = w; return this; }
    clone() { return new Vector4(this.x, this.y, this.z, this.w); }
}

class Quaternion {
    setFromUnitVectors() { return this; }
}

class Matrix3 { getNormalMatrix() { return this; } }
class Matrix4 {
    constructor() { this.elements = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]; }
    copy() { return this; }
    multiplyMatrices() { return this; }
    compose() { return this; }
}

class Color {
    constructor(hex = 0xffffff) { this.setHex(hex); }
    setHex(hex) {
        this.hex = hex;
        this.r = ((hex >>> 16) & 255) / 255;
        this.g = ((hex >>> 8) & 255) / 255;
        this.b = (hex & 255) / 255;
        return this;
    }
    copy(other) { this.hex = other.hex; this.r = other.r; this.g = other.g; this.b = other.b; return this; }
}

class Object3D {
    constructor() {
        this.name = '';
        this.visible = true;
        this.userData = {};
        this.position = new Vector3();
        this.quaternion = new Quaternion();
        this.scale = new Vector3(1, 1, 1);
        this.matrixWorld = new Matrix4();
        this.parent = null;
    }
    updateWorldMatrix() {}
}

class Geometry {
    constructor(kind = 'geometry') { this.kind = kind; this.disposed = false; }
    translate() { return this; }
    rotateX() { return this; }
    dispose() { this.disposed = true; }
}
class PlaneGeometry extends Geometry { constructor() { super('plane'); } }
class OctahedronGeometry extends Geometry { constructor() { super('octahedron'); } }
class IcosahedronGeometry extends Geometry { constructor() { super('icosahedron'); } }
class CircleGeometry extends Geometry { constructor() { super('circle'); } }
class BufferAttribute {
    constructor(array, itemSize) { this.array = array; this.itemSize = itemSize; this.needsUpdate = false; }
    setUsage() { return this; }
}
class BufferGeometry extends Geometry {
    constructor() { super('buffer'); this.attributes = {}; this.index = null; this.drawRange = { start: 0, count: 0 }; }
    setAttribute(name, attribute) { this.attributes[name] = attribute; return this; }
    setIndex(attribute) { this.index = attribute; return this; }
    setDrawRange(start, count) { this.drawRange = { start, count }; }
    computeBoundingSphere() {}
}

class Material {
    constructor(options = {}) {
        Object.assign(this, options);
        this.userData = {};
        this.isNodeMaterial = true;
        this.visible = true;
        this.disposed = false;
    }
    dispose() { this.disposed = true; }
}
class MeshBasicNodeMaterial extends Material {}
class Mesh extends Object3D {
    constructor(geometry, material) { super(); this.geometry = geometry; this.material = material; this.isMesh = true; }
}
class InstancedMesh extends Mesh {
    constructor(geometry, material, count) {
        super(geometry, material);
        this.count = count;
        this.instanceMatrix = { needsUpdate: false };
        this.matrices = [];
    }
    setMatrixAt(index, matrix) { this.matrices[index] = matrix; }
    dispose() { this.disposed = true; }
}
class PointLight extends Object3D {
    constructor(hex, intensity, distance, decay) {
        super();
        this.color = new Color(hex);
        this.intensity = intensity;
        this.distance = distance;
        this.decay = decay;
    }
}
class Raycaster {
    set() {}
    intersectObjects(_roots, _recursive, target = []) { return target; }
}

class Scene {
    constructor() { this.children = []; }
    add(...objects) {
        for (const object of objects) {
            if (!this.children.includes(object)) this.children.push(object);
            object.parent = this;
        }
    }
    remove(...objects) {
        const removed = new Set(objects);
        this.children = this.children.filter((object) => !removed.has(object));
        for (const object of objects) if (object.parent === this) object.parent = null;
    }
    traverse(callback) { for (const child of this.children) callback(child); }
}

const tsl = () => node();
const THREE = {
    Vector3, Vector4, Quaternion, Matrix3, Matrix4, Color,
    PlaneGeometry, OctahedronGeometry, IcosahedronGeometry, CircleGeometry,
    BufferGeometry, BufferAttribute, MeshBasicNodeMaterial, Mesh, InstancedMesh,
    PointLight, Raycaster,
    uniform: (value) => node(value),
    Fn: tsl,
    vec2: tsl,
    vec3: tsl,
    vec4: tsl,
    float: tsl,
    instanceIndex: node(),
    positionLocal: node(),
    uv: tsl,
    fract: tsl,
    floor: tsl,
    mix: tsl,
    clamp: tsl,
    smoothstep: tsl,
    dot: tsl,
    normalize: tsl,
    max: tsl,
    min: tsl,
    pow: tsl,
    abs: tsl,
    exp: tsl,
    sin: tsl,
    cos: tsl,
    length: tsl,
    atan2: tsl,
    cameraPosition: node(),
    normalWorld: node(),
    positionWorld: node(),
    materialColor: node(),
    materialRoughness: node(),
    materialMetalness: node(),
    AdditiveBlending: 'additive',
    DoubleSide: 'double',
    DynamicDrawUsage: 'dynamic',
};

const quietConsole = { log() {}, warn() {}, error() {} };
const context = vm.createContext({ THREE, console: quietConsole });
vm.runInContext(source, context, { filename: 'engine/weather_system.js' });

const makeUniform = (value) => node(value);
const makeSky = () => {
    const vectorUniformNames = [
        'skyWind', 'stretch', 'wispStretch', 'wispTint', 'wispColor',
        'sunDir', 'zenith', 'horizon', 'lightningFlashColor',
    ];
    const scalarUniformNames = [
        'cloudDim', 'cloudRadiance', 'sunDiscI', 'precipK', 'precipLo', 'precipHi',
        'largeT', 'largeA', 'weatherT', 'finalMul', 'wScale', 'dScale', 'cloudStart',
        'cloudHeight', 'lightK', 'wispOn', 'wispScale', 'wispThreshold',
        'wispStrength', 'wispOpacity', 'wispFloor', 'wispFilament',
        'lightCacheDirect', 'stormCanopy', 'celestialVisibility',
    ];
    const uniforms = Object.fromEntries(scalarUniformNames.map((name) => [name, makeUniform(0)]));
    for (const name of vectorUniformNames) uniforms[name] = makeUniform(new Vector3());
    uniforms.cloudStart.value = 500;
    uniforms.cloudHeight.value = 420;
    uniforms.lightningStrike = makeUniform(new Vector4(0, 500, 0, 0));
    const sky = {
        uniforms,
        state: {
            preset: 'clear',
            palette: { zen: [0.08, 0.10, 0.14], hor: [0.12, 0.13, 0.16] },
        },
        domes: [],
        setClouds(preset, over = {}) {
            this.state.preset = preset;
            for (const [key, value] of Object.entries(over)) {
                const mapped = key === 'start' ? 'cloudStart' : key === 'height' ? 'cloudHeight' : key;
                if (!this.uniforms[mapped]) continue;
                if (Array.isArray(value)) this.uniforms[mapped].value.set(...value);
                else this.uniforms[mapped].value = value;
            }
        },
        weatherAt() { return 0; },
        tslCoverage: tsl,
        invalidateOptimizedCaches() {},
    };
    return sky;
};

const makeCamera = () => ({
    position: new Vector3(0, 2, 0),
    quaternion: new Quaternion(),
    matrixWorld: new Matrix4(),
    getWorldDirection(target) { return target.set(0, 0, -1); },
});

const scene = new Scene();
const sky = makeSky();
const camera = makeCamera();
const impacts = [];
const makeSystem = () => context.makeWeatherSystem({
    scene,
    sky,
    opts: {
        rainCount: 0,
        splashCount: 0,
        strikeTargets: () => [],
        strikeHeightAt: () => 0,
        onLocalStrike: (impact) => impacts.push(JSON.parse(JSON.stringify(impact))),
    },
});

const weather = await makeSystem();
weather.setWeather('darkstorm', 1);
assert.equal(weather.update(0, camera), true, 'live owner accepts its CPU update');
const firstEventAt = weather.diagnostics.lightning.nextEventAtSeconds;
assert.ok(firstEventAt >= 6 && firstEventAt <= 9,
    `first Dark Storm event is scheduled in 6-9 seconds (got ${firstEventAt})`);

weather.update(firstEventAt - 0.001, camera);
assert.equal(weather.diagnostics.lightning.eventCount, 0,
    'no event starts before its seconds-based deadline');
assert.equal(weather.bolt.intensity, 0, 'scene light stays dark before the event');

weather.update(firstEventAt, camera);
assert.equal(weather.diagnostics.lightning.eventCount, 1,
    'exactly one event starts at the first deadline');
assert.equal(weather.state.strike?.local, true,
    'first Dark Storm event commits the promised local strike');
assert.equal(weather.state.strike?.kind, 'terrain_heightfield',
    'empty raycast roots still reach the real heightfield fallback');
assert.equal(impacts.length, 1, 'local strike emits one atomic surface-damage event');
assert.equal(weather.state.lastImpact?.radiusMeters, 4.5,
    'committed surface damage exposes its honest bounded radius');
const impactDistance = Math.hypot(weather.state.strike.x, weather.state.strike.z);
assert.ok(impactDistance >= 34 && impactDistance <= 58,
    `forced strike is framed inside the visible 34-58m band (got ${impactDistance})`);

weather.update(firstEventAt + 0.05, camera);
assert.ok(scene.children.some((object) =>
    object.name.startsWith('weather_lightning_impact_puff_')
        && object.geometry.kind === 'icosahedron'
        && object.visible),
'a successful local strike activates a pooled 3D impact puff');
assert.ok(scene.children.some((object) =>
    object.name.startsWith('weather_lightning_scorch_') && object.visible),
'the same committed local strike activates a temporary scorch');

for (let step = 1; step <= 1000; step++) {
    weather.update(firstEventAt + 0.05 + step * 0.001, camera);
}
assert.equal(weather.diagnostics.lightning.eventCount, 1,
    'one thousand 1ms updates cannot retrigger lightning');
assert.ok(weather.bolt.intensity < 0.001,
    'bounded scene illumination decays instead of sticking white');
assert.ok(weather.uniforms.rainLight.value >= 0.20
    && weather.uniforms.rainLight.value < 0.50,
'settled sealed canopy keeps heavy rain legible without emissive brightness');
const secondEventAt = weather.diagnostics.lightning.nextEventAtSeconds;
assert.ok(secondEventAt - firstEventAt >= 12 && secondEventAt - firstEventAt <= 28,
    `the next runtime event retains the authored 12-28s dark interval (got ${secondEventAt - firstEventAt})`);

const staleEventCount = weather.diagnostics.lightning.eventCount;
const replacement = await makeSystem();
assert.equal(scene.children.filter((object) =>
    object.name === 'weather_lightning_scene_light').length, 1,
'registry replacement leaves one scene-light/scheduler owner');
assert.equal(weather.update(secondEventAt + 100, camera), false,
    'a retained disposed scheduler rejects updates');
assert.equal(weather.diagnostics.lightning.eventCount, staleEventCount,
    'a retained disposed scheduler cannot advance its event count');
assert.equal(sky.uniforms.lightningStrike.value.w, 0,
    'replacement disposal clears the shared sky flash channel');

replacement.setWeather('darkstorm', 1);
assert.equal(replacement.update(0, camera), true,
    'the replacement alone owns subsequent updates');
replacement.dispose();
assert.equal(replacement.update(100, camera), false,
    'explicit disposal permanently gates scheduler updates');

const transitioning = await makeSystem();
transitioning.transitionTo('darkstorm', 1, 45);
transitioning.update(0, camera);
transitioning.update(0.5, camera);
const transitionDeadline = transitioning.diagnostics.lightning.nextEventAtSeconds;
assert.ok(transitionDeadline - 0.5 >= 6 && transitionDeadline - 0.5 <= 9,
    'Dark Storm transition schedules its first event once, in seconds');
for (let time = 1; time < Math.min(transitionDeadline - 0.1, 5.5); time += 0.25) {
    transitioning.update(time, camera);
    assert.equal(transitioning.diagnostics.lightning.nextEventAtSeconds, transitionDeadline,
        'transition blending cannot reset the Dark Storm cadence key each frame');
}
transitioning.update(transitionDeadline, camera);
assert.equal(transitioning.diagnostics.lightning.eventCount, 1,
    'transitioning runtime starts one event at its stable deadline');
assert.equal(transitioning.state.strike?.local, true,
    'first transition event still commits the guaranteed nearby surface strike');
transitioning.dispose();

// Exercise the lazy-wrapper race as a real async lifecycle: an attachment is
// disposed while its first weather textures are in flight. It must not call the
// one-owner constructor afterward, because that stale call would evict a newer
// scene owner and can leave rain/lightning inert.
const { makeLazyWeatherAttachment } = await import(
    `data:text/javascript;base64,${Buffer.from(wrapperSource).toString('base64')}`
);
let releaseTextures;
const texturesReady = new Promise((resolve) => { releaseTextures = resolve; });
let staleMakeCalls = 0;
const previousLoadImageTexture = globalThis.loadImageTexture;
const previousMakeWeatherSystem = globalThis.makeWeatherSystem;
globalThis.loadImageTexture = async () => {
    await texturesReady;
    return {};
};
globalThis.makeWeatherSystem = async () => {
    staleMakeCalls++;
    return { transitionTo() {}, wrapScene() {}, dispose() {}, WEATHER: { clear: {} } };
};
try {
    const lazy = await makeLazyWeatherAttachment({
        scene: { traverse() {} },
        camera,
        sky: {},
        sun: null,
        hemi: null,
        loadEngine: async () => {},
        quality: { weather: { transitionSeconds: 45 } },
        initialWeatherState: 'none',
    });
    assert.equal(lazy.setWeather('darkstorm'), true,
        'lazy attachment accepts an asynchronous first weather request');
    lazy.dispose();
    releaseTextures();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(staleMakeCalls, 0,
        'disposed lazy attachment cannot construct and evict a newer weather owner');
} finally {
    globalThis.loadImageTexture = previousLoadImageTexture;
    globalThis.makeWeatherSystem = previousMakeWeatherSystem;
}

console.log('lightning CPU runtime/lifecycle audit: PASS');
