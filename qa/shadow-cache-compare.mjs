import { connect } from './cdp.mjs';
import { writeFile } from 'node:fs/promises';
const cdp=await connect();
try {
    await cdp.evaluate(`(async()=>{_eanpaTest.pauseAfterFrame=true;_eanpaTest.paused=false;
        while(!_eanpaTest.paused)await new Promise(r=>setTimeout(r,10));})()`);
    const before=await cdp.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
    await writeFile('artifacts/overhaul/shadow-cache-before.png',Buffer.from(before.data,'base64'));
    await cdp.evaluate(`(async()=>{const {installShadowMaterialCache}=await import('/src/shadow_material_cache.js');
        globalThis._shadowMaterialCache=installShadowMaterialCache(_reflectionPipeline.pipeline.renderer);
        await _reflectionPipeline.render();await _reflectionPipeline.render();})()`);
    const after=await cdp.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
    await writeFile('artifacts/overhaul/shadow-cache-after.png',Buffer.from(after.data,'base64'));
    console.log(JSON.stringify({identicalPNG:before.data===after.data,stats:await cdp.evaluate('_shadowMaterialCache.stats')}));
}finally{await cdp.evaluate('_eanpaTest.paused=false').catch(()=>{});cdp.close();}
