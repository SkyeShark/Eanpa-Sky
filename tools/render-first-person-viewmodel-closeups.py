#!/usr/bin/env python3
"""Render orthographic closeups of critical hand poses from three axes."""

from pathlib import Path
import json
import math
import os

import bmesh
import bpy
from mathutils import Euler, Vector


ROOT = Path(__file__).resolve().parents[1]
ASSET = ROOT / "assets" / "player" / "runtime" / "Aletheia_Chrome_1p_arms_viewmodel.glb"
OUT = ROOT / "artifacts" / "first-person-viewmodel" / "closeups"
SAMPLES = (
    ("Idle", 24, "idle"),
    ("PushRight", 10, "push"),
    ("Climb", 14, "grip"),
    ("Climb", 20, "pull"),
)
VIEW_OFFSETS = (
    ("back", (0.0, 0.0, 3.0)),
    ("palm", (0.0, 0.0, -3.0)),
    ("camera", (0.0, -3.0, 0.0)),
    ("side", (3.0, 0.0, 0.0)),
)


def find_action(name):
    return next(
        action
        for action in bpy.data.actions
        if action.name == name or action.name.startswith(name + "_")
    )


def main():
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    bpy.ops.import_scene.gltf(filepath=str(ASSET))
    armature = next(obj for obj in bpy.context.scene.objects if obj.type == "ARMATURE")
    mesh = next(obj for obj in bpy.context.scene.objects if obj.type == "MESH")
    # Isolate the right arm; side-axis closeups otherwise superimpose both
    # hands and falsely resemble duplicated or shredded fingers.
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
    for track in armature.animation_data.nla_tracks:
        track.mute = True

    camera_data = bpy.data.cameras.new("CloseupCamera")
    camera_data.type = "ORTHO"
    camera_data.ortho_scale = float(
        os.environ.get("EANPA_PROBE_ORTHO_SCALE", "0.76")
    )
    camera = bpy.data.objects.new("CloseupCamera", camera_data)
    bpy.context.collection.objects.link(camera)
    bpy.context.scene.camera = camera
    scene = bpy.context.scene
    probe_pbr = os.environ.get("EANPA_PROBE_PBR", "0") == "1"
    if probe_pbr:
        scene.render.engine = "BLENDER_EEVEE_NEXT"
        scene.render.image_settings.color_mode = "RGB"
        scene.world.use_nodes = True
        background = scene.world.node_tree.nodes.get("Background")
        background.inputs["Color"].default_value = (0.012, 0.016, 0.025, 1.0)
        background.inputs["Strength"].default_value = 0.2
        target = Vector((0.3, 0.82, 0.36))
        for name, location, energy, size in (
            ("Closeup_Key", (0.0, 0.35, 1.55), 110.0, 1.35),
            ("Closeup_Fill", (1.45, 0.95, 0.35), 85.0, 1.15),
            ("Closeup_Rim", (-0.65, 1.45, 0.75), 95.0, 1.0),
        ):
            light_data = bpy.data.lights.new(name, type="AREA")
            light_data.energy = energy
            light_data.shape = "DISK"
            light_data.size = size
            light = bpy.data.objects.new(name, light_data)
            bpy.context.collection.objects.link(light)
            light.location = location
            light.rotation_euler = (
                target - light.location
            ).to_track_quat("-Z", "Y").to_euler()
        scene.view_settings.look = "AgX - Medium High Contrast"
        scene.view_settings.exposure = -0.65
    else:
        scene.render.engine = "BLENDER_WORKBENCH"
        scene.display.shading.light = "STUDIO"
        scene.display.shading.color_type = "MATERIAL"
        scene.display.shading.show_shadows = True
        scene.display.shading.show_cavity = True
        scene.display.shading.cavity_type = "BOTH"
        scene.display.shading.background_type = "WORLD"
        scene.display.shading.background_color = (0.025, 0.03, 0.045)
    scene.render.resolution_x = 700
    scene.render.resolution_y = 700
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "JPEG"
    scene.render.image_settings.quality = 88
    OUT.mkdir(parents=True, exist_ok=True)
    probe_sample_names = {
        name.strip()
        for name in os.environ.get("EANPA_PROBE_SAMPLE_NAMES", "").split(",")
        if name.strip()
    }
    probe_suffix = os.environ.get("EANPA_PROBE_SUFFIX", "").strip()
    probe_bind_pose = os.environ.get("EANPA_PROBE_BIND_POSE", "0") == "1"
    probe_digit_deltas = json.loads(
        os.environ.get("EANPA_PROBE_DIGIT_DELTAS_JSON", "{}")
    )
    probe_hand_rotation = (
        float(os.environ.get("EANPA_PROBE_HAND_X_DEGREES", "0")),
        float(os.environ.get("EANPA_PROBE_HAND_Y_DEGREES", "0")),
        float(os.environ.get("EANPA_PROBE_HAND_Z_DEGREES", "0")),
    )

    samples = SAMPLES + (("__BIND__", 1, "bind"),) if probe_bind_pose else SAMPLES
    for action_name, requested_frame, pose_name in samples:
        if probe_sample_names and action_name not in probe_sample_names:
            continue
        frame_override = os.environ.get(
            f"EANPA_{action_name.upper().replace('.', '_')}_FRAME"
        )
        if frame_override is not None:
            requested_frame = int(frame_override)
        if action_name == "__BIND__":
            armature.animation_data.action = None
            for bone in armature.pose.bones:
                bone.matrix_basis.identity()
            scene.frame_set(1)
        else:
            action = find_action(action_name)
            armature.animation_data.action = action
            scene.frame_set(
                max(
                    int(action.frame_range[0]),
                    min(int(action.frame_range[1]), requested_frame),
                )
            )
            sampled_basis = {
                bone.name: bone.matrix_basis.copy()
                for bone in armature.pose.bones
            }
            armature.animation_data.action = None
            for bone in armature.pose.bones:
                bone.matrix_basis = sampled_basis[bone.name]
        for digit, segment_deltas in probe_digit_deltas.items():
            for segment, delta_degrees in segment_deltas.items():
                bone = armature.pose.bones[f"right_{digit}_{segment}"]
                delta = Euler(
                    tuple(math.radians(float(value)) for value in delta_degrees),
                    "XYZ",
                ).to_quaternion()
                bone.matrix_basis = (
                    bone.matrix_basis @ delta.to_matrix().to_4x4()
                )
        if any(abs(value) > 1e-6 for value in probe_hand_rotation):
            hand = armature.pose.bones["right_hand"]
            hand_delta = Euler(
                tuple(math.radians(value) for value in probe_hand_rotation),
                "XYZ",
            ).to_quaternion()
            hand.matrix_basis = (
                hand.matrix_basis @ hand_delta.to_matrix().to_4x4()
            )
        bpy.context.view_layer.update()
        hand = armature.pose.bones["right_hand"]
        target = armature.matrix_world @ ((hand.head + hand.tail) * 0.5)
        for view_name, offset in VIEW_OFFSETS:
            location = target + Vector(offset)
            camera.location = location
            camera.rotation_euler = (
                target - Vector(location)
            ).to_track_quat("-Z", "Y").to_euler()
            rendered_name = f"{pose_name}{probe_suffix}" if probe_suffix else pose_name
            scene.render.filepath = str(OUT / f"{rendered_name}_{view_name}.jpg")
            bpy.ops.render.render(write_still=True)
            print("VIEWMODEL_CLOSEUP", scene.render.filepath)


if __name__ == "__main__":
    main()
