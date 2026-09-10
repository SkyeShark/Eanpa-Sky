// Isolated use of the production celestial shader. Paused by default; time
// advances only when the review runner requests a frame. No clouds, scene
// assets, pointer capture, performance emulation or automatic render loop.
import * as GPU from 'three';
import * as TSL from 'three/tsl';
const T = globalThis.THREE = { ...GPU, ...TSL };
const errors = [];
const report = error => {
    errors.push(String(error?.stack ?? error));
    document.getElementById('status').textContent = errors.join('\n');
};
addEventListener('error', event => report(event.error ?? event.message));
addEventListener('unhandledrejection', event => report(event.reason));
const params = new URLSearchParams(location.search);
const version = params.get('version') ?? 'current';
const paths = {
    current: '/engine/redgiant.js',
    before: '/.artifacts/redgiant-20260910/before.js',
    radiant: '/.artifacts/redgiant-20260910/radiant.js',
};
if (!paths[version]) throw new Error('Unknown comparison version');
await import(paths[version]);
const opts = { shield: false };
if (params.get('flares') === 'off') opts.flares = [];
const renderer = new T.WebGPURenderer({ antialias: false });
await renderer.init();
renderer.setSize(960, 720);
renderer.toneMapping = T.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1;
document.body.appendChild(renderer.domElement);
renderer.backend.device.addEventListener('uncapturederror', event => report(event.error));
const star = await makeRedGiant({ opts });
const starDir = new T.Vector3(0, .42, -.86).normalize();
star.attach({ sky: { sunDir: starDir, uniforms: { sunDiscI: { value: 0 } } } });
const scene = new T.Scene();
const camera = new T.PerspectiveCamera(52, 960 / 720, .1, 100);
camera.lookAt(starDir);
const material = new T.MeshBasicNodeMaterial({ side: T.BackSide, depthWrite: false });
material.colorNode = star.celestial(T.normalize(T.positionWorld), T.vec3(.025, .035, .045));
scene.add(new T.Mesh(new T.SphereGeometry(10, 48, 24), material));
const fixture = globalThis.__starFixture = {
    renderer, scene, camera, star, errors, version, ready: false, time: 0,
    async frame(time) {
        this.time = time;
        star.update(time);
        renderer.render(scene, camera);
        await renderer.backend.device.queue.onSubmittedWorkDone();
    },
};
await renderer.compileAsync(scene, camera);
await fixture.frame(8);
fixture.ready = true;
document.getElementById('status').textContent = `${version} · production star shader · paused for inspection`;
