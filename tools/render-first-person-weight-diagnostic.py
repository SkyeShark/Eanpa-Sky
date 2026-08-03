#!/usr/bin/env python3
"""Render dominant skin-bone ownership on the generated viewmodel mesh."""

from collections import Counter
from pathlib import Path
import math

import bmesh
import bpy
from mathutils import Vector


ROOT = Path(__file__).resolve().parents[1]
ASSET = ROOT / "assets" / "player" / "runtime" / "Aletheia_Chrome_1p_arms_viewmodel.glb"
OUT = ROOT / "artifacts" / "first-person-viewmodel" / "weights"

PALETTE = {
    "upper_arm": (0.12, 0.12, 0.14, 1.0),
    "forearm": (0.30, 0.30, 0.34, 1.0),
    "hand": (0.72, 0.72, 0.74, 1.0),
    "thumb": (0.95, 0.12, 0.08, 1.0),
    "index": (1.00, 0.55, 0.04, 1.0),
    "middle": (0.25, 0.90, 0.18, 1.0),
    "ring": (0.05, 0.55, 1.00, 1.0),
    "pinky": (0.85, 0.12, 0.92, 1.0),
}


def owner_family(group_name: str) -> str:
    for digit in ("thumb", "index", "middle", "ring", "pinky"):
        if f"_{digit}_" in group_name:
            return digit
    for family in ("upper_arm", "forearm", "hand"):
        if group_name.endswith(f"_{family}"):
            return family
    return "upper_arm"


def owner_color(group_name: str) -> tuple[float, float, float, float]:
    family = owner_family(group_name)
    base = PALETTE[family]
    if family not in {"thumb", "index", "middle", "ring", "pinky"}:
        return base
    if group_name.endswith("_metacarpal") or group_name.endswith("_proximal"):
        factor = 0.62
    elif group_name.endswith("_intermediate"):
        factor = 0.82
    else:
        factor = 1.0
    return tuple(channel * factor for channel in base[:3]) + (1.0,)


def main() -> None:
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    bpy.ops.import_scene.gltf(filepath=str(ASSET))
    armature = next(obj for obj in bpy.context.scene.objects if obj.type == "ARMATURE")
    mesh = next(obj for obj in bpy.context.scene.objects if obj.type == "MESH")
    if armature.animation_data:
        armature.animation_data.action = None
        for track in armature.animation_data.nla_tracks:
            track.mute = True
    for bone in armature.pose.bones:
        bone.matrix_basis.identity()

    isolated = bmesh.new()
    isolated.from_mesh(mesh.data)
    bmesh.ops.delete(
        isolated,
        geom=[vertex for vertex in isolated.verts if vertex.co.x < 0.0],
        context="VERTS",
    )
    isolated.to_mesh(mesh.data)
    isolated.free()
    mesh.data.update()

    color = mesh.data.color_attributes.get("rig_weight_owner")
    if color is None:
        color = mesh.data.color_attributes.new(
            name="rig_weight_owner", type="BYTE_COLOR", domain="CORNER"
        )
    owners = {}
    owner_groups = {}
    counts = Counter()
    group_counts = Counter()
    for vertex in mesh.data.vertices:
        if not vertex.groups:
            group_name = "right_upper_arm"
        else:
            assignment = max(vertex.groups, key=lambda item: item.weight)
            group_name = mesh.vertex_groups[assignment.group].name
        family = owner_family(group_name)
        owners[vertex.index] = family
        owner_groups[vertex.index] = group_name
        counts[family] += 1
        group_counts[group_name] += 1
    for loop in mesh.data.loops:
        color.data[loop.index].color = owner_color(owner_groups[loop.vertex_index])

    camera_data = bpy.data.cameras.new("WeightDiagnosticCamera")
    camera_data.type = "ORTHO"
    camera_data.ortho_scale = 0.76
    camera = bpy.data.objects.new("WeightDiagnosticCamera", camera_data)
    bpy.context.collection.objects.link(camera)
    bpy.context.scene.camera = camera

    scene = bpy.context.scene
    scene.render.engine = "BLENDER_WORKBENCH"
    scene.display.shading.light = "STUDIO"
    scene.display.shading.color_type = "VERTEX"
    scene.display.shading.show_shadows = False
    scene.display.shading.show_cavity = True
    scene.display.shading.cavity_type = "BOTH"
    scene.display.shading.background_type = "WORLD"
    scene.display.shading.background_color = (0.025, 0.03, 0.045)
    scene.render.resolution_x = 700
    scene.render.resolution_y = 700
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "JPEG"
    scene.render.image_settings.quality = 90
    OUT.mkdir(parents=True, exist_ok=True)

    hand = armature.pose.bones["right_hand"]
    target = armature.matrix_world @ ((hand.head + hand.tail) * 0.5)
    views = (
        ("top", Vector((0.0, 0.0, 3.0))),
        ("camera", Vector((0.0, -3.0, 0.0))),
        ("side", Vector((3.0, 0.0, 0.0))),
    )
    for name, offset in views:
        camera.location = target + offset
        camera.rotation_euler = (target - camera.location).to_track_quat("-Z", "Y").to_euler()
        scene.render.filepath = str(OUT / f"dominant_owner_{name}.jpg")
        bpy.ops.render.render(write_still=True)
        print("VIEWMODEL_WEIGHT_DIAGNOSTIC", scene.render.filepath)
    print("VIEWMODEL_DOMINANT_OWNER_COUNTS", dict(sorted(counts.items())))
    print("VIEWMODEL_DOMINANT_GROUP_COUNTS", dict(sorted(group_counts.items())))


if __name__ == "__main__":
    main()
