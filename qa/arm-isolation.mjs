import { connect } from './cdp.mjs';
import { writeFile } from 'node:fs/promises';
const cdp=await connect(), prefix=process.argv[2]??'arms';
let ao;
try {
    ao=await cdp.evaluate(`(async()=>{
        _eanpaTest.paused=false;_eanpaTest.pauseAfterFrame=true;
        while(!_eanpaTest.paused)await new Promise(r=>setTimeout(r,20));
        return _reflectionPipeline.aoEnabled;
    })()`);
    for(const [name,enabled,ssr] of [['normal',ao,true],['no-ao',false,true],['no-ssr',ao,false],['native-no-ao',false,false]]){
        await cdp.evaluate(`(async()=>{
            _reflectionPipeline.setAOEnabled(${enabled});
            _reflectionPipeline.setAuditContributions({ssr:${ssr},sky:true});
            await _reflectionPipeline.render();
        })()`);
        const shot=await cdp.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
        await writeFile(`artifacts/overhaul/${prefix}-${name}.png`,Buffer.from(shot.data,'base64'));
    }
    const data=await cdp.evaluate(`(async()=>{
        const p=_reflectionPipeline,r=p.pipeline.renderer,t=p.scenePass.renderTarget,rows=[];
        for(const point of [[450,750],[1160,750]]){
            const row={point};
            for(let attachment=0;attachment<4;attachment++){
                const values=await r.readRenderTargetPixelsAsync(t,...point,1,1,attachment);
                row[attachment]=Array.from(values,x=>values instanceof Uint16Array?THREE.DataUtils.fromHalfFloat(x):x/255);
            }
            rows.push(row);
        }
        const arms=[];
        _c.traverse(o=>{if(o.isMesh)arms.push({name:o.name,type:o.material.type,
            env:o.material.envMap?.name,envIntensity:o.material.envMapIntensity,
            mrt:!!o.material.mrtNode,version:o.material.version,lights:o.material.lightsNode?.getLights?.().map(l=>l.name)});});
        const pass=rows.every(row=>Math.abs(Math.hypot(...row[1].slice(0,3).map(x=>x*2-1))-1)<.02
            &&row[0].every(Number.isFinite)&&row[2][0]>.8);
        return {pass,rows,arms};
    })()`);
    console.log(JSON.stringify(data,null,2));
    await writeFile(`artifacts/overhaul/${prefix}.json`,JSON.stringify(data,null,2));
    if(!data.pass)throw new Error('Arm receiver lost its finite unit normal');
} finally {
    if(ao!==undefined)await cdp.evaluate(`_reflectionPipeline.setAOEnabled(${ao})`).catch(()=>{});
    await cdp.evaluate('_reflectionPipeline.setAuditContributions({ssr:true,sky:true});_eanpaTest.paused=false').catch(()=>{});
    cdp.close();
}
