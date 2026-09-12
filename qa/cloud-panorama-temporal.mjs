// Normal-time cloud motion, measured independently of camera movement.
// GPU readback is intentional: these measurements are not FPS benchmarks.
import {connect} from './cdp.mjs';
import {mkdir,writeFile} from 'node:fs/promises';
const [name='current',seconds='30']=process.argv.slice(2);
if(!/^[a-z0-9_-]+$/i.test(name)||!Number.isFinite(Number(seconds))||Number(seconds)<3||Number(seconds)>60)
 throw new Error('Invalid temporal capture');
const c=await connect();
try{
 const {result,exceptionDetails}=await c.send('Runtime.evaluate',{awaitPromise:true,returnByValue:true,expression:`(async()=>{
  const f=__skyFixture,T=THREE,r=f.renderer;
  _eanpaTest.pauseAfterFrame=true;while(!_eanpaTest.paused)await new Promise(done=>setTimeout(done,10));
  f.animateCamera=false;f.camera.position.set(0,2.2,13);f.camera.lookAt(0,22, -17);f.camera.updateMatrixWorld(true);
  f.weather.setWeather('none');f.sky.setClouds('cumulus');f.active.setTime(10.5);
  for(let i=0;i<100;i++){await new Promise(requestAnimationFrame);await f.frame(f.time+1/30);}
  const target=new T.RenderTarget(256,144,{type:T.HalfFloatType,depthBuffer:false});
  const saved=T.RendererUtils.saveRendererState(r),oldContext=r.contextNode,oldShadow=r.shadowMap.enabled,diagnosticContext=T.context({});
  const draw=async object=>{
   r.contextNode=diagnosticContext;r.shadowMap.enabled=false;r.setMRT(null);r.setRenderTarget(target);r.setClearColor(0,0);r.clear();r.render(object,f.camera);
   const values=await r.readRenderTargetPixelsAsync(target,0,0,256,144);
   T.RendererUtils.restoreRendererState(r,saved);r.contextNode=oldContext;r.shadowMap.enabled=oldShadow;
   return Float32Array.from(values,T.DataUtils.fromHalfFloat);
  };
  const difference=(a,b)=>{if(!a)return null;let sum=0,color=0,max=0;for(let i=0;i<a.length;i++){
   const v=Math.abs(a[i]-b[i]);if(i%4===3){sum+=v;max=Math.max(max,v);}else color+=v;
  }return{alpha:sum/(a.length/4),rgb:color/(a.length/4*3),maxAlpha:max};};
  const frames=[],samples=[],start=f.time,wall=performance.now();let previousCache,previousLive;
  try{
   // Warm both exact diagnostic render contexts before measuring motion.
   await draw(f.sky.domes[1]);await draw(f.spatial.proxy);
   const begin=performance.now();
   for(let i=0;i<${Number(seconds)*30};i++){
    await new Promise(requestAnimationFrame);await f.frame(start+i/30);
    const live=await draw(f.sky.domes[1]),cached=await draw(f.spatial.proxy);
    globalThis.__cloudTemporalProgress={frame:i,total:${Number(seconds)*30},start};
    frames.push({time:i/30,blend:f.spatial.captureStats.blend,captures:f.spatial.captureStats.captures,
     cached:difference(previousCache,cached),live:difference(previousLive,live),error:difference(live,cached)});
    previousCache=cached;previousLive=live;
    if(i%30===0)samples.push({frame:i,data:r.domElement.toDataURL('image/jpeg',.85)});
    await new Promise(done=>setTimeout(done,Math.max(1,(i+1)*1000/30-(performance.now()-begin))));
   }
   return globalThis.__cloudTemporalResult={date:new Date().toISOString(),quality:f.quality,seconds:${Number(seconds)},actualSeconds:(performance.now()-wall)/1000,frames,samples,errors:f.errors};
  }finally{target.dispose();T.RendererUtils.restoreRendererState(r,saved);r.contextNode=oldContext;r.shadowMap.enabled=oldShadow;}
 })()`},300000);
 if(exceptionDetails)throw Error(exceptionDetails.exception?.description??exceptionDetails.text);
 const data=result.value,dir='.artifacts/cloud-performance/temporal-'+name;await mkdir(dir,{recursive:true});
 for(const sample of data.samples)await writeFile(dir+'/'+sample.frame+'.jpg',Buffer.from(sample.data.split(',')[1],'base64'));
 delete data.samples;await writeFile(dir+'/result.json',JSON.stringify(data,null,2));
 const stat=key=>{const a=data.frames.slice(1).map(f=>f[key].alpha).sort((a,b)=>a-b);return{mean:a.reduce((a,b)=>a+b)/a.length,median:a[Math.floor(a.length*.5)],p95:a[Math.floor(a.length*.95)],max:a.at(-1)};};
 console.log(JSON.stringify({name,errors:data.errors,cached:stat('cached'),live:stat('live'),error:stat('error')}));
}finally{c.close();}
