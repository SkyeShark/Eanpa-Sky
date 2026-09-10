import {connect} from './cdp.mjs';
import {mkdir,writeFile} from 'node:fs/promises';
const [name='feedback-motion',mode='sky',duration='8',speed='1']=process.argv.slice(2);
if(!/^[a-z0-9_-]+$/.test(name)||!['sky','walk','orb'].includes(mode)||Number(duration)>20)throw new Error('Invalid capture arguments');
const c=await connect();
try{
    const result=await c.evaluate(`(async()=>{
        _eanpaTest.pauseAfterFrame=true;while(!_eanpaTest.paused)await new Promise(r=>setTimeout(r,10));
        const renderer=_reflectionPipeline.pipeline.renderer,canvas=renderer.domElement;
        const stream=canvas.captureStream(30),recorder=new MediaRecorder(stream,{mimeType:'video/webm;codecs=vp8',videoBitsPerSecond:8000000});
        const chunks=[],frames=[];recorder.ondataavailable=e=>{if(e.data.size)chunks.push(e.data)};
        const finished=new Promise(done=>recorder.onstop=done),baseTime=_sky.uniforms.time.value;
        const position=_c.position.clone(),rotation=_c.quaternion.clone(),weather=__eanpaWeatherByScene.get(_c.parent);
        const duration=${Number(duration)},scale=${Number(speed)},mode=${JSON.stringify(mode)};
        const total=Math.ceil(duration*30),start=performance.now();recorder.start();
        try{for(let i=0;i<total;i++){
            await new Promise(requestAnimationFrame);
            const dt=1/30,t=baseTime+i*dt*scale,phase=i/(total-1)*Math.PI*2;
            if(mode==='walk')_c.position.copy(position).add(new THREE.Vector3(Math.sin(phase)*2,0,-i/(total-1)*9));
            if(mode==='orb'){_c.position.copy(position).add(new THREE.Vector3(Math.sin(phase)*.5,0,Math.cos(phase)*.15));
                _c.quaternion.copy(rotation);_c.rotateY(Math.sin(phase)*.025);}
            _c.updateMatrixWorld(true);_sky.update(t,_c);weather.update(t,_c);
            globalThis._ringworld?.update(t);_sky._celestialModule?.update(t);globalThis._temple?.update(t,_c,dt);
            await globalThis._ringworld?.prepareFrame(renderer);await weather.prepareFrame(renderer,_c);
            await _sky.prepareCloudShadows(renderer,_c);await _spatialClouds?.render();await _reflectionPipeline.render();
            if(i%30===0||i===total-1){await renderer.backend.device.queue.onSubmittedWorkDone();frames.push({index:i,time:t,png:canvas.toDataURL('image/png')});}
            await new Promise(done=>setTimeout(done,Math.max(1,(i+1)*1000/30-(performance.now()-start))));
        }}finally{recorder.stop();await finished;stream.getTracks().forEach(t=>t.stop());}
        const blob=new Blob(chunks,{type:recorder.mimeType}),video=await new Promise(done=>{const r=new FileReader();r.onload=()=>done(r.result);r.readAsDataURL(blob)});
        return{video,frames,metadata:{date:new Date().toISOString(),mode,duration,simulationSpeed:scale,
            actualSeconds:(performance.now()-start)/1000,baseTime,sky:document.getElementById('skybox').value,
            weather:weather.state.name,camera:position.toArray(),finalCamera:_c.position.toArray(),
            wind:_sky.uniforms.skyWind.value.toArray(),displacement:_sky.uniforms.cloudDisplacement.value.toArray(),
            pointerLocked:!!document.pointerLockElement,probe:{..._reflectionPipeline.localProbe.stats},
            errors:[...document.body.children].filter(e=>e.style?.zIndex==='99').map(e=>e.textContent).filter(Boolean)}};
    })()`);
    const path='artifacts/feedback-20260909/motion';await mkdir(path,{recursive:true});
    await writeFile(`${path}/${name}.webm`,Buffer.from(result.video.split(',')[1],'base64'));
    for(const [i,f]of result.frames.entries())await writeFile(`${path}/${name}-${i}.png`,Buffer.from(f.png.split(',')[1],'base64'));
    await writeFile(`${path}/${name}.json`,JSON.stringify({...result.metadata,frames:result.frames.map(({index,time})=>({index,time}))},null,2));
    console.log(JSON.stringify(result.metadata));
}finally{c.close()}
