#!/usr/bin/env python3
"""Render Aletheia's measured post-subdivision mechanical skin zones.

Run with Blender, for example::

    blender --background --python tools/render-first-person-skin-zone-diagnostic.py

The diagnostic first validates the original source and ownership sidecar, then
inserts the same 90 non-planar hinge contours as the production builder. Every
UV/normal duplicate at one quantized post-cut position receives the same color,
so a visible boundary represents the final mechanical partition rather than an
import seam.
"""

from __future__ import annotations

import ast
from collections import Counter
import hashlib
import json
import math
import os
from pathlib import Path
import sys

import bmesh
import bpy
from mathutils import Matrix, Vector


ROOT = Path(__file__).resolve().parents[1]
TOOLS_DIR = Path(__file__).resolve().parent
if str(TOOLS_DIR) not in sys.path:
    sys.path.insert(0, str(TOOLS_DIR))

from first_person_hinge_topology import (  # noqa: E402
    load_hinge_spec,
    subdivide_and_classify,
)


SOURCE = ROOT / "assets" / "player" / "Aletheia_Chrome_1p_arms.glb"
SKIN_ZONES = ROOT / "assets" / "player" / "Aletheia_Chrome_1p_arms_skin_zones.json"
HINGE_SEAMS = (
    ROOT / "assets" / "player" / "Aletheia_Chrome_1p_arms_hinge_seams.json"
)
BUILDER = ROOT / "tools" / "build-first-person-viewmodel.py"
OUT = ROOT / "artifacts" / "first-person-viewmodel" / "skin-zones"

SCHEMA_VERSION = 1
POSITION_QUANTIZATION = 1_000_000
EXPECTED_SOURCE_SHA256 = (
    "c0b9c6cba54c316111d29878493a7a65ba94010a2756addd6f5a18a6c9fd5c1d"
)
EXPECTED_SOURCE_RAW_VERTEX_COUNT = 37_963
EXPECTED_SOURCE_UNIQUE_POSITION_COUNT = 27_739
EXPECTED_SOURCE_TRIANGLE_COUNT = 55_446
HAND_REGION_MINIMUM_Y = 0.64
EXPECTED_HAND_REGION_RAW_VERTEX_COUNT = 5_354
EXPECTED_HAND_REGION_UNIQUE_POSITION_COUNT = 3_533
EXPECTED_HAND_REGION_SIDE_UNIQUE_COUNTS = {"left": 1_783, "right": 1_750}

DIGITS = ("thumb", "index", "middle", "ring", "pinky")
ZONES = ("H", "G0", "S0", "G1", "S1", "G2", "S2")

# Rigid chrome pieces keep a recognizable per-digit hue while S0/S1/S2 use
# progressively brighter shades.  The universal gasket colors are deliberately
# neon and mutually distinct so even narrow transition rings remain obvious.
HAND_COLOR = (0.20, 0.22, 0.27, 1.0)
RIGID_COLORS = {
    "thumb": {
        "S0": (0.48, 0.07, 0.015, 1.0),
        "S1": (0.82, 0.20, 0.025, 1.0),
        "S2": (1.00, 0.53, 0.08, 1.0),
    },
    "index": {
        "S0": (0.015, 0.34, 0.07, 1.0),
        "S1": (0.02, 0.67, 0.15, 1.0),
        "S2": (0.30, 1.00, 0.20, 1.0),
    },
    "middle": {
        "S0": (0.015, 0.16, 0.48, 1.0),
        "S1": (0.02, 0.43, 0.91, 1.0),
        "S2": (0.28, 0.76, 1.00, 1.0),
    },
    "ring": {
        "S0": (0.25, 0.035, 0.47, 1.0),
        "S1": (0.53, 0.07, 0.88, 1.0),
        "S2": (0.81, 0.39, 1.00, 1.0),
    },
    "pinky": {
        "S0": (0.48, 0.015, 0.09, 1.0),
        "S1": (0.86, 0.035, 0.20, 1.0),
        "S2": (1.00, 0.36, 0.49, 1.0),
    },
}
GASKET_COLORS = {
    "G0": (1.00, 0.95, 0.015, 1.0),
    "G1": (0.015, 1.00, 0.95, 1.0),
    "G2": (1.00, 0.015, 0.85, 1.0),
}


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def position_key(coordinate) -> tuple[int, int, int]:
    """Return the exact sidecar key for one source-local coordinate."""

    return tuple(
        int(round(float(coordinate[axis]) * POSITION_QUANTIZATION))
        for axis in range(3)
    )


