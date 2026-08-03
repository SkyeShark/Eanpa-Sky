#!/usr/bin/env python3
"""Build the articulated Aletheia Chrome first-person arms runtime asset.

Run with Blender 4.3+:

    blender --background --factory-startup --python tools/build-first-person-viewmodel.py

The authored Chrome source remains the runtime mesh, UVs, silhouette, and PBR
material. It has no skin or animation. This build places each digit pivot at the
source material's authored circumferential hinge-band center. A source-hash-locked
seam trace inserts three non-planar contours through every modeled hinge because
the original coarse triangles do not contain complete rings. Chrome panels stay
rigid; only the narrow traced gasket strips blend, with one identical weight
vector shared by every UV/normal duplicate coordinate.
The clean modeling pose stays the bind pose; every exported clip composes over a
lowered, palms-in, softly curled natural posture. Safe timing comes from
Drillimpact's CC0 PSX First Person Arms; weapon and attack actions are never
exported.

Blender imports the authored camera-forward direction as +Y; glTF/Three maps
that to camera -Z.  The runtime asset therefore needs no PI rotation.
"""

from __future__ import annotations

import hashlib
import json
import math
import struct
import sys
from pathlib import Path

import bpy
from mathutils import Euler, Matrix, Quaternion, Vector


ROOT = Path(__file__).resolve().parents[1]
TOOLS_DIR = Path(__file__).resolve().parent
if str(TOOLS_DIR) not in sys.path:
    sys.path.insert(0, str(TOOLS_DIR))

from first_person_hinge_projection import (  # noqa: E402
    derive_measured_digit_pivots,
)
from first_person_hinge_topology import (  # noqa: E402
    load_hinge_spec,
    subdivide_and_classify,
)


SOURCE = ROOT / "assets" / "player" / "Aletheia_Chrome_1p_arms.glb"
REFERENCE = (
    ROOT
    / "assets"
    / "player"
    / "rig_reference"
    / "Drillimpact_PSX_First_Person_Arms_CC0.glb"
)
RUNTIME_DIR = ROOT / "assets" / "player" / "runtime"
OUTPUT = RUNTIME_DIR / "Aletheia_Chrome_1p_arms_viewmodel.glb"
AUTHORING_BLEND = ROOT / "assets" / "player" / "Aletheia_Chrome_1p_arms_rigged.blend"
MANIFEST = RUNTIME_DIR / "first_person_viewmodel_manifest.json"
TOPOLOGY_RECORDS = (
    RUNTIME_DIR / "Aletheia_Chrome_1p_arms_viewmodel_topology.json"
)
SKIN_ZONES = ROOT / "assets" / "player" / "Aletheia_Chrome_1p_arms_skin_zones.json"
HINGE_SEAMS = (
    ROOT / "assets" / "player" / "Aletheia_Chrome_1p_arms_hinge_seams.json"
)

EXPECTED_SOURCE_SHA256 = (
    "c0b9c6cba54c316111d29878493a7a65ba94010a2756addd6f5a18a6c9fd5c1d"
)
POSITION_QUANTIZATION = 1_000_000
EXPECTED_SOURCE_RAW_VERTEX_COUNT = 37_963
EXPECTED_SOURCE_UNIQUE_POSITION_COUNT = 27_739
EXPECTED_SOURCE_TRIANGLE_COUNT = 55_446
HAND_REGION_MINIMUM_Y = 0.64
EXPECTED_HAND_REGION_RAW_VERTEX_COUNT = 5_354
EXPECTED_HAND_REGION_UNIQUE_POSITION_COUNT = 3_533
EXPECTED_HAND_REGION_SIDE_UNIQUE_COUNTS = {"left": 1_783, "right": 1_750}
SKIN_ZONE_SCHEMA_VERSION = 1
SKIN_ZONE_NAMES = ("H", "G0", "S0", "G1", "S1", "G2", "S2")

TEXTURE_TARGETS = {
    "normal": ("Aletheia_Chrome_Viewmodel_Normal_2K.png", 2048),
    "basecolor": ("Aletheia_Chrome_Viewmodel_BaseColor_4K.png", 4096),
    "metallicroughness": ("Aletheia_Chrome_Viewmodel_MetallicRoughness_2K.png", 2048),
}
DIGITS = ("thumb", "index", "middle", "ring", "pinky")
DIGIT_SEGMENTS = {
    "thumb": ("metacarpal", "proximal", "distal"),
    "index": ("proximal", "intermediate", "distal"),
    "middle": ("proximal", "intermediate", "distal"),
    "ring": ("proximal", "intermediate", "distal"),
    "pinky": ("proximal", "intermediate", "distal"),
}
CHAIN_PARTS = (
    "upper_arm",
    "forearm",
    "hand",
    *(
        f"{digit}_{segment}"
        for digit in DIGITS
        for segment in DIGIT_SEGMENTS[digit]
    ),
)
BONES = (
    "viewmodel_root",
    *(f"{side}_{part}" for side in ("left", "right") for part in CHAIN_PARTS),
)
SAFE_REFERENCE_ACTIONS = ("rest", "relax", "push.L", "push.R")
EXCLUDED_REFERENCE_PREFIXES = (
    "finger_gun_",
    "knife_",
    "jab.",
    "grab.",
    "guard_",
)
NATURAL_ROTATIONS: dict[str, Quaternion] = {}
REFERENCE_MOUNT_PITCH_DEGREES = 23.0
REFERENCE_ALIGNMENT = (
    Matrix.Rotation(math.radians(REFERENCE_MOUNT_PITCH_DEGREES), 3, "X")
    @ Matrix.Rotation(math.pi, 3, "Z")
)
REFERENCE_ARM_BONES = {
    "upper_arm": "upper_arm",
    "forearm": "forearm",
    "hand": "hand",
}
REFERENCE_DIGIT_BONES = {
    "thumb": ("thumb.01", "thumb.02", "thumb.03"),
    "index": ("f_index.01", "f_index.02", "f_index.03"),
    "middle": ("f_middle.01", "f_middle.02", "f_middle.03"),
    "ring": ("f_ring.01", "f_ring.02", "f_ring.03"),
    "pinky": ("f_pinky.01", "f_pinky.02", "f_pinky.03"),
}
SOURCE_CHAIN_POINTS = {
    "left": {
        "thumb": (
            (-0.239370, 0.720048, 0.270977),
            (-0.198109, 0.739028, 0.274273),
            (-0.157806, 0.763410, 0.278866),
            (-0.114318, 0.802511, 0.303328),
        ),
        "index": (
            (-0.246320, 0.804365, 0.365815),
            (-0.226963, 0.835009, 0.400575),
            (-0.207296, 0.880736, 0.444740),
            (-0.195972, 0.909288, 0.475632),
        ),
        "middle": (
            (-0.301930, 0.810046, 0.373610),
            (-0.300938, 0.845448, 0.425258),
            (-0.299811, 0.899050, 0.488550),
            (-0.303348, 0.922473, 0.525893),
        ),
        "ring": (
            (-0.362475, 0.813316, 0.359333),
            (-0.376161, 0.845585, 0.403327),
            (-0.387765, 0.892511, 0.458940),
            (-0.394064, 0.920459, 0.498012),
        ),
        "pinky": (
            (-0.415024, 0.814771, 0.330215),
            (-0.438473, 0.850177, 0.360600),
            (-0.464018, 0.898831, 0.395998),
            (-0.485759, 0.938066, 0.423845),
        ),
    },
    "right": {
        "thumb": (
            (0.240139, 0.726093, 0.285955),
            (0.197398, 0.739779, 0.285318),
            (0.152370, 0.766506, 0.281737),
            (0.114821, 0.801829, 0.303732),
        ),
        "index": (
            (0.245075, 0.803216, 0.366294),
            (0.224146, 0.836422, 0.402162),
            (0.206185, 0.880466, 0.442871),
            (0.193298, 0.907089, 0.474247),
        ),
        "middle": (
            (0.299497, 0.810046, 0.371383),
            (0.299140, 0.847445, 0.426859),
            (0.297970, 0.896142, 0.487214),
            (0.300540, 0.920426, 0.523142),
        ),
        "ring": (
            (0.363022, 0.812545, 0.358464),
            (0.375371, 0.845814, 0.403487),
            (0.386274, 0.893838, 0.458035),
            (0.391245, 0.920212, 0.505771),
        ),
        "pinky": (
            (0.412655, 0.814456, 0.330245),
            (0.435869, 0.849394, 0.360659),
            (0.460090, 0.899712, 0.398238),
            (0.484326, 0.931336, 0.427151),
        ),
    },
}

# The trace coordinate system above is immutable source evidence.  Bone pivots
# are a separate product of that evidence: derive_measured_digit_pivots places
# every digit joint at its measured hinge-ring center (axial station mean for
# all joints; in-plane circle-fit center only where the ring evidence is well
# covered and near-circular), while these chain points stay the trace frame.


def anatomical_points(sign: float) -> dict[str, tuple[float, float, float]]:
    """Landmarks measured from the unrigged Aletheia Chrome modeling pose.

    Blender imports the flat arm cuts around Y=-0.94, with the real palms and
    fingertips at Y=+0.57..+0.95. The modeling pose is deliberately open so
    these centers are unambiguous; it is not retained as the runtime rest.
    """

    return {
        "shoulder": (sign * 0.57, -0.94, -0.27),
        "elbow": (sign * 0.50, -0.23, -0.10),
        "wrist": (sign * 0.37, 0.60, 0.17),
        "palm": (sign * 0.30, 0.75, 0.30),
    }


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def smoothstep(edge0: float, edge1: float, value: float) -> float:
    t = max(0.0, min(1.0, (value - edge0) / max(edge1 - edge0, 1e-8)))
    return t * t * (3.0 - 2.0 * t)


def reset_scene() -> None:
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    for blocks in (
        bpy.data.actions,
        bpy.data.armatures,
        bpy.data.meshes,
        bpy.data.materials,
    ):
        for item in list(blocks):
            blocks.remove(item)


def imported_aletheia_mesh() -> bpy.types.Object:
    meshes = [obj for obj in bpy.context.scene.objects if obj.type == "MESH"]
    if len(meshes) != 1:
        raise RuntimeError(f"Expected one Aletheia source mesh, found {len(meshes)}")
    mesh = meshes[0]
    mesh.name = "Aletheia_Chrome_Viewmodel_Arms"
    mesh.data.name = "Aletheia_Chrome_Viewmodel_Arms_Geometry"
    return mesh


def texture_role(image: bpy.types.Image) -> str | None:
    token = image.name.lower().replace("_", "").replace(" ", "")
    if "basecolor" in token:
        return "basecolor"
    if "metallicroughness" in token:
        return "metallicroughness"
    if "normal" in token:
        return "normal"
    return None


def downsample_textures(mesh: bpy.types.Object) -> list[dict]:
    RUNTIME_DIR.mkdir(parents=True, exist_ok=True)
    records: list[dict] = []
    seen: set[int] = set()
    for material in mesh.data.materials:
        if not material or not material.use_nodes:
            continue
        for node in material.node_tree.nodes:
            image = getattr(node, "image", None)
            if image is None or image.as_pointer() in seen:
                continue
            seen.add(image.as_pointer())
            role = texture_role(image)
            if role is None:
                continue
            filename, target = TEXTURE_TARGETS[role]
            source_size = [int(image.size[0]), int(image.size[1])]
            if source_size[0] < target or source_size[1] < target:
                raise RuntimeError(
                    f"Refusing to upscale {image.name}: {source_size} -> {target}"
                )
            if tuple(source_size) != (target, target):
                image.scale(target, target)
            image.name = Path(filename).stem
            image.filepath_raw = str(RUNTIME_DIR / filename)
            image.file_format = "PNG"
            image.save()
            image.pack()
            if role != "basecolor":
                image.colorspace_settings.name = "Non-Color"
            records.append(
                {
                    "role": role,
                    "sourceSize": source_size,
                    "runtimeSize": [target, target],
                    "file": f"assets/player/runtime/{filename}",
                }
            )
    if {record["role"] for record in records} != set(TEXTURE_TARGETS):
        raise RuntimeError("Aletheia PBR texture roles are incomplete")
    return sorted(records, key=lambda record: record["role"])


