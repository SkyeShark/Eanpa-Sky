import { connect } from './cdp.mjs';
import { writeFile, mkdir } from 'node:fs/promises';
const [name='current', rate='4'] = process.argv.slice(2);
const cdp = await connect();
try {
    await cdp.send('Emulation.setCPUThrottlingRate',{rate:Number(rate)});
    await new Promise(r=>setTimeout(r,3000));
    await cdp.send('Profiler.enable');
    await cdp.send('Profiler.setSamplingInterval',{interval:1000});
    await cdp.send('Profiler.start');
    await new Promise(r=>setTimeout(r,8000));
    const {profile}=await cdp.send('Profiler.stop');
    await mkdir('artifacts/overhaul/profiles',{recursive:true});
    await writeFile(`artifacts/overhaul/profiles/${name}.cpuprofile`,JSON.stringify(profile));
    const nodes=new Map(profile.nodes.map(n=>[n.id,n]));
    const own=new Map();
    for(let i=0;i<profile.samples.length;i++){
        const id=profile.samples[i];own.set(id,(own.get(id)??0)+(profile.timeDeltas?.[i]??1000));
    }
    const top=[...own].map(([id,time])=>({timeMs:time/1000,...nodes.get(id).callFrame}))
        .sort((a,b)=>b.timeMs-a.timeMs).slice(0,35);
    console.log(JSON.stringify(top,null,2));
} finally {
    await cdp.send('Profiler.disable').catch(()=>{});
    await cdp.send('Emulation.setCPUThrottlingRate',{rate:1}).catch(()=>{});cdp.close();
}
