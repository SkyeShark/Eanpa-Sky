# Drillimpact PSX First Person Arms motion reference

- Creator: Drillimpact
- Asset: `PSX First Person Arms`, version 1.1.0
- Source: https://drillimpact.itch.io/psx-first-person-arms-free
- License: CC0 / Public Domain, as stated on the source page and its 2026-04-10 update log
- Local source file: `Drillimpact_PSX_First_Person_Arms_CC0.glb`
- SHA-256: recorded in `first_person_viewmodel_manifest.json` during the runtime build

Only animation timing and articulated pose reference are used. The runtime
mesh, silhouette, UVs, and PBR textures remain the authored Aletheia Chrome
arms/hands. The accepted source actions are `rest`, `relax`, `push.L`, and
`push.R`.

`rest` is a spatial pose reference, not the Chrome asset's exported rest pose.
The Chrome natural rest is authored for its own proportions, with lowered
forearms, inward-facing palms, neutral wrists, and softly curled fingers, then
baked into the Chrome mesh and armature rest state. `relax` and the two push
actions provide safe motion timing. Weapon, knife, jab, grab, guard, and every
`finger_gun_*` clip are excluded.
