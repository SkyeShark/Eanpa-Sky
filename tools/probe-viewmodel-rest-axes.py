"""Measure local finger-axis effects in the authored Idle pose."""

import math

import bpy
from mathutils import Euler


ARMATURE_NAME = "Aletheia_Chrome_Viewmodel_Rig"
DIGITS = ("thumb", "index", "middle", "ring", "pinky")
FIRST_SEGMENT = {
    "thumb": "metacarpal",
    "index": "proximal",
    "middle": "proximal",
    "ring": "proximal",
    "pinky": "proximal",
}


def tip(armature, side, digit):
    bone = armature.pose.bones[f"{side}_{digit}_distal"]
    return armature.matrix_world @ bone.tail


def fmt(vector):
    return tuple(round(value, 6) for value in vector)


armature = bpy.data.objects[ARMATURE_NAME]
idle = bpy.data.actions.get("Idle")
armature.animation_data_create()
armature.animation_data.action = idle
bpy.context.scene.frame_set(1)
bpy.context.view_layer.update()

for side in ("left", "right"):
    print(f"SIDE {side}")
    baseline = {digit: tip(armature, side, digit).copy() for digit in DIGITS}
    middle = baseline["middle"]
    for digit in DIGITS:
        bone = armature.pose.bones[f"{side}_{digit}_{FIRST_SEGMENT[digit]}"]
        bone.rotation_mode = "QUATERNION"
        original = bone.rotation_quaternion.copy()
        print(
            f"  {digit:6s} base={fmt(baseline[digit])} "
            f"to_middle={round((baseline[digit] - middle).length, 6)}"
        )
        for axis, values in (("X", (math.radians(-10.0), 0.0, 0.0)),
                             ("Y", (0.0, math.radians(-10.0), 0.0)),
                             ("Z", (0.0, 0.0, math.radians(-10.0)))):
            for sign in (-1.0, 1.0):
                delta_values = tuple(value * sign for value in values)
                bone.rotation_quaternion = original @ Euler(delta_values, "XYZ").to_quaternion()
                bpy.context.view_layer.update()
                moved = tip(armature, side, digit)
                print(
                    f"    {axis}{int(-10 * sign):+d} "
                    f"delta={fmt(moved - baseline[digit])} "
                    f"to_middle={round((moved - middle).length, 6)}"
                )
        bone.rotation_quaternion = original
        bpy.context.view_layer.update()
