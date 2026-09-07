import test from 'node:test';
import assert from 'node:assert/strict';
import * as WebGPU from '../vendor/three/three.webgpu.js';
import {makeSkyGeometryLayer} from '../src/sky_geometry_layer.js';
import {makeCloudShadowMap} from '../engine/cloud_shadow_map.js';
import {makeRingCloudField} from '../engine/ring_cloud_field.js';

function fixture(){
    const uniforms=[];
    const renderer={target:null,mrt:null,contextNode:{original:true},toneMapping:1,outputColorSpace:'display',
        getRenderTarget(){return this.target},setRenderTarget(v){this.target=v},getMRT(){return this.mrt},setMRT(v){this.mrt=v},
        getDrawingBufferSize(v){return v.set(800,450)},setClearColor(){},
        render(scene){this.draw?.(scene)},async compileAsync(scene){this.draw?.(scene)}};
    const T={...WebGPU,...WebGPU.TSL,uniform(value){const node=WebGPU.TSL.uniform(value);uniforms.push(node);return node},
        QuadMesh:class{constructor(material){this.material=material}async renderAsync(r){r.draw?.(this.material)}},
        RendererUtils:{saveRendererState:r=>({target:r.target,mrt:r.mrt,contextNode:r.contextNode,toneMapping:r.toneMapping,outputColorSpace:r.outputColorSpace}),
            restoreRendererState:(r,s)=>Object.assign(r,s)}};
    return{T,renderer,uniforms};
}

test('celestial captures restore parent transforms, visibility and material ownership after failures',async()=>{
    const {T,renderer}=fixture(),scene=new T.Scene(),parent=new T.Group(),camera=new T.PerspectiveCamera();
    parent.position.set(5,12,-3);parent.rotation.set(.2,-.4,.1);parent.scale.setScalar(7);scene.add(parent);
    const mesh=new T.Mesh(new T.BoxGeometry(),new T.MeshStandardMaterial({depthWrite:false}));
    mesh.position.set(1,4,-2);parent.add(mesh);scene.updateMatrixWorld(true);
    const local=mesh.matrix.clone(),world=mesh.matrixWorld.clone(),context=renderer.contextNode;
    const layer=makeSkyGeometryLayer(T,renderer,scene,camera,{objects:[mesh]});
    assert.equal(mesh.material.depthWrite,true);
    renderer.draw=()=>{assert.notEqual(mesh.parent,parent);throw new Error('device draw failed')};
    await assert.rejects(layer.render(),/device draw failed/);
    assert.equal(mesh.parent,parent);assert.equal(mesh.visible,true);assert.equal(renderer.contextNode,context);assert.equal(renderer.target,null);
    scene.updateMatrixWorld(true);
    for(let i=0;i<16;i++){assert.ok(Math.abs(mesh.matrix.elements[i]-local.elements[i])<1e-8);assert.ok(Math.abs(mesh.matrixWorld.elements[i]-world.elements[i])<1e-8)}
    renderer.draw=null;await layer.render();assert.equal(mesh.visible,false);layer.restoreVisibility();assert.equal(mesh.visible,true);
    let disposed=0;layer.target.addEventListener('dispose',()=>disposed++);layer.dispose();layer.dispose();
    assert.equal(disposed,1);assert.equal(mesh.material.depthWrite,false);assert.equal(mesh.userData.noSSRSource,undefined);
    assert.equal(layer.proxy.parent,null);
});

test('cloud-map refresh is amortized and a failed refresh retains the previous world projection',async()=>{
    const {T,renderer,uniforms}=fixture(),light=T.uniform(new T.Vector3(.2,1,.1).normalize()),time=T.uniform(0);
    const camera=new T.PerspectiveCamera(),parent=new T.Group();parent.position.set(100,10,300);parent.add(camera);parent.updateMatrixWorld(true);
    const map=makeCloudShadowMap(T,{transmittance:()=>T.float(.5),lightDirection:light,time});
    const origin=uniforms[2],captureLight=uniforms[3];
    await map.prepare(renderer,camera);assert.equal(map.stats.captures,1);assert.ok(origin.value.y>200,'nested camera uses its world position');
    assert.equal(await map.prepare(renderer,camera),false);
    const previous=origin.value.clone(),previousLight=captureLight.value.clone(),context=renderer.contextNode;
    camera.position.set(500,0,0);time.value=1;light.value.set(.4,1,.5).normalize();
    renderer.draw=()=>{throw new Error('capture failed')};await assert.rejects(map.prepare(renderer,camera),/capture failed/);
    assert.deepEqual(origin.value,previous);assert.deepEqual(captureLight.value,previousLight);assert.equal(map.stats.captures,1);
    assert.equal(renderer.target,null);assert.equal(renderer.contextNode,context);
    renderer.draw=null;assert.equal(await map.prepare(renderer,camera),true);assert.equal(map.stats.captures,2);
    let disposed=0;map.target.addEventListener('dispose',()=>disposed++);map.dispose();map.dispose();assert.equal(disposed,1);
    assert.equal(await map.prepare(renderer,camera,true),false);
});

test('ring cloud atlas shares captures, restores renderer state after failure and disposes once',async()=>{
    const {T,renderer}=fixture();
    const u={wind:T.uniform(new T.Vector2()),cover:T.uniform(.5),grey:T.uniform(0),dens:T.uniform(1)};
    const field=makeRingCloudField(T,u,T.uniform(0)),context=renderer.contextNode;
    assert.equal(await field.prepare(renderer,0),true);
    assert.equal(await field.prepare(renderer,.05),false);
    renderer.draw=()=>{throw new Error('atlas failed')};
    await assert.rejects(field.prepare(renderer,1),/atlas failed/);
    assert.equal(field.stats.captures,1);assert.equal(field.stats.lastTime,0);
    assert.equal(renderer.target,null);assert.equal(renderer.contextNode,context);
    renderer.draw=null;assert.equal(await field.prepare(renderer,1),true);
    let disposals=0;field.target.addEventListener('dispose',()=>disposals++);
    field.dispose();field.dispose();assert.equal(disposals,1);
    assert.equal(await field.prepare(renderer,2),false);
});
