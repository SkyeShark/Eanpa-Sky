import{connect}from'./cdp.mjs';
import{mkdir,writeFile}from'node:fs/promises';
const c=await connect(),results=[];
try{
    await c.evaluate(`(async()=>{
        _eanpaTest.pauseAfterFrame=true;while(!_eanpaTest.paused)await new Promise(r=>setTimeout(r,10));
        const {makeStaticInstances}=await import('/src/static_instances.js');
        const parent=_temple.group,roots=parent.children.filter(o=>/^(front_wall|side_wall|rear_wall|front_pillar|rear_pillar|side_pillar|front_corner_watchtower|rear_corner_watchtower)/.test(o.name));
        globalThis.__instanceAudit=makeStaticInstances(THREE,parent,roots);
        _reflectionPipeline.registerObject(parent);
        await __eanpaWeatherByScene.get(_c.parent).prepareFrame(_reflectionPipeline.pipeline.renderer,_c,{force:true});
        await _reflectionPipeline.compileAsync();
    })()`);
    await mkdir('artifacts/feedback-20260908',{recursive:true});
    for(const enabled of [false,true,false]){
        const row=await c.evaluate(`(async()=>{
            __instanceAudit.setEnabled(${enabled});
            const r=_reflectionPipeline.pipeline.renderer,w=__eanpaWeatherByScene.get(_c.parent);
            _c.parent.traverse(o=>{if(o.isLight&&o.shadow)o.shadow.needsUpdate=true});
            await w.prepareFrame(r,_c,{force:true});_reflectionPipeline.localProbe.invalidate();
            _reflectionPipeline.invalidateHistory();
            for(let i=0;i<14;i++){await new Promise(requestAnimationFrame);await _reflectionPipeline.render()}
            const proto=GPURenderPassEncoder.prototype,restores=[],counts={draw:0,drawIndexed:0,drawIndirect:0,drawIndexedIndirect:0};
            for(const key of Object.keys(counts)){const original=proto[key];proto[key]=function(...args){counts[key]++;return original.apply(this,args)};restores.push(()=>proto[key]=original)}
            try{await new Promise(requestAnimationFrame);await _reflectionPipeline.render();await r.backend.device.queue.onSubmittedWorkDone();}
            finally{for(const restore of restores)restore()}
            return{enabled:${enabled},stats:__instanceAudit.stats,counts,camera:_c.position.toArray(),time:_sky.uniforms.time.value};
        })()`);
        const shot=await c.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
        await writeFile(`artifacts/feedback-20260908/instances-${results.length}-${enabled}.png`,Buffer.from(shot.data,'base64'));
        results.push(row);console.log(JSON.stringify(row));
    }
    await writeFile('artifacts/feedback-20260908/instances-comparison.json',JSON.stringify(results,null,2));
    await c.evaluate('__instanceAudit.setEnabled(true)');
}finally{c.close()}
