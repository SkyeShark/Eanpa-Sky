(async()=>{
    _eanpaTest.pauseAfterFrame=true;
    while(!_eanpaTest.paused) await new Promise(r=>setTimeout(r,20));
    const pipeline=_reflectionPipeline, ssr=pipeline.ssrNode, renderer=pipeline.pipeline.renderer;
    const normal=pipeline.scenePass.getTextureNode('normal');
    const debugColor=THREE.sample(coord=>THREE.vec4(coord,
        normal.load(coord.mul(THREE.textureSize(normal)).floor()).a.mul(.25),1));
    // An independent tracing pass avoids modifying/recompiling the live Fn
    // graph or leaving diagnostic hit UVs in its radiance/cache.
    const diagnostic=new ssr.constructor(debugColor,ssr.depthNode,ssr.normalNode,
        ssr.metalnessNode,ssr.roughnessNode,ssr.camera);
    diagnostic.objectIdNode=ssr.objectIdNode;
    diagnostic.specularResponseNode=ssr.specularResponseNode;
    for(const key of ['maxDistance','thickness','opacity','quality','maxRoughness'])
        diagnostic[key].value=ssr[key].value;
    try {
        diagnostic.setup({renderer,getSharedContext:()=>({})});
        diagnostic.updateBefore({renderer});
        const target=diagnostic._ssrRenderTarget, w=target.width, h=target.height;
        const raw=await renderer.readRenderTargetPixelsAsync(target,0,0,w,h);
        const normals=await renderer.readRenderTargetPixelsAsync(pipeline.scenePass.renderTarget,0,0,w,h,1);
        const f=THREE.DataUtils.fromHalfFloat, records=[];
        let accepted=0, selfHits=0, convexHits=0, hitsOnConvex=0;
        for(let y=0;y<h;y++)for(let x=0;x<w;x++){
            const i=(y*w+x)*4;
            if(f(raw[i+3])<.99)continue;
            accepted++;
            const receiver=f(normals[i+3]), hitId=f(raw[i+2])*4;
            if(receiver>1.5){convexHits++;if(Math.abs(receiver-hitId)<.25)selfHits++;}
            if(receiver<=1.5&&hitId>1.5)hitsOnConvex++;
            if(accepted%300!==1 || records.length>=20)continue;
            records.push({at:[x,y],id:f(normals[i+3]),hit:[f(raw[i])*w,f(raw[i+1])*h],hitId:f(raw[i+2])*4});
        }
        return {accepted,convexHits,selfHits,hitsOnConvex,records:records.slice(0,20)};
    }finally{diagnostic.dispose();_eanpaTest.paused=false;}
})()
