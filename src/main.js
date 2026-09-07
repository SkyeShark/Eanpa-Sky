// EANPA ENGINE — realtime browser branch of the eidoverse volumetric sky.
// Boot order matters: install the browser THREE globals before importing the
// legacy side-effect engine modules, then initialize the renderer, terrain,
// and selected skybox module.
import * as WEBGPU from 'three';
import * as TSL from 'three/tsl';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
// Required module linkage happens before this file evaluates, so a missing
// FXAA addon reaches index.html's visible boot failure before WebGPU renderer
// construction; antialias:false can never silently continue without edge AA.
import { fxaa as requiredFxaaFactory } from 'three/addons/tsl/display/FXAANode.js';
import { makeAudioSystem } from './audio_system.js';
import { FrameMetrics } from './frame_metrics.js';
import { installShadowMaterialCache } from './shadow_material_cache.js';
import { makeShadowRefreshPolicy } from './shadow_refresh.js';
import { makeReflectionEnvironment } from './reflection_environment.js';
import { installRebuildResourceCache } from './rebuild_resource_cache.js';
import { makeFirstPersonViewmodel } from './first_person_viewmodel.js?v=20260722-armlight-isolation';
import {
    MAX_WALK_STEP_RISE,
    FLOOR_CONTACT_TOLERANCE,
    createAssistedStepState,
    tryBeginAssistedStep,
    advanceAssistedStep,
    shouldBlockHighSurfaceEntry,
    cancelAssistedStep,
} from './movement_step.js';

// Reproducible scene links also let visual QA open the requested sky directly
// instead of compiling Earth first and immediately rebuilding the whole scene.
const launchSettings = new URLSearchParams(location.search);
for (const id of ['skybox','cloud-type','weather','quality']) {
    const control=document.getElementById(id),value=launchSettings.get(id);
    if(value&&[...control.options].some(option=>option.value===value))control.value=value;
}
if(launchSettings.has('tod')){
    const hours=Number(launchSettings.get('tod'));
    if(Number.isFinite(hours)&&hours>=0&&hours<=24){
        document.getElementById('tod').value=String(hours);
        document.getElementById('todv').textContent=hours.toFixed(1);
    }
}

// ---- on-page error console: WebGPU pipeline failures are SILENT no-draws,
// so every error path gets surfaced visibly (no devtools needed) ----
const errBox = document.createElement('div');
errBox.style.cssText = 'position:fixed;right:12px;top:12px;z-index:99;max-width:46vw;max-height:60vh;overflow:auto;'
    + 'font:11px/1.4 monospace;color:#ffb3b3;background:rgba(30,8,8,.88);border:1px solid #6b2a2a;'
    + 'border-radius:8px;padding:8px 10px;display:none;white-space:pre-wrap;';
document.body.appendChild(errBox);
const errSeen = new Map();
const errLog = (...a) => {
    globalThis._benchmark?.invalidate('browser or shader error during capture');
    errBox.style.display = 'block';
    const line = a.map((x) => (x?.stack || x?.message || String(x))).join(' ');
    const n = (errSeen.get(line) || 0) + 1;
    errSeen.set(line, n);
    if (n === 1) errBox.textContent += line + '\n';
    else errBox.textContent = errBox.textContent.replace(line + (n > 2 ? ` (x${n - 1})` : ''), line + ` (x${n})`);
};
addEventListener('error', (e) => errLog('[error]', e.message, e.filename?.split('/').pop(), e.lineno));
addEventListener('unhandledrejection', (e) => errLog('[promise]', e.reason));
const _cerr = console.error.bind(console);
console.error = (...a) => { errLog('[console]', ...a); _cerr(...a); };

// ---- WGSL compile-error interceptor: Chrome only surfaces "invalid due to
// a previous error" at pipeline time; the REAL message lives in the shader
// module's compilation info. Wrap createShaderModule and print every error
// with the offending source lines. ----
if (globalThis.GPUDevice) {
    const _csm = GPUDevice.prototype.createShaderModule;
    GPUDevice.prototype.createShaderModule = function (desc) {
        const mod = _csm.call(this, desc);
        mod.getCompilationInfo?.().then((info) => {
            for (const m of info.messages) {
                if (m.type !== 'error') continue;
                const lines = (desc.code || '').split('\n');
                const l0 = Math.max(0, m.lineNum - 3), l1 = Math.min(lines.length, m.lineNum + 2);
                const ctx = lines.slice(l0, l1).map((s, i) => `${l0 + i + 1}${l0 + i + 1 === m.lineNum ? ' >>' : '   '} ${s}`).join('\n');
                errLog(`[wgsl] ${m.message}\n${ctx}`);
            }
        });
        return mod;
    };
}

// ---- console forwarding: mirror logs/errors to the dev server so the
// assistant reads the page console directly (POST /__log, fire-and-forget)
{
    const forwardLog = (level, parts) => {
        try {
            const text = parts.map((part) => {
                if (typeof part === 'string') return part;
                try { return JSON.stringify(part); } catch { return String(part); }
            }).join(' ').slice(0, 4000);
            navigator.sendBeacon('/__log', JSON.stringify({
                t: new Date().toISOString(), level, text,
            }));
        } catch {}
    };
    for (const level of ['log', 'warn', 'error']) {
        const original = console[level].bind(console);
        console[level] = (...parts) => { original(...parts); forwardLog(level, parts); };
    }
    addEventListener('error', (event) => forwardLog('window-error', [
        event.message, (event.filename ?? '') + ':' + (event.lineno ?? ''),
    ]));
    addEventListener('unhandledrejection', (event) => forwardLog(
        'unhandled-rejection',
        [String(event.reason?.stack ?? event.reason).slice(0, 4000)],
    ));
    // Main-thread stalls self-report with the frame stage that owned them,
    // so freezes are diagnosable from the dev-server log without profiling.
    try {
        new PerformanceObserver((list) => {
            for (const entry of list.getEntries()) {
                if (entry.duration < 350) continue;
                forwardLog('longtask', [
                    `[perf] main thread blocked ${Math.round(entry.duration)}ms`,
                    'stage=' + (globalThis._frameStage ?? 'unknown'),
                ]);
            }
        }).observe({ entryTypes: ['longtask'] });
    } catch {}
}

// ---- browser engine globals (legacy engine scripts are loaded below) ----
globalThis.THREE = Object.assign({}, WEBGPU, TSL);
globalThis.GLTFLoader = GLTFLoader;
globalThis.EANPA_NO_MRT = true;   // forward renderer: no G-buffer, no mrt stamps

// Shared image cache: settings sweeps rebuild sky systems, but immutable
// source textures (the 4K starmap alone is ~32 MiB decoded) must not be
// refetched and re-uploaded on every quality change.
const imageTextureCache = new Map();
// byte-identical port of the harness image loader: RGBA pixels, baked
// vertical flip (DataTexture origin), linear filtering, no mips
globalThis.loadImageTexture = async (url, { srgb = false, mipmaps = false } = {}) => {
    const key = `${url}|${srgb ? 'srgb' : 'linear'}|${mipmaps ? 'mips' : 'nomips'}`;
    if (!imageTextureCache.has(key)) {
        imageTextureCache.set(key, (async () => {
            const bmp = await createImageBitmap(await (await fetch(url)).blob());
            const cv = new OffscreenCanvas(bmp.width, bmp.height);
            const ctx = cv.getContext('2d', { willReadFrequently: true });
            ctx.drawImage(bmp, 0, 0);
            const img = ctx.getImageData(0, 0, bmp.width, bmp.height);
            bmp.close?.();
            const W = img.width, H = img.height, row = W * 4;
            const flipped = new Uint8Array(img.data.length);
            for (let y = 0; y < H; y++) flipped.set(img.data.subarray((H - 1 - y) * row, (H - y) * row), y * row);
            const tex = new THREE.DataTexture(flipped, W, H, THREE.RGBAFormat);
            tex.needsUpdate = true;
            if (srgb) tex.colorSpace = THREE.SRGBColorSpace;
            tex.minFilter = mipmaps ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
            tex.magFilter = THREE.LinearFilter;
            tex.generateMipmaps = mipmaps;
            return tex;
        })().catch((error) => {
            imageTextureCache.delete(key);
            throw error;
        }));
    }
    return imageTextureCache.get(key);
};

globalThis.eanpaStripMrt = (root) => {
    let n = 0;
    root.traverse((o) => {
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of mats) {
            // Full scene-MRT overrides carry intentional per-material masks
            // (thin foliage rejects N8AO). Only strip legacy partial stamps.
            if (m && m.isNodeMaterial && m.mrtNode
                && m.userData?.preserveSceneMrtOverride !== true) {
                m.mrtNode = null; m.needsUpdate = true; n++;
            }
        }
    });
    if (n) console.log('[eanpa] stripped mrt stamps from', n, 'materials');
};

const ENGINE_MODULE_LOADERS = Object.freeze({
    'sky_system.js': () => import('../engine/sky_system.js'),
    'weather_system.js': () => import('../engine/weather_system.js'),
    'ringworld.js': () => import('../engine/ringworld.js'),
    'redgiant.js': () => import('../engine/redgiant.js'),
    'asteroid_moon.js': () => import('../engine/asteroid_moon.js'),
});
const engineModules = new Map();
function loadEngine(name) {
    const loader = ENGINE_MODULE_LOADERS[name];
    if (!loader) return Promise.reject(new Error('Unknown engine module: ' + name));
    if (!engineModules.has(name)) {
        const pending = loader().catch((error) => {
            engineModules.delete(name);
            throw error;
        });
        engineModules.set(name, pending);
    }
    return engineModules.get(name);
}

// Start independent browser modules as soon as the legacy engine globals exist.
// Immediate observers prevent early network failures from becoming unhandled;
// the later awaited batch still propagates the original error to the boot UI.
const observePreload = (promise) => {
    promise.catch(() => {});
    return promise;
};
const coreEngineModulesReady = observePreload(Promise.all([
    loadEngine('sky_system.js'),
    loadEngine('weather_system.js'),
]));
const sceneModulesReady = observePreload(Promise.all([
    import('./terrain_real.js'),
    import('./temple_real.js'),
    import('./desert_dressing.js'),
    import('./vegetation.js'),
]));
const skyModulesReady = observePreload(Promise.all([
    import('./weathersky.js'),
    import('./shieldworld.js'),
    import('./ringsky.js'),
    import('./reflection_pipeline.js?rev=reflection-holdout-20260805'),
    import('./cloudspatial.js'),
]));

// ---- renderer / scene / camera ----
const canvas = document.getElementById('view');
// WebGPU's portable default permits 16 sampled textures per shader, while
// this adapter exposes more and the complete PBR + shadow/environment path
// needs 19. Request a modest raised limit only after verifying support; older
// adapters retain the portable default rather than failing device creation.
const adapterProbe = await navigator.gpu?.requestAdapter({ powerPreference: 'high-performance' });
const adapterSampledTextureLimit = Number(
    adapterProbe?.limits?.maxSampledTexturesPerShaderStage ?? 16,
);
const adapterAttachmentByteLimit = Number(
    adapterProbe?.limits?.maxColorAttachmentBytesPerSample ?? 32,
);
const requestedLimits = {};
if (adapterSampledTextureLimit >= 24) {
    requestedLimits.maxSampledTexturesPerShaderStage = 24;
}
// The exact PBR response MRT plus the authored selective-emissive bloom target
// is five colors. WebGPU accounts this layout as 40 bytes/sample even though
// the four auxiliary textures are RGBA8. Request it only when the adapter
// explicitly advertises support; portable 32-byte devices retain the four-
// target reflection graph and its non-selective bloom fallback.
if (adapterAttachmentByteLimit >= 40) {
    requestedLimits.maxColorAttachmentBytesPerSample = 40;
}
const requiredLimits = Object.keys(requestedLimits).length
    ? requestedLimits
    : undefined;
