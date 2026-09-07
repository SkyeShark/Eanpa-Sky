# Local changes to the pinned Three renderer

The standalone keeps its pinned r184 renderer. These narrowly scoped changes
are recorded relative to local starting checkpoint `e2e6496`:

- `TextureNode.clone()` copies the explicit `updateMatrix` policy. Chained
  screen-buffer and PMREM sampling must not reintroduce per-object UV matrices.
  `tests/texture-node-policy.test.mjs` covers chained sample/LOD clones.
- `ShadowNode` initializes its shadow target before materials bind the depth
  view. Otherwise a zero-intensity light's first later shadow render can replace
  the attachment and leave compiled bind groups referring to a destroyed view.
  The day/night/flashlight GPU lifecycle capture covers the original trigger.

The vendored `addons/tsl/display/SSRNode.js` also contains the earlier continuous
depth-crossing repair for the optional legacy reflection path. The standalone
now defaults to `src/native_reflection_pipeline.js` and
`src/screen_space_trace.js`, which resolve radiance inside native PBR lighting.

Renderer resource retirement, shadow-material variants, and environment-target
ownership are implemented in standalone adapters with tests. They depend on the
pinned renderer's internal interfaces and must be reviewed during a Three upgrade.

Upstream Three source and license remain authoritative; these notes do not
describe an upstream release or imply that the changes have been submitted there.
