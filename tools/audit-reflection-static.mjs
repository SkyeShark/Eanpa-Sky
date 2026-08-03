import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const read = async (path) => readFile(new URL('../' + path, import.meta.url), 'utf8');
const [pipeline, main, sky, spatial, fxaaSource, ssrSource] = await Promise.all([
    read('src/reflection_pipeline.js'),
    read('src/main.js'),
    read('engine/sky_system.js'),
    read('src/cloudspatial.js'),
    read('vendor/three/addons/tsl/display/FXAANode.js'),
    read('vendor/three/addons/tsl/display/SSRNode.js'),
]);

let checks = 0;
const ok = (value, message) => {
    assert.ok(value, message);
    checks++;
};

ok(/ssr as makeSsrNode/.test(pipeline), 'uses the vendored Three r184 SSR node');
ok(/material\.envMap = texture[\s\S]*scene\.environmentNode = null[\s\S]*scene\.environment = null/.test(pipeline),
    'baked sky binds per PBR material, never scene environment');
ok(/includeClouds: true/.test(main), 'native PMREM bake contains cloud radiance');
ok(/cloudPbr: 'three-native-pmrem-material-brdf'/.test(main),
    'runtime reports native material BRDF ownership');
for (const seconds of [10, 16, 24]) {
    ok(main.includes('cloudReflectionRefreshSeconds: ' + seconds),
        'quality profile retains ' + seconds + ' second cloud PMREM cadence');
}
ok(/movingCloudReflectionDue[\s\S]*cloudReflectionRefreshSeconds \* 1000[\s\S]*reflectionDirty = true/.test(main),
    'moving clouds periodically invalidate the reusable PMREM source');
ok(/target\.texture\.needsPMREMUpdate = true/.test(sky),
    'a reused cloud environment explicitly invalidates Three PMREM');
