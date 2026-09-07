// Real-scale Eanpa desert terrain. A dense local height field carries the
// walkable scene while a concentric, progressively coarser ring supplies the
// distant horizon. Fourteen user-selected Poly Haven and ambientCG CC0 surfaces
// are graded individually into one tan-to-orange family without flattening
// their photographed luminance. Authored vertex splats assign geological
// roles from elevation, slope, and globally interleaved ownership selectors.
// An authored threshold brush then breaks every selector at fragment scale;
// shared per-material height bias resolves only the remaining local fronts.

const NEAR_SIZE = 768;
const NEAR_SEGMENTS = 384;
const HALF_NEAR = NEAR_SIZE * 0.5;
const HORIZON_HALF = 2400;
const HORIZON_RADIAL_SEGMENTS = 56;
// These are scene-calibrated metres per complete texture repeat, not the
// capture footprints published beside the source scans. The previous 2-4 m
// projection made each scan's internal motifs read as over-dense/repetitive.
// SeedThree establishes a 4 m ground / 7.27 m rock reference; source-specific
// crack and stone structure then rounds upward where a larger repeat is needed.
const SURFACE_TILE_METERS = Object.freeze({
    RockyTrail02: [4.0, 4.0],
    DryGroundRocks: [8.0, 8.0],
    RedLateriteSoilStones: [4.0, 4.0],
    CrackedRedGround: [6.0, 6.0],
    MudCrackedDryRiverbed002: [6.0, 6.0],
    Rock029: [8.0, 8.0],
    Rock061: [8.0, 8.0],
    GravellySand: [5.0, 5.0],
    RockFace03: [8.0, 8.0],
    SandyGravel02: [5.0, 5.0],
    RockyTrail: [4.0, 4.0],
    RockFace: [8.0, 8.0],
    RockBoulderCracked: [6.0, 6.0],
    // This scan contains large stones inside its four-metre source motif.
    // A seven-metre scene repeat keeps legitimate slope talus from reading as
    // a tiled gravel carpet while its ownership remains exactly zero on flats.
    RocksGround02: [7.0, 7.0],
});
const SURFACE_RUNTIME_SIZE = 2048;
const SURFACE_FALLBACK_SIZE = 1024;
const SURFACE_LAYER_COUNT = 14;
const SURFACE_KTX2_ALBEDO_URL =
    './assets/pbr/eanpa_southwest_ground_v3/runtime/SouthwestGroundV3_AlbedoHeight_14x2K_UASTC.ktx2';
const SURFACE_KTX2_PACKED_URL =
    './assets/pbr/eanpa_southwest_ground_v3/runtime/SouthwestGroundV3_PackedNxyRoughAO_14x2K_UASTC.ktx2';
const SURFACE_KTX2_TRANSCODER_PATH = './vendor/three/addons/libs/basis/';
const TERRAIN_BLEND_BRUSH_URL = './assets/terrain/masks/seedthree_blend_brush.png';
// SeedThree's authored threshold brush is sampled from world XZ using seven
// independently phased 55-125 m periods. This keeps its hand-authored edge
// character while producing several interlocking fronts in a normal view.
// No second octave is needed, so mask breakup still costs seven reads total.
const TERRAIN_BLEND_BRUSH_TRANSFORMS = Object.freeze([
    Object.freeze({ repeatMeters: 4 / 0.061, offset: Object.freeze([0.00, 0.00]) }),
    Object.freeze({ repeatMeters: 4 / 0.043, offset: Object.freeze([0.37, 0.71]) }),
    Object.freeze({ repeatMeters: 4 / 0.037, offset: Object.freeze([0.13, 0.29]) }),
    Object.freeze({ repeatMeters: 4 / 0.052, offset: Object.freeze([0.61, 0.47]) }),
    Object.freeze({ repeatMeters: 4 / 0.073, offset: Object.freeze([0.41, 0.93]) }),
    Object.freeze({ repeatMeters: 4 / 0.032, offset: Object.freeze([0.83, 0.09]) }),
    Object.freeze({ repeatMeters: 4 / 0.048, offset: Object.freeze([0.19, 0.57]) }),
]);
const COMPOUND_X = 0;
const COMPOUND_Z = -72;
const GATE_THRESHOLD_X = COMPOUND_X;
const GATE_THRESHOLD_Z = COMPOUND_Z + 48;
// Beyond the ziggurat on the north side of the valley, opposite the southern
// start. Keeping it off-axis preserves the approach while exposing the rim
// from the summit and eastern valley floor.
const CRATER_X = 158;
const CRATER_Z = -286;
const CRATER_RADIUS = 88;
const DESERT_CLIFF_ASSETS = Object.freeze({
    wideLow: './assets/terrain/Desert_Cliff_Wide_Mesa_Low_runtime_2k_lods.glb',
    mesaHigh: './assets/terrain/Desert_Cliff_Mesa_High_runtime_2k_lods.glb',
});
const DESERT_CLIFF_LOD_DISTANCES = [0, 600, 1050];
const DESERT_CLIFF_LOD_HYSTERESIS = 0.10;
const DESERT_CLIFF_DERIVATIVE_REPAIRS = Object.freeze({ wideLow: 0, mesaHigh: 3 });
const DESERT_CLIFF_BASE_SUPPORT_BAND_FRACTION = 0.025;
const DESERT_CLIFF_BASE_EMBED_METRES = 2.0;
// The user-authored meshes arrive in normalized metres around the origin.
// Uniform scale preserves their authored profiles and baked UVs. Overlapping,
// independently rotated copies build landscape-width compound silhouettes
// without stretching either source mesh. Rear masses stay off the ziggurat axis.
const DESERT_CLIFF_PLACEMENTS = [
    { name: 'western_shelf_west', asset: 'wideLow', x: -790, z: -430, yaw: -2.25,
        scale: 150, halfLength: 140.3, halfDepth: 142.2, baseRise: 8.5 },
    { name: 'western_shelf_east', asset: 'wideLow', x: -620, z: -385, yaw: -2.08,
        scale: 145, halfLength: 135.6, halfDepth: 137.5, baseRise: 7.5 },
    { name: 'western_crown', asset: 'mesaHigh', x: -720, z: -510, yaw: -2.05,
        scale: 95, halfLength: 89.9, halfDepth: 88.7, baseRise: 6.5 },
    { name: 'northwestern_shelf', asset: 'wideLow', x: -300, z: -800, yaw: -2.783,
        scale: 150, halfLength: 140.3, halfDepth: 142.2, baseRise: 7.5 },
    { name: 'northeastern_shelf', asset: 'wideLow', x: 360, z: -850, yaw: 2.70,
        scale: 135, halfLength: 126.3, halfDepth: 128.0, baseRise: 7.0 },
    { name: 'northeastern_mesa', asset: 'mesaHigh', x: 310, z: -905, yaw: 2.87,
        scale: 100, halfLength: 94.6, halfDepth: 93.3, baseRise: 8.0 },
    { name: 'eastern_shelf', asset: 'wideLow', x: 820, z: -260, yaw: 1.86,
        scale: 100, halfLength: 93.6, halfDepth: 94.8, baseRise: 6.0 },
    { name: 'eastern_crown', asset: 'mesaHigh', x: 855, z: -315, yaw: 1.68,
        scale: 65, halfLength: 61.5, halfDepth: 60.7, baseRise: 4.0 },
];
const DESERT_ROCK_ASSET =
    './assets/terrain/Desert_rock_chunks_12_pieces_runtime_2k_lods.glb';
const DESERT_ROCK_PIECE_COUNT = 12;
const DESERT_ROCK_LOD_PROJECTED_DIAMETER_PIXELS = [72, 18, 1];
const DESERT_ROCK_LOD_HYSTERESIS = 0.12;
const DESERT_ROCK_CULL_DIAMETER_PIXELS = 1;
const DESERT_ROCK_INSTANCE_TARGET = 720;
const DESERT_ROCK_GROUND_INSTANCE_TARGET = 656;
const DESERT_ROCK_CLIFF_CLUSTER_TARGET = 64;
const DESERT_ROCK_CLIFF_CLUSTER_COUNT = DESERT_CLIFF_PLACEMENTS.length;
const DESERT_ROCK_CLIFF_CLUSTER_MEMBERS = 8;
const DESERT_ROCK_MAXIMUM_DRAWS = DESERT_ROCK_PIECE_COUNT
    * DESERT_ROCK_LOD_PROJECTED_DIAMETER_PIXELS.length;
const DESERT_ROCK_BURY_FRACTION = 0.035;
const DESERT_ROCK_GROUND_MAX_GRADE = 0.42;
const DESERT_ROCK_CLIFF_CLUSTER_MIN_GRADE = 0.35;
const DESERT_ROCK_CLIFF_SHOULDER_MASK_RANGE = Object.freeze([0.08, 0.82]);
const DESERT_ROCK_CLIFF_CLUSTER_RADIUS_METRES = Object.freeze([8, 18]);
const DESERT_ROCK_CLIFF_CLUSTER_BURY_FRACTION_RANGE = Object.freeze([0.42, 0.64]);
const DESERT_ROCK_DERIVATIVE_WINDING_REPAIRS = 31;
const DESERT_ROCK_PIECE_GROUPS = Object.freeze({
    largeFlatWide: Object.freeze([2, 4, 8, 9]),
    mediumIrregular: Object.freeze([0, 5, 6, 7]),
    smallSmoothRound: Object.freeze([1, 10]),
    cliffFaceTallNarrow: Object.freeze([3, 11]),
});
const DESERT_ROCK_PIECE_CLASS = Object.freeze([
    'mediumIrregular', 'smallSmoothRound', 'largeFlatWide',
    'cliffFaceTallNarrow', 'largeFlatWide', 'mediumIrregular',
    'mediumIrregular', 'mediumIrregular', 'largeFlatWide', 'largeFlatWide',
    'smallSmoothRound', 'cliffFaceTallNarrow',
]);
const DESERT_ROCK_DIAMETER_RANGES = Object.freeze({
    largeFlatWide: Object.freeze([2.0, 5.8]),
    mediumIrregular: Object.freeze([0.95, 2.75]),
    smallSmoothRound: Object.freeze([0.30, 0.80]),
    cliffFaceTallNarrow: Object.freeze([6.0, 14.0]),
});
const DESERT_ROCK_VISUAL_INDEX = Object.freeze([
    Object.freeze({ piece: 0, node: 'DesertRockPiece00_LOD0',
        mesh: 'DesertRockPiece00_LOD0_Mesh', submesh: 'primitive 0',
        role: 'mediumIrregular' }),
    Object.freeze({ piece: 1, node: 'DesertRockPiece01_LOD0',
        mesh: 'DesertRockPiece01_LOD0_Mesh', submesh: 'primitive 0',
        role: 'smallSmoothRound' }),
    Object.freeze({ piece: 2, node: 'DesertRockPiece02_LOD0',
        mesh: 'DesertRockPiece02_LOD0_Mesh', submesh: 'primitive 0',
        role: 'largeFlatWide' }),
    Object.freeze({ piece: 3, node: 'DesertRockPiece03_LOD0',
        mesh: 'DesertRockPiece03_LOD0_Mesh', submesh: 'primitive 0',
        role: 'cliffFaceTallNarrow' }),
    Object.freeze({ piece: 4, node: 'DesertRockPiece04_LOD0',
        mesh: 'DesertRockPiece04_LOD0_Mesh', submesh: 'primitive 0',
        role: 'largeFlatWide' }),
    Object.freeze({ piece: 5, node: 'DesertRockPiece05_LOD0',
        mesh: 'DesertRockPiece05_LOD0_Mesh', submesh: 'primitive 0',
        role: 'mediumIrregular' }),
    Object.freeze({ piece: 6, node: 'DesertRockPiece06_LOD0',
        mesh: 'DesertRockPiece06_LOD0_Mesh', submesh: 'primitive 0',
        role: 'mediumIrregular' }),
    Object.freeze({ piece: 7, node: 'DesertRockPiece07_LOD0',
        mesh: 'DesertRockPiece07_LOD0_Mesh', submesh: 'primitive 0',
        role: 'mediumIrregular' }),
    Object.freeze({ piece: 8, node: 'DesertRockPiece08_LOD0',
        mesh: 'DesertRockPiece08_LOD0_Mesh', submesh: 'primitive 0',
        role: 'largeFlatWide' }),
    Object.freeze({ piece: 9, node: 'DesertRockPiece09_LOD0',
        mesh: 'DesertRockPiece09_LOD0_Mesh', submesh: 'primitive 0',
        role: 'largeFlatWide' }),
    Object.freeze({ piece: 10, node: 'DesertRockPiece10_LOD0',
        mesh: 'DesertRockPiece10_LOD0_Mesh', submesh: 'primitive 0',
        role: 'smallSmoothRound' }),
    Object.freeze({ piece: 11, node: 'DesertRockPiece11_LOD0',
        mesh: 'DesertRockPiece11_LOD0_Mesh', submesh: 'primitive 0',
        role: 'cliffFaceTallNarrow' }),
]);

const clamp01 = (value) => Math.max(0, Math.min(1, value));
const smooth01 = (value) => {
    const t = clamp01(value);
    return t * t * (3 - 2 * t);
};
const smooth = (a, b, value) => smooth01((value - a) / Math.max(1e-6, b - a));

