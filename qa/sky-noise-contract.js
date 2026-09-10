(async () => {
    const {makeAnalyticSkyNoise} = await import('/engine/sky_noise.js');
    const T = THREE, renderer = _reflectionPipeline.pipeline.renderer;
    _eanpaTest.pauseAfterFrame = true; _eanpaTest.paused = false;
    while (!_eanpaTest.paused) await new Promise(resolve => setTimeout(resolve, 20));
    const {noise3A, fbm3A} = makeAnalyticSkyNoise(T);
    // Frozen arithmetic from v0.2.0, intentionally inlined as it was there.
    const hash = p => {
        const q = T.fract(p.mul(0.3183099).add(T.vec3(0.1, 0.17, 0.13))).mul(17);
        return T.fract(q.x.mul(q.y).mul(q.z).mul(q.x.add(q.y).add(q.z)));
    };
    const referenceNoise = p => {
        const i = T.floor(p), f = T.fract(p);
        const sm = f.mul(f).mul(T.float(3).sub(f.mul(2)));
        const nx0 = T.mix(hash(i), hash(i.add(T.vec3(1, 0, 0))), sm.x);
        const nx1 = T.mix(hash(i.add(T.vec3(0, 1, 0))), hash(i.add(T.vec3(1, 1, 0))), sm.x);
        const nx2 = T.mix(hash(i.add(T.vec3(0, 0, 1))), hash(i.add(T.vec3(1, 0, 1))), sm.x);
        const nx3 = T.mix(hash(i.add(T.vec3(0, 1, 1))), hash(i.add(T.vec3(1, 1, 1))), sm.x);
        return T.mix(T.mix(nx0, nx1, sm.y), T.mix(nx2, nx3, sm.y), sm.z);
    };
    const rotate = p => T.vec3(T.dot(p, T.vec3(0, 0.8, 0.6)),
        T.dot(p, T.vec3(-0.8, 0.36, -0.48)), T.dot(p, T.vec3(-0.6, -0.48, 0.64)));
    const referenceFbm = p => {
        const pp = p.toVar(), f = referenceNoise(pp).mul(0.5).toVar();
        pp.assign(rotate(pp).mul(2.02)); f.addAssign(referenceNoise(pp).mul(0.25));
        pp.assign(rotate(pp).mul(2.03)); f.addAssign(referenceNoise(pp).mul(0.125));
        return f;
    };
    const width = 256, height = 128;
    const target = new T.RenderTarget(width, height, {type: T.FloatType, depthBuffer: false});
    const material = new T.MeshBasicNodeMaterial({fog: false, toneMapped: false});
    material.vertexNode = T.vec4(T.positionGeometry.xy, 0, 1);
    material.fragmentNode = T.Fn(() => {
        const x = T.screenCoordinate.x, y = T.screenCoordinate.y;
        const scale = T.exp2(T.floor(y.div(16)).sub(3));
        const p = T.vec3(x.sub(128).mul(1.371), y.sub(64).mul(2.019),
            T.fract(x.mul(.618).add(y.mul(.131))).sub(.5).mul(83)).mul(scale).toVar();
        return T.vec4(noise3A(p), referenceNoise(p), fbm3A(p), referenceFbm(p));
    })();
    const scene = new T.Scene(), camera = new T.OrthographicCamera(-1, 1, 1, -1, .1, 10);
    const geometry = new T.PlaneGeometry(2, 2), mesh = new T.Mesh(geometry, material);
    mesh.frustumCulled = false; scene.add(mesh);
    const state = T.RendererUtils.saveRendererState(renderer);
    try {
        renderer.setMRT(null); renderer.setRenderTarget(target);
        await renderer.compileAsync(scene, camera); renderer.render(scene, camera);
        const data = await renderer.readRenderTargetPixelsAsync(target, 0, 0, width, height);
        let maxNoiseError = 0, maxFbmError = 0, nonFinite = 0;
        for (let i = 0; i < data.length; i += 4) {
            if (![data[i], data[i+1], data[i+2], data[i+3]].every(Number.isFinite)) nonFinite++;
            maxNoiseError = Math.max(maxNoiseError, Math.abs(data[i] - data[i+1]));
            maxFbmError = Math.max(maxFbmError, Math.abs(data[i+2] - data[i+3]));
        }
        const result = {samples: width * height, maxNoiseError, maxFbmError, nonFinite,
            pass: nonFinite === 0 && maxNoiseError < 0.000002 && maxFbmError < 0.000002};
        if (!result.pass) throw Error(JSON.stringify(result));
        return result;
    } finally {
        T.RendererUtils.restoreRendererState(renderer, state);
        target.dispose(); material.dispose(); geometry.dispose();
    }
})();
