#!/usr/bin/env python3
"""Render the runtime viewmodel animation clips to playable MP4 files.

Run with Blender 4.3+:

    blender --background --factory-startup --python tools/render-first-person-viewmodel-clips.py

Each exported clip renders as one front video (looking along the authored
camera direction) and, for the most joint-informative clips, one side video.
Videos land in artifacts/first-person-viewmodel/clips/.
"""

from pathlib import Path

import bpy
from mathutils import Vector


ROOT = Path(__file__).resolve().parents[1]
ASSET = ROOT / "assets" / "player" / "runtime" / "Aletheia_Chrome_1p_arms_viewmodel.glb"
OUT = ROOT / "artifacts" / "first-person-viewmodel" / "clips"
CLIPS = (
    "Idle",
    "Walk",
    "Run",
    "Jump",
    "Land",
    "PushLeft",
    "PushRight",
    "ContactRecoil",
    "Climb",
)
SIDE_VIEW_CLIPS = {"Idle", "Climb", "PushRight"}
VIEW_OFFSETS = {
    "front": Vector((0.0, -2.6, 0.35)),
    "side": Vector((2.6, 0.0, 0.35)),
}


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
    for track in armature.animation_data.nla_tracks:
        track.mute = True

    scene = bpy.context.scene
    camera_data = bpy.data.cameras.new("ClipCamera")
    camera_data.type = "ORTHO"
    camera_data.ortho_scale = 1.35
    camera = bpy.data.objects.new("ClipCamera", camera_data)
    bpy.context.collection.objects.link(camera)
    scene.camera = camera

    # The hinge rings live in the authored PBR textures, so joint quality is
    # only judgeable with the real materials lit well enough to read chrome.
    scene.render.engine = "BLENDER_EEVEE_NEXT"
    scene.eevee.taa_render_samples = 24
    scene.world.use_nodes = True
    background = scene.world.node_tree.nodes.get("Background")
    background.inputs["Color"].default_value = (0.05, 0.06, 0.085, 1.0)
    background.inputs["Strength"].default_value = 0.55
    light_target = Vector((0.0, 0.82, 0.36))
    for name, location, energy, size in (
        ("Clip_Key", (0.0, 0.35, 1.55), 110.0, 1.35),
        ("Clip_Fill", (1.45, 0.95, 0.35), 85.0, 1.15),
        ("Clip_Rim", (-0.65, 1.45, 0.75), 95.0, 1.0),
        ("Clip_Under", (0.0, 1.1, -1.2), 60.0, 1.4),
    ):
        light_data = bpy.data.lights.new(name, type="AREA")
        light_data.energy = energy
        light_data.shape = "DISK"
        light_data.size = size
        light = bpy.data.objects.new(name, light_data)
        bpy.context.collection.objects.link(light)
        light.location = location
        light.rotation_euler = (
            light_target - light.location
        ).to_track_quat("-Z", "Y").to_euler()
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

    for clip_name in CLIPS:
        action = find_action(clip_name)
        armature.animation_data.action = action
        start = max(1, int(action.frame_range[0]))
        end = max(start, int(action.frame_range[1]))
        scene.frame_start = start
        scene.frame_end = end

        # Frame the shot on the averaged mid-hand position across the clip so
        # the camera stays still while the hands move.
        accumulated = Vector((0.0, 0.0, 0.0))
        samples = 0
        for frame in range(start, end + 1):
            scene.frame_set(frame)
            for side in ("left", "right"):
                hand = armature.pose.bones[f"{side}_hand"]
                accumulated += armature.matrix_world @ (
                    (hand.head + hand.tail) * 0.5
                )
                samples += 1
        target = accumulated / samples

        views = ("front", "side") if clip_name in SIDE_VIEW_CLIPS else ("front",)
        for view_name in views:
            camera.location = target + VIEW_OFFSETS[view_name]
            camera.rotation_euler = (
                target - camera.location
            ).to_track_quat("-Z", "Y").to_euler()
            scene.render.filepath = str(OUT / f"{clip_name}_{view_name}.mp4")
            bpy.ops.render.render(animation=True)
            print("VIEWMODEL_CLIP", scene.render.filepath, f"frames={start}-{end}")


if __name__ == "__main__":
    main()
