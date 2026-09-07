// A single GPU sample connects local weather to audio/gameplay without a
// terrain callback or synchronous depth readback. The surface field already
// contains roofs, moving props and other rain occluders.
export function makeWeatherListener(T,{surfaceField,cellAt,rain,refreshSeconds=.25}){
    const position=T.uniform(new T.Vector3()).setGroup(T.renderGroup);
    const material=new T.MeshBasicNodeMaterial({toneMapped:false,fog:false});
    material.name='Listener rain exposure';
    material.fragmentNode=T.vec4(surfaceField.visibilityAt(position,T.float(.06)),cellAt(position),rain,1);
    const quad=new T.QuadMesh(material);
    const target=new T.RenderTarget(1,1,{depthBuffer:false,generateMipmaps:false});
    target.texture.name='listener-weather';
    const context=T.context({});
    const stats={ready:false,exposure:1,cell:1,rain:0,samples:0,error:null};
    let last=-Infinity,pending=null,disposed=false;
    return{stats,
        async prepare(renderer,camera,time,force=false){
            if(disposed||pending||(!force&&time>=last&&time-last<refreshSeconds))return false;
            camera.getWorldPosition(position.value);
            const saved={target:renderer.getRenderTarget(),mrt:renderer.getMRT(),context:renderer.contextNode};
            try{
                renderer.setMRT(null);renderer.contextNode=context;renderer.setRenderTarget(target);
                await quad.renderAsync(renderer);
            }finally{
                renderer.contextNode=saved.context;renderer.setRenderTarget(saved.target);renderer.setMRT(saved.mrt);
            }
            last=time;
            // Readback owns no renderer state and never stalls the world frame.
            pending=renderer.readRenderTargetPixelsAsync(target,0,0,1,1).then(pixels=>{
                if(disposed)return;
                stats.exposure=pixels[0]/255;stats.cell=pixels[1]/255;stats.rain=pixels[2]/255;
                stats.ready=true;stats.samples++;stats.error=null;
            }).catch(error=>{if(!disposed){stats.error=String(error?.message??error);stats.ready=false;}})
                .finally(()=>{pending=null;});
            return true;
        },
        async settled(){await pending;return stats;},
        dispose(){if(disposed)return;disposed=true;stats.ready=false;
            // Retire the readback's texture after the copy finishes.
            const release=()=>{target.dispose();material.dispose();};
            if(pending)void pending.finally(release);else release();
        },
    };
}