function hash2(ix, iz, seed = 0) {
    let h = (ix * 374761393 + iz * 668265263 + seed * 1442695041) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function valueNoise(x, z, seed = 0) {
    const ix = Math.floor(x), iz = Math.floor(z);
    const fx = x - ix, fz = z - iz;
    const sx = smooth01(fx), sz = smooth01(fz);
    const a = hash2(ix, iz, seed), b = hash2(ix + 1, iz, seed);
    const c = hash2(ix, iz + 1, seed), d = hash2(ix + 1, iz + 1, seed);
    return (a + (b - a) * sx) * (1 - sz) + (c + (d - c) * sx) * sz;
}

function fbm(x, z, seed = 0, octaves = 5) {
    let value = 0, amplitude = 0.5, frequency = 1, norm = 0;
    for (let octave = 0; octave < octaves; octave++) {
        value += valueNoise(x * frequency, z * frequency, seed + octave * 37) * amplitude;
        norm += amplitude;
        amplitude *= 0.5;
        frequency *= 2.03;
    }
    return value / Math.max(norm, 1e-6);
}

function ridged(x, z, seed = 0) {
    return 1 - Math.abs(fbm(x, z, seed, 5) * 2 - 1);
}

function compoundMaskAt(x, z) {
    const dx = (x - COMPOUND_X) / 82;
    const dz = (z - COMPOUND_Z) / 66;
    return 1 - smooth(0.72, 1.18, Math.hypot(dx, dz));
}

// The Eidoverse gate asset includes a dressed threshold/input strip beneath
// its retracting leaf. Grade a shallow, softly feathered slot into the local
// terrain so that authored surface remains exposed instead of being buried by
// centimetre-scale compound variation. Posts and adjacent wall bases stay
// seated because the clearance ends inside the gate's built-in supports.
function gateThresholdMaskAt(x, z) {
    const across = 1 - smooth(8.7, 10.1, Math.abs(x - GATE_THRESHOLD_X));
    const through = 1 - smooth(1.25, 3.25, Math.abs(z - GATE_THRESHOLD_Z));
    return across * through;
}

function processionalMaskAt(x, z) {
    const centerX = 1.5 + Math.sin((z + 18) * 0.014) * 1.8;
    const cross = Math.abs(x - centerX);
    const along = smooth(-18, 2, z) * (1 - smooth(112, 148, z));
    return (1 - smooth(6, 17, cross)) * along;
}

function authoredCliffPlacementMaskAt(placement, x, z) {
    const dx = x - placement.x;
    const dz = z - placement.z;
    const cosYaw = Math.cos(placement.yaw), sinYaw = Math.sin(placement.yaw);
    const localX = dx * cosYaw - dz * sinYaw;
    const localZ = dx * sinYaw + dz * cosYaw;
    const footprint = Math.max(
        Math.abs(localX) / (placement.halfLength + 20),
        Math.abs(localZ) / (placement.halfDepth + 24),
    );
    return 1 - smooth(0.82, 1.08, footprint);
}

function authoredCliffMaskAt(x, z) {
    let mask = 0;
    for (const placement of DESERT_CLIFF_PLACEMENTS) {
        mask = Math.max(mask, authoredCliffPlacementMaskAt(placement, x, z));
    }
    return mask;
}

function cliffBaseBuildUpAt(x, z) {
    let rise = 0;
    for (let index = 0; index < DESERT_CLIFF_PLACEMENTS.length; index++) {
        const placement = DESERT_CLIFF_PLACEMENTS[index];
        const dx = x - placement.x;
        const dz = z - placement.z;
        const cosYaw = Math.cos(placement.yaw), sinYaw = Math.sin(placement.yaw);
        const localX = dx * cosYaw - dz * sinYaw;
        const localZ = dx * sinYaw + dz * cosYaw;
        const distance = Math.hypot(
            localX / (placement.halfLength + 42),
            localZ / (placement.halfDepth + 38),
        );
        const shoulder = 1 - smooth(0.34, 1.12, distance);
        const breakup = 0.84 + 0.16 * fbm(x * 0.012, z * 0.012, 401 + index * 17, 3);
        rise = Math.max(rise, placement.baseRise * shoulder * breakup);
    }
    return rise;
}

function washMaskAt(x, z) {
    const channelA = 16 + z * 0.11 + Math.sin(z * 0.018 + 0.7) * 13;
    const channelB = -94 - z * 0.07 + Math.sin(z * 0.013 - 1.8) * 19;
    const a = 1 - smooth(5, 28, Math.abs(x - channelA));
    const b = (1 - smooth(7, 35, Math.abs(x - channelB))) * 0.72;
    return Math.max(a, b);
}

function baseTerrainHeight(x, z) {
    // Low-frequency domain warp breaks every straight or concentric contour.
    const warpX = (fbm(x * 0.0023 + 11.3, z * 0.0023 - 7.1, 19, 4) - 0.5) * 58;
    const warpZ = (fbm(x * 0.0021 - 31.8, z * 0.0021 + 17.5, 43, 4) - 0.5) * 46;
    const px = x + warpX, pz = z + warpZ;

    // An asymmetric, gently meandering alluvial corridor. Foothills grow from
    // independent west/east/north fields rather than from a radial crater rim.
    const valleyCenter = -24 + pz * 0.085 + Math.sin((pz + 65) * 0.008) * 22;
    const across = Math.abs(px - valleyCenter);
    const west = smooth(112, 410, -px + pz * 0.10);
    const east = smooth(155, 520, px - pz * 0.035);
    const north = smooth(210, 610, -pz + px * 0.08);
    const valleyShoulder = smooth(92, 360, across);

    const westRelief = west * valleyShoulder
        * (12 + 35 * ridged(px * 0.0038 + 8.2, pz * 0.0038 - 4.5, 71));
    const eastRelief = east * valleyShoulder
        * (8 + 29 * ridged(px * 0.0034 - 6.1, pz * 0.0034 + 9.8, 89));
    const northRelief = north
        * (7 + 27 * ridged(px * 0.0031 + 2.7, pz * 0.0031 + 3.3, 113));

    // Separate broad outcrops interrupt the foothills without becoming mesas.
    const outcrop = (cx, cz, rx, rz, height, seed) => {
        const d = Math.hypot((px - cx) / rx, (pz - cz) / rz);
        const body = 1 - smooth(0.42, 1.18, d);
        const surface = 0.72 + 0.28 * ridged(px * 0.009, pz * 0.009, seed);
        return body * height * surface;
    };
    const outcrops = outcrop(-270, -120, 155, 230, 34, 131)
        + outcrop(285, -245, 190, 145, 27, 149)
        + outcrop(-235, 245, 135, 165, 19, 163);

    const radius = Math.hypot(px * 0.88, pz * 1.04);
    const distantRise = smooth(430, 1550, radius)
        * (14 + 43 * ridged(px * 0.0017 + 14, pz * 0.0017 - 23, 181));
    // The south-east remains a broad visual exit instead of closing the scene.
    const angle = Math.atan2(pz, px);
    const exitDelta = Math.atan2(Math.sin(angle - 0.58), Math.cos(angle - 0.58));
    const openExit = Math.exp(-(exitDelta * exitDelta) / 0.19) * smooth(260, 900, radius);

    const floorMacro = (fbm(px * 0.009, pz * 0.009, 211, 5) - 0.5) * 2.2;
    const floorFine = (fbm(px * 0.035, pz * 0.035, 227, 3) - 0.5) * 0.56;
    // Sub-decimetre desert-pavement relief keeps grazing light alive on the
    // valley floor without turning the walkable surface into procedural
    // dunes or replacing the photographed displacement/normal response.
    const pavementRelief = (fbm(px * 0.092, pz * 0.092, 239, 3) - 0.5) * 0.18;
    const wash = washMaskAt(x, z)
        * (1.0 + 1.8 * smooth(70, 470, Math.abs(x - valleyCenter)));

    return floorMacro + floorFine + pavementRelief + westRelief + eastRelief + northRelief
        + outcrops + distantRise * (1 - openExit * 0.88) - wash;
}

function craterFieldsAt(x, z) {
    const dx = x - CRATER_X;
    const dz = z - CRATER_Z;
    const angle = Math.atan2(dz, dx);
    const rimWarp = 1
        + Math.sin(angle * 3 + 0.7) * 0.055
        + Math.sin(angle * 7 - 1.4) * 0.027
        + Math.sin(angle * 13 + 2.1) * 0.013;
    const n = Math.hypot(dx, dz) / (CRATER_RADIUS * rimWarp);
    const bowl = -23.5 * (1 - smooth(0.13, 0.91, n));
    const rim = Math.exp(-Math.pow((n - 1.0) / 0.115, 2))
        * (9.5 + 2.4 * Math.sin(angle * 5 - 0.8));
    const ray = Math.max(0, Math.sin(angle * 9 + 0.9)) ** 5;
    const ejecta = (1 - smooth(1.0, 1.72, n)) * smooth(0.88, 1.03, n)
        * (2.1 + ray * 2.8);
    const inner = 1 - smooth(0.10, 0.96, n);
    const rimZone = 1 - smooth(0.78, 1.22, Math.abs(n - 1) + 0.78);
    const exclusion = 1 - smooth(1.12, 1.62, n);
    const landformMask = 1 - smooth(0.74, 1.68, n);
    return { n, delta: bowl + rim + ejecta, inner, rimZone, exclusion, landformMask };
}

const CRATER_DATUM = baseTerrainHeight(CRATER_X, CRATER_Z);

// ---- OFFLINE-BAKED TERRAIN (tools/bake-eanpa-terrain.py) ------------------
// The generated world: swiss-turbulence ranges, gully-carved slopes, thermal
// talus, wash channels — baked to assets, loaded here as raw float32 metres.
// When loaded, terrainHeightAt reads THIS by bilinear lookup instead of the
// legacy in-code noise composition. The compound/gate grading still applies
// on top so the temple datum convention (compound ~ y=0) is preserved.
let BAKED_TERRAIN = null;
async function loadBakedTerrain() {
    if (BAKED_TERRAIN) return BAKED_TERRAIN;
    const [metaResponse, dataResponse] = await Promise.all([
        fetch('./assets/terrain/baked/eanpa_terrain_v1_meta.json'),
        fetch('./assets/terrain/baked/eanpa_terrain_v1_height.f32'),
    ]);
    if (!metaResponse.ok || !dataResponse.ok) {
        throw new Error('baked terrain assets missing (run tools/bake-eanpa-terrain.py)');
    }
    const meta = await metaResponse.json();
    const data = new Float32Array(await dataResponse.arrayBuffer());
    if (data.length !== meta.size * meta.size) {
        throw new Error('baked terrain size mismatch');
    }
    const sample = (x, z) => {
        const scale = meta.size / (meta.halfExtentMeters * 2);
        let u = (x + meta.halfExtentMeters) * scale - 0.5;
        let v = (z + meta.halfExtentMeters) * scale - 0.5;
        u = Math.max(0, Math.min(meta.size - 1.001, u));
        v = Math.max(0, Math.min(meta.size - 1.001, v));
        const x0 = Math.floor(u), z0 = Math.floor(v);
        const fx = u - x0, fz = v - z0;
        const row0 = z0 * meta.size, row1 = row0 + meta.size;
        return (data[row0 + x0] * (1 - fx) + data[row0 + x0 + 1] * fx) * (1 - fz)
            + (data[row1 + x0] * (1 - fx) + data[row1 + x0 + 1] * fx) * fz;
    };
    BAKED_TERRAIN = { meta, sample, compoundDatum: 0 };
    BAKED_TERRAIN.compoundDatum = sample(COMPOUND_X, COMPOUND_Z);
    return BAKED_TERRAIN;
}

function rawTerrainHeight(x, z) {
    const base = baseTerrainHeight(x, z);
    const crater = craterFieldsAt(x, z);
    // A blast this large cuts across pre-existing small relief. Blend toward
    // one local datum before applying the bowl/rim profile, but retain enough
    // broad geology that the ejecta still belongs to the valley.
    const gradedBase = base + (CRATER_DATUM - base) * crater.landformMask * 0.88;
    return gradedBase + crater.delta + cliffBaseBuildUpAt(x, z);
}

const COMPOUND_DATUM = rawTerrainHeight(COMPOUND_X, COMPOUND_Z);

function terrainHeightAt(x, z) {
    if (BAKED_TERRAIN) {
        const raw = BAKED_TERRAIN.sample(x, z) - BAKED_TERRAIN.compoundDatum;
        const compoundK = compoundMaskAt(x, z);
        const graded = (fbm(x * 0.055 + 4, z * 0.055 - 9, 251, 3) - 0.5) * 0.16;
        return raw + (graded - raw) * compoundK
            - gateThresholdMaskAt(x, z) * 0.24;
    }
    const original = rawTerrainHeight(x, z);
    const compound = compoundMaskAt(x, z);
    // The compound is graded, not stamped perfectly flat: centimetre-scale
    // variation remains so its margins merge naturally into the alluvium.
    const graded = COMPOUND_DATUM
        + (fbm(x * 0.055 + 4, z * 0.055 - 9, 251, 3) - 0.5) * 0.16;
    const compoundSurface = original + (graded - original) * compound - COMPOUND_DATUM;
    return compoundSurface - gateThresholdMaskAt(x, z) * 0.24;
}

function desertRockGradeAt(heightAt, x, z, step = 1.4) {
    const dx = (heightAt(x + step, z) - heightAt(x - step, z)) / (step * 2);
    const dz = (heightAt(x, z + step) - heightAt(x, z - step)) / (step * 2);
    return { dx, dz, grade: Math.hypot(dx, dz) };
}

function desertRockSpacingDiameter(placement) {
    return placement.desiredDiameter ?? placement.desiredLongAxis * 0.78;
}

function desertRockHasClearance(placements, x, z, spacingDiameter, minimumSpacing) {
    return !placements.some((item) => {
        const separation = Math.max(
            minimumSpacing,
            (desertRockSpacingDiameter(item) + spacingDiameter) * 0.85,
        );
        return (item.x - x) ** 2 + (item.z - z) ** 2 < separation ** 2;
    });
}

function desertRockCommonExclusionAt(x, z) {
    return compoundMaskAt(x, z) > 0.015
        || processionalMaskAt(x, z) > 0.015
        || (Math.abs(x) < 28 && z > -34 && z < 168)
        || washMaskAt(x, z) > 0.22
        || craterFieldsAt(x, z).exclusion > 0.18;
}

function makeCliffClusterRockPlacement({
    x,
    z,
    piece,
    grade,
    nearField,
    rollSeed,
    sizeSeed,
    burySeed,
    clusterId,
    clusterMember,
    clusterRadius,
    cliffMask,
    cliffPlacementMask,
    cliffPlacement,
}) {
    const range = DESERT_ROCK_DIAMETER_RANGES.cliffFaceTallNarrow;
    const sizeT = 0.18 + sizeSeed ** 1.15 * 0.82;
    const desiredLongAxis = range[0] + (range[1] - range[0]) * sizeT;
    const buryRange = DESERT_ROCK_CLIFF_CLUSTER_BURY_FRACTION_RANGE;
    const clusterRoll = hash2(clusterId, 167, 953) * Math.PI * 2;
    return {
        x,
        z,
        piece,
        pieceClass: 'cliffFaceTallNarrow',
        placementKind: 'cliffFaceCluster',
        embedding: 'authoredCliffShoulderCluster',
        clusterId,
        clusterMember,
        clusterSize: DESERT_ROCK_CLIFF_CLUSTER_MEMBERS,
        clusterTargetSize: DESERT_ROCK_CLIFF_CLUSTER_MEMBERS,
        clusterComplete: false,
        clusterRadius,
        cliffPlacement,
        cliffMask,
        cliffPlacementMask,
        grade,
        yaw: clusterRoll + (rollSeed - 0.5) * 0.70,
        desiredLongAxis,
        buryFraction: buryRange[0] + (buryRange[1] - buryRange[0]) * burySeed,
        nearField,
    };
}

function buildDesertGroundRockPlacements(heightAt = terrainHeightAt) {
    const placements = [];
    const maximumAttempts = DESERT_ROCK_GROUND_INSTANCE_TARGET * 112;
    for (let attempt = 0;
        attempt < maximumAttempts && placements.length < DESERT_ROCK_GROUND_INSTANCE_TARGET;
        attempt++
    ) {
        const nearField = hash2(attempt, 17, 811) < 0.70;
        const halfExtent = nearField ? HALF_NEAR - 24 : 720;
        const x = (hash2(attempt, 31, 823) * 2 - 1) * halfExtent;
        const z = (hash2(attempt, 47, 827) * 2 - 1) * halfExtent;
        if (!nearField && Math.max(Math.abs(x), Math.abs(z)) < HALF_NEAR + 32) continue;
        if (desertRockCommonExclusionAt(x, z)) continue;
        if (authoredCliffMaskAt(x, z) > 0.04) continue;
        const { grade } = desertRockGradeAt(heightAt, x, z);
        if (grade > DESERT_ROCK_GROUND_MAX_GRADE) continue;
        const groupRoll = hash2(attempt, 53, 835);
        const group = groupRoll < 0.30
            ? 'largeFlatWide'
            : groupRoll < 0.72 ? 'mediumIrregular' : 'smallSmoothRound';
        const groupPieces = DESERT_ROCK_PIECE_GROUPS[group];
        const piece = groupPieces[Math.min(
            groupPieces.length - 1,
            Math.floor(hash2(attempt, 59, 839) * groupPieces.length),
        )];
        const sizeSeed = hash2(attempt, 71, 853);
        const authoredRange = DESERT_ROCK_DIAMETER_RANGES[group];
        const sizeT = Math.min(
            1,
            sizeSeed ** 1.35 + (nearField ? 0 : 0.06),
        );
        const desiredDiameter = authoredRange[0]
            + (authoredRange[1] - authoredRange[0]) * sizeT;
        const minimumSpacing = nearField ? 7.5 : 12;
        if (!desertRockHasClearance(
            placements,
            x,
            z,
            desiredDiameter,
            minimumSpacing,
        )) continue;
        placements.push({
            x,
            z,
            piece,
            pieceClass: DESERT_ROCK_PIECE_CLASS[piece],
            yaw: hash2(attempt, 83, 857) * Math.PI * 2,
            desiredDiameter,
            placementKind: 'ground',
            grade,
            nearField,
        });
    }
    if (placements.length !== DESERT_ROCK_GROUND_INSTANCE_TARGET) {
        throw new Error(
            `Desert rock scatter produced ${placements.length} of `
            + `${DESERT_ROCK_GROUND_INSTANCE_TARGET} requested ground placements`,
        );
    }
    return placements;
}

function desertCliffClusterCandidateAt(heightAt, cliff, localX, localZ) {
    const cosYaw = Math.cos(cliff.yaw), sinYaw = Math.sin(cliff.yaw);
    const x = cliff.x + localX * cosYaw + localZ * sinYaw;
    const z = cliff.z - localX * sinYaw + localZ * cosYaw;
    const cliffMask = authoredCliffMaskAt(x, z);
    const cliffPlacementMask = authoredCliffPlacementMaskAt(cliff, x, z);
    if (cliffPlacementMask < DESERT_ROCK_CLIFF_SHOULDER_MASK_RANGE[0]
        || cliffPlacementMask > DESERT_ROCK_CLIFF_SHOULDER_MASK_RANGE[1]
        || desertRockCommonExclusionAt(x, z)
    ) return null;
    const { grade } = desertRockGradeAt(heightAt, x, z);
    if (grade < DESERT_ROCK_CLIFF_CLUSTER_MIN_GRADE) return null;
    return { x, z, grade, cliffMask, cliffPlacementMask };
}

function buildDesertCliffClusterPlacements(heightAt) {
    const placements = [];
    const tallPieces = DESERT_ROCK_PIECE_GROUPS.cliffFaceTallNarrow;
    const maximumAnchorAttempts = 4096;
    const maximumMemberAttempts = 192;
    for (let cliffIndex = 0;
        cliffIndex < DESERT_CLIFF_PLACEMENTS.length;
        cliffIndex++
    ) {
        const cliff = DESERT_CLIFF_PLACEMENTS[cliffIndex];
        let completedCluster = null;
        let bestPartialCluster = [];
        for (let anchorAttempt = 0;
            anchorAttempt < maximumAnchorAttempts && !completedCluster;
            anchorAttempt++
        ) {
            const anchorKey = cliffIndex * maximumAnchorAttempts + anchorAttempt;
            const anchorLocalX = (hash2(anchorKey, 137, 919) * 2 - 1)
                * (cliff.halfLength + 20) * 0.92;
            const anchorLocalZ = (hash2(anchorKey, 139, 929) * 2 - 1)
                * (cliff.halfDepth + 24) * 0.92;
            if (!desertCliffClusterCandidateAt(
                heightAt, cliff, anchorLocalX, anchorLocalZ,
            )) continue;
            const radiusRange = DESERT_ROCK_CLIFF_CLUSTER_RADIUS_METRES;
            const clusterRadius = radiusRange[0]
                + (radiusRange[1] - radiusRange[0]) * hash2(anchorKey, 173, 959);
            const members = [];
            let failed = false;
            for (let member = 0;
                member < DESERT_ROCK_CLIFF_CLUSTER_MEMBERS;
                member++
            ) {
                const pair = Math.floor(member / 2);
                const pairKey = anchorKey * 8 + pair;
                const pairAngle = hash2(pairKey, 179, 967) * Math.PI * 2;
                const pairRadius = clusterRadius
                    * (0.18 + hash2(pairKey, 181, 971) * 0.46);
                const baseAlong = Math.cos(pairAngle) * pairRadius;
                const baseAcross = Math.sin(pairAngle) * pairRadius * 0.55;
                const pairSign = member % 2 === 0 ? -1 : 1;
                const overlapOffset = pairSign
                    * (1.25 + hash2(pairKey, 191, 977) * 1.15);
                let accepted = null;
                for (let memberAttempt = 0;
                    memberAttempt < maximumMemberAttempts && !accepted;
                    memberAttempt++
                ) {
                    const memberKey = anchorKey * 8192
                        + member * maximumMemberAttempts + memberAttempt;
                    const along = baseAlong - Math.sin(pairAngle) * overlapOffset
                        + (hash2(memberKey, 193, 983) - 0.5) * 1.8;
                    const across = baseAcross + Math.cos(pairAngle) * overlapOffset * 0.55
                        + (hash2(memberKey, 197, 991) - 0.5) * 1.2;
                    const sampled = desertCliffClusterCandidateAt(
                        heightAt,
                        cliff,
                        anchorLocalX + along,
                        anchorLocalZ + across,
                    );
                    if (!sampled || members.some((item) => (
                        (item.x - sampled.x) ** 2 + (item.z - sampled.z) ** 2 < 0.8 ** 2
                    ))) continue;
                    const piece = tallPieces[(cliffIndex + member) % tallPieces.length];
                    accepted = makeCliffClusterRockPlacement({
                        ...sampled,
                        piece,
                        nearField: Math.max(Math.abs(sampled.x), Math.abs(sampled.z))
                            <= HALF_NEAR,
                        rollSeed: hash2(memberKey, 199, 997),
                        sizeSeed: hash2(memberKey, 211, 1009),
                        burySeed: hash2(memberKey, 223, 1013),
                        clusterId: cliffIndex,
                        clusterMember: member,
                        clusterRadius,
                        cliffPlacement: cliff.name,
                    });
                    accepted.clusterPair = pair;
                    accepted.clusterOffsetMetres = Math.hypot(along, across);
                }
                if (!accepted) {
                    failed = true;
                    break;
                }
                members.push(accepted);
            }
            if (members.length > bestPartialCluster.length) {
                bestPartialCluster = members;
            }
            if (!failed && members.length === DESERT_ROCK_CLIFF_CLUSTER_MEMBERS) {
                completedCluster = members;
            }
        }
        const selectedCluster = completedCluster ?? bestPartialCluster;
        const actualClusterSize = selectedCluster.length;
        for (const placement of selectedCluster) {
            placement.clusterSize = actualClusterSize;
            placement.clusterComplete = actualClusterSize
                === DESERT_ROCK_CLIFF_CLUSTER_MEMBERS;
        }
        placements.push(...selectedCluster);
    }
    return placements;
}

function buildDesertRockPlacements(heightAt = terrainHeightAt) {
    const ground = buildDesertGroundRockPlacements(heightAt);
    const cliffClusters = buildDesertCliffClusterPlacements(heightAt);
    // Cliff dressing is deliberately best-effort. Terrain or exclusion changes
    // may make an authored shoulder unable to support all eight decorative
    // members; that must reduce the instance count, never abort world loading.
    return ground.concat(cliffClusters);
}

function macroAt(x, z) {
    // Separate kilometre-, outcrop-, and wash-scale fields keep the ground
    // from reading as one uniformly tiled sheet even where the PBR set is the
    // same. The range stays physically plausible under the scene lighting.
    const broad = fbm(x * 0.0017 + 31, z * 0.0017 - 17, 271, 4);
    const local = fbm(x * 0.0105 - 19, z * 0.0105 + 43, 283, 4);
    return 0.74 + broad * 0.30 + local * 0.22;
}

function tintAt(x, z) {
    const warm = fbm(x * 0.0028 + 9, z * 0.0028 - 21, 289, 4) - 0.5;
    const pale = fbm(x * 0.0071 - 37, z * 0.0071 + 18, 293, 3) - 0.5;
    const crater = craterFieldsAt(x, z);
    const fusedDarkening = crater.inner * 0.34 + crater.rimZone * 0.10;
    return [
        (1.03 + warm * 0.22 + pale * 0.08) * (1 - fusedDarkening * 0.78),
        (0.99 + warm * 0.10 + pale * 0.06) * (1 - fusedDarkening * 0.88),
        (0.94 - warm * 0.16 + pale * 0.04) * (1 - fusedDarkening),
    ];
}

function interleavedSelectorAt(x, z, seed) {
    // Low-frequency ownership is continuous across the entire terrain. A
    // domain-warped 58-90 m field establishes deposits; 19-21 m patches and
    // 8-10 m chips keep every camera-sized area geologically mixed. There is
    // deliberately no center, radius, signed-distance shape, or regional mask.
    const warpX = (fbm(x * 0.0071 + seed, z * 0.0067 - seed, seed + 17, 3) - 0.5) * 23;
    const warpZ = (fbm(x * 0.0063 - seed, z * 0.0075 + seed, seed + 29, 3) - 0.5) * 23;
    const broad = fbm(
        (x + warpX) * 0.0131 + seed * 0.071,
        (z + warpZ) * 0.0117 - seed * 0.053,
        seed + 43, 3,
    );
    const patches = fbm(
        (x - warpZ * 0.31) * 0.052 + seed * 0.113,
        (z + warpX * 0.31) * 0.047 - seed * 0.089,
        seed + 71, 3,
    );
    const chips = valueNoise(
        (x + warpX * 0.18) * 0.118 + seed * 0.19,
        (z - warpZ * 0.18) * 0.103 - seed * 0.17,
        seed + 101,
    );
    return smooth(0.20, 0.80, broad * 0.18 + patches * 0.55 + chips * 0.27);
}

const SURFACE_ORGANIC_POLICY = Object.freeze({
    // The authored SeedThree brush must own the silhouette of material
    // transitions. Continuous domain-warped selectors retain broad deposits;
    // the brush supplies their irregular, hand-shaped per-fragment edges.
    authoredShapeShare: 0.68,
    familyCrossfade: 0.30,
    familyCrossfadePower: 2,
    rockFamilyCrossfade: 0.38,
    craterExposureSelector: Object.freeze([0.11, 0.15]),
    craterRockEligibility: 0.20,
    craterRock061Bias: 0.30,
    groundElevationTrends: Object.freeze([-0.18, 0.10, -0.14, -0.10, 0.18]),
    talusElevationMeters: Object.freeze([8, 24]),
    talusGradeSignal: Object.freeze([0.107143, 0.230769]),
    talusSummitFadeMeters: Object.freeze([32, 50]),
});

function interleavedRockPairAt(x, z, seed) {
    // Rock029 and Rock061 both belong throughout exposed terrain. Their pair
    // selector intentionally omits the broad octave used by soil deposits so
    // neither scan can monopolize an entire 128 m hillside. Independent
    // 8-19 m warped patches still resolve to one readable rock at a point.
    const warpX = (fbm(x * 0.011 + seed, z * 0.0103 - seed, seed + 11, 3) - 0.5) * 12;
    const warpZ = (fbm(x * 0.0107 - seed, z * 0.0113 + seed, seed + 23, 3) - 0.5) * 12;
    const patches = fbm(
        (x + warpX) * 0.061 + seed * 0.097,
        (z + warpZ) * 0.054 - seed * 0.073,
        seed + 47, 3,
    );
    const chips = fbm(
        (x - warpZ * 0.24) * 0.128 + seed * 0.13,
        (z + warpX * 0.24) * 0.112 - seed * 0.11,
        seed + 79, 2,
    );
    return smooth(0.20, 0.80, patches * 0.58 + chips * 0.42);
}

function resolvePaintOwnership(
    selectors,
    brushValues = null,
    physicalGrade = 0,
    elevation = 0,
    fragmentWashSupport = null,
    worldX = 0,
    worldZ = 0,
) {
    const brush = brushValues ?? [0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5];
    const shaped = selectors.map((selector, index) => {
        const threshold = clamp01(brush[index]) * 0.70 + 0.15;
        return smooth(threshold - 0.22, threshold + 0.22, selector);
    });
    const rawShapeShare = 1 - SURFACE_ORGANIC_POLICY.authoredShapeShare;
    const features = selectors.map((selector, index) => (
        clamp01(selector * rawShapeShare
            + shaped[index] * SURFACE_ORGANIC_POLICY.authoredShapeShare)
    ));
    const grade = Math.max(0, physicalGrade);
    const gradeSignal = grade / (1 + grade);
    const slopeRock = smooth(0.137931, 0.305556, gradeSignal)
        * (0.82 + 0.18 * smooth(0.305556, 0.444444, gradeSignal));
    const heightRock = Math.max(
        0.70 * smooth(12, 30, elevation),
        smooth(35, 50, elevation),
    );
    const physicalRockEligibility = Math.max(heightRock, slopeRock);
    // Selector zero carries the authored exposed-geology signal. Ordinary
    // low flats remain below 0.11; the depressed crater bowl occupies the
    // narrow 0.15+ band even where height and grade alone would call it soil.
    // Suppressing this term as physical eligibility rises keeps it local to
    // the blast bowl rather than turning it into another slope router.
    const craterExposure = smooth(
        ...SURFACE_ORGANIC_POLICY.craterExposureSelector, selectors[0],
    ) * (1 - physicalRockEligibility);
    const rockEligibility = Math.max(
        physicalRockEligibility,
        craterExposure * SURFACE_ORGANIC_POLICY.craterRockEligibility,
    );
    const faceGate = smooth(0.305556, 0.444444, gradeSignal);
    const summitPure = smooth(35, 50, elevation);
    const highFlat = smooth(25, 50, elevation) * (1 - faceGate);
    const coarseGround = smooth(4, 18, elevation);

    const fieldScore = (value) => Math.pow(
        0.08 + clamp01(value) * 0.92,
        3,
    );
    const sparseFamily = (
        scores, softness = SURFACE_ORGANIC_POLICY.familyCrossfade,
    ) => {
        let firstIndex;
        let secondIndex;
        if (scores[0] > scores[1]) {
            firstIndex = 0;
            secondIndex = 1;
        } else {
            firstIndex = 1;
            secondIndex = 0;
        }
        for (let index = 2; index < scores.length; index++) {
            if (scores[index] > scores[firstIndex]) {
                secondIndex = firstIndex;
                firstIndex = index;
            } else if (scores[index] > scores[secondIndex]) {
                secondIndex = index;
            }
        }
        const first = scores[firstIndex];
        const second = scores[secondIndex];
        const margin = (first - second) / Math.max(first + second, 1e-5);
        const edgeSoftness = softness * (0.88 + features[0] * 0.24);
        // Relative-gap gating gives every nearby candidate a continuous fade.
        // The former hard top-two runner-up swap could abruptly replace one
        // secondary material with another and draw a thin cut line through an
        // otherwise organic transition. Distant candidates still become
        // exactly zero, so this remains a sparse rather than soup-like blend.
        const blendWeights = scores.map((score) => {
            const relativeGap = (first - score) / Math.max(first + score, 1e-5);
            const candidateFade = 1 - smooth(0, edgeSoftness, relativeGap);
            return Math.pow(candidateFade, SURFACE_ORGANIC_POLICY.familyCrossfadePower);
        });
        const blendTotal = blendWeights.reduce((sum, weight) => sum + weight, 0);
        const weights = blendWeights.map((weight) => weight / Math.max(blendTotal, 1e-8));
        return { weights, margin, firstIndex, secondIndex };
    };

    const groundPrimaries = [
        features[1], features[6], features[2], features[3],
        1 - features[1],
    ];
    const groundHeightSignal = coarseGround * 2 - 1;
    const groundScores = groundPrimaries.map((primary, index) => (
        fieldScore(primary)
        * (1 + SURFACE_ORGANIC_POLICY.groundElevationTrends[index] * groundHeightSignal)
    ));
    const washScores = [
        fieldScore(features[1]),
        fieldScore(features[2]),
        fieldScore(features[6]),
    ];
    const faceCandidate = smooth(0.137931, 0.305556, gradeSignal);
    const nonFace = 1 - faceGate;
    const faceStrength = Math.max(faceCandidate * 1.30, faceGate);
    const talusElevation = smooth(
        ...SURFACE_ORGANIC_POLICY.talusElevationMeters, elevation,
    );
    const talusGrade = smooth(
        ...SURFACE_ORGANIC_POLICY.talusGradeSignal, gradeSignal,
    );
    const talusSummitFade = 1 - smooth(
        ...SURFACE_ORGANIC_POLICY.talusSummitFadeMeters, elevation,
    );
    const talusGate = Math.max(talusElevation * 0.62, talusGrade)
        * talusSummitFade * nonFace;
    const rockScores = [
        fieldScore(features[5]) * nonFace,
        (fieldScore(features[2])
            + craterExposure * SURFACE_ORGANIC_POLICY.craterRock061Bias) * nonFace,
        fieldScore(features[1]) * faceStrength + faceGate * 0.01,
        fieldScore(1 - features[1]) * faceStrength + faceGate * 0.01,
        fieldScore(features[3]) * nonFace * (0.78 + highFlat * 0.50),
        fieldScore(features[6]) * talusGate * 1.15,
    ];
    const groundOwnership = sparseFamily(groundScores);
    const washOwnership = sparseFamily(washScores);
    const rockOwnership = sparseFamily(
        rockScores, SURFACE_ORGANIC_POLICY.rockFamilyCrossfade,
    );
    const groundMembers = groundOwnership.weights;
    const washMembers = washOwnership.weights;
    const rockMembers = rockOwnership.weights;

    // A second analytic support value keeps wash layers mathematically zero
    // beyond the channel, even where interpolated vertex selectors remain >0.
    const washSupport = fragmentWashSupport ?? selectors[4];
    const mudPresence = smooth(0.000001, 0.0001, washSupport);
    const baseWash = selectors[4] <= 0 || washSupport <= 0
        ? 0 : Math.min(0.64,
            selectors[4] * (0.44 + shaped[4] * 0.16) * mudPresence);
    const washFamily = baseWash * (1 - summitPure) * (1 - faceGate);
    const nonWash = 1 - washFamily;
    const groundFamily = (1 - rockEligibility) * nonWash;
    const rockFamily = rockEligibility * nonWash;
    const raw = [
        groundMembers[0] * groundFamily,
        groundMembers[1] * groundFamily,
        groundMembers[2] * groundFamily,
        groundMembers[3] * groundFamily,
        washMembers[0] * washFamily,
        rockMembers[0] * rockFamily,
        rockMembers[1] * rockFamily,
        washMembers[1] * washFamily,
        rockMembers[2] * rockFamily,
        washMembers[2] * washFamily,
        groundMembers[4] * groundFamily,
        rockMembers[3] * rockFamily,
        rockMembers[4] * rockFamily,
        rockMembers[5] * rockFamily,
    ];
    const total = raw.reduce((sum, value) => sum + value, 0);
    const weights = total > 1e-8
        ? raw.map((value) => value / total)
        : [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    return {
        weights,
        families: { ground: groundFamily, wash: washFamily, rock: rockFamily },
        familyMembers: {
            ground: groundMembers,
            wash: washMembers,
            rock: rockMembers,
        },
        familyScores: {
            ground: groundScores,
            wash: washScores,
            rock: rockScores,
        },
        familyMargins: {
            ground: groundOwnership.margin,
            wash: washOwnership.margin,
            rock: rockOwnership.margin,
        },
        faceGate,
        highFlat,
        coarseGround,
        talusGate,
    };
}

function resolvePaintSelectors(
    selectors,
    brushValues = null,
    physicalGrade = 0,
    elevation = 0,
    fragmentWashSupport = null,
    worldX = 0,
    worldZ = 0,
) {
    return resolvePaintOwnership(
        selectors, brushValues, physicalGrade, elevation, fragmentWashSupport,
        worldX, worldZ,
    ).weights;
}

function paintAt(x, z, grade = 0, elevation = terrainHeightAt(x, z)) {
    // Stage one mirrors SeedThree's vertex-painted selector model: independent
    // global fields establish interleaved ownership everywhere, while terrain
    // signals only bias which family is eligible. Stage two happens per pixel
    // in makeTerrainMaterial, where the authored grayscale brush thresholds
    // these selectors at independent scales/phases before final normalization.
    const crater = craterFieldsAt(x, z);
    const familyBreakup = interleavedSelectorAt(x, z, 353);
    const heightWarp = (familyBreakup - 0.5) * 10;
    const slopeWarp = (interleavedSelectorAt(x, z, 379) - 0.5) * 0.12;
    const terrainElevation = elevation + heightWarp;
    const terrainGrade = Math.max(0, grade + slopeWarp);
    const highTerrain = smooth(10, 25, terrainElevation);
    const physicalHigh = smooth(12, 20, elevation);
    const exposedSlope = smooth(0.16, 0.44, terrainGrade);
    const physicalExposedSlope = smooth(0.16, 0.32, grade);
    const exposedTerrain = Math.max(
        0.075,
        physicalHigh * 0.85,
        physicalExposedSlope * 0.85,
        clamp01(
        0.035
        + highTerrain * 0.64
        + exposedSlope * 0.30
        - highTerrain * exposedSlope * 0.14
        + (familyBreakup - 0.5) * 0.13
        + crater.inner * 0.16
        + crater.rimZone * 0.10,
        ),
    );
    const flat = 1 - smooth(0.12, 0.46, terrainGrade);
    const wash = clamp01(washMaskAt(x, z) * flat);
    const selectors = [
        Math.min(0.90, exposedTerrain),
        interleavedSelectorAt(x, z, 601),
        interleavedSelectorAt(x, z, 653),
        interleavedSelectorAt(x, z, 709),
        wash,
        interleavedRockPairAt(x, z, 503),
        clamp01(interleavedSelectorAt(x, z, 823) * 0.70
            + (1 - highTerrain) * 0.20 + 0.05),
    ];
    const ownership = resolvePaintOwnership(
        selectors, null, grade, elevation, washMaskAt(x, z), x, z,
    );
    const weights = ownership.weights;
    return {
        selectors,
        weights,
        ownership,
        RockyTrail02: weights[0],
        DryGroundRocks: weights[1],
        RedLateriteSoilStones: weights[2],
        CrackedRedGround: weights[3],
        MudCrackedDryRiverbed002: weights[4],
        Rock029: weights[5],
        Rock061: weights[6],
        GravellySand: weights[7],
        RockFace03: weights[8],
        SandyGravel02: weights[9],
        RockyTrail: weights[10],
        RockFace: weights[11],
        RockBoulderCracked: weights[12],
        RocksGround02: weights[13],
    };
}

function addSurfaceAttributes(T3, geometry) {
    const position = geometry.getAttribute('position');
    const normal = geometry.getAttribute('normal');
    const macros = new Float32Array(position.count);
    const tints = new Float32Array(position.count * 3);
    const splatA = new Float32Array(position.count * 4);
    const splatB = new Float32Array(position.count * 4);
    for (let index = 0; index < position.count; index++) {
        const x = position.getX(index), z = position.getZ(index);
        const ny = Math.max(0.025, Math.abs(normal.getY(index)));
        const grade = Math.hypot(normal.getX(index), normal.getZ(index)) / ny;
        // Position Y is the exact rendered terrain elevation. Passing it avoids
        // recomputing the full analytic height field for every splat vertex.
        const paint = paintAt(x, z, grade, position.getY(index));
        macros[index] = macroAt(x, z);
        const tint = tintAt(x, z);
        tints[index * 3] = tint[0];
        tints[index * 3 + 1] = tint[1];
        tints[index * 3 + 2] = tint[2];
        splatA.set(paint.selectors.slice(0, 4), index * 4);
        splatB[index * 4] = paint.selectors[4];
        splatB[index * 4 + 1] = paint.selectors[5];
        splatB[index * 4 + 2] = paint.selectors[6];
        // Preserve physical slope for the fragment material without adding
        // another vertex buffer. q = grade/(1+grade) is bounded and stable
        // under interpolation; q=.444444 corresponds to rise/run=.80.
        splatB[index * 4 + 3] = grade / (1 + grade);
    }
    geometry.setAttribute('terrainMacro', new T3.BufferAttribute(macros, 1));
    geometry.setAttribute('terrainTint', new T3.BufferAttribute(tints, 3));
    geometry.setAttribute('terrainSplatA', new T3.BufferAttribute(splatA, 4));
    geometry.setAttribute('terrainSplatB', new T3.BufferAttribute(splatB, 4));
}

function analyticTerrainNormal(x, z, step = 0.8) {
    const dx = (terrainHeightAt(x + step, z) - terrainHeightAt(x - step, z)) / (step * 2);
    const dz = (terrainHeightAt(x, z + step) - terrainHeightAt(x, z - step)) / (step * 2);
    const inverseLength = 1 / Math.hypot(dx, 1, dz);
    return [-dx * inverseLength, inverseLength, -dz * inverseLength];
}

function harmonizeTerrainSeamNormals(T3, geometry, predicate) {
    // The near grid and four horizon sectors have intentionally different
    // tessellation densities. Their independently averaged boundary normals
    // can therefore disagree even though every boundary position is exact,
    // producing a visible false crack. Only shared seam vertices need the
    // common analytic normal; retaining mesh normals elsewhere keeps terrain
    // construction inexpensive.
    const position = geometry.getAttribute('position');
    const normal = geometry.getAttribute('normal');
    for (let index = 0; index < position.count; index++) {
        const x = position.getX(index), z = position.getZ(index);
        if (!predicate(x, z)) continue;
        const [nx, ny, nz] = analyticTerrainNormal(x, z);
        normal.setXYZ(index, nx, ny, nz);
    }
    normal.needsUpdate = true;
}

function makeHorizonGeometry(T3) {
    // Four square trapezoid fans meet the dense terrain on its exact boundary.
    // The old circular ring began 22 m *inside* the square, was downward-wound,
    // and alternated between overlap and open gaps around the corners.
    const outerHalf = HORIZON_HALF;
    const radialSegments = HORIZON_RADIAL_SEGMENTS;
    const edgeSegments = NEAR_SEGMENTS;
    const verticesPerSide = (radialSegments + 1) * (edgeSegments + 1);
    const positions = new Float32Array(verticesPerSide * 4 * 3);
    const indices = [];
    let cursor = 0;
    for (let side = 0; side < 4; side++) {
        for (let ring = 0; ring <= radialSegments; ring++) {
            const t = ring / radialSegments;
            const half = HALF_NEAR + (outerHalf - HALF_NEAR) * Math.pow(t, 1.46);
            for (let edge = 0; edge <= edgeSegments; edge++) {
                const u = edge / edgeSegments * 2 - 1;
                let x, z;
                if (side === 0) { x = u * half; z = half; }
                else if (side === 1) { x = half; z = -u * half; }
                else if (side === 2) { x = -u * half; z = -half; }
                else { x = -half; z = u * half; }
                positions[cursor * 3] = x;
                positions[cursor * 3 + 1] = terrainHeightAt(x, z);
                positions[cursor * 3 + 2] = z;
                cursor++;
            }
        }
    }

    const pushUp = (a, b, c) => {
        const ax = positions[a * 3], az = positions[a * 3 + 2];
        const bx = positions[b * 3] - ax, bz = positions[b * 3 + 2] - az;
        const cx = positions[c * 3] - ax, cz = positions[c * 3 + 2] - az;
        // y component of cross(b-a, c-a); swap when it faces down.
        if (bz * cx - bx * cz >= 0) indices.push(a, b, c);
        else indices.push(a, c, b);
    };
    for (let side = 0; side < 4; side++) {
        const base = side * verticesPerSide;
        for (let ring = 0; ring < radialSegments; ring++) {
            for (let edge = 0; edge < edgeSegments; edge++) {
                const a = base + ring * (edgeSegments + 1) + edge;
                const b = a + 1;
                const c = a + edgeSegments + 1;
                const d = c + 1;
                pushUp(a, b, c);
                pushUp(b, d, c);
            }
        }
    }
    const geometry = new T3.BufferGeometry();
    geometry.setAttribute('position', new T3.BufferAttribute(positions, 3));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();
    harmonizeTerrainSeamNormals(T3, geometry, (x, z) => (
        Math.abs(Math.max(Math.abs(x), Math.abs(z)) - HALF_NEAR) < 1e-4
        || Math.abs(Math.abs(x) - Math.abs(z)) < 1e-4
    ));
    addSurfaceAttributes(T3, geometry);
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    return geometry;
}

function makeHorizonHeightSampler(geometry) {
    // Instances beyond the dense 384 m half-extent must sit on the rendered
    // triangle surface, not the smoother analytic function sampled only at
    // horizon vertices. The latter can differ substantially as radial cells
    // widen, making otherwise well-seated distant plants appear to hover.
    const position = geometry.getAttribute('position');
    const edgeSegments = NEAR_SEGMENTS;
    const row = edgeSegments + 1;
    const verticesPerSide = (HORIZON_RADIAL_SEGMENTS + 1) * row;
    const halfSteps = Array.from({ length: HORIZON_RADIAL_SEGMENTS + 1 }, (_, ring) => (
        HALF_NEAR + (HORIZON_HALF - HALF_NEAR)
            * Math.pow(ring / HORIZON_RADIAL_SEGMENTS, 1.46)
    ));

    const interpolateTriangle = (x, z, a, b, c) => {
        const ax = position.getX(a), az = position.getZ(a);
        const bx = position.getX(b), bz = position.getZ(b);
        const cx = position.getX(c), cz = position.getZ(c);
        const denominator = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
        if (Math.abs(denominator) < 1e-12) return { inside: false, height: position.getY(a), minimumWeight: -Infinity };
        const wa = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / denominator;
        const wb = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / denominator;
        const wc = 1 - wa - wb;
        return {
            inside: wa >= -1e-7 && wb >= -1e-7 && wc >= -1e-7,
            minimumWeight: Math.min(wa, wb, wc),
            height: position.getY(a) * wa + position.getY(b) * wb + position.getY(c) * wc,
        };
    };

    return (x, z) => {
        const absX = Math.abs(x), absZ = Math.abs(z);
        const half = Math.max(absX, absZ);
        if (half <= HALF_NEAR || half > HORIZON_HALF) return terrainHeightAt(x, z);

        let side, u;
        if (z >= absX) { side = 0; u = x / z; }
        else if (x >= absZ) { side = 1; u = -z / x; }
        else if (-z >= absX) { side = 2; u = -x / -z; }
        else { side = 3; u = z / -x; }
        u = Math.max(-1, Math.min(1, u));

        let ring = 0;
        while (ring < HORIZON_RADIAL_SEGMENTS - 1 && half > halfSteps[ring + 1]) ring++;
        const edge = Math.max(0, Math.min(edgeSegments - 1,
            Math.floor((u + 1) * 0.5 * edgeSegments)));
        const base = side * verticesPerSide + ring * row + edge;
        const a = base;
        const b = base + 1;
        const c = base + row;
        const d = c + 1;
        const first = interpolateTriangle(x, z, a, b, c);
        if (first.inside) return first.height;
        const second = interpolateTriangle(x, z, b, d, c);
        // A point exactly on a sector/cell boundary can be a few ulps outside
        // both tests. Select the closer triangle rather than reverting to the
        // analytic surface and reintroducing a height discontinuity.
        return second.inside || second.minimumWeight >= first.minimumWeight
            ? second.height
            : first.height;
    };
}

async function decodePngRgba(blob, url, expectedWidth, expectedHeight) {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const signature = [137, 80, 78, 71, 13, 10, 26, 10];
    if (bytes.length < signature.length
        || signature.some((value, index) => bytes[index] !== value)) {
        throw new Error('Terrain runtime texture is not a PNG: ' + url);
    }

    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const idatChunks = [];
    let width = 0;
    let height = 0;
    let sawHeader = false;
    let sawEnd = false;
    let offset = signature.length;
    while (offset + 12 <= bytes.length) {
        const length = view.getUint32(offset, false);
        const typeOffset = offset + 4;
        const dataOffset = offset + 8;
        const dataEnd = dataOffset + length;
        const nextOffset = dataEnd + 4;
        if (dataEnd < dataOffset || nextOffset > bytes.length) {
            throw new Error('Terrain runtime PNG has a truncated chunk: ' + url);
        }
        const type = String.fromCharCode(
            bytes[typeOffset], bytes[typeOffset + 1],
            bytes[typeOffset + 2], bytes[typeOffset + 3],
        );
        if (type === 'IHDR') {
            if (sawHeader || length !== 13) {
                throw new Error('Terrain runtime PNG has an invalid IHDR: ' + url);
            }
            sawHeader = true;
            width = view.getUint32(dataOffset, false);
            height = view.getUint32(dataOffset + 4, false);
            const bitDepth = bytes[dataOffset + 8];
            const colorType = bytes[dataOffset + 9];
            const compression = bytes[dataOffset + 10];
            const filterMethod = bytes[dataOffset + 11];
            const interlace = bytes[dataOffset + 12];
            if (bitDepth !== 8 || colorType !== 6
                || compression !== 0 || filterMethod !== 0 || interlace !== 0) {
                throw new Error(
                    'Terrain runtime PNG must be non-interlaced RGBA8: ' + url,
                );
            }
        } else if (type === 'IDAT') {
            if (!sawHeader) {
                throw new Error('Terrain runtime PNG has IDAT before IHDR: ' + url);
            }
            idatChunks.push(bytes.slice(dataOffset, dataEnd));
        } else if (type === 'IEND') {
            sawEnd = true;
            break;
        }
        offset = nextOffset;
    }

    if (!sawHeader || !sawEnd || idatChunks.length === 0) {
        throw new Error('Terrain runtime PNG is missing required chunks: ' + url);
    }
    if (width !== expectedWidth || height !== expectedHeight) {
        throw new Error(
            'Terrain runtime texture must be true '
            + expectedWidth + 'x' + expectedHeight + ': ' + url,
        );
    }
    if (typeof DecompressionStream !== 'function') {
        throw new Error('This browser cannot decode byte-exact terrain PNG data.');
    }

    const compressedStream = new Blob(idatChunks).stream();
    const inflatedBuffer = await new Response(
        compressedStream.pipeThrough(new DecompressionStream('deflate')),
    ).arrayBuffer();
    const inflated = new Uint8Array(inflatedBuffer);
    const bytesPerPixel = 4;
    const stride = width * bytesPerPixel;
    const expectedInflatedBytes = (stride + 1) * height;
    if (inflated.length !== expectedInflatedBytes) {
        throw new Error('Terrain runtime PNG scanline size is invalid: ' + url);
    }

    const decoded = new Uint8Array(stride * height);
    const paeth = (left, up, upLeft) => {
        const prediction = left + up - upLeft;
        const leftDistance = Math.abs(prediction - left);
        const upDistance = Math.abs(prediction - up);
        const diagonalDistance = Math.abs(prediction - upLeft);
        if (leftDistance <= upDistance && leftDistance <= diagonalDistance) return left;
        return upDistance <= diagonalDistance ? up : upLeft;
    };
    let sourceOffset = 0;
    for (let row = 0; row < height; row++) {
        const filter = inflated[sourceOffset++];
        if (filter > 4) {
            throw new Error('Terrain runtime PNG uses an unknown filter: ' + url);
        }
        const rowOffset = row * stride;
        for (let column = 0; column < stride; column++) {
            const raw = inflated[sourceOffset++];
            const left = column >= bytesPerPixel
                ? decoded[rowOffset + column - bytesPerPixel] : 0;
            const up = row > 0 ? decoded[rowOffset - stride + column] : 0;
            const upLeft = row > 0 && column >= bytesPerPixel
                ? decoded[rowOffset - stride + column - bytesPerPixel] : 0;
            let predictor = 0;
            if (filter === 1) predictor = left;
            else if (filter === 2) predictor = up;
            else if (filter === 3) predictor = Math.floor((left + up) * 0.5);
            else if (filter === 4) predictor = paeth(left, up, upLeft);
            decoded[rowOffset + column] = (raw + predictor) & 255;
        }
    }
    return decoded;
}

async function loadGroundTextures(T3, renderer = null) {
    const packageRoot = './assets/pbr/eanpa_southwest_ground_v3';
    const runtimeSet = (fileStem, heightFile) => ({
        albedoSource2k: `${packageRoot}/runtime/${fileStem}_AlbedoGrade_2K.png`,
        packedSource2k: `${packageRoot}/runtime/${fileStem}_PackedNxyRoughAO_2K.png`,
        albedoFallback: `${packageRoot}/runtime/fallback_1k/${fileStem}_AlbedoHeight_1K.png`,
        packedFallback: `${packageRoot}/runtime/fallback_1k/${fileStem}_PackedNxyRoughAO_1K.png`,
        height: `${packageRoot}/sources/${heightFile}`,
    });
    const surfaceLayers = [
        {
            id: 'polyhaven_rocky_trail_02', semantic: 'dominant-alluvial-gravel-and-stony-trail',
            tileMeters: SURFACE_TILE_METERS.RockyTrail02,
            ...runtimeSet('RockyTrail02', 'RockyTrail02_Displacement_4K.jpg'),
        },
        {
            id: 'polyhaven_dry_ground_rocks', semantic: 'stony-transition-soil',
            tileMeters: SURFACE_TILE_METERS.DryGroundRocks,
            ...runtimeSet('DryGroundRocks', 'DryGroundRocks_Displacement_4K.jpg'),
        },
        {
            id: 'polyhaven_red_laterite_soil_stones', semantic: 'warm-gravel-transition-soil',
            tileMeters: SURFACE_TILE_METERS.RedLateriteSoilStones,
            ...runtimeSet('RedLateriteSoilStones', 'RedLateriteSoilStones_Displacement_4K.png'),
        },
        {
            id: 'polyhaven_cracked_red_ground', semantic: 'compacted-cracked-flats',
            tileMeters: SURFACE_TILE_METERS.CrackedRedGround,
            ...runtimeSet('CrackedRedGround', 'CrackedRedGround_Displacement_4K.jpg'),
        },
        {
            id: 'polyhaven_mud_cracked_dry_riverbed_002', semantic: 'authored-dry-washes-only',
            tileMeters: SURFACE_TILE_METERS.MudCrackedDryRiverbed002,
            ...runtimeSet('MudCrackedDryRiverbed002', 'MudCrackedDryRiverbed002_Displacement_4K.jpg'),
        },
        {
            id: 'ambientcg_Rock029', semantic: 'orange-bedrock-and-steep-outcrop',
            tileMeters: SURFACE_TILE_METERS.Rock029,
            ...runtimeSet('Rock029', 'Rock029_Displacement_4K.jpg'),
        },
        {
            id: 'ambientcg_Rock061', semantic: 'tan-bedrock-and-outcrop-transition',
            tileMeters: SURFACE_TILE_METERS.Rock061,
            ...runtimeSet('Rock061', 'Rock061_Displacement_4K.jpg'),
        },
        {
            id: 'GravellySand', semantic: 'wash-gravel-and-sand-transition',
            provider: 'Poly Haven', tileMeters: SURFACE_TILE_METERS.GravellySand,
            ...runtimeSet('GravellySand', 'GravellySand_Displacement_4K.jpg'),
        },
        {
            id: 'RockFace03', semantic: 'layered-rock-face-outcrop',
            provider: 'Poly Haven', tileMeters: SURFACE_TILE_METERS.RockFace03,
            ...runtimeSet('RockFace03', 'RockFace03_Displacement_4K.jpg'),
        },
        {
            id: 'SandyGravel02', semantic: 'wash-sandy-gravel-transition',
            provider: 'Poly Haven', tileMeters: SURFACE_TILE_METERS.SandyGravel02,
            ...runtimeSet('SandyGravel02', 'SandyGravel02_Displacement_4K.jpg'),
        },
        {
            id: 'RockyTrail', semantic: 'compact-rocky-ground-transition',
            provider: 'Poly Haven', tileMeters: SURFACE_TILE_METERS.RockyTrail,
            ...runtimeSet('RockyTrail', 'RockyTrail_Displacement_4K.jpg'),
        },
        {
            id: 'RockFace', semantic: 'weathered-rock-face-outcrop',
            provider: 'Poly Haven', tileMeters: SURFACE_TILE_METERS.RockFace,
            ...runtimeSet('RockFace', 'RockFace_Displacement_4K.jpg'),
        },
        {
            id: 'RockBoulderCracked', semantic: 'cracked-boulder-and-high-outcrop',
            provider: 'Poly Haven', tileMeters: SURFACE_TILE_METERS.RockBoulderCracked,
            ...runtimeSet('RockBoulderCracked', 'RockBoulderCracked_Displacement_4K.jpg'),
        },
        {
            id: 'RocksGround02', semantic: 'talus-and-elevated-rock-strewn-transition',
            provider: 'Poly Haven', tileMeters: SURFACE_TILE_METERS.RocksGround02,
            ...runtimeSet('RocksGround02', 'RocksGround02_Displacement_4K.jpg'),
        },
    ];

    if (surfaceLayers.length !== SURFACE_LAYER_COUNT) {
        throw new Error(`Terrain layer contract changed: ${surfaceLayers.length}`);
    }

    const loadPixels = async (url, expectedSize) => {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`Terrain texture failed ${response.status}: ${url}`);
        const blob = await response.blob();
        // Decode PNG scanlines directly. Canvas readback can premultiply RGB by
        // the newly meaningful height alpha and can color-convert numeric PBR
        // bytes. This path preserves all four authored bytes and their shared
        // top-left row order exactly.
        return decodePngRgba(
            blob, url, expectedSize, expectedSize,
        );
    };

    const annotateArray = (texture, key, {
        srgb = false,
        runtimeSize,
        runtimeKind,
        generateMipmaps,
    }) => {
        texture.name = `eanpa_surface_${key}_${runtimeKind}`;
        texture.colorSpace = srgb ? T3.SRGBColorSpace : T3.NoColorSpace;
        texture.wrapS = texture.wrapT = T3.RepeatWrapping;
        texture.minFilter = T3.LinearMipmapLinearFilter;
        texture.magFilter = T3.LinearFilter;
        texture.generateMipmaps = generateMipmaps;
        texture.anisotropy = 8;
        texture.flipY = false;
        texture.needsUpdate = true;
        texture.userData.layers = surfaceLayers.map((layer) => layer.id);
        texture.userData.runtimeSize = runtimeSize;
        texture.userData.runtimeKind = runtimeKind;
        texture.userData.channelPacking = key === 'packed'
            ? 'R=normalX_G=normalY_B=roughness_A=ambientOcclusion'
            : 'RGB=sRGB-albedo_A=linear-relative-height';
        texture.userData.pixelOrientation =
            'top-left-row-preserved_world-positive-Z-is-increasing-image-V';
        return texture;
    };

    const makeFallbackArray = async (key, { srgb = false } = {}) => {
        const layerBytes = SURFACE_FALLBACK_SIZE * SURFACE_FALLBACK_SIZE * 4;
        const packed = new Uint8Array(layerBytes * surfaceLayers.length);
        // Decode one source at a time. Fourteen concurrent image decodes would
        // create a needless transient spike; both arrays remain immutable and
        // are shared by near and horizon materials.
        for (let index = 0; index < surfaceLayers.length; index++) {
            const url = surfaceLayers[index][
                key === 'albedo' ? 'albedoFallback' : 'packedFallback'
            ];
            const pixels = await loadPixels(url, SURFACE_FALLBACK_SIZE);
            packed.set(pixels, index * layerBytes);
        }
        const texture = new T3.DataArrayTexture(
            packed, SURFACE_FALLBACK_SIZE, SURFACE_FALLBACK_SIZE, surfaceLayers.length,
        );
        texture.format = T3.RGBAFormat;
        texture.type = T3.UnsignedByteType;
        return annotateArray(texture, key, {
            srgb,
            runtimeSize: SURFACE_FALLBACK_SIZE,
            runtimeKind: 'rgba8-png-1k-fallback',
            generateMipmaps: true,
        });
    };

    const loadCompressedArrays = async () => {
        if (!renderer) throw new Error('renderer-unavailable-for-KTX2-detectSupport');
        const { KTX2Loader } = await import('three/addons/loaders/KTX2Loader.js');
        const loader = new KTX2Loader();
        loader.setTranscoderPath(SURFACE_KTX2_TRANSCODER_PATH);
        loader.detectSupport(renderer);
        let albedo = null;
        let packed = null;
        const acceptedFormats = [
            T3.RGBA_ASTC_4x4_Format,
            T3.RGBA_BPTC_Format,
            T3.RGBA_ETC2_EAC_Format,
            T3.RGBA_S3TC_DXT5_Format,
        ].filter((value) => value !== undefined);
        const validate = (texture, label) => {
            const image = texture?.image ?? {};
            if (texture?.isCompressedArrayTexture !== true
                || image.width !== SURFACE_RUNTIME_SIZE
                || image.height !== SURFACE_RUNTIME_SIZE
                || image.depth !== SURFACE_LAYER_COUNT
                || !acceptedFormats.includes(texture.format)
                || (texture.mipmaps?.length ?? 0) < 12) {
                throw new Error(`invalid-${label}-compressed-array`);
            }
        };
        try {
            // Sequential transcodes bound the worker and temporary-memory peak.
            albedo = await loader.loadAsync(SURFACE_KTX2_ALBEDO_URL);
            validate(albedo, 'albedo-height');
            packed = await loader.loadAsync(SURFACE_KTX2_PACKED_URL);
            validate(packed, 'normal-rough-ao');
            return {
                albedo: annotateArray(albedo, 'albedo', {
                    srgb: true,
                    runtimeSize: SURFACE_RUNTIME_SIZE,
                    runtimeKind: 'uastc-ktx2-2k-compressed-array',
                    generateMipmaps: false,
                }),
                packed: annotateArray(packed, 'packed', {
                    runtimeSize: SURFACE_RUNTIME_SIZE,
                    runtimeKind: 'uastc-ktx2-2k-compressed-array',
                    generateMipmaps: false,
                }),
            };
        } catch (error) {
            albedo?.dispose();
            packed?.dispose();
            throw error;
        } finally {
            loader.dispose();
        }
    };

    let surfaceArray;
    let textureRuntime;
    let runtimeResolution;
    let gpuBaseLevelBytes;
    let gpuEstimatedMipBytes;
    let compressionFallbackReason = null;
    try {
        surfaceArray = await loadCompressedArrays();
        textureRuntime = 'uastc-ktx2-2k-compressed-array';
        runtimeResolution = SURFACE_RUNTIME_SIZE;
        // BC7, ASTC 4x4, and ETC2 RGBA are all 8 bpp. The mip estimate includes
        // the minimum 4x4 block allocation for the final sub-block levels.
        gpuBaseLevelBytes = 117440512;
        gpuEstimatedMipBytes = 156588096;
    } catch (error) {
        compressionFallbackReason = String(error?.message ?? error);
        console.warn(
            '[terrain] 2K compressed arrays unavailable; using verified 1K RGBA8 fallback:',
            compressionFallbackReason,
        );
        surfaceArray = {
            albedo: await makeFallbackArray('albedo', { srgb: true }),
            packed: await makeFallbackArray('packed'),
        };
        textureRuntime = 'rgba8-png-1k-fallback';
        runtimeResolution = SURFACE_FALLBACK_SIZE;
        gpuBaseLevelBytes = 117440512;
        gpuEstimatedMipBytes = 156587312;
    }

    const blendBrush = await new T3.TextureLoader().loadAsync(TERRAIN_BLEND_BRUSH_URL);
    blendBrush.name = 'eanpa_seedthree_authored_terrain_blend_brush';
    blendBrush.colorSpace = T3.NoColorSpace;
    blendBrush.wrapS = blendBrush.wrapT = T3.RepeatWrapping;
    blendBrush.minFilter = T3.LinearMipmapLinearFilter;
    blendBrush.magFilter = T3.LinearFilter;
    blendBrush.generateMipmaps = true;
    blendBrush.anisotropy = 8;
    blendBrush.flipY = false;
    blendBrush.needsUpdate = true;
    blendBrush.userData.role =
        'authored-per-pixel-threshold_breaks-global-vertex-material-selectors';
    blendBrush.userData.sourceProject = 'SeedThree';
    blendBrush.userData.sha256 =
        '4fd44ca5c00b83c897423d1a849bd2e184684b1dc16b88e28e905ddeec2ab62b';
    return {
        surfaceArray,
        blendBrush,
        surfaceLayers: surfaceLayers.map((layer) => layer.id),
        textureRuntime,
        runtimeResolution,
        gpuBaseLevelBytes,
        gpuEstimatedMipBytes,
        compressionFallbackReason,
        // Retain unmodified height inputs now; the later SPOM implementation
        // can consume them without another material migration.
        spomHeightSources: surfaceLayers.map((layer, index) => ({
            id: layer.id,
            url: layer.height,
            channel: 'luminance',
            tileMeters: [...layer.tileMeters],
            retainedResolution: '4K-master',
            runtimeBlendUrl: textureRuntime === 'uastc-ktx2-2k-compressed-array'
                ? SURFACE_KTX2_ALBEDO_URL : layer.albedoFallback,
            runtimeBlendLayer: index,
            runtimeBlendChannel: 'A',
            runtimeBlendResolution: runtimeResolution,
            runtimeUse: 'bounded-material-transition-height_plus-future-4K-SPOM-master',
            enabled: false,
        })),
    };
}

function makeTerrainMaterial(T3, maps, { far = false } = {}) {
    const material = new T3.MeshStandardNodeMaterial({ metalness: 0, roughness: 1 });
    const worldPosition = T3.positionWorld;
    const world = worldPosition.xz;
    const geometricWorldNormal = T3.normalize(T3.normalWorldGeometry);
    // Scene-calibrated spans are intentionally distinct from capture metadata.
    // Every layer owns one stable rotation, so transitions never line up as a
    // single repeating grid while aggregate size remains physically legible.
    const layerTransforms = [
        [1 / SURFACE_TILE_METERS.RockyTrail02[0], 1.0, 0.0],
        [1 / SURFACE_TILE_METERS.DryGroundRocks[0], 0.990268, 0.139173],
        [1 / SURFACE_TILE_METERS.RedLateriteSoilStones[0], 0.978148, -0.207912],
        [1 / SURFACE_TILE_METERS.CrackedRedGround[0], 0.951057, 0.309017],
        [1 / SURFACE_TILE_METERS.MudCrackedDryRiverbed002[0], 0.965926, -0.258819],
        [1 / SURFACE_TILE_METERS.Rock029[0], 0.923880, 0.382683],
        [1 / SURFACE_TILE_METERS.Rock061[0], 0.939693, -0.342020],
        [1 / SURFACE_TILE_METERS.GravellySand[0], 0.891007, 0.453990],
        [1 / SURFACE_TILE_METERS.RockFace03[0], 0.891007, -0.453990],
        [1 / SURFACE_TILE_METERS.SandyGravel02[0], 0.838671, 0.544639],
        [1 / SURFACE_TILE_METERS.RockyTrail[0], 0.848048, -0.529919],
        [1 / SURFACE_TILE_METERS.RockFace[0], 0.788011, 0.615661],
        [1 / SURFACE_TILE_METERS.RockBoulderCracked[0], 0.798636, -0.601815],
        [1 / SURFACE_TILE_METERS.RocksGround02[0], 0.731354, 0.681998],
    ];
    const selectorA = T3.attribute('terrainSplatA', 'vec4').clamp(0, 1);
    const selectorB = T3.attribute('terrainSplatB', 'vec4').clamp(0, 1);
    const rawSelectors = [
        selectorA.x, selectorA.y, selectorA.z, selectorA.w,
        selectorB.x, selectorB.y, selectorB.z,
    ];
    // SeedThree's authored grayscale brush does not choose geography. It
    // thresholds each globally interpolated selector at a distinct world-XZ
    // period and phase, turning smooth vertex gradients into independent,
    // ragged interlocking fronts at fragment resolution.
    // The brush THRESHOLDS every layer selector, and the top-5 layer cut is
    // a hard membership boundary. Implicit-gradient sampling tied the brush's
    // mip level to the screen footprint, so pitching the camera washed the
    // thresholds region-wide and whole distant areas swapped their selected
    // texture layers in one visible snap. Explicit radial-distance LOD keeps
    // the brush content identical no matter where the camera points.
    const brushViewDistance = T3.positionView.length();
    const brushWorldPerPixel = brushViewDistance.mul(0.00084).max(1e-6);
    const brushTexelSize = maps.blendBrush.image?.width ?? 1024;
    const brushMipCap = Math.log2(brushTexelSize);
    const brushSamples = TERRAIN_BLEND_BRUSH_TRANSFORMS.map((transform, index) => {
        const brushUv = world.div(transform.repeatMeters).add(T3.vec2(...transform.offset));
        const brushLod = T3.log2(
            brushWorldPerPixel.mul(brushTexelSize / transform.repeatMeters),
        ).clamp(0, brushMipCap);
        return T3.texture(maps.blendBrush, brushUv).level(brushLod).r
            .toVar('terrainBlendBrush' + index);
    });
    const shapedSelectors = rawSelectors.map((selector, index) => {
        const threshold = brushSamples[index].mul(0.70).add(0.15);
        return T3.smoothstep(threshold.sub(0.22), threshold.add(0.22), selector)
            .toVar('terrainShapedSelector' + index);
    });
    const features = rawSelectors.map((selector, index) => (
        selector.mul(1 - SURFACE_ORGANIC_POLICY.authoredShapeShare)
            .add(shapedSelectors[index].mul(SURFACE_ORGANIC_POLICY.authoredShapeShare))
            .clamp(0, 1)
            .toVar('terrainOwnershipFeature' + index)
    ));
    const gradeSignal = selectorB.w;
    const elevation = T3.positionWorld.y;
    const slopeRock = T3.smoothstep(0.137931, 0.305556, gradeSignal).mul(
        T3.mix(
            T3.float(0.82),
            T3.float(1),
            T3.smoothstep(0.305556, 0.444444, gradeSignal),
        ),
    );
    const heightRock = T3.max(
        T3.smoothstep(12, 30, elevation).mul(0.70),
        T3.smoothstep(35, 50, elevation),
    );
    const physicalRockEligibility = T3.max(heightRock, slopeRock);
    const craterExposure = T3.smoothstep(
        ...SURFACE_ORGANIC_POLICY.craterExposureSelector, rawSelectors[0],
    ).mul(physicalRockEligibility.oneMinus());
    const rockEligibility = T3.max(
        physicalRockEligibility,
        craterExposure.mul(SURFACE_ORGANIC_POLICY.craterRockEligibility),
    );
    const faceGate = T3.smoothstep(0.305556, 0.444444, gradeSignal);
    const summitPure = T3.smoothstep(35, 50, elevation);
    const highFlat = T3.smoothstep(25, 50, elevation).mul(faceGate.oneMinus());
    const coarseGround = T3.smoothstep(4, 18, elevation);

    const fieldScore = (value) => value.clamp(0, 1)
        .mul(0.92).add(0.08).pow(3);
    const sparseFamily = (
        scores, softness = SURFACE_ORGANIC_POLICY.familyCrossfade,
    ) => {
        const firstWins = scores[0].greaterThan(scores[1]);
        let firstScore = firstWins.select(scores[0], scores[1]);
        let firstIndex = firstWins.select(T3.int(0), T3.int(1));
        let secondScore = firstWins.select(scores[1], scores[0]);
        let secondIndex = firstWins.select(T3.int(1), T3.int(0));
        for (let index = 2; index < scores.length; index++) {
            const winsFirst = scores[index].greaterThan(firstScore);
            const winsSecond = scores[index].greaterThan(secondScore);
            const nextSecondScore = winsFirst.select(
                firstScore,
                winsSecond.select(scores[index], secondScore),
            );
            const nextSecondIndex = winsFirst.select(
                firstIndex,
                winsSecond.select(T3.int(index), secondIndex),
            );
            firstScore = winsFirst.select(scores[index], firstScore);
            firstIndex = winsFirst.select(T3.int(index), firstIndex);
            secondScore = nextSecondScore;
            secondIndex = nextSecondIndex;
        }
        const margin = firstScore.sub(secondScore)
            .div(firstScore.add(secondScore).max(0.00001));
        const edgeSoftness = features[0].mul(0.24).add(0.88).mul(softness);
        const blendWeights = scores.map((score) => {
            const relativeGap = firstScore.sub(score)
                .div(firstScore.add(score).max(0.00001));
            return T3.float(1).sub(T3.smoothstep(0, edgeSoftness, relativeGap))
                .pow(SURFACE_ORGANIC_POLICY.familyCrossfadePower);
        });
        const blendTotal = blendWeights.reduce(
            (sum, weight) => sum.add(weight), T3.float(0),
        ).max(0.00001);
        const weights = blendWeights.map((weight) => weight.div(blendTotal));
        return { weights, margin };
    };

    const groundPrimaries = [
        features[1], features[6], features[2], features[3],
        features[1].oneMinus(),
    ];
    const groundElevationTrends = SURFACE_ORGANIC_POLICY.groundElevationTrends;
    const groundHeightSignal = coarseGround.mul(2).sub(1);
    const groundScores = groundPrimaries.map((primary, index) => (
        fieldScore(primary)
            .mul(groundHeightSignal.mul(groundElevationTrends[index]).add(1))
    ));
    const washScores = [
        fieldScore(features[1]),
        fieldScore(features[2]),
        fieldScore(features[6]),
    ];
    const faceCandidate = T3.smoothstep(0.137931, 0.305556, gradeSignal);
    const nonFace = faceGate.oneMinus();
    const faceStrength = T3.max(faceCandidate.mul(1.30), faceGate);
    const talusElevation = T3.smoothstep(
        ...SURFACE_ORGANIC_POLICY.talusElevationMeters, elevation,
    );
    const talusGrade = T3.smoothstep(
        ...SURFACE_ORGANIC_POLICY.talusGradeSignal, gradeSignal,
    );
    const talusSummitFade = T3.smoothstep(
        ...SURFACE_ORGANIC_POLICY.talusSummitFadeMeters, elevation,
    ).oneMinus();
    const talusGate = T3.max(talusElevation.mul(0.62), talusGrade)
        .mul(talusSummitFade).mul(nonFace);
    const rockScores = [
        fieldScore(features[5]).mul(nonFace),
        fieldScore(features[2])
            .add(craterExposure.mul(SURFACE_ORGANIC_POLICY.craterRock061Bias))
            .mul(nonFace),
        fieldScore(features[1]).mul(faceStrength).add(faceGate.mul(0.01)),
        fieldScore(features[1].oneMinus()).mul(faceStrength).add(faceGate.mul(0.01)),
        fieldScore(features[3]).mul(nonFace).mul(highFlat.mul(0.50).add(0.78)),
        fieldScore(features[6]).mul(talusGate).mul(1.15),
    ];
    const groundOwnership = sparseFamily(groundScores);
    const washOwnership = sparseFamily(washScores);
    const rockOwnership = sparseFamily(
        rockScores, SURFACE_ORGANIC_POLICY.rockFamilyCrossfade,
    );
    const groundMembers = groundOwnership.weights;
    const washMembers = washOwnership.weights;
    const rockMembers = rockOwnership.weights;

    // Re-evaluate the authored wash footprint per fragment. The selector is a
    // vertex attribute, so using it alone would leak mud a few metres beyond
    // the near triangles and much farther across coarse horizon triangles.
    const washChannelA = world.y.mul(0.11).add(16)
        .add(T3.sin(world.y.mul(0.018).add(0.7)).mul(13));
    const washChannelB = world.y.mul(-0.07).sub(94)
        .add(T3.sin(world.y.mul(0.013).sub(1.8)).mul(19));
    const fragmentWashA = T3.float(1).sub(T3.smoothstep(
        5, 28, T3.abs(world.x.sub(washChannelA)),
    ));
    const fragmentWashB = T3.float(1).sub(T3.smoothstep(
        7, 35, T3.abs(world.x.sub(washChannelB)),
    )).mul(0.72);
    const fragmentWashSupport = T3.max(fragmentWashA, fragmentWashB);
    const mudPresence = T3.smoothstep(0.000001, 0.0001, fragmentWashSupport);
    const baseWash = rawSelectors[4]
        .mul(shapedSelectors[4].mul(0.16).add(0.44))
        .min(0.64)
        .mul(mudPresence);
    const washFamily = baseWash
        .mul(summitPure.oneMinus())
        .mul(faceGate.oneMinus());
    const nonWash = washFamily.oneMinus();
    const groundFamily = rockEligibility.oneMinus().mul(nonWash);
    const rockFamily = rockEligibility.mul(nonWash);
    const rawSplatWeights = [
        groundMembers[0].mul(groundFamily),
        groundMembers[1].mul(groundFamily),
        groundMembers[2].mul(groundFamily),
        groundMembers[3].mul(groundFamily),
        washMembers[0].mul(washFamily),
        rockMembers[0].mul(rockFamily),
        rockMembers[1].mul(rockFamily),
        washMembers[1].mul(washFamily),
        rockMembers[2].mul(rockFamily),
        washMembers[2].mul(washFamily),
        groundMembers[4].mul(groundFamily),
        rockMembers[3].mul(rockFamily),
        rockMembers[4].mul(rockFamily),
        rockMembers[5].mul(rockFamily),
    ];
    const weightSum = rawSplatWeights.reduce(
        (sum, weight) => sum.add(weight), T3.float(0),
    ).max(0.00001);
    const baseWeights = rawSplatWeights.map((weight) => weight.div(weightSum));
    const macro = T3.attribute('terrainMacro', 'float');
    const tint = T3.attribute('terrainTint', 'vec3');
    // Per-source color unification is baked by the v3 builder. Runtime macro
    // variation only breaks kilometre-scale uniformity and cannot repaint the
    // scan detail or create giant gravel.
    const broadVariation = tint.mul(macro).clamp(0.78, 1.12);
    // Two offset scan samples break repeated stones/cracks while every PBR
    // channel retains the same coordinates. The variation is fixed in world
    // space; camera motion cannot change which texture phase owns a point.
    const variationPhase=T3.mx_noise_float(world.mul(.035),3.5,4).toVar('terrainTexturePhase');
    const variationCell=T3.floor(variationPhase);
    const variationBlend=T3.smoothstep(.2,.8,T3.fract(variationPhase));
    const offsetFor=(cell,layer)=>T3.sin(T3.vec2(12.3,31.7).mul(cell.add(1))
        .add(T3.float(layer).mul(19.13))).mul(.43);

    // Select the five strongest pre-height weights before touching either PBR
    // array. Only nonzero layers fetch their paired texture phases on each
    // binding; no hidden fourteen-layer select tree samples discarded layers.
    const TOP_K = 5;
    const selectTopK = (sourceWeights) => {
        const selected = [];
        for (let slot = 0; slot < TOP_K; slot++) {
            const available = sourceWeights.map((weight, layer) => {
                let candidate = weight;
                for (const prior of selected) {
                    candidate = prior.layer.equal(T3.int(layer))
                        .select(T3.float(0), candidate);
                }
                return candidate;
            });
            let bestWeight = available[0];
            let bestLayer = T3.int(0);
            for (let layer = 1; layer < available.length; layer++) {
                const wins = available[layer].greaterThan(bestWeight);
                bestLayer = wins.select(T3.int(layer), bestLayer);
                bestWeight = wins.select(available[layer], bestWeight);
            }
            selected.push({
                layer: bestLayer.toVar(`terrainTopLayer${slot}`),
                weight: bestWeight.toVar(`terrainTopPreHeightWeight${slot}`),
            });
        }
        return selected;
    };
    const selected = selectTopK(baseWeights);

    const dynamicTransformFor = (layer, slot) => {
        let transform = T3.vec3(...layerTransforms[0]);
        for (let index = 1; index < layerTransforms.length; index++) {
            transform = layer.equal(T3.int(index))
                .select(T3.vec3(...layerTransforms[index]), transform);
        }
        return transform.toVar(`terrainTopTransform${slot}`);
    };
    const transformCoordinate = (coordinate, transform) => T3.vec2(
        coordinate.x.mul(transform.x).mul(transform.y)
            .sub(coordinate.y.mul(transform.x).mul(transform.z)),
        coordinate.x.mul(transform.x).mul(transform.z)
            .add(coordinate.y.mul(transform.x).mul(transform.y)),
    );
    // Biplanar projection (Quilez): use the strongest two geometric axes.
    // Removing the weakest component below 1/sqrt(3) makes plane changes
    // continuous. Flat ground takes only the first texture sample; steep
    // faces blend actual projections, without shearing or warping the scans.
    const absoluteNormal = T3.abs(geometricWorldNormal).toVar('terrainAbsNormal');
    const strongestAxis = (n) => {
        const x = n.x.greaterThanEqual(n.y).and(n.x.greaterThanEqual(n.z));
        const y = x.not().and(n.y.greaterThanEqual(n.z));
        return {
            axis: x.select(T3.vec3(1, 0, 0), y.select(T3.vec3(0, 1, 0), T3.vec3(0, 0, 1))),
            u: x.select(T3.vec3(0, 0, 1), T3.vec3(1, 0, 0)),
            v: y.select(T3.vec3(0, 0, 1), T3.vec3(0, 1, 0)),
        };
    };
    const primary = strongestAxis(absoluteNormal);
    const secondary = strongestAxis(absoluteNormal.mul(primary.axis.oneMinus()));
    const primaryWeight = T3.dot(absoluteNormal, primary.axis).sub(0.577350269).max(0).pow(2);
    const secondaryWeight = T3.dot(absoluteNormal, secondary.axis).sub(0.577350269).max(0).pow(2);
    const planeBlend = secondaryWeight.div(primaryWeight.add(secondaryWeight).max(0.000001))
        .toVar('terrainSecondaryPlaneWeight');
    const coordinateFor = (plane) => T3.vec2(T3.dot(worldPosition, plane.u), T3.dot(worldPosition, plane.v));
    const primaryCoordinate = coordinateFor(primary);
    const secondaryCoordinate = coordinateFor(secondary);
    // Differentiate position before selecting axes. Derivatives of selected
    // UVs would see artificial jumps at projection boundaries and choose a
    // much blurrier mip than the actual pixel footprint.
    const positionDx = worldPosition.dFdx(), positionDy = worldPosition.dFdy();
    const gradientFor = (gradient, plane) => T3.vec2(T3.dot(gradient, plane.u), T3.dot(gradient, plane.v));
    const selectedSlots = selected.map((entry, slot) => {
        const transform = dynamicTransformFor(entry.layer, slot);
        const uvNode = transformCoordinate(primaryCoordinate, transform)
            .toVar(`terrainTopUv${slot}`);
        const gradX = transformCoordinate(gradientFor(positionDx, primary), transform)
            .toVar(`terrainTopGradX${slot}`);
        const gradY = transformCoordinate(gradientFor(positionDy, primary), transform)
            .toVar(`terrainTopGradY${slot}`);
        const offsetA=offsetFor(variationCell,entry.layer),offsetB=offsetFor(variationCell.add(1),entry.layer);
        const variedSample=(key,coordinate,dx,dy)=>T3.mix(
            T3.texture(maps.surfaceArray[key],coordinate.add(offsetA)).depth(entry.layer).grad(dx,dy),
            T3.texture(maps.surfaceArray[key],coordinate.add(offsetB)).depth(entry.layer).grad(dx,dy),variationBlend);
        const sampleArray = (key) => T3.Fn(()=>{
            const dx=gradX.toVar(),dy=gradY.toVar(),value=T3.vec4(0).toVar();
            // Most terrain pixels have one or two contributing layers. Do not
            // fetch all five shortlisted scans where their weights are zero.
            T3.If(entry.weight.greaterThan(.0001),()=>{value.assign(variedSample(key,uvNode,dx,dy));});
            return value;
        })();
        const secondaryUv = transformCoordinate(secondaryCoordinate, transform);
        const secondaryDx = transformCoordinate(gradientFor(positionDx, secondary), transform);
        const secondaryDy = transformCoordinate(gradientFor(positionDy, secondary), transform);
        const sampleSecondary = (key) => T3.Fn(() => {
            const dx = secondaryDx.toVar(), dy = secondaryDy.toVar();
            const sampled = T3.vec4(0).toVar();
            T3.If(planeBlend.greaterThan(0.0001).and(entry.weight.greaterThan(.0001)), () => {
                sampled.assign(variedSample(key,secondaryUv,dx,dy));
            });
            return sampled;
        })();
        const albedoPrimary = sampleArray('albedo').toVar(`terrainTopAlbedo${slot}`);
        const packedPrimary = sampleArray('packed').toVar(`terrainTopPacked${slot}`);
        const albedoSecondary = sampleSecondary('albedo').toVar(`terrainSideAlbedo${slot}`);
        const packedSecondary = sampleSecondary('packed').toVar(`terrainSidePacked${slot}`);
        return {
            ...entry,
            transform,
            uvNode,
            gradX,
            gradY,
            albedo: T3.mix(albedoPrimary, albedoSecondary, planeBlend),
            packed: T3.mix(packedPrimary, packedSecondary, planeBlend),
            packedPrimary, packedSecondary,
        };
    });
    const albedoSamples = selectedSlots.map((slot) => slot.albedo);
    const packedSamples = selectedSlots.map((slot) => slot.packed);
    const nearBoundary = T3.max(T3.abs(world.x), T3.abs(world.y));
    // Alpha is a normalized 2K displacement channel packed beside albedo. The
    // sRGB texture transform touches RGB only; alpha remains linear. Height can
    // therefore choose which photographed surface owns a transition without a
    // third sampler or another decoded array. It never creates displacement:
    // zero base weight stays zero and a bounded factor only affects boundaries.
    const heightBlendAmplitude = far ? T3.float(0.10) : T3.float(0.22);
    const heightBiasedWeights = selectedSlots.map((slot) => {
        const weight = slot.weight;
        const boundary = T3.float(1).sub(T3.smoothstep(0.62, 0.90, weight));
        const heightFactor = T3.mix(
            T3.float(1),
            T3.mix(
                T3.float(1).sub(heightBlendAmplitude),
                T3.float(1).add(heightBlendAmplitude),
                slot.albedo.a,
            ),
            boundary,
        );
        return weight.mul(heightFactor);
    });
    const heightWeightSum = heightBiasedWeights.reduce(
        (sum, weight) => sum.add(weight), T3.float(0),
    ).max(0.00001);
    const weights = heightBiasedWeights.map((weight) => weight.div(heightWeightSum));
    const weightedMix = (samples) => {
        let mixed = samples[0].mul(weights[0]);
        for (let index = 1; index < samples.length; index++) {
            mixed = mixed.add(samples[index].mul(weights[index]));
        }
        return mixed;
    };
    const mixedAlbedo = weightedMix(albedoSamples);
    const mixedPacked = weightedMix(packedSamples);

    const decodePackedNormal = (sample) => {
        const stored = sample.rg.mul(2).sub(1);
        // Runtime images retain top-left row order. Image V increases downward
        // while NormalGL +Y increases upward, so flip Y exactly once here.
        const xy = T3.vec2(stored.x, stored.y.negate());
        const z = T3.sqrt(T3.float(1).sub(T3.dot(xy, xy)).max(0.0001));
        return T3.vec3(xy, z);
    };
    const alignNormalToWorldUv = (sample, cosine, sine) => T3.vec3(
        sample.x.mul(cosine).add(sample.y.mul(sine)),
        sample.y.mul(cosine).sub(sample.x.mul(sine)),
        sample.z,
    );
    const projectedNormalToWorld = (normal, plane) => geometricWorldNormal
        .add(plane.u.mul(normal.x)).add(plane.v.mul(normal.y))
        .add(plane.axis.mul(T3.dot(geometricWorldNormal, plane.axis)).mul(normal.z.sub(1)));
    const normalSamples = selectedSlots.map((slot) => {
        const aligned = (sample) => alignNormalToWorldUv(decodePackedNormal(sample), slot.transform.y, slot.transform.z);
        // Whiteout reorientation preserves the geometric normal for a flat
        // normal map on either plane, including vertical faces and blends.
        return T3.mix(projectedNormalToWorld(aligned(slot.packedPrimary), primary),
            projectedNormalToWorld(aligned(slot.packedSecondary), secondary), planeBlend);
    });
    const mixedNormalLinear = T3.normalize(weightedMix(normalSamples));
    // True radial camera distance. The previous view-space Z (depth along the
    // camera's forward axis) changed with pure camera ROTATION, sliding this
    // fade band across the world: whole terrain chunks crossed it together
    // and their relief/roughness flipped in one visible step.
    const viewDistance = T3.positionView.length();
    const reliefDistanceFade = T3.smoothstep(70, 520, viewDistance);
    const localNormalStrength = T3.mix(
        T3.float(1.0), T3.float(0.38), reliefDistanceFade,
    );
    const normalStrength = far
        ? T3.float(0.38)
        : T3.mix(localNormalStrength, T3.float(0.38),
            T3.smoothstep(336, 376, nearBoundary));
    const mappedWorldNormal = T3.normalize(T3.mix(geometricWorldNormal, mixedNormalLinear, normalStrength));
    const nearRoughness = mixedPacked.b.sub(0.72).mul(1.22).add(0.72);
    const farRoughness = mixedPacked.b.sub(0.72).mul(0.86).add(0.72);
    const resolvedRoughness = far
        ? farRoughness
        : T3.mix(nearRoughness, farRoughness, reliefDistanceFade);
    material.colorNode = mixedAlbedo.rgb.mul(broadVariation);
    material.roughnessNode = resolvedRoughness.clamp(0.42, 1);
    material.normalNode = T3.normalize(
        T3.cameraViewMatrix.transformDirection(mappedWorldNormal),
    );
    material.aoNode = mixedPacked.a.mul(0.84).add(0.16);
    material.userData.pbrSource = '14-layer Poly Haven + ambientCG CC0 Southwest surface arrays';
    material.userData.arrayLayers = Array.from({ length: 14 }, (_, index) => index);
    material.userData.familyLayers = {
        ground: [0, 1, 2, 3, 10],
        wash: [4, 7, 9],
        rock: [5, 6, 8, 11, 12, 13],
    };
    material.userData.paintPolicy =
        'organic-authored_5-ground_3-exact-wash_6-rock-and-talus_sparse-ownership';
    material.userData.splatAttributes = [
        'terrainSplatA', 'terrainSplatB',
    ];
    material.userData.splatAttributeSemantics = [
        'exposed-family-gate', 'dry-ground-selector', 'laterite-selector',
        'cracked-ground-selector', 'exact-wash-gate', 'Rock061-selector',
        'base-gravel-modulation', 'bounded-physical-grade',
    ];
    material.userData.organicOwnershipPolicy = {
        authoredShapeShare: SURFACE_ORGANIC_POLICY.authoredShapeShare,
        continuousSelectorShare: 1 - SURFACE_ORGANIC_POLICY.authoredShapeShare,
        relativeGapCrossfade: SURFACE_ORGANIC_POLICY.familyCrossfade,
        relativeGapCrossfadePower: SURFACE_ORGANIC_POLICY.familyCrossfadePower,
        rockRelativeGapCrossfade: SURFACE_ORGANIC_POLICY.rockFamilyCrossfade,
        continuousSecondaryFade: true,
        groundElevationTrends: [...SURFACE_ORGANIC_POLICY.groundElevationTrends],
        talusElevationMeters: [...SURFACE_ORGANIC_POLICY.talusElevationMeters],
        talusGradeSignal: [...SURFACE_ORGANIC_POLICY.talusGradeSignal],
        talusSummitFadeMeters: [...SURFACE_ORGANIC_POLICY.talusSummitFadeMeters],
        craterExposureSelector: [...SURFACE_ORGANIC_POLICY.craterExposureSelector],
        craterRockEligibility: SURFACE_ORGANIC_POLICY.craterRockEligibility,
        craterRock061Bias: SURFACE_ORGANIC_POLICY.craterRock061Bias,
        evaluation: 'continuous-domain-warped-vertex-selectors_plus-authored-per-fragment-brush',
        squareCellLattice: false,
    };
    material.userData.transitionPolicy =
        'domain-warped-selectors_seedthree-brush-dominant_soft-irregular-crossfades_height-slope-gates_height-alpha';
    material.userData.geologicStratification = {
        softGroundElevationBiasMeters: [4, 18],
        groundElevationTrends: [...SURFACE_ORGANIC_POLICY.groundElevationTrends],
        heightRockElevationMeters: [12, 30],
        summitRockOnlyElevationMeters: [35, 50],
        talusLayer: 13,
        talusElevationMeters: [...SURFACE_ORGANIC_POLICY.talusElevationMeters],
        talusGradeSignal: [...SURFACE_ORGANIC_POLICY.talusGradeSignal],
        talusSummitFadeMeters: [...SURFACE_ORGANIC_POLICY.talusSummitFadeMeters],
        exactLowFlatTalusPolicy: 'zero-when-rock-family-is-ineligible',
        faceTransitionRiseRun: [0.44, 0.80],
        exactSummitPolicy: 'elevation>=50_ground-and-wash-zero',
        exactFacePolicy: 'rise-run>=0.80_only-RockFace03-and-RockFace',
        familyActiveChildPolicy: 'continuous-relative-gap-gated_sparse-crossfade',
        childCrossfadeMargin: SURFACE_ORGANIC_POLICY.familyCrossfade,
        childCrossfadeBrushModulation: [0.88, 1.12],
    };
    material.userData.transitionBrush = {
        url: TERRAIN_BLEND_BRUSH_URL,
        sha256: '4fd44ca5c00b83c897423d1a849bd2e184684b1dc16b88e28e905ddeec2ab62b',
        repeatMeters: TERRAIN_BLEND_BRUSH_TRANSFORMS.map(({ repeatMeters }) => repeatMeters),
        role: 'threshold-only_not-geographic-material-map',
        fragmentSamples: 7,
        estimatedRgba8BytesWithMips: 5592405,
    };
    material.userData.derivativeSafeRepeats = true;
    material.userData.samplerCount = 3;
    material.userData.channelPacking = 'normalXY_roughness_ambientOcclusion';
    material.userData.albedoPacking = 'sRGB_RGB_linear-relative-height_A';
    material.userData.heightBlendAmplitude = far ? 0.10 : 0.22;
    material.userData.heightBlendPolicy =
        'bounded-transition-weight-bias_zero-base-remains-zero_no-displacement';
    material.userData.surfaceProjection =
        'world-biplanar_geometric-axis-selection_conditional-secondary-sample';
    material.userData.normalBasis =
        'per-projection-whiteout-world-normal_top-left-image-normalY-inverted-once';
    material.userData.sceneRepeatMeters = Object.fromEntries(
        Object.entries(SURFACE_TILE_METERS).map(([key, value]) => [key, [...value]]),
    );
    material.userData.arrayResolutions = {
        albedo: maps.runtimeResolution,
        packedNormalXyRoughAo: maps.runtimeResolution,
    };
    material.userData.textureRuntime = maps.textureRuntime;
    material.userData.antiTiling =
        'dense-authored-selector-islands_independent-layer-rotations_explicit-gradients';
    material.userData.topK = 5;
    material.userData.dynamicSamplesPerArray = 5;
    material.userData.maximumDynamicSamplesPerArray = 10;
    material.userData.preHeightSelection = true;
    material.userData.topKRetainedMass = {
        samples: 37249,
        minimum: 0.8241822649764199,
        p01: 0.9990516304493826,
        median: 1,
        mean: 0.9997995549783334,
    };
    material.userData.reliefDistanceFadeMeters = [70, 520];
    material.userData.normalStrength = far ? 0.38 : 1.0;
    material.userData.farPath = far
        ? 'topK5-dynamic-array-layers_explicit-gradient-horizon'
        : 'topK5-dynamic-array-layers_explicit-gradient-near';
    return material;
}

function makeCliffMaterial(T3, maps) {
    const material = new T3.MeshStandardNodeMaterial({ metalness: 0, roughness: 1 });
    const rawWeights = T3.abs(T3.normalWorld);
    const weightSum = rawWeights.x.add(rawWeights.y).add(rawWeights.z).max(0.0001);
    const weights = rawWeights.div(weightSum);
    const tri = (key, layer, scale, turn = 0) => {
        const yz = T3.vec2(
            T3.positionWorld.z.mul(scale).add(T3.positionWorld.y.mul(scale * turn)),
            T3.positionWorld.y.mul(scale).sub(T3.positionWorld.z.mul(scale * turn)),
        );
        const xz = T3.vec2(
            T3.positionWorld.x.mul(scale).sub(T3.positionWorld.z.mul(scale * turn)),
            T3.positionWorld.z.mul(scale).add(T3.positionWorld.x.mul(scale * turn)),
        );
        const xy = T3.vec2(
            T3.positionWorld.x.mul(scale).add(T3.positionWorld.y.mul(scale * turn)),
            T3.positionWorld.y.mul(scale).sub(T3.positionWorld.x.mul(scale * turn)),
        );
        const sample = (coordinates) => (
            T3.texture(maps.surfaceArray[key], coordinates).depth(T3.int(layer))
        );
        return sample(yz).mul(weights.x)
            .add(sample(xz).mul(weights.y))
            .add(sample(xy).mul(weights.z));
    };
    // The authored GLB stores cap / exposed-face / talus weights in COLOR_0
    // RGB and a broad, per-module geological value in alpha. Material zones
    // therefore survive every baked LOD instead of being inferred from one
    // shared procedural cross-section at runtime.
    const authoredColor = T3.attribute('color', 'vec4').max(T3.vec4(0));
    const authoredZone = authoredColor.rgb;
    const zoneSum = authoredZone.x.add(authoredZone.y).add(authoredZone.z).max(0.0001);
    const capAmount = authoredZone.x.div(zoneSum);
    const faceAmount = authoredZone.y.div(zoneSum);
    const talusAmount = authoredZone.z.div(zoneSum);
    const macro = authoredColor.a.clamp(0.82, 1.0);
    const broadGeology = T3.sin(T3.positionWorld.x.mul(0.0047)
        .sub(T3.positionWorld.z.mul(0.0033))
        .add(T3.sin(T3.positionWorld.y.mul(0.021)).mul(0.64))).mul(0.5).add(0.5);
    const authoredVariation = macro.sub(0.82).div(0.18).clamp(0, 1);
    const capVariation = authoredVariation.mul(0.64).add(broadGeology.mul(0.24)).clamp(0.08, 0.88);
    const faceVariation = authoredVariation.mul(0.52).add(broadGeology.mul(0.36)).clamp(0.10, 0.90);
    const talusVariation = authoredVariation.mul(0.38).add(broadGeology.mul(0.42)).clamp(0.08, 0.84);
    // Meter-scale projections preserve readable photographed rock detail on
    // 60-95 m faces. Independent rotations plus authored broad variation keep
    // those repeats from becoming wallpaper without smearing one sample over
    // an entire landform.
    const capA = tri('albedo', 5, 1 / 18.0, -0.11).rgb;
    const capB = tri('albedo', 7, 1 / 31.0, 0.18).rgb;
    const faceA = tri('albedo', 4, 1 / 13.0, 0.08).rgb;
    const faceB = tri('albedo', 6, 1 / 24.0, -0.14).rgb;
    const talusA = tri('albedo', 7, 1 / 8.5, 0.21).rgb;
    const talusB = tri('albedo', 5, 1 / 15.0, -0.25).rgb;
    const capColor = T3.mix(capA, capB, capVariation)
        .mul(T3.vec3(1.035, 1.005, 0.965));
    const faceTint = T3.mix(
        T3.vec3(0.96, 0.985, 1.015),
        T3.vec3(1.055, 1.005, 0.94),
        broadGeology,
    );
    const faceColor = T3.mix(faceA, faceB, faceVariation).mul(faceTint);
    const talusColor = T3.mix(talusA, talusB, talusVariation)
        .mul(T3.vec3(1.02, 0.99, 0.94));
    material.colorNode = capColor.mul(capAmount)
        .add(faceColor.mul(faceAmount))
        .add(talusColor.mul(talusAmount))
        .mul(macro);
    const capRoughness = T3.mix(
        tri('roughness', 5, 1 / 18.0, -0.11).r,
        tri('roughness', 7, 1 / 31.0, 0.18).r,
        capVariation,
    );
    const faceRoughness = T3.mix(
        tri('roughness', 4, 1 / 13.0, 0.08).r,
        tri('roughness', 6, 1 / 24.0, -0.14).r,
        faceVariation,
    );
    const talusRoughness = T3.mix(
        tri('roughness', 7, 1 / 8.5, 0.21).r,
        tri('roughness', 5, 1 / 15.0, -0.25).r,
        talusVariation,
    );
    material.roughnessNode = capRoughness.mul(capAmount)
        .add(faceRoughness.mul(faceAmount))
        .add(talusRoughness.mul(talusAmount))
        .clamp(0.57, 0.98);

    const normalFor = (layer, scale, turn) => {
        const nX = tri('normal', layer, scale, turn).rgb.mul(2).sub(1);
        // Re-project the blended tangent detail around the geometric normal.
        const tangent = T3.normalize(T3.cross(T3.vec3(0, 1, 0), T3.normalWorld)
            .add(T3.vec3(0.001, 0, 0)));
        const bitangent = T3.normalize(T3.cross(T3.normalWorld, tangent));
        return T3.normalize(tangent.mul(nX.x)
            .add(bitangent.mul(nX.y))
            .add(T3.normalWorld.mul(nX.z.max(0.12))));
    };
    const capNormal = T3.normalize(T3.mix(
        normalFor(5, 1 / 18.0, -0.11),
        normalFor(7, 1 / 31.0, 0.18),
        capVariation,
    ));
    const faceNormalA = normalFor(4, 1 / 13.0, 0.08);
    const faceNormalB = normalFor(6, 1 / 24.0, -0.14);
    const faceNormal = T3.normalize(T3.mix(faceNormalA, faceNormalB, faceVariation));
    const talusNormal = T3.normalize(T3.mix(
        normalFor(7, 1 / 8.5, 0.21),
        normalFor(5, 1 / 15.0, -0.25),
        talusVariation,
    ));
    const projectedNormal = T3.normalize(capNormal.mul(capAmount)
        .add(faceNormal.mul(faceAmount))
        .add(talusNormal.mul(talusAmount)));
    const geometricNormalWeight = capAmount.mul(0.34)
        .add(faceAmount.mul(0.28))
        .add(talusAmount.mul(0.24));
    material.normalNode = T3.normalize(T3.cameraViewMatrix.transformDirection(
        T3.mix(projectedNormal, T3.normalWorld, geometricNormalWeight),
    ));
    const capAo = T3.mix(
        tri('ao', 5, 1 / 18.0, -0.11).r,
        tri('ao', 7, 1 / 31.0, 0.18).r,
        capVariation,
    );
    const faceAo = T3.mix(
        tri('ao', 4, 1 / 13.0, 0.08).r,
        tri('ao', 6, 1 / 24.0, -0.14).r,
        faceVariation,
    );
    const talusAo = T3.mix(
        tri('ao', 7, 1 / 8.5, 0.21).r,
        tri('ao', 5, 1 / 15.0, -0.25).r,
        talusVariation,
    );
    material.aoNode = capAo.mul(capAmount)
        .add(faceAo.mul(faceAmount))
        .add(talusAo.mul(talusAmount))
        .mul(0.66).add(0.34);
    material.userData.pbrSource = 'Poly Haven cliff_side/rock_face/worn_rock_natural_01 + ambientCG Rock030 texture array';
    material.userData.arrayLayers = [4, 5, 6, 7];
    material.userData.derivativeSafeRepeats = true;
    material.userData.samplerCount = 4;
    return material;
}

function makeClosedCliffGeometry(T3, {
    length, depth, height, seed, x: originX = 0, z: originZ = 0, yaw = 0,
    alongSegments = 224, acrossSegments = 104,
    groundHeightAt = terrainHeightAt,
}) {
    // One heightfield-informed surface carries back slope, weathered cap,
    // exposed strata and talus. There is no separate roof or underside: every
    // visible triangle is a single-valued y(x,z) sample with upward projected
    // winding. The zero-relief perimeter follows and sinks into the rendered
    // terrain, so the mesh cannot float or expose a black closure wall.
    const buriedDepth = 36;
    const positions = [];
    const indices = [];
    const cliffBlend = [];
    const cliffMacro = [];
    const baseHeight = groundHeightAt(originX, originZ);
    const cosYaw = Math.cos(yaw), sinYaw = Math.sin(yaw);
    const topIndex = (along, across) => along * (acrossSegments + 1) + across;
    for (let along = 0; along <= alongSegments; along++) {
        const u = along / alongSegments * 2 - 1;
        // Ends erode down into the terrain over a noise-varied reach. Unlike
        // the rejected 64%-height boundary, the actual end row has zero relief,
        // eliminating the rounded vertical endcap.
        const endReach = 0.13 + fbm(u * 3.4 + seed, seed * 0.61, 389 + Math.round(seed), 3) * 0.075;
        const ridgeNoise = 0.90
            + (fbm(u * 4.2 + seed * 0.37, seed * 0.23, 401 + Math.round(seed), 4) - 0.5) * 0.28;
        const fractureNotch = 1 - smooth(0.60, 0.86,
            fbm(u * 14.7 - seed, seed * 0.71, 433 + Math.round(seed), 3)) * 0.22;
        const meander = (
            fbm(u * 2.7 + seed, seed * 0.17, 457 + Math.round(seed), 4) - 0.5
        ) * depth * 0.14;
        const faceOffset = (
            fbm(u * 5.7 - seed * 0.31, seed * 0.53, 467 + Math.round(seed), 4) - 0.5
        ) * 0.15 + Math.sin(u * 9.1 + seed) * 0.014;
        for (let across = 0; across <= acrossSegments; across++) {
            const v = across / acrossSegments * 2 - 1;
            const sv = v - faceOffset;
            // Cross-profile erosion changes how quickly each cap, stratum and
            // talus lobe dies into the valley. The end row is still exactly
            // zero, but it is no longer one shared rounded loaf taper.
            const endScallop = 0.76 + fbm(
                u * 10.7 + seed,
                sv * 5.3 - seed * 0.29,
                397 + Math.round(seed),
                4,
            ) * 0.48;
            const endEnvelope = smooth01((1 - Math.abs(u)) / (endReach * endScallop));
            const backRise = smooth01((sv + 1) / 0.46);
            const faceT = clamp01((sv + 0.18) / 0.36);
            const faceWarp = (fbm(u * 8.4 + seed, seed * 0.37, 487 + Math.round(seed), 3) - 0.5)
                * 0.075 * Math.sin(faceT * Math.PI);
            const warpedFaceT = clamp01(faceT + faceWarp);
            const terraceCoordinate = Math.min(5.999999, warpedFaceT * 6);
            const terraceIndex = Math.min(5, Math.floor(terraceCoordinate));
            const terracePhase = terraceCoordinate - terraceIndex;
            // Broad, sloped risers plus narrow benches: visible strata without
            // the long razor-edged shelf that read as a cave roof.
            const terraceDrop = smooth(0.18, 0.86, terracePhase);
            const terracedFaceT = (terraceIndex + terraceDrop) / 6;
            const steppedFaceT = warpedFaceT * 0.52 + terracedFaceT * 0.48;
            let faceProfile = 0.20 + 0.80 * (1 - steppedFaceT);
            const gullyField = smooth(0.57, 0.84,
                fbm(u * 9.8 + seed, seed * 0.43, 503 + Math.round(seed), 4));
            const branchGully = smooth(0.66, 0.90,
                fbm(u * 21.3 - seed, seed * 0.19, 509 + Math.round(seed), 3));
            const gullyCut = (gullyField * gullyField * 0.085 + branchGully * 0.022)
                * smooth01(faceT) * (1 - smooth(0.82, 1, faceT));
            faceProfile = Math.max(0.18, faceProfile - gullyCut
                + Math.sin(faceT * Math.PI * 12 + u * 1.7 + seed) * 0.006);

            const talusT = clamp01((sv - 0.18) / 0.76);
            const talusNoise = 0.84 + fbm(u * 7.2 + seed, talusT * 4.1, 479 + Math.round(seed), 4) * 0.27;
            const talusLobes = smooth(0.56, 0.82,
                fbm(u * 13.7 - seed, talusT * 2.6, 493 + Math.round(seed), 3));
            const talusProfile = Math.max(0,
                0.20 * Math.pow(1 - smooth01(talusT), 1.34) * talusNoise
                    + talusLobes * 0.035 * smooth(0.04, 0.24, talusT) * (1 - talusT));
            let crossSection;
            if (sv < -0.18) {
                const capToRim = smooth01((sv + 0.60) / 0.42);
                const capDrainage = smooth(0.60, 0.88,
                    fbm(u * 12.9 + seed, sv * 8.6, 547 + Math.round(seed), 4));
                const capWeathering = (
                    (fbm(u * 7.3 + seed, sv * 5.1, 541 + Math.round(seed), 4) - 0.5) * 0.052
                    - capDrainage * 0.024
                ) * backRise;
                // A slight rise toward the broken rim plus drainage relief
                // prevents the cap from reading as one giant smooth roof.
                crossSection = Math.max(0,
                    backRise * (0.925 + capToRim * 0.075) + capWeathering);
            } else if (sv <= 0.18) {
                crossSection = faceProfile;
            } else {
                crossSection = talusProfile;
            }

            const localX = u * length * 0.5
                + (fbm(u * 6.7, sv * 3.1 + seed, 521 + Math.round(seed), 3) - 0.5)
                    * depth * 0.018;
            const localZ = v * depth * 0.5 + meander * (0.76 + v * 0.12)
                + (fbm(u * 11.1 + seed, sv * 4.3, 533 + Math.round(seed), 3) - 0.5)
                    * depth * 0.012;
            const worldX = originX + localX * cosYaw + localZ * sinYaw;
            const worldZ = originZ - localX * sinYaw + localZ * cosYaw;
            const groundOffset = groundHeightAt(worldX, worldZ) - baseHeight;
            // Force both long perimeter edges to merge below the exact
            // rendered ground even when the meandering face offset pushes a
            // little cap/talus relief beyond the nominal profile boundary.
            const crossEnvelope = smooth01((1 - Math.abs(v)) / 0.085);
            const reliefScale = endEnvelope * crossEnvelope * ridgeNoise * fractureNotch;
            const relief = height * reliefScale * crossSection;
            const mergeMask = smooth(0.018, 0.085, relief / Math.max(height, 1));
            const localY = groundOffset + relief - (1 - mergeMask) * 1.35;
            positions.push(localX, localY, localZ);

            const capWeight = 1 - smooth(-0.28, -0.11, sv);
            const talusWeight = smooth(0.11, 0.31, sv);
            const faceWeight = Math.max(0, 1 - capWeight - talusWeight);
            const blendSum = Math.max(1e-5, capWeight + faceWeight + talusWeight);
            cliffBlend.push(capWeight / blendSum, faceWeight / blendSum, talusWeight / blendSum);
            cliffMacro.push(0.94 + (fbm(u * 2.9 + seed, sv * 2.1, 557 + Math.round(seed), 3) - 0.5) * 0.12);
        }
    }

    for (let along = 0; along < alongSegments; along++) {
        for (let across = 0; across < acrossSegments; across++) {
            const a = topIndex(along, across);
            const b = topIndex(along + 1, across);
            const c = topIndex(along, across + 1);
            const d = topIndex(along + 1, across + 1);
            // x then z is downward-wound; reverse both top triangles.
            indices.push(a, c, b, b, c, d);
        }
    }

    const perimeter = [];
    for (let along = 0; along <= alongSegments; along++) perimeter.push(topIndex(along, 0));
    for (let across = 1; across <= acrossSegments; across++) perimeter.push(topIndex(alongSegments, across));
    for (let along = alongSegments - 1; along >= 0; along--) perimeter.push(topIndex(along, acrossSegments));
    for (let across = acrossSegments - 1; across > 0; across--) perimeter.push(topIndex(0, across));
    const bottomStart = positions.length / 3;
    for (const top of perimeter) {
        positions.push(
            positions[top * 3],
            positions[top * 3 + 1] - buriedDepth,
            positions[top * 3 + 2],
        );
        cliffBlend.push(
            cliffBlend[top * 3],
            cliffBlend[top * 3 + 1],
            cliffBlend[top * 3 + 2],
        );
        cliffMacro.push(cliffMacro[top]);
    }
    for (let edge = 0; edge < perimeter.length; edge++) {
        const next = (edge + 1) % perimeter.length;
        const topA = perimeter[edge], topB = perimeter[next];
        const bottomA = bottomStart + edge, bottomB = bottomStart + next;
        indices.push(topA, topB, bottomA, topB, bottomB, bottomA);
    }
    const bottomCenter = positions.length / 3;
    let bottomCenterY = Infinity;
    for (let edge = 0; edge < perimeter.length; edge++) {
        bottomCenterY = Math.min(bottomCenterY, positions[(bottomStart + edge) * 3 + 1]);
    }
    positions.push(0, bottomCenterY - 2, 0);
    cliffBlend.push(0, 0, 1);
    cliffMacro.push(1);
    for (let edge = 0; edge < perimeter.length; edge++) {
        const next = (edge + 1) % perimeter.length;
        indices.push(bottomCenter, bottomStart + edge, bottomStart + next);
    }

    const geometry = new T3.BufferGeometry();
    geometry.setAttribute('position', new T3.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('cliffBlend', new T3.Float32BufferAttribute(cliffBlend, 3));
    geometry.setAttribute('cliffMacro', new T3.Float32BufferAttribute(cliffMacro, 1));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    return geometry;
}

function repairImportedCliffWinding(geometry) {
    const position = geometry.getAttribute('position');
    const normal = geometry.getAttribute('normal');
    const index = geometry.getIndex();
    if (!position || !normal || !index) {
        throw new Error('Imported desert cliff requires indexed positions and normals');
    }
    let repairs = 0;
    for (let offset = 0; offset < index.count; offset += 3) {
        const a = index.getX(offset);
        const b = index.getX(offset + 1);
        const c = index.getX(offset + 2);
        const ax = position.getX(a), ay = position.getY(a), az = position.getZ(a);
        const abx = position.getX(b) - ax;
        const aby = position.getY(b) - ay;
        const abz = position.getZ(b) - az;
        const acx = position.getX(c) - ax;
        const acy = position.getY(c) - ay;
        const acz = position.getZ(c) - az;
        const nx = aby * acz - abz * acy;
        const ny = abz * acx - abx * acz;
        const nz = abx * acy - aby * acx;
        const authoredX = normal.getX(a) + normal.getX(b) + normal.getX(c);
        const authoredY = normal.getY(a) + normal.getY(b) + normal.getY(c);
        const authoredZ = normal.getZ(a) + normal.getZ(b) + normal.getZ(c);
        if (nx * authoredX + ny * authoredY + nz * authoredZ < 0) {
            index.setX(offset + 1, c);
            index.setX(offset + 2, b);
            repairs++;
        }
    }
    index.needsUpdate = repairs > 0;
    geometry.userData.repairedWindingTriangles = repairs;
    return repairs;
}

function collectCliffBaseSupportSamples(geometry) {
    const position = geometry.getAttribute('position');
    const bounds = geometry.boundingBox;
    const bandTop = bounds.min.y
        + (bounds.max.y - bounds.min.y) * DESERT_CLIFF_BASE_SUPPORT_BAND_FRACTION;
    const samples = [];
    for (let index = 0; index < position.count; index++) {
        const y = position.getY(index);
        if (y > bandTop) continue;
        samples.push(Object.freeze({
            x: position.getX(index),
            y,
            z: position.getZ(index),
        }));
    }
    if (samples.length === 0) {
        throw new Error('Desert cliff LOD0 did not provide any base-support vertices');
    }
    return Object.freeze(samples);
}

async function loadDesertCliffTemplates(T3) {
    const Loader = globalThis.GLTFLoader;
    if (!Loader) throw new Error('Desert terrain requires the shared GLTFLoader');
    const entries = await Promise.all(Object.entries(DESERT_CLIFF_ASSETS).map(async ([key, url]) => {
        const gltf = await new Loader().loadAsync(url);
        gltf.scene.updateWorldMatrix(true, true);
        const meshes = [];
        gltf.scene.traverse((child) => {
            if (child.isMesh) meshes.push(child);
        });
        if (meshes.length !== DESERT_CLIFF_LOD_DISTANCES.length) {
            throw new Error(`Desert cliff ${url} supplied ${meshes.length} meshes instead of three LODs`);
        }
        const levels = Array(DESERT_CLIFF_LOD_DISTANCES.length);
        let runtimeSafetyWindingRepairs = 0;
        for (const source of meshes) {
            const match = /_LOD([0-2])$/.exec(source.name);
            if (!match) throw new Error(`Unexpected desert cliff LOD node ${source.name}`);
            const lod = Number(match[1]);
            if (Array.isArray(source.material)) {
                throw new Error(`Desert cliff ${url} unexpectedly uses multiple materials`);
            }
            const geometry = source.geometry.clone();
            geometry.applyMatrix4(source.matrixWorld);
            const repairedWindingTriangles = repairImportedCliffWinding(geometry);
            runtimeSafetyWindingRepairs += repairedWindingTriangles;
            geometry.computeBoundingBox();
            geometry.computeBoundingSphere();
            geometry.userData.sourceAsset = url;
            geometry.userData.lod = lod;
            geometry.userData.runtimeSafetyWindingRepairs = repairedWindingTriangles;
            levels[lod] = geometry;
        }
        if (levels.some((geometry) => !geometry)) {
            levels.filter(Boolean).forEach((geometry) => geometry.dispose());
            throw new Error(`Desert cliff ${url} is missing a required LOD`);
        }
        const source = meshes[0];
        const material = source.material.clone();
        material.name = `eanpa_${key}_imported_baked_pbr`;
        material.userData.sourceAsset = url;
        material.userData.pbrSource = 'user-supplied baked base-color + normal + metallic/roughness';
        material.needsUpdate = true;
        const textures = new Set();
        for (const value of Object.values(material)) {
            if (value?.isTexture) textures.add(value);
        }
        const importedMaterials = new Set();
        for (const mesh of meshes) {
            mesh.geometry.dispose();
            importedMaterials.add(mesh.material);
        }
        importedMaterials.forEach((importedMaterial) => importedMaterial.dispose());
        return [key, {
            levels,
            baseSupportSamples: collectCliffBaseSupportSamples(levels[0]),
            material,
            textures,
            derivativeWindingRepairs: DESERT_CLIFF_DERIVATIVE_REPAIRS[key],
            runtimeSafetyWindingRepairs,
            url,
        }];
    }));
    return new Map(entries);
}

async function loadDesertRockLibrary(T3) {
    const Loader = globalThis.GLTFLoader;
    if (!Loader) throw new Error('Desert terrain requires the shared GLTFLoader');
    const gltf = await new Loader().loadAsync(DESERT_ROCK_ASSET);
    gltf.scene.updateWorldMatrix(true, true);
    const meshes = [];
    gltf.scene.traverse((child) => {
        if (child.isMesh) meshes.push(child);
    });
    const expectedMeshes = DESERT_ROCK_PIECE_COUNT
        * DESERT_ROCK_LOD_PROJECTED_DIAMETER_PIXELS.length;
    if (meshes.length !== expectedMeshes) {
        throw new Error(
            `Desert rock library supplied ${meshes.length} meshes instead of `
            + `${expectedMeshes}`,
        );
    }
    const levels = Array.from(
        { length: DESERT_ROCK_PIECE_COUNT },
        () => Array(DESERT_ROCK_LOD_PROJECTED_DIAMETER_PIXELS.length),
    );
    let runtimeSafetyWindingRepairs = 0;
    for (const source of meshes) {
        const match = /^DesertRockPiece(\d{2})_LOD([012])$/.exec(source.name);
        if (!match) throw new Error(`Unexpected desert rock LOD node ${source.name}`);
        const piece = Number(match[1]);
        const lod = Number(match[2]);
        if (piece >= DESERT_ROCK_PIECE_COUNT || Array.isArray(source.material)) {
            throw new Error(`Invalid desert rock mesh ${source.name}`);
        }
        const geometry = source.geometry.clone();
        geometry.applyMatrix4(source.matrixWorld);
        const repairs = repairImportedCliffWinding(geometry);
        runtimeSafetyWindingRepairs += repairs;
        geometry.computeBoundingBox();
        geometry.computeBoundingSphere();
        geometry.userData.sourceAsset = DESERT_ROCK_ASSET;
        geometry.userData.piece = piece;
        geometry.userData.lod = lod;
        geometry.userData.runtimeSafetyWindingRepairs = repairs;
        levels[piece][lod] = geometry;
    }
    if (levels.some((pieceLevels) => pieceLevels.some((geometry) => !geometry))) {
        levels.flat().filter(Boolean).forEach((geometry) => geometry.dispose());
        throw new Error('Desert rock library is missing a required piece LOD');
    }
    const material = meshes[0].material.clone();
    material.name = 'eanpa_desert_rock_chunks_imported_baked_pbr';
    material.userData.sourceAsset = DESERT_ROCK_ASSET;
    material.userData.pbrSource =
        'user-supplied baked base-color + normal + metallic/roughness';
    material.needsUpdate = true;
    const textures = new Set();
    for (const value of Object.values(material)) {
        if (value?.isTexture) textures.add(value);
    }
    const footprints = levels.map((pieceLevels) => {
        const bounds = pieceLevels[0].boundingBox;
        return Math.max(bounds.max.x - bounds.min.x, bounds.max.z - bounds.min.z);
    });
    const dimensions = levels.map((pieceLevels) => {
        const bounds = pieceLevels[0].boundingBox;
        return Object.freeze({
            widthX: bounds.max.x - bounds.min.x,
            height: bounds.max.y - bounds.min.y,
            widthZ: bounds.max.z - bounds.min.z,
        });
    });
    const visibilitySpheres = levels.map((pieceLevels) => ({
        center: pieceLevels[0].boundingSphere.center.clone(),
        radius: pieceLevels[0].boundingSphere.radius,
    }));
    const importedMaterials = new Set();
    for (const mesh of meshes) {
        mesh.geometry.dispose();
        importedMaterials.add(mesh.material);
    }
    importedMaterials.forEach((importedMaterial) => importedMaterial.dispose());
    return {
        levels,
        footprints,
        dimensions,
        visibilitySpheres,
        material,
        textures,
        runtimeSafetyWindingRepairs,
        derivativeWindingRepairs: DESERT_ROCK_DERIVATIVE_WINDING_REPAIRS,
        url: DESERT_ROCK_ASSET,
    };
}

export async function makeTerrain(T3, renderer = null) {
    // The baked heightfield must be resident BEFORE any geometry, placement,
    // or ecology sampling below — terrainHeightAt reads it from load onward.
    const [maps, desertCliffTemplates, desertRockLibrary] = await Promise.all([
        loadGroundTextures(T3, renderer),
        loadDesertCliffTemplates(T3),
        loadDesertRockLibrary(T3),
        loadBakedTerrain(),
    ]);
    const geometry = new T3.PlaneGeometry(NEAR_SIZE, NEAR_SIZE, NEAR_SEGMENTS, NEAR_SEGMENTS);
    geometry.rotateX(-Math.PI / 2);
    const position = geometry.getAttribute('position');
    for (let index = 0; index < position.count; index++) {
        const x = position.getX(index), z = position.getZ(index);
        position.setY(index, terrainHeightAt(x, z));
    }
    position.needsUpdate = true;
    geometry.computeVertexNormals();
    harmonizeTerrainSeamNormals(T3, geometry, (x, z) => (
        Math.abs(Math.max(Math.abs(x), Math.abs(z)) - HALF_NEAR) < 1e-4
    ));
    addSurfaceAttributes(T3, geometry);
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();

    const nearMaterial = makeTerrainMaterial(T3, maps);
    const terrain = new T3.Mesh(geometry, nearMaterial);
    terrain.name = 'eanpa_real_alluvial_terrain';
    terrain.castShadow = false;
    terrain.receiveShadow = true;

    const horizonGeometry = makeHorizonGeometry(T3);
    const horizonMaterial = makeTerrainMaterial(T3, maps, { far: true });
    const horizon = new T3.Mesh(horizonGeometry, horizonMaterial);
    horizon.name = 'eanpa_low_cost_horizon';
    horizon.castShadow = false;
    horizon.receiveShadow = true;
    terrain.add(horizon);
    const horizonHeightAt = makeHorizonHeightSampler(horizonGeometry);

    const cliffGroup = new T3.Group();
    cliffGroup.name = 'eanpa_user_distant_desert_cliffs';
    const cliffGeometries = [];
    const cliffMaterials = new Set();
    const cliffTextures = new Set();
    const cliffBatches = new Map();
    const cliffAssetCapacities = {};
    for (const placement of DESERT_CLIFF_PLACEMENTS) {
        cliffAssetCapacities[placement.asset] = (cliffAssetCapacities[placement.asset] ?? 0) + 1;
    }
    for (const [asset, template] of desertCliffTemplates) {
        cliffMaterials.add(template.material);
        template.textures.forEach((texture) => cliffTextures.add(texture));
        for (let lod = 0; lod < DESERT_CLIFF_LOD_DISTANCES.length; lod++) {
            const cliffGeometry = template.levels[lod];
            const batch = new T3.InstancedMesh(
                cliffGeometry,
                template.material,
                cliffAssetCapacities[asset],
            );
            batch.name = `instanced_${asset}_LOD${lod}`;
            batch.count = 0;
            batch.castShadow = false;
            batch.receiveShadow = true;
            batch.frustumCulled = true;
            batch.instanceMatrix.setUsage(T3.DynamicDrawUsage);
            batch.userData.asset = asset;
            batch.userData.lod = lod;
            batch.userData.lodDistance = DESERT_CLIFF_LOD_DISTANCES[lod];
            batch.userData.triangles = cliffGeometry.index.count / 3;
            batch.userData.capacity = cliffAssetCapacities[asset];
            batch.userData.sharedGeometry = true;
            cliffBatches.set(`${asset}:LOD${lod}`, batch);
            cliffGeometries.push(cliffGeometry);
            cliffGroup.add(batch);
        }
    }
    terrain.add(cliffGroup);
    const cliffInstanceStates = DESERT_CLIFF_PLACEMENTS.map((placement, index) => {
        const template = desertCliffTemplates.get(placement.asset);
        if (!template) throw new Error(`Missing desert cliff template ${placement.asset}`);
        const cosYaw = Math.cos(placement.yaw), sinYaw = Math.sin(placement.yaw);
        let seatingHeight = Infinity;
        for (const sample of template.baseSupportSamples) {
            const scaledX = sample.x * placement.scale;
            const scaledZ = sample.z * placement.scale;
            const worldX = placement.x + scaledX * cosYaw + scaledZ * sinYaw;
            const worldZ = placement.z - scaledX * sinYaw + scaledZ * cosYaw;
            seatingHeight = Math.min(
                seatingHeight,
                horizonHeightAt(worldX, worldZ) - sample.y * placement.scale,
            );
        }
        seatingHeight -= DESERT_CLIFF_BASE_EMBED_METRES;
        const positionNode = new T3.Vector3(
            placement.x,
            seatingHeight,
            placement.z,
        );
        const rotationNode = new T3.Quaternion().setFromEuler(
            new T3.Euler(0, placement.yaw, 0),
        );
        const scaleNode = new T3.Vector3(
            placement.scale,
            placement.scale,
            placement.scale,
        );
        return {
            index,
            placement,
            seatingHeight,
            baseSupportSampleCount: template.baseSupportSamples.length,
            matrix: new T3.Matrix4().compose(positionNode, rotationNode, scaleNode),
            lod: 1,
            distance: Infinity,
        };
    });
    const selectCliffLod = (state, distance) => {
        const mid = DESERT_CLIFF_LOD_DISTANCES[1];
        const far = DESERT_CLIFF_LOD_DISTANCES[2];
        const h = DESERT_CLIFF_LOD_HYSTERESIS;
        let lod = state.lod;
        if (lod === 0 && distance > mid * (1 + h)) lod = 1;
        else if (lod === 1 && distance < mid * (1 - h)) lod = 0;
        else if (lod === 1 && distance > far * (1 + h)) lod = 2;
        else if (lod === 2 && distance < far * (1 - h)) lod = 1;
        return lod;
    };
    const updateCliffInstances = (camera) => {
        if (!camera?.position) return;
        for (const batch of cliffBatches.values()) batch.count = 0;
        for (const state of cliffInstanceStates) {
            const dx = state.placement.x - camera.position.x;
            const dz = state.placement.z - camera.position.z;
            state.distance = Math.hypot(dx, dz);
            state.lod = selectCliffLod(state, state.distance);
            const batch = cliffBatches.get(`${state.placement.asset}:LOD${state.lod}`);
            if (!batch) throw new Error('Missing instanced desert cliff LOD batch');
            batch.setMatrixAt(batch.count, state.matrix);
            batch.count++;
        }
        for (const batch of cliffBatches.values()) {
            batch.visible = batch.count > 0;
            batch.instanceMatrix.needsUpdate = batch.count > 0;
            batch.userData.activeInstances = batch.count;
            if (batch.count > 0) {
                batch.computeBoundingBox();
                batch.computeBoundingSphere();
            }
        }
    };
    updateCliffInstances(globalThis._c ?? { position: { x: 0, z: 96 } });

    const sampleScratch = {};
    const surfaceHeightAt = (x, z) => (
        Math.max(Math.abs(x), Math.abs(z)) > HALF_NEAR
            ? horizonHeightAt(x, z)
            : terrainHeightAt(x, z)
    );
    const rockPlacements = buildDesertRockPlacements(surfaceHeightAt);
    const rockCapacities = Array(DESERT_ROCK_PIECE_COUNT).fill(0);
    for (const placement of rockPlacements) rockCapacities[placement.piece]++;
    const rockGroup = new T3.Group();
    rockGroup.name = 'eanpa_instanced_desert_rock_chunks';
    const rockBatches = new Map();
    const rockGeometries = desertRockLibrary.levels.flat();
    for (let piece = 0; piece < DESERT_ROCK_PIECE_COUNT; piece++) {
        for (let lod = 0;
            lod < DESERT_ROCK_LOD_PROJECTED_DIAMETER_PIXELS.length;
            lod++
        ) {
            const rockGeometry = desertRockLibrary.levels[piece][lod];
            const batch = new T3.InstancedMesh(
                rockGeometry,
                desertRockLibrary.material,
                Math.max(1, rockCapacities[piece]),
            );
            batch.name = `instanced_desert_rock_piece${piece
                .toString().padStart(2, '0')}_LOD${lod}`;
            batch.count = 0;
            batch.castShadow = false;
            batch.receiveShadow = true;
            // Each copy is filtered against its transformed authored sphere
            // before entering this compact bucket. A second aggregate-frustum
            // test would require rebuilding bounds every frame.
            batch.frustumCulled = false;
            batch.instanceMatrix.setUsage(T3.DynamicDrawUsage);
            batch.userData.piece = piece;
            batch.userData.lod = lod;
            batch.userData.minimumProjectedDiameterPixels =
                DESERT_ROCK_LOD_PROJECTED_DIAMETER_PIXELS[lod];
            batch.userData.triangles = rockGeometry.index.count / 3;
            batch.userData.capacity = rockCapacities[piece];
            batch.userData.allocatedCapacity = Math.max(1, rockCapacities[piece]);
            batch.userData.sharedGeometry = true;
            rockBatches.set(`${piece}:LOD${lod}`, batch);
            rockGroup.add(batch);
        }
    }
    terrain.add(rockGroup);
    const rockUp = new T3.Vector3(0, 1, 0);
    const rockInstanceStates = rockPlacements.map((placement, index) => {
        const footprint = desertRockLibrary.footprints[placement.piece];
        const dimensions = desertRockLibrary.dimensions[placement.piece];
        const isCliffCluster = placement.placementKind === 'cliffFaceCluster';
        const authoredLongAxisMetres = placement.piece === 3
            ? dimensions.widthZ
            : dimensions.height;
        const uniformScale = isCliffCluster
            ? placement.desiredLongAxis / Math.max(authoredLongAxisMetres, 1e-5)
            : placement.desiredDiameter / Math.max(footprint, 1e-5);
        const placementSize = isCliffCluster
            ? placement.desiredLongAxis
            : placement.desiredDiameter;
        const step = Math.max(0.8, placementSize * 0.45);
        const dx = (surfaceHeightAt(placement.x + step, placement.z)
            - surfaceHeightAt(placement.x - step, placement.z)) / (step * 2);
        const dz = (surfaceHeightAt(placement.x, placement.z + step)
            - surfaceHeightAt(placement.x, placement.z - step)) / (step * 2);
        const normal = new T3.Vector3(-dx, 1, -dz).normalize();
        let rotation;
        let positionNode;
        let burialDepth;
        let longAxisNormalDot = null;
        if (isCliffCluster) {
            const grade = Math.max(Math.hypot(dx, dz), 1e-5);
            const upslope = new T3.Vector3(dx / grade, grade, dz / grade).normalize();
            const longAxis = upslope.multiplyScalar(0.97)
                .addScaledVector(normal, -0.24)
                .normalize();
            const sourceLongAxis = placement.piece === 3
                ? new T3.Vector3(0, 0, 1)
                : rockUp;
            const alignLongAxis = new T3.Quaternion().setFromUnitVectors(
                sourceLongAxis,
                longAxis,
            );
            const roll = new T3.Quaternion().setFromAxisAngle(longAxis, placement.yaw);
            rotation = roll.multiply(alignLongAxis);
            const transverseThickness = (placement.piece === 3
                ? Math.min(dimensions.widthX, dimensions.height)
                : Math.min(dimensions.widthX, dimensions.widthZ)) * uniformScale;
            burialDepth = transverseThickness * placement.buryFraction;
            positionNode = new T3.Vector3(
                placement.x,
                surfaceHeightAt(placement.x, placement.z),
                placement.z,
            ).addScaledVector(normal, -burialDepth);
            longAxisNormalDot = longAxis.dot(normal);
        } else {
            const tilt = new T3.Quaternion().setFromUnitVectors(rockUp, normal);
            const yaw = new T3.Quaternion().setFromAxisAngle(rockUp, placement.yaw);
            rotation = tilt.multiply(yaw);
            burialDepth = placement.desiredDiameter * DESERT_ROCK_BURY_FRACTION;
            positionNode = new T3.Vector3(
                placement.x,
                surfaceHeightAt(placement.x, placement.z) - burialDepth,
                placement.z,
            );
        }
        const y = positionNode.y;
        const matrix = new T3.Matrix4().compose(
            positionNode,
            rotation,
            new T3.Vector3(uniformScale, uniformScale, uniformScale),
        );
        const sourceSphere = desertRockLibrary.visibilitySpheres[placement.piece];
        const visibilityCenter = sourceSphere.center.clone().applyMatrix4(matrix);
        return {
            index,
            placement,
            matrix,
            y,
            visibilityCenter,
            radius: sourceSphere.radius * uniformScale,
            uniformScale,
            burialDepth,
            longAxisNormalDot,
            lod: 2,
            distance: Infinity,
            projectedDiameterPixels: 0,
            visible: true,
        };
    });
    const rockFrustum = new T3.Frustum();
    // The collision bake uses the same bottom-centred piece-local geometry.
    // Feed the exact rendered transform, including hillside tilt and burial.
    terrain.rockCollisionPlacements = rockInstanceStates.map((state) => {
        const m = state.matrix.elements, s = state.uniformScale;
        return { id: state.index, species: `rock_${String(state.placement.piece).padStart(2, '0')}`,
            x: m[12], y: m[13], z: m[14], scale: s,
            rot9: [m[0]/s,m[4]/s,m[8]/s,m[1]/s,m[5]/s,m[9]/s,m[2]/s,m[6]/s,m[10]/s],
            boundsRadius: state.radius + Math.hypot(state.visibilityCenter.x-m[12],state.visibilityCenter.z-m[14]) };
    });
    const rockProjectionView = new T3.Matrix4();
    const rockVisibilitySphere = new T3.Sphere();
    const rockViewCenter = new T3.Vector3();
    const selectRockLod = (state, projectedDiameterPixels) => {
        const nearBoundary = DESERT_ROCK_LOD_PROJECTED_DIAMETER_PIXELS[0];
        const farBoundary = DESERT_ROCK_LOD_PROJECTED_DIAMETER_PIXELS[1];
        const hysteresis = DESERT_ROCK_LOD_HYSTERESIS;
        let lod = state.lod;
        if (lod === 0 && projectedDiameterPixels < nearBoundary * (1 - hysteresis)) {
            lod = 1;
        } else if (lod === 1
            && projectedDiameterPixels > nearBoundary * (1 + hysteresis)
        ) {
            lod = 0;
        } else if (lod === 1
            && projectedDiameterPixels < farBoundary * (1 - hysteresis)
        ) {
            lod = 2;
        } else if (lod === 2
            && projectedDiameterPixels > farBoundary * (1 + hysteresis)
        ) {
            lod = 1;
        }
        return lod;
    };
    let lastRockVisibilityStats = {
        active: 0,
        frustumCulled: 0,
        subpixelCulled: 0,
        viewportHeightPixels: 0,
    };
    const rockViewportSize = new T3.Vector2();
    const getRockViewportHeight = () => {
        if (renderer?.getDrawingBufferSize) {
            renderer.getDrawingBufferSize(rockViewportSize);
            return Math.max(1, rockViewportSize.y);
        }
        return Math.max(1, globalThis.innerHeight ?? 1080);
    };
    const updateRockInstances = (camera) => {
        if (!camera?.position) return;
        for (const batch of rockBatches.values()) batch.count = 0;
        const useProjection = Boolean(
            camera.projectionMatrix && camera.matrixWorldInverse,
        );
        // LOD tracks rendered pixels. This renderer deliberately uses DPR 1;
        // display DPR previously selected unnecessarily dense rocks on HiDPI.
        const viewportHeightPixels = getRockViewportHeight();
        const projectionScaleY = useProjection
            ? Math.abs(camera.projectionMatrix.elements[5])
            : 0;
        if (useProjection) {
            camera.updateMatrixWorld?.();
            rockProjectionView.multiplyMatrices(
                camera.projectionMatrix,
                camera.matrixWorldInverse,
            );
            rockFrustum.setFromProjectionMatrix(rockProjectionView);
        }
        let active = 0;
        let frustumCulled = 0;
        let subpixelCulled = 0;
        for (const state of rockInstanceStates) {
            state.distance = state.visibilityCenter.distanceTo(camera.position);
            if (useProjection) {
                rockVisibilitySphere.center.copy(state.visibilityCenter);
                rockVisibilitySphere.radius = state.radius;
                if (!rockFrustum.intersectsSphere(rockVisibilitySphere)) {
                    frustumCulled++;
                    continue;
                }
                rockViewCenter.copy(state.visibilityCenter)
                    .applyMatrix4(camera.matrixWorldInverse);
                const viewDepth = -rockViewCenter.z;
                if (viewDepth <= 1e-4) {
                    frustumCulled++;
                    continue;
                }
                state.projectedDiameterPixels = state.radius
                    * projectionScaleY * viewportHeightPixels / viewDepth;
                if (state.visible
                    && state.projectedDiameterPixels
                        < DESERT_ROCK_CULL_DIAMETER_PIXELS
                            * (1 - DESERT_ROCK_LOD_HYSTERESIS)
                ) {
                    state.visible = false;
                } else if (!state.visible
                    && state.projectedDiameterPixels
                        > DESERT_ROCK_CULL_DIAMETER_PIXELS
                            * (1 + DESERT_ROCK_LOD_HYSTERESIS)
                ) {
                    state.visible = true;
                }
                if (!state.visible) {
                    subpixelCulled++;
                    continue;
                }
                state.lod = selectRockLod(
                    state,
                    state.projectedDiameterPixels,
                );
            }
            const batch = rockBatches.get(`${state.placement.piece}:LOD${state.lod}`);
            if (!batch) throw new Error('Missing instanced desert rock LOD batch');
            batch.setMatrixAt(batch.count, state.matrix);
            batch.count++;
            active++;
        }
        for (const batch of rockBatches.values()) {
            batch.visible = batch.count > 0;
            batch.instanceMatrix.needsUpdate = batch.count > 0;
            batch.userData.activeInstances = batch.count;
        }
        lastRockVisibilityStats = {
            active,
            frustumCulled,
            subpixelCulled,
            viewportHeightPixels,
        };
    };
    updateRockInstances(globalThis._c ?? { position: { x: 0, z: 96 } });
    const writeSample = (x, z, out) => {
        const step = 0.8;
        const h = surfaceHeightAt(x, z);
        const dx = (surfaceHeightAt(x + step, z) - surfaceHeightAt(x - step, z)) / (step * 2);
        const dz = (surfaceHeightAt(x, z + step) - surfaceHeightAt(x, z - step)) / (step * 2);
        const grade = Math.hypot(dx, dz);
        const inv = 1 / Math.sqrt(1 + grade * grade);
        out.x = x;
        out.z = z;
        out.height = h;
        out.grade = grade;
        out.slope = Math.atan(grade);
        out.inside = Math.abs(x) <= HALF_NEAR && Math.abs(z) <= HALF_NEAR;
        const normal = out.normal || (out.normal = {});
        normal.x = -dx * inv;
        normal.y = inv;
        normal.z = -dz * inv;
        return out;
    };
    const heightAt = (x, z) => surfaceHeightAt(x, z);
    const slopeAt = (x, z) => writeSample(x, z, sampleScratch).slope;
    const sampleTerrain = (x, z, out = {}) => writeSample(x, z, out);
    const ecologyAt = (x, z, out = {}) => {
        writeSample(x, z, out);
        out.compound = compoundMaskAt(x, z);
        out.route = processionalMaskAt(x, z);
        out.wash = washMaskAt(x, z);
        out.crater = craterFieldsAt(x, z).exclusion;
        out.cliff = authoredCliffMaskAt(x, z);
        out.rockiness = clamp01(smooth(0.16, 0.68, out.grade)
            + (fbm(x * 0.021, z * 0.021, 307, 4) - 0.55) * 0.62);
        return out;
    };

    const bounds = Object.freeze({
        minX: -HALF_NEAR + 28,
        maxX: HALF_NEAR - 28,
        minZ: -HALF_NEAR + 28,
        maxZ: HALF_NEAR - 28,
        size: NEAR_SIZE,
    });
    const sampler = Object.freeze({ heightAt, slopeAt, sampleTerrain, ecologyAt, bounds });
    terrain.heightAt = heightAt;
    terrain.slopeAt = slopeAt;
    terrain.sampleTerrain = sampleTerrain;
    terrain.ecologyAt = ecologyAt;
    terrain.terrainSampler = sampler;
    terrain.terrainBounds = bounds;
    terrain.userData.quality = 'balanced';
    terrain.userData.gridSpacing = NEAR_SIZE / NEAR_SEGMENTS;
    terrain.userData.horizonRadialSegments = HORIZON_RADIAL_SEGMENTS;
    terrain.userData.distantSeatingSurface = 'rendered-horizon-triangles';
    terrain.userData.pbrSource = maps.textureRuntime === 'uastc-ktx2-2k-compressed-array'
        ? 'fourteen-layer compressed true-2K arrays from retained 4K Poly Haven + ambientCG CC0 Southwest masters'
        : 'fourteen-layer 1K RGBA8 compatibility arrays from retained 2K/4K Southwest masters';
    terrain.userData.groundMaterialLayers = 14;
    terrain.userData.groundSamplerCount = 3;
    terrain.userData.groundRuntimeResolution = maps.runtimeResolution;
    terrain.userData.groundTextureRuntime = maps.textureRuntime;
    terrain.userData.groundGpuBaseLevelBytes = maps.gpuBaseLevelBytes;
    terrain.userData.groundEstimatedMipBytes = maps.gpuEstimatedMipBytes;
    terrain.userData.groundCompressionFallbackReason = maps.compressionFallbackReason;
    terrain.userData.groundTopK = 5;
    terrain.userData.groundDynamicSamplesPerArray = 5;
    terrain.userData.groundFamilyLayers = {
        ground: [0, 1, 2, 3, 10],
        wash: [4, 7, 9],
        rock: [5, 6, 8, 11, 12, 13],
    };
    terrain.userData.groundTransitionBrushEstimatedMipBytes = 5592405;
    terrain.userData.groundTransitionBrushFragmentSamples = 7;
    terrain.userData.groundPackedChannels = 'R=normalX_G=normalY_B=roughness_A=ambientOcclusion';
    terrain.userData.surfaceMaterialLayers = maps.surfaceLayers.slice();
    terrain.userData.surfacePaintPolicy =
        'organic-authored-5-ground_3-exact-wash_6-elevated-rock-and-talus_sparse-interleaving';
    terrain.userData.surfaceTransitionPolicy =
        'continuous-domain-warped-vertex-selectors_seedthree-authored-brush-dominant-per-pixel-thresholds_height-alpha';
    terrain.userData.surfaceOrganicOwnership = {
        authoredShapeShare: SURFACE_ORGANIC_POLICY.authoredShapeShare,
        relativeGapCrossfade: SURFACE_ORGANIC_POLICY.familyCrossfade,
        relativeGapCrossfadePower: SURFACE_ORGANIC_POLICY.familyCrossfadePower,
        rockRelativeGapCrossfade: SURFACE_ORGANIC_POLICY.rockFamilyCrossfade,
        continuousSecondaryFade: true,
        squareCellLattice: false,
        additionalAttributeBytesPerVertex: 0,
        talusLayer: 13,
        lowFlatTalusMass: 0,
        craterExposureSelector: [...SURFACE_ORGANIC_POLICY.craterExposureSelector],
        craterRockEligibility: SURFACE_ORGANIC_POLICY.craterRockEligibility,
    };
    terrain.userData.spomHeightSources = maps.spomHeightSources.map((source) => ({ ...source }));
    terrain.userData.gateThresholdClearance = {
        center: [GATE_THRESHOLD_X, GATE_THRESHOLD_Z],
        depth: 0.24,
        authoredGateSurfaceExposed: true,
    };
    terrain.userData.closedCliffs = DESERT_CLIFF_PLACEMENTS.length;
    terrain.userData.cliffGeometry = {
        profile: 'user-wide-low-plus-high-mesa_instanced-lods-v3',
        assets: { ...DESERT_CLIFF_ASSETS },
        runtimeManifest: './assets/terrain/desert_cliff_runtime_lods.json',
        placements: DESERT_CLIFF_PLACEMENTS.map((item) => ({
            name: item.name,
            asset: item.asset,
            position: [item.x, item.z],
            yaw: item.yaw,
            uniformScale: item.scale,
        })),
        trianglesByAssetAndLod: Object.fromEntries([...desertCliffTemplates].map(([key, template]) => (
            [key, template.levels.map((level) => level.index.count / 3)]
        ))),
        derivativeWindingRepairs: Object.fromEntries([...desertCliffTemplates].map(([key, template]) => (
            [key, template.derivativeWindingRepairs]
        ))),
        runtimeSafetyWindingRepairs: Object.fromEntries([...desertCliffTemplates].map(([key, template]) => (
            [key, template.runtimeSafetyWindingRepairs]
        ))),
        sharedImportedBakedPbr: true,
        instanced: true,
        instancedBatches: cliffBatches.size,
        maximumCliffDrawCalls: cliffBatches.size,
        totalInstances: cliffInstanceStates.length,
        geometryClonePerPlacement: false,
        lodDistances: DESERT_CLIFF_LOD_DISTANCES.slice(),
        lodHysteresis: DESERT_CLIFF_LOD_HYSTERESIS,
        realGeometryLods: true,
        activeInstancesByBatch: Object.fromEntries([...cliffBatches].map(([key, batch]) => (
            [key, batch.count]
        ))),
        originalAssetsUntouched: true,
        runtimeTextureSize: 2048,
        runtimeEncodedBytes: 31458120,
        decodedTextureMemoryMiB: 96,
        uniformScaleOnly: true,
        layeredCopies: true,
        terrainConformedBuriedSkirts: false,
        terrainFoundationAprons: true,
        wholeFootprintSupportSeating: true,
        baseSupportBandFraction: DESERT_CLIFF_BASE_SUPPORT_BAND_FRACTION,
        baseSupportSamplesByAsset: Object.fromEntries(
            [...desertCliffTemplates].map(([key, template]) => [
                key,
                template.baseSupportSamples.length,
            ]),
        ),
        seatingHeightsByPlacement: Object.fromEntries(
            cliffInstanceStates.map((state) => [state.placement.name, state.seatingHeight]),
        ),
        rigidUpperSilhouettes: true,
        templeAxisSkyAperture: true,
        outsidePlayerBounds: true,
        physics: false,
        baseEmbedMetres: DESERT_CLIFF_BASE_EMBED_METRES,
    };
    const cliffClusterPlacements = rockPlacements.filter(
        (item) => item.placementKind === 'cliffFaceCluster',
    );
    const cliffClusterSummaries = DESERT_CLIFF_PLACEMENTS.map((cliff, clusterId) => {
        const members = cliffClusterPlacements.filter(
            (item) => item.clusterId === clusterId,
        );
        return {
            clusterId,
            cliffPlacement: cliff.name,
            instances: members.length,
            targetInstances: DESERT_ROCK_CLIFF_CLUSTER_MEMBERS,
            complete: members.length === DESERT_ROCK_CLIFF_CLUSTER_MEMBERS,
        };
    });
    const activeCliffClusterCount = cliffClusterSummaries.filter(
        (item) => item.instances > 0,
    ).length;
    terrain.userData.desertRockChunks = {
        profile: 'user-12-piece-instanced-terrain-dressing-v4',
        master: './assets/terrain/Desert_rock_chunks_12_pieces.glb',
        masterSha256: '233a8c11fb0e281b38a6e7df1ff0fe20f3ff00f3fe31b858971041637e89714f',
        runtime: DESERT_ROCK_ASSET,
        runtimeManifest: './assets/terrain/desert_rock_chunks_runtime_lods.json',
        pieces: DESERT_ROCK_PIECE_COUNT,
        trianglesByPieceAndLod: desertRockLibrary.levels.map((levels) => (
            levels.map((level) => level.index.count / 3)
        )),
        trianglesByLod: DESERT_ROCK_LOD_PROJECTED_DIAMETER_PIXELS.map((_, lod) => (
            desertRockLibrary.levels.reduce(
                (sum, levels) => sum + levels[lod].index.count / 3,
                0,
            )
        )),
        sharedImportedBakedPbr: true,
        sharedMaterialCount: 1,
        instanced: true,
        instancedBatches: rockBatches.size,
        maximumRockDrawCalls: DESERT_ROCK_MAXIMUM_DRAWS,
        targetInstances: DESERT_ROCK_INSTANCE_TARGET,
        totalInstances: rockInstanceStates.length,
        nearFieldInstances: rockPlacements.filter((item) => item.nearField).length,
        horizonInstances: rockPlacements.filter((item) => !item.nearField).length,
        geometryClonePerPlacement: false,
        realGeometryLods: DESERT_ROCK_LOD_PROJECTED_DIAMETER_PIXELS.length,
        lodProjectedDiameterPixels:
            DESERT_ROCK_LOD_PROJECTED_DIAMETER_PIXELS.slice(),
        lodHysteresis: DESERT_ROCK_LOD_HYSTERESIS,
        subpixelCullDiameterPixels: DESERT_ROCK_CULL_DIAMETER_PIXELS,
        fixedDistanceCulling: false,
        visibilityBounds: 'scaled-lod0-authored-geometry-spheres',
        perInstanceFrustumFiltering: true,
        visibility: { ...lastRockVisibilityStats },
        activeInstancesByBatch: Object.fromEntries([...rockBatches].map(([key, batch]) => (
            [key, batch.count]
        ))),
        activeInstanceCount: [...rockBatches.values()].reduce(
            (sum, batch) => sum + batch.count,
            0,
        ),
        minimumDiameter: Math.min(...rockPlacements
            .filter((item) => item.placementKind === 'ground')
            .map((item) => item.desiredDiameter)),
        maximumDiameter: Math.max(...rockPlacements
            .filter((item) => item.placementKind === 'ground')
            .map((item) => item.desiredDiameter)),
        cliffClusterLongAxisRangesMetres: {
            cliffFaceTallNarrow:
                DESERT_ROCK_DIAMETER_RANGES.cliffFaceTallNarrow.slice(),
        },
        groundInstances: rockPlacements
            .filter((item) => item.placementKind === 'ground').length,
        cliffClusterInstanceTarget: DESERT_ROCK_CLIFF_CLUSTER_TARGET,
        cliffClusterInstances: cliffClusterPlacements.length,
        cliffClusterTargetCount: DESERT_ROCK_CLIFF_CLUSTER_COUNT,
        cliffClusterCount: activeCliffClusterCount,
        cliffClusterMemberTarget: DESERT_ROCK_CLIFF_CLUSTER_MEMBERS,
        cliffClusters: cliffClusterSummaries,
        incompleteCliffClusters: cliffClusterSummaries
            .filter((item) => !item.complete)
            .map((item) => item.cliffPlacement),
        gracefulPartialClusters: true,
        cliffClusterRadiusMetres: DESERT_ROCK_CLIFF_CLUSTER_RADIUS_METRES.slice(),
        pieceClasses: Object.fromEntries(Object.entries(
            DESERT_ROCK_PIECE_GROUPS,
        ).map(([key, pieces]) => [key, pieces.slice()])),
        visualIndexContactSheet:
            './artifacts/desert-rock-review/desert-rock-runtime-lod0-numbered-contact-sheet.png',
        visualIndexMapping: DESERT_ROCK_VISUAL_INDEX.map((item) => ({ ...item })),
        groundDiameterRangesMetres: Object.fromEntries(Object.entries(
            DESERT_ROCK_DIAMETER_RANGES,
        ).filter(([key]) => key !== 'cliffFaceTallNarrow')
            .map(([key, range]) => [key, range.slice()])),
        classInstanceCounts: Object.fromEntries(Object.keys(
            DESERT_ROCK_PIECE_GROUPS,
        ).map((key) => [
            key,
            rockPlacements.filter((item) => item.pieceClass === key).length,
        ])),
        pieceInstanceCounts: rockCapacities.slice(),
        cliffClusterMinimumGrade: DESERT_ROCK_CLIFF_CLUSTER_MIN_GRADE,
        cliffShoulderMaskRange: DESERT_ROCK_CLIFF_SHOULDER_MASK_RANGE.slice(),
        cliffClusterBurialFractionRange:
            DESERT_ROCK_CLIFF_CLUSTER_BURY_FRACTION_RANGE.slice(),
        deterministicPlacement: true,
        placementVersion: 'desert-rock-authored-v5-graceful-visual-index-clusters',
        proceduralRockInstancesRetired: 20220,
        uniformScaleOnly: true,
        bottomCenteredReusableSubmeshes: true,
        terrainAwareSeating: true,
        terrainNormalAlignment: 'ground roles plus cliff-cluster slope frame',
        cliffClusterLongAxisAlignment: 'upslope tangent with inward lean',
        cliffClusterBurialBasis: 'authored transverse thickness',
        cliffClusterOverlap: 'paired multi-member shoulder dressing',
        exclusions: {
            templeCompound: true,
            processionalRoute: true,
            dryWashes: true,
            nuclearCrater: true,
            distantCliffInteriors: true,
            authoredCliffShoulderDetail: true,
            steepSlopes: 'pieces03-and11-cluster-only',
        },
        derivativeWindingRepairs: desertRockLibrary.derivativeWindingRepairs,
        runtimeSafetyWindingRepairs: desertRockLibrary.runtimeSafetyWindingRepairs,
        originalAssetUntouched: true,
        runtimeTextureSize: 2048,
        runtimeEncodedBytes: 18707644,
        decodedTextureMemoryMiB: 48,
        physics: 'proximity-streamed-convex-hulls-with-walkable-tops',
    };
    terrain.userData.nuclearCrater = {
        center: [CRATER_X, CRATER_Z],
        radius: CRATER_RADIUS,
        heightmap: './assets/terrain/nuclear_crater_heightmap.png',
        oppositeStart: true,
    };

    terrain.setQuality = (quality = 'balanced') => {
        // Retained for API compatibility only. The public quality selector is
        // sky/weather/skybox-only, so every authored terrain layer and all
        // eight cliff copies remain present regardless of that selection.
        terrain.userData.quality = 'authored';
        terrain.userData.requestedSkyQuality = quality;
        horizon.userData.quality = 'authored';
        cliffBatches.forEach((batch) => { batch.visible = batch.count > 0; });
        rockBatches.forEach((batch) => { batch.visible = batch.count > 0; });
    };
    const lastLodView = new Float64Array(10).fill(NaN);
    const currentLodView = new Float64Array(10);
    terrain.updateLods = (camera) => {
        if (!camera) return;
        const p = camera.position, q = camera.quaternion;
        currentLodView[0]=p.x;currentLodView[1]=p.y;currentLodView[2]=p.z;
        currentLodView[3]=q?.x??0;currentLodView[4]=q?.y??0;currentLodView[5]=q?.z??0;currentLodView[6]=q?.w??1;
        currentLodView[7]=camera.projectionMatrix?.elements[0]??0;
        currentLodView[8]=camera.projectionMatrix?.elements[5]??0;
        currentLodView[9]=getRockViewportHeight();
        let viewChanged = false;
        for (let i = 0; i < currentLodView.length; i++) {
            if (currentLodView[i] !== lastLodView[i]) { viewChanged = true; break; }
        }
        if (!viewChanged) return;
        lastLodView.set(currentLodView);
        // These rocks/cliffs are static. A stationary view needs no recull,
        // matrix repacking, GPU instance upload, or telemetry allocation.
        updateCliffInstances(camera);
        updateRockInstances(camera);
        terrain.userData.cliffGeometry.activeInstancesByBatch = Object.fromEntries(
            [...cliffBatches].map(([key, batch]) => [key, batch.count]),
        );
        terrain.userData.desertRockChunks.activeInstancesByBatch = Object.fromEntries(
            [...rockBatches].map(([key, batch]) => [key, batch.count]),
        );
        terrain.userData.desertRockChunks.activeInstanceCount =
            [...rockBatches.values()].reduce((sum, batch) => sum + batch.count, 0);
        terrain.userData.desertRockChunks.visibility = {
            ...lastRockVisibilityStats,
        };
    };

    let disposed = false;
    terrain.dispose = () => {
        if (disposed) return;
        disposed = true;
        terrain.removeFromParent();
        terrain.clear();
        geometry.dispose();
        horizonGeometry.dispose();
        nearMaterial.dispose();
        horizonMaterial.dispose();
        for (const cliffGeometry of cliffGeometries) cliffGeometry.dispose();
        cliffMaterials.forEach((material) => material.dispose());
        cliffTextures.forEach((texture) => texture.dispose());
        for (const rockGeometry of rockGeometries) rockGeometry.dispose();
        desertRockLibrary.material.dispose();
        desertRockLibrary.textures.forEach((texture) => texture.dispose());
        for (const texture of Object.values(maps.surfaceArray)) texture.dispose();
        maps.blendBrush?.dispose?.();
    };

    return terrain;
}
