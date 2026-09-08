(async()=>{
    const wasPaused=_eanpaTest.paused;
    _eanpaTest.pauseAfterFrame=true;
    while(!_eanpaTest.paused)await new Promise(r=>setTimeout(r,10));
    const T=THREE,w=__eanpaWeatherByScene.get(_c.parent),r=_reflectionPipeline.pipeline.renderer;
    const saved=T.RendererUtils.saveRendererState(r),time=w.uniforms.time.value;
    const target=new T.RenderTarget(256,256,{type:T.FloatType,depthBuffer:false});
    const scanMaterial=new T.MeshBasicNodeMaterial();
    const scanPosition=T.vec3(T.uv().x.sub(.5).mul(2400),2,T.uv().y.sub(.5).mul(2400));
    scanMaterial.fragmentNode=T.vec4(w.rainCellAt(scanPosition),0,0,1);
    const quad=new T.QuadMesh(scanMaterial),scene=new T.Scene();
    const source=new T.MeshStandardNodeMaterial();w.wrapMaterial(source);
    const response=w.getSurfaceNodes(source),probe=new T.MeshBasicNodeMaterial();
    probe.fragmentNode=T.vec4(response.rippleSlope,w.rainCellAt(T.positionWorld),1);
    const geometry=new T.PlaneGeometry(16,16),plane=new T.Mesh(geometry,probe);
    plane.rotation.x=-Math.PI/2;scene.add(plane);
    const camera=new T.OrthographicCamera(-8,8,8,-8,.1,50);
    try{
        r.setMRT(null);r.setRenderTarget(target);await quad.renderAsync(r);
        const cells=await r.readRenderTargetPixelsAsync(target,0,0,256,256);
        const candidates={wet:null,dry:null};
        for(let z=0;z<256;z++)for(let x=0;x<256;x++){
            const cell=cells[(z*256+x)*4],p=[((x+.5)/256-.5)*2400,2,((z+.5)/256-.5)*2400];
            const distance=Math.hypot(p[0],p[2]);
            const kind=cell>.98?'wet':cell<1e-6?'dry':null;
            if(kind&&(!candidates[kind]||distance<candidates[kind].distance))candidates[kind]={p,cell,distance};
        }
        if(!candidates.wet||!candidates.dry)throw new Error('Sunshower needs both raining and dry cloud cells');
        const results=[];
        for(const [name,candidate]of Object.entries(candidates)){
            plane.position.fromArray(candidate.p);camera.position.copy(plane.position).add(new T.Vector3(0,8,0));
            camera.lookAt(plane.position);camera.updateMatrixWorld(true);
            for(const advance of [0,.27]){
                w.uniforms.time.value=time+advance;await new Promise(requestAnimationFrame);
                await r.renderAsync(scene,camera);
                const pixels=await r.readRenderTargetPixelsAsync(target,0,0,256,256);
                let dry=0,wet=0,leaks=0,nonzero=0,maxSlope=0,finite=true;
                for(let i=0;i<pixels.length;i+=4){
                    const slope=Math.hypot(pixels[i],pixels[i+1]),cell=pixels[i+2];
                    finite&&=Number.isFinite(slope)&&Number.isFinite(cell);maxSlope=Math.max(maxSlope,slope);
                    if(cell<1e-6){dry++;if(slope>1e-7)leaks++;}
                    if(cell>.9){wet++;if(slope>1e-5)nonzero++;}
                }
                results.push({name,advance,dry,wet,leaks,nonzero,maxSlope,finite,
                    pass:finite&&leaks===0&&(name==='dry'?dry>1000:wet>60000&&nonzero>100)});
            }
        }
        return{pass:results.every(x=>x.pass),weather:w.state.name,time,wetness:w.uniforms.wetness.value,
            water:w.uniforms.surfaceWater.value,candidates,results};
    }finally{
        w.uniforms.time.value=time;T.RendererUtils.restoreRendererState(r,saved);
        target.dispose();scanMaterial.dispose();source.dispose();probe.dispose();geometry.dispose();
        _eanpaTest.paused=wasPaused;
    }
})()
