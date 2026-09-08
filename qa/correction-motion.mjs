// Record a fixed inspection camera in the one owned page. The actual sky,
// surface capture, particles and reflection pipeline run at normal time scale.
import {connect} from './cdp.mjs';
import {mkdir,writeFile} from 'node:fs/promises';
const name=process.argv[2]??'rain-correction';
if(!/^[a-z0-9_-]+$/.test(name))throw new Error('Invalid capture name');
const c=await connect();
try{
    if(!await c.evaluate("document.getElementById('boot')?.style.display==='none'"))throw new Error('Wait for scene initialization before a motion capture');
    const result=await c.evaluate(`(async()=>{
        _eanpaTest.pauseAfterFrame=true;
        while(!_eanpaTest.paused)await new Promise(r=>setTimeout(r,10));
        const canvas=document.getElementById('view'),stream=canvas.captureStream(30);
        const recorder=new MediaRecorder(stream,{mimeType:'video/webm;codecs=vp8',videoBitsPerSecond:8000000});
        const chunks=[];recorder.ondataavailable=e=>{if(e.data.size)chunks.push(e.data)};
        const finished=new Promise(r=>recorder.onstop=r);
        const w=__eanpaWeatherByScene.get(_c.parent),r=_reflectionPipeline.pipeline.renderer;
        if(${JSON.stringify(name.includes('lightning'))}&&!w.debugForceLocalStrike())throw new Error('Lightning weather required');
        const time=_sky.uniforms.time.value,start=performance.now(),frames=[];
        recorder.start();
        try{
            for(let i=0;i<180;i++){
                const t=time+(performance.now()-start)/1000;
                _sky.update(t,_c);w.update(t,_c);globalThis._ringworld?.update(t);
                _sky._celestialModule?.update(t);globalThis._temple?.update(t,_c,1/30);
                await globalThis._ringworld?.prepareFrame(r);await w.prepareFrame(r,_c);
                await _sky.prepareCloudShadows(r,_c);await _spatialClouds?.render();
                await _reflectionPipeline.render();
                if(i%30===0||(${JSON.stringify(name.includes('lightning'))}&&[18,19,20,22,26,45].includes(i))){
                    await r.backend.device.queue.onSubmittedWorkDone();frames.push(canvas.toDataURL('image/png'));}
                await new Promise(done=>setTimeout(done,Math.max(1,(i+1)*1000/30-(performance.now()-start))));
            }
        }finally{recorder.stop();await finished;stream.getTracks().forEach(t=>t.stop());}
        const blob=new Blob(chunks,{type:recorder.mimeType});
        const video=await new Promise(done=>{const reader=new FileReader();reader.onload=()=>done(reader.result);reader.readAsDataURL(blob)});
        return{video,frames,metadata:{date:new Date().toISOString(),durationSeconds:(performance.now()-start)/1000,
            camera:_c.position.toArray(),sky:document.getElementById('skybox').value,
            weather:document.getElementById('weather').value,wetness:w.uniforms.wetness.value,
            water:w.uniforms.surfaceWater.value,rain:w.diagnostics.precipitation,
            errors:[...document.body.children].filter(e=>e.style?.zIndex==='99').map(e=>e.textContent).filter(Boolean)}};
    })()`);
    const directory='artifacts/overhaul/look-review';await mkdir(directory,{recursive:true});
    await writeFile(`${directory}/${name}.webm`,Buffer.from(result.video.split(',')[1],'base64'));
    for(const [i,frame]of result.frames.entries())await writeFile(`${directory}/${name}-${i}.png`,Buffer.from(frame.split(',')[1],'base64'));
    await writeFile(`${directory}/${name}.json`,JSON.stringify(result.metadata,null,2));
    console.log(JSON.stringify(result.metadata));
}finally{c.close();}