globalThis._gpuLimits = {
    adapterSampledTextures: adapterSampledTextureLimit,
    requestedSampledTextures: requiredLimits?.maxSampledTexturesPerShaderStage ?? 16,
    adapterAttachmentBytes: adapterAttachmentByteLimit,
    requestedAttachmentBytes: requiredLimits?.maxColorAttachmentBytesPerSample ?? 32,
};
const renderer = new THREE.WebGPURenderer({
    canvas,
    // The complete image is produced by the Eidoverse post graph. Its scene
    // MRT is single-sample and the final tone-mapped image runs through the
    // exact Three r184 FXAA node, so canvas MSAA would only multisample a
    // fullscreen triangle after all geometric edges were already resolved.
    antialias: false,
    powerPreference: 'high-performance',
    requiredLimits,
});
// volumetric skies are fill-bound: render at CSS resolution, never at
// high-DPI native (pixelRatio 2 on a laptop panel = 4x the pixels)
renderer.setPixelRatio(1);
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.shadowMap.enabled = true;
const shadowMaterialCache = installShadowMaterialCache(renderer);
globalThis._shadowMaterialCache = shadowMaterialCache;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
await renderer.init();
// Validation failures in texture copies and render passes are device events,
// not JavaScript exceptions or shader compilation errors.
renderer.backend.device?.addEventListener('uncapturederror', event => {
    errLog('[WebGPU]', event.error.message);
});
const rebuildResources = installRebuildResourceCache(renderer);
globalThis._rebuildResources = rebuildResources;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(52, innerWidth / innerHeight, 0.18, 60000);
camera.position.set(0, 2.0, 96);
globalThis._c = camera;                      // engine modules read the camera here

// Player flashlight: a real shadow-casting spot, parented to the camera so
// its origin and aim remain stable through walk bob, jumping, and drag-look.
// It is deliberately independent of sky quality and architectural lighting.
scene.add(camera);
const flashlightTarget = new THREE.Object3D();
flashlightTarget.name = 'player_flashlight_target';
// Aim FAR and on the light's own lateral axis: the old (0,-0.025,-1) target
// sat 1 m out on the view axis while the light hung 0.16 m right, so the
// beam crossed the view axis and sprayed visibly LEFT past the crossing.
// A far target parallel to view (slight down-tilt) keeps the spot centered.
flashlightTarget.position.set(0.05, -0.7, -40);
const FLASHLIGHT_INTENSITY = 330;
const flashlight = new THREE.SpotLight(
    0xeaf6ff,
    0,
    115,
    Math.PI * 0.155,
    0.62,
    2,
);
flashlight.name = 'player_flashlight';
// The beam origin sits beyond the first-person hands (they end near
// z -0.52 camera-local): at centimeter range the inverse-square spot
// blew the near hand out to solid white.
flashlight.position.set(0.05, -0.10, -0.30);
flashlight.target = flashlightTarget;
flashlight.castShadow = true;
flashlight.shadow.mapSize.set(1024, 1024);
flashlight.shadow.camera.near = 0.22;
flashlight.shadow.camera.far = 115;
flashlight.shadow.bias = -0.00018;
flashlight.shadow.normalBias = 0.025;
// Keep the spotlight in the renderer's light/shadow topology permanently.
// Toggling visible used to invalidate every lit WebGPU pipeline on both F
// presses, synchronously freezing the engine. Intensity is a uniform; shadow
// updates can be gated independently without changing the light hash.
flashlight.visible = true;
flashlight.shadow.autoUpdate = false;
flashlight.shadow.needsUpdate = true;
camera.add(flashlight, flashlightTarget);
const flashlightState = { enabled: false, toggles: 0 };
const setFlashlightEnabled = (enabled) => {
    const next = Boolean(enabled);
    if (next === flashlightState.enabled) return flashlightState.enabled;
    flashlightState.enabled = next;
    flashlightState.toggles++;
    flashlight.intensity = flashlightState.enabled ? FLASHLIGHT_INTENSITY : 0;
    flashlight.shadow.autoUpdate = flashlightState.enabled;
    if (flashlightState.enabled) flashlight.shadow.needsUpdate = true;
    globalThis._audio?.playFlashlightToggle?.(flashlightState.enabled);
    const legend = document.getElementById('controls');
    const status = document.getElementById('flashlight-status');
    if (legend) legend.dataset.flashlight = flashlightState.enabled ? 'on' : 'off';
    if (status) status.textContent = 'flashlight ' + (flashlightState.enabled ? 'on' : 'off');
    return flashlightState.enabled;
};
globalThis._flashlight = {
    light: flashlight,
    target: flashlightTarget,
    state: flashlightState,
    setEnabled: setFlashlightEnabled,
};

