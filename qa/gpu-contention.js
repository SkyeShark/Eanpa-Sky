// Synthetic GPU competition in the one owned page. This reserves GPU time;
// it does not emulate another architecture, VRAM capacity or driver.
(async()=>{
    if(globalThis.__gpuContention)throw new Error('GPU contention already installed');
    const wasPaused=_eanpaTest.paused,resources=[];
    let installed=false;
    const own=resource=>{resources.push(resource);return resource;};
    const release=()=>{for(const resource of resources.splice(0))resource.destroy();};
    try{
    _eanpaTest.pauseAfterFrame=true;_eanpaTest.paused=false;
    while(!_eanpaTest.paused)await new Promise(r=>setTimeout(r,20));
    const device=_reflectionPipeline.pipeline.renderer.backend.device;
    if(!device.features.has('timestamp-query'))throw new Error('GPU timestamps are required for calibration');
    const input=own(device.createBuffer({size:16*1024*1024,usage:GPUBufferUsage.STORAGE,mappedAtCreation:true}));
    const data=new Uint32Array(input.getMappedRange());let seed=50906;
    for(let i=0;i<data.length;i++){seed=(Math.imul(seed,1664525)+1013904223)>>>0;data[i]=seed}input.unmap();
    const output=own(device.createBuffer({size:1024*256*4,usage:GPUBufferUsage.STORAGE}));
    const params=own(device.createBuffer({size:16,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST}));
    const query=own(device.createQuerySet({type:'timestamp',count:2}));
    const resolve=own(device.createBuffer({size:256,usage:GPUBufferUsage.QUERY_RESOLVE|GPUBufferUsage.COPY_SRC}));
    const read=own(device.createBuffer({size:16,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ}));
    const shader=device.createShaderModule({code:`
        @group(0) @binding(0) var<storage,read> source:array<u32>;
        @group(0) @binding(1) var<storage,read_write> result:array<u32>;
        @group(0) @binding(2) var<uniform> parameters:vec4<u32>;
        @compute @workgroup_size(256) fn main(@builtin(global_invocation_id) id:vec3<u32>){
            var value=id.x*747796405u+2891336453u;
            for(var i=0u;i<parameters.x;i++){
                value=source[(value^(value>>16u))&4194303u]*277803737u+2891336453u;
            }
            result[id.x]=value;
        }`});
    const pipeline=await device.createComputePipelineAsync({layout:'auto',compute:{module:shader,entryPoint:'main'}});
    const bindings=device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:
        [input,output,params].map((buffer,binding)=>({binding,resource:{buffer}}))});
    const targetMs=globalThis.__requestedGpuContentionMs??12,calibration=[];
    const dispatch=(timed=false)=>{
        const encoder=device.createCommandEncoder();
        const pass=encoder.beginComputePass(timed?{timestampWrites:{querySet:query,beginningOfPassWriteIndex:0,endOfPassWriteIndex:1}}:{});
        pass.setPipeline(pipeline);pass.setBindGroup(0,bindings);pass.dispatchWorkgroups(1024);pass.end();
        if(timed){encoder.resolveQuerySet(query,0,2,resolve,0);encoder.copyBufferToBuffer(resolve,0,read,0,16)}
        device.queue.submit([encoder.finish()]);
    };
    let iterations=16;
    for(let attempt=0;attempt<6;attempt++){
        device.queue.writeBuffer(params,0,new Uint32Array([iterations,0,0,0]));dispatch(true);
        await read.mapAsync(GPUMapMode.READ);const ticks=new BigUint64Array(read.getMappedRange());
        const ms=Number(ticks[1]-ticks[0])/1e6;read.unmap();calibration.push({iterations,ms});
        if(ms>targetMs*.85&&ms<targetMs*1.15)break;
        const next=Math.max(1,Math.min(4096,Math.round(iterations*targetMs/Math.max(ms,.01))));
        if(next===iterations||attempt===5)break;
        iterations=next;
    }
    device.queue.writeBuffer(params,0,new Uint32Array([iterations,0,0,0]));
    const owner=_reflectionPipeline,original=owner.render;
    let disposed=false;
    const stop=()=>{if(disposed)return;disposed=true;if(owner.render===wrapped)owner.render=original;clearTimeout(watchdog);
        delete globalThis.__gpuContention;return device.queue.onSubmittedWorkDone().catch(()=>{}).then(release);};
    const watchdog=setTimeout(stop,180000);
    const wrapped=async function(...args){const result=await original.apply(this,args);if(!disposed){dispatch();await device.queue.onSubmittedWorkDone();}return result;};
    owner.render=wrapped;installed=true;
    const metadata={method:'Synthetic GPU memory-latency workload and per-frame completion fence',targetExtraGpuMs:targetMs,calibration,iterations,
        limitations:'Same RTX 5090 architecture and VRAM; GPU contention is not a physical lower-power GPU or a prediction for a named card.'};
    globalThis.__gpuContention={stop,metadata};
    _eanpaTest.pauseAfterFrame=false;_eanpaTest.paused=false;
    return metadata;
    }finally{if(!installed){release();_eanpaTest.pauseAfterFrame=false;_eanpaTest.paused=wasPaused;}}
})()
