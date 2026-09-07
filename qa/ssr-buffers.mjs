import {connect} from './cdp.mjs';
import {writeFile} from 'node:fs/promises';
const cdp=await connect();
try{
    await cdp.evaluate(`(async()=>{_eanpaTest.pauseAfterFrame=true;while(!_eanpaTest.paused)await new Promise(r=>setTimeout(r,20));
        globalThis._qaOutput=_reflectionPipeline.pipeline.outputNode;})()`);
    for(const [name,expression] of [
        ['radiance','THREE.vec4(_reflectionPipeline.ssrNode.getTextureNode().rgb,1)'],
        ['coverage','THREE.vec4(THREE.vec3(_reflectionPipeline.ssrNode.getTextureNode().a),1)'],
    ]){
        await cdp.evaluate(`(async()=>{_reflectionPipeline.pipeline.outputNode=${expression};_reflectionPipeline.pipeline.needsUpdate=true;await _reflectionPipeline.render();})()`);
        const shot=await cdp.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
        await writeFile(`artifacts/overhaul/ssr-${name}.png`,Buffer.from(shot.data,'base64'));
    }
}finally{
    await cdp.evaluate('_reflectionPipeline.pipeline.outputNode=_qaOutput;_reflectionPipeline.pipeline.needsUpdate=true;delete globalThis._qaOutput;_eanpaTest.paused=false;').catch(()=>{});
    cdp.close();
}
