import { connect } from './cdp.mjs';
import { writeFile, mkdir } from 'node:fs/promises';
const cdp = await connect();
const prefix = process.argv[2] ?? 'cloud-shadow';
let original,wasPaused;
try {
    wasPaused=await cdp.evaluate('_eanpaTest.paused');
    original = await cdp.evaluate(`(async () => {
        if(!_eanpaTest.paused){_eanpaTest.pauseAfterFrame=true;
            while(!_eanpaTest.paused)await new Promise(r=>setTimeout(r,20));}
        await _sky.prepareCloudShadows(_reflectionPipeline.pipeline.renderer,_c,{force:true});
        return _sky.uniforms.cloudShadowStrength.value;
    })()`);
    await mkdir('artifacts/overhaul/shadows', { recursive: true });
    for (const strength of [0, 1]) {
        await cdp.evaluate(`(async () => {
            _sky.uniforms.cloudShadowStrength.value=${strength};
            await new Promise(requestAnimationFrame);
            await _reflectionPipeline.render();
        })()`);
        const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
        await writeFile(`artifacts/overhaul/shadows/${prefix}-${strength}.png`, Buffer.from(shot.data, 'base64'));
    }
    const state = await cdp.evaluate(`({sky:document.getElementById('skybox').value,
        cloud:document.getElementById('cloud-type').value,hours:document.getElementById('tod').value,
        direction:_sky.uniforms.cloudLightDir.value.toArray(),color:_sky.uniforms.cloudLightColor.value.toArray(),
        camera:_c.position.toArray(),time:_sky.uniforms.time.value})`);
    await writeFile(`artifacts/overhaul/shadows/${prefix}.json`, JSON.stringify(state, null, 2));
    console.log(JSON.stringify(state));
} finally {
    if (original !== undefined) await cdp.evaluate(`_sky.uniforms.cloudShadowStrength.value=${original}`).catch(() => {});
    await cdp.evaluate(`_eanpaTest.paused=${!!wasPaused}`).catch(() => {});
    cdp.close();
}
