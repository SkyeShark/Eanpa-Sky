import test from 'node:test';
import assert from 'node:assert/strict';
import { makeReflectionEnvironment } from '../src/reflection_environment.js';

function fixture() {
    const targets=[];
    const renderer={mrt:{name:'scene'},setMRT(value){this.mrt=value;}};
    let generator;
    class Generator {
        constructor(){generator=this;this.disposals=0;}
        fromEquirectangular(source,target){
            assert.equal(renderer.mrt,null);
            if(source.fail)throw new Error('failed bake');
            if(!target){target={texture:{pmremVersion:0},disposals:0,dispose(){this.disposals++;}};targets.push(target);}
            return target;
        }
        dispose(){this.disposals++;}
    }
    const T={PMREMGenerator:Generator,RendererUtils:{
        saveRendererState:r=>({mrt:r.mrt}),restoreRendererState:(r,s)=>{r.mrt=s.mrt;}}};
    return {owner:makeReflectionEnvironment(T,renderer),renderer,targets,get generator(){return generator;}};
}
test('filtered environment reuses matching targets and retires a resized target exactly once',()=>{
    const f=fixture(),mrt=f.renderer.mrt;
    const first=f.owner.update({image:{width:384}});
    assert.equal(f.owner.update({image:{width:256}}),first); // same native cube-size bucket
    assert.equal(first.pmremVersion,2);
    const larger=f.owner.update({image:{width:512}});
    assert.notEqual(larger,first);assert.equal(f.targets[0].disposals,1);
    assert.equal(f.renderer.mrt,mrt);
    f.owner.dispose();f.owner.dispose();
    assert.equal(f.targets[1].disposals,1);assert.equal(f.generator.disposals,1);
    assert.throws(()=>f.owner.update({image:{width:512}}),/disposed/);
});
test('a failed resize restores renderer state and preserves the last usable environment',()=>{
    const f=fixture(),mrt=f.renderer.mrt;
    const first=f.owner.update({image:{width:256}});
    assert.throws(()=>f.owner.update({image:{width:512},fail:true}),/failed bake/);
    assert.equal(f.targets[0].disposals,0);assert.equal(f.renderer.mrt,mrt);
    assert.equal(f.owner.update({image:{width:256}}),first);
    f.owner.dispose();
});
