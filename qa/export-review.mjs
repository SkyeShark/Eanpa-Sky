// Export current evidence without relabeling historical or contended captures.
import {readFile,writeFile,copyFile,mkdir,access} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const json=async path=>{
    const data=await readFile(path);
    // Some retained console captures were written by Windows PowerShell 5.
    const decoded=data[0]===0xff&&data[1]===0xfe
        ?data.subarray(2).toString('utf16le'):data.toString('utf8').replace(/^\uFEFF/,'');
    return JSON.parse(decoded);
};
const exists=async path=>{try{await access(path);return true}catch{return false}};
const hash=async path=>createHash('sha256').update(await readFile(path)).digest('hex');
const worlds=['earth','ringworld','shieldworld'],captures=[];
for(const world of worlds){
    const route=await json(`artifacts/overhaul/benchmarks/final-${world}-route.json`);
    if(route.length!==9)throw new Error('Incomplete final route: '+world);
    for(const row of route){
        const b=row.benchmark;
        if(b.errors||b.invalidReasons.some(x=>!x.includes('External GPU activity')))throw new Error('Unusable capture: '+row.name);
        if(b.metadata.workingTreeDiffSha256)throw new Error('Uncommitted rendering source: '+row.name);
        if(b.metadata.cpuThrottleRate>1&&!(b.metadata.gpuConstraint?.runtimeSamples?.length>=10))
            throw new Error('Missing measured GPU constraint: '+row.name);
        captures.push({name:row.name,...b,gpuProfile:row.gpuProfile,
            rawCaptureSha256:await hash(`artifacts/overhaul/benchmarks/${row.name}.json`)});
    }
}
const revisions=[...new Set(captures.map(r=>r.metadata.revision))];
if(revisions.length!==1)throw new Error('Final rendering revisions differ');
const verification={
    depthGate:await json('artifacts/overhaul/depth-gate/pixel-comparison.json'),
    depthGateGpu:await Promise.all(['depth-gate-off-a-gpu','depth-gate-on-gpu','depth-gate-off-b-gpu']
        .map(async name=>({name,...await json(`artifacts/overhaul/benchmarks/${name}.json`)}))),
    rainSurfaces:await json('artifacts/overhaul/rain-surface-contract-final.json'),
    wetNormals:await json('artifacts/overhaul/wet-normal-contract.json'),
    roofGbuffer:await json('artifacts/overhaul/roof-native-gbuffer-final.json'),
    cloudShadowHeights:await json('artifacts/overhaul/cloud-shadow-ring-height-review.json'),
    fragmentMotion:await json('artifacts/overhaul/celestial-renewed/moon.json'),
    shadowLifetime:await json('artifacts/overhaul/celestial-renewed/day-night-shadow-lifecycle.json'),
    audio:await json('artifacts/overhaul/audio-levels.json'),
    stairs:await json('artifacts/overhaul/player-stairs.json'),
    rock:await json('artifacts/overhaul/rock-interaction.json'),
    rebuild:await json('artifacts/overhaul/rebuild-memory-overhaul-ring.json'),
    transitionBefore:await json('artifacts/overhaul/transitions/shieldworld-rain-cold-trace.json'),
    benchmarkRetest:await json('artifacts/overhaul/benchmarks/final-shieldworld-balanced-cyclone-retest.json'),
    finalReceivers:await json('artifacts/overhaul/final-local-receivers.json'),
    receiverPerformance:{
        full:await json('artifacts/overhaul/benchmarks/receiver-final-ringworld-balanced-rain-full.json'),
        reduced:await json('artifacts/overhaul/benchmarks/receiver-final-ringworld-balanced-rain-reduced.json'),
        gpu:await json('artifacts/overhaul/benchmarks/receiver-final-ringworld-balanced-rain-gpu.json'),
    },
    receiverBeforeCpuCounters:await json('artifacts/overhaul/benchmarks/receiver-first-ringworld-balanced-rain-full.json'),
    transitions:Object.fromEntries(await Promise.all(worlds.map(async world=>[world,
        await json(`artifacts/overhaul/transitions/${world}-rain.json`)]))),
};
if(!verification.depthGate.pass_||!verification.rebuild.pass||!verification.rainSurfaces.pass
    ||!verification.wetNormals.pass||!verification.stairs.pass||!verification.rock.grounded||!verification.finalReceivers.pass
    ||verification.fragmentMotion.errors||verification.fragmentMotion.validation
    ||!(verification.fragmentMotion.motion.minimumEnvelopeClearance>0)||
    Object.values(verification.transitions).some(x=>!x.pass||!x.responsivenessPass))throw new Error('A required verification did not pass');
