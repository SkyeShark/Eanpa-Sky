(async()=>{
 const T=THREE,p=_reflectionPipeline,r=p.pipeline.renderer,a=p.ambientOcclusion;
 _eanpaTest.pauseAfterFrame=true;while(!_eanpaTest.paused)await new Promise(done=>setTimeout(done,10));
 await p.render();const w=p.geometry.target.width,h=p.geometry.target.height;
 const material=new T.MeshBasicNodeMaterial({depthTest:false,depthWrite:false,toneMapped:false});
 const sample=a.textureNode.load(T.screenCoordinate);
 material.fragmentNode=T.vec4(a.unpackNormal(sample.rg),sample.a);
 const target=new T.RenderTarget(w,h,{type:T.FloatType,depthBuffer:false}),quad=new T.QuadMesh(material);
 const saved=T.RendererUtils.resetRendererState(r);
 try{
  r.setRenderTarget(target);quad.render(r);
  const unpack=raw=>{const row=Math.ceil(w*4*raw.BYTES_PER_ELEMENT/256)*256/raw.BYTES_PER_ELEMENT;
   const f=raw instanceof Uint16Array?T.DataUtils.fromHalfFloat:x=>x,out=new Float32Array(w*h*4);
   for(let y=0;y<h;y++)for(let x=0;x<w*4;x++)out[y*w*4+x]=f(raw[y*(raw.length===w*h*4?w*4:row)+x]);return out;};
  const decoded=unpack(await r.readRenderTargetPixelsAsync(target,0,0,w,h));
  const geometry=unpack(await r.readRenderTargetPixelsAsync(p.geometry.target,0,0,w,h));
  const packed=unpack(await r.readRenderTargetPixelsAsync(a.target,0,0,w,h));
  let maxNormalError=0,idErrors=0,invalid=0,receivers=0,negativeZ=0;
  for(let i=0;i<geometry.length;i+=4){
   if(geometry[i+3]===0)continue;receivers++;
   const n=[geometry[i]*2-1,geometry[i+1]*2-1,geometry[i+2]*2-1],length=Math.hypot(...n);
   if(n[2]<0)negativeZ++;
   const error=Math.hypot(...n.map((v,k)=>v/length-decoded[i+k]));
   if(!Number.isFinite(error)||packed[i+2]<0||packed[i+2]>1)invalid++;
   maxNormalError=Math.max(maxNormalError,error);
   if(decoded[i+3]!==geometry[i+3])idErrors++;
  }
  return{pass:receivers>1000&&maxNormalError<.008&&idErrors===0&&invalid===0,
   date:new Date().toISOString(),size:[w,h],receivers,negativeZ,maxNormalError,idErrors,invalid,
   sampledTextureLimit:r.backend.device.limits.maxSampledTexturesPerShaderStage};
 }finally{T.RendererUtils.restoreRendererState(r,saved);material.dispose();target.dispose();}
})()
