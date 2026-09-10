// Normal-time sky motion in the same owned page, with video and inspectable
// keyframes. Simulation speed is explicit in every evidence file.
import {connect} from './cdp.mjs';
import {mkdir,writeFile} from 'node:fs/promises';
const [name='fixture-motion',duration='12',speed='1']=process.argv.slice(2);
if(!/^[a-z0-9_-]+$/i.test(name)||Number(duration)>20||Number(duration)<1||Number(speed)<.1)throw new Error('Invalid motion capture');
const c=await connect();
try{
    const result=await c.evaluate(`(async()=>{
        const f=__skyFixture;
        if(!_eanpaTest.paused){_eanpaTest.pauseAfterFrame=true;while(!_eanpaTest.paused)await new Promise(r=>setTimeout(r,10));}
        const canvas=f.renderer.domElement,stream=canvas.captureStream(30),chunks=[],frames=[];
        const recorder=new MediaRecorder(stream,{mimeType:'video/webm;codecs=vp8',videoBitsPerSecond:8000000});
        recorder.ondataavailable=e=>{if(e.data.size)chunks.push(e.data)};
        const finished=new Promise(done=>recorder.onstop=done),duration=${Number(duration)},speed=${Number(speed)};
        const start=f.time,total=Math.ceil(duration*30),wall=performance.now();recorder.start();
        try{for(let i=0;i<total;i++){
            await new Promise(requestAnimationFrame);await f.frame(start+i/30*speed);
            if(i%90===0||i===total-1){await f.renderer.backend.device.queue.onSubmittedWorkDone();frames.push({time:f.time,png:canvas.toDataURL('image/png')});}
            await new Promise(r=>setTimeout(r,Math.max(1,(i+1)*1000/30-(performance.now()-wall))));
        }}finally{recorder.stop();await finished;stream.getTracks().forEach(t=>t.stop());}
        const video=await new Promise(done=>{const r=new FileReader();r.onload=()=>done(r.result);r.readAsDataURL(new Blob(chunks,{type:recorder.mimeType}));});
        return{date:new Date().toISOString(),sky:f.kind,weather:f.weather.state.name,quality:f.tier,
            camera:f.camera.position.toArray(),fov:f.camera.fov,start,duration,simulationSpeed:speed,actualSeconds:(performance.now()-wall)/1000,
            errors:[...f.errors],pointerLocked:!!document.pointerLockElement,video,frames};
    })()`);
    const directory='artifacts/feedback-20260909/motion';await mkdir(directory,{recursive:true});
    await writeFile(`${directory}/${name}.webm`,Buffer.from(result.video.split(',')[1],'base64'));
    delete result.video;
    for(const [i,f]of result.frames.entries())await writeFile(`${directory}/${name}-${i}.png`,Buffer.from(f.png.split(',')[1],'base64'));
    result.frames=result.frames.map(({time})=>({time}));await writeFile(`${directory}/${name}.json`,JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}finally{c.close()}
