(async()=>{
    const T=THREE,w=__eanpaWeatherByScene.get(_c.parent),r=_reflectionPipeline.pipeline.renderer,scene=_c.parent;
    const size=r.getDrawingBufferSize(new T.Vector2());
    const target=new T.RenderTarget(size.x,size.y,{type:T.UnsignedByteType,depthBuffer:false});target.texture.name='output';
    const state=T.RendererUtils.saveRendererState(r),context=r.contextNode,changes=[];
    scene.traverse(o=>{if(o.isMesh&&o!==w.rain&&o!==w.splashes){changes.push([o,o.visible]);o.visible=false;}});
    const results=[];
    try{
        r.contextNode=T.context({});r.setMRT(T.mrt({output:T.output}));r.setRenderTarget(target);r.setClearColor(0,0);
        for(const name of ['rain','splashes']){
            w.rain.visible=name==='rain';w.splashes.visible=name==='splashes';
            await r.compileAsync(scene,_c);await new Promise(requestAnimationFrame);await r.renderAsync(scene,_c);
            const pixels=await r.readRenderTargetPixelsAsync(target,0,0,size.x,size.y);
            let count=0,peak=0,total=0;for(let i=0;i<pixels.length;i+=4){const value=Math.max(pixels[i],pixels[i+1],pixels[i+2]);if(value>4)count++;peak=Math.max(peak,value);total+=value;}
            results.push({name,pixelsAbove4:count,peak,integratedBrightness:total});
        }
        // Show the isolated splashes through an ordinary colour-only quad.
        r.setMRT(null);r.setRenderTarget(null);const m=new T.MeshBasicNodeMaterial();
        m.fragmentNode=T.vec4(T.texture(target.texture,T.screenUV).rgb.mul(4),1);await new T.QuadMesh(m).renderAsync(r);m.dispose();
        return results;
    }finally{for(const[o,visible]of changes)o.visible=visible;w.rain.visible=w.splashes.visible=true;
        r.contextNode=context;T.RendererUtils.restoreRendererState(r,state);target.dispose();}
})()
