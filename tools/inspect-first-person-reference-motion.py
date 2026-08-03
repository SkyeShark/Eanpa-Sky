#!/usr/bin/env python3
"""Measure safe CC0 source-action motion on candidate retarget bones."""

from pathlib import Path
import math
import bpy

SOURCE = Path(r"C:\Users\sdn52\OneDrive\Desktop\Eanpa Engine\assets\player\rig_reference\Drillimpact_PSX_First_Person_Arms_CC0.glb")
PROBES = (
    "root", "upper_arm.R", "forearm.R", "hand.R", "handIK.R",
    "upper_arm.L", "forearm.L", "hand.L", "handIK.L",
)


def main() -> None:
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    bpy.ops.import_scene.gltf(filepath=str(SOURCE))
    armature = next(obj for obj in bpy.context.scene.objects if obj.type == "ARMATURE")
    if armature.animation_data is None:
        armature.animation_data_create()
    for track in armature.animation_data.nla_tracks:
        track.mute = True
    for token in ("rest", "relax", "push.R", "push.L"):
        action = next(item for item in bpy.data.actions if item.name == f"{token}_ArmsRig")
        armature.animation_data.action = action
        frames = range(max(1, int(math.ceil(action.frame_range[0]))), int(math.ceil(action.frame_range[1])) + 1)
        samples = {name: [] for name in PROBES}
        for frame in frames:
            bpy.context.scene.frame_set(frame)
            bpy.context.view_layer.update()
            for name in PROBES:
                bone = armature.pose.bones[name]
                samples[name].append((bone.matrix.translation.copy(), bone.matrix.to_quaternion()))
        for name, values in samples.items():
            base_position, base_rotation = values[0]
            position_delta = max((position - base_position).length for position, _rotation in values)
            rotation_delta = max(base_rotation.rotation_difference(rotation).angle for _position, rotation in values)
            print(
                "MOTION", token, name,
                "POSITION", round(position_delta, 7),
                "ROTATION_DEG", round(math.degrees(rotation_delta), 4),
            )


if __name__ == "__main__":
    main()
