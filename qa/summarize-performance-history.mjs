// Archive the complete old/new comparison. Run only after all measurements.
import {readFile,writeFile,mkdir,copyFile} from 'node:fs/promises';
import {gzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
const series='performance-history-20260912',directory=`qa/benchmarks/${series}`;
const sum=xs=>xs.reduce((a,b)=>a+b,0),mean=xs=>sum(xs)/xs.length;
const hash=b=>createHash('sha256').update(b).digest('hex');
const percentile=(xs,p)=>[...xs].sort((a,b)=>a-b)[Math.floor((xs.length-1)*p)];
const git=['-c',`safe.directory=${process.cwd().replaceAll('\\','/')}`];
const gitText=(...args)=>execFileSync('git',[...git,...args],{encoding:'utf8',windowsHide:true}).trim();
if(gitText('diff','HEAD','--','src','engine','vendor'))throw Error('Runtime changed during comparison');
const revisions={old:gitText('rev-parse','31a107f'),new:null};
await mkdir(`${directory}/raw`,{recursive:true});
const archives=[];
async function archive(path,name){
    const bytes=await readFile(path),gzip=gzipSync(bytes,{level:9});
    await writeFile(`${directory}/raw/${name}.json.gz`,gzip);
    archives.push({file:`raw/${name}.json.gz`,bytes:gzip.length,sha256:hash(gzip),uncompressedSha256:hash(bytes)});
    return JSON.parse(bytes);
}
const throughput=[],gpu=[],exploratoryGpu=[];
for(const profile of ['native','limited'])for(const label of ['old','new'])for(const repeat of [1,2]){
    const name=`${series}-${label}-r${repeat}-${profile}`;
    const r=await archive(`artifacts/feedback-20260909/benchmarks/${name}.json`,name);
    if(r.comparison.label!==label||r.errors.length||r.comparison.finalState.errors.length||r.size.join('x')!=='1920x1080'
        ||r.environment.capturesDuringRun!==1)throw Error('Invalid run '+name);
    if(r.quality.skySamples!==(label==='old'?20:64)||r.quality.cloudDiv!==(label==='old'?3:2))throw Error('Wrong quality preset '+name);
    if(label==='new'&&(r.cloudDisplay.capturesDuringRun<3||r.cloudDisplay.capture.failures))throw Error('Invalid cloud capture coverage '+name);
    throughput.push(r);
}
const aggregate=[];
for(const profile of ['native','limited'])for(const label of ['old','new']){
    const runs=throughput.filter(r=>r.profile.name===profile&&r.comparison.label===label),intervals=runs.flatMap(r=>r.intervalsMs);
    aggregate.push({profile,label,frames:intervals.length,seconds:sum(intervals)/1000,fps:1000/mean(intervals),
        meanMs:mean(intervals),medianMs:percentile(intervals,.5),p95Ms:percentile(intervals,.95),
        fpsRange:[Math.min(...runs.map(r=>r.fps)),Math.max(...runs.map(r=>r.fps))]});
}
const gains=['native','limited'].map(profile=>{
    const old=aggregate.find(r=>r.profile===profile&&r.label==='old'),current=aggregate.find(r=>r.profile===profile&&r.label==='new');
    return {profile,fpsPercent:(current.fps/old.fps-1)*100,frameMsSaved:old.meanMs-current.meanMs,
        frameTimePercentSaved:(1-current.meanMs/old.meanMs)*100};
});
for(const label of ['old','new']){
    const exploratoryName=`${series}-${label}-r1-gpu`,first=await archive(`artifacts/overhaul/benchmarks/${exploratoryName}.json`,exploratoryName);
    exploratoryGpu.push({label,summary:first.summary,gpuHardwareBefore:first.comparison.gpuHardwareBefore,gpuHardwareAfter:first.comparison.gpuHardwareAfter,
        includedInComparison:false,reason:'Unmonitored first pair crossed a large change in total GPU load and VRAM use: old 98% and about 17 GiB, new 37-45% and about 11 GiB. Repeated both with process counters instead of interpreting the first pair as a speedup.'});
    const name=`${series}-${label}-r2-gpu`,r=await archive(`artifacts/overhaul/benchmarks/${name}.json`,name),passes=new Map();
    if(r.comparison.label!==label||r.comparison.finalState.errors.length||r.actualSeconds<30||r.environmentCapturesDuringRun!==1)throw Error('Invalid GPU profile '+name);
    if(label==='new'&&r.cloudCapturesDuringRun<3)throw Error('Insufficient new cloud captures');
    for(const frame of r.records)for(const p of frame.passes){const key=p.label.replace(/#\d+/g,'');passes.set(key,(passes.get(key)??0)+p.ms/r.records.length);}
    gpu.push({label,seconds:r.actualSeconds,summary:r.summary,cloudCaptures:r.cloudCapturesDuringRun,environmentCaptures:r.environmentCapturesDuringRun,
        gpuHardwareBefore:r.comparison.gpuHardwareBefore,gpuHardwareAfter:r.comparison.gpuHardwareAfter,
        cleanGpu:r.comparison.gpuResources?.before.clean&&r.comparison.gpuResources?.during.clean,
        externalGpuBefore:r.comparison.gpuResources?.before.busy,externalGpuDuring:r.comparison.gpuResources?.during.busy,
        passes:[...passes].sort((a,b)=>b[1]-a[1]).map(([name,meanMs])=>({name,meanMs})),
        dedicatedCloudPassMs:sum([...passes].filter(([name])=>name.includes('eanpa_current_spatial_clouds')||name.includes('eanpa-cloud-panorama')).map(([,ms])=>ms))});
}
const runs=throughput.map(r=>({label:r.comparison.label,profile:r.profile.name,repeat:r.comparison.repeat,date:r.date,
    fps:r.fps,meanMs:1000/r.fps,p95Ms:r.p95Ms,cloudCaptures:r.cloudDisplay.capturesDuringRun,
    cleanCpu:r.cleanCpuWindow,cleanGpu:r.cleanGpuWindow,externalCpuPercent:r.resources.during.cpu.externalMeanPercent,
    externalGpuBefore:r.resources.before.busy,externalGpuDuring:r.resources.during.busy,
    syntheticGpu:r.constraints?{iterations:r.constraints.iterations,targetMs:r.constraints.targetExtraGpuMs,
        meanMeasuredMs:mean(r.constraints.runtimeSamples.map(s=>s.ms)),minMeasuredMs:Math.min(...r.constraints.runtimeSamples.map(s=>s.ms)),
        maxMeasuredMs:Math.max(...r.constraints.runtimeSamples.map(s=>s.ms))}:null}));
const stress=runs.filter(r=>r.syntheticGpu),workloadIterations=stress[0].syntheticGpu.iterations;
if(stress.some(r=>r.syntheticGpu.iterations!==workloadIterations))throw Error('Mismatched GPU stress workloads');
const old=throughput.find(r=>r.comparison.label==='old'),current=throughput.find(r=>r.comparison.label==='new');
revisions.new=current.revision;
if(throughput.some(r=>r.revision!==current.revision))throw Error('Checkout revision changed between runs');
const modules=old.comparison.loaded.overrides.map(path=>({path,revision:revisions.old,
    sha256:hash(execFileSync('git',[...git,'show',`${revisions.old}:${path.slice(1)}`],{windowsHide:true}))}));
const gpuMsSaved=gpu[0].summary.meanMs-gpu[1].summary.meanMs,gpuPercentSaved=gpuMsSaved/gpu[0].summary.meanMs*100;
const browser=JSON.parse(await readFile(`.artifacts/${series}/browser.json`,'utf8'));
const result={date:new Date().toISOString(),revisions,browser,viewport:[1920,1080],
    scope:'Earth Rain at 11:00; moving camera; generic host geometry with native SSR/PBR, live cloud shadows, rain, impacts and surface wetness. No sample-world assets.',
    method:'Two fresh 30-second throughput runs per profile/version after 30 seconds of real-time warmup, old/new/new/old order. Separate 30-second GPU timestamp profiles. One sky/PMREM refresh scheduled in each measured window.',
    historicalLoading:'The six changed existing runtime modules were fulfilled from Git in the one owned browser page. The newer capture-only modules are not imported by the old version. Current QA fixture and r186 vendor code are shared; working-tree engine code is unchanged.',
    historicalModules:modules,quality:{old:old.quality,new:current.quality},workloadIterations,
    limits:['One rainy Earth scene and resolution; these are reusable-effect fixture timings, not full-demo or named lower-end-device predictions.',
        'Background CPU activity exceeded the quiet threshold in all throughput runs. Two native runs also had external GPU peaks above threshold.',
        'Both replacement GPU profiles had desktop-compositor/terminal peaks slightly above the 5% external-GPU threshold. The reported GPU delta is a measurement under ambient desktop activity, not a GPU-isolated laboratory result.',
        'Synthetic pressure is CDP CPU rate 4 plus a fixed seeded competing GPU workload on the same RTX 5090 Laptop GPU. Actual workload duration changes with clocks/contention.',
        'The old preset has lower particle, cloud-shadow, reflection and surface-field budgets. This compares both whole presets as configured, not only the display algorithm.',
        'The panorama adds 60 MiB of texture storage and approximates cloud parallax/motion between captures.'],
    aggregate,gains,gpu,exploratoryGpu,gpuMsSaved,gpuPercentSaved,runs,archives};
await writeFile(`${directory}/measurements.json`,JSON.stringify(result,null,2)+'\n');
for(const label of ['old','new'])await copyFile(`.artifacts/${series}/${label}-rain.png`,`${directory}/${label}-rain.png`);
const f=(n,d=2)=>n.toFixed(d),a=(p,l)=>aggregate.find(r=>r.profile===p&&r.label===l);
const change=p=>gains.find(r=>r.profile===p),limited=change('limited');
const pairedGains=[1,2].map(repeat=>{const o=stress.find(r=>r.label==='old'&&r.repeat===repeat),n=stress.find(r=>r.label==='new'&&r.repeat===repeat);return(n.fps/o.fps-1)*100;});
const row=(name,p)=>`| ${name} | ${f(a(p,'old').fps,1)} FPS / ${f(a(p,'old').meanMs)} ms | ${f(a(p,'new').fps,1)} FPS / ${f(a(p,'new').meanMs)} ms | ${Math.abs(change(p).fpsPercent)<.1?'Effectively tied':`${f(change(p).fpsPercent,1)}% FPS; ${f(change(p).frameMsSaved)} ms saved`} |`;
const report=`# Original versus new Performance — 12 September 2026

The original live-cloud Performance mode and the new panorama mode were effectively tied natively in this 1080p rain fixture. Under synthetic resource pressure, the new mode averaged ${f(limited.fpsPercent,1)}% higher FPS (${f(limited.frameMsSaved)} ms saved per frame). Its measured application GPU work was ${f(gpuPercentSaved,1)}% lower (${f(gpuMsSaved)} ms saved). Background activity and the variation between constrained repeats limit the precision of the throughput gain.

| Measurement | Original Performance | New Performance | Observed change |
|---|---:|---:|---:|
${row('Native RTX 5090 Laptop GPU','native')}
${row('4× CPU throttle + fixed GPU workload','limited')}
| Application GPU work per frame | ${f(gpu[0].summary.meanMs)} ms | ${f(gpu[1].summary.meanMs)} ms | ${f(gpuPercentSaved,1)}% less GPU work |

These are fresh measurements of both versions, collected in the same owned browser session. They are not inferred from the earlier Balanced comparison. The baseline is **${revisions.old}**, the r186 version immediately before panorama Performance was introduced. The new engine is **${revisions.new}**. Only the QA helpers and result artifacts changed in the working tree; engine files and Balanced/High settings were not edited.

Both runs used the same generic six-mesh fixture, Earth at 11:00 with settled Rain, 1920×1080, camera field of view and orbit phase, native SSR/PBR, rain, impacts, puddles and cloud shadows. No terrain, temple, vegetation or player assets were included. Each page warmed for 30 real-time seconds, then measured for 30 seconds; time was not accelerated. Native and constrained order was old → new → new → old. The helpers scheduled one sky/PMREM refresh in every window; the original reflection preset normally refreshes every 24 seconds and the new one every 16. New Performance completed three cloud captures in every measured run, including its GPU profile.

| Preset budget | Original | New |
|---|---:|---:|
| Cloud samples / passes | 20 / 2 | 64 / 4 |
| Cloud lighting samples | 6 | 14 |
| Display strategy | Live march at one-third resolution | 2048×1024 panoramas, 32 bands, 9-second refresh/blend |
| Cloud shadow resolution | 256 | 384 |
| Sky reflection bake | 256×128, 2 passes | 384×192, 3 passes |
| Rain / impact instances | 5,500 / 320 | 10,000 / 700 |
| Rain surface field | 512 at 6 Hz | 768 at 8 Hz |
| Cloud light cache | 72×20×72, 0.33 s | 112×28×112, 0.22 s |
| Panorama/distance texture storage | None | 60 MiB |

The comparison includes all these budget differences. The new mode spends part of its cloud saving on more detailed clouds and larger supporting-effect budgets. Its volume is still temporally sampled, with approximate motion/parallax reprojection. These tests do not establish quality equivalence or performance across every sky, weather, camera path or host game. The [old](old-rain.png) and [new](new-rain.png) screenshots were captured after timing and visually inspected; their cloud edges and rain densities differ as expected from the presets.

| Profile | Version | Run | FPS | Mean ms | p95 ms |
|---|---|---:|---:|---:|---:|
${runs.map(r=>`| ${r.profile} | ${r.label} | ${r.repeat} | ${f(r.fps,1)} | ${f(r.meanMs)} | ${f(r.p95Ms)} |`).join('\n')}

Aggregate FPS is total frames divided by total measured time across the two runs, and mean frame ms is the reciprocal. The constrained paired gains were ${f(pairedGains[0],1)}% in the first pair and ${f(pairedGains[1],1)}% in the reverse pair. The old runs varied more; the averaged gain should be treated as an observation under this load, not a guaranteed speedup.

GPU timings are separate sums of WebGPU begin/end timestamps for all frame render/compute passes. They include the periodic reflection refresh and amortized cloud captures, but exclude idle time; reciprocal GPU milliseconds is not measured FPS. The dedicated live-cloud pass averaged ${f(gpu[0].dedicatedCloudPassMs,3)} ms/frame; new panorama capture passes averaged ${f(gpu[1].dedicatedCloudPassMs,3)} ms/frame. Panorama display and compositing are included in the application total, not the dedicated-pass number. There were ${gpu[0].summary.samples.toLocaleString('en-US')} original and ${gpu[1].summary.samples.toLocaleString('en-US')} new GPU samples.

The first GPU pair was excluded from the speedup calculation because machine load changed sharply: the original run saw 98% total GPU utilization and roughly 17 GiB in use, while the subsequent new run saw 37–45% utilization and roughly 11 GiB. Both were repeated in reverse order with process counters during the measurements. ${gpu.filter(r=>r.cleanGpu).length}/2 replacement GPU runs passed the strict external-GPU peak check: desktop compositor/terminal peaks were 5.14–6.11%, with per-process means of 1.29–3.56%. The repeat distributions were much steadier, but the reported delta remains a measurement under ambient desktop activity. Both exploratory runs remain archived and identified in the JSON; their timings were not blended into the reported GPU comparison.

All ${runs.length} throughput runs exceeded the CPU quiet threshold in a before/during sampling window. During-run external CPU activity ranged from ${f(Math.min(...runs.map(r=>r.externalCpuPercent)),1)}% to ${f(Math.max(...runs.map(r=>r.externalCpuPercent)),1)}% of total logical CPU capacity. ${runs.filter(r=>r.cleanGpu).length}/${runs.length} passed the external-GPU peak check; all four constrained runs passed. Other processes and accounts were left alone. Runtime error lists were empty in every throughput run and both GPU final-state checks.

The constrained profile applied CDP CPU rate 4 to the owned page plus the same seeded ${workloadIterations}-iteration GPU memory-latency workload for every old/new run. Calibration targeted 8 ms once; recorded per-run workload means were ${f(Math.min(...stress.map(r=>r.syntheticGpu.meanMeasuredMs)))}–${f(Math.max(...stress.map(r=>r.syntheticGpu.meanMeasuredMs)))} ms. This tests resource contention on the same architecture and VRAM, rather than emulating a named lower-end GPU. Hardware power and clock settings were unchanged.

GPU: NVIDIA GeForce RTX 5090 Laptop GPU, driver 610.88. Browser: ${browser.version}. [Measurements, presets and hashes](measurements.json) include compressed raw evidence under [raw](raw/). This folder is excluded from the hosted demo package.

Reproduce in the one owned QA page with \`node qa/performance-comparison-run.mjs performance native 1 31a107f ${series} old\`, then \`node qa/performance-comparison-run.mjs performance native 1 current ${series} new\`. Repeat in reverse order using run \`2\`. Replace \`native\` with \`limited\` for resource pressure, or \`gpu\` for separate GPU profiles. The reported GPU pair uses repeat \`2\` (new then old); repeat \`1\` is retained as the exploratory pair described above. The series-specific fixed GPU workload is saved at \`.artifacts/${series}/gpu-workload.json\`. Windows resource counters need CIM/performance-counter access. Throttling and GPU contention are restored after each run. \`node qa/summarize-performance-history.mjs\` validates and archives the results.
`;
await writeFile(`${directory}/README.md`,report);
console.log(JSON.stringify({aggregate,gains,gpuMsSaved,gpuPercentSaved,archiveBytes:sum(archives.map(r=>r.bytes))},null,2));
