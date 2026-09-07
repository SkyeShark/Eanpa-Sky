(async()=>{
    const T=THREE,r=_reflectionPipeline.pipeline.renderer,w=__eanpaWeatherByScene.get(_c.parent);
    if(!_eanpaTest.paused)throw new Error('Pause the scene before this isolated diagnostic');
    const original=_temple.group.getObjectByName('stone_rectilinear_tier_04');
    const response=w.getSurfaceNodes(original.material);
    const geometry=original.geometry,scene=new T.Scene();
    const m=new T.MeshBasicNodeMaterial({toneMapped:false,fog:false});
    m.metalness=original.material.metalness;m.metalnessMap=original.material.metalnessMap;
    m.fragmentNode=T.vec4(response.wetness,response.puddle,response.exposure,1);
    const mesh=new T.Mesh(geometry,m);original.updateWorldMatrix(true,false);
    mesh.matrixAutoUpdate=false;mesh.matrix.copy(original.matrixWorld);scene.add(mesh);
    const size=r.getDrawingBufferSize(new T.Vector2());
    const target=new T.RenderTarget(size.x,size.y,{depthBuffer:true});
    const state=T.RendererUtils.saveRendererState(r),context=r.contextNode;
    try{
        r.contextNode=T.context({});r.setMRT(null);r.setRenderTarget(target);r.setClearColor(0,0);
        await r.compileAsync(scene,_c);await new Promise(requestAnimationFrame);await r.renderAsync(scene,_c);
        const data=await r.readRenderTargetPixelsAsync(target,0,0,size.x,size.y);
        let covered=0;const sum=[0,0,0],max=[0,0,0];
        for(let i=0;i<data.length;i+=4)if(data[i+3]){covered++;for(let j=0;j<3;j++){sum[j]+=data[i+j];max[j]=Math.max(max[j],data[i+j]);}}
        const view=new T.MeshBasicNodeMaterial();view.fragmentNode=T.texture(target.texture,T.screenUV);
        r.setRenderTarget(null);await new T.QuadMesh(view).renderAsync(r);view.dispose();
        return {covered,mean:sum.map(x=>x/covered/255),max};
    }finally{r.contextNode=context;T.RendererUtils.restoreRendererState(r,state);m.dispose();target.dispose();}
})()
