import { N8AONode } from './vendor/n8ao/N8AONode.js';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { createConvexReceiverIds } from './reflection_receiver_id.js';
import { makeScreenSpaceTrace } from './screen_space_trace.js';
import { makeLocalReflectionProbe } from './local_reflection_probe.js';
import { makeSkyGeometryLayer } from './sky_geometry_layer.js';

// Resolve incoming radiance before Three evaluates each native material BRDF.
// The previous HDR/depth frame supplies ray hits, reprojected through its camera.
// Copying three GPU textures avoids a second traversal/draw of the entire scene.
// Fresnel, clearcoat, anisotropy and iridescence remain native Three lighting.
export function makeNativeReflectionPipeline(T, renderer, scene, camera, sky, quality, fxaaFactory) {
    const skyLayers = (sky.depthLayers ?? []).map(options => makeSkyGeometryLayer(T,renderer,scene,camera,options));
    const localProbe = makeLocalReflectionProbe(T,renderer,scene,camera);
    const receiverIds = createConvexReceiverIds();
    const receiverId = T.uniform(1).onObjectUpdate(({object}) => receiverIds(object));
    const sourceReceiverId = T.uniform(1).onObjectUpdate(({object,material}) =>
        object.userData?.noSSRSource || material.depthWrite === false ? 0 : receiverIds(object));
    const ssrAllowed = T.uniform(1).onObjectUpdate(({object}) =>
        object.userData?.noSSR || object.userData?.noSkyReflection ? 0 : 1);
    const shared = value => T.uniform(value).setGroup(T.renderGroup);
    const history = new T.RenderTarget(1, 1, {count: 2, type: T.HalfFloatType});
    history.texture.name = 'Reflection radiance history';
    history.texture.generateMipmaps = true;
    history.texture.minFilter = T.LinearMipmapLinearFilter;
    history.textures[1].name = 'Reflection receiver history';
    history.depthTexture = new T.DepthTexture(1, 1, T.FloatType);
    // Explicit screen UVs avoid per-object texture-matrix uniforms. The local
    // TextureNode.clone() patch preserves this policy through sample/LOD chains.
    const sourceColor = T.texture(history.texture,T.screenUV);
    const sourceDepth = T.texture(history.depthTexture,T.screenUV);
    const sourceIds = T.texture(history.textures[1],T.screenUV);
    for (const node of [sourceColor, sourceDepth, sourceIds]) node.updateMatrix = false;
    const previousView = shared(new T.Matrix4());
    const previousProjection = shared(camera.projectionMatrix.clone());
    const previousProjectionInverse = shared(camera.projectionMatrixInverse.clone());
    const previousNear = shared(camera.near), previousFar = shared(camera.far);
    const historyValid = shared(0);
    const params = {maxDistance: shared(32), thickness: shared(0.15), quality: shared(1), coarseDepthGate: shared(1)};
    const trace = makeScreenSpaceTrace({colorNode: sourceColor, depthNode: sourceDepth,
        objectIdNode: T.sample(coord => sourceIds.load(coord.mul(T.textureSize(sourceIds)).floor()).a),
        camera, projection: previousProjection, projectionInverse: previousProjectionInverse,
        near: previousNear, far: previousFar, ...params,
        logarithmicDepthBuffer: renderer.logarithmicDepthBuffer});
    const ssrWeight = shared(1), skyWeight = shared(1), probeWeight = shared(1);
    const installed = new Map();
    let environmentTexture = null;
    const registerObject = root => { localProbe.registerObject(root); root.traverse(object => {
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
                                const worldRay = T.cameraWorldMatrix.mul(T.vec4(direction,0)).xyz;
                                const probe = localProbe.sample(T.positionWorld,worldRay,roughness).toVar();
                                const influence = probe.a.mul(probeWeight);
                                const fallback = incoming.mul(skyWeight).mul(influence.oneMinus())
                                    .add(probe.rgb.mul(influence)).toVar();
                                const result = fallback.toVar();
                                T.If(historyValid.greaterThan(0).and(ssrAllowed.greaterThan(0)).and(roughness.lessThan(0.8)), () => {
                                    const origin = previousView.mul(T.vec4(T.positionWorld, 1)).xyz;
                                    const ray = previousView.mul(T.cameraWorldMatrix.mul(T.vec4(direction, 0))).xyz;
                                    const plane = previousView.mul(T.cameraWorldMatrix.mul(T.vec4(T.normalViewGeometry, 0))).xyz;
                                    const hit = trace(origin, ray, plane, receiverId, roughness).toVar();
                                    const confidence = hit.a.mul(ssrWeight);
                                    result.assign(fallback.mul(confidence.oneMinus())
                                        .add(hit.rgb.mul(ssrWeight)));
                                });
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
            const release = () => {
                if (material.setupEnvironment === replacement) {
                    if (own) material.setupEnvironment=original; else delete material.setupEnvironment;
                }
                material.removeEventListener('dispose',release);
                installed.delete(material);
            };
            installed.set(material, {own, original, replacement, release});
            material.addEventListener('dispose',release);
            material.setupEnvironment = replacement;
            material.needsUpdate = true;
        }
    }); };
    registerObject(scene);
    const scenePass = T.pass(scene, camera, {samples: 0});
    // WebGPU depth24plus cannot be copied into depth32float. Keep both
    // attachments explicitly identical; failed GPU copies otherwise read zero.
    scenePass.getTexture('depth').type = T.FloatType;
    scenePass.name = 'Native PBR with local radiance';
    scenePass.contextNode = T.context({eanpaReflectionSurfacePass: true});
    const outputs = {output: T.output,
        normal: T.vec4(T.directionToColor(T.normalView), sourceReceiverId),
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
    let disposed = false, aoEnabled = true, bloomEnabled = true, auditing = false;
    const bufferSize = new T.Vector2(), lastPosition = new T.Vector3();
    const lastOrientation = new T.Quaternion();
    let hasHistory = false;
    const invalidateHistory = () => { historyValid.value = 0; hasHistory = false; };
    const prepareHistory = () => {
        renderer.getDrawingBufferSize(bufferSize);
        if (history.width !== bufferSize.x || history.height !== bufferSize.y) {
            history.setSize(bufferSize.x, bufferSize.y);
            renderer.initRenderTarget(history);
            invalidateHistory();
        }
        // Camera reprojection handles ordinary movement. Cuts and a changed
        // lens must start with the native environment, never stale geometry.
        if (hasHistory && (camera.position.distanceToSquared(lastPosition) > 25
            || Math.abs(camera.quaternion.dot(lastOrientation)) < 0.95
            || !camera.projectionMatrix.equals(previousProjection.value))) invalidateHistory();
    };
    const captureHistory = () => {
        for (const [channel, target] of [['output', history.texture],
            ['normal', history.textures[1]], ['depth', history.depthTexture]]) {
            renderer.copyTextureToTexture(scenePass.getTexture(channel), target);
        }
        previousView.value.copy(camera.matrixWorldInverse);
        previousProjection.value.copy(camera.projectionMatrix);
        previousProjectionInverse.value.copy(camera.projectionMatrixInverse);
        previousNear.value = camera.near; previousFar.value = camera.far;
        lastPosition.copy(camera.position); lastOrientation.copy(camera.quaternion);
        hasHistory = true; historyValid.value = 1;
    };
    prepareHistory();
    return {supported:true, mode:'native-pbr-screen-space-radiance', pipeline, scenePass, history, trace, localProbe, skyLayers, registerObject, invalidateHistory,
        ssrImplementation:'reprojected-history-native-material-radiance', ssrNode:params,
        ssrMaterialResponse:'native-three-base-clearcoat-anisotropy-iridescence-specular-ior',
        nativeEnvironmentPbr:true, sceneColorAttachments:4, aoAvailable:true, aoQuality:'Medium',
        bloomAvailable:true, get aoEnabled(){return aoEnabled}, get bloomEnabled(){return bloomEnabled},
        setAOEnabled(value){aoEnabled=!!value;aoWeight.value=aoEnabled?1:0;n8ao.enabled=aoEnabled;return aoEnabled;},
        setBloomEnabled(value){bloomEnabled=!!value;bloomWeight.value=bloomEnabled?1:0;return bloomEnabled;},
        setAuditContributions({ssr=true,sky=true,probe=true}={}){ssrWeight.value=ssr?1:0;skyWeight.value=sky?1:0;probeWeight.value=probe?1:0;auditing=!ssr||!sky||!probe;},
        setSsrParams(values={}){for(const k of ['maxDistance','thickness','quality','coarseDepthGate'])if(values[k]!==undefined)params[k].value=values[k];},
        setEnvironment(texture){environmentTexture=texture;invalidateHistory();localProbe.setEnvironment(texture);
            for(const material of installed.keys())if(material.envMap!==texture){material.envMap=texture;material.needsUpdate=true;}
            texture.userData.eanpaReflectionMaterialCount=installed.size;return texture;},
        update(){}, resize(w,h){scenePass.setSize(w,h);n8ao.setSize(w,h);invalidateHistory();},
        async compileAsync(){
            // r184 PassNode.compileAsync does not install the pass context.
            // Compile the actual receiving variant behind the boot screen.
            const savedContext=renderer.contextNode, savedTarget=renderer.getRenderTarget(), savedMrt=renderer.getMRT();
            try { for(const layer of skyLayers)await layer.compileAsync();
                await localProbe.compileAsync(); for(const pass of [scenePass]) {
                renderer.contextNode=pass.contextNode;
                await pass.compileAsync(renderer);
            } return true; }
            finally {for(const layer of skyLayers)layer.restoreVisibility();renderer.contextNode=savedContext;renderer.setRenderTarget(savedTarget);renderer.setMRT(savedMrt);}
        },
        async render(){if(!disposed){try{prepareHistory();for(const layer of skyLayers)await layer.render();
            if(!auditing)localProbe.update();pipeline.render();if(!auditing)captureHistory();
        }finally{for(const layer of skyLayers)layer.restoreVisibility();}}},
        dispose(){if(disposed)return;disposed=true;pipeline.dispose();for(const layer of skyLayers)layer.dispose();localProbe.dispose();history.dispose();scenePass.dispose();n8ao.dispose();glow.dispose();
            display._quadMesh?.material?.dispose();display.renderTarget?.dispose();display.dispose();
            for(const [material,state]of installed){state.release();material.needsUpdate=true;}
            installed.clear();},
    };
}
