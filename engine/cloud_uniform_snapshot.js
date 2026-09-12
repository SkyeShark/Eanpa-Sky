// A banded capture needs one weather state for its entire panorama. Separate
// uniform storage keeps the live frame-group buffers untouched during capture.
// Selection happens once during shader construction, not for every receiver.
export function makeCloudUniformSnapshot(T, uniforms) {
    const group = T.sharedUniformGroup('eanpa_cloud_snapshot');
    const entries = Object.entries(uniforms).map(([name, live]) => {
        const original = live.getSharedNode;
        const frozen = T.uniform(live.value?.clone?.() ?? live.value).setGroup(group);
        const select = function(builder) {
            return builder.context.eanpaCloudSnapshot
                ? frozen.getSharedNode(builder) : original.call(this, builder);
        };
        live.getSharedNode = select;
        return {name, live, frozen, original, select};
    });
    return {
        capture() {
            for (const {name, live, frozen} of entries) {
                if (frozen.value?.copy) frozen.value.copy(live.value);
                else frozen.value = name === 'solarSkyVisibility' ? 1 : live.value;
            }
            // These replacement nodes are selected during generate(), after
            // setup has collected ordinary frame/render update callbacks.
            // Explicit publication versions update this group once per bake.
            group.needsUpdate = true;
        },
        dispose() {
            for (const {live, original, select} of entries)
                if (live.getSharedNode === select) live.getSharedNode = original;
        },
    };
}
