// Three r184 retains draw objects for obsolete render contexts/lights, and its
// geometry disposer only sees the attributes of the first draw. TSL creates
// additional instance buffers for later draws. Retire these caches explicitly
// while the standalone's frame loop is stopped for a complete sky rebuild.
// This adapter is intentionally scoped to the pinned WebGPURenderer internals.
export function installRebuildResourceCache(renderer) {
    const objects = renderer._objects, attributes = renderer._attributes;
    if (!objects?.createRenderObject || !attributes?.delete) {
        throw new Error('Rebuild resource cache requires an initialized Three WebGPURenderer');
    }
    const originalCreate = objects.createRenderObject;
    const draws = new Set(), generated = new Set(), geometryBuffers = new Set();
    const root = attribute => attribute.isInterleavedBufferAttribute ? attribute.data : attribute;
    const stats = { clears: 0, retiredDraws: 0, releasedAttributes: 0 };
    function create(...args) {
        const draw = originalCreate.apply(this, args);
        draws.add(draw);
        const dispose = draw.onDispose, getAttributes = draw.getAttributes;
        let lastAttributes;
        draw.getAttributes = function () {
            const result = getAttributes.call(this);
            if (result !== lastAttributes) {
                lastAttributes = result;
                for (const a of Object.values(this.geometry.attributes)) geometryBuffers.add(root(a));
                if (this.geometry.index) geometryBuffers.add(root(this.geometry.index));
                for (const a of result) if (!geometryBuffers.has(root(a))) generated.add(a);
            }
            return result;
        };
        draw.onDispose = function () {
            if (!draws.delete(draw)) return;
            stats.retiredDraws++;
            dispose.call(this);
        };
        return draw;
    }
    objects.createRenderObject = create;
    let disposed = false;
    function clear() {
        // Call only after awaiting all in-flight rendering/warmup. Geometry and
        // its uploaded vertex/index data remain live for the persistent scene.
        for (const draw of [...draws]) draw.dispose();
        const releasedBuffers = new Set();
        for (const a of generated) {
            const buffer = root(a);
            if (geometryBuffers.has(buffer)) continue;
            if (attributes.has(a)) {
                attributes.delete(a);
                stats.releasedAttributes++;
            }
            releasedBuffers.add(buffer);
        }
        // Four matrix columns share one interleaved GPU buffer. Native deletion
        // clears the column keys; clear the backing key after all four columns
        // so a reusable TSL attribute can allocate a fresh buffer on next use.
        for (const buffer of releasedBuffers) renderer.backend.delete(buffer);
        generated.clear(); geometryBuffers.clear();
        stats.clears++;
    }
    return {
        stats,
        clear() { if (!disposed) clear(); },
        dispose() {
            if (disposed) return;
            clear(); disposed = true;
            if (objects.createRenderObject === create) objects.createRenderObject = originalCreate;
        },
    };
}
