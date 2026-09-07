// SeedThree vegetation integration. Authored MSFT_lod levels are batched into
// one InstancedMesh per source mesh/level, so adding desert silhouettes does
// not turn into one draw call per plant. LOD membership is refreshed at a low
// cadence as the ground camera moves.

import {
    deinterleaveAttribute,
    mergeGeometries,
} from 'three/addons/utils/BufferGeometryUtils.js';
import {
    abs,
    float,
    fract,
    mix,
    mx_fractal_noise_float,
    normalViewGeometry,
    positionLocal,
    positionWorld,
    shadow,
    smoothstep,
    texture,
    uniform,
    uv,
    vec3,
} from 'three/tsl';
import { createVegetationCollisionStreamer, setConvexHullLibrary } from './vegetation_collision.js';

// Content revision prevents a browser from reusing a stale response if the
// checked-in layout is regenerated during development.
const VEGETATION_LAYOUT_URL = './assets/vegetation/desert_vegetation_layout_v1.json?v=c9c3e56c';
const VEGETATION_LAYOUT_FORMAT = 'eanpa-desert-vegetation-layout/1';
const VEGETATION_LAYOUT_COUNTS = Object.freeze({ saguaro: 760, joshua: 430 });
let bakedLayoutPromise = null;

const loadBakedVegetationLayout = () => {
    if (bakedLayoutPromise) return bakedLayoutPromise;
    bakedLayoutPromise = fetch(VEGETATION_LAYOUT_URL, { cache: 'force-cache' })
        .then((response) => {
            if (!response.ok) {
                throw new Error(
                    `Unable to load fixed vegetation layout (${response.status})`,
                );
            }
            return response.json();
        })
        .then((layout) => {
            if (layout?.format !== VEGETATION_LAYOUT_FORMAT || layout?.version !== 1) {
                throw new Error('Unsupported vegetation placement manifest');
            }
            for (const [species, expectedCount] of Object.entries(VEGETATION_LAYOUT_COUNTS)) {
                const placements = layout.species?.[species];
                if (!Array.isArray(placements) || placements.length !== expectedCount) {
                    throw new Error(
                        `Vegetation layout ${species} count is not ${expectedCount}`,
                    );
                }
                placements.forEach((placement, index) => {
                    if (!Array.isArray(placement)
                        || placement.length !== 5
                        || !placement.every(Number.isFinite)
                        || placement[2] <= 0) {
                        throw new Error(
                            `Invalid ${species} placement ${index} in fixed layout`,
                        );
                    }
                });
            }
            return layout;
        });
    return bakedLayoutPromise;
};

