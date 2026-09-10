// Conservative test for a nonzero native emissive MRT. Dynamic node outputs
// remain eligible even when their current value may be black.
export function hasVisibleEmission(scene, camera) {
    let found = false;
    const emits = material => material?.visible !== false && !!material && (
        material.emissiveNode != null || material.mrtNode != null || material.isShaderMaterial ||
        (material.emissiveIntensity !== 0 && material.emissive &&
            (material.emissive.r !== 0 || material.emissive.g !== 0 || material.emissive.b !== 0))
    );
    if (scene.overrideMaterial) return emits(scene.overrideMaterial);
    scene.traverseVisible(object => {
        if (found || !object.material || (camera && !object.layers.test(camera.layers))) return;
        found = (Array.isArray(object.material) ? object.material : [object.material]).some(emits);
    });
    return found;
}