def identity_error(matrix: Matrix) -> float:
    return max(
        abs(
            float(matrix[row][column])
            - (1.0 if row == column else 0.0)
        )
        for row in range(4)
        for column in range(4)
    )


def builder_joint_points() -> dict:
    """Derive the measured pivots without importing the Blender build script."""

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
    return json.loads(json.dumps(pivots))


def reset_scene() -> None:
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    for collection in (bpy.data.meshes, bpy.data.materials, bpy.data.cameras):
        for item in list(collection):
            collection.remove(item)


def imported_source_mesh() -> bpy.types.Object:
    bpy.ops.import_scene.gltf(filepath=str(SOURCE))
    meshes = [obj for obj in bpy.context.scene.objects if obj.type == "MESH"]
    if len(meshes) != 1:
        raise RuntimeError(f"Expected one source mesh, found {len(meshes)}")
    mesh = meshes[0]
    if identity_error(mesh.matrix_world) > 1e-7:
        raise RuntimeError("The authored source mesh has a non-identity object transform")
    mesh.name = "Aletheia_Chrome_Source_For_Skin_Zone_Diagnostic"
    return mesh


def validate_sidecar(
    mesh: bpy.types.Object,
) -> tuple[dict, dict[tuple[int, int, int], dict], dict]:
    """Validate schema, source lock, sorted keys, and exact hand coverage."""

    if not SKIN_ZONES.exists():
        raise FileNotFoundError(
            "Mechanical skin-zone sidecar is missing: "
            f"{SKIN_ZONES.relative_to(ROOT).as_posix()}"
        )

    source_digest = sha256(SOURCE)
    if source_digest != EXPECTED_SOURCE_SHA256:
        raise RuntimeError(
            "Aletheia source hash changed: "
            f"{source_digest} != {EXPECTED_SOURCE_SHA256}"
        )
    if len(mesh.data.vertices) != EXPECTED_SOURCE_RAW_VERTEX_COUNT:
        raise RuntimeError(
            "Unexpected source raw-vertex count: "
            f"{len(mesh.data.vertices)} != {EXPECTED_SOURCE_RAW_VERTEX_COUNT}"
        )

    source_groups: dict[tuple[int, int, int], list[int]] = {}
    source_coordinates: dict[tuple[int, int, int], Vector] = {}
    for vertex in mesh.data.vertices:
        key = position_key(vertex.co)
        source_groups.setdefault(key, []).append(vertex.index)
        source_coordinates.setdefault(key, vertex.co.copy())
    if len(source_groups) != EXPECTED_SOURCE_UNIQUE_POSITION_COUNT:
        raise RuntimeError(
            "Unexpected source unique-position count: "
            f"{len(source_groups)} != {EXPECTED_SOURCE_UNIQUE_POSITION_COUNT}"
        )

    hand_keys = {
        key
        for key, coordinate in source_coordinates.items()
        if coordinate.y >= HAND_REGION_MINIMUM_Y
    }
    hand_raw_count = sum(len(source_groups[key]) for key in hand_keys)
    side_unique_counts = {
        "left": sum(key[0] < 0 for key in hand_keys),
        "right": sum(key[0] >= 0 for key in hand_keys),
    }
    if hand_raw_count != EXPECTED_HAND_REGION_RAW_VERTEX_COUNT:
        raise RuntimeError(
            "Unexpected hand-region raw-vertex count: "
            f"{hand_raw_count} != {EXPECTED_HAND_REGION_RAW_VERTEX_COUNT}"
        )
    if len(hand_keys) != EXPECTED_HAND_REGION_UNIQUE_POSITION_COUNT:
        raise RuntimeError(
            "Unexpected hand-region unique-position count: "
            f"{len(hand_keys)} != {EXPECTED_HAND_REGION_UNIQUE_POSITION_COUNT}"
        )
    if side_unique_counts != EXPECTED_HAND_REGION_SIDE_UNIQUE_COUNTS:
        raise RuntimeError(
            "Unexpected hand-region per-side counts: "
            f"{side_unique_counts} != {EXPECTED_HAND_REGION_SIDE_UNIQUE_COUNTS}"
        )

    document = json.loads(SKIN_ZONES.read_text(encoding="utf-8"))
    required_top_level = {
        "schemaVersion",
        "source",
        "quantization",
        "handRegion",
        "jointPoints",
        "records",
    }
    allowed_top_level = required_top_level | {"evidenceSummary", "hingeAxes"}
    if not isinstance(document, dict):
        raise RuntimeError("Skin-zone sidecar root must be an object")
    if not required_top_level.issubset(document) or not set(document).issubset(
        allowed_top_level
    ):
        raise RuntimeError("Skin-zone sidecar has missing or unsupported top-level fields")
    if document["schemaVersion"] != SCHEMA_VERSION:
        raise RuntimeError(
            f"Unsupported skin-zone schema version: {document['schemaVersion']}"
        )
    if document["quantization"] != POSITION_QUANTIZATION:
        raise RuntimeError("Skin-zone coordinate quantization is not 1e6")

    expected_source = {
        "file": "assets/player/Aletheia_Chrome_1p_arms.glb",
        "sha256": EXPECTED_SOURCE_SHA256,
        "rawVertexCount": EXPECTED_SOURCE_RAW_VERTEX_COUNT,
        "uniquePositionCount": EXPECTED_SOURCE_UNIQUE_POSITION_COUNT,
    }
    if document["source"] != expected_source:
        raise RuntimeError("Skin-zone source metadata is stale or malformed")

    expected_hand_region = {
        "minimumY": HAND_REGION_MINIMUM_Y,
        "rawVertexCount": EXPECTED_HAND_REGION_RAW_VERTEX_COUNT,
        "uniquePositionCount": EXPECTED_HAND_REGION_UNIQUE_POSITION_COUNT,
        "leftUniquePositionCount": EXPECTED_HAND_REGION_SIDE_UNIQUE_COUNTS["left"],
        "rightUniquePositionCount": EXPECTED_HAND_REGION_SIDE_UNIQUE_COUNTS["right"],
    }
    if document["handRegion"] != expected_hand_region:
        raise RuntimeError("Skin-zone hand-region metadata is stale or malformed")
    if document["jointPoints"] != builder_joint_points():
        raise RuntimeError("Skin-zone joint points do not match the builder pivots")
    for optional_mapping in ("evidenceSummary", "hingeAxes"):
        if optional_mapping in document and not isinstance(
            document[optional_mapping], dict
        ):
            raise RuntimeError(f"Skin-zone {optional_mapping} must be an object")

    records = document["records"]
    if not isinstance(records, list):
        raise RuntimeError("Skin-zone records must be a list")
    record_by_key: dict[tuple[int, int, int], dict] = {}
    ordered_keys: list[tuple[int, int, int]] = []
    unique_counts: Counter[str] = Counter()
    required_fields = {"key", "side", "digit", "zone", "blend"}
    allowed_fields = required_fields | {"evidence"}
    for index, record in enumerate(records):
        if not isinstance(record, dict):
            raise RuntimeError(f"Skin-zone record {index} is not an object")
        if not required_fields.issubset(record) or not set(record).issubset(
            allowed_fields
        ):
            raise RuntimeError(f"Skin-zone record {index} has invalid fields")
        raw_key = record["key"]
        if (
            not isinstance(raw_key, list)
            or len(raw_key) != 3
            or any(type(component) is not int for component in raw_key)
        ):
            raise RuntimeError(f"Skin-zone record {index} has an invalid key")
        key = tuple(raw_key)
        if key in record_by_key:
            raise RuntimeError(f"Duplicate skin-zone key: {key}")
        if key not in hand_keys:
            raise RuntimeError(f"Skin-zone key is outside the exact hand region: {key}")

        side = record["side"]
        expected_side = "left" if key[0] < 0 else "right"
        if key[0] == 0 or side != expected_side:
            raise RuntimeError(
                f"Skin-zone key {key} declares inconsistent side {side!r}"
            )
        digit = record["digit"]
        zone = record["zone"]
        blend = record["blend"]
        if zone not in ZONES:
            raise RuntimeError(f"Skin-zone key {key} has invalid zone {zone!r}")
        if zone == "H":
            if digit is not None or blend is not None:
                raise RuntimeError(f"Hand-zone key {key} must have null digit/blend")
        else:
            if digit not in DIGITS:
                raise RuntimeError(
                    f"Digit-zone key {key} has invalid digit {digit!r}"
                )
            if zone.startswith("G"):
                if (
                    isinstance(blend, bool)
                    or not isinstance(blend, (int, float))
                    or not math.isfinite(float(blend))
                    or not 0.0 <= float(blend) <= 1.0
                ):
                    raise RuntimeError(f"Gasket-zone key {key} has invalid blend")
            elif blend is not None:
                raise RuntimeError(f"Rigid-zone key {key} must have null blend")
        if "evidence" in record and not isinstance(record["evidence"], dict):
            raise RuntimeError(f"Skin-zone key {key} has invalid evidence metadata")

        record_by_key[key] = record
        ordered_keys.append(key)
        unique_counts[f"{side}/{digit or 'hand'}/{zone}"] += 1

    if ordered_keys != sorted(ordered_keys):
        raise RuntimeError("Skin-zone records are not lexicographically key-sorted")
    if set(record_by_key) != hand_keys:
        missing = hand_keys - set(record_by_key)
        extra = set(record_by_key) - hand_keys
        raise RuntimeError(
            "Skin-zone records do not exactly cover the source hand region: "
            f"missing={len(missing)}, extra={len(extra)}"
        )

    required_zone_groups = {
        *(f"{side}/hand/H" for side in ("left", "right")),
        *(
            f"{side}/{digit}/{zone}"
            for side in ("left", "right")
            for digit in DIGITS
            for zone in ZONES[1:]
        ),
    }
    missing_groups = sorted(required_zone_groups - set(unique_counts))
    if missing_groups:
        raise RuntimeError(
            "Skin-zone map has empty required groups: " + ", ".join(missing_groups)
        )

    raw_counts: Counter[str] = Counter()
    for key, raw_indices in source_groups.items():
        if key not in record_by_key:
            continue
        record = record_by_key[key]
        label = f"{record['side']}/{record['digit'] or 'hand'}/{record['zone']}"
        raw_counts[label] += len(raw_indices)

    counts = {
        "uniquePositionCounts": dict(sorted(unique_counts.items())),
        "rawVertexCounts": dict(sorted(raw_counts.items())),
        "uniquePositionTotal": sum(unique_counts.values()),
        "rawVertexTotal": sum(raw_counts.values()),
    }
    return document, record_by_key, counts


