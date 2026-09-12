import {connect}from'./cdp.mjs';import{mkdir,writeFile}from'node:fs/promises';
const name=process.argv[2]||'current';if(!/^[a-z0-9_-]+$/i.test(name))throw Error('Invalid capture name');
const c=await connect();try{
 const result=await c.evaluate(`(async()=>{
  _eanpaTest.pauseAfterFrame=true;while(!_eanpaTest.paused)await new Promise(r=>setTimeout(r,10));
  const p=_reflectionPipeline,r=p.pipeline.renderer,canvas=r.domElement,position=_c.position.clone(),rotation=_c.quaternion.clone();
  const weather=__eanpaWeatherByScene.get(_c.parent),time=_sky.uniforms.time.value;
  p.setAuditContributions();p.setAOEnabled(true);
  const stream=canvas.captureStream(30),recorder=new MediaRecorder(stream,{mimeType:'video/webm;codecs=vp8',videoBitsPerSecond:2400000});
  const chunks=[],frames=[];recorder.ondataavailable=e=>{if(e.data.size)chunks.push(e.data)};
  const finished=new Promise(done=>recorder.onstop=done);const start=performance.now();recorder.start();
  try{for(let i=0;i<180;i++){
   await new Promise(requestAnimationFrame);const phase=i/179*Math.PI*2,t=time+i/30;
   _c.position.copy(position).add(new THREE.Vector3(Math.sin(phase)*1.2,0,Math.cos(phase)*.35));
   _c.quaternion.copy(rotation);_c.rotateY(Math.sin(phase)*.035);_c.updateMatrixWorld(true);
   _sky.update(t,_c);weather.update(t,_c);await weather.prepareFrame(r,_c);
   await _sky.prepareCloudShadows(r,_c);await _spatialClouds?.render();await p.render();
   if(i%45===0||i===179){await r.backend.device.queue.onSubmittedWorkDone();frames.push({index:i,jpeg:canvas.toDataURL('image/jpeg',.91)});}
   await new Promise(done=>setTimeout(done,Math.max(1,(i+1)*1000/30-(performance.now()-start))));
  }}finally{recorder.stop();await finished;stream.getTracks().forEach(t=>t.stop());}
  const blob=new Blob(chunks,{type:recorder.mimeType}),video=await new Promise(done=>{const reader=new FileReader();reader.onload=()=>done(reader.result);reader.readAsDataURL(blob)});
  return{video,frames,metadata:{date:new Date().toISOString(),revision:THREE.REVISION,weather:weather.state.name,
   camera:position.toArray(),actualSeconds:(performance.now()-start)/1000,frames:180,probe:p.localProbe.stats,
   ao:p.aoEnabled,pointerLocked:!!document.pointerLockElement,
   errors:[...document.body.children].filter(e=>e.style?.zIndex==='99').map(e=>e.textContent).filter(Boolean)}};
 })()`);
 const dir='.artifacts/fence-r186';await mkdir(dir,{recursive:true});
 await writeFile(`${dir}/${name}-motion.webm`,Buffer.from(result.video.split(',')[1],'base64'));
 for(const frame of result.frames)await writeFile(`${dir}/${name}-motion-${frame.index}.jpg`,Buffer.from(frame.jpeg.split(',')[1],'base64'));
 await writeFile(`${dir}/${name}-motion.json`,JSON.stringify(result.metadata,null,2));console.log(JSON.stringify(result.metadata));
 if(result.metadata.errors.length)throw Error('Render errors during motion review');
}finally{c.close()}
