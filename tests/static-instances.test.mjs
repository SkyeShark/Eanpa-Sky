import test from 'node:test';
import assert from 'node:assert/strict';
import * as T from '../vendor/three/three.webgpu.js';
import {makeStaticInstances} from '../src/static_instances.js';

test('static instances retain world transforms, authored materials, ray hits and disposal ownership',()=>{
    const scene=new T.Scene(),parent=new T.Group(),roots=[];
    parent.position.set(10,4,-30);parent.rotation.y=.3;scene.add(parent);
    const geometry=new T.BoxGeometry(2,4,2),material=new T.MeshStandardMaterial();
    for(let i=0;i<5;i++){
        const root=new T.Group(),mesh=new T.Mesh(geometry,material);root.position.set(4+i*4,0,4);
        root.rotation.y=i*.2;mesh.position.y=2;mesh.castShadow=true;mesh.receiveShadow=true;
        root.add(mesh);parent.add(root);roots.push(root);
    }
    scene.updateMatrixWorld(true);
    const originals=roots.map(r=>r.children[0].matrixWorld.clone());
    const cast=()=>{
        scene.updateMatrixWorld(true);const hits=[];
        for(const [i,m]of originals.entries()){
            const center=new T.Vector3().setFromMatrixPosition(m);
            const ray=new T.Raycaster(center.clone().add(new T.Vector3(0,10,0)),new T.Vector3(0,-1,0));
            const visible=[];parent.traverseVisible(o=>{if(o.isMesh)visible.push(o)});
            hits.push({index:i,distance:ray.intersectObjects(visible,false)[0].distance});
        }return hits;
    };
    const before=cast(),batching=makeStaticInstances(T,parent,roots);
    assert.equal(batching.stats.sourceMeshes,5);assert.equal(batching.stats.drawMeshes,1);
    const batch=batching.batches[0];assert.equal(batch.geometry,geometry);assert.equal(batch.material,material);
    assert.equal(batch.castShadow,true);assert.equal(batch.receiveShadow,true);
    scene.updateMatrixWorld(true);
    for(let i=0;i<5;i++){
        const m=new T.Matrix4();batch.getMatrixAt(i,m);m.premultiply(batch.matrixWorld);
        for(let k=0;k<16;k++)assert.ok(Math.abs(m.elements[k]-originals[i].elements[k])<1e-5);
    }
    const after=cast();for(let i=0;i<before.length;i++)assert.ok(Math.abs(before[i].distance-after[i].distance)<1e-5);
    batching.setEnabled(false);assert.deepEqual(cast(),before);batching.setEnabled(true);
    let disposed=0,geometryDisposed=false;batch.addEventListener('dispose',()=>disposed++);
    geometry.addEventListener('dispose',()=>geometryDisposed=true);
    batching.dispose();batching.dispose();assert.equal(disposed,1);assert.equal(geometryDisposed,false);
    assert.deepEqual(cast(),before);geometry.dispose();material.dispose();
});
