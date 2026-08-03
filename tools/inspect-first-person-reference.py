#!/usr/bin/env python3
"""Inspect the CC0 Drillimpact first-person reference rig and actions."""

from pathlib import Path

import bpy


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "assets" / "player" / "rig_reference" / "Drillimpact_PSX_First_Person_Arms_CC0.glb"


def main() -> None:
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    bpy.ops.import_scene.gltf(filepath=str(SOURCE))
    armature = next(obj for obj in bpy.context.scene.objects if obj.type == "ARMATURE")
    print("REFERENCE_ARMATURE", armature.name, "BONES", len(armature.data.bones))
    for bone in armature.data.bones:
        print(
            "BONE", bone.name,
            "PARENT", bone.parent.name if bone.parent else "-",
            "HEAD", tuple(round(value, 5) for value in bone.head_local),
            "TAIL", tuple(round(value, 5) for value in bone.tail_local),
        )
    for action in sorted(bpy.data.actions, key=lambda item: item.name):
        groups = sorted({curve.group.name for curve in action.fcurves if curve.group})
        print(
            "ACTION", action.name,
            "RANGE", tuple(round(value, 3) for value in action.frame_range),
            "CURVES", len(action.fcurves),
            "GROUPS", groups,
        )


if __name__ == "__main__":
    main()
