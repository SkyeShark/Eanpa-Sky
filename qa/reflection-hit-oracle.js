(async () => {
    const p = _reflectionPipeline, ssr = p.ssrNode, r = p.pipeline.renderer;
    const normal = p.scenePass.getTextureNode('normal');
    const diagnostic = new ssr.constructor(THREE.sample(coord => THREE.vec4(coord, 0, 1)),
        ssr.depthNode, ssr.normalNode, ssr.metalnessNode, ssr.roughnessNode, ssr.camera);
    diagnostic.objectIdNode = ssr.objectIdNode;
    diagnostic.specularResponseNode = ssr.specularResponseNode;
    for (const key of ['maxDistance', 'thickness', 'quality', 'maxRoughness'])
        diagnostic[key].value = ssr[key].value;
    const target = p.scenePass.renderTarget, w = target.width, h = target.height;
    const depthTarget = new THREE.RenderTarget(w, h, { type: THREE.FloatType, depthBuffer: false });
    const depthMaterial = new THREE.NodeMaterial();
    depthMaterial.fragmentNode = THREE.vec4(ssr.depthNode.r, 0, 0, 1);
    const quad = new THREE.QuadMesh(depthMaterial);
    const savedTarget = r.getRenderTarget();
    try {
        diagnostic.setup({ renderer: r, getSharedContext: () => ({}) });
        diagnostic.updateBefore({ renderer: r });
        r.setRenderTarget(depthTarget); quad.render(r); r.setRenderTarget(savedTarget);
        const [hits, depths, normals, beauty, materials, radiance] = await Promise.all([
            r.readRenderTargetPixelsAsync(diagnostic._ssrRenderTarget, 0, 0, w, h),
            r.readRenderTargetPixelsAsync(depthTarget, 0, 0, w, h),
            r.readRenderTargetPixelsAsync(target, 0, 0, w, h, 1),
            r.readRenderTargetPixelsAsync(target, 0, 0, w, h, 0),
            r.readRenderTargetPixelsAsync(target, 0, 0, w, h, 2),
            r.readRenderTargetPixelsAsync(ssr._ssrRenderTarget, 0, 0, w, h),
        ]);
        const f = THREE.DataUtils.fromHalfFloat;
        const index = (x, y) => (Math.min(h-1, Math.max(0, Math.floor(y))) * w + Math.min(w-1, Math.max(0, Math.floor(x)))) * 4;
        const viewPosition = (x,y) => new THREE.Vector3((x+.5)/w*2-1, 1-(y+.5)/h*2, depths[index(x,y)])
            .applyMatrix4(_c.projectionMatrixInverse);
        const rows = [], meshList = [];
        _c.parent.traverseVisible(o => { if(o.isMesh && !o.isInstancedMesh && !o.isSkinnedMesh) meshList.push(o); });
        const raycaster = new THREE.Raycaster();
        let accepted = 0, receivers = 0;
        for(let y=260;y<620;y+=8)for(let x=350;x<1250;x+=8){
            const i=index(x,y); if(f(normals[i+3])<1.5) continue; receivers++;
            if(f(hits[i+3])<.99)continue; accepted++;
            if(rows.length>=36 || accepted%43!==1)continue;
            const uv = [f(hits[i]), f(hits[i+1])];
            const hx=uv[0]*w, hy=uv[1]*h, hi=index(hx,hy);
            const start=viewPosition(x,y), hit=viewPosition(hx,hy);
            const n=new THREE.Vector3(...Array.from(normals.slice(i,i+3),v=>f(v)*2-1)).normalize();
            const direction=start.clone().normalize().reflect(n).normalize();
            const separation=hit.clone().sub(start), along=separation.dot(direction);
            const offset=separation.clone().addScaledVector(direction,-along).length();
            raycaster.setFromCamera(new THREE.Vector2(uv[0]*2-1,1-uv[1]*2),_c);
            const surface=raycaster.intersectObjects(meshList,false)[0];
            const hitNormal=new THREE.Vector3(...Array.from(normals.slice(hi,hi+3),v=>f(v)*2-1)).normalize();
            rows.push({at:[x,y],hit:[hx,hy],surface:surface?.object.name, offset, along,
                hitFacing:hitNormal.dot(direction), roughness:materials[i+1]/255,
                color:Array.from(beauty.slice(hi,hi+3),f), source:Array.from(radiance.slice(i,i+3),f)});
        }
        return {receivers,accepted,rows};
    } finally { r.setRenderTarget(savedTarget); diagnostic.dispose(); depthTarget.dispose(); depthMaterial.dispose(); }
})()
