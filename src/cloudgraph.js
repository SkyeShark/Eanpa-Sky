// EANPA realtime cloud frame graph:
//   cloud march (low-res, blue-noise jittered, few passes)
//     -> temporal accumulation (EMA, direction-reprojected history)
//     -> composite proxy dome in the main scene (screen-space sample)
// The march itself is untouched engine code — noise is integrated over
// TIME by the history buffer instead of appearing as dither on screen.
export function makeCloudGraph(THREE, renderer, camera, opts = {}) {
    const T3 = THREE;
    const DIV = opts.div ?? 2;
    // stage taps: ?cg=raw (march target, no TAA) | ?cg=reproj (direction reprojection)
    const CG_DBG = new URLSearchParams(location.search).get('cg') || '';

    // ---- blue-noise tile (boot-time void-and-cluster-lite) ----
    const BN = 64;
    const bnData = new Uint8Array(BN * BN * 4);
    {
        const taken = [];
        const score = (x, y) => {
            let s = 0;
            for (const p of taken) {
                let dx = Math.abs(x - p.x); dx = Math.min(dx, BN - dx);
                let dy = Math.abs(y - p.y); dy = Math.min(dy, BN - dy);
                s += 1 / (1 + dx * dx + dy * dy);
            }
            return s;
        };
        let seed = 7;
        const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
        const total = BN * BN;
        for (let r = 0; r < total; r++) {
            let best = null, bestS = Infinity;
            for (let c = 0; c < 10; c++) {
                const x = (rnd() * BN) | 0, y = (rnd() * BN) | 0;
                if (bnData[(y * BN + x) * 4 + 3]) continue;
                const s = score(x, y);
                if (s < bestS) { bestS = s; best = { x, y }; }
            }
            if (!best) { for (let i = 0; i < total; i++) if (!bnData[i * 4 + 3]) { best = { x: i % BN, y: (i / BN) | 0 }; break; } }
            const v = Math.round((r / total) * 255);
            const o = (best.y * BN + best.x) * 4;
            bnData[o] = v; bnData[o + 1] = v; bnData[o + 2] = v; bnData[o + 3] = 255;
            taken.push(best);
            if (taken.length > 220) taken.shift();   // local repulsion window
        }
    }
    const bnTex = new T3.DataTexture(bnData, BN, BN, T3.RGBAFormat);
    bnTex.needsUpdate = true;
    bnTex.wrapS = bnTex.wrapT = T3.RepeatWrapping;
    bnTex.minFilter = bnTex.magFilter = T3.NearestFilter;

    // ---- targets ----
    const W = () => Math.ceil(innerWidth / DIV), H = () => Math.ceil(innerHeight / DIV);
    const mkRT = () => new T3.RenderTarget(W(), H(), {
        depthBuffer: false, type: T3.HalfFloatType,
        minFilter: T3.LinearFilter, magFilter: T3.LinearFilter,
    });
    const cloudRT = mkRT();
    let histA = mkRT(), histB = mkRT();

    // ---- cloud scene: the dome mesh gets moved here by attach() ----
    const cloudScene = new T3.Scene();

    // ---- temporal pass: fullscreen blend with direction reprojection ----
    const { vec2, vec3, vec4, float, uniform, texture, uv, clamp, mix, max, min, abs, normalize } = T3;
    const uPrevVP = uniform(new T3.Matrix4());
    const uCurInvVP = uniform(new T3.Matrix4());
    const uAlpha = uniform(0.12);
    const uCur = texture(cloudRT.texture);
    const taaScene = new T3.Scene();
    const taaCam = new T3.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    // TWO fixed-binding materials (read-A / read-B), alternated per frame:
    // swapping one texture node's value across ping-pong targets can leave a
    // cached bind group READING THE TARGET BEING WRITTEN — a read-write
    // hazard that renders as standing kaleidoscope garbage
    const mkTaaMat = (histTex) => {
        const m = new T3.MeshBasicNodeMaterial({ depthWrite: false, depthTest: false });
        const uH = texture(histTex);
        const suv = uv();
        // current pixel -> NDC -> world direction (far plane) -> previous
        // frame's screen uv. The dome is camera-centered: direction-only
        // reprojection is exact under rotation (the demo's dominant motion).
        const ndc = vec4(suv.x.mul(2).sub(1), suv.y.mul(2).sub(1), float(1), float(1));
        const wp = uCurInvVP.mul(ndc);
        const dirW = normalize(wp.xyz.div(wp.w));
        const pp = uPrevVP.mul(vec4(dirW, 0));   // w=0: direction, translation-free
        const puv = pp.xy.div(pp.w).mul(0.5).add(0.5);
        const inBounds = puv.x.greaterThan(0).and(puv.x.lessThan(1)).and(puv.y.greaterThan(0)).and(puv.y.lessThan(1)).and(pp.w.greaterThan(0));
        // v1 DEFAULT: identity history sampling — cannot mirror or smear
        // structurally; motion-weighted alpha handles pans. The direction
        // reprojection (still imperfect) stays behind ?cg=reproj.
        const cur = uCur.sample(suv);
        const hist = uH.sample(CG_DBG === 'reproj' ? puv : suv);
        const a = CG_DBG === 'raw' ? float(1)
            : CG_DBG === 'reproj' ? T3.select(inBounds, uAlpha, float(1))
            : uAlpha;
        // RAW vec4 write: colorNode drops alpha through a Basic material's
        // opacity pipeline — the history needs the coverage channel intact
        m.outputNode = mix(hist, cur, a);
        m.blending = T3.NoBlending;
        return m;
    };
    const taaMatA = mkTaaMat(histA.texture);   // reads A — used when writing B
    const taaMatB = mkTaaMat(histB.texture);   // reads B — used when writing A
    const taaGeo = new T3.PlaneGeometry(2, 2);
    const taaQuad = new T3.Mesh(taaGeo, taaMatA);
    taaScene.add(taaQuad);

    // ---- composite proxy: cheap dome shown in the MAIN scene ----
    // Keep both history textures in fixed material bindings here too. Texture
    // node value swaps can retain a cached bind group, which would make the
    // proxy display only every other completed history target.
    const mkProxyMat = (histTex) => {
        const m = new T3.MeshBasicNodeMaterial({
            transparent: true, depthWrite: false, side: T3.BackSide, fog: false,
            // History already stores premultiplied RGB. Keep NodeMaterial
            // from multiplying it by alpha again, and select the matching
            // blend factors explicitly.
            premultipliedAlpha: false,
            blending: T3.CustomBlending,
            blendEquation: T3.AddEquation,
            blendSrc: T3.OneFactor,
            blendDst: T3.OneMinusSrcAlphaFactor,
            blendEquationAlpha: T3.AddEquation,
            blendSrcAlpha: T3.OneFactor,
            blendDstAlpha: T3.OneMinusSrcAlphaFactor,
        });
        const suv = T3.screenUV;
        const s = texture(histTex).sample(suv);
        m.colorNode = s.rgb;
        m.opacityNode = s.a;
        return m;
    };
    const proxyMatA = mkProxyMat(histA.texture);
    const proxyMatB = mkProxyMat(histB.texture);
    const proxyGeo = new T3.SphereGeometry(30000, 24, 12);
    const proxy = new T3.Mesh(proxyGeo, proxyMatB);
    proxy.renderOrder = -98;
    proxy.frustumCulled = false;

    const prevVP = new T3.Matrix4();
    const curVP = new T3.Matrix4();
    const prevQ = new T3.Quaternion();
    const prevPos = new T3.Vector3();
    const frameQ = new T3.Quaternion();
    const framePos = new T3.Vector3();
    const savedClearColor = new T3.Color();
    let prevFov = camera.fov;
    let historyValid = false;
    let disposed = false;
    let frame = 0, dome = null, sky = null, attachedScene = null;

    return {
        proxy,
        bnTex,
        attach(scene, skyRef) {
            if (disposed) return false;
            sky = skyRef;
            attachedScene = scene;
            dome = skyRef.domes?.[1] ?? null;   // [bgDome, cloudDome]
            if (!dome) return false;
            cloudScene.add(dome);
            scene.add(proxy);
            historyValid = false;
            if (sky.uniforms?.frameJit) sky.uniforms.frameJit.value = 0;
            return true;
        },
        async render() {
            if (!dome || disposed) return;
            // Optional optimized light volume. This compute submission is
            // serialized immediately before the cloud pass; timers only mark
            // cache state dirty and never submit GPU work on their own.
            await sky.prepareOptimizedCaches?.(renderer, camera);
            frame++;
            // per-frame golden-ratio jitter phase for the march's blue noise
            if (sky.uniforms?.frameJit) sky.uniforms.frameJit.value = (frame * 0.6180339887) % 1;
            // Motion-weighted history rejection. Rotation dominated the old
            // path, but same-UV history also becomes invalid under camera
            // translation and projection/FOV changes. A new or resized graph
            // always trusts the current frame completely.
            frameQ.copy(camera.quaternion);
            framePos.copy(camera.position);
            const frameFov = camera.fov;
            if (!historyValid) {
                uAlpha.value = 1;
            } else {
                const rot = frameQ.angleTo(prevQ);
                const move = framePos.distanceTo(prevPos);
                const fovDelta = Math.abs(frameFov - prevFov);
                const rotAlpha = rot < 1e-5 ? 0.06 : Math.min(0.95, 0.10 + rot * 80);
                const moveAlpha = move < 1e-5 ? 0.06 : Math.min(1, 0.10 + move * 0.12);
                const fovAlpha = fovDelta < 1e-5 ? 0.06 : 1;
                uAlpha.value = Math.max(rotAlpha, moveAlpha, fovAlpha);
            }

            camera.updateMatrixWorld();
            // matrixWorldInverse only refreshes during a render — computing
            // it here keeps curVP aligned with THIS frame's cloud pass
            // (stale inverse = one-frame reprojection offset = ghost doubles)
            camera.matrixWorldInverse.copy(camera.matrixWorld).invert();
            curVP.copy(camera.projectionMatrix).multiply(camera.matrixWorldInverse);
            uCurInvVP.value.copy(curVP).invert();
            uPrevVP.value.copy(prevVP);

            const rt0 = renderer.getRenderTarget();
            renderer.getClearColor(savedClearColor);
            const clearAlpha0 = renderer.getClearAlpha();
            const writeA = (frame & 1) !== 0;
            const writeRT = writeA ? histA : histB;
            try {
                renderer.setRenderTarget(cloudRT);
                renderer.setClearColor(0x000000, 0);
                await renderer.renderAsync(cloudScene, camera);
                // fixed-binding ping-pong: odd frames read B / write A, even
                // frames read A / write B — no texture binding ever changes
                taaQuad.material = writeA ? taaMatB : taaMatA;
                renderer.setRenderTarget(writeRT);
                await renderer.renderAsync(taaScene, taaCam);
            } catch (e) {
                // Either target may contain a partial frame after a rejected
                // submit. Force a current-only write before history is reused.
                historyValid = false;
                throw e;
            } finally {
                renderer.setRenderTarget(rt0);
                renderer.setClearColor(savedClearColor, clearAlpha0);
            }

            proxy.material = writeA ? proxyMatA : proxyMatB;
            prevVP.copy(curVP);
            prevQ.copy(frameQ);
            prevPos.copy(framePos);
            prevFov = frameFov;
            historyValid = true;
        },
        resize() {
            if (disposed) return;
            cloudRT.setSize(W(), H());
            histA.setSize(W(), H());
            histB.setSize(W(), H());
            historyValid = false;
        },
        invalidate() {
            historyValid = false;
        },
        dispose() {
            if (disposed) return;
            disposed = true;
            if (dome && sky) cloudScene.remove(dome);
            attachedScene?.remove(proxy);
            taaScene.remove(taaQuad);
            cloudRT.dispose(); histA.dispose(); histB.dispose();
            bnTex.dispose();
            taaMatA.dispose(); taaMatB.dispose();
            proxyMatA.dispose(); proxyMatB.dispose();
            taaGeo.dispose(); proxyGeo.dispose();
            proxy.material = null;
            dome = null; sky = null; attachedScene = null;
            historyValid = false;
        },
    };
}
