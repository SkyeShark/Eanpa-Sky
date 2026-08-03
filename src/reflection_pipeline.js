// Live sky reflection pipeline for the browser build.
//
// This is the small, app-owned subset of Eidoverse's r184 auto-enhance
// pipeline: one scene MRT (beauty + view normal + metalness/roughness), native
// per-material cloud PMREM/IBL, and a bounded screen-space local-geometry
// march. It intentionally does not patch renderer methods: environment bakes
// and other offscreen work must keep using the raw renderer.

// Browser-compatible copy of Eidoverse's vendored n8ao-webgpu node. The
// upstream attribution and CC0 license travel with it in vendor/n8ao/.
import { N8AONode } from './vendor/n8ao/N8AONode.js';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { ssr as makeSsrNode } from 'three/addons/tsl/display/SSRNode.js';

const QUALITY = {
    balanced: {
        ssrDistance: 180, ssrThickness: 0.70,
        ssrQuality: 0.50, ssrResolutionScale: 0.75,
        aoQuality: 'Medium', bloomStrength: 0.28, bloomRadius: 0.42,
    },
    performance: {
        ssrDistance: 120, ssrThickness: 0.90,
        ssrQuality: 0.38, ssrResolutionScale: 0.60,
        aoQuality: 'Performance', bloomStrength: 0.20, bloomRadius: 0.34,
    },
};

function qualityOptions(quality) {
    if (typeof quality === 'string') return QUALITY[quality] ?? QUALITY.balanced;
    const named = QUALITY[quality?.name] ?? QUALITY.balanced;
    return {
        ssrDistance: quality?.ssrDistance ?? named.ssrDistance,
        ssrThickness: quality?.ssrThickness ?? named.ssrThickness,
        ssrQuality: quality?.ssrQuality ?? named.ssrQuality,
        ssrResolutionScale: quality?.ssrResolutionScale ?? named.ssrResolutionScale,
        aoQuality: quality?.aoQuality ?? named.aoQuality,
        bloomStrength: quality?.bloomStrength ?? named.bloomStrength,
        bloomRadius: quality?.bloomRadius ?? named.bloomRadius,
    };
}

/**
 * Install a baked sky only on PBR materials, never as scene.environment.
 *
 * The browser sky is made from camera-centred Basic NodeMaterial domes. A
 * global environment enters Three's scene-level background/environment path
 * and was also impossible to opt out per object. Explicit material bindings
 * preserve the Eidoverse browser contract: sky domes remain purely visible
 * layers while opaque PBR receivers share the same baked PMREM source.
 */
export function installReflectionEnvironment(scene, texture) {
    if (!scene || !texture) return null;
    const installed = new Set();
    scene.traverse((object) => {
        if (!object?.isMesh || object.userData?.noSkyReflection) return;
        const materials = Array.isArray(object.material)
            ? object.material
            : [object.material];
        for (const material of materials) {
            const isPbr = material?.isMeshStandardMaterial
                || material?.isMeshPhysicalMaterial
                || material?.isMeshStandardNodeMaterial
                || material?.isMeshPhysicalNodeMaterial
                || (material?.isNodeMaterial
                    && material.metalness !== undefined
                    && material.roughness !== undefined);
            if (!isPbr) continue;
            if (material.envMap !== texture) {
                material.envMap = texture;
                material.needsUpdate = true;
            }
            installed.add(material);
        }
    });
    scene.environmentNode = null;
    scene.environment = null;
    texture.userData = texture.userData || {};
    texture.userData.eanpaReflectionMaterialCount = installed.size;
    return texture;
}

function isTexturePassThrough(node) {
    // Keep this predicate aligned with Three r184 convertToTexture(). Only a
    // result created from a different input kind is owned by this pipeline.
    return Boolean(node?.isSampleNode || node?.isTextureNode || node?.isPassNode);
}

function convertOwnedToTexture(THREE, node, ownedRttNodes) {
    const createsRtt = !isTexturePassThrough(node);
    const textureNode = THREE.convertToTexture(node);
    if (createsRtt && textureNode?.isRTTNode) ownedRttNodes.add(textureNode);
    return textureNode;
}

