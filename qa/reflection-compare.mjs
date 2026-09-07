import {connect} from './cdp.mjs';
import {writeFile,mkdir} from 'node:fs/promises';
const cdp=await connect();
const prefix=process.argv[2]??'orb';
try {
    await cdp.evaluate(`(async()=>{_eanpaTest.pauseAfterFrame=true;_eanpaTest.paused=false;
        while(!_eanpaTest.paused) await new Promise(r=>setTimeout(r,30));})()`);
    await mkdir('artifacts/overhaul',{recursive:true});
    for(const [name,ssr,sky] of [['combined',true,true],['sky-only',false,true],['local-only',true,false]]){
        await cdp.evaluate(`(async()=>{_reflectionPipeline.setAuditContributions({ssr:${ssr},sky:${sky}});await _reflectionPipeline.render();})()`);
        await new Promise(r=>setTimeout(r,300));
        const shot=await cdp.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
        await writeFile(`artifacts/overhaul/${prefix}-${name}.png`,Buffer.from(shot.data,'base64'));
        console.log(name);
    }
}finally{
    await cdp.evaluate('_reflectionPipeline.setAuditContributions({ssr:true,sky:true});_eanpaTest.paused=false;').catch(()=>{});
    cdp.close();
}
