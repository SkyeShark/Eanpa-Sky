(async () => {
    const pipeline = _reflectionPipeline;
    const renderer = pipeline.pipeline.renderer;
    _eanpaTest.pauseAfterFrame = true;
    while (!_eanpaTest.paused) await new Promise(r => setTimeout(r, 20));
    const target = pipeline.scenePass.renderTarget;
    const index = target.textures.indexOf(pipeline.scenePass.getTexture('normal'));
    const result = { target: [target.width,target.height], normalIndex:index,
        orb:[], renderer:!!renderer, targetType:target.textures[index].type };
    _temple.group.traverse(o => {
        if (/Sphere/.test(o.name)) result.orb.push({name:o.name,group:o.userData.ssrConvexGroup,
            transparent:o.material?.transparent,mrt:!!o.material?.mrtNode,
            nodeType:o.material?.type, normalOverride:!!o.material?.mrtNode?.outputNodes?.normal});
    });
    if (renderer) {
        const pixels = await renderer.readRenderTargetPixelsAsync(target, 700, 200, 1, 1, index, 0);
        result.sample = Array.from(pixels);
        result.decodedSample = pixels instanceof Uint16Array ? Array.from(pixels, THREE.DataUtils.fromHalfFloat) : Array.from(pixels);
    }
    _eanpaTest.paused = false;
    return result;
})()
