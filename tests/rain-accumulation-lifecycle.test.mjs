import test from 'node:test';
import assert from 'node:assert/strict';
import * as WebGPU from '../vendor/three/three.webgpu.js';
import {makeRainAccumulationField} from '../engine/rain_accumulation_field.js';

function fixture(){
    const targets=[],materials=[];
    const renderer={target:{host:true},mrt:{host:true},contextNode:{host:true},
        setRenderTarget(v){this.target=v},setMRT(v){this.mrt=v}};
    const T={...WebGPU,...WebGPU.TSL,
        RenderTarget:class extends WebGPU.RenderTarget{constructor(...args){super(...args);targets.push(this)}},
        QuadMesh:class{constructor(material){this.material=material;materials.push(material)}async renderAsync(r){r.draw?.(this.material)}},
        RendererUtils:{saveRendererState:r=>({target:r.target,mrt:r.mrt,contextNode:r.contextNode}),
            restoreRendererState:(r,s)=>Object.assign(r,s)}};
    const field=makeRainAccumulationField(T,{cellAt:()=>T.float(1),rain:T.uniform(.7),wetTarget:T.uniform(.85)});
    const camera=new T.PerspectiveCamera();camera.updateMatrixWorld(true);
    return {T,renderer,field,camera,targets,materials};
}

test('rain history amortizes updates and ordinary walking does not trigger extra captures',async()=>{
    const {renderer,field,camera}=fixture();
    try{
        assert.equal(await field.prepare(renderer,camera,0,{active:false}),false);
        assert.equal(await field.prepare(renderer,camera,0),true);
        for(let i=1;i<15;i++){
            camera.position.x=i*.2;camera.updateMatrixWorld(true);
            assert.equal(await field.prepare(renderer,camera,i/60),false);
        }
        assert.equal(await field.prepare(renderer,camera,.25),true);
        camera.position.x=300;camera.updateMatrixWorld(true);
        assert.equal(await field.prepare(renderer,camera,.26),true,'leaving the guard area refreshes the world footprint');
        assert.equal(field.stats.captures,3);
        assert.equal(await field.prepare(renderer,camera,.1),true,'simulation rewind discards stale future history');
        field.reset();assert.equal(field.stats.ready,false);
        assert.equal(await field.prepare(renderer,camera,.1),true);
    }finally{field.dispose()}
});

test('failed rainfall capture preserves published history and restores the host renderer',async()=>{
    const {renderer,field,camera}=fixture();
    const {target,mrt,contextNode}=renderer;
    try{
        await field.prepare(renderer,camera,0);
        renderer.draw=()=>{throw new Error('rain capture failed')};
        camera.position.x=500;camera.updateMatrixWorld(true);
        await assert.rejects(field.prepare(renderer,camera,1),/rain capture failed/);
        assert.equal(renderer.target,target);assert.equal(renderer.mrt,mrt);assert.equal(renderer.contextNode,contextNode);
        assert.equal(field.stats.captures,1);assert.equal(field.stats.lastUpdateSeconds,0);assert.equal(field.stats.ready,true);
        renderer.draw=null;
        assert.equal(await field.prepare(renderer,camera,1),true);
        assert.equal(field.stats.captures,2);
    }finally{field.dispose()}
});

test('rain history owns a bounded pair of textures and releases them exactly once',async()=>{
    const {renderer,field,camera,targets,materials}=fixture();let releasedTargets=0,releasedMaterials=0;
    targets.forEach(t=>t.addEventListener('dispose',()=>releasedTargets++));
    materials.forEach(m=>m.addEventListener('dispose',()=>releasedMaterials++));
    assert.equal(targets.length,2);assert.equal(field.stats.historyBytes,1024*1024);
    field.dispose();field.dispose();
    assert.equal(releasedTargets,2);assert.equal(releasedMaterials,1);
    assert.equal(await field.prepare(renderer,camera,1,{force:true}),false);
});
