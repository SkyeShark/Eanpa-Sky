(async () => {
    // Preserve this close underside view: the old frontal test missed the
    // recurring dark bands reported in Screenshot 2026-09-07 041328.png.
    _eanpaTest.pauseAfterFrame = true;
    _eanpaTest.paused = false;
    while (!_eanpaTest.paused) await new Promise(resolve => setTimeout(resolve, 20));
    _c.position.set(0, 24.8, -67);
    _c.fov = 52;
    _c.updateProjectionMatrix();
    _c.rotation.set(0.14, 0, 0);
    _c.updateMatrixWorld(true);
    const orb = _c.parent.getObjectByName('authored_inanna_orb_pivot');
    orb.rotation.y = -0.7;
    orb.position.y = 26.96;
    orb.updateMatrixWorld(true);
    await _reflectionPipeline.render();
    return { camera: _c.position.toArray(), orb: orb.getWorldPosition(new THREE.Vector3()).toArray() };
})()
