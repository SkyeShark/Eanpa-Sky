// Package the static demo without editor/source duplicates. Source files stay
// in Git; both the shipped compressed terrain and its PNG fallback stay here.
import {execFileSync} from 'node:child_process';
import {copyFile, lstat, mkdir, readFile, writeFile} from 'node:fs/promises';
import {dirname, relative, resolve, sep} from 'node:path';
import {fileURLToPath} from 'node:url';

const root=fileURLToPath(new URL('../',import.meta.url));
const output=resolve(root,process.argv[2]??'.artifacts/pages/site');
const relativeOutput=relative(root,output);
if(!relativeOutput||relativeOutput==='..'||relativeOutput.startsWith('..'+sep)){
    throw new Error('Pages output must be a new directory inside the checkout');
}
const git=(...args)=>execFileSync('git',['-c',`safe.directory=${root.replaceAll('\\','/').replace(/\/$/,'')}`,...args],{
    cwd:root,encoding:'utf8',windowsHide:true,maxBuffer:8*1024*1024,
});
const tracked=git('ls-files','-z').split('\0').filter(Boolean);
const include=p=>/^(assets|engine|src|vendor|docs)\//.test(p)||p.startsWith('qa/review/')
    ||/^(index\.html|VERSION|package\.json|\.nojekyll|LICENSE|[^/]+\.md)$/.test(p);
const sourceOnly=p=>/\.(?:blend\d*|psd|xcf|kra|mtlx|usdc|tres)$/.test(p)
    ||/^assets\/pbr\/eanpa_southwest_ground_v3\/runtime\/[^/]+_(?:AlbedoGrade|PackedNxyRoughAO)_2K\.png$/.test(p)
    ||/^assets\/terrain\/Desert_(?:rock_chunks_12_pieces|Cliff_Mesa_High|Cliff_Wide_Mesa_Low)_runtime_2k\.glb$/.test(p);
const files=tracked.filter(p=>include(p)&&!sourceOnly(p)),selected=new Set(files);
const version=(await readFile(resolve(root,'VERSION'),'utf8')).trim();
if(JSON.parse(await readFile(resolve(root,'package.json'),'utf8')).version!==version)throw new Error('Release versions differ');
const records=[];
for(const path of files){
    const info=await lstat(resolve(root,path));
    if(!info.isFile()||info.isSymbolicLink())throw new Error(`Pages input must be a regular file: ${path}`);
    records.push({path,bytes:info.size});
    if(/^(src|engine)\/.+\.js$/.test(path)){
        const code=await readFile(resolve(root,path),'utf8');
        for(const match of code.matchAll(/(?:from\s+|import\s*\(\s*|import\s*)['"](\.\.?\/[^'"]+\.js)(?:\?[^'"]*)?['"]/g)){
            const dependency=new URL(match[1],new URL(path,'https://example.invalid/demo/')).pathname.slice('/demo/'.length);
            if(!selected.has(dependency))throw new Error(`Missing deployed module: ${path} -> ${dependency}`);
        }
    }
}
// Keep the actual terrain arrays, every PNG fallback, and all sky payloads.
for(const path of tracked.filter(p=>p.endsWith('.ktx2')||p.includes('/fallback_1k/')
    ||p.startsWith('assets/ringworld/')||p.startsWith('assets/weather/'))){
    if(!selected.has(path))throw new Error(`Required runtime asset excluded: ${path}`);
}
const bytes=records.reduce((sum,file)=>sum+file.bytes,0);
if(bytes>990_000_000)throw new Error(`Demo exceeds the Pages size budget: ${bytes} bytes`);
const manifest={version,commit:git('rev-parse','HEAD').trim(),bytes,files:records};
// Refuse reuse rather than leaving stale files in a supposedly verified build.
await mkdir(dirname(output),{recursive:true});await mkdir(output);
for(const {path} of records){
    const destination=resolve(output,path);await mkdir(dirname(destination),{recursive:true});
    await copyFile(resolve(root,path),destination);
}
await writeFile(resolve(output,'release-manifest.json'),JSON.stringify(manifest,null,2)+'\n');
console.log(JSON.stringify({version,commit:manifest.commit,files:files.length,bytes,output},null,2));
