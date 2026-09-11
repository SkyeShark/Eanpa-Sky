import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {TSL,Vector2} from '../vendor/three/three.webgpu.js';

// Exercise the actual private renderer cache with real TSL references. Shader
// and buffer sharing is also checked in the live WebGPU capture.
const source=readFileSync(new URL('../vendor/three/three.webgpu.js',import.meta.url),'utf8');
const start=source.indexOf('const _shadowFilterUniforms =');
const end=source.indexOf('/**',start);
const getUniforms=vm.runInNewContext(source.slice(start,end)+'\ngetShadowFilterUniforms',{
    reference:TSL.reference,renderGroup:TSL.renderGroup,
});
const value=node=>{node.updateReference({});node.update({});return node.node.value;};

test('shadow filter receivers reuse references while map resize and replacement stay live',()=>{
    const shadow={mapSize:new Vector2(256,128),radius:1};
    const first=getUniforms(shadow),second=getUniforms(shadow);
    assert.equal(first.mapSize,second.mapSize);
    assert.equal(first.radius,second.radius);
    assert.deepEqual(value(first.mapSize).toArray(),[256,128]);
    shadow.mapSize.set(1024,512);shadow.radius=2.5;
    assert.deepEqual(value(second.mapSize).toArray(),[1024,512]);
    assert.equal(value(first.radius),2.5);
    shadow.mapSize=new Vector2(64,32);
    assert.equal(value(first.mapSize),shadow.mapSize);
    assert.deepEqual(value(second.mapSize).toArray(),[64,32]);
});

test('different lights retain independent filter dimensions and radii',()=>{
    const a={mapSize:new Vector2(2048,2048),radius:2};
    const b={mapSize:new Vector2(512,256),radius:.5};
    const first=getUniforms(a),second=getUniforms(b);
    assert.notEqual(first.mapSize,second.mapSize);
    assert.notEqual(first.radius,second.radius);
    a.mapSize.set(128,64);a.radius=3;
    assert.deepEqual(value(first.mapSize).toArray(),[128,64]);
    assert.deepEqual(value(second.mapSize).toArray(),[512,256]);
    assert.equal(value(first.radius),3);
    assert.equal(value(second.radius),.5);
});
