#!/usr/bin/env python3
"""Render exact-camera probes for every articulated viewmodel state."""

from pathlib import Path
import json
import math
import os

import bpy
from mathutils import Euler, Quaternion


ROOT = Path(__file__).resolve().parents[1]
ASSET = ROOT / "assets" / "player" / "runtime" / "Aletheia_Chrome_1p_arms_viewmodel.glb"
MANIFEST = ROOT / "assets" / "player" / "runtime" / "first_person_viewmodel_manifest.json"
OUT_DIR = ROOT / "artifacts" / "first-person-viewmodel" / "poses"
SAMPLES = (
    ("Idle", 24, "idle"),
    ("Walk", 1, "walk_a"),
    ("Walk", 17, "walk_b"),
    ("Run", 1, "run_a"),
    ("Run", 13, "run_b"),
    ("Jump", 12, "jump_apex"),
    ("Land", 5, "land_impact"),
    ("PushLeft", 10, "push_left_contact"),
    ("PushRight", 10, "push_right_contact"),
    ("ContactRecoil", 9, "contact_recoil"),
    ("Climb", 10, "climb_reach"),
    ("Climb", 14, "climb_grip"),
    ("Climb", 20, "climb_pull"),
)


def find_action(name: str):
    return next(
        action for action in bpy.data.actions
        if action.name == name or action.name.startswith(name + "_")
    )


def main() -> None:
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    bpy.ops.import_scene.gltf(filepath=str(ASSET))

    root = bpy.data.objects.get("Aletheia_Chrome_Viewmodel_Rig")
    if root is None:
        raise AssertionError("imported Aletheia viewmodel root is missing")

    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    scale = float(manifest["integration"]["recommendedScale"])
    offset = list(manifest["integration"]["recommendedCameraLocalOffset"])
    probe_camera_y = os.environ.get("EANPA_PROBE_CAMERA_Y")
    if probe_camera_y is not None:
        offset[1] = float(probe_camera_y)
    offset = tuple(offset)
    probe_hand_rotation = (
        float(os.environ.get("EANPA_PROBE_HAND_X_DEGREES", "0")),
        float(os.environ.get("EANPA_PROBE_HAND_Y_DEGREES", "0")),
        float(os.environ.get("EANPA_PROBE_HAND_Z_DEGREES", "0")),
    )
    probe_suffix = os.environ.get("EANPA_PROBE_SUFFIX", "").strip()
    probe_sample_names = {
        name.strip()
        for name in os.environ.get("EANPA_PROBE_SAMPLE_NAMES", "").split(",")
        if name.strip()
    }
    probe_digit_deltas = json.loads(
        os.environ.get("EANPA_PROBE_DIGIT_DELTAS_JSON", "{}")
    )
    probe_mirror_digit_yz = (
        os.environ.get("EANPA_PROBE_MIRROR_DIGIT_YZ", "1") != "0"
    )
    # Three camera-local (X,Y,Z) maps to Blender (X,-Z,Y).
    root.rotation_euler = (0.0, 0.0, 0.0)
    root.scale = (scale, scale, scale)
    root.location = (offset[0], -offset[2], offset[1])

    armature = next(obj for obj in bpy.context.scene.objects if obj.type == "ARMATURE")
    if armature.animation_data is None:
        armature.animation_data_create()
    for track in armature.animation_data.nla_tracks:
        track.mute = True

    camera_data = bpy.data.cameras.new("viewmodel_probe_camera")
    camera = bpy.data.objects.new("viewmodel_probe_camera", camera_data)
    bpy.context.collection.objects.link(camera)
    camera.location = (0.0, 0.0, 0.0)
    camera.rotation_euler = (math.pi / 2.0, 0.0, 0.0)
    camera_data.type = "PERSP"
    camera_data.lens = 25.0 / (2.0 * math.tan(math.radians(52.0) / 2.0))
    camera_data.sensor_fit = "VERTICAL"
    camera_data.sensor_height = 25.0
    camera_data.clip_start = 0.18
    camera_data.clip_end = 60000.0
    bpy.context.scene.camera = camera

    scene = bpy.context.scene
    scene.render.engine = "BLENDER_WORKBENCH"
    scene.display.shading.light = "STUDIO"
    scene.display.shading.color_type = "MATERIAL"
    scene.display.shading.show_shadows = True
    scene.display.shading.show_cavity = True
    scene.display.shading.cavity_type = "WORLD"
    scene.display.shading.background_type = "WORLD"
    scene.display.shading.background_color = (0.04, 0.05, 0.07)
    scene.render.resolution_x = 800
    scene.render.resolution_y = 450
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "JPEG"
    scene.render.image_settings.quality = 86
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    outputs = []
    for action_name, requested_frame, filename in SAMPLES:
        if probe_sample_names and action_name not in probe_sample_names:
            continue
        frame_override = os.environ.get(
            f"EANPA_{action_name.upper().replace('.', '_')}_FRAME"
        )
        if frame_override is not None:
            requested_frame = int(frame_override)
        action = find_action(action_name)
        armature.animation_data.action = action
        start, end = action.frame_range
        frame = max(int(math.ceil(start)), min(int(math.floor(end)), requested_frame))
        scene.frame_set(frame)
        sampled_basis = {
            bone.name: bone.matrix_basis.copy()
            for bone in armature.pose.bones
        }
        armature.animation_data.action = None
        for bone in armature.pose.bones:
            bone.matrix_basis = sampled_basis[bone.name]
        if action_name == "Idle" and any(
            abs(value) > 1e-6 for value in probe_hand_rotation
        ):
            for side in ("left", "right"):
                side_sign = -1.0 if side == "left" else 1.0
                hand_delta = Euler(
                    (
                        math.radians(probe_hand_rotation[0]),
                        math.radians(probe_hand_rotation[1] * side_sign),
                        math.radians(probe_hand_rotation[2] * side_sign),
                    ),
                    "XYZ",
                ).to_quaternion()
                hand = armature.pose.bones[f"{side}_hand"]
                hand.matrix_basis = (
                    hand.matrix_basis @ hand_delta.to_matrix().to_4x4()
                )
            bpy.context.view_layer.update()
        if action_name == "Idle" and probe_digit_deltas:
            for side in ("left", "right"):
                for digit, segment_deltas in probe_digit_deltas.items():
                    for segment, delta_degrees in segment_deltas.items():
                        bone = armature.pose.bones[f"{side}_{digit}_{segment}"]
                        side_sign = -1.0 if side == "left" else 1.0
                        delta_values = tuple(float(value) for value in delta_degrees)
                        if probe_mirror_digit_yz:
                            delta_values = (
                                delta_values[0],
                                delta_values[1] * side_sign,
                                delta_values[2] * side_sign,
                            )
                        delta = Euler(
                            tuple(math.radians(value) for value in delta_values),
                            "XYZ",
                        ).to_quaternion()
                        bone.matrix_basis = (
                            bone.matrix_basis @ delta.to_matrix().to_4x4()
                        )
            bpy.context.view_layer.update()
        rendered_name = f"{filename}{probe_suffix}" if probe_suffix else filename
        scene.render.filepath = str(OUT_DIR / f"{rendered_name}.jpg")
        bpy.ops.render.render(write_still=True)
        outputs.append(scene.render.filepath)
    print(f"VIEWMODEL_POSE_PROBES {len(outputs)}")
    for path in outputs:
        print(Path(path).relative_to(ROOT))


if __name__ == "__main__":
    main()
