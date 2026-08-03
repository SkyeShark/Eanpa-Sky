#!/usr/bin/env python3
"""Render Aletheia's authored hand topology with current rig pivots overlaid."""

from __future__ import annotations

import ast
import os
from pathlib import Path

import bmesh
import bpy
from mathutils import Vector


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "assets" / "player" / "Aletheia_Chrome_1p_arms.glb"
BUILDER = ROOT / "tools" / "build-first-person-viewmodel.py"
OUT = ROOT / "artifacts" / "first-person-viewmodel" / "joint-pivots"


def guide_points() -> dict:
    import json
    import sys

    tools_dir = str(ROOT / "tools")
    if tools_dir not in sys.path:
        sys.path.insert(0, tools_dir)
    from first_person_hinge_projection import derive_measured_digit_pivots

    document = json.loads(
        (
            ROOT / "assets" / "player" / "Aletheia_Chrome_1p_arms_hinge_seams.json"
        ).read_text(encoding="utf-8")
    )
    pivots, _provenance = derive_measured_digit_pivots(document)
    return pivots


def material(name: str, color) -> bpy.types.Material:
    value = bpy.data.materials.new(name)
    value.diffuse_color = (*color, 1.0)
    return value


def add_marker(name: str, location, color, radius: float) -> None:
    bpy.ops.mesh.primitive_uv_sphere_add(segments=24, ring_count=12, radius=radius, location=location)
    marker = bpy.context.object
    marker.name = name
    marker.data.materials.append(material(f"{name}_Material", color))


def add_joint_ring(name: str, location, tangent: Vector, color, radius: float) -> None:
    rotation = Vector((0.0, 0.0, 1.0)).rotation_difference(tangent.normalized())
    bpy.ops.mesh.primitive_torus_add(
        align="WORLD",
        major_segments=48,
        minor_segments=8,
        location=location,
        rotation=rotation.to_euler(),
        major_radius=radius,
        minor_radius=0.00075,
    )
    ring = bpy.context.object
    ring.name = name
    ring.data.materials.append(material(f"{name}_Material", color))


def add_line(name: str, points, color) -> None:
    curve_data = bpy.data.curves.new(name, type="CURVE")
    curve_data.dimensions = "3D"
    curve_data.bevel_depth = 0.0013
    curve_data.bevel_resolution = 2
    spline = curve_data.splines.new("POLY")
    spline.points.add(len(points) - 1)
    for target, source in zip(spline.points, points):
        target.co = (*source, 1.0)
    curve = bpy.data.objects.new(name, curve_data)
    bpy.context.collection.objects.link(curve)
    curve.data.materials.append(material(f"{name}_Material", color))


