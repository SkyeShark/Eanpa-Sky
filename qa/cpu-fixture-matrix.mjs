// Sequential before/after resource stress in the one owned browser. This uses
// only the reusable engine fixture, never the demonstration's imported assets.
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
const run=promisify(execFile),directory='artifacts/cpu-optimization-20260910';
const tiers=(process.argv[2]??'performance,balanced,high').split(',');
if(tiers.some(t=>!['performance','balanced','high'].includes(t)))throw new Error('Invalid quality tier');
await mkdir(directory,{recursive:true});
const rows=[];
for(const tier of tiers)for(const variant of ['baseline','current']){
    const name=`fixture-${tier}-${variant}`;
    console.log(`Preparing ${tier} / ${variant}`);
    const boot=await run(process.execPath,['qa/cpu-variant.mjs',name,variant,
        `/qa/sky-fixture.html?sky=earth&quality=${tier}&weather=rain`,'8','1'],{windowsHide:true,maxBuffer:5e6});
    await writeFile(`${directory}/${name}-boot.log`,boot.stdout);
    const source=JSON.parse(await readFile(`${directory}/${name}.json`,'utf8'));
    for(const level of ['native','moderate','limited']){
        const capture=await run(process.execPath,['qa/sky-benchmark.mjs',name,level,'10'],{windowsHide:true,maxBuffer:5e6});
        await writeFile(`${directory}/${name}-${level}.log`,capture.stdout);
        const result=JSON.parse(await readFile(`artifacts/feedback-20260909/benchmarks/${name}-${level}.json`,'utf8'));
        // The old variant stays in the loaded page after source interception is
        // removed. Record its actual sources, rather than claiming current HEAD.
        Object.assign(result,{sourceVariant:variant,sourceRevision:variant==='baseline'?source.baseline:source.revision,
            sourceSha256:source.sourceSha256,workingTreeRevision:source.revision});
        await writeFile(`${directory}/${name}-${level}.json`,JSON.stringify(result,null,2));
        const row={tier,variant,level,fps:result.fps,p95Ms:result.p95Ms,
            cpuTaskMsPerFrameAtNative:source.cpuTaskMsPerFrame,
            cleanCpuWindow:result.cleanCpuWindow,cleanGpuWindow:result.cleanGpuWindow,
            errors:result.errors,environmentCaptures:result.environment.capturesDuringRun};
        rows.push(row);await writeFile(`${directory}/fixture-matrix.json`,JSON.stringify(rows,null,2));
        console.log(JSON.stringify(row));
        if(result.errors.length||!result.frames||result.environment.capturesDuringRun<1)throw new Error('Incomplete fixture validation');
    }
}
