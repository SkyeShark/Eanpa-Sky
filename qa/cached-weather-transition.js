(async()=>{
 const f=__skyFixture,device=f.renderer.backend.device,p=GPUDevice.prototype,restore=[],builds=[],samples=[];
 if(!f.sky.cachedCloudDisplay)throw new Error('Performance cache required');
 for(const key of ['createRenderPipeline','createRenderPipelineAsync']){
  const original=p[key];p[key]=function(...args){if(this===device)builds.push({method:key,stage:globalThis._frameStage,time:f.time});return original.apply(this,args);};
  restore.push(()=>{p[key]=original});
 }
 const frame=f.frame,intervals=[];let previous=null;
 f.frame=async function(...args){const now=performance.now();if(previous!==null)intervals.push(now-previous);previous=now;return frame.apply(this,args);};
 try{
  f.weather.transitionTo('darkstorm',1,45);
  _eanpaTest.pauseAfterFrame=false;_eanpaTest.paused=false;
  const start=performance.now();
  for(let i=0;i<24;i++){
   await new Promise(done=>setTimeout(done,2000));
   samples.push({seconds:(performance.now()-start)/1000,transition:{...f.weather.diagnostics.transition},
    capture:{...f.spatial.captureStats},shadows:f.sky.cloudShadowMap.stats.captures,rain:f.weather.uniforms.rainK.value});
  }
  _eanpaTest.pauseAfterFrame=true;while(!_eanpaTest.paused)await new Promise(done=>setTimeout(done,10));
  const sorted=intervals.sort((a,b)=>a-b),last=samples.at(-1);
  return{pass:!last.transition.active&&last.rain>.9&&f.errors.length===0&&builds.length===0,
   date:new Date().toISOString(),sky:f.kind,quality:f.tier,durationSeconds:45,actualSeconds:(performance.now()-start)/1000,
   errors:[...f.errors],pipelineBuilds:builds,frames:sorted.length,medianMs:sorted[Math.floor(sorted.length*.5)],p95Ms:sorted[Math.floor(sorted.length*.95)],maxMs:sorted.at(-1),samples};
 }finally{f.frame=frame;restore.forEach(fn=>fn());}
})()
