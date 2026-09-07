// Procedural Temple of Inanna scene dressing for the Eanpa browser demo.
// Everything is native geometry and WebGPU-safe standard/basic materials;
// repeated architecture and desert dressing are instanced to keep draw and
// allocation cost predictable. The optional envMap is assigned per material
// (never through scene.environment, which the sky domes cannot tolerate).

export async function makeTempleScene(THREE, {
    terrain = null,
    envMap = null,
    sandstoneTextures = null,
    inannaModel = null,
} = {}) {
    const T3 = THREE;
    const StandardMaterial = T3.MeshStandardNodeMaterial ?? T3.MeshStandardMaterial;
    const BasicMaterial = T3.MeshBasicNodeMaterial ?? T3.MeshBasicMaterial;
    const ownedGeometries = new Set();
    const ownedMaterials = new Set();
    const ownedModelTextures = new Set();
    const instancedMeshes = [];
    const stoneSurfaces = [];
    let disposed = false;

    const ownGeometry = (geometry) => { ownedGeometries.add(geometry); return geometry; };
    const ownMaterial = (material) => { ownedMaterials.add(material); return material; };
    const applySandstoneSurface = (material, tint) => {
        if (!sandstoneTextures?.albedo || !sandstoneTextures?.normal || !sandstoneTextures?.roughness) return;
        const { positionWorld, normalWorld, cameraViewMatrix } = T3;
        const scale = 1 / 5.5;
        const weightsRaw = T3.abs(normalWorld);
        const weights = weightsRaw.div(weightsRaw.x.add(weightsRaw.y).add(weightsRaw.z));
        const tri = (texture) => T3.texture(texture, positionWorld.zy.mul(scale)).mul(weights.x)
            .add(T3.texture(texture, positionWorld.xz.mul(scale)).mul(weights.y))
            .add(T3.texture(texture, positionWorld.xy.mul(scale)).mul(weights.z));
        const colorNode = tri(sandstoneTextures.albedo).rgb.mul(T3.vec3(...tint));
        const roughnessNode = tri(sandstoneTextures.roughness).r.mul(0.22).add(0.76).clamp(0.72, 1);

        // Decode each tangent-space projection into world space before the
        // triplanar blend; raw normal-map RGB blending makes cube faces point
        // into unrelated tangent frames and produces bright seams.
        const nX = T3.texture(sandstoneTextures.normal, positionWorld.zy.mul(scale)).rgb.mul(2).sub(1);
        const nY = T3.texture(sandstoneTextures.normal, positionWorld.xz.mul(scale)).rgb.mul(2).sub(1);
        const nZ = T3.texture(sandstoneTextures.normal, positionWorld.xy.mul(scale)).rgb.mul(2).sub(1);
        const axisSign = T3.sign(normalWorld);
        const worldX = T3.vec3(nX.z.mul(axisSign.x), nX.y.mul(axisSign.x).mul(-1), nX.x);
        const worldY = T3.vec3(nY.x, nY.z.mul(axisSign.y), nY.y.mul(axisSign.y).mul(-1));
        const worldZ = T3.vec3(nZ.x, nZ.y.mul(axisSign.z), nZ.z.mul(axisSign.z));
        const mappedWorld = T3.normalize(worldX.mul(weights.x).add(worldY.mul(weights.y)).add(worldZ.mul(weights.z)));
        const normalNode = T3.normalize(cameraViewMatrix.transformDirection(T3.mix(normalWorld, mappedWorld, 0.46)));
        material.colorNode = colorNode;
        material.roughnessNode = roughnessNode;
        material.normalNode = normalNode;
        stoneSurfaces.push({ material, colorNode, roughnessNode, normalNode });
    };
    const standard = (params, envIntensity = 0.32, stoneTint = null) => {
        const material = ownMaterial(new StandardMaterial(params));
        material.envMapIntensity = envIntensity;
        if (envMap) {
            material.envMap = envMap;
        }
        if (stoneTint) applySandstoneSurface(material, stoneTint);
        return material;
    };
    const unlit = (params) => ownMaterial(new BasicMaterial({ toneMapped: false, ...params }));

    const sandstone = [
        standard({ color: 0x9a6541, roughness: 0.92, metalness: 0 }, 0.32, [0.82, 0.67, 0.58]),
        standard({ color: 0xb1784b, roughness: 0.88, metalness: 0 }, 0.32, [0.98, 0.82, 0.67]),
        standard({ color: 0x7f4f34, roughness: 0.95, metalness: 0 }, 0.32, [0.66, 0.52, 0.46]),
    ];
    const sandstoneTrim = standard({ color: 0xc18b5a, roughness: 0.82, metalness: 0.02 }, 0.32, [1.06, 0.90, 0.73]);
    const sandstoneDark = standard({ color: 0x553525, roughness: 0.96, metalness: 0 }, 0.32, [0.44, 0.36, 0.34]);
    const recessMaterial = standard({ color: 0x11191b, roughness: 0.58, metalness: 0.42 }, 0.7);
    const darkMetal = standard({ color: 0x1a2528, roughness: 0.28, metalness: 0.86 }, 1.0);
    const goldMetal = standard({ color: 0xa76a25, roughness: 0.24, metalness: 0.82 }, 1.0);
    const rockMaterial = standard({ color: 0xffffff, roughness: 0.96, metalness: 0 });
    const shrubMaterial = standard({ color: 0x5d6742, roughness: 1, metalness: 0 });
    const cyanMaterial = unlit({ color: 0x45e4d0 });
    const amberMaterial = unlit({ color: 0xffb34a });
    const orbMaterial = unlit({ color: 0x53fff0 });
    const wireMaterial = unlit({ color: 0xffbd55, wireframe: true, transparent: true, opacity: 0.78, depthWrite: false });

    const group = new T3.Group();
    group.name = 'eanpa_temple_compound';
    group.userData.noCloudShadow = false;

    // Fast bilinear sampler for the current regular-grid terrain. It falls
    // back to the terrain object's world Y for any future non-grid terrain.
    const makeHeightSampler = () => {
        if (!terrain?.geometry?.attributes?.position) return () => 0;
        terrain.updateWorldMatrix?.(true, false);
        const geometry = terrain.geometry;
        const position = geometry.attributes.position;
        const sx = geometry.parameters?.widthSegments;
        const sz = geometry.parameters?.heightSegments;
        const fallback = new T3.Vector3();
        terrain.getWorldPosition?.(fallback);
        if (!Number.isInteger(sx) || !Number.isInteger(sz) || position.count !== (sx + 1) * (sz + 1)) {
            return () => fallback.y;
        }
        const cols = sx + 1;
        const x0 = position.getX(0), x1 = position.getX(sx);
        const z0 = position.getZ(0), z1 = position.getZ(sz * cols);
        if (Math.abs(x1 - x0) < 1e-6 || Math.abs(z1 - z0) < 1e-6) return () => fallback.y;
        const world = terrain.matrixWorld.clone();
        const invWorld = world.clone().invert();
        const query = new T3.Vector3();
        const result = new T3.Vector3();
        return (worldX, worldZ) => {
            query.set(worldX, fallback.y, worldZ).applyMatrix4(invWorld);
            const uu = Math.max(0, Math.min(1, (query.x - x0) / (x1 - x0))) * sx;
            const vv = Math.max(0, Math.min(1, (query.z - z0) / (z1 - z0))) * sz;
            const ix = Math.min(sx - 1, Math.floor(uu));
            const iz = Math.min(sz - 1, Math.floor(vv));
            const fx = uu - ix, fz = vv - iz;
            const o = iz * cols + ix;
            const ya = position.getY(o) + (position.getY(o + 1) - position.getY(o)) * fx;
            const yb = position.getY(o + cols) + (position.getY(o + cols + 1) - position.getY(o + cols)) * fx;
            result.set(query.x, ya + (yb - ya) * fz, query.z).applyMatrix4(world);
            return result.y;
        };
    };

    const sampleHeight = makeHeightSampler();
    const centerX = 0, centerZ = -72;
    let padMinY = Infinity, padMaxY = -Infinity;
    for (let iz = 0; iz <= 6; iz++) for (let ix = 0; ix <= 6; ix++) {
        const height = sampleHeight(centerX - 48 + ix * 16, centerZ - 39 + iz * 13);
        padMinY = Math.min(padMinY, height);
        padMaxY = Math.max(padMaxY, height);
    }
    // The ziggurat is monumental architecture, not a flexible decal: establish
    // a level stone datum above the entire footprint, then carry a foundation
    // skirt down through the naturally eroded basin instead of burying/floating
    // different corners of the first tier.
    const rootY = padMaxY + 0.22;
    const foundationDepth = Math.max(2.5, rootY - padMinY + 1.6);
    group.position.set(centerX, rootY, centerZ);
    const localGround = (x, z) => sampleHeight(centerX + x, centerZ + z) - rootY;

    const unitBox = ownGeometry(new T3.BoxGeometry(1, 1, 1));
    const addBox = (name, size, position, material, parent = group, rotation = null) => {
        const mesh = new T3.Mesh(unitBox, material);
        mesh.name = name;
        mesh.position.set(position[0], position[1], position[2]);
        mesh.scale.set(size[0], size[1], size[2]);
        if (rotation) mesh.rotation.set(rotation[0], rotation[1], rotation[2]);
        mesh.castShadow = false;
        mesh.receiveShadow = false;
        parent.add(mesh);
        return mesh;
    };
    addBox('leveled_temple_foundation', [96, foundationDepth, 78], [0, -foundationDepth * 0.5, 0], sandstoneDark);
    addBox('foundation_capstone', [98, 0.55, 80], [0, -0.275, 0], sandstoneTrim);

    const identityQ = new T3.Quaternion();
    const makeRecord = (x, y, z, sxr, syr, szr, quaternion = identityQ, color = null) => ({
        position: new T3.Vector3(x, y, z),
        quaternion: quaternion.clone(),
        scale: new T3.Vector3(sxr, syr, szr),
        color,
    });
    const composeMatrix = new T3.Matrix4();
    const instanceColor = new T3.Color();
    const makeInstances = (name, geometry, material, records, parent = group) => {
        if (!records.length) return null;
        const mesh = new T3.InstancedMesh(geometry, material, records.length);
        mesh.name = name;
        mesh.castShadow = false;
        mesh.receiveShadow = false;
        let hasColors = false;
        records.forEach((record, index) => {
            composeMatrix.compose(record.position, record.quaternion, record.scale);
            mesh.setMatrixAt(index, composeMatrix);
            if (record.color !== null) {
                mesh.setColorAt(index, instanceColor.set(record.color));
                hasColors = true;
            }
        });
        mesh.instanceMatrix.needsUpdate = true;
        if (hasColors && mesh.instanceColor) {
            material.vertexColors = true;
            material.needsUpdate = true;
            mesh.instanceColor.needsUpdate = true;
        }
        mesh.computeBoundingBox?.();
        mesh.computeBoundingSphere?.();
        parent.add(mesh);
        instancedMeshes.push(mesh);
        return mesh;
    };

    // Main stepped ziggurat. Deep bands beneath bright cornices provide
    // baked-in contact depth without a shadow map or SSAO pass.
    const tiers = [
        { w: 88, d: 70, h: 7.0 },
        { w: 69, d: 54, h: 6.0 },
        { w: 52, d: 40, h: 5.5 },
        { w: 37, d: 28, h: 5.0 },
        { w: 24, d: 18, h: 4.0 },
    ];
    const panelRecords = [];
    const accentRecords = [];
    const buttressRecords = [];
    let topY = 0;
    tiers.forEach((tier, index) => {
        const baseY = topY;
        addBox(`ziggurat_tier_${index}`, [tier.w, tier.h, tier.d], [0, baseY + tier.h * 0.5, 0], sandstone[index % sandstone.length]);
        addBox(`tier_${index}_occlusion_band`, [tier.w + 1.0, 0.34, tier.d + 1.0], [0, baseY + tier.h - 0.56, 0], sandstoneDark);
        addBox(`tier_${index}_cornice`, [tier.w + 1.7, 0.38, tier.d + 1.7], [0, baseY + tier.h - 0.19, 0], sandstoneTrim);

        const panelW = Math.max(4.2, tier.w * 0.16);
        const panelH = Math.max(1.5, tier.h * 0.43);
        const panelY = baseY + tier.h * 0.56;
        const panelZ = tier.d * 0.5 + 0.17;
        for (const side of [-1, 1]) {
            const px = side * tier.w * 0.29;
            panelRecords.push(makeRecord(px, panelY, panelZ, panelW, panelH, 0.28));
            accentRecords.push(makeRecord(px, panelY, panelZ + 0.18, panelW * 0.68, 0.13, 0.10));
            accentRecords.push(makeRecord(px + side * panelW * 0.32, panelY, panelZ + 0.19, 0.12, panelH * 0.67, 0.10));
        }
        const buttressH = tier.h * 0.78;
        for (const side of [-1, 1]) {
            for (const zSide of [-1, 1]) {
                buttressRecords.push(makeRecord(
                    side * (tier.w * 0.5 + 0.42),
                    baseY + buttressH * 0.5,
                    zSide * tier.d * 0.31,
                    1.25, buttressH, 2.7,
                ));
            }
        }
        topY += tier.h;
    });
    makeInstances('recessed_facade_panels', unitBox, recessMaterial, panelRecords);
    makeInstances('facade_energy_accents', unitBox, cyanMaterial, accentRecords);
    makeInstances('tier_edge_buttresses', unitBox, sandstoneTrim, buttressRecords);

    // A solid triangular ramp supports thin instanced stair treads. Side
    // cheeks make the steep ceremonial stair read as monumental masonry.
    const makeWedgeGeometry = (width, height, depth, frontY = 0) => {
        const hw = width * 0.5, hd = depth * 0.5;
        const positions = new Float32Array([
            -hw, frontY, hd,   hw, frontY, hd,   hw, 0, -hd,  -hw, 0, -hd,
            -hw, height, -hd,   hw, height, -hd,
        ]);
        const indices = [
            0, 3, 2, 0, 2, 1,
            3, 4, 5, 3, 5, 2,
            0, 4, 3, 1, 2, 5,
            0, 1, 5, 0, 5, 4,
        ];
        const geometry = new T3.BufferGeometry();
        geometry.setAttribute('position', new T3.BufferAttribute(positions, 3));
        geometry.setIndex(indices);
        geometry.computeVertexNormals();
        geometry.computeBoundingBox();
        geometry.computeBoundingSphere();
        return ownGeometry(geometry);
    };
    const stairFront = 44, stairBack = 9;
    const stairDepth = stairFront - stairBack;
    const rampFrontY = localGround(0, stairFront) - 0.18;
    const wedgeGeometry = makeWedgeGeometry(14, topY, stairDepth, rampFrontY);
    const ramp = new T3.Mesh(wedgeGeometry, sandstoneDark);
    ramp.name = 'processional_ramp_core';
    ramp.position.set(0, 0, (stairFront + stairBack) * 0.5);
    group.add(ramp);
    for (const side of [-1, 1]) {
        const cheek = new T3.Mesh(wedgeGeometry, sandstoneTrim);
        cheek.name = 'processional_ramp_cheek';
        cheek.position.set(side * 7.55, 0, (stairFront + stairBack) * 0.5);
        cheek.scale.x = 0.12;
        group.add(cheek);
    }
    const stepCount = 25;
    const stairRecords = [];
    for (let i = 0; i < stepCount; i++) {
        const rise = (topY - rampFrontY) / stepCount;
        const tread = stairDepth / stepCount;
        const shade = i % 4 === 0 ? 0xc69261 : (i % 2 ? 0xb67c4e : 0xa96f47);
        stairRecords.push(makeRecord(0, rampFrontY + (i + 0.5) * rise, stairFront - (i + 0.5) * tread, 13.2, rise * 1.03, tread * 1.12, identityQ, shade));
    }
    const stairMaterial = standard({ color: 0xffffff, roughness: 0.86, metalness: 0 });
    makeInstances('processional_stair_treads', unitBox, stairMaterial, stairRecords);

    // Summit plinth and proxy for the Inanna star sphere. The eight radial
    // points preserve the icon's silhouette while the nested sphere/rings
    // sell it as an active piece of technology.
    const lowerPlinthGeometry = ownGeometry(new T3.CylinderGeometry(8.5, 9.4, 2.4, 12));
    const upperPlinthGeometry = ownGeometry(new T3.CylinderGeometry(6.1, 7.0, 1.2, 12));
    const lowerPlinth = new T3.Mesh(lowerPlinthGeometry, sandstoneTrim);
    lowerPlinth.position.y = topY + 1.2;
    lowerPlinth.name = 'summit_plinth_lower';
    group.add(lowerPlinth);
    const upperPlinth = new T3.Mesh(upperPlinthGeometry, darkMetal);
    upperPlinth.position.y = topY + 3.0;
    upperPlinth.name = 'summit_plinth_upper';
    group.add(upperPlinth);

    const starPivot = new T3.Group();
    const starBaseY = topY + 8.2;
    starPivot.position.y = starBaseY;
    starPivot.name = 'inanna_star_sphere';
    group.add(starPivot);
    const orbGeometry = ownGeometry(new T3.IcosahedronGeometry(3.15, 2));
    let innerOrb;
    if (inannaModel) {
        // Preserve the authored CC0 model and its embedded PBR/emissive maps,
        // but normalize its pivot and diameter so animation is deterministic.
        innerOrb = new T3.Group();
        innerOrb.name = 'inanna_authored_orb';
        innerOrb.add(inannaModel);
        const bounds = new T3.Box3().setFromObject(inannaModel);
        const center = bounds.getCenter(new T3.Vector3());
        const size = bounds.getSize(new T3.Vector3());
        inannaModel.position.sub(center);
        innerOrb.scale.setScalar(5.8 / Math.max(size.x, size.y, size.z, 0.001));
        inannaModel.traverse((object) => {
            if (!object.isMesh) return;
            object.castShadow = false;
            object.receiveShadow = false;
            object.userData.noWet = true;
            if (object.geometry) ownedGeometries.add(object.geometry);
            const materials = Array.isArray(object.material) ? object.material : [object.material];
            for (const material of materials) {
                if (!material) continue;
                ownedMaterials.add(material);
                for (const value of Object.values(material)) if (value?.isTexture) ownedModelTextures.add(value);
            }
        });
    } else {
        innerOrb = new T3.Mesh(orbGeometry, orbMaterial);
        innerOrb.scale.setScalar(0.88);
    }
    starPivot.add(innerOrb);
    const wireOrb = new T3.Mesh(orbGeometry, wireMaterial);
    wireOrb.scale.setScalar(1.08);
    wireOrb.visible = !inannaModel;
    starPivot.add(wireOrb);
    const torusGeometry = ownGeometry(new T3.TorusGeometry(4.1, 0.16, 7, 40));
    const ringA = new T3.Mesh(torusGeometry, goldMetal);
    ringA.rotation.x = Math.PI * 0.5;
    starPivot.add(ringA);
    const ringB = new T3.Mesh(torusGeometry, darkMetal);
    ringB.rotation.set(Math.PI * 0.28, Math.PI * 0.22, Math.PI * 0.5);
    ringB.scale.setScalar(1.14);
    starPivot.add(ringB);
    const spikeGeometry = ownGeometry(new T3.ConeGeometry(0.62, 3.0, 5));
    const spikeRecords = [];
    const yAxis = new T3.Vector3(0, 1, 0);
    for (let i = 0; i < 8; i++) {
        const angle = i * Math.PI / 4;
        const direction = new T3.Vector3(Math.cos(angle), Math.sin(angle), 0);
        const q = new T3.Quaternion().setFromUnitVectors(yAxis, direction);
        spikeRecords.push(makeRecord(direction.x * 4.35, direction.y * 4.35, 0, 1, 1, 1, q));
    }
    makeInstances('inanna_eight_points', spikeGeometry, amberMaterial, spikeRecords, starPivot);

    // Broken perimeter wall: a small number of instanced masonry blocks with
    // inset dark panels and live strips. Deterministic gaps keep the compound
    // authored-looking and make sightlines through to the ziggurat.
    let randomState = 0x6e624eb7;
    const random = () => {
        randomState += 0x6d2b79f5;
        let v = randomState;
        v = Math.imul(v ^ (v >>> 15), v | 1);
        v ^= v + Math.imul(v ^ (v >>> 7), v | 61);
        return ((v ^ (v >>> 14)) >>> 0) / 4294967296;
    };
    const wallRecords = [];
    const wallPanelRecords = [];
    const wallStripRecords = [];
    const xAxis = new T3.Vector3(1, 0, 0);
    const addWallRun = (x0r, z0r, x1r, z1r, inwardX, inwardZ, breakChance) => {
        const dx = x1r - x0r, dz = z1r - z0r;
        const total = Math.hypot(dx, dz);
        const direction = new T3.Vector3(dx / total, 0, dz / total);
        const q = new T3.Quaternion().setFromUnitVectors(xAxis, direction);
        let cursor = 0;
        while (cursor < total - 0.4) {
            const desired = 7.5 + random() * 5.8;
            const segmentLength = Math.min(desired, total - cursor);
            const gap = 0.65 + random() * 1.55;
            if (cursor > 2 && cursor + segmentLength < total - 2 && random() < breakChance) {
                cursor += segmentLength + gap * 1.5;
                continue;
            }
            const middle = cursor + segmentLength * 0.5;
            const x = x0r + direction.x * middle;
            const z = z0r + direction.z * middle;
            const ground = localGround(x, z) - 0.35;
            const height = 6.8 + random() * 5.0;
            const color = random() < 0.33 ? 0x8b593a : (random() < 0.55 ? 0xa56d46 : 0x75482f);
            wallRecords.push(makeRecord(x, ground + height * 0.5, z, segmentLength, height, 3.1, q, color));
            if (random() > 0.22) {
                const panelX = x + inwardX * 1.67;
                const panelZ = z + inwardZ * 1.67;
                wallPanelRecords.push(makeRecord(panelX, ground + height * 0.54, panelZ, segmentLength * 0.62, height * 0.39, 0.24, q));
                wallStripRecords.push(makeRecord(panelX + inwardX * 0.14, ground + height * 0.57, panelZ + inwardZ * 0.14, segmentLength * 0.37, 0.15, 0.10, q));
            }
            cursor += segmentLength + gap;
        }
    };
    addWallRun(-72, 68, -18, 68, 0, -1, 0.04);
    addWallRun(18, 68, 72, 68, 0, -1, 0.04);
    addWallRun(-72, -62, 72, -62, 0, 1, 0.13);
    addWallRun(-72, -62, -72, 68, 1, 0, 0.10);
    addWallRun(72, 68, 72, -62, -1, 0, 0.10);
    const wallMaterial = standard({ color: 0xffffff, roughness: 0.93, metalness: 0 });
    makeInstances('broken_perimeter_walls', unitBox, wallMaterial, wallRecords);
    makeInstances('perimeter_recess_panels', unitBox, recessMaterial, wallPanelRecords);
    makeInstances('perimeter_energy_strips', unitBox, cyanMaterial, wallStripRecords);

    // Monumental gate aligned with the processional axis.
    const gateZ = 68;
    const gateGround = localGround(0, gateZ) - 0.25;
    for (const side of [-1, 1]) {
        addBox('gate_pylon', [5.4, 17, 6.2], [side * 15, gateGround + 8.5, gateZ], sandstoneTrim);
        addBox('gate_pylon_recess', [2.6, 10.8, 0.35], [side * 15, gateGround + 8.4, gateZ + 3.22], recessMaterial);
        addBox('gate_pylon_light', [0.24, 8.5, 0.12], [side * 15, gateGround + 8.4, gateZ + 3.43], amberMaterial);
    }
    addBox('gate_lintel', [25.5, 3.0, 5.2], [0, gateGround + 16.0, gateZ], sandstoneDark);
    addBox('gate_lintel_trim', [27.2, 0.45, 5.7], [0, gateGround + 17.3, gateZ], goldMetal);
    const emblemBackingGeometry = ownGeometry(new T3.CircleGeometry(3.2, 20));
    const emblemBacking = new T3.Mesh(emblemBackingGeometry, recessMaterial);
    emblemBacking.position.set(0, gateGround + 16.0, gateZ + 2.67);
    group.add(emblemBacking);
    const starShape = new T3.Shape();
    for (let i = 0; i < 16; i++) {
        const radius = i % 2 === 0 ? 2.65 : 1.05;
        const angle = Math.PI * 0.5 + i * Math.PI / 8;
        const x = Math.cos(angle) * radius, y = Math.sin(angle) * radius;
        if (i === 0) starShape.moveTo(x, y); else starShape.lineTo(x, y);
    }
    starShape.closePath();
    const emblemGeometry = ownGeometry(new T3.ShapeGeometry(starShape));
    const gateEmblem = new T3.Mesh(emblemGeometry, amberMaterial);
    gateEmblem.position.set(0, gateGround + 16.0, gateZ + 2.73);
    group.add(gateEmblem);

    // Broken sandstone causeway from the gate to the ceremonial stair.
    const pathRecords = [];
    for (let i = 0; i < 6; i++) {
        const z = 62 - i * 3.35;
        const ground = localGround(0, z);
        const yaw = (random() - 0.5) * 0.018;
        const q = new T3.Quaternion().setFromAxisAngle(yAxis, yaw);
        pathRecords.push(makeRecord(0, ground + 0.02, z, 13.5, 0.34, 2.95, q, i % 2 ? 0xb77f52 : 0x9c6744));
    }
    makeInstances('processional_causeway', unitBox, stairMaterial, pathRecords);

    // Deterministic low-poly rocks and shrubs supplement the authored
    // SeedThree cacti/trees without adding per-prop draw calls.
    const rockGeometry = ownGeometry(new T3.DodecahedronGeometry(1, 0));
    const rockRecords = [];
    const shrubGeometry = ownGeometry(new T3.IcosahedronGeometry(1, 1));
    const shrubRecords = [];
    const randomEuler = new T3.Euler();
    for (let tries = 0; tries < 500 && rockRecords.length < 72; tries++) {
        const x = (random() * 2 - 1) * 91;
        const z = (random() * 2 - 1) * 78;
        if (Math.abs(x) < 50 && Math.abs(z) < 43) continue;
        if (Math.abs(x) < 15 && z > 34) continue;
        const scale = 0.65 + Math.pow(random(), 2) * 2.8;
        randomEuler.set(random() * Math.PI, random() * Math.PI * 2, random() * Math.PI * 0.35);
        const q = new T3.Quaternion().setFromEuler(randomEuler);
        const sy = scale * (0.55 + random() * 0.65);
        const color = random() < 0.45 ? 0x7b5036 : (random() < 0.6 ? 0xa66f48 : 0x684331);
        rockRecords.push(makeRecord(x, localGround(x, z) + sy * 0.68, z, scale * (0.75 + random() * 0.7), sy, scale, q, color));
    }
    for (let tries = 0; tries < 400 && shrubRecords.length < 46; tries++) {
        const x = (random() * 2 - 1) * 88;
        const z = (random() * 2 - 1) * 75;
        if (Math.abs(x) < 47 && Math.abs(z) < 40) continue;
        if (Math.abs(x) < 14 && z > 32) continue;
        const scale = 0.55 + random() * 1.15;
        randomEuler.set(0, random() * Math.PI * 2, 0);
        const q = new T3.Quaternion().setFromEuler(randomEuler);
        const color = random() < 0.5 ? 0x53613e : 0x6e7143;
        shrubRecords.push(makeRecord(x, localGround(x, z) + scale * 0.52, z, scale * 1.35, scale * 0.72, scale, q, color));
    }
    makeInstances('desert_rock_placeholders', rockGeometry, rockMaterial, rockRecords);
    makeInstances('desert_shrub_placeholders', shrubGeometry, shrubMaterial, shrubRecords);

    // Visual defaults: no scene shadow map is required by any temple object.
    group.traverse((object) => {
        if (!object.isMesh) return;
        object.castShadow = false;
        object.receiveShadow = false;
        const materials = Array.isArray(object.material) ? object.material : [object.material];
        if (materials.some((material) => material === cyanMaterial || material === amberMaterial
            || material === orbMaterial || material === wireMaterial)) {
            object.userData.noWet = true;
        }
    });

    const cyanBase = new T3.Color(0x45e4d0);
    const amberBase = new T3.Color(0xffb34a);
    const setQuality = (quality = 'balanced') => {
        for (const surface of stoneSurfaces) {
            const roughnessNode = quality === 'performance' ? null : surface.roughnessNode;
            const normalNode = quality === 'cinematic' ? surface.normalNode : null;
            const changed = surface.material.colorNode !== surface.colorNode
                || surface.material.roughnessNode !== roughnessNode
                || surface.material.normalNode !== normalNode;
            surface.material.colorNode = surface.colorNode;
            surface.material.roughnessNode = roughnessNode;
            surface.material.normalNode = normalNode;
            if (changed) surface.material.needsUpdate = true;
        }
        group.userData.quality = quality;
    };
    return {
        group,
        setQuality,
        update(t = 0) {
            if (disposed) return;
            starPivot.position.y = starBaseY + Math.sin(t * 0.72) * 0.24;
            starPivot.rotation.y = Math.sin(t * 0.23) * 0.16;
            starPivot.rotation.z = t * 0.18;
            innerOrb.rotation.set(t * 0.21, t * 0.34, t * 0.13);
            wireOrb.rotation.set(-t * 0.17, t * 0.26, -t * 0.11);
            ringA.rotation.set(Math.PI * 0.5, t * 0.12, t * 0.08);
            ringB.rotation.set(Math.PI * 0.28 + Math.sin(t * 0.19) * 0.12, t * 0.20, Math.PI * 0.5);
            const pulse = 0.86 + Math.sin(t * 2.1) * 0.14;
            cyanMaterial.color.copy(cyanBase).multiplyScalar(pulse);
            amberMaterial.color.copy(amberBase).multiplyScalar(0.92 + Math.sin(t * 1.45 + 0.8) * 0.08);
        },
        dispose() {
            if (disposed) return;
            disposed = true;
            for (const mesh of instancedMeshes) mesh.dispose?.();
            group.removeFromParent?.();
            group.clear();
            for (const geometry of ownedGeometries) geometry.dispose();
            for (const material of ownedMaterials) material.dispose();
            for (const texture of ownedModelTextures) texture.dispose();
            ownedGeometries.clear();
            ownedMaterials.clear();
            ownedModelTextures.clear();
            instancedMeshes.length = 0;
        },
    };
}
