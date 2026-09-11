# Local changes to the pinned Three renderer

The standalone keeps its pinned r184 renderer. These narrowly scoped changes
are recorded relative to local starting checkpoint `e2e6496`:

- `TextureNode.clone()` copies the explicit `updateMatrix` policy. Chained
  screen-buffer and PMREM sampling must not reintroduce per-object UV matrices.
  `tests/texture-node-policy.test.mjs` covers chained sample/LOD clones.
- PCF, PCFSoft and point-shadow filters reuse map-size/radius reference nodes
  per `LightShadow`. Previously each material's filter expansion created fresh
  references, preventing sharing of the entire native render uniform buffer.
  The referenced properties remain live, including replacement of `mapSize`;
  no filter samples, coordinates or lighting equations change.
- `ShadowNode` initializes its shadow target before materials bind the depth
  view. Otherwise a zero-intensity light's first later shadow render can replace
  the attachment and leave compiled bind groups referring to a destroyed view.
  The day/night/flashlight GPU lifecycle capture covers the original trigger.
- `Renderer.compileAsync()` builds node graphs sequentially while preparing up
  to four GPU pipelines together. It drains pending work before returning or
  throwing, and visits visible objects independently of the last draw's frustum.
  Precompile flags never remain set across an await. Geometry initialization
  follows asynchronous node building, avoiding an implicit synchronous rebuild.
  Offscreen depth/stencil settings come from the actual render target, matching
  the pipeline used by the subsequent draw.
  Cached draws yield on an 8 ms CPU budget instead of scheduling a separate
  task for each reused material. The local cube probe can consequently compile
  all visible materials once and then render its six faces.
- `PassNode.compileAsync()` uses the same merged context, attachment format,
  visibility layers and override material as rendering. State is restored even
  when compilation fails. This avoids rebuilding native PBR for a different
  context on the first frame.
- WebGPU pipeline validation scopes close before awaiting driver compilation,
  so overlapping jobs cannot pop each other's scopes. Rejected compilations
  retain an error state instead of silently appearing successful.
  `tests/async-compilation.test.mjs` covers these scheduling and ownership rules.

The vendored `addons/tsl/display/SSRNode.js` also contains the earlier continuous
depth-crossing repair for the optional legacy reflection path. The standalone
now defaults to `src/native_reflection_pipeline.js` and
`src/screen_space_trace.js`, which resolve radiance inside native PBR lighting.

Renderer resource retirement, shadow-material variants, and environment-target
ownership are implemented in standalone adapters with tests. They depend on the
pinned renderer's internal interfaces and must be reviewed during a Three upgrade.

Upstream Three source and license remain authoritative; these notes do not
describe an upstream release or imply that the changes have been submitted there.
