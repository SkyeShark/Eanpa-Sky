(async()=>{
    _eanpaTest.pauseAfterFrame=true;
    while(!_eanpaTest.paused) await new Promise(r=>setTimeout(r,20));
    const pipeline=_reflectionPipeline, ssr=pipeline.ssrNode, renderer=pipeline.pipeline.renderer;
    const original=ssr.colorNode, normal=pipeline.scenePass.getTextureNode('normal');
    try {
        ssr.colorNode=THREE.sample(coord=>THREE.vec4(coord,
            normal.load(coord.mul(THREE.textureSize(normal)).floor()).a.mul(.25),1));
        ssr._ssrMaterial.needsUpdate=true;
        ssr._ssrMaterial.fragmentNode.needsUpdate=true;
        await pipeline.render();
        const target=ssr._ssrRenderTarget, w=target.width, h=target.height;
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
    }finally{ssr.colorNode=original;ssr._ssrMaterial.needsUpdate=true;ssr._ssrMaterial.fragmentNode.needsUpdate=true;_eanpaTest.paused=false;}
})()
