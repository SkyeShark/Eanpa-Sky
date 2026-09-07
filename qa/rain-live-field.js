(async () => {
    _eanpaTest.paused = false; _eanpaTest.pauseAfterFrame = true;
    while (!_eanpaTest.paused) await new Promise(r => setTimeout(r, 10));
    const T = THREE, renderer = _reflectionPipeline.pipeline.renderer;
    const weather = __eanpaWeatherByScene.get(_c.parent);
    const field = weather.surfaceField;
    const p = _c.position;
    const samples = [new T.Vector3(p.x, p.y, p.z), new T.Vector3(p.x, p.y + 4, p.z - 8),
        new T.Vector3(p.x - 10, p.y + 4, p.z), new T.Vector3(p.x + 10, p.y + 4, p.z)];
    const data = T.uniformArray(samples, 'vec3');
    const sample = data.element(T.int(T.uv().x.mul(samples.length)));
    const mat = new T.MeshBasicNodeMaterial();
    mat.fragmentNode = T.vec4(field.impactAt(sample).xyz, field.visibilityAt(sample, T.float(0.025)));
    const quad = new T.QuadMesh(mat), target = new T.RenderTarget(samples.length, 1, { type: T.FloatType, depthBuffer: false });
    const state = T.RendererUtils.saveRendererState(renderer);
    try {
        renderer.setMRT(null); renderer.setRenderTarget(target); await quad.renderAsync(renderer);
        const read = await renderer.readRenderTargetPixelsAsync(target, 0, 0, samples.length, 1);
        return { samples: samples.map((s, i) => ({ position: s.toArray(), impactAndVisible: Array.from(read.slice(i * 4, i * 4 + 4)) })),
            stats: field.stats, rain: weather.diagnostics.precipitation };
    } finally { T.RendererUtils.restoreRendererState(renderer, state); mat.dispose(); target.dispose(); _eanpaTest.paused = false; }
})()
