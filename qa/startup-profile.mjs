// Attaches to the single owned inspection page; starts no browser or server.
// Usage: node qa/startup-profile.mjs URL LABEL [cpu|warm|cold] [CPU_RATE]
// cold clears the origin's browser shader cache, not the GPU driver's cache.
// CPU_RATE is DevTools CPU throttling, not GPU/device emulation.
import { writeFile, mkdir } from 'node:fs/promises';
const [url='https://skyeshark.github.io/Eanpa-Sky/?automated=1',name='live-baseline',mode='cpu',rate='1'] = process.argv.slice(2);
if(!/^[a-z0-9_-]+$/i.test(name)||!['cpu','warm','cold'].includes(mode)||!Number.isFinite(Number(rate))||Number(rate)<1||Number(rate)>8)throw Error('Invalid profile settings');
if(!/^(http:\/\/127\.0\.0\.1:8378\/|https:\/\/skyeshark\.github\.io\/Eanpa-Sky\/)/.test(url)||!new URL(url).searchParams.has('automated'))throw Error('Use only automated inspection URLs');
const pages=(await fetch('http://127.0.0.1:9223/json/list').then(r=>r.json())).filter(t=>t.type==='page');
if(pages.length!==1||!(pages[0].url==='about:blank'||/^(http:\/\/127\.0\.0\.1:8378\/|https:\/\/skyeshark\.github\.io\/Eanpa-Sky\/)/.test(pages[0].url)))throw Error('Expected one owned page');
const socket=new WebSocket(pages[0].webSocketDebuggerUrl),pending=new Map();let id=0;
await new Promise((r,j)=>{socket.addEventListener('open',r,{once:true});socket.addEventListener('error',j,{once:true})});
const requests=new Map(),logs=[],errors=[];
socket.addEventListener('message',({data})=>{const m=JSON.parse(data);if(m.id){const p=pending.get(m.id);if(p){pending.delete(m.id);clearTimeout(p.timer);m.error?p.reject(Error(JSON.stringify(m.error))):p.resolve(m.result)}return;}
 const p=m.params;
 if(m.method==='Network.requestWillBeSent')requests.set(p.requestId,{url:p.request.url,method:p.request.method,type:p.type,start:p.timestamp,wallTime:p.wallTime});
 if(m.method==='Network.responseReceived'){const r=requests.get(p.requestId);if(r)Object.assign(r,{response:p.timestamp,status:p.response.status,fromDiskCache:p.response.fromDiskCache,fromServiceWorker:p.response.fromServiceWorker,timing:p.response.timing});}
 if(m.method==='Network.loadingFinished'){const r=requests.get(p.requestId);if(r)Object.assign(r,{end:p.timestamp,bytes:p.encodedDataLength});}
 if(m.method==='Network.loadingFailed'){const r=requests.get(p.requestId);if(r)r.error=p.errorText;}
 if(m.method==='Runtime.consoleAPICalled')logs.push({type:p.type,time:p.timestamp,text:p.args.map(a=>a.value??a.description).join(' ')});
 if(m.method==='Runtime.exceptionThrown')errors.push(p.exceptionDetails);
});
function send(method,params={}){return new Promise((resolve,reject)=>{const request=++id,timer=setTimeout(()=>{pending.delete(request);reject(Error(method+' timeout'))},55000);pending.set(request,{resolve,reject,timer});socket.send(JSON.stringify({id:request,method,params}));});}
async function evaluate(expression){const r=await send('Runtime.evaluate',{expression,returnByValue:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.text);return r.result.value;}
const source=`(()=>{
performance.setResourceTimingBufferSize(10000);
const p=globalThis.__startupProfile={stages:[],modules:[],pipelines:[],longTasks:[],done:false};
new PerformanceObserver(list=>{for(const e of list.getEntries())p.longTasks.push({start:e.startTime,duration:e.duration})}).observe({type:'longtask',buffered:true});
let last='';new MutationObserver(()=>{const boot=document.getElementById('boot');if(!boot)return;const text=boot.style.display==='none'?'ready':boot.textContent;if(text!==last){last=text;p.stages.push({text,at:performance.now()});if(text==='ready'){p.readyAt=performance.now();p.done=true;}}}).observe(document,{subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:['style']});
if(globalThis.GPUDevice){const prototype=GPUDevice.prototype;const modules=new WeakMap();
 const shader=prototype.createShaderModule;prototype.createShaderModule=function(d){const start=performance.now();const result=shader.call(this,d);const item={id:p.modules.length,start,ms:performance.now()-start,chars:d.code?.length,label:d.label};p.modules.push(item);modules.set(result,item.id);return result;};
 for(const key of ['createRenderPipeline','createRenderPipelineAsync','createComputePipeline','createComputePipelineAsync']){const fn=prototype[key];prototype[key]=function(d){const start=performance.now(),item={key,start,label:d.label,vertex:modules.get(d.vertex?.module),fragment:modules.get(d.fragment?.module),compute:modules.get(d.compute?.module)};p.pipelines.push(item);const result=fn.call(this,d);item.callMs=performance.now()-start;if(result?.then)result.then(()=>item.readyMs=performance.now()-start,()=>item.failed=true);return result;};}
}
})();`;
await mkdir('.artifacts/startup',{recursive:true});let script;
try{
 await send('Network.enable');await send('Runtime.enable');await send('Page.enable');
 await send('Network.setCacheDisabled',{cacheDisabled:mode!=='warm'});
 await send('Emulation.setCPUThrottlingRate',{rate:Number(rate)});
 if(mode==='cold')await send('Storage.clearDataForOrigin',{origin:new URL(url).origin,storageTypes:'shader_cache'});
 script=await send('Page.addScriptToEvaluateOnNewDocument',{source});
 if(mode==='cpu'){await send('Profiler.enable');await send('Profiler.setSamplingInterval',{interval:2000});await send('Profiler.start');}
 await send('Page.navigate',{url});
 const deadline=Date.now()+15*60_000;let state,lastStage='';
 while(Date.now()<deadline){await new Promise(r=>setTimeout(r,1500));
  try{state=await evaluate('({uptime:performance.now(),stages:globalThis.__startupProfile?.stages,done:globalThis.__startupProfile?.done,frames:globalThis._eanpaTest?.completedFrames})');}catch(e){console.log(e.message);continue;}
  const stage=state.stages?.at(-1)?.text;if(stage!==lastStage){lastStage=stage;console.log(JSON.stringify(state));}
  if(state.done && state.frames>2)break;
 }
 const snapshot=await evaluate('(()=>{if(globalThis._eanpaTest)_eanpaTest.paused=true;return {profile:globalThis.__startupProfile,warmup:globalThis._shaderWarmupStats,frames:globalThis._eanpaTest?.completedFrames,settings:{viewport:[innerWidth,innerHeight],devicePixelRatio,sky:document.getElementById("skybox")?.value,clouds:document.getElementById("cloud-type")?.value,weather:document.getElementById("weather")?.value,quality:document.getElementById("quality")?.value},errorText:[...document.body.children].filter(e=>e.style?.zIndex==="99").map(e=>e.textContent).filter(Boolean),resources:performance.getEntriesByType("resource").map(e=>({name:e.name,start:e.startTime,end:e.responseEnd,bytes:e.transferSize,duration:e.duration})),heap:performance.memory?.usedJSHeapSize}})()');
 if(mode==='cpu'){const {profile}=await send('Profiler.stop');await writeFile('.artifacts/startup/'+name+'.cpuprofile',JSON.stringify(profile));}
 // Keep canceled requests visible in the artifact. A 200 HEAD has no body;
 // streamed GETs can also report cancellation after Resource Timing records
 // their transfer. Distinguish those from missing/failed asset responses.
 const completedCancellations=[...requests.values()].filter(r=>r.status===200&&r.error==='net::ERR_ABORTED'
  &&(r.method==='HEAD'||snapshot.resources.some(e=>e.name===r.url&&e.end>e.start&&e.bytes>0)));
 const completedCancellationSet=new Set(completedCancellations);
 const failedRequests=[...requests.values()].filter(r=>r.status>=400
  ||(r.error&&!completedCancellationSet.has(r)));
 const valid=!snapshot.errorText.length&&!snapshot.profile?.pipelines.some(p=>p.failed)&&!errors.length&&!failedRequests.length&&snapshot.profile?.done===true;
 const result={url,mode,valid,cpuThrottleRate:Number(rate),httpCacheDisabled:mode!=='warm',
  shaderCache:mode==='cold'?'browser shader cache cleared via CDP; driver cache uncontrolled':'not cleared',
  recordedAt:new Date().toISOString(),...snapshot,requests:[...requests.values()],failedRequests,completedCancellations,logs,errors};
 await writeFile('.artifacts/startup/'+name+'.json',JSON.stringify(result,null,2));
 if(!valid){console.error('Invalid startup: browser or GPU errors. See artifact.');process.exitCode=1;}
 console.log(JSON.stringify({name,stages:snapshot.profile?.stages,warmup:snapshot.warmup,modules:snapshot.profile?.modules.length,pipelines:snapshot.profile?.pipelines.length,requests:requests.size,bytes:[...requests.values()].reduce((sum,r)=>sum+(r.bytes??0),0),errors:errors.length}));
}finally{if(script)await send('Page.removeScriptToEvaluateOnNewDocument',{identifier:script.identifier}).catch(()=>{});await send('Emulation.setCPUThrottlingRate',{rate:1}).catch(()=>{});await send('Network.setCacheDisabled',{cacheDisabled:false}).catch(()=>{});for(const p of pending.values())clearTimeout(p.timer);socket.close();}