def position_key(co: Vector) -> tuple[int, int, int]:
    """Stable source-local key shared by every UV/normal duplicate."""

    return tuple(
        int(round(float(component) * POSITION_QUANTIZATION))
        for component in co
    )


def load_skin_zones(mesh: bpy.types.Object) -> tuple[dict, dict, dict]:
    """Validate and load the source-locked mechanical hand skinning map."""

    source_digest = sha256(SOURCE)
    if source_digest != EXPECTED_SOURCE_SHA256:
        raise RuntimeError(
            "Aletheia source changed; refusing to apply an asset-specific skin map "
            f"({source_digest} != {EXPECTED_SOURCE_SHA256})"
        )
    if len(mesh.data.vertices) != EXPECTED_SOURCE_RAW_VERTEX_COUNT:
        raise RuntimeError(
            "Unexpected Aletheia source vertex count: "
            f"{len(mesh.data.vertices)} != {EXPECTED_SOURCE_RAW_VERTEX_COUNT}"
        )

    position_groups: dict[tuple[int, int, int], list[int]] = {}
    coordinates: dict[tuple[int, int, int], Vector] = {}
    for vertex in mesh.data.vertices:
        key = position_key(vertex.co)
        position_groups.setdefault(key, []).append(vertex.index)
        coordinates.setdefault(key, vertex.co.copy())
    if len(position_groups) != EXPECTED_SOURCE_UNIQUE_POSITION_COUNT:
        raise RuntimeError(
            "Unexpected Aletheia unique-position count: "
            f"{len(position_groups)} != {EXPECTED_SOURCE_UNIQUE_POSITION_COUNT}"
        )

    hand_keys = {
        key
        for key, coordinate in coordinates.items()
        if coordinate.y >= HAND_REGION_MINIMUM_Y
    }
    hand_raw_count = sum(len(position_groups[key]) for key in hand_keys)
    side_unique_counts = {
        "left": sum(key[0] < 0 for key in hand_keys),
        "right": sum(key[0] >= 0 for key in hand_keys),
    }
    if hand_raw_count != EXPECTED_HAND_REGION_RAW_VERTEX_COUNT:
        raise RuntimeError(
            "Unexpected hand-region raw vertex count: "
            f"{hand_raw_count} != {EXPECTED_HAND_REGION_RAW_VERTEX_COUNT}"
        )
    if len(hand_keys) != EXPECTED_HAND_REGION_UNIQUE_POSITION_COUNT:
        raise RuntimeError(
            "Unexpected hand-region unique-position count: "
            f"{len(hand_keys)} != {EXPECTED_HAND_REGION_UNIQUE_POSITION_COUNT}"
        )
    if side_unique_counts != EXPECTED_HAND_REGION_SIDE_UNIQUE_COUNTS:
        raise RuntimeError(
            "Unexpected per-side hand-region counts: "
            f"{side_unique_counts} != {EXPECTED_HAND_REGION_SIDE_UNIQUE_COUNTS}"
        )

    document = json.loads(SKIN_ZONES.read_text(encoding="utf-8"))
    if document.get("schemaVersion") != SKIN_ZONE_SCHEMA_VERSION:
        raise RuntimeError("Unsupported Aletheia skin-zone schema")
    if document.get("quantization") != POSITION_QUANTIZATION:
        raise RuntimeError("Aletheia skin-zone quantization does not match the builder")

    source_metadata = document.get("source")
    expected_source_metadata = {
        "file": "assets/player/Aletheia_Chrome_1p_arms.glb",
        "sha256": EXPECTED_SOURCE_SHA256,
        "rawVertexCount": EXPECTED_SOURCE_RAW_VERTEX_COUNT,
        "uniquePositionCount": EXPECTED_SOURCE_UNIQUE_POSITION_COUNT,
    }
    if source_metadata != expected_source_metadata:
        raise RuntimeError("Aletheia skin-zone source metadata is stale or malformed")

    hand_metadata = document.get("handRegion")
    expected_hand_metadata = {
        "minimumY": HAND_REGION_MINIMUM_Y,
        "rawVertexCount": EXPECTED_HAND_REGION_RAW_VERTEX_COUNT,
        "uniquePositionCount": EXPECTED_HAND_REGION_UNIQUE_POSITION_COUNT,
        "leftUniquePositionCount": EXPECTED_HAND_REGION_SIDE_UNIQUE_COUNTS["left"],
        "rightUniquePositionCount": EXPECTED_HAND_REGION_SIDE_UNIQUE_COUNTS["right"],
    }
    if hand_metadata != expected_hand_metadata:
        raise RuntimeError("Aletheia skin-zone hand-region metadata is stale or malformed")

    expected_joint_points = json.loads(json.dumps(SOURCE_CHAIN_POINTS))
    if document.get("jointPoints") != expected_joint_points:
        raise RuntimeError(
            "Aletheia skin-zone joint points do not match the immutable source trace frame"
        )

    records = document.get("records")
    if not isinstance(records, list):
        raise RuntimeError("Aletheia skin-zone records must be a list")
    zone_records: dict[tuple[int, int, int], dict] = {}
    record_keys: list[tuple[int, int, int]] = []
    zone_counts: dict[str, int] = {}
    required_fields = {"key", "side", "digit", "zone", "blend"}
    allowed_fields = required_fields | {"evidence"}
    for record_index, record in enumerate(records):
        if not isinstance(record, dict):
            raise RuntimeError(f"Skin-zone record {record_index} is not an object")
        if not required_fields.issubset(record) or not set(record).issubset(allowed_fields):
            raise RuntimeError(f"Skin-zone record {record_index} has invalid fields")
        raw_key = record["key"]
        if (
            not isinstance(raw_key, list)
            or len(raw_key) != 3
            or any(type(component) is not int for component in raw_key)
        ):
            raise RuntimeError(f"Skin-zone record {record_index} has an invalid key")
        key = tuple(raw_key)
        if key in zone_records:
            raise RuntimeError(f"Duplicate skin-zone key {key}")
        if key not in hand_keys:
            raise RuntimeError(f"Skin-zone key {key} is outside the exact hand region")

        side = record["side"]
        expected_side = "left" if key[0] < 0 else "right"
        if side != expected_side:
            raise RuntimeError(
                f"Skin-zone key {key} declares side {side!r}, expected {expected_side!r}"
            )
        digit = record["digit"]
        zone = record["zone"]
        blend = record["blend"]
        if zone not in SKIN_ZONE_NAMES:
            raise RuntimeError(f"Skin-zone key {key} has invalid zone {zone!r}")
        if zone == "H":
            if digit is not None or blend is not None:
                raise RuntimeError(f"Hand-zone key {key} must have null digit/blend")
        else:
            if digit not in DIGITS:
                raise RuntimeError(f"Digit-zone key {key} has invalid digit {digit!r}")
            if zone.startswith("G"):
                if (
                    isinstance(blend, bool)
                    or not isinstance(blend, (int, float))
                    or not math.isfinite(float(blend))
                    or not 0.0 <= float(blend) <= 1.0
                ):
                    raise RuntimeError(f"Gasket-zone key {key} has invalid blend")
            elif blend is not None:
                raise RuntimeError(f"Rigid-zone key {key} must have a null blend")
        if "evidence" in record and not isinstance(record["evidence"], dict):
            raise RuntimeError(f"Skin-zone key {key} has invalid evidence metadata")

        zone_records[key] = record
        record_keys.append(key)
        count_name = f"{side}/{digit or 'hand'}/{zone}"
        zone_counts[count_name] = zone_counts.get(count_name, 0) + 1

    if record_keys != sorted(record_keys):
        raise RuntimeError("Aletheia skin-zone records are not sorted by integer key")
    if set(record_keys) != hand_keys:
        missing = len(hand_keys - set(record_keys))
        extra = len(set(record_keys) - hand_keys)
        raise RuntimeError(
            f"Aletheia skin-zone coverage is not exact ({missing} missing, {extra} extra)"
        )

    provenance = {
        "file": "assets/player/Aletheia_Chrome_1p_arms_skin_zones.json",
        "sha256": sha256(SKIN_ZONES),
        "schemaVersion": SKIN_ZONE_SCHEMA_VERSION,
        "sourceSha256": source_digest,
        "quantization": POSITION_QUANTIZATION,
        "handRegion": expected_hand_metadata,
        "recordCount": len(record_keys),
        "zoneCounts": dict(sorted(zone_counts.items())),
        "assignment": "exact source-local coordinate keys; one weight vector shared by every UV/normal duplicate",
    }
    return position_groups, zone_records, provenance


