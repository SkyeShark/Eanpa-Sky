import test from 'node:test';
import assert from 'node:assert/strict';
import {Bone,Skeleton,SkinnedMesh,BufferGeometry,MeshBasicNodeMaterial,SkinningNode} from '../vendor/three/three.webgpu.js';

test('a shadow variant updating first preserves skeleton history for the motion-vector pass',()=>{
    const bone=new Bone(),skeleton=new Skeleton([bone]),mesh=new SkinnedMesh(new BufferGeometry(),new MeshBasicNodeMaterial());
    mesh.skeleton=skeleton;bone.updateMatrixWorld(true);skeleton.update();
    skeleton.previousBoneMatrices=new Float32Array(skeleton.boneMatrices);
    const shadow=new SkinningNode(mesh),motion=new SkinningNode(mesh);motion.previousBoneMatricesNode={};
    bone.position.x=2;bone.updateMatrixWorld(true);shadow.update({object:mesh,frameId:101});motion.update({object:mesh,frameId:101});
    assert.equal(skeleton.boneMatrices[12],2);assert.equal(skeleton.previousBoneMatrices[12],0);
    bone.position.x=5;bone.updateMatrixWorld(true);shadow.update({object:mesh,frameId:102});motion.update({object:mesh,frameId:102});
    assert.equal(skeleton.boneMatrices[12],5);assert.equal(skeleton.previousBoneMatrices[12],2);
});
