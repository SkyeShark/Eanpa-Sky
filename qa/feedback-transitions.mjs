// UI changes, including completed clear transitions and interrupted fronts.
// Connect to the one owned page; never launch a browser from a QA script.
import {connect} from './cdp.mjs';
import {mkdir,writeFile} from 'node:fs/promises';
const label=process.argv[2]??'feedback';
if(!/^[a-z0-9_-]+$/i.test(label))throw new Error('Invalid label');
const c=await connect(),samples=[];
const wait=ms=>new Promise(done=>setTimeout(done,ms));
try{
  await c.evaluate(`(()=>{
    _eanpaTest.paused=false;_eanpaTest.pauseAfterFrame=false;
    globalThis._switchBuilds=[];globalThis._switchRestores=[];
    for(const key of ['createRenderPipeline','createRenderPipelineAsync']){
      const owner=GPUDevice.prototype,original=owner[key];
      owner[key]=function(...args){const t=performance.now();const stage=_frameStage;
        const done=()=>_switchBuilds.push({method:key,ms:performance.now()-t,stage,label:args[0]?.label});
        const result=original.apply(this,args);if(key.endsWith('Async'))return result.finally(done);done();return result;};
      _switchRestores.push(()=>owner[key]=original);
    }
    _benchmark.start({purpose:'Weather/cloud switch responsiveness'});
  })()`);
  // Start settled, then use the actual change handlers. A short transition
  // duration lets this stress every endpoint as well as rapid retargeting.
  const cases=[['weather','none'],['cloud-type','clear'],['cloud-type','cirrus'],
    ['cloud-type','cumulus'],['cloud-type','stratus'],['weather','sunshower'],
    ['weather','rain'],['weather','overcast'],['weather','storm'],
    ['weather','cyclone'],['weather','darkstorm'],['weather','fair'],['weather','none'],['cloud-type','clear']];
  for(const [id,value]of cases){
    const start=Date.now();
    const before=await c.evaluate('_eanpaTest.completedFrames');
    await c.evaluate(`(()=>{const e=document.getElementById(${JSON.stringify(id)});e.value=${JSON.stringify(value)};
      e.dispatchEvent(new Event('change',{bubbles:true}));
      const w=__eanpaWeatherByScene.get(_c.parent);if(w?._trans)w._trans.dur=1.5;
    })()`);
    await wait(3800);
    const result=await c.evaluate(`({frames:_eanpaTest.completedFrames,failures:_eanpaTest.failedFrames??0,
      stage:_frameStage,preset:_sky.state.preset,transition:_weather.diagnostics.transition,
      builds:_switchBuilds.splice(0),pointerLocked:!!document.pointerLockElement})`);
    const row={id,value,wallMs:Date.now()-start,frameDelta:result.frames-before,...result};
    samples.push(row);console.log(JSON.stringify(row));
    if(!row.frameDelta||row.failures||row.pointerLocked)throw new Error('Frame progress/interaction failure');
  }
  const frames=await c.evaluate('_benchmark.stop()');
  await mkdir('artifacts/feedback-20260908',{recursive:true});
  await writeFile(`artifacts/feedback-20260908/${label}-transitions.json`,JSON.stringify({samples,frames},null,2));
  console.log(JSON.stringify({summary:frames.frameIntervalMs}));
}finally{
  await c.evaluate('(()=>{for(const restore of _switchRestores??[])restore()})()').catch(()=>{});
  c.close();
}