// Ground-based look-around: one primary click captures the mouse, movement
// looks anywhere (straight up included), and the browser-standard Escape key
// releases pointer lock. Wheel zooms FOV; WASD strolls.
const look = {
    yaw: 0,
    pitch: 0.035,
    vyaw: 0,
    vpitch: 0,
    locked: false,
    pointerLockRequests: 0,
    pointerLockErrors: 0,
};
globalThis._look = look;   // debug: lets the CDP harness drive camera motion
camera.rotation.order = 'YXZ';
// Automated inspection drives the camera directly and must never capture the
// desktop mouse, even if a test dispatches a trusted browser input event.
const automatedPreview = new URLSearchParams(location.search).get('automated') === '1';
canvas.addEventListener('pointerdown', (e) => {
    if (automatedPreview || !e.isTrusted || document.hidden || !document.hasFocus()
        || e.button !== 0 || document.pointerLockElement === canvas) return;
    look.pointerLockRequests++;
    try {
        const request = canvas.requestPointerLock?.();
        request?.catch?.(() => { look.pointerLockErrors++; });
    } catch {
        look.pointerLockErrors++;
    }
});
document.addEventListener('mousemove', (e) => {
    if (document.pointerLockElement !== canvas) return;
    look.vyaw -= Number(e.movementX || 0) * 0.0028;
    look.vpitch -= Number(e.movementY || 0) * 0.0028;
});
document.addEventListener('pointerlockchange', () => {
    const locked = document.pointerLockElement === canvas;
    if (!locked && look.locked) {
        // Escape, focus loss, or browser revocation also reconciles movement
        // keys so releasing the lock can never leave the explorer walking.
        clearInputState();
    }
    look.locked = locked;
});
document.addEventListener('pointerlockerror', () => {
    look.pointerLockErrors++;
    look.locked = false;
});
canvas.addEventListener('wheel', (e) => {
    camera.fov = Math.max(28, Math.min(80, camera.fov + Math.sign(e.deltaY) * 3));
    camera.updateProjectionMatrix();
}, { passive: true });
const keys = new Set();
const movementStart = new THREE.Vector3();
const contactRecoilStart = new THREE.Vector3();
const movementKeys = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ShiftLeft', 'ShiftRight', 'Space']);
const isEditableControl = (target) => Boolean(target?.closest?.(
    'input, select, textarea, button, [contenteditable="true"]',
));
const movementState = {
    eyeHeight: 1.82,
    physicalEyeY: camera.position.y,
    verticalVelocity: 0,
    grounded: false,
    bobPhase: 0,
    bobOffset: 0,
    bobRoll: 0,
    // Physical feet snap to a valid tread for collision, while this
    // view-only offset eases the camera across the rise. This avoids the
    // stair-step bump without letting the player sink through architecture.
    stepViewOffset: 0,
    horizontalSpeed: 0,
    // Collision contacts are edge-triggered into the articulated viewmodel.
    // Side is camera-relative: -1 left hand, +1 right hand, 0 both hands.
    contactSerial: 0,
    contactSide: 0,
    contactStrength: 0,
    contactImpactSpeed: 0,
    contactKind: 'none',
    contactNormalX: 0,
    contactNormalZ: 0,
    contactCooldown: 0,
    contactLatched: false,
    contactSeparationTime: 0,
    jumpQueued: false,
    jumpSpeed: 5.6,
    lifecycleInputClears: 0,
    assistedStep: createAssistedStepState(),
};
const assistedStepSample = {};
const navigationSurfaceAt = (x, z) => {
    const terrainHeight = Number(terrain?.heightAt?.(x, z) ?? 0);
    const templeSurface = temple?.walkSurfaceAt?.(x, z) ?? null;
    const rockSurface = vegetation?.walkSurfaceAt?.(x, z,
        movementState.physicalEyeY - movementState.eyeHeight + MAX_WALK_STEP_RISE) ?? null;
    if (Number.isFinite(rockSurface?.height)
        && rockSurface.height >= Math.max(terrainHeight, templeSurface?.height ?? -Infinity)) return rockSurface;
    if (Number.isFinite(templeSurface?.height)
        && templeSurface.height >= terrainHeight - 1e-5) return templeSurface;
    return { height: terrainHeight, kind: 'terrain', assistedStep: false };
};
const clearInputState = () => {
    if (keys.size || movementState.jumpQueued || look.locked) {
        movementState.lifecycleInputClears++;
    }
    keys.clear();
    movementState.jumpQueued = false;
    look.vyaw = 0;
    look.vpitch = 0;
};
addEventListener('keydown', (e) => {
    if (e.code === 'KeyF') {
        if (isEditableControl(e.target)) return;
        if (!e.repeat) setFlashlightEnabled(!flashlightState.enabled);
        e.preventDefault();
        return;
    }
    if (!movementKeys.has(e.code)) return;
    if (isEditableControl(e.target)) return;
    if (e.code === 'Space' && !e.repeat) movementState.jumpQueued = true;
    // The Set is the physical-key state. Native repeat keydowns are harmless
    // idempotent confirmations, never a lease which can expire while the key
    // is still held.
    keys.add(e.code);
    e.preventDefault();
}, { passive: false, capture: true });
addEventListener('keyup', (e) => {
    if (!movementKeys.has(e.code)) return;
    const wasMoving = keys.delete(e.code);
    if (wasMoving) e.preventDefault();
}, { passive: false, capture: true });
addEventListener('blur', clearInputState);
addEventListener('focus', clearInputState);
addEventListener('pagehide', clearInputState);
addEventListener('pageshow', clearInputState);
document.addEventListener('visibilitychange', () => {
    if (document.hidden) clearInputState();
});
// Native select popups can consume the matching keyup without blurring the
// browser window. Clear before any panel interaction/focus so WASD cannot stay
// latched behind a dropdown, slider, or checkbox.
document.addEventListener('focusin', (event) => {
    if (isEditableControl(event.target)) clearInputState();
}, { capture: true });
document.getElementById('panel')?.addEventListener('pointerdown', clearInputState, { capture: true });
globalThis._inputState = {
    keys,
    clear: clearInputState,
    get pointerLocked() { return document.pointerLockElement === canvas; },
};
globalThis._movementState = movementState;
document.getElementById('boot').textContent = 'rigging Aletheia explorer hands…';
let firstPersonViewmodel;
try {
    firstPersonViewmodel = await makeFirstPersonViewmodel(THREE, renderer, {
        loader: new GLTFLoader(),
        worldScene: scene,
        worldCamera: camera,
    });
} catch (error) {
    // Arms are visible player feedback, but they are not allowed to prevent
    // the terrain/sky/explorer from booting. Keep the omission conspicuous in
    // the existing on-page error console and expose it through debug state.
    errLog('[viewmodel] Aletheia arms unavailable; world boot will continue.', error);
    firstPersonViewmodel = {
        stats: {
            available: false,
            error: error?.message ?? String(error),
            dedicatedScene: true,
            worldCollision: false,
        },
        update() {},
        resize() {},
        async render() {},
        dispose() {},
    };
}
globalThis._firstPersonViewmodel = firstPersonViewmodel;
const controls = {
    update(dt = 0.016) {
        // Keep a physical eye position separate from the view-only walk bob.
        // This prevents bob from leaking into collision/ground queries and
        // also lets the test harness (or a future teleporter) move the camera.
        const frameDt = Math.max(0, Math.min(Number.isFinite(dt) ? dt : 0.016, 0.1));
        movementState.contactCooldown = Math.max(
            0,
            movementState.contactCooldown - frameDt,
        );
        const expectedViewY = movementState.physicalEyeY
            + movementState.bobOffset
            + movementState.stepViewOffset;
        if (!Number.isFinite(movementState.physicalEyeY)
            || Math.abs(camera.position.y - expectedViewY) > 0.005) {
            cancelAssistedStep(movementState.assistedStep);
            movementState.physicalEyeY = camera.position.y;
            movementState.verticalVelocity = 0;
            movementState.grounded = false;
            movementState.bobOffset = 0;
            movementState.bobRoll = 0;
            movementState.stepViewOffset = 0;
        }
        camera.position.y = movementState.physicalEyeY;
        movementStart.copy(camera.position);
        look.yaw += look.vyaw; look.pitch += look.vpitch;
        look.vyaw *= 0.82; look.vpitch *= 0.82;
        look.pitch = Math.max(-1.35, Math.min(1.53, look.pitch));
        camera.rotation.set(look.pitch, look.yaw, 0);
        const sprinting = keys.has('ShiftLeft') || keys.has('ShiftRight');
        const movementSpeed = sprinting ? 7.2 : 3.6;
        let inputForward = (keys.has('KeyW') ? 1 : 0) - (keys.has('KeyS') ? 1 : 0);
        let inputStrafe = (keys.has('KeyD') ? 1 : 0) - (keys.has('KeyA') ? 1 : 0);
        const inputLength = Math.hypot(inputForward, inputStrafe);
        if (inputLength > 1) {
            inputForward /= inputLength;
            inputStrafe /= inputLength;
        }
        const sp = movementSpeed * frameDt;
        const fx = -Math.sin(look.yaw), fz = -Math.cos(look.yaw);
        if (!movementState.assistedStep.active) {
            camera.position.x += (fx * inputForward - fz * inputStrafe) * sp;
            camera.position.z += (fz * inputForward + fx * inputStrafe) * sp;
        }
        const bounds = terrain.terrainBounds;
        if (bounds) {
            camera.position.x = Math.max(bounds.minX + 1, Math.min(bounds.maxX - 1, camera.position.x));
            camera.position.z = Math.max(bounds.minZ + 1, Math.min(bounds.maxZ - 1, camera.position.z));
        }
        const attemptedX = camera.position.x;
        const attemptedZ = camera.position.z;
        const attemptedTravel = Math.hypot(
            attemptedX - movementStart.x,
            attemptedZ - movementStart.z,
        );
        let appliedContactRecoilX = 0;
        let appliedContactRecoilZ = 0;

        // A normal 0.20 m stair tread keeps the existing contact path. The two
        // explicitly tagged Inanna dais courses instead begin a short kinematic
        // step: lift at the edge, then carry the capsule centre across the
        // vertical face. Every other high surface remains a solid wall until a
        // real jump puts the player's feet above its top.
        let assistedStepFrame = movementState.assistedStep.active;
        let highSurfaceBlocked = false;
        if (!assistedStepFrame) {
            const previousSurface = navigationSurfaceAt(movementStart.x, movementStart.z);
            const nextSurface = navigationSurfaceAt(camera.position.x, camera.position.z);
            assistedStepFrame = tryBeginAssistedStep(movementState.assistedStep, {
                previousSurface,
                nextSurface,
                previousX: movementStart.x,
                previousZ: movementStart.z,
                candidateX: camera.position.x,
                candidateZ: camera.position.z,
                physicalEyeY: movementState.physicalEyeY,
                eyeHeight: movementState.eyeHeight,
                grounded: movementState.grounded,
                jumpQueued: movementState.jumpQueued,
            });
            if (!assistedStepFrame && shouldBlockHighSurfaceEntry({
                previousSurface,
                nextSurface,
                physicalEyeY: movementState.physicalEyeY,
                eyeHeight: movementState.eyeHeight,
            })) {
                camera.position.x = movementStart.x;
                camera.position.z = movementStart.z;
                movementState.assistedStep.blockedHighEntries++;
                highSurfaceBlocked = true;
            }
        }

        let assistedStepResult = null;
        if (movementState.assistedStep.active) {
            assistedStepFrame = true;
            assistedStepResult = advanceAssistedStep(
                movementState.assistedStep,
                frameDt,
                assistedStepSample,
            );
            camera.position.x = assistedStepResult.x;
            camera.position.z = assistedStepResult.z;
            movementState.physicalEyeY = assistedStepResult.eyeY;
            camera.position.y = movementState.physicalEyeY;
            movementState.verticalVelocity = 0;
            movementState.grounded = false;
            movementState.jumpQueued = false;
        }
        // Resolve solid walls/tiers at the previous walking eye height before
        // sampling a new walk surface. Sampling first would teleport the eye
        // onto a tier top and let the player auto-climb vertical ziggurat
        // faces; the authored stair corridor is explicitly exempt.
        const preTempleX = camera.position.x, preTempleZ = camera.position.z;
        const templeContact = temple?.resolveCamera?.(camera, movementStart) ?? null;
        const postTempleX = camera.position.x, postTempleZ = camera.position.z;
        const vegetationContact = vegetation?.resolveCamera?.(
            camera,
            movementStart,
            performance.now() * 0.001,
            movementState.eyeHeight,
        ) ?? null;
        // TELEPORT TRIPWIRE — logs to the dev-server intake with per-stage
        // attribution the moment any frame moves the player farther than
        // input plausibly could. Diagnosis instrument for the reported
        // teleports; remove once the culprit stage is fixed.
        {
            const total = Math.hypot(
                camera.position.x - movementStart.x,
                camera.position.z - movementStart.z,
            );
            if (total > 1.0) {
                console.log('[teleport]', JSON.stringify({
                    total: Number(total.toFixed(3)),
                    temple: Number(Math.hypot(
                        postTempleX - preTempleX, postTempleZ - preTempleZ,
                    ).toFixed(3)),
                    vegetation: Number(Math.hypot(
                        camera.position.x - postTempleX,
                        camera.position.z - postTempleZ,
                    ).toFixed(3)),
                    highSurfaceBlocked,
                    assistedStep: Boolean(assistedStepFrame),
                    at: [Number(movementStart.x.toFixed(1)),
                        Number(movementStart.z.toFixed(1))],
                }));
            }
        }

        const collisionReported = highSurfaceBlocked
            || Boolean(templeContact?.collided)
            || Number(vegetationContact?.contacts) > 0;
        const activeContact = collisionReported && inputLength > 0 && !assistedStepFrame;
        if (activeContact) {
            movementState.contactSeparationTime = 0;
        } else {
            movementState.contactSeparationTime += frameDt;
            if (movementState.contactSeparationTime >= 0.12) {
                movementState.contactLatched = false;
            }
        }
        if (activeContact
            && !movementState.contactLatched
            && movementState.contactCooldown <= 0) {
            // Resolver correction points away from the contacted surface. If a
            // resolver stopped exactly at the previous position, the inverse
            // attempted travel supplies the same bounded contact normal.
            let correctionX = camera.position.x - attemptedX;
            let correctionZ = camera.position.z - attemptedZ;
            let correctionLength = Math.hypot(correctionX, correctionZ);
            if (correctionLength < 0.0001) {
                correctionX = movementStart.x - attemptedX;
                correctionZ = movementStart.z - attemptedZ;
                correctionLength = Math.hypot(correctionX, correctionZ);
            }
            if (correctionLength >= 0.0001) {
                const normalX = correctionX / correctionLength;
                const normalZ = correctionZ / correctionLength;
                const strength = Math.max(0.35, Math.min(
                    1,
                    attemptedTravel / Math.max(sp, 0.0001),
                ));
                const obstacleX = -normalX;
                const obstacleZ = -normalZ;
                const rightX = -fz;
                const rightZ = fx;
                const sideDot = obstacleX * rightX + obstacleZ * rightZ;
                const side = Math.abs(sideDot) < 0.28 ? 0 : Math.sign(sideDot);
                const recoilDistance = (sprinting ? 0.055 : 0.035)
                    * (0.65 + strength * 0.35);

                contactRecoilStart.copy(camera.position);
                const preRecoilX = camera.position.x;
                const preRecoilZ = camera.position.z;
                camera.position.x += normalX * recoilDistance;
                camera.position.z += normalZ * recoilDistance;
                if (bounds) {
                    camera.position.x = Math.max(
                        bounds.minX + 1,
                        Math.min(bounds.maxX - 1, camera.position.x),
                    );
                    camera.position.z = Math.max(
                        bounds.minZ + 1,
                        Math.min(bounds.maxZ - 1, camera.position.z),
                    );
                }
                // The recoil is physical but must still be safe at compound
                // corners and between neighbouring vegetation colliders. This
                // second solve is deliberately telemetry-only: it cannot emit
                // another arm event or recursively add recoil.
                temple?.resolveCamera?.(camera, contactRecoilStart);
                vegetation?.resolveCamera?.(
                    camera,
                    contactRecoilStart,
                    performance.now() * 0.001,
                    movementState.eyeHeight,
                );
                if (bounds) {
                    camera.position.x = Math.max(
                        bounds.minX + 1,
                        Math.min(bounds.maxX - 1, camera.position.x),
                    );
                    camera.position.z = Math.max(
                        bounds.minZ + 1,
                        Math.min(bounds.maxZ - 1, camera.position.z),
                    );
                }
                appliedContactRecoilX = camera.position.x - preRecoilX;
                appliedContactRecoilZ = camera.position.z - preRecoilZ;
                movementState.contactSerial++;
                movementState.contactSide = side;
                movementState.contactStrength = strength;
                // Capture the incoming normal velocity before collision removes
                // it. Post-solve horizontalSpeed describes sliding, not impact.
                movementState.contactImpactSpeed = frameDt > 0 ? Math.max(0,
                    -((attemptedX - movementStart.x) * normalX
                        + (attemptedZ - movementStart.z) * normalZ) / frameDt,
                ) : 0;
                movementState.contactKind = highSurfaceBlocked
                    ? 'high-surface'
                    : templeContact?.collided
                        ? 'temple'
                        : 'vegetation';
                movementState.contactNormalX = normalX;
                movementState.contactNormalZ = normalZ;
                movementState.contactLatched = true;
                movementState.contactCooldown = 0.18;
            }
        }
        // Full 3D orb collision may adjust Y. Adopt that correction as the
        // physical eye position before resolving the floor beneath it.
        if (Math.abs(camera.position.y - movementState.physicalEyeY) > 0.0001) {
            movementState.physicalEyeY = camera.position.y;
        }
        if (assistedStepFrame) {
            movementState.grounded = assistedStepResult?.done === true;
        } else {
            const targetSurface = navigationSurfaceAt(camera.position.x, camera.position.z);
            const targetEyeY = targetSurface.height + movementState.eyeHeight;
            const floorGap = movementState.physicalEyeY - targetEyeY;
            const wasGrounded = movementState.grounded;
            const stairStepDown = 0.38;
            const jumpStarted = movementState.jumpQueued
                && wasGrounded
                && floorGap >= -MAX_WALK_STEP_RISE - FLOOR_CONTACT_TOLERANCE
                && floorGap <= stairStepDown + FLOOR_CONTACT_TOLERANCE;
            movementState.jumpQueued = false;
            if (jumpStarted) {
                movementState.verticalVelocity = movementState.jumpSpeed;
                movementState.grounded = false;
                // Integrate the first airborne frame immediately; otherwise the
                // contact branch on the next frame can swallow a very short tap.
                const gravity = 11.5;
                const nextVelocity = movementState.verticalVelocity - gravity * frameDt;
                movementState.physicalEyeY += (
                    movementState.verticalVelocity + nextVelocity
                ) * 0.5 * frameDt;
                movementState.verticalVelocity = nextVelocity;
            } else if (floorGap <= FLOOR_CONTACT_TOLERANCE) {
                // Ascending tread contacts must never put the view below visible
                // geometry. Keep that physical snap for collision, then absorb a
                // normal stair-sized rise into a short-lived camera offset.
                const contactRise = targetEyeY - movementState.physicalEyeY;
                if (wasGrounded
                    && contactRise > FLOOR_CONTACT_TOLERANCE
                    && contactRise <= MAX_WALK_STEP_RISE) {
                    movementState.stepViewOffset = Math.max(
                        -MAX_WALK_STEP_RISE,
                        movementState.stepViewOffset - contactRise,
                    );
                }
                movementState.physicalEyeY = targetEyeY;
                movementState.verticalVelocity = 0;
                movementState.grounded = true;
            } else if (wasGrounded && floorGap <= stairStepDown) {
                // Follow the authored 25 cm treads without turning every descent
                // into a tiny free-fall, but avoid the old one-frame downward snap.
                const stairDescentSpeed = sprinting ? 9.0 : 4.6;
                movementState.physicalEyeY = Math.max(
                    targetEyeY,
                    movementState.physicalEyeY - stairDescentSpeed * frameDt,
                );
                movementState.verticalVelocity = 0;
                movementState.grounded = true;
            } else {
                // Average-velocity gravity integration gives stable fall timing
                // across refresh rates. Ledges now produce a readable physical
                // fall instead of an exponential terrain-height snap.
                const gravity = 11.5;
                const terminalVelocity = -18;
                const previousVelocity = movementState.verticalVelocity;
                const nextVelocity = Math.max(
                    terminalVelocity,
                    previousVelocity - gravity * frameDt,
                );
                movementState.physicalEyeY += (previousVelocity + nextVelocity) * 0.5 * frameDt;
                movementState.verticalVelocity = nextVelocity;
                movementState.grounded = false;
                if (movementState.physicalEyeY <= targetEyeY) {
                    movementState.physicalEyeY = targetEyeY;
                    movementState.verticalVelocity = 0;
                    movementState.grounded = true;
                }
            }
        }

        const horizontalDistance = Math.hypot(
            camera.position.x - appliedContactRecoilX - movementStart.x,
            camera.position.z - appliedContactRecoilZ - movementStart.z,
        );
        movementState.horizontalSpeed = frameDt > 0 ? horizontalDistance / frameDt : 0;
        const walking = movementState.grounded && inputLength > 0 && horizontalDistance > 0.00001;
        if (walking) {
            // One phase revolution spans a two-step stride. Keep the broad
            // world's traversal speed, but decouple it from an unnaturally
            // rapid Foley/bob cadence (2.25 steps/s walking, 3.0 sprinting).
            const strideLength = sprinting ? 4.8 : 3.2;
            movementState.bobPhase += horizontalDistance * Math.PI * 2 / strideLength;
        }
        const bobAmplitude = sprinting ? 0.045 : 0.028;
        const targetBob = walking
            ? Math.sin(movementState.bobPhase * 2) * bobAmplitude
            : 0;
        const targetRoll = walking
            ? Math.sin(movementState.bobPhase) * (sprinting ? 0.0032 : 0.0022)
            : 0;
        const bobBlend = 1 - Math.exp(-frameDt * (walking ? 14 : 10));
        movementState.bobOffset += (targetBob - movementState.bobOffset) * bobBlend;
        movementState.bobRoll += (targetRoll - movementState.bobRoll) * bobBlend;
        const stepBlend = 1 - Math.exp(-frameDt * 11.5);
        movementState.stepViewOffset += (0 - movementState.stepViewOffset) * stepBlend;
        if (Math.abs(movementState.stepViewOffset) < 0.0001) movementState.stepViewOffset = 0;
        camera.position.y = movementState.physicalEyeY
            + movementState.bobOffset
            + movementState.stepViewOffset;
        camera.rotation.z = movementState.bobRoll;
    },
};

