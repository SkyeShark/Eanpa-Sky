import assert from 'node:assert/strict';
import test from 'node:test';
import { createVegetationCollisionStreamer, setConvexHullLibrary } from '../src/vegetation_collision.js';

const box = { aabb: { min: [-1,0,-1], max:[1,1,1] },
    planes:[[1,0,0,-1],[-1,0,0,-1],[0,1,0,-1],[0,-1,0,0],[0,0,1,-1],[0,0,-1,-1]] };
setConvexHullLibrary({ rock_test:[box] });
function scene() {
    const streamer=createVegetationCollisionStreamer();
    streamer.registerSpecies('rock_test',[{id:1,x:30,y:0,z:0,scale:5,boundsRadius:8}]);
    return streamer;
}

test('a large rock activates near its surface before its pivot reaches the player radius',()=>{
    const s=scene();s.refresh({x:18,y:1.82,z:0},0,true);
    assert.equal(s.snapshot().active,1);
    assert.equal(s.snapshot().activeHullCount,1,'overlapping grid cells do not duplicate a proxy');
    s.refresh({x:10,y:1.82,z:0},1,true);
    assert.equal(s.snapshot().active,0);
    s.dispose();
});

test('swept movement stops on the rock and preserves sliding along its face',()=>{
    const s=scene(),from={x:24,y:1.82,z:0},to={x:26,y:1.82,z:1};
    const hit=s.resolve(to,from,0,1.82);
    assert.ok(hit.contacts>0);
    assert.ok(to.x<=24.621&&to.x>=24.60);
    assert.ok(Math.abs(to.z-1)<1e-6);
    s.dispose();
});

test('rock tops support landing without pulling a player up through a tall side',()=>{
    const s=scene();s.refresh({x:30,y:7,z:0},0,true);
    assert.equal(s.walkSurfaceAt(30,0,5.1)?.height,5);
    assert.equal(s.walkSurfaceAt(30,0,1),null);
    assert.equal(s.walkSurfaceAt(36,0,20),null);
    const above={x:30,y:6.82,z:0};
    s.resolve(above,above,0,1.82);
    assert.equal(above.x,30,'standing on a top face does not eject the player sideways');
    s.dispose();
});

test('tilted hull planes retain a walkable slope and exact height under rotation',()=>{
    const s=createVegetationCollisionStreamer(),a=Math.PI/6,c=Math.cos(a),sn=Math.sin(a);
    s.registerSpecies('rock_test',[{id:2,x:0,y:0,z:0,scale:1,boundsRadius:2,
        rot9:[c,-sn,0,sn,c,0,0,0,1]}]);
    s.refresh({x:0,y:2,z:0},0,true);
    const support=s.walkSurfaceAt(0,0,3);
    assert.ok(Math.abs(support.height-1/c)<1e-6);
    assert.ok(Math.abs(support.normalY-c)<1e-6);
    for (const clearance of [0, 0.03, 0.1]) {
        const standing = { x: 0, y: support.height + 1.82 + clearance, z: 0 };
        s.resolve(standing, { ...standing }, 0, 1.82);
        assert.equal(standing.x, 0, 'approaching a sloped top from above does not cause a lateral ejection');
        assert.equal(standing.z, 0);
    }
    s.dispose();
});