def create_rig(
    mesh: bpy.types.Object,
    position_groups: dict[tuple[int, int, int], list[int]],
    zone_records: dict[tuple[int, int, int], dict],
    digit_pivots: dict[str, dict[str, list[list[float]]]],
) -> tuple[bpy.types.Object, dict[str, dict]]:
    data = bpy.data.armatures.new("Aletheia_Chrome_Viewmodel_Rig")
    armature = bpy.data.objects.new("Aletheia_Chrome_Viewmodel_Rig", data)
    bpy.context.collection.objects.link(armature)
    armature.show_in_front = True
    bpy.context.view_layer.objects.active = armature
    armature.select_set(True)
    bpy.ops.object.mode_set(mode="EDIT")

    def add_bone(
        name,
        head,
        tail,
        parent=None,
        connected=False,
        deform=True,
        flexion_axis=None,
    ):
        bone = data.edit_bones.new(name)
        bone.head = head
        bone.tail = tail
        bone.parent = parent
        bone.use_connect = connected
        bone.use_deform = deform
        direction = Vector(tail) - Vector(head)
        desired_x = (
            Vector(flexion_axis)
            if flexion_axis is not None
            else Vector((1.0, 0.0, 0.0))
        )
        desired_x = desired_x - direction.normalized() * desired_x.dot(direction.normalized())
        if desired_x.length < 1e-6:
            desired_x = Vector((1.0, 0.0, 0.0))
        if abs(direction.normalized().dot(desired_x)) > 0.92:
            desired_x = Vector((0.0, 0.0, 1.0))
        desired_x.normalize()
        desired_z = desired_x.cross(direction).normalized()
        bone.align_roll(desired_z)
        return bone

    root = add_bone(
        "viewmodel_root",
        (0.0, -0.94, -0.30),
        (0.0, -0.69, -0.23),
        deform=True,
    )
    for side, sign in (("left", -1.0), ("right", 1.0)):
        points = anatomical_points(sign)
        upper = add_bone(f"{side}_upper_arm", points["shoulder"], points["elbow"], root)
        forearm = add_bone(
            f"{side}_forearm", points["elbow"], points["wrist"], upper, True
        )
        hand = add_bone(f"{side}_hand", points["wrist"], points["palm"], forearm, True)
        for digit in DIGITS:
            joints = digit_pivots[side][digit]
            first_direction = Vector(joints[1]) - Vector(joints[0])
            chain_flexion_axis = first_direction.cross(Vector((0.0, 0.0, 1.0)))
            if chain_flexion_axis.length < 1e-6:
                chain_flexion_axis = Vector((1.0, 0.0, 0.0))
            chain_flexion_axis.normalize()
            parent = hand
            for index, segment in enumerate(DIGIT_SEGMENTS[digit]):
                parent = add_bone(
                    f"{side}_{digit}_{segment}",
                    joints[index],
                    joints[index + 1],
                    parent,
                    index > 0,
                    flexion_axis=chain_flexion_axis,
                )
    bpy.ops.object.mode_set(mode="OBJECT")

    for old_group in list(mesh.vertex_groups):
        mesh.vertex_groups.remove(old_group)
    groups = {name: mesh.vertex_groups.new(name=name) for name in BONES}
    weight_stats = {
        name: {"verticesAboveOnePercent": 0, "totalWeight": 0.0} for name in BONES
    }

    def cleaned_weights(
        co: Vector,
        side: str,
        zone_record: dict | None,
    ) -> dict[str, float]:
        upper_name = f"{side}_upper_arm"
        forearm_name = f"{side}_forearm"
        hand_name = f"{side}_hand"

        # Rigid shaft interiors with a 12 cm elbow hinge band. The former
        # 44 cm blend was the main rubber-hose failure.
        if co.y < 0.50:
            elbow = smoothstep(-0.30, -0.18, co.y)
            return {upper_name: 1.0 - elbow, forearm_name: elbow}

        # Keep the overlapping wrist shells coherent across a localized 10 cm
        # transition, then make the palm rigid to the hand.
        if co.y < HAND_REGION_MINIMUM_Y:
            wrist = smoothstep(0.52, 0.62, co.y)
            return {forearm_name: 1.0 - wrist, hand_name: wrist}

        if zone_record is None:
            raise RuntimeError(
                f"Hand-region position {position_key(co)} has no skin-zone record"
            )
        zone = zone_record["zone"]
        if zone == "H":
            return {hand_name: 1.0}
        digit = zone_record["digit"]
        segment_names = DIGIT_SEGMENTS[digit]
        zone_index = int(zone[1])
        distal_name = f"{side}_{digit}_{segment_names[zone_index]}"
        if zone.startswith("S"):
            return {distal_name: 1.0}
        proximal_name = (
            hand_name
            if zone_index == 0
            else f"{side}_{digit}_{segment_names[zone_index - 1]}"
        )
        blend = smoothstep(0.0, 1.0, float(zone_record["blend"]))
        return {proximal_name: 1.0 - blend, distal_name: blend}

    for key, vertex_indices in position_groups.items():
        co = mesh.data.vertices[vertex_indices[0]].co
        if co.y >= HAND_REGION_MINIMUM_Y:
            zone_record = zone_records.get(key)
            if zone_record is None:
                raise RuntimeError(
                    f"Hand-region position {key} has no exact topology record"
                )
            side = zone_record.get("side")
            if side not in {"left", "right"}:
                raise RuntimeError(
                    f"Hand-region position {key} has invalid topology side {side}"
                )
        else:
            zone_record = None
            side = "left" if co.x < 0.0 else "right"
        weights = cleaned_weights(co, side, zone_record)
        if len(weights) > 2:
            raise RuntimeError(
                f"Position {key} has more than two mechanical skin influences"
            )
        if any(
            not math.isfinite(value) or value < 0.0
            for value in weights.values()
        ):
            raise RuntimeError(f"Position {key} received an invalid skin weight")
        positive = sorted(
            ((name, value) for name, value in weights.items() if value > 1e-12),
            key=lambda item: item[1],
            reverse=True,
        )
        total = sum(value for _name, value in positive)
        if total <= 1e-8:
            raise RuntimeError(f"Position {key} received no skin weight")
        for name, value in positive:
            value /= total
            groups[name].add(vertex_indices, value, "REPLACE")
            weight_stats[name]["totalWeight"] += value * len(vertex_indices)
            if value >= 0.01:
                weight_stats[name]["verticesAboveOnePercent"] += len(vertex_indices)

    for side in ("left", "right"):
        for part in ("upper_arm", "forearm", "hand"):
            name = f"{side}_{part}"
            if weight_stats[name]["verticesAboveOnePercent"] < 500:
                raise RuntimeError(f"Anatomical group {name} has too little coverage")
        digit_coverage = sum(
            weight_stats[f"{side}_{digit}_{segment}"]["verticesAboveOnePercent"]
            for digit in DIGITS
            for segment in DIGIT_SEGMENTS[digit]
        )
        if digit_coverage < 180:
            raise RuntimeError(f"{side} digit rig has too little topology coverage")

    modifier = mesh.modifiers.new("Aletheia_Chrome_Viewmodel_Skin", "ARMATURE")
    modifier.object = armature
    # glTF/Three.js evaluates linear blend skinning, so author and audit under
    # the same deformation model instead of Blender's dual-quaternion preview.
    modifier.use_deform_preserve_volume = False
    mesh.parent = armature
    mesh.matrix_parent_inverse = armature.matrix_world.inverted()
    for polygon in mesh.data.polygons:
        polygon.use_smooth = True
    for material in mesh.data.materials:
        if material:
            material.name = "Aletheia_Chrome_Viewmodel_PBR"
            material.use_nodes = True
    return armature, weight_stats


def load_motion_reference() -> bpy.types.Object:
    if not REFERENCE.exists():
        raise FileNotFoundError(REFERENCE)
    before = set(bpy.context.scene.objects)
    bpy.ops.import_scene.gltf(filepath=str(REFERENCE))
    imported = [obj for obj in bpy.context.scene.objects if obj not in before]
    armatures = [obj for obj in imported if obj.type == "ARMATURE"]
    if len(armatures) != 1 or len(armatures[0].data.bones) != 52:
        raise RuntimeError("Unexpected Drillimpact CC0 reference hierarchy")
    for obj in imported:
        obj.hide_render = True
        obj.hide_viewport = False
    available = {action.name.split("_ArmsRig", 1)[0] for action in bpy.data.actions}
    missing = set(SAFE_REFERENCE_ACTIONS) - available
    if missing:
        raise RuntimeError(f"CC0 reference missing safe actions: {sorted(missing)}")
    return armatures[0]


def reference_action(name: str) -> bpy.types.Action:
    exact = f"{name}_ArmsRig"
    action = next((item for item in bpy.data.actions if item.name == exact), None)
    if action is None:
        raise RuntimeError(f"Missing CC0 reference action {exact}")
    return action


def reference_profile(
    armature: bpy.types.Object,
    action_name: str,
    control_bones: tuple[str, ...],
) -> list[float]:
    """Extract the source action's baked end-effector timing as 0..1 motion."""

    action = reference_action(action_name)
    if armature.animation_data is None:
        armature.animation_data_create()
    for track in armature.animation_data.nla_tracks:
        track.mute = True
    armature.animation_data.action = action
    start = max(1, int(math.ceil(action.frame_range[0])))
    end = int(math.ceil(action.frame_range[1]))
    samples: list[tuple[Vector, ...]] = []
    depsgraph = bpy.context.evaluated_depsgraph_get()
    for frame in range(start, end + 1):
        bpy.context.scene.frame_set(frame)
        depsgraph.update()
        samples.append(
            tuple(armature.pose.bones[name].matrix.translation.copy() for name in control_bones)
        )
    baseline = samples[0]
    magnitudes = [
        math.sqrt(
            sum((sample[index] - baseline[index]).length_squared for index in range(len(sample)))
        )
        for sample in samples
    ]
    maximum = max(magnitudes)
    if maximum <= 1e-6:
        raise RuntimeError(f"Reference action {action_name} has no end-effector motion")
    profile = [value / maximum for value in magnitudes]
    if action_name == "relax":
        # The source relax clip is intended to loop.  Preserve its internal
        # timing while pinning the final sample to the first for a clean wrap.
        profile[-1] = profile[0]
    return profile


def degrees(values: tuple[float, float, float]) -> tuple[float, float, float]:
    return tuple(math.radians(value) for value in values)


def reset_pose(armature: bpy.types.Object) -> None:
    for bone in armature.pose.bones:
        bone.rotation_mode = "QUATERNION"
        bone.location = (0.0, 0.0, 0.0)
        bone.rotation_quaternion = (1.0, 0.0, 0.0, 0.0)
        bone.scale = (1.0, 1.0, 1.0)


def point_bone(
    bone: bpy.types.PoseBone,
    head: Vector,
    direction: Vector,
    *,
    twist_degrees: float = 0.0,
) -> Vector:
    """Place a pose bone in armature space while preserving its authored roll."""

    target_direction = direction.normalized()
    rest_direction = (
        Vector(bone.bone.tail_local) - Vector(bone.bone.head_local)
    ).normalized()
    swing = rest_direction.rotation_difference(target_direction)
    rotation = swing.to_matrix() @ bone.bone.matrix_local.to_3x3()
    if abs(twist_degrees) > 1e-6:
        twist = Quaternion(target_direction, math.radians(twist_degrees))
        rotation = twist.to_matrix() @ rotation
    matrix = rotation.to_4x4()
    matrix.translation = head
    bone.matrix = matrix
    bpy.context.view_layer.update()
    return head + target_direction * bone.length


def sample_reference_pose(
    reference: bpy.types.Object,
    action_name: str,
    frame: int,
) -> None:
    """Evaluate one baked frame from the supplied CC0 arm rig."""

    action = reference_action(action_name)
    reference.animation_data_create()
    for track in reference.animation_data.nla_tracks:
        track.mute = True
    reference.animation_data.action = action
    start = max(1, int(math.ceil(action.frame_range[0])))
    end = int(math.ceil(action.frame_range[1]))
    bpy.context.scene.frame_set(max(start, min(end, int(frame))))
    bpy.context.view_layer.update()


def aligned_reference_direction(
    reference: bpy.types.Object,
    bone_name: str,
) -> Vector:
    bone = reference.pose.bones[bone_name]
    direction = Vector(bone.tail) - Vector(bone.head)
    if direction.length <= 1e-7:
        raise RuntimeError(f"Reference bone {bone_name} has zero posed length")
    return (REFERENCE_ALIGNMENT @ direction).normalized()


def anatomical_frame(width: Vector, forward: Vector) -> Matrix:
    """Build a right-handed frame from palm-width X and longitudinal Y."""

    y_axis = Vector(forward).normalized()
    x_axis = Vector(width) - y_axis * Vector(width).dot(y_axis)
    if x_axis.length <= 1e-7:
        raise RuntimeError("Palm-width axis collapsed into the hand direction")
    x_axis.normalize()
    z_axis = x_axis.cross(y_axis).normalized()
    x_axis = y_axis.cross(z_axis).normalized()
    frame = Matrix.Identity(3)
    frame.col[0] = x_axis
    frame.col[1] = y_axis
    frame.col[2] = z_axis
    return frame


def point_hand_from_reference(
    armature: bpy.types.Object,
    reference: bpy.types.Object,
    side: str,
    suffix: str,
    wrist: Vector,
) -> Vector:
    """Match reference hand direction and palm plane across different rolls."""

    hand = armature.pose.bones[f"{side}_hand"]
    desired_forward = aligned_reference_direction(reference, f"hand.{suffix}")
    source_index = Vector(reference.pose.bones[f"palm.01.{suffix}"].head)
    source_pinky = Vector(reference.pose.bones[f"palm.04.{suffix}"].head)
    desired_width = REFERENCE_ALIGNMENT @ (source_pinky - source_index)

    target_index = armature.pose.bones[f"{side}_index_proximal"].bone.head_local
    target_pinky = armature.pose.bones[f"{side}_pinky_proximal"].bone.head_local
    target_width = Vector(target_pinky) - Vector(target_index)
    hand_rest = hand.bone.matrix_local.to_3x3()
    local_width = hand_rest.inverted() @ target_width
    local_frame = anatomical_frame(local_width, Vector((0.0, 1.0, 0.0)))
    desired_frame = anatomical_frame(desired_width, desired_forward)

    matrix = (desired_frame @ local_frame.inverted()).to_4x4()
    matrix.translation = wrist
    hand.matrix = matrix
    bpy.context.view_layer.update()
    return wrist + desired_forward * hand.length


