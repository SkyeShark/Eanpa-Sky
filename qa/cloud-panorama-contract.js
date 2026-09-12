// GPU contract for atomic publication, frozen bands, direction mapping and
// cancellation. Run in the sky fixture, using its one WebGPU device.
(async()=>{
 const T=THREE,r=_reflectionPipeline.pipeline.renderer;
 _eanpaTest.pauseAfterFrame=true;while(!_eanpaTest.paused)await new Promise(done=>setTimeout(done,10));
 const {makeCloudUniformSnapshot}=await import('/engine/cloud_uniform_snapshot.js');
 const {makeCachedCloudDisplay}=await import('/engine/cached_cloud_display.js');
 const scalar=value=>T.uniform(value).setGroup(T.frameGroup),vector=(x=0,y=0,z=0)=>scalar(new T.Vector3(x,y,z));
 const u={time:scalar(0),amount:scalar(.2),cloudDisplacement:vector(),cloudLightColor:vector(1,1,1),lightK:scalar(1),
  cloudAmbSky:vector(),cloudAmbGround:vector(),cloudRadiance:scalar(1),cloudRadianceScale:scalar(1),cloudLightDir:vector(0,1,0),
  finalMul:scalar(0),wispOn:scalar(0),stormCanopy:scalar(0),cloudWeatherGrey:scalar(0),wispOpacity:scalar(0),
  stretch:vector(1,1,1),celestialVisibility:scalar(1),
  cloudStart:scalar(1000),cloudHeight:scalar(1000),fadeDist:scalar(50000),solarSkyVisibility:scalar(1),
  lightningStrike:scalar(new T.Vector4()),lightningFlashColor:vector(1,1,1)};
 const sky={uniforms:u,async prepareOptimizedCaches(){},createCloudCaptureMaterial(){
  const snapshot=makeCloudUniformSnapshot(T,u),material=new T.NodeMaterial();
  material.depthTest=material.depthWrite=material.toneMapped=false;
  material.fragmentNode=T.outputStruct(T.Fn(()=>T.vec4(u.amount,T.uv(),.6))().context({eanpaCloudSnapshot:true}),T.float(1.5*.6));
  return{snapshot,material};
 }};
 const camera=new T.PerspectiveCamera();camera.updateMatrixWorld(true);
 const options={width:64,height:32,bands:4,refreshSeconds:1,blendSeconds:.1};
 const cache=makeCachedCloudDisplay(T,r,sky,camera,options),saved=T.RendererUtils.saveRendererState(r),checks=[];
 const check=(name,pass,detail)=>checks.push({name,pass,...detail});
 const published=()=>cache.records.find(record=>record.time===cache.stats.publishedTime).target;
 const read=async target=>{
  const data=await r.readRenderTargetPixelsAsync(target,0,0,target.width,target.height);
  const from=data instanceof Uint16Array?T.DataUtils.fromHalfFloat:v=>v;
  const stride=Math.ceil(target.width*4*data.BYTES_PER_ELEMENT/256)*256/data.BYTES_PER_ELEMENT;
  return(x,y)=>Array.from(data.slice(y*stride+x*4,y*stride+x*4+4),from);
 };
 const uniformRed=async(target,value)=>{const pixel=await read(target);let error=0;
  for(let y=0;y<target.height;y++)for(let x=0;x<target.width;x++)error=Math.max(error,Math.abs(pixel(x,y)[0]-value));return error;};
 let sampleTarget,sampleMaterial,cancelled;
 try{
  await Promise.all([cache.ensureReady(),cache.ensureReady()]);
  check('one initial capture for concurrent requests',cache.stats.fullDraws===1&&cache.stats.captures===1,{stats:{...cache.stats}});
  check('initial frozen data',await uniformRed(published(),.2)<.001);
  sampleMaterial=new T.NodeMaterial();sampleMaterial.depthTest=sampleMaterial.depthWrite=sampleMaterial.toneMapped=false;
  sampleMaterial.fragmentNode=T.Fn(()=>{
   const uv=T.uv(),lon=uv.x.sub(.5).mul(Math.PI*2),lat=T.float(.5).sub(uv.y).mul(Math.PI);
   const dir=T.vec3(T.cos(lat).mul(T.cos(lon)),T.sin(lat),T.cos(lat).mul(T.sin(lon)));
   return cache.sample(dir,T.vec3(0),false);
  })();
  const quad=new T.QuadMesh(sampleMaterial);sampleTarget=new T.RenderTarget(64,32,{type:T.FloatType,depthBuffer:false});
  const drawSample=async()=>{await new Promise(requestAnimationFrame);r.setMRT(null);r.setRenderTarget(sampleTarget);quad.render(r);return read(sampleTarget);};
  await drawSample();
  check('shader compiled on first publication sees the initial cloud',await uniformRed(sampleTarget,.2)<.001);
  u.time.value=.01;await cache.update();await drawSample();
  check('first display update keeps the completed startup capture fully visible',await uniformRed(sampleTarget,.2)<.001);
  u.time.value=1;u.amount.value=.7;
  await Promise.all([cache.update(),cache.update()]);
  check('partial capture stays private and concurrent updates coalesce',cache.stats.band===1&&cache.stats.captures===1&&await uniformRed(published(),.2)<.001);
  const partial=cache.records.find(record=>record.time===cache.stats.captureTime).target,partialPixel=await read(partial);
  const rowValues=Array.from({length:32},(_,y)=>partialPixel(32,y)[0]);
  check('one scissor band changes only its eight rows',rowValues.slice(0,8).every(v=>Math.abs(v-.7)<.001)
   &&rowValues.slice(8).every(v=>Math.abs(v-.7)>.01),{rowValues});
  u.amount.value=.9;
  for(let i=1;i<4;i++){u.time.value=1+i*.01;await cache.update();}
  const error=await uniformRed(published(),.7);
  check('every completed band uses the state from capture start',cache.stats.captures===2&&error<.001,{maxError:error});
  await drawSample();check('publication starts from the previous image',await uniformRed(sampleTarget,.2)<.001);
  u.time.value=1.08;await cache.update();await drawSample();
  check('halfway crossfade contains both distinct texture bindings',await uniformRed(sampleTarget,.45)<.001);
  // Inverse world-direction mapping must recover both latitude and longitude.
  u.time.value=1.2;await cache.update();
  const pixel=await drawSample(),samples=[];
  for(const [x,y]of [[8,4],[48,4],[8,26],[48,26],[31,15]]){
   const value=pixel(x,y),expected=[.7,(x+.5)/64,(y+.5)/32,.6];
   samples.push({x,y,value,expected,error:Math.max(...value.map((v,i)=>Math.abs(v-expected[i])))});
  }
  check('world directions round-trip without rotation or vertical flip',samples.every(p=>p.error<.003),{samples});
  const targetBefore=r.getRenderTarget(),autoClear=r.autoClear,xr=r.xr.enabled,render=r.render;
  u.time.value=2.3;
  try{r.render=()=>{throw new Error('intentional capture failure')};await cache.update();check('draw failure reported',false);}
  catch(e){check('draw failure reported',e.message==='intentional capture failure');}
  finally{r.render=render;}
  check('failure retains publication and restores renderer',cache.stats.captures===2&&cache.stats.failures===1
   &&r.getRenderTarget()===targetBefore&&r.autoClear===autoClear&&r.xr.enabled===xr&&await uniformRed(published(),.7)<.001);
  for(let i=0;i<4;i++){u.time.value=2.31+i*.01;await cache.update();}
  check('failed band can retry without holes',cache.stats.captures===3&&await uniformRed(published(),.9)<.001);
  let resume;const pending=new Promise(done=>resume=done);
  cancelled=makeCachedCloudDisplay(T,r,{...sky,prepareOptimizedCaches:()=>pending},camera,options);
  let released=0;for(const record of cancelled.records)record.target.addEventListener('dispose',()=>released++);
  const boot=cancelled.ensureReady();cancelled.dispose();resume();await boot;cancelled.dispose();
  check('dispose during warmup publishes nothing and releases exactly once',cancelled.stats.captures===0&&cancelled.stats.fullDraws===0&&released===3);
  return{pass:checks.every(c=>c.pass),date:new Date().toISOString(),revision:T.REVISION,checks};
 }finally{cache.dispose();cancelled?.dispose();sampleTarget?.dispose();sampleMaterial?.dispose();T.RendererUtils.restoreRendererState(r,saved);}
})()