def zone_color(record: dict) -> tuple[float, float, float, float]:
    zone = record["zone"]
    if zone == "H":
        return HAND_COLOR
    if zone.startswith("G"):
        return GASKET_COLORS[zone]
    return RIGID_COLORS[record["digit"]][zone]


def post_subdivision_counts(
    position_groups: dict[tuple[int, int, int], list[int]],
    records: dict[tuple[int, int, int], dict],
) -> dict:
    unique_counts: Counter[str] = Counter()
    raw_counts: Counter[str] = Counter()
    for key, record in records.items():
        label = f"{record['side']}/{record['digit'] or 'hand'}/{record['zone']}"
        unique_counts[label] += 1
        raw_counts[label] += len(position_groups[key])
    return {
        "uniquePositionCounts": dict(sorted(unique_counts.items())),
        "rawVertexCounts": dict(sorted(raw_counts.items())),
        "uniquePositionTotal": sum(unique_counts.values()),
        "rawVertexTotal": sum(raw_counts.values()),
    }


def rigid_bridge_summary(
    mesh: bpy.types.Object,
    record_by_key: dict[tuple[int, int, int], dict],
) -> dict[str, dict[str, float | int]]:
    """Report source faces that cross a hinge with no gasket vertex row."""

    vertex_keys = [position_key(vertex.co) for vertex in mesh.data.vertices]
    unique_edges: set[
        tuple[tuple[int, int, int], tuple[int, int, int]]
    ] = set()
    face_key_sets: list[set[tuple[int, int, int]]] = []
    for polygon in mesh.data.polygons:
        keys = [vertex_keys[index] for index in polygon.vertices]
        mapped = [key for key in keys if key in record_by_key]
        if len(mapped) != len(keys):
            continue
        face_key_sets.append(set(mapped))
        for index, first in enumerate(keys):
            second = keys[(index + 1) % len(keys)]
            if first == second:
                continue
            unique_edges.add(tuple(sorted((first, second))))

    result: dict[str, dict[str, float | int]] = {}
    for side in ("left", "right"):
        for digit in DIGITS:
            for joint_index in range(3):
                gasket_zone = f"G{joint_index}"

                def is_proximal(record: dict) -> bool:
                    if record["side"] != side:
                        return False
                    if joint_index == 0:
                        return record["zone"] == "H"
                    return (
                        record["digit"] == digit
                        and record["zone"] == f"S{joint_index - 1}"
                    )

                def is_distal(record: dict) -> bool:
                    return (
                        record["side"] == side
                        and record["digit"] == digit
                        and record["zone"] == f"S{joint_index}"
                    )

                bridge_edges = []
                for first, second in unique_edges:
                    first_record = record_by_key[first]
                    second_record = record_by_key[second]
                    if (
                        is_proximal(first_record)
                        and is_distal(second_record)
                    ) or (
                        is_proximal(second_record)
                        and is_distal(first_record)
                    ):
                        bridge_edges.append((first, second))
                bridge_faces = 0
                for keys in face_key_sets:
                    records = [record_by_key[key] for key in keys]
                    if any(is_proximal(record) for record in records) and any(
                        is_distal(record) for record in records
                    ):
                        bridge_faces += 1
                maximum_bridge_mm = max(
                    (
                        math.dist(first, second)
                        / POSITION_QUANTIZATION
                        * 1_000.0
                        for first, second in bridge_edges
                    ),
                    default=0.0,
                )
                gasket_count = sum(
                    record["side"] == side
                    and record["digit"] == digit
                    and record["zone"] == gasket_zone
                    for record in record_by_key.values()
                )
                result[f"{side}/{digit}/{gasket_zone}"] = {
                    "gasketUniquePositions": gasket_count,
                    "directRigidBridgeEdges": len(bridge_edges),
                    "directRigidBridgeFaces": bridge_faces,
                    "maximumBridgeEdgeMm": round(maximum_bridge_mm, 3),
                }
    return result


