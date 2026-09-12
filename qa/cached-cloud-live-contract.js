// Real sky shader: live response must work between panorama publications.
(async()=>{
 const f=__skyFixture,T=THREE,r=f.renderer,u=f.sky.uniforms,cache=f.sky.cachedCloudDisplay;
 if(!cache)throw new Error('Performance cache required');
 _eanpaTest.pauseAfterFrame=true;while(!_eanpaTest.paused)await new Promise(done=>setTimeout(done,10));
 const saved=T.RendererUtils.saveRendererState(r),origin=T.uniform(f.camera.getWorldPosition(new T.Vector3()));
 const before={wind:u.cloudDisplacement.value.clone(),solar:u.solarSkyVisibility.value,
  strike:u.lightningStrike.value.clone(),flash:u.lightningFlashColor.value.clone(),light:u.cloudLightColor.value.clone()};
 const makeMaterial=transient=>{const m=new T.NodeMaterial();m.depthTest=m.depthWrite=m.toneMapped=false;
  m.fragmentNode=T.Fn(()=>{
   const uv=T.uv(),lon=uv.x.sub(.5).mul(Math.PI*2),lat=T.float(.5).sub(uv.y.mul(.5)).mul(Math.PI);
   const dir=T.vec3(T.cos(lat).mul(T.cos(lon)),T.sin(lat),T.cos(lat).mul(T.sin(lon)));
   return cache.sample(dir,origin,transient);
  })();return m;};
 const display=makeMaterial(true),environment=makeMaterial(false),q=new T.QuadMesh(display);
 const target=new T.RenderTarget(128,64,{type:T.FloatType,depthBuffer:false}),checks=[];
 const check=(name,pass,detail)=>checks.push({name,pass,...detail});
 const read=async m=>{await new Promise(requestAnimationFrame);r.setMRT(null);r.setRenderTarget(target);q.material=m;q.render(r);
  return r.readRenderTargetPixelsAsync(target,0,0,128,64);};
 const difference=(a,b,channel)=>{let sum=0,max=0,n=0;for(let i=0;i<a.length;i++){
  if(channel!==undefined?i%4!==channel:i%4===3)continue;
  const d=Math.abs(a[i]-b[i]);sum+=d;max=Math.max(max,d);n++;}return{mean:sum/n,max};};
 try{
  u.solarSkyVisibility.value=1;u.lightningStrike.value.w=0;
  const base=await read(display),envBase=await read(environment),captures=cache.stats.captures;
  const coverage=Array.from(base).filter((_,i)=>i%4===3).reduce((a,b)=>a+b,0)/(base.length/4);
  check('published sky contains cloud coverage',coverage>.02,{coverage});
  u.solarSkyVisibility.value=.16;const eclipse=await read(display);
  let error=0;for(let i=0;i<base.length;i++)error=Math.max(error,Math.abs(eclipse[i]-base[i]*(i%4===3?1:.16)));
  check('eclipse changes radiance immediately without changing opacity',error<.0001,{maxError:error});
  u.solarSkyVisibility.value=1;u.cloudLightColor.value.multiplyScalar(.5);
  const relit=difference(base,await read(display));check('current light responds between captures',relit.mean>.0001,{difference:relit});
  u.cloudLightColor.value.copy(before.light);u.lightningFlashColor.value.set(1,.8,.6);
  u.lightningStrike.value.set(origin.value.x,1000,origin.value.z,1);
  const flash=difference(base,await read(display)),envFlash=difference(envBase,await read(environment));
  check('lightning remains live on visible clouds',flash.mean>.0001,{difference:flash});
  check('transient lightning never enters the environment sample',envFlash.max<.0001,{difference:envFlash});
  u.lightningStrike.value.w=0;u.cloudDisplacement.value.x+=120;
  const wind=difference(base,await read(display),3);
  check('wind advects cloud coverage between captures',wind.mean>.0001,{difference:wind});
  u.cloudDisplacement.value.copy(before.wind);origin.value.x+=32;
  const translation=difference(base,await read(display),3);
  check('observer translation changes lookup without screen history',translation.mean>.00001,{difference:translation});
  check('all live responses occurred without publishing another panorama',cache.stats.captures===captures,{captures});
  return{pass:checks.every(c=>c.pass),date:new Date().toISOString(),sky:f.kind,tier:f.tier,checks};
 }finally{
  u.cloudDisplacement.value.copy(before.wind);u.solarSkyVisibility.value=before.solar;
  u.lightningStrike.value.copy(before.strike);u.lightningFlashColor.value.copy(before.flash);u.cloudLightColor.value.copy(before.light);
  target.dispose();display.dispose();environment.dispose();T.RendererUtils.restoreRendererState(r,saved);
 }
})()
