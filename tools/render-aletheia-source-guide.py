#!/usr/bin/env python3
"""Render orthographic anatomy guides for the unrigged Chrome source."""

from pathlib import Path

import bpy
from mathutils import Vector


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "assets" / "player" / "Aletheia_Chrome_1p_arms.glb"
OUT = ROOT / "artifacts" / "first-person-viewmodel" / "source-guide"


def point_camera(camera, location, target, scale):
    camera.location = location
    camera.rotation_euler = (Vector(target) - Vector(location)).to_track_quat("-Z", "Y").to_euler()
    camera.data.ortho_scale = scale


def main() -> None:
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    bpy.ops.import_scene.gltf(filepath=str(SOURCE))
    mesh = next(obj for obj in bpy.context.scene.objects if obj.type == "MESH")
    mesh.color = (0.66, 0.71, 0.78, 1.0)
    camera_data = bpy.data.cameras.new("SourceGuideCamera")
    camera_data.type = "ORTHO"
    camera = bpy.data.objects.new("SourceGuideCamera", camera_data)
    bpy.context.collection.objects.link(camera)
    bpy.context.scene.camera = camera

    scene = bpy.context.scene
    scene.render.engine = "BLENDER_WORKBENCH"
    scene.display.shading.light = "STUDIO"
    scene.display.shading.color_type = "OBJECT"
    scene.display.shading.show_shadows = True
    scene.display.shading.show_cavity = True
    scene.display.shading.cavity_type = "BOTH"
    scene.display.shading.background_type = "WORLD"
    scene.display.shading.background_color = (0.025, 0.03, 0.045)
    scene.render.resolution_x = 900
    scene.render.resolution_y = 900
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    OUT.mkdir(parents=True, exist_ok=True)

    views = (
        ("full_top", (0.0, 0.0, 4.0), (0.0, 0.0, 0.0), 2.15),
        ("full_camera", (0.0, -4.0, 0.0), (0.0, 0.0, 0.0), 2.15),
        ("right_top", (0.0, 0.78, 3.0), (0.30, 0.78, 0.32), 0.72),
        ("right_camera", (0.30, -2.2, 0.32), (0.30, 0.78, 0.32), 0.72),
        ("right_side", (3.0, 0.78, 0.32), (0.30, 0.78, 0.32), 0.72),
    )
    for name, location, target, scale in views:
        point_camera(camera, location, target, scale)
        scene.render.filepath = str(OUT / f"{name}.png")
        bpy.ops.render.render(write_still=True)
        print("SOURCE_GUIDE", scene.render.filepath)


if __name__ == "__main__":
    main()