def solve_reference_pose(
    armature: bpy.types.Object,
    reference: bpy.types.Object,
) -> None:
    """Solve the evaluated donor pose onto Aletheia's own joints and lengths."""

    reset_pose(armature)
    for side, sign, suffix in (
        ("left", -1.0, "L"),
        ("right", 1.0, "R"),
    ):
        shoulder = Vector(anatomical_points(sign)["shoulder"])
        elbow = point_bone(
            armature.pose.bones[f"{side}_upper_arm"],
            shoulder,
            aligned_reference_direction(reference, f"upper_arm.{suffix}"),
        )
        wrist = point_bone(
            armature.pose.bones[f"{side}_forearm"],
            elbow,
            aligned_reference_direction(reference, f"forearm.{suffix}"),
        )
        point_hand_from_reference(armature, reference, side, suffix, wrist)

        for digit in DIGITS:
            target_segments = DIGIT_SEGMENTS[digit]
            source_segments = REFERENCE_DIGIT_BONES[digit]
            first = armature.pose.bones[f"{side}_{digit}_{target_segments[0]}"]
            head = Vector(first.head)
            for target_segment, source_segment in zip(
                target_segments,
                source_segments,
            ):
                target_name = f"{side}_{digit}_{target_segment}"
                desired = aligned_reference_direction(
                    reference,
                    f"{source_segment}.{suffix}",
                )
                head = point_bone(
                    armature.pose.bones[target_name],
                    head,
                    desired,
                )
                actual_bone = armature.pose.bones[target_name]
                actual = (Vector(actual_bone.tail) - Vector(actual_bone.head)).normalized()
                error = math.degrees(actual.angle(desired))
                if error > 0.5:
                    raise RuntimeError(
                        f"Reference retarget direction drifted on {target_name}: "
                        f"{error:.4f} degrees"
                    )

        target_width = (
            Vector(armature.pose.bones[f"{side}_pinky_proximal"].head)
            - Vector(armature.pose.bones[f"{side}_index_proximal"].head)
        )
        desired_forward = aligned_reference_direction(reference, f"hand.{suffix}")
        target_width -= desired_forward * target_width.dot(desired_forward)
        source_width = REFERENCE_ALIGNMENT @ (
            Vector(reference.pose.bones[f"palm.04.{suffix}"].head)
            - Vector(reference.pose.bones[f"palm.01.{suffix}"].head)
        )
        source_width -= desired_forward * source_width.dot(desired_forward)
        width_error = math.degrees(target_width.angle(source_width))
        if width_error > 1.0:
            raise RuntimeError(
                f"Reference palm-plane retarget drifted on {side}: "
                f"{width_error:.4f} degrees"
            )
    bpy.context.view_layer.update()


def reference_pose(
    armature: bpy.types.Object,
    reference: bpy.types.Object,
    action_name: str,
    frame: int,
) -> dict:
    sample_reference_pose(reference, action_name, frame)
    solve_reference_pose(armature, reference)
    pose = {}
    for bone_name in BONES:
        rotation = armature.pose.bones[bone_name].matrix_basis.to_quaternion()
        rotation.normalize()
        pose[bone_name] = {"rotation": tuple(rotation)}
    pose["viewmodel_root"]["location"] = (0.0, 0.0, 0.0)
    reset_pose(armature)
    bpy.context.view_layer.update()
    return pose


def capture_natural_pose(
    armature: bpy.types.Object,
    reference: bpy.types.Object,
) -> None:
    """Use the supplied Relax pose, not its open modeling Rest pose."""

    action = reference_action("relax")
    frame = max(1, int(math.ceil(action.frame_range[0])))
    pose = reference_pose(armature, reference, "relax", frame)
    NATURAL_ROTATIONS.clear()
    for bone_name in BONES:
        rotation = Quaternion(pose[bone_name]["rotation"])
        rotation.normalize()
        NATURAL_ROTATIONS[bone_name] = rotation
    missing = set(BONES) - set(NATURAL_ROTATIONS)
    if missing:
        raise RuntimeError(f"Natural pose is missing bones: {sorted(missing)}")


def composed_rotation(
    bone_name: str,
    delta_degrees: tuple[float, float, float],
) -> tuple[float, float, float, float]:
    base = NATURAL_ROTATIONS.get(bone_name, Quaternion((1.0, 0.0, 0.0, 0.0)))
    delta = Euler(degrees(delta_degrees), "XYZ").to_quaternion()
    rotation = base @ delta
    rotation.normalize()
    return tuple(rotation)


def side_pose(
    side: str,
    *,
    upper=(0.0, 0.0, 0.0),
    forearm=(0.0, 0.0, 0.0),
    hand=(0.0, 0.0, 0.0),
    curl: float = 0.0,
    spread: float = 0.0,
) -> dict:
    sign = -1.0 if side == "left" else 1.0
    upper = (upper[0], upper[1] * 0.55, upper[2] * 0.55)
    forearm = (forearm[0], forearm[1] * 0.40, forearm[2] * 0.40)
    hand = (hand[0] * 0.25, hand[1] * 0.35, hand[2] * 0.35)
    pose = {
        f"{side}_upper_arm": {
            "rotation": composed_rotation(f"{side}_upper_arm", upper)
        },
        f"{side}_forearm": {
            "rotation": composed_rotation(f"{side}_forearm", forearm)
        },
        f"{side}_hand": {
            "rotation": composed_rotation(f"{side}_hand", hand)
        },
    }
    curl = max(-28.0, min(48.0, curl))
    spread = max(-4.0, min(4.0, spread))
    curl_scale = {"thumb": 0.85, "index": 0.88, "middle": 1.0, "ring": 1.08, "pinky": 1.15}
    spread_scale = {"thumb": -1.0, "index": -0.45, "middle": -0.12, "ring": 0.32, "pinky": 0.74}
    segment_scale = {
        "metacarpal": 0.70,
        "proximal": 0.72,
        "intermediate": 0.90,
        "distal": 0.55,
    }
    thumb_segment_scale = {
        "metacarpal": 0.70,
        "proximal": 0.50,
        "distal": 0.25,
    }
    for digit in DIGITS:
        for index, segment in enumerate(DIGIT_SEGMENTS[digit]):
            hinge_sign = 1.0 if digit == "thumb" else -1.0
            scale = (
                thumb_segment_scale[segment]
                if digit == "thumb"
                else segment_scale[segment]
            )
            digit_curl = max(-18.0, min(18.0, curl)) if digit == "thumb" else curl
            bend = hinge_sign * digit_curl * curl_scale[digit] * scale
            lateral = -spread * spread_scale[digit] * sign
            name = f"{side}_{digit}_{segment}"
            delta = (bend, 0.0, lateral if index == 0 else 0.0)
            pose[name] = {"rotation": composed_rotation(name, delta)}
    return pose


def merge_pose(*parts: dict) -> dict:
    merged = {}
    for part in parts:
        merged.update(part)
    return merged


def root_pose(location=(0.0, 0.0, 0.0), rotation=(0.0, 0.0, 0.0)) -> dict:
    return {
        "viewmodel_root": {
            "location": location,
            "rotation": composed_rotation("viewmodel_root", rotation),
        }
    }


def natural_basis_pose() -> dict:
    pose = {
        bone_name: {"rotation": tuple(NATURAL_ROTATIONS[bone_name])}
        for bone_name in BONES
    }
    pose["viewmodel_root"]["location"] = (0.0, 0.0, 0.0)
    return pose


def blend_reference_side_pose(
    absolute_pose: dict,
    side: str,
    amount: float,
) -> dict:
    """Blend one supplied action side over Relax without moving the root."""

    amount = max(0.0, min(1.0, float(amount)))
    pose = natural_basis_pose()
    prefix = f"{side}_"
    for bone_name in BONES:
        if not bone_name.startswith(prefix):
            continue
        base = NATURAL_ROTATIONS[bone_name]
        target = Quaternion(absolute_pose[bone_name]["rotation"])
        rotation = base.slerp(target, amount)
        rotation.normalize()
        pose[bone_name] = {"rotation": tuple(rotation)}
    return pose


def neutral_pose(breath: float = 0.0) -> dict:
    return merge_pose(
        root_pose((0.0, -0.002 * breath, 0.006 * breath), (0.45 * breath, 0.0, 0.0)),
        side_pose(
            "left", upper=(0.8 + breath * 0.45, -1.1, 0.6),
            forearm=(1.2 + breath * 0.35, 0.3, -0.5),
            hand=(-1.2 + breath * 0.3, -0.8, 0.4),
            curl=1.5 + breath * 1.8,
        ),
        side_pose(
            "right", upper=(0.2 + breath * 0.55, 0.7, -0.4),
            forearm=(0.7 + breath * 0.45, -0.2, 0.35),
            hand=(-0.6 + breath * 0.35, 0.45, -0.25),
            curl=0.7 + breath * 2.1,
        ),
    )


def walk_pose(phase: float) -> dict:
    return merge_pose(
        root_pose((phase * 0.006, 0.0, 0.016), (0.0, phase * 0.4, phase * 0.6)),
        side_pose(
            "left", upper=(-4.5 * phase, 0.9 * phase, 1.8 * phase),
            forearm=(6.0 * phase, -0.9 * phase, -1.0 * phase),
            hand=(-6.5 * phase, 0.9 * phase, 0.7 * phase),
            curl=3.2 + 1.8 * phase, spread=0.8,
        ),
        side_pose(
            "right", upper=(4.5 * phase, -0.9 * phase, -1.8 * phase),
            forearm=(-6.0 * phase, 0.9 * phase, 1.0 * phase),
            hand=(6.5 * phase, -0.9 * phase, -0.7 * phase),
            curl=2.4 - 1.6 * phase, spread=0.8,
        ),
    )


def run_pose(phase: float) -> dict:
    return merge_pose(
        root_pose((phase * 0.008, -0.006, 0.014), (2.0, phase * 0.8, phase * 1.2)),
        side_pose(
            "left", upper=(-8.0 * phase, 1.4 * phase, -16.0 + 2.0 * phase),
            forearm=(12.0 * phase, -1.4 * phase, -1.8 * phase),
            hand=(-9.0 * phase, 1.4 * phase, 1.2 * phase),
            curl=8.0 + 3.0 * phase,
        ),
        side_pose(
            "right", upper=(8.0 * phase, -1.4 * phase, 16.0 - 2.0 * phase),
            forearm=(-12.0 * phase, 1.4 * phase, 1.8 * phase),
            hand=(9.0 * phase, -1.4 * phase, -1.2 * phase),
            curl=7.0 - 3.0 * phase,
        ),
    )


def push_pose(side: str, amount: float, recoil: float = 0.0) -> dict:
    sign = -1.0 if side == "left" else 1.0
    pose = neutral_pose(0.15 * amount)
    pose.update(root_pose((sign * 0.008 * amount, -0.035 * recoil, -0.025 * recoil), (2.5 * recoil, 0.0, sign * amount)))
    pose.update(
        side_pose(
            side,
            upper=(17.0 * amount, 1.5 * sign * amount, -2.5 * sign * amount),
            forearm=(17.0 * amount, -1.2 * sign * amount, 2.0 * sign * amount),
            hand=(-7.0 * amount, 1.5 * sign * amount, -1.5 * sign * amount),
            curl=-34.0 * amount,
            spread=2.0 + 10.0 * amount,
        )
    )
    return pose


def contact_pose(amount: float) -> dict:
    pose = neutral_pose(0.2 * amount)
    pose.update(root_pose((0.0, 0.020 * amount, -0.025 * amount), (0.0, 0.0, 0.0)))
    for side in ("left", "right"):
        sign = -1.0 if side == "left" else 1.0
        pose.update(
            side_pose(
                side,
                upper=(0.0, 1.4 * sign * amount, 80.0 * sign * amount),
                forearm=(10.0 * amount, -1.0 * sign * amount, 2.5 * sign * amount),
                hand=(-6.0 * amount, 1.4 * sign * amount, -1.8 * sign * amount),
                curl=-32.0 * amount,
                spread=2.0 + 10.0 * amount,
            )
        )
    return pose


