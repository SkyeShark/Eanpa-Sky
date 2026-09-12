// GPU contracts: direct light/emission survive AO, indirect light uses Three's
// native BRDF, flat surfaces do not occlude themselves, and zero never flips to
// full visibility in the spatial filter. Runs in the single owned QA page.
(async () => {
    const T=THREE,r=_reflectionPipeline.pipeline.renderer;
    const errorsBefore=[...document.body.children].find(e=>e.style?.zIndex==='99')?.textContent??'';
    _eanpaTest.pauseAfterFrame=true;
    while(!_eanpaTest.paused)await new Promise(done=>setTimeout(done,10));
    const {makeAmbientOcclusion}=await import('/src/ambient_occlusion.js');
    const {makeReflectionGeometry}=await import('/src/reflection_geometry.js');
    const saved=T.RendererUtils.saveRendererState(r),size=r.getSize(new T.Vector2());
    const oldContext=r.contextNode??T.context({}),oldShadows=r.shadowMap.enabled,emptyContext=T.context({});
    r.contextNode=oldContext;
    const scene=new T.Scene(),camera=new T.PerspectiveCamera(50,1,.18,100);
    camera.position.set(0,0,4);camera.lookAt(0,0,0);scene.add(camera);
    const plane=new T.Mesh(new T.PlaneGeometry(20,20),new T.MeshStandardNodeMaterial());scene.add(plane);
    const geometry=makeReflectionGeometry(T,r,scene,camera,()=>1);
    const ao=makeAmbientOcclusion(T,r,scene,camera,geometry);
    const target=new T.RenderTarget(128,128,{type:T.FloatType});
    const control=new T.DataTexture(new Float32Array(128*128*4),128,128,T.RGBAFormat,T.FloatType);
    for(let i=0;i<control.image.data.length;i+=4)control.image.data.set([.5,.5,.6,1],i);
    control.needsUpdate=true;
    const zero=new T.DataTexture(new Uint8Array(128*128*4),128,128);
    for(let i=0;i<zero.image.data.length;i+=4)zero.image.data.set([0,128,128,255],i);
    zero.needsUpdate=true;
    const materials=[plane.material],lights=[],checks=[];
    const assert=(name,ok,details)=>{checks.push({name,pass:!!ok,...details});};
    const unpack=raw=>{
        const f=raw instanceof Uint16Array?T.DataUtils.fromHalfFloat:raw instanceof Uint8Array?x=>x/255:x=>x;
        return Float32Array.from(raw,f);
    };
    const read=async rt=>unpack(await r.readRenderTargetPixelsAsync(rt,0,0,128,128));
    const mean=buffer=>{let sum=0,count=0;for(let y=48;y<80;y++)for(let x=48;x<80;x++){
        const i=(y*128+x)*4;sum+=buffer[i]+buffer[i+1]+buffer[i+2];count+=3;}return sum/count;};
    const render=async context=>{
        r.contextNode=context??emptyContext;r.setMRT(null);r.setRenderTarget(target);
        await new Promise(requestAnimationFrame);r.render(scene,camera);return mean(await read(target));
    };
    r.backend.device.pushErrorScope('validation');let scopePopped=false;
    try {
        r.setSize(128,128);r.toneMapping=T.NoToneMapping;r.outputColorSpace=T.LinearSRGBColorSpace;
        r.setClearColor(0,1);r.shadowMap.enabled=false;
        ao.textureNode.value=control;
        const context=T.context({getAO:ao.getAO});
        let skyEnvironment=null;
        _c.parent.traverse(o=>{if(!skyEnvironment&&o.material?.envMap)skyEnvironment=o.material.envMap;});
        for(const kind of ['direct-diffuse','direct-specular','emission','indirect-diffuse','authored-ao','chrome-clearcoat']) {
            for(const light of lights)scene.remove(light);lights.length=0;
            const material=new T.MeshPhysicalNodeMaterial({color:0xaaaaaa,roughness:.25});materials.push(material);plane.material=material;
            if(kind==='emission'){material.color.set(0);material.emissive.set(0x4488cc);material.emissiveIntensity=2;}
            else if(kind.startsWith('direct')) {
                const light=new T.DirectionalLight(0xffffff,3);light.position.set(0,0,4);scene.add(light);lights.push(light);
                if(kind==='direct-specular'){material.metalness=1;material.roughness=.15;}
            } else if(kind==='chrome-clearcoat') {
                if(!skyEnvironment)throw Error('Missing native reflection environment');
                material.envMap=skyEnvironment;material.metalness=1;material.roughness=.12;material.clearcoat=1;material.clearcoatRoughness=.06;
            } else {
                const light=new T.AmbientLight(0xffffff,3);scene.add(light);lights.push(light);
                if(kind==='authored-ao')material.aoNode=T.float(.5);
            }
            ao.setEnabled(false);const unoccluded=await render(context);
            ao.setEnabled(true);const occluded=await render(context);
            const authored=kind==='authored-ao'?.5:1;
            material.aoNode=T.float(.6*authored);material.needsUpdate=true;
            const nativeReference=await render(null);
            const error=Math.abs(occluded-nativeReference)/Math.max(1e-6,nativeReference);
            assert(kind,Number.isFinite(occluded)&&unoccluded>1e-5&&error<.003,
                {unoccluded,occluded,nativeReference,relativeError:error,ratio:occluded/unoccluded});
        }
        // Evaluate the actual prepass/denoiser as the camera moves along a plane.
        ao.textureNode.value=ao.target.texture;ao.setEnabled(true);r.contextNode=emptyContext;
        for(const [x,y]of [[0,0],[1.4,.3],[-1.4,-.3],[.3,1.4],[.3,-1.4]]) {
            camera.position.set(x,y,4);camera.lookAt(0,0,0);camera.updateMatrixWorld(true);
            await geometry.render();ao.render();
            const data=await read(ao.target);const values=[];
            for(let py=16;py<112;py++)for(let px=16;px<112;px++)values.push(data[(py*128+px)*4+2]);
            values.sort((a,b)=>a-b);const p01=values[Math.floor(values.length*.01)],median=values[values.length>>1];
            assert('unoccluded-moving-plane',p01>.94&&median>.985,{camera:[x,y,4],p01,median});
        }
        // Exercise the shipped filter with exact zero occlusion, not a CPU copy.
        const n=ao.node;n.aoSourceTextureNode.value=zero;n.syncConfigurationUniforms();n.aoSourceTextureNode.value=zero;
        r.contextNode=emptyContext;r.setMRT(null);r.setRenderTarget(n.aoTargetB);n.quadMesh.material=n.blurMaterial;n.quadMesh.render(r);
        const filtered=await read(n.aoTargetB);let maxZero=0;
        for(let y=16;y<112;y++)for(let x=16;x<112;x++)maxZero=Math.max(maxZero,filtered[(y*128+x)*4]);
        assert('fully-occluded-samples-stay-zero',maxZero===0,{maxVisibility:maxZero});
        await r.backend.device.queue.onSubmittedWorkDone();
        const validation=await r.backend.device.popErrorScope();scopePopped=true;
        assert('webgpu-validation',!validation,{error:validation?.message??null});
        const errorsAfter=[...document.body.children].find(e=>e.style?.zIndex==='99')?.textContent??'';
        assert('browser-errors',errorsBefore===errorsAfter,{newErrors:errorsAfter.slice(errorsBefore.length)});
        return {pass:checks.every(c=>c.pass),revision:T.REVISION,date:new Date().toISOString(),checks};
    } finally {
        if(!scopePopped)await r.backend.device.popErrorScope();
        ao.dispose();geometry.dispose();target.dispose();control.dispose();zero.dispose();
        plane.geometry.dispose();for(const material of materials)material.dispose();
        r.contextNode=oldContext;r.shadowMap.enabled=oldShadows;
        r.setSize(size.x,size.y);T.RendererUtils.restoreRendererState(r,saved);
    }
})()
