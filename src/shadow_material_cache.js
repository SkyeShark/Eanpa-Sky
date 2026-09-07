// Three r184 shares one mutable override material across every shadow caster.
// Alternating opaque and alpha-tested objects increments that material's version
// on every switch, making all previously drawn casters rebuild their cache keys.
// Keep the existing renderer's shadow semantics with a stable variant per source.
export function installShadowMaterialCache(renderer) {
    const original = renderer.renderObject;
    const bases = new Map();
    const roots = ['colorNode', 'depthNode', 'positionNode', 'vertexNode', 'fragmentNode'];
    const stats = { variants: 0, sourcesReleased: 0 };
    let disposed = false;

    function getVariant(base, source) {
        let group = bases.get(base);
        if (!group) {
            const entries = new Map();
            const releaseBase = () => {
                for (const entry of [...entries.values()]) entry.release();
                base.removeEventListener('dispose', releaseBase);
                bases.delete(base);
            };
            group = { entries, releaseBase };
            bases.set(base, group);
            base.addEventListener('dispose', releaseBase);
        }
        let entry = group.entries.get(source);
        if (!entry) {
            const material = base.clone();
            material.isShadowPassMaterial = true;
            material.name = `${base.name}:${source.name || source.type}`;
            const release = () => {
                if (!group.entries.delete(source)) return;
                source.removeEventListener('dispose', release);
                material.dispose();
                stats.variants--; stats.sourcesReleased++;
            };
            entry = { material, release, baseVersion: base.version, sourceVersion: source.version,
                roots: roots.map(key => base[key]) };
            group.entries.set(source, entry);
            source.addEventListener('dispose', release);
            stats.variants++;
        }
        // Preserve explicit custom-shadow graph changes and normal material
        // invalidation. Uniform animation does not require shader invalidation.
        if (entry.baseVersion !== base.version || roots.some((key, i) => entry.roots[i] !== base[key])) {
            entry.material.copy(base);
            entry.material.isShadowPassMaterial = true;
            entry.baseVersion = base.version;
            entry.roots = roots.map(key => base[key]);
            entry.material.needsUpdate = true;
        }
        if (entry.sourceVersion !== source.version) {
            entry.sourceVersion = source.version;
            entry.material.needsUpdate = true;
        }
        return entry.material;
    }
    function renderObject(object, scene, camera, geometry, material, ...rest) {
        const base = scene.overrideMaterial;
        if (disposed || !base?.isShadowPassMaterial || material.allowOverride !== true) {
            return original.call(this, object, scene, camera, geometry, material, ...rest);
        }
        scene.overrideMaterial = getVariant(base, material);
        try {
            return original.call(this, object, scene, camera, geometry, material, ...rest);
        } finally { scene.overrideMaterial = base; }
    }
    renderer.renderObject = renderObject;
    return {
        stats,
        dispose() {
            if (disposed) return;
            disposed = true;
            if (renderer.renderObject === renderObject) renderer.renderObject = original;
            for (const group of [...bases.values()]) group.releaseBase();
        },
    };
}
