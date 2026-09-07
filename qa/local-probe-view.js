(async () => {
    if (globalThis.__localProbeTrial) throw new Error('Reload the owned page before repeating this isolated probe trial');
    const T = THREE, p = _reflectionPipeline, r = p.pipeline.renderer, scene = _c.parent;
    _eanpaTest.pauseAfterFrame = true; _eanpaTest.paused = false;
    while (!_eanpaTest.paused) await new Promise(resolve => setTimeout(resolve, 20));
    p.setAuditContributions();
    const cube = new T.CubeRenderTarget(256, {type:T.HalfFloatType});
    cube.texture.name = 'output';
    const camera = new T.CubeCamera(.15, 60000, cube);
    camera.position.set(0, 27.1, -72);
    const state = T.RendererUtils.saveRendererState(r);
    const hidden = [], shadows = [];
    const background = scene.background, context = r.contextNode;
    const hands = _c.getObjectByName('first_person_viewmodel_motion');
    if (hands?.visible) { hands.visible = false; hidden.push(hands); }
    scene.traverse(o => {
        if (o.isLight && o.shadow) {
            shadows.push([o.shadow,o.shadow.autoUpdate,o.shadow.needsUpdate]);
            o.shadow.autoUpdate=false; o.shadow.needsUpdate=false;
        }
        if (!o.visible || !o.material) return;
        const materials=Array.isArray(o.material)?o.material:[o.material];
        if (o.userData.ssrConvexGroup || materials.every(m=>m.depthWrite===false)) {
            o.visible=false; hidden.push(o);
        }
    });
    const generator = new T.PMREMGenerator(r);
    try {
        scene.background = _reflectionEnv;
        r.setMRT(T.mrt({output:T.output})); r.contextNode = T.context({eanpaReflectionSurfacePass:false});
        r.toneMapping = T.NoToneMapping; r.outputColorSpace = T.LinearSRGBColorSpace;
        camera.update(r, scene);
        const filtered=generator.fromCubemap(cube.texture);
        globalThis.__localProbeTrial={cube,camera,generator,filtered};
        const orb=scene.getObjectByName('authored_inanna_orb_pivot');
        orb.traverse(o=>{if(o.material){o.material.envMap=filtered.texture;o.material.needsUpdate=true}});
        p.invalidateHistory();
    } finally {
        scene.background=background; r.contextNode=context;
        for(const o of hidden)o.visible=true;
        for(const [shadow,auto,needs]of shadows){shadow.autoUpdate=auto;shadow.needsUpdate=needs;}
        T.RendererUtils.restoreRendererState(r,state);
    }
    _c.position.set(0,24.8,-67);_c.rotation.set(.14,0,0);_c.updateMatrixWorld(true);
    const orb=scene.getObjectByName('authored_inanna_orb_pivot');
    orb.rotation.y=-.7;orb.position.y=26.96;orb.updateMatrixWorld(true);
    for(let i=0;i<4;i++)await p.render();
    return {size:256,center:camera.position.toArray()};
})()
