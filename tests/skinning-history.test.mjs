import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {Bone,Skeleton,SkinnedMesh,BufferGeometry,MeshBasicNodeMaterial} from '../vendor/three/three.webgpu.js';

// r186 replaced SkinningNode with TSL skinning(). Exercise its actual registered
// object callback and shared history; GPU motion tests cover the resulting MRT.
const source = readFileSync(new URL('../vendor/three/three.webgpu.js', import.meta.url), 'utf8');
const start = source.indexOf('\tOnObjectUpdate(', source.indexOf('const skinning ='));
const end = source.indexOf('\n\t} );', start) + '\n\t} );'.length;
assert.ok(start > 0 && end > start);
function historyFixture() {
    const history = new WeakMap(), frames = new WeakMap();
    let update;
    vm.runInNewContext(source.slice(start, end), {
        OnObjectUpdate: callback => { update = callback; },
        _previousBoneMatricesData: history, _skeletonsUpdated: frames,
    });
    return {history, update};
}

test('a shadow variant updating first preserves skeleton history for the motion-vector pass',()=>{
    const bone=new Bone(),skeleton=new Skeleton([bone]),mesh=new SkinnedMesh(new BufferGeometry(),new MeshBasicNodeMaterial());
    mesh.skeleton=skeleton;bone.updateMatrixWorld(true);skeleton.update();
    const previous=new Float32Array(skeleton.boneMatrices), f=historyFixture();
    f.history.set(skeleton,{previousBoneMatrices:previous,previousBoneTexture:null});
    // The shadow pass runs first; the motion pass must not overwrite history.
    bone.position.x=2;bone.updateMatrixWorld(true);f.update({object:mesh,frameId:101});f.update({object:mesh,frameId:101});
    assert.equal(skeleton.boneMatrices[12],2);assert.equal(previous[12],0);
    bone.position.x=5;bone.updateMatrixWorld(true);f.update({object:mesh,frameId:102});f.update({object:mesh,frameId:102});
    assert.equal(skeleton.boneMatrices[12],5);assert.equal(previous[12],2);
});
