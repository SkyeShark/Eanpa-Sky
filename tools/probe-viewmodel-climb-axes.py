"""Measure which local arm axes pull the two-hand climb reach inward."""

import math

import bpy
from mathutils import Euler


ARMATURE_NAME = "Aletheia_Chrome_Viewmodel_Rig"
DIGITS = ("thumb", "index", "middle", "ring", "pinky")


def tips(armature, side):
    return [
        armature.matrix_world @ armature.pose.bones[f"{side}_{digit}_distal"].tail
        for digit in DIGITS
    ]


def summary(armature, side):
    points = tips(armature, side)
    return (
        round(sum(point.x for point in points) / len(points), 6),
        round(min(point.x for point in points), 6),
        round(max(point.x for point in points), 6),
    )


armature = bpy.data.objects[ARMATURE_NAME]
armature.animation_data_create()
for track in armature.animation_data.nla_tracks:
    track.mute = True
armature.animation_data.action = bpy.data.actions["Climb"]
bpy.context.scene.frame_set(10)
bpy.context.view_layer.update()

for side in ("left", "right"):
    print(f"SIDE {side} BASE avg/min/max x={summary(armature, side)}")
    for part in ("upper_arm", "forearm", "hand"):
        bone = armature.pose.bones[f"{side}_{part}"]
        bone.rotation_mode = "QUATERNION"
        original = bone.rotation_quaternion.copy()
        for axis_index, axis in enumerate("XYZ"):
            for angle in (-5.0, 5.0):
                values = [0.0, 0.0, 0.0]
                values[axis_index] = math.radians(angle)
                bone.rotation_quaternion = original @ Euler(values, "XYZ").to_quaternion()
                bpy.context.view_layer.update()
                print(f"  {part:9s} {axis}{angle:+.0f} avg/min/max x={summary(armature, side)}")
        bone.rotation_quaternion = original
        bpy.context.view_layer.update()

