import {connect} from './cdp.mjs';
import {mkdir,writeFile} from 'node:fs/promises';
const label=process.argv[2]??'current';
if(!/^[a-z0-9_-]+$/.test(label))throw new Error('Invalid label');
const c=await connect(),directory='.artifacts/rain-timing-20260910';
try{
    await c.evaluate(`(()=>{
        globalThis.__rainTimingResult=null;
        globalThis.__rainTimingRun=(async()=>{
            const f=__skyFixture,T=THREE,w=f.weather,r=f.renderer;
            if(!f.ready)throw new Error('Fixture not ready');
            if(!_eanpaTest.paused){_eanpaTest.pauseAfterFrame=true;while(!_eanpaTest.paused)await new Promise(done=>setTimeout(done,10));}
            w.setWeather('none');w.uniforms.wetness.value=0;w.uniforms.surfaceWater.value=0;
            w.accumulation?.reset();
            const source=new T.MeshStandardNodeMaterial();source.userData.puddleMaskNode=T.float(1);w.wrapMaterial(source);
            const response=w.getSurfaceNodes(source),material=new T.MeshStandardNodeMaterial({metalness:0,roughness:.8});
            material.fragmentNode=T.vec4(response.wetness,response.puddle,w.rainCellAt(T.positionWorld),1);
            const geometry=new T.PlaneGeometry(12,12),plane=new T.Mesh(geometry,material),scene=new T.Scene();
            plane.rotation.x=-Math.PI/2;plane.position.set(f.camera.position.x,.02,f.camera.position.z);scene.add(plane);
            const camera=new T.OrthographicCamera(-6,6,6,-6,.1,20);
            camera.position.copy(plane.position).add(new T.Vector3(0,10,0));camera.lookAt(plane.position);camera.updateMatrixWorld(true);
            const target=new T.RenderTarget(32,32,{type:T.FloatType,depthBuffer:false});
            const probe=async()=>{
                const saved=T.RendererUtils.saveRendererState(r),context=r.contextNode;
                try{r.contextNode=T.context({});r.setMRT(null);r.setRenderTarget(target);await r.renderAsync(scene,camera);
                    const pixels=await r.readRenderTargetPixelsAsync(target,0,0,32,32),mean=[0,0,0];
                    for(let i=0;i<pixels.length;i+=4)for(let k=0;k<3;k++)mean[k]+=pixels[i+k]/1024;
                    if(!mean.every(Number.isFinite))throw new Error('Non-finite rain surface probe');
                    return {wet:mean[0],puddle:mean[1],cell:mean[2]};
                }finally{r.contextNode=context;T.RendererUtils.restoreRendererState(r,saved);}
            };
            await f.frame(f.time+.05);await probe();
            const start=f.time,wall=performance.now(),samples=[],frames=[];let nextSample=0;
            w.transitionTo('rain',1,45);w.update(start,f.camera);
            try{
                while(performance.now()-wall<55050){
                    const tick=performance.now(),elapsed=(tick-wall)/1000;
                    await f.frame(start+elapsed);
                    if(elapsed>=nextSample){
                        await w.listener.settled();
                        const sample={seconds:elapsed,rain:w.uniforms.rainK.value,wet:w.uniforms.wetness.value,water:w.uniforms.surfaceWater.value,
                            listener:{...w.diagnostics.listener},surface:await probe()};
                        samples.push(sample);globalThis.__rainTimingProgress=sample;
                        if(nextSample%10===0)frames.push({seconds:elapsed,png:r.domElement.toDataURL('image/png')});
                        nextSample+=5;
                    }
                    await new Promise(done=>setTimeout(done,Math.max(1,50-(performance.now()-tick))));
                }
                globalThis.__rainTimingResult={date:new Date().toISOString(),sky:f.kind,quality:f.tier,weather:'none-to-rain',transitionSeconds:45,
                    startSimulationSeconds:start,camera:f.camera.position.toArray(),accumulation:w.accumulation?{...w.accumulation.stats}:null,
                    simulationSpeed:1,samples,frames,errors:[...f.errors],pointerLocked:!!document.pointerLockElement};
            }finally{source.dispose();material.dispose();geometry.dispose();target.dispose();}
        })().catch(error=>{globalThis.__rainTimingResult={error:String(error?.stack??error)}});
        return true;
    })()`);
    let result;const deadline=Date.now()+100000;
    while(!(result=await c.evaluate('globalThis.__rainTimingResult'))){
        if(Date.now()>deadline)throw new Error('Transition capture timed out');
        await new Promise(resolve=>setTimeout(resolve,5000));
        const progress=await c.evaluate('globalThis.__rainTimingProgress');
        if(progress)console.log(JSON.stringify(progress));
    }
    if(result.error)throw new Error(result.error);
    await mkdir(directory,{recursive:true});
    for(const [i,frame]of result.frames.entries())await writeFile(`${directory}/${label}-${i}.png`,Buffer.from(frame.png.split(',')[1],'base64'));
    result.frames=result.frames.map(({seconds})=>({seconds}));
    await writeFile(`${directory}/${label}.json`,JSON.stringify(result,null,2));
    console.log(JSON.stringify({label,samples:result.samples.length,errors:result.errors}));
}finally{c.close();}