def isolated_colored_hand(
    source: bpy.types.Object,
    side: str,
    record_by_key: dict[tuple[int, int, int], dict],
) -> bpy.types.Object:
    """Copy one source hand without welding or splitting coordinate groups."""

    mesh = source.data.copy()
    mesh.name = f"Aletheia_{side.title()}_Skin_Zones_Geometry"
    obj = bpy.data.objects.new(f"Aletheia_{side.title()}_Skin_Zones", mesh)
    bpy.context.collection.objects.link(obj)

    isolated = bmesh.new()
    isolated.from_mesh(mesh)
    bmesh.ops.delete(
        isolated,
        geom=[
            vertex
            for vertex in isolated.verts
            if (
                position_key(vertex.co) not in record_by_key
                or record_by_key[position_key(vertex.co)]["side"] != side
            )
        ],
        context="VERTS",
    )
    isolated.to_mesh(mesh)
    isolated.free()
    mesh.update(calc_edges=True)

    for attribute in list(mesh.color_attributes):
        mesh.color_attributes.remove(attribute)
    color_attribute = mesh.color_attributes.new(
        name="Aletheia_Skin_Zone_Color",
        type="BYTE_COLOR",
        domain="CORNER",
    )

    colors_by_vertex: dict[int, tuple[float, float, float, float]] = {}
    colors_by_key: dict[
        tuple[int, int, int], tuple[float, float, float, float]
    ] = {}
    duplicate_counts: Counter[tuple[int, int, int]] = Counter()
    for vertex in mesh.vertices:
        key = position_key(vertex.co)
        record = record_by_key.get(key)
        if record is None or record["side"] != side:
            raise RuntimeError(f"Isolated {side} hand contains an unmapped vertex: {key}")
        color = zone_color(record)
        previous = colors_by_key.setdefault(key, color)
        if previous != color:
            raise RuntimeError(f"Coordinate duplicates disagree on zone color: {key}")
        colors_by_vertex[vertex.index] = color
        duplicate_counts[key] += 1

    for loop in mesh.loops:
        color_attribute.data[loop.index].color = colors_by_vertex[loop.vertex_index]
    mesh.color_attributes.active_color = color_attribute
    try:
        mesh.color_attributes.render_color_index = 0
    except AttributeError:
        pass

    # This is a deliberate invariant check rather than merely a consequence of
    # loop assignment: all source duplicates at a key resolve through one color.
    for key, duplicate_count in duplicate_counts.items():
        if duplicate_count <= 1:
            continue
        expected = colors_by_key[key]
        if any(
            colors_by_vertex[vertex.index] != expected
            for vertex in mesh.vertices
            if position_key(vertex.co) == key
        ):
            raise RuntimeError(f"Raw duplicates received different colors: {key}")

    obj.show_wire = False
    obj.show_all_edges = False
    return obj


