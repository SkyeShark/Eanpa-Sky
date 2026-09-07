// Compare the shadow cache using the same current code, scene and quality.
import { connect } from './cdp.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile } from 'node:fs/promises';
const run=promisify(execFile),cdp=await connect();
const reports=[];
try{
    const stateSource=await readFile('qa/state.js','utf8');
    const deadline=Date.now()+240000;
    while(true){
        const s=await cdp.evaluate(stateSource);
        if(s.errors||s.pointerLocked)throw new Error(JSON.stringify(s));
        if(s.controls.skybox.value!=='earth'||s.controls.quality.value!=='balanced'
            ||s.controls.weather.value!=='none'||s.controls['cloud-type'].value!=='cumulus'
            ||Number(s.controls.tod.value)!==10.5)throw new Error('Expected Earth/Balanced/Cumulus/None at 10.5h');
        if(s.ready&&!s.weather?.active&&!s.transition?.active)break;
        if(Date.now()>deadline)throw new Error('Scene did not settle');
        await new Promise(r=>setTimeout(r,1000));
    }
    await cdp.evaluate(await readFile('qa/reset-view.js','utf8'));
    await cdp.evaluate(`(() => {
        const r=_reflectionPipeline.pipeline.renderer;
        if(!String(r.renderObject).includes('getVariant'))throw new Error('Expected shadow cache');
        globalThis.__qaShadowRenderObject=r.renderObject;
    })()`);
    for(const cached of [false,true]){
        await cdp.evaluate(`_reflectionPipeline.pipeline.renderer.renderObject=${cached
            ?'__qaShadowRenderObject':'Object.getPrototypeOf(_reflectionPipeline.pipeline.renderer).renderObject'};`);
        const stem=cached?'earth-shadow-cache-enabled':'earth-shadow-cache-disabled';
        let report;
        for(let attempt=1;attempt<=3;attempt++){
            const name=attempt===1?stem:`${stem}-retry${attempt}`;
            let result;
            try{result=await run(process.execPath,['qa/benchmark.mjs',name,'30','1'],{windowsHide:true,maxBuffer:8*1024*1024});}
            catch(error){
                if(!String(error).includes('GPU contention before capture')||attempt===3)throw error;
                await new Promise(r=>setTimeout(r,5000));continue;
            }
            console.log(result.stdout.trim());
            report=JSON.parse(await readFile(`artifacts/overhaul/benchmarks/${name}.json`,'utf8'));
            if(report.valid)break;
        }
        if(!report?.valid)throw new Error('Shadow comparison has no clean benchmark');
        reports.push({cached,report});
    }
    await writeFile('artifacts/overhaul/shadow-cache-benchmark.json',JSON.stringify(reports,null,2));
}finally{
    await cdp.evaluate(`if(globalThis.__qaShadowRenderObject){
        _reflectionPipeline.pipeline.renderer.renderObject=__qaShadowRenderObject;delete globalThis.__qaShadowRenderObject;
    }_eanpaTest.paused=false;`).catch(()=>{});
    await cdp.send('Emulation.setCPUThrottlingRate',{rate:1}).catch(()=>{});
    cdp.close();
}
