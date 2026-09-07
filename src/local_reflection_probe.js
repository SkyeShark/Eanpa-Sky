// A nearby, parallax-corrected radiance capture fills the geometry hidden from
// SSR. Six faces refresh over six frames; only a completed cube is prefiltered
// and published. The visible frame never reads a partially updated probe.
export function makeLocalReflectionProbe(T, renderer, scene, viewCamera, {size = 128, refreshSeconds = 3} = {}) {
    const cube = new T.CubeRenderTarget(size, {type:T.HalfFloatType, generateMipmaps:false});
    cube.texture.name = 'output';
    const camera = new T.CubeCamera(.15, viewCamera.far, cube);
    camera.coordinateSystem = renderer.coordinateSystem;
    camera.updateCoordinateSystem();
    renderer.initRenderTarget(cube);
    const generator = new T.PMREMGenerator(renderer);
    const initialState = T.RendererUtils.saveRendererState(renderer);
    let filtered;
    try { renderer.setMRT(null); filtered = generator.fromCubemap(cube.texture); }
    finally { T.RendererUtils.restoreRendererState(renderer, initialState); }
    filtered.texture.name = 'eanpa-local-probe-pmrem';
    const tex = T.texture(filtered.texture,T.screenUV);
    tex.updateMatrix = false;
    const shared = value => T.uniform(value).setGroup(T.renderGroup);
    const center = shared(new T.Vector3()), boxMin = shared(new T.Vector3()), boxMax = shared(new T.Vector3());
    const ready = shared(0);
    const excluded = new Set(), lights = new Set(), convex = new Set();
    const sourceContext = T.context({eanpaReflectionSurfacePass:false});
    const captureMrt = T.mrt({output:T.output});
    const point = new T.Vector3(), desired = new T.Vector3(), pending = new T.Vector3();
    let environment = null, sampleGroundHeight = null, face = -1, deadline = 0, dirty = true, disposed = false;
    const stats = {captures:0, faces:0, lastCaptureMs:0, lastCenter:[0,0,0]};

    const registerObject = root => root.traverse(object => {
        if (object.isLight && object.shadow) lights.add(object);
        if (object.name === 'first_person_viewmodel_motion' || object.userData?.noSSRSource) excluded.add(object);
        if (!object.material) return;
        const materials = Array.isArray(object.material) ? object.material : [object.material];
        // A convex receiver cannot reflect itself. Excluding these few hero
        // objects from the coarse capture also prevents their self-occlusion
        // from being baked into every surrounding material's fallback.
        if (object.userData?.ssrConvexGroup) { excluded.add(object); convex.add(object); }
        if (materials.every(material => material.depthWrite === false)) excluded.add(object);
    });
    registerObject(scene);
    const chooseCenter = () => {
        desired.set(0,0,0);
        let weight = 0;
        for (const object of convex) {
            let visible = true;
            for (let parent=object; parent; parent=parent.parent) if (!parent.visible) { visible=false; break; }
            if (!visible || !object.parent) continue;
            object.updateWorldMatrix(true,false);
            if (!object.geometry.boundingSphere) object.geometry.computeBoundingSphere();
            const sphere = object.geometry.boundingSphere;
            point.copy(sphere.center).applyMatrix4(object.matrixWorld);
            if (point.distanceToSquared(viewCamera.position) > 25*25) continue;
            const area = Math.max(.01, sphere.radius*sphere.radius);
            desired.addScaledVector(point,area); weight += area;
        }
        if (weight) desired.divideScalar(weight); else desired.copy(viewCamera.position);
    };
    const withCaptureState = asyncCallback => {
        const state = T.RendererUtils.saveRendererState(renderer);
        const background = scene.background, context = renderer.contextNode;
        const hidden = [], shadows = [];
        for (const object of excluded) if (object.visible) { hidden.push(object); object.visible=false; }
        for (const light of lights) {
            const shadow = light.shadow;
            shadows.push([shadow,shadow.autoUpdate,shadow.needsUpdate]);
            shadow.autoUpdate=false; shadow.needsUpdate=false;
        }
        scene.background = environment;
        renderer.contextNode = sourceContext;
        renderer.setMRT(captureMrt);
        renderer.toneMapping = T.NoToneMapping;
        renderer.outputColorSpace = T.LinearSRGBColorSpace;
        const restore = () => {
            for (const object of hidden) object.visible=true;
            for (const [shadow,auto,needs] of shadows) { shadow.autoUpdate=auto; shadow.needsUpdate=needs; }
            scene.background=background; renderer.contextNode=context;
            T.RendererUtils.restoreRendererState(renderer,state);
        };
        try {
            const result = asyncCallback();
            if (result?.then) return result.finally(restore);
            restore(); return result;
        } catch (error) { restore(); throw error; }
    };
    const beginCapture = () => {
        chooseCenter(); pending.copy(desired); camera.position.copy(pending); camera.updateMatrixWorld(true);
        face=0; dirty=false;
    };
    const finishCapture = () => {
        const state = T.RendererUtils.saveRendererState(renderer);
        try { renderer.setMRT(null); generator.fromCubemap(cube.texture,filtered); }
        finally { T.RendererUtils.restoreRendererState(renderer,state); }
        center.value.copy(pending);
        boxMin.value.copy(pending).addScalar(-32); boxMax.value.copy(pending).addScalar(32);
        const ground = Number(sampleGroundHeight?.(pending.x,pending.z));
        if (Number.isFinite(ground) && ground < pending.y-.1 && ground > pending.y-32) boxMin.value.y=ground;
        ready.value=1; face=-1; deadline=performance.now()+refreshSeconds*1000;
        stats.captures++; stats.lastCenter=pending.toArray();
    };
    const captureFace = () => withCaptureState(() => {
        renderer.setRenderTarget(cube,face);
        renderer.render(scene,camera.children[face]);
        stats.faces++; face++;
    });
    return {
        stats, registerObject,
        configure(options={}) { sampleGroundHeight=options.sampleGroundHeight ?? sampleGroundHeight; dirty=true; },
        setEnvironment(texture) { environment=texture; dirty=true; },
        invalidate() { dirty=true; },
        sample(position, direction, roughness) {
            // Slab exit gives a box-projected direction, anchored to the actual
            // floor height when the host supplies its collision/support query.
            // TSL select on a vector predicate reduces it with all(). Choose
            // each sign independently, or seven octants get the wrong slab.
            const signs = T.vec3(...['x','y','z'].map(axis=>T.select(direction[axis].greaterThanEqual(0),1,-1)));
            const safeDirection = signs.mul(T.abs(direction).max(.00001));
            const first = boxMin.sub(position).div(safeDirection);
            const second = boxMax.sub(position).div(safeDirection);
            const far = T.max(first,second);
            const distance = T.min(far.x,T.min(far.y,far.z)).max(0);
            const projected = position.add(direction.mul(distance)).sub(center).normalize();
            const uv = T.vec3(projected.x,projected.y.negate(),projected.z);
            const radiance = T.textureCubeUV(tex,uv,roughness,1/filtered.width,1/filtered.height,Math.log2(filtered.height)-2);
            const weight = position.distance(center).smoothstep(20,32).oneMinus().mul(ready);
            return T.vec4(radiance,weight);
        },
        async compileAsync() {
            if (!environment || disposed) return;
            beginCapture();
            await withCaptureState(async () => {
                // Different cube directions expose different materials. Warm
                // these variants behind the boot curtain, never during walking.
                for (let i=0;i<6;i++) {
                    renderer.setRenderTarget(cube,i);
                    await renderer.compileAsync(scene,camera.children[i]);
                }
            });
            for(let i=0;i<6;i++) captureFace();
            finishCapture();
        },
        update() {
            if (!environment || disposed) return;
            if (face<0) {
                chooseCenter();
                if (!dirty && performance.now()<deadline && desired.distanceToSquared(center.value)<36) return;
                beginCapture();
            }
            const started=performance.now();
            captureFace();
            if(face===6) finishCapture();
            stats.lastCaptureMs=performance.now()-started;
        },
        dispose() { if(disposed)return;disposed=true;cube.dispose();filtered.dispose();generator.dispose();excluded.clear();lights.clear();convex.clear(); },
    };
}