def climb_pose(stage: str) -> dict:
    """Authored reach/grab/pull/mantle poses over the natural action basis."""

    if stage == "reach_left":
        return merge_pose(
            root_pose((-0.006, 0.10, 0.010), (-1.5, 0.6, -0.8)),
            side_pose(
                "left", upper=(8.0, -2.0, -36.0), forearm=(18.0, 1.0, -2.0),
                hand=(-8.0, -2.0, 1.0), curl=-34.0, spread=8.0,
            ),
            side_pose(
                "right", upper=(3.0, 1.0, 24.0), forearm=(9.0, -0.5, 1.0),
                hand=(-4.0, 1.0, -0.5), curl=-22.0, spread=4.0,
            ),
        )
    if stage == "reach_both":
        return merge_pose(
            root_pose((0.0, 0.14, 0.018), (-2.5, 0.0, 0.0)),
            side_pose(
                "left", upper=(9.0, -2.0, -36.0), forearm=(19.0, 1.0, -2.0),
                hand=(-8.0, -2.0, 1.0), curl=-36.0, spread=9.0,
            ),
            side_pose(
                "right", upper=(9.0, 2.0, 36.0), forearm=(19.0, -1.0, 2.0),
                hand=(-8.0, 2.0, -1.0), curl=-34.0, spread=8.0,
            ),
        )
    if stage == "grip":
        return merge_pose(
            root_pose((0.0, 0.19, 0.010), (-1.0, 0.0, 0.0)),
            side_pose(
                "left", upper=(6.0, -1.5, -75.0), forearm=(25.0, 0.8, -1.5),
                hand=(-5.0, -1.2, 0.8), curl=40.0, spread=-1.0,
            ),
            side_pose(
                "right", upper=(6.0, 1.5, 75.0), forearm=(25.0, -0.8, 1.5),
                hand=(-5.0, 1.2, -0.8), curl=38.0, spread=-1.0,
            ),
        )
    if stage == "pull":
        return merge_pose(
            root_pose((0.0, 0.10, -0.028), (4.0, 0.0, 0.0)),
            side_pose(
                "left", upper=(3.0, -1.0, -40.0), forearm=(20.0, 1.0, -2.0),
                hand=(8.0, -1.0, 0.8), curl=46.0, spread=-2.0,
            ),
            side_pose(
                "right", upper=(3.0, 1.0, 40.0), forearm=(20.0, -1.0, 2.0),
                hand=(8.0, 1.0, -0.8), curl=44.0, spread=-2.0,
            ),
        )
    if stage == "mantle":
        return merge_pose(
            root_pose((0.0, 0.10, -0.020), (2.0, 0.0, 0.0)),
            side_pose(
                "left", upper=(-6.0, -0.8, -22.0), forearm=(18.0, 0.5, -1.0),
                hand=(10.0, -0.8, 0.5), curl=30.0, spread=0.0,
            ),
            side_pose(
                "right", upper=(-7.0, 0.8, 22.0), forearm=(18.0, -0.5, 1.0),
                hand=(10.0, 0.8, -0.5), curl=28.0, spread=0.0,
            ),
        )
    raise ValueError(f"Unknown climb stage {stage}")


def key_pose(armature: bpy.types.Object, frame: int, pose: dict) -> None:
    reset_pose(armature)
    for bone_name, values in pose.items():
        bone = armature.pose.bones[bone_name]
        if "location" in values:
            bone.location = values["location"]
        if "rotation" in values:
            bone.rotation_quaternion = values["rotation"]
    for bone in armature.pose.bones:
        bone.keyframe_insert(data_path="location", frame=frame, group=bone.name)
        bone.keyframe_insert(data_path="rotation_quaternion", frame=frame, group=bone.name)


def create_action(armature, name: str, end_frame: int, keyframes: list[tuple[int, dict]]):
    action = bpy.data.actions.new(name=name)
    action.use_fake_user = True
    armature.animation_data.action = action
    for frame, pose in keyframes:
        key_pose(armature, frame, pose)
    for curve in action.fcurves:
        for point in curve.keyframe_points:
            point.interpolation = "BEZIER"
            point.handle_left_type = "AUTO_CLAMPED"
            point.handle_right_type = "AUTO_CLAMPED"
    return action


def resample_profile(profile: list[float], count: int) -> list[float]:
    if count <= 1:
        return [profile[0]]
    result = []
    for index in range(count):
        source = index * (len(profile) - 1) / (count - 1)
        lower = int(math.floor(source))
        upper = min(len(profile) - 1, lower + 1)
        fraction = source - lower
        result.append(profile[lower] * (1.0 - fraction) + profile[upper] * fraction)
    return result


def create_animations(armature: bpy.types.Object, reference: bpy.types.Object) -> list[dict]:
    bpy.context.scene.render.fps = 24
    armature.animation_data_create()
    clips = []

    relax_action = reference_action("relax")
    relax_start = max(1, int(math.ceil(relax_action.frame_range[0])))
    relax_end = int(math.ceil(relax_action.frame_range[1]))
    idle_keys = [
        (
            target_frame,
            reference_pose(armature, reference, "relax", source_frame),
        )
        for target_frame, source_frame in enumerate(
            range(relax_start, relax_end + 1),
            1,
        )
    ]
    loop_error = max(
        math.degrees(
            Quaternion(idle_keys[0][1][bone_name]["rotation"]).rotation_difference(
                Quaternion(idle_keys[-1][1][bone_name]["rotation"])
            ).angle
        )
        for bone_name in BONES
    )
    if loop_error > 0.25:
        raise RuntimeError(
            f"Retargeted Relax loop does not close: {loop_error:.4f} degrees"
        )
    idle = create_action(armature, "Idle", len(idle_keys), idle_keys)
    clips.append((
        idle,
        len(idle_keys),
        True,
        "full CC0 Relax pose retarget with lowered elbows, inward-canted wrists, cascading loose finger curl, and shallow opposing thumbs",
        "relax full-pose retarget",
    ))

    push_left = reference_profile(reference, "push.L", ("handIK.L",))
    push_right = reference_profile(reference, "push.R", ("handIK.R",))

    walk = create_action(
        armature, "Walk", 33,
        [(1, walk_pose(1.0)), (9, neutral_pose(0.25)), (17, walk_pose(-1.0)), (25, neutral_pose(0.25)), (33, walk_pose(1.0))],
    )
    clips.append((walk, 33, True, "authored locomotion additive over the retargeted relaxed hand posture", "relax additive"))

    run = create_action(
        armature, "Run", 25,
        [(1, run_pose(1.0)), (7, merge_pose(neutral_pose(0.6), root_pose((0.0, 0.012, -0.024)))), (13, run_pose(-1.0)), (19, merge_pose(neutral_pose(0.6), root_pose((0.0, 0.012, -0.024)))), (25, run_pose(1.0))],
    )
    clips.append((run, 25, True, "strong opposed arm/elbow/wrist swing with articulated fingers", "relax additive"))

    jump = create_action(
        armature, "Jump", 24,
        [
            (1, neutral_pose(0.0)),
            (5, merge_pose(root_pose((0.0, -0.010, -0.012), (-3.0, 0.0, 0.0)), side_pose("left", upper=(-7.0, -1.0, -2.0), forearm=(12.0, 0.0, 2.0), hand=(-12.0, -1.0, -1.0), curl=-12.0, spread=5.0), side_pose("right", upper=(-7.0, 1.0, 2.0), forearm=(12.0, 0.0, -2.0), hand=(-12.0, 1.0, 1.0), curl=-12.0, spread=5.0))),
            (12, merge_pose(root_pose((0.0, 0.010, 0.025), (-5.0, 0.0, 0.0)), side_pose("left", upper=(-10.0, -1.5, -3.0), forearm=(15.0, -1.0, 3.0), hand=(-14.0, -1.5, -2.0), curl=-17.0, spread=8.0), side_pose("right", upper=(-10.0, 1.5, 3.0), forearm=(15.0, 1.0, -3.0), hand=(-14.0, 1.5, 2.0), curl=-17.0, spread=8.0))),
            (19, merge_pose(root_pose((0.0, 0.004, 0.012), (-2.0, 0.0, 0.0)), side_pose("left", upper=(-5.0, -0.6, -1.5), forearm=(9.0, 0.0, 1.5), hand=(-8.0, -0.6, -1.0), curl=-7.0, spread=3.0), side_pose("right", upper=(-5.0, 0.6, 1.5), forearm=(9.0, 0.0, -1.5), hand=(-8.0, 0.6, 1.0), curl=-7.0, spread=3.0))),
            (24, neutral_pose(0.0)),
        ],
    )
    clips.append((jump, 24, False, "takeoff recoil, airborne lift, and open stabilizing hands", "relax additive"))

    land = create_action(
        armature, "Land", 22,
        [
            (1, neutral_pose(0.0)),
            (5, merge_pose(root_pose((0.0, -0.008, -0.024), (3.5, 0.0, 0.0)), side_pose("left", upper=(6.0, -1.5, -3.0), forearm=(11.0, 1.0, 3.0), hand=(-10.0, -1.5, -2.0), curl=-18.0, spread=7.0), side_pose("right", upper=(6.0, 1.5, 3.0), forearm=(11.0, -1.0, -3.0), hand=(-10.0, 1.5, 2.0), curl=-18.0, spread=7.0))),
            (10, merge_pose(root_pose((0.0, 0.004, 0.008), (-2.0, 0.0, 0.0)), side_pose("left", upper=(-4.0, 0.5, 1.5), forearm=(7.0, -0.5, -1.5), hand=(-6.0, 0.5, 1.0), curl=-4.0, spread=2.0), side_pose("right", upper=(-4.0, -0.5, -1.5), forearm=(7.0, 0.5, 1.5), hand=(-6.0, -0.5, -1.0), curl=-4.0, spread=2.0))),
            (16, neutral_pose(0.35)),
            (22, neutral_pose(0.0)),
        ],
    )
    clips.append((land, 22, False, "impact brace, wrist extension, finger splay, and damped recovery", "relax additive"))

    for name, profile, side, source_name in (
        ("PushLeft", push_left, "left", "push.L"),
        ("PushRight", push_right, "right", "push.R"),
    ):
        source_action = reference_action(source_name)
        source_start = max(1, int(math.ceil(source_action.frame_range[0])))
        source_end = int(math.ceil(source_action.frame_range[1]))
        source_frames = list(range(source_start, source_end + 1))
        if len(source_frames) != len(profile):
            raise RuntimeError(
                f"Reference {source_name} frame/profile mismatch: "
                f"{len(source_frames)} != {len(profile)}"
            )
        keys = []
        for target_frame, (source_frame, amount) in enumerate(
            zip(source_frames, profile),
            1,
        ):
            absolute = reference_pose(
                armature,
                reference,
                source_name,
                source_frame,
            )
            keys.append(
                (
                    target_frame,
                    blend_reference_side_pose(absolute, side, amount * 0.78),
                )
            )
        action = create_action(
            armature,
            name,
            len(profile),
            keys,
        )
        clips.append((
            action,
            len(profile),
            False,
            "supplied push trajectory and hand articulation blended on the active arm over the Relax basis",
            f"{source_name} active-side pose retarget",
        ))

    contact_profile = [
        max(left, right)
        for left, right in zip(
            resample_profile(push_left, 17),
            resample_profile(push_right, 17),
        )
    ]
    contact = create_action(
        armature, "ContactRecoil", 17,
        [(frame, contact_pose(amount)) for frame, amount in enumerate(contact_profile, 1)],
    )
    clips.append((contact, 17, False, "dual-hand contact stabilization plus bounded camera-local recoil", "push.L + push.R"))

    climb = create_action(
        armature,
        "Climb",
        29,
        [
            (1, neutral_pose(0.0)),
            (5, climb_pose("reach_left")),
            (10, climb_pose("reach_both")),
            (14, climb_pose("grip")),
            (20, climb_pose("pull")),
            (25, climb_pose("mantle")),
            (29, neutral_pose(0.0)),
        ],
    )
    clips.append((
        climb,
        29,
        False,
        "authored alternating reach, open contact, grip, pull, and mantle recovery for assisted climbs",
        "authored from natural rest",
    ))

    armature.animation_data.action = None
    for action, end_frame, _loop, _description, _source_action in clips:
        track = armature.animation_data.nla_tracks.new()
        track.name = action.name
        strip = track.strips.new(action.name, 1, action)
        strip.action_frame_start = 1
        strip.action_frame_end = end_frame
    reset_pose(armature)
    return [
        {
            "name": action.name,
            "frames": end_frame,
            "fps": 24,
            "loop": loop,
            "description": description,
            "motionSource": source_action,
        }
        for action, end_frame, loop, description, source_action in clips
    ]