const sun = new THREE.DirectionalLight(0xffffff, 2.5);
const hemi = new THREE.HemisphereLight(0xbfd6e6, 0x54452e, 0.5);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.near = 1;
sun.shadow.camera.far = 420;
sun.shadow.camera.left = -190;
sun.shadow.camera.right = 190;
sun.shadow.camera.top = 190;
sun.shadow.camera.bottom = -190;
sun.shadow.bias = -0.0003;
sun.shadow.normalBias = 0.06;
// Main/SSR cameras remain on their normal layers. Only the directional-light
// shadow camera sees the authored LOD3-card proxies that preserve a cheap
// silhouette shadow when dense vegetation switches to LOD2.
sun.shadow.camera.layers.enable(3);
const sunShadowRefresh=makeShadowRefreshPolicy(THREE,sun);
globalThis._sunShadowRefresh=sunShadowRefresh.stats;
scene.add(sun, sun.target, hemi);
scene.fog = new THREE.FogExp2(0xb2a18d, 0.00105);
// FogExp2's node path measures depth along the camera's FORWARD axis, so pure
// camera rotation changed every distant mesh's haze wholesale (the whole-mesa
// brightness snap when pitching). Override the fog factor with true radial
// distance so haze depends only on where a fragment is, never where the
// camera points. Color/density still follow scene.fog (palette-driven).
const fogColorUniform = THREE.uniform(scene.fog.color);
const fogDensityUniform = THREE.uniform(scene.fog.density);
{
    const radialFogArg = THREE.positionView.length().mul(fogDensityUniform);
    scene.fogNode = THREE.fog(
        fogColorUniform,
        radialFogArg.mul(radialFogArg).negate().exp().oneMinus(),
    );
}

// ---- terrain + skybox modules ----
const [
    { makeTerrain }, { makeTempleScene },
    { makeDesertDressing }, { makeVegetationScene },
] = await sceneModulesReady;
document.getElementById('boot').textContent = 'building the alluvial valley…';
const terrain = await makeTerrain(THREE, renderer);
scene.add(terrain);
globalThis._terrain = terrain;
camera.position.y = terrain.heightAt(camera.position.x, camera.position.z) + 1.82;

document.getElementById('boot').textContent = 'assembling the Eidoverse compound…';
const architectureLoader = new GLTFLoader();
const stoneRoot = './assets/pbr/sandstone_blocks_05/sandstone_blocks_05_';
const mineralRoot = './assets/temple/materials/';
const fixtureMetalRoot = './assets/temple/materials/ambientcg_metal010/Metal010_1K-JPG_';
const perimeterRoot = './assets/eidoverse/perimeter/';
const [templeAlbedo, templeNormal, templeRoughness, templeAo, templeDisplacement,
    lapisAlbedo, lapisNormal, lapisRoughness, lapisHeight,
    carnelianAlbedo, carnelianNormal, carnelianRoughness, carnelianHeight,
    fixtureMetalAlbedo, fixtureMetalNormal, fixtureMetalRoughness, fixtureMetalMetalness,
    panelFastenerDecal,
    inannaGltf, zigguratGltf, gateGltf, wallGltf, pillarGltf, watchtowerGltf] = await Promise.all([
    globalThis.loadImageTexture(stoneRoot + 'diff_1k.jpg', { srgb: true, mipmaps: true }),
    globalThis.loadImageTexture(stoneRoot + 'nor_gl_1k.jpg', { mipmaps: true }),
    globalThis.loadImageTexture(stoneRoot + 'rough_1k.jpg', { mipmaps: true }),
    globalThis.loadImageTexture(stoneRoot + 'ao_1k.jpg', { mipmaps: true }),
    globalThis.loadImageTexture(stoneRoot + 'disp_1k.jpg', { mipmaps: true }),
    globalThis.loadImageTexture(mineralRoot + 'lapis_tiles_diff.png', { srgb: true, mipmaps: true }),
    globalThis.loadImageTexture(mineralRoot + 'lapis_tiles_normal.png', { mipmaps: true }),
    globalThis.loadImageTexture(mineralRoot + 'lapis_tiles_rough.png', { mipmaps: true }),
    globalThis.loadImageTexture(mineralRoot + 'lapis_tiles_height.png', { mipmaps: true }),
    globalThis.loadImageTexture(mineralRoot + 'carnelian_tiles_diff.png', { srgb: true, mipmaps: true }),
    globalThis.loadImageTexture(mineralRoot + 'carnelian_tiles_normal.png', { mipmaps: true }),
    globalThis.loadImageTexture(mineralRoot + 'carnelian_tiles_rough.png', { mipmaps: true }),
    globalThis.loadImageTexture(mineralRoot + 'carnelian_tiles_height.png', { mipmaps: true }),
    globalThis.loadImageTexture(fixtureMetalRoot + 'Color.jpg', { srgb: true, mipmaps: true }),
    globalThis.loadImageTexture(fixtureMetalRoot + 'NormalGL.jpg', { mipmaps: true }),
    globalThis.loadImageTexture(fixtureMetalRoot + 'Roughness.jpg', { mipmaps: true }),
    globalThis.loadImageTexture(fixtureMetalRoot + 'Metalness.jpg', { mipmaps: true }),
    globalThis.loadImageTexture('./assets/temple/decals/panel_fastener_decal-v1.png', { srgb: true, mipmaps: true }),
    architectureLoader.loadAsync('./assets/temple/inanna_orb.glb'),
    architectureLoader.loadAsync('./assets/temple/ziggurat_architecture.glb'),
    architectureLoader.loadAsync(perimeterRoot + 'scifi_perimeter_wall_gate.glb'),
    architectureLoader.loadAsync(perimeterRoot + 'scifi_perimeter_wall_middle_geometry.glb'),
    architectureLoader.loadAsync(perimeterRoot + 'scifi_perimeter_wall_pillar_geometry.glb'),
    architectureLoader.loadAsync(perimeterRoot + 'scifi_perimeter_watchtower_geometry.glb'),
]);
for (const texture of [
    templeAlbedo, templeNormal, templeRoughness, templeAo, templeDisplacement,
    lapisAlbedo, lapisNormal, lapisRoughness, lapisHeight,
    carnelianAlbedo, carnelianNormal, carnelianRoughness, carnelianHeight,
    fixtureMetalAlbedo, fixtureMetalNormal, fixtureMetalRoughness, fixtureMetalMetalness,
]) {
    texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
    texture.anisotropy = 8;
    texture.needsUpdate = true;
}
panelFastenerDecal.wrapS = panelFastenerDecal.wrapT = THREE.ClampToEdgeWrapping;
panelFastenerDecal.anisotropy = 8;
panelFastenerDecal.needsUpdate = true;
const temple = await makeTempleScene(THREE, {
    terrain,
    sandstoneTextures: {
        albedo: templeAlbedo,
        normal: templeNormal,
        roughness: templeRoughness,
        ao: templeAo,
        displacement: templeDisplacement,
    },
    mineralTextures: {
        lapis: {
            albedo: lapisAlbedo,
            normal: lapisNormal,
            roughness: lapisRoughness,
            height: lapisHeight,
        },
        carnelian: {
            albedo: carnelianAlbedo,
            normal: carnelianNormal,
            roughness: carnelianRoughness,
            height: carnelianHeight,
        },
    },
    fixtureMetalTextures: {
        albedo: fixtureMetalAlbedo,
        normal: fixtureMetalNormal,
        roughness: fixtureMetalRoughness,
        metalness: fixtureMetalMetalness,
    },
    fastenerDecalTexture: panelFastenerDecal,
    inannaModel: inannaGltf.scene,
    zigguratModel: zigguratGltf.scene,
    perimeterModels: {
        gate: gateGltf,
        wall: wallGltf,
        pillar: pillarGltf,
        watchtower: watchtowerGltf,
    },
});
scene.add(temple.group);
globalThis._temple = temple;
temple.setTime?.(Number(document.getElementById('tod').value));
const audio = makeAudioSystem({ camera, temple, terrain, surfaceAt: navigationSurfaceAt });
globalThis._audio = audio;

