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
test('a sliced refresh runs the generator stages one per step into staging and publishes into the same target',()=>{
    const calls=[],targets=[];
    const renderer={mrt:{name:'scene'},autoClear:true,setMRT(value){this.mrt=value;},
        initRenderTarget(t){calls.push(['init',t.name]);},
        copyTextureToTexture(src,dst){calls.push(['copy',src.name,dst.name]);}};
    class Generator {
        constructor(){this._lodMeshes=[];}
        fromEquirectangular(source,target){
            if(!target){target={texture:{pmremVersion:0,name:'out'},dispose(){}};targets.push(target);}
            return target;
        }
        _setSizeFromTexture(source){calls.push(['size',source.image.width]);}
        _allocateTarget(){return {texture:{name:'staging'},scissorTest:false,dispose(){}};}
        _init(){this._lodMeshes=[0,1,2,3];}
        _textureToCubeUV(source,target){assert.equal(renderer.mrt,null);calls.push(['cubeUV',target.texture.name]);}
        _applyGGXFilter(target,lodIn,lodOut){assert.equal(renderer.autoClear,false);calls.push(['ggx',lodIn,lodOut]);}
        dispose(){}
    }
    const T={PMREMGenerator:Generator,RendererUtils:{
        saveRendererState:r=>({mrt:r.mrt,autoClear:r.autoClear}),restoreRendererState:(r,s)=>{r.mrt=s.mrt;r.autoClear=s.autoClear;}}};
    const owner=makeReflectionEnvironment(T,renderer),mrt=renderer.mrt;
    assert.equal(owner.begin({image:{width:384}}),false); // no target yet: update() makes it
    const texture=owner.update({image:{width:384}});
    assert.equal(owner.begin({image:{width:512}}),false); // another cube size: update() again
    assert.equal(owner.begin({image:{width:384}}),true);
    assert.equal(owner.busy,true);
    assert.equal(owner.begin({image:{width:384}}),false); // one refresh at a time
    const version=texture.pmremVersion;
    const published=[];
    for(let i=0;i<10&&owner.busy;i++)published.push(owner.step());
    assert.deepEqual(published,[null,null,null,null,texture]); // cube-UV, three GGX levels, the copy
    assert.equal(texture.pmremVersion,version+1);
    assert.equal(renderer.mrt,mrt);assert.equal(renderer.autoClear,true);
    assert.deepEqual(calls.filter(c=>c[0]!=='size'&&c[0]!=='init'),
        [['cubeUV','eanpa-owned-sky-pmrem-staging'],['ggx',0,1],['ggx',1,2],['ggx',2,3],
         ['copy','eanpa-owned-sky-pmrem-staging','eanpa-owned-sky-pmrem']]);
    assert.equal(targets.length,1);
    assert.equal(owner.begin({image:{width:384}}),true);owner.step();owner.cancel();
    assert.equal(owner.busy,false);assert.equal(owner.step(),null);
    owner.dispose();
});
