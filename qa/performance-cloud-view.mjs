import{connect}from'./cdp.mjs';import{mkdir,writeFile}from'node:fs/promises';
const [name='earth-day',cloud='cumulus',weather='none',hours='11',yaw='0',pitch='.1']=process.argv.slice(2);
if(!/^[a-z0-9_-]+$/i.test(name)||!Number.isFinite(Number(hours))||!Number.isFinite(Number(pitch))
 ||(yaw!=='star'&&!Number.isFinite(Number(yaw))))throw Error('Invalid view arguments');
const c=await connect();
try{
 const result=await c.evaluate(`(async()=>{
  const f=__skyFixture;
  _eanpaTest.pauseAfterFrame=true;while(!_eanpaTest.paused)await new Promise(done=>setTimeout(done,10));
  f.animateCamera=false;f.weather.setWeather(${JSON.stringify(weather)});
  if(${JSON.stringify(weather)}==='none')f.sky.setClouds(${JSON.stringify(cloud)});
  f.active.setTime(${Number(hours)});f.camera.position.set(0,2.2,13);
  ${yaw==='star' ? 'f.camera.lookAt(f.camera.position.clone().addScaledVector(f.sky.sunDir,1000));' : `f.camera.lookAt(Math.sin(${Number(yaw)})*30,2.2+Math.tan(${Number(pitch)})*30,13-Math.cos(${Number(yaw)})*30);`}
  f.weather.uniforms.wetness.value=f.weather.uniforms.wetTarget.value;
  f.weather.uniforms.surfaceWater.value=Math.pow(f.weather.uniforms.wetTarget.value,1.8);
  // Static look review only: advance enough simulated time for both published
  // images to contain the selected weather. Motion/FPS use separate harnesses.
  const start=f.time;
  for(let i=0;i<300;i++){await new Promise(requestAnimationFrame);await f.frame(start+i*.1);}
  f.nextEnvironmentAt=f.time;await f.frame(f.time+.01);
  // The local reflection probe uses wall time for its crossfade.
  for(let i=0;i<40;i++){await new Promise(requestAnimationFrame);await f.frame(f.time+.025);await new Promise(done=>setTimeout(done,25));}
  await f.renderer.backend.device.queue.onSubmittedWorkDone();
  return{source:globalThis.__sourceRevision,sky:f.kind,tier:f.tier,cloud:f.sky.state.preset,weather:f.weather.state.name,hours:${Number(hours)},time:f.time,
   camera:f.camera.position.toArray(),rotation:f.camera.rotation.toArray(),wind:f.sky.uniforms.cloudDisplacement.value.toArray(),
   cached:f.spatial.captureStats??null,shadows:f.sky.cloudShadowMap.stats,environment:f.environmentStats,errors:f.errors};
 })()`);
 const shot=await c.send('Page.captureScreenshot',{format:'jpeg',quality:88,captureBeyondViewport:false});
 await mkdir('qa/review/performance-cloud-motion',{recursive:true});
 await writeFile(`qa/review/performance-cloud-motion/${name}.jpg`,Buffer.from(shot.data,'base64'));
 await writeFile(`qa/review/performance-cloud-motion/${name}.json`,JSON.stringify(result,null,2));
 console.log(JSON.stringify(result));
}finally{c.close()}
