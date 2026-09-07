// Camera-layer Aletheia arms viewmodel. The articulated rig shares the world's
// supported RenderPipeline submission, but remains excluded from world
// collision, reflections, shadows, terrain queries, and explorer body physics.

const ASSET_URL = './assets/player/runtime/Aletheia_Chrome_1p_arms_viewmodel.glb?v=65336553bd9ad4ec';
const LOOPING_CLIPS = new Set(['Idle', 'Walk', 'Run']);
const ONE_SHOT_CLIPS = new Set([
    'Jump',
    'Land',
    'PushLeft',
    'PushRight',
    'ContactRecoil',
    'Climb',
]);
const CONTACT_CLIPS = new Set(['PushLeft', 'PushRight', 'ContactRecoil']);
const ACTION_VIEWMODEL_Y = -0.19;
const IDLE_VIEWMODEL_LIFT = 0.015;
const WALK_VIEWMODEL_LIFT = 0.020;
const RUN_VIEWMODEL_LIFT = 0.015;
const VIEWMODEL_DEPTH = -0.385;

function clamp01(value) {
    return Math.max(0, Math.min(1, Number(value) || 0));
}

function disposeLoadedObject(root) {
    const geometries = new Set();
    const materials = new Set();
    const textures = new Set();
    root?.traverse?.((object) => {
        if (object.geometry) geometries.add(object.geometry);
        const objectMaterials = Array.isArray(object.material)
            ? object.material
            : [object.material];
        for (const material of objectMaterials) {
            if (!material) continue;
            materials.add(material);
            for (const value of Object.values(material)) {
                if (value?.isTexture) textures.add(value);
            }
        }
    });
    for (const texture of textures) texture.dispose?.();
    for (const material of materials) material.dispose?.();
    for (const geometry of geometries) geometry.dispose?.();
}

