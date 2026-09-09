// Copy selected evidence into version control; raw captures remain in artifacts/.
import {copyFile,mkdir,readFile,readdir,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const destination='qa/review/feedback-20260908';
await mkdir(`${destination}/benchmarks`,{recursive:true});
const rows=JSON.parse(await readFile('artifacts/feedback-20260908/feedback-ringworld-benchmarks.json','utf8'));
if(rows.length!==12)throw new Error(`Expected all 12 benchmark runs, found ${rows.length}`);
await writeFile(`${destination}/benchmarks.json`,JSON.stringify(rows,null,2));
for(const row of rows)await copyFile(`artifacts/overhaul/benchmarks/${row.name}.json`,`${destination}/benchmarks/${row.name}.json`);
for(const [source,name]of [
    ['overhaul/look-review/feedback-night-final.png','night.png'],
    ['overhaul/look-review/feedback-eclipse-final.png','eclipse.png'],
    ['overhaul/look-review/feedback-eclipse-before.png','before-eclipse.png'],
    ['feedback-20260908/ring-sheet-0-on.png','ring-sheet-on.png'],
    ['feedback-20260908/ring-sheet-1-off.png','ring-sheet-off.png'],
    ['feedback-20260908/ring-sky-checks.json','ring-sky-checks.json'],
    ['feedback-20260908/cold-clear-submitted-transitions.json','ring-balanced-transitions.json'],
    ['feedback-20260908/shield-final-transitions.json','shield-balanced-transitions.json'],
    ['feedback-20260908/ring-high-final-transitions.json','ring-high-transitions.json'],
    ['feedback-20260908/earth-high-cold-transitions.json','earth-high-transitions.json'],
    ['overhaul/transitions/shieldworld-rain-feedback-shield.json','shield-rain-transition.json'],
    ['overhaul/transitions/earth-rain-feedback-earth.json','earth-rain-transition.json'],
])await copyFile(`artifacts/${source}`,`${destination}/${name}`);
const manifest=[];
for(const name of await readdir(destination)){
    if(name==='manifest.json'||name==='benchmarks')continue;
    const data=await readFile(`${destination}/${name}`);
    manifest.push({file:name,bytes:data.length,sha256:createHash('sha256').update(data).digest('hex')});
}
await writeFile(`${destination}/manifest.json`,JSON.stringify(manifest,null,2));
const cells=rows.map(row=>`| ${row.tier} | ${row.weather==='none'?'Dry / cumulus':'Rain / stratus'} | ${row.constraint==='full'?'Unthrottled':'4x CPU + GPU load'} | ${row.fps.toFixed(1)} | ${row.ms.mean.toFixed(1)} | ${row.ms.p95.toFixed(1)} | ${row.cpuBackground.toFixed(1)}% | ${row.valid?'Clean':'Contended'} |`);
await writeFile('artifacts/feedback-20260908/benchmark-table.md',[
    '| Quality | Weather | Constraint | Mean FPS | Mean ms | p95 ms | Background CPU | Status |',
    '|---|---|---|---:|---:|---:|---:|---|',...cells,''].join('\n'));
console.log(`Packaged ${manifest.length} selected artifacts and ${rows.length} benchmark runs`);