ok(/cloudBody\([\s\S]*dir, vec3\(0, 2, 0\), bopts\.cloudPasses, null, float\(0\)/.test(sky),
    'environment bake evaluates the authored cloud field in angular space');
ok(/transientLightningInBake: false/.test(sky),
    'periodic PMREM cannot retain a transient storm flash between refreshes');

ok(!/cloud_reflection_filter|makeCloudReflectionFilter/.test(pipeline),
    'production pipeline does not screen-blur neighbouring cloud receiver pixels');
ok(!/enableReflections\(camera|liveHook\(|sharpCloudReflection|horizonMaskedSky/.test(pipeline),
    'production pipeline has no additive full-screen cloud reflection layer');
ok(/Cloud radiance is already part of the periodically refreshed PMREM/.test(pipeline),
    'source documents native PBR ownership and the retired oil-band failure mode');
ok(/reflectionCompose: 'native-cloud-pmrem-ibl_then-three-ssr'/.test(pipeline),
    'runtime reports native cloud IBL followed by local SSR');
ok(/skyRoughnessMode: 'three-pmrem-angular-prefilter'/.test(pipeline),
    'runtime reports angular rather than receiver-pixel roughness filtering');
ok(/cloudReflectionMaterialSource: 'native-material-brdf-final-maps'/.test(pipeline),
    'cloud IBL uses each material resolved PBR inputs');
ok(/cloudReflectionWeighting: 'three-pmrem-environment-brdf'/.test(pipeline),
    'cloud reflection weighting is owned by Three environment BRDF');
ok(/cloudReflectionAo: 'native-material-ibl-occlusion'/.test(pipeline),
    'cloud specular occlusion remains native to the material');
ok(/cloudReflectionResolutionScale: null/.test(pipeline),
    'no screen-resolution cloud target remains');
ok(/cloudReflectionUpdate: 'periodic-equirectangular-pmrem'/.test(pipeline),
    'runtime exposes periodic cloud PMREM updates');

ok(/mode: 'native-equirectangular-pmrem'/.test(sky), 'sky diagnostics identify native PMREM');
ok(/materialSource: 'three-native-resolved-material-brdf'/.test(sky),
    'sky diagnostics identify resolved native material inputs');
ok(/roughnessResponse: 'three-pmrem-angular-prefilter'/.test(sky),
    'sky diagnostics identify angular roughness prefiltering');
ok(/screenSpaceCloudLayer: false/.test(sky), 'sky diagnostics reject the retired post layer');

ok(/THREE\.pass\(scene, camera, \{ samples: 0 \}\)/.test(pipeline),
    'scene MRT is explicitly single-sample');
for (const channel of ['output', 'normal', 'metalrough', 'emissive']) {
    ok(new RegExp(channel + ':').test(pipeline), 'scene MRT keeps ' + channel);
}
ok(/metalrough: THREE\.vec4\(THREE\.metalness, THREE\.roughness/.test(pipeline),
    'SSR sees every material final metalness and roughness values');
ok(/makeSsrNode\([\s\S]*metalrough\.r, metalrough\.g, camera/.test(pipeline),
    'native SSR receives those final maps in the correct channels');
ok(/const lod = r\.mul\( r \)\.mul\( mips \)[\s\S]*\.level\( lod \)/.test(ssrSource),
    'native SSR keeps its authored roughness-squared local-reflection lobe');
ok(/const op = this\.opacity\.mul\( metalness \)/.test(ssrSource),
    'native SSR keeps its authored metalness response');
ok(/const reflectedColor = aoSceneColor[\s\S]*\.add\(ssrRgb\.mul\(uSsrAudit\)\)/.test(pipeline),
    'local SSR overlays the already PBR-shaded cloud IBL beauty');
ok(!/ssrHitAlpha|oneMinus\(ssr/.test(pipeline),
    'binary SSR hit alpha never erases native environment IBL');

ok(/m\.userData\?\.preserveSceneMrtOverride !== true/.test(main),
    'compatibility stripping preserves intentional per-material N8AO weights');
ok(!/scenePassNode\s*:/.test(pipeline), 'N8AO does not submit a duplicate scene pass');
ok(/halfRes = false/.test(pipeline), 'N8AO uses the validated full-resolution path');
ok(/gammaCorrection = false/.test(pipeline), 'N8AO remains in the linear graph');
ok(/transparencyAware = false[\s\S]*autoDetectTransparency = false/.test(pipeline),
    'N8AO avoids a duplicate transparency render');
ok(/environmentSuppressedMaterials: 0[\s\S]*nativeEnvironmentPbr: true/.test(pipeline),
    'opaque PBR environments are never suppressed');
ok(!/suppressedEnvironmentRoots|zeroOpaqueEnvironment/.test(pipeline),
    'no global opaque environment suppression remains');

ok(/bloom\([\s\S]*sceneEmissive/.test(pipeline), 'bloom is selective from emissive MRT');
ok(/renderOutput\(colorOut\)[\s\S]*fxaaFactory\(fxaaInput\)[\s\S]*outputColorTransform = false/.test(pipeline),
    'FXAA follows display conversion with no double transform');
ok(/isSampleNode \|\| node\?\.isTextureNode \|\| node\?\.isPassNode/.test(pipeline),
    'pass textures are excluded from RTT ownership');
ok(/_quadMesh\?\.material\?\.dispose[\s\S]*renderTarget\?\.dispose/.test(pipeline),
    'pipeline-owned RTT material and target are released');
for (const token of [
    'bloomContribution.dispose?.()',
    'ssrNode.dispose?.()',
    'n8ao?.dispose?.()',
    'scenePass.dispose?.()',
]) {
    ok(pipeline.includes(token), 'dispose retains ' + token);
}

ok(/antialias: false/.test(main), 'renderer avoids redundant canvas MSAA');
ok(/makeReflectionPipeline\([\s\S]*active\.sky, 'balanced'/.test(main),
    'sky selector cannot reduce local post quality');
ok(/fxaa as requiredFxaaFactory/.test(main), 'FXAA remains a required static dependency');
ok(/const lon = suv\.x\.sub\(0\.5\)\.mul\(Math\.PI \* 2\)[\s\S]*const lat = float\(0\.5\)\.sub\(suv\.y\)\.mul\(Math\.PI\)[\s\S]*vec3\(cl\.mul\(cos\(lon\)\), sin\(lat\), cl\.mul\(sin\(lon\)\)\)/.test(sky),
    'environment bake reconstructs Three equirectangular directions');
ok(/mode: 'spatial-current-frame-sky'/.test(spatial), 'visible optimized clouds remain current-frame spatial');
ok(/frameJit\.value = 0/.test(spatial), 'visible clouds have no temporal screen jitter');
ok(/backgroundTarget[\s\S]*cloudTarget/.test(spatial), 'visible background and clouds remain ordered targets');

const fxaaHash = createHash('sha256').update(fxaaSource).digest('hex').toUpperCase();
assert.equal(
    fxaaHash,
    'BB74FA25ED39FAF410847808C227C06D8CEA300268A377BFF7A4EA1BAFF0127F',
    'vendored FXAA differs from Eidoverse donor',
);
checks++;

console.log('[reflection-static-audit] ' + checks + ' assertions passed; no GPU/browser');
