(async () => {
    if (!_reflectionPipeline.registerObject) throw new Error('Native reflection comparison is not active');
    _eanpaTest.pauseAfterFrame = true;
    _eanpaTest.paused = false;
    while (!_eanpaTest.paused) await new Promise(r => setTimeout(r, 20));
    if (globalThis.__reflectionFixture) throw new Error('Fixture already exists; reuse it or reload the owned page');
    const T = THREE, group = new T.Group();
    group.name = 'reflection_validation_fixture';
    const checker = T.mod(T.positionWorld.x.floor().add(T.positionWorld.z.floor()), 2);
    const floorMaterial = new T.MeshStandardNodeMaterial({ roughness: 1, metalness: 0 });
    floorMaterial.colorNode = T.mix(T.vec3(.035,.055,.08), T.vec3(.65,.68,.72), checker);
    const floor = new T.Mesh(new T.PlaneGeometry(20,24), floorMaterial);
    floor.rotation.x = -Math.PI/2;
    floor.position.set(0,40,61);
    group.add(floor);
    const properties = [
        {name:'silver',metalness:1,roughness:.12,color:0xffffff},
        {name:'water-ior-clearcoat',metalness:0,roughness:.55,color:0x223344,ior:1.33,clearcoat:1,clearcoatRoughness:.08},
        {name:'anisotropic-gold',metalness:1,roughness:.3,color:0xe8b13a,anisotropy:.9,anisotropyRotation:.5},
        {name:'iridescent-metal',metalness:1,roughness:.16,color:0xffffff,iridescence:1},
    ];
    properties.forEach((settings,i) => {
        const material = new T.MeshPhysicalNodeMaterial(settings);
        const sphere = new T.Mesh(new T.SphereGeometry(1.15,48,32), material);
        sphere.position.set((i-1.5)*2.9,41.18,61);
        sphere.name=settings.name;
        sphere.userData.ssrConvexGroup=sphere.uuid;
        group.add(sphere);
    });
    const emitterMaterial = new T.MeshStandardNodeMaterial({color:0x000000,emissive:0xff1800,emissiveIntensity:2,roughness:1});
    const emitter = new T.Mesh(new T.BoxGeometry(9,.55,.7),emitterMaterial);
    emitter.position.set(0,40.6,64.6);
    emitter.name='red_reflection_positive_control';
    group.add(emitter);
    group.traverse(o=>{o.userData.noWet=true;o.userData.noCloudShadow=true;});
    _c.parent.add(group);
    _reflectionPipeline.registerObject(group);
    globalThis.__reflectionFixture=group;
    _c.position.set(0,44,72);
    _c.fov=52;_c.updateProjectionMatrix();
    _c.lookAt(0,41.6,61.8);
    _c.updateMatrixWorld(true);
    await _reflectionPipeline.compileAsync();
    await _reflectionPipeline.render();
    return {materials:properties,camera:_c.position.toArray()};
})()
