import test from 'node:test';
import assert from 'node:assert/strict';
import {Texture,TextureNode,TSL} from '../vendor/three/three.webgpu.js';

test('explicit screen/PMREM matrix policy survives chained sampling and mip selection',()=>{
    const bitmap=new Texture(),source=new TextureNode(bitmap);
    source.setUpdateMatrix(false);
    const sampled=source.sample(TSL.vec2(.2,.7)).level(2).bias(.1);
    assert.equal(sampled.value,bitmap);
    assert.equal(sampled.updateMatrix,false);
    assert.equal(sampled.updateType,'none');
    const authored=new TextureNode(bitmap);
    assert.equal(authored.sample(TSL.vec2(.2,.7)).updateMatrix,true);
});