def export_runtime(mesh: bpy.types.Object, armature: bpy.types.Object) -> None:
    bpy.ops.object.select_all(action="DESELECT")
    mesh.hide_viewport = False
    armature.hide_viewport = False
    mesh.select_set(True)
    armature.select_set(True)
    bpy.context.view_layer.objects.active = armature
    params = {
        "filepath": str(OUTPUT), "export_format": "GLB", "use_selection": True,
        "export_skins": True, "export_morph": False, "export_materials": "EXPORT",
        "export_image_format": "AUTO", "export_animations": True,
        "export_frame_range": False, "export_force_sampling": True,
        "export_def_bones": True, "export_yup": True,
    }
    properties = bpy.ops.export_scene.gltf.get_rna_type().properties.keys()
    if "export_animation_mode" in properties:
        params["export_animation_mode"] = "NLA_TRACKS"
    elif "export_nla_strips" in properties:
        params["export_nla_strips"] = True
    bpy.ops.export_scene.gltf(**params)


def save_authoring_file(armature: bpy.types.Object) -> None:
    armature["eanpa_natural_pose"] = "CC0 Relax full-pose retarget at frame 1"
    armature["eanpa_bind_pose"] = "clean open modeling pose retained only for stable skinning"
    armature["eanpa_motion_reference"] = "Drillimpact PSX First Person Arms 1.1.0 CC0"
    bpy.context.scene["eanpa_viewmodel_asset"] = "Aletheia Chrome first-person arms"
    bpy.context.scene["eanpa_runtime_clips"] = json.dumps(
        [
            "Idle",
            "Walk",
            "Run",
            "Jump",
            "Land",
            "PushLeft",
            "PushRight",
            "ContactRecoil",
            "Climb",
        ]
    )
    idle = next(action for action in bpy.data.actions if action.name == "Idle")
    tracks = list(armature.animation_data.nla_tracks)
    for track in tracks:
        track.mute = True
    armature.animation_data.action = idle
    bpy.context.scene.frame_set(1)
    bpy.context.view_layer.update()
    bpy.ops.wm.save_as_mainfile(
        filepath=str(AUTHORING_BLEND),
        compress=True,
        relative_remap=False,
    )
    armature.animation_data.action = None
    for track in tracks:
        track.mute = False
    reset_pose(armature)
    bpy.context.view_layer.update()


def glb_json(path: Path) -> dict:
    data = path.read_bytes()
    if data[:4] != b"glTF":
        raise RuntimeError(f"Not a GLB: {path}")
    chunk_length, chunk_type = struct.unpack_from("<II", data, 12)
    if chunk_type != 0x4E4F534A:
        raise RuntimeError("First GLB chunk is not JSON")
    return json.loads(data[20 : 20 + chunk_length].decode("utf-8").rstrip("\0 \t\r\n"))


def validate_inactive_virtual_tangent_provenance(classification: dict) -> dict:
    closure_records = classification.get("closureFixedPoint")
    if (
        not isinstance(closure_records, list)
        or classification.get("closureFixedPointPassCount")
        != len(closure_records)
        or [record.get("pass") for record in closure_records]
        != list(range(len(closure_records)))
    ):
        raise RuntimeError("Topology closure fixed-point provenance is malformed")
    components = []
    edge_count = 0
    for record in closure_records:
        pruned = record.get("prunedVirtualTangentEdgeCount", 0)
        pass_components = record.get("prunedVirtualTangentComponents", [])
        if (
            not isinstance(pruned, int)
            or pruned < 0
            or not isinstance(pass_components, list)
            or sum(
                component.get("edgeCount", -1)
                for component in pass_components
                if isinstance(component, dict)
            )
            != pruned
        ):
            raise RuntimeError("Inactive virtual tangent pass evidence is malformed")
        if pruned and (
            record.get("mixedComponentCount") != 0
            or record.get("qualifiedComponentCount") != 0
            or record.get("virtualInsertions") != []
            or record.get("newInactiveEdgeCount") != 0
        ):
            raise RuntimeError(
                "Inactive virtual tangent pruning is mixed with another closure action"
            )
        edge_count += pruned
        components.extend(pass_components)
    for component in components:
        owner = component.get("owner") if isinstance(component, dict) else None
        attachment = component.get("attachment") if isinstance(component, dict) else None
        component_edges = component.get("edgeCount") if isinstance(component, dict) else None
        component_nodes = component.get("nodeCount") if isinstance(component, dict) else None
        tangent_class = component.get("class") if isinstance(component, dict) else None
        semantic_state = (
            component.get("semanticState") if isinstance(component, dict) else None
        )
        kept_endpoint_count = (
            component.get("keptEndpointCount")
            if isinstance(component, dict)
            else None
        )
        boundary_evidence = (
            component.get("keptBoundaryEvidence")
            if isinstance(component, dict)
            else None
        )
        kept_nodes = (
            component.get("keptComponentNodeCount")
            if isinstance(component, dict)
            else None
        )
        if (
            not isinstance(owner, (tuple, list))
            or len(owner) != 2
            or owner[0] not in {"left", "right"}
            or owner[1] not in DIGITS
            or component.get("rank") not in {2, 3}
            or not isinstance(component_edges, int)
            or component_edges <= 0
            or not isinstance(component_nodes, int)
            or component_nodes != component_edges + 1
            or not isinstance(attachment, (tuple, list))
            or len(attachment) != 3
            or any(
                isinstance(value, bool) or not isinstance(value, int)
                for value in attachment
            )
            or not isinstance(kept_nodes, int)
            or kept_nodes < 3
            or tangent_class
            not in {"terminalTangentTail", "redundantTangentChord"}
            or semantic_state
            not in {component.get("rank"), component.get("rank", -1) + 1}
            or kept_endpoint_count not in {0, 2}
            or not isinstance(boundary_evidence, list)
        ):
            raise RuntimeError(
                "Inactive virtual tangent lacks terminal/connectivity proof"
            )
        if tangent_class == "terminalTangentTail":
            if kept_endpoint_count != 0 or boundary_evidence:
                raise RuntimeError(
                    "Terminal virtual tangent has nonterminal boundary evidence"
                )
        elif len(boundary_evidence) != kept_endpoint_count:
            raise RuntimeError(
                "Redundant virtual chord boundary evidence is incomplete"
            )
        elif boundary_evidence:
            components_seen = {
                item.get("component")
                for item in boundary_evidence
                if isinstance(item, dict)
                and isinstance(item.get("component"), int)
                and not isinstance(item.get("component"), bool)
                and isinstance(item.get("distanceMeters"), (int, float))
                and not isinstance(item.get("distanceMeters"), bool)
                and math.isfinite(float(item["distanceMeters"]))
                and 0.0 <= float(item["distanceMeters"]) <= 1e-7
            }
            if len(components_seen) != 1 or len(boundary_evidence) != 2:
                raise RuntimeError(
                    "Redundant virtual chord lacks one source boundary component"
                )
    tangent_position_count = classification.get(
        "inactiveVirtualTangentPositionCount"
    )
    attachment_position_count = classification.get(
        "inactiveVirtualAttachmentPositionCount"
    )
    component_count = classification.get("inactiveVirtualTangentComponentCount")
    classified_edge_count = classification.get(
        "inactiveVirtualTangentEdgeCount"
    )
    if (
        isinstance(classified_edge_count, bool)
        or not isinstance(classified_edge_count, int)
        or classified_edge_count < 0
        or edge_count != classified_edge_count
        or len(components) != component_count
        or any(
            isinstance(value, bool) or not isinstance(value, int) or value < 0
            for value in (
                tangent_position_count,
                attachment_position_count,
                component_count,
            )
        )
        or (
            edge_count == 0
            and any(
                value != 0
                for value in (
                    tangent_position_count,
                    attachment_position_count,
                    component_count,
                )
            )
        )
        or (
            edge_count > 0
            and any(
                value <= 0
                for value in (
                    tangent_position_count,
                    attachment_position_count,
                    component_count,
                )
            )
        )
    ):
        raise RuntimeError(
            "Inactive virtual tangent aggregates differ from closure proof"
        )
    return {
        "edgeCount": edge_count,
        "componentCount": len(components),
    }


def validate_recorded_root_endpoint_reuse_provenance(
    classification: dict,
) -> dict:
    """Require the source-locked physical endpoint reuse that prevents slivers."""

    closure_records = classification.get("closureFixedPoint")
    if not isinstance(closure_records, list):
        raise RuntimeError("Topology closure endpoint provenance is missing")
    insertion_count = 0
    reuse_count = 0
    maximum_displacement = 0.0
    for closure_record in closure_records:
        insertions = closure_record.get("virtualInsertions")
        if not isinstance(insertions, list):
            raise RuntimeError("Topology closure insertion evidence is malformed")
        for insertion in insertions:
            if not isinstance(insertion, dict):
                raise RuntimeError("Topology closure insertion is not an object")
            insertion_count += 1
            owner = insertion.get("owner")
            rank = insertion.get("rank")
            count = insertion.get("recordedRootEndpointReuseCount")
            reported_maximum = insertion.get(
                "maximumRecordedRootEndpointReuseDisplacementMeters"
            )
            ambiguous = insertion.get(
                "ambiguousRecordedRootEndpointReuseCount"
            )
            cross_owner_rank = insertion.get(
                "crossOwnerRankEndpointReuseCount"
            )
            evidence = insertion.get("recordedRootEndpointReuseEvidence")
            if (
                not isinstance(owner, (tuple, list))
                or len(owner) != 2
                or owner[0] not in {"left", "right"}
                or owner[1] not in DIGITS
                or isinstance(rank, bool)
                or not isinstance(rank, int)
                or rank not in {2, 3}
                or isinstance(count, bool)
                or not isinstance(count, int)
                or count < 0
                or isinstance(reported_maximum, bool)
                or not isinstance(reported_maximum, (int, float))
                or not math.isfinite(float(reported_maximum))
                or not 0.0 <= float(reported_maximum) <= 1e-6
                or ambiguous != 0
                or cross_owner_rank != 0
                or not isinstance(evidence, list)
                or len(evidence) != count
            ):
                raise RuntimeError(
                    "Recorded physical-root endpoint provenance is malformed"
                )
            expected_contour_index = (
                (0 if owner[0] == "left" else 45)
                + DIGITS.index(owner[1]) * 9
                + rank
            )
            seen = set()
            displacements = []
            for item in evidence:
                if not isinstance(item, dict):
                    raise RuntimeError(
                        "Recorded physical-root endpoint evidence is malformed"
                    )
                identity = tuple(
                    item.get(name)
                    for name in (
                        "sourceFaceIndex",
                        "descendantFaceIndex",
                        "requestedEdgeIndex",
                        "endpointVertexIndex",
                    )
                )
                displacement = item.get("displacementMeters")
                contour_indices = item.get("physicalContourIndices")
                if (
                    any(
                        isinstance(value, bool)
                        or not isinstance(value, int)
                        or value < 0
                        for value in identity
                    )
                    or identity in seen
                    or isinstance(displacement, bool)
                    or not isinstance(displacement, (int, float))
                    or not math.isfinite(float(displacement))
                    or not 0.0 <= float(displacement) <= 1e-6
                    or not isinstance(contour_indices, list)
                    or not contour_indices
                    or any(
                        isinstance(value, bool)
                        or not isinstance(value, int)
                        or value != expected_contour_index
                        for value in contour_indices
                    )
                ):
                    raise RuntimeError(
                        "Recorded endpoint reuse lacks exact edge/contour proof"
                    )
                seen.add(identity)
                displacements.append(float(displacement))
            measured_maximum = max(displacements, default=0.0)
            if abs(measured_maximum - float(reported_maximum)) > 1e-12:
                raise RuntimeError(
                    "Recorded endpoint reuse maximum differs from its evidence"
                )
            reuse_count += count
            maximum_displacement = max(
                maximum_displacement,
                measured_maximum,
            )
    if insertion_count <= 0 or reuse_count <= 0:
        raise RuntimeError(
            "Source-locked topology no longer reuses its authored root endpoint"
        )
    return {
        "insertionCount": insertion_count,
        "reuseCount": reuse_count,
        "maximumDisplacementMeters": maximum_displacement,
        "ambiguousReuseCount": 0,
        "crossOwnerRankReuseCount": 0,
    }


