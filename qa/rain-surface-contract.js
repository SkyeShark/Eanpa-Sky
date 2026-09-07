(async () => {
    const wasPaused=_eanpaTest.paused;
    _eanpaTest.paused = false;
    _eanpaTest.pauseAfterFrame = true;
    while (!_eanpaTest.paused) await new Promise(r => setTimeout(r, 10));
    const T = globalThis.THREE;
    const renderer = _reflectionPipeline.pipeline.renderer;
    const { makeRainSurfaceField } = await import('/engine/rain_surface_field.js');
    const scene = new T.Scene();
    const resources = [];
    const material = new T.MeshStandardMaterial({ color: 0x806850 });
    resources.push(material);
    const mesh = (geometry, x, y, z, mat = material) => {
        const object = new T.Mesh(geometry, mat);
        object.position.set(x, y, z); scene.add(object); resources.push(geometry);
        return object;
    };
    mesh(new T.BoxGeometry(80, 0.2, 50), 0, -0.1, 0);
    const roof = mesh(new T.BoxGeometry(8, 0.2, 8), -18, 3.9, 0);
    const ramp = mesh(new T.PlaneGeometry(8, 8), -6, 2, 0);
    ramp.rotation.set(-Math.PI / 2, Math.PI / 8, 0);
    const instanceGeo = new T.BoxGeometry(6, 0.2, 6);
    resources.push(instanceGeo);
    const instances = new T.InstancedMesh(instanceGeo, material, 1);
    instances.setMatrixAt(0, new T.Matrix4().makeTranslation(6, 4.9, 0));
    scene.add(instances);
    const raisedMat = new T.MeshStandardNodeMaterial();
    raisedMat.positionNode = T.positionLocal.add(T.vec3(0, 3, 0));
    resources.push(raisedMat);
    const raised = mesh(new T.BoxGeometry(6, 0.2, 6), 18, 0.9, 0, raisedMat);
    const cutoutMat = new T.MeshStandardNodeMaterial({ alphaTest: 0.5, side: T.DoubleSide });
    cutoutMat.colorNode = T.vec4(1, 1, 1, T.uv().x.greaterThan(0.5).select(1, 0));
    resources.push(cutoutMat);
    const cutout = mesh(new T.PlaneGeometry(8, 8), 0, 6, 14, cutoutMat);
    cutout.rotation.x = -Math.PI / 2;
    const skinGeometry = new T.BoxGeometry(6, 0.2, 6);
    const vertexCount = skinGeometry.attributes.position.count;
    skinGeometry.setAttribute('skinIndex', new T.Uint16BufferAttribute(new Uint16Array(vertexCount * 4), 4));
    const weights = new Float32Array(vertexCount * 4);
    for (let i = 0; i < vertexCount; i++) weights[i * 4] = 1;
    skinGeometry.setAttribute('skinWeight', new T.Float32BufferAttribute(weights, 4));
    resources.push(skinGeometry);
    const skinned = new T.SkinnedMesh(skinGeometry, material);
    skinned.position.set(-12, 0.9, 14);
    const bone = new T.Bone(); skinned.add(bone); scene.add(skinned);
    skinned.bind(new T.Skeleton([bone])); bone.position.y = 3;
    const view = new T.PerspectiveCamera(60, 1, 0.1, 100);
    view.position.set(0, 3, 0);
    const field = makeRainSurfaceField(T, scene, { resolution: 512, radius: 48, verticalSpan: 256 });
    const cases = [
        { name: 'open ground', p: [30, 0.08, 0], height: 0, exposure: 1 },
        { name: 'roof top', p: [-18, 4.08, 0], height: 4, exposure: 1 },
        { name: 'sheltered floor', p: [-18, 0.08, 0], height: 4, exposure: 0 },
        { name: 'tilted mesh', p: [-6, 2.12, 0], height: 2, exposure: 1 },
        { name: 'instanced roof', p: [6, 5.08, 0], height: 5, exposure: 1 },
        { name: 'under instanced roof', p: [6, 0.08, 0], height: 5, exposure: 0 },
        { name: 'vertex-deformed roof', p: [18, 4.08, 0], height: 4, exposure: 1 },
        { name: 'under deformed roof', p: [18, 0.08, 0], height: 4, exposure: 0 },
        { name: 'cutout opening', p: [-2, 0.08, 14], height: 0, exposure: 1 },
        { name: 'cutout solid half', p: [2, 0.08, 14], height: 6, exposure: 0 },
        { name: 'downwind open floor', p: [-13, 0.08, 0], height: 0, exposure: 1 },
        { name: 'upwind roof edge', p: [-21.5, 0.08, 0], height: 4, exposure: 0 },
        { name: 'skinned roof', p: [-12, 4.08, 14], height: 4, exposure: 1 },
        { name: 'under skinned roof', p: [-12, 0.08, 14], height: 4, exposure: 0 },
    ];
    const samples = T.uniformArray(cases.map(c => new T.Vector3(...c.p)), 'vec3');
    const sample = samples.element(T.int(T.uv().x.mul(cases.length)));
    const output = new T.RenderTarget(cases.length, 1, { type: T.FloatType, depthBuffer: false });
    const probeMat = new T.MeshBasicNodeMaterial();
    probeMat.fragmentNode = T.vec4(field.impactAt(sample).xyz, field.visibilityAt(sample, T.float(0.06)));
    const normalMat = new T.MeshBasicNodeMaterial();
    normalMat.fragmentNode = T.vec4(field.normalAt(sample), field.impactAt(sample).w);
    const quad = new T.QuadMesh(probeMat);
    const rendererState = T.RendererUtils.saveRendererState(renderer);
    try {
        await field.prepareFrame(renderer, view, { force: true });
        renderer.setMRT(null); renderer.setRenderTarget(output);
        await quad.renderAsync(renderer);
        const hits = await renderer.readRenderTargetPixelsAsync(output, 0, 0, cases.length, 1);
        quad.material = normalMat;
        await quad.renderAsync(renderer);
        const normals = await renderer.readRenderTargetPixelsAsync(output, 0, 0, cases.length, 1);
        const results = cases.map((c, i) => {
            const hit = Array.from(hits.slice(i * 4, i * 4 + 4));
            const normal = Array.from(normals.slice(i * 4, i * 4 + 4));
            return { ...c, hit, normal, pass: hit.every(Number.isFinite)
                && Math.abs(hit[1] - c.height) < 0.15 && Math.abs(hit[3] - c.exposure) < 0.01
                && normal[3] === 1 && Math.abs(Math.hypot(...normal.slice(0, 3)) - 1) < 0.02 };
        });
        const restored = roof.material === material && instances.material === material
            && raised.material === raisedMat && cutout.material === cutoutMat;
        await field.prepareFrame(renderer, view, { force: true, wind: { x: 4, z: 0 }, fallSpeed: 9 });
        renderer.setRenderTarget(output); quad.material = probeMat;
        await quad.renderAsync(renderer);
        const windHits = await renderer.readRenderTargetPixelsAsync(output, 0, 0, cases.length, 1);
        const wind = [
            { name: 'roof stops downwind rain beyond vertical footprint', index: 10, height: 4, exposure: 0 },
            { name: 'upwind edge admits slanted rain', index: 11, height: 0, exposure: 1 },
        ].map(c => {
            const hit = Array.from(windHits.slice(c.index * 4, c.index * 4 + 4));
            return { ...c, hit, pass: Math.abs(hit[1] - c.height) < 0.15 && hit[3] === c.exposure };
        });
        // A failed host render must leave no temporary material/visibility
        // state on persistent scene objects or on the shared renderer.
        const originalRender = renderer.renderAsync;
        let failureRestored = false;
        try {
            renderer.renderAsync = async () => { throw new Error('injected capture failure'); };
            await field.prepareFrame(renderer, view, { force: true });
        } catch (error) {
            failureRestored = error.message === 'injected capture failure'
                && roof.material === material && cutout.material === cutoutMat
                && renderer.getRenderTarget() === output;
        } finally { renderer.renderAsync = originalRender; }
        const cachedBefore = field.stats.captureMaterials;
        raisedMat.dispose();
        const releasedSource = field.stats.captureMaterials === cachedBefore - 1;
        field.invalidate();
        await field.prepareFrame(renderer, view, { force: true });
        const rebuiltSource = field.stats.captureMaterials === cachedBefore;
        return { pass: restored && failureRestored && releasedSource && rebuiltSource
                && results.every(r => r.pass) && wind.every(r => r.pass),
            restored, failureRestored, releasedSource, rebuiltSource, results, wind, stats: { ...field.stats } };
    } finally {
        T.RendererUtils.restoreRendererState(renderer, rendererState);
        field.dispose(); output.dispose(); probeMat.dispose(); normalMat.dispose();
        instances.dispose();
        skinned.skeleton.dispose();
        for (const resource of resources) resource.dispose();
        _eanpaTest.paused = wasPaused;
    }
})()
