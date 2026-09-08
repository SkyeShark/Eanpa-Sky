// Current-frame spatial sky downsampling for optimized quality tiers.
//
// This deliberately has NO temporal history, reprojection, or previous-frame
// texture. The former cloudgraph accumulated the same screen UV while the
// camera moved, producing the pinned/skipping cloud copies reported by the
// user. Here the real world cloud dome is rendered for the current camera at
// reduced resolution and immediately composited once in that same frame. The
// background and cloud volume use separate targets so authored layers can
// remain between them (Ringworld background -100, structure -99, cloud -98,
// curved high cloud -97) instead of being flattened into the wrong order.

export function makeSpatialCloudPass(THREE, renderer, camera, { div = 2 } = {}) {
    const T3 = THREE;
    let divisor = Math.max(1, Math.round(div));
    const width = () => Math.max(1, Math.ceil(innerWidth / divisor));
    const height = () => Math.max(1, Math.ceil(innerHeight / divisor));
    const makeTarget = (name) => {
        const result = new T3.RenderTarget(width(), height(), {
            depthBuffer: false,
            type: T3.HalfFloatType,
            minFilter: T3.LinearFilter,
            magFilter: T3.LinearFilter,
        });
        result.texture.name = name;
        result.texture.colorSpace = T3.NoColorSpace;
        result.texture.generateMipmaps = false;
        return result;
    };
    const backgroundTarget = makeTarget('eanpa_current_spatial_background');
    const cloudTarget = makeTarget('eanpa_current_spatial_clouds');

    const backgroundScene = new T3.Scene();
    const cloudScene = new T3.Scene();
    const backgroundMaterial = new T3.MeshBasicNodeMaterial({
        depthWrite: false,
        depthTest: true,
        side: T3.BackSide,
        fog: false,
    });
    backgroundMaterial.toneMapped = true;
    backgroundMaterial.colorNode = T3.texture(backgroundTarget.texture).sample(T3.screenUV).rgb;

    const proxyMaterial = new T3.MeshBasicNodeMaterial({
        transparent: true,
        depthWrite: false,
        depthTest: true,
        side: T3.BackSide,
        fog: false,
        premultipliedAlpha: false,
        blending: T3.CustomBlending,
        blendEquation: T3.AddEquation,
        blendSrc: T3.OneFactor,
        blendDst: T3.OneMinusSrcAlphaFactor,
        blendEquationAlpha: T3.AddEquation,
        blendSrcAlpha: T3.OneFactor,
        blendDstAlpha: T3.OneMinusSrcAlphaFactor,
    });
    // The source dome writes linear HDR into this target and the proxy is
    // tone-mapped once with the rest of the scene. Hardware linear sampling
    // already performs a four-texel reconstruction. The earlier five-sample
    // tent added four full-screen texture reads to every main pass; after the
    // correlated jitter hash was fixed it no longer removed any artifact and
    // consumed most of Performance's remaining 8.33 ms budget.
    proxyMaterial.toneMapped = true;
    const source = T3.texture(cloudTarget.texture);
    const center = source.sample(T3.screenUV);
    const current = center;
    proxyMaterial.colorNode = current.rgb;
    proxyMaterial.opacityNode = current.a;

    const proxyGeometry = new T3.SphereGeometry(30000, 24, 12);
    const backgroundProxy = new T3.Mesh(proxyGeometry, backgroundMaterial);
    backgroundProxy.name = 'current_frame_background_proxy';
    // This is a screen-space sky reconstruction shell, never local geometry.
    // Lazy weather activation traverses the completed scene, so explicitly
    // exclude the shell from per-fragment wetness/puddle wrapping.
    backgroundProxy.userData.noWet = true;
    backgroundProxy.renderOrder = -100;
    backgroundProxy.frustumCulled = false;
    const proxy = new T3.Mesh(proxyGeometry, proxyMaterial);
    proxy.name = 'current_frame_cloud_proxy';
    proxy.userData.noWet = true;
    proxy.renderOrder = -98;
    proxy.frustumCulled = false;

    const savedClearColor = new T3.Color();
    let backgroundDome = null;
    let cloudDome = null;
    let sky = null;
    let attachedScene = null;
    let originalBackgroundToneMapped = null;
    let originalCloudToneMapped = null;
    let disposed = false;

    return {
        proxy,
        backgroundProxy,
        mode: 'spatial-current-frame-sky',
        attach(scene, skyRef) {
            if (disposed) return false;
            // One pass owns one pair of domes. Refusing a second attachment
            // avoids orphaning the first pair in these private scenes.
            if (backgroundDome || cloudDome || attachedScene) return false;
            const nextBackgroundDome = skyRef?.domes?.[0] ?? null;
            const nextCloudDome = skyRef?.domes?.[1] ?? null;
            if (!nextBackgroundDome || !nextCloudDome) return false;
            backgroundDome = nextBackgroundDome;
            cloudDome = nextCloudDome;
            sky = skyRef;
            attachedScene = scene;
            // MeshBasicNodeMaterial normally tone-maps its output. Doing that
            // in this HDR target and again in the main scene made the high/2D
            // layer converge toward the same dull grey in optimized modes.
            originalBackgroundToneMapped = backgroundDome.material?.toneMapped;
            originalCloudToneMapped = cloudDome.material?.toneMapped;
            if (backgroundDome.material) {
                backgroundDome.material.toneMapped = false;
                backgroundDome.material.needsUpdate = true;
            }
            if (cloudDome.material) {
                cloudDome.material.toneMapped = false;
                cloudDome.material.needsUpdate = true;
            }
            backgroundScene.add(backgroundDome);
            cloudScene.add(cloudDome);
            scene.add(backgroundProxy, proxy);
            if (sky.uniforms?.frameJit) sky.uniforms.frameJit.value = 0;
            return true;
        },
        async compileAsync() {
            if(disposed||!sky)return;
            const state=T3.RendererUtils.saveRendererState(renderer),visible=cloudDome.visible;
            try{
                // A clear initial sky hides this mesh. It must nevertheless
                // compile before play, or the first cloudy preset pays for
                // the entire volume shader on the interaction thread.
                await sky.prepareOptimizedCaches?.(renderer,camera,true);
                cloudDome.visible=true;renderer.setMRT(null);
                renderer.setRenderTarget(backgroundTarget);
                await renderer.compileAsync(backgroundScene,camera);
                await renderer.renderAsync(backgroundScene,camera);
                renderer.setRenderTarget(cloudTarget);
                await renderer.compileAsync(cloudScene,camera);
                // compileAsync alone does not exercise every final render
                // context variant in the pinned renderer. Submit this exact
                // transparent pass and finish its GPU work before revealing
                // the scene, including when the initial preset is clear.
                await renderer.renderAsync(cloudScene,camera);
                await renderer.backend.device.queue.onSubmittedWorkDone();
            }finally{cloudDome.visible=visible;T3.RendererUtils.restoreRendererState(renderer,state);}
        },
        async render() {
            if (disposed || !backgroundDome || !cloudDome) return;
            await sky.prepareOptimizedCaches?.(renderer, camera);
            // The proxy only establishes draw order/depth. Its content is the
            // just-rendered current camera texture, so centering it avoids any
            // large-world geometry drift without introducing temporal state.
            backgroundProxy.position.copy(camera.position);
            proxy.position.copy(camera.position);
            if (sky.uniforms?.frameJit) sky.uniforms.frameJit.value = 0;
            const previousTarget = renderer.getRenderTarget();
            renderer.getClearColor(savedClearColor);
            const previousAlpha = renderer.getClearAlpha();
            try {
                renderer.setRenderTarget(backgroundTarget);
                renderer.setClearColor(0x000000, 1);
                await renderer.renderAsync(backgroundScene, camera);
                renderer.setRenderTarget(cloudTarget);
                renderer.setClearColor(0x000000, 0);
                await renderer.renderAsync(cloudScene, camera);
            } finally {
                renderer.setRenderTarget(previousTarget);
                renderer.setClearColor(savedClearColor, previousAlpha);
            }
        },
        resize() {
            if (!disposed) {
                backgroundTarget.setSize(width(), height());
                cloudTarget.setSize(width(), height());
            }
        },
        getDivisor() { return divisor; },
        setDivisor(next) {
            if (disposed) return false;
            const resolved = Math.max(1, Math.round(next));
            if (resolved === divisor) return false;
            divisor = resolved;
            backgroundTarget.setSize(width(), height());
            cloudTarget.setSize(width(), height());
            return true;
        },
        getResolution() { return { width: width(), height: height(), divisor }; },
        dispose() {
            if (disposed) return;
            disposed = true;
            backgroundScene.remove(backgroundDome);
            cloudScene.remove(cloudDome);
            if (backgroundDome?.material && originalBackgroundToneMapped !== null) {
                backgroundDome.material.toneMapped = originalBackgroundToneMapped;
                backgroundDome.material.needsUpdate = true;
            }
            if (cloudDome?.material && originalCloudToneMapped !== null) {
                cloudDome.material.toneMapped = originalCloudToneMapped;
                cloudDome.material.needsUpdate = true;
            }
            if (attachedScene) {
                // attach() reparents the real domes into private offscreen
                // scenes. Restore them before releasing the pass so disposing
                // this optimization independently cannot make the sky vanish.
                if (backgroundDome) attachedScene.add(backgroundDome);
                if (cloudDome) attachedScene.add(cloudDome);
                attachedScene.remove(backgroundProxy, proxy);
            }
            backgroundTarget.dispose();
            cloudTarget.dispose();
            proxyGeometry.dispose();
            backgroundMaterial.dispose();
            proxyMaterial.dispose();
            backgroundDome = null;
            cloudDome = null;
            sky = null;
            attachedScene = null;
        },
    };
}