if(!await exists('qa/results-first-pass-20260907.json'))
    await copyFile('qa/results-20260907.json','qa/results-first-pass-20260907.json');
await writeFile('qa/results-20260907.json',JSON.stringify({date:new Date().toISOString(),
    revision:revisions[0],note:'Revised overhaul; historical first-pass results are retained separately.',
    captures,verification},null,2)+'\n');

const pictures=[
    ['reflections.png','reflection-review/ringworld-final-receivers/orb-combined.png','Reflections — close underside','The reported failure angle on Ringworld after native-radiance repair and the final cloud-shadow receiver correction.'],
    ['native-materials.png','native-materials-earth-final.png','Native PBR materials','Local red-emitter and sky reflections on four native Physical materials.'],
    ['cloud-earth-off.png','shadows/earth-roof-205-final-0.png','Earth cloud shadows — off','Matched camera, weather and cloud time; only cloud-shadow strength changes.'],
    ['cloud-earth-on.png','shadows/earth-roof-205-final-1.png','Earth cloud shadows — on','Roofs, walls, vegetation and terrain receive the same projected cloud field.'],
    ['cloud-ring-off.png','shadows/ring-roof-205-0.png','Ringworld cloud shadows — off','Matched shadow comparison on the local architecture.'],
    ['cloud-ring-on.png','shadows/ring-roof-205-1.png','Ringworld cloud shadows — on','The building participates without a terrain callback.'],
    ['cloud-shield-off.png','shadows/shield-roof-205-0.png','Shieldworld cloud shadows — off','Matched shadow comparison under the red giant.'],
    ['cloud-shield-on.png','shadows/shield-roof-205-1.png','Shieldworld cloud shadows — on','Cloud attenuation preserves the active stellar spectrum.'],
    ['cloud-orb-off.png','shadows/orb-final-0.png','Local metal cloud shadows — off','The orb after removing its legacy receiver exclusion.'],
    ['cloud-orb-on.png','shadows/orb-final-1.png','Local metal cloud shadows — on','Clouds attenuate its direct PBR lighting, with native emission and indirect reflections preserved.'],
    ['ring-relief.png','look-review/ring-cumulus-final.png','Ring terrain and clouds','Displaced, stitched terrain with the local relief transition.'],
    ['ring-reverse.png','look-review/ring-clear-reverse-final.png','Ring terrain — reverse horizon','Actual mountain silhouettes and closed shoreline geometry; original water retained.'],
    ['terrain-steep.png','terrain-steep-final.png','Local terrain — steep surface','World-space material projections on the authored height field.'],
    ['rain-puddles.png','look-review/ring-rain-roof-production-final.png','Rain on the temple roof','Production wetness, pooled water, surface impacts and falling streaks.'],
    ['rain-impact-a.png','rain-roof-motion-0.png','Roof impacts — motion A','Surface-aligned crown and bead motion; captured before the final cloud-radiance adjustment.'],
    ['rain-impact-b.png','rain-roof-motion-4.png','Roof impacts — motion B','A later animation frame on the same roof.'],
    ['shattered-moon.png','celestial-renewed/moon-gpu-debris.png','Shattered moon','Separated solid fragments, GPU-driven small debris and depth-aware dust.'],
    ['moon-motion-a.png','look-review/moon-motion-0.png','Moon motion — first pose','Fixed camera; fragment motion preserves clearance.'],
    ['moon-motion-b.png','look-review/moon-motion-240.png','Moon motion — 240 seconds later','A later pose from the same motion review.'],
    ['red-giant.png','look-review/red-giant.png','Red giant','Broad convection features, warm variation and a softer limb.'],
    ['cirrus.png','look-review/earth-cirrus-overhead-final.png','High cirrus','Irregular, curved ice-trail field shared by visible cirrus and cloud shadows.'],
    ['cirrus-shield.png','look-review/shield-cirrus-final.png','Cirrus under the red giant','The same ice-trail field under Shieldworld illumination; High quality in this capture.'],
];
await mkdir('qa/review',{recursive:true});
const manifest=[];
for(const [file,source,title,note]of pictures){
    const path='artifacts/overhaul/'+source;
    await copyFile(path,'qa/review/'+file);
    manifest.push({file,source,title,note,sha256:await hash(path)});
}
await writeFile('qa/review/manifest.json',JSON.stringify(manifest,null,2)+'\n');
const summary=captures.map(b=>({world:b.metadata.skybox,quality:b.metadata.quality,weather:b.metadata.weather,
    cpuSlowdown:b.metadata.cpuThrottleRate,fps:b.meanFps,p95:b.frameIntervalMs.p95,p99:b.frameIntervalMs.p99,
    isolated:b.cleanGpuWindow,gpu:b.gpuProfile,extraGpuMs:b.metadata.gpuConstraint?.runtimeSamples?.map(x=>x.ms)??[]}));
