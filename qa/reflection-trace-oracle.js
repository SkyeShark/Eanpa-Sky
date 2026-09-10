(async()=>{
    const T=THREE,p=_reflectionPipeline,r=p.pipeline.renderer;
    _eanpaTest.pauseAfterFrame=true;
    while(!_eanpaTest.paused)await new Promise(done=>setTimeout(done,10));
    p.setAuditContributions();
    for(let i=0;i<3;i++){await new Promise(requestAnimationFrame);await p.render();}
    const {makeScreenSpaceTrace}=await import('/src/screen_space_trace.js');
    const w=p.history.width,h=p.history.height;
    const size=T.vec2(w,h);
    const depth=T.texture(p.geometry.target.depthTexture,T.screenUV);
    const ids=T.texture(p.geometry.target.texture,T.screenUV).setSampler(false);
    const normal=T.texture(p.scenePass.getTexture('normal'),T.screenUV);
    const rough=T.texture(p.scenePass.getTexture('metalrough'),T.screenUV).g;
    const projection=T.uniform(_c.projectionMatrix),inverse=T.uniform(_c.projectionMatrixInverse);
    // Return exact hit UVs: no colour mip filtering or half-float coordinates.
    const tracer=makeScreenSpaceTrace({depthNode:depth,
        sampleRadiance:T.Fn(([uv])=>T.vec4(uv,0,1)),
        objectIdNode:T.sample(uv=>ids.load(uv.mul(size).floor()).a),
        hitNormalNode:T.sample(uv=>ids.load(uv.mul(size).floor()).rgb.mul(2).sub(1)),
        camera:_c,projection,projectionInverse:inverse,near:T.uniform(_c.near),far:T.uniform(_c.far),...p.ssrNode});
    const pos=T.getViewPosition(T.screenUV,depth.r,inverse),n=normal.rgb.mul(2).sub(1).normalize();
    const face=T.cross(T.dFdx(pos),T.dFdy(pos)).normalize();
    const geom=T.select(T.dot(face,pos).greaterThan(0),face.negate(),face);
    const ray=T.mix(pos.normalize().reflect(n),n,rough.pow(4)).normalize();
    const mat=new T.MeshBasicNodeMaterial();mat.fragmentNode=tracer(pos,ray,geom,normal.a,rough);
    const quad=new T.QuadMesh(mat),target=new T.RenderTarget(w,h,{type:T.FloatType,depthBuffer:false});
    const saved=T.RendererUtils.saveRendererState(r);
    try{
        r.setMRT(null);r.setRenderTarget(target);await quad.renderAsync(r);
        const unpack=a=>{const row=Math.ceil(w*4*a.BYTES_PER_ELEMENT/256)*256/a.BYTES_PER_ELEMENT;
            if(a.length===w*h*4)return a;const out=new a.constructor(w*h*4);
            for(let y=0;y<h;y++)out.set(a.subarray(y*row,y*row+w*4),y*w*4);return out;};
        const [hit,keys]=(await Promise.all([r.readRenderTargetPixelsAsync(target,0,0,w,h),r.readRenderTargetPixelsAsync(p.geometry.target,0,0,w,h)])).map(unpack);
        const f=T.DataUtils.fromHalfFloat,rows=[];let accepted=0,self=0;
        for(let y=0;y<h;y++)for(let x=0;x<w;x++){
            const i=(y*w+x)*4;const receiver=f(keys[i+3]);if(receiver<1.5||hit[i+3]<.1)continue;accepted++;
            const hx=Math.min(w-1,Math.max(0,Math.floor(hit[i]/hit[i+3]*w))),hy=Math.min(h-1,Math.max(0,Math.floor(hit[i+1]/hit[i+3]*h)));
            const key=f(keys[(hy*w+hx)*4+3]);if(key===receiver)self++;
            if(rows.length<12&&accepted%139===0)rows.push({pixel:[x,y],hit:[hx,hy],key,confidence:hit[i+3]});
        }
        return{accepted,self,rows};
    }finally{T.RendererUtils.restoreRendererState(r,saved);target.dispose();mat.dispose();}
})()