def validate_central_constraint_solver_provenance(
    classification: dict,
) -> dict:
    """Reject stale greedy/unbounded central-thumb constraint provenance."""

    closure_records = classification.get("closureFixedPoint")
    if not isinstance(closure_records, list):
        raise RuntimeError("Central constraint closure provenance is missing")

    def nonnegative_integer(value) -> bool:
        return (
            not isinstance(value, bool)
            and isinstance(value, int)
            and value >= 0
        )

    searches = []
    for closure_record in closure_records:
        constraint = closure_record.get("centralConstraint")
        if constraint is None:
            continue
        if not isinstance(constraint, dict):
            raise RuntimeError("Central constraint provenance is malformed")
        search = constraint.get("globalConstraintSearch")
        if search is None:
            if constraint.get("relevantComponentCount") != 0:
                raise RuntimeError(
                    "Relevant central constraints lack bounded-search proof"
                )
            continue
        if not isinstance(search, dict):
            raise RuntimeError("Central constraint search proof is malformed")
        searches.append(search)
        integer_fields = (
            "clusterCount",
            "rawEdgeCount",
            "relationGroupCount",
            "visitedNodeCount",
            "upperBoundPruneCount",
            "infeasibleBranchCount",
            "feasibleLeafCount",
            "infeasibleLeafCount",
            "rejectedFallbackLeafCount",
            "maximumDepth",
            "peakRollbackLogSize",
            "optimalActiveEdgeCount",
            "optimalInactiveEdgeCount",
            "completeLeafCount",
        )
        clusters = search.get("clusters")
        signature = search.get("selectedSignature")
        if (
            search.get("solver")
            != "weighted-rollback-dsu-branch-and-bound"
            or search.get("objective")
            != (
                "maximum total active physical edge count; ties use rank "
                "priority 1,4,2,3 then geometric edge key"
            )
            or search.get("tieCountEnumerated") is not False
            or search.get("optimalityProven") is not True
            or not isinstance(search.get("boundProof"), str)
            or "future assignments and unions only remove support"
            not in search["boundProof"]
            or any(
                not nonnegative_integer(search.get(name))
                for name in integer_fields
            )
            or not isinstance(clusters, list)
            or len(clusters) != search.get("clusterCount")
            or not isinstance(signature, list)
            or len(signature) != search.get("rawEdgeCount")
            or any(value not in {0, 1} for value in signature)
            or sum(signature) != search.get("optimalActiveEdgeCount")
            or search.get("optimalActiveEdgeCount")
            + search.get("optimalInactiveEdgeCount")
            != search.get("rawEdgeCount")
            or search.get("completeLeafCount")
            != search.get("feasibleLeafCount")
            + search.get("infeasibleLeafCount")
            or search.get("feasibleLeafCount", 0) <= 0
        ):
            raise RuntimeError(
                "Central constraint search is not a complete bounded proof"
            )
        cluster_integer_fields = (
            "clusterIndex",
            "quotientNodeCount",
            "rawEdgeCount",
            "initialRelationGroupCount",
            "postForcedRelationGroupCount",
            "postForcedOptionalRawEdgeCount",
            "fixedPointForcedInactiveRawEdgeCount",
            "visitedNodeCount",
            "upperBoundPruneCount",
            "infeasibleBranchCount",
            "feasibleLeafCount",
            "infeasibleLeafCount",
            "rejectedFallbackLeafCount",
            "maximumDepth",
            "peakRollbackLogSize",
            "greedyVisitedNodeCount",
            "greedyIncumbentActiveEdgeCount",
            "optimalActiveEdgeCount",
        )
        for index, cluster in enumerate(clusters):
            cluster_signature = (
                cluster.get("selectedSignature")
                if isinstance(cluster, dict)
                else None
            )
            if (
                not isinstance(cluster, dict)
                or any(
                    not nonnegative_integer(cluster.get(name))
                    for name in cluster_integer_fields
                )
                or cluster.get("clusterIndex") != index
                or cluster.get("quotientNodeCount", 0) <= 0
                or cluster.get("postForcedRelationGroupCount")
                > cluster.get("initialRelationGroupCount")
                or cluster.get("greedyIncumbentActiveEdgeCount")
                > cluster.get("optimalActiveEdgeCount")
                or not isinstance(cluster_signature, list)
                or len(cluster_signature)
                != cluster.get("postForcedOptionalRawEdgeCount")
                or any(value not in {0, 1} for value in cluster_signature)
                or sum(cluster_signature)
                != cluster.get("optimalActiveEdgeCount")
            ):
                raise RuntimeError(
                    "Central constraint cluster proof is malformed"
                )
        if (
            sum(item["rawEdgeCount"] for item in clusters)
            != search["rawEdgeCount"]
            or sum(item["initialRelationGroupCount"] for item in clusters)
            != search["relationGroupCount"]
            or sum(item["optimalActiveEdgeCount"] for item in clusters)
            != search["optimalActiveEdgeCount"]
            or sum(item["visitedNodeCount"] for item in clusters)
            != search["visitedNodeCount"]
            or max(
                (item["maximumDepth"] for item in clusters),
                default=0,
            )
            != search["maximumDepth"]
            or max(
                (item["peakRollbackLogSize"] for item in clusters),
                default=0,
            )
            != search["peakRollbackLogSize"]
            or constraint.get("rawCentralConstraintEdgeCount")
            != search["rawEdgeCount"]
            or constraint.get("rawRelationValidationEdgeCount")
            != search["rawEdgeCount"]
            or constraint.get("centralRelationGroupCount")
            != search["relationGroupCount"]
            or constraint.get("activeCentralEdgeCount")
            != search["optimalActiveEdgeCount"]
            or constraint.get("inactiveCentralEdgeCount")
            != search["optimalInactiveEdgeCount"]
        ):
            raise RuntimeError(
                "Central constraint aggregates differ from bounded search"
            )
    if not searches:
        raise RuntimeError("Topology closure has no bounded central search proof")
    return {
        "searchCount": len(searches),
        "rawEdgeCount": sum(item["rawEdgeCount"] for item in searches),
        "optimalActiveEdgeCount": sum(
            item["optimalActiveEdgeCount"] for item in searches
        ),
        "visitedNodeCount": sum(
            item["visitedNodeCount"] for item in searches
        ),
        "peakRollbackLogSize": max(
            item["peakRollbackLogSize"] for item in searches
        ),
        "tieCountEnumerated": False,
        "optimalityProven": True,
    }


def write_topology_records(
    zone_records: dict[tuple[int, int, int], dict],
    topology_provenance: dict,
) -> dict:
    """Persist the exact post-cut key-to-mechanical-state contract."""

    classification = topology_provenance.get("topologyClassification")
    if not isinstance(classification, dict):
        raise RuntimeError("Topology classification provenance is missing")
    validate_inactive_virtual_tangent_provenance(classification)
    validate_recorded_root_endpoint_reuse_provenance(classification)
    validate_central_constraint_solver_provenance(classification)
    expected_record_count = classification.get("recordCount")
    expected_hand_key_count = classification.get("postcutHandKeyCount")
    if (
        expected_record_count != len(zone_records)
        or expected_hand_key_count != len(zone_records)
        or classification.get("postcutHandKeyMismatchCount") != 0
    ):
        raise RuntimeError(
            "Topology records do not cover the exact post-cut hand key set"
        )

    records = []
    zone_counts = {}
    disposition_counts = {}
    interface_rank_counts = {}
    for key in sorted(zone_records):
        if (
            not isinstance(key, tuple)
            or len(key) != 3
            or any(
                isinstance(value, bool) or not isinstance(value, int)
                for value in key
            )
        ):
            raise RuntimeError(f"Malformed topology position key: {key}")
        record = dict(zone_records[key])
        if "key" in record:
            raise RuntimeError(f"Topology record {key} shadows its exact key")
        side = record.get("side")
        digit = record.get("digit")
        zone = record.get("zone")
        blend = record.get("blend")
        if record.get("origin") not in {"source", "inserted"}:
            raise RuntimeError(f"Topology key {key} has invalid origin")
        if side not in {"left", "right"}:
            raise RuntimeError(f"Topology key {key} has invalid side {side}")
        if zone == "H":
            if digit is not None or blend is not None:
                raise RuntimeError(f"Topology hand key {key} is malformed")
        elif zone in {"S0", "S1", "S2"}:
            if digit not in DIGITS or blend is not None:
                raise RuntimeError(f"Topology rigid key {key} is malformed")
        elif zone in {"G0", "G1", "G2"}:
            if (
                digit not in DIGITS
                or isinstance(blend, bool)
                or not isinstance(blend, (int, float))
                or not math.isfinite(float(blend))
                or not 0.0 <= float(blend) <= 1.0
            ):
                raise RuntimeError(f"Topology gasket key {key} is malformed")
        else:
            raise RuntimeError(f"Topology key {key} has invalid zone {zone}")

        interface_rank = record.get("topologyInterfaceRank")
        disposition = record.get("interfaceDisposition")
        if "topologyDisposition" in record:
            raise RuntimeError(
                f"Topology key {key} still uses legacy topologyDisposition"
            )
        if disposition not in {
            "none",
            "activeInterface",
            "virtualContinuation",
            "inactiveIncompleteTripletCap",
            "inactiveVirtualTangent",
        }:
            raise RuntimeError(
                f"Topology key {key} has no canonical interface disposition"
            )
        if interface_rank is not None:
            if (
                isinstance(interface_rank, bool)
                or not isinstance(interface_rank, int)
                or not 0 <= interface_rank < 9
            ):
                raise RuntimeError(
                    f"Topology key {key} has invalid interface rank"
                )
            expected_zone = f"G{interface_rank // 3}"
            expected_blend = (0.0, 0.5, 1.0)[interface_rank % 3]
            if zone != expected_zone or float(blend) != expected_blend:
                raise RuntimeError(
                    f"Topology key {key} lost exact interface semantics"
                )
            if disposition not in {
                "activeInterface",
                "virtualContinuation",
            }:
                raise RuntimeError(
                    f"Ranked topology key {key} has disposition {disposition}"
                )
            interface_rank_counts[str(interface_rank)] = (
                interface_rank_counts.get(str(interface_rank), 0) + 1
            )
        elif disposition not in {
            "none",
            "inactiveIncompleteTripletCap",
            "inactiveVirtualTangent",
        }:
            raise RuntimeError(
                f"Topology key {key} disposition {disposition} lacks a rank"
            )
        if interface_rank is None:
            topology_state = record.get("topologyState")
            if (
                isinstance(topology_state, bool)
                or not isinstance(topology_state, int)
                or not 0 <= topology_state <= 9
            ):
                raise RuntimeError(
                    f"Unranked topology key {key} has no proven state"
                )
            rigid_state_zones = {0: "H", 3: "S0", 6: "S1", 9: "S2"}
            if topology_state in rigid_state_zones:
                valid_topology_state = (
                    zone == rigid_state_zones[topology_state]
                    and blend is None
                )
            else:
                gasket_index = (topology_state - 1) // 3
                lower_half = topology_state == 3 * gasket_index + 1
                valid_topology_state = (
                    zone == f"G{gasket_index}"
                    and isinstance(blend, (int, float))
                    and (
                        0.0 <= float(blend) <= 0.5
                        if lower_half
                        else 0.5 <= float(blend) <= 1.0
                    )
                )
            if not valid_topology_state:
                raise RuntimeError(
                    f"Unranked topology key {key} disagrees with state "
                    f"{topology_state}"
                )
        record["interfaceDisposition"] = disposition
        records.append({"key": list(key), **record})
        zone_key = f"{side}/{digit or 'hand'}/{zone}"
        zone_counts[zone_key] = zone_counts.get(zone_key, 0) + 1
        disposition_counts[disposition] = (
            disposition_counts.get(disposition, 0) + 1
        )

    zone_counts = dict(sorted(zone_counts.items()))
    disposition_counts = dict(sorted(disposition_counts.items()))
    interface_rank_counts = dict(sorted(interface_rank_counts.items()))
    if (
        set(interface_rank_counts) != {str(rank) for rank in range(9)}
        or any(count <= 0 for count in interface_rank_counts.values())
        or zone_counts != classification.get("zoneCounts")
        or disposition_counts
        != classification.get("interfaceDispositionCounts")
        or interface_rank_counts
        != classification.get("interfaceRankPositionCounts")
        or disposition_counts.get("activeInterface", 0)
        != classification.get("exactRecordedContourBlendPositionCount")
        or disposition_counts.get("virtualContinuation", 0)
        != classification.get("exactVirtualContinuationBlendPositionCount")
        or sum(interface_rank_counts.values())
        != classification.get("exactContourBlendPositionCount")
        or disposition_counts.get("inactiveIncompleteTripletCap", 0)
        != classification.get("inactiveOnlyPositionCount")
        or disposition_counts.get("inactiveVirtualTangent", 0)
        != classification.get("inactiveVirtualTangentPositionCount")
        or not isinstance(
            classification.get("inactiveVirtualTangentEdgeCount"), int
        )
        or classification.get("inactiveVirtualTangentEdgeCount") < 0
        or not isinstance(
            classification.get("inactiveVirtualAttachmentPositionCount"), int
        )
        or classification.get("inactiveVirtualAttachmentPositionCount") < 0
        or not isinstance(
            classification.get("inactiveVirtualTangentComponentCount"), int
        )
        or classification.get("inactiveVirtualTangentComponentCount") < 0
        or classification.get("activeOneSidedVirtualEdgeCount") != 0
        or classification.get("inactiveVirtualConnectivityViolationCount") != 0
        or classification.get("inactiveVirtualExactInterfaceLeakCount") != 0
        or classification.get("inactiveUnprovenStateCount") != 0
        or classification.get("inactiveProtectedAnchorCrossingCount") != 0
        or classification.get("inactiveExactInterfaceLeakCount") != 0
    ):
        raise RuntimeError(
            "Topology sidecar aggregates differ from the topology flood"
        )
    sidecar = {
        "schemaVersion": 1,
        "coordinateSystem": "Blender source-mesh local coordinates",
        "quantization": POSITION_QUANTIZATION,
        "handRegionMinimumY": HAND_REGION_MINIMUM_Y,
        "source": {
            "file": "assets/player/Aletheia_Chrome_1p_arms.glb",
            "sha256": sha256(SOURCE),
        },
        "runtime": {
            "file": (
                "assets/player/runtime/"
                "Aletheia_Chrome_1p_arms_viewmodel.glb"
            ),
            "sha256": sha256(OUTPUT),
        },
        "classification": {
            "schemaVersion": classification.get("schemaVersion"),
            "method": classification.get("method"),
            "coordinateEligibilityCount": classification.get(
                "coordinateEligibilityCount"
            ),
            "recordCount": len(records),
            "interfaceDispositionCounts": disposition_counts,
            "interfaceRankPositionCounts": interface_rank_counts,
            "zoneCounts": zone_counts,
        },
        "records": records,
    }
    serialized = json.dumps(
        sidecar,
        sort_keys=True,
        separators=(",", ":"),
        allow_nan=False,
    ) + "\n"
    TOPOLOGY_RECORDS.write_text(serialized, encoding="utf-8")
    return {
        "file": TOPOLOGY_RECORDS.relative_to(ROOT).as_posix(),
        "bytes": TOPOLOGY_RECORDS.stat().st_size,
        "sha256": sha256(TOPOLOGY_RECORDS),
        "schemaVersion": sidecar["schemaVersion"],
        "quantization": sidecar["quantization"],
        "handRegionMinimumY": sidecar["handRegionMinimumY"],
        "sourceSha256": sidecar["source"]["sha256"],
        "runtimeSha256": sidecar["runtime"]["sha256"],
        "recordCount": len(records),
        "interfaceDispositionCounts": disposition_counts,
        "interfaceRankPositionCounts": interface_rank_counts,
        "zoneCounts": zone_counts,
    }