def object_bounds(object_: bpy.types.Object) -> tuple[Vector, list[Vector]]:
    coordinates = [object_.matrix_world @ vertex.co for vertex in object_.data.vertices]
    if not coordinates:
        raise RuntimeError(f"{object_.name} has no vertices")
    minimum = Vector(
        tuple(min(coordinate[axis] for coordinate in coordinates) for axis in range(3))
    )
    maximum = Vector(
        tuple(max(coordinate[axis] for coordinate in coordinates) for axis in range(3))
    )
    return (minimum + maximum) * 0.5, coordinates


def frame_orthographic_camera(
    camera: bpy.types.Object,
    object_: bpy.types.Object,
    view_from_target: Vector,
    margin: float = 1.10,
) -> None:
    target, coordinates = object_bounds(object_)
    direction = view_from_target.normalized()
    camera.location = target + direction * 2.0
    rotation = (target - camera.location).to_track_quat("-Z", "Y")
    camera.rotation_euler = rotation.to_euler()
    camera_right = rotation @ Vector((1.0, 0.0, 0.0))
    camera_up = rotation @ Vector((0.0, 1.0, 0.0))
    horizontal = [coordinate.dot(camera_right) for coordinate in coordinates]
    vertical = [coordinate.dot(camera_up) for coordinate in coordinates]
    width = max(horizontal) - min(horizontal)
    height = max(vertical) - min(vertical)
    aspect = (
        bpy.context.scene.render.resolution_x
        / bpy.context.scene.render.resolution_y
    )
    camera.data.ortho_scale = max(height, width / aspect, 0.02) * margin


