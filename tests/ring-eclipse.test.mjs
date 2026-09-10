import test from 'node:test';
import assert from 'node:assert/strict';
import * as T from '../vendor/three/three.core.js';
import {ringSolarVisibility} from '../engine/ring_eclipse.js';
const point={x:0,y:1.82,z:96};
const direction=angle=>({x:Math.sin(angle),y:Math.cos(angle),z:0});
test('opposite ring eclipses overhead sun but never changes the night-side light',()=>{
    assert.equal(ringSolarVisibility(point,direction(0)),0);
    assert.equal(ringSolarVisibility(point,direction(.15)),1);
    assert.equal(ringSolarVisibility(point,{x:0,y:-1,z:0}),1);
    assert.equal(ringSolarVisibility(point,{x:1,y:0,z:0}),1);
});
test('eclipse follows the observer and crosses the finite solar disc continuously',()=>{
    assert.equal(ringSolarVisibility({...point,x:700},direction(0)),1);
    const values=Array.from({length:1001},(_,i)=>ringSolarVisibility(point,direction(i*.0001)));
    assert.ok(values.some(x=>x>0&&x<1),'solar limb produces partial eclipse');
    assert.ok(values.every(Number.isFinite));
    for(let i=1;i<values.length;i++)assert.ok(values[i]>=values[i-1]&&values[i]-values[i-1]<.03);
});

test('translated cylinder and observer retain the same eclipse, including both arcs',()=>{
    const center={x:83,y:4921.660888671875,z:-.458740234375};
    for(const z of [-3500,-96,96,3500])for(const angle of [-.06,0,.06]){
        const local={x:0,y:4940-Math.sqrt(5000**2-z*z)+2,z};
        const moved={x:local.x+center.x,y:local.y+center.y-4940,z:local.z+center.z};
        assert.ok(Math.abs(ringSolarVisibility(moved,direction(angle),{center})
            -ringSolarVisibility(local,direction(angle)))<1e-10);
    }
});

test('the ring remains opaque across the reverse arc solar tangent, including zero-length exits',()=>{
    const radius=5000,center={x:0,y:4921.660888671875,z:-.458740234375};
    const sun={x:.16242894347198716,y:.841327160852789,z:.515543835899489};
    const tangent=Math.atan2(sun.y,-sun.z);
    for(const height of [0,.01,.1,2,85])for(const x of [-250,0,250]){
        for(let i=-30;i<=30;i++){
            const angle=tangent+i*.0001,r=radius-height;
            const p={x,y:center.y+r*Math.cos(angle),z:center.z+r*Math.sin(angle)};
            assert.equal(ringSolarVisibility(p,sun,{center}),0,
                `the ground still blocks the sun: height=${height}, x=${x}, tangent offset=${i*.0001}`);
        }
    }
});

test('local horizon shadow is stable under float-sized radial errors and retains the open ring edge',()=>{
    const radius=5000,center={x:0,y:4940,z:0},sun={x:0,y:1,z:0};
    for(const error of [-.002,0,.002]){
        assert.equal(ringSolarVisibility({x:0,y:center.y+radius+error,z:0},sun,{center}),0);
    }
    assert.equal(ringSolarVisibility({x:700,y:center.y+radius,z:0},sun,{center}),1);
    assert.equal(ringSolarVisibility({x:0,y:center.y+radius+20,z:0},sun,{center}),1,
        'a ray genuinely outside and pointing away from the cylinder remains unoccluded');
});

test('daytime solar occlusion agrees with independent rays against an opaque triangulated ring',()=>{
    const radius=5000,geometry=new T.CylinderGeometry(radius,radius,966,4096,1,true);
    geometry.rotateZ(Math.PI/2);
    const material=new T.MeshBasicMaterial({side:T.DoubleSide}),mesh=new T.Mesh(geometry,material);
    mesh.updateMatrixWorld(true);let checked=0;
    try{
        for(const sx of [-.16242894347198716,0,.16242894347198716]){
            const sun=new T.Vector3(sx,.841327160852789,.515543835899489).normalize();
            for(let i=0;i<32;i++)for(const height of [.01,85])for(const x of [-450,0,450]){
                const angle=i*Math.PI/16;
                const p=new T.Vector3(x,(radius-height)*Math.cos(angle),(radius-height)*Math.sin(angle));
                const visibility=ringSolarVisibility(p,sun,{center:new T.Vector3(),angularRadius:0});
                // The analytic path retains a one-metre filtering footprint;
                // a binary ray is only an oracle outside that edge footprint.
                if(visibility>0&&visibility<1)continue;
                const hits=new T.Raycaster(p,sun,0,25000).intersectObject(mesh);
                assert.equal(visibility,hits.length?0:1,`ray from ${p.toArray()} toward ${sun.toArray()}`);
                checked++;
            }
        }
        assert.ok(checked>550,'cover both arcs, the local horizon, elevations and both width edges');
    }finally{geometry.dispose();material.dispose();}
});

test('the night illumination handoff stays continuous across the observer horizon',()=>{
    const center={x:0,y:4940,z:0},p={x:0,y:center.y,z:-5000};
    const samples=Array.from({length:1001},(_,i)=>{
        const y=-.01+i*.0001,sun={x:0,y,z:-Math.sqrt(1-y*y)};
        return ringSolarVisibility(p,sun,{center});
    });
    assert.equal(samples[0],1);assert.equal(samples.at(-1),0);
    assert.ok(samples.some(v=>v>0&&v<1));
    for(let i=1;i<samples.length;i++){
        assert.ok(samples[i]<=samples[i-1]);
        assert.ok(samples[i-1]-samples[i]<.004,'no single-frame daylight switch');
    }
});