document.getElementById('boot').textContent = 'dressing rock, scree, and desert scrub…';
const dressing = await makeDesertDressing(THREE, {
    terrain,
    // Sky quality is deliberately isolated from authored scene detail.
    quality: 'balanced',
});
scene.add(dressing.group);
globalThis._desertDressing = dressing;

document.getElementById('boot').textContent = 'planting SeedThree desert LODs…';
const vegetationLoader = new GLTFLoader();
const saguaroGltf = await vegetationLoader.loadAsync('./assets/vegetation/saguaro_seed555.glb');
const joshuaUrl = './assets/vegetation/joshuaTree_seed555.glb';
const joshuaGltf = (await fetch(joshuaUrl, { method: 'HEAD' })).ok
    ? await vegetationLoader.loadAsync(joshuaUrl)
    : null;
const vegetation = await makeVegetationScene(THREE, {
    terrain,
    saguaroGltf,
    joshuaGltf,
    sunLight: sun,
    // Keep the complete instanced population and its long LOD distances in
    // every sky mode. The Quality selector only budgets sky and weather work.
    quality: 'balanced',
});
scene.add(vegetation.group);
vegetation.update(camera, 0, true);
globalThis._vegetation = vegetation;
// Rocks resolve through the same collision streamer as the vegetation, so
// the player pushes off the SAME CoACD hull shapes the renderer draws. The
// hull library must land before registration matters; awaiting it here keeps
// the very first resolve shape-accurate instead of capsule-fallback.
await vegetation.hullLibraryReady;
{
    const rockFeed = terrain?.rockCollisionPlacements ?? [];
    const bySpecies = new Map();
    for (const record of rockFeed) {
        if (!bySpecies.has(record.species)) bySpecies.set(record.species, []);
        bySpecies.get(record.species).push(record);
    }
    let registered = 0;
    for (const [speciesKey, placements] of bySpecies) {
        registered += vegetation.registerCollisionSpecies(speciesKey, placements);
    }
    console.log(`[collision] registered ${registered} rock instances across ${bySpecies.size} hull species`);
}

// Optional chrome probe for automated reflection validation. It is not part
// of the authored scene; enable it explicitly with ?debugProbe=1.
const showReflectionProbe = new URLSearchParams(location.search).get('debugProbe') === '1';
const ballMat = new THREE.MeshStandardNodeMaterial({ metalness: 1, roughness: 0, color: 0xffffff });
ballMat.envMapIntensity = 1;
const ballRadius = 2.4;
const ball = new THREE.Mesh(new THREE.SphereGeometry(ballRadius, 48, 24), ballMat);
ball.name = 'reflection_probe';
const probeGroundY = terrain.heightAt?.(20, 14) ?? 0;
const probePedestalMat = new THREE.MeshStandardNodeMaterial({ color: 0x27383a, roughness: 0.38, metalness: 0.42 });
probePedestalMat.envMapIntensity = 0.72;
const probePedestal = new THREE.Mesh(new THREE.CylinderGeometry(2.85, 3.25, 1.25, 12), probePedestalMat);
probePedestal.name = 'reflection_probe_pedestal';
probePedestal.position.set(20, probeGroundY + 0.625, 14);
ball.position.set(20, probeGroundY + 1.25 + ballRadius + 0.06, 14);
ball.userData.noWet = true;
ball.visible = showReflectionProbe;
probePedestal.visible = showReflectionProbe;
scene.add(probePedestal, ball);

let reflectionDirty = true;
let reflectionLastBake = -Infinity;
let reflectionBakedHours = null;
// The IBL environment must never lag the weather: a pre-storm bake leaves
// PBR receivers (temple, far terrain) lit sunny-bright under a sealed sky.
let reflectionBakedWeatherSig = '';
let reflectionBakeRevision = 0;
let reflectionPipeline = null;
const aoControl = document.getElementById('ao');
const skyboxControl = document.getElementById('skybox');
const cloudTypeControl = document.getElementById('cloud-type');
const weatherControl = document.getElementById('weather');
const weatherStatus = document.getElementById('weather-status');
const weatherBusy = document.getElementById('weather-busy');
// One in-flight async pipeline warmup; the frame loop waits on it instead of
// letting the next render compile every dirtied material synchronously.
let pipelineWarmup = null;
// Boot preloads the weather engine, finishes every material wrapper, exposes
// pooled rain/lightning meshes, then compiles them with the exact scene MRT.
// Later weather transitions are uniform-only and must not traverse/compile the
// same 235 render items again.
let pipelineWarmupReadyOwner = null;
const setWeatherBusy = (on) => {
    if (weatherBusy) weatherBusy.hidden = !on;
};
const beginPipelineWarmup = () => {
    if (pipelineWarmup) return pipelineWarmup;
    const owner = reflectionPipeline;
    if (owner && pipelineWarmupReadyOwner === owner) {
        setWeatherBusy(false);
        return Promise.resolve(true);
    }
    const warmupObjects = active?.weatherWarmupObjects?.() ?? [];
    const savedVisibility = warmupObjects.map((object) => object.visible);
    for (const object of warmupObjects) object.visible = true;
    const started = performance.now();
    const compilePromise = typeof owner?.compileAsync === 'function'
        ? owner.compileAsync() : renderer.compileAsync(scene, camera);
    const syncMs = performance.now() - started;
    if (syncMs > 200) {
        console.log('[perf] pipeline warmup blocked', Math.round(syncMs), 'ms synchronously');
    }
    let compileSucceeded = false;
    const warmup = compilePromise
        .then(() => { compileSucceeded = true; })
        .catch((error) => { console.warn('[weather] exact-pass pipeline warmup failed', error); })
        .then(() => {
            warmupObjects.forEach((object, index) => {
                object.visible = savedVisibility[index];
            });
            const totalMs = performance.now() - started;
            if (totalMs > 500) {
                console.log('[perf] exact-pass pipeline warmup total', Math.round(totalMs), 'ms');
            }
            if (compileSucceeded && reflectionPipeline === owner) {
                pipelineWarmupReadyOwner = owner;
            }
            if (pipelineWarmup === warmup) pipelineWarmup = null;
            setWeatherBusy(false);
        });
    pipelineWarmup = warmup;
    return warmup;
};
const SCENE_SELECTION_VALUES = Object.freeze({
    skybox: Object.freeze(['earth', 'ringworld', 'shieldworld']),
    cloudType: Object.freeze(['clear', 'cumulus', 'stratus', 'cirrus']),
    weather: Object.freeze(['none', 'fair', 'sunshower', 'overcast', 'rain', 'storm', 'cyclone', 'darkstorm']),
});
// The old combined "Cumulus Day" default is preserved as two independent
// defaults: Earth + Cumulus. Rebuilds read this durable selection rather than
// deriving one axis from another or mutating either control.
const sceneSelection = {
    skybox: 'earth',
    cloudType: 'cumulus',
    weather: 'none',
};
const selectedAxis = (axis, control, fallback) => SCENE_SELECTION_VALUES[axis].includes(control?.value)
    ? control.value
    : fallback;
const syncSceneSelection = () => {
    sceneSelection.skybox = selectedAxis('skybox', skyboxControl, sceneSelection.skybox);
    sceneSelection.cloudType = selectedAxis('cloudType', cloudTypeControl, sceneSelection.cloudType);
    sceneSelection.weather = selectedAxis('weather', weatherControl, sceneSelection.weather);
    globalThis._eanpaSceneSelection = {
        ...sceneSelection,
        independentAxes: true,
        available: SCENE_SELECTION_VALUES,
    };
    return { ...sceneSelection };
};
syncSceneSelection();
let aoPreference = aoControl?.checked ?? true;
let lastWeatherStatus = '';
const weatherLabel = (value = weatherControl?.value) => [...(weatherControl?.options ?? [])]
    .find((option) => option.value === (value ?? 'none'))
    ?.textContent?.replace(/\s*\([^)]*\)\s*$/, '') ?? value ?? 'None';
