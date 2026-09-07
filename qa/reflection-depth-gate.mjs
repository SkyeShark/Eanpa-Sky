import {connect} from './cdp.mjs';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const c=await connect(),run=promisify(execFile),records=[];
await mkdir('artifacts/overhaul/depth-gate',{recursive:true});
try{
    for(const view of ['wide','roof','orb']){
        await run(process.execPath,['qa/review-view.mjs','gate-'+view,'cumulus','rain','10.5',view==='orb'?'roof':view],{windowsHide:true});
        if(view==='orb')await c.evaluate(await readFile('qa/reflection-failure-view.js','utf8'));
        await c.evaluate(`(async()=>{
            const r=_reflectionPipeline.pipeline.renderer,w=__eanpaWeatherByScene.get(_c.parent);
            w.uniforms.wetness.value=w.uniforms.wetTarget.value;
            w.uniforms.surfaceWater.value=Math.pow(w.uniforms.wetTarget.value,1.8);
            _sky.update(_sky.uniforms.time.value,_c);await _spatialClouds.render();
            await w.prepareFrame(r,_c,{force:true});await _sky.prepareCloudShadows(r,_c,true);
            _reflectionPipeline.setAuditContributions();
            for(let i=0;i<14;i++){await new Promise(requestAnimationFrame);await _reflectionPipeline.render();}
            // Freeze the same history and probe for both images. The trace
            // still runs, sampling the production radiance captured above.
            _reflectionPipeline.setAuditContributions({probe:false});
        })()`);
        for(const gate of [0,1]){
            await c.evaluate(`(async()=>{_reflectionPipeline.setSsrParams({coarseDepthGate:${gate}});
                await new Promise(requestAnimationFrame);await _reflectionPipeline.render();})()`);
            const shot=await c.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
            await writeFile(`artifacts/overhaul/depth-gate/${view}-${gate}.png`,Buffer.from(shot.data,'base64'));
        }
        records.push(await c.evaluate(`({view:${JSON.stringify(view)},camera:_c.position.toArray(),
            time:_sky.uniforms.time.value,historyValid:!!_reflectionPipeline.history,
            errors:[...document.body.children].filter(e=>e.style?.zIndex==='99').map(e=>e.textContent).filter(Boolean)})`));
    }
    await writeFile('artifacts/overhaul/depth-gate/captures.json',JSON.stringify(records,null,2));
    console.log(JSON.stringify(records));
}finally{
    await c.evaluate('_reflectionPipeline.setSsrParams({coarseDepthGate:1});_reflectionPipeline.setAuditContributions()').catch(()=>{});
    c.close();
}
