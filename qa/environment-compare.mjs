import { connect } from './cdp.mjs';
import { writeFile } from 'node:fs/promises';
const cdp=await connect();
try{
    await cdp.evaluate(`(async()=>{
        _eanpaTest.paused=false;_eanpaTest.pauseAfterFrame=true;
        while(!_eanpaTest.paused)await new Promise(r=>setTimeout(r,20));
        globalThis.__qaEnvSource=_reflectionEnv;
        const {makeReflectionEnvironment}=await import('/src/reflection_environment.js');
        globalThis.__qaEnvOwner=makeReflectionEnvironment(THREE,_reflectionPipeline.pipeline.renderer);
        await _reflectionPipeline.render();
    })()`);
    const before=await cdp.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
    await writeFile('artifacts/overhaul/environment-before.png',Buffer.from(before.data,'base64'));
    const state=await cdp.evaluate(`(async()=>{
        const source=__qaEnvSource;
        if(source.isPMREMTexture)throw new Error('Comparison needs the original automatic environment path');
        const next=__qaEnvOwner.update(source);
        _reflectionPipeline.setEnvironment(next);
        await _reflectionPipeline.render();await _reflectionPipeline.render();
        return {sourceSize:[source.image.width,source.image.height],outputSize:[next.image.width,next.image.height],stats:__qaEnvOwner.stats};
    })()`);
    const after=await cdp.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
    await writeFile('artifacts/overhaul/environment-after.png',Buffer.from(after.data,'base64'));
    const result={...state,identicalPNG:before.data===after.data};
    await writeFile('artifacts/overhaul/environment-compare.json',JSON.stringify(result,null,2));
    console.log(JSON.stringify(result));
}finally{
    await cdp.evaluate(`if(globalThis.__qaEnvSource)_reflectionPipeline.setEnvironment(__qaEnvSource);
        globalThis.__qaEnvOwner?.dispose();delete globalThis.__qaEnvOwner;delete globalThis.__qaEnvSource;
        _eanpaTest.paused=false;`).catch(()=>{});
    cdp.close();
}