const setWeatherStatus = (text) => {
    if (!weatherStatus || text === lastWeatherStatus) return;
    weatherStatus.textContent = text;
    lastWeatherStatus = text;
};
const weatherBakeSignature = () => {
    const tr = globalThis._weather?.diagnostics?.transition;
    return tr?.active
        ? tr.target + ':' + Math.round((tr.easedProgress ?? 0) * 8)
        : 'settled:' + sceneSelection.weather;
};
const updateWeatherStatus = () => {
    const tr = globalThis._weather?.diagnostics?.transition;
    if (tr?.active) {
        const percent = Math.round(Math.max(0, Math.min(1, tr.rawProgress ?? 0)) * 100);
        const remaining = Math.max(0, (tr.durationSeconds ?? 45) - (tr.elapsedSeconds ?? 0));
        setWeatherStatus(weatherLabel(tr.target) + ' ' + percent + '% · ' + remaining.toFixed(0) + 's');
        return;
    }
    setWeatherStatus(weatherLabel());
};

const filteredEnvironment = makeReflectionEnvironment(THREE, renderer);
globalThis._filteredEnvironment = filteredEnvironment;

function assignReflectionEnvironment(env) {
    if (!env) return 0;
    const installed = reflectionPipeline
        ? reflectionPipeline.setEnvironment(env)
        : installReflectionEnvironment(scene, env);
    globalThis._reflectionEnv = env;
    return installed?.userData?.eanpaReflectionMaterialCount ?? 0;
}

async function rebakeReflections(force = false) {
    if (!force && !reflectionDirty) return;
    try {
        const sky = active?.sky;
        if (!sky?.bakeEnv) return;
        const bakeStarted = performance.now();
        const q = QUALITY[document.getElementById('quality').value] ?? QUALITY.balanced;
        const owner = active;
        const env = await sky.bakeEnv(renderer, {
            ...q.reflectionBake,
            ...(active.reflectionBake ?? {}),
            // Keep clouds inside Three's native PMREM/IBL path. That path
            // evaluates each material's resolved normal, base/specular color,
            // metalness, roughness, Fresnel, multiscattering and IBL AO. The
            // former full-screen live delta blurred neighbouring receiver
            // pixels instead of angular sky radiance, producing oil-like
            // colour bands and visibly incorrect roughness response.
            includeClouds: true,
        });
        if (active !== owner) return;
        const count = assignReflectionEnvironment(filteredEnvironment.update(env));
        reflectionBakedHours = Number(document.getElementById('tod').value);
        reflectionBakedWeatherSig = weatherBakeSignature();
        reflectionDirty = false;
        reflectionLastBake = performance.now();
        globalThis._reflectionStats = {
            ...(globalThis._reflectionStats ?? {}),
            materials: count,
            quality: document.getElementById('quality').value,
            hours: reflectionBakedHours,
            cloudPbr: 'same-ray-live-sky-plus-pmrem-pbr-response',
            cloudsIncluded: true,
            cloudRefreshSeconds: q.cloudReflectionRefreshSeconds,
            bakeRevision: ++reflectionBakeRevision,
            equirectBakeMs: Number((performance.now() - bakeStarted).toFixed(2)),
        };
        console.log(`[eanpa] Eidoverse sky environment installed for ${count} PBR materials`);
    } catch (e) {
        reflectionDirty = false;   // avoid an error storm; the next state change retries
        reflectionLastBake = performance.now();
        console.error('[eanpa] reflection env bake failed', e);
    }
}

await coreEngineModulesReady;
const [
    { makeWeatherSky }, { makeShieldworld }, { makeRingworld },
    { makeReflectionPipeline, installReflectionEnvironment },
    { makeSpatialCloudPass },
] = await skyModulesReady;

const SKYBOX_FACTORIES = Object.freeze({
    earth: (ctx, cloudPreset, weatherState) => makeWeatherSky(ctx, cloudPreset, weatherState),
    ringworld: (ctx, cloudPreset, weatherState) => makeRingworld({ ...ctx, cloudPreset, weatherState }),
    shieldworld: (ctx, cloudPreset, weatherState) => makeShieldworld({ ...ctx, cloudPreset, weatherState }),
});

// The optimized tiers retain Eidoverse's world-space cloud dome. Their speed
// comes from bounded march counts and density/light caches, never from the old
// screen-space history proxy that pinned cloud copies to camera pixels.
const CACHE_MODE = new URLSearchParams(location.search).get('cache') || 'all';
const useDensityCache = CACHE_MODE === 'all' || CACHE_MODE === 'density';
const useLightCache = CACHE_MODE === 'all' || CACHE_MODE === 'light';
const optimizedCaches = (lightSize, refreshSeconds) => ({
    densityCache: useDensityCache ? { size: 128 } : null,
    lightCache: useLightCache ? { size: lightSize, refreshSeconds } : null,
});
// These profiles budget only sky, skybox reflections, spatial clouds, and
// weather particles. All tiers retain terrain, architecture, N8AO and native
// reflections. Sun-shadow resolution is fixed; refresh cadence follows the tier.
const QUALITY = {
    high: {
        name: 'high', label: 'High / Insane', fpsTarget: 30,
        skySamples: 60, lightSamples: 18, cloudPasses: 5, cloudDiv: 1,
        reflectionBake: { width: 512, height: 256, cloudPasses: 4 },
        cloudReflectionRefreshSeconds: 10,
        weather: { rainCount: 16000, splashCount: 1100, transitionSeconds: 45, surfaceResolution: 1024, surfaceRefreshHz: 12 },
        ...optimizedCaches([160, 40, 160], 0.12),
    },
    balanced: {
        name: 'balanced', label: 'Balanced', fpsTarget: 60,
        skySamples: 44, lightSamples: 14, cloudPasses: 3, cloudDiv: 2,
        reflectionBake: { width: 384, height: 192, cloudPasses: 3 },
        cloudReflectionRefreshSeconds: 16,
        weather: { rainCount: 10000, splashCount: 700, transitionSeconds: 45, surfaceResolution: 768, surfaceRefreshHz: 8 },
        ...optimizedCaches([112, 28, 112], 0.22),
    },
    performance: {
        name: 'performance', label: 'Performance', fpsTarget: 120,
        skySamples: 20, lightSamples: 6, cloudPasses: 2, cloudDiv: 3,
        reflectionBake: { width: 256, height: 128, cloudPasses: 2 },
        cloudReflectionRefreshSeconds: 24,
        weather: { rainCount: 5500, splashCount: 320, transitionSeconds: 45, surfaceResolution: 512, surfaceRefreshHz: 6 },
        ...optimizedCaches([72, 20, 72], 0.33),
    },
};
let spatialClouds = null;
let skyResolutionPolicy = null;

// Keep the authored tier fixed. The previous adaptive controller timed the
// entire serialized scene/post frame, so dense vegetation, SSR/N8AO, or an
// unrelated GPU process could make it punish only the clouds. Quality tuning
// is accepted only from a clean sole-GPU run; runtime contention must never
// silently degrade the selected visual tier.
function resetSkyResolutionPolicy(q) {
    skyResolutionPolicy = spatialClouds ? {
        quality: q.name,
        mode: 'fixed-clean-benchmark',
        divisor: q.cloudDiv,
    } : null;
}

let active = null;      // { sky, update(t, dt), dispose() }
let building = false;
let rebuildQueued = false;
let inFlight = false;   // declared here: buildSkybox runs before the frame-loop section
let cycleHours = Number(document.getElementById('tod').value);
const weatherReflectionTimers = new Set();
const clearWeatherReflectionTimers = () => {
    for (const timer of weatherReflectionTimers) clearTimeout(timer);
    weatherReflectionTimers.clear();
};
const scheduleWeatherReflectionUpdates = (owner, seconds = 45) => {
    clearWeatherReflectionTimers();
    const duration = Math.max(10, Number(seconds) || 45) * 1000;
    for (const fraction of [0.25, 0.5, 0.75, 1.03]) {
        const timer = setTimeout(() => {
            weatherReflectionTimers.delete(timer);
            if (active === owner) reflectionDirty = true;
        }, duration * fraction);
        weatherReflectionTimers.add(timer);
    }
};
const testFrameState = globalThis._eanpaTest = {
    pauseAfterFrame: false,
    paused: false,
    completedFrames: 0,
    // Controlled visual QA only: the optional ?debugProbe=1 chrome sphere
    // needs repeatable camera placement without synthetic movement input.
    camera: showReflectionProbe ? camera : null,
    reflectionProbe: showReflectionProbe ? ball : null,
};

function yieldForBootPaint() {
    return new Promise((resolve) => {
        let frameId = null;
        const finish = () => {
            if (frameId !== null) cancelAnimationFrame(frameId);
            clearTimeout(timer);
            resolve();
        };
        // Covered/minimized windows can stop rAF completely. Prefer two paint
        // opportunities, but never make initialization depend on visibility.
        const timer = setTimeout(finish, 200);
        frameId = requestAnimationFrame(() => { frameId = requestAnimationFrame(finish); });
    });
}

