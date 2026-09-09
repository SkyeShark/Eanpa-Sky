// Matched distant-cloud visibility and actual daylight-path checks in one page.
import {connect} from './cdp.mjs';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir,writeFile} from 'node:fs/promises';
const run=promisify(execFile),c=await connect(),directory='artifacts/feedback-20260908';
const view=async(name,cloud,hours,pose)=>run(process.execPath,
    ['qa/review-view.mjs',name,cloud,'none',String(hours),pose],{windowsHide:true,timeout:60000});
try{
    if(await c.evaluate("document.getElementById('skybox').value")!=='ringworld')throw new Error('Load Ringworld first');
    await mkdir(directory,{recursive:true});
    await view('feedback-ring-overhead','cumulus',10.5,'overhead');
    const images=[];
    for(const enabled of [true,false,true]){
        await c.evaluate(`(async()=>{
            for(const mesh of _ringworld.clouds.children)mesh.visible=${enabled};
            for(let i=0;i<4;i++){await new Promise(requestAnimationFrame);await _reflectionPipeline.render()}
            const target=_reflectionPipeline.skyLayers[0].target;
            const data=await _reflectionPipeline.pipeline.renderer.readRenderTargetPixelsAsync(target,0,0,target.width,target.height);
            (globalThis.__ringCloudReview??=[]).push(data);
        })()`);
        const name=`ring-sheet-${images.length}-${enabled?'on':'off'}.png`;
        const shot=await c.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
        await writeFile(`${directory}/${name}`,Buffer.from(shot.data,'base64'));images.push(name);
    }
    const checks=await c.evaluate(`(()=>{
        const [on,off,restored]=__ringCloudReview;delete globalThis.__ringCloudReview;
        let changed=0,restoreChanged=0,maxDifference=0;
        for(let i=0;i<on.length;i+=4){let delta=0,restoreDelta=0;
            for(let k=0;k<3;k++){
                delta=Math.max(delta,Math.abs(THREE.DataUtils.fromHalfFloat(on[i+k])-THREE.DataUtils.fromHalfFloat(off[i+k])));
                restoreDelta=Math.max(restoreDelta,Math.abs(THREE.DataUtils.fromHalfFloat(on[i+k])-THREE.DataUtils.fromHalfFloat(restored[i+k])));
            }
            if(delta>.001)changed++;if(restoreDelta>.001)restoreChanged++;maxDifference=Math.max(maxDifference,delta);
        }
        const savedHours=Number(document.getElementById('tod').value),samples=[];
        for(let step=0;step<=2400;step++){
            const hours=step/100;_sky.setTime(hours);
            samples.push({hours,visibility:_ringworld.eclipseK(_sky.sunDir,_c.position),sunY:_sky.sunDir.y});
        }
        _sky.setTime(savedHours);
        const eclipsed=samples.filter(s=>s.visibility<.99),total=samples.filter(s=>s.visibility<.01);
        return{pass:changed>100&&restoreChanged===0&&total.some(s=>s.hours===12)
            &&samples.every(s=>s.sunY>0||s.visibility===1),
            clouds:{changedPixels:changed,restoreChangedPixels:restoreChanged,maxLinearDifference:maxDifference,
                atlas:_ringworld.cloudField.stats,coverage:_ringworld.cloudUniforms.cover.value,density:_ringworld.cloudUniforms.dens.value},
            eclipse:{first:eclipsed[0],last:eclipsed.at(-1),totalFirst:total[0],totalLast:total.at(-1),samples}};
    })()`);
    await writeFile(`${directory}/ring-sky-checks.json`,JSON.stringify({...checks,images},null,2));
    console.log(JSON.stringify({...checks,eclipse:{...checks.eclipse,samples:undefined}}));
    await view('feedback-eclipse-before','clear',11.4,'ring');
    await view('feedback-eclipse-final','clear',12,'ring');
    await view('feedback-night-final','clear',0,'overhead');
    if(!checks.pass)process.exitCode=1;
}finally{
    await c.evaluate('for(const mesh of globalThis._ringworld?.clouds?.children??[])mesh.visible=true').catch(()=>{});
    c.close();
}
