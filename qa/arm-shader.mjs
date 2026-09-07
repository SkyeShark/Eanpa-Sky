import { connect } from './cdp.mjs';
import { writeFile } from 'node:fs/promises';
const cdp=await connect();
try {
    const shaders=await cdp.evaluate(`(async()=>{
        _eanpaTest.paused=false;_eanpaTest.pauseAfterFrame=true;
        while(!_eanpaTest.paused)await new Promise(r=>setTimeout(r,20));
        const objects=_reflectionPipeline.pipeline.renderer._objects,original=objects.get;
        let shaders;
        objects.get=function(...args){
            const object=original.apply(this,args);
            if(args[0].userData.firstPersonViewmodel){
                const state=object.getNodeBuilderState();
                shaders={fragment:state.fragmentShader,vertex:state.vertexShader};
            }
            return object;
        };
        try{await _reflectionPipeline.render();return shaders;}
        finally{objects.get=original;_eanpaTest.paused=false;}
    })()`);
    for(const [kind,source] of Object.entries(shaders))await writeFile(`artifacts/overhaul/arms-${kind}.wgsl`,source);
    console.log('Saved active arm shader');
}finally{cdp.close();}
