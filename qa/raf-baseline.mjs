// Measure browser scheduling separately from engine throughput, in the single
// owned page. Use after engine measurements: this navigates away from the sky.
import {connect} from './cdp.mjs';
import {mkdir,writeFile} from 'node:fs/promises';
const directory='.artifacts/performance-balanced-20260912';
await mkdir(directory,{recursive:true});
await writeFile(`${directory}/empty.html`,'<!doctype html><meta charset="utf-8"><title>Owned QA scheduling baseline</title>');
const c=await connect();
try{
    const browser=await fetch('http://127.0.0.1:9223/json/version').then(r=>r.json());
    await c.send('Emulation.setCPUThrottlingRate',{rate:1});
    await c.send('Page.navigate',{url:`http://127.0.0.1:8378/${directory}/empty.html`});
    await new Promise(r=>setTimeout(r,1000));
    const result=await c.evaluate(`(async()=>{
        if(document.title!=='Owned QA scheduling baseline'||globalThis.__skyFixture)throw Error('Expected empty QA page');
        const times=[],started=performance.now();
        await new Promise(done=>{function frame(){const now=performance.now();times.push(now);if(now-started>=30000)done();else requestAnimationFrame(frame);}requestAnimationFrame(frame);});
        const intervalsMs=times.slice(1).map((t,i)=>t-times[i]);
        const total=intervalsMs.reduce((a,b)=>a+b,0),sorted=[...intervalsMs].sort((a,b)=>a-b);
        return {date:new Date().toISOString(),samples:intervalsMs.length,actualSeconds:total/1000,
            fps:intervalsMs.length*1000/total,meanMs:total/intervalsMs.length,p95Ms:sorted[Math.floor(sorted.length*.95)],
            viewport:[innerWidth,innerHeight],intervalsMs};
    })()`);
    result.browser={version:browser.Browser,protocol:browser['Protocol-Version'],javascript:browser['V8-Version'],userAgent:browser['User-Agent']};
    result.method='30 seconds of requestAnimationFrame on an empty page in the same owned headless browser, unthrottled; measured after engine tests. Scheduling context only, not an engine result.';
    await writeFile(`${directory}/raf-baseline.json`,JSON.stringify(result,null,2));
    const {intervalsMs,...summary}=result;console.log(JSON.stringify(summary,null,2));
}finally{c.close();}