def configure_renderer() -> bpy.types.Object:
    scene = bpy.context.scene
    display_mode = os.environ.get("EANPA_SKIN_ZONE_DISPLAY", "zones").strip().lower()
    if display_mode in {"basecolor", "normal", "metallicroughness"}:
        scene.render.engine = "BLENDER_EEVEE_NEXT"
        scene.world.use_nodes = True
        background = scene.world.node_tree.nodes.get("Background")
        background.inputs["Color"].default_value = (0.018, 0.022, 0.032, 1.0)
        background.inputs["Strength"].default_value = 0.0
    elif display_mode == "zones":
        scene.render.engine = "BLENDER_WORKBENCH"
        scene.display.shading.light = "STUDIO"
        scene.display.shading.color_type = "VERTEX"
        scene.display.shading.show_shadows = False
        scene.display.shading.show_cavity = True
        scene.display.shading.cavity_type = "BOTH"
        scene.display.shading.show_specular_highlight = False
        scene.display.shading.background_type = "VIEWPORT"
        scene.display.shading.background_color = (0.018, 0.022, 0.032)
    else:
        raise RuntimeError(f"Unsupported EANPA_SKIN_ZONE_DISPLAY: {display_mode}")
    scene.render.resolution_x = 2048
    scene.render.resolution_y = 2048
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGB"
    scene.render.film_transparent = False

    camera_data = bpy.data.cameras.new("SkinZoneDiagnosticCamera")
    camera_data.type = "ORTHO"
    camera_data.clip_start = 0.01
    camera_data.clip_end = 10.0
    camera = bpy.data.objects.new("SkinZoneDiagnosticCamera", camera_data)
    bpy.context.collection.objects.link(camera)
    scene.camera = camera
    return camera


def emission_material(
    name: str,
    color: tuple[float, float, float, float],
) -> bpy.types.Material:
    material = bpy.data.materials.new(name)
    material.diffuse_color = color
    material.use_nodes = True
    nodes = material.node_tree.nodes
    nodes.clear()
    output = nodes.new("ShaderNodeOutputMaterial")
    emission = nodes.new("ShaderNodeEmission")
    emission.inputs["Color"].default_value = color
    emission.inputs["Strength"].default_value = 1.0
    material.node_tree.links.new(emission.outputs["Emission"], output.inputs["Surface"])
    return material


