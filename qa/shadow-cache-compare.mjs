import { connect } from './cdp.mjs';
import { writeFile } from 'node:fs/promises';
const cdp=await connect();
try {
    await cdp.evaluate(`(async()=>{_eanpaTest.pauseAfterFrame=true;_eanpaTest.paused=false;
        while(!_eanpaTest.paused)await new Promise(r=>setTimeout(r,10));
        const r=_reflectionPipeline.pipeline.renderer;
        if(!String(r.renderObject).includes('getVariant'))throw new Error('Expected the installed shadow cache');
        globalThis.__qaShadowRenderObject=r.renderObject;
        r.renderObject=Object.getPrototypeOf(r).renderObject;
        await _reflectionPipeline.render();await _reflectionPipeline.render();})()`);
    const before=await cdp.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
    await writeFile('artifacts/overhaul/shadow-cache-before.png',Buffer.from(before.data,'base64'));
    await cdp.evaluate(`(async()=>{
        _reflectionPipeline.pipeline.renderer.renderObject=__qaShadowRenderObject;
        await _reflectionPipeline.render();await _reflectionPipeline.render();})()`);
    const after=await cdp.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
    await writeFile('artifacts/overhaul/shadow-cache-after.png',Buffer.from(after.data,'base64'));
    const result={identicalPNG:before.data===after.data,stats:await cdp.evaluate('_shadowMaterialCache.stats')};
    await writeFile('artifacts/overhaul/shadow-cache-compare.json',JSON.stringify(result,null,2));
    console.log(JSON.stringify(result));
}finally{await cdp.evaluate(`if(globalThis.__qaShadowRenderObject){
    _reflectionPipeline.pipeline.renderer.renderObject=__qaShadowRenderObject;delete globalThis.__qaShadowRenderObject;
}_eanpaTest.paused=false`).catch(()=>{});cdp.close();}
