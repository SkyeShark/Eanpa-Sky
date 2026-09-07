import { connect } from './cdp.mjs';
import { writeFile } from 'node:fs/promises';
const cdp=await connect();
try {
    await cdp.evaluate(`(async()=>{
        _eanpaTest.paused=false;_eanpaTest.pauseAfterFrame=true;
        while(!_eanpaTest.paused)await new Promise(r=>setTimeout(r,20));
        await _reflectionPipeline.render();
    })()`);
    const before=await cdp.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
    await writeFile('artifacts/overhaul/rebuild-cache-before.png',Buffer.from(before.data,'base64'));
    const state=await cdp.evaluate(`(async()=>{
        const memoryBefore={..._reflectionPipeline.pipeline.renderer.info.memory};
        _rebuildResources.clear();
        await _reflectionPipeline.render();await _reflectionPipeline.render();
        return {memoryBefore,memoryAfter:_reflectionPipeline.pipeline.renderer.info.memory,stats:_rebuildResources.stats};
    })()`);
    const after=await cdp.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
    await writeFile('artifacts/overhaul/rebuild-cache-after.png',Buffer.from(after.data,'base64'));
    const result={...state,identicalPNG:before.data===after.data};
    await writeFile('artifacts/overhaul/rebuild-cache-compare.json',JSON.stringify(result,null,2));
    console.log(JSON.stringify(result));
    if(!result.identicalPNG)throw new Error('Draw-cache retirement changed the paused frame');
} finally {
    await cdp.evaluate('_eanpaTest.paused=false').catch(()=>{});cdp.close();
}