def use_basecolor_emission(hands: dict[str, bpy.types.Object]) -> None:
    seen_materials: set[int] = set()
    for hand in hands.values():
        for material in hand.data.materials:
            if (
                material is None
                or material.as_pointer() in seen_materials
                or not material.use_nodes
            ):
                continue
            seen_materials.add(material.as_pointer())
            nodes = material.node_tree.nodes
            image_node = next(
                (
                    node
                    for node in nodes
                    if node.type == "TEX_IMAGE"
                    and node.image is not None
                    and "basecolor"
                    in node.image.name.lower().replace("_", "").replace(" ", "")
                ),
                None,
            )
            if image_node is None:
                raise RuntimeError(f"No authored base-color image in {material.name}")
            output = next(node for node in nodes if node.type == "OUTPUT_MATERIAL")
            emission = nodes.new("ShaderNodeEmission")
            emission.inputs["Strength"].default_value = 1.0
            material.node_tree.links.new(
                image_node.outputs["Color"], emission.inputs["Color"]
            )
            material.node_tree.links.new(emission.outputs["Emission"], output.inputs["Surface"])


def use_authored_data_map_emission(
    hands: dict[str, bpy.types.Object],
    display_mode: str,
) -> None:
    """Show an authored non-color texture on the subdivided source UVs."""

    image_tokens = {
        "normal": "normal",
        "metallicroughness": "bakedmetallicroughness",
    }
    image_token = image_tokens.get(display_mode)
    if image_token is None:
        raise RuntimeError(f"Unsupported authored data-map display: {display_mode}")

    seen_materials: set[int] = set()
    for hand in hands.values():
        for material in hand.data.materials:
            if (
                material is None
                or material.as_pointer() in seen_materials
                or not material.use_nodes
            ):
                continue
            seen_materials.add(material.as_pointer())
            nodes = material.node_tree.nodes
            image_node = next(
                (
                    node
                    for node in nodes
                    if node.type == "TEX_IMAGE"
                    and node.image is not None
                    and image_token
                    in node.image.name.lower().replace("_", "").replace(" ", "")
                ),
                None,
            )
            if image_node is None:
                raise RuntimeError(
                    f"No authored {display_mode} image in {material.name}"
                )
            output = next(node for node in nodes if node.type == "OUTPUT_MATERIAL")
            emission = nodes.new("ShaderNodeEmission")
            emission.inputs["Strength"].default_value = 1.0
            material.node_tree.links.new(
                image_node.outputs["Color"], emission.inputs["Color"]
            )
            material.node_tree.links.new(
                emission.outputs["Emission"], output.inputs["Surface"]
            )


def topology_wire_overlay(
    hand: bpy.types.Object,
    side: str,
) -> bpy.types.Object:
    """Build renderable dark ribbons on every source edge.

    Workbench's viewport-only show_wire flag is not included in background
    renders, so the topology review uses a real non-deforming wireframe copy.
    """

    wire = hand.copy()
    wire.data = hand.data.copy()
    wire.name = f"Aletheia_{side.title()}_Skin_Zone_Topology"
    wire.data.name = f"{wire.name}_Geometry"
    bpy.context.collection.objects.link(wire)
    modifier = wire.modifiers.new(name="SourceTopologyEdges", type="WIREFRAME")
    modifier.thickness = 0.00016
    modifier.offset = 1.0
    modifier.use_even_offset = True
    modifier.use_replace = True
    bpy.ops.object.select_all(action="DESELECT")
    wire.select_set(True)
    bpy.context.view_layer.objects.active = wire
    bpy.ops.object.modifier_apply(modifier=modifier.name)

    for attribute in list(wire.data.color_attributes):
        wire.data.color_attributes.remove(attribute)
    edge_color = wire.data.color_attributes.new(
        name="Aletheia_Source_Topology_Color",
        type="BYTE_COLOR",
        domain="CORNER",
    )
    for item in edge_color.data:
        item.color = (0.002, 0.003, 0.006, 1.0)
    wire.data.color_attributes.active_color = edge_color
    try:
        wire.data.color_attributes.render_color_index = 0
    except AttributeError:
        pass
    wire.data.materials.clear()
    wire.data.materials.append(
        emission_material(f"{wire.name}_Material", (0.002, 0.003, 0.006, 1.0))
    )
    return wire


