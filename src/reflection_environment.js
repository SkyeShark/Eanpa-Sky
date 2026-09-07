// Own the filtered environment explicitly. Three's automatic equirectangular
// cache keeps its generated render target outside the source texture's disposal.
// One generator and one output target serve every material and sky rebuild.
export function makeReflectionEnvironment(THREE, renderer) {
    const generator = new THREE.PMREMGenerator(renderer);
    let target = null, cubeSize = 0, disposed = false;
    const stats = { bakes: 0, replacements: 0 };
    return {
        stats,
        update(source) {
            if (disposed) throw new Error('Reflection environment has been disposed');
            const width = Number(source?.image?.width);
            if (!Number.isFinite(width) || width < 4) throw new Error('Reflection source has an invalid image width');
            const nextSize = 2 ** Math.floor(Math.log2(width / 4));
            // The native generator sizes its cube faces from equirect width.
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
        dispose() {
            if (disposed) return;
            disposed = true;
            target?.dispose(); target = null;
            generator.dispose();
        },
    };
}