function makeFallback(THREE, fxaaFactory, renderer, scene, camera, reason) {
    let disposed = false;
    const fxaaPrimitives = ['RenderPipeline', 'pass', 'renderOutput', 'convertToTexture'];
    const canUseFxaa = typeof fxaaFactory === 'function'
        && fxaaPrimitives.every((name) => typeof THREE?.[name] === 'function');
    const hasCanvasMsaa = Number(renderer?.samples ?? 0) > 0;
    if (!canUseFxaa && !hasCanvasMsaa) {
        const missing = fxaaPrimitives.filter((name) => typeof THREE?.[name] !== 'function');
        if (typeof fxaaFactory !== 'function') missing.push('FXAA factory');
        throw new Error(
            `[reflection-pipeline] No antialiased fallback for "${reason}"; missing: ${missing.join(', ')}`,
        );
    }

    const ownedRttNodes = new Set();
    const fallbackPass = canUseFxaa
        ? THREE.pass(scene, camera, { samples: 0 })
        : null;
    const fallbackPipeline = canUseFxaa
        ? new THREE.RenderPipeline(renderer)
        : null;
    if (fallbackPipeline) {
        const finalColor = THREE.renderOutput(fallbackPass);
        const fxaaInput = convertOwnedToTexture(THREE, finalColor, ownedRttNodes);
        fallbackPipeline.outputNode = fxaaFactory(fxaaInput);
        fallbackPipeline.outputColorTransform = false;
    }

    const aoReason = `N8AO unavailable because live pipeline fell back: ${reason}`;
    return {
        supported: false,
        mode: 'baked-environment',
        reason,
        antialiasMode: canUseFxaa ? 'fxaa' : 'msaa',
        aoAvailable: false,
        aoEnabled: false,
        aoQuality: null,
        aoReason,
        setAOEnabled() { return false; },
        bloomAvailable: false,
        bloomEnabled: false,
        setBloomEnabled() { return false; },
        setEnvironment(texture) {
            return installReflectionEnvironment(scene, texture);
        },
        update() {},
        resize(width, height) {
            if (!disposed && width > 0 && height > 0) {
                fallbackPass?.setSize?.(width, height);
            }
        },
        async render() {
            if (disposed) return;
            if (fallbackPipeline) fallbackPipeline.render();
            else await renderer.renderAsync(scene, camera);
        },
        dispose() {
            if (disposed) return;
            disposed = true;
            fallbackPipeline?.dispose?.();
            disposeOwnedRttNodes(ownedRttNodes);
            fallbackPass?.dispose?.();
        },
    };
}

function disposeOwnedRttNodes(nodes) {
    // Three r184 RTTNode inherits Node.dispose() (event only): neither that
    // event nor RenderPipeline.dispose() releases its private fullscreen
    // material or RenderTarget. convertOwnedToTexture() records a node only
    // when the input was not an existing sample/texture/pass-through node,
    // so hook-supplied RTTs, PassTextureNodes and effect-owned targets remain
    // with their original owners.
    for (const node of nodes) {
        if (!node?.isRTTNode) continue;
        node._quadMesh?.material?.dispose?.();
        node.renderTarget?.dispose?.();
        node.dispose?.();
    }
    nodes.clear?.();
}

function makeEidoverseSsr({
    color, depth, normal, metalrough, camera,
    maxDistance, thickness, quality, resolutionScale,
}) {
    // This is the exact Three r184 SSRNode used by Eidoverse's auto-enhance
    // path. Its perspective-correct reciprocal-Z march, adaptive pixel count,
    // neighbor-derived thickness and plane-distance validation are essential:
    // the old fixed-step linear interpolation almost never produced a valid
    // local-geometry hit in this hundreds-of-metres scene.
    const node = makeSsrNode(
        color, depth, normal, metalrough.r, metalrough.g, camera,
    );
    node.maxDistance.value = maxDistance;
    node.thickness.value = thickness;
    node.quality.value = quality;
    node.resolutionScale = resolutionScale;
    return node;
}