def render_views(
    camera: bpy.types.Object,
    hands: dict[str, bpy.types.Object],
) -> None:
    topology_overlay = os.environ.get("EANPA_SKIN_ZONE_TOPOLOGY", "0") == "1"
    display_mode = os.environ.get("EANPA_SKIN_ZONE_DISPLAY", "zones").strip().lower()
    wire_overlays: dict[str, bpy.types.Object] = {}
    if topology_overlay:
        wire_overlays = {
            side: topology_wire_overlay(hand, side)
            for side, hand in hands.items()
        }
    views = {
        "palm": Vector((0.0, 0.0, -1.0)),
        "back": Vector((0.0, 0.0, 1.0)),
    }
    OUT.mkdir(parents=True, exist_ok=True)
    for side, hand in hands.items():
        side_views = dict(views)
        side_views["side"] = Vector((1.0, 0.0, 0.0)) if side == "right" else Vector(
            (-1.0, 0.0, 0.0)
        )
        for object_ in hands.values():
            object_.hide_render = object_ is not hand
        for wire_side, wire in wire_overlays.items():
            wire.hide_render = wire_side != side
        for view_name, direction in side_views.items():
            frame_orthographic_camera(camera, hand, direction)
            suffix = "" if display_mode == "zones" else f"_{display_mode}"
            if topology_overlay:
                suffix += "_topology"
            bpy.context.scene.render.filepath = str(
                OUT / f"{side}_{view_name}{suffix}.png"
            )
            bpy.ops.render.render(write_still=True)
            print("FIRST_PERSON_SKIN_ZONE_RENDER", bpy.context.scene.render.filepath)


def main() -> None:
    reset_scene()
    source = imported_source_mesh()
    sidecar, source_records, source_counts = validate_sidecar(source)
    hinge_spec, hinge_provenance = load_hinge_spec(
        HINGE_SEAMS,
        expected_source_sha256=EXPECTED_SOURCE_SHA256,
        expected_source_raw_vertex_count=EXPECTED_SOURCE_RAW_VERTEX_COUNT,
        expected_source_triangle_count=EXPECTED_SOURCE_TRIANGLE_COUNT,
        expected_joint_points=builder_joint_points(),
    )
    position_groups, records, topology = subdivide_and_classify(
        source,
        hinge_spec=hinge_spec,
        source_zone_records=source_records,
        hand_region_minimum_y=HAND_REGION_MINIMUM_Y,
    )
    counts = post_subdivision_counts(position_groups, records)
    bridge_summary = rigid_bridge_summary(source, records)
    hands = {
        side: isolated_colored_hand(source, side, records)
        for side in ("left", "right")
    }
    display_mode = os.environ.get("EANPA_SKIN_ZONE_DISPLAY", "zones").strip().lower()
    if display_mode == "basecolor":
        use_basecolor_emission(hands)
    elif display_mode in {"normal", "metallicroughness"}:
        use_authored_data_map_emission(hands, display_mode)
    source.hide_render = True
    camera = configure_renderer()
    render_views(camera, hands)
    print("FIRST_PERSON_SKIN_ZONE_COUNTS", json.dumps(counts, sort_keys=True))
    print(
        "FIRST_PERSON_SKIN_ZONE_SOURCE_COUNTS",
        json.dumps(source_counts, sort_keys=True),
    )
    print(
        "FIRST_PERSON_HINGE_SEAM_PROVENANCE",
        json.dumps(hinge_provenance, sort_keys=True),
    )
    print(
        "FIRST_PERSON_SUBDIVIDED_TOPOLOGY",
        json.dumps(
            {key: value for key, value in topology.items() if key != "cuts"},
            sort_keys=True,
        ),
    )
    print(
        "FIRST_PERSON_SKIN_ZONE_RIGID_BRIDGES",
        json.dumps(bridge_summary, sort_keys=True),
    )
    print(
        "FIRST_PERSON_SKIN_ZONE_PALETTE",
        json.dumps(
            {
                "H": HAND_COLOR,
                "gaskets": GASKET_COLORS,
                "rigidSegments": RIGID_COLORS,
            },
            sort_keys=True,
        ),
    )


if __name__ == "__main__":
    main()
