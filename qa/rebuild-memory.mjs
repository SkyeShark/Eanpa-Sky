import { connect } from './cdp.mjs';
import { writeFile } from 'node:fs/promises';
const cdp=await connect(),records=[];
const suffix=process.argv[2]??'';
if(suffix&&!/^[a-z0-9_-]+$/i.test(suffix))throw new Error('Invalid artifact suffix');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
try{
    await cdp.evaluate('_eanpaTest.pauseAfterFrame=false;_eanpaTest.paused=false');
    for(const quality of ['balanced','high','balanced','performance','balanced','high','balanced']){
        await cdp.evaluate(`(() => {
            const e=document.getElementById('quality');if(e.value===${JSON.stringify(quality)})return;
            e.value=${JSON.stringify(quality)};e.dispatchEvent(new Event('change',{bubbles:true}));
        })()`);
        const end=Date.now()+240000;
        while(!await cdp.evaluate("document.getElementById('boot').style.display==='none'")){
            if(Date.now()>end)throw new Error('Rebuild timed out');await sleep(500);
        }
        await sleep(3500);
        const record=await cdp.evaluate(`({quality:document.getElementById('quality').value,
            memory:_reflectionPipeline.pipeline.renderer.info.memory,environment:_filteredEnvironment.stats,
            rebuildResources:globalThis._rebuildResources?.stats,
            errors:[...document.body.children].find(e=>e.style?.zIndex==='99')?.textContent,
            pointerLocked:!!document.pointerLockElement})`);
        if(record.errors||record.pointerLocked)throw new Error(JSON.stringify(record));
        records.push(record);console.log(JSON.stringify(record));
    }
    const steady=records.filter(r=>r.quality==='balanced').slice(1);
    const range=key=>Math.max(...steady.map(r=>r.memory[key]))-Math.min(...steady.map(r=>r.memory[key]));
    const pass=['renderTargets','textures','geometries','attributes','indexAttributes','attributesSize']
        .every(key=>range(key)===0);
    await writeFile('artifacts/overhaul/rebuild-memory'+(suffix?'-'+suffix:'')+'.json',JSON.stringify({pass,records},null,2));
    if(!pass)throw new Error('Repeated Balanced rebuilds retained GPU resources');
}finally{cdp.close();}
