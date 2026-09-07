(() => {
    const meshes = [];
    _temple.group.traverse(o => {
        if (o.isMesh && /orb|inanna|sphere|dais/i.test(o.name)) meshes.push({
            name:o.name, position:o.getWorldPosition(new THREE.Vector3()).toArray(),
            materials:(Array.isArray(o.material)?o.material:[o.material]).map(m=>({
                name:m.name,roughness:m.roughness,metalness:m.metalness,envIntensity:m.envMapIntensity,
            })),
        });
    });
    return { meshes, templePosition: _temple.group.position.toArray(),
        templeKeys:Object.keys(_temple), pipelineKeys:Object.keys(_reflectionPipeline),
        skySun: _sky.sunDir.toArray(), skyMoon: _sky.moonDir.toArray(),
        ring:globalThis._ringworld ? {radius:_ringworld.info.radius,halfWidth:_ringworld.info.halfWidth,repeat:_ringworld.info.repeat}:null,
        ready:document.getElementById('boot').style.display==='none' };
})()
