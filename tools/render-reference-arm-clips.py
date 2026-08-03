#!/usr/bin/env python3
"""Render the CC0 Drillimpact reference arms playing their own animations.

Run with Blender 4.3+:

    blender --background --factory-startup --python tools/render-reference-arm-clips.py

The reference deformation is the authored ground truth for how these hand
actions are expected to read; the videos pair with the retargeted Aletheia
clips for side-by-side comparison.
"""

from pathlib import Path

import bpy
from mathutils import Vector


ROOT = Path(__file__).resolve().parents[1]
ASSET = (
    ROOT
    / "assets"
    / "player"
    / "rig_reference"
    / "Drillimpact_PSX_First_Person_Arms_CC0.glb"
)
OUT = ROOT / "artifacts" / "first-person-viewmodel" / "clips"
CLIPS = (
    ("relax", "Reference_Relax"),
    ("push.R", "Reference_PushRight"),
)
VIEW_OFFSETS = (
    ("front", Vector((0.0, -2.6, 0.3))),
    ("side", Vector((2.6, 0.0, 0.3))),
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
    if armature.animation_data and armature.animation_data.nla_tracks:
        for track in armature.animation_data.nla_tracks:
            track.mute = True
    else:
        armature.animation_data_create()

    scene = bpy.context.scene
    camera_data = bpy.data.cameras.new("ReferenceCamera")
    camera_data.type = "ORTHO"
    camera = bpy.data.objects.new("ReferenceCamera", camera_data)
    bpy.context.collection.objects.link(camera)
    scene.camera = camera

    # Render with the asset's own materials so its authored hand detail reads.
    scene.render.engine = "BLENDER_EEVEE_NEXT"
    scene.eevee.taa_render_samples = 24
    scene.world.use_nodes = True
    background = scene.world.node_tree.nodes.get("Background")
    background.inputs["Color"].default_value = (0.05, 0.06, 0.085, 1.0)
    background.inputs["Strength"].default_value = 0.55
    lights = []
    for name, offset, energy, size in (
        ("Ref_Key", Vector((0.0, -1.2, 1.25)), 110.0, 1.35),
        ("Ref_Fill", Vector((1.45, -0.4, 0.1)), 85.0, 1.15),
        ("Ref_Rim", Vector((-0.65, 1.0, 0.45)), 95.0, 1.0),
    ):
        light_data = bpy.data.lights.new(name, type="AREA")
        light_data.energy = energy
        light_data.shape = "DISK"
        light_data.size = size
        light = bpy.data.objects.new(name, light_data)
        bpy.context.collection.objects.link(light)
        lights.append((light, offset))
    scene.view_settings.look = "AgX - Medium High Contrast"
    scene.view_settings.exposure = -0.4
    scene.render.resolution_x = 960
    scene.render.resolution_y = 640
    scene.render.resolution_percentage = 100
    scene.render.fps = 24
    scene.render.image_settings.file_format = "FFMPEG"
    scene.render.ffmpeg.format = "MPEG4"
    scene.render.ffmpeg.codec = "H264"
    scene.render.ffmpeg.constant_rate_factor = "HIGH"
    scene.render.ffmpeg.gopsize = 12
    OUT.mkdir(parents=True, exist_ok=True)

    for action_name, output_name in CLIPS:
        action = find_action(action_name)
        armature.animation_data.action = action
        start = max(1, int(action.frame_range[0]))
        end = max(start, int(action.frame_range[1]))
        scene.frame_start = start
        scene.frame_end = end

        # Frame on the averaged posed bounds of the whole reference so both
        # its hands stay in shot regardless of its own scale conventions.
        accumulated = Vector((0.0, 0.0, 0.0))
        samples = 0
        largest = 0.0
        for frame in range(start, end + 1, max(1, (end - start) // 12 or 1)):
            scene.frame_set(frame)
            for bone in armature.pose.bones:
                position = armature.matrix_world @ bone.head
                accumulated += position
                samples += 1
        target = accumulated / samples
        for frame in range(start, end + 1, max(1, (end - start) // 12 or 1)):
            scene.frame_set(frame)
            for bone in armature.pose.bones:
                position = armature.matrix_world @ bone.head
                largest = max(largest, (position - target).length)
        camera_data.ortho_scale = max(0.6, largest * 2.6)
        for light, light_offset in lights:
            light.location = target + light_offset
            light.rotation_euler = (
                target - light.location
            ).to_track_quat("-Z", "Y").to_euler()

        for view_name, offset in VIEW_OFFSETS:
            camera.location = target + offset
            camera.rotation_euler = (
                target - camera.location
            ).to_track_quat("-Z", "Y").to_euler()
            scene.render.filepath = str(OUT / f"{output_name}_{view_name}.mp4")
            bpy.ops.render.render(animation=True)
            print("REFERENCE_CLIP", scene.render.filepath, f"frames={start}-{end}")


if __name__ == "__main__":
    main()
