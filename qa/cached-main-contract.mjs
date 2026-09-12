// Full-demo integration and quality replacement in the single owned page.
import {connect} from './cdp.mjs';
import {writeFile,mkdir} from 'node:fs/promises';
const c=await connect(),out='qa/review/cached-performance',records=[];
const inspect=`({ready:document.getElementById('boot')?.style.display==='none',
 quality:document.getElementById('quality')?.value,mode:globalThis._spatialClouds?.mode,
 capture:globalThis._spatialClouds?.captureStats,frames:globalThis._eanpaTest?.completedFrames,
 warmup:globalThis._shaderWarmupStats,
 weatherTransition:globalThis._weather?.diagnostics?.transition,
 errors:[...document.body.children].filter(e=>e.style?.zIndex==='99').map(e=>e.textContent).join(''),
 pointerLocked:!!document.pointerLockElement,requests:globalThis._look?.pointerLockRequests,
 skies:[...document.getElementById('skybox').options].map(o=>o.value),
 tiers:[...document.getElementById('quality').options].map(o=>o.value)})`;
const waitFor=async predicate=>{
 const deadline=Date.now()+240000;
 while(Date.now()<deadline){
  const state=await c.evaluate(inspect);
  if(state.errors)throw Error(state.errors);
  if(predicate(state))return state;
  await new Promise(done=>setTimeout(done,500));
 }
 throw Error('Demo state timed out');
};
const shot=async name=>{
 await c.evaluate(`(async()=>{_eanpaTest.pauseAfterFrame=true;while(!_eanpaTest.paused)await new Promise(done=>setTimeout(done,10));})()`);
 const image=await c.send('Page.captureScreenshot',{format:'jpeg',quality:88,captureBeyondViewport:false});
 await writeFile(`${out}/${name}.jpg`,Buffer.from(image.data,'base64'));
 await c.evaluate('_eanpaTest.pauseAfterFrame=false;_eanpaTest.paused=false;');
};
try{
 await mkdir(out,{recursive:true});
 let state=await waitFor(s=>s.ready&&s.quality==='performance'&&s.capture?.captures>=2);
 records.push({step:'initial rain',...state});await shot('main-rain');
 for(const quality of ['balanced','performance']){
  const before=state.frames;
  await c.evaluate(`(()=>{const e=document.getElementById('quality');e.value=${JSON.stringify(quality)};e.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  state=await waitFor(s=>s.ready&&s.quality===quality&&s.frames>before+60
   &&s.mode===(quality==='performance'?'banded-world-direction-cloud-panorama':'spatial-current-frame-sky'));
  records.push({step:`switch to ${quality}`,...state});console.log(JSON.stringify(records.at(-1)));
 }
 await c.evaluate(`(()=>{for(const [id,value]of [['weather','none'],['cloud-type','cumulus']]){
  const e=document.getElementById(id);e.value=value;e.dispatchEvent(new Event('change',{bubbles:true}));}})()`);
 const captures=state.capture.captures;
 state=await waitFor(s=>s.ready&&s.weatherTransition?.active===false&&s.capture?.captures>captures+1);
 const settled=state.capture.captures;
 state=await waitFor(s=>s.ready&&s.capture?.captures>settled+1);
 records.push({step:'cumulus after the rain transition finishes',...state});await shot('main-day');
 const pass=records.every(s=>!s.errors&&!s.pointerLocked&&s.requests===0&&s.tiers.length===3&&s.skies.length===3);
 await writeFile(`${out}/main-integration.json`,JSON.stringify({pass,date:new Date().toISOString(),records},null,2)+'\n');
 if(!pass)throw Error('Demo integration contract failed');
 console.log(JSON.stringify({pass,steps:records.length}));
}finally{c.close();}
