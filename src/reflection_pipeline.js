// Live sky reflection pipeline for the browser build.
//
// This is the small, app-owned subset of Eidoverse's r184 auto-enhance
// pipeline: one scene MRT (beauty + view normal + metalness/roughness + resolved
// specular data), the sky system's same-ray live/baked fallback, and a bounded
// screen-space local-geometry march. It intentionally does not patch renderer
// methods: environment bakes and other offscreen work keep using the raw
// renderer.

// Browser-compatible copy of Eidoverse's vendored n8ao-webgpu node. The
// upstream attribution and CC0 license travel with it in vendor/n8ao/.
import { N8AONode } from './vendor/n8ao/N8AONode.js';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { ssr as makeSsrNode } from 'three/addons/tsl/display/SSRNode.js';

// Keep the donor's thin, full-resolution hit domain, scaled only far enough for
// Eanpa's dais/temple contact reflections. Every tier deliberately marches each
// target pixel: sub-unit quality skipped dominant-axis pixels and made the
// SSR/sky ownership mask form the structured underside pattern reported on the
// Inanna orb. Performance mode saves work in range, AO, and bloom instead of
// reintroducing that reflection defect.
const QUALITY = {
    balanced: {
        ssrDistance: 32, ssrThickness: 0.15,
        ssrQuality: 1.00, ssrResolutionScale: 1.0,
        aoQuality: 'Medium', bloomStrength: 0.28, bloomRadius: 0.42,
    },
    performance: {
        ssrDistance: 24, ssrThickness: 0.20,
        ssrQuality: 1.00, ssrResolutionScale: 1.0,
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

function isPbrMaterial(material) {
    return Boolean(material && (
        material.isMeshStandardMaterial
        || material.isMeshPhysicalMaterial
        || material.isMeshStandardNodeMaterial
        || material.isMeshPhysicalNodeMaterial
        || (material.isNodeMaterial
            && material.metalness !== undefined
            && material.roughness !== undefined)
    ));
}

function isZeroEnvironmentNode(node) {
    const value = node?.node?.value ?? node?.value;
    if (Array.isArray(value)) return value.length >= 3
        && value.slice(0, 3).every((component) => Math.abs(component) <= 1e-9);
    return value && Math.abs(value.x ?? Infinity) <= 1e-9
        && Math.abs(value.y ?? Infinity) <= 1e-9
        && Math.abs(value.z ?? Infinity) <= 1e-9;
}

function needsNativeOnlyReflection(material, ignoreEnvironment = false) {
    if (!material) return true;
    if (material.transparent && material.alphaTest <= 0.0001) return true;
    if (material.userData?.noSkyReflection || material.userData?.noSSR) return true;
    if (!ignoreEnvironment && material.envNode
        && !isZeroEnvironmentNode(material.envNode)) return true;
    const envRotation = material.envMapRotation;
    if (envRotation && (Math.abs(envRotation.x) > 1e-7
        || Math.abs(envRotation.y) > 1e-7
        || Math.abs(envRotation.z) > 1e-7)) return true;

    // The base Standard/Physical lobe below is exact. Extra Physical lobes
    // remain entirely native until SSR has a matching clearcoat/sheen/
    // iridescence/transmission ray model; approximating them is worse than
    // retaining their correct PMREM result.
    return Number(material.clearcoat ?? 0) > 0
        || Boolean(material.clearcoatMap || material.clearcoatNode)
        || Number(material.sheen ?? 0) > 0
        || Boolean(material.sheenColorMap || material.sheenRoughnessMap || material.sheenNode)
        || Number(material.iridescence ?? 0) > 0
        || Boolean(material.iridescenceMap || material.iridescenceNode)
        || Number(material.transmission ?? 0) > 0
        || Boolean(material.transmissionMap || material.transmissionNode)
        || Number(material.anisotropy ?? 0) > 0
        || Boolean(material.anisotropyMap || material.anisotropyNode)
        // Physical materials may lower grazing reflectance through
        // specularIntensity (F90). The compact MRT stores resolved F0 but not
        // an independent F90 channel, so keep those materials fully native.
        || Math.abs(Number(material.specularIntensity ?? 1) - 1) > 1e-7
        || Boolean(material.specularIntensityMap || material.specularIntensityNode);
}

function installAuxiliaryMrtOverrides(THREE, scene) {
    const installed = new Map();
    const zero = THREE.vec4(0);
    const unlitOverride = THREE.mrt({
        normal: zero,
        metalrough: zero,
        specularData: zero,
    });
    const nativeOnlyOverride = THREE.mrt({
        specularData: zero,
    });

    const restore = () => {
        for (const [material, state] of installed) {
            // Do not overwrite a later owner that deliberately replaced it.
            if (material.mrtNode !== state.replacement
                && material.mrtNode !== state.original) continue;
            material.mrtNode = state.original;
            if (state.preserveOverride === undefined) {
                delete material.userData.preserveSceneMrtOverride;
            } else {
                material.userData.preserveSceneMrtOverride = state.preserveOverride;
            }
            material.needsUpdate = true;
        }
        installed.clear();
    };

    try {
        scene.traverse((object) => {
            if (!object?.material) return;
            const materials = Array.isArray(object.material)
                ? object.material
                : [object.material];
            for (const material of materials) {
                if (!material || installed.has(material)) continue;
                const pbr = isPbrMaterial(material);
                const objectNativeOnly = object.userData?.noSkyReflection
                    || object.userData?.noSSR;
                const zeroEnvironment = pbr && isZeroEnvironmentNode(material.envNode);
                if (pbr && !zeroEnvironment && !objectNativeOnly
                    && !needsNativeOnlyReflection(material)) continue;
                if (!pbr && !material.isNodeMaterial) continue;

                const original = material.mrtNode ?? null;
                const transparentPbr = pbr && material.transparent
                    && material.alphaTest <= 0.0001;
                // Transparent PBR sheets blend only into beauty. Zero alpha on
                // every auxiliary target preserves the opaque receiver beneath;
                // otherwise their env intensity would incorrectly become the MRT
                // blend alpha for normal/roughness/material response.
                let override = pbr && !transparentPbr
                    ? nativeOnlyOverride
                    : unlitOverride;
                if (zeroEnvironment && !objectNativeOnly
                    && !needsNativeOnlyReflection(material, true)) {
                    override = THREE.mrt({
                        metalrough: THREE.vec4(
                            THREE.metalness,
                            THREE.roughness,
                            THREE.float(material.userData?.n8aoAcceptance ?? 1),
                            THREE.float(0),
                        ),
                    });
                }
                const replacement = original?.isMRTNode
                    ? original.merge(override)
                    : override;
                const preserveOverride = material.userData?.preserveSceneMrtOverride;
                installed.set(material, { original, replacement, preserveOverride });
                material.userData = material.userData || {};
                material.userData.preserveSceneMrtOverride = true;
                material.mrtNode = replacement;
                material.needsUpdate = true;
            }
        });
    } catch (error) {
        restore();
        throw error;
    }

    return { restore };
}

function makeResolvedMaterialAoNode(THREE) {
    return new class extends THREE.Node {
        constructor() { super('float'); }
        setup(builder) {
            const material = builder.material;
            if (material?.aoNode) return material.aoNode;
            if (material?.aoMap && THREE.materialAO) return THREE.materialAO;
            return THREE.float(1);
        }
    }();
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
            if (!isPbrMaterial(material)) continue;
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
        async compileAsync() {
            if (disposed) return false;
            if (!fallbackPass?.compileAsync) {
                await renderer.compileAsync(scene, camera);
                return true;
            }
            const previousTarget = renderer.getRenderTarget?.() ?? null;
            const previousMrt = renderer.getMRT?.() ?? null;
            try {
                await fallbackPass.compileAsync(renderer);
                return true;
            } finally {
                renderer.setRenderTarget?.(previousTarget);
                renderer.setMRT?.(previousMrt);
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
    color, depth, normal, metalrough, response, camera,
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
    node.specularResponseNode = response;
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
    fxaaFactory = null, environmentTexture = null,
) {
    const required = [
        'RenderPipeline', 'pass', 'mrt', 'output', 'normalView',
        'directionToColor', 'colorToDirection', 'metalness', 'roughness',
        'sample', 'convertToTexture',
        'uniform', 'mix', 'renderOutput', 'pmremTexture',
        'DFGLUT', 'specularColor', 'specularF90', 'diffuseColor',
        'positionViewDirection', 'materialEnvIntensity', 'emissive',
        'getViewPosition', 'Node',
    ];
    const missing = required.filter((name) => !THREE[name]);
    if (typeof fxaaFactory !== 'function') missing.push('FXAA factory');
    if (!environmentTexture) missing.push('reflection environment texture');
    if (missing.length) {
        return makeFallback(
            THREE, fxaaFactory, renderer, scene, camera,
            `missing reflection dependencies: ${missing.join(', ')}`,
        );
    }

    const options = qualityOptions(quality);
    const selectiveBloomMrt = Number(
        renderer.backend?.device?.limits?.maxColorAttachmentBytesPerSample ?? 32,
    ) >= 40;
    // Donor scene-tunable override (render_scene.mjs pattern): lets SSR be
    // retuned live from the console without a pipeline rebuild.
    const ssrOverride = globalThis._ssrParams || {};
    for (const key of ['maxDistance', 'thickness', 'quality', 'resolutionScale']) {
        if (ssrOverride[key] !== undefined) {
            const optKey = key === 'maxDistance' ? 'ssrDistance'
                : 'ssr' + key[0].toUpperCase() + key.slice(1);
            options[optKey] = ssrOverride[key];
        }
    }

    // Donor G-buffer hygiene (render_scene.mjs defensive material setup):
    // sprites/points and non-alphaTest transparents must not write depth —
    // a rain sheet or dust quad that writes depth feeds SSR and AO a false
    // occluder and reflections ghost against it. alphaToCoverage arms cutout
    // materials for any future multisampled target; materials opt out with
    // userData.noAutoAlphaToCoverage.
    // The pipeline is rebuilt on sky switches: flags are only written when
    // they actually change, so rebuilds never queue mass shader recompiles.
    scene.traverse((child) => {
        if ((child.isSprite || child.isPoints) && child.material?.depthWrite) {
            child.material.depthWrite = false;
        }
        if (!child.isMesh || !child.material) return;
        const mats = Array.isArray(child.material) ? child.material : [child.material];
        for (const mat of mats) {
            if (mat.alphaTest > 0.0001) {
                const wanted = mat.userData?.noAutoAlphaToCoverage !== true;
                if (mat.alphaToCoverage !== wanted) {
                    mat.alphaToCoverage = wanted;
                    mat.needsUpdate = true;
                }
            } else if (mat.transparent && mat.depthWrite) {
                mat.depthWrite = false;
            }
        }
    });

    // Cloud radiance is already part of the periodically refreshed PMREM that
    // is assigned to every PBR material. Keep it inside Three's native IBL
    // BRDF: this is where final base/specular color, metalness, roughness,
    // normal maps, Fresnel, multiscattering and specular occlusion belong.
    // A screen-space cloud post layer cannot reproduce that angular filter;
    // blurring neighbouring receiver pixels mixes unrelated reflection rays
    // and creates the coloured oil-slick bands seen on curved/normal-mapped
    // surfaces. SSR remains a separate local-geometry layer below.

    // The donor Eidoverse stack resolves edge quality with final-output FXAA.
    // Explicitly keep the scene MRT single-sample: otherwise PassNode inherits
    // renderer.samples=4 and multisamples every attachment and depth before
    // every effect. Output stays HDR; compact material/emissive data is RGBA8,
    // keeping five colors within WebGPU's 32-byte portable attachment budget.
    const scenePass = THREE.pass(scene, camera, { samples: 0 });
    const auxiliaryAlpha = THREE.diffuseColor ? THREE.diffuseColor.a : THREE.float(1);
    // Store the final resolved F0, not raw material constants. sqrt encoding
    // gives dielectric values around 0.04 substantially more precision in an
    // 8-bit attachment while retaining the full metallic color range.
    const resolvedF0 = THREE.mix(
        THREE.specularColor,
        THREE.diffuseColor.rgb,
        THREE.metalness,
    );
    const materialAo = makeResolvedMaterialAoNode(THREE);
    const sceneOutputs = {
        output: THREE.output,
        normal: THREE.vec4(THREE.directionToColor(THREE.normalView), auxiliaryAlpha),
        // B stores the N8AO receiver acceptance weight. SSR consumes only R/G,
        // so thin materials can reduce or reject cavity darkening without a
        // fifth color attachment (which exceeds WebGPU's byte budget).
        // A carries the per-material environment intensity needed to recreate
        // the native directional PMREM term in the full-screen handoff.
        metalrough: THREE.vec4(
            THREE.metalness,
            THREE.roughness,
            1,
            THREE.materialEnvIntensity,
        ),
        specularData: THREE.vec4(resolvedF0.sqrt(), materialAo),
    };
    if (selectiveBloomMrt) {
        // Preserve the authored selective bloom path when the adapter exposes
        // the required fifth-attachment byte budget. Bright sky and ordinary
        // PBR/SSR highlights then remain outside bloom entirely.
        sceneOutputs.emissive = THREE.vec4(THREE.emissive, auxiliaryAlpha);
    }
    const sceneMrt = THREE.mrt(sceneOutputs);
    if (sceneMrt.setBlendMode && THREE.MaterialBlending !== undefined) {
        sceneMrt.setBlendMode('normal', { blending: THREE.MaterialBlending });
        sceneMrt.setBlendMode('metalrough', { blending: THREE.MaterialBlending });
        sceneMrt.setBlendMode('specularData', { blending: THREE.MaterialBlending });
        if (selectiveBloomMrt) {
            sceneMrt.setBlendMode('emissive', { blending: THREE.MaterialBlending });
        }
    }
    scenePass.setMRT(sceneMrt);
    const sceneColor = scenePass.getTextureNode('output');
    const sceneDepth = scenePass.getTextureNode('depth');
    const packedNormal = scenePass.getTextureNode('normal');
    const sceneMetalrough = scenePass.getTextureNode('metalrough');
    const sceneSpecularData = scenePass.getTextureNode('specularData');
    const sceneEmissive = selectiveBloomMrt
        ? scenePass.getTextureNode('emissive')
        : null;
    const ownedRttNodes = new Set();
    const sceneAoMask = sceneMetalrough.b;
    const sceneNormal = THREE.sample((coord) => (
        THREE.colorToDirection(packedNormal.sample(coord))
    ));
    const projectionInverse = THREE.uniform(camera.projectionMatrixInverse);
    const sceneCameraViewMatrix = THREE.uniform(camera.matrixWorldInverse);
    // THREE.output already contains the scene fog. Reflection ownership is
    // replaced later in this full-screen graph, so its removal/addition delta
    // must be attenuated by the identical radial FogExp2 transmittance or a
    // distant receiver can over-subtract native PMREM and over-add SSR.
    const uFogDensity = THREE.uniform(
        scene.fog?.isFogExp2 ? Number(scene.fog.density ?? 0) : 0,
    );
    const sceneFogTransmittance = THREE.sample((coord) => {
        const depth = sceneDepth.sample(coord).r;
        const viewPosition = THREE.getViewPosition(
            coord,
            depth,
            projectionInverse,
        );
        const radialFogArg = viewPosition.length().mul(uFogDensity);
        return radialFogArg.mul(radialFogArg).negate().exp();
    });
    const sceneSsrResponse = THREE.sample((coord) => {
        const depth = sceneDepth.sample(coord).r;
        const viewPosition = THREE.getViewPosition(
            coord,
            depth,
            projectionInverse,
        );
        const normal = sceneNormal.sample(coord).rgb.normalize();
        const viewDirection = viewPosition.normalize().negate();
        const dotNV = normal.dot(viewDirection).clamp();
        const roughness = sceneMetalrough.sample(coord).g;
        const dfg = THREE.DFGLUT({ roughness, dotNV });
        const data = sceneSpecularData.sample(coord);
        const f0 = data.rgb.mul(data.rgb);
        const singleScattering = f0.mul(dfg.x).add(dfg.y);
        const materialAo = data.a;
        const aoNV = dotNV.add(materialAo);
        const aoExp = roughness.mul(-16).oneMinus().negate().exp2();
        const specularAo = materialAo
            .sub(aoNV.pow(aoExp).oneMinus())
            .clamp();
        return singleScattering.mul(specularAo);
    });
    const sceneReflectionRay = THREE.sample((coord) => {
        const depth = sceneDepth.sample(coord).r;
        const viewPosition = THREE.getViewPosition(
            coord,
            depth,
            projectionInverse,
        );
        const normal = sceneNormal.sample(coord).rgb.normalize();
        const roughness = sceneMetalrough.sample(coord).g;
        const incidentView = viewPosition.normalize();
        const reflectedView = incidentView.reflect(normal);
        const roughness2 = roughness.mul(roughness);
        const roughness4 = roughness2.mul(roughness2);
        const radianceDirection = THREE.mix(
            reflectedView,
            normal,
            roughness4,
        ).normalize().transformDirection(sceneCameraViewMatrix);
        return THREE.vec4(radianceDirection, roughness);
    });
    const reflectionRay = sceneReflectionRay.sample(THREE.uv());
    const environmentPmremNode = THREE.pmremTexture(
        environmentTexture,
        reflectionRay.rgb,
        reflectionRay.a,
    );
    const sceneBakedRadiance = environmentPmremNode
        .mul(sceneMetalrough.a);
    const sceneNativeSpecular = sceneBakedRadiance
        .mul(sceneSsrResponse);

    // Eanpa already carries Eidoverse's same-ray sky hook in sky_system.js.
    // In external-PBR mode it returns raw radiance: deterministic live
    // sky/clouds above the reflected horizon and the baked ground-bounce band
    // below it. Keep rough receivers on Three's angular PMREM; the live
    // one-ray result owns only sharp/glossy metallic reflections.
    let liveSkyTexture = null;
    let liveSkyFailure = null;
    const liveSkyHook = globalThis._autoEnhanceCloudReflectHook;
    if (typeof liveSkyHook === 'function'
        && liveSkyHook.externalPbrResponse === true) {
        try {
            const liveSkyNode = liveSkyHook(
                sceneColor,
                sceneDepth,
                sceneNormal,
                sceneMetalrough,
            );
            if (liveSkyNode) {
                liveSkyTexture = convertOwnedToTexture(
                    THREE,
                    liveSkyNode,
                    ownedRttNodes,
                );
            }
        } catch (error) {
            liveSkyFailure = error instanceof Error ? error.message : String(error);
            console.warn('[reflection-pipeline] same-ray sky fallback unavailable:', error);
        }
    }
    const liveSkyWeight = liveSkyTexture
        ? THREE.float(1).sub(
            // A single exact sky ray is valid only for genuinely mirror-like
            // receivers. Even modest authored roughness needs PMREM's angular
            // integration; blending the sharp one-ray field across 0.12-0.50
            // made the Inanna roughness texture crawl as the orb rotated.
            THREE.smoothstep(0.02, 0.10, sceneMetalrough.g),
        )
            // The hook stores reflected-horizon visibility in alpha. A
            // below-horizon ray must retain Three's native, roughness-filtered
            // PMREM fallback; replacing it with the hook's sharp baked sample
            // exposes two differently filtered fields on the orb underside.
            .mul(liveSkyTexture.a)
            .mul(THREE.step(0.0001, sceneMetalrough.r))
        : THREE.float(0);
    const sceneSkyFallback = liveSkyTexture
        ? THREE.mix(
            sceneBakedRadiance,
            liveSkyTexture.rgb.mul(sceneMetalrough.a),
            liveSkyWeight,
        )
        : sceneBakedRadiance;

    // Match Eidoverse's MRT bandwidth optimization. N8AO consumes the same
    // directionToColor-encoded normal attachment directly; it does not render
    // a second beauty/normal scene pass.
    if (THREE.UnsignedByteType && scenePass.getTexture) {
        // Native material lighting shades with the full-precision normal.
        // Keep this attachment at half-float as well: quantizing it to RGBA8
        // shifts PMREM lookups during the replacement subtraction and leaves a
        // signed residual field that shimmers on glossy curved receivers.
        const compactChannels = ['metalrough', 'specularData'];
        if (selectiveBloomMrt) compactChannels.push('emissive');
        for (const channel of compactChannels) {
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
    // convertToTexture makes the AO-composited beauty sampleable by the
    // bounded SSR ray marcher.
    const aoAcceptance = uAoEnabled.mul(sceneAoMask);
    const aoSceneColor = n8aoOutput
        ? convertOwnedToTexture(
            THREE,
            THREE.mix(sceneColor, n8aoOutput, aoAcceptance),
            ownedRttNodes,
        )
        : sceneColor;
    // N8AO is a linear beauty multiplier in this graph. Recover that receiver
    // multiplier so the removed native lobe and local replacement receive the
    // same screen-space occlusion.
    const receiverAo = aoSceneColor.rgb
        .div(sceneColor.rgb.max(THREE.float(0.0001)))
        .clamp(0, 1);
    // Match the donor's deferred ownership contract at the hit source as well
    // as at the receiver. If SSR samples the PMREM-bearing scene beauty, a
    // curved-surface/self hit carries the hit pixel's differently mapped sky
    // field while a miss carries the receiver ray's PMREM field. Their changing
    // ownership boundary looks exactly like two reflections z-fighting.
    //
    // Hold only the reconstructed directional native lobe out of the sampleable
    // SSR source. The presented scene keeps Three's complete native PBR result,
    // and the composite below still replaces the receiver lobe on accepted
    // hits. Diffuse, direct lighting, emissive, and native multiscattering stay
    // in the hit color; the deliberate trade-off is losing a directional
    // chrome-of-chrome sky bounce, the same priority chosen by Eidoverse.
    const ssrHeldOutDirectional = sceneNativeSpecular.rgb
        .mul(receiverAo)
        .mul(sceneFogTransmittance);
    const ssrSourceColor = convertOwnedToTexture(
        THREE,
        THREE.vec4(
            aoSceneColor.rgb.sub(ssrHeldOutDirectional).max(THREE.float(0)),
            aoSceneColor.a,
        ),
        ownedRttNodes,
    );
    const ssrNode = makeEidoverseSsr({
        color: ssrSourceColor,
        depth: sceneDepth,
        normal: sceneNormal,
        metalrough: sceneMetalrough,
        response: sceneSsrResponse,
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
    // Runtime-only audit gate lets the parity harness isolate Three's native
    // PMREM/IBL result from the local SSR layer without rebuilding the graph.
    const uSsrAudit = THREE.uniform(1);
    const uSkyFallbackAudit = THREE.uniform(1);
    const ssrConfidence = ssrTexture.a
        .mul(ssrEdgeFade)
        .mul(uSsrAudit);
    const skyRemaining = THREE.float(1).sub(ssrConfidence);
    // Both sources carry receiver-independent radiance. SSR owns accepted
    // local geometry; the same reflected ray reaches sky/ground only for the
    // exact remaining coverage. There is no additive overlap to z-fight.
    const reflectionTransport = ssrTexture.rgb
        .mul(ssrEdgeFade)
        .mul(uSsrAudit)
        .add(
            sceneSkyFallback
                .mul(skyRemaining)
                .mul(uSkyFallbackAudit),
        );
    const ownedDirectionalSpecular = reflectionTransport
        // Apply this pixel's resolved PBR response after roughness filtering so
        // F0/albedo/AO cannot bleed across receiving materials.
        .mul(sceneSsrResponse.rgb)
        .mul(receiverAo);
    // Remove the native directional PMREM lobe unconditionally. Its stable
    // multiscattering/irradiance and diffuse energy remain authored by Three;
    // only the one reflected direction is handed to the exclusive owner above.
    const removedNativeSpecular = sceneNativeSpecular.rgb.mul(receiverAo);
    const foggedDirectionalDelta = ownedDirectionalSpecular
        .sub(removedNativeSpecular)
        .mul(sceneFogTransmittance);
    const reflectedRgb = aoSceneColor.rgb
        .add(foggedDirectionalDelta)
        .max(THREE.float(0));
    const reflectedColor = THREE.vec4(reflectedRgb, aoSceneColor.a);

    // Three r184's native WebGPU UnrealBloom node, matching Eidoverse's post
    // stack. Keep it selective: cloud/sky radiance and ordinary PBR/SSR/local
    // highlights must not grow broad dark-edge halos.
    const uBloomEnabled = THREE.uniform(1);
    const bloomContribution = bloom(
        sceneEmissive ?? reflectedColor,
        options.bloomStrength,
        options.bloomRadius,
        sceneEmissive ? 0.72 : 1.1,
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

    // Install scene-material MRT overrides only after every fallible graph
    // constructor has succeeded. The installer also rolls back partial work if
    // a material traversal/merge throws, so a failed build cannot poison the
    // next pipeline attempt.
    const auxiliaryMrtOverrides = installAuxiliaryMrtOverrides(THREE, scene);

    let disposed = false;
    let aoEnabled = Boolean(n8ao);
    let bloomEnabled = true;
    const ownedGlobals = {
        hook: globalThis._autoEnhanceCloudReflectHook,
        blur: globalThis._autoEnhanceCloudReflectBlurHook,
    };

    return {
        supported: true,
        mode: 'same-ray-sky-ground-fallback-plus-ssr-pbr',
        reflectionCompose: 'ssr_plus-same-ray-sky-ground-times-one-minus-ssr',
        skyRoughnessMode: 'three-pmrem-angular-prefilter',
        cloudReflectionMaterialSource: 'native-material-brdf-final-maps',
        cloudReflectionWeighting: 'three-pmrem-environment-brdf',
        cloudReflectionAo: 'native-material-ibl-occlusion',
        cloudReflectionResolutionScale: null,
        cloudReflectionUpdate: 'periodic-equirectangular-pmrem',
        ssrImplementation: 'three-r184-ssr-native-pbr-response',
        ssrHitConfidence: 'binary-accepted-hit-ownership-with-screen-edge-fade',
        ssrSource: 'ao-composited-hit-radiance-with-directional-pmrem-held-out',
        ssrMaterialResponse: 'resolved-f0-dfg-roughness-metalness-albedo-normal-ao',
        reflectionFogCompose: 'radial-fogexp2-transmittance-on-directional-delta',
        sameRaySkyAvailable: Boolean(liveSkyTexture),
        sameRaySkySource: liveSkyTexture
            ? 'live-sky-above-horizon-baked-ground-bounce-below'
            : 'periodic-baked-sky-ground-pmrem',
        sameRaySkyReason: liveSkyTexture ? null
            : (liveSkyFailure ?? 'active sky did not register an external-PBR hook'),
        bloomSource: selectiveBloomMrt
            ? 'authored-emissive-mrt'
            : 'portable-hdr-threshold-fallback',
        sceneColorAttachments: selectiveBloomMrt ? 5 : 4,
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
        setAuditContributions({ ssr = true, sky = true } = {}) {
            if (disposed) return false;
            uSsrAudit.value = ssr ? 1 : 0;
            uSkyFallbackAudit.value = sky ? 1 : 0;
            return true;
        },
        setSsrParams({ maxDistance, thickness, quality } = {}) {
            // Donor live-tuning contract: these are SSRNode uniforms, so they
            // retune the march without any graph or pipeline rebuild.
            // (resolutionScale is a build-time property — change quality tier
            // instead.)
            if (disposed) return false;
            if (maxDistance !== undefined) ssrNode.maxDistance.value = maxDistance;
            if (thickness !== undefined) ssrNode.thickness.value = thickness;
            if (quality !== undefined) ssrNode.quality.value = quality;
            return true;
        },
        setEnvironment(texture) {
            const installed = installReflectionEnvironment(scene, texture);
            environmentPmremNode.value = texture;
            return installed;
        },
        update() {
            if (disposed) return;
            uFogDensity.value = scene.fog?.isFogExp2
                ? Number(scene.fog.density ?? 0)
                : 0;
        },
        resize(width, height) {
            if (disposed) return;
            if (width > 0 && height > 0) {
                scenePass.setSize(width, height);
                n8ao?.setSize?.(width, height);
                ssrNode.setSize?.(width, height);
            }
        },
        async compileAsync() {
            if (disposed || typeof scenePass.compileAsync !== 'function') return false;
            // PassNode selects the exact scene MRT before delegating to Three's
            // asynchronous TSL/WebGPU compiler. Restore explicitly even when
            // compilation rejects; r184's public helper restores only on success.
            const previousTarget = renderer.getRenderTarget?.() ?? null;
            const previousMrt = renderer.getMRT?.() ?? null;
            try {
                await scenePass.compileAsync(renderer);
                return true;
            } finally {
                renderer.setRenderTarget?.(previousTarget);
                renderer.setMRT?.(previousMrt);
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
            environmentPmremNode.dispose?.();
            scenePass.dispose?.();
            auxiliaryMrtOverrides.restore();
            if (globalThis._autoEnhanceCloudReflectHook === ownedGlobals.hook) {
                globalThis._autoEnhanceCloudReflectHook = null;
            }
            if (globalThis._autoEnhanceCloudReflectBlurHook === ownedGlobals.blur) {
                globalThis._autoEnhanceCloudReflectBlurHook = null;
            }
        },
    };
}
