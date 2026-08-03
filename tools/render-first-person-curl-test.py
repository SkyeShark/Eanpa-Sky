#!/usr/bin/env python3
"""Render an expected-action finger test: a procedural open-fist-open sweep.

Run with Blender 4.3+:

    blender --background --factory-startup --python tools/render-first-person-curl-test.py

Every digit joint sweeps from the bind pose to a full mechanical fist and
back, rotating strictly about its authored flexion axis, so bends that miss
the modeled hinge seams are directly visible against the known action.
Videos land in artifacts/first-person-viewmodel/clips/.
"""

import math
from pathlib import Path

import bpy
from mathutils import Quaternion, Vector


ROOT = Path(__file__).resolve().parents[1]
ASSET = ROOT / "assets" / "player" / "runtime" / "Aletheia_Chrome_1p_arms_viewmodel.glb"
OUT = ROOT / "artifacts" / "first-person-viewmodel" / "clips"
DIGIT_SEGMENTS = {
    "thumb": ("metacarpal", "proximal", "distal"),
    "index": ("proximal", "intermediate", "distal"),
    "middle": ("proximal", "intermediate", "distal"),
    "ring": ("proximal", "intermediate", "distal"),
    "pinky": ("proximal", "intermediate", "distal"),
}
FIST_DEGREES = {
    "thumb": (25.0, 35.0, 45.0),
    "index": (60.0, 70.0, 40.0),
    "middle": (60.0, 70.0, 40.0),
    "ring": (60.0, 70.0, 40.0),
    "pinky": (60.0, 70.0, 40.0),
}
# frame: curl fraction; a hold at the fist makes the seam behavior readable
CURL_KEYS = ((1, 0.0), (30, 1.0), (48, 1.0), (78, 0.0))
VIEW_OFFSETS = (
    ("side", Vector((3.0, 0.0, 0.0))),
    ("back", Vector((0.0, 0.0, 3.0))),
    ("palm", Vector((0.0, 0.0, -3.0))),
)


def flexion_sign(armature, side):
    """Curl must move the index fingertip toward the palm (-Z)."""

    bone = armature.pose.bones[f"{side}_index_proximal"]
    tip = armature.pose.bones[f"{side}_index_distal"]
    baseline = (armature.matrix_world @ tip.tail).z
    bone.rotation_quaternion = Quaternion((1.0, 0.0, 0.0), math.radians(30.0))
    bpy.context.view_layer.update()
    curled = (armature.matrix_world @ tip.tail).z
    bone.rotation_quaternion = (1.0, 0.0, 0.0, 0.0)
    bpy.context.view_layer.update()
    return 1.0 if curled < baseline else -1.0


def main():
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    bpy.ops.import_scene.gltf(filepath=str(ASSET))
    armature = next(obj for obj in bpy.context.scene.objects if obj.type == "ARMATURE")
    for track in armature.animation_data.nla_tracks:
        track.mute = True
    armature.animation_data.action = None
    for bone in armature.pose.bones:
        bone.rotation_mode = "QUATERNION"
        bone.matrix_basis.identity()
    bpy.context.view_layer.update()

    signs = {side: flexion_sign(armature, side) for side in ("left", "right")}
    action = bpy.data.actions.new("CurlTest")
    armature.animation_data.action = action
    for frame, fraction in CURL_KEYS:
        for side in ("left", "right"):
            for digit, segments in DIGIT_SEGMENTS.items():
                for segment, full_degrees in zip(segments, FIST_DEGREES[digit]):
                    bone = armature.pose.bones[f"{side}_{digit}_{segment}"]
                    angle = math.radians(full_degrees * fraction * signs[side])
                    bone.rotation_quaternion = Quaternion(
                        (1.0, 0.0, 0.0), angle
                    )
                    bone.keyframe_insert("rotation_quaternion", frame=frame)

    scene = bpy.context.scene
    camera_data = bpy.data.cameras.new("CurlCamera")
    camera_data.type = "ORTHO"
    camera_data.ortho_scale = 0.72
    camera = bpy.data.objects.new("CurlCamera", camera_data)
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
    light_target = Vector((0.3, 0.82, 0.36))
    for name, location, energy, size in (
        ("Curl_Key", (0.0, 0.35, 1.55), 110.0, 1.35),
        ("Curl_Fill", (1.45, 0.95, 0.35), 85.0, 1.15),
        ("Curl_Rim", (-0.65, 1.45, 0.75), 95.0, 1.0),
        ("Curl_Under", (0.3, 1.1, -1.2), 60.0, 1.4),
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
    scene.render.resolution_y = 720
    scene.render.resolution_percentage = 100
    scene.render.fps = 24
    scene.render.image_settings.file_format = "FFMPEG"
    scene.render.ffmpeg.format = "MPEG4"
    scene.render.ffmpeg.codec = "H264"
    scene.render.ffmpeg.constant_rate_factor = "HIGH"
    scene.render.ffmpeg.gopsize = 12
    scene.frame_start = CURL_KEYS[0][0]
    scene.frame_end = CURL_KEYS[-1][0]
    OUT.mkdir(parents=True, exist_ok=True)

    scene.frame_set(1)
    hand = armature.pose.bones["right_hand"]
    target = armature.matrix_world @ ((hand.head + hand.tail) * 0.5)
    target += Vector((0.03, 0.09, 0.02))
    for view_name, offset in VIEW_OFFSETS:
        camera.location = target + offset
        camera.rotation_euler = (
            target - camera.location
        ).to_track_quat("-Z", "Y").to_euler()
        scene.render.filepath = str(OUT / f"CurlTest_{view_name}.mp4")
        bpy.ops.render.render(animation=True)
        print("CURL_TEST_CLIP", scene.render.filepath)


if __name__ == "__main__":
    main()
