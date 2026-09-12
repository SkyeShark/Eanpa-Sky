// Compare native normal-mapped PBR rendering of rotated/scaled instances with
// ordinary Mesh draws of the same geometry/material at the same world pose.
(async()=>{
 const T=THREE,r=_reflectionPipeline.pipeline.renderer;
 _eanpaTest.pauseAfterFrame=true;while(!_eanpaTest.paused)await new Promise(done=>setTimeout(done,10));
 const saved=T.RendererUtils.saveRendererState(r),oldContext=r.contextNode,oldShadows=r.shadowMap.enabled;
 const scene=new T.Scene(),camera=new T.PerspectiveCamera(50,1,.18,100);
 const shape=new T.BoxGeometry(2,2,2);shape.computeTangents();
 const normalMap=new T.DataTexture(new Uint8Array([155,108,251,255]),1,1,T.RGBAFormat);
 normalMap.needsUpdate=true;
 const material=new T.MeshPhysicalNodeMaterial({color:0xc0c0c0,metalness:.65,roughness:.28,normalMap});
 const reference=new T.Mesh(shape,material);reference.matrixAutoUpdate=false;scene.add(reference);
 const sun=new T.DirectionalLight(0xffffff,3);sun.position.set(3,5,6);scene.add(sun,new T.AmbientLight(0x99bbff,1));
 const target=new T.RenderTarget(128,128,{type:T.FloatType,count:2});target.textures[0].name='output';target.textures[1].name='normal';
 const mrt=T.mrt({output:T.output,normal:T.vec4(T.normalView,1)}),checks=[];
 const draw=async()=>{
  await new Promise(requestAnimationFrame);r.setRenderTarget(target);r.setMRT(mrt);r.render(scene,camera);
  return {normal:await r.readRenderTargetPixelsAsync(target,0,0,128,128,1),hdr:await r.readRenderTargetPixelsAsync(target,0,0,128,128,0)};
 };
 r.backend.device.pushErrorScope('validation');let popped=false;
 try{
  r.contextNode=T.context({});r.shadowMap.enabled=false;r.toneMapping=T.NoToneMapping;r.outputColorSpace=T.LinearSRGBColorSpace;r.setClearColor(0,0);
  for(const mode of ['uniform-buffer','instanced-attributes','dynamic-attributes']){
   const count=mode==='uniform-buffer'?1:Math.floor(r.backend.device.limits.maxUniformBufferBindingSize/64)+1;
   const instance=new T.InstancedMesh(shape,material,count);instance.count=1;instance.frustumCulled=false;scene.add(instance);
   if(mode==='dynamic-attributes')instance.instanceMatrix.setUsage(T.DynamicDrawUsage);
   try{for(const angle of [0,Math.PI/2,Math.PI,Math.PI*1.5,.67]){
    const transform=new T.Matrix4().compose(new T.Vector3(.1,-.1,0),new T.Quaternion().setFromEuler(new T.Euler(.12,angle,.09)),new T.Vector3(1.25,.75,1.1));
    instance.setMatrixAt(0,transform);instance.instanceMatrix.needsUpdate=true;reference.matrix.copy(transform);
    camera.position.set(3.6+Math.sin(angle)*.2,2.3,5.7);camera.lookAt(0,0,0);camera.updateMatrixWorld(true);
    instance.visible=false;reference.visible=true;const expected=await draw();
    instance.visible=true;reference.visible=false;const actual=await draw();
    let finiteErrors=0,samples=0,maxNormalError=0,sumHdrError=0,sumReference=0;
    for(let y=2;y<126;y++)for(let x=2;x<126;x++){
     const i=(y*128+x)*4;if(expected.normal[i+3]!==1||actual.normal[i+3]!==1)continue;
     // Exclude rasterization boundaries; transformed vertices may differ by
     // a float ULP between an instance matrix and a model matrix.
     const n=Array.from(expected.normal.slice(i,i+3));
     if([-4,4,-512,512].some(d=>n.some((v,k)=>Math.abs(expected.normal[i+d+k]-v)>.001)))continue;
     samples++;const v=Array.from(actual.normal.slice(i,i+3));
     if(v.some(v=>!Number.isFinite(v))){finiteErrors++;continue;}
     maxNormalError=Math.max(maxNormalError,Math.hypot(...v.map((v,k)=>v-n[k])));
     for(let k=0;k<3;k++){sumHdrError+=Math.abs(actual.hdr[i+k]-expected.hdr[i+k]);sumReference+=expected.hdr[i+k];}
    }
    const relativeHdrError=sumHdrError/Math.max(1e-6,sumReference);
    checks.push({mode,angle,samples,finiteErrors,maxNormalError,relativeHdrError,
     pass:samples>500&&finiteErrors===0&&maxNormalError<.005&&relativeHdrError<.005});
   }}finally{instance.removeFromParent();instance.dispose();}
  }
  const validation=await r.backend.device.popErrorScope();popped=true;
  return {pass:checks.every(c=>c.pass)&&!validation,revision:T.REVISION,date:new Date().toISOString(),checks,validation:validation?.message??null};
 }finally{
  if(!popped)await r.backend.device.popErrorScope();
  target.dispose();shape.dispose();material.dispose();normalMap.dispose();
  r.contextNode=oldContext;r.shadowMap.enabled=oldShadows;T.RendererUtils.restoreRendererState(r,saved);
 }
})()