def write_manifest(
    texture_records,
    clips,
    weight_stats,
    skin_zone_provenance,
    hinge_seam_provenance,
    topology_provenance,
    topology_record_provenance,
    digit_pivots,
    pivot_provenance,
) -> None:
    source_doc = glb_json(SOURCE)
    output_doc = glb_json(OUTPUT)
    primitive = output_doc["meshes"][0]["primitives"][0]
    index_accessor = output_doc["accessors"][primitive["indices"]]
    manifest = {
        "schemaVersion": 3,
        "source": {
            "file": "assets/player/Aletheia_Chrome_1p_arms.glb",
            "bytes": SOURCE.stat().st_size, "sha256": sha256(SOURCE),
            "skinCount": len(source_doc.get("skins", [])),
            "animationCount": len(source_doc.get("animations", [])),
        },
        "authoring": {
            "file": "assets/player/Aletheia_Chrome_1p_arms_rigged.blend",
            "bytes": AUTHORING_BLEND.stat().st_size,
            "sha256": sha256(AUTHORING_BLEND),
            "blenderVersion": bpy.app.version_string,
            "containsMotionReference": True,
        },
        "motionReference": {
            "file": "assets/player/rig_reference/Drillimpact_PSX_First_Person_Arms_CC0.glb",
            "creator": "Drillimpact", "asset": "PSX First Person Arms 1.1.0",
            "sourceUrl": "https://drillimpact.itch.io/psx-first-person-arms-free",
            "license": "CC0 / Public Domain", "sha256": sha256(REFERENCE),
            "usedActions": list(SAFE_REFERENCE_ACTIONS),
            "excludedActionPrefixes": list(EXCLUDED_REFERENCE_PREFIXES),
            "usage": "evaluated Relax joint directions and animation timing; no reference mesh or textures in runtime",
        },
        "runtime": {
            "file": "assets/player/runtime/Aletheia_Chrome_1p_arms_viewmodel.glb",
            "bytes": OUTPUT.stat().st_size, "sha256": sha256(OUTPUT),
            "triangles": int(index_accessor["count"]) // 3,
            "skinCount": len(output_doc.get("skins", [])),
            "animationCount": len(output_doc.get("animations", [])),
        },
        "textures": texture_records,
        "rig": {
            "bones": list(BONES),
            "chain": "root -> upper arm -> forearm -> hand -> three bones per digit, both sides",
            "weighting": "source-hash-locked mechanical hinge topology: three measured non-planar contours inserted at all 30 authored separations; palm and chrome phalanges are rigid, two-bone interpolation is confined to the measured 2-7 mm gasket strips, every UV/normal duplicate shares one exact weight vector, arm hinges remain localized, and every vertex has at most two influences",
            "skinZones": skin_zone_provenance,
            "hingeSeams": hinge_seam_provenance,
            "topologyRecords": topology_record_provenance,
            "subdividedTopology": topology_provenance,
            "pivotPlacement": {
                "source": "32-sample cyclic base-color/normal/geometry traces through each modeled hinge; bone heads use independently audited modeled-separation centers and mesh contours use the measured proximal/center/distal boundaries",
                "coordinateSystem": "Blender source-mesh local coordinates",
                "sourceChainPoints": SOURCE_CHAIN_POINTS,
                "measuredJointCenters": digit_pivots,
                "evidencePolicy": {
                    "derivation": (
                        "derive_measured_digit_pivots: every digit joint "
                        "pivot is its measured hinge-ring center; the axial "
                        "station-mean correction along the fixed-frame "
                        "tangent applies to all 30 joints, and the in-plane "
                        "circle-fit center applies only where the recorded "
                        "ring is well covered and near-circular"
                    ),
                    "radialAcceptance": {
                        "maximumFitRmsMeters": 0.0016,
                        "maximumAngularGapRadians": math.pi / 4.0,
                        "maximumCorrectionMeters": 0.008,
                    },
                    "axialSanityCapMeters": 0.040,
                    "jointCorrections": pivot_provenance,
                },
                "thumbCmcConfidence": "inferred from the branch centerline because the buried CMC has no complete surface ring",
            },
            "weightCoverage": weight_stats,
            "authoredForward": "Blender +Y / glTF and Three camera -Z",
            "restPose": {
                "bindPose": "clean source modeling pose retained for stable inverse binds and predictable local axes",
                "authoredNaturalPose": "every clip composes from the supplied Relax frame: lowered elbows, inward-canted wrists, grouped cascading fingers, and shallow opposing thumbs",
                "authoringFilePreview": "Idle frame 1",
                "bakedAsArmatureRest": False,
            },
        },
        "clips": clips,
        "integration": {
            "worldCollision": False, "worldSceneAttachment": True,
            "rendering": "camera-child layer in the existing world RenderPipeline; no second renderer pass",
            "recommendedScale": 0.275,
            "recommendedCameraLocalOffset": [0.0, -0.19, -0.385],
            "modelRotation": [0.0, 0.0, 0.0],
            "contact": {
                "clips": ["PushLeft", "PushRight", "ContactRecoil"],
                "expectation": "runtime chooses a side from the collision normal, stabilizes hand contact, and applies only a small bounded explorer recoil",
            },
        },
    }
    MANIFEST.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")


def main() -> None:
    for path in (SOURCE, REFERENCE, SKIN_ZONES, HINGE_SEAMS):
        if not path.exists():
            raise FileNotFoundError(path)
    RUNTIME_DIR.mkdir(parents=True, exist_ok=True)
    reset_scene()
    bpy.ops.import_scene.gltf(filepath=str(SOURCE))
    mesh = imported_aletheia_mesh()
    (
        source_position_groups,
        source_zone_records,
        skin_zone_provenance,
    ) = load_skin_zones(mesh)
    hinge_spec, hinge_seam_provenance = load_hinge_spec(
        HINGE_SEAMS,
        expected_source_sha256=EXPECTED_SOURCE_SHA256,
        expected_source_raw_vertex_count=EXPECTED_SOURCE_RAW_VERTEX_COUNT,
        expected_source_triangle_count=EXPECTED_SOURCE_TRIANGLE_COUNT,
        expected_joint_points=SOURCE_CHAIN_POINTS,
    )
    digit_pivots, pivot_provenance = derive_measured_digit_pivots(hinge_spec)
    position_groups, zone_records, topology_provenance = subdivide_and_classify(
        mesh,
        hinge_spec=hinge_spec,
        source_zone_records=source_zone_records,
        hand_region_minimum_y=HAND_REGION_MINIMUM_Y,
    )
    skin_zone_provenance["sourcePositionGroupCount"] = len(source_position_groups)
    textures = downsample_textures(mesh)
    armature, weight_stats = create_rig(
        mesh, position_groups, zone_records, digit_pivots
    )
    reference = load_motion_reference()
    capture_natural_pose(armature, reference)
    clips = create_animations(armature, reference)
    save_authoring_file(armature)
    export_runtime(mesh, armature)
    topology_record_provenance = write_topology_records(
        zone_records,
        topology_provenance,
    )
    write_manifest(
        textures,
        clips,
        weight_stats,
        skin_zone_provenance,
        hinge_seam_provenance,
        topology_provenance,
        topology_record_provenance,
        digit_pivots,
        pivot_provenance,
    )
    print(f"Built {OUTPUT.relative_to(ROOT)} ({OUTPUT.stat().st_size:,} bytes)")
    print(f"Rig {len(BONES)} bones; clips {', '.join(clip['name'] for clip in clips)}")
    print(f"Motion reference Drillimpact CC0 {sha256(REFERENCE)}")
    print(
        "Topology records "
        f"{TOPOLOGY_RECORDS.relative_to(ROOT)} "
        f"({topology_record_provenance['recordCount']:,} keys)"
    )
    print(f"Manifest {MANIFEST.relative_to(ROOT)}")


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"FIRST_PERSON_VIEWMODEL_BUILD_FAILED: {exc}", file=sys.stderr)
        raise
