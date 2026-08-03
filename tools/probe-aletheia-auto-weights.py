#!/usr/bin/env python3
"""Probe Blender heat weights on a welded Chrome deformation proxy."""

from pathlib import Path

import bmesh
import bpy
from mathutils import Vector


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "assets" / "player" / "Aletheia_Chrome_1p_arms.glb"
DIGITS = ("thumb", "index", "middle", "ring", "pinky")
SEGMENTS = {
    "thumb": ("metacarpal", "proximal", "distal"),
    "index": ("proximal", "intermediate", "distal"),
    "middle": ("proximal", "intermediate", "distal"),
    "ring": ("proximal", "intermediate", "distal"),
    "pinky": ("proximal", "intermediate", "distal"),
}


def points(sign):
    return {
        "shoulder": (sign * 0.57, -0.94, -0.27),
        "elbow": (sign * 0.50, -0.23, -0.10),
        "wrist": (sign * 0.37, 0.60, 0.17),
        "palm": (sign * 0.30, 0.75, 0.30),
        "thumb_base": (sign * 0.265, 0.715, 0.275),
        "thumb_tip": (sign * 0.115, 0.875, 0.205),
        "index_base": (sign * 0.245, 0.745, 0.355),
        "index_tip": (sign * 0.200, 0.910, 0.490),
        "middle_base": (sign * 0.292, 0.755, 0.370),
        "middle_tip": (sign * 0.282, 0.925, 0.530),
        "ring_base": (sign * 0.340, 0.745, 0.355),
        "ring_tip": (sign * 0.360, 0.910, 0.510),
        "pinky_base": (sign * 0.390, 0.720, 0.325),
        "pinky_tip": (sign * 0.460, 0.880, 0.450),
    }


def joints(anatomy, digit):
    start = Vector(anatomy[f"{digit}_base"])
    end = Vector(anatomy[f"{digit}_tip"])
    fractions = (0.0, 0.31, 0.66, 1.0) if digit == "thumb" else (0.0, 0.34, 0.68, 1.0)
    return [start.lerp(end, fraction) for fraction in fractions]


def main():
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    bpy.ops.import_scene.gltf(filepath=str(SOURCE))
    source = next(obj for obj in bpy.context.scene.objects if obj.type == "MESH")
    proxy_data = source.data.copy()
    proxy = bpy.data.objects.new("Chrome_Deformation_Proxy", proxy_data)
    bpy.context.collection.objects.link(proxy)
    bm = bmesh.new()
    bm.from_mesh(proxy_data)
    bmesh.ops.remove_doubles(bm, verts=list(bm.verts), dist=0.00002)
    bm.to_mesh(proxy_data)
    bm.free()
    proxy_data.update()
    print("PROXY_VERTICES", len(source.data.vertices), len(proxy_data.vertices))

    rig_data = bpy.data.armatures.new("AutoWeightProbeRig")
    rig = bpy.data.objects.new("AutoWeightProbeRig", rig_data)
    bpy.context.collection.objects.link(rig)
    bpy.context.view_layer.objects.active = rig
    rig.select_set(True)
    bpy.ops.object.mode_set(mode="EDIT")

    def add(name, head, tail, parent=None, connected=False, deform=True):
        bone = rig_data.edit_bones.new(name)
        bone.head = head
        bone.tail = tail
        bone.parent = parent
        bone.use_connect = connected
        bone.use_deform = deform
        direction = (Vector(tail) - Vector(head)).normalized()
        x_axis = Vector((1.0, 0.0, 0.0))
        if abs(direction.dot(x_axis)) > 0.94:
            x_axis = Vector((0.0, 0.0, 1.0))
        bone.align_roll(x_axis.cross(direction).normalized())
        return bone

    root = add("viewmodel_root", (0, -0.94, -0.30), (0, -0.69, -0.23), deform=False)
    for side, sign in (("left", -1.0), ("right", 1.0)):
        anatomy = points(sign)
        upper = add(f"{side}_upper_arm", anatomy["shoulder"], anatomy["elbow"], root)
        forearm = add(f"{side}_forearm", anatomy["elbow"], anatomy["wrist"], upper, True)
        hand = add(f"{side}_hand", anatomy["wrist"], anatomy["palm"], forearm, True)
        for digit in DIGITS:
            chain = joints(anatomy, digit)
            parent = hand
            for index, segment in enumerate(SEGMENTS[digit]):
                parent = add(
                    f"{side}_{digit}_{segment}",
                    chain[index],
                    chain[index + 1],
                    parent,
                    index > 0,
                )
    bpy.ops.object.mode_set(mode="OBJECT")

    bpy.ops.object.select_all(action="DESELECT")
    proxy.select_set(True)
    rig.select_set(True)
    bpy.context.view_layer.objects.active = rig
    result = bpy.ops.object.parent_set(type="ARMATURE_AUTO")
    print("AUTO_WEIGHT_RESULT", result)
    print("GROUPS", len(proxy.vertex_groups))
    coverage = {}
    for group in proxy.vertex_groups:
        values = []
        for vertex in proxy_data.vertices:
            value = next((item.weight for item in vertex.groups if item.group == group.index), 0.0)
            if value >= 0.01:
                values.append(value)
        coverage[group.name] = len(values)
    for name in sorted(coverage):
        print("COVERAGE", name, coverage[name])
    for side, sign in (("left", -1.0), ("right", 1.0)):
        names = (f"{side}_upper_arm", f"{side}_forearm", f"{side}_hand")
        indices = [proxy.vertex_groups[name].index for name in names]
        samples = []
        for vertex in proxy_data.vertices:
            if (vertex.co.x < 0.0) != (sign < 0.0):
                continue
            weights = {
                item.group: item.weight
                for item in vertex.groups
                if item.group in indices
            }
            samples.append((vertex.co.y, *(weights.get(index, 0.0) for index in indices)))
        for label, first, second in (
            ("ELBOW", 1, 2),
            ("WRIST", 2, 3),
        ):
            overlap = [row[0] for row in samples if row[first] >= 0.1 and row[second] >= 0.1]
            print(
                "BLEND_SPAN",
                side,
                label,
                len(overlap),
                round(min(overlap), 5) if overlap else None,
                round(max(overlap), 5) if overlap else None,
            )


if __name__ == "__main__":
    main()