/**
 * Build an isolated live reflection pipeline.
 *
 * The returned render() replaces renderer.renderAsync(scene, camera) for the
 * main beauty pass only. Environment bakes must continue to call the raw
 * renderer. Recreate this object whenever the sky system changes so its
 * per-material native environment binding follows the active sky.
 */
export function makeReflectionPipeline(
    THREE, renderer, scene, camera, sky, quality = 'balanced',
    fxaaFactory = null,
) {
    const required = [
        'RenderPipeline', 'pass', 'mrt', 'output', 'normalView',
        'directionToColor', 'colorToDirection', 'metalness', 'roughness',
        'sample', 'convertToTexture',
        'uniform', 'mix', 'emissive', 'renderOutput',
    ];
    const missing = required.filter((name) => !THREE[name]);
    if (typeof fxaaFactory !== 'function') missing.push('FXAA factory');
    if (missing.length) {
        return makeFallback(
            THREE, fxaaFactory, renderer, scene, camera,
            `missing reflection dependencies: ${missing.join(', ')}`,
        );
    }

    const options = qualityOptions(quality);

    // Cloud radiance is already part of the periodically refreshed PMREM that
    // is assigned to every PBR material. Keep it inside Three's native IBL
    // BRDF: this is where final base/specular color, metalness, roughness,
    // normal maps, Fresnel, multiscattering and specular occlusion belong.
    // A screen-space cloud post layer cannot reproduce that angular filter;
    // blurring neighbouring receiver pixels mixes unrelated reflection rays
    // and creates the coloured oil-slick bands seen on curved/normal-mapped
    // surfaces. SSR remains a separate local-geometry layer below.

    // The donor Eidoverse stack resolves edge quality with final-output FXAA.
    // Explicitly keep the four-color scene MRT single-sample: otherwise
    // PassNode inherits renderer.samples=4 and multisamples beauty, normal,
    // metal/roughness, emissive, and depth before every full-screen effect.
    const scenePass = THREE.pass(scene, camera, { samples: 0 });
    const auxiliaryAlpha = THREE.diffuseColor ? THREE.diffuseColor.a : THREE.float(1);
    const sceneMrt = THREE.mrt({
        output: THREE.output,
        normal: THREE.vec4(THREE.directionToColor(THREE.normalView), auxiliaryAlpha),
        // B stores the N8AO receiver acceptance weight. SSR consumes only R/G,
        // so thin materials can reduce or reject cavity darkening without a
        // fifth color attachment (which exceeds WebGPU's byte budget).
        metalrough: THREE.vec4(THREE.metalness, THREE.roughness, 1, auxiliaryAlpha),
        // Selective bloom consumes only authored emissive energy. Bright sky,
        // sun, and live cloud reflections therefore cannot produce the broad
        // dark-edge halos that a beauty-buffer threshold introduces.
        emissive: THREE.vec4(THREE.emissive, auxiliaryAlpha),
    });
    if (sceneMrt.setBlendMode && THREE.MaterialBlending !== undefined) {
        sceneMrt.setBlendMode('normal', { blending: THREE.MaterialBlending });
        sceneMrt.setBlendMode('metalrough', { blending: THREE.MaterialBlending });
        sceneMrt.setBlendMode('emissive', { blending: THREE.MaterialBlending });
    }
    scenePass.setMRT(sceneMrt);

    const sceneColor = scenePass.getTextureNode('output');
    const sceneDepth = scenePass.getTextureNode('depth');
    const packedNormal = scenePass.getTextureNode('normal');
    const sceneMetalrough = scenePass.getTextureNode('metalrough');
    const sceneEmissive = scenePass.getTextureNode('emissive');
    const sceneAoMask = sceneMetalrough.b;
    const sceneNormal = THREE.sample((coord) => (
        THREE.colorToDirection(packedNormal.sample(coord))
    ));

    // Match Eidoverse's MRT bandwidth optimization. N8AO consumes the same
    // directionToColor-encoded normal attachment directly; it does not render
    // a second beauty/normal scene pass.
    if (THREE.UnsignedByteType && scenePass.getTexture) {
        for (const channel of ['normal', 'metalrough']) {
            const texture = scenePass.getTexture(channel);
            if (texture) texture.type = THREE.UnsignedByteType;
        }
    }

    // N8AO owns only its full-screen AO/denoise targets. Do not pass its
    // optional `scenePassNode` workaround here: every attachment below is a
    // PassTextureNode used by this output graph (AO, live reflection, SSR and
    // bloom). Three r184 therefore schedules `scenePass` once, before N8AO.
    // Supplying it as well makes N8AO call scenePass.updateBefore() directly,
    // bypassing NodeFrame's once-per-frame guard and submitting the complete
    // local scene MRT a second time.
    const uAoEnabled = THREE.uniform(1);
    let n8ao = null;
    let n8aoOutput = null;
    let aoFailure = null;
    try {
        n8ao = new N8AONode({
            beautyNode: sceneColor,
            beautyTexture: scenePass.getTexture('output'),
            depthNode: sceneDepth,
            depthTexture: scenePass.getTexture('depth'),
            normalNode: packedNormal,
            normalTexture: scenePass.getTexture('normal'),
            scene,
            camera,
        });
        // Keep the complete chain linear until RenderPipeline's final output
        // transform, and use the validated full-resolution path. Transparent
        // foliage is already represented in the shared MRT; the auxiliary
        // transparency re-render would duplicate work and reintroduce halos.
        n8ao.configuration.halfRes = false;
        n8ao.configuration.gammaCorrection = false;
        n8ao.configuration.transparencyAware = false;
        n8ao.configuration.accumulate = false;
        n8ao.autoDetectTransparency = false;
        n8ao.setQualityMode(options.aoQuality);
        n8aoOutput = n8ao.getTextureNode();
    } catch (error) {
        aoFailure = error instanceof Error ? error.message : String(error);
        console.warn('[reflection-pipeline] N8AO unavailable:', error);
        n8ao?.dispose?.();
        n8ao = null;
        n8aoOutput = null;
        uAoEnabled.value = 0;
    }

    // Runtime switching is a uniform mix, not a graph/pipeline rebuild.
    // convertToTexture makes the AO-composited beauty sampleable by both the
    // live sky hook and the bounded SSR ray marcher.
    const ownedRttNodes = new Set();
    const aoAcceptance = uAoEnabled.mul(sceneAoMask);
    const aoSceneColor = n8aoOutput
        ? convertOwnedToTexture(
            THREE,
            THREE.mix(sceneColor, n8aoOutput, aoAcceptance),
            ownedRttNodes,
        )
        : sceneColor;
    const ssrNode = makeEidoverseSsr({
        color: aoSceneColor,
        depth: sceneDepth,
        normal: sceneNormal,
        metalrough: sceneMetalrough,
        camera,
        maxDistance: options.ssrDistance,
        thickness: options.ssrThickness,
        quality: options.ssrQuality,
        resolutionScale: options.ssrResolutionScale,
    });
    const ssrTexture = convertOwnedToTexture(THREE, ssrNode, ownedRttNodes);
    const ssrEdgeDistance = THREE.min(
        THREE.min(THREE.uv().x, THREE.float(1).sub(THREE.uv().x)),
        THREE.min(THREE.uv().y, THREE.float(1).sub(THREE.uv().y)),
    );
    const ssrEdgeFade = THREE.smoothstep(0.05, 0.15, ssrEdgeDistance);
    const ssrRgb = ssrTexture.rgb.mul(ssrEdgeFade);
    // Runtime-only audit gate lets the parity harness isolate Three's native
    // PMREM/IBL result from the local SSR layer without rebuilding the graph.
    const uSsrAudit = THREE.uniform(1);
    const reflectedColor = aoSceneColor
        // Three's SSR is the final reflection layer. Do not use its binary
        // hit alpha to erase native IBL: SSRNode's RGB is already weighted by
        // the receiver's final metalness, Fresnel and hit distance, while its
        // alpha is only a hard hit/miss bit.
        .add(ssrRgb.mul(uSsrAudit));

    // Three r184's native WebGPU UnrealBloom node, matching Eidoverse's post
    // stack. It is intentionally selective: the MRT emissive attachment lets
    // the Inanna blue/red fixtures bloom while ordinary PBR highlights and
    // the HDR sky stay crisp.
    const uBloomEnabled = THREE.uniform(1);
    const bloomContribution = bloom(
        sceneEmissive,
        options.bloomStrength,
        options.bloomRadius,
        0.72,
    );
    const colorOut = reflectedColor.add(bloomContribution.mul(uBloomEnabled));

    // Three r184 FXAA requires display-referred sRGB input. Match Eidoverse's
    // ordering exactly: tone-map/color-convert into a sampleable texture,
    // then anti-alias that finished image and disable a second output transform.
    const finalColor = THREE.renderOutput(colorOut);
    const fxaaInput = convertOwnedToTexture(THREE, finalColor, ownedRttNodes);
    const antialiasedColor = fxaaFactory(fxaaInput);
    const pipeline = new THREE.RenderPipeline(renderer);
    pipeline.outputNode = antialiasedColor;
    pipeline.outputColorTransform = false;

    let disposed = false;
    let aoEnabled = Boolean(n8ao);
    let bloomEnabled = true;
    const ownedGlobals = {
        hook: globalThis._autoEnhanceCloudReflectHook,
        blur: globalThis._autoEnhanceCloudReflectBlurHook,
    };

    return {
        supported: true,
        mode: 'native-cloud-pmrem-eidoverse-ssr',
        reflectionCompose: 'native-cloud-pmrem-ibl_then-three-ssr',
        skyRoughnessMode: 'three-pmrem-angular-prefilter',
        cloudReflectionMaterialSource: 'native-material-brdf-final-maps',
        cloudReflectionWeighting: 'three-pmrem-environment-brdf',
        cloudReflectionAo: 'native-material-ibl-occlusion',
        cloudReflectionResolutionScale: null,
        cloudReflectionUpdate: 'periodic-equirectangular-pmrem',
        ssrImplementation: 'three/addons/tsl/display/SSRNode.js',
        aoReceiverMask: 'metalrough-b-per-material',
        environmentSuppressedMaterials: 0,
        nativeEnvironmentPbr: true,
        scenePass,
        pipeline,
        ssrNode,
        aoAvailable: Boolean(n8ao),
        get aoEnabled() { return aoEnabled; },
        aoQuality: n8ao ? options.aoQuality : null,
        aoReason: n8ao ? null : (aoFailure ?? 'N8AO construction failed'),
        setAOEnabled(enabled) {
            if (disposed || !n8ao) {
                aoEnabled = false;
                uAoEnabled.value = 0;
                return false;
            }
            aoEnabled = Boolean(enabled);
            uAoEnabled.value = aoEnabled ? 1 : 0;
            n8ao.enabled = aoEnabled;
            if (aoEnabled) n8ao.firstFrame?.();
            return aoEnabled;
        },
        bloomAvailable: true,
        get bloomEnabled() { return bloomEnabled; },
        setBloomEnabled(enabled) {
            if (disposed) return false;
            bloomEnabled = Boolean(enabled);
            uBloomEnabled.value = bloomEnabled ? 1 : 0;
            return bloomEnabled;
        },
        setAuditContributions({ ssr = true } = {}) {
            if (disposed) return false;
            uSsrAudit.value = ssr ? 1 : 0;
            return true;
        },
        setEnvironment(texture) {
            return installReflectionEnvironment(scene, texture);
        },
        update() {
            if (disposed) return;
        },
        resize(width, height) {
            if (disposed) return;
            if (width > 0 && height > 0) {
                scenePass.setSize(width, height);
                n8ao?.setSize?.(width, height);
                ssrNode.setSize?.(width, height);
            }
        },
        async render() {
            if (disposed) return;
            pipeline.render();
        },
        dispose() {
            if (disposed) return;
            disposed = true;
            pipeline.dispose?.();
            disposeOwnedRttNodes(ownedRttNodes);
            bloomContribution.dispose?.();
            ssrNode.dispose?.();
            n8ao?.dispose?.();
            scenePass.dispose?.();
        },
    };
}
