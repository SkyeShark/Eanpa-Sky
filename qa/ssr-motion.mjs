import { connect } from './cdp.mjs';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
const cdp=await connect();
const trace=await readFile(new URL('./trace-ssr-hits.js',import.meta.url),'utf8');
const prefix=process.argv[2]??'orb';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
try{
    await cdp.evaluate(await readFile(new URL('./orb-view.js',import.meta.url),'utf8'));
    await mkdir('artifacts/overhaul/ssr-motion',{recursive:true});
    const records=[];
    for(let i=0;i<13;i++){
        const x=Math.sin(i/12*Math.PI*2)*1.5, yaw=x*.046;
        await cdp.evaluate(`_c.position.x=${x};_look.yaw=${yaw};_look.pitch=.34;_eanpaTest.paused=false;`);
        await sleep(180);
        const shot=await cdp.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
        await writeFile(`artifacts/overhaul/ssr-motion/${prefix}-${String(i).padStart(2,'0')}.png`,Buffer.from(shot.data,'base64'));
        if(i%3===0){
            const r=await cdp.evaluate(trace);records.push({pose:i,x,yaw,...r});
            if(r.selfHits)throw new Error(`Convex self reflection at pose ${i}`);
            console.log(`Pose ${i}: ${r.convexHits} orb → scene hits, ${r.hitsOnConvex} scene → orb hits, ${r.selfHits} self hits`);
        }
    }
    if(!records.some(r=>r.convexHits>100&&r.hitsOnConvex>0))throw new Error('Missing positive reflection control');
    await writeFile(`artifacts/overhaul/ssr-motion/${prefix}.json`,JSON.stringify(records,null,2));
}finally{await cdp.evaluate('_eanpaTest.paused=false').catch(()=>{});cdp.close();}