export async function makeFirstPersonViewmodel(
    THREE,
    renderer,
    {
        loader,
        worldScene,
        worldCamera,
        assetUrl = ASSET_URL,
    } = {},
) {
    if (!THREE || !renderer || !loader?.loadAsync || !worldScene || !worldCamera) {
        throw new Error(
            'First-person viewmodel requires THREE, renderer, GLTFLoader, worldScene, and worldCamera',
        );
    }

    const motionRoot = new THREE.Group();
    motionRoot.name = 'first_person_viewmodel_motion';
    // The rig is a camera child so it shares the one supported RenderPipeline
    // scene submission. A second renderer.renderAsync() after pipeline.render()
    // can acquire/present a new WebGPU canvas texture and erase the world.
    worldCamera.add(motionRoot);
    worldCamera.layers.enable(31);

    const modelRoot = new THREE.Group();
    modelRoot.name = 'first_person_viewmodel_authored_orientation';
    // The runtime GLB is authored directly in Three's camera convention: the
    // hands extend down -Z already. Any PI half-turn puts the hands behind the
    // camera and exposes only the proximal upper-arm cuts.
    modelRoot.rotation.set(0, 0, 0);
    modelRoot.scale.setScalar(0.275);
    motionRoot.add(modelRoot);

    const gltf = await loader.loadAsync(assetUrl);
    const model = gltf.scene;
    model.name = 'Aletheia_Chrome_first_person_arms';
    modelRoot.add(model);

    let meshCount = 0;
    model.traverse((object) => {
        if (!object.isMesh) return;
        meshCount++;
        object.castShadow = false;
        object.receiveShadow = false;
        object.frustumCulled = false;
        object.renderOrder = 10000;
        object.layers.set(31);
        object.userData.firstPersonViewmodel = true;
        object.userData.cannotReceiveAO = true;
        object.userData.noPuddles = true;
        const materials = Array.isArray(object.material)
            ? object.material
            : [object.material];
        for (const material of materials) {
            if (!material) continue;
            material.depthTest = true;
            material.depthWrite = true;
            material.toneMapped = true;
            material.userData = material.userData || {};
            material.userData.firstPersonViewmodel = true;
            for (const value of Object.values(material)) {
                if (value?.isTexture) value.anisotropy = Math.max(value.anisotropy || 1, 4);
            }
        }
    });
    if (meshCount !== 1) {
        disposeLoadedObject(model);
        throw new Error(`Aletheia viewmodel expected one skinned mesh, found ${meshCount}`);
    }

    // Stable view-space lighting for the arms ONLY. In r184 WebGPU the global
    // light list is collected against the CAMERA's layer mask, not per mesh,
    // so a layer the camera can see cannot isolate lights from the world:
    // these camera-tracking lights lit terrain/temple/cliffs and their
    // per-draw inclusion flipped with the nested shadow render (the shading
    // snap). They now live on layer 30 — which no camera enables, excluding
    // them from global collection — and bind DIRECTLY to the arm material
    // via material.lightsNode, which replaces its scene light list.
    const ambient = new THREE.HemisphereLight(0xe8f1f8, 0x332b27, 1.25);
    const key = new THREE.DirectionalLight(0xfff0d8, 2.2);
    key.position.set(-2.4, 3.2, 2.8);
    key.target.position.set(0, -0.25, -1.0);
    const fill = new THREE.DirectionalLight(0xb8d8ff, 0.72);
    fill.position.set(2.6, 0.8, 1.6);
    fill.target.position.set(0, -0.35, -1.0);
    for (const object of [ambient, key, key.target, fill, fill.target]) object.layers.set(30);
    motionRoot.add(ambient, key, key.target, fill, fill.target);
    model.traverse((object) => {
        if (!object.isMesh) return;
        const materials = Array.isArray(object.material)
            ? object.material
            : [object.material];
        for (const material of materials) {
            if (material) material.lightsNode = THREE.lights([ambient, key, fill]);
        }
    });

    const mixer = new THREE.AnimationMixer(model);
    const actions = new Map();
    for (const clip of gltf.animations ?? []) {
        const action = mixer.clipAction(clip);
        if (LOOPING_CLIPS.has(clip.name)) {
            action.setLoop(THREE.LoopRepeat, Infinity);
            action.clampWhenFinished = false;
        } else if (ONE_SHOT_CLIPS.has(clip.name)) {
            action.setLoop(THREE.LoopOnce, 1);
            action.clampWhenFinished = true;
        }
        actions.set(clip.name, action);
    }
    const requiredClips = [
        'Idle',
        'Walk',
        'Run',
        'Jump',
        'Land',
        'PushLeft',
        'PushRight',
        'ContactRecoil',
        'Climb',
    ];
    const missingClips = requiredClips.filter((name) => !actions.has(name));
    if (missingClips.length) {
        disposeLoadedObject(model);
        throw new Error(`Aletheia viewmodel missing clips: ${missingClips.join(', ')}`);
    }

    let disposed = false;
    let activeName = null;
    let activeAction = null;
    let hasMovementSample = false;
    let previouslyGrounded = true;
    let airbornePeakSpeed = 0;
    let landTimeRemaining = 0;
    let lastContactSerial = 0;
    let contactClip = 'ContactRecoil';
    let contactTimeRemaining = 0;
    // Running square into a wall should raise BOTH hands. The GLB authors
    // only single-hand pushes, so a fast frontal impact overlays the OTHER
    // hand's push as a second concurrent action — the mixer normalizes the
    // cumulative weight, so both arms rise together.
    let overlayAction = null;
    let overlayFading = false;
    let wasClimbing = false;
    let smoothedX = 0;
    // Start at the visible relaxed presentation so loading never flashes a
    // hidden pose or waits for the hands to rise into their steady position.
    let smoothedY = ACTION_VIEWMODEL_Y + IDLE_VIEWMODEL_LIFT;
    let smoothedRoll = 0;

    function play(name, fadeSeconds = 0.12, restart = false) {
        if (name === activeName && !restart) return;
        const next = actions.get(name);
        if (!next) return;
        next.enabled = true;
        next.reset();
        next.setEffectiveTimeScale(1);
        next.setEffectiveWeight(1);
        if (activeAction && activeAction !== next) {
            activeAction.paused = false;
            // Preserve the authored clip and finger timing. Time-warping a
            // short full-rig push/landing clip makes its contact pose skid.
            activeAction.crossFadeTo(next, fadeSeconds, false);
        } else if (activeAction !== next) {
            next.fadeIn(Math.min(0.08, fadeSeconds));
        }
        next.play();
        activeName = name;
        activeAction = next;
    }

    play('Idle', 0);

    const api = {
        scene: worldScene,
        camera: worldCamera,
        model,
        mixer,
        stats: {
            available: true,
            assetUrl,
            meshCount,
            clipNames: [...actions.keys()],
            dedicatedScene: false,
            integratedRenderPipeline: true,
            renderLayer: 31,
            worldCollision: false,
            near: worldCamera.near,
            far: worldCamera.far,
            state: 'Idle',
        },
        update(dt = 0.016, movement = null) {
            if (disposed) return;
            const numericDt = Number(dt);
            const frameDt = Number.isFinite(numericDt)
                ? Math.max(0, Math.min(numericDt, 0.1))
                : 0.016;
            const grounded = movement ? Boolean(movement.grounded) : true;
            const verticalVelocity = Number(movement?.verticalVelocity) || 0;
            const horizontalSpeed = Math.max(0, Number(movement?.horizontalSpeed) || 0);
            const contactSerial = Math.max(0, Math.floor(Number(movement?.contactSerial) || 0));
            const assistedStep = movement?.assistedStep;
            const assistedStepActive = Boolean(assistedStep?.active);
            const climbDuration = Math.max(0.001, Number(assistedStep?.duration) || 0.001);
            const climbElapsed = Math.max(0, Number(assistedStep?.elapsed) || 0);
            // advanceAssistedStep clears `active` as soon as it reaches 1.0,
            // before this update runs. Retain Climb for that one completion
            // frame so the authored mantle/recovery endpoint is evaluated.
            const completedClimbFrame = !assistedStepActive
                && wasClimbing
                && climbElapsed >= climbDuration - 1e-6;
            const climbing = assistedStepActive || completedClimbFrame;
            const climbProgress = climbing
                ? clamp01(climbElapsed / climbDuration)
                : 0;
            let contactTriggered = false;

            if (contactSerial !== lastContactSerial) {
                lastContactSerial = contactSerial;
                const contactSide = Math.max(-1, Math.min(1, Number(movement?.contactSide) || 0));
                // Frontal at speed = a square wall hit: both hands brace.
                // Off-axis impacts keep their single-hand push; only a slow
                // frontal touch remains the small recoil flinch.
                const frontal = Math.abs(contactSide) <= 0.25;
                const impactSpeed = Math.max(0, Number(movement?.contactImpactSpeed) || 0);
                const bracing = frontal && impactSpeed > 3.0;
                contactClip = bracing || contactSide > 0.25
                    ? 'PushRight'
                    : contactSide < -0.25
                        ? 'PushLeft'
                        : 'ContactRecoil';
                if (overlayAction) {
                    overlayAction.fadeOut(0.05);
                    overlayAction = null;
                    overlayFading = false;
                }
                if (bracing) {
                    const other = actions.get('PushLeft');
                    if (other) {
                        other.enabled = true;
                        other.reset();
                        other.setEffectiveTimeScale(1);
                        other.setEffectiveWeight(1);
                        other.fadeIn(0.045);
                        other.play();
                        overlayAction = other;
                        overlayFading = false;
                    }
                }
                const clipDuration = actions.get(contactClip)?.getClip?.()?.duration ?? 0.72;
                contactTimeRemaining = Math.max(0.42, Math.min(0.9, clipDuration));
                // A new surface impact supersedes a pending landing recovery;
                // do not replay a stale landing almost a second afterward.
                landTimeRemaining = 0;
                contactTriggered = true;
            }
            // Retire the brace overlay with the contact window so it cannot
            // linger under Walk/Run/Idle after the push completes.
            if (overlayAction && !overlayFading && contactTimeRemaining <= 0.12) {
                overlayAction.fadeOut(0.1);
                overlayFading = true;
            }
            if (overlayAction && overlayFading && contactTimeRemaining <= 0) {
                overlayAction = null;
                overlayFading = false;
            }

            if (!hasMovementSample) {
                hasMovementSample = true;
                previouslyGrounded = grounded;
            }
            if (!grounded) airbornePeakSpeed = Math.max(airbornePeakSpeed, Math.abs(verticalVelocity));
            const justLanded = grounded && !previouslyGrounded && airbornePeakSpeed >= 0.6;
            if (justLanded && contactTimeRemaining <= 0) {
                const landDuration = actions.get('Land')?.getClip?.()?.duration ?? 0.82;
                landTimeRemaining = Math.max(0.62, Math.min(0.95, landDuration));
            }
            if (grounded && previouslyGrounded && landTimeRemaining <= 0) airbornePeakSpeed = 0;
            previouslyGrounded = grounded;

            let desired = 'Idle';
            if (climbing) {
                desired = 'Climb';
                contactTimeRemaining = 0;
                landTimeRemaining = 0;
            } else if (contactTimeRemaining > 0) {
                desired = contactClip;
                contactTimeRemaining = Math.max(0, contactTimeRemaining - frameDt);
            } else if (landTimeRemaining > 0) {
                desired = 'Land';
                landTimeRemaining = Math.max(0, landTimeRemaining - frameDt);
            } else if (!grounded) {
                desired = 'Jump';
            } else if (horizontalSpeed > 5.0) {
                desired = 'Run';
            } else if (horizontalSpeed > 0.18) {
                desired = 'Walk';
            }
            const fadeSeconds = desired === 'Land'
                ? 0.055
                : ONE_SHOT_CLIPS.has(desired)
                    ? 0.045
                    : 0.11;
            play(
                desired,
                fadeSeconds,
                (contactTriggered && desired === contactClip)
                    || (climbing && !wasClimbing),
            );
            if (desired === 'Climb') {
                const climbAction = actions.get('Climb');
                const authoredDuration = climbAction?.getClip?.()?.duration ?? 1;
                climbAction.paused = true;
                climbAction.time = climbProgress * Math.max(authoredDuration, 0);
                // The paused action keeps its authored time tied to physical
                // climb progress. A positive mixer delta is still required so
                // AnimationMixer's global-time crossfade weights can advance.
                mixer.update(frameDt);
            } else {
                if (activeAction) activeAction.paused = false;
                mixer.update(frameDt);
            }
            wasClimbing = assistedStepActive;

            // Only subtle screen-space inertia sits on top of the authored rig
            // clips. Locomotion and finger articulation come from the skeleton,
            // never from this camera-local secondary motion.
            const moveAmount = clamp01(horizontalSpeed / 7.2);
            const phase = Number(movement?.bobPhase) || 0;
            const targetX = Math.sin(phase) * 0.005 * moveAmount;
            // Relaxed locomotion keeps both complete hand/cuff silhouettes
            // visible above the HUD. One-shot actions retain the separately
            // audited action framing instead of inheriting this lift.
            const presentationLift = desired === 'Idle'
                ? IDLE_VIEWMODEL_LIFT
                : desired === 'Walk'
                    ? WALK_VIEWMODEL_LIFT
                    : desired === 'Run'
                        ? RUN_VIEWMODEL_LIFT
                        : 0;
            const targetY = ACTION_VIEWMODEL_Y + presentationLift
                - Math.abs(Math.sin(phase * 2)) * 0.003 * moveAmount
                + (!grounded ? 0.004 : 0);
            const targetRoll = Math.sin(phase) * 0.005 * moveAmount;
            const blend = 1 - Math.exp(-frameDt * 13);
            smoothedX += (targetX - smoothedX) * blend;
            smoothedY += (targetY - smoothedY) * blend;
            smoothedRoll += (targetRoll - smoothedRoll) * blend;
            motionRoot.position.set(smoothedX, smoothedY, VIEWMODEL_DEPTH);
            motionRoot.rotation.set(0, 0, smoothedRoll);
            api.stats.state = activeName;
            api.stats.contactSerial = lastContactSerial;
            api.stats.contactClip = CONTACT_CLIPS.has(desired) ? desired : null;
            api.stats.climbProgress = climbing ? climbProgress : null;
        },
        resize() {},
        async render() {},
        setVisible(visible) {
            model.visible = Boolean(visible);
        },
        dispose() {
            if (disposed) return;
            disposed = true;
            mixer.stopAllAction();
            disposeLoadedObject(model);
            motionRoot.removeFromParent();
            worldCamera.layers.disable(31);
        },
    };

    motionRoot.position.set(0, ACTION_VIEWMODEL_Y + IDLE_VIEWMODEL_LIFT, VIEWMODEL_DEPTH);
    return api;
}

export const FIRST_PERSON_VIEWMODEL_ASSET = ASSET_URL;
