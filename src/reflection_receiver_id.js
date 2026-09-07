// Normal-buffer alpha is unused for opaque surfaces. Half floats represent
// these small integers exactly; 0/1 remain reserved for unknown/ordinary data.
// Only explicitly convex groups reject their own pixels: concave meshes and
// separate instances must still be able to reflect themselves/one another.
export function createConvexReceiverIds() {
    const groups = new Map();
    return (object) => {
        const group = object?.userData?.ssrConvexGroup;
        if (!group || object.isInstancedMesh || object.isBatchedMesh) return 1;
        if (!groups.has(group)) {
            if (groups.size >= 2046) return 1;
            groups.set(group, groups.size + 2);
        }
        return groups.get(group);
    };
}
