import test from 'node:test';
import assert from 'node:assert/strict';
import * as WebGPU from '../vendor/three/three.webgpu.js';
import {makeSkyGeometryLayer} from '../src/sky_geometry_layer.js';
import {makeCloudShadowMap} from '../engine/cloud_shadow_map.js';
import {makeRingCloudField} from '../engine/ring_cloud_field.js';
import {makeSpatialCloudPass} from '../src/cloudspatial.js';

function fixture(){
    const uniforms=[];
    const renderer={target:null,mrt:null,contextNode:{original:true},toneMapping:1,outputColorSpace:'display',
        getRenderTarget(){return this.target},setRenderTarget(v){this.target=v},getMRT(){return this.mrt},setMRT(v){this.mrt=v},
        getDrawingBufferSize(v){return v.set(800,450)},setClearColor(){},
        render(scene,camera){this.draw?.(scene,camera)},async compileAsync(scene,camera){this.draw?.(scene,camera)}};
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
    const {origin,light:captureLight,right,up}=map.projection;
    await map.prepare(renderer,camera);assert.equal(map.stats.captures,1);
    const relative=camera.getWorldPosition(new T.Vector3()).sub(origin.value);
    assert.ok(Math.abs(relative.dot(right.value))<16&&Math.abs(relative.dot(up.value))<16,'nested camera uses its world position');
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

test('celestial warmup and rendering use the same private camera without copying the player hierarchy',async()=>{
    const {T,renderer}=fixture(),scene=new T.Scene(),camera=new T.PerspectiveCamera(62,1.6,.18,60000);
    camera.add(new T.Object3D());camera.position.set(4,2,90);camera.updateMatrixWorld(true);
    const mesh=new T.Mesh(new T.BoxGeometry(),new T.MeshStandardMaterial());scene.add(mesh);
    const layer=makeSkyGeometryLayer(T,renderer,scene,camera,{objects:[mesh],near:20}),captures=[];
    renderer.draw=(_,capture)=>{
        captures.push(capture);assert.notEqual(capture,camera);assert.equal(capture.near,20);
        assert.equal(capture.children.length,0);assert.ok(capture.matrixWorld.equals(camera.matrixWorld));
    };
    await layer.compileAsync();camera.position.x+=10;await layer.render();
    assert.equal(captures[0],captures[1]);assert.equal(camera.near,.18);assert.equal(camera.children.length,1);
    layer.dispose();
});

test('near-horizontal cloud shadow columns cover roofs and preserve points along one light ray',async()=>{
    const {T,renderer}=fixture(),light=T.uniform(new T.Vector3(.8,.008,-.6).normalize()),time=T.uniform(0);
    const camera=new T.PerspectiveCamera();camera.position.set(30,2,70);camera.updateMatrixWorld(true);
    const map=makeCloudShadowMap(T,{transmittance:()=>T.float(.5),lightDirection:light,time});await map.prepare(renderer,camera);
    const {origin,right,up}=map.projection;
    const project=p=>{const d=p.clone().sub(origin.value);return new T.Vector2(d.dot(right.value),d.dot(up.value));};
    const ground=new T.Vector3(0,0,0),roof=new T.Vector3(0,180,0);
    assert.ok(project(roof).length()<512,'tall roof remains inside the same map footprint at sunset');
    assert.ok(project(ground).distanceTo(project(ground.clone().addScaledVector(light.value,20000)))<1e-8);
    map.dispose();
});

test('gradual sun motion keeps capture rays perpendicular without increasing refresh frequency',async()=>{
    const {T,renderer}=fixture(),light=T.uniform(new T.Vector3(.8,.6,0)),time=T.uniform(0);
    const camera=new T.PerspectiveCamera();camera.updateMatrixWorld(true);
    const map=makeCloudShadowMap(T,{transmittance:()=>T.float(.5),lightDirection:light,time,refreshSeconds:.1});
    await map.prepare(renderer,camera);
    for(let i=1;i<=12;i++){
        const angle=.6-i*.008;light.value.set(Math.cos(angle),Math.sin(angle),0);
        time.value=(i-1)*.101+.05;
        assert.equal(await map.prepare(renderer,camera),false,'small rotations wait for the next shared refresh');
        time.value=i*.101;assert.equal(await map.prepare(renderer,camera),true);
        const {right,up}=map.projection;
        assert.ok(Math.abs(right.value.dot(light.value))<1e-9);
        assert.ok(Math.abs(up.value.dot(light.value))<1e-9,'published plane matches the current sun, not an earlier step');
    }
    assert.equal(map.stats.captures,13);map.dispose();
});

test('ring cloud atlas shares captures, restores renderer state after failure and disposes once',async()=>{
    const {T,renderer}=fixture();
    const u={displacement:T.uniform(new T.Vector2()),cover:T.uniform(.5),grey:T.uniform(0),dens:T.uniform(1)};
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

test('clear startup submits the hidden cloud pass and waits for GPU completion; failed warmup restores state',async()=>{
    const {T,renderer}=fixture(),scene=new T.Scene(),camera=new T.PerspectiveCamera();
    const oldWidth=globalThis.innerWidth,oldHeight=globalThis.innerHeight;
    globalThis.innerWidth=800;globalThis.innerHeight=450;
    const domes=[0,1].map(()=>new T.Mesh(new T.SphereGeometry(100,8,4),new T.MeshBasicNodeMaterial()));
    domes.forEach(o=>scene.add(o));domes[1].visible=false;
    const steps=[];const sky={domes,uniforms:{},async prepareOptimizedCaches(r,c,force){assert.equal(force,true);steps.push('cache')}};
    renderer.backend={device:{queue:{async onSubmittedWorkDone(){steps.push('complete')}}}};
    renderer.renderAsync=async function(s){assert.equal(this.mrt,null);assert.equal(s.children[0].visible,true);steps.push('draw');this.draw?.(s)};
    const pass=makeSpatialCloudPass(T,renderer,camera);
    try{
        assert.equal(pass.attach(scene,sky),true);
        await pass.compileAsync();
        assert.deepEqual(steps,['cache','draw','draw','complete']);
        assert.equal(domes[1].visible,false);assert.equal(renderer.target,null);
        renderer.draw=()=>{throw new Error('cloud warmup failed')};
        await assert.rejects(pass.compileAsync(),/cloud warmup failed/);
        assert.equal(domes[1].visible,false);assert.equal(renderer.target,null);
    }finally{
        pass.dispose();globalThis.innerWidth=oldWidth;globalThis.innerHeight=oldHeight;
        for(const dome of domes){assert.equal(dome.parent,scene);dome.geometry.dispose();dome.material.dispose()}
    }
});
