// Analytic moving cloud sheet: verify time/wind/stretch reprojection against
// an independently evaluated live field, including publication boundaries.
(async()=>{
 const f=__skyFixture,T=THREE,r=f.renderer;
 _eanpaTest.pauseAfterFrame=true;while(!_eanpaTest.paused)await new Promise(done=>setTimeout(done,10));
 const {makeCloudUniformSnapshot}=await import('/engine/cloud_uniform_snapshot.js');
 const {makeCachedCloudDisplay}=await import('/engine/cached_cloud_display.js');
 const shared=value=>T.uniform(value).setGroup(T.renderGroup),vector=(...v)=>shared(new T.Vector3(...v));
 const u={time:shared(0),cloudDisplacement:vector(0,0,0),stretch:vector(1.7,.7,.8),
  cloudLightColor:vector(1,1,1),lightK:shared(1),cloudAmbSky:vector(0,0,0),cloudAmbGround:vector(0,0,0),
  cloudRadiance:shared(1),cloudRadianceScale:shared(1),cloudLightDir:vector(0,1,0),
  finalMul:shared(1),wispOn:shared(0),stormCanopy:shared(0),cloudWeatherGrey:shared(0),wispOpacity:shared(0),
  celestialVisibility:shared(1),cloudStart:shared(500),cloudHeight:shared(1000),fadeDist:shared(50000),
  solarSkyVisibility:shared(1),lightningStrike:shared(new T.Vector4()),lightningFlashColor:vector(1,1,1)};
 const ray=(uv,hemisphere=false)=>{const lon=uv.x.sub(.5).mul(Math.PI*2),lat=T.float(.5).sub(uv.y.mul(hemisphere?.25:1)).mul(Math.PI);
  return T.vec3(T.cos(lat).mul(T.cos(lon)),T.sin(lat),T.cos(lat).mul(T.sin(lon)));};
 const sheet=(dir,origin)=>{
  const distance=T.float(1400).sub(origin.y).div(dir.y.max(.001));
  const point=origin.add(dir.mul(distance)).mul(u.stretch);
  const x=point.x.sub(u.cloudDisplacement.x).sub(u.cloudDisplacement.z.mul(.4)).add(u.time.mul(12.3));
  const z=point.z.sub(u.cloudDisplacement.z).add(u.cloudDisplacement.x.mul(.4));
  const alpha=T.sin(x.mul(.005)).mul(T.cos(z.mul(.004))).mul(.65).add(.25).clamp(0,1);
  return{rgba:T.vec4(T.vec3(alpha.mul(.6)),alpha),distance:distance.mul(.001).mul(alpha)};
 };
 const sky={uniforms:u,async prepareOptimizedCaches(){},createCloudCaptureMaterial(origin){
  const snapshot=makeCloudUniformSnapshot(T,u),m=new T.NodeMaterial(),distance=T.property('float');
  m.depthTest=m.depthWrite=m.toneMapped=false;
  const color=T.Fn(()=>{const field=sheet(ray(T.uv()),origin);distance.assign(field.distance);return field.rgba;})().context({eanpaCloudSnapshot:true});
  m.fragmentNode=T.outputStruct(color,distance);return{material:m,snapshot};
 }};
 const camera=new T.PerspectiveCamera();camera.position.set(0,3,0);camera.updateMatrixWorld(true);
 const origin=shared(camera.position.clone()),cache=makeCachedCloudDisplay(T,r,sky,camera,
  {width:1024,height:512,bands:8,refreshSeconds:9,blendSeconds:9});
 const target=new T.RenderTarget(128,64,{type:T.FloatType,depthBuffer:false}),m=new T.NodeMaterial();
 m.depthTest=m.depthWrite=m.toneMapped=false;
 m.fragmentNode=T.Fn(()=>{const dir=ray(T.uv(),true),cached=cache.sample(dir,origin,false),live=sheet(dir,origin).rgba;
  return T.vec4(cached.a,live.a,cached.r,live.r);})();
 const q=new T.QuadMesh(m),saved=T.RendererUtils.saveRendererState(r),oldContext=r.contextNode,diagnosticContext=T.context({}),checks=[],samples=[];
 const check=(name,pass,detail)=>checks.push({name,pass,...detail});
 try{
  await cache.ensureReady();
  for(let i=0;i<=100;i++){
   const time=i*.3;u.time.value=time;u.cloudDisplacement.value.set(time*2,0,time*3);
   camera.position.x=time*.75;camera.updateMatrixWorld(true);origin.value.copy(camera.position);
   await cache.update();await new Promise(requestAnimationFrame);
   r.contextNode=diagnosticContext;r.setMRT(null);r.setRenderTarget(target);q.render(r);
   const data=await r.readRenderTargetPixelsAsync(target,0,0,128,64);
   let error=0,max=0;for(let p=0;p<data.length;p+=4){const d=Math.abs(data[p]-data[p+1]);error+=d;max=Math.max(max,d);}
   samples.push({time,error:error/(data.length/4),max,captures:cache.stats.captures,blend:cache.stats.blend});
  }
  const maximum=Math.max(...samples.map(s=>s.error));
  check('moving captures stay aligned with the live density phase',maximum<.012,{maximumMeanOpacityError:maximum});
  check('test crosses multiple completed captures',cache.stats.captures>=3,{captures:cache.stats.captures});
  check('long crossfades include intermediate weights',samples.filter(s=>s.blend>.1&&s.blend<.9).length>30);
  const publicationErrors=samples.filter((s,i)=>i&&s.captures!==samples[i-1].captures).map(s=>s.error);
  check('publication does not break world alignment',publicationErrors.every(e=>e<.012),{publicationErrors});
  check('distance storage is one extra half-float channel',cache.records.every(r=>r.target.textures[1].format===T.RedFormat)
   &&cache.stats.textureBytes===1024*512*10*3);
  return{pass:checks.every(c=>c.pass),date:new Date().toISOString(),checks,samples};
 }finally{cache.dispose();target.dispose();m.dispose();r.contextNode=oldContext;T.RendererUtils.restoreRendererState(r,saved);}
})()
