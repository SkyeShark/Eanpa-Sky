(async()=>{
    const wasPaused=_eanpaTest.paused;_eanpaTest.pauseAfterFrame=true;
    while(!_eanpaTest.paused)await new Promise(r=>setTimeout(r,10));
    const T=THREE,r=_reflectionPipeline.pipeline.renderer,{makeImpactSmoke}=await import('/engine/impact_smoke.js');
    const saved=T.RendererUtils.saveRendererState(r),scene=new T.Scene(),camera=new T.PerspectiveCamera(50,1,.1,30);
    const uniforms={age:T.uniform(1),life:T.uniform(1/4.5),alpha:T.uniform(1),color:T.uniform(new T.Vector3(.2,.22,.24)),
        glowColor:T.uniform(new T.Vector3(1,1,1)),sceneLight:T.uniform(.4)};
    const material=new T.MeshBasicNodeMaterial(),volume=makeImpactSmoke(T,uniforms);
    material.fragmentNode=volume;
    const geometry=new T.IcosahedronGeometry(1,2),mesh=new T.InstancedMesh(geometry,material,1);scene.add(mesh);
    const target=new T.RenderTarget(96,96,{type:T.FloatType,depthBuffer:false}),images=[];
    try{
        r.setMRT(null);r.setRenderTarget(target);r.setClearColor(0,0);
        for(const [x,life]of [[0,1/4.5],[1024,1/4.5],[1024,1]]){
            mesh.setMatrixAt(0,new T.Matrix4().makeTranslation(x,0,0));mesh.instanceMatrix.needsUpdate=true;
            mesh.computeBoundingSphere();camera.position.set(x,0,3);camera.lookAt(x,0,0);uniforms.life.value=life;
            await new Promise(requestAnimationFrame);await r.renderAsync(scene,camera);
            images.push(await r.readRenderTargetPixelsAsync(target,0,0,96,96));
        }
        let difference=0,totalDifference=0,finite=true,active=0,translatedActive=0,maxAlpha=0,expired=0;
        for(let i=0;i<images[0].length;i++){
            finite&&=images.every(a=>Number.isFinite(a[i]));const delta=Math.abs(images[0][i]-images[1][i]);
            difference=Math.max(difference,delta);totalDifference+=delta;
            if(i%4===3){if(images[0][i]>.001)active++;if(images[1][i]>.001)translatedActive++;
                maxAlpha=Math.max(maxAlpha,images[0][i]);expired=Math.max(expired,images[2][i]);}
        }
        const meanDifference=totalDifference/images[0].length;
        // Float32 camera cancellation at 1 km can shift edge pixels slightly.
        // The translated volume must retain its coverage and overall response.
        return{pass:finite&&active>100&&maxAlpha>.01&&maxAlpha<.32&&difference<.012
                &&meanDifference<.0002&&Math.abs(active-translatedActive)<active*.02&&expired===0,
            finite,activePixels:active,translatedActivePixels:translatedActive,maxAlpha,
            translationMaxDifference:difference,translationMeanDifference:meanDifference,expiredMaxAlpha:expired};
    }finally{
        T.RendererUtils.restoreRendererState(r,saved);mesh.dispose();geometry.dispose();material.dispose();target.dispose();_eanpaTest.paused=wasPaused;
    }
})()
