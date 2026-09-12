// Inspect the full demonstration with the existing owned headless page.
import {connect} from './cdp.mjs';
import {mkdir,writeFile} from 'node:fs/promises';
const c=await connect(),out='qa/review/performance-cloud-motion',errors=[],records=[],started=Date.now();
const inspect=`({ready:document.getElementById('boot')?.style.display==='none',
 quality:document.getElementById('quality')?.value,mode:globalThis._spatialClouds?.mode,
 capture:globalThis._spatialClouds?.captureStats,frames:globalThis._eanpaTest?.completedFrames,
 time:globalThis._sky?.uniforms?.time.value,warmup:globalThis._shaderWarmupStats,
 stage:globalThis._frameStage,progress:document.getElementById('boot-status')?.textContent,
 errors:[...document.body.children].filter(e=>e.style?.zIndex==='99').map(e=>e.textContent).join(''),
 pointerLocked:!!document.pointerLockElement,requests:globalThis._look?.pointerLockRequests,
 skies:[...document.getElementById('skybox').options].map(o=>o.value),
 tiers:[...document.getElementById('quality').options].map(o=>o.value)})`;
try{
 await mkdir(out,{recursive:true});await c.send('Runtime.enable');
 c.on('Runtime.consoleAPICalled',e=>{if(e.type==='error')errors.push(e.args.map(a=>a.value??a.description).join(' '));});
 c.on('Runtime.exceptionThrown',e=>errors.push(e.exceptionDetails.exception?.description??e.exceptionDetails.text));
 await c.send('Page.navigate',{url:'http://127.0.0.1:8378/?automated=1&benchmark=1&skybox=earth&tod=10.5&quality=performance&weather=none&cloud-type=cumulus'});
 let first=null,state;
 while(Date.now()-started<480000){
  await new Promise(done=>setTimeout(done,1000));
  state=await c.evaluate(inspect).catch(()=>null);if(!state)continue;
  if(state.errors||errors.length)throw new Error(JSON.stringify({state,errors}));
  if(state.ready&&!first){first={...state,bootMs:Date.now()-started};records.push({step:'first ready',...first});
   const shot=await c.send('Page.captureScreenshot',{format:'jpeg',quality:85,captureBeyondViewport:false});await writeFile(out+'/main-first.jpg',Buffer.from(shot.data,'base64'));
   console.log(JSON.stringify({step:'ready',bootMs:first.bootMs,captureAge:state.time-state.capture.publishedTime}));
  }
  if(first&&state.frames>first.frames+120&&state.capture.captures>=first.capture.captures+2)break;
 }
 if(!first||Date.now()-started>=480000)throw new Error('Standalone inspection timed out');
 await c.evaluate(`(async()=>{_eanpaTest.pauseAfterFrame=true;while(!_eanpaTest.paused)await new Promise(done=>setTimeout(done,10));})()`);
 state=await c.evaluate(inspect);records.push({step:'two subsequent publications',...state});
 const image=await c.send('Page.captureScreenshot',{format:'jpeg',quality:85,captureBeyondViewport:false});await writeFile(out+'/main.jpg',Buffer.from(image.data,'base64'));
 const pass=records.every(s=>s.ready&&!s.errors&&!s.pointerLocked&&s.requests===0&&s.tiers.length===3&&s.skies.length===3
  &&s.quality==='performance'&&s.capture.distanceReprojection&&s.capture.failures===0)&&errors.length===0;
 await writeFile(out+'/main-integration.json',JSON.stringify({pass,date:new Date().toISOString(),errors,records},null,2)+'\n');
 console.log(JSON.stringify({pass,bootMs:first.bootMs,publications:state.capture.captures,frames:state.frames,errors}));
 if(!pass)process.exitCode=1;
}finally{c.close();}
