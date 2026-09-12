import { N8AONode } from './vendor/n8ao/N8AONode.js';

// Evaluate current geometry once, then feed visibility into Three's native
// indirect diffuse/specular occlusion. A beauty-buffer multiply incorrectly
// darkens direct lights, emission, and all reflection lobes by the same amount.
export function makeAmbientOcclusion(T, renderer, scene, camera, geometry) {
    const depth = T.texture(geometry.target.depthTexture, T.screenUV);
    const normal = T.texture(geometry.target.texture, T.screenUV);
    depth.updateMatrix = normal.updateMatrix = false;
    const node = new N8AONode({scene, camera, depthNode:depth, depthTexture:depth.value,
        normalNode:normal, normalTexture:normal.value, occlusionOnly:true});
    Object.assign(node.configuration, {halfRes:false, gammaCorrection:false,
        transparencyAware:false, accumulate:false, intensity:1});
    node.autoDetectTransparency = false;
    node.setQualityMode('Medium');
    const enabled = T.uniform(1).setGroup(T.renderGroup);
    // The reflection prepass deliberately excludes viewmodels and surfaces
    // without depth writes. Never apply the background's AO to those pixels.
    const receiver = T.uniform(1).onObjectUpdate(({object, material}) =>
        object.userData?.noSSRSource || material.depthWrite === false ? 0 : 1);
    const visibility = node.getOcclusionTextureNode().sample(T.screenUV).r.clamp();
    // Share the existing reflection geometry binding: octahedral normal RG,
    // visibility B, convex receiver ID A. Complex host materials already use
    // all 24 sampled-texture slots; AO must not require a 25th texture.
    const target = node.outputTarget;
    target.texture.minFilter = target.texture.magFilter = T.NearestFilter;
    target.texture.name = 'Current normal, ambient visibility and receiver';
    const data = T.texture(target.texture, T.screenUV).setSampler(false);
    data.updateMatrix = false;
    const signNotZero = v => T.select(v.greaterThanEqual(0), T.float(1), T.float(-1));
    const unpackNormal = T.Fn(([encoded]) => {
        const p = encoded.mul(2).sub(1);
        const n = T.vec3(p, T.float(1).sub(p.x.abs()).sub(p.y.abs())).toVar();
        const fold = n.z.negate().clamp();
        n.x.subAssign(signNotZero(n.x).mul(fold));
        n.y.subAssign(signNotZero(n.y).mul(fold));
        return n.normalize();
    });
    const material = new T.MeshBasicNodeMaterial({depthTest:false, depthWrite:false, toneMapped:false});
    material.name = 'Publish current ambient visibility and reflection geometry';
    material.fragmentNode = T.Fn(() => {
        const geometryData = normal.sample(T.screenUV).toVar();
        const n = geometryData.rgb.mul(2).sub(1);
        const p = n.xy.div(n.x.abs().add(n.y.abs()).add(n.z.abs()).max(1e-6)).toVar();
        T.If(n.z.lessThan(0), () => {
            p.assign(T.vec2(1).sub(p.yx.abs()).mul(T.vec2(signNotZero(p.x), signNotZero(p.y))));
        });
        return T.vec4(p.mul(.5).add(.5), T.mix(1, visibility, enabled), geometryData.a);
    })();
    const quad = new T.QuadMesh(material);
    let rendererState;
    return {
        node, target, textureNode:data, unpackNormal,
        getAO(authored) {
            const ao = data.load(T.screenCoordinate).b;
            return (authored ?? T.float(1)).mul(T.mix(1, ao, enabled.mul(receiver)));
        },
        setEnabled(value) { node.enabled = !!value; enabled.value = value ? 1 : 0; },
        render() {
            if (node.width !== geometry.target.width || node.height !== geometry.target.height)
                node.setSize(geometry.target.width, geometry.target.height);
            rendererState = T.RendererUtils.saveRendererState(renderer, rendererState);
            const background = scene.background, xrEnabled = renderer.xr.enabled;
            try {
                if (node.enabled) node.updateBefore({renderer});
                renderer.setMRT(null);
                renderer.setRenderObjectFunction(null);
                renderer.setRenderTarget(target);
                quad.render(renderer);
            } finally {
                scene.background = background; renderer.xr.enabled = xrEnabled;
                T.RendererUtils.restoreRendererState(renderer, rendererState);
            }
        },
        resize(width, height) { node.setSize(width, height); },
        dispose() { material.dispose(); node.dispose(); },
    };
}
