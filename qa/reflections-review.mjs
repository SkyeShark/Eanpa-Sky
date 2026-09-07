import {connect} from './cdp.mjs';
import {readFile,writeFile,mkdir} from 'node:fs/promises';

const c=await connect(),directory='artifacts/overhaul/reflection-review';
await mkdir(directory,{recursive:true});
const capture=async name=>{
    const shot=await c.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
    await writeFile(`${directory}/${name}.png`,Buffer.from(shot.data,'base64'));
};
try {
    await c.evaluate(await readFile('qa/reflection-failure-view.js','utf8'));
    await c.evaluate(`(async()=>{
        if(globalThis.__reflectionFixture)__reflectionFixture.visible=false;
        _reflectionPipeline.setAuditContributions();
        _reflectionPipeline.localProbe.configure({sampleGroundHeight:(x,z)=>_temple.walkSurfaceAt(x,z)?.height??_terrain.heightAt(x,z)});
        for(let i=0;i<12;i++){
            await new Promise(requestAnimationFrame);
            await _reflectionPipeline.render();
        }
    })()`);
    await capture('orb-combined');
    for(const [name,settings]of [['orb-sky',{ssr:false,sky:true,probe:false}],
        ['orb-local-probe',{ssr:false,sky:false,probe:true}],['orb-ssr',{ssr:true,sky:false,probe:false}]]) {
        await c.evaluate(`(async()=>{_reflectionPipeline.setAuditContributions(${JSON.stringify(settings)});await new Promise(requestAnimationFrame);await _reflectionPipeline.render()})()`);
        await capture(name);
    }
    await c.evaluate('_reflectionPipeline.setAuditContributions();');
    for(let i=0;i<16;i++) {
        const phase=i/15*Math.PI*2;
        await c.evaluate(`(async()=>{
            _c.position.set(${.7*Math.sin(phase)},${24.5+.3*Math.cos(phase)},${-66.8+.2*Math.cos(phase)});
            _c.rotation.set(${.17+.03*Math.cos(phase)},${.06*Math.sin(phase)},0);_c.updateMatrixWorld(true);
            const orb=_c.parent.getObjectByName('authored_inanna_orb_pivot');orb.rotation.y=${-.7+i*.035};orb.updateMatrixWorld(true);
            await new Promise(requestAnimationFrame);
            await _reflectionPipeline.render();
        })()`);
        if(i%4===0||i===15)await capture(`orb-motion-${String(i).padStart(2,'0')}`);
    }
    const result=await c.evaluate(`({date:new Date().toISOString(),mode:_reflectionPipeline.mode,
        implementation:_reflectionPipeline.ssrImplementation,probe:_reflectionPipeline.localProbe.stats,
        camera:_c.position.toArray(),pointerLocked:!!document.pointerLockElement,
        errors:[...document.body.children].filter(e=>e.style?.zIndex==='99').map(e=>e.textContent).join('')})`);
    await writeFile(`${directory}/metadata.json`,JSON.stringify(result,null,2));
    console.log(JSON.stringify(result));
    if(result.errors)throw new Error('Render errors recorded; visual review invalid');
}finally{c.close()}
