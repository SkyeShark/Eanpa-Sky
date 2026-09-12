// A nearby, parallax-corrected radiance capture fills the geometry hidden from
// SSR. Six faces refresh over six frames; only a completed cube is prefiltered
// and published. The visible frame never reads a partially updated probe.
export function makeLocalReflectionProbe(T, renderer, scene, viewCamera, {size = 128, refreshSeconds = 3,
    blendSeconds=.45,now=()=>performance.now()} = {}) {
    const cube = new T.CubeRenderTarget(size, {type:T.HalfFloatType, generateMipmaps:false});
    cube.texture.name = 'output';
    const camera = new T.CubeCamera(.15, viewCamera.far, cube);
    camera.coordinateSystem = renderer.coordinateSystem;
    camera.updateCoordinateSystem();
    renderer.initRenderTarget(cube);
    const generator = new T.PMREMGenerator(renderer);
    const initialState = T.RendererUtils.saveRendererState(renderer);
    let filtered,back;
    try { renderer.setMRT(null); filtered = generator.fromCubemap(cube.texture); back=generator.fromCubemap(cube.texture); }
    finally { T.RendererUtils.restoreRendererState(renderer, initialState); }
    filtered.texture.name = 'eanpa-local-probe-pmrem';
    const tex = T.texture(filtered.texture,T.screenUV);
    tex.updateMatrix = false;
    const oldTex=T.texture(back.texture,T.screenUV);oldTex.updateMatrix=false;
    const shared = value => T.uniform(value).setGroup(T.renderGroup);
    const center = shared(new T.Vector3()), boxMin = shared(new T.Vector3()), boxMax = shared(new T.Vector3());
    const oldCenter=shared(new T.Vector3()),oldMin=shared(new T.Vector3()),oldMax=shared(new T.Vector3()),blend=shared(1);
    const ready = shared(0);
    const excluded = new Set(), lights = new Set(), convex = new Set();
    const sourceContext = T.context({eanpaReflectionSurfacePass:false});
    const captureMrt = T.mrt({output:T.output});
    const point = new T.Vector3(), desired = new T.Vector3(), pending = new T.Vector3();
    let environment = null, sampleGroundHeight = null, face = -1, deadline = 0, dirty = true, disposed = false,blendStart=-Infinity;
    const stats = {captures:0, faces:0, lastCaptureMs:0, lastCenter:[0,0,0],blend:1};

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
        try { renderer.setMRT(null); generator.fromCubemap(cube.texture,back); }
        finally { T.RendererUtils.restoreRendererState(renderer,state); }
        const previous=filtered;filtered=back;back=previous;
        tex.value=filtered.texture;oldTex.value=back.texture;
        oldCenter.value.copy(center.value);oldMin.value.copy(boxMin.value);oldMax.value.copy(boxMax.value);
        center.value.copy(pending);
        boxMin.value.copy(pending).addScalar(-32); boxMax.value.copy(pending).addScalar(32);
        const ground = Number(sampleGroundHeight?.(pending.x,pending.z));
        if (Number.isFinite(ground) && ground < pending.y-.1 && ground > pending.y-32) boxMin.value.y=ground;
        blend.value=ready.value?0:1;stats.blend=blend.value;blendStart=ready.value?now():-Infinity;
        ready.value=1; face=-1; deadline=now()+refreshSeconds*1000;
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
            const sampleBox=(source,captureCenter,minimum,maximum)=>{
            const first = minimum.sub(position).div(safeDirection);
            const second = maximum.sub(position).div(safeDirection);
            const far = T.max(first,second);
            const distance = T.min(far.x,T.min(far.y,far.z)).max(0);
            const projected = position.add(direction.mul(distance)).sub(captureCenter).normalize();
            const uv = T.vec3(projected.x,projected.y.negate(),projected.z);
            const radiance = T.textureCubeUV(source,uv,roughness,1/filtered.width,1/filtered.height,Math.log2(filtered.height)-2);
            const weight = position.distance(captureCenter).smoothstep(20,32).oneMinus().mul(ready);
            return T.vec4(radiance,weight);
            };
            return T.Fn(()=>{
                const current=sampleBox(tex,center,boxMin,boxMax).toVar();
                T.If(blend.lessThan(.999),()=>{
                    const old=sampleBox(oldTex,oldCenter,oldMin,oldMax).toVar();
                    const alpha=T.mix(old.a,current.a,blend);
                    current.assign(T.vec4(T.mix(old.rgb.mul(old.a),current.rgb.mul(current.a),blend).div(alpha.max(.00001)),alpha));
                });
                return current;
            })();
        },
        async compileAsync() {
            if (!environment || disposed) return;
            beginCapture();
            await withCaptureState(async () => {
                // The pinned compiler visits every visible material without
                // frustum culling. All cube cameras share this shader variant;
                // avoid five duplicate walks of already-prepared materials.
                renderer.setRenderTarget(cube,0);
                await renderer.compileAsync(scene,camera.children[0]);
            });
            // Keep the environment fallback until update() has captured all
            // six faces. Compilation prepares the variant; presentation need
            // not wait for the capture or its PMREM filtering.
        },
        update() {
            if (!environment || disposed) return;
            const progress=Math.max(0,Math.min(1,(now()-blendStart)/(Math.max(.001,blendSeconds)*1000)));
            blend.value=progress*progress*(3-2*progress);stats.blend=blend.value;
            if (face<0) {
                chooseCenter();
                if (blend.value<1 || (!dirty && now()<deadline && desired.distanceToSquared(center.value)<36)) return;
                beginCapture();
            }
            const started=performance.now();
            captureFace();
            if(face===6) finishCapture();
            stats.lastCaptureMs=performance.now()-started;
        },
        dispose() { if(disposed)return;disposed=true;cube.dispose();filtered.dispose();back.dispose();generator.dispose();excluded.clear();lights.clear();convex.clear(); },
    };
}
