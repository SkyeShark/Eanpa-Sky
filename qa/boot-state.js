({ boot: document.getElementById('boot').textContent, ready: document.getElementById('boot').style.display === 'none',
    stage: globalThis._frameStage, errors: [...document.body.children].find(e => e.style?.zIndex === '99')?.textContent,
    frames: globalThis._eanpaTest, weather: globalThis._weather?.diagnostics })
