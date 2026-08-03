// Metric material metadata for the eanpa_southwest_ground_v3 layer set.
//
// Ekigar's height-blend fold (src/materials/layer_kernel.js layerBlend)
// contests materials in METRES: one layer's relief height against another's
// blend depth. Eanpa's arrays carry only a unitless 0..1 relative height in
// albedo.a — these tables supply the missing physical scale.
//
// Values follow Ekigar's authoring heuristic (sources.js: heightMetres ~
// physicalScale * 0.006, blendDepth ~ physicalScale * 0.002) floored upward
// for the rock scans, whose relief is genuinely deeper than the heuristic.
// Indices match the layer declaration order in terrain_real.js (:1322-1393)
// and SURFACE_TILE_METERS. Tuning these is look-dev, not physics: raising a
// layer's heightMetres makes it "win" contact boundaries more aggressively;
// raising blendDepth widens/softens the interpenetration zone.

// metres of relief encoded across albedo.a's 0..1 range, per layer
export const SURFACE_HEIGHT_METERS = Object.freeze([
    0.05,   //  0 RockyTrail02        ground
    0.10,   //  1 DryGroundRocks      ground
    0.05,   //  2 RedLateriteSoilStones ground
    0.04,   //  3 CrackedRedGround    ground
    0.03,   //  4 MudCrackedDryRiverbed002 wash
    0.25,   //  5 Rock029             rock
    0.25,   //  6 Rock061             rock
    0.05,   //  7 GravellySand        wash
    0.35,   //  8 RockFace03          rock face
    0.05,   //  9 SandyGravel02       wash
    0.06,   // 10 RockyTrail          ground
    0.35,   // 11 RockFace            rock face
    0.30,   // 12 RockBoulderCracked  rock
    0.20,   // 13 RocksGround02       talus
]);

// metres over which this layer interpenetrates its neighbour at a boundary
export const SURFACE_BLEND_DEPTH_METERS = Object.freeze([
    0.020, 0.040, 0.020, 0.020, 0.015, 0.090, 0.090,
    0.020, 0.120, 0.020, 0.025, 0.120, 0.100, 0.070,
]);
