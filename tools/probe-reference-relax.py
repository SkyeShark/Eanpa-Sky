#!/usr/bin/env python3
"""Print the supplied reference rig hierarchy and relax pose transforms."""

from pathlib import Path

import bpy


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "assets" / "player" / "rig_reference" / "Drillimpact_PSX_First_Person_Arms_CC0.glb"


bpy.ops.object.select_all(action="SELECT")
bpy.ops.object.delete(use_global=False)
bpy.ops.import_scene.gltf(filepath=str(SOURCE))
armature = next(obj for obj in bpy.context.scene.objects if obj.type == "ARMATURE")
armature.animation_data_create()
for track in armature.animation_data.nla_tracks:
    track.mute = True

print("REFERENCE_BONES_BEGIN")
for bone in armature.data.bones:
    print(f"{bone.name}|parent={bone.parent.name if bone.parent else '-'}")
print("REFERENCE_BONES_END")

for action_name in ("rest_ArmsRig", "relax_ArmsRig"):
    action = bpy.data.actions[action_name]
    armature.animation_data.action = action
    frame = max(1, round(action.frame_range[0]))
    bpy.context.scene.frame_set(frame)
    bpy.context.view_layer.update()
    print(f"REFERENCE_POSE_BEGIN {action_name} frame={frame}")
    for bone in armature.pose.bones:
        if any(token in bone.name.lower() for token in ("arm", "hand", "finger", "thumb", "f_", "palm")):
            matrix = bone.matrix.copy()
            head = matrix.translation
            tail = matrix @ bone.vector
            quaternion = bone.matrix_basis.to_quaternion()
            print(
                f"{bone.name}|head={tuple(round(v, 6) for v in head)}"
                f"|basis_q={tuple(round(v, 6) for v in quaternion)}"
                f"|basis_deg={round(quaternion.angle * 57.295779513, 4)}"
            )
    print(f"REFERENCE_POSE_END {action_name}")
