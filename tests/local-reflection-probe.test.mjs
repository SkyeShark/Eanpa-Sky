import test from 'node:test';
import assert from 'node:assert/strict';
import {Vector3, Scene, Mesh, BoxGeometry, MeshStandardMaterial, DirectionalLight, PerspectiveCamera} from '../vendor/three/three.core.js';
import {makeLocalReflectionProbe} from '../src/local_reflection_probe.js';

function fixture() {
    const resources=[];
    class Target {
        constructor(size) {this.width=size*3;this.height=size*4;this.texture={};this.disposals=0;resources.push(this)}
        dispose(){this.disposals++}
    }
    class Generator {
        constructor(){this.disposals=0;this.bakes=0;resources.push(this)}
        fromCubemap(cube,target){this.bakes++;return target??new Target(128)}
        dispose(){this.disposals++}
    }
    class CubeCamera {
        constructor(){this.position=new Vector3();this.children=Array.from({length:6},(_,face)=>({face}))}
        updateCoordinateSystem(){}
        updateMatrixWorld(){}
    }
    const renderer={contextNode:{original:true},target:null,mrt:null,outputColorSpace:'display',toneMapping:'aces',
        coordinateSystem:2001,draws:[],initRenderTarget(){},setRenderTarget(target,face){this.target=target;this.face=face},
        setMRT(mrt){this.mrt=mrt},render(scene,camera){this.onDraw?.(scene,camera);this.draws.push(camera.face)},
        async compileAsync(scene,camera){this.onCompile?.(scene,camera)}};
    const T={Vector3,CubeRenderTarget:Target,CubeCamera,PMREMGenerator:Generator,
        uniform:value=>({value,setGroup(){return this}}),texture:value=>({value}),context:value=>value,mrt:value=>value,
        RendererUtils:{saveRendererState:r=>({contextNode:r.contextNode,target:r.target,mrt:r.mrt,toneMapping:r.toneMapping,outputColorSpace:r.outputColorSpace}),
            restoreRendererState:(r,state)=>Object.assign(r,state)}};
    const scene=new Scene(),camera=new PerspectiveCamera();camera.position.set(0,4,0);
    const hero=new Mesh(new BoxGeometry(),new MeshStandardMaterial());hero.position.set(0,4,-3);hero.userData.ssrConvexGroup='hero';
    const light=new DirectionalLight();light.shadow.autoUpdate=true;light.shadow.needsUpdate=true;
    scene.add(hero,light);scene.updateMatrixWorld(true);
    const probe=makeLocalReflectionProbe(T,renderer,scene,camera);
    const environment={name:'sky'};probe.setEnvironment(environment);
    return {probe,renderer,scene,hero,light,environment,resources};
}

test('local probe publishes six complete faces and restores visible-scene state',()=>{
    const {probe,renderer,scene,hero,light,environment}=fixture();
    const context=renderer.contextNode;
    renderer.onDraw=()=>{
        assert.equal(hero.visible,false);
        assert.equal(light.shadow.autoUpdate,false);
        assert.equal(light.shadow.needsUpdate,false);
        assert.equal(scene.background,environment);
    };
    for(let i=0;i<5;i++){probe.update();assert.equal(probe.stats.captures,0)}
    probe.update();
    assert.deepEqual(renderer.draws,[0,1,2,3,4,5]);
    assert.equal(probe.stats.captures,1);
    assert.ok(new Vector3(...probe.stats.lastCenter).distanceTo(new Vector3(0,4,-3))<1e-10);
    assert.equal(hero.visible,true);assert.equal(light.shadow.autoUpdate,true);assert.equal(light.shadow.needsUpdate,true);
    assert.equal(scene.background,null);assert.equal(renderer.contextNode,context);assert.equal(renderer.target,null);assert.equal(renderer.mrt,null);
    probe.update();assert.equal(renderer.draws.length,6,'settled capture is reused');
    probe.dispose();
});

test('failed capture restores camera-independent scene state and can retry the same face',()=>{
    const {probe,renderer,scene,hero,light}=fixture();
    renderer.onDraw=()=>{throw new Error('capture failed')};
    assert.throws(()=>probe.update(),/capture failed/);
    assert.equal(hero.visible,true);assert.equal(light.shadow.autoUpdate,true);assert.equal(scene.background,null);assert.equal(renderer.target,null);
    assert.equal(probe.stats.captures,0);
    renderer.onDraw=null;probe.update();assert.deepEqual(renderer.draws,[0]);
    probe.dispose();
});

test('failed asynchronous probe warmup restores state and disposal releases each owned resource once',async()=>{
    const {probe,renderer,scene,hero,light,resources}=fixture();
    const context=renderer.contextNode;
    renderer.onCompile=(scene,camera)=>{if(camera.face===2)throw new Error('compile failed')};
    await assert.rejects(probe.compileAsync(),/compile failed/);
    assert.equal(hero.visible,true);assert.equal(light.shadow.needsUpdate,true);assert.equal(scene.background,null);
    assert.equal(renderer.contextNode,context);assert.equal(renderer.target,null);assert.equal(renderer.mrt,null);
    probe.dispose();probe.dispose();
    assert.ok(resources.every(resource=>resource.disposals===1));
    probe.update();assert.equal(renderer.draws.length,0);
});
