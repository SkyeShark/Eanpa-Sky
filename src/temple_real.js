// Asset-backed Temple of Inanna compound.
//
// The ziggurat is a small set of custom rectilinear terraced masonry masses,
// while every perimeter element is an authored Eidoverse GLB used at its
// original scale.  Imported wall assets are normalized because the source
// GLBs retain their Blender scene offsets.

export async function makeTempleScene(THREE, {
    terrain = null,
    sandstoneTextures = null,
    mineralTextures = null,
    fixtureMetalTextures = null,
    fastenerDecalTexture = null,
    inannaModel = null,
    perimeterModels = null,
    zigguratModel = null,
} = {}) {
    const T3 = THREE;
    const StandardMaterial = T3.MeshStandardNodeMaterial ?? T3.MeshStandardMaterial;
    const PhysicalMaterial = T3.MeshPhysicalNodeMaterial ?? T3.MeshPhysicalMaterial ?? StandardMaterial;
    const BasicMaterial = T3.MeshBasicNodeMaterial ?? T3.MeshBasicMaterial;
    const ownedGeometries = new Set();
    const ownedMaterials = new Set();
    const ownedModelTextures = new Set();
    const discardedMaterials = new Set();
    const discardedTextures = new Set();
    const prototypes = [];
    let disposed = false;

    const unwrapModel = (value) => value?.scene ?? value ?? null;
    const lookupModel = (...keys) => {
        for (const key of keys) {
            const model = unwrapModel(perimeterModels?.[key]);
            if (model?.isObject3D) return model;
        }
        return null;
    };
    const sources = {
        gate: lookupModel('gate', 'wallGate'),
        wall: lookupModel('wall', 'middle', 'wallMiddle'),
        pillar: lookupModel('pillar', 'wallPillar'),
        watchtower: lookupModel('watchtower', 'tower'),
    };
    const orbSource = unwrapModel(inannaModel);
    const authoredZigguratSource = unwrapModel(zigguratModel);
    const useAuthoredZiggurat = Boolean(authoredZigguratSource?.isObject3D);
    const missing = Object.entries(sources).filter(([, value]) => !value).map(([key]) => key);
    if (missing.length) throw new Error(`makeTempleScene requires perimeterModels: ${missing.join(', ')}`);
    if (!orbSource?.isObject3D) throw new Error('makeTempleScene requires the authored Inanna orb model');

    const group = new T3.Group();
    group.name = 'eanpa_real_temple_compound';
    group.userData.noCloudShadow = false;

    const textureValues = (material) => Object.values(material ?? {}).filter((value) => value?.isTexture);
    const retainMaterial = (material) => {
        if (!material) return;
        ownedMaterials.add(material);
        for (const texture of textureValues(material)) ownedModelTextures.add(texture);
    };
    const discardMaterial = (material, keepTextures = new Set()) => {
        if (!material || discardedMaterials.has(material)) return;
        discardedMaterials.add(material);
        for (const texture of textureValues(material)) {
            if (keepTextures.has(texture) || discardedTextures.has(texture)) continue;
            discardedTextures.add(texture);
            texture.dispose?.();
        }
        material.dispose?.();
    };

    const sampleHeight = (x, z) => {
        const sampled = terrain?.heightAt?.(x, z);
        if (Number.isFinite(sampled)) return sampled;
        return Number.isFinite(terrain?.position?.y) ? terrain.position.y : 0;
    };

    // Establish one level datum above the complete ziggurat footprint.  Only
    // the first foundation block extends downward through terrain variation;
    // there is no giant rectangular foundation slab.
    const centerX = 0;
    const centerZ = -72;
    let footprintMin = Infinity;
    let footprintMax = -Infinity;
    for (let iz = 0; iz <= 8; iz++) {
        for (let ix = 0; ix <= 8; ix++) {
            const x = centerX - 35 + ix * (70 / 8);
            const z = centerZ - 34 + iz * (72.4 / 8);
            const height = sampleHeight(x, z);
            footprintMin = Math.min(footprintMin, height);
            footprintMax = Math.max(footprintMax, height);
        }
    }
    if (!Number.isFinite(footprintMin)) footprintMin = 0;
    if (!Number.isFinite(footprintMax)) footprintMax = footprintMin;
    const datumY = footprintMax + 0.08;
    const foundationBottom = Math.min(-1.2, footprintMin - datumY - 0.75);
    group.position.set(centerX, datumY, centerZ);
    const localGround = (x, z) => sampleHeight(centerX + x, centerZ + z) - datumY;

    const maps = {
        albedo: sandstoneTextures?.albedo ?? sandstoneTextures?.color ?? sandstoneTextures?.diffuse ?? null,
        normal: sandstoneTextures?.normal ?? sandstoneTextures?.normalGL ?? null,
        roughness: sandstoneTextures?.roughness ?? sandstoneTextures?.rough ?? null,
        ao: sandstoneTextures?.ao ?? sandstoneTextures?.ambientOcclusion ?? null,
        displacement: sandstoneTextures?.displacement ?? sandstoneTextures?.disp ?? null,
    };
    for (const texture of Object.values(maps)) {
        if (!texture?.isTexture) continue;
        texture.wrapS = texture.wrapT = T3.RepeatWrapping;
        texture.needsUpdate = true;
    }

    const makeStoneMaterial = (name, tint) => {
        const material = new StandardMaterial({ color: 0xffffff, roughness: 0.92, metalness: 0 });
        material.name = name;
        material.envMapIntensity = 0.42;
        ownedMaterials.add(material);

        const nodeCapable = maps.albedo && maps.normal && maps.roughness
            && T3.texture && T3.positionWorld && T3.normalWorld && T3.cameraViewMatrix;
        if (!nodeCapable) {
            material.map = maps.albedo;
            material.normalMap = maps.normal;
            material.roughnessMap = maps.roughness;
            material.aoMap = maps.ao;
            return material;
        }

        const { positionWorld, normalWorld, cameraViewMatrix } = T3;
        const scale = 0.22;
        const absNormal = T3.abs(normalWorld);
        const weightPower = absNormal.mul(absNormal).mul(absNormal);
        const weights = weightPower.div(weightPower.x.add(weightPower.y).add(weightPower.z));
        const tri = (texture) => T3.texture(texture, positionWorld.zy.mul(scale)).mul(weights.x)
            .add(T3.texture(texture, positionWorld.xz.mul(scale)).mul(weights.y))
            .add(T3.texture(texture, positionWorld.xy.mul(scale)).mul(weights.z));

        let colorNode = tri(maps.albedo).rgb.mul(T3.vec3(...tint));
        if (maps.ao) colorNode = colorNode.mul(tri(maps.ao).r.mul(0.28).add(0.72));
        material.colorNode = colorNode;
        material.roughnessNode = tri(maps.roughness).r.mul(0.46).add(0.52).clamp(0.5, 1);

        // Decode each triplanar normal sample in its own projection frame,
        // then blend in world space.  Blending raw normal RGB causes seams and
        // was one of the old temple's most visible material defects.
        const nX = T3.texture(maps.normal, positionWorld.zy.mul(scale)).rgb.mul(2).sub(1);
        const nY = T3.texture(maps.normal, positionWorld.xz.mul(scale)).rgb.mul(2).sub(1);
        const nZ = T3.texture(maps.normal, positionWorld.xy.mul(scale)).rgb.mul(2).sub(1);
        const axisSign = T3.sign(normalWorld);
        const worldX = T3.vec3(nX.z.mul(axisSign.x), nX.y.mul(axisSign.x).mul(-1), nX.x);
        const worldY = T3.vec3(nY.x, nY.z.mul(axisSign.y), nY.y.mul(axisSign.y).mul(-1));
        const worldZ = T3.vec3(nZ.x, nZ.y.mul(axisSign.z), nZ.z.mul(axisSign.z));
        const mappedWorld = T3.normalize(worldX.mul(weights.x).add(worldY.mul(weights.y)).add(worldZ.mul(weights.z)));
        material.normalNode = T3.normalize(cameraViewMatrix.transformDirection(T3.mix(normalWorld, mappedWorld, 0.58)));
        return material;
    };

    const sandstone = makeStoneMaterial('PolyHaven_sandstone_blocks_05', [0.94, 0.88, 0.78]);
    const userRailSandstone = makeStoneMaterial(
        'PolyHaven_sandstone_blocks_05_double_sided_user_rails', [0.94, 0.88, 0.78],
    );
    userRailSandstone.side = T3.DoubleSide;
    const sandstonePlinth = makeStoneMaterial('PolyHaven_sandstone_blocks_05_plinth', [0.72, 0.68, 0.62]);

    const prepareMineralMaps = (source = {}) => {
        const prepared = {
            albedo: source.albedo ?? source.color ?? source.diffuse ?? null,
            normal: source.normal ?? source.normalGL ?? null,
            roughness: source.roughness ?? source.rough ?? null,
            height: source.height ?? source.displacement ?? source.disp ?? null,
            ao: source.ao ?? source.ambientOcclusion ?? null,
        };
        for (const texture of Object.values(prepared)) {
            if (!texture?.isTexture) continue;
            texture.wrapS = texture.wrapT = T3.RepeatWrapping;
            texture.anisotropy = Math.max(texture.anisotropy || 1, 8);
            texture.needsUpdate = true;
        }
        const sources = [prepared.albedo, prepared.normal, prepared.roughness, prepared.ao ?? prepared.height];
        if (T3.DataTexture && sources.every((texture) => texture?.image?.data)) {
            const width = sources[0].image.width;
            const height = sources[0].image.height;
            const layerBytes = width * height * 4;
            if (sources.every((texture) => texture.image.width === width
                && texture.image.height === height && texture.image.data.length === layerBytes)) {
                const colorRoughnessData = new Uint8Array(layerBytes);
                const normalCavityData = new Uint8Array(layerBytes);
                for (let offset = 0; offset < layerBytes; offset += 4) {
                    colorRoughnessData[offset] = sources[0].image.data[offset];
                    colorRoughnessData[offset + 1] = sources[0].image.data[offset + 1];
                    colorRoughnessData[offset + 2] = sources[0].image.data[offset + 2];
                    colorRoughnessData[offset + 3] = sources[2].image.data[offset];
                    normalCavityData[offset] = sources[1].image.data[offset];
                    normalCavityData[offset + 1] = sources[1].image.data[offset + 1];
                    normalCavityData[offset + 2] = sources[1].image.data[offset + 2];
                    normalCavityData[offset + 3] = sources[3].image.data[offset];
                }
                const makePackedTexture = (data, name, colorSpace) => {
                    const texture = new T3.DataTexture(data, width, height, T3.RGBAFormat);
                    texture.name = name;
                    texture.wrapS = texture.wrapT = T3.RepeatWrapping;
                    texture.minFilter = T3.LinearMipmapLinearFilter;
                    texture.magFilter = T3.LinearFilter;
                    texture.generateMipmaps = true;
                    texture.anisotropy = 8;
                    texture.colorSpace = colorSpace;
                    texture.needsUpdate = true;
                    ownedModelTextures.add(texture);
                    return texture;
                };
                prepared.colorRoughness = makePackedTexture(
                    colorRoughnessData, 'mineral_baseColor_RGB_roughness_A', T3.SRGBColorSpace,
                );
                prepared.normalCavity = makePackedTexture(
                    normalCavityData, 'mineral_normalGL_RGB_cavity_A', T3.NoColorSpace,
                );
            }
        }
        return prepared;
    };
    const mineralMaps = {
        lapis: prepareMineralMaps(mineralTextures?.lapis),
        carnelian: prepareMineralMaps(mineralTextures?.carnelian),
    };

    const makeGemMaterial = (name, baseHex, veinHex, roughness, clearcoat, textures) => {
        const hasPbrSet = Boolean(textures?.colorRoughness && textures?.normalCavity);
        const material = hasPbrSet
            ? new StandardMaterial({ color: 0xffffff, metalness: 0.02, roughness })
            : new PhysicalMaterial({
                color: baseHex,
                metalness: 0.02,
                roughness,
                clearcoat,
                clearcoatRoughness: Math.min(0.48, roughness + 0.08),
                ior: 1.5,
            });
        material.name = name;
        material.envMapIntensity = 0.82;
        ownedMaterials.add(material);

        if (hasPbrSet) {
            // These small masonry inlays use direct/hemisphere lighting and
            // the scene's SSR/AO composite. Opting this material out of the
            // separate PMREM environment binding leaves room for both packed
            // PBR textures on WebGPU's fixed 16-sampler hardware ceiling.
            material.envNode = T3.vec3(0);
            // The Harness maps describe a much smaller dressed-stone module
            // than one full authored inlay segment. Repeat them at consistent
            // masonry density instead of stretching one 2K scan per block.
            const mineralUvScale = 3.25;
            const uvNode = T3.fract(T3.uv().mul(mineralUvScale));
            const colorRoughness = T3.texture(textures.colorRoughness, uvNode).toVar();
            const normalCavity = T3.texture(textures.normalCavity, uvNode).toVar();
            const albedoSample = colorRoughness.rgb;
            const normalSample = normalCavity.rgb;
            const roughnessSample = colorRoughness.a;
            const cavitySample = normalCavity.a;

            // Two packed samplers carry base-color+roughness and
            // normal+cavity. The standard PBR model plus these two bindings
            // stays within WebGPU's immutable 16-sampler hardware limit.
            // Full displacement is intentionally avoided: these thin inlays
            // are not subdivided and must remain seated in their masonry beds.
            // Feed the height-derived cavity signal into the material's real
            // indirect-light AO term. Multiplying it into base color would
            // permanently stain direct light and reflections instead of
            // behaving like ambient occlusion.
            const cavityAo = cavitySample.mul(0.14).add(0.86).clamp(0, 1);
            material.colorNode = albedoSample;
            material.normalNode = T3.normalMap(normalSample, T3.vec2(0.62, 0.62));
            material.roughnessNode = roughnessSample.mul(0.78).add(0.14).clamp(0.16, 0.94);
            material.metalnessNode = T3.float(0.02);
            material.aoNode = cavityAo;
            material.userData.pbrSource = 'new_twitter_harness/city_builder_assets/sumerian';
            material.userData.uvRepeat = mineralUvScale;
            material.userData.maps = {
                baseColor: true,
                normalGL: true,
                roughness: true,
                height: Boolean(textures.height),
                ao: Boolean(textures.ao),
                effectiveAo: Boolean(textures.ao || textures.height),
                cavityFromHeight: !textures.ao && Boolean(textures.height),
                metalnessMap: false,
                metalnessScalar: 0.02,
            };
            return material;
        }

        // Polished mineral variation is evaluated in world space, so every
        // instanced tile has a unique vein pattern without extra textures.
        if (T3.positionWorld && T3.sin && T3.smoothstep && T3.mix && T3.vec3) {
            const base = new T3.Color(baseHex);
            const vein = new T3.Color(veinHex);
            const p = T3.positionWorld;
            const mineralBand = T3.sin(
                p.x.mul(4.7)
                    .add(p.z.mul(3.1))
                    .add(T3.sin(p.y.mul(11.3)).mul(1.35)),
            ).mul(0.5).add(0.5);
            const veinMask = T3.smoothstep(0.84, 0.97, mineralBand);
            material.colorNode = T3.mix(
                T3.vec3(base.r, base.g, base.b),
                T3.vec3(vein.r, vein.g, vein.b),
                veinMask.mul(0.34),
            );
            material.roughnessNode = T3.float(roughness)
                .add(mineralBand.mul(0.055)).clamp(0.18, 0.62);
        }
        return material;
    };

    const lapis = makeGemMaterial(
        'Harness_lapis_lazuli_tile_PBR', 0x123d83, 0x5c82b8, 0.32, 0.46,
        mineralMaps.lapis,
    );
    const carnelian = makeGemMaterial(
        'Harness_carnelian_tile_PBR', 0x9c2f16, 0xf08a3c, 0.28, 0.58,
        mineralMaps.carnelian,
    );
    const fixtureMetalMaps = {
        albedo: fixtureMetalTextures?.albedo ?? fixtureMetalTextures?.color ?? null,
        normal: fixtureMetalTextures?.normal ?? fixtureMetalTextures?.normalGL ?? null,
        roughness: fixtureMetalTextures?.roughness ?? fixtureMetalTextures?.rough ?? null,
        metalness: fixtureMetalTextures?.metalness ?? fixtureMetalTextures?.metal ?? null,
    };
    for (const texture of Object.values(fixtureMetalMaps)) {
        if (!texture?.isTexture) continue;
        texture.wrapS = texture.wrapT = T3.RepeatWrapping;
        texture.anisotropy = Math.max(texture.anisotropy || 1, 8);
        texture.needsUpdate = true;
    }

    const makeMappedMetal = (name, settings) => {
        const material = new PhysicalMaterial({
            color: settings.color,
            metalness: settings.metalness,
            roughness: settings.roughness,
            clearcoat: settings.clearcoat,
            clearcoatRoughness: settings.clearcoatRoughness,
        });
        material.name = name;
        material.envMapIntensity = settings.envMapIntensity;
        material.userData.metalCalibration = settings.calibration;
        ownedMaterials.add(material);
        return material;
    };
    // Native PMREM and Three SSR both consume these same resolved material
    // registers. Keep the authored Metal010 maps as the single source of
    // variation, but avoid compressing them into nearly diffuse ranges where
    // cloud structure disappears from dark architectural receivers.
    const fixtureMetal = makeMappedMetal('ambientCG_Metal010_dark_panel_metal', {
        color: 0x24313a, metalness: 0.72, roughness: 0.66,
        clearcoat: 0.015, clearcoatRoughness: 0.62, envMapIntensity: 0.78,
        calibration: {
            tint: [0.34, 0.40, 0.45], roughScale: 0.26, roughBias: 0.52,
            roughRange: [0.52, 0.78], metalScale: 0.23, metalBias: 0.55,
            metalRange: [0.55, 0.78], normalMix: 0.56,
        },
    });
    const railMetal = makeMappedMetal('ambientCG_Metal010_satin_rail_metal', {
        color: 0x343a3d, metalness: 0.68, roughness: 0.56,
        clearcoat: 0.012, clearcoatRoughness: 0.62, envMapIntensity: 0.80,
        calibration: {
            tint: [0.46, 0.48, 0.49], roughScale: 0.23, roughBias: 0.45,
            roughRange: [0.45, 0.68], metalScale: 0.20, metalBias: 0.55,
            metalRange: [0.55, 0.75], normalMix: 0.48,
        },
    });
    const daisMetal = makeMappedMetal('ambientCG_Metal010_burnished_dais_metal', {
        color: 0x202b34, metalness: 0.74, roughness: 0.43,
        clearcoat: 0.025, clearcoatRoughness: 0.52, envMapIntensity: 0.84,
        calibration: {
            tint: [0.30, 0.35, 0.40], roughScale: 0.22, roughBias: 0.32,
            roughRange: [0.32, 0.54], metalScale: 0.22, metalBias: 0.58,
            metalRange: [0.58, 0.80], normalMix: 0.61,
        },
    });
    const mappedFixtureMetals = [fixtureMetal, railMetal, daisMetal];
    const fastenerMetal = new PhysicalMaterial({
        color: 0xffffff,
        map: fastenerDecalTexture?.isTexture ? fastenerDecalTexture : null,
        normalMap: fixtureMetalMaps.normal?.isTexture ? fixtureMetalMaps.normal : null,
        normalScale: new T3.Vector2(0.34, 0.34),
        metalness: 0.78,
        roughness: 0.40,
        clearcoat: 0.03,
        clearcoatRoughness: 0.54,
        transparent: Boolean(fastenerDecalTexture?.isTexture),
        alphaTest: 0.10,
        depthWrite: true,
    });
    fastenerMetal.name = 'generated_recessed_fastener_decal';
    fastenerMetal.envMapIntensity = 0.82;
    fastenerMetal.alphaToCoverage = true;
    fastenerMetal.polygonOffset = true;
    fastenerMetal.polygonOffsetFactor = -1;
    fastenerMetal.polygonOffsetUnits = -1;
    fastenerMetal.userData.pbrSource = 'ImageGen recessed fastener RGBA decal v1 + ambientCG Metal010 NormalGL (CC0)';
    fastenerMetal.userData.pbrMaps = {
        baseColorAlpha: Boolean(fastenerDecalTexture?.isTexture),
        normalGL: Boolean(fixtureMetalMaps.normal?.isTexture),
        roughness: 'calibrated-scalar-0.40',
        metalness: 'calibrated-scalar-0.78',
        projection: 'authored-decal-uv',
    };
    ownedMaterials.add(fastenerMetal);
    const applyFixtureMetalPbr = () => {
        const { albedo, normal, roughness, metalness } = fixtureMetalMaps;
        if (!albedo || !normal || !roughness || !metalness) return false;

        for (const material of mappedFixtureMetals) material.color.set(0xffffff);

        const nodeCapable = T3.texture && T3.positionWorld && T3.normalWorld
            && T3.cameraViewMatrix && T3.abs && T3.sign;
        if (nodeCapable) {
            // Metal010 is a dedicated CC0 brushed steel surface, not the
            // perimeter wall/greeble albedo. World triplanar sampling keeps
            // its real-metre density consistent across custom panels, rails,
            // and the curved dais reveal without requiring shared authored UVs.
            const scale = 0.62;
            const absNormal = T3.abs(T3.normalWorld);
            const weightPower = absNormal.mul(absNormal).mul(absNormal);
            const weights = weightPower.div(
                weightPower.x.add(weightPower.y).add(weightPower.z).max(1e-5),
            );
            const tri = (texture) => T3.texture(texture, T3.positionWorld.zy.mul(scale)).mul(weights.x)
                .add(T3.texture(texture, T3.positionWorld.xz.mul(scale)).mul(weights.y))
                .add(T3.texture(texture, T3.positionWorld.xy.mul(scale)).mul(weights.z));
            const baseSample = tri(albedo).rgb;
            // These are separate grayscale maps. The prior implementation
            // sampled the roughness texture for both channels and never read
            // the loaded metalness map, causing the max-metal mirror response.
            const roughSample = tri(roughness).r;
            const metalSample = tri(metalness).r;

            const nX = T3.texture(normal, T3.positionWorld.zy.mul(scale)).rgb.mul(2).sub(1);
            const nY = T3.texture(normal, T3.positionWorld.xz.mul(scale)).rgb.mul(2).sub(1);
            const nZ = T3.texture(normal, T3.positionWorld.xy.mul(scale)).rgb.mul(2).sub(1);
            const axisSign = T3.sign(T3.normalWorld);
            const worldX = T3.vec3(nX.z.mul(axisSign.x), nX.y.mul(axisSign.x).mul(-1), nX.x);
            const worldY = T3.vec3(nY.x, nY.z.mul(axisSign.y), nY.y.mul(axisSign.y).mul(-1));
            const worldZ = T3.vec3(nZ.x, nZ.y.mul(axisSign.z), nZ.z.mul(axisSign.z));
            const mappedWorld = T3.normalize(
                worldX.mul(weights.x).add(worldY.mul(weights.y)).add(worldZ.mul(weights.z)),
            );
            for (const material of mappedFixtureMetals) {
                const calibration = material.userData.metalCalibration;
                material.colorNode = baseSample
                    .mul(T3.vec3(...calibration.tint))
                    .add(T3.vec3(0.009, 0.011, 0.013));
                material.roughnessNode = roughSample
                    .mul(calibration.roughScale).add(calibration.roughBias)
                    .clamp(...calibration.roughRange);
                material.metalnessNode = metalSample
                    .mul(calibration.metalScale).add(calibration.metalBias)
                    .clamp(...calibration.metalRange);
                material.normalNode = T3.normalize(
                    T3.cameraViewMatrix.transformDirection(
                        T3.mix(T3.normalWorld, mappedWorld, calibration.normalMix),
                    ),
                );
            }
        } else {
            for (const material of mappedFixtureMetals) {
                material.map = albedo;
                material.normalMap = normal;
                material.roughnessMap = roughness;
                material.metalnessMap = metalness;
            }
        }
        for (const material of mappedFixtureMetals) {
            material.userData.pbrSource = 'ambientCG Metal010 1K JPG (CC0)';
            material.userData.pbrMaps = {
                baseColor: true,
                normalGL: true,
                roughness: true,
                metalness: true,
                separateChannelTextures: true,
                channelDecoding: 'roughness.r + metalness.r',
                projection: nodeCapable ? 'world-triplanar-1.61m' : 'authored-uv',
            };
            material.needsUpdate = true;
        }
        return true;
    };
    const fixtureMetalPbrReady = applyFixtureMetalPbr();

    const makeRectilinearBlockGeometry = (
        width, depth, height, cornerChamfer = 0.18,
    ) => {
        const makeRing = (width, depth) => {
            const hx = width * 0.5;
            const hz = depth * 0.5;
            const c = Math.min(cornerChamfer, hx * 0.42, hz * 0.42);
            return [
                [-hx + c, -hz], [hx - c, -hz], [hx, -hz + c], [hx, hz - c],
                [hx - c, hz], [-hx + c, hz], [-hx, hz - c], [-hx, -hz + c],
            ];
        };
        const bottom = makeRing(width, depth);
        const top = makeRing(width, depth);
        const positions = [];
        for (const [x, z] of bottom) positions.push(x, 0, z);
        for (const [x, z] of top) positions.push(x, height, z);
        const bottomCenter = positions.length / 3;
        positions.push(0, 0, 0);
        const topCenter = positions.length / 3;
        positions.push(0, height, 0);
        const indices = [];
        for (let index = 0; index < 8; index++) {
            const next = (index + 1) % 8;
            // Preserve the verified outward winding: bottom faces -Y, top
            // faces +Y, and every exterior side faces away from the mass.
            indices.push(bottomCenter, index, next);
            indices.push(topCenter, 8 + next, 8 + index);
            indices.push(index, 8 + next, next);
            indices.push(index, 8 + index, 8 + next);
        }
        const indexed = new T3.BufferGeometry();
        indexed.setAttribute('position', new T3.Float32BufferAttribute(positions, 3));
        indexed.setIndex(indices);
        const geometry = indexed.toNonIndexed();
        indexed.dispose();
        geometry.computeVertexNormals();
        geometry.computeBoundingBox();
        geometry.computeBoundingSphere();
        ownedGeometries.add(geometry);
        return geometry;
    };

    const makeBeveledPrismGeometry = (
        width, height, depth, cornerChamfer = 0.08, edgeBevel = 0.025,
    ) => {
        const ringAt = (ringWidth, ringDepth, y, chamfer) => {
            const hx = ringWidth * 0.5;
            const hz = ringDepth * 0.5;
            const c = Math.min(chamfer, hx * 0.42, hz * 0.42);
            return [
                [-hx + c, y, -hz], [hx - c, y, -hz],
                [hx, y, -hz + c], [hx, y, hz - c],
                [hx - c, y, hz], [-hx + c, y, hz],
                [-hx, y, hz - c], [-hx, y, -hz + c],
            ];
        };
        const bevel = Math.min(edgeBevel, height * 0.24, width * 0.12, depth * 0.12);
        const insetWidth = Math.max(0.02, width - bevel * 2);
        const insetDepth = Math.max(0.02, depth - bevel * 2);
        const rings = [
            ringAt(insetWidth, insetDepth, -height * 0.5, Math.max(0, cornerChamfer - bevel)),
            ringAt(width, depth, -height * 0.5 + bevel, cornerChamfer),
            ringAt(width, depth, height * 0.5 - bevel, cornerChamfer),
            ringAt(insetWidth, insetDepth, height * 0.5, Math.max(0, cornerChamfer - bevel)),
        ];
        const positions = rings.flatMap((ring) => ring.flat());
        const bottomCenter = positions.length / 3;
        positions.push(0, -height * 0.5, 0);
        const topCenter = positions.length / 3;
        positions.push(0, height * 0.5, 0);
        const indices = [];
        for (let band = 0; band < rings.length - 1; band++) {
            const start = band * 8;
            const nextStart = (band + 1) * 8;
            for (let index = 0; index < 8; index++) {
                const next = (index + 1) % 8;
                indices.push(start + index, nextStart + next, start + next);
                indices.push(start + index, nextStart + index, nextStart + next);
            }
        }
        for (let index = 0; index < 8; index++) {
            const next = (index + 1) % 8;
            indices.push(bottomCenter, index, next);
            indices.push(topCenter, 24 + next, 24 + index);
        }
        const indexed = new T3.BufferGeometry();
        indexed.setAttribute('position', new T3.Float32BufferAttribute(positions, 3));
        indexed.setIndex(indices);
        const geometry = indexed.toNonIndexed();
        indexed.dispose();
        geometry.computeVertexNormals();
        geometry.computeBoundingBox();
        geometry.computeBoundingSphere();
        ownedGeometries.add(geometry);
        return geometry;
    };

    const makeRampGeometry = (width, frontZ, backZ, frontY, backY, thickness) => {
        const half = width * 0.5;
        const indexed = new T3.BufferGeometry();
        indexed.setAttribute('position', new T3.Float32BufferAttribute([
            -half, frontY, frontZ,  half, frontY, frontZ,
            half, backY, backZ,  -half, backY, backZ,
            -half, frontY - thickness, frontZ,  half, frontY - thickness, frontZ,
            half, backY - thickness, backZ,  -half, backY - thickness, backZ,
        ], 3));
        indexed.setIndex([
            0, 1, 2, 0, 2, 3,
            4, 6, 5, 4, 7, 6,
            0, 4, 5, 0, 5, 1,
            1, 5, 6, 1, 6, 2,
            2, 6, 7, 2, 7, 3,
            3, 7, 4, 3, 4, 0,
        ]);
        const geometry = indexed.toNonIndexed();
        indexed.dispose();
        geometry.computeVertexNormals();
        geometry.computeBoundingBox();
        geometry.computeBoundingSphere();
        ownedGeometries.add(geometry);
        return geometry;
    };

    const addArchitecturalMesh = (name, geometry, material, y = 0) => {
        const mesh = new T3.Mesh(geometry, material);
        mesh.name = name;
        mesh.position.y = y;
        mesh.visible = !useAuthoredZiggurat;
        mesh.userData.proceduralZigguratFallback = true;
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        group.add(mesh);
        return mesh;
    };

    // Four vertical rectilinear masonry blocks create a proper terraced
    // ziggurat silhouette. Equal bottom/top plans eliminate the rejected
    // continuous pyramidal frustum read; large setbacks form real terraces.
    const tier0Top = 6.8;
    const tiers = [
        {
            name: 'ziggurat_rectilinear_tier_1',
            base: foundationBottom,
            height: tier0Top - foundationBottom,
            bottom: [70, 68], top: [70, 68],
        },
        {
            name: 'ziggurat_rectilinear_tier_2',
            base: tier0Top, height: 5.6,
            bottom: [58, 50], top: [58, 50],
        },
        {
            name: 'ziggurat_rectilinear_tier_3',
            base: tier0Top + 5.6, height: 5.0,
            bottom: [46, 34], top: [46, 34],
        },
        {
            name: 'ziggurat_rectilinear_tier_4',
            base: tier0Top + 10.6, height: 4.4,
            bottom: [34, 18], top: [34, 18],
        },
    ];
    for (const tier of tiers) {
        addArchitecturalMesh(
            tier.name,
            makeRectilinearBlockGeometry(
                tier.bottom[0], tier.bottom[1], tier.height, 0.18,
            ),
            sandstone,
            tier.base,
        );
    }
    const summitY = tiers.at(-1).base + tiers.at(-1).height;
    const terraceProfiles = tiers.map((tier) => ({
        y: tier.base + tier.height,
        width: tier.top[0],
        depth: tier.top[1],
    }));

    // A continuous, slightly projecting course at each terrace edge gives
    // the silhouette readable masonry scale without freestanding clutter.
    for (let index = 0; index < terraceProfiles.length; index++) {
        const terrace = terraceProfiles[index];
        addArchitecturalMesh(
            `integrated_terrace_cornice_${index + 1}`,
            makeRectilinearBlockGeometry(
                terrace.width + 0.56, terrace.depth + 0.56, 0.30, 0.14,
            ),
            sandstonePlinth,
            terrace.y - 0.34,
        );
    }
    addArchitecturalMesh(
        'integrated_foundation_toe_course',
        makeRectilinearBlockGeometry(70.8, 68.8, 0.56, 0.16),
        sandstonePlinth,
        foundationBottom,
    );

    // Exact shared contract with ziggurat_architecture_reference.svg and the
    // Blender source: 110 true 0.20 m risers x 0.30 m treads, four flights,
    // and three supported 1.60 m landings. This replaces the rejected steep
    // 78-step profile whose 0.28-0.35 m risers read as a striped wall.
    const stairFrontZ = 43.35;
    const stairBackZ = 5.55;
    const stairFrontY = -0.20;
    const stairTopY = summitY;
    const stairWidth = 15.5030928;
    const stairProfile = [
        { frontZ: 43.35, backZ: 32.85, frontY: stairFrontY, backY: 6.80, steps: 35, landingBackZ: 31.25 },
        { frontZ: 31.25, backZ: 22.85, frontY: 6.80, backY: 12.40, steps: 28, landingBackZ: 21.25 },
        { frontZ: 21.25, backZ: 13.75, frontY: 12.40, backY: 17.40, steps: 25, landingBackZ: 12.15 },
        { frontZ: 12.15, backZ: 5.55, frontY: 17.40, backY: stairTopY, steps: 22, landingBackZ: null },
    ];
    const stairCount = stairProfile.reduce((sum, flight) => sum + flight.steps, 0);
    const stairRise = 0.20;
    const stairRun = 0.30;
    const stairLandingDepth = 1.60;
    addArchitecturalMesh(
        'sealed_processional_stair_substructure',
        makeRampGeometry(
            stairWidth - 0.56, stairFrontZ, stairBackZ,
            stairFrontY - 0.02, stairTopY - 0.03, 0.58,
        ),
        sandstonePlinth,
    );

    const stepGeometry = makeBeveledPrismGeometry(
        stairWidth, stairRise + 0.09, stairRun + 0.035, 0.11, 0.018,
    );
    const stairTreads = new T3.InstancedMesh(stepGeometry, sandstone, stairCount);
    stairTreads.name = 'instanced_processional_stair_treads_and_risers';
    stairTreads.castShadow = true;
    stairTreads.receiveShadow = true;
    stairTreads.visible = !useAuthoredZiggurat;
    stairTreads.userData.proceduralZigguratFallback = true;
    if (T3.StaticDrawUsage) stairTreads.instanceMatrix.setUsage(T3.StaticDrawUsage);
    const stairMatrix = new T3.Matrix4();
    let stairInstanceIndex = 0;
    for (const flight of stairProfile) {
        const flightRise = (flight.backY - flight.frontY) / flight.steps;
        const flightRun = (flight.frontZ - flight.backZ) / flight.steps;
        for (let index = 0; index < flight.steps; index++) {
            const topY = flight.frontY + (index + 1) * flightRise;
            const z = flight.frontZ - (index + 0.5) * flightRun;
            stairMatrix.makeTranslation(0, topY - (stairRise + 0.09) * 0.5, z);
            stairTreads.setMatrixAt(stairInstanceIndex, stairMatrix);
            stairInstanceIndex += 1;
        }
    }
    stairTreads.instanceMatrix.needsUpdate = true;
    stairTreads.computeBoundingBox?.();
    stairTreads.computeBoundingSphere?.();
    group.add(stairTreads);

    const curbWidth = 0.66;
    const curbOffset = stairWidth * 0.5 + curbWidth * 0.5 - 0.04;
    for (const side of [-1, 1]) {
        for (let index = 0; index < stairProfile.length; index++) {
            const flight = stairProfile[index];
            const curb = addArchitecturalMesh(
                `processional_stair_curb_${side < 0 ? 'left' : 'right'}_${index + 1}`,
                makeRampGeometry(
                    curbWidth, flight.frontZ, flight.backZ,
                    flight.frontY + 0.48, flight.backY + 0.48, 0.38,
                ),
                sandstonePlinth,
            );
            curb.position.x = side * curbOffset;
            if (flight.landingBackZ !== null) {
                const landing = addArchitecturalMesh(
                    `processional_landing_curb_${side < 0 ? 'left' : 'right'}_${index + 1}`,
                    makeBeveledPrismGeometry(
                        curbWidth, 0.62, stairLandingDepth + 0.06, 0.06, 0.018,
                    ),
                    sandstonePlinth,
                );
                landing.position.set(
                    side * curbOffset,
                    flight.backY + 0.21,
                    (flight.backZ + flight.landingBackZ) * 0.5,
                );
            }
        }
    }
    // Match the authored Blender termination: continue the two side curbs
    // across the final summit landing and return them into the tier opening.
    const summitLandingBackZ = 4.75;
    const summitLandingDepth = stairBackZ - summitLandingBackZ;
    const summitLandingCenterZ = (stairBackZ + summitLandingBackZ) * 0.5;
    for (const side of [-1, 1]) {
        const landing = addArchitecturalMesh(
            `processional_summit_landing_curb_${side < 0 ? 'left' : 'right'}`,
            makeBeveledPrismGeometry(
                curbWidth, 0.62, summitLandingDepth + 0.06, 0.06, 0.018,
            ),
            sandstonePlinth,
        );
        landing.position.set(
            side * curbOffset,
            stairTopY + 0.21,
            summitLandingCenterZ,
        );
        const returnWidth = 0.38;
        const returnMesh = addArchitecturalMesh(
            `processional_summit_curb_return_${side < 0 ? 'left' : 'right'}`,
            makeBeveledPrismGeometry(
                returnWidth, 0.62, 0.72, 0.05, 0.018,
            ),
            sandstonePlinth,
        );
        returnMesh.position.set(
            side * (Math.abs(curbOffset) + curbWidth * 0.5 + returnWidth * 0.5),
            stairTopY + 0.21,
            summitLandingBackZ + 0.13,
        );
    }

    // Gem tile bands are shallow physical inlays, segmented and instanced.
    // The front bands leave the stair aperture clear at every terrace.
    const tileGeometry = makeBeveledPrismGeometry(0.92, 0.36, 0.15, 0.075, 0.024);
    const tilePlacements = { lapis: [], carnelian: [] };
    const addTilePlacement = (kind, x, y, z, yaw = 0) => {
        tilePlacements[kind].push({ x, y, z, yaw });
    };
    for (let level = 0; level < terraceProfiles.length; level++) {
        const { y, width, depth } = terraceProfiles[level];
        const spacing = 1.06;
        const xCount = Math.max(1, Math.floor((width - 0.8) / spacing));
        const zCount = Math.max(1, Math.floor((depth - 0.8) / spacing));
        for (let index = 0; index < xCount; index++) {
            const x = (index - (xCount - 1) * 0.5) * spacing;
            const kind = ((index + level * 2) % 7 === 0) ? 'carnelian' : 'lapis';
            if (Math.abs(x) > stairWidth * 0.5 + 0.38) {
                addTilePlacement(kind, x, y - 0.46, depth * 0.5 + 0.12, 0);
            }
            addTilePlacement(kind, x, y - 0.46, -depth * 0.5 - 0.12, 0);
        }
        for (let index = 0; index < zCount; index++) {
            const z = (index - (zCount - 1) * 0.5) * spacing;
            const kind = ((index + level * 3 + 2) % 7 === 0) ? 'carnelian' : 'lapis';
            addTilePlacement(kind, width * 0.5 + 0.12, y - 0.46, z, Math.PI * 0.5);
            addTilePlacement(kind, -width * 0.5 - 0.12, y - 0.46, z, Math.PI * 0.5);
        }
    }
    const tileDummy = new T3.Object3D();
    const addTileInstances = (kind, material) => {
        const placements = tilePlacements[kind];
        const instances = new T3.InstancedMesh(tileGeometry, material, placements.length);
        instances.name = `instanced_${kind}_architectural_tile_band`;
        instances.castShadow = true;
        instances.receiveShadow = true;
        instances.visible = !useAuthoredZiggurat;
        instances.userData.proceduralZigguratFallback = true;
        if (T3.StaticDrawUsage) instances.instanceMatrix.setUsage(T3.StaticDrawUsage);
        for (let index = 0; index < placements.length; index++) {
            const placement = placements[index];
            tileDummy.position.set(placement.x, placement.y, placement.z);
            tileDummy.rotation.set(0, placement.yaw, 0);
            tileDummy.scale.set(1, 1, 1);
            tileDummy.updateMatrix();
            instances.setMatrixAt(index, tileDummy.matrix);
        }
        instances.instanceMatrix.needsUpdate = true;
        instances.computeBoundingBox?.();
        instances.computeBoundingSphere?.();
        group.add(instances);
        return instances;
    };
    const lapisTiles = addTileInstances('lapis', lapis);
    const carnelianTiles = addTileInstances('carnelian', carnelian);

    const plinthLowerRadius = 4.7;
    const plinthUpperRadius = 3.55;
    const plinthLowerHeight = 1.05;
    const plinthUpperHeight = 0.72;
    const plinthLowerGeometry = new T3.CylinderGeometry(plinthLowerRadius, plinthLowerRadius, plinthLowerHeight, 64);
    const plinthUpperGeometry = new T3.CylinderGeometry(plinthUpperRadius, plinthUpperRadius, plinthUpperHeight, 64);
    ownedGeometries.add(plinthLowerGeometry);
    ownedGeometries.add(plinthUpperGeometry);
    addArchitecturalMesh(
        'summit_stone_plinth', plinthLowerGeometry, sandstonePlinth,
        summitY + plinthLowerHeight * 0.5,
    );
    addArchitecturalMesh(
        'summit_orb_dais', plinthUpperGeometry, sandstone,
        summitY + plinthLowerHeight + plinthUpperHeight * 0.5,
    );

    // Preserve the actual Inanna GLB and normalize only its pivot and diameter.
    const orbContent = orbSource.clone(true);
    const orbPivot = new T3.Group();
    orbPivot.name = 'authored_inanna_orb_pivot';
    orbPivot.add(orbContent);
    orbContent.updateMatrixWorld(true);
    const orbBounds = new T3.Box3().setFromObject(orbContent);
    const orbCenter = orbBounds.getCenter(new T3.Vector3());
    const orbSize = orbBounds.getSize(new T3.Vector3());
    orbContent.position.sub(orbCenter);
    orbPivot.scale.setScalar(4.9 / Math.max(orbSize.x, orbSize.y, orbSize.z, 0.001));
    const orbBaseY = summitY + 5.0;
    orbPivot.position.y = orbBaseY;
    orbPivot.userData.noWet = true;
    orbPivot.userData.noCloudShadow = true;
    // The authored orb is one mesh with three material groups: shell, red
    // light island, and blue light island. Anchoring by whole-mesh bounds
    // collapses both emitters to the sphere centre, so derive each anchor from
    // the vertices referenced by its emissive material group instead.
    const sphereEmitterAnchors = { blue: null, red: null };
    const sphereEmitterMaterials = { blue: new Set(), red: new Set() };
    const materialGroupCenter = (geometry, materialIndex) => {
        const position = geometry?.getAttribute?.('position');
        if (!position) return null;
        const index = geometry.getIndex?.() ?? geometry.index ?? null;
        const groups = (geometry.groups ?? []).filter(
            (groupEntry) => groupEntry.materialIndex === materialIndex,
        );
        const ranges = groups.length
            ? groups
            : [{ start: 0, count: index?.count ?? position.count }];
        const bounds = new T3.Box3();
        bounds.makeEmpty();
        const point = new T3.Vector3();
        for (const range of ranges) {
            const end = Math.min(
                range.start + range.count,
                index?.count ?? position.count,
            );
            for (let offset = range.start; offset < end; offset++) {
                const vertex = index ? index.getX(offset) : offset;
                point.fromBufferAttribute(position, vertex);
                bounds.expandByPoint(point);
            }
        }
        return bounds.isEmpty() ? null : bounds.getCenter(new T3.Vector3());
    };
    orbPivot.traverse((object) => {
        if (!object.isMesh) return;
        // This convex shell cannot reflect its own silhouette. Its engraved
        // normal map used to create false SSR hits on other shell pixels.
        object.userData.ssrConvexGroup = orbPivot.uuid;
        object.castShadow = true;
        object.receiveShadow = false;
        object.userData.noWet = true;
        object.userData.noCloudShadow = true;
        if (object.geometry) ownedGeometries.add(object.geometry);
        const materials = Array.isArray(object.material) ? object.material : [object.material];
        for (const [materialIndex, material] of materials.entries()) {
            retainMaterial(material);
            const emissive = material?.emissive;
            if (!emissive?.isColor) continue;
            const strongest = Math.max(emissive.r, emissive.g, emissive.b);
            if (strongest < 0.12) continue;
            const channel = emissive.b > emissive.r ? 'blue' : 'red';
            sphereEmitterMaterials[channel].add(material);
            const localCenter = materialGroupCenter(object.geometry, materialIndex);
            if (!sphereEmitterAnchors[channel] && localCenter) {
                sphereEmitterAnchors[channel] = { mesh: object, localCenter, materialIndex };
            }
            const channels = object.userData.inannaSphereEmitterChannels ??= [];
            if (!channels.includes(channel)) channels.push(channel);
        }
    });
    group.add(orbPivot);

    // Restrained summit technology: two structural pylons, one cool and one
    // warm emitter, and narrow stair light strips. The additive volumes are
    // depth-tested and never write depth, so masonry and the Inanna sphere
    // correctly occlude them.
    const blueLightColor = new T3.Color(0x007cff);
    const redLightColor = new T3.Color(0xff4a24);
    const makeEmitterMaterial = (name, color) => {
        const material = new StandardMaterial({
            color: 0x101820,
            metalness: 0.34,
            roughness: 0.24,
            emissive: color,
            emissiveIntensity: 0,
        });
        material.name = name;
        material.envMapIntensity = 0.9;
        ownedMaterials.add(material);
        return material;
    };
    const blueEmitterMaterial = makeEmitterMaterial('HDR_lapis_blue_emitter', blueLightColor);
    const redEmitterMaterial = makeEmitterMaterial('HDR_carnelian_red_emitter', redLightColor);
    // The visible atmosphere is deliberately local to the orb; the actual
    // shadowed spotlights below carry illumination out to 600 m. A 140 m
    // additive shell read as a saturated solid wedge across the whole valley.
    const beamLength = 52;
    const makeBeamMaterial = (name, color) => {
        const material = new BasicMaterial({
            color: 0xffffff,
            transparent: true,
            opacity: 1,
            depthTest: true,
            depthWrite: false,
            blending: T3.AdditiveBlending,
            side: T3.DoubleSide,
            toneMapped: false,
        });
        material.name = name;
        if (T3.uniform && T3.positionLocal && T3.normalView) {
            const level = T3.uniform(0);
            const axial = T3.positionLocal.y.div(beamLength).add(0.5).clamp(0, 1);
            const sourceFade = T3.smoothstep(0.0, 0.018, axial);
            // Reversed smoothstep edges are undefined in WGSL/GLSL and were
            // producing an opaque, hard-ended red/blue blob on some WebGPU
            // drivers. Use one-minus a conventional increasing ramp so the
            // volume always dissolves smoothly before its local 52 m endpoint.
            const distanceFade = T3.float(1).sub(
                T3.smoothstep(0.05, 1.0, axial),
            ).pow(1.55);
            const faceSoft = T3.smoothstep(
                0.015, 0.72, T3.abs(T3.normalView.z),
            );
            const envelope = sourceFade.mul(distanceFade)
                .mul(faceSoft.pow(1.6).mul(0.72).add(0.025));
            material.colorNode = T3.vec3(color.r, color.g, color.b)
                .mul(T3.float(1.45).sub(axial.mul(0.42)));
            material.opacityNode = level.mul(envelope);
            material.userData.beamLevel = level;
            material.userData.gradient = 'source-fade + distance-fade + soft silhouette';
        }
        ownedMaterials.add(material);
        return material;
    };
    const blueBeamMaterial = makeBeamMaterial('depth_tested_blue_beam_volume', blueLightColor);
    const redBeamMaterial = makeBeamMaterial('depth_tested_red_beam_volume', redLightColor);

    const pylonGeometry = new T3.CylinderGeometry(0.30, 0.52, 4.05, 16, 2, false);
    const emitterGeometry = new T3.IcosahedronGeometry(0.31, 2);
    const emitterCollarGeometry = new T3.TorusGeometry(0.43, 0.075, 10, 32);
    // Narrow at -Y (the sphere surface) and widening toward +Y (outward).
    const beamGeometry = new T3.CylinderGeometry(4.8, 0.10, beamLength, 32, 24, true);
    ownedGeometries.add(pylonGeometry);
    ownedGeometries.add(emitterGeometry);
    ownedGeometries.add(emitterCollarGeometry);
    ownedGeometries.add(beamGeometry);

    const emitters = [];
    const beams = [];
    const summitLights = [];
    const summitLightTargets = [];
    const emitterY = summitY + 4.12;
    for (const side of [-1, 1]) {
        const isBlue = side < 0;
        const color = isBlue ? blueLightColor : redLightColor;
        const emitterMaterial = isBlue ? blueEmitterMaterial : redEmitterMaterial;
        const beamMaterial = isBlue ? blueBeamMaterial : redBeamMaterial;
        const x = side * 5.85;

        const pylon = addArchitecturalMesh(
            `integrated_summit_${isBlue ? 'blue' : 'red'}_pylon`,
            pylonGeometry,
            fixtureMetal,
            summitY + 2.025,
        );
        pylon.position.x = x;
        pylon.userData.noWet = true;

        const collar = addArchitecturalMesh(
            `summit_${isBlue ? 'blue' : 'red'}_emitter_collar`,
            emitterCollarGeometry,
            fixtureMetal,
            emitterY,
        );
        collar.position.x = x;
        collar.rotation.x = Math.PI * 0.5;

        const emitter = addArchitecturalMesh(
            `summit_${isBlue ? 'blue' : 'red'}_HDR_emitter`,
            emitterGeometry,
            emitterMaterial,
            emitterY,
        );
        emitter.position.x = x;
        emitter.castShadow = false;
        emitter.receiveShadow = false;
        emitter.userData.noWet = true;
        emitter.userData.noCloudShadow = true;
        emitters.push(emitter);

        const light = new T3.SpotLight(
            color, 0, 600, Math.PI * 0.030, 0.92, 1.55,
        );
        light.name = `summit_${isBlue ? 'blue' : 'red'}_long_range_spotlight`;
        light.position.set(x, emitterY, 0.15);
        light.castShadow = true;
        light.shadow.mapSize.set(1024, 1024);
        light.shadow.camera.near = 0.35;
        light.shadow.camera.far = 600;
        light.shadow.bias = -0.00018;
        light.shadow.normalBias = 0.045;
        const lightTarget = new T3.Object3D();
        lightTarget.name = `summit_${isBlue ? 'blue' : 'red'}_spotlight_target`;
        light.target = lightTarget;
        light.userData.noWet = true;
        light.userData.noCloudShadow = true;
        light.userData.range = 600;
        light.userData.source = 'Inanna sphere emissive mesh';
        group.add(light, lightTarget);
        summitLights.push(light);
        summitLightTargets.push(lightTarget);

        const beam = new T3.Mesh(beamGeometry, beamMaterial);
        beam.name = `summit_${isBlue ? 'blue' : 'red'}_depth_tested_beam`;
        beam.position.set(x, emitterY + 3.38, 0);
        beam.castShadow = false;
        beam.receiveShadow = false;
        beam.visible = false;
        beam.renderOrder = 1;
        beam.userData.noWet = true;
        beam.userData.noCloudShadow = true;
        beam.userData.cannotReceiveAO = true;
        group.add(beam);
        beams.push(beam);
    }

    // The real red/blue emissive details are part of the Inanna sphere GLB.
    // Bind the lights and volumes to those meshes, then follow the sphere's
    // bob and rotation. This replaces the old upward beams from detached
    // ziggurat boxes with lateral/outward light from the sphere itself.
    const sphereEmitterBindings = [
        {
            channel: 'blue',
            ...sphereEmitterAnchors.blue,
            light: summitLights[0],
            target: summitLightTargets[0],
            beam: beams[0],
        },
        {
            channel: 'red',
            ...sphereEmitterAnchors.red,
            light: summitLights[1],
            target: summitLightTargets[1],
            beam: beams[1],
        },
    ];
    const emitterWorld = new T3.Vector3();
    const emitterLocal = new T3.Vector3();
    const sphereCenterWorld = new T3.Vector3();
    const sphereCenterLocal = new T3.Vector3();
    const emitterDirection = new T3.Vector3();
    const beamUp = new T3.Vector3(0, 1, 0);
    const syncSphereEmitters = () => {
        group.updateWorldMatrix(true, false);
        orbPivot.updateWorldMatrix(true, true);
        orbPivot.getWorldPosition(sphereCenterWorld);
        sphereCenterLocal.copy(sphereCenterWorld);
        group.worldToLocal(sphereCenterLocal);
        for (const binding of sphereEmitterBindings) {
            const { mesh, light, target, beam, localCenter } = binding;
            if (!mesh) {
                light.visible = false;
                beam.visible = false;
                continue;
            }
            emitterWorld.copy(localCenter).applyMatrix4(mesh.matrixWorld);
            emitterLocal.copy(emitterWorld);
            group.worldToLocal(emitterLocal);
            emitterDirection.copy(emitterLocal).sub(sphereCenterLocal);
            if (emitterDirection.lengthSq() < 1e-8) emitterDirection.set(0, 0, 1);
            emitterDirection.normalize();
            light.visible = true;
            light.position.copy(emitterLocal).addScaledVector(emitterDirection, 0.16);
            target.position.copy(emitterLocal).addScaledVector(
                emitterDirection, beamLength,
            );
            beam.position.copy(emitterLocal).addScaledVector(
                emitterDirection, beamLength * 0.5 + 0.06,
            );
            beam.quaternion.setFromUnitVectors(beamUp, emitterDirection);
            beam.userData.source = 'Inanna sphere emissive mesh';
            beam.userData.sourceMesh = mesh.name;
            beam.userData.direction = 'lateral/outward';
        }
    };

    const stripMaterials = [
        makeEmitterMaterial('processional_lapis_light_strip', blueLightColor),
        makeEmitterMaterial('processional_carnelian_light_strip', redLightColor),
    ];
    const stripGeometry = makeRampGeometry(
        0.11, stairFrontZ, stairBackZ,
        stairFrontY + 0.745, stairTopY + 0.745, 0.055,
    );
    const lightStrips = [];
    for (let index = 0; index < 2; index++) {
        const side = index === 0 ? -1 : 1;
        const strip = addArchitecturalMesh(
            `integrated_processional_${side < 0 ? 'blue' : 'red'}_light_strip`,
            stripGeometry,
            stripMaterials[index],
        );
        strip.position.x = side * curbOffset;
        strip.castShadow = false;
        strip.receiveShadow = false;
        strip.userData.noWet = true;
        strip.userData.noCloudShadow = true;
        lightStrips.push(strip);
    }

    const smoothstep01 = (value) => {
        const x = Math.max(0, Math.min(1, value));
        return x * x * (3 - 2 * x);
    };
    const nightForHours = (hours) => {
        const wrapped = ((Number(hours) % 24) + 24) % 24;
        const solarProxy = Math.cos((wrapped - 12) * Math.PI / 12);
        return smoothstep01((0.08 - solarProxy) / 0.36);
    };
    let templeHours = 10.5;
    let targetNightLevel = nightForHours(templeHours);
    let nightLevel = targetNightLevel;
    const applyNightLighting = (timeSeconds = 0) => {
        const pulse = 0.94 + Math.sin(timeSeconds * 1.7) * 0.06;
        for (const material of sphereEmitterMaterials.blue) {
            material.emissive.copy(blueLightColor);
            material.emissiveIntensity = 0.45 + nightLevel * 15.5 * pulse;
        }
        for (const material of sphereEmitterMaterials.red) {
            material.emissiveIntensity = 0.45 + nightLevel * 14.8 * (1.96 - pulse);
        }
        stripMaterials[0].emissiveIntensity = nightLevel * 6.4 * pulse;
        stripMaterials[1].emissiveIntensity = nightLevel * 6.0 * (1.96 - pulse);
        summitLights[0].intensity = nightLevel * 52000 * pulse;
        summitLights[1].intensity = nightLevel * 48000 * (1.96 - pulse);
        // Three still renders a shadow map for a zero-intensity spotlight.
        // Keep these lights in the stable light list, but sleep their shadow
        // captures during daylight and refresh immediately when they light up.
        for (const light of summitLights) {
            const active = light.intensity > 0.001;
            if (active && !light.shadow.autoUpdate) light.shadow.needsUpdate=true;
            if (!active) light.shadow.needsUpdate=false;
            light.shadow.autoUpdate=active;
        }
        // Day/night is carried ONLY by intensity. Toggling light `visible` at
        // the nightLevel threshold changed the scene's light list at every
        // dusk and dawn, and a light-list change invalidates every pipeline
        // in the scene (r184) — a 15-30 s whole-app freeze twice per cycle.
        summitLights[0].visible = Boolean(sphereEmitterAnchors.blue);
        summitLights[1].visible = Boolean(sphereEmitterAnchors.red);
        if (blueBeamMaterial.userData.beamLevel) {
            blueBeamMaterial.userData.beamLevel.value = nightLevel * 0.014 * pulse;
        }
        if (redBeamMaterial.userData.beamLevel) {
            redBeamMaterial.userData.beamLevel.value = nightLevel * 0.013 * (1.96 - pulse);
        }
        for (const beam of beams) beam.visible = nightLevel > 0.004;
        group.userData.nightLighting = nightLevel;
    };
    syncSphereEmitters();
    applyNightLighting(0);

    let authoredZiggurat = null;
    let hiddenLegacyEmitterMeshes = 0;
    let authoredZigguratMeshCount = 0;
    let authoredPanelCornerFasteners = 0;
    const authoredWalkSurfaces = [];
    if (useAuthoredZiggurat) {
        authoredZiggurat = authoredZigguratSource.clone(true);
        authoredZiggurat.name = 'authored_ziggurat_architecture';
        authoredZiggurat.userData.preferredOverProceduralFallback = true;
        const materialForName = (materialName = '') => {
            const key = String(materialName).toLowerCase().replace(/[^a-z0-9]/g, '');
            if (key.includes('sandstonepbr') || key === 'sandstone') return sandstone;
            if (key.includes('lapispbr') || key.includes('lapislazuli')) return lapis;
            if (key.includes('carnelianpbr') || key.includes('carnelian')) return carnelian;
            if (key.includes('scifimetal') || key.includes('fixturemetal')) return fixtureMetal;
            return null;
        };
        authoredZiggurat.traverse((object) => {
            const embeddedFastenerCount = Number(object.userData?.panel_corner_fasteners ?? 0);
            if (Number.isFinite(embeddedFastenerCount)) {
                authoredPanelCornerFasteners = Math.max(
                    authoredPanelCornerFasteners,
                    embeddedFastenerCount,
                );
            }
            if (!object.isMesh) return;
            authoredZigguratMeshCount += 1;
            const objectKey = String(object.name).toLowerCase().replace(/[^a-z0-9]/g, '');
            if (objectKey.includes('lightemitterblue') || objectKey.includes('lightemitterred')) {
                // Compatibility with pre-regeneration GLBs: never show the
                // obsolete detached boxes even if an old file is cached.
                object.visible = false;
                object.userData.obsoleteDetachedEmitter = true;
                hiddenLegacyEmitterMeshes += 1;
            }
            object.castShadow = true;
            object.receiveShadow = true;
            if (object.geometry) ownedGeometries.add(object.geometry);
            const sourceMaterials = Array.isArray(object.material)
                ? object.material
                : [object.material];
            const mappedMaterials = sourceMaterials.map((material) => {
                if (!material) return material;
                // Retain even mapped source materials until temple disposal;
                // GLB slots may share textures and eager disposal is unsafe.
                retainMaterial(material);
                const mappedBase = materialForName(material.name);
                let mapped = mappedBase;
                if (objectKey.includes('scifipanelcornerfasteners')) mapped = fastenerMetal;
                else if (objectKey.includes('scifiprocessionalcheekinsets')) mapped = railMetal;
                else if (objectKey.includes('scifidaisinsetmetalreveal')) mapped = daisMetal;
                else if (objectKey.includes('stoneprocessionalrailflight')) mapped = userRailSandstone;
                return mapped ?? material;
            });
            object.material = Array.isArray(object.material)
                ? mappedMaterials
                : mappedMaterials[0];
        });
        group.add(authoredZiggurat);
        group.updateMatrixWorld(true);

        for (const name of ['stone_entry_threshold', 'stone_summit_landing']) {
            const surface = authoredZiggurat.getObjectByName(name);
            if (!surface?.isMesh) continue;
            const worldBounds = new T3.Box3().setFromObject(surface);
            authoredWalkSurfaces.push({
                name,
                minX: worldBounds.min.x - group.position.x,
                maxX: worldBounds.max.x - group.position.x,
                minZ: worldBounds.min.z - group.position.z,
                maxZ: worldBounds.max.z - group.position.z,
                y: worldBounds.max.y - group.position.y,
            });
        }
    }

    // The four GLBs embed byte-identical copies of one 2K material set.  Keep
    // the gate material as the canonical instance and release every duplicate
    // material/texture while preparing the other prototypes.
    let sharedPerimeterMaterial = null;
    const retainedPerimeterTextures = new Set();
    const preparePerimeterPrototype = (source, name) => {
        const content = source.clone(true);
        content.name = `${name}_normalized_content`;
        content.traverse((object) => {
            if (!object.isMesh) return;
            object.castShadow = true;
            object.receiveShadow = true;
            if (object.geometry) ownedGeometries.add(object.geometry);
            const materials = (Array.isArray(object.material) ? object.material : [object.material]).filter(Boolean);
            if (!sharedPerimeterMaterial && materials.length) {
                sharedPerimeterMaterial = materials[0];
                sharedPerimeterMaterial.name = 'Eidoverse_perimeter_shared_2K_PBR';
                // Retain the GLB's exact color/metal/roughness/normal maps.
                // Lowering the scalar still leaves the roughness texture in
                // control while preserving recognizable cloud energy in its
                // native PMREM lobe on these large planar receivers.
                sharedPerimeterMaterial.roughness = 0.42;
                sharedPerimeterMaterial.envMapIntensity = 0.86;
                retainMaterial(sharedPerimeterMaterial);
                for (const texture of textureValues(sharedPerimeterMaterial)) retainedPerimeterTextures.add(texture);
            }
            for (const material of materials) {
                if (material !== sharedPerimeterMaterial) discardMaterial(material, retainedPerimeterTextures);
            }
            object.material = sharedPerimeterMaterial;
        });

        const wrapper = new T3.Group();
        wrapper.name = `${name}_normalized_prototype`;
        wrapper.add(content);
        content.updateMatrixWorld(true);
        const bounds = new T3.Box3().setFromObject(content);
        const center = bounds.getCenter(new T3.Vector3());
        const size = bounds.getSize(new T3.Vector3());
        content.position.x -= center.x;
        content.position.y -= bounds.min.y;
        content.position.z -= center.z;
        wrapper.userData.assetSize = size.toArray();
        wrapper.userData.authoredScale = 1;
        prototypes.push(wrapper);
        return wrapper;
    };

    const perimeter = {
        gate: preparePerimeterPrototype(sources.gate, 'perimeter_gate'),
        wall: preparePerimeterPrototype(sources.wall, 'perimeter_wall_bay'),
        pillar: preparePerimeterPrototype(sources.pillar, 'perimeter_pillar'),
        watchtower: preparePerimeterPrototype(sources.watchtower, 'perimeter_watchtower'),
    };

    const supportHeight = (x, z, size, yaw) => {
        const halfX = size.x * 0.5;
        const halfZ = size.z * 0.5;
        const cosine = Math.cos(yaw);
        const sine = Math.sin(yaw);
        let highest = localGround(x, z);
        for (const sx of [-1, 1]) {
            for (const sz of [-1, 1]) {
                const ox = sx * halfX;
                const oz = sz * halfZ;
                const rx = ox * cosine + oz * sine;
                const rz = -ox * sine + oz * cosine;
                highest = Math.max(highest, localGround(x + rx, z + rz));
            }
        }
        return highest - 0.16;
    };

    const placedPerimeter = [];
    const perimeterLayout = [];
    let mainGateInstance = null;
    const queuePerimeter = (prototype, name, x, z, yaw = 0) => {
        const kind = prototype === perimeter.gate ? 'gate'
            : prototype === perimeter.wall ? 'wall'
                : prototype === perimeter.pillar ? 'pillar'
                    : prototype === perimeter.watchtower ? 'watchtower'
                        : 'unknown';
        perimeterLayout.push({ prototype, name, x, z, yaw, kind });
    };
    const placePerimeter = (prototype, name, x, z, yaw, baseY) => {
        const instance = prototype.clone(true);
        instance.name = name;
        instance.position.set(x, baseY, z);
        instance.rotation.y = yaw;
        instance.userData.authoredScale = 1;
        group.add(instance);
        placedPerimeter.push(instance);
        return instance;
    };

    // The kit is authored around ten-metre support sockets, not edge-to-edge
    // bounding boxes.  Wall ends terminate on pillar/watchtower centerlines so
    // their caps are hidden inside the supports.  The gate already contains
    // full pillars centered ten metres either side of its opening.
    const quarterTurn = Math.PI * 0.5;
    const bay = 10;
    const frontZ = 48;
    const backZ = -42;
    const sideX = 40;
    queuePerimeter(perimeter.gate, 'authored_main_gate', 0, frontZ, quarterTurn);

    for (const side of [-1, 1]) {
        for (const x of [15, 25, 35]) {
            queuePerimeter(perimeter.wall, `front_wall_${side}_${x}`, side * x, frontZ, quarterTurn);
        }
        for (const x of [20, 30]) {
            queuePerimeter(perimeter.pillar, `front_pillar_${side}_${x}`, side * x, frontZ);
        }
        queuePerimeter(perimeter.watchtower, `front_corner_watchtower_${side}`, side * sideX, frontZ);
        queuePerimeter(perimeter.watchtower, `rear_corner_watchtower_${side}`, side * sideX, backZ);

        for (let index = 0; index < 9; index++) {
            const z = frontZ - (index + 0.5) * bay;
            queuePerimeter(perimeter.wall, `side_wall_${side}_${z}`, side * sideX, z);
        }
        for (let index = 1; index < 9; index++) {
            const z = frontZ - index * bay;
            queuePerimeter(perimeter.pillar, `side_pillar_${side}_${z}`, side * sideX, z);
        }
    }
    for (let index = 0; index < 8; index++) {
        const x = -sideX + (index + 0.5) * bay;
        queuePerimeter(perimeter.wall, `rear_wall_${x}`, x, backZ, quarterTurn);
    }
    for (let index = 1; index < 8; index++) {
        const x = -sideX + index * bay;
        queuePerimeter(perimeter.pillar, `rear_pillar_${x}`, x, backZ);
    }

    // Assert the authored kit grammar instead of relying on a visually close
    // placement. Every 10 m wall terminates on a support centerline: one
    // standalone pillar at wall-wall joins, a watchtower at corners, or one
    // of the gate's own built-in posts at x +/-10. There are deliberately no
    // extra standalone pillars beside the gate.
    const countPerimeterKind = (kind) => perimeterLayout.filter((item) => item.kind === kind).length;
    const socketKey = (x, z) => `${x.toFixed(3)},${z.toFixed(3)}`;
    const supportSockets = new Map();
    for (const placement of perimeterLayout) {
        if (placement.kind !== 'pillar' && placement.kind !== 'watchtower') continue;
        const key = socketKey(placement.x, placement.z);
        if (supportSockets.has(key)) throw new Error(`Duplicate perimeter support at ${key}`);
        supportSockets.set(key, placement.kind);
    }
    supportSockets.set(socketKey(-bay, frontZ), 'gatePost');
    supportSockets.set(socketKey(bay, frontZ), 'gatePost');
    const unsupportedWallEnds = [];
    for (const placement of perimeterLayout) {
        if (placement.kind !== 'wall') continue;
        const alongX = Math.abs(Math.sin(placement.yaw)) > 0.5;
        const endpoints = alongX
            ? [[placement.x - bay * 0.5, placement.z], [placement.x + bay * 0.5, placement.z]]
            : [[placement.x, placement.z - bay * 0.5], [placement.x, placement.z + bay * 0.5]];
        for (const [x, z] of endpoints) {
            if (!supportSockets.has(socketKey(x, z))) unsupportedWallEnds.push([x, z]);
        }
    }
    const perimeterGrammar = {
        gateModules: countPerimeterKind('gate'),
        wallBays: countPerimeterKind('wall'),
        standalonePillars: countPerimeterKind('pillar'),
        watchtowers: countPerimeterKind('watchtower'),
        gateAdjacentStandalonePillars: perimeterLayout.filter((item) => item.kind === 'pillar'
            && item.z === frontZ && Math.abs(item.x) === bay).length,
        unsupportedWallEnds: unsupportedWallEnds.length,
        wallEndsClipToSupportCenterlines: unsupportedWallEnds.length === 0,
    };
    if (perimeterGrammar.gateModules !== 1
        || perimeterGrammar.wallBays !== 32
        || perimeterGrammar.standalonePillars !== 27
        || perimeterGrammar.watchtowers !== 4
        || perimeterGrammar.gateAdjacentStandalonePillars !== 0
        || perimeterGrammar.unsupportedWallEnds !== 0) {
        throw new Error(`Invalid Eidoverse perimeter grammar: ${JSON.stringify(perimeterGrammar)}`);
    }

    // A separate terrain-conforming height for every module creates stepped
    // wall tops.  Use the median supported elevation as one compound datum;
    // the grading still overlaps every base, while all authored joins align.
    const supportedElevations = perimeterLayout.map(({ prototype, x, z, yaw }) => {
        const size = new T3.Vector3().fromArray(prototype.userData.assetSize);
        return supportHeight(x, z, size, yaw);
    }).sort((a, b) => a - b);
    const elevationMiddle = Math.floor(supportedElevations.length * 0.5);
    const perimeterBaseY = supportedElevations.length % 2
        ? supportedElevations[elevationMiddle]
        : (supportedElevations[elevationMiddle - 1] + supportedElevations[elevationMiddle]) * 0.5;
    for (const placement of perimeterLayout) {
        const instance = placePerimeter(
            placement.prototype,
            placement.name,
            placement.x,
            placement.z,
            placement.yaw,
            perimeterBaseY,
        );
        if (placement.name === 'authored_main_gate') mainGateInstance = instance;
    }

    // Animate the authored thin gate leaf itself, not a replacement primitive.
    // GLTFLoader sanitizes `Cube.001` to `Cube001` in this browser build.
    const gateDoor = mainGateInstance?.getObjectByName('Cube001')
        ?? mainGateInstance?.getObjectByName('Cube.001')
        ?? null;
    if (!gateDoor?.isMesh) {
        throw new Error('Authored perimeter gate is missing its Cube.001 retracting door mesh');
    }
    gateDoor.geometry?.computeBoundingBox?.();
    const gateDoorSize = gateDoor.geometry?.boundingBox
        ?.getSize(new T3.Vector3()) ?? new T3.Vector3(0.516, 6.38, 18.32);
    const gateDoorClosedPosition = gateDoor.position.clone();
    const gateDoorTravel = gateDoorSize.y + 0.34;
    group.updateMatrixWorld(true);
    const gateClosedWorldBounds = new T3.Box3().setFromObject(gateDoor);
    const gateDoorClosedBottomLocal = gateClosedWorldBounds.min.y - group.position.y;
    const gateDoorClosedTopLocal = gateClosedWorldBounds.max.y - group.position.y;
    gateDoor.userData.authoredRetractingDoor = true;
    gateDoor.userData.sourceMeshName = 'Cube.001';
    let gateProgress = 0;
    let gateTarget = 0;
    let gateCloseDelay = 0;
    let lastTempleUpdateTime = null;
    group.userData.gate = {
        sourceMesh: 'Cube.001',
        runtimeMesh: gateDoor.name,
        frontZ,
        progress: gateProgress,
        target: gateTarget,
        openingWidth: gateDoorSize.z,
        doorHeight: gateDoorSize.y,
        travel: gateDoorTravel,
    };

    group.userData.architecture = {
        authoredZiggurat: useAuthoredZiggurat,
        proceduralFallbackVisible: !useAuthoredZiggurat,
        sphereEmitterAnchors: {
            blue: sphereEmitterAnchors.blue ? 1 : 0,
            red: sphereEmitterAnchors.red ? 1 : 0,
        },
        emitterSource: 'Inanna sphere GLB emissive meshes',
        emitterDirection: 'lateral/outward',
        hiddenLegacyEmitterMeshes,
        zigguratMeshes: useAuthoredZiggurat ? authoredZigguratMeshCount : 4,
        continuousRamp: false,
        architecturalReference: 'assets/temple/ziggurat_architecture_reference.svg',
        stairTreads: stairCount,
        stairRise,
        stairRun,
        stairLandingDepth,
        stairWidth,
        stairFlights: stairProfile.length,
        stairLandings: stairProfile.filter((flight) => flight.landingBackZ !== null).length,
        stairProfile: stairProfile.map((flight) => ({ ...flight })),
        lapisTileInstances: lapisTiles.count,
        carnelianTileInstances: carnelianTiles.count,
        summitPylons: 0,
        detachedSummitFixtures: 0,
        pairedHdrEmitters: true,
        physicalSummitLights: summitLights.length,
        depthTestedBeamVolumes: beams.length,
        gradientBeamVolumes: beams.filter((beam) => beam.material?.userData?.gradient).length,
        beamLength,
        longRangeSpotLights: summitLights.length,
        spotlightRange: 600,
        mappedFixtureMetalPbr: Boolean(fixtureMetal.userData.pbrMaps),
        fixtureMetalPbrReady,
        mappedRailMetalPbr: Boolean(railMetal.userData.pbrMaps),
        userRailOpenSurfaceSeamsPreserved: true,
        userRailDoubleSided: userRailSandstone.side === T3.DoubleSide,
        mappedDaisMetalPbr: Boolean(daisMetal.userData.pbrMaps),
        fixtureMetalSource: fixtureMetal.userData.pbrSource,
        fixtureMetalSeparateChannels: fixtureMetal.userData.pbrMaps?.separateChannelTextures === true,
        mappedFastenerMetalPbr: Boolean(fastenerMetal.userData.pbrMaps),
        fastenerTreatment: '176 Metal010-normal-mapped recessed RGBA decals; 0.090 m visible diameter on 0.235 m, 5 mm-proud support plates',
        orbBlueEmitterHex: '#007cff',
        panelCornerFasteners: authoredPanelCornerFasteners,
        perimeterInstances: placedPerimeter.length,
        perimeterMaterialDeduplicated: true,
        authoredPerimeterScale: 1,
        perimeterSocketPitch: bay,
        perimeterBaseY,
        perimeterGrammar,
        wallSocketInset: {
            gatePost: 2,
            standalonePillar: 2,
            watchtower: 4,
        },
        pbrMaps: {
            albedo: !!maps.albedo,
            normal: !!maps.normal,
            roughness: !!maps.roughness,
            ao: !!maps.ao,
            displacementAssetAvailable: !!maps.displacement,
        },
    };

    const setQuality = (quality = 'balanced') => {
        // API-compatibility no-op: sky quality never changes architecture.
        group.userData.quality = 'authored';
        group.userData.requestedSkyQuality = quality;
        group.userData.fullStonePbr = true;
    };

    const setTime = (hours = 10.5) => {
        const numeric = Number(hours);
        if (!Number.isFinite(numeric)) return templeHours;
        templeHours = ((numeric % 24) + 24) % 24;
        targetNightLevel = nightForHours(templeHours);
        group.userData.timeHours = templeHours;
        return templeHours;
    };

    // The curb stones beside the processional stairs, modelled as what they
    // are: elongated boxes. Flight curbs are ramps whose top runs parallel to
    // the flight slope 0.48 m above it; landing/summit prisms top out ~0.52 m
    // over their landings. Returns the curb TOP at a local z, or null where
    // no curb exists. X extents are shared constants used by both the walk
    // surface (top) and resolveCamera (side faces).
    const CURB_INNER_X = stairWidth * 0.5 - 0.04;
    // +0.78: reaches past the stone into the channel slit so nothing
    // walkable dead-ends into a fall-through gap beside the stairs.
    const CURB_OUTER_X = stairWidth * 0.5 + 0.78;
    const curbTopLocalAt = (z) => {
        for (const flight of stairProfile) {
            if (z <= flight.frontZ + 0.001 && z >= flight.backZ - 0.001) {
                const run = flight.frontZ - flight.backZ;
                const t = run > 1e-6 ? (flight.frontZ - z) / run : 0;
                return flight.frontY + (flight.backY - flight.frontY) * t + 0.48;
            }
            if (flight.landingBackZ !== null
                && z < flight.backZ
                && z >= flight.landingBackZ - 0.001) {
                return flight.backY + 0.52;
            }
        }
        if (z <= stairBackZ + 0.001 && z >= 4.75 - 0.001) return stairTopY + 0.52;
        return null;
    };

    const stairSurfaceLocalHeight = (x, z) => {
        if (Math.abs(x) > stairWidth * 0.5) return null;
        if (z < stairBackZ - 0.001 || z > stairFrontZ + 0.001) return null;
        for (const flight of stairProfile) {
            if (z <= flight.frontZ + 0.001 && z >= flight.backZ - 0.001) {
                const run = (flight.frontZ - flight.backZ) / flight.steps;
                const rise = (flight.backY - flight.frontY) / flight.steps;
                const distance = Math.max(0, Math.min(
                    flight.frontZ - flight.backZ - 0.00001,
                    flight.frontZ - z,
                ));
                const index = Math.max(0, Math.min(
                    flight.steps - 1,
                    Math.floor(distance / run),
                ));
                return flight.frontY + (index + 1) * rise;
            }
            if (flight.landingBackZ !== null
                && z < flight.backZ
                && z >= flight.landingBackZ - 0.001) {
                return flight.backY;
            }
        }
        return null;
    };

    /**
     * Highest authored walkable surface at a world-space X/Z coordinate.
     * Returns null outside the temple architecture so callers can fall back
     * to terrain. Stair values are quantized to the exact visible tread tops.
     *
     * The richer surface record is also the narrow authorization contract for
     * the Inanna dais climb. No other wall/tier can opt into assisted stepping.
     */
    const walkSurfaceAt = (worldX, worldZ) => {
        const x = Number(worldX) - group.position.x;
        const z = Number(worldZ) - group.position.z;
        if (!Number.isFinite(x) || !Number.isFinite(z)) return null;
        // Navigation/floor queries run every explorer frame. Reject the
        // complete temple outside one small local envelope before walking the
        // authored tread/terrace lists.
        const walkHalfX = tiers[0].bottom[0] * 0.5 + 1.0;
        const walkBackZ = -tiers[0].bottom[1] * 0.5 - 1.0;
        const walkFrontZ = Math.max(
            tiers[0].bottom[1] * 0.5,
            stairFrontZ,
        ) + 1.0;
        if (Math.abs(x) > walkHalfX || z < walkBackZ || z > walkFrontZ) return null;

        let bestSurface = null;
        const consider = (localHeight, kind, metadata = null) => {
            if (!Number.isFinite(localHeight)) return;
            if (bestSurface && localHeight <= bestSurface.localHeight + 1e-5) return;
            bestSurface = {
                localHeight,
                kind,
                ...(metadata ?? {}),
            };
        };

        const stairHeight = stairSurfaceLocalHeight(x, z);
        consider(stairHeight, 'ziggurat_stair');

        // STAIR EDGE CURBS — each is literally a rotated elongated box (the
        // flight ramps) or a prism (landings/summit). The walkable TOP follows
        // the authored slope like a ramp.
        const onCurbBand = Math.abs(x) >= CURB_INNER_X && Math.abs(x) <= CURB_OUTER_X;
        const curbTop = onCurbBand ? curbTopLocalAt(z) : null;
        if (curbTop !== null) consider(curbTop, 'ziggurat_stair_curb');

        for (const surface of authoredWalkSurfaces) {
            if (x >= surface.minX && x <= surface.maxX
                && z >= surface.minZ && z <= surface.maxZ) {
                consider(surface.y, `authored_${surface.name}`);
            }
        }

        const radial = Math.hypot(x, z);
        const upperTop = summitY + plinthLowerHeight + plinthUpperHeight;
        if (radial <= 3.3) {
            consider(upperTop, 'inanna_dais_upper', {
                assistedStep: true,
                entryRise: plinthUpperHeight,
                maxAssistedRise: 0.80,
                entryRadius: 3.3,
                entryCenterX: group.position.x,
                entryCenterZ: group.position.z,
            });
        }
        else if (radial <= 4.5) {
            consider(summitY + plinthLowerHeight, 'inanna_dais_lower', {
                assistedStep: true,
                entryRise: plinthLowerHeight,
                maxAssistedRise: 1.12,
                entryRadius: 4.5,
                entryCenterX: group.position.x,
                entryCenterZ: group.position.z,
            });
        }

        // Test highest-to-lowest outside the boolean-cut processional channel.
        // Within it, the exact tread/landing value must win; allowing a tier
        // footprint to max() over a visible step created a hidden 0.40 m jump.
        // The curb band is part of the processional channel: while a curb
        // surface exists, the tier footprints (whose rectangles extend under
        // the channel cut) must not hijack the walk surface — exactly the
        // same guard the treads get via stairHeight. Without this, walking
        // up a curb slammed into an “invisible wall” (the tier top) at
        // every tier boundary the curb crosses.
        if (stairHeight === null && curbTop === null) {
            for (let index = terraceProfiles.length - 1; index >= 0; index--) {
                const terrace = terraceProfiles[index];
                // +0.28: the integrated terrace CORNICE projects 0.28 m past
                // every tier top (width/depth + 0.56 blocks, tops ~flush with
                // the terrace). Without it the lip was visible stone with no
                // surface record — stepping onto it dropped the player clean
                // through the cornice down the tier face.
                if (Math.abs(x) <= terrace.width * 0.5 + 0.28
                    && Math.abs(z) <= terrace.depth * 0.5 + 0.28) {
                    consider(terrace.y, `ziggurat_terrace_${index + 1}`);
                    break;
                }
            }
        }
        if (!bestSurface) return null;
        return {
            ...bestSurface,
            height: group.position.y + bestSurface.localHeight,
        };
    };
    const walkSurfaceHeightAt = (worldX, worldZ) => (
        walkSurfaceAt(worldX, worldZ)?.height ?? null
    );
    const walkSurfaceTypeAt = (worldX, worldZ, footY = null) => {
        const surface = walkSurfaceAt(worldX, worldZ);
        if (!surface) return null;
        if (Number.isFinite(footY)) {
            if (Math.abs(Number(footY) - surface.height) > 0.45) return null;
        }
        return 'stone';
    };
    const heightAt = walkSurfaceHeightAt;

    const collisionScratch = new T3.Vector3();
    const previousScratch = new T3.Vector3();
    const worldScratch = new T3.Vector3();
    const cameraClearance = 0.42;
    const orbCollisionRadius = 4.9 * 0.5 + 0.34;
    const physicsStreamConfig = Object.freeze({
        activationDistance: 7.0,
        releaseDistance: 9.5,
    });
    const physicsStream = {
        mode: 'per-component-close-proximity-broadphase',
        config: physicsStreamConfig,
        active: { ziggurat: false, walls: false, orb: false },
        activations: { ziggurat: 0, walls: 0, orb: 0 },
        deactivations: { ziggurat: 0, walls: 0, orb: 0 },
        narrowphaseChecks: { ziggurat: 0, walls: 0, orb: 0 },
        lastDistance: { ziggurat: Infinity, walls: Infinity, orb: Infinity },
    };
    group.userData.physicsStreaming = physicsStream;
    const distanceToRectangle = (x, z, halfX, halfZ) => Math.hypot(
        Math.max(0, Math.abs(x) - halfX),
        Math.max(0, Math.abs(z) - halfZ),
    );
    const distanceToSegment = (x, z, ax, az, bx, bz) => {
        const abx = bx - ax;
        const abz = bz - az;
        const lengthSq = abx * abx + abz * abz;
        const along = lengthSq > 0
            ? Math.max(0, Math.min(1, ((x - ax) * abx + (z - az) * abz) / lengthSq))
            : 0;
        return Math.hypot(x - (ax + abx * along), z - (az + abz * along));
    };
    const distanceToVerticalRange = (value, minimum, maximum) => (
        value < minimum ? minimum - value : value > maximum ? value - maximum : 0
    );
    const wallDistanceAt = (point) => {
        const horizontal = Math.min(
            distanceToSegment(point.x, point.z, -sideX, frontZ, sideX, frontZ),
            distanceToSegment(point.x, point.z, -sideX, backZ, sideX, backZ),
            distanceToSegment(point.x, point.z, -sideX, backZ, -sideX, frontZ),
            distanceToSegment(point.x, point.z, sideX, backZ, sideX, frontZ),
        );
        const vertical = distanceToVerticalRange(
            point.y,
            perimeterBaseY - 0.55,
            perimeterBaseY + 7.55,
        );
        return Math.hypot(horizontal, vertical);
    };
    const zigguratDistanceAt = (point) => {
        const horizontal = distanceToRectangle(
            point.x,
            point.z,
            tiers[0].bottom[0] * 0.5,
            tiers[0].bottom[1] * 0.5,
        );
        const vertical = distanceToVerticalRange(
            point.y,
            foundationBottom - 0.5,
            summitY + plinthLowerHeight + plinthUpperHeight + 0.72,
        );
        return Math.hypot(horizontal, vertical);
    };
    const orbDistanceAt = (point) => Math.max(0, Math.hypot(
        point.x - orbPivot.position.x,
        point.y - orbPivot.position.y,
        point.z - orbPivot.position.z,
    ) - orbCollisionRadius);
    const updatePhysicsActivation = (kind, distance) => {
        const wasActive = physicsStream.active[kind];
        const threshold = wasActive
            ? physicsStreamConfig.releaseDistance
            : physicsStreamConfig.activationDistance;
        const active = distance <= threshold;
        physicsStream.lastDistance[kind] = distance;
        if (active !== wasActive) {
            physicsStream.active[kind] = active;
            const counter = active ? physicsStream.activations : physicsStream.deactivations;
            counter[kind] += 1;
        }
        return active;
    };
    const resolveCamera = (camera, previousPosition = null) => {
        if (disposed || !camera?.position?.isVector3) {
            return {
                collided: false,
                gateBlocked: false,
                orbBlocked: false,
                zigguratBlocked: false,
            };
        }
        group.updateWorldMatrix(true, false);
        collisionScratch.copy(camera.position);
        group.worldToLocal(collisionScratch);
        const entryLocalX = collisionScratch.x;
        const entryLocalZ = collisionScratch.z;
        const previousValue = previousPosition?.position ?? previousPosition;
        const hasPrevious = Boolean(previousValue?.isVector3);
        if (hasPrevious) {
            previousScratch.copy(previousValue);
            group.worldToLocal(previousScratch);
        }
        const nearestDistance = (measure) => {
            const currentDistance = measure(collisionScratch);
            return hasPrevious
                ? Math.min(currentDistance, measure(previousScratch))
                : currentDistance;
        };
        const zigguratPhysicsActive = updatePhysicsActivation(
            'ziggurat',
            nearestDistance(zigguratDistanceAt),
        );
        const wallsPhysicsActive = updatePhysicsActivation(
            'walls',
            nearestDistance(wallDistanceAt),
        );
        const orbPhysicsActive = updatePhysicsActivation(
            'orb',
            nearestDistance(orbDistanceAt),
        );

        let collided = false;
        let gateBlocked = false;
        let orbBlocked = false;
        let zigguratBlocked = false;
        const previousSide = (value, center, fallback) => {
            if (hasPrevious && Math.abs(value - center) > 0.0001) {
                return Math.sign(value - center);
            }
            return Math.sign(fallback - center) || 1;
        };
        const resolveZBand = (center, halfThickness) => {
            const extent = halfThickness + cameraClearance;
            if (Math.abs(collisionScratch.z - center) >= extent) return false;
            const source = hasPrevious ? previousScratch.z : collisionScratch.z;
            const side = previousSide(source, center, collisionScratch.z);
            collisionScratch.z = center + side * extent;
            collided = true;
            return true;
        };
        const resolveXBand = (center, halfThickness) => {
            const extent = halfThickness + cameraClearance;
            if (Math.abs(collisionScratch.x - center) >= extent) return false;
            const source = hasPrevious ? previousScratch.x : collisionScratch.x;
            const side = previousSide(source, center, collisionScratch.x);
            collisionScratch.x = center + side * extent;
            collided = true;
            return true;
        };

        // Prevent walking through the solid tier masses while retaining
        // the complete central stair corridor. Players already on a terrace
        // have eye height above that tier's top and are not pushed away.
        if (zigguratPhysicsActive) {
            physicsStream.narrowphaseChecks.ziggurat += 1;
            const inStairCorridor = Math.abs(collisionScratch.x) <= CURB_OUTER_X + 0.10
                && collisionScratch.z >= stairBackZ - 0.35
                && collisionScratch.z <= stairFrontZ + 0.35;
            // Use the lower of prior/candidate eye heights. Some controllers
            // snap to heightAt before collision; relying only on that raised
            // candidate would let a vertical tier side teleport onto its roof.
            const tierCollisionEyeY = hasPrevious
                ? Math.min(collisionScratch.y, previousScratch.y)
                : collisionScratch.y;
            if (!inStairCorridor) {
                for (let index = tiers.length - 1; index >= 0; index--) {
                const tier = tiers[index];
                const top = tier.base + tier.height;
                if (tierCollisionEyeY > top + 0.72
                    || tierCollisionEyeY < tier.base - 0.5) continue;
                const hx = tier.bottom[0] * 0.5 + cameraClearance;
                const hz = tier.bottom[1] * 0.5 + cameraClearance;
                if (Math.abs(collisionScratch.x) >= hx
                    || Math.abs(collisionScratch.z) >= hz) continue;

                const previousOutsideX = hasPrevious && Math.abs(previousScratch.x) >= hx;
                const previousOutsideZ = hasPrevious && Math.abs(previousScratch.z) >= hz;
                const distanceX = hx - Math.abs(collisionScratch.x);
                const distanceZ = hz - Math.abs(collisionScratch.z);
                if (previousOutsideX || (!previousOutsideZ && distanceX < distanceZ)) {
                    const sign = hasPrevious
                        ? (Math.sign(previousScratch.x) || Math.sign(collisionScratch.x) || 1)
                        : (Math.sign(collisionScratch.x) || 1);
                    collisionScratch.x = sign * hx;
                } else {
                    const sign = hasPrevious
                        ? (Math.sign(previousScratch.z) || Math.sign(collisionScratch.z) || 1)
                        : (Math.sign(collisionScratch.z) || 1);
                    collisionScratch.z = sign * hz;
                }
                collided = true;
                zigguratBlocked = true;
                break;
                }
            }
            // Stair curbs need no side collision: their sloped tops are
            // ordinary walk surfaces (one angled box per flight) and the walk
            // step limit covers stepping onto them like a ramp edge.
        }

        // The authored perimeter is seven metres tall. Above it, free-flight
        // cameras are not constrained. At walking height, walls and towers
        // form continuous bands; only the real central gate aperture can open.
        const withinPerimeterHeight = collisionScratch.y >= perimeterBaseY - 0.55
            && collisionScratch.y <= perimeterBaseY + 7.55;
        if (wallsPhysicsActive && withinPerimeterHeight) {
            physicsStream.narrowphaseChecks.walls += 1;
            const absX = Math.abs(collisionScratch.x);
            const openingHalf = gateDoorSize.z * 0.5 - cameraClearance;
            const withinCompoundWidth = absX <= sideX + 4.5;
            if (withinCompoundWidth
                && absX >= openingHalf
                && Math.abs(collisionScratch.z - frontZ) < 2.0 + cameraClearance) {
                resolveZBand(frontZ, 2.0);
            }

            const currentDoorBottom = gateDoorClosedBottomLocal - gateProgress * gateDoorTravel;
            const currentDoorTop = gateDoorClosedTopLocal - gateProgress * gateDoorTravel;
            const doorIntersectsCamera = collisionScratch.y + 0.22 >= currentDoorBottom
                && collisionScratch.y - 0.22 <= currentDoorTop;
            if (absX < openingHalf
                && doorIntersectsCamera
                && Math.abs(collisionScratch.z - frontZ)
                    < gateDoorSize.x * 0.5 + cameraClearance) {
                if (resolveZBand(frontZ, gateDoorSize.x * 0.5)) gateBlocked = true;
            }

            if (absX <= sideX + 4.5
                && Math.abs(collisionScratch.z - backZ) < 2.0 + cameraClearance) {
                resolveZBand(backZ, 2.0);
            }
            if (collisionScratch.z >= backZ - 4.4
                && collisionScratch.z <= frontZ + 4.4) {
                if (Math.abs(collisionScratch.x - sideX) < 2.0 + cameraClearance) {
                    resolveXBand(sideX, 2.0);
                }
                if (Math.abs(collisionScratch.x + sideX) < 2.0 + cameraClearance) {
                    resolveXBand(-sideX, 2.0);
                }
            }
        }

        // The Inanna GLB is normalized to a 4.9 m sphere. Resolve in full 3D
        // so neither walking nor free-flight cameras can pass through it.
        if (orbPhysicsActive) {
            physicsStream.narrowphaseChecks.orb += 1;
            let dx = collisionScratch.x - orbPivot.position.x;
            let dy = collisionScratch.y - orbPivot.position.y;
            let dz = collisionScratch.z - orbPivot.position.z;
            let distance = Math.hypot(dx, dy, dz);
            if (distance < orbCollisionRadius) {
                if (distance < 0.0001 && hasPrevious) {
                    dx = previousScratch.x - orbPivot.position.x;
                    dy = previousScratch.y - orbPivot.position.y;
                    dz = previousScratch.z - orbPivot.position.z;
                    distance = Math.hypot(dx, dy, dz);
                }
                if (distance < 0.0001) {
                    dx = 1;
                    dy = 0;
                    dz = 0;
                    distance = 1;
                }
                const scale = orbCollisionRadius / distance;
                collisionScratch.set(
                    orbPivot.position.x + dx * scale,
                    orbPivot.position.y + dy * scale,
                    orbPivot.position.z + dz * scale,
                );
                collided = true;
                orbBlocked = true;
            }
        }

        if (collided) {
            // ANTI-TELEPORT RESOLUTION RULE: a resolver may UNDO this frame's
            // motion (push you back out the way you came, incl. full expulsion
            // of an embedded spawn) but may never fling you farther than you
            // travelled plus a small slack. A genuine contact resolves within
            // centimetres of the approach path and passes untouched; a
            // misread previous-side (corner grazes, stale previous) that
            // would land the camera on the OPPOSITE face of a tier — a
            // many-metre horizontal teleport — gets clamped to a nudge and
            // settles over the following frames instead.
            const referenceX = hasPrevious ? previousScratch.x : entryLocalX;
            const referenceZ = hasPrevious ? previousScratch.z : entryLocalZ;
            const travel = hasPrevious
                ? Math.hypot(entryLocalX - previousScratch.x, entryLocalZ - previousScratch.z)
                : 0;
            const resolveCap = travel + 0.6;
            const pushX = collisionScratch.x - referenceX;
            const pushZ = collisionScratch.z - referenceZ;
            const pushLength = Math.hypot(pushX, pushZ);
            if (pushLength > resolveCap) {
                const clampScale = resolveCap / pushLength;
                collisionScratch.x = referenceX + pushX * clampScale;
                collisionScratch.z = referenceZ + pushZ * clampScale;
            }
            worldScratch.copy(collisionScratch);
            group.localToWorld(worldScratch);
            camera.position.copy(worldScratch);
        }
        const result = {
            collided,
            gateBlocked,
            orbBlocked,
            zigguratBlocked,
            physicsActive: { ...physicsStream.active },
            physicsDistance: { ...physicsStream.lastDistance },
        };
        group.userData.lastCameraResolve = result;
        return result;
    };

    group.userData.navigation = {
        stairFrontZ,
        stairBackZ,
        stairCount,
        stairRise,
        stairRun,
        stairLandingDepth,
        stairProfile: stairProfile.map((flight) => ({ ...flight })),
        heightApi: 'walkSurfaceHeightAt',
        surfaceApi: 'walkSurfaceAt',
        surfaceTypeApi: 'walkSurfaceTypeAt',
        assistedStepKinds: ['inanna_dais_lower', 'inanna_dais_upper'],
        cameraResolver: true,
        physicsStreaming: {
            ...physicsStreamConfig,
            components: ['ziggurat', 'walls', 'orb'],
        },
    };

    return {
        group,
        setQuality,
        setTime,
        heightAt,
        walkSurfaceAt,
        walkSurfaceHeightAt,
        walkSurfaceTypeAt,
        resolveCamera,
        get gateProgress() { return gateProgress; },
        get nightLevel() { return nightLevel; },
        state: {
            get gateProgress() { return gateProgress; },
            get gateTarget() { return gateTarget; },
            get nightLevel() { return nightLevel; },
            get timeHours() { return templeHours; },
        },
        update(t = 0, camera = null, dt = undefined) {
            if (disposed) return;
            if (typeof camera === 'number' && dt === undefined) {
                dt = camera;
                camera = null;
            }
            let delta = Number(dt);
            if (!Number.isFinite(delta)) {
                delta = lastTempleUpdateTime === null
                    ? (1 / 60)
                    : Number(t) - lastTempleUpdateTime;
            }
            delta = Math.max(0, Math.min(0.1, Number.isFinite(delta) ? delta : (1 / 60)));
            lastTempleUpdateTime = Number.isFinite(Number(t)) ? Number(t) : lastTempleUpdateTime;

            orbPivot.position.y = orbBaseY + Math.sin(t * 0.42) * 0.06;
            orbPivot.rotation.y = t * 0.075;
            syncSphereEmitters();

            if (camera?.position?.isVector3) {
                collisionScratch.copy(camera.position);
                group.worldToLocal(collisionScratch);
                const gateDx = Math.abs(collisionScratch.x);
                const gateDz = Math.abs(collisionScratch.z - frontZ);
                const openZone = gateDx < 14.5 && gateDz < 16.0;
                const holdZone = gateDx < 19.0 && gateDz < 22.0;
                if (openZone) {
                    gateTarget = 1;
                    gateCloseDelay = 1.35;
                } else if (gateTarget > 0.5 && holdZone) {
                    gateCloseDelay = Math.max(gateCloseDelay, 0.28);
                } else if (gateCloseDelay > 0) {
                    gateCloseDelay = Math.max(0, gateCloseDelay - delta);
                } else {
                    gateTarget = 0;
                }
            } else if (gateCloseDelay > 0) {
                gateCloseDelay = Math.max(0, gateCloseDelay - delta);
            } else {
                gateTarget = 0;
            }

            const gateBlend = 1 - Math.exp(-delta * (gateTarget > gateProgress ? 3.8 : 2.7));
            gateProgress += (gateTarget - gateProgress) * gateBlend;
            if (Math.abs(gateTarget - gateProgress) < 0.0005) gateProgress = gateTarget;
            gateDoor.position.copy(gateDoorClosedPosition);
            gateDoor.position.y -= gateProgress * gateDoorTravel;
            group.userData.gate.progress = gateProgress;
            group.userData.gate.target = gateTarget;
            group.userData.gate.closeDelay = gateCloseDelay;

            const nightBlend = 1 - Math.exp(-delta * 1.45);
            nightLevel += (targetNightLevel - nightLevel) * nightBlend;
            if (Math.abs(targetNightLevel - nightLevel) < 0.0002) nightLevel = targetNightLevel;
            applyNightLighting(Number(t) || 0);
        },
        dispose() {
            if (disposed) return;
            disposed = true;
            group.removeFromParent?.();
            group.clear();
            for (const prototype of prototypes) prototype.clear();
            for (const geometry of ownedGeometries) geometry.dispose?.();
            for (const material of ownedMaterials) material.dispose?.();
            for (const texture of ownedModelTextures) texture.dispose?.();
            ownedGeometries.clear();
            ownedMaterials.clear();
            ownedModelTextures.clear();
            prototypes.length = 0;
            placedPerimeter.length = 0;
        },
    };
}
