// Count submission work separately from throughput: these diagnostic hooks
// intentionally add CPU overhead and their FPS is not a benchmark result.
import {connect} from './cdp.mjs';
import {mkdir,writeFile} from 'node:fs/promises';
const [name='current',seconds='3']=process.argv.slice(2);
if(!/^[a-z0-9_-]+$/i.test(name)||!(Number(seconds)>=1&&Number(seconds)<=15))throw new Error('Invalid capture arguments');
const c=await connect();
try{
    const result=await c.evaluate(`(async()=>{
        if(_eanpaTest.paused||(!globalThis.__skyFixture?.ready&&document.getElementById('boot')?.style.display!=='none'))throw new Error('Resume a ready scene before counting');
        const renderer=_reflectionPipeline.pipeline.renderer,nodes=renderer._nodes,queue=renderer.backend.device.queue;
        const originalGroup=nodes.updateGroup,originalWrite=queue.writeBuffer;
        const groups={};let writes=0,bytes=0;
        nodes.updateGroup=function(binding){
            const changed=originalGroup.call(this,binding);
            if(binding.isUniformsGroup){
                const key=binding.name+':'+binding.buffer.byteLength;
                const data=groups[key]??={checks:0,updates:0,uniformsCompared:0};data.checks++;
                if(changed){data.updates++;data.uniformsCompared+=binding.uniforms.length;}
            }
            return changed;
        };
        queue.writeBuffer=function(buffer,offset,data,start=0,size){
            writes++;const elementBytes=data.BYTES_PER_ELEMENT??1;
            bytes+=size===undefined?data.byteLength-start*elementBytes:size*elementBytes;
            return originalWrite.apply(this,arguments);
        };
        const start=performance.now(),frame=_eanpaTest.completedFrames;
        try{
            await new Promise(done=>setTimeout(done,${Number(seconds)*1000}));
            return {date:new Date().toISOString(),frames:_eanpaTest.completedFrames-frame,ms:performance.now()-start,
                writes,bytes,groups,lastRenderInfo:{...renderer.info.render},
                sky:document.getElementById('skybox')?.value??__skyFixture?.kind,
                errors:[...document.body.children].find(e=>e.style?.zIndex==='99')?.textContent??''};
        }finally{nodes.updateGroup=originalGroup;queue.writeBuffer=originalWrite;}
    })()`);
    result.interpretation='Instrumented operation counts, not throughput; all browser hooks restored after capture.';
    await mkdir('artifacts/cpu-optimization-20260910',{recursive:true});
    await writeFile(`artifacts/cpu-optimization-20260910/${name}-counters.json`,JSON.stringify(result,null,2));
    console.log(JSON.stringify({frames:result.frames,writesPerFrame:result.writes/result.frames,
        uniformsComparedPerFrame:Object.values(result.groups).reduce((sum,g)=>sum+g.uniformsCompared,0)/result.frames,
        groups:Object.entries(result.groups).sort((a,b)=>b[1].uniformsCompared-a[1].uniformsCompared).slice(0,10),errors:result.errors},null,2));
}finally{c.close();}
