import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import * as Core from '../vendor/three/three.core.js';
import * as GPU from '../vendor/three/three.webgpu.js';

const root=new URL('../vendor/three/',import.meta.url);
const provenance=JSON.parse(readFileSync(new URL('UPSTREAM.json',root),'utf8'));
// Match the browser import map without installing a second Three instance.
const tslSource=readFileSync(new URL('three.tsl.js',root),'utf8')
    .replace("from 'three/webgpu'", "from '"+new URL('three.webgpu.js',root).href+"'");
const TSL=await import('data:text/javascript;base64,'+Buffer.from(tslSource).toString('base64'));

test('core, WebGPU and TSL use one pinned Three revision and constructor identity',()=>{
    assert.equal(Core.REVISION,provenance.revision);
    assert.equal(GPU.REVISION,Core.REVISION);
    assert.equal(GPU.Texture,Core.Texture);
    assert.equal(TSL.texture,GPU.TSL.texture);
    assert.equal(TSL.textureCubeUV,GPU.TSL.textureCubeUV);
    assert.equal(typeof TSL.textureCubeUV,'function');
    assert.equal(typeof TSL.packNormalToRGB,'function');
    assert.equal(typeof TSL.unpackRGBToNormal,'function');
});

test('unpatched vendor files match the verified release and relative modules resolve',()=>{
    for(const entry of provenance.files){
        const bytes=readFileSync(new URL(entry.path,root));
        if(!entry.patched){
            // Git may check text out with CRLF on Windows; compare package LF.
            const normalized=entry.path.endsWith('.js')?Buffer.from(bytes.toString().replaceAll('\r\n','\n')):bytes;
            assert.equal(createHash('sha256').update(normalized).digest('hex'),entry.upstreamSha256,entry.path);
        }
        if(!entry.path.endsWith('.js'))continue;
        for(const [,dependency] of bytes.toString().matchAll(/(?:from\s+|import\s*)['"](\.\.?\/[^'"]+\.js)['"]/g)){
            assert.doesNotThrow(()=>readFileSync(new URL(dependency,new URL(entry.path,root))),entry.path+' -> '+dependency);
        }
    }
});
