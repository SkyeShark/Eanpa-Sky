import { connect } from './cdp.mjs';
import { mkdir, writeFile } from 'node:fs/promises';

const [name = 'current', requested = '120'] = process.argv.slice(2);
const frames = Number(requested);
if (!Number.isInteger(frames) || frames < 2 || frames > 600) throw new Error('Use 2–600 frames');
const cdp = await connect();
try {
    const result = await cdp.evaluate(`(async () => {
        _eanpaTest.paused=false;_eanpaTest.pauseAfterFrame=true;
        while(!_eanpaTest.paused) await new Promise(r=>setTimeout(r,10));
        const pipeline=_reflectionPipeline, device=pipeline.pipeline.renderer.backend.device;
        if(!device.features.has('timestamp-query')) throw new Error('GPU timestamps unavailable');
        const queries=device.createQuerySet({type:'timestamp',count:2048});
        const resolve=device.createBuffer({size:16384,usage:GPUBufferUsage.QUERY_RESOLVE|GPUBufferUsage.COPY_SRC});
        const read=device.createBuffer({size:16384,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
        const proto=GPUCommandEncoder.prototype;
        const originalRender=proto.beginRenderPass,originalCompute=proto.beginComputePass,originalPipeline=pipeline.render;
        const records=[];let index=0, labels=[],failure=null;
        function descriptor(input,kind) {
            if(index>=2048) throw new Error('GPU profile query capacity exceeded');
            const target=pipeline.pipeline.renderer.getRenderTarget();
            const targetName=target?.texture?.name|| (target ? target.width+'x'+target.height : 'screen');
            labels.push(kind+':'+targetName+(target?'#'+target.texture.id+'@'+target.width+'x'+target.height:'')+':'+globalThis._frameStage);
            const timestampWrites={querySet:queries,beginningOfPassWriteIndex:index++,endOfPassWriteIndex:index++};
            return {...input,timestampWrites};
        }
        // Copies leave Three's cached pass descriptors untouched. All hooks
        // exist only during this explicit QA run and are restored below.
        proto.beginRenderPass=function(d){return originalRender.call(this,descriptor(d,'render'));};
        proto.beginComputePass=function(d={}){return originalCompute.call(this,descriptor(d,'compute'));};
        pipeline.render=async function(...args){
            try {
                const result=await originalPipeline.apply(this,args);
                const count=index, names=labels;
                if(count){
                    const encoder=device.createCommandEncoder();
                    encoder.resolveQuerySet(queries,0,count,resolve,0);
                    encoder.copyBufferToBuffer(resolve,0,read,0,count*8);
                    device.queue.submit([encoder.finish()]);
                    await read.mapAsync(GPUMapMode.READ,0,count*8);
                    const ticks=new BigUint64Array(read.getMappedRange(0,count*8));
                    const passes=names.map((label,i)=>({label,ms:Number(ticks[i*2+1]-ticks[i*2])/1e6}));
                    records.push({ms:passes.reduce((sum,p)=>sum+p.ms,0),passes});
                    read.unmap();index=0;labels=[];
                }
                if(records.length>=${frames}) _eanpaTest.pauseAfterFrame=true;
                return result;
            }catch(e){failure=String(e);_eanpaTest.pauseAfterFrame=true;throw e;}
        };
        try {
            _eanpaTest.paused=false;
            const deadline=performance.now()+90000;
            while(!_eanpaTest.paused){
                if(performance.now()>deadline)throw new Error('GPU profile timed out');
                await new Promise(r=>setTimeout(r,20));
            }
            if(failure)throw new Error(failure);
            return {date:new Date().toISOString(),sky:document.getElementById('skybox').value,
                quality:document.getElementById('quality').value,clouds:document.getElementById('cloud-type').value,
                weather:document.getElementById('weather').value,records};
        }finally{
            proto.beginRenderPass=originalRender;proto.beginComputePass=originalCompute;pipeline.render=originalPipeline;
            if(read.mapState==='mapped')read.unmap();read.destroy();resolve.destroy();queries.destroy();
            _eanpaTest.paused=false;
        }
    })()`);
    const ordered = result.records.map(r=>r.ms).sort((a,b)=>a-b);
    result.timingSource = 'Sum of WebGPU begin/end timestamps across each application frame’s render and compute passes; excludes queue idle time. Readback overhead makes this separate from throughput benchmarks.';
    result.summary = {samples:ordered.length, meanMs:ordered.reduce((a,b)=>a+b,0)/ordered.length,
        medianMs:ordered[Math.ceil(ordered.length*.5)-1],p95Ms:ordered[Math.ceil(ordered.length*.95)-1],maxMs:ordered.at(-1)};
    await mkdir('artifacts/overhaul/benchmarks',{recursive:true});
    await writeFile(`artifacts/overhaul/benchmarks/${name}-gpu.json`,JSON.stringify(result,null,2));
    console.log(JSON.stringify(result.summary,null,2));
} finally { cdp.close(); }
