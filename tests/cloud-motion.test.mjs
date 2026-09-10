import test from 'node:test';
import assert from 'node:assert/strict';
import {createCloudMotion} from '../engine/cloud_motion.js';

test('weather changes after a long session change velocity without jumping cloud phase',()=>{
    const m=createCloudMotion();m.update(40000,{x:2,z:6});m.update(40001,{x:2,z:6});
    assert.deepEqual(m.offset,{x:2,y:0,z:6});
    m.update(40001,{x:20,z:10});assert.deepEqual(m.offset,{x:2,y:0,z:6});
    m.update(40002,{x:20,z:10});assert.deepEqual(m.offset,{x:22,y:0,z:16});
});
test('smooth weather acceleration is independent of the update rate',()=>{
    for(const steps of [10,30,60,240]){
        const m=createCloudMotion();for(let i=0;i<=steps;i++)m.update(i/steps,{x:2+8*i/steps,z:6});
        assert.ok(Math.abs(m.offset.x-6)<1e-10);assert.ok(Math.abs(m.offset.z-6)<1e-10);
    }
});
test('pauses, duplicate updates and clock resets keep clouds in place',()=>{
    const m=createCloudMotion();m.update(0,{x:2});m.update(1,{x:2});m.update(1,{x:8});
    m.update(0,{x:8});assert.equal(m.offset.x,2);m.update(1,{x:8});assert.equal(m.offset.x,10);
});
