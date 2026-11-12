// Own the filtered environment explicitly. Three's automatic equirectangular
// cache keeps its generated render target outside the source texture's disposal.
// One generator and one output target serve every material and sky rebuild.
//
// A refresh can also be filtered in slices: begin(source) then step() once a
// frame. The slices are the same passes fromEquirectangular() makes in one go
// (the equirect into the cube-UV layout, then two per GGX level: 17 render
// passes and about a millisecond of GPU for the 384x192 bake), with the same
// generator and shaders, so the result is the same PMREM. They render into a
// staging target and the finished filter is published with one GPU copy into
// the output target, whose identity never changes: materials keep their
// binding, and no frame carries the whole refresh. update() stays the one-go
// path (boot, sky switches, a size change); begin() returns false whenever it
// must be used instead.
export function makeReflectionEnvironment(THREE, renderer) {
    const generator = new THREE.PMREMGenerator(renderer);
    let target = null, cubeSize = 0, disposed = false;
    let staging = null, steps = null, next = -1;
    const stats = { bakes: 0, replacements: 0, slicedBakes: 0, steps: 0 };
    // the generator's own stages, as three r184-r186 name them
    const sliceable = ['_setSizeFromTexture', '_allocateTarget', '_init', '_textureToCubeUV', '_applyGGXFilter']
        .every((name) => typeof generator[name] === 'function')
        && typeof renderer.copyTextureToTexture === 'function';
    const sizeOf = (source) => {
        const width = Number(source?.image?.width);
        if (!Number.isFinite(width) || width < 4) throw new Error('Reflection source has an invalid image width');
        // The native generator sizes its cube faces from equirect width.
        return 2 ** Math.floor(Math.log2(width / 4));
    };
    const runStep = (index) => {
        const state = THREE.RendererUtils.saveRendererState(renderer);
        try {
            renderer.setMRT(null);
            staging.scissorTest = true;
            steps[index]();
        } finally { THREE.RendererUtils.restoreRendererState(renderer, state); }
        stats.steps++;
    };
    return {
        stats,
        get busy() { return next >= 0; },
        update(source) {
            if (disposed) throw new Error('Reflection environment has been disposed');
            next = -1;
            const nextSize = sizeOf(source);
            // Its optional reuse target must already have matching dimensions.
            const state = THREE.RendererUtils.saveRendererState(renderer);
            try {
                renderer.setMRT(null);
                const next = generator.fromEquirectangular(source, nextSize === cubeSize ? target : null);
                if (target && next !== target) {
                    target.dispose(); stats.replacements++;
                }
                target = next;
                cubeSize = nextSize;
                target.texture.name = 'eanpa-owned-sky-pmrem';
                target.texture.pmremVersion++;
                stats.bakes++;
                return target.texture;
            } finally { THREE.RendererUtils.restoreRendererState(renderer, state); }
        },
        /** Starts filtering `source` in slices into the current target; false when update() must do it instead. */
        begin(source) {
            if (disposed) throw new Error('Reflection environment has been disposed');
            if (!sliceable || !target || next >= 0 || sizeOf(source) !== cubeSize) return false;
            generator._setSizeFromTexture(source);
            if (!staging) {
                staging = generator._allocateTarget();
                staging.texture.name = 'eanpa-owned-sky-pmrem-staging';
                renderer.initRenderTarget(staging);
            }
            generator._init(staging);
            const levels = generator._lodMeshes.length;
            steps = [() => generator._textureToCubeUV(source, staging)];
            for (let level = 1; level < levels; level++) {
                steps.push(() => { renderer.autoClear = false; generator._applyGGXFilter(staging, level - 1, level); });
            }
            steps.push(() => renderer.copyTextureToTexture(staging.texture, target.texture));
            next = 0;
            return true;
        },
        /** The next slice; returns the published texture when this slice finished the filter, else null. */
        step() {
            if (disposed || next < 0) return null;
            runStep(next++);
            if (next < steps.length) return null;
            next = -1;
            target.texture.pmremVersion++;
            stats.bakes++;
            stats.slicedBakes++;
            return target.texture;
        },
        /** Abandons a sliced refresh (the published filter stays). */
        cancel() { next = -1; },
        dispose() {
            if (disposed) return;
            disposed = true;
            next = -1;
            target?.dispose(); target = null;
            staging?.dispose(); staging = null;
            generator.dispose();
        },
    };
}
