// Actual GPU buffers: a frozen capture must not rewrite live frame-group
// lighting, regardless of which material draws first or a later snapshot.
(async()=>{
 const T=THREE,r=_reflectionPipeline.pipeline.renderer;
 _eanpaTest.pauseAfterFrame=true;while(!_eanpaTest.paused)await new Promise(done=>setTimeout(done,10));
 const {makeCloudUniformSnapshot}=await import('/engine/cloud_uniform_snapshot.js');
 const live={amount:T.uniform(.2).setGroup(T.frameGroup),color:T.uniform(new T.Vector3(.3,.4,.5)).setGroup(T.frameGroup)};
 const snapshot=makeCloudUniformSnapshot(T,live);snapshot.capture();
 const material=frozen=>{const m=new T.MeshBasicNodeMaterial({depthTest:false,depthWrite:false,toneMapped:false});
  const node=T.Fn(()=>T.vec4(live.amount,live.color.x,live.color.y,1))();
  m.fragmentNode=frozen?node.context({eanpaCloudSnapshot:true}):node;return m;};
 const a=material(false),b=material(true),q=new T.QuadMesh(a),rt=new T.RenderTarget(16,16,{type:T.FloatType,depthBuffer:false});
 const saved=T.RendererUtils.saveRendererState(r),checks=[];
 const read=async m=>{r.setMRT(null);r.setRenderTarget(rt);q.material=m;q.render(r);
  return Array.from((await r.readRenderTargetPixelsAsync(rt,0,0,1,1)).slice(0,3));};
 const check=(name,values,expected)=>checks.push({name,values,expected,pass:values.every((v,i)=>Math.abs(v-expected[i])<1e-5)});
 try{
  await new Promise(requestAnimationFrame);
  live.amount.value=.7;live.color.value.set(.8,.9,1);
  check('live before capture',await read(a),[.7,.8,.9]);
  check('frozen after live',await read(b),[.2,.3,.4]);
  check('live after frozen in same frame',await read(a),[.7,.8,.9]);
  await new Promise(requestAnimationFrame);snapshot.capture();live.amount.value=.1;live.color.value.set(.2,.3,.4);
  check('new frozen before live',await read(b),[.7,.8,.9]);
  check('new live after frozen',await read(a),[.1,.2,.3]);
  return{pass:checks.every(c=>c.pass),date:new Date().toISOString(),revision:T.REVISION,checks};
 }finally{snapshot.dispose();a.dispose();b.dispose();rt.dispose();T.RendererUtils.restoreRendererState(r,saved);}
})()