async function buildSkybox() {
    if (building) {
        rebuildQueued = true;
        return;
    }
    building = true;
    document.getElementById('boot').style.display = 'grid';
    document.getElementById('boot').textContent = 'building skybox…';
    // Two rAF yields let the browser actually PAINT the overlay before the
    // heavy synchronous build/compile work blocks the thread — without them a
    // skybox change read as a raw freeze with no loading feedback at all.
    await yieldForBootPaint();
    // Kept outside the try so a preset that rejects before attachment cannot
    // strand its two offscreen render targets/materials/geometries.
    let spatialCandidate = null;
    // never dispose the scene while a frame is mid-flight on the device —
    // that's a renderAsync hang (Chrome freeze on settings change)
    while (inFlight) await new Promise((r) => setTimeout(r, 16));
    while (pipelineWarmup) await pipelineWarmup;
    try {
        clearWeatherReflectionTimers();
        rebuildResources.clear();
        if (reflectionPipeline) {
            if (pipelineWarmupReadyOwner === reflectionPipeline) {
                pipelineWarmupReadyOwner = null;
            }
            reflectionPipeline.dispose();
            reflectionPipeline = null;
            globalThis._reflectionPipeline = null;
        }
        if (spatialClouds) {
            spatialClouds.dispose();
            spatialClouds = null;
            globalThis._spatialClouds = null;
        }
        skyResolutionPolicy = null;
        if (active) { active.dispose(); active = null; }
        const selection = syncSceneSelection();
        const kind = selection.skybox;
        const cloudPreset = selection.cloudType;
        const wx = selection.weather;
        setWeatherStatus(weatherLabel(wx));
        const qualityName = document.getElementById('quality').value;
        const q = QUALITY[qualityName] ?? QUALITY.balanced;
        globalThis._skyQualityStats = {
            name: q.name,
            label: q.label,
            fpsTarget: q.fpsTarget,
            scope: 'sky-weather-skyboxes-only',
            preservesAllSkyElements: true,
        };
        document.getElementById('stage').textContent = `${q.label}: ${q.fpsTarget}+ FPS target`;
        const hours = Number(document.getElementById('tod').value);
        spatialCandidate = q.cloudDiv
            ? makeSpatialCloudPass(THREE, renderer, camera, { div: q.cloudDiv })
            : null;
        const ctx = {
            THREE, scene, camera, renderer, sun, hemi, loadEngine,
            quality: q,
            hours,
            cloudPreset,
            weatherState: wx,
            blueNoise: null,
            worldRayDir: !!spatialCandidate,
        };
        active = await (SKYBOX_FACTORIES[kind] ?? SKYBOX_FACTORIES.earth)(ctx, cloudPreset, wx);
        if (active?.supportsWeather !== true || typeof active.setWeather !== 'function') {
            throw new Error(`${kind} skybox did not provide the shared weather contract`);
        }
        if (spatialCandidate?.attach(scene, active.sky)) {
            spatialClouds = spatialCandidate;
            globalThis._spatialClouds = spatialClouds;
        } else {
            spatialCandidate?.dispose();
        }
        resetSkyResolutionPolicy(q);
        // Pre-load the weather engine while the boot screen still covers the
        // cost. Its lightning scene light must exist BEFORE anything compiles:
        // a light added later (the old lazy first-use path) changed the
        // scene's light list, which regenerates every pipeline in the scene —
        // that was the 30-60 s freeze on the first switch into rainy weather.
        if (typeof active.preloadWeather === 'function') {
            // Pre-load the weather engine AND synchronously finish its
            // wetness/cloud-shadow material wraps behind the boot screen. Its
            // lightning light must join the scene and every wrap must land
            // BEFORE anything compiles ("no graph surgery after first
            // compile") — a light or graph change later regenerates pipelines.
            document.getElementById('boot').textContent = 'loading weather engine…';
            await yieldForBootPaint();
            await active.preloadWeather();
            document.getElementById('boot').textContent = 'building skybox…';
        }
        // Shieldworld synchronizes the red giant and hides its placeholder sun
        // in update(); initialize that state before baking the first reflection.
        active.update?.(0, 0);
        await active.prepareFrame?.(renderer,camera);
        await globalThis._weather?.prepareFrame?.(renderer, camera, { force: true });
        // Project the active sky's moving cloud field onto every local PBR
        // receiver independently of weather activation. Previously this was a
        // side effect of lazily constructing weather, so the default None state
        // had no cloud shadows at all.
        const cloudShadowMaterials = active.sky?.wrapCloudShadows?.(scene) ?? 0;
        await active.sky?.prepareCloudShadows?.(renderer, camera, true);
        globalThis._cloudShadowStats = {
            ...(active.sky?.cloudShadowInfo ?? {}),
            materials: cloudShadowMaterials,
            installedWithoutWeather: true,
            quality: q.name,
        };
        // Register the local sky system's existing Eidoverse same-ray shader
        // before the bake: bakeEnv then binds its stable below-horizon
        // ground-bounce texture, while the hook supplies deterministic live
        // sky/cloud radiance above the reflected horizon. The reflection
        // pipeline applies Eanpa's resolved F0/DFG/AO response externally.
        active.sky?.enableReflections?.(camera, {
            externalPbrResponse: true,
            blur: false,
        });
        reflectionDirty = true;
        reflectionBakedHours = null;
        await rebakeReflections(true);
        // The browser owns one explicit scene MRT in reflection_pipeline.js;
        // remove legacy partial MRT stamps while preserving complete material
        // overrides that merge intentional receiver weights into this contract.
        globalThis.eanpaStripMrt(scene);
        reflectionPipeline = makeReflectionPipeline(
            // The sky selector must not degrade local reflections, N8AO, SSR,
            // or bloom. Keep that scene pipeline at its authored setting.
            THREE, renderer, scene, camera, active.sky, 'balanced',
            requiredFxaaFactory, globalThis._reflectionEnv,
        );
        reflectionPipeline.setAOEnabled?.(aoPreference);
        reflectionPipeline.localProbe?.configure({sampleGroundHeight:(x,z)=>navigationSurfaceAt(x,z).height});
        if (aoControl) {
            aoControl.disabled = !reflectionPipeline.aoAvailable;
            aoControl.checked = reflectionPipeline.aoAvailable
                ? Boolean(reflectionPipeline.aoEnabled)
                : false;
        }
        reflectionPipeline.resize(innerWidth, innerHeight);
        if (globalThis._reflectionEnv) reflectionPipeline.setEnvironment(globalThis._reflectionEnv);
        globalThis._reflectionPipeline = reflectionPipeline;
        globalThis._reflectionStats = {
            ...(globalThis._reflectionStats ?? {}),
            mode: reflectionPipeline.mode,
            supported: reflectionPipeline.supported,
            n8aoAvailable: Boolean(reflectionPipeline.aoAvailable),
            n8aoEnabled: Boolean(reflectionPipeline.aoEnabled),
            n8aoReason: reflectionPipeline.aoReason ?? null,
            n8aoRequested: aoPreference,
            environmentSuppressedMaterials: reflectionPipeline.environmentSuppressedMaterials ?? 0,
            reflectionCompose: reflectionPipeline.reflectionCompose ?? null,
            aoReceiverMask: reflectionPipeline.aoReceiverMask ?? null,
            sameRaySkyAvailable: Boolean(reflectionPipeline.sameRaySkyAvailable),
            sameRaySkySource: reflectionPipeline.sameRaySkySource ?? null,
            sameRaySkyReason: reflectionPipeline.sameRaySkyReason ?? null,
            bloomSource: reflectionPipeline.bloomSource ?? null,
            sceneColorAttachments: reflectionPipeline.sceneColorAttachments ?? null,
        };
        // STAGED WARMUP BEHIND THE CURTAIN. First compile the exact scene MRT
        // asynchronously after native environment bindings, material graphs, lights,
        // and weather wrappers have reached their final form. The boot overlay is
        // still up — this was the multi-second black screen after loading:
        // Pooled weather meshes stay visible to the compiler so later weather
        // switches remain uniform changes instead of surprise shader builds.
        // The boot overlay remains painted while Three yields between objects.
        {
            const warmupObjects = active.weatherWarmupObjects?.() ?? [];
            const savedVisibility = warmupObjects.map((object) => object.visible);
            const firstFrameStarted = performance.now();
            let rainSurfaceWarmupMs = null;
            let exactMrtCompileMs = null;
            let finalGraphRenderMs = null;
            let curtainFrameReady = false;
            try {
                // Reflection registration and environment assignment changed
                // source material versions after the initial rain-field bake.
                // Resolve those final capture variants here: a dry scene skips
                // them until first rain, which otherwise compiles 51 pipelines
                // during play and stalls presentation on the GPU process.
                const rainSurfaceStarted = performance.now();
                await globalThis._weather?.prepareFrame?.(renderer, camera, { force: true });
                rainSurfaceWarmupMs = performance.now() - rainSurfaceStarted;
                for (const object of warmupObjects) object.visible = true;
                reflectionPipeline.update();
                if (typeof reflectionPipeline.compileAsync === 'function') {
                    const compileStarted = performance.now();
                    try {
                        await reflectionPipeline.compileAsync();
                        exactMrtCompileMs = performance.now() - compileStarted;
                        console.log('[perf] exact MRT async compile took',
                            Math.round(exactMrtCompileMs), 'ms');
                    } catch (error) {
                        console.warn('[boot] exact MRT async compile failed', error);
                    }
                }
                const finalGraphStarted = performance.now();
                try {
                    await reflectionPipeline.render();
                    // render() submits work; completion of GPU-side pipeline
                    // preparation must also remain behind the loading curtain.
                    await renderer.backend.device.queue.onSubmittedWorkDone();
                    curtainFrameReady = true;
                } finally {
                    finalGraphRenderMs = performance.now() - finalGraphStarted;
                }
            } catch (error) {
                console.warn('[boot] curtain frame failed', error);
            } finally {
                warmupObjects.forEach((object, index) => {
                    object.visible = savedVisibility[index];
                });
            }
            const totalWarmupMs = performance.now() - firstFrameStarted;
            globalThis._shaderWarmupStats = {
                rainSurfaceWarmupMs: rainSurfaceWarmupMs === null
                    ? null : Number(rainSurfaceWarmupMs.toFixed(2)),
                exactMrtCompileMs: exactMrtCompileMs === null
                    ? null : Number(exactMrtCompileMs.toFixed(2)),
                finalGraphRenderMs: finalGraphRenderMs === null
                    ? null : Number(finalGraphRenderMs.toFixed(2)),
                totalMs: Number(totalWarmupMs.toFixed(2)),
                weatherGraphReady: curtainFrameReady,
            };
            if (curtainFrameReady) pipelineWarmupReadyOwner = reflectionPipeline;
            console.log('[perf] staged curtain warmup total',
                Math.round(totalWarmupMs), 'ms; final graph render',
                Math.round(finalGraphRenderMs ?? 0), 'ms');
        }
        // Boot-time shader compilation does not advance the authored sky or
        // weather simulation, so its wall-clock duration must not make the
        // first live frame immediately repeat the environment bake that just
        // completed behind the curtain.
        reflectionLastBake = performance.now();
        document.getElementById('boot').style.display = 'none';
    } catch (e) {
        clearWeatherReflectionTimers();
        // Roll back every stage that successfully committed before the
        // failure. Each cleanup is isolated so one disposal error cannot
        // prevent the remaining GPU resources from being retired.
        const failedPipeline = reflectionPipeline;
        reflectionPipeline = null;
        if (pipelineWarmupReadyOwner === failedPipeline) pipelineWarmupReadyOwner = null;
        globalThis._reflectionPipeline = null;
        try { failedPipeline?.dispose?.(); } catch (cleanupError) { console.error('[cleanup] reflection pipeline', cleanupError); }

        const failedSpatial = spatialClouds;
        spatialClouds = null;
        globalThis._spatialClouds = null;
        try { failedSpatial?.dispose?.(); } catch (cleanupError) { console.error('[cleanup] spatial clouds', cleanupError); }
        if (spatialCandidate && spatialCandidate !== failedSpatial) {
            try { spatialCandidate.dispose?.(); } catch (cleanupError) { console.error('[cleanup] spatial candidate', cleanupError); }
        }

        const failedActive = active;
        active = null;
        try { failedActive?.dispose?.(); } catch (cleanupError) { console.error('[cleanup] active sky', cleanupError); }
        skyResolutionPolicy = null;
        globalThis._reflectionEnv = null;
        document.getElementById('boot').textContent = 'skybox build failed: ' + e.message;
        console.error(e);
    }
    building = false;
    if (rebuildQueued) {
        rebuildQueued = false;
        await buildSkybox();
    }
}

