// Distant solid geometry needs its own depth buffer. Its HDR colour/coverage is
// then composited behind local geometry and beneath the existing cloud layers.
// This lets mountains occlude valleys and moon fragments occlude each other
// without placing the reconstruction shell behind their main-scene depth.
export function makeSkyGeometryLayer(T,renderer,scene,camera,{objects,renderOrder=-99,opacity=null}){
    const target=new T.RenderTarget(1,1,{type:T.HalfFloatType,depthBuffer:true});
    target.texture.name='output';
    const captureScene=new T.Scene(),context=T.context({eanpaReflectionSurfacePass:false});
    const mrt=T.mrt({output:T.output});
    const source=T.texture(target.texture,T.screenUV);
    const fade=opacity??T.float(1);
    const material=new T.MeshBasicNodeMaterial({transparent:true,depthWrite:false,depthTest:true,fog:false,
        blending:T.CustomBlending,blendSrc:T.OneFactor,blendDst:T.OneMinusSrcAlphaFactor,
        blendSrcAlpha:T.OneFactor,blendDstAlpha:T.OneMinusSrcAlphaFactor});
    material.vertexNode=T.vec4(T.positionGeometry.xy,1,1);
    material.colorNode=source.rgb.mul(fade);material.opacityNode=source.a.mul(fade);
    material.mrtNode=T.mrt({normal:T.vec4(0),metalrough:T.vec4(0),emissive:T.vec4(0)});
    const geometry=new T.BufferGeometry();
    geometry.setAttribute('position',new T.Float32BufferAttribute([-1,-1,0,3,-1,0,-1,3,0],3));
    const proxy=new T.Mesh(geometry,material);
    proxy.name='depth-tested-celestial-layer';proxy.frustumCulled=false;proxy.renderOrder=renderOrder;
    proxy.userData.noWet=true;proxy.userData.noCloudShadow=true;proxy.userData.noSSRSource=true;
    scene.add(proxy);
    const materialDepth=new Map(),exclusions=new Map();
    for(const root of objects){
        exclusions.set(root,root.userData.noSSRSource);root.userData.noSSRSource=true;
        root.traverse(o=>{for(const m of(Array.isArray(o.material)?o.material:[o.material])){
            if(m&&!m.transparent&&!materialDepth.has(m)){materialDepth.set(m,m.depthWrite);m.depthWrite=true;}
        }});
    }
    const size=new T.Vector2(),hidden=[];
    const resize=()=>{renderer.getDrawingBufferSize(size);if(target.width!==size.x||target.height!==size.y)target.setSize(size.x,size.y)};
    const restoreVisibility=()=>{for(const [object,visible]of hidden)object.visible=visible;hidden.length=0;};
    const hide=()=>{for(const o of objects){hidden.push([o,o.visible]);o.visible=false}};
    const inCapture=async callback=>{
        const state=T.RendererUtils.saveRendererState(renderer),savedContext=renderer.contextNode;
        const parents=objects.map(o=>[o,o.parent]);
        try{
            resize();for(const [o]of parents)captureScene.attach(o);
            renderer.contextNode=context;renderer.setMRT(mrt);renderer.setRenderTarget(target);
            renderer.setClearColor(0,0);renderer.toneMapping=T.NoToneMapping;
            renderer.outputColorSpace=T.LinearSRGBColorSpace;
            return await callback();
        }finally{
            for(const [o,parent]of parents)if(parent)parent.attach(o);else captureScene.remove(o);
            renderer.contextNode=savedContext;T.RendererUtils.restoreRendererState(renderer,state);
        }
    };
    let disposed=false;
    return {target,proxy,restoreVisibility,
        async compileAsync(){await inCapture(()=>renderer.compileAsync(captureScene,camera));hide();},
        async render(){if(disposed)return;restoreVisibility();await inCapture(()=>renderer.render(captureScene,camera));hide();},
        dispose(){if(disposed)return;disposed=true;restoreVisibility();scene.remove(proxy);geometry.dispose();material.dispose();target.dispose();
            for(const [m,write]of materialDepth)m.depthWrite=write;
            for(const [o,previous]of exclusions){if(previous===undefined)delete o.userData.noSSRSource;else o.userData.noSSRSource=previous;}
        },
    };
}
