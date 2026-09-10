import test from 'node:test';
import assert from 'node:assert/strict';
import {Scene,Group,Mesh,BoxGeometry,MeshStandardNodeMaterial,PerspectiveCamera} from '../vendor/three/three.webgpu.js';
import {hasVisibleEmission} from '../src/visible_emission.js';

test('emissive pass eligibility follows visibility, layers and animated material values',()=>{
    const scene=new Scene(),camera=new PerspectiveCamera(),group=new Group();scene.add(group);
    const material=new MeshStandardNodeMaterial(),mesh=new Mesh(new BoxGeometry(),material);group.add(mesh);
    assert.equal(hasVisibleEmission(scene,camera),false);
    material.emissive.setRGB(2,0,0);assert.equal(hasVisibleEmission(scene,camera),true);
    group.visible=false;assert.equal(hasVisibleEmission(scene,camera),false);group.visible=true;
    mesh.layers.set(1);assert.equal(hasVisibleEmission(scene,camera),false);mesh.layers.set(0);
    material.emissiveIntensity=0;assert.equal(hasVisibleEmission(scene,camera),false);
    material.emissiveNode={};assert.equal(hasVisibleEmission(scene,camera),true);
    material.emissiveNode=null;material.mrtNode={};assert.equal(hasVisibleEmission(scene,camera),true);
    material.visible=false;assert.equal(hasVisibleEmission(scene,camera),false);
    mesh.geometry.dispose();material.dispose();
});
