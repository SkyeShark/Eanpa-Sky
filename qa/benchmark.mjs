import { connect } from './cdp.mjs';
import { mkdir, writeFile } from 'node:fs/promises';
const [name='current',seconds='30',rate='1']=process.argv.slice(2);
const cdp=await connect();
try {
    await cdp.send('Emulation.setCPUThrottlingRate',{rate:Number(rate)});
    const metadata=await cdp.evaluate(`({date:new Date().toISOString(),skybox:document.getElementById('skybox').value,
        clouds:document.getElementById('cloud-type').value,weather:document.getElementById('weather').value,
        hours:document.getElementById('tod').value,quality:document.getElementById('quality').value,
        canvas:[document.getElementById('view').width,document.getElementById('view').height],
        camera:_c.position.toArray(),look:{yaw:_look.yaw,pitch:_look.pitch},
        ready:document.getElementById('boot').style.display==='none',pointerLocked:!!document.pointerLockElement})`);
    if(!metadata.ready||metadata.pointerLocked)throw new Error('Preview not ready for capture');
    metadata.cpuThrottleRate=Number(rate); metadata.gpu='NVIDIA GeForce RTX 5090 Laptop GPU, 24GB';
    await cdp.evaluate(`_eanpaTest.paused=false;_benchmark.start(${JSON.stringify(metadata)});`);
    await new Promise(r=>setTimeout(r,Number(seconds)*1000));
    const result=await cdp.evaluate('_benchmark.stop()');
    result.errors=await cdp.evaluate(`[...document.body.children].find(e=>e.style?.zIndex==='99')?.textContent`);
    await mkdir('artifacts/overhaul/benchmarks',{recursive:true});
    await writeFile(`artifacts/overhaul/benchmarks/${name}.json`,JSON.stringify(result,null,2));
    const {intervalsMs,...summary}=result; console.log(JSON.stringify(summary,null,2));
}finally{await cdp.send('Emulation.setCPUThrottlingRate',{rate:1}).catch(()=>{});cdp.close();}
