(() => ({
    ready: document.getElementById('boot').style.display === 'none',
    stage: globalThis._frameStage,
    pointerLocked: !!document.pointerLockElement,
    camera: globalThis._c?.position.toArray(),
    look: globalThis._look && { yaw: _look.yaw, pitch: _look.pitch },
    canvas: [document.getElementById('view').width, document.getElementById('view').height],
    controls: Object.fromEntries(['skybox','cloud-type','weather','quality','tod'].map(id => {
        const el = document.getElementById(id);
        return [id, { value: el.value, options: el.options && [...el.options].map(x => x.value) }];
    })),
    errors: [...document.body.children].find(e => e.style?.zIndex === '99')?.textContent,
    frames: globalThis._eanpaTest,
    cloudShadows: globalThis._cloudShadowStats,
    transition: globalThis._sky?.cloudTransitionInfo,
    weather: globalThis._weather?.diagnostics?.transition,
    rocks: globalThis._terrain?.rockCollisionPlacements?.length,
    collision: globalThis._vegetation?.diagnostics.collision.state,
    sunDir: globalThis._sky?.sunDir.toArray(),
    moonDir: globalThis._sky?.moonDir.toArray(),
    cloudLightDir: globalThis._sky?.uniforms.cloudLightDir.value.toArray(),
    cloudLightColor: globalThis._sky?.uniforms.cloudLightColor.value.toArray(),
    memory: globalThis._reflectionPipeline?.pipeline.renderer.info.memory,
}))()
