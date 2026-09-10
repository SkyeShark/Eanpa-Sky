import test from 'node:test';
import assert from 'node:assert/strict';
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
