// Current geometry, with the previous position of each visible sample. This
// inexpensive unlit pass lets native PBR trace moving/skinned objects without
// intersecting their stale silhouettes in last frame's depth buffer.
export function makeReflectionGeometry(T,renderer,scene,camera,receiverIds){
    const target=new T.RenderTarget(1,1,{count:2,type:T.HalfFloatType,samples:0,
        minFilter:T.NearestFilter,magFilter:T.NearestFilter});
    target.texture.name='output';
    target.textures[1].name='motion';
    target.name='reflection-current-geometry';
    target.depthTexture=new T.DepthTexture(1,1,T.FloatType);
    const identity=new WeakMap();let nextId=1;
    const objectId=object=>{if(!identity.has(object))identity.set(object,nextId++);return identity.get(object);};
    const convex=T.uniform(1).onObjectUpdate(({object})=>receiverIds(object));
    const key=T.uniform(0).onObjectUpdate(({object})=>objectId(object));
    const previousPosition=T.velocity.previousCameraViewMatrix.mul(T.velocity.previousModelWorldMatrix)
        .mul(T.vec4(T.positionPrevious,1));
    const previousZ=T.varying(previousPosition.z,'reflectionPreviousViewZ');
    const face=T.cross(T.dFdx(T.positionView),T.dFdy(T.positionView)).normalize();
    const faceNormal=T.select(T.dot(face,T.positionView).greaterThan(0),face.negate(),face);
    const mrt=T.mrt({output:T.vec4(T.directionToColor(faceNormal),convex),
        motion:T.vec4(T.velocity.mul(T.vec2(.5,-.5)),previousZ,key)});
    // IDs are exact through 2048 in half float; use float for arbitrary host
    // object counts and previous depth at the kilometre scale.
    target.textures[1].type=T.FloatType;
    const materials=new Map(),versions=new Map(),releases=new Map(),hidden=[],swapped=[];
    const context=T.context({eanpaReflectionSurfacePass:false});
    const size=new T.Vector2();let disposed=false;
    const skipMaterial=new T.MeshBasicNodeMaterial({visible:false});
    const captureMaterial=source=>{
        if(!source||!source.visible||!source.depthWrite)return skipMaterial;
        let material=materials.get(source);
        if(material && versions.get(source)!==source.version){releases.get(source)();material=null;}
        if(material){
            for(const k of ['displacementScale','displacementBias','alphaTest','opacity'])if(source[k]!==undefined)material[k]=source[k];
            return material;
        }
        material=new T.MeshBasicNodeMaterial({side:source.side,fog:false,toneMapped:false});
        material.name='reflection-geometry:'+source.name;
        for(const k of ['positionNode','vertexNode','displacementMap','displacementScale','displacementBias',
            'alphaTest','alphaTestNode','alphaMap','clippingPlanes','clipIntersection'])if(source[k]!==undefined)material[k]=source[k];
        if(source.alphaTest>0||source.alphaTestNode){material.map=source.map;material.opacityNode=source.opacityNode;}
        material.mrtNode=mrt;
        const release=()=>{material.dispose();materials.delete(source);versions.delete(source);releases.delete(source);source.removeEventListener('dispose',release);};
        source.addEventListener('dispose',release);releases.set(source,release);
        materials.set(source,material);versions.set(source,source.version);return material;
    };
    const resize=()=>{renderer.getDrawingBufferSize(size);if(size.x!==target.width||size.y!==target.height){
        target.setSize(size.x,size.y);renderer.initRenderTarget(target);}};
    const capture=async callback=>{
        const state=T.RendererUtils.saveRendererState(renderer),oldContext=renderer.contextNode;
        const background=scene.background,override=scene.overrideMaterial,shadows=renderer.shadowMap.enabled;
        try{
            resize();scene.background=null;scene.overrideMaterial=null;renderer.shadowMap.enabled=false;
            scene.traverseVisible(object=>{
                if(object.userData?.noSSRSource){hidden.push(object);object.visible=false;return;}
                if(!object.isMesh)return;
                const source=object.material;
                swapped.push([object,source]);object.material=Array.isArray(source)?source.map(captureMaterial):captureMaterial(source);
            });
            renderer.contextNode=context;renderer.setMRT(mrt);renderer.setRenderTarget(target);
            renderer.setClearColor(0,0);return await callback();
        }finally{
            for(const [object,material]of swapped)object.material=material;swapped.length=0;
            for(const object of hidden)object.visible=true;hidden.length=0;
            scene.background=background;scene.overrideMaterial=override;renderer.shadowMap.enabled=shadows;renderer.contextNode=oldContext;
            T.RendererUtils.restoreRendererState(renderer,state);
        }
    };
    return {target,objectId,
        render:()=>disposed?undefined:capture(()=>renderer.render(scene,camera)),
        compileAsync:()=>capture(()=>renderer.compileAsync(scene,camera)),
        dispose(){if(disposed)return;disposed=true;target.dispose();skipMaterial.dispose();for(const release of [...releases.values()])release();},
    };
}
