#!/usr/bin/env python3
"""Render the supplied CC0 reference arms in their authored rest action."""

import os
from pathlib import Path

import bpy
from mathutils import Vector


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "assets" / "player" / "rig_reference" / "Drillimpact_PSX_First_Person_Arms_CC0.glb"
OUT = ROOT / "artifacts" / "first-person-viewmodel" / "reference-rest"
ACTION_NAME = os.environ.get("EANPA_REFERENCE_ACTION", "rest")
ACTION_FRACTION = max(0.0, min(1.0, float(os.environ.get("EANPA_REFERENCE_FRACTION", "0"))))


def point_camera(camera, location, target, scale):
    camera.location = location
    camera.rotation_euler = (Vector(target) - Vector(location)).to_track_quat("-Z", "Y").to_euler()
    camera.data.ortho_scale = scale


def main() -> None:
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    bpy.ops.import_scene.gltf(filepath=str(SOURCE))
    armature = next(obj for obj in bpy.context.scene.objects if obj.type == "ARMATURE")
    meshes = [obj for obj in bpy.context.scene.objects if obj.type == "MESH"]
    for mesh in meshes:
        mesh.hide_render = False
        mesh.hide_viewport = False
        mesh.color = (0.66, 0.71, 0.78, 1.0)
    armature.animation_data_create()
    for track in armature.animation_data.nla_tracks:
        track.mute = True
    action = bpy.data.actions[f"{ACTION_NAME}_ArmsRig"]
    armature.animation_data.action = action
    frame = round(action.frame_range[0] + (action.frame_range[1] - action.frame_range[0]) * ACTION_FRACTION)
    bpy.context.scene.frame_set(max(1, int(frame)))
    bpy.context.view_layer.update()

    depsgraph = bpy.context.evaluated_depsgraph_get()
    points = []
    for mesh in meshes:
        evaluated = mesh.evaluated_get(depsgraph)
        points.extend(evaluated.matrix_world @ vertex.co for vertex in evaluated.data.vertices)
    minimum = Vector(tuple(min(point[axis] for point in points) for axis in range(3)))
    maximum = Vector(tuple(max(point[axis] for point in points) for axis in range(3)))
    center = (minimum + maximum) * 0.5
    span = maximum - minimum
    distance = max(span) * 2.5

    camera_data = bpy.data.cameras.new("ReferenceRestCamera")
    camera_data.type = "ORTHO"
    camera = bpy.data.objects.new("ReferenceRestCamera", camera_data)
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
    scene.render.image_settings.file_format = "JPEG"
    scene.render.image_settings.quality = 82
    OUT.mkdir(parents=True, exist_ok=True)

    views = (
        ("front", center + Vector((0.0, -distance, 0.0)), max(span.x, span.z) * 1.18),
        ("top", center + Vector((0.0, 0.0, distance)), max(span.x, span.y) * 1.18),
        ("side", center + Vector((distance, 0.0, 0.0)), max(span.y, span.z) * 1.18),
    )
    for name, location, scale in views:
        point_camera(camera, location, center, max(scale, 0.1))
        scene.render.filepath = str(OUT / f"{ACTION_NAME}_{ACTION_FRACTION:.2f}_{name}.jpg")
        bpy.ops.render.render(write_still=True)
        print("REFERENCE_REST", scene.render.filepath)


if __name__ == "__main__":
    main()
