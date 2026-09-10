import test from 'node:test';
import assert from 'node:assert/strict';
import * as T from '../vendor/three/three.core.js';
import {syncSkyCaptureCamera} from '../src/sky_geometry_layer.js';

test('distant sky depth resolves metre-scale shores without changing the first-person camera',()=>{
    const view=new T.PerspectiveCamera(52,1.7,.18,60000);
    view.coordinateSystem=T.WebGPUCoordinateSystem;view.updateProjectionMatrix();view.updateMatrixWorld(true);
    const projection=view.projectionMatrix.clone(),capture=new T.PerspectiveCamera();
    syncSkyCaptureCamera(view,capture,20);capture.updateMatrixWorld(true);
    const depth=(camera,z)=>Math.fround(new T.Vector3(0,0,-z).project(camera).z);
    assert.equal(depth(view,10000),depth(view,10001),'the first-person range loses this separation');
    assert.notEqual(depth(capture,10000),depth(capture,10001),'the private range keeps the sea behind the shore');
    assert.equal(view.near,.18);assert.ok(view.projectionMatrix.equals(projection));
});

test('a private depth camera preserves framing, zoom and a parented world pose',()=>{
    const parent=new T.Group(),view=new T.PerspectiveCamera(62,1.6,.18,60000);
    parent.position.set(40,12,-55);parent.rotation.set(.1,.3,-.2);parent.add(view);
    view.position.set(3,2,-4);view.rotation.set(-.3,.2,0);view.zoom=1.3;
    view.setViewOffset(1600,1000,100,40,1200,800);view.updateProjectionMatrix();parent.updateMatrixWorld(true);
    view.add(new T.Object3D());
    const capture=new T.PerspectiveCamera();syncSkyCaptureCamera(view,capture,20);capture.updateMatrixWorld(true);
    assert.equal(capture.children.length,0);
    for(const p of [new T.Vector3(0,0,-2000),new T.Vector3(300,240,-9000)]){
        p.applyMatrix4(view.matrixWorld);
        const a=p.clone().project(view),b=p.clone().project(capture);
        assert.ok(Math.abs(a.x-b.x)<1e-10&&Math.abs(a.y-b.y)<1e-10);
    }
});
