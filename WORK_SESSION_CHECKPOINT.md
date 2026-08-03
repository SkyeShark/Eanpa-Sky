# EANPA work checkpoint — 2026-07-16

Status: paused at the user's request. Resume from this file; do not redo completed work.

## Recovered prior session

- Exact prior session log: `C:\Users\sdn52\.codex\sessions\2026\07\16\rollout-2026-07-16T11-27-26-019f6c2e-fb7c-7411-bc6b-65c6059e685f.jsonl`
- Recovered backlog, in order:
  1. Finish restoring clouds while preserving the successful cloud shadows.
  2. Fix reflections.
  3. Fix distant mesh-impostor lighting instability and, separately, nearly black nearby Joshua/yucca canopies at noon.
  4. Make cliffs less stylized.
  5. Give the stone ziggurat stone footsteps.
- Added this session: flashlight toggling froze the engine; once real-time toggling worked, add soft on/off clicks generated with Stable Audio 3 in ComfyUI.

## Completed implementation

### Clouds

- `engine/sky_system.js`
  - Restored an organic, fully wind-advected FBM high-cloud field.
  - Restored Ringworld's curved high-cloud intersection inside the shared cloud dome.
  - Removed the standalone coarse `ringWisp` sheet and its resources.
  - Added transition/capture/apply support for `wispFloor`.
  - Kept cloud-shadow code intact.
- `engine/weather_system.js`
  - Dark Storm now drives `wispOn: 1.0` and `wispFloor: 0.78`, producing a continuous overhead canopy.
- `engine/ringworld.js`
  - Restored weather-responsive far-cloud coverage and base-preset coverage when Weather is None.
- `src/ringsky.js`
  - Corrected layer order to background `-100`, ring `-99`, far clouds `-98.5`, local clouds `-98`.
- `src/main.js`
  - Balanced cloud quality is currently `44` sky samples, `14` light samples, `3` cloud passes, divisor `2`.
- Cloud audit assertions were updated in:
  - `tools/audit-weather-static.mjs`
  - `tools/audit-sky-stability-static.mjs`
  - `tools/audit-sky-resource-lifecycle.mjs`

Live results already accepted:

- Earth Cumulus, Cirrus, and Dark Storm render and transition correctly.
- Dark Storm has no clear-sky holes overhead.
- Ringworld Cumulus, Cirrus/None, and Dark Storm retain curved/world-space high clouds with correct ordering.
- **RETRACTED 2026-07-17:** the former 60–65 FPS Balanced claim and all other
  runtime performance measurements from the affected period are invalid because
  repeated hidden audit launches left competing Chrome processes alive.

### Flashlight freeze and audio

- `src/main.js`
  - Flashlight remains `visible = true`; toggling changes intensity between `0` and `330` instead of changing the WebGPU light topology.
  - Shadow auto-update follows enabled state and refreshes once on enable.
  - Setter is idempotent and calls the audio toggle hook.
- Controlled 10-toggle runtime test:
  - Setter cost: about `0.1–0.2 ms`.
  - Next completed frame: median `15.8 ms`, maximum `31.4 ms`.
  - No errors and no pipeline/topology freeze.
- `src/audio_system.js`
  - Added priority decoding, queuing, rapid-toggle voice replacement, and soft non-spatial playback at gain `0.12`.
- Generated with the local Stable Audio 3 ComfyUI workflow and installed:
  - `assets/audio/flashlight_click_on.ogg` — 48 kHz mono, 0.078 s.
  - `assets/audio/flashlight_click_off.ogg` — 48 kHz mono, 0.174 s.
  - Post-bus peak is about `-25.26 dBFS`.
- Provenance, prompts, seeds, workflow, trims, and licensing caveat are in `assets/audio/README.md`.
- Comfy prompt IDs:
  - ON: `2d03cc87-ceda-4cb1-ba0b-f8882764485d`, seed `7162612`.
  - OFF: `60f06503-366e-44a8-b1c7-c95c271f5357`, seed `7162613`.
- Audio audit updated in `tools/audit-audio-static.py`.

## Verification already passing

- Weather/audio static audit: 431 assertions.
- Sky stability audit: 22 assertions.
- Sky lifecycle audit: 69 assertions.
- Full audio audit: 220 assertions.
- Syntax checks passed for all edited cloud, flashlight, and audio JavaScript files.
- `tools/audit-input-static.mjs` has an existing CRLF-sensitive baseline failure unrelated to this work.

## Exact pause point / unresolved finding

The current cloud blocker is a Shieldworld partial-frame/gray-lower-screen regression. It reproduces on a clean direct Shieldworld Dark Storm load, so it is not accumulated skybox-wrapper state.

Evidence:

- Captured frame: `cloud-repair-shieldworld-darkstorm-clean.jpg`.
- The upper part renders the storm/cloud scene; a sharp horizontal boundary leaves the lower canvas solid gray.
- Canvas and CSS sizes both report `1418 x 802`, DPR 1.
- Spatial targets report `709 x 401` at divisor 2.
- Hiding terrain/cloud proxies in earlier diagnostics did not eliminate the gray region.
- Disabling N8AO did not eliminate it (`C:\tmp\shield-noao.jpg`).
- Strong current hypothesis: offscreen cloud/reflection rendering leaves a WebGPU viewport/scissor or post-process target size active, so only part of the final canvas is written. Inspect `src/cloudspatial.js` target restoration and `src/reflection_pipeline.js` render/resize behavior next.
- The isolated page's AO was temporarily disabled only for the diagnostic; a reload restores it.

## Next actions

1. Reproduce Shieldworld clean and compare final output with the spatial pass bypassed, then with the reflection pipeline bypassed, to identify which offscreen pass leaves partial output state.
2. Fix viewport/target restoration or pipeline sizing, add a regression audit, and verify repeated Earth → Ringworld → Shieldworld cycles.
3. Rerun the complete cloud/flashlight/audio audit set and add a static assertion that flashlight visibility never toggles.
4. Continue the recovered backlog in order: reflections, the two vegetation-lighting issues, cliff realism, then stone ziggurat footsteps.

Three read-only diagnostic subagents for reflections, vegetation, and cliffs/footsteps were interrupted immediately when the user requested the pause; restart those investigations rather than assuming results were completed.

## Local tooling note

- This workspace is not a Git repository.
- OneDrive ACLs require escalated reads and the local Codex apply-patch binary workaround for edits.
- **Superseded safety rule (2026-07-17):** never use isolated/headless/CDP Chrome
  for this project. Keep exactly one preview server and at most one normal,
  user-visible browser window; never control or reload the user's visible page.
