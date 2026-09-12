// Performance display only. World density, rain and cloud-shadow maps continue
// to update independently. Completed panoramas publish atomically; an unfinished
// scissor band never becomes visible or enters a reflection bake.
export function makeCachedCloudDisplay(T, renderer, sky, camera, options = {}) {
    const bounded = (name, fallback, min, max, integer = false) => {
        const value = options[name] ?? fallback;
        if (!Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value)))
            throw new RangeError(`Invalid cloud capture ${name}: ${value}`);
        return value;
    };
    const width = bounded('width',2048,16,4096,true), height = bounded('height',1024,16,2048,true);
    const bands = bounded('bands',Math.min(height,32),1,height,true);
    const refreshSeconds = bounded('refreshSeconds',9,.1,60);
    const blendSeconds = bounded('blendSeconds',9,.05,60);
    const u = sky.uniforms;
    const shared = value => T.uniform(value).setGroup(T.renderGroup);
    const makeRecord = index => {
        const target = new T.RenderTarget(width, height, {count:2,type:T.HalfFloatType, depthBuffer:false});
        for(const texture of target.textures)Object.assign(texture, {wrapS:T.RepeatWrapping, wrapT:T.ClampToEdgeWrapping,
            minFilter:T.LinearFilter, magFilter:T.LinearFilter, generateMipmaps:false,
            colorSpace:T.NoColorSpace});
        target.texture.name = `eanpa-cloud-panorama-${index}`;
        target.textures[1].format = T.RedFormat;
        target.textures[1].name = `eanpa-cloud-distance-${index}`;
        return {target, origin:new T.Vector3(), wind:new T.Vector3(), light:new T.Vector3(),
            sun:new T.Vector3(), stretch:new T.Vector3(1,1,1), flow:new T.Vector2(),
            altitude:1000, time:-Infinity, signature:[]};
    };
    const records = [0,1,2].map(makeRecord);
    let current = records[0], previous = records[1], staging = records[2];
    const makeView = record => ({
        texture:T.texture(record.target.texture), distance:T.texture(record.target.textures[1]), origin:shared(new T.Vector3()),
        wind:shared(new T.Vector3()), light:shared(new T.Vector3(1,1,1)), altitude:shared(1000),
        stretch:shared(new T.Vector3(1,1,1)), flow:shared(new T.Vector2()), time:shared(0),
    });
    const oldView = makeView(previous), newView = makeView(current), blend = shared(1);
    for (const view of [oldView,newView]) view.texture.updateMatrix = view.distance.updateMatrix = false;
    const captureOrigin = shared(new T.Vector3());
    const capture = sky.createCloudCaptureMaterial(captureOrigin);
    const quad = new T.QuadMesh(capture.material);
    // Use exactly the same vertex graph for warmup and draws. QuadMesh.render
    // temporarily replaces it, which would create a second pipeline at startup.
    capture.material.vertexNode = T.vec4(T.positionGeometry,1);
    let ready = false, disposed = false, released = false, band = -1, publishedAt = 0;
    let lastUpdateTime = null, bandSeconds = .5;
    let initialization = null, updating = null;
    let savedState;
    const observer = new T.Vector3();
    const observerNode = shared(new T.Vector3());
    const signatureNames = ['finalMul','wispOn','stormCanopy','cloudWeatherGrey','wispOpacity'];
    const lightNode = u.cloudLightColor.mul(u.lightK).add(u.cloudAmbSky.mul(.5))
        .add(u.cloudAmbGround.mul(.15)).mul(u.cloudRadiance).mul(u.cloudRadianceScale).max(.001);
    const lightFloor = new T.Vector3(.001,.001,.001);
    const lightValue = target => target.copy(u.cloudLightColor.value).multiplyScalar(u.lightK.value)
        .addScaledVector(u.cloudAmbSky.value,.5).addScaledVector(u.cloudAmbGround.value,.15)
        .multiplyScalar(u.cloudRadiance.value*u.cloudRadianceScale.value).max(lightFloor);
    const stats = {mode:'banded-world-direction-cloud-panorama',width,height,bands,
        refreshSeconds,blendSeconds,activeBlendSeconds:blendSeconds,captures:0,bandDraws:0,fullDraws:0,failures:0,
        distanceReprojection:true,textureBytes:width*height*10*3,
        publishedTime:null,captureTime:null,band:-1,blend:1,liveCloudShadows:true,liveLocalReflections:true};
    const publishView = (view, record) => {
        view.texture.value = record.target.texture;
        view.distance.value = record.target.textures[1];
        view.origin.value.copy(record.origin);view.wind.value.copy(record.wind);
        view.light.value.copy(record.light);view.altitude.value = record.altitude;
        view.stretch.value.copy(record.stretch);view.flow.value.copy(record.flow);
        view.time.value=Number.isFinite(record.time)?record.time:u.time.value;
    };
    const begin = async () => {
        await sky.prepareOptimizedCaches?.(renderer,camera,true);
        if(disposed)return false;
        camera.getWorldPosition(observer);observerNode.value.copy(observer);staging.origin.copy(observer);
        staging.wind.copy(u.cloudDisplacement.value);staging.sun.copy(u.cloudLightDir.value);
        staging.time = u.time.value;staging.signature = signatureNames.map(name => u[name].value);
        staging.stretch.copy(u.stretch.value);
        // Match the density-domain drift: the main erosion field travels in
        // addition to the weather map. Cirrus has only wind advection; the
        // storm volume has its own slower drift. Keep these per capture so
        // a weather transition never changes an old image's motion model.
        const smooth = (a,b,v) => {const t=Math.max(0,Math.min(1,(v-a)/(b-a)));return t*t*(3-2*t);};
        const underlayerFront = smooth(.96,.995,u.stormCanopy.value)
            *(1-smooth(.005,.08,u.celestialVisibility.value));
        const stormWeight = u.stormCanopy.value*(1-underlayerFront);
        staging.flow.set(u.finalMul.value>.0001 ? 1-stormWeight : 0,stormWeight);
        staging.altitude = u.stormCanopy.value > .1 ? 1275
            : u.finalMul.value > .001 ? u.cloudStart.value + u.cloudHeight.value*.5
            : u.cloudStart.value + u.cloudHeight.value + 1000;
        lightValue(staging.light);captureOrigin.value.copy(observer);capture.snapshot.capture();
        band = 0;stats.captureTime = staging.time;stats.band = band;
        return true;
    };
    const renderBand = async full => {
        const target = staging.target;
        const start = full ? 0 : Math.floor(band*height/bands);
        const end = full ? height : Math.floor((band+1)*height/bands);
        savedState = T.RendererUtils.saveRendererState(renderer,savedState);
        const xr = renderer.xr.enabled;
        try {
            renderer.xr.enabled = false;renderer.setMRT(null);renderer.setRenderObjectFunction(null);
            renderer.autoClear = false;target.scissor.set(0,start,width,end-start);target.scissorTest = !full;
            // r186 takes the rectangle from the target, but the enable flag
            // from the renderer's canvas target. Both must be set: target-only
            // scissoring silently rerenders the full panorama for every band.
            renderer.setScissorTest(!full);
            renderer.setRenderTarget(target);
            if (full && !ready) await renderer.compileAsync(quad,quad.camera);
            if(disposed)return false;
            renderer.render(quad,quad.camera);
            if(full)stats.fullDraws++;else stats.bandDraws++;
        } catch(error) {stats.failures++;throw error;}
        finally {
            target.scissorTest = false;renderer.xr.enabled = xr;
            T.RendererUtils.restoreRendererState(renderer,savedState);
        }
        band = full ? bands : band+1;stats.band = band;
        return true;
    };
    const publish = time => {
        const recycled = previous;previous = current;current = staging;staging = recycled;
        publishView(newView,current);publishView(oldView,previous);
        publishedAt = ready ? time : time-blendSeconds;blend.value = ready ? 0 : 1;
        lastUpdateTime = time;
        ready = true;band = -1;stats.band = -1;stats.captures++;
        stats.publishedTime = current.time;stats.blend = blend.value;
    };
    const release = () => {
        if(!disposed || released || initialization || updating)return;
        released=true;
        for(const record of records)record.target.dispose();
        capture.material.dispose();capture.snapshot.dispose();
    };
    const directionUV = ray => T.vec2(T.atan(ray.z,ray.x).div(Math.PI*2).add(.5),
        T.acos(ray.y.clamp(-1,1)).div(Math.PI).clamp(.5/height,1-.5/height));
    const sampleView = (view, dir, origin) => {
        const delta = u.cloudDisplacement.sub(view.wind), elapsed = u.time.sub(view.time);
        const ordinary = T.vec3(delta.x.add(delta.z.mul(.4)).sub(elapsed.mul(12.3)),0,
            delta.z.sub(delta.x.mul(.4))).div(view.stretch.max(.01));
        const storm = T.vec3(delta.x.mul(.62),elapsed.mul(-1.15),delta.z.mul(.62));
        const advection = delta.mul(T.float(1).sub(view.flow.x).sub(view.flow.y))
            .add(ordinary.mul(view.flow.x)).add(storm.mul(view.flow.y));
        const distance = view.altitude.sub(origin.y).max(1).div(dir.y.max(.04)).min(u.fadeDist);
        const firstRay = origin.add(dir.mul(distance)).sub(view.origin).sub(advection).normalize();
        const firstUV=directionUV(firstRay),firstColor=view.texture.sample(firstUV);
        const capturedDistance = view.distance.sample(firstUV).r.mul(1000).div(firstColor.a.max(.0001));
        // Reconstruct the captured visible cloud, then solve its distance on
        // the current ray. This also handles the curved deck and high cirrus;
        // a fixed plane alone slides different cloud depths out of alignment.
        const point = view.origin.add(firstRay.mul(capturedDistance)).add(advection);
        const correctedDistance = point.sub(origin).dot(dir).max(1);
        // Thin/mixed silhouettes have uncertain depth; retain the smooth
        // altitude prior there instead of letting a discontinuity fold UVs.
        const confidence=T.smoothstep(.02,.15,firstColor.a).mul(T.smoothstep(1,10,capturedDistance));
        const travel = T.mix(distance,correctedDistance.clamp(distance.mul(.65),distance.mul(1.5)),confidence);
        const warped = origin.add(dir.mul(travel)).sub(view.origin).sub(advection).normalize();
        const ray = T.mix(dir,warped,T.smoothstep(.005,.025,dir.y)).normalize();
        const rgba = view.texture.sample(directionUV(ray));
        const relight = lightNode.div(view.light.max(.001)).clamp(0,4);
        return T.vec4(rgba.rgb.mul(relight),rgba.a);
    };
    const api = {
        stats, records, originNode:observerNode, get ready(){return ready;},
        sample(dir, origin, transient = true) {
            const rgba = T.mix(sampleView(oldView,dir,origin),sampleView(newView,dir,origin),blend);
            let radiance = rgba.rgb;
            if(transient){
                const distance = u.cloudStart.add(u.cloudHeight.mul(.5)).max(1100)
                    .sub(origin.y).max(1).div(dir.y.max(.04)).min(u.fadeDist);
                const hit = origin.add(dir.mul(distance));
                const reach = hit.xz.sub(u.lightningStrike.xz).length().mul(-.00082).exp().mul(.94).add(.025);
                radiance = radiance.add(u.lightningFlashColor.mul(u.lightningStrike.w.clamp(0,1.15))
                    .mul(reach).mul(rgba.a).mul(.55));
            }
            return T.vec4(radiance.mul(u.solarSkyVisibility),rgba.a);
        },
        async ensureReady() {
            if(disposed)return false;
            if(ready)return true;
            if(!initialization)initialization=(async()=>{
                // Keep old/new texture identities distinct during the first
                // shader build. Pointing both at the first capture makes TSL
                // deduplicate them into one binding, breaking every later fade.
                // The zero-initialized old target has zero weight at startup.
                for(const record of records)renderer.initRenderTarget(record.target);
                if(!await begin() || !await renderBand(true))return false;
                await renderer.backend.device.queue.onSubmittedWorkDone();
                if(disposed)return false;
                publish(u.time.value);return true;
            })().finally(()=>{initialization=null;release();});
            return initialization;
        },
        async update() {
            if(disposed)return;
            if(updating)return updating;
            updating=(async()=>{
                if(!await api.ensureReady() || disposed)return;
                const time = u.time.value;
                camera.getWorldPosition(observer);observerNode.value.copy(observer);
                const age = time-current.time;
                const changed = signatureNames.some((name,i)=>Math.abs(u[name].value-current.signature[i])>.035);
                const moved = observer.distanceToSquared(current.origin)>32*32;
                const sunMoved = current.sun.dot(u.cloudLightDir.value)<.999;
                const responsive = changed||moved||sunMoved;
                const cadence = responsive ? Math.min(refreshSeconds,3) : refreshSeconds;
                const duration = responsive ? Math.min(blendSeconds,3) : blendSeconds;
                const dt = lastUpdateTime===null ? 0 : Math.max(0,time-lastUpdateTime);
                // Continuous interpolation, not a held image followed by a
                // half-second catch-up pulse. Changing weather may accelerate
                // the fade, but never jumps its weight or replaces a live slot.
                blend.value = Math.min(1,blend.value+dt/duration);
                lastUpdateTime = time;stats.activeBlendSeconds=duration;
                if(time<publishedAt){band=-1;blend.value=1;publishedAt=time-blendSeconds;}
                stats.blend = blend.value;
                const lead = Math.min(bandSeconds,cadence*.5);
                if(band<0 && (1-blend.value)*duration<=lead && (age>=cadence-lead || age<0)) {
                    if(!await begin())return;
                }
                if(band>=0 && band<bands && await renderBand(false) && band>=bands) {
                    // Measure drawing, not time waiting for the previous fade.
                    // Otherwise a slow frame period permanently schedules all
                    // later captures too early after the frame rate recovers.
                    bandSeconds=Math.max(.01,Math.min(refreshSeconds,time-staging.time));
                }
                if(band>=bands && blend.value>=1)publish(time);
            })().finally(()=>{updating=null;release();});
            return updating;
        },
        dispose() {
            if(disposed)return;disposed=true;
            // A sky/quality switch may arrive during async warmup. Never draw
            // into released targets or publish that obsolete sky afterwards.
            release();
        },
    };
    return api;
}