document.getElementById('skybox').addEventListener('change', buildSkybox);
document.getElementById('quality').addEventListener('change', buildSkybox);
cloudTypeControl.addEventListener('change', () => {
    const { cloudType } = syncSceneSelection();
    if (building) {
        rebuildQueued = true;
        return;
    }
    const owner = active;
    const handled = owner?.setCloudPreset?.(cloudType, ({ duration } = {}) => {
        if (active !== owner) return;
        reflectionDirty = true;
        scheduleWeatherReflectionUpdates(owner, duration ?? owner?.weatherTransitionSeconds ?? 45);
    }) === true;
    if (handled) {
        reflectionDirty = true;
        return;
    }
    void buildSkybox();
});
document.getElementById('strike-test')?.addEventListener('click', (event) => {
    const button = event.currentTarget;
    const requested = globalThis._weather?.forceStrike?.() ?? false;
    const lightning = globalThis._weather?.diagnostics?.lightning;
    const thunder = globalThis._audio?.stats?.thunder;
    console.log('[debug] forced lightning strike', requested ? 'queued' : 'unavailable', JSON.stringify({
        eventCount: lightning?.eventCount ?? null,
        nextEventAtSeconds: lightning?.nextEventAtSeconds ?? null,
        palette: lightning?.palette ?? null,
        localStrikes: lightning?.localImpact?.strikes ?? null,
        candidateAttempts: lightning?.localImpact?.candidateAttempts ?? null,
        raycastMisses: lightning?.localImpact?.raycastMisses ?? null,
        thunderLastDistanceMeters: thunder?.lastDistanceMeters ?? null,
        thunderLastDelaySeconds: thunder?.lastDelaySeconds ?? null,
        thunderLocal: thunder?.local ?? null,
        thunderDistant: thunder?.distant ?? null,
        thunderCracks: thunder?.cracks ?? null,
    }));
    if (button && !button.dataset.flashTimer) {
        const idleText = button.textContent;
        button.textContent = requested
            ? '⚡ strike incoming ahead…'
            : '⚡ needs stormy weather';
        button.dataset.flashTimer = String(setTimeout(() => {
            button.textContent = idleText;
            delete button.dataset.flashTimer;
        }, 1800));
    }
});
aoControl?.addEventListener('change', (event) => {
    aoPreference = Boolean(event.currentTarget.checked);
    reflectionPipeline?.setAOEnabled?.(aoPreference);
    const available = Boolean(reflectionPipeline?.aoAvailable);
    event.currentTarget.disabled = !available;
    event.currentTarget.checked = available
        ? Boolean(reflectionPipeline?.aoEnabled)
        : false;
    globalThis._reflectionStats = {
        ...(globalThis._reflectionStats ?? {}),
        n8aoAvailable: available,
        n8aoEnabled: Boolean(reflectionPipeline?.aoEnabled),
        n8aoReason: reflectionPipeline?.aoReason ?? null,
        n8aoRequested: aoPreference,
    };
});
weatherControl.addEventListener('change', () => {
    const { weather: state } = syncSceneSelection();
    if (building) {
        rebuildQueued = true;
        return;
    }
    setWeatherStatus(state === 'none' ? weatherLabel(state) : 'loading ' + weatherLabel(state) + '…');
    setWeatherBusy(true);
    const owner = active;
    const handled = owner?.setWeather?.(state, ({ duration } = {}) => {
        if (active !== owner) return;
        reflectionDirty = true;
        setWeatherStatus(weatherLabel(state) + ' 0% · ' + Math.round(duration ?? 45) + 's');
        // A true lazy/failure fallback still compiles asynchronously. The normal
        // browser path was preloaded and exact-MRT compiled behind the boot
        // curtain, so beginPipelineWarmup() resolves immediately without a
        // redundant full-scene traversal on every uniform-only transition.
        beginPipelineWarmup();
        // Start the PMREM milestones only once a lazy first-use weather load
        // has completed and the actual long morph has begun.
        scheduleWeatherReflectionUpdates(
            owner,
            duration ?? owner?.weatherTransitionSeconds ?? 45,
        );
    }) === true;
    if (!handled) {
        setWeatherBusy(false);
        buildSkybox();
    }
});
document.getElementById('tod').addEventListener('input', () => {
    const h = Number(document.getElementById('tod').value);
    document.getElementById('todv').textContent = h.toFixed(1);
    cycleHours = h;
    temple.setTime?.(h);
    if (active?.setTime) {
        active.setTime(h);
        reflectionDirty = true;
    }
});

await buildSkybox();

// ---- frame loop: try/catch + unconditional re-arm (a bad submit must
// never kill the rAF chain), fps meter + title telemetry ----
// frame path is FULLY serialized on renderAsync: an unawaited offscreen
// pass interleaving with the main render corrupts render-target state
// (black skies, vanished layers — found the hard way)
let last = performance.now(), emaMs = 16.7, t = 0;
const benchmark = new URLSearchParams(location.search).get('benchmark') === '1'
    ? new FrameMetrics() : null;
if (benchmark) globalThis._benchmark = benchmark;
document.addEventListener('visibilitychange', () => {
    if (document.hidden) benchmark?.invalidate('page hidden during capture');
});
async function tick(now, dt) {
    globalThis._frameStage = 'controls';
    controls.update(dt);
    firstPersonViewmodel.update(dt, movementState);
    terrain.updateLods?.(camera);
    temple.update(t, camera, dt);
    dressing.update?.(camera, t);
    vegetation.update(camera, t);
    if (document.getElementById('cycle').checked && active?.setTime) {
        const speed = Number(document.getElementById('cyclespeed').value);
        cycleHours = (cycleHours + dt * (24 / speed)) % 24;
        active.setTime(cycleHours);
        temple.setTime?.(cycleHours);
        document.getElementById('tod').value = cycleHours.toFixed(1);
        document.getElementById('todv').textContent = cycleHours.toFixed(1);
        const dh = reflectionBakedHours === null
            ? 24
            : Math.min(Math.abs(cycleHours - reflectionBakedHours), 24 - Math.abs(cycleHours - reflectionBakedHours));
        if (dh >= 0.35) reflectionDirty = true;
    }
    if (active) active.update(t, dt);
    const shadowHz={high:60,balanced:30,performance:20}[document.getElementById('quality').value]??30;
    sunShadowRefresh.update(t,shadowHz);
    updateWeatherStatus();
    if (scene.fog) {
        fogColorUniform.value = scene.fog.color;
        fogDensityUniform.value = scene.fog.density;
    }
    audio.update(dt, t, movementState);
    if (pipelineWarmup) {
        // Hold every GPU pass (bake, spatial clouds, scene render) until the
        // async pipeline warmup finishes; the last presented frame stays on
        // screen and the page keeps painting the busy spinner meanwhile.
        globalThis._frameStage = 'pipeline-warmup';
        await pipelineWarmup;
    }
    // `active.update()` applies Eidoverse's calibrated time-of-day key/fill
    // every frame. Do not boost the sun afterward: that would desynchronise
    // local PBR shading from the sky radiance and baked reflection environment.
    // All offscreen GPU work stays inside this serialized tick. A slider,
    // weather event, or cycle update only marks the bake dirty.
    const currentQuality = QUALITY[document.getElementById('quality').value]
        ?? QUALITY.balanced;
    const movingCloudReflectionDue = active?.sky?.state?.preset !== 'clear'
        && performance.now() - reflectionLastBake
            >= currentQuality.cloudReflectionRefreshSeconds * 1000;
    if (movingCloudReflectionDue) reflectionDirty = true;
    globalThis._frameStage = 'rain-surface';
    await active?.prepareFrame?.(renderer,camera);
    await globalThis._weather?.prepareFrame?.(renderer, camera);
    await active?.sky?.prepareCloudShadows?.(renderer, camera);
    if (reflectionBakedWeatherSig !== weatherBakeSignature()) reflectionDirty = true;
    if (reflectionDirty && performance.now() - reflectionLastBake >= 1500) {
        globalThis._frameStage = 'reflection-bake';
        await rebakeReflections();
    }
    if (spatialClouds) {
        globalThis._frameStage = 'spatial-clouds';
        await spatialClouds.render();
    }
    if (reflectionPipeline) {
        globalThis._frameStage = 'reflection-pipeline';
        reflectionPipeline.update();
        await reflectionPipeline.render();
    } else {
        globalThis._frameStage = 'raw-render';
        await renderer.renderAsync(scene, camera);
    }
    globalThis._frameStage = 'complete';
    benchmark?.record(now, performance.now(), !document.hidden);
    emaMs = emaMs * 0.95 + (now - (tick._p ?? now)) * 0.05;
    tick._p = now;
    if ((tick._n = (tick._n ?? 0) + 1) % 15 === 0) {
        const fps = 1000 / Math.max(emaMs, 0.01);
        document.getElementById('fps').textContent = fps.toFixed(0);
        document.getElementById('ms').textContent = emaMs.toFixed(1) + ' ms';
        document.title = `Eanpa ${fps.toFixed(0)}fps`;   // headless telemetry
        const qualityName = document.getElementById('quality').value;
        const target = (QUALITY[qualityName] ?? QUALITY.balanced).fpsTarget;
        globalThis._skyQualityStats = {
            ...(globalThis._skyQualityStats ?? {}),
            measuredFps: fps,
            measuredMs: emaMs,
            targetMet: fps >= target,
            workloadTargetMs: 1000 / target,
            cloudDivisor: spatialClouds?.getDivisor?.() ?? null,
            cloudResolution: spatialClouds?.getResolution?.() ?? null,
            resolutionPolicy: skyResolutionPolicy?.mode ?? 'not-applicable',
            preservesAllSkyElements: true,
        };
    }
}
function frame(now) {
    requestAnimationFrame(frame);
    // Pauses/rebuilds do not accumulate player motion. GPU work does: callbacks
    // skipped while a render is in flight belong to the next simulation step.
    // Updating `last` before the inFlight check slowed walking and falling in
    // proportion to GPU load (30 rendered FPS on a 60 Hz display ran at half speed).
    if (building || testFrameState.paused) {
        benchmark?.invalidate(building ? 'sky rebuild during capture' : 'paused during capture');
        last = now;
        tick._p = now;
        return;
    }
    if (inFlight) return;
    // A queued rAF timestamp can precede the performance.now() used during
    // boot. Never rewind weather, particle motion or player integration.
    const dt = Math.max(0, Math.min((now - last) / 1000, 0.1));
    last = now;
    t += dt;
    inFlight = true;
    tick(now, dt).then(() => {
        testFrameState.completedFrames++;
    }).catch((e) => {
        benchmark?.invalidate('render task failed');
        testFrameState.failedFrames = (testFrameState.failedFrames ?? 0) + 1;
        if (!frame._err) { frame._err = true; console.error('[frame]', e); }
    }).finally(() => {
        inFlight = false;
        if (testFrameState.pauseAfterFrame) {
            testFrameState.pauseAfterFrame = false;
            testFrameState.paused = true;
        }
    });
}
requestAnimationFrame(frame);

addEventListener('resize', () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
    firstPersonViewmodel.resize(innerWidth, innerHeight);
    spatialClouds?.resize();
    reflectionPipeline?.resize(innerWidth, innerHeight);
});

addEventListener('beforeunload', () => {
    clearWeatherReflectionTimers();
    firstPersonViewmodel.dispose();
    reflectionPipeline?.dispose();
    spatialClouds?.dispose();
    active?.dispose();
    void audio.dispose();
    vegetation.dispose();
    dressing.dispose();
    temple.dispose();
    terrain.dispose?.();
    ball.geometry.dispose();
    ballMat.dispose();
    probePedestal.geometry.dispose();
    probePedestalMat.dispose();
    for (const texturePromise of imageTextureCache.values()) texturePromise.then((texture) => texture.dispose()).catch(() => {});
    shadowMaterialCache.dispose();
    filteredEnvironment.dispose();
    rebuildResources.dispose();
    renderer.dispose();
    globalThis._temple = null;
    globalThis._vegetation = null;
    globalThis._desertDressing = null;
    globalThis._reflectionPipeline = null;
    globalThis._spatialClouds = null;
    globalThis._inputState = null;
    globalThis._audio = null;
});