const receiver=verification.receiverPerformance;
await writeFile('qa/review/summary.json',JSON.stringify({revision:revisions[0],captures:summary,
    finalReceiver:{revision:receiver.full.metadata.revision,fullFps:receiver.full.meanFps,
        reducedFps:receiver.reduced.meanFps,gpuMeanMs:receiver.gpu.summary.meanMs,
        cpuIsolated:receiver.full.cleanCpuWindow===true,
        fullExternalCpu:receiver.full.resources.during.cpu?.externalMeanPercent}},null,2)+'\n');
const labels={earth:'Earth',ringworld:'Ringworld',shieldworld:'Shieldworld'};
const lines=[
    `Rendering revision: \`${revisions[0].slice(0,7)}\`. ${captures.filter(x=>x.cleanGpuWindow).length} of ${captures.length} captures passed the external-GPU-activity gate.`,
    'An asterisk marks an observed capture that exceeded that gate. Actual GPU',
    'competition times, background processes and raw frame intervals are retained',
    'in [qa/results-20260907.json](qa/results-20260907.json).','',
    '| World | Quality / weather | Full FPS | Full p95 ms | Reduced FPS | Reduced p95 ms | GPU mean ms |',
    '| --- | --- | ---: | ---: | ---: | ---: | ---: |',
];
const fmt=b=>b?b.meanFps.toFixed(1)+(b.cleanGpuWindow?'':'*'):'—';
for(const full of captures.filter(x=>x.metadata.cpuThrottleRate===1)){
    const reduced=captures.find(x=>x.name===full.name.replace(/-full$/,'-reduced'));
    lines.push(`| ${labels[full.metadata.skybox]} | ${full.metadata.quality} / ${full.metadata.weather} | ${fmt(full)} | ${full.frameIntervalMs.p95.toFixed(1)} | ${fmt(reduced)} | ${reduced?.frameIntervalMs.p95.toFixed(1)??'—'} | ${full.gpuProfile.meanMs.toFixed(2)} |`);
}
const review=await readFile('OVERHAUL_REVIEW.md','utf8');
const receiverLines=[
    `Final receiver revision \`${receiver.full.metadata.revision.slice(0,7)}\`, Ringworld / Balanced / Rain:`,
    `${receiver.full.meanFps.toFixed(1)} FPS unrestricted (p95 ${receiver.full.frameIntervalMs.p95.toFixed(1)} ms),`,
    `${receiver.reduced.meanFps.toFixed(1)} FPS with CPU+GPU constraints (p95 ${receiver.reduced.frameIntervalMs.p95.toFixed(1)} ms).`,
    `Separate GPU pass mean: ${receiver.gpu.summary.meanMs.toFixed(2)} ms.`,
    `External mean CPU usage during the unrestricted capture: ${receiver.full.resources.during.cpu?.externalMeanPercent?.toFixed(1)??'not measured'}%.`,
    receiver.full.cleanCpuWindow?'The unrestricted capture passed both recorded activity gates.':
        'The unrestricted capture exceeded the CPU-activity gate. It is a contended observation, not a CPU-idle throughput baseline.',
    'The earlier 61.0 FPS receiver capture preceded CPU instrumentation and is retained as well.',
];
await writeFile('OVERHAUL_REVIEW.md',review.replace(/<!-- OVERHAUL_BENCHMARK_TABLE -->[\s\S]*?<!-- END_OVERHAUL_BENCHMARK_TABLE -->/,
    '<!-- OVERHAUL_BENCHMARK_TABLE -->\n'+lines.join('\n')+'\n<!-- END_OVERHAUL_BENCHMARK_TABLE -->')
    .replace(/<!-- FINAL_RECEIVER_BENCHMARK -->[\s\S]*?<!-- END_FINAL_RECEIVER_BENCHMARK -->/,
        '<!-- FINAL_RECEIVER_BENCHMARK -->\n'+receiverLines.join('\n')+'\n<!-- END_FINAL_RECEIVER_BENCHMARK -->'));
console.log(`Exported ${captures.length} captures and ${manifest.length} selected images from ${revisions[0].slice(0,7)}.`);