def main() -> None:
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    bpy.ops.import_scene.gltf(filepath=str(SOURCE))
    hand = next(obj for obj in bpy.context.scene.objects if obj.type == "MESH")
    hand.name = "Aletheia_Authored_Right_Hand"
    isolated = bmesh.new()
    isolated.from_mesh(hand.data)
    bmesh.ops.delete(
        isolated,
        geom=[vertex for vertex in isolated.verts if vertex.co.x < 0.0 or vertex.co.y < 0.54],
        context="VERTS",
    )
    isolated.to_mesh(hand.data)
    isolated.free()
    hand.data.update()
    hand.show_wire = False
    hand.show_all_edges = False
    hand.color = (0.36, 0.40, 0.46, 1.0)
    map_mode = os.environ.get("EANPA_JOINT_MAP_MODE", "pbr").strip().lower()
    if map_mode != "pbr":
        image_tokens = {
            "basecolor": "baked_basecolor",
            "normal": "normal",
            "metallicroughness": "baked_metallicroughness",
        }
        if map_mode not in image_tokens:
            raise RuntimeError(f"Unsupported EANPA_JOINT_MAP_MODE: {map_mode}")
        source_material = hand.data.materials[0]
        nodes = source_material.node_tree.nodes
        links = source_material.node_tree.links
        image_node = next(
            node
            for node in nodes
            if node.type == "TEX_IMAGE"
            and node.image
            and image_tokens[map_mode] in node.image.name.lower()
        )
        output = next(node for node in nodes if node.type == "OUTPUT_MATERIAL")
        emission = nodes.new("ShaderNodeEmission")
        emission.inputs["Strength"].default_value = 1.0
        links.new(image_node.outputs["Color"], emission.inputs["Color"])
        links.new(emission.outputs["Emission"], output.inputs["Surface"])

    colors = {
        "thumb": (0.98, 0.25, 0.12),
        "index": (1.00, 0.68, 0.05),
        "middle": (0.18, 0.95, 0.30),
        "ring": (0.10, 0.60, 1.00),
        "pinky": (0.90, 0.15, 1.00),
    }
    for digit, points in guide_points()["right"].items():
        add_line(f"right_{digit}_guide", points, colors[digit])
        for index, point in enumerate(points[:-1]):
            if index == 0:
                tangent = Vector(points[1]) - Vector(points[0])
            else:
                tangent = Vector(points[index + 1]) - Vector(points[index - 1])
            radius = 0.025 if digit == "thumb" else 0.018
            add_joint_ring(
                f"right_{digit}_pivot_{index}",
                point,
                tangent,
                colors[digit],
                radius,
            )

    scene = bpy.context.scene
    target = Vector((0.315, 0.805, 0.355))
    scene.render.engine = "BLENDER_EEVEE_NEXT"
    scene.world.color = (0.035, 0.045, 0.065)
    if scene.world:
        scene.world.use_nodes = True
        background = scene.world.node_tree.nodes.get("Background")
        background.inputs["Color"].default_value = (0.035, 0.045, 0.065, 1.0)
        background.inputs["Strength"].default_value = 0.25
    for name, location, energy, size in (
        ("Joint_Key", (0.1, 0.45, 1.6), 90.0, 1.8),
        ("Joint_Fill", (1.4, 1.0, 0.2), 55.0, 1.4),
        ("Joint_Rim", (-0.5, 1.4, 0.8), 70.0, 1.2),
    ):
        light_data = bpy.data.lights.new(name, type="AREA")
        light_data.energy = energy
        light_data.shape = "DISK"
        light_data.size = size
        light = bpy.data.objects.new(name, light_data)
        bpy.context.collection.objects.link(light)
        light.location = location
        light.rotation_euler = (target - light.location).to_track_quat("-Z", "Y").to_euler()
    scene.render.resolution_x = 1024
    scene.render.resolution_y = 1024
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "JPEG"
    scene.render.image_settings.quality = 90
    if map_mode == "pbr":
        scene.view_settings.look = "AgX - Medium High Contrast"
        scene.view_settings.exposure = -1.0
    else:
        scene.view_settings.look = "AgX - Medium Low Contrast"
        scene.view_settings.exposure = 0.0
    scene.render.film_transparent = False

    camera_data = bpy.data.cameras.new("JointDiagnosticCamera")
    camera_data.type = "ORTHO"
    camera_data.ortho_scale = 0.43
    camera = bpy.data.objects.new("JointDiagnosticCamera", camera_data)
    bpy.context.collection.objects.link(camera)
    scene.camera = camera
    views = {
        "palm": Vector((0.0, 0.0, -2.0)),
        "back": Vector((0.0, 0.0, 2.0)),
        "front": Vector((0.0, -2.0, 0.0)),
        "side": Vector((2.0, 0.0, 0.0)),
    }
    OUT.mkdir(parents=True, exist_ok=True)
    for view, offset in views.items():
        camera.location = target + offset
        camera.rotation_euler = (target - camera.location).to_track_quat("-Z", "Y").to_euler()
        prefix = "current_pivots" if map_mode == "pbr" else f"{map_mode}_pivots"
        scene.render.filepath = str(OUT / f"{prefix}_{view}.jpg")
        bpy.ops.render.render(write_still=True)
        print("JOINT_DIAGNOSTIC_RENDER", scene.render.filepath)
    for obj in bpy.context.scene.objects:
        if obj.name.startswith("right_"):
            obj.hide_render = True
    for view, offset in views.items():
        camera.location = target + offset
        camera.rotation_euler = (target - camera.location).to_track_quat("-Z", "Y").to_euler()
        prefix = "authored_joints" if map_mode == "pbr" else f"{map_mode}_clean"
        scene.render.filepath = str(OUT / f"{prefix}_{view}.jpg")
        bpy.ops.render.render(write_still=True)
        print("JOINT_DIAGNOSTIC_RENDER", scene.render.filepath)


if __name__ == "__main__":
    main()
