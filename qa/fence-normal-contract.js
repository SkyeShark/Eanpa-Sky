(async()=>{
 const T=THREE,p=_reflectionPipeline,r=p.pipeline.renderer,scene=_c.parent;
 _eanpaTest.pauseAfterFrame=true;while(!_eanpaTest.paused)await new Promise(done=>setTimeout(done,10));
 // The production graph does not need the shaded-normal MRT attachment.
 // Request it explicitly for this diagnostic before rendering a frame.
 const normalTexture=p.scenePass.getTexture('normal');
 const wallIds=new Set();scene.traverseVisible(o=>{if(o.isMesh&&o.material?.name==='Eidoverse_perimeter_shared_2K_PBR')wallIds.add(p.geometry.objectId(o));});
 const t=_sky.uniforms.time.value,weather=__eanpaWeatherByScene.get(scene),rows=[];
 for(const phase of [0,.5*Math.PI,Math.PI,1.5*Math.PI,2*Math.PI]){
  _c.position.set(24,1.82,-19.5);_c.lookAt(22,4,-24);
  _c.position.add(new T.Vector3(Math.sin(phase)*1.2,0,Math.cos(phase)*.35));_c.rotateY(Math.sin(phase)*.035);_c.updateMatrixWorld(true);
  _sky.update(t,_c);weather.update(t,_c);await _spatialClouds?.render();
  await new Promise(requestAnimationFrame);await p.render();
  const w=p.geometry.target.width,h=p.geometry.target.height,rt=p.scenePass.renderTarget;
  const normals=await r.readRenderTargetPixelsAsync(rt,0,0,w,h,rt.textures.indexOf(normalTexture));
  const keys=await r.readRenderTargetPixelsAsync(p.geometry.target,0,0,w,h,1);
  const stride=buffer=>buffer.length===w*h*4?w*4:
   Math.ceil(w*4*buffer.BYTES_PER_ELEMENT/256)*256/buffer.BYTES_PER_ELEMENT;
  const ns=stride(normals),ks=stride(keys);
  let samples=0,nonFinite=0,maxLengthError=0;
  for(let y=2;y<h-2;y+=2)for(let x=2;x<w-2;x+=2){
   if(!wallIds.has(Math.round(keys[y*ks+x*4+3])))continue;samples++;
   const i=y*ns+x*4,n=[0,1,2].map(k=>T.DataUtils.fromHalfFloat(normals[i+k])*2-1);
   if(n.some(v=>!Number.isFinite(v)))nonFinite++;else maxLengthError=Math.max(maxLengthError,Math.abs(Math.hypot(...n)-1));
  }
  rows.push({phase,samples,nonFinite,maxLengthError,pass:samples>10000&&nonFinite===0&&maxLengthError<.01});
 }
 return globalThis.__fenceNormalContract={pass:rows.every(r=>r.pass),date:new Date().toISOString(),revision:T.REVISION,weather:weather.state.name,rows};
})()
