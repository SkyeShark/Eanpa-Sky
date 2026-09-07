(async()=>{
    const wasPaused=_eanpaTest.paused;
    if(!wasPaused){_eanpaTest.pauseAfterFrame=true;
        while(!_eanpaTest.paused)await new Promise(r=>setTimeout(r,20));}
    const T=THREE,r=_reflectionPipeline.pipeline.renderer;
    const weather=globalThis.__eanpaWeatherByScene.get(_c.parent),u=weather.uniforms;
    const saved=Object.fromEntries(['wetness','surfaceWater','puddleK'].map(k=>[k,u[k].value]));
    const scene=new T.Scene(),camera=new T.OrthographicCamera(-8,8,2, -2,.1,50);
    camera.coordinateSystem=r.coordinateSystem;camera.position.set(0,10,10);camera.lookAt(0,0,0);
    camera.updateProjectionMatrix();camera.updateMatrixWorld(true);
    scene.add(new T.HemisphereLight(0xffffff,0x808080,1));
    const map=new T.DataTexture(new Uint8Array([204,128,230,255]),1,1);map.needsUpdate=true;
    const materials=[new T.MeshStandardMaterial(),new T.MeshStandardMaterial({normalMap:map}),
        new T.MeshStandardNodeMaterial(),new T.MeshStandardMaterial({flatShading:true})];
    materials[2].normalNode=T.normalize(T.vec3(.2,.3,.93));
    const geometry=new T.PlaneGeometry(3,3),meshes=[];
    for(let i=0;i<4;i++){
        const m=new T.Mesh(geometry,materials[i]);m.rotation.x=-Math.PI/2;m.position.x=-6+i*4;
        if(i===2)m.userData.noPuddles=true;
        materials[i].userData.puddleMaskNode=T.float(1);
        scene.add(m);meshes.push(m);weather.wrapMaterial(materials[i],m);
    }
    const target=new T.RenderTarget(128,32,{type:T.FloatType,count:2});
    target.textures[0].name='output';target.textures[1].name='normal';
    const state=T.RendererUtils.saveRendererState(r),snapshots=[];
    try{
        r.setMRT(T.mrt({output:T.output,normal:T.vec4(T.normalView,1)}));
        r.setRenderTarget(target);r.setScissorTest(false);r.autoClear=true;r.setClearColor(0,0);
        for(const wet of [0,1,0]){
            u.wetness.value=wet;u.surfaceWater.value=wet;u.puddleK.value=1;
            await new Promise(requestAnimationFrame);
            await r.renderAsync(scene,camera);
            const pixels=await r.readRenderTargetPixelsAsync(target,0,0,128,32,1);
            const normals=meshes.map(m=>{
                const p=m.position.clone().project(camera),x=Math.floor((p.x*.5+.5)*128),y=Math.floor((.5-p.y*.5)*32);
                return Array.from(pixels.slice((y*128+x)*4,(y*128+x)*4+3));
            });
            snapshots.push({wet,normals});
        }
        const distance=(a,b)=>Math.hypot(...a.map((v,i)=>v-b[i]));
        const unit=snapshots.every(s=>s.normals.every(n=>n.every(Number.isFinite)&&Math.abs(Math.hypot(...n)-1)<.02));
        const dryRestored=snapshots[0].normals.every((n,i)=>distance(n,snapshots[2].normals[i])<.002);
        const mappedWaterFlattens=distance(snapshots[0].normals[1],snapshots[1].normals[1])>.1;
        const excludedNormalPreserved=distance(snapshots[0].normals[2],snapshots[1].normals[2])<.002;
        return {pass:unit&&dryRestored&&mappedWaterFlattens&&excludedNormalPreserved,
            unit,dryRestored,mappedWaterFlattens,excludedNormalPreserved,snapshots};
    }finally{
        for(const [key,value]of Object.entries(saved))u[key].value=value;
        T.RendererUtils.restoreRendererState(r,state);
        target.dispose();geometry.dispose();map.dispose();for(const m of materials)m.dispose();
        _eanpaTest.paused=wasPaused;
    }
})()
