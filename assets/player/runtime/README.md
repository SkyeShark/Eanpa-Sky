# Aletheia Chrome first-person viewmodel runtime

The Aletheia Chrome asset replaces the previous Aletheia arms as the active
first-person viewmodel. Its immutable source is
`assets/player/Aletheia_Chrome_1p_arms.glb`; the builder reads but never
overwrites that file, and records its SHA-256 in
`first_person_viewmodel_manifest.json`. The source contains one static
55,446-triangle mesh, no skin or animation clips, an 8K base-colour map, and 4K
normal and metallic/roughness maps.

The source's open hands, extended fingers, and raised wrists are a modeling
pose used to place bones and establish stable inverse binds. They are not the
visible rest pose. The builder adds a 37-bone anatomical rig and retains that
clean source pose only as the bind pose. Every clip is composed over an
authored lowered, palms-in, neutral-wrist stance with softly curled and
adducted fingers; the editable Blend opens on Idle frame 1 so that natural pose
is the authoring preview. The builder saves that scene as
`assets/player/Aletheia_Chrome_1p_arms_rigged.blend`.

The rig contains one viewmodel root; upper-arm, forearm, and hand bones on each
side; and three bones for every digit. The thumb uses metacarpal, proximal, and
distal segments, while the four fingers use proximal, intermediate, and distal
segments. All 30 digit bones are animated across nine runtime clips: Idle,
Walk, Run, Jump, Land, PushLeft, PushRight, ContactRecoil, and Climb.

Skinning is built on a disposable copy welded across the source's UV seams.
Fingertip-seeded geodesic ownership keeps every ring, pinky, and web strip with
one digit branch; longitudinal two-bone blends then articulate each knuckle.
Rigid shaft interiors use localized elbow and wrist transition bands, with at
most four influences and no cross-side leakage. This avoids the former
rubber-hose forearms, split wrist rings, and cross-finger deformation.

Drillimpact's CC0 `PSX First Person Arms` supplies safe reference material from
`rest`, `relax`, `push.L`, and `push.R`. The `rest` action is a spatial pose
reference only; the Chrome natural rest is authored for this mesh rather than
copied from the reference. `relax` and the two push actions provide safe motion
timing. No reference mesh or textures are exported, and weapon, knife,
finger-gun, jab, grab, and guard actions remain excluded.

Rebuild with Blender 4.3 or newer from the repository root:

```powershell
& 'C:\Program Files\Blender Foundation\Blender 4.3\blender.exe' --background --factory-startup --python tools\build-first-person-viewmodel.py
```

The build emits:

- `assets/player/Aletheia_Chrome_1p_arms_rigged.blend`
- `assets/player/runtime/Aletheia_Chrome_1p_arms_viewmodel.glb`
- `assets/player/runtime/Aletheia_Chrome_Viewmodel_BaseColor_4K.png`
- `assets/player/runtime/Aletheia_Chrome_Viewmodel_Normal_2K.png`
- `assets/player/runtime/Aletheia_Chrome_Viewmodel_MetallicRoughness_2K.png`
- `assets/player/runtime/first_person_viewmodel_manifest.json`

The standalone PNGs are reproducibility masters; the same images are embedded
inside the runtime GLB. The active integration uses identity model rotation, a
scale of `0.275`, and camera-local offset `[0, -0.19, -0.30]`. Runtime
isolation, movement-state blending, climb playback, and depth behavior live in
`src/first_person_viewmodel.js`.

Run both focused audits from the repository root:

```powershell
& 'C:\Program Files\Blender Foundation\Blender 4.3\blender.exe' --background --factory-startup --python tools\audit-first-person-viewmodel-blender.py
node tools\audit-first-person-viewmodel-static.mjs
```

The Blender audit writes
`artifacts/first-person-viewmodel/rig_audit.json`; the static audit validates
the generated assets, manifest, rig contract, clips, and runtime integration.
The Blender pass also measures joint-band widths, influence ownership,
within-digit edge stretch, and UV-seam divergence across every sampled pose.
