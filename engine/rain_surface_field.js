// A local rain-direction depth/normal field shared by precipitation and wetness.
// Call prepareFrame before rendering the world, in the host's serialized frame.
// It includes off-screen roofs and ordinary/instanced/skinned opaque geometry.
export function makeRainSurfaceField(T3, scene, options = {}) {
    const { uniform, Fn, vec2, vec3, vec4, float, texture, clamp, mix, normalize } = T3;
    const radius = Math.max(48, options.radius ?? 72);
    const resolution = Math.max(128, Math.min(2048, options.resolution ?? 768));
    const span = Math.max(256, options.verticalSpan ?? 512);
    const texelMeters = radius * 2 / resolution;
    const camera = new T3.OrthographicCamera(-radius, radius, radius, -radius, 0.1, span);
    camera.up.set(0, 0, -1);
    const target = new T3.RenderTarget(resolution, resolution, {
        type: T3.UnsignedByteType, minFilter: T3.NearestFilter, magFilter: T3.NearestFilter,
        generateMipmaps: false, depthBuffer: true, samples: 0,
    });
    target.texture.name = 'rain-surface-world-normal';
    target.texture.colorSpace = T3.NoColorSpace;
    target.depthTexture = new T3.DepthTexture(resolution, resolution, T3.FloatType);
    target.depthTexture.name = 'rain-surface-depth';
    target.depthTexture.minFilter = target.depthTexture.magFilter = T3.NearestFilter;
    const u = {
        enabled: uniform(0),
        viewProjection: uniform(new T3.Matrix4()),
        inverseViewProjection: uniform(new T3.Matrix4()),
        sourceDirection: uniform(new T3.Vector3(0, 1, 0)),
        depthBias: uniform(0.06 / span),
        depthScale: uniform(span),
    };
    const depth = texture(target.depthTexture);
    const normals = texture(target.texture);
    const project = Fn(([world]) => {
        const clip = u.viewProjection.mul(vec4(world, 1));
        return vec3(clip.x.mul(0.5).add(0.5), float(0.5).sub(clip.y.mul(0.5)), clip.z);
    });
    const inBounds = (p) => p.x.greaterThan(0.001).and(p.x.lessThan(0.999))
        .and(p.y.greaterThan(0.001)).and(p.y.lessThan(0.999))
        .and(p.z.greaterThan(0)).and(p.z.lessThan(1));
    const visibilityAt = Fn(([world, biasMeters]) => {
        const p = project(world).toVar();
        const d = depth.sample(p.xy).level(0).r;
        const exposed = p.z.lessThanEqual(d.add(biasMeters.div(u.depthScale))).select(1, 0);
        // The field is intentionally local. Outside it retain the host's
        // normal weather response rather than drawing a moving dry square.
        return mix(float(1), exposed, inBounds(p).select(u.enabled, 0));
    });
    const impactAt = Fn(([world]) => {
        const p = project(world).toVar();
        const sampleUV = T3.floor(p.xy.mul(resolution)).add(0.5).div(resolution);
        const d = depth.sample(sampleUV).level(0).r.toVar();
        const clip = vec4(sampleUV.x.mul(2).sub(1), float(1).sub(sampleUV.y.mul(2)), d, 1);
        const hit = u.inverseViewProjection.mul(clip);
        const n = normalize(normals.sample(sampleUV).level(0).rgb.mul(2).sub(1).add(vec3(0, 0.00001, 0)));
        // Depth belongs to the texel center. Intersect the requested rain ray
        // with that small surface plane, avoiding stair-stepped splash heights
        // and floating rings on sloping roofs between capture texels.
        const travel = T3.dot(hit.xyz.div(hit.w).sub(world), n)
            .div(T3.max(T3.dot(n, u.sourceDirection), 0.04));
        return vec4(world.add(u.sourceDirection.mul(travel)),
            inBounds(p).and(d.lessThan(0.99999)).select(u.enabled, 0));
    });
    const normalAt = Fn(([world]) => {
        const p = project(world);
        return normalize(normals.sample(p.xy).level(0).rgb.mul(2).sub(1).add(vec3(0, 0.00001, 0)));
    });
    const materials = new Map();
    const sourceDisposals = new Map();
    const sourceVersions = new Map();
    const invisible = new T3.MeshBasicNodeMaterial({ visible: false });
    const changes = [];
    const center = new T3.Vector3();
    const lastCenter = new T3.Vector3(Infinity, Infinity, Infinity);
    const direction = new T3.Vector3(0, 1, 0);
    const lastDirection = new T3.Vector3(0, 1, 0);
    const rendererState = {}, sceneState = {};
    let lastUpdate = -Infinity, disposed = false;
    const stats = { updates: 0, resolution, radiusMeters: radius, refreshHz: options.refreshHz ?? 8,
        occluderMeshes: 0, captureMaterials: 0, enabled: false, lastUpdateSeconds: null };

    const captureMaterial = (source) => {
        if (!source || source.visible === false || (source.transparent && !source.alphaTest
            && source.userData?.rainOccluder !== true)) return null;
        let material = materials.get(source);
        if (material && sourceVersions.get(source) === source.version) return material;
        if (material) sourceDisposals.get(source)();
        const roots = options.getMaterialRoots?.(source) ?? source;
        material = new T3.MeshBasicNodeMaterial({ side: T3.DoubleSide, fog: false, toneMapped: false });
        material.name = `rain-occluder:${source.name || source.type}`;
        material.colorNode = T3.normalWorld.mul(0.5).add(0.5);
        material.positionNode = source.userData?.rainCapturePositionNode ?? source.positionNode ?? null;
        material.vertexNode = source.vertexNode ?? null;
        material.displacementMap = source.displacementMap;
        material.displacementScale = source.displacementScale;
        material.displacementBias = source.displacementBias;
        if (source.alphaTest > 0 || source.alphaTestNode) {
            // Retain cutout silhouettes, without evaluating a PBR light model
            // or the wet RGB graph while capturing the field itself.
            material.map = source.map;
            material.alphaMap = source.alphaMap;
            material.alphaTest = source.alphaTest;
            material.alphaTestNode = source.alphaTestNode;
            material.opacityNode = roots.opacityNode ?? (roots.colorNode ? vec4(roots.colorNode).a : null);
        }
        materials.set(source, material);
        sourceVersions.set(source, source.version);
        const release = () => {
            material.dispose();
            materials.delete(source);
            sourceVersions.delete(source);
            sourceDisposals.delete(source);
            source.removeEventListener('dispose', release);
            stats.captureMaterials = materials.size;
        };
        sourceDisposals.set(source, release);
        source.addEventListener('dispose', release);
        stats.captureMaterials = materials.size;
        return material;
    };
    const excluded = (object) => {
        for (let p = object; p && p !== scene; p = p.parent) {
            if (p.isCamera || p.userData.noRainOcclusion || p.userData.firstPersonViewmodel
                || p.userData.noSupportCheck || p.renderOrder < -90) return true;
        }
        return false;
    };

    return {
        uniforms: u, target, camera, stats, project, visibilityAt, impactAt, normalAt,
        invalidate() { lastUpdate = -Infinity; },
        async prepareFrame(renderer, viewCamera, { time = 0, active = true, wind, fallSpeed = 9, force = false } = {}) {
            if (disposed || !viewCamera || (!active && !force)) return false;
            direction.set(-(wind?.x ?? 0), Math.max(1, fallSpeed), -(wind?.z ?? 0)).normalize();
            viewCamera.getWorldPosition(center);
            center.x = Math.round(center.x / texelMeters) * texelMeters;
            center.z = Math.round(center.z / texelMeters) * texelMeters;
            // Continuous Y following would shift every world sample during a
            // jump. Quantize it too, with generous room above and below.
            center.y = Math.round(center.y / 8) * 8;
            if (!force && u.enabled.value && time >= lastUpdate
                && time - lastUpdate < 1 / stats.refreshHz
                && center.distanceToSquared(lastCenter) < 4
                && direction.dot(lastDirection) > 0.999) return false;
            camera.coordinateSystem = renderer.coordinateSystem;
            camera.position.copy(center).addScaledVector(direction, span * 0.5);
            camera.lookAt(center);
            camera.updateProjectionMatrix();
            camera.updateMatrixWorld(true);
            u.viewProjection.value.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
            u.inverseViewProjection.value.copy(u.viewProjection.value).invert();
            u.sourceDirection.value.copy(direction);
            T3.RendererUtils.saveRendererState(renderer, rendererState);
            T3.RendererUtils.saveSceneState(scene, sceneState);
            const shadowEnabled = renderer.shadowMap.enabled;
            try {
                stats.occluderMeshes = 0;
                scene.traverseVisible((object) => {
                    if (!object.isMesh && !object.isLine && !object.isPoints && !object.isSprite) return;
                    const original = object.material;
                    if (!object.isMesh || excluded(object)) {
                        changes.push([object, original, object.visible]);
                        object.visible = false;
                        return;
                    }
                    const captured = Array.isArray(original)
                        ? original.map(captureMaterial) : captureMaterial(original);
                    changes.push([object, original, object.visible]);
                    if (!captured || (Array.isArray(captured) && captured.every(m => !m))) object.visible = false;
                    else {
                        // Invisible group materials preserve geometry group
                        // indices when a mesh mixes glass and opaque parts.
                        object.material = Array.isArray(captured) ? captured.map(m => m ?? invisible) : captured;
                        stats.occluderMeshes++;
                    }
                });
                scene.background = scene.backgroundNode = scene.overrideMaterial = null;
                renderer.shadowMap.enabled = false;
                renderer.setRenderObjectFunction(null);
                renderer.setMRT(null);
                renderer.setRenderTarget(target);
                renderer.setClearColor(0x000000, 0);
                renderer.setScissorTest(false);
                renderer.autoClear = true;
                await renderer.renderAsync(scene, camera);
                u.enabled.value = 1;
                lastUpdate = time;
                lastCenter.copy(center);
                lastDirection.copy(direction);
                stats.updates++;
                stats.enabled = true;
                stats.lastUpdateSeconds = time;
            } finally {
                for (const [object, material, visible] of changes) {
                    object.material = material;
                    object.visible = visible;
                }
                changes.length = 0;
                renderer.shadowMap.enabled = shadowEnabled;
                T3.RendererUtils.restoreSceneState(scene, sceneState);
                T3.RendererUtils.restoreRendererState(renderer, rendererState);
            }
            return true;
        },
        dispose() {
            if (disposed) return;
            disposed = true;
            u.enabled.value = 0;
            for (const material of materials.values()) material.dispose();
            for (const [source, release] of sourceDisposals) source.removeEventListener('dispose', release);
            materials.clear();
            sourceDisposals.clear();
            sourceVersions.clear();
            invisible.dispose();
            target.dispose();
        },
    };

}
