import test from 'node:test';
import assert from 'node:assert/strict';
import * as T from '../vendor/three/three.core.js';
import {makeShadowRefreshPolicy} from '../src/shadow_refresh.js';
test('steady light retains its map between samples and light motion or time resets invalidates it',()=>{
    const light=new T.DirectionalLight(),policy=makeShadowRefreshPolicy(T,light);
    policy.update(0,30);assert.equal(light.shadow.needsUpdate,true);assert.equal(light.shadow.autoUpdate,false);
    light.shadow.map={};light.shadow.needsUpdate=false;policy.update(.01,30);assert.equal(light.shadow.needsUpdate,false);
    policy.update(.04,30);assert.equal(light.shadow.needsUpdate,true);
    light.shadow.needsUpdate=false;light.position.x+=.1;policy.update(.045,30);assert.equal(light.shadow.needsUpdate,true);
    light.shadow.needsUpdate=false;policy.update(0,30);assert.equal(light.shadow.needsUpdate,true);
    light.shadow.needsUpdate=false;light.target.position.z+=1;policy.update(.001,30);assert.equal(light.shadow.needsUpdate,true);
});
