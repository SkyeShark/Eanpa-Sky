(() => ({
    title: document.title,
    boot: document.getElementById('boot')?.textContent,
    ready: document.getElementById('boot')?.style.display === 'none',
    camera: globalThis._c?.position.toArray(),
    look: globalThis._look,
    renderer: { info: globalThis._r?.info?.render, gpu: globalThis._gpuLimits },
    stage: globalThis._frameStage,
    frames: globalThis._eanpaTest,
    quality: globalThis._skyQualityStats,
    reflection: globalThis._reflectionStats,
    errors: [...document.body.children].find(e => e.style?.zIndex === '99')?.textContent,
}))()
