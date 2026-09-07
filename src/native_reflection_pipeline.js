import { N8AONode } from './vendor/n8ao/N8AONode.js';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { createConvexReceiverIds } from './reflection_receiver_id.js';
import { makeScreenSpaceTrace } from './screen_space_trace.js';

// Native lighting experiment: trace incoming radiance inside EnvironmentNode,
// before Three evaluates the material BRDF. A small source pass supplies visible
// scene radiance; the final pass shades each base/clearcoat lobe independently.
// No reconstructed specular subtraction or compact F0 approximation is needed.
export function makeNativeReflectionPipeline(T, renderer, scene, camera, sky, quality, fxaaFactory) {
    const receiverIds = createConvexReceiverIds();
    const receiverId = T.uniform(1).onObjectUpdate(({object}) => receiverIds(object));
    const ssrAllowed = T.uniform(1).onObjectUpdate(({object}) =>
        object.userData?.noSSR || object.userData?.noSkyReflection ? 0 : 1);
    const sourcePass = T.pass(scene, camera, {samples: 0});
    sourcePass.name = 'Reflection source';
    sourcePass.setResolutionScale(0.5);
    sourcePass.contextNode = T.context({eanpaReflectionSurfacePass: false});
    // Keep coverage separate from identity so filtered radiance has no dark
    // fringe at a silhouette. The compact ID target is always read unfiltered.
    sourcePass.setMRT(T.mrt({output: T.output, receiverId: T.vec4(receiverId,0,0,1)}));
    sourcePass.getTexture('receiverId').format = T.RedFormat;
    sourcePass.getTexture('receiverId').type = T.HalfFloatType;
    const sourceTexture = sourcePass.getTexture('output');
    sourceTexture.generateMipmaps = true;
    sourceTexture.minFilter = T.LinearMipmapLinearFilter;
    const sourceColor = T.texture(sourceTexture);
    const sourceDepth = T.texture(sourcePass.getTexture('depth'));
    const sourceIds = T.texture(sourcePass.getTexture('receiverId'));
    sourceColor.updateMatrix = false;
    sourceDepth.updateMatrix = false;
    const shared = value => T.uniform(value).setGroup(T.renderGroup);
    const params = {maxDistance: shared(32), thickness: shared(0.15), quality: shared(1)};
    const trace = makeScreenSpaceTrace({colorNode: sourceColor, depthNode: sourceDepth,
        objectIdNode: T.sample(coord => sourceIds.load(coord.mul(T.textureSize(sourceIds)).floor()).r),
        camera, projection: shared(camera.projectionMatrix), projectionInverse: shared(camera.projectionMatrixInverse),
        near: T.reference('near','float',camera).setGroup(T.renderGroup), far: T.reference('far','float',camera).setGroup(T.renderGroup),
        ...params, logarithmicDepthBuffer: renderer.logarithmicDepthBuffer});
    const ssrWeight = shared(1), skyWeight = shared(1);
    const installed = new Map();
    let environmentTexture = null;
    const registerObject = root => root.traverse(object => {
        for(const material of (Array.isArray(object.material) ? object.material : [object.material])) {
            if(!material || installed.has(material) || material.userData?.noSSR || material.userData?.noSkyReflection) continue;
            if(!(material.isMeshStandardMaterial || material.isMeshStandardNodeMaterial || material.isMeshPhysicalMaterial || material.isMeshPhysicalNodeMaterial)) continue;
            if(!material.envMap && !material.envNode && environmentTexture) material.envMap=environmentTexture;
            const own = Object.hasOwn(material, 'setupEnvironment');
            const original = material.setupEnvironment ?? T.MeshStandardNodeMaterial.prototype.setupEnvironment;
            const replacement = function(builder) {
                const native = original.call(this, builder);
                if(!native || builder.context.eanpaReflectionSurfacePass !== true) return native;
                return new class extends T.Node {
                    constructor() { super('vec3'); this.isLightingNode = true; }
                    setup(b) {
                        native.setup(b);
                        const model = b.context.lightingModel;
                        const nativeRadiance = b.context.radiance;
                        const coatRadiance = model.clearcoatRadiance;
                        const baseNormal = material.anisotropy > 0 || material.useAnisotropy
                            ? T.bentNormalView : T.normalView;
                        const applyLobe = (radiance, normal, roughness) => {
                            const reflected = T.positionViewDirection.negate().reflect(normal);
                            const direction = T.mix(reflected, normal, roughness.pow(4)).normalize();
                            const resolved = T.Fn(([incoming]) => {
                                const result = incoming.toVar();
                                T.If(ssrAllowed.greaterThan(0).and(roughness.lessThan(0.8)), () => {
                                    const hit = trace(T.positionView, direction, T.normalViewGeometry, receiverId, roughness).toVar();
                                    const confidence = hit.a.mul(ssrWeight);
                                    result.assign(incoming.mul(confidence.oneMinus()).mul(skyWeight)
                                        .add(hit.rgb.mul(ssrWeight)));
                                }).Else(() => { result.mulAssign(skyWeight); });
                                return result;
                            })(radiance);
                            radiance.assign(resolved);
                        };
                        applyLobe(nativeRadiance, baseNormal, T.roughness);
                        if(coatRadiance) applyLobe(coatRadiance, T.clearcoatNormalView, T.clearcoatRoughness);
                        return T.vec3(0);
                    }
                }();
            };
            installed.set(material, {own, original, replacement});
            material.setupEnvironment = replacement;
            material.needsUpdate = true;
        }
    });
    registerObject(scene);
    const scenePass = T.pass(scene, camera, {samples: 0});
    // Schedule the capture inside the same RenderPipeline frame and under its
    // linear HDR output state, before the receiving materials sample it.
    scenePass.before(sourcePass);
    scenePass.name = 'Native PBR with local radiance';
    scenePass.contextNode = T.context({eanpaReflectionSurfacePass: true});
    const outputs = {output: T.output,
        normal: T.vec4(T.directionToColor(T.normalView), T.diffuseColor.a),
        metalrough: T.vec4(T.metalness, T.roughness, 1, T.diffuseColor.a),
        emissive: T.vec4(T.emissive, T.diffuseColor.a)};
    const mrt = T.mrt(outputs);
    for(const channel of ['normal','metalrough','emissive']) mrt.setBlendMode(channel, {blending:T.MaterialBlending});
    scenePass.setMRT(mrt);
    for(const channel of ['metalrough','emissive']) scenePass.getTexture(channel).type = T.UnsignedByteType;
    const sceneColor = scenePass.getTextureNode('output');
    const n8ao = new N8AONode({beautyNode:sceneColor, beautyTexture:scenePass.getTexture('output'),
        depthNode:scenePass.getTextureNode('depth'), depthTexture:scenePass.getTexture('depth'),
        normalNode:scenePass.getTextureNode('normal'), normalTexture:scenePass.getTexture('normal'), scene, camera});
    Object.assign(n8ao.configuration, {halfRes:false, gammaCorrection:false, transparencyAware:false, accumulate:false});
    n8ao.autoDetectTransparency = false;
    n8ao.setQualityMode('Medium');
    const aoWeight = T.uniform(1), bloomWeight = T.uniform(1);
    const beauty = T.mix(sceneColor, n8ao.getTextureNode(), aoWeight.mul(scenePass.getTextureNode('metalrough').b));
    const glow = bloom(scenePass.getTextureNode('emissive'), .28, .42);
    const display = T.convertToTexture(T.renderOutput(beauty.add(glow.mul(bloomWeight))));
    const pipeline = new T.RenderPipeline(renderer);
    pipeline.outputNode = fxaaFactory(display);
    pipeline.outputColorTransform = false;
    let disposed = false, aoEnabled = true, bloomEnabled = true;
    const renderSourceObject = (...args) => {
        const [object,,,,material] = args;
        // Clouds, sky domes and effects without depth cannot be ray hits. Their
        // light is already in native PMREM; avoid shading them in this capture.
        if(material.depthWrite !== false && !object.userData?.noSSRSource) renderer.renderObject(...args);
    };
    const updateSource = sourcePass.updateBefore.bind(sourcePass);
    const savedSourceClear = new T.Color();
    sourcePass.updateBefore = frame => {
        const savedFunction=renderer.getRenderObjectFunction();
        renderer.getClearColor(savedSourceClear);
        const savedAlpha=renderer.getClearAlpha();
        try {
            renderer.setClearColor(0,0);
            renderer.setRenderObjectFunction(renderSourceObject);
            updateSource(frame);
        } finally {
            renderer.setRenderObjectFunction(savedFunction);
            renderer.setClearColor(savedSourceClear,savedAlpha);
        }
    };
    return {supported:true, mode:'native-pbr-screen-space-radiance', pipeline, scenePass, sourcePass, trace, registerObject,
        ssrImplementation:'continuous-depth-native-material-radiance', ssrNode:params,
        ssrMaterialResponse:'native-three-base-clearcoat-anisotropy-iridescence-specular-ior',
        nativeEnvironmentPbr:true, sceneColorAttachments:4, aoAvailable:true, aoQuality:'Medium',
        bloomAvailable:true, get aoEnabled(){return aoEnabled}, get bloomEnabled(){return bloomEnabled},
        setAOEnabled(value){aoEnabled=!!value;aoWeight.value=aoEnabled?1:0;n8ao.enabled=aoEnabled;return aoEnabled;},
        setBloomEnabled(value){bloomEnabled=!!value;bloomWeight.value=bloomEnabled?1:0;return bloomEnabled;},
        setAuditContributions({ssr=true,sky=true}={}){ssrWeight.value=ssr?1:0;skyWeight.value=sky?1:0;},
        setSsrParams(values={}){for(const k of ['maxDistance','thickness','quality'])if(values[k]!==undefined)params[k].value=values[k];},
        setEnvironment(texture){environmentTexture=texture;
            for(const material of installed.keys())if(material.envMap!==texture){material.envMap=texture;material.needsUpdate=true;}
            texture.userData.eanpaReflectionMaterialCount=installed.size;return texture;},
        update(){}, resize(w,h){sourcePass.setSize(w,h);scenePass.setSize(w,h);n8ao.setSize(w,h);},
        async compileAsync(){
            // r184 PassNode.compileAsync does not install the pass context.
            // Compile the actual source/final variants behind the boot screen.
            const savedContext=renderer.contextNode, savedTarget=renderer.getRenderTarget(), savedMrt=renderer.getMRT();
            try { for(const pass of [sourcePass,scenePass]) {
                renderer.contextNode=pass.contextNode;
                await pass.compileAsync(renderer);
            } return true; }
            finally {renderer.contextNode=savedContext;renderer.setRenderTarget(savedTarget);renderer.setMRT(savedMrt);}
        },
        async render(){if(!disposed)pipeline.render();},
        dispose(){if(disposed)return;disposed=true;pipeline.dispose();sourcePass.dispose();scenePass.dispose();n8ao.dispose();glow.dispose();
            display._quadMesh?.material?.dispose();display.renderTarget?.dispose();display.dispose();
            for(const [material,state]of installed){if(material.setupEnvironment!==state.replacement)continue;
                if(state.own)material.setupEnvironment=state.original;else delete material.setupEnvironment;material.needsUpdate=true;}
            installed.clear();},
    };
}
