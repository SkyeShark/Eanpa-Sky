// Record the actual 120-second day cycle, including normal lighting/IBL updates.
// One existing automated page, bounded capture, no pointer input or new browser.
import {connect} from './cdp.mjs';
import {mkdir,writeFile} from 'node:fs/promises';
const c=await connect(),directory=process.argv[2]??'artifacts/ring-eclipse-motion';
try{
    const result=await c.evaluate(`(async()=>{
        if(!new URL(location.href).searchParams.has('automated')||document.pointerLockElement
            ||!_eanpaTest.paused||document.getElementById('skybox').value!=='ringworld')throw new Error('Pause the automated Ringworld page first');
        _c.position.set(0,1.82,96);_c.rotation.set(.28,0,0,'YXZ');_c.fov=62;
        _c.updateProjectionMatrix();_c.updateMatrixWorld(true);Object.assign(_look,{pitch:.28,yaw:0,vpitch:0,vyaw:0});
        Object.assign(_movementState,{physicalEyeY:1.82,verticalVelocity:0,grounded:true,bobOffset:0,stepViewOffset:0});
        const tod=document.getElementById('tod');tod.value=11.2;tod.dispatchEvent(new Event('input',{bubbles:true}));
        document.getElementById('cyclespeed').value='120';document.getElementById('cycle').checked=true;
        const canvas=document.getElementById('view'),stream=canvas.captureStream(30),chunks=[],frames=[];
        const recorder=new MediaRecorder(stream,{mimeType:'video/webm;codecs=vp8',videoBitsPerSecond:5000000});
        recorder.ondataavailable=e=>{if(e.data.size)chunks.push(e.data)};
        const stopped=new Promise(resolve=>recorder.onstop=resolve),start=performance.now();
        try{
            recorder.start();_eanpaTest.pauseAfterFrame=false;_eanpaTest.paused=false;
            for(let i=0;i<12;i++){
                await new Promise(resolve=>setTimeout(resolve,1000));
                frames.push({seconds:(performance.now()-start)/1000,hours:_sky.state.hours,
                    solar:_ringEclipse.solarVisibility,png:canvas.toDataURL('image/png')});
            }
        }finally{
            document.getElementById('cycle').checked=false;_eanpaTest.pauseAfterFrame=true;
            while(!_eanpaTest.paused)await new Promise(resolve=>setTimeout(resolve,20));
            recorder.stop();await stopped;stream.getTracks().forEach(track=>track.stop());
        }
        const video=await new Promise(resolve=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);
            reader.readAsDataURL(new Blob(chunks,{type:recorder.mimeType}));});
        const errors=[...document.body.children].filter(e=>e.style?.zIndex==='99').map(e=>e.textContent).filter(Boolean);
        return {video,frames,metadata:{date:new Date().toISOString(),dayCycleSeconds:120,errors,
            pointerLocked:!!document.pointerLockElement,normalFrameLoop:true}};
    })()`);
    await mkdir(directory,{recursive:true});
    await writeFile(`${directory}/eclipse.webm`,Buffer.from(result.video.split(',')[1],'base64'));
    for(const [i,f]of result.frames.entries())await writeFile(`${directory}/frame-${i}.png`,Buffer.from(f.png.split(',')[1],'base64'));
    const report={...result.metadata,frames:result.frames.map(({png,...frame})=>frame)};
    await writeFile(`${directory}/motion.json`,JSON.stringify(report,null,2));console.log(JSON.stringify(report));
    if(report.errors.length||!report.frames.some(f=>f.solar===0)||report.frames.at(-1).solar!==1)process.exitCode=1;
}finally{c.close()}