export async function makeVegetationScene(THREE, {
    terrain,
    saguaroGltf = null,
    joshuaGltf = null,
    sunLight = null,
    quality = 'balanced',
} = {}) {
    const T3 = THREE;
    const group = new T3.Group();
    group.name = 'seedthree_desert_vegetation';
    const placementLayout = await loadBakedVegetationLayout();
    group.userData.placementManifest = Object.freeze({
        url: VEGETATION_LAYOUT_URL,
        format: placementLayout.format,
        version: placementLayout.version,
        seed: placementLayout.seed,
        policy: placementLayout.policy.layout,
        counts: Object.freeze({ ...placementLayout.stats.counts }),
        spacing: Object.freeze({ ...placementLayout.stats.spacing }),
        sourceAssets: Object.freeze({ ...placementLayout.sourceAssets }),
    });
    const ownedInstances = new Set();
    const ownedGeometries = new Set();
    const ownedMaterials = new Set();
    const ownedTextures = new Set();
    const species = [];
    const collisionStreamer = createVegetationCollisionStreamer();
    // Baked CoACD hull sets (tools/build-collision-hulls.py): hard-stop
    // shapes decomposed from the ACTUAL render meshes. Non-fatal on 404 —
    // the authored capsule templates remain the working fallback, so a
    // missing bake degrades collision fidelity, never collision itself.
    const hullLibraryReady = fetch('./assets/collision/convex_hulls_v1.json', { cache: 'force-cache' })
        .then((response) => (response.ok ? response.json() : null))
        .then((data) => {
            if (!data?.species) return 0;
            const installed = setConvexHullLibrary(data.species);
            console.log(`[vegetation] convex hull library installed for ${installed} species keys`);
            return installed;
        })
        .catch(() => 0);
    const materialStats = {};
    const geometryStats = {};
    const diagnosticTargets = {
        saguaroSpines: [],
        saguaroSkin: [],
        saguaroLod2ShadowProxies: [],
        saguaroSkinMaterials: new Set(),
    };
    const diagnosticState = {
        spinesVisible: true,
        spinesCastShadow: true,
        lod2ProxyCastShadow: true,
        skinCastShadow: true,
        skinReceiveShadow: true,
        skinDoubleSided: false,
    };
    // Local vegetation is authored independently of the sky quality selector.
    // The balanced profile is the complete long-distance instanced population.
    let currentQuality = 'balanced';
    let lastUpdate = -Infinity;
    let dirty = true;
    let disposed = false;

    // SeedThree's Joshua hero meshes are exceptionally dense (214k/79k/36k
    // triangles per real LOD). Keep every authored instance and the long
    // billboard range, but reserve those real meshes for distances where
    // their silhouette can contribute. This profile never changes with the
    // public sky-quality selector.
    const authoredProfile = { cuts: [60, 160, 420], farCull: 1450, density: 1 };
    // LOD2 begins while plants can still sit inside the directional-light
    // shadow volume. Rendering its dense source meshes into the shadow map
    // would duplicate a large vertex workload, but dropping their shadows
    // entirely made the plants pop flat/bright at the LOD1 -> LOD2 cut. Reuse
    // the authored crossed-card LOD3 silhouette on a shadow-only camera layer.
    // The normal scene/SSR camera never enables this layer.
    const SHADOW_PROXY_LAYER = 3;
    const SHADOW_PROXY_TARGET_LOD = 2;
    const SHADOW_PROXY_SOURCE_LOD = 3;
    const scratchWorld = new T3.Matrix4();

    const terrainSeatHeight = (x, z, footprint) => Math.min(
        terrain?.heightAt?.(x, z) ?? 0,
        terrain?.heightAt?.(x + footprint, z) ?? 0,
        terrain?.heightAt?.(x - footprint, z) ?? 0,
        terrain?.heightAt?.(x, z + footprint) ?? 0,
        terrain?.heightAt?.(x, z - footprint) ?? 0,
        terrain?.heightAt?.(x + footprint * 0.72, z + footprint * 0.72) ?? 0,
        terrain?.heightAt?.(x - footprint * 0.72, z + footprint * 0.72) ?? 0,
        terrain?.heightAt?.(x + footprint * 0.72, z - footprint * 0.72) ?? 0,
        terrain?.heightAt?.(x - footprint * 0.72, z - footprint * 0.72) ?? 0,
    );

    // GLTFExporter stores every Joshua cone band as a separate indexed glTF
    // primitive, but each primitive references the same full POSITION/normal/
    // UV accessors. GLTFLoader therefore gives all 17 children a full 134k
    // vertex attribute even though each index references only its own band.
    // Compact before transform/merge so buffers contain only referenced
    // records. Indices, triangles, morphs, material roles and topology remain
    // byte-for-byte equivalent at the attribute-value level.
    const compactIndexedGeometry = (source) => {
        const sourceIndex = source.getIndex();
        if (!sourceIndex || !sourceIndex.count) return source;
        const remap = new Map();
        const referenced = [];
        const remapped = new Array(sourceIndex.count);
        for (let index = 0; index < sourceIndex.count; index++) {
            const oldIndex = sourceIndex.getX(index);
            let nextIndex = remap.get(oldIndex);
            if (nextIndex === undefined) {
                nextIndex = referenced.length;
                remap.set(oldIndex, nextIndex);
                referenced.push(oldIndex);
            }
            remapped[index] = nextIndex;
        }
        const cloneSubset = (sourceAttribute) => {
            const readable = sourceAttribute.isInterleavedBufferAttribute
                ? deinterleaveAttribute(sourceAttribute)
                : sourceAttribute;
            const values = new readable.array.constructor(
                referenced.length * readable.itemSize,
            );
            for (let index = 0; index < referenced.length; index++) {
                const from = referenced[index] * readable.itemSize;
                const to = index * readable.itemSize;
                values.set(readable.array.subarray(from, from + readable.itemSize), to);
            }
            const attribute = new T3.BufferAttribute(
                values,
                readable.itemSize,
                readable.normalized,
            );
            attribute.name = sourceAttribute.name;
            attribute.usage = sourceAttribute.usage;
            if (sourceAttribute.gpuType !== undefined) attribute.gpuType = sourceAttribute.gpuType;
            return attribute;
        };
        const compact = new T3.BufferGeometry();
        for (const [name, attribute] of Object.entries(source.attributes)) {
            compact.setAttribute(name, cloneSubset(attribute));
        }
        for (const [name, attributes] of Object.entries(source.morphAttributes)) {
            compact.morphAttributes[name] = attributes.map(cloneSubset);
        }
        compact.morphTargetsRelative = source.morphTargetsRelative;
        compact.userData = { ...source.userData };
        compact.name = source.name;
        const IndexArray = referenced.length > 65535 ? Uint32Array : Uint16Array;
        compact.setIndex(new T3.BufferAttribute(new IndexArray(remapped), 1));
        for (const groupEntry of source.groups) compact.addGroup(
            groupEntry.start,
            groupEntry.count,
            groupEntry.materialIndex,
        );
        compact.setDrawRange(source.drawRange.start, source.drawRange.count);
        source.dispose();
        return compact;
    };

    // SeedThree's generated branch junctions contain small, localized regions
    // whose triangle face points opposite the authored outward vertex normals.
    // With the opaque bark's intentional FrontSide material those regions are
    // culled from outside, leaving black branch-shaped holes beneath the leaf
    // skirts. Repair only strongly disagreeing, nondegenerate bark triangles;
    // positions and every vertex attribute remain byte-for-byte untouched.
    const JOSHUA_BARK_WINDING_THRESHOLD = -0.02;
    const repairIndexedWindingToAuthoredNormals = (geometry) => {
        const index = geometry.getIndex();
        const position = geometry.getAttribute('position');
        const normal = geometry.getAttribute('normal');
        const result = {
            threshold: JOSHUA_BARK_WINDING_THRESHOLD,
            repairedTriangles: 0,
            degenerateTriangles: 0,
            remainingStrongDisagreements: 0,
        };
        if (!index || !position || !normal) return result;

        for (let offset = 0; offset + 2 < index.count; offset += 3) {
            const ia = index.getX(offset);
            const ib = index.getX(offset + 1);
            const ic = index.getX(offset + 2);
            const abx = position.getX(ib) - position.getX(ia);
            const aby = position.getY(ib) - position.getY(ia);
            const abz = position.getZ(ib) - position.getZ(ia);
            const acx = position.getX(ic) - position.getX(ia);
            const acy = position.getY(ic) - position.getY(ia);
            const acz = position.getZ(ic) - position.getZ(ia);
            const faceX = aby * acz - abz * acy;
            const faceY = abz * acx - abx * acz;
            const faceZ = abx * acy - aby * acx;
            const normalX = normal.getX(ia) + normal.getX(ib) + normal.getX(ic);
            const normalY = normal.getY(ia) + normal.getY(ib) + normal.getY(ic);
            const normalZ = normal.getZ(ia) + normal.getZ(ib) + normal.getZ(ic);
            const faceLengthSq = faceX * faceX + faceY * faceY + faceZ * faceZ;
            const normalLengthSq = normalX * normalX + normalY * normalY + normalZ * normalZ;
            if (faceLengthSq <= 1e-24 || normalLengthSq <= 1e-24) {
                result.degenerateTriangles++;
                continue;
            }
            const alignment = (faceX * normalX + faceY * normalY + faceZ * normalZ)
                / Math.sqrt(faceLengthSq * normalLengthSq);
            let repairedAlignment = alignment;
            if (alignment < JOSHUA_BARK_WINDING_THRESHOLD) {
                index.setX(offset + 1, ic);
                index.setX(offset + 2, ib);
                result.repairedTriangles++;
                repairedAlignment = -alignment;
            }
            if (repairedAlignment < JOSHUA_BARK_WINDING_THRESHOLD) {
                result.remainingStrongDisagreements++;
            }
        }
        if (result.repairedTriangles) index.needsUpdate = true;
        return result;
    };

    const ownMaterialResources = (material) => {
        const materials = Array.isArray(material) ? material : [material];
        for (const item of materials) {
            if (!item) continue;
            ownedMaterials.add(item);
            for (const value of Object.values(item)) if (value?.isTexture) ownedTextures.add(value);
        }
    };

    // SeedThree's hero materials use TSL effects that glTF cannot serialize:
    // Joshua foliage picks green/dry/driest atlases from an instance-age
    // attribute, and saguaro skin blends clean/scarred PBR sets in world space.
    // The exported geometry still preserves one primitive per Joshua cone band,
    // so restore those authored roles here instead of flattening every primitive
    // into the single green export material.
    const supplementalLoader = new T3.TextureLoader();
    const loadSupplementalTexture = async (file, { srgb = false } = {}) => {
        try {
            const map = await supplementalLoader.loadAsync(`./assets/vegetation/materials/${file}`);
            map.name = file;
            map.flipY = false;
            map.wrapS = map.wrapT = T3.RepeatWrapping;
            map.anisotropy = 8;
            map.colorSpace = srgb ? T3.SRGBColorSpace : T3.NoColorSpace;
            map.needsUpdate = true;
            ownedTextures.add(map);
            return map;
        } catch (error) {
            console.warn(`[vegetation] Optional authored material map failed: ${file}`, error);
            return null;
        }
    };
    const [
        joshuaDry,
        joshuaDriest,
        joshuaTranslucency,
        saguaroSpineTranslucency,
        saguaroCleanAlbedo,
        saguaroCleanNormal,
        saguaroCleanRoughness,
    ] = await Promise.all([
        loadSupplementalTexture('yucca_rosette_dry_albedo.png', { srgb: true }),
        loadSupplementalTexture('yucca_rosette_dryest_albedo.png', { srgb: true }),
        loadSupplementalTexture('yucca_rosette_translucency.png'),
        loadSupplementalTexture('saguaro_spines_translucency.png'),
        loadSupplementalTexture('saguaro_skin_clean_albedo.png', { srgb: true }),
        loadSupplementalTexture('saguaro_skin_clean_normal.png'),
        loadSupplementalTexture('saguaro_skin_clean_roughness.png'),
    ]);

    const makeCutoutSssMaterial = (source, role, speciesName) => {
        const billboard = role === 'billboard';
        const isJoshua = speciesName === 'joshua';
        const isSpines = role === 'cactus_spines';
        const material = new T3.MeshSSSNodeMaterial({
            map: source.map ?? null,
            alphaMap: source.alphaMap ?? null,
            normalMap: source.normalMap ?? null,
            roughnessMap: source.roughnessMap ?? null,
            aoMap: source.aoMap ?? null,
            color: source.color?.clone?.() ?? 0xffffff,
            roughness: Math.max(0.82, source.roughness ?? 1),
            metalness: 0,
            side: T3.DoubleSide,
            alphaTest: Math.max(0.35, source.alphaTest ?? 0),
            transparent: false,
        });
        if (source.normalScale && material.normalScale) material.normalScale.copy(source.normalScale);
        if (isJoshua && !billboard) {
            // The authored rosette shells contain both winding directions in
            // every mesh LOD, while their deliberately bent vertex normals
            // point up through each whole rosette for soft canopy lighting.
            // Supplying that authored normal directly bypasses DoubleSide's
            // winding-dependent frontFacing sign. Never turn it toward the
            // camera: a ground-level view otherwise flips almost the complete
            // crown downward and removes its direct-sun response.
            material.normalNode = normalViewGeometry.normalize();
            material.userData.twoSidedNormal = {
                source: 'authored-vertex-normal',
                orientation: 'unflipped-independent-of-winding',
                tangentNormalMap: false,
            };
        }

        // Restore SeedThree's Barré-Brisebois thin-material response instead
        // of either a full unshadowed transmission lobe (the old neon look)
        // or no transmission at all (the current crushed-black undersides).
        let thicknessMask;
        if (!billboard && isJoshua && joshuaTranslucency) {
            thicknessMask = texture(joshuaTranslucency).r;
        } else if (!billboard && isSpines && saguaroSpineTranslucency) {
            thicknessMask = texture(saguaroSpineTranslucency).r;
        } else if (source.map) {
            // The exported LOD3 cards have a baked, aligned alpha silhouette;
            // using it avoids projecting an unrelated leaf-atlas mask.
            thicknessMask = texture(source.map).a;
        } else {
            thicknessMask = float(1);
        }

        let transmitColor;
        if (isSpines) {
            transmitColor = new T3.Color().setRGB(0.86, 0.78, 0.42);
        } else if (role === 'joshua_dry') {
            transmitColor = new T3.Color().setRGB(0.11, 0.075, 0.028);
        } else if (role === 'joshua_driest') {
            transmitColor = new T3.Color().setRGB(0.06, 0.045, 0.028);
        } else if (isJoshua) {
            transmitColor = new T3.Color().setRGB(0.10, 0.13, 0.03);
        } else {
            transmitColor = new T3.Color().setRGB(0.20, 0.17, 0.08);
        }
        let thickness = uniform(transmitColor).mul(thicknessMask);
        if (isSpines && sunLight?.shadow) {
            // SeedThree's original fix: the cactus body shadow must suppress
            // transmission on the far side, leaving only the real sunlit rim.
            thickness = thickness.mul(shadow(sunLight, sunLight.shadow));
        }
        material.thicknessColorNode = thickness;
        material.thicknessDistortionNode = uniform(isSpines ? 0.35 : 0.2);
        material.thicknessAmbientNode = uniform(billboard ? 0.008 : 0.015);
        material.thicknessAttenuationNode = uniform(1);
        material.thicknessPowerNode = uniform(isSpines ? 5 : 8);
        material.thicknessScaleNode = uniform(billboard ? 0.55 : isSpines ? 2.2 : 1.2);
        material.userData.vegetationSss = {
            recipe: 'SeedThree MeshSSSNodeMaterial',
            perTexel: Boolean((isJoshua && joshuaTranslucency)
                || (isSpines && saguaroSpineTranslucency)
                || source.map),
            shadowGated: Boolean(isSpines && sunLight?.shadow),
            ambientFloor: billboard ? 0.008 : 0.015,
        };
        return material;
    };

    const makeSaguaroSkinMaterial = (source) => {
        if (!source?.map || !saguaroCleanAlbedo) return source.clone();
        const cleanRoughness = saguaroCleanRoughness ?? source.roughnessMap;
        const damagedRoughness = source.roughnessMap ?? cleanRoughness;
        const material = new T3.MeshStandardNodeMaterial({
            map: source.map,
            normalMap: saguaroCleanNormal ?? source.normalMap ?? null,
            roughnessMap: damagedRoughness ?? null,
            color: 0xffffff,
            roughness: 1,
            metalness: 0,
        });

        // This is SeedThree's authored bark-damage recipe. positionWorld includes
        // the InstancedMesh transform, giving each cactus a different, broad
        // healthy/scarred distribution without adding instance attributes.
        const cleanAlbedoNode = texture(saguaroCleanAlbedo);
        const damagedAlbedoNode = texture(source.map);
        // Project the scar field in plant-local 3D space. The previous mask
        // was dominated by world Y, so all front-facing fragments at a given
        // height agreed and produced an implausible dark belt around the
        // trunk. Intersecting a broad local blotch with a second, finer local
        // field makes damage occupy bounded patches on individual ribs while
        // the low-frequency world offset still varies the pattern per plant.
        const plantVariation = positionWorld.mul(vec3(0.035, 0.012, 0.035));
        const macroNoise = mx_fractal_noise_float(
            positionLocal.mul(vec3(2.4, 0.72, 2.4)).add(plantVariation),
            3, 2, 0.5, 1,
        );
        const detailNoise = mx_fractal_noise_float(
            positionLocal.mul(vec3(7.5, 1.45, 7.5))
                .add(plantVariation.mul(2.7))
                .add(vec3(17.3, -4.1, 9.7)),
            3, 2, 0.5, 1,
        );
        const macroPatch = smoothstep(0.62, 0.82, macroNoise);
        const detailPatch = smoothstep(0.54, 0.77, detailNoise);
        // Even at the center of a scar, retain most of the clean skin texture
        // and normal response instead of replacing the cactus with black bark.
        const damageMask = macroPatch.mul(detailPatch).mul(0.28);
        const blended = mix(cleanAlbedoNode.rgb, damagedAlbedoNode.rgb, damageMask);
        const crestTriangle = float(1).sub(abs(fract(uv().x.mul(4)).sub(0.5)).mul(2));
        const crestMask = smoothstep(0.62, 0.92, crestTriangle).mul(0.45);
        material.colorNode = mix(
            blended,
            blended.mul(vec3(1.18, 1.15, 1.02)).add(vec3(0.06, 0.055, 0.04)),
            crestMask,
        );
        if (cleanRoughness && damagedRoughness) {
            material.roughnessNode = mix(
                texture(cleanRoughness).r,
                texture(damagedRoughness).r,
                damageMask,
            );
        }
        material.name = 'Saguaro_Skin_HealthyDamageBlend';
        material.userData.vegetationMaterialRole = 'healthy_damage_skin';
        material.userData.damageBlend = {
            projection: 'plant-local-3d-intersection',
            macroFrequency: 'local-xz-2.4x/local-y-0.72x',
            detailFrequency: 'local-xz-7.5x/local-y-1.45x',
            maximumScarBlend: 0.28,
        };
        return material;
    };

    const findLodRoots = (scene) => {
        const roots = [];
        scene.updateWorldMatrix(true, true);
        scene.traverse((object) => {
            const match = /_LOD([0-3])$/i.exec(object.name ?? '');
            if (match) roots[Number(match[1])] = object;
        });
        return roots.filter(Boolean);
    };

    const buildSpecies = (name, gltf, placementDefs, distanceScale = 1) => {
        if (!gltf?.scene || !placementDefs.length) return;
        const roots = findLodRoots(gltf.scene);
        if (!roots.length) return;
        const materialCache = new Map();
        const roleCounts = new Map();
        const barkWindingRepairs = [];
        let sourceVertexRecords = 0;
        let compactedVertexRecords = 0;
        const prepareMaterial = (sourceMaterial, meshName = '', role = 'default') => {
            const sourceList = Array.isArray(sourceMaterial) ? sourceMaterial : [sourceMaterial];
            const prepared = sourceList.map((source) => {
                const cutout = (source.alphaTest ?? 0) > 0 || source.transparent;
                const billboard = /billboard/i.test(meshName);
                const key = `${source.uuid}:${cutout ? 'cutout' : 'solid'}:${billboard ? 'billboard' : 'mesh'}:${role}`;
                if (materialCache.has(key)) return materialCache.get(key);
                const useSss = cutout && (
                    role === 'billboard'
                    || role === 'cactus_spines'
                    || role.startsWith('joshua_')
                );
                const material = role === 'healthy_damage_skin'
                    ? makeSaguaroSkinMaterial(source)
                    : useSss
                        ? makeCutoutSssMaterial(source, role, name)
                        : source.clone();
                material.metalness = 0;
                material.roughness = cutout ? 1 : Math.max(0.82, material.roughness ?? 1);
                material.envMapIntensity = cutout ? 0.16 : 0.34;
                material.emissive?.set?.(0x000000);
                material.emissiveIntensity = 0;
                material.toneMapped = true;
                if (role === 'joshua_dry' && joshuaDry) material.map = joshuaDry;
                if (role === 'joshua_driest' && joshuaDriest) material.map = joshuaDriest;
                if (cutout) {
                    // The exported KHR diffuse-transmission lobe has no source
                    // shadow node in this forward scene. Keep the real alpha,
                    // normal and roughness maps, but use naturally dark PBR
                    // reflectance instead of a full-strength glowing lobe.
                    // Preserve the real atlas colors. The former blanket green/
                    // tan multiplier recolored dry Joshua skirts and baked
                    // billboards, even when their textures were already correct.
                    material.color?.set?.(0xffffff);
                    material.alphaTest = Math.max(0.35, material.alphaTest ?? 0);
                    material.alphaToCoverage = true;
                    material.transparent = false;
                    material.depthWrite = true;
                    material.side = T3.DoubleSide;
                    // Thin foliage/spines may become wet, but their authored
                    // upward/bent normals are not a horizontal ground plane.
                    material.userData.noPuddles = true;
                    // MeshSSSNodeMaterial handles a calibrated, per-texel,
                    // light-driven lobe. Disable only the unrelated refractive
                    // and exported blanket diffuse-transmission paths.
                    if ('transmission' in material) material.transmission = 0;
                    if ('diffuseTransmission' in material) material.diffuseTransmission = 0;
                    if (T3.mrt && T3.output && T3.normalView) {
                        // N8AO acceptance is carried in metalrough.b. Real
                        // Joshua geometry keeps restrained contact depth, but
                        // cannot accept the full cavity term: its interleaved
                        // thin shells otherwise collapse toward black. Flat
                        // billboards and cactus spines reject the term entirely.
                        const n8aoAcceptance = !billboard && name === 'joshua' ? 0.80 : 0;
                        material.mrtNode = T3.mrt({
                            output: T3.output,
                            normal: T3.vec4(
                                T3.directionToColor(T3.normalView),
                                T3.float(1),
                            ),
                            metalrough: T3.vec4(
                                T3.metalness, T3.roughness,
                                T3.float(n8aoAcceptance), T3.materialEnvIntensity,
                            ),
                            emissive: T3.vec4(T3.emissive, T3.float(1)),
                        });
                        material.userData.n8aoAcceptance = n8aoAcceptance;
                        material.userData.preserveSceneMrtOverride = true;
                    }
                }
                const materialNames = {
                    joshua_green: 'Joshua_Foliage_LivingGreen',
                    joshua_dry: 'Joshua_Foliage_DryOchre',
                    joshua_driest: 'Joshua_Foliage_DeadGrayBrown',
                    joshua_bark: 'Joshua_Bark',
                    cactus_spines: 'Saguaro_Spines',
                    billboard: `${name}_Billboard`,
                };
                material.name = materialNames[role] ?? material.name;
                material.userData.vegetationMaterialRole = role;
                material.needsUpdate = true;
                ownMaterialResources(material);
                materialCache.set(key, material);
                return material;
            });
            return Array.isArray(sourceMaterial) ? prepared : prepared[0];
        };
        const placements = placementDefs.map(([x, z, scale, yaw, rank], id) => {
            const footprint = scale * (name === 'joshua' ? 1.15 : 0.72);
            const y = terrainSeatHeight(x, z, footprint) - Math.min(0.14, scale * 0.055);
            const quaternion = new T3.Quaternion().setFromAxisAngle(new T3.Vector3(0, 1, 0), yaw);
            const matrix = new T3.Matrix4().compose(
                new T3.Vector3(x, y, z),
                quaternion,
                new T3.Vector3(scale, scale, scale),
            );
            return {
                id,
                rank: rank ?? 0,
                x,
                y,
                z,
                scale,
                yaw,
                matrix,
                currentLod: null,
                currentDistance: null,
            };
        });
        const levels = roots.map((root, levelIndex) => {
            root.updateWorldMatrix(true, true);
            const inverseRoot = root.matrixWorld.clone().invert();
            const box = new T3.Box3().setFromObject(root);
            const groundOffset = new T3.Matrix4().makeTranslation(0, -box.min.y, 0);
            const batches = [];
            const mergeGroups = new Map();
            let joshuaFoliagePrimitive = 0;
            root.traverse((source) => {
                if (!source.isMesh || !source.geometry || !source.material) return;
                ownedGeometries.add(source.geometry);
                const relative = inverseRoot.clone().multiply(source.matrixWorld);
                const localMatrix = groundOffset.clone().multiply(relative);
                const sourcePositions = source.geometry.getAttribute('position')?.count ?? 0;
                sourceVertexRecords += sourcePositions;
                let geometry = source.geometry.clone();
                geometry = compactIndexedGeometry(geometry);
                compactedVertexRecords += geometry.getAttribute('position')?.count ?? 0;
                geometry.applyMatrix4(localMatrix);
                const sourceMaterials = Array.isArray(source.material) ? source.material : [source.material];
                const isCutout = sourceMaterials.some((material) => (
                    (material.alphaTest ?? 0) > 0 || material.transparent
                ));
                const billboard = /billboard/i.test(source.name || '');
                let materialRole = 'default';
                if (billboard) {
                    materialRole = 'billboard';
                } else if (name === 'joshua' && isCutout) {
                    const band = joshuaFoliagePrimitive++;
                    // SeedThree exports CONES in order: ten living crown shells,
                    // then the dead skirt from nearest-green to farthest/driest.
                    materialRole = band < 10
                        ? 'joshua_green'
                        : band < 13 ? 'joshua_dry' : 'joshua_driest';
                } else if (name === 'joshua') {
                    materialRole = 'joshua_bark';
                } else if (name === 'saguaro' && isCutout) {
                    materialRole = 'cactus_spines';
                } else if (name === 'saguaro') {
                    materialRole = 'healthy_damage_skin';
                }
                if (materialRole === 'joshua_bark') {
                    const repair = repairIndexedWindingToAuthoredNormals(geometry);
                    geometry.userData.joshuaBarkWindingRepair = { ...repair };
                    barkWindingRepairs.push({ lod: levelIndex, ...repair });
                }
                roleCounts.set(materialRole, (roleCounts.get(materialRole) ?? 0) + 1);
                const preparedMaterial = prepareMaterial(source.material, source.name || 'mesh', materialRole);
                const materials = Array.isArray(preparedMaterial) ? preparedMaterial : [preparedMaterial];
                const materialKey = materials.map((material) => material.uuid).join('+');
                const attributeKey = Object.entries(geometry.attributes)
                    .sort(([a], [b]) => a.localeCompare(b))
                    .map(([attributeName, attribute]) => (
                        `${attributeName}:${attribute.itemSize}:${attribute.normalized}:${attribute.array.constructor.name}`
                    )).join('|');
                const key = `${materialKey}/${geometry.index ? 'indexed' : 'linear'}/${attributeKey}`;
                if (!mergeGroups.has(key)) mergeGroups.set(key, {
                    material: preparedMaterial,
                    role: materialRole,
                    geometries: [],
                    names: [],
                });
                const entry = mergeGroups.get(key);
                entry.geometries.push(geometry);
                entry.names.push(source.name || 'mesh');
            });

            const addBatch = (geometry, material, label, role) => {
                ownedGeometries.add(geometry);
                const batch = new T3.InstancedMesh(geometry, material, placements.length);
                batch.name = `${name}_lod${levelIndex}_${label}`;
                batch.count = 0;
                // The directional shadow camera covers only the near scene.
                // Casting LOD2/billboard foliage into its 2048 map wastes a
                // second traversal of dense distant Joshua geometry without
                // producing a resolvable shadow. Near LOD0/1 still cast.
                const isDenseJoshuaFoliage = name === 'joshua' && (
                    role === 'joshua_green'
                    || role === 'joshua_dry'
                    || role === 'joshua_driest'
                );
                // Hundreds of overlapping rosette shells were rasterising a
                // near-solid self-shadow over the plant. Bark keeps casting;
                // foliage still receives scene/bark shadows and uses its
                // calibrated thin-leaf SSS, but does not shadow itself black.
                batch.castShadow = levelIndex <= 1 && !isDenseJoshuaFoliage;
                batch.receiveShadow = true;
                batch.frustumCulled = false;
                batch.instanceMatrix.setUsage(T3.DynamicDrawUsage);
                batch.userData.seedThreeLod = levelIndex;
                batch.userData.vegetationMaterialRole = role;
                batch.userData.authoredCastShadow = batch.castShadow;
                batch.userData.authoredReceiveShadow = batch.receiveShadow;
                batch.userData.shadowPolicy = isDenseJoshuaFoliage
                    ? 'receive-without-dense-self-cast'
                    : 'authored-caster-receiver';
                if (name === 'saguaro' && role === 'cactus_spines') {
                    diagnosticTargets.saguaroSpines.push(batch);
                } else if (name === 'saguaro' && role === 'healthy_damage_skin') {
                    diagnosticTargets.saguaroSkin.push(batch);
                    const materials = Array.isArray(material) ? material : [material];
                    for (const item of materials) {
                        if (!item) continue;
                        item.userData.authoredSide = item.side;
                        diagnosticTargets.saguaroSkinMaterials.add(item);
                    }
                }
                group.add(batch);
                ownedInstances.add(batch);
                batches.push({ mesh: batch });
            };

            for (const entry of mergeGroups.values()) {
                if (entry.geometries.length === 1) {
                    addBatch(entry.geometries[0], entry.material, entry.names[0], entry.role);
                    continue;
                }
                const merged = mergeGeometries(entry.geometries, false);
                if (merged) {
                    for (const geometry of entry.geometries) geometry.dispose();
                    addBatch(merged, entry.material, `${entry.names[0]}_merged${entry.geometries.length}`, entry.role);
                } else {
                    // The compatibility signature above should make this rare,
                    // but preserving every primitive is safer than dropping it.
                    entry.geometries.forEach((geometry, index) => {
                        addBatch(geometry, entry.material, `${entry.names[index]}_${index}`, entry.role);
                    });
                }
            }
            return { root, batches };
        });
        const shadowProxies = [];
        const shadowSource = levels[SHADOW_PROXY_SOURCE_LOD];
        if (levels[SHADOW_PROXY_TARGET_LOD] && shadowSource?.batches?.length) {
            shadowSource.batches.forEach(({ mesh: sourceMesh }, proxyIndex) => {
                // Share the already-owned billboard geometry/material. This is
                // an additional InstancedMesh allocation only; ownership and
                // texture disposal stay with the visible authored LOD batch.
                const proxy = new T3.InstancedMesh(
                    sourceMesh.geometry,
                    sourceMesh.material,
                    placements.length,
                );
                proxy.name = `${name}_lod${SHADOW_PROXY_TARGET_LOD}_shadow_proxy_${proxyIndex}`;
                proxy.count = 0;
                proxy.castShadow = true;
                proxy.receiveShadow = false;
                proxy.frustumCulled = false;
                proxy.layers.set(SHADOW_PROXY_LAYER);
                proxy.instanceMatrix.setUsage(T3.DynamicDrawUsage);
                proxy.userData.seedThreeShadowProxy = true;
                proxy.userData.sourceLod = SHADOW_PROXY_SOURCE_LOD;
                proxy.userData.targetLod = SHADOW_PROXY_TARGET_LOD;
                proxy.userData.authoredCastShadow = true;
                group.add(proxy);
                ownedInstances.add(proxy);
                shadowProxies.push(proxy);
                if (name === 'saguaro') diagnosticTargets.saguaroLod2ShadowProxies.push(proxy);
            });
        }
        materialStats[name] = Object.fromEntries(roleCounts);
        geometryStats[name] = {
            sourceVertexRecords,
            compactedVertexRecords,
            removedVertexRecords: sourceVertexRecords - compactedVertexRecords,
            twoSidedNormalPolicy: name === 'joshua'
                ? 'unflipped-authored-vertex-normal'
                : null,
            denseFoliageSelfCast: name === 'joshua' ? false : null,
            barkWindingRepairs: name === 'joshua'
                ? barkWindingRepairs.map((repair) => ({ ...repair }))
                : [],
            reduction: sourceVertexRecords > 0
                ? 1 - compactedVertexRecords / sourceVertexRecords
                : 0,
        };
        species.push({
            name,
            placements,
            levels,
            shadowProxies,
            shadowProxyCount: 0,
            distanceScale,
            counts: new Array(levels.length).fill(0),
            signature: '',
        });
    };

    // This one-time, versioned ecology layout is baked by
    // tools/build-vegetation-placement-manifest.mjs. It preserves the open
    // compound/approach/washes while guaranteeing conservative authored-asset
    // footprint clearance across and within species. There is intentionally no
    // runtime PRNG: every reload uses these exact transforms.
    buildSpecies('saguaro', saguaroGltf, placementLayout.species.saguaro);
    buildSpecies('joshua', joshuaGltf, placementLayout.species.joshua, 0.85);
    for (const item of species) {
        collisionStreamer.registerSpecies(item.name, item.placements);
    }

    const applyDiagnosticState = () => {
        for (const mesh of diagnosticTargets.saguaroSpines) {
            mesh.visible = diagnosticState.spinesVisible;
            mesh.castShadow = Boolean(
                mesh.userData.authoredCastShadow && diagnosticState.spinesCastShadow,
            );
        }
        for (const mesh of diagnosticTargets.saguaroSkin) {
            mesh.castShadow = Boolean(
                mesh.userData.authoredCastShadow && diagnosticState.skinCastShadow,
            );
            mesh.receiveShadow = Boolean(
                mesh.userData.authoredReceiveShadow && diagnosticState.skinReceiveShadow,
            );
        }
        for (const proxy of diagnosticTargets.saguaroLod2ShadowProxies) {
            proxy.castShadow = Boolean(diagnosticState.lod2ProxyCastShadow);
        }
        for (const material of diagnosticTargets.saguaroSkinMaterials) {
            const side = diagnosticState.skinDoubleSided
                ? T3.DoubleSide
                : material.userData.authoredSide;
            if (material.side === side) continue;
            material.side = side;
            material.needsUpdate = true;
        }
        return { ...diagnosticState };
    };

    const setSaguaroDiagnostic = (options = {}) => {
        for (const key of Object.keys(diagnosticState)) {
            if (options[key] !== undefined) diagnosticState[key] = Boolean(options[key]);
        }
        return applyDiagnosticState();
    };
    const resetSaguaroDiagnostic = () => setSaguaroDiagnostic({
        spinesVisible: true,
        spinesCastShadow: true,
        lod2ProxyCastShadow: true,
        skinCastShadow: true,
        skinReceiveShadow: true,
        skinDoubleSided: false,
    });
    const nearestSaguaro = (x, z) => {
        const item = species.find((entry) => entry.name === 'saguaro');
        if (!item?.placements?.length) return null;
        let nearest = null;
        for (const placement of item.placements) {
            const distance = Math.hypot(placement.x - Number(x), placement.z - Number(z));
            if (!nearest || distance < nearest.queryDistance) nearest = { placement, queryDistance: distance };
        }
        const placement = nearest.placement;
        return {
            id: placement.id,
            x: placement.x,
            y: placement.y,
            z: placement.z,
            scale: placement.scale,
            yaw: placement.yaw,
            queryDistance: nearest.queryDistance,
            currentLod: placement.currentLod,
            currentDistance: placement.currentDistance,
        };
    };
    const diagnosticApi = {
        get state() { return { ...diagnosticState }; },
        set: setSaguaroDiagnostic,
        reset: resetSaguaroDiagnostic,
        nearestSaguaro,
        collision: {
            get state() { return collisionStreamer.snapshot(); },
            get hullLibraryReady() { return hullLibraryReady; },
            registerSpecies: (name, placements) => collisionStreamer
                .registerSpecies(name, placements),
            activeProxies: () => collisionStreamer.activeProxies(),
            forceRefresh: (position, time = 0) => {
                collisionStreamer.refresh(position, time, true);
                return collisionStreamer.snapshot();
            },
        },
        targets: {
            spineBatches: diagnosticTargets.saguaroSpines.length,
            skinBatches: diagnosticTargets.saguaroSkin.length,
            lod2ShadowProxyBatches: diagnosticTargets.saguaroLod2ShadowProxies.length,
        },
    };
    applyDiagnosticState();
    globalThis._vegetationDiagnostics = diagnosticApi;

    const update = (camera, t = 0, force = false) => {
        if (disposed || !camera) return;
        collisionStreamer.refresh(camera.position, t, force);
        if (!force && !dirty && t - lastUpdate < 0.28) return;
        lastUpdate = t;
        const profile = authoredProfile;
        const cuts = profile.cuts;
        const stats = {};
        for (const item of species) {
            const lists = item.levels.map(() => []);
            for (const placement of item.placements) {
                placement.currentLod = null;
                placement.currentDistance = null;
                if (placement.rank > profile.density) continue;
                const dx = camera.position.x - placement.x;
                const dy = camera.position.y - placement.y;
                const dz = camera.position.z - placement.z;
                const actualDistance = Math.hypot(dx, dy, dz);
                if (actualDistance >= profile.farCull) continue;
                const distance = actualDistance / item.distanceScale;
                let level = 0;
                while (level < cuts.length && level < item.levels.length - 1 && distance >= cuts[level]) level++;
                placement.currentLod = level;
                placement.currentDistance = actualDistance;
                lists[level].push(placement);
            }
            // Counts alone miss a same-count swap between adjacent LODs.
            // Plant IDs make membership changes invalidate the matrices too.
            const signature = lists.map((list) => list.map((placement) => placement.id).join(',')).join('/');
            if (force || dirty || signature !== item.signature) {
                item.signature = signature;
                for (let levelIndex = 0; levelIndex < item.levels.length; levelIndex++) {
                    const placementMatrices = lists[levelIndex];
                    item.counts[levelIndex] = placementMatrices.length;
                    for (const batch of item.levels[levelIndex].batches) {
                        for (let index = 0; index < placementMatrices.length; index++) {
                            scratchWorld.copy(placementMatrices[index].matrix);
                            batch.mesh.setMatrixAt(index, scratchWorld);
                        }
                        batch.mesh.count = placementMatrices.length;
                        batch.mesh.instanceMatrix.needsUpdate = true;
                    }
                }
                const shadowPlacements = lists[SHADOW_PROXY_TARGET_LOD] ?? [];
                item.shadowProxyCount = shadowPlacements.length;
                for (const proxy of item.shadowProxies) {
                    for (let index = 0; index < shadowPlacements.length; index++) {
                        scratchWorld.copy(shadowPlacements[index].matrix);
                        proxy.setMatrixAt(index, scratchWorld);
                    }
                    proxy.count = shadowPlacements.length;
                    proxy.instanceMatrix.needsUpdate = true;
                }
            }
            stats[item.name] = [...item.counts];
        }
        dirty = false;
        globalThis._vegetationStats = {
            quality: currentQuality,
            species: stats,
            materials: materialStats,
            geometry: geometryStats,
            shadowProxies: Object.fromEntries(species.map((item) => [item.name, {
                sourceLod: SHADOW_PROXY_SOURCE_LOD,
                targetLod: SHADOW_PROXY_TARGET_LOD,
                layer: SHADOW_PROXY_LAYER,
                batches: item.shadowProxies.length,
                instances: item.shadowProxyCount,
            }])),
            profile: { ...authoredProfile },
            placementManifest: group.userData.placementManifest,
            diagnostics: {
                ...diagnosticState,
                targets: { ...diagnosticApi.targets },
            },
            collision: collisionStreamer.snapshot(),
        };
    };

    const resolveCamera = (camera, previous, time = 0, eyeHeight = 1.82) => {
        if (disposed || !camera?.position) return { active: 0, contacts: 0, refreshed: false };
        return collisionStreamer.resolve(
            camera.position,
            previous ?? camera.position,
            time,
            eyeHeight,
        );
    };

    const setQuality = (nextQuality) => {
        group.userData.requestedSkyQuality = nextQuality;
        if (currentQuality !== 'balanced') {
            currentQuality = 'balanced';
            dirty = true;
        }
    };

    return {
        group,
        update,
        resolveCamera,
        walkSurfaceAt: collisionStreamer.walkSurfaceAt,
        setQuality,
        // Feed for non-vegetation hard-stop species (terrain rocks): the one
        // collision streamer resolves every registered species uniformly.
        registerCollisionSpecies: (name, placements) => collisionStreamer
            .registerSpecies(name, placements),
        hullLibraryReady,
        diagnostics: diagnosticApi,
        dispose() {
            if (disposed) return;
            disposed = true;
            group.removeFromParent();
            group.clear();
            for (const instance of ownedInstances) instance.dispose?.();
            for (const geometry of ownedGeometries) geometry.dispose?.();
            for (const material of ownedMaterials) material.dispose?.();
            for (const texture of ownedTextures) texture.dispose?.();
            ownedInstances.clear();
            ownedGeometries.clear();
            ownedMaterials.clear();
            ownedTextures.clear();
            collisionStreamer.dispose();
            globalThis._vegetationStats = null;
            if (globalThis._vegetationDiagnostics === diagnosticApi) {
                globalThis._vegetationDiagnostics = null;
            }
        },
    };
}
