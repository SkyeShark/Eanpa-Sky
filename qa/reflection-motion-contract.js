(async()=>{
    const f=__skyFixture,T=THREE,p=f.pipeline,r=f.renderer,c=f.camera;
    _eanpaTest.pauseAfterFrame=true;
    while(!_eanpaTest.paused)await new Promise(done=>setTimeout(done,10));
    f.animateCamera=false;
    for(let i=0;i<3;i++){await new Promise(requestAnimationFrame);await f.frame(f.time);}
    const previousView=c.matrixWorldInverse.clone(),previousProjection=c.projectionMatrix.clone();
    const previous=new Map();f.host.traverse(o=>{if(o.isMesh)previous.set(p.geometry.objectId(o),{object:o,matrix:o.matrixWorld.clone()});});
    c.position.x+=.27;c.lookAt(.15,1,-8);
    await new Promise(requestAnimationFrame);await f.frame(f.time+.3);
    const w=p.geometry.target.width,h=p.geometry.target.height;
    const depth=T.texture(p.geometry.target.depthTexture,T.screenUV).r;
    const mainDepth=T.texture(p.scenePass.getTexture('depth'),T.screenUV).r;
    const view=T.getViewPosition(T.screenUV,depth,T.uniform(c.projectionMatrixInverse.clone()));
    const world=T.uniform(c.matrixWorld.clone()).mul(T.vec4(view,1)).xyz;
    const material=new T.MeshBasicNodeMaterial();material.fragmentNode=T.vec4(world,T.select(depth.lessThan(.99999),T.abs(depth.sub(mainDepth)),T.float(-1)));
    const quad=new T.QuadMesh(material),target=new T.RenderTarget(w,h,{type:T.FloatType,depthBuffer:false});
    const saved=T.RendererUtils.saveRendererState(r);
    try{
        r.setMRT(null);r.setRenderTarget(target);await quad.renderAsync(r);
        const unpack=a=>{const stride=Math.ceil(w*16/256)*256/4;
            const out=new Float32Array(w*h*4);for(let y=0;y<h;y++)out.set(a.subarray(y*stride,y*stride+w*4),y*w*4);return out;};
        const [points,motion]=(await Promise.all([r.readRenderTargetPixelsAsync(target,0,0,w,h),r.readRenderTargetPixelsAsync(p.geometry.target,0,0,w,h,1)])).map(unpack);
        const groups={},q=new T.Vector3(),clip=new T.Vector3();
        for(const entry of previous.values())entry.inverse=entry.object.matrixWorld.clone().invert();
        for(let y=2;y<h-2;y+=4)for(let x=2;x<w-2;x+=4){
            const i=(y*w+x)*4,key=Math.round(motion[i+3]),entry=previous.get(key);if(!entry||points[i+3]<0)continue;
            q.fromArray(points,i).applyMatrix4(entry.inverse).applyMatrix4(entry.matrix).applyMatrix4(previousView);
            const z=q.z;clip.copy(q).applyMatrix4(previousProjection);
            const expected=[(x+.5)/w-(clip.x*.5+.5),(y+.5)/h-(-clip.y*.5+.5)];
            const pixelError=Math.hypot((motion[i]-expected[0])*w,(motion[i+1]-expected[1])*h);
            const group=groups[key]??={name:entry.object.geometry.type,samples:0,maxPixelError:0,maxPreviousZError:0,maxDepthDifference:0};
            group.samples++;group.maxPixelError=Math.max(group.maxPixelError,pixelError);
            group.maxPreviousZError=Math.max(group.maxPreviousZError,Math.abs(motion[i+2]-z));
            group.maxDepthDifference=Math.max(group.maxDepthDifference,points[i+3]);
        }
        const passed=Object.values(groups).length>=4&&Object.values(groups).every(g=>g.maxPixelError<.1&&g.maxPreviousZError<.01&&g.maxDepthDifference<.00001);
        return{passed,size:[w,h],groups,implementation:p.ssrImplementation};
    }finally{T.RendererUtils.restoreRendererState(r,saved);material.dispose();target.dispose();}
})()
