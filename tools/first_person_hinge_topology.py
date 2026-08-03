#!/usr/bin/env python3
"""Measured seam topology for the Aletheia mechanical first-person hands.

The source GLB is a textured, unskinned triangle mesh.  Several visible finger
hinges pass through large triangles instead of following existing edge loops.
This module inserts three non-planar contours at every measured hinge:

* proximal gasket boundary (raw blend t=0)
* authored gasket center (raw blend t=0.5)
* distal gasket boundary (raw blend t=1)

The contours come from a source-hash-locked PBR/normal/geometry trace.  Chrome
outside the two boundary contours remains rigid.  Only vertices inside the
resulting narrow strip receive a two-bone blend.
"""

from __future__ import annotations

import copy
import hashlib
import json
import math
import os
from array import array
from pathlib import Path
from typing import Iterable

import bmesh
import numpy as np
from mathutils import Vector

from first_person_hinge_marching import (
    ContourRefinementError,
    insert_face_linear_contour,
    insert_face_local_contour,
)
from first_person_hinge_csp import solve_weighted_relations
from first_person_hinge_projection import (
    evaluate_joint_mapping,
    reparameterize_document,
)


SCHEMA_VERSION = 1
ANGLE_SAMPLE_COUNT = 32
SIDES = ("left", "right")
DIGITS = ("thumb", "index", "middle", "ring", "pinky")
GASKETS = ("G0", "G1", "G2")
CONTOUR_FIELDS = (
    ("proximal", "proximalBoundary", 0.0),
    ("center", "center", 0.5),
    ("distal", "distalBoundary", 1.0),
)
POSITION_QUANTIZATION = 1_000_000
MINIMUM_RIGID_GAP = 0.0005
DOMAIN_TIE_TOLERANCE = 1e-7
DOMAIN_AMBIGUITY_TOLERANCE = 0.02
CONTOUR_SCALAR_TOLERANCE = 2e-8
AFFINE_SCALAR_TOLERANCE = 1e-12
CONTOUR_CHORD_TOLERANCE = 0.00015
MAXIMUM_CHORD_REFINEMENT_DEPTH = 4
MAXIMUM_OVERLAP_EDGE_LENGTH = 0.006
SURFACE_FIELD_RADIAL_MARGIN = 1.15
SURFACE_FIELD_STATION_MARGIN = 0.015
CONTOUR_MARKER_LAYER_COUNT = 3
CONTOURS_PER_MARKER_LAYER = 30
MAXIMUM_RECORDED_ROOT_DISPLACEMENT = 1e-6
THUMB_ORDERED_FACE_OWNERS = {
    ("left", "G0"): {29478, 49193},
    ("left", "G1"): {49186},
    ("right", "G0"): {19162, 19204, 19206, 19209},
    ("right", "G1"): {1340, 1341, 1351, 19201, 19208},
}
THUMB_ORDERED_SOURCE_FACES = set().union(*THUMB_ORDERED_FACE_OWNERS.values())


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def position_key(coordinate: Iterable[float]) -> tuple[int, int, int]:
    return tuple(
        int(round(float(component) * POSITION_QUANTIZATION))
        for component in coordinate
    )


def _validate_fixed_frame_reparameterization(
    source_document: dict,
    effective_document: dict,
    audit: dict,
) -> dict:
    """Strictly validate the generated schema-2 continuous hinge frames."""

    root_record = effective_document.get("fixedFrameReparameterization")
    if not isinstance(root_record, dict) or root_record.get("schemaVersion") != 2:
        raise RuntimeError("Fixed-frame hinge reparameterization schema is invalid")
    if (
        audit.get("schemaVersion") != 2
        or audit.get("jointCount") != 30
        or audit.get("traceRecordCount") != 90
        or audit.get("angleSampleCount") != ANGLE_SAMPLE_COUNT
    ):
        raise RuntimeError("Fixed-frame hinge audit cardinality is invalid")
    scalar_gates = {
        "maximumFitResidualMeters": 2e-7,
        "maximumAdditionalSeparationCorrectionMeters": 1e-12,
        "maximumAngularGapRadians": math.pi * 0.5,
    }
    for name, maximum in scalar_gates.items():
        value = float(audit.get(name, math.inf))
        if not math.isfinite(value) or value > maximum:
            raise RuntimeError(f"Fixed-frame hinge audit failed {name}: {value}")
    for name in (
        "orderingViolationCount",
        "widthContractViolationCount",
        "adjacentGapViolationCount",
    ):
        if int(audit.get(name, -1)) != 0:
            raise RuntimeError(f"Fixed-frame hinge audit failed {name}")

    projection_count = 0
    for side in SIDES:
        for digit in DIGITS:
            source_digit = source_document["seams"][side][digit]
            effective_digit = effective_document["seams"][side][digit]
            if effective_digit["chainPoints"] != source_digit["chainPoints"]:
                raise RuntimeError(
                    f"{side} {digit} fixed frames changed canonical chain points"
                )
            for gasket_index, gasket in enumerate(GASKETS):
                joint = effective_digit["joints"][gasket]
                projection = joint.get("fixedFrameProjection")
                if (
                    not isinstance(projection, dict)
                    or projection.get("schemaVersion") != 2
                    or projection.get("gasket") != gasket
                ):
                    raise RuntimeError(
                        f"{side} {digit} {gasket} fixed projection is malformed"
                    )
                if projection.get("anchorPoint") != source_digit["chainPoints"][
                    gasket_index
                ]:
                    raise RuntimeError(
                        f"{side} {digit} {gasket} fixed anchor changed"
                    )
                basis = [
                    Vector(projection[name])
                    for name in ("tangent", "axisU", "axisV")
                ]
                if any(
                    not math.isclose(vector.length, 1.0, abs_tol=2e-7)
                    for vector in basis
                ) or any(
                    abs(basis[first].dot(basis[second])) > 2e-7
                    for first, second in ((0, 1), (0, 2), (1, 2))
                ):
                    raise RuntimeError(
                        f"{side} {digit} {gasket} fixed basis is not orthonormal"
                    )
                source_traces = projection.get("sourceEffectiveTraces")
                if not isinstance(source_traces, dict):
                    raise RuntimeError(
                        f"{side} {digit} {gasket} lacks effective source traces"
                    )
                for field in ("proximal", "center", "distal"):
                    values = source_traces.get(field)
                    if (
                        not isinstance(values, list)
                        or len(values) != ANGLE_SAMPLE_COUNT
                        or any(not math.isfinite(float(value)) for value in values)
                    ):
                        raise RuntimeError(
                            f"{side} {digit} {gasket} {field} runtime trace is invalid"
                        )
                mapping = projection.get("mapping")
                if not isinstance(mapping, dict) or mapping.get("schemaVersion") != 1:
                    raise RuntimeError(
                        f"{side} {digit} {gasket} irregular mapping is invalid"
                    )
                arrays = [
                    mapping.get(name)
                    for name in (
                        "fixedAnglesRadians",
                        "oldAnglesRadians",
                        "stationShiftsMeters",
                    )
                ]
                sample_count = len(arrays[0]) if isinstance(arrays[0], list) else 0
                if (
                    sample_count < 3
                    or any(not isinstance(values, list) for values in arrays)
                    or any(len(values) != sample_count for values in arrays)
                    or mapping.get("mapSampleCount") != sample_count
                    or any(
                        not math.isfinite(float(value))
                        for values in arrays
                        for value in values
                    )
                    or any(
                        float(arrays[0][index]) >= float(arrays[0][index + 1])
                        for index in range(sample_count - 1)
                    )
                ):
                    raise RuntimeError(
                        f"{side} {digit} {gasket} irregular mapping arrays are malformed"
                    )
                correction = mapping.get("stationCorrectionByFixedAngleMeters")
                if correction and any(abs(float(value)) > 1e-12 for value in correction):
                    raise RuntimeError(
                        f"{side} {digit} {gasket} has an unapproved station correction"
                    )
                projection_count += 1
    if projection_count != 30:
        raise RuntimeError("Fixed-frame hinge projection set is incomplete")

    return {
        "schemaVersion": 2,
        "jointProjectionCount": projection_count,
        "traceRecordCount": audit["traceRecordCount"],
        "maximumFitResidualMeters": audit["maximumFitResidualMeters"],
        "orderingViolationCount": audit["orderingViolationCount"],
        "widthContractViolationCount": audit["widthContractViolationCount"],
        "adjacentGapViolationCount": audit["adjacentGapViolationCount"],
        "maximumAdditionalSeparationCorrectionMeters": audit[
            "maximumAdditionalSeparationCorrectionMeters"
        ],
        "maximumAngularGapRadians": audit["maximumAngularGapRadians"],
        "maximumAngularGapDegrees": audit["maximumAngularGapDegrees"],
        "pivotRelocations": audit.get("pivotRelocations", []),
        "largeG0PivotOffsets": audit.get("largeG0PivotOffsets", []),
    }


def load_hinge_spec(
    path: Path,
    *,
    expected_source_sha256: str,
    expected_source_raw_vertex_count: int,
    expected_source_triangle_count: int,
    expected_joint_points: dict,
) -> tuple[dict, dict]:
    """Load and strictly validate the measured non-planar hinge specification."""

    document = json.loads(path.read_text(encoding="utf-8"))
    if document.get("schemaVersion") != SCHEMA_VERSION:
        raise RuntimeError("Unsupported Aletheia hinge-seam schema")
    if document.get("angleSampleCount") != ANGLE_SAMPLE_COUNT:
        raise RuntimeError("Aletheia hinge-seam angle sample count changed")
    expected_angles = [
        math.tau * index / ANGLE_SAMPLE_COUNT
        for index in range(ANGLE_SAMPLE_COUNT)
    ]
    actual_angles = document.get("angleSamplesRadians")
    if (
        not isinstance(actual_angles, list)
        or len(actual_angles) != ANGLE_SAMPLE_COUNT
        or any(
            not math.isclose(float(actual), expected, abs_tol=1e-12)
            for actual, expected in zip(actual_angles, expected_angles)
        )
    ):
        raise RuntimeError("Aletheia hinge-seam angular coordinates are malformed")

    expected_source = {
        "file": "assets/player/Aletheia_Chrome_1p_arms.glb",
        "sha256": expected_source_sha256,
        "rawVertexCount": expected_source_raw_vertex_count,
        "rawTriangleCount": expected_source_triangle_count,
    }
    if document.get("source") != expected_source:
        raise RuntimeError("Aletheia hinge-seam source lock is stale or malformed")
    normalized_joint_points = json.loads(json.dumps(expected_joint_points))
    if document.get("jointPoints") != normalized_joint_points:
        raise RuntimeError("Aletheia hinge-seam joint points do not match the rig")

    seams = document.get("seams")
    if not isinstance(seams, dict) or set(seams) != set(SIDES):
        raise RuntimeError("Aletheia hinge-seam sides are incomplete")
    validated_joint_count = 0
    contour_segment_count = 0
    for side in SIDES:
        side_document = seams[side]
        if not isinstance(side_document, dict) or set(side_document) != set(DIGITS):
            raise RuntimeError(f"Aletheia hinge-seam digits are incomplete on {side}")
        for digit in DIGITS:
            digit_document = side_document[digit]
            chain_points = digit_document.get("chainPoints")
            if chain_points != normalized_joint_points[side][digit]:
                raise RuntimeError(f"{side} {digit} hinge chain is stale")
            radial_limit = digit_document.get("radialLimit")
            if (
                isinstance(radial_limit, bool)
                or not isinstance(radial_limit, (int, float))
                or not 0.02 <= float(radial_limit) <= 0.10
            ):
                raise RuntimeError(f"{side} {digit} has an invalid radial limit")
            joints = digit_document.get("joints")
            if not isinstance(joints, dict) or set(joints) != set(GASKETS):
                raise RuntimeError(f"{side} {digit} hinge records are incomplete")
            for gasket in GASKETS:
                joint = joints[gasket]
                arrays = {}
                for field in ("proximal", "center", "distal", "halfWidth"):
                    values = joint.get(field)
                    if (
                        not isinstance(values, list)
                        or len(values) != ANGLE_SAMPLE_COUNT
                        or any(
                            isinstance(value, bool)
                            or not isinstance(value, (int, float))
                            or not math.isfinite(float(value))
                            for value in values
                        )
                    ):
                        raise RuntimeError(
                            f"{side} {digit} {gasket} {field} trace is malformed"
                        )
                    arrays[field] = [float(value) for value in values]
                for index, (proximal, center, distal, half_width) in enumerate(
                    zip(
                        arrays["proximal"],
                        arrays["center"],
                        arrays["distal"],
                        arrays["halfWidth"],
                    )
                ):
                    width = distal - proximal
                    if (
                        proximal > center + 1e-10
                        or center > distal + 1e-10
                        or not 0.0009 <= width <= 0.0081
                        or not math.isclose(
                            half_width, width * 0.5, rel_tol=0.0, abs_tol=1e-9
                        )
                    ):
                        raise RuntimeError(
                            f"{side} {digit} {gasket} sample {index} has "
                            "an invalid measured gasket envelope"
                        )
                contours = joint.get("contours")
                if not isinstance(contours, list) or len(contours) != 3:
                    raise RuntimeError(
                        f"{side} {digit} {gasket} must contain three contours"
                    )
                expected_contours = {
                    role: blend for _field, role, blend in CONTOUR_FIELDS
                }
                actual_contours = {}
                for contour in contours:
                    role = contour.get("role")
                    blend = contour.get("rawBlendT")
                    if role in actual_contours or role not in expected_contours:
                        raise RuntimeError(
                            f"{side} {digit} {gasket} contour roles are malformed"
                        )
                    if not math.isclose(
                        float(blend), expected_contours[role], abs_tol=1e-12
                    ):
                        raise RuntimeError(
                            f"{side} {digit} {gasket} {role} blend is malformed"
                        )
                    segments = contour.get("segments")
                    if not isinstance(segments, list):
                        raise RuntimeError(
                            f"{side} {digit} {gasket} {role} has no face segments"
                        )
                    contour_segment_count += len(segments)
                    actual_contours[role] = float(blend)
                if actual_contours != expected_contours:
                    raise RuntimeError(
                        f"{side} {digit} {gasket} contour set is incomplete"
                    )
                validated_joint_count += 1

    if validated_joint_count != 30:
        raise RuntimeError("Aletheia hinge-seam specification is incomplete")

    provenance = {
        "file": "assets/player/Aletheia_Chrome_1p_arms_hinge_seams.json",
        "sha256": _sha256(path),
        "schemaVersion": SCHEMA_VERSION,
        "sourceSha256": expected_source_sha256,
        "angleSampleCount": ANGLE_SAMPLE_COUNT,
        "jointCount": validated_joint_count,
        "contoursPerJoint": 3,
        "recordedSourceFaceSegments": contour_segment_count,
    }
    fixed_document, fixed_audit = reparameterize_document(document)
    provenance["fixedFrameReparameterization"] = (
        _validate_fixed_frame_reparameterization(
            document,
            fixed_document,
            fixed_audit,
        )
    )
    return document, provenance


def project_coordinate(
    coordinate: Vector | Iterable[float],
    chain_points: list[list[float]] | tuple[tuple[float, float, float], ...],
) -> tuple[float, float, float]:
    """Project one point to a four-point digit chain.

    Returns longitudinal station, radial distance, and the periodic surface
    angle used by the measured seam traces.
    """

    point = Vector(coordinate)
    chain = [Vector(value) for value in chain_points]
    lengths = [(chain[index + 1] - chain[index]).length for index in range(3)]
    arcs = (0.0, lengths[0], lengths[0] + lengths[1], sum(lengths))
    best_radial = math.inf
    best_station = 0.0
    best_center = chain[0]
    best_tangent = (chain[1] - chain[0]).normalized()
    for index in range(3):
        start = chain[index]
        direction = chain[index + 1] - start
        length_squared = direction.length_squared
        raw = (point - start).dot(direction) / length_squared
        clamped = max(0.0, min(1.0, raw))
        if index == 0 and raw < 0.0:
            clamped = raw
        elif index == 2 and raw > 1.0:
            clamped = raw
        center = start + direction * clamped
        radial = (point - center).length
        if radial < best_radial:
            best_radial = radial
            best_station = arcs[index] + clamped * lengths[index]
            best_center = center
            best_tangent = direction.normalized()

    radial_vector = point - best_center
    axis_u = best_tangent.cross(Vector((0.0, 0.0, 1.0)))
    if axis_u.length < 1e-10:
        axis_u = best_tangent.cross(Vector((1.0, 0.0, 0.0)))
    axis_u.normalize()
    axis_v = best_tangent.cross(axis_u).normalized()
    angle = math.atan2(radial_vector.dot(axis_v), radial_vector.dot(axis_u))
    return best_station, best_radial, angle % math.tau


def trace_value(values: list[float], angle: float) -> float:
    scaled = (angle % math.tau) / math.tau * len(values)
    first = int(math.floor(scaled)) % len(values)
    fraction = scaled - math.floor(scaled)
    second = (first + 1) % len(values)
    return float(values[first]) * (1.0 - fraction) + float(values[second]) * fraction


def _normalized_radial_candidates(
    coordinate: Vector,
    side_document: dict,
) -> list[tuple[float, int, str]]:
    candidates = []
    for order, digit in enumerate(DIGITS):
        digit_document = side_document[digit]
        _station, radial, _angle = project_coordinate(
            coordinate, digit_document["chainPoints"]
        )
        candidates.append(
            (radial / float(digit_document["radialLimit"]), order, digit)
        )
    return sorted(candidates)


def _digit_domain_owner(
    coordinate: Vector,
    side_document: dict,
) -> tuple[str, float, float, bool]:
    """Return the deterministic nearest normalized-radial digit domain."""

    candidates = _normalized_radial_candidates(coordinate, side_document)
    best = candidates[0]
    second = candidates[1]
    return (
        best[2],
        best[0],
        second[0],
        second[0] - best[0] <= DOMAIN_TIE_TOLERANCE,
    )


def _separate_adjacent_joint_traces(hinge_spec: dict) -> tuple[dict, list[dict]]:
    """Shift overlapping envelopes apart without changing gasket widths.

    The coarse source triangles make the thumb G0/G1 chords cross even though
    one vertex may never carry both joint blends.  A small symmetric station
    shift preserves each measured envelope while guaranteeing a rigid interval
    between adjacent joints at every periodic trace sample.
    """

    separated = copy.deepcopy(hinge_spec)
    adjustment_totals: dict[tuple[str, str, str, str], dict] = {}
    for _pass in range(6):
        changed = False
        for side in SIDES:
            for digit in DIGITS:
                joints = separated["seams"][side][digit]["joints"]
                for proximal_name, distal_name in zip(GASKETS, GASKETS[1:]):
                    proximal_joint = joints[proximal_name]
                    distal_joint = joints[distal_name]
                    for sample in range(ANGLE_SAMPLE_COUNT):
                        gap = (
                            float(distal_joint["proximal"][sample])
                            - float(proximal_joint["distal"][sample])
                        )
                        if gap >= MINIMUM_RIGID_GAP - 1e-12:
                            continue
                        changed = True
                        shift = (MINIMUM_RIGID_GAP - gap) * 0.5
                        for field in ("proximal", "center", "distal"):
                            proximal_joint[field][sample] = (
                                float(proximal_joint[field][sample]) - shift
                            )
                            distal_joint[field][sample] = (
                                float(distal_joint[field][sample]) + shift
                            )
                        key = (side, digit, proximal_name, distal_name)
                        record = adjustment_totals.setdefault(
                            key,
                            {
                                "side": side,
                                "digit": digit,
                                "proximalJoint": proximal_name,
                                "distalJoint": distal_name,
                                "adjustedSamples": set(),
                                "maximumOneSidedShift": 0.0,
                            },
                        )
                        record["adjustedSamples"].add(sample)
                        record["maximumOneSidedShift"] = max(
                            record["maximumOneSidedShift"], shift
                        )
        if not changed:
            break
    else:
        raise RuntimeError("Adjacent hinge trace separation did not converge")

    for side in SIDES:
        for digit in DIGITS:
            joints = separated["seams"][side][digit]["joints"]
            for proximal_name, distal_name in zip(GASKETS, GASKETS[1:]):
                for sample in range(ANGLE_SAMPLE_COUNT):
                    gap = (
                        float(joints[distal_name]["proximal"][sample])
                        - float(joints[proximal_name]["distal"][sample])
                    )
                    if gap < MINIMUM_RIGID_GAP - 1e-10:
                        raise RuntimeError(
                            f"{side} {digit} {proximal_name}/{distal_name} "
                            f"sample {sample} retains an overlapping envelope"
                        )

    adjustments = []
    for record in adjustment_totals.values():
        adjustments.append(
            {
                **record,
                "adjustedSamples": sorted(record["adjustedSamples"]),
                "maximumOneSidedShift": record["maximumOneSidedShift"],
            }
        )
    return separated, sorted(
        adjustments,
        key=lambda value: (
            value["side"],
            value["digit"],
            value["proximalJoint"],
        ),
    )


def _adaptive_subdivide_overlap_faces(
    bm: bmesh.types.BMesh,
    hinge_spec: dict,
) -> dict:
    """Refine coarse source faces shared by different joint contours.

    A persistent source-face layer is assigned before any split, so subsequent
    refinement never relies on stale BMesh indices.  Each round re-evaluates
    the child geometry inherited from the original overlap faces.
    """

    overlap_records = hinge_spec.get("crossSeamFaceOverlaps", [])
    overlap_indices = {
        int(record["faceIndex"])
        for record in overlap_records
        if isinstance(record, dict) and "faceIndex" in record
    }
    source_face_layer = bm.faces.layers.int.get("hinge_source_face")
    if source_face_layer is None:
        source_face_layer = bm.faces.layers.int.new("hinge_source_face")
    bm.faces.ensure_lookup_table()
    bm.faces.index_update()
    for face in bm.faces:
        face[source_face_layer] = face.index

    rounds = []
    for depth in range(MAXIMUM_CHORD_REFINEMENT_DEPTH):
        target_faces = [
            face
            for face in bm.faces
            if face.is_valid
            and face[source_face_layer] in overlap_indices
            and max((edge.calc_length() for edge in face.edges), default=0.0)
            > MAXIMUM_OVERLAP_EDGE_LENGTH
        ]
        if not target_faces:
            break
        target_edges = {
            edge
            for face in target_faces
            for edge in face.edges
            if edge.is_valid
        }
        before_vertices = len(bm.verts)
        before_faces = len(bm.faces)
        bmesh.ops.subdivide_edges(
            bm,
            edges=list(target_edges),
            cuts=1,
            use_grid_fill=True,
        )
        bm.verts.index_update()
        bm.edges.index_update()
        bm.faces.index_update()
        rounds.append(
            {
                "depth": depth + 1,
                "refinedSourceFaceChildren": len(target_faces),
                "splitEdges": len(target_edges),
                "insertedVertices": len(bm.verts) - before_vertices,
                "insertedFaces": len(bm.faces) - before_faces,
            }
        )

    remaining_long_faces = sum(
        face.is_valid
        and face[source_face_layer] in overlap_indices
        and max((edge.calc_length() for edge in face.edges), default=0.0)
        > MAXIMUM_OVERLAP_EDGE_LENGTH
        for face in bm.faces
    )
    return {
        "sourceOverlapFaceCount": len(overlap_indices),
        "maximumChildEdgeLength": MAXIMUM_OVERLAP_EDGE_LENGTH,
        "rounds": rounds,
        "remainingLongOverlapFaceCount": remaining_long_faces,
        "sourceFaceIdentityLayer": "hinge_source_face",
    }


def _project_joint_coordinate(
    coordinate: Vector,
    digit_document: dict,
    joint_document: dict,
) -> tuple[float, float, float]:
    """Project through one continuous fixed joint frame when available."""

    projection = joint_document.get("fixedFrameProjection")
    if projection is None:
        return project_coordinate(coordinate, digit_document["chainPoints"])
    point = Vector(coordinate)
    anchor = Vector(projection["anchorPoint"])
    tangent = Vector(projection["tangent"])
    axis_u = Vector(projection["axisU"])
    axis_v = Vector(projection["axisV"])
    relative = point - anchor
    axial_offset = relative.dot(tangent)
    radial_vector = relative - tangent * axial_offset
    station = float(projection["anchorArcMeters"]) + axial_offset
    radial = radial_vector.length
    angle = math.atan2(radial_vector.dot(axis_v), radial_vector.dot(axis_u))
    return station, radial, angle % math.tau


def _joint_trace_value(
    joint_document: dict,
    field: str,
    fixed_angle: float,
) -> float:
    """Evaluate the exact irregular fixed-frame trace, not its 32-sample view."""

    projection = joint_document.get("fixedFrameProjection")
    if projection is None:
        return trace_value(joint_document[field], fixed_angle)
    mapped_angle, station_shift = evaluate_joint_mapping(
        projection["mapping"],
        fixed_angle,
    )
    return (
        trace_value(projection["sourceEffectiveTraces"][field], mapped_angle)
        + station_shift
    )


def _initialize_source_surface(bm: bmesh.types.BMesh) -> dict:
    """Capture immutable raw source triangles before any topology operation."""

    bm.verts.ensure_lookup_table()
    bm.faces.ensure_lookup_table()
    bm.verts.index_update()
    bm.faces.index_update()
    source_face_layer = bm.faces.layers.int.get("hinge_source_face")
    if source_face_layer is None:
        source_face_layer = bm.faces.layers.int.new("hinge_source_face")

    vertices = {}
    welded_coordinates = {}
    raw_vertex_to_welded_key = {}
    for vertex in bm.verts:
        coordinate = vertex.co.copy()
        # Source scalar welding must not merge distinct vertices merely because
        # the public topology audit collapses them to a 1-micron display key.
        # Nine decimal places preserves the GLB's authored float coordinates
        # while still unifying exact UV/custom-normal copies.
        key = tuple(round(float(component), 9) for component in coordinate)
        vertices[int(vertex.index)] = coordinate
        raw_vertex_to_welded_key[int(vertex.index)] = key
        welded_coordinates.setdefault(key, coordinate)

    faces = {}
    for face in bm.faces:
        if len(face.verts) != 3:
            raise RuntimeError(
                "Aletheia source surface must remain triangulated before hinge cuts"
            )
        source_index = int(face.index)
        face[source_face_layer] = source_index
        raw_vertex_indices = [int(vertex.index) for vertex in face.verts]
        coordinates = [vertices[index].copy() for index in raw_vertex_indices]
        origin = coordinates[0]
        first_edge = coordinates[1] - origin
        second_edge = coordinates[2] - origin
        gram_00 = first_edge.dot(first_edge)
        gram_01 = first_edge.dot(second_edge)
        gram_11 = second_edge.dot(second_edge)
        determinant = gram_00 * gram_11 - gram_01 * gram_01
        if abs(determinant) <= 1e-24:
            raise RuntimeError(
                f"Degenerate immutable source triangle {source_index}"
            )
        faces[source_index] = {
            "rawVertexIndices": raw_vertex_indices,
            "coordinates": coordinates,
            "origin": origin,
            "dualFirst": (
                first_edge * gram_11 - second_edge * gram_01
            ) / determinant,
            "dualSecond": (
                second_edge * gram_00 - first_edge * gram_01
            ) / determinant,
        }

    welded_edge_faces = {}
    welded_edge_coordinates = {}
    for source_face_index, source_face in faces.items():
        coordinates = source_face["coordinates"]
        for first_offset, second_offset in ((0, 1), (1, 2), (2, 0)):
            first_key = position_key(coordinates[first_offset])
            second_key = position_key(coordinates[second_offset])
            edge_key = tuple(sorted((first_key, second_key)))
            welded_edge_faces.setdefault(edge_key, set()).add(source_face_index)
            welded_edge_coordinates.setdefault(
                edge_key,
                (
                    coordinates[first_offset].copy(),
                    coordinates[second_offset].copy(),
                ),
            )
    boundary_graph = {}
    boundary_edge_keys = [
        edge_key
        for edge_key, linked_faces in welded_edge_faces.items()
        if len(linked_faces) == 1
    ]
    for first_key, second_key in boundary_edge_keys:
        boundary_graph.setdefault(first_key, set()).add(second_key)
        boundary_graph.setdefault(second_key, set()).add(first_key)
    boundary_component_by_vertex = {}
    unseen_boundary_vertices = set(boundary_graph)
    component_index = 0
    while unseen_boundary_vertices:
        seed = min(unseen_boundary_vertices)
        stack = [seed]
        while stack:
            key = stack.pop()
            if key in boundary_component_by_vertex:
                continue
            boundary_component_by_vertex[key] = component_index
            unseen_boundary_vertices.discard(key)
            stack.extend(boundary_graph[key])
        component_index += 1
    boundary_edges = []
    for edge_key in boundary_edge_keys:
        first_key, second_key = edge_key
        first_coordinate, second_coordinate = welded_edge_coordinates[edge_key]
        boundary_edges.append(
            {
                "first": first_coordinate,
                "second": second_coordinate,
                "component": boundary_component_by_vertex[first_key],
            }
        )

    return {
        "sourceFaceLayer": source_face_layer,
        "vertices": vertices,
        "weldedCoordinates": welded_coordinates,
        "rawVertexToWeldedKey": raw_vertex_to_welded_key,
        "faces": faces,
        "boundaryEdges": boundary_edges,
        "boundaryComponentCount": component_index,
        "weldedEdgeFaces": welded_edge_faces,
        "weldedEdgeCoordinates": welded_edge_coordinates,
    }


def _legacy_source_scalar(
    coordinate: Vector,
    digit_document: dict,
    values: list[float],
) -> float:
    """Evaluate the authored legacy field only at immutable source vertices."""

    station, _radial, angle = project_coordinate(
        coordinate,
        digit_document["chainPoints"],
    )
    return station - trace_value(values, angle)


def _build_source_digit_domains(
    source_surface: dict,
    *,
    effective_spec: dict,
    source_zone_records: dict,
) -> dict:
    """Assign each immutable source face to one normalized-radial digit."""

    owner_by_face = {}
    tie_count = 0
    unanimous_evidence_count = 0
    for source_face_index, source_face in source_surface["faces"].items():
        records = [
            source_zone_records.get(position_key(coordinate))
            for coordinate in source_face["coordinates"]
        ]
        authored_owners = {
            (record.get("side"), record.get("digit"))
            for record in records
            if record is not None
        }
        if (
            all(record is not None for record in records)
            and len(authored_owners) == 1
            and next(iter(authored_owners))[1] is not None
        ):
            # Authored per-vertex evidence outranks the centroid metric: a
            # face whose source vertices unanimously prove one (side, digit)
            # belongs to that digit even when another chain is radially
            # nearer (web-adjacent knuckle faces otherwise misassign).
            owner_by_face[source_face_index] = next(iter(authored_owners))
            unanimous_evidence_count += 1
            continue
        center = sum(source_face["coordinates"], Vector()) / 3.0
        side = "left" if center.x < 0.0 else "right"
        side_document = effective_spec["seams"][side]
        candidates = []
        for digit in DIGITS:
            digit_document = side_document[digit]
            _station, radial, _angle = project_coordinate(
                center,
                digit_document["chainPoints"],
            )
            candidates.append(
                (
                    radial / float(digit_document["radialLimit"]),
                    DIGITS.index(digit),
                    digit,
                )
            )
        candidates.sort()
        tied_digits = [
            item[2]
            for item in candidates
            if item[0] - candidates[0][0] <= 1e-7
        ]
        if len(tied_digits) > 1:
            tie_count += 1
            votes = {digit: 0 for digit in tied_digits}
            for record in records:
                if record is not None and record.get("digit") in votes:
                    votes[record["digit"]] += 1
            owner = min(
                tied_digits,
                key=lambda digit: (-votes[digit], DIGITS.index(digit)),
            )
        else:
            owner = candidates[0][2]
        owner_by_face[source_face_index] = (side, owner)

    boundary_edges = {}
    for side in SIDES:
        for digit in DIGITS:
            selected_edges = []
            for edge_key, linked_faces in source_surface[
                "weldedEdgeFaces"
            ].items():
                owned_faces = [
                    source_face_index
                    for source_face_index in linked_faces
                    if owner_by_face[source_face_index] == (side, digit)
                ]
                if not owned_faces:
                    continue
                if len(owned_faces) == len(linked_faces) and len(linked_faces) > 1:
                    continue
                selected_edges.append(edge_key)
            graph = {}
            for first_key, second_key in selected_edges:
                graph.setdefault(first_key, set()).add(second_key)
                graph.setdefault(second_key, set()).add(first_key)
            component_by_key = {}
            unseen = set(graph)
            component_index = 0
            while unseen:
                seed = min(unseen)
                stack = [seed]
                while stack:
                    key = stack.pop()
                    if key in component_by_key:
                        continue
                    component_by_key[key] = component_index
                    unseen.discard(key)
                    stack.extend(graph[key])
                component_index += 1
            records = []
            for edge_key in selected_edges:
                first_key, _second_key = edge_key
                first, second = source_surface["weldedEdgeCoordinates"][edge_key]
                records.append(
                    {
                        "first": first.copy(),
                        "second": second.copy(),
                        "component": component_by_key[first_key],
                    }
                )
            boundary_edges[(side, digit)] = records

    source_surface["digitOwnerByFace"] = owner_by_face
    source_surface["digitBoundaryEdges"] = boundary_edges
    return {
        "schemaVersion": 1,
        "metric": (
            "unanimous authored (side, digit) vertex evidence, then "
            "source-face centroid chain radial / digit radialLimit"
        ),
        "tieTolerance": 1e-7,
        "tieBreak": "source-zone vertex vote, then DIGITS declaration order",
        "sourceFaceCount": len(owner_by_face),
        "unanimousEvidenceFaceCount": unanimous_evidence_count,
        "tieFaceCount": tie_count,
        "boundaryEdgeCounts": {
            f"{side}/{digit}": len(boundary_edges[(side, digit)])
            for side in SIDES
            for digit in DIGITS
        },
    }


def _face_domain_boundary_edges(
    source_surface: dict,
    selected_source_faces: set[int],
) -> list[dict]:
    """Return shell/internal boundary components of one routed face domain."""

    selected_edges = []
    for edge_key, linked_faces in source_surface["weldedEdgeFaces"].items():
        selected_count = sum(
            source_face_index in selected_source_faces
            for source_face_index in linked_faces
        )
        if selected_count and (
            selected_count < len(linked_faces) or len(linked_faces) == 1
        ):
            selected_edges.append(edge_key)
    graph = {}
    for first_key, second_key in selected_edges:
        graph.setdefault(first_key, set()).add(second_key)
        graph.setdefault(second_key, set()).add(first_key)
    component_by_key = {}
    unseen = set(graph)
    component_index = 0
    while unseen:
        seed = min(unseen)
        stack = [seed]
        while stack:
            key = stack.pop()
            if key in component_by_key:
                continue
            component_by_key[key] = component_index
            unseen.discard(key)
            stack.extend(graph[key])
        component_index += 1
    records = []
    for edge_key in selected_edges:
        first_key, _second_key = edge_key
        first, second = source_surface["weldedEdgeCoordinates"][edge_key]
        records.append(
            {
                "first": first.copy(),
                "second": second.copy(),
                "component": component_by_key[first_key],
                "edgeKey": edge_key,
                "linkedSourceFaces": tuple(
                    sorted(source_surface["weldedEdgeFaces"][edge_key])
                ),
            }
        )
    return records


def _affine_source_face_record(
    coordinates: list[Vector],
    values: list[float],
) -> dict:
    """Return an in-plane affine interpolant through three source values."""

    origin = coordinates[0]
    first_edge = coordinates[1] - origin
    second_edge = coordinates[2] - origin
    gram_00 = first_edge.dot(first_edge)
    gram_01 = first_edge.dot(second_edge)
    gram_11 = second_edge.dot(second_edge)
    determinant = gram_00 * gram_11 - gram_01 * gram_01
    if abs(determinant) <= 1e-24:
        raise RuntimeError("Degenerate source triangle in hinge surface field")
    first_delta = float(values[1]) - float(values[0])
    second_delta = float(values[2]) - float(values[0])
    first_coefficient = (
        first_delta * gram_11 - second_delta * gram_01
    ) / determinant
    second_coefficient = (
        second_delta * gram_00 - first_delta * gram_01
    ) / determinant
    gradient = (
        first_edge * first_coefficient
        + second_edge * second_coefficient
    )
    maximum_vertex_residual = max(
        abs(
            float(values[index])
            - (
                float(values[0])
                + (coordinates[index] - origin).dot(gradient)
            )
        )
        for index in range(3)
    )
    if maximum_vertex_residual > 1e-9:
        raise RuntimeError(
            "Source-face affine interpolation exceeded its vertex residual gate"
        )
    return {
        "origin": origin.copy(),
        "originValue": float(values[0]),
        "gradient": gradient,
        "maximumVertexResidual": maximum_vertex_residual,
    }


def _evaluate_affine_source_face(record: dict, coordinate: Vector) -> float:
    return float(record["originValue"]) + (
        Vector(coordinate) - record["origin"]
    ).dot(record["gradient"])


def _surface_field_contour_document(joint_document: dict, field: str) -> dict:
    role = next(
        role
        for candidate_field, role, _blend in CONTOUR_FIELDS
        if candidate_field == field
    )
    return next(
        contour
        for contour in joint_document["contours"]
        if contour["role"] == role
    )


def _recorded_root_audit(
    contour_document: dict,
    *,
    source_surface: dict,
    raw_vertex_scalars,
    included_source_faces: set[int] | None = None,
) -> dict:
    maximum_scalar_residual = 0.0
    maximum_root_displacement = 0.0
    maximum_position_residual = 0.0
    maximum_root_position_displacement = 0.0
    maximum_root_position_evidence = None
    missing_bracket_count = 0
    audited_intersections = 0
    excluded_segment_count = 0
    for segment in contour_document["segments"]:
        source_face_index = int(segment["faceIndex"])
        if (
            included_source_faces is not None
            and source_face_index not in included_source_faces
        ):
            excluded_segment_count += 1
            continue
        source_face = source_surface["faces"].get(source_face_index)
        if source_face is None:
            raise RuntimeError(
                f"Recorded hinge segment references source face {source_face_index} "
                "outside the immutable mesh"
            )
        if set(int(value) for value in segment["rawVertexIndices"]) != set(
            source_face["rawVertexIndices"]
        ):
            raise RuntimeError(
                f"Recorded hinge segment/source face {source_face_index} vertex "
                "identity mismatch"
            )
        for intersection in segment["intersections"]:
            first_index, second_index = (
                int(value) for value in intersection["edgeRawVertexIndices"]
            )
            first_value = float(raw_vertex_scalars[first_index])
            second_value = float(raw_vertex_scalars[second_index])
            alpha = float(intersection["alphaFromFirst"])
            residual = abs((1.0 - alpha) * first_value + alpha * second_value)
            maximum_scalar_residual = max(maximum_scalar_residual, residual)
            first_coordinate = source_surface["vertices"][first_index]
            second_coordinate = source_surface["vertices"][second_index]
            recorded_coordinate = Vector(intersection["position"])
            interpolated_coordinate = first_coordinate.lerp(
                second_coordinate,
                alpha,
            )
            maximum_position_residual = max(
                maximum_position_residual,
                (interpolated_coordinate - recorded_coordinate).length,
            )
            denominator = first_value - second_value
            if abs(denominator) <= 1e-14:
                missing_bracket_count += 1
            else:
                root_alpha = first_value / denominator
                if not -1e-8 <= root_alpha <= 1.0 + 1e-8:
                    missing_bracket_count += 1
                maximum_root_displacement = max(
                    maximum_root_displacement,
                    abs(root_alpha - alpha)
                    * (second_coordinate - first_coordinate).length,
                )
                root_coordinate = first_coordinate.lerp(
                    second_coordinate,
                    root_alpha,
                )
                root_position_displacement = (
                    root_coordinate - recorded_coordinate
                ).length
                if (
                    root_position_displacement
                    > maximum_root_position_displacement
                ):
                    maximum_root_position_displacement = (
                        root_position_displacement
                    )
                    maximum_root_position_evidence = {
                        "sourceFaceIndex": source_face_index,
                        "edgeRawVertexIndices": [first_index, second_index],
                    }
            audited_intersections += 1
    return {
        "recordedIntersectionCount": audited_intersections,
        "maximumRecordedScalarResidualMeters": maximum_scalar_residual,
        "maximumRecordedRootDisplacementMeters": maximum_root_displacement,
        "maximumRecordedPositionResidualMeters": maximum_position_residual,
        "maximumRecordedRootPositionDisplacementMeters": (
            maximum_root_position_displacement
        ),
        "maximumRecordedRootPositionEvidence": (
            maximum_root_position_evidence
        ),
        "missingRecordedRootBracketCount": missing_bracket_count,
        "excludedRecordedSegmentCount": excluded_segment_count,
    }


def _fit_recorded_edge_roots(
    contour_document: dict,
    *,
    source_surface: dict,
    raw_vertex_scalars,
    excluded_source_faces: set[int],
) -> tuple[array, dict]:
    """Project rounded recorded edge roots onto a consistent signed P1 field.

    The authored raw scalar supplies immutable signs and the magnitude anchor.
    Each recorded edge root supplies a linear equation in log magnitude.  A
    least-squares projection removes tiny rounded-alpha cycle inconsistencies
    without changing any sign or introducing an interior nonlinear field.
    """

    edge_alphas = {}
    edge_raw_indices = {}
    excluded_segment_count = 0
    for segment in contour_document["segments"]:
        if int(segment["faceIndex"]) in excluded_source_faces:
            excluded_segment_count += 1
            continue
        for intersection in segment["intersections"]:
            first_index, second_index = (
                int(value) for value in intersection["edgeRawVertexIndices"]
            )
            first_key = source_surface["rawVertexToWeldedKey"][first_index]
            second_key = source_surface["rawVertexToWeldedKey"][second_index]
            alpha = float(intersection["alphaFromFirst"])
            if second_key < first_key:
                first_key, second_key = second_key, first_key
                first_index, second_index = second_index, first_index
                alpha = 1.0 - alpha
            edge_key = (first_key, second_key)
            edge_alphas.setdefault(edge_key, []).append(alpha)
            edge_raw_indices.setdefault(
                edge_key,
                (first_index, second_index),
            )

    welded_raw_values = {}
    welded_raw_indices = {}
    for raw_vertex_index, coordinate in source_surface["vertices"].items():
        key = source_surface["rawVertexToWeldedKey"][raw_vertex_index]
        welded_raw_values.setdefault(key, []).append(
            float(raw_vertex_scalars[raw_vertex_index])
        )
        welded_raw_indices.setdefault(key, []).append(raw_vertex_index)
    raw_value_by_key = {
        key: sum(values) / len(values)
        for key, values in welded_raw_values.items()
    }

    constraints = []
    duplicate_alpha_spread = 0.0
    sign_violation_count = 0
    graph = {}
    for edge_key in sorted(edge_alphas):
        alphas = edge_alphas[edge_key]
        duplicate_alpha_spread = max(
            duplicate_alpha_spread,
            max(alphas) - min(alphas),
        )
        alpha = sum(alphas) / len(alphas)
        first_key, second_key = edge_key
        first_value = raw_value_by_key[first_key]
        second_value = raw_value_by_key[second_key]
        if first_value == 0.0 or second_value == 0.0 or (
            first_value < 0.0
        ) == (second_value < 0.0):
            sign_violation_count += 1
            continue
        if not 0.0 < alpha < 1.0:
            raise RuntimeError("Recorded hinge root alpha lies outside its edge")
        constraint = {
            "first": first_key,
            "second": second_key,
            "alpha": alpha,
            "logRatio": math.log((1.0 - alpha) / alpha),
            "rawIndices": edge_raw_indices[edge_key],
        }
        constraints.append(constraint)
        graph.setdefault(first_key, set()).add(second_key)
        graph.setdefault(second_key, set()).add(first_key)
    if sign_violation_count:
        raise RuntimeError(
            f"Raw authored scalar fails {sign_violation_count} recorded-root "
            "sign constraints"
        )

    corrected_by_key = {}
    fitted_log_magnitude = {}
    component_count = 0
    unseen = set(graph)
    while unseen:
        seed = min(unseen)
        stack = [seed]
        component_nodes = set()
        while stack:
            key = stack.pop()
            if key in component_nodes:
                continue
            component_nodes.add(key)
            unseen.discard(key)
            stack.extend(graph[key] - component_nodes)
        nodes = sorted(component_nodes)
        node_index = {key: index for index, key in enumerate(nodes)}
        component_constraints = [
            item
            for item in constraints
            if item["first"] in component_nodes
            and item["second"] in component_nodes
        ]
        matrix = np.zeros(
            (len(component_constraints) + 1, len(nodes)),
            dtype=np.float64,
        )
        target = np.zeros(len(component_constraints) + 1, dtype=np.float64)
        for row, constraint in enumerate(component_constraints):
            matrix[row, node_index[constraint["first"]]] = -1.0
            matrix[row, node_index[constraint["second"]]] = 1.0
            target[row] = constraint["logRatio"]
        matrix[-1, 0] = 1.0
        magnitudes, _residuals, _rank, _singular = np.linalg.lstsq(
            matrix,
            target,
            rcond=None,
        )
        offset = sum(
            math.log(max(abs(raw_value_by_key[key]), 1e-30))
            - float(magnitudes[node_index[key]])
            for key in nodes
        ) / len(nodes)
        for key in nodes:
            magnitude = float(magnitudes[node_index[key]]) + offset
            fitted_log_magnitude[key] = magnitude
            raw_value = raw_value_by_key[key]
            corrected_by_key[key] = math.copysign(math.exp(magnitude), raw_value)
        component_count += 1

    corrected = array("d", raw_vertex_scalars)
    for key, value in corrected_by_key.items():
        for raw_vertex_index in welded_raw_indices[key]:
            corrected[raw_vertex_index] = value

    maximum_root_displacement = 0.0
    maximum_log_equation_residual = 0.0
    for constraint in constraints:
        first_magnitude = fitted_log_magnitude[constraint["first"]]
        second_magnitude = fitted_log_magnitude[constraint["second"]]
        fitted_alpha = 1.0 / (
            1.0 + math.exp(second_magnitude - first_magnitude)
        )
        first_index, second_index = constraint["rawIndices"]
        edge_length = (
            source_surface["vertices"][second_index]
            - source_surface["vertices"][first_index]
        ).length
        maximum_root_displacement = max(
            maximum_root_displacement,
            abs(fitted_alpha - constraint["alpha"]) * edge_length,
        )
        maximum_log_equation_residual = max(
            maximum_log_equation_residual,
            abs(
                second_magnitude
                - first_magnitude
                - constraint["logRatio"]
            ),
        )
    if maximum_root_displacement > MAXIMUM_RECORDED_ROOT_DISPLACEMENT:
        raise RuntimeError(
            "Recorded-root least-squares fit exceeds the contour gate: "
            f"{maximum_root_displacement} m"
        )
    return corrected, {
        "schemaVersion": 1,
        "method": (
            "signed log-magnitude least squares on welded recorded edges; "
            "raw authored signs and nearest raw-magnitude component offset"
        ),
        "exclusionRule": (
            "recorded source face absent from the final digit-domain and "
            "ordered-thumb routed contour"
        ),
        "excludedSourceFaceCount": len(excluded_source_faces),
        # Compatibility spelling retained for downstream manifests.
        "excludedOverlapSourceFaceCount": len(excluded_source_faces),
        "excludedRecordedSegmentCount": excluded_segment_count,
        "uniqueConstraintEdgeCount": len(constraints),
        "constraintComponentCount": component_count,
        "rawSignViolationCount": sign_violation_count,
        "maximumDuplicateAlphaSpread": duplicate_alpha_spread,
        "maximumLogEquationResidual": maximum_log_equation_residual,
        "maximumFittedRootDisplacementMeters": maximum_root_displacement,
        "maximumFittedRootDisplacementGateMeters": (
            MAXIMUM_RECORDED_ROOT_DISPLACEMENT
        ),
    }


def _evaluate_surface_field_face(
    surface_field: dict,
    source_surface: dict,
    source_face_index: int,
    coordinate: Vector,
) -> float:
    face = source_surface["faces"][int(source_face_index)]
    raw_indices = face["rawVertexIndices"]
    scalars = surface_field["rawVertexScalars"]
    first_value = float(scalars[raw_indices[0]])
    second_value = float(scalars[raw_indices[1]])
    third_value = float(scalars[raw_indices[2]])
    relative = Vector(coordinate) - face["origin"]
    first_barycentric = relative.dot(face["dualFirst"])
    second_barycentric = relative.dot(face["dualSecond"])
    return (
        first_value
        + first_barycentric * (second_value - first_value)
        + second_barycentric * (third_value - first_value)
    )


def _source_edge_root(
    source_surface: dict,
    raw_vertex_scalars,
    first_index: int,
    second_index: int,
):
    first_value = float(raw_vertex_scalars[first_index])
    second_value = float(raw_vertex_scalars[second_index])
    first_sign = (
        -1 if first_value < -AFFINE_SCALAR_TOLERANCE
        else 1 if first_value > AFFINE_SCALAR_TOLERANCE
        else 0
    )
    second_sign = (
        -1 if second_value < -AFFINE_SCALAR_TOLERANCE
        else 1 if second_value > AFFINE_SCALAR_TOLERANCE
        else 0
    )
    if first_sign == 0 and second_sign == 0:
        return "zero-edge", None
    if first_sign == 0:
        return (
            "root",
            (
                "vertex",
                source_surface["rawVertexToWeldedKey"][first_index],
            ),
        )
    elif second_sign == 0:
        return (
            "root",
            (
                "vertex",
                source_surface["rawVertexToWeldedKey"][second_index],
            ),
        )
    elif first_sign == second_sign:
        return None, None
    first_key = source_surface["rawVertexToWeldedKey"][first_index]
    second_key = source_surface["rawVertexToWeldedKey"][second_index]
    return "root", ("edge",) + tuple(sorted((first_key, second_key)))


def _select_surface_zero_component(
    surface_field: dict,
    *,
    source_surface: dict,
    recorded_source_faces: set[int],
) -> dict:
    """Select the affine zero component with maximum recorded-face overlap."""

    sign = -1.0 if surface_field["side"] == "left" else 1.0
    graph: dict[tuple[int, int, int], set[tuple[int, int, int]]] = {}
    segment_faces = []
    zero_edge_face_count = 0
    multi_root_face_count = 0
    for source_face_index, source_face in source_surface["faces"].items():
        coordinates = source_face["coordinates"]
        if (
            max(coordinate.x * sign for coordinate in coordinates) <= 0.0
            or max(coordinate.y for coordinate in coordinates) < 0.615
        ):
            continue
        indices = source_face["rawVertexIndices"]
        roots = set()
        has_zero_edge = False
        for first_offset, second_offset in ((0, 1), (1, 2), (2, 0)):
            kind, root = _source_edge_root(
                source_surface,
                surface_field["rawVertexScalars"],
                indices[first_offset],
                indices[second_offset],
            )
            if kind == "zero-edge":
                has_zero_edge = True
            elif kind == "root":
                roots.add(root)
        if has_zero_edge:
            zero_edge_face_count += 1
        if len(roots) > 2:
            multi_root_face_count += 1
            continue
        if len(roots) != 2:
            continue
        first_root, second_root = sorted(roots)
        graph.setdefault(first_root, set()).add(second_root)
        graph.setdefault(second_root, set()).add(first_root)
        segment_faces.append((first_root, second_root, source_face_index))

    components = []
    unseen = set(graph)
    while unseen:
        seed = min(unseen)
        stack = [seed]
        nodes = set()
        while stack:
            node = stack.pop()
            if node in nodes:
                continue
            nodes.add(node)
            unseen.discard(node)
            stack.extend(graph[node] - nodes)
        faces = {
            source_face_index
            for first_root, second_root, source_face_index in segment_faces
            if first_root in nodes and second_root in nodes
        }
        overlap = faces & recorded_source_faces
        components.append(
            {
                "nodes": nodes,
                "faces": faces,
                "recordedOverlap": overlap,
                "closed": (
                    len(nodes) >= 3
                    and all(len(graph[node]) == 2 for node in nodes)
                ),
                "degreeHistogram": {
                    str(degree): sum(
                        len(graph[node]) == degree for node in nodes
                    )
                    for degree in sorted({len(graph[node]) for node in nodes})
                },
            }
        )
    if not components:
        raise RuntimeError(
            f"{surface_field['side']} {surface_field['digit']} "
            f"{surface_field['gasket']} {surface_field['field']} has no affine "
            "zero component"
        )
    components.sort(
        key=lambda item: (
            len(item["recordedOverlap"]),
            item["closed"],
            len(item["nodes"]),
        ),
        reverse=True,
    )
    selected = components[0]
    return {
        "selectedSourceFaces": selected["faces"],
        "componentCount": len(components),
        "selectedClosed": selected["closed"],
        "selectedCollapsedVertexCount": len(selected["nodes"]),
        "selectedSourceFaceCount": len(selected["faces"]),
        "recordedSourceFaceCount": len(recorded_source_faces),
        "selectedRecordedFaceOverlapCount": len(selected["recordedOverlap"]),
        "selectedRecordedFaceCoverage": (
            len(selected["recordedOverlap"])
            / max(len(recorded_source_faces), 1)
        ),
        "selectedDegreeHistogram": selected["degreeHistogram"],
        "extraComponentCount": max(len(components) - 1, 0),
        "extraClosedComponentCount": sum(
            item["closed"] for item in components[1:]
        ),
        "zeroEdgeFaceCount": zero_edge_face_count,
        "multiRootFaceCount": multi_root_face_count,
    }


def _canonical_source_edge_roots(
    surface_field: dict,
    source_surface: dict,
) -> tuple[dict, dict]:
    """Weld geometric copies of each selected source-edge root coordinate."""

    grouped_coordinates = {}
    for source_face_index in surface_field["selectedSourceFaces"]:
        source_face = source_surface["faces"][source_face_index]
        indices = source_face["rawVertexIndices"]
        for first_offset, second_offset in ((0, 1), (1, 2), (2, 0)):
            first_index = indices[first_offset]
            second_index = indices[second_offset]
            first_value = float(surface_field["rawVertexScalars"][first_index])
            second_value = float(surface_field["rawVertexScalars"][second_index])
            if first_value == 0.0:
                factor = 0.0
            elif second_value == 0.0:
                factor = 1.0
            elif (first_value < 0.0) == (second_value < 0.0):
                continue
            else:
                factor = first_value / (first_value - second_value)
            first_key = source_surface["rawVertexToWeldedKey"][first_index]
            second_key = source_surface["rawVertexToWeldedKey"][second_index]
            edge_key = tuple(sorted((first_key, second_key)))
            coordinate = source_surface["vertices"][first_index].lerp(
                source_surface["vertices"][second_index],
                factor,
            )
            grouped_coordinates.setdefault(edge_key, []).append(coordinate)

    canonical = {}
    maximum_copy_disagreement = 0.0
    for edge_key, coordinates in grouped_coordinates.items():
        coordinate = sum(coordinates, Vector()) / len(coordinates)
        canonical[edge_key] = coordinate
        maximum_copy_disagreement = max(
            maximum_copy_disagreement,
            max((item - coordinate).length for item in coordinates),
        )
    return canonical, {
        "canonicalSourceEdgeRootCount": len(canonical),
        "maximumGeometricCopyRootDisagreementMeters": (
            maximum_copy_disagreement
        ),
    }


def _audit_routed_surface_components(
    surface_field: dict,
    source_surface: dict,
) -> dict:
    graph = {}
    for source_face_index in surface_field["selectedSourceFaces"]:
        source_face = source_surface["faces"][source_face_index]
        indices = source_face["rawVertexIndices"]
        roots = set()
        for first_offset, second_offset in ((0, 1), (1, 2), (2, 0)):
            kind, root = _source_edge_root(
                source_surface,
                surface_field["rawVertexScalars"],
                indices[first_offset],
                indices[second_offset],
            )
            if kind == "root":
                roots.add(root)
        if len(roots) != 2:
            continue
        first, second = sorted(roots)
        graph.setdefault(first, set()).add(second)
        graph.setdefault(second, set()).add(first)
    components = []
    unseen = set(graph)
    while unseen:
        seed = min(unseen)
        stack = [seed]
        nodes = set()
        while stack:
            node = stack.pop()
            if node in nodes:
                continue
            nodes.add(node)
            unseen.discard(node)
            stack.extend(graph[node] - nodes)
        endpoints = sum(len(graph[node]) == 1 for node in nodes)
        absolute = len(nodes) >= 3 and all(
            len(graph[node]) == 2 for node in nodes
        )
        relative = (
            endpoints == 2
            and all(len(graph[node]) in {1, 2} for node in nodes)
        )
        components.append(
            {
                "vertexCount": len(nodes),
                "endpointCount": endpoints,
                "absolute": absolute,
                "relative": relative,
            }
        )
    return {
        "routedComponentCount": len(components),
        "routedAbsoluteComponentCount": sum(
            item["absolute"] for item in components
        ),
        "routedRelativeComponentCount": sum(
            item["relative"] for item in components
        ),
        "routedInvalidComponentCount": sum(
            not (item["absolute"] or item["relative"])
            for item in components
        ),
        "routedEndpointCount": sum(item["endpointCount"] for item in components),
        "routedComponents": components,
    }


def _resolve_source_edge_root(
    *,
    face: bmesh.types.BMFace,
    edge: bmesh.types.BMEdge,
    coordinate: Vector,
    source_face_layer,
    surface_field: dict,
) -> Vector:
    source_surface = surface_field["sourceSurface"]
    source_face_index = int(face[source_face_layer])
    source_face = source_surface["faces"][source_face_index]
    indices = source_face["rawVertexIndices"]
    best = None
    for first_offset, second_offset in ((0, 1), (1, 2), (2, 0)):
        first_index = indices[first_offset]
        second_index = indices[second_offset]
        first_coordinate = source_surface["vertices"][first_index]
        second_coordinate = source_surface["vertices"][second_index]
        distance = _point_segment_distance(
            coordinate,
            first_coordinate,
            second_coordinate,
        )
        if best is None or distance < best[0]:
            first_key = source_surface["rawVertexToWeldedKey"][first_index]
            second_key = source_surface["rawVertexToWeldedKey"][second_index]
            best = (
                distance,
                tuple(sorted((first_key, second_key))),
            )
    if best is None or best[0] > 1e-6:
        return coordinate
    canonical = surface_field["canonicalSourceEdgeRoots"].get(best[1])
    if canonical is None:
        return coordinate
    direction = edge.verts[1].co - edge.verts[0].co
    factor = (
        (canonical - edge.verts[0].co).dot(direction)
        / max(direction.length_squared, 1e-30)
    )
    if not -1e-5 <= factor <= 1.0 + 1e-5:
        return coordinate
    return canonical.copy()


def _route_surface_field_faces(
    component_faces: set[int],
    *,
    source_surface: dict,
    side: str,
    digit: str,
    gasket: str,
) -> tuple[set[int], dict]:
    """Clip one raw-sign component to its immutable digit domain.

    Adjacent thumb-gasket ownership cannot be decided independently while a
    field is built: it is a relation between the complete G0 and G1 triplet
    corridors.  `_synchronize_thumb_gasket_corridors` applies that relation
    after all 90 raw P1 fields exist.
    """

    full_component_faces = set(component_faces)
    routed_faces = {
        source_face_index
        for source_face_index in full_component_faces
        if source_surface["digitOwnerByFace"][source_face_index]
        == (side, digit)
    }
    digit_clipped_count = len(full_component_faces) - len(routed_faces)
    return routed_faces, {
        "fullSelectedSourceFaceCount": len(full_component_faces),
        "digitDomainClippedSourceFaceCount": digit_clipped_count,
        "thumbOrderedClippedSourceFaceCount": 0,
        "thumbOrderedRouting": {
            "applied": False,
            "deferredToTripletSynchronization": (
                digit == "thumb" and gasket in {"G0", "G1"}
            ),
            "selectionRule": (
                "complete raw-P1 adjacent-gasket corridor partition"
            ),
            "ownedOverlapSourceFaces": [],
        },
    }


def _build_surface_field(
    *,
    source_surface: dict,
    source_digit_document: dict,
    source_joint_document: dict,
    effective_digit_document: dict,
    effective_joint_document: dict,
    side: str,
    digit: str,
    gasket: str,
    field: str,
    excluded_source_faces: set[int],
) -> dict:
    """Cache one continuous P1 scalar field on immutable source triangles."""

    projection = effective_joint_document["fixedFrameProjection"]
    effective_source_values = projection["sourceEffectiveTraces"][field]
    raw_source_values = source_joint_document[field]
    recorded_contour = _surface_field_contour_document(
        effective_joint_document,
        field,
    )
    recorded_source_faces = {
        int(segment["faceIndex"])
        for segment in recorded_contour["segments"]
    }

    effective_welded_scalars = {}
    raw_welded_scalars = {}
    for key, coordinate in source_surface["weldedCoordinates"].items():
        effective_welded_scalars[key] = _legacy_source_scalar(
            coordinate,
            effective_digit_document,
            effective_source_values,
        )
        raw_welded_scalars[key] = _legacy_source_scalar(
            coordinate,
            source_digit_document,
            raw_source_values,
        )

    vertex_count = len(source_surface["vertices"])
    if max(source_surface["vertices"], default=-1) != vertex_count - 1:
        raise RuntimeError("Immutable source vertex indices are not contiguous")
    raw_vertex_scalars = array("d", [0.0]) * vertex_count
    effective_vertex_scalars = array("d", [0.0]) * vertex_count
    for raw_vertex_index in range(vertex_count):
        welded_key = source_surface["rawVertexToWeldedKey"][raw_vertex_index]
        raw_vertex_scalars[raw_vertex_index] = raw_welded_scalars[welded_key]
        effective_vertex_scalars[raw_vertex_index] = effective_welded_scalars[
            welded_key
        ]

    unconstrained_raw_audit = _recorded_root_audit(
        recorded_contour,
        source_surface=source_surface,
        raw_vertex_scalars=raw_vertex_scalars,
    )
    unfitted_raw_vertex_scalars = array("d", raw_vertex_scalars)
    surface_field = {
        "side": side,
        "digit": digit,
        "gasket": gasket,
        "field": field,
        # Sample the original generator scalar only at immutable source
        # vertices.  Its signs choose the zero component and final routed faces
        # before retained recorded roots constrain the magnitudes.
        "rawVertexScalars": raw_vertex_scalars,
        "unfittedRawVertexScalars": unfitted_raw_vertex_scalars,
        "effectiveVertexScalars": effective_vertex_scalars,
        "recordedContourDocument": recorded_contour,
        "recordedSourceFaces": recorded_source_faces,
        "unconstrainedRawRecordedRootAudit": unconstrained_raw_audit,
        "canonicalOverlapSourceFaceCount": len(excluded_source_faces),
    }
    initial_component = _select_surface_zero_component(
        surface_field,
        source_surface=source_surface,
        recorded_source_faces=recorded_source_faces,
    )
    initial_component_faces = set(initial_component["selectedSourceFaces"])
    initial_routed_faces, _initial_route_audit = _route_surface_field_faces(
        initial_component_faces,
        source_surface=source_surface,
        side=side,
        digit=digit,
        gasket=gasket,
    )
    route_excluded_recorded_faces = (
        recorded_source_faces - initial_routed_faces
    )
    fitted_vertex_scalars, recorded_root_fit = _fit_recorded_edge_roots(
        recorded_contour,
        source_surface=source_surface,
        raw_vertex_scalars=raw_vertex_scalars,
        excluded_source_faces=route_excluded_recorded_faces,
    )
    surface_field["rawVertexScalars"] = fitted_vertex_scalars
    final_component = _select_surface_zero_component(
        surface_field,
        source_surface=source_surface,
        recorded_source_faces=recorded_source_faces,
    )
    final_component_faces = set(final_component["selectedSourceFaces"])
    final_routed_faces, final_route_audit = _route_surface_field_faces(
        final_component_faces,
        source_surface=source_surface,
        side=side,
        digit=digit,
        gasket=gasket,
    )
    component_symmetric_difference = (
        initial_component_faces ^ final_component_faces
    )
    routed_symmetric_difference = initial_routed_faces ^ final_routed_faces
    if component_symmetric_difference or routed_symmetric_difference:
        raise RuntimeError(
            f"{side} {digit} {gasket} {field} route-aware recorded-root "
            "refit changed the selected contour topology"
        )

    surface_field.update(final_component)
    surface_field.update(final_route_audit)
    surface_field["sourceZeroComponentFaces"] = final_component_faces
    surface_field["selectedSourceFaces"] = final_routed_faces
    surface_field["routeAwareRefit"] = {
        "selectionScalar": "unfitted raw authored signs",
        "retainedRecordedSourceFaceCount": len(
            recorded_source_faces - route_excluded_recorded_faces
        ),
        "excludedRecordedSourceFaceCount": len(
            route_excluded_recorded_faces
        ),
        "componentFaceSymmetricDifferenceCount": len(
            component_symmetric_difference
        ),
        "routedFaceSymmetricDifferenceCount": len(
            routed_symmetric_difference
        ),
    }
    surface_field["recordedRootLeastSquaresFit"] = recorded_root_fit
    surface_field["rawRecordedRootAudit"] = _recorded_root_audit(
        recorded_contour,
        source_surface=source_surface,
        raw_vertex_scalars=fitted_vertex_scalars,
    )
    surface_field["retainedRecordedRootAudit"] = _recorded_root_audit(
        recorded_contour,
        source_surface=source_surface,
        raw_vertex_scalars=fitted_vertex_scalars,
        included_source_faces=final_routed_faces,
    )
    surface_field["intentionallyExcludedRecordedRootAudit"] = (
        _recorded_root_audit(
            recorded_contour,
            source_surface=source_surface,
            raw_vertex_scalars=fitted_vertex_scalars,
            included_source_faces=route_excluded_recorded_faces,
        )
    )
    surface_field["effectiveRecordedRootAudit"] = _recorded_root_audit(
        recorded_contour,
        source_surface=source_surface,
        raw_vertex_scalars=effective_vertex_scalars,
    )
    surface_field["relativeBoundaryEdges"] = _face_domain_boundary_edges(
        source_surface,
        surface_field["selectedSourceFaces"],
    )
    surface_field.update(
        _audit_routed_surface_components(surface_field, source_surface)
    )
    canonical_roots, canonical_root_audit = _canonical_source_edge_roots(
        surface_field,
        source_surface,
    )
    surface_field["canonicalSourceEdgeRoots"] = canonical_roots
    surface_field["canonicalSourceEdgeRootAudit"] = canonical_root_audit
    surface_field["candidateSourceFaceCount"] = len(
        surface_field["selectedSourceFaces"]
    )
    return surface_field


def _synchronize_thumb_gasket_corridors(
    fields: dict,
    *,
    source_surface: dict,
    effective_spec: dict,
) -> dict:
    """Give each thumb gasket one triplet corridor, then order G0/G1.

    The partition is evaluated from the cached raw affine fields on immutable
    source triangles.  Legacy authored face owners are regression evidence
    only: they must agree with the derived result, but never select a face.
    """

    def retained_root_coordinates(
        contour_document: dict,
        raw_vertex_scalars,
        included_source_faces: set[int],
    ) -> dict:
        coordinates = {}
        for segment_offset, segment in enumerate(
            contour_document["segments"]
        ):
            if int(segment["faceIndex"]) not in included_source_faces:
                continue
            for intersection_offset, intersection in enumerate(
                segment["intersections"]
            ):
                first_index, second_index = (
                    int(value)
                    for value in intersection["edgeRawVertexIndices"]
                )
                first_value = float(raw_vertex_scalars[first_index])
                second_value = float(raw_vertex_scalars[second_index])
                denominator = first_value - second_value
                if abs(denominator) <= 1e-14:
                    raise RuntimeError(
                        "Retained recorded root lost its affine bracket"
                    )
                alpha = first_value / denominator
                coordinates[(segment_offset, intersection_offset)] = (
                    source_surface["vertices"][first_index].lerp(
                        source_surface["vertices"][second_index],
                        alpha,
                    )
                )
        return coordinates

    side_reports = []
    partition_by_side = {}
    for side in SIDES:
        corridors = {}
        preselected_by_field = {}
        for gasket in GASKETS:
            field_sets = []
            for field, _role, _blend in CONTOUR_FIELDS:
                surface_field = fields[(side, "thumb", gasket, field)]
                selected = set(surface_field["selectedSourceFaces"])
                preselected_by_field[(gasket, field)] = selected
                field_sets.append(selected)
            corridors[gasket] = set().union(*field_sets)

        g0_g1_overlap = corridors["G0"] & corridors["G1"]
        overlap_owner = {"G0": set(), "G1": set()}
        ownership_records = []
        ambiguous_faces = []
        minimum_absolute_midfield = math.inf
        g0_distal_field = fields[(side, "thumb", "G0", "distal")]
        g1_proximal_field = fields[(side, "thumb", "G1", "proximal")]
        for source_face_index in sorted(g0_g1_overlap):
            source_face = source_surface["faces"][source_face_index]
            raw_indices = source_face["rawVertexIndices"]
            g0_distal = sum(
                float(g0_distal_field["unfittedRawVertexScalars"][index])
                for index in raw_indices
            ) / 3.0
            g1_proximal = sum(
                float(g1_proximal_field["unfittedRawVertexScalars"][index])
                for index in raw_indices
            ) / 3.0
            midfield = 0.5 * (g0_distal + g1_proximal)
            minimum_absolute_midfield = min(
                minimum_absolute_midfield,
                abs(midfield),
            )
            if abs(midfield) <= AFFINE_SCALAR_TOLERANCE:
                ambiguous_faces.append(source_face_index)
                continue
            owner = "G0" if midfield < 0.0 else "G1"
            overlap_owner[owner].add(source_face_index)
            ownership_records.append(
                {
                    "sourceFaceIndex": source_face_index,
                    "g0DistalRawP1AtCentroid": g0_distal,
                    "g1ProximalRawP1AtCentroid": g1_proximal,
                    "adjacentMidfieldRawP1AtCentroid": midfield,
                    "owner": owner,
                }
            )

        assigned_overlap = overlap_owner["G0"] | overlap_owner["G1"]
        multiply_owned = overlap_owner["G0"] & overlap_owner["G1"]
        unassigned_overlap = g0_g1_overlap - assigned_overlap
        if ambiguous_faces or multiply_owned or unassigned_overlap:
            raise RuntimeError(
                f"{side} thumb raw-P1 corridor partition is not total and "
                f"disjoint: ambiguous={sorted(ambiguous_faces)}, "
                f"multiplyOwned={sorted(multiply_owned)}, "
                f"unassigned={sorted(unassigned_overlap)}"
            )

        expected_owner_by_face = {
            source_face_index: gasket
            for gasket in ("G0", "G1")
            for source_face_index in THUMB_ORDERED_FACE_OWNERS[(side, gasket)]
        }
        missing_known_owner_faces = sorted(
            set(expected_owner_by_face) - g0_g1_overlap
        )
        known_owner_mismatches = sorted(
            source_face_index
            for source_face_index, expected_owner in expected_owner_by_face.items()
            if source_face_index not in overlap_owner[expected_owner]
        )
        if missing_known_owner_faces or known_owner_mismatches:
            raise RuntimeError(
                f"{side} thumb raw-P1 ownership changed authored regression "
                f"evidence: missing={missing_known_owner_faces}, "
                f"mismatched={known_owner_mismatches}"
            )
        corridors["G0"] -= overlap_owner["G1"]
        corridors["G1"] -= overlap_owner["G0"]
        remaining_overlap = corridors["G0"] & corridors["G1"]
        if remaining_overlap:
            raise RuntimeError("Ordered thumb G0/G1 corridors still overlap")

        owner_by_face = {
            source_face_index: gasket
            for gasket in ("G0", "G1")
            for source_face_index in overlap_owner[gasket]
        }
        exclusive_corridor_owner_by_face = {
            source_face_index: gasket
            for gasket in ("G0", "G1")
            for source_face_index in corridors[gasket]
        }
        if len(exclusive_corridor_owner_by_face) != (
            len(corridors["G0"]) + len(corridors["G1"])
        ):
            raise RuntimeError(
                f"{side} thumb exclusive corridor ownership is not disjoint"
            )
        partition_by_side[side] = {
            "overlapSourceFaces": set(g0_g1_overlap),
            "ownerBySourceFace": owner_by_face,
            "exclusiveCorridorOwnerBySourceFace": (
                exclusive_corridor_owner_by_face
            ),
            "corridorByGasket": {
                gasket: set(corridors[gasket])
                for gasket in ("G0", "G1")
            },
        }

        field_reports = []
        for gasket in GASKETS:
            corridor = corridors[gasket]
            for field, _role, _blend in CONTOUR_FIELDS:
                surface_field = fields[(side, "thumb", gasket, field)]
                recorded_contour = surface_field["recordedContourDocument"]
                recorded_source_faces = surface_field["recordedSourceFaces"]
                preselected = preselected_by_field[(gasket, field)]
                final_selected = preselected & corridor
                if not final_selected:
                    raise RuntimeError(
                        f"{side} thumb {gasket} {field} common corridor "
                        "removed every zero-crossing face"
                    )
                pre_refit_root_coordinates = retained_root_coordinates(
                    recorded_contour,
                    surface_field["rawVertexScalars"],
                    final_selected,
                )
                excluded_recorded_faces = (
                    recorded_source_faces - final_selected
                )
                fitted_scalars, recorded_root_fit = _fit_recorded_edge_roots(
                    recorded_contour,
                    source_surface=source_surface,
                    raw_vertex_scalars=surface_field[
                        "unfittedRawVertexScalars"
                    ],
                    excluded_source_faces=excluded_recorded_faces,
                )
                surface_field["rawVertexScalars"] = fitted_scalars
                refitted_component = _select_surface_zero_component(
                    surface_field,
                    source_surface=source_surface,
                    recorded_source_faces=recorded_source_faces,
                )
                refitted_component_faces = set(
                    refitted_component["selectedSourceFaces"]
                )
                component_difference = (
                    surface_field["sourceZeroComponentFaces"]
                    ^ refitted_component_faces
                )
                refitted_route, _route_audit = _route_surface_field_faces(
                    refitted_component_faces,
                    source_surface=source_surface,
                    side=side,
                    digit="thumb",
                    gasket=gasket,
                )
                route_difference = preselected ^ refitted_route
                if component_difference or route_difference:
                    raise RuntimeError(
                        f"{side} thumb {gasket} {field} common-corridor "
                        "refit changed raw-sign route topology"
                    )
                final_selected = refitted_route & corridor
                post_refit_root_coordinates = retained_root_coordinates(
                    recorded_contour,
                    fitted_scalars,
                    final_selected,
                )
                if (
                    pre_refit_root_coordinates.keys()
                    != post_refit_root_coordinates.keys()
                ):
                    raise RuntimeError(
                        f"{side} thumb {gasket} {field} retained-root "
                        "identity changed during common-corridor refit"
                    )
                maximum_pre_post_root_displacement = max(
                    (
                        pre_refit_root_coordinates[key]
                        - post_refit_root_coordinates[key]
                    ).length
                    for key in pre_refit_root_coordinates
                ) if pre_refit_root_coordinates else 0.0
                if (
                    maximum_pre_post_root_displacement
                    > MAXIMUM_RECORDED_ROOT_DISPLACEMENT
                ):
                    raise RuntimeError(
                        f"{side} thumb {gasket} {field} common-corridor "
                        "refit moved a retained root by "
                        f"{maximum_pre_post_root_displacement} m"
                    )
                for key, value in refitted_component.items():
                    if key != "selectedSourceFaces":
                        surface_field[key] = value
                surface_field["sourceZeroComponentFaces"] = (
                    refitted_component_faces
                )
                surface_field["selectedSourceFaces"] = final_selected
                surface_field["routeCorridorSourceFaces"] = set(corridor)
                surface_field["recordedRootLeastSquaresFit"] = (
                    recorded_root_fit
                )
                surface_field["rawRecordedRootAudit"] = _recorded_root_audit(
                    recorded_contour,
                    source_surface=source_surface,
                    raw_vertex_scalars=fitted_scalars,
                )
                surface_field["retainedRecordedRootAudit"] = (
                    _recorded_root_audit(
                        recorded_contour,
                        source_surface=source_surface,
                        raw_vertex_scalars=fitted_scalars,
                        included_source_faces=final_selected,
                    )
                )
                surface_field["intentionallyExcludedRecordedRootAudit"] = (
                    _recorded_root_audit(
                        recorded_contour,
                        source_surface=source_surface,
                        raw_vertex_scalars=fitted_scalars,
                        included_source_faces=excluded_recorded_faces,
                    )
                )
                surface_field["routeAwareRefit"] = {
                    "selectionScalar": "unfitted raw authored signs",
                    "retainedRecordedSourceFaceCount": len(
                        recorded_source_faces - excluded_recorded_faces
                    ),
                    "excludedRecordedSourceFaceCount": len(
                        excluded_recorded_faces
                    ),
                    "componentFaceSymmetricDifferenceCount": len(
                        component_difference
                    ),
                    "routedFaceSymmetricDifferenceCount": len(
                        route_difference
                    ),
                    "commonCorridorClippedSourceFaceCount": len(
                        refitted_route - final_selected
                    ),
                    "maximumPrePostRetainedRootDisplacementMeters": (
                        maximum_pre_post_root_displacement
                    ),
                    "maximumPrePostRetainedRootDisplacementGateMeters": (
                        MAXIMUM_RECORDED_ROOT_DISPLACEMENT
                    ),
                }
                surface_field["thumbOrderedClippedSourceFaceCount"] = len(
                    preselected - final_selected
                )
                surface_field["thumbOrderedRouting"] = {
                    "applied": gasket in {"G0", "G1"},
                    "commonTripletCorridorApplied": True,
                    "selectionRule": (
                        "sign of the raw affine G0-distal/G1-proximal "
                        "midfield at the immutable source-face centroid"
                    ),
                    "ownedOverlapSourceFaces": sorted(
                        overlap_owner.get(gasket, set())
                    ),
                }
                surface_field["relativeBoundaryEdges"] = (
                    _face_domain_boundary_edges(source_surface, corridor)
                )
                surface_field.update(
                    _audit_routed_surface_components(
                        surface_field,
                        source_surface,
                    )
                )
                canonical_roots, canonical_root_audit = (
                    _canonical_source_edge_roots(
                        surface_field,
                        source_surface,
                    )
                )
                surface_field["canonicalSourceEdgeRoots"] = canonical_roots
                surface_field["canonicalSourceEdgeRootAudit"] = (
                    canonical_root_audit
                )
                surface_field["candidateSourceFaceCount"] = len(
                    final_selected
                )
                field_reports.append(
                    {
                        "gasket": gasket,
                        "field": field,
                        "preselectedSourceFaceCount": len(preselected),
                        "corridorSourceFaceCount": len(corridor),
                        "finalSelectedSourceFaceCount": len(final_selected),
                        "clippedSourceFaceCount": len(
                            preselected - final_selected
                        ),
                        "maximumPrePostRetainedRootDisplacementMeters": (
                            maximum_pre_post_root_displacement
                        ),
                    }
                )
        side_reports.append(
            {
                "side": side,
                "g0G1PrepartitionOverlapSourceFaceCount": len(
                    g0_g1_overlap
                ),
                "g0OwnedOverlapSourceFaceCount": len(overlap_owner["G0"]),
                "g1OwnedOverlapSourceFaceCount": len(overlap_owner["G1"]),
                "assignedOverlapSourceFaceCount": len(assigned_overlap),
                "unassignedOverlapSourceFaceCount": len(
                    unassigned_overlap
                ),
                "multiplyOwnedOverlapSourceFaceCount": len(
                    multiply_owned
                ),
                "ambiguousMidfieldSourceFaceCount": len(ambiguous_faces),
                "legacyKnownOwnerSourceFaceCount": len(
                    expected_owner_by_face
                ),
                "legacyKnownOwnerCoveredSourceFaceCount": len(
                    set(expected_owner_by_face) & g0_g1_overlap
                ),
                "legacyKnownOwnerUncoveredSourceFaceCount": len(
                    missing_known_owner_faces
                ),
                "knownOwnerMismatchCount": 0,
                "minimumAbsoluteRawP1MidfieldAtCentroidMeters": (
                    minimum_absolute_midfield
                    if math.isfinite(minimum_absolute_midfield)
                    else None
                ),
                "ownershipEvidence": ownership_records,
                "fields": field_reports,
            }
        )
    source_surface["thumbAdjacentGasketPartition"] = partition_by_side
    return {
        "schemaVersion": 1,
        "method": (
            "union corridor shared by each thumb gasket triplet; complete "
            "G0/G1 overlap partitioned by the sign of the raw affine "
            "G0-distal/G1-proximal midfield at each immutable source-face "
            "centroid; legacy authored owners used only as regression gates"
        ),
        "affineMidfieldAmbiguityToleranceMeters": AFFINE_SCALAR_TOLERANCE,
        "retainedRootRefitDisplacementGateMeters": (
            MAXIMUM_RECORDED_ROOT_DISPLACEMENT
        ),
        "sides": side_reports,
    }


def _build_surface_fields(
    bm: bmesh.types.BMesh,
    *,
    source_spec: dict,
    effective_spec: dict,
    source_zone_records: dict,
) -> tuple[dict, list[dict], dict]:
    source_surface = _initialize_source_surface(bm)
    digit_domain_audit = _build_source_digit_domains(
        source_surface,
        effective_spec=effective_spec,
        source_zone_records=source_zone_records,
    )
    excluded_source_faces = {
        int(record["faceIndex"])
        for record in source_spec.get("crossSeamFaceOverlaps", [])
    }
    fields = {}
    audits = []
    contour_index = 0
    for side in SIDES:
        for digit in DIGITS:
            source_digit = source_spec["seams"][side][digit]
            effective_digit = effective_spec["seams"][side][digit]
            for gasket in GASKETS:
                source_joint = source_digit["joints"][gasket]
                effective_joint = effective_digit["joints"][gasket]
                for field, role, blend in CONTOUR_FIELDS:
                    surface_field = _build_surface_field(
                        source_surface=source_surface,
                        source_digit_document=source_digit,
                        source_joint_document=source_joint,
                        effective_digit_document=effective_digit,
                        effective_joint_document=effective_joint,
                        side=side,
                        digit=digit,
                        gasket=gasket,
                        field=field,
                        excluded_source_faces=excluded_source_faces,
                    )
                    surface_field.update(
                        {
                            "index": contour_index,
                            "role": role,
                            "rawBlendT": blend,
                            "sourceSurface": source_surface,
                        }
                    )
                    fields[(side, digit, gasket, field)] = surface_field
                    contour_index += 1
    if contour_index != 90:
        raise RuntimeError(f"Expected 90 cached surface fields, got {contour_index}")
    thumb_corridor_synchronization = _synchronize_thumb_gasket_corridors(
        fields,
        source_surface=source_surface,
        effective_spec=effective_spec,
    )
    transient_keys = {
        "rawVertexScalars",
        "unfittedRawVertexScalars",
        "effectiveVertexScalars",
        "recordedContourDocument",
        "recordedSourceFaces",
        "selectedSourceFaces",
        "sourceZeroComponentFaces",
        "routeCorridorSourceFaces",
        "sourceSurface",
        "canonicalSourceEdgeRoots",
        "relativeBoundaryEdges",
    }
    audits = [
        {
            key: value
            for key, value in surface_field.items()
            if key not in transient_keys
        }
        for surface_field in sorted(
            fields.values(),
            key=lambda item: item["index"],
        )
    ]
    summary = {
        "schemaVersion": 1,
        "method": (
            "original generator scalar cached once at welded immutable source "
            "vertices; barycentric P1 evaluation by persistent source-face id; "
            "maximum-recorded-overlap zero component; raw-sign final face "
            "routing before retained-evidence constrained refit"
        ),
        "contourCount": contour_index,
        "sourceFaceCount": len(source_surface["faces"]),
        "sourceRawVertexCount": len(source_surface["vertices"]),
        "sourceWeldedPositionCount": len(source_surface["weldedCoordinates"]),
        "excludedCanonicalOverlapSourceFaceCount": len(excluded_source_faces),
        "maximumUnconstrainedRawRecordedRootDisplacementMeters": max(
            item["unconstrainedRawRecordedRootAudit"][
                "maximumRecordedRootDisplacementMeters"
            ]
            for item in audits
        ),
        "maximumRawRecordedRootDisplacementMeters": max(
            item["rawRecordedRootAudit"]["maximumRecordedRootDisplacementMeters"]
            for item in audits
        ),
        "maximumFittedRecordedRootDisplacementMeters": max(
            item["recordedRootLeastSquaresFit"][
                "maximumFittedRootDisplacementMeters"
            ]
            for item in audits
        ),
        "maximumRetainedRecordedRootPositionDisplacementMeters": max(
            item["retainedRecordedRootAudit"][
                "maximumRecordedRootPositionDisplacementMeters"
            ]
            for item in audits
        ),
        "retainedRecordedIntersectionCount": sum(
            item["retainedRecordedRootAudit"]["recordedIntersectionCount"]
            for item in audits
        ),
        "routeRefitComponentFaceSymmetricDifferenceCount": sum(
            item["routeAwareRefit"][
                "componentFaceSymmetricDifferenceCount"
            ]
            for item in audits
        ),
        "routeRefitRoutedFaceSymmetricDifferenceCount": sum(
            item["routeAwareRefit"]["routedFaceSymmetricDifferenceCount"]
            for item in audits
        ),
        "maximumEffectiveRecordedRootDisplacementMeters": max(
            item["effectiveRecordedRootAudit"][
                "maximumRecordedRootDisplacementMeters"
            ]
            for item in audits
        ),
        "rawMissingRecordedRootBracketCount": sum(
            item["rawRecordedRootAudit"]["missingRecordedRootBracketCount"]
            for item in audits
        ),
        "effectiveMissingRecordedRootBracketCount": sum(
            item["effectiveRecordedRootAudit"][
                "missingRecordedRootBracketCount"
            ]
            for item in audits
        ),
        "absoluteClosedComponentCount": sum(
            item["selectedClosed"] for item in audits
        ),
        "openComponentCount": sum(
            not item["selectedClosed"] for item in audits
        ),
        "digitDomain": digit_domain_audit,
        "thumbGasketCorridorSynchronization": (
            thumb_corridor_synchronization
        ),
    }
    return fields, audits, summary


def _field_value(
    coordinate: Vector,
    digit_document: dict,
    joint_document: dict,
    field: str,
) -> tuple[float, float, float, float]:
    station, radial, angle = _project_joint_coordinate(
        coordinate,
        digit_document,
        joint_document,
    )
    target = _joint_trace_value(joint_document, field, angle)
    return station - target, station, radial, angle


def _bisect_root(
    first: Vector,
    second: Vector,
    first_value: float,
    second_value: float,
    digit_document: dict,
    joint_document: dict,
    field: str,
) -> tuple[float, Vector, float]:
    low = 0.0
    high = 1.0
    low_value = first_value
    for _iteration in range(32):
        middle = (low + high) * 0.5
        coordinate = first.lerp(second, middle)
        middle_value, _station, _radial, _angle = _field_value(
            coordinate, digit_document, joint_document, field
        )
        if (low_value <= 0.0) == (middle_value <= 0.0):
            low = middle
            low_value = middle_value
        else:
            high = middle
    factor = (low + high) * 0.5
    coordinate = first.lerp(second, factor)
    residual, _station, radial, _angle = _field_value(
        coordinate, digit_document, joint_document, field
    )
    return factor, coordinate, max(abs(residual), radial)


def _face_contour_roots(
    face: bmesh.types.BMFace,
    *,
    side: str,
    digit: str,
    gasket: str,
    field: str,
    side_document: dict,
    digit_document: dict,
    joint_document: dict,
) -> list[Vector]:
    """Evaluate the current nonlinear contour where it crosses one face.

    This is intentionally geometric rather than index based.  Every refinement
    round creates new faces, so retaining source/current face indices here would
    make the next evaluation stale.
    """

    if not face.is_valid:
        return []
    sign = -1.0 if side == "left" else 1.0
    if (
        max((vertex.co.x * sign for vertex in face.verts), default=-math.inf)
        <= 0.0
        or max((vertex.co.y for vertex in face.verts), default=-math.inf) < 0.625
    ):
        return []

    radial_limit = float(digit_document["radialLimit"])
    field_min = min(float(value) for value in joint_document[field])
    field_max = max(float(value) for value in joint_document[field])

    def accepted(coordinate: Vector) -> bool:
        _value, station, radial, _angle = _field_value(
            coordinate, digit_document, joint_document, field
        )
        if (
            radial > radial_limit * 1.015
            and not (digit == "thumb" and gasket == "G0")
        ):
            return False
        if not field_min - 0.012 <= station <= field_max + 0.012:
            return False
        if gasket == "G0" and digit != "thumb":
            owner, _best, _second, _tied = _digit_domain_owner(
                coordinate, side_document
            )
            if owner != digit:
                return False
        return True

    roots: dict[tuple[int, int, int], Vector] = {}
    for edge in face.edges:
        if not edge.is_valid:
            continue
        first = edge.verts[0].co
        second = edge.verts[1].co
        first_value, _station, first_radial, _angle = _field_value(
            first, digit_document, joint_document, field
        )
        second_value, _station, second_radial, _angle = _field_value(
            second, digit_document, joint_document, field
        )
        if min(first_radial, second_radial) > radial_limit * 1.75:
            continue
        if abs(first_value) <= CONTOUR_SCALAR_TOLERANCE and accepted(first):
            roots[position_key(first)] = first.copy()
        if abs(second_value) <= CONTOUR_SCALAR_TOLERANCE and accepted(second):
            roots[position_key(second)] = second.copy()
        if (first_value < -CONTOUR_SCALAR_TOLERANCE and second_value < -CONTOUR_SCALAR_TOLERANCE) or (
            first_value > CONTOUR_SCALAR_TOLERANCE and second_value > CONTOUR_SCALAR_TOLERANCE
        ):
            continue
        if (
            abs(first_value) <= CONTOUR_SCALAR_TOLERANCE
            or abs(second_value) <= CONTOUR_SCALAR_TOLERANCE
        ):
            continue
        _factor, coordinate, _residual_or_radial = _bisect_root(
            first.copy(),
            second.copy(),
            first_value,
            second_value,
            digit_document,
            joint_document,
            field,
        )
        if accepted(coordinate):
            roots[position_key(coordinate)] = coordinate
    return list(roots.values())


def _contour_source_face_domain(
    bm: bmesh.types.BMesh,
    joint_document: dict,
    field: str,
) -> tuple[object, set[int], set[int]]:
    """Return the persistent source-face neighborhood for one contour."""

    source_face_layer = bm.faces.layers.int.get("hinge_source_face")
    if source_face_layer is None:
        raise RuntimeError("Hinge source-face identity layer is unavailable")
    contour_role = next(
        role for candidate_field, role, _blend in CONTOUR_FIELDS
        if candidate_field == field
    )
    contour_document = next(
        contour
        for contour in joint_document["contours"]
        if contour["role"] == contour_role
    )
    recorded_source_faces = {
        int(segment["faceIndex"])
        for segment in contour_document["segments"]
    }
    eligible_source_faces = set(recorded_source_faces)
    recorded_children = [
        face
        for face in bm.faces
        if face.is_valid and face[source_face_layer] in recorded_source_faces
    ]
    for face in recorded_children:
        for vertex in face.verts:
            eligible_source_faces.update(
                linked[source_face_layer]
                for linked in vertex.link_faces
                if linked.is_valid
            )
    return source_face_layer, recorded_source_faces, eligible_source_faces


def _refine_contour_faces(
    bm: bmesh.types.BMesh,
    *,
    side: str,
    digit: str,
    gasket: str,
    field: str,
    side_document: dict,
    digit_document: dict,
    joint_document: dict,
) -> dict:
    """Recursively refine nonlinear contour chords before inserting a seam.

    A planar chord is accepted only when its midpoint lies within the authored
    contour tolerance.  Coarser faces are subdivided and then re-evaluated from
    their new geometry, which eliminates the false straight-chord crossings in
    the source intersection report.
    """

    rounds = []
    (
        source_face_layer,
        recorded_source_faces,
        eligible_source_faces,
    ) = _contour_source_face_domain(bm, joint_document, field)

    def failing_faces() -> tuple[
        list[bmesh.types.BMFace], float, list[bmesh.types.BMFace]
    ]:
        failures = []
        maximum_residual = 0.0
        multi_crossing_faces = []
        for face in list(bm.faces):
            if face[source_face_layer] not in eligible_source_faces:
                continue
            roots = _face_contour_roots(
                face,
                side=side,
                digit=digit,
                gasket=gasket,
                field=field,
                side_document=side_document,
                digit_document=digit_document,
                joint_document=joint_document,
            )
            if len(roots) > 2:
                failures.append(face)
                multi_crossing_faces.append(face)
                continue
            if len(roots) != 2:
                continue
            midpoint = (roots[0] + roots[1]) * 0.5
            residual, _station, _radial, _angle = _field_value(
                midpoint, digit_document, joint_document, field
            )
            maximum_residual = max(maximum_residual, abs(residual))
            wrong_domain = False
            if gasket == "G0" and digit != "thumb":
                owner, _best, _second, _tied = _digit_domain_owner(
                    midpoint, side_document
                )
                wrong_domain = owner != digit
            if abs(residual) > CONTOUR_CHORD_TOLERANCE or wrong_domain:
                failures.append(face)
        return failures, maximum_residual, multi_crossing_faces

    for depth in range(MAXIMUM_CHORD_REFINEMENT_DEPTH):
        target_faces, maximum_residual, multi_crossing_faces = failing_faces()
        if not target_faces:
            break
        triangulated_faces = [
            face
            for face in multi_crossing_faces
            if face.is_valid and len(face.verts) > 3
        ]
        if triangulated_faces:
            bmesh.ops.triangulate(
                bm,
                faces=triangulated_faces,
                quad_method="BEAUTY",
                ngon_method="BEAUTY",
            )
            bm.verts.index_update()
            bm.edges.index_update()
            bm.faces.index_update()
            target_faces, maximum_residual, multi_crossing_faces = failing_faces()
            if not target_faces:
                rounds.append(
                    {
                        "depth": depth + 1,
                        "refinedFaceCount": 0,
                        "splitEdgeCount": 0,
                        "insertedVertexCount": 0,
                        "insertedFaceCount": len(triangulated_faces),
                        "triangulatedMultiCrossingFaceCount": len(
                            triangulated_faces
                        ),
                        "maximumPreRefinementChordResidual": maximum_residual,
                        "multiCrossingFaceCount": 0,
                    }
                )
                break
        target_edges = {
            edge
            for face in target_faces
            if face.is_valid
            for edge in face.edges
            if edge.is_valid
        }
        before_vertices = len(bm.verts)
        before_faces = len(bm.faces)
        bmesh.ops.subdivide_edges(
            bm,
            edges=list(target_edges),
            cuts=1,
            use_grid_fill=True,
        )
        bm.verts.index_update()
        bm.edges.index_update()
        bm.faces.index_update()
        rounds.append(
            {
                "depth": depth + 1,
                "refinedFaceCount": len(target_faces),
                "splitEdgeCount": len(target_edges),
                "insertedVertexCount": len(bm.verts) - before_vertices,
                "insertedFaceCount": len(bm.faces) - before_faces,
                "triangulatedMultiCrossingFaceCount": len(triangulated_faces),
                "maximumPreRefinementChordResidual": maximum_residual,
                "multiCrossingFaceCount": len(multi_crossing_faces),
            }
        )

    remaining_faces, maximum_residual, multi_crossing_faces = failing_faces()
    return {
        "tolerance": CONTOUR_CHORD_TOLERANCE,
        "maximumDepth": MAXIMUM_CHORD_REFINEMENT_DEPTH,
        "recordedSourceFaceCount": len(recorded_source_faces),
        "eligibleSourceFaceCount": len(eligible_source_faces),
        "rounds": rounds,
        "remainingFailingFaceCount": len(remaining_faces),
        "remainingMaximumChordResidual": maximum_residual,
        "remainingMultiCrossingFaceCount": len(multi_crossing_faces),
    }


def _cut_contour(
    bm: bmesh.types.BMesh,
    *,
    side: str,
    digit: str,
    gasket: str,
    field: str,
    side_document: dict,
    digit_document: dict,
    joint_document: dict,
    surface_field: dict,
    contour_edge_layer,
    contour_edge_mask: int,
    contour_edge_layers: list,
) -> dict:
    """Insert one periodic contour from its cached source-surface field."""

    (
        source_face_layer,
        recorded_source_faces,
        eligible_source_faces,
    ) = _contour_source_face_domain(bm, joint_document, field)
    sign = -1.0 if side == "left" else 1.0
    clipped_domain_keys = set()
    domain_tie_keys = set()

    selected_source_faces = surface_field["selectedSourceFaces"]

    def face_scalar_field(
        face: bmesh.types.BMFace,
        coordinate: Vector,
    ) -> float:
        source_face_index = int(face[source_face_layer])
        if source_face_index not in selected_source_faces:
            raise RuntimeError(
                f"{side} {digit} {gasket} {field} lacks affine source face "
                f"{source_face_index}"
            )
        return _evaluate_surface_field_face(
            surface_field,
            surface_field["sourceSurface"],
            source_face_index,
            coordinate,
        )

    def accept_coordinate(coordinate: Vector) -> bool:
        # Component selection has already isolated the intended full-side P1
        # zero arc.  Reapplying legacy radial/station/Voronoi predicates here
        # would truncate a closed surface loop.  Cross-joint web collisions are
        # handled explicitly by local face routing and audited after insertion.
        return coordinate.x * sign > 0.0 and coordinate.y >= 0.615

    def face_filter(face: bmesh.types.BMFace) -> bool:
        return (
            face.is_valid
            and int(face[source_face_layer]) in selected_source_faces
            and max(
                (vertex.co.x * sign for vertex in face.verts),
                default=-math.inf,
            )
            > 0.0
            and max((vertex.co.y for vertex in face.verts), default=-math.inf)
            >= 0.615
        )

    before_vertices = len(bm.verts)
    try:
        marching = insert_face_linear_contour(
            bm,
            face_scalar_field=face_scalar_field,
            accept_coordinate=accept_coordinate,
            face_filter=face_filter,
            chord_tolerance=CONTOUR_CHORD_TOLERANCE,
            scalar_tolerance=AFFINE_SCALAR_TOLERANCE,
            contour_edge_layer=contour_edge_layer,
            contour_edge_mask=contour_edge_mask,
            propagated_edge_layers=contour_edge_layers,
            root_coordinate_resolver=(
                lambda face, edge, coordinate: _resolve_source_edge_root(
                    face=face,
                    edge=edge,
                    coordinate=coordinate,
                    source_face_layer=source_face_layer,
                    surface_field=surface_field,
                )
            ),
            face_identity=lambda face: int(face[source_face_layer]),
        )
    except (ContourRefinementError, RuntimeError) as error:
        raise RuntimeError(
            f"{side} {digit} {gasket} {field} affine insertion failed: "
            f"{error}"
        ) from error
    inserted_vertices = len(bm.verts) - before_vertices
    if (
        marching["maximumEndpointReuseDisplacementMeters"]
        > MAXIMUM_RECORDED_ROOT_DISPLACEMENT
    ):
        raise RuntimeError(
            f"{side} {digit} {gasket} {field} endpoint reuse exceeds 1 micron"
        )
    if marching["contourEdgeCount"] < 3:
        raise RuntimeError(
            f"{side} {digit} {gasket} {field} produced only "
            f"{marching['contourEdgeCount']} face-local contour edges"
        )
    return {
        "side": side,
        "digit": digit,
        "gasket": gasket,
        "field": field,
        "role": surface_field["role"],
        "rawBlendT": surface_field["rawBlendT"],
        "contourIndex": surface_field["index"],
        "method": "cached-source-vertex-piecewise-affine",
        "consideredSignCrossings": marching["requestedEdgeRootCount"],
        "insertedVertices": inserted_vertices,
        "contourVertices": marching["contourEdgeCount"],
        "connectedEdges": marching["splitFaceCount"],
        "reusedContourEdges": marching["existingContourEdgeCount"],
        "singleRootFaceCount": marching["singleRootFaceCount"],
        "singleRootFaces": marching["singleRootFaces"],
        "maximumScalarResidual": marching["maximumPostinsertChordResidual"],
        "maximumSharedEdgeRootDisagreementMeters": marching[
            "maximumSharedEdgeRootDisagreementMeters"
        ],
        "endpointReuseCount": marching["endpointReuseCount"],
        "crossQuantizationEndpointReuseCount": marching[
            "crossQuantizationEndpointReuseCount"
        ],
        "maximumEndpointReuseDisplacementMeters": marching[
            "maximumEndpointReuseDisplacementMeters"
        ],
        "clippedVoronoiCrossings": len(clipped_domain_keys),
        "domainTieEvaluations": len(domain_tie_keys),
        "recordedSourceFaceCount": len(recorded_source_faces),
        "eligibleSourceFaceCount": len(eligible_source_faces),
        "candidateSourceFaceCount": surface_field["candidateSourceFaceCount"],
        "adaptiveChordRefinement": marching["refinement"],
        "faceLocalMarching": marching,
    }


def _raw_blend(
    station: float,
    angle: float,
    joint_document: dict,
) -> float:
    proximal = _joint_trace_value(joint_document, "proximal", angle)
    center = _joint_trace_value(joint_document, "center", angle)
    distal = _joint_trace_value(joint_document, "distal", angle)
    if station <= center:
        denominator = max(center - proximal, 1e-9)
        return 0.5 * (station - proximal) / denominator
    denominator = max(distal - center, 1e-9)
    return 0.5 + 0.5 * (station - center) / denominator


def _contour_topology_audit(
    bm: bmesh.types.BMesh,
    hinge_spec: dict,
) -> dict:
    """Audit collapsed-coordinate closure and cross-joint intersections."""

    contour_reports = []
    coordinate_memberships: dict[tuple[int, int, int], set[str]] = {}
    endpoint_tolerance = 2e-6
    for side in SIDES:
        sign = -1.0 if side == "left" else 1.0
        side_document = hinge_spec["seams"][side]
        for digit in DIGITS:
            digit_document = side_document[digit]
            radial_limit = float(digit_document["radialLimit"])
            for gasket in GASKETS:
                joint_document = digit_document["joints"][gasket]
                for field, role, _blend in CONTOUR_FIELDS:
                    contour_id = f"{side}/{digit}/{gasket}/{role}"
                    graph: dict[
                        tuple[int, int, int], set[tuple[int, int, int]]
                    ] = {}
                    maximum_midpoint_residual = 0.0
                    rejected_chord_count = 0
                    for edge in bm.edges:
                        if not edge.is_valid:
                            continue
                        first = edge.verts[0].co
                        second = edge.verts[1].co
                        if (
                            max(first.x * sign, second.x * sign) <= 0.0
                            or max(first.y, second.y) < 0.625
                        ):
                            continue
                        first_value, _station, first_radial, _angle = _field_value(
                            first, digit_document, joint_document, field
                        )
                        second_value, _station, second_radial, _angle = _field_value(
                            second, digit_document, joint_document, field
                        )
                        if (
                            abs(first_value) > endpoint_tolerance
                            or abs(second_value) > endpoint_tolerance
                            or min(first_radial, second_radial)
                            > radial_limit * 1.05
                        ):
                            continue
                        midpoint = (first + second) * 0.5
                        midpoint_value, _station, midpoint_radial, _angle = (
                            _field_value(
                                midpoint,
                                digit_document,
                                joint_document,
                                field,
                            )
                        )
                        maximum_midpoint_residual = max(
                            maximum_midpoint_residual, abs(midpoint_value)
                        )
                        if (
                            (
                                midpoint_radial > radial_limit * 1.015
                                and not (digit == "thumb" and gasket == "G0")
                            )
                            or abs(midpoint_value) > CONTOUR_CHORD_TOLERANCE
                        ):
                            rejected_chord_count += 1
                            continue
                        if gasket == "G0" and digit != "thumb":
                            owner, _best, _second, _tied = _digit_domain_owner(
                                midpoint, side_document
                            )
                            if owner != digit:
                                rejected_chord_count += 1
                                continue
                        first_key = position_key(first)
                        second_key = position_key(second)
                        if first_key == second_key:
                            continue
                        graph.setdefault(first_key, set()).add(second_key)
                        graph.setdefault(second_key, set()).add(first_key)

                    components = []
                    unseen = set(graph)
                    while unseen:
                        seed = min(unseen)
                        stack = [seed]
                        component = set()
                        while stack:
                            key = stack.pop()
                            if key in component:
                                continue
                            component.add(key)
                            unseen.discard(key)
                            stack.extend(graph[key] - component)
                        components.append(component)
                    degree_histogram = {}
                    for neighbors in graph.values():
                        degree = len(neighbors)
                        degree_histogram[str(degree)] = (
                            degree_histogram.get(str(degree), 0) + 1
                        )
                    closed_components = [
                        component
                        for component in components
                        if len(component) >= 3
                        and all(len(graph[key]) == 2 for key in component)
                    ]
                    closed = len(components) == 1 and len(closed_components) == 1
                    if closed:
                        for key in closed_components[0]:
                            coordinate_memberships.setdefault(key, set()).add(
                                contour_id
                            )
                    contour_reports.append(
                        {
                            "id": contour_id,
                            "side": side,
                            "digit": digit,
                            "gasket": gasket,
                            "role": role,
                            "collapsedVertexCount": len(graph),
                            "collapsedEdgeCount": sum(
                                len(value) for value in graph.values()
                            )
                            // 2,
                            "componentCount": len(components),
                            "closedComponentCount": len(closed_components),
                            "degreeHistogram": dict(sorted(degree_histogram.items())),
                            "maximumChordResidual": maximum_midpoint_residual,
                            "rejectedChordCount": rejected_chord_count,
                            "closed": closed,
                        }
                    )

    cross_joint_positions = []
    for key, memberships in coordinate_memberships.items():
        joints = {"/".join(value.split("/")[:3]) for value in memberships}
        if len(joints) > 1:
            cross_joint_positions.append(
                {
                    "key": list(key),
                    "contours": sorted(memberships),
                    "joints": sorted(joints),
                }
            )
    return {
        "contourCount": len(contour_reports),
        "closedContourCount": sum(item["closed"] for item in contour_reports),
        "allContoursClosed": all(item["closed"] for item in contour_reports),
        "crossJointContourIntersectionCount": len(cross_joint_positions),
        "crossJointContourIntersections": cross_joint_positions,
        "contours": contour_reports,
    }


def _point_segment_distance(
    point: Vector,
    first: Vector,
    second: Vector,
) -> float:
    direction = second - first
    factor = (
        (point - first).dot(direction) / max(direction.length_squared, 1e-30)
    )
    factor = max(0.0, min(1.0, factor))
    return (point - first.lerp(second, factor)).length


def _source_boundary_membership(
    coordinate: Vector,
    boundary_edges: list[dict],
) -> dict | None:
    coordinate = Vector(coordinate)
    best = None
    for edge in boundary_edges:
        distance = _point_segment_distance(
            coordinate,
            edge["first"],
            edge["second"],
        )
        if best is None or distance < best[0]:
            best = (distance, int(edge["component"]), edge)
    if best is None or best[0] > 1e-7:
        return None
    return {
        "component": best[1],
        "distanceMeters": best[0],
        "edgeKey": best[2]["edgeKey"],
        "linkedSourceFaces": best[2]["linkedSourceFaces"],
    }


def _tagged_contour_topology_audit(
    bm: bmesh.types.BMesh,
    *,
    surface_fields: dict,
    contour_marker_layers: list,
) -> dict:
    """Audit the actual tagged cut edges, never scalar-rediscovered chords."""

    source_face_layer = bm.faces.layers.int.get("hinge_source_face")
    if source_face_layer is None:
        raise RuntimeError("Tagged contour audit lacks source-face identity")
    fields_by_index = {
        int(surface_field["index"]): surface_field
        for surface_field in surface_fields.values()
    }
    contour_edges = {index: [] for index in range(90)}
    for edge in bm.edges:
        if not edge.is_valid:
            continue
        for layer_index, layer in enumerate(contour_marker_layers):
            bits = int(edge[layer])
            while bits:
                lowest = bits & -bits
                bit_index = lowest.bit_length() - 1
                contour_index = (
                    layer_index * CONTOURS_PER_MARKER_LAYER + bit_index
                )
                if contour_index < 90:
                    contour_edges[contour_index].append(edge)
                bits ^= lowest

    contour_reports = []
    coordinate_memberships = {}
    coordinate_source_faces = {}
    for contour_index in range(90):
        surface_field = fields_by_index[contour_index]
        contour_id = (
            f"{surface_field['side']}/{surface_field['digit']}/"
            f"{surface_field['gasket']}/{surface_field['role']}"
        )
        graph = {}
        graph_coordinates = {}
        maximum_residual = 0.0
        edges_without_source_field = 0
        for edge in contour_edges[contour_index]:
            first_key = position_key(edge.verts[0].co)
            second_key = position_key(edge.verts[1].co)
            if first_key == second_key:
                continue
            graph.setdefault(first_key, set()).add(second_key)
            graph.setdefault(second_key, set()).add(first_key)
            graph_coordinates.setdefault(first_key, edge.verts[0].co.copy())
            graph_coordinates.setdefault(second_key, edge.verts[1].co.copy())
            linked_source_faces = {
                int(face[source_face_layer]) for face in edge.link_faces
            }
            coordinate_source_faces.setdefault(first_key, set()).update(
                linked_source_faces
            )
            coordinate_source_faces.setdefault(second_key, set()).update(
                linked_source_faces
            )
            midpoint = (edge.verts[0].co + edge.verts[1].co) * 0.5
            residuals = []
            for face in edge.link_faces:
                source_face_index = int(face[source_face_layer])
                if source_face_index not in surface_field["selectedSourceFaces"]:
                    continue
                residuals.append(
                    abs(
                        _evaluate_surface_field_face(
                            surface_field,
                            surface_field["sourceSurface"],
                            source_face_index,
                            midpoint,
                        )
                    )
                )
            if residuals:
                maximum_residual = max(maximum_residual, min(residuals))
            else:
                edges_without_source_field += 1

        components = []
        unseen = set(graph)
        while unseen:
            seed = min(unseen)
            stack = [seed]
            component = set()
            while stack:
                key = stack.pop()
                if key in component:
                    continue
                component.add(key)
                unseen.discard(key)
                stack.extend(graph[key] - component)
            components.append(component)
        degree_histogram = {}
        for neighbors in graph.values():
            degree = len(neighbors)
            degree_histogram[str(degree)] = (
                degree_histogram.get(str(degree), 0) + 1
            )
        component_reports = []
        for component_index, component in enumerate(components):
            endpoints = sorted(
                key for key in component if len(graph[key]) == 1
            )
            boundary_evidence = [
                _source_boundary_membership(
                    graph_coordinates[key],
                    surface_field["relativeBoundaryEdges"],
                )
                for key in endpoints
            ]
            thumb_partition = surface_field["sourceSurface"].get(
                "thumbAdjacentGasketPartition", {}
            ).get(surface_field["side"])
            for evidence in boundary_evidence:
                if evidence is None:
                    continue
                corridor_owner_sequence = []
                if thumb_partition is not None:
                    owner_by_source_face = thumb_partition[
                        "exclusiveCorridorOwnerBySourceFace"
                    ]
                    corridor_owner_sequence = [
                        owner_by_source_face.get(source_face_index)
                        for source_face_index in evidence[
                            "linkedSourceFaces"
                        ]
                    ]
                evidence["exclusiveAdjacentGasketOwners"] = sorted(
                    owner
                    for owner in corridor_owner_sequence
                    if owner is not None
                )
                evidence["exclusiveAdjacentGasketCap"] = (
                    surface_field["digit"] == "thumb"
                    and surface_field["gasket"] in {"G0", "G1"}
                    and len(evidence["linkedSourceFaces"]) == 2
                    and None not in corridor_owner_sequence
                    and sorted(corridor_owner_sequence) == ["G0", "G1"]
                )
            absolute = (
                len(component) >= 3
                and all(len(graph[key]) == 2 for key in component)
            )
            relative = (
                len(endpoints) == 2
                and all(item is not None for item in boundary_evidence)
                and boundary_evidence[0]["component"]
                == boundary_evidence[1]["component"]
                and all(len(graph[key]) in {1, 2} for key in component)
            )
            component_reports.append(
                {
                    "index": component_index,
                    "collapsedVertexCount": len(component),
                    "endpointCount": len(endpoints),
                    "boundaryEndpointEvidence": boundary_evidence,
                    "endpoints": [
                        {
                            "key": list(key),
                            "coordinate": [
                                float(value) for value in graph_coordinates[key]
                            ],
                            "sourceFaces": sorted(
                                coordinate_source_faces.get(key, set())
                            ),
                        }
                        for key in endpoints
                    ],
                    "absolute": absolute,
                    "relative": relative,
                    "valid": absolute or relative,
                }
            )
        paired_cap_boundary_components = set()
        paired_exclusive_cap_spanning = False
        if (
            surface_field["digit"] == "thumb"
            and surface_field["gasket"] in {"G0", "G1"}
            and len(component_reports) == 2
            and all(
                item["endpointCount"] == 2
                and all(
                    len(graph[key]) in {1, 2}
                    for key in components[item["index"]]
                )
                and all(
                    evidence is not None
                    and evidence["exclusiveAdjacentGasketCap"]
                    for evidence in item["boundaryEndpointEvidence"]
                )
                for item in component_reports
            )
        ):
            boundary_pairs = [
                tuple(
                    sorted(
                        evidence["component"]
                        for evidence in item["boundaryEndpointEvidence"]
                    )
                )
                for item in component_reports
            ]
            paired_cap_boundary_components = set(boundary_pairs[0])
            endpoint_counts_by_boundary = {
                component: sum(
                    evidence["component"] == component
                    for item in component_reports
                    for evidence in item["boundaryEndpointEvidence"]
                )
                for component in paired_cap_boundary_components
            }
            paired_exclusive_cap_spanning = (
                len(paired_cap_boundary_components) == 2
                and boundary_pairs[0] == boundary_pairs[1]
                and set(endpoint_counts_by_boundary.values()) == {2}
            )
        if paired_exclusive_cap_spanning:
            for item in component_reports:
                item["pairedExclusiveAdjacentGasketCap"] = True
                item["valid"] = True
        else:
            for item in component_reports:
                item["pairedExclusiveAdjacentGasketCap"] = False
        absolute_closed = bool(component_reports) and all(
            item["absolute"] for item in component_reports
        )
        boundary_relative_closed = any(
            item["relative"] for item in component_reports
        )
        valid_cycle = bool(component_reports) and all(
            item["valid"] for item in component_reports
        )
        endpoints = sorted(
            key for key, neighbors in graph.items() if len(neighbors) == 1
        )
        boundary_evidence = [
            evidence
            for component_report in component_reports
            for evidence in component_report["boundaryEndpointEvidence"]
        ]
        if valid_cycle:
            for key in graph:
                coordinate_memberships.setdefault(key, set()).add(contour_id)
        contour_reports.append(
            {
                "index": contour_index,
                "id": contour_id,
                "side": surface_field["side"],
                "digit": surface_field["digit"],
                "gasket": surface_field["gasket"],
                "role": surface_field["role"],
                "rawTaggedEdgeCount": len(contour_edges[contour_index]),
                "collapsedVertexCount": len(graph),
                "collapsedEdgeCount": sum(len(value) for value in graph.values())
                // 2,
                "componentCount": len(components),
                "absoluteComponentCount": sum(
                    item["absolute"] for item in component_reports
                ),
                "boundaryRelativeComponentCount": sum(
                    item["relative"] for item in component_reports
                ),
                "invalidComponentCount": sum(
                    not item["valid"] for item in component_reports
                ),
                "components": component_reports,
                "degreeHistogram": dict(sorted(degree_histogram.items())),
                "maximumChordResidual": maximum_residual,
                "edgesWithoutSourceFieldCount": edges_without_source_field,
                "absoluteClosed": absolute_closed,
                "boundaryRelativeClosed": boundary_relative_closed,
                "pairedExclusiveAdjacentGasketCapSpanning": (
                    paired_exclusive_cap_spanning
                ),
                "pairedExclusiveAdjacentGasketCapBoundaryComponents": (
                    sorted(paired_cap_boundary_components)
                    if paired_exclusive_cap_spanning
                    else []
                ),
                "boundaryEndpointCount": len(endpoints),
                "boundaryEndpointEvidence": boundary_evidence,
                "closed": valid_cycle,
            }
        )

    cross_joint_positions = []
    for key, memberships in coordinate_memberships.items():
        joints = {"/".join(value.split("/")[:3]) for value in memberships}
        if len(joints) > 1:
            cross_joint_positions.append(
                {
                    "key": list(key),
                    "contours": sorted(memberships),
                    "joints": sorted(joints),
                    "sourceFaces": sorted(coordinate_source_faces.get(key, set())),
                }
            )
    valid_count = sum(item["closed"] for item in contour_reports)
    return {
        "schemaVersion": 2,
        "method": "persistent contour-bit edge tags; 1-micron position collapse",
        "contourCount": len(contour_reports),
        "absoluteClosedContourCount": sum(
            item["absoluteClosed"] for item in contour_reports
        ),
        "boundaryRelativeClosedContourCount": sum(
            item["boundaryRelativeClosed"] for item in contour_reports
        ),
        "pairedExclusiveAdjacentGasketCapContourCount": sum(
            item["pairedExclusiveAdjacentGasketCapSpanning"]
            for item in contour_reports
        ),
        "componentCount": sum(
            item["componentCount"] for item in contour_reports
        ),
        "absoluteComponentCount": sum(
            item["absoluteComponentCount"] for item in contour_reports
        ),
        "boundaryRelativeComponentCount": sum(
            item["boundaryRelativeComponentCount"] for item in contour_reports
        ),
        "boundaryEndpointCount": sum(
            item["boundaryEndpointCount"] for item in contour_reports
        ),
        "multiComponentContourCount": sum(
            item["componentCount"] > 1 for item in contour_reports
        ),
        "closedContourCount": valid_count,
        "allContoursClosed": valid_count == 90,
        "crossJointContourIntersectionCount": len(cross_joint_positions),
        "crossJointContourIntersections": cross_joint_positions,
        "contours": contour_reports,
    }


def _source_record_topology_state(record: dict) -> int | None:
    """Translate one authored source zone into the ten ordered cut cells."""

    zone = record.get("zone")
    if zone == "H":
        return 0
    if zone in {"S0", "S1", "S2"}:
        return 3 * (int(zone[1]) + 1)
    if zone in GASKETS:
        blend = record.get("blend")
        if blend is None:
            return None
        gasket_index = GASKETS.index(zone)
        return 3 * gasket_index + (1 if float(blend) < 0.5 else 2)
    return None


def _topology_state_zone(state: int) -> tuple[str, int | None]:
    """Return the mechanical zone and gasket index for a cut-cell state."""

    rigid = {0: "H", 3: "S0", 6: "S1", 9: "S2"}
    if state in rigid:
        return rigid[state], None
    if not 0 <= state <= 9:
        raise RuntimeError(f"Invalid hinge topology state {state}")
    gasket_index = (state - 1) // 3
    return GASKETS[gasket_index], gasket_index


def _edge_contour_mask(edge, contour_marker_layers: list) -> int:
    mask = 0
    for layer_index, layer in enumerate(contour_marker_layers):
        layer_mask = int(edge[layer])
        if layer_mask < 0:
            raise RuntimeError("Negative persistent contour marker bitset")
        mask |= layer_mask << (layer_index * CONTOURS_PER_MARKER_LAYER)
    return mask


def _face_affine_root_segment(
    face: bmesh.types.BMFace,
    *,
    surface_field: dict,
    source_surface: dict,
    source_face_index: int,
) -> tuple[list[dict], list]:
    """Return one raw-P1 chord and its supporting geometric edge keys."""

    roots = {}
    zero_edges = []
    for loop in face.loops:
        first = loop.vert
        second = loop.link_loop_next.vert
        first_value = _evaluate_surface_field_face(
            surface_field,
            source_surface,
            source_face_index,
            first.co,
        )
        second_value = _evaluate_surface_field_face(
            surface_field,
            source_surface,
            source_face_index,
            second.co,
        )
        edge_key = tuple(
            sorted((position_key(first.co), position_key(second.co)))
        )
        if (
            abs(first_value) <= CONTOUR_SCALAR_TOLERANCE
            and abs(second_value) <= CONTOUR_SCALAR_TOLERANCE
        ):
            zero_edges.append(loop.edge)
            continue
        if abs(first_value) <= CONTOUR_SCALAR_TOLERANCE:
            coordinate = first.co.copy()
        elif abs(second_value) <= CONTOUR_SCALAR_TOLERANCE:
            coordinate = second.co.copy()
        elif (first_value < 0.0) == (second_value < 0.0):
            continue
        else:
            factor = first_value / (first_value - second_value)
            coordinate = first.co.lerp(second.co, factor)
        key = position_key(coordinate)
        record = roots.setdefault(
            key,
            {"key": key, "coordinate": coordinate.copy(), "edgeKeys": set()},
        )
        record["edgeKeys"].add(edge_key)
    return list(roots.values()), zero_edges


def _segment_distance(
    first_start: Vector,
    first_end: Vector,
    second_start: Vector,
    second_end: Vector,
) -> float:
    """Return the shortest distance between two finite 3-D segments."""

    first_direction = first_end - first_start
    second_direction = second_end - second_start
    offset = first_start - second_start
    first_length_squared = first_direction.length_squared
    second_length_squared = second_direction.length_squared
    epsilon = 1e-24
    if first_length_squared <= epsilon and second_length_squared <= epsilon:
        return offset.length
    if first_length_squared <= epsilon:
        first_parameter = 0.0
        second_parameter = max(
            0.0,
            min(
                1.0,
                second_direction.dot(-offset) / second_length_squared,
            ),
        )
    else:
        first_projection = first_direction.dot(offset)
        if second_length_squared <= epsilon:
            second_parameter = 0.0
            first_parameter = max(
                0.0,
                min(1.0, -first_projection / first_length_squared),
            )
        else:
            mutual_projection = first_direction.dot(second_direction)
            second_projection = second_direction.dot(offset)
            denominator = (
                first_length_squared * second_length_squared
                - mutual_projection * mutual_projection
            )
            if abs(denominator) > epsilon:
                first_parameter = max(
                    0.0,
                    min(
                        1.0,
                        (
                            mutual_projection * second_projection
                            - first_projection * second_length_squared
                        )
                        / denominator,
                    ),
                )
            else:
                first_parameter = 0.0
            second_parameter = (
                mutual_projection * first_parameter + second_projection
            ) / second_length_squared
            if second_parameter < 0.0:
                second_parameter = 0.0
                first_parameter = max(
                    0.0,
                    min(1.0, -first_projection / first_length_squared),
                )
            elif second_parameter > 1.0:
                second_parameter = 1.0
                first_parameter = max(
                    0.0,
                    min(
                        1.0,
                        (
                            mutual_projection - first_projection
                        )
                        / first_length_squared,
                    ),
                )
    first_closest = first_start + first_direction * first_parameter
    second_closest = second_start + second_direction * second_parameter
    return (first_closest - second_closest).length


def _raw_bridge_candidate(
    *,
    component: int,
    states: set[int],
    component_faces: dict,
    component_owner: dict,
    face_by_index: dict,
    face_source: dict,
    face_component: dict,
    eligible_faces: set[int],
    geometric_edges: dict,
    ordered_fields: dict,
    contour_by_index: dict,
) -> dict:
    """Prove the complete required raw-P1 central closure set for one disk."""

    owner = component_owner[component]
    source_surface = ordered_fields[owner][0]["sourceSurface"]
    required_ranks = [
        rank
        for rank in (2, 3)
        if min(states) <= rank < max(states)
    ]
    physical_positions_by_rank = {2: set(), 3: set()}
    physical_ranks_by_position = {}
    for edge_key, edge_record in geometric_edges.items():
        mask = edge_record["mask"]
        if not mask:
            continue
        metadata = contour_by_index[mask.bit_length() - 1]
        if (metadata["side"], metadata["digit"]) != owner:
            continue
        for key in edge_key:
            physical_ranks_by_position.setdefault(key, set()).add(
                metadata["rank"]
            )
            if metadata["rank"] in physical_positions_by_rank:
                physical_positions_by_rank[metadata["rank"]].add(key)

    rank_reports = []
    segment_keys_by_rank = {}
    segment_records_by_rank = {}
    complete = bool(required_ranks)
    for rank in required_ranks:
        surface_field = ordered_fields[owner][rank]
        graph = {}
        endpoint_edges = {}
        face_segments = []
        edge_root_samples = {}
        multi_root_face_count = 0
        for face_index in component_faces[component]:
            roots, zero_edges = _face_affine_root_segment(
                face_by_index[face_index],
                surface_field=surface_field,
                source_surface=source_surface,
                source_face_index=face_source[face_index],
            )
            if zero_edges:
                for edge in zero_edges:
                    first_key = position_key(edge.verts[0].co)
                    second_key = position_key(edge.verts[1].co)
                    if first_key == second_key:
                        continue
                    graph.setdefault(first_key, set()).add(second_key)
                    graph.setdefault(second_key, set()).add(first_key)
                    edge_key = tuple(sorted((first_key, second_key)))
                    endpoint_edges.setdefault(first_key, set()).add(edge_key)
                    endpoint_edges.setdefault(second_key, set()).add(edge_key)
                    face_segments.append(
                        {
                            "keys": (first_key, second_key),
                            "coordinates": (
                                edge.verts[0].co.copy(),
                                edge.verts[1].co.copy(),
                            ),
                        }
                    )
                continue
            if len(roots) > 2:
                multi_root_face_count += 1
                continue
            if len(roots) != 2:
                continue
            first, second = roots
            if first["key"] == second["key"]:
                continue
            graph.setdefault(first["key"], set()).add(second["key"])
            graph.setdefault(second["key"], set()).add(first["key"])
            endpoint_edges.setdefault(first["key"], set()).update(
                first["edgeKeys"]
            )
            endpoint_edges.setdefault(second["key"], set()).update(
                second["edgeKeys"]
            )
            for root in (first, second):
                for edge_key in root["edgeKeys"]:
                    edge_root_samples.setdefault(edge_key, []).append(
                        root["coordinate"].copy()
                    )
            face_segments.append(
                {
                    "keys": (first["key"], second["key"]),
                    "coordinates": (
                        first["coordinate"].copy(),
                        second["coordinate"].copy(),
                    ),
                }
            )

        components = []
        unseen = set(graph)
        while unseen:
            seed = min(unseen)
            stack = [seed]
            nodes = set()
            while stack:
                node = stack.pop()
                if node in nodes:
                    continue
                nodes.add(node)
                unseen.discard(node)
                stack.extend(graph[node] - nodes)
            components.append(nodes)
        chain_components = [
            nodes
            for nodes in components
            if sum(len(graph[node]) == 1 for node in nodes) == 2
            and all(len(graph[node]) in {1, 2} for node in nodes)
        ]
        endpoint_records = []
        endpoint_complete = bool(components) and (
            len(chain_components) == len(components)
        )
        if endpoint_complete:
            endpoints = sorted(
                node
                for nodes in chain_components
                for node in nodes
                if len(graph[node]) == 1
            )
            for endpoint in endpoints:
                matching_tag = endpoint in physical_positions_by_rank[rank]
                cross_ranks = physical_ranks_by_position.get(endpoint, set()) - {
                    rank
                }
                boundary = False
                routed_cap_boundary = False
                for edge_key in endpoint_edges.get(endpoint, set()):
                    geometric_edge = geometric_edges.get(edge_key, {})
                    if geometric_edge.get("routedCap"):
                        routed_cap_boundary = True
                    incident = geometric_edge.get("faces", set()) & eligible_faces
                    incident_components = {
                        face_component[index] for index in incident
                    }
                    if incident_components - {component} or len(incident) < 2:
                        boundary = True
                valid = (
                    not cross_ranks
                    and not routed_cap_boundary
                    and (matching_tag or boundary)
                )
                endpoint_records.append(
                    {
                        "key": list(endpoint),
                        "matchingTag": matching_tag,
                        "crossRanks": sorted(cross_ranks),
                        "routedBoundary": boundary,
                        "routedCapBoundary": routed_cap_boundary,
                        "valid": valid,
                    }
                )
            endpoint_complete = all(item["valid"] for item in endpoint_records)
        maximum_shared_edge_root_disagreement = 0.0
        shared_edge_root_violation_count = 0
        for samples in edge_root_samples.values():
            for first_offset, first_coordinate in enumerate(samples):
                for second_coordinate in samples[first_offset + 1 :]:
                    disagreement = (
                        first_coordinate - second_coordinate
                    ).length
                    maximum_shared_edge_root_disagreement = max(
                        maximum_shared_edge_root_disagreement,
                        disagreement,
                    )
                    if disagreement > MAXIMUM_RECORDED_ROOT_DISPLACEMENT:
                        shared_edge_root_violation_count += 1
        rank_complete = (
            multi_root_face_count == 0
            and bool(components)
            and len(chain_components) == len(components)
            and endpoint_complete
            and shared_edge_root_violation_count == 0
        )
        complete = complete and rank_complete
        segment_keys_by_rank[rank] = {
            tuple(sorted(segment["keys"])) for segment in face_segments
        }
        segment_records_by_rank[rank] = face_segments
        rank_reports.append(
            {
                "rank": rank,
                "segmentCount": len(face_segments),
                "componentCount": len(components),
                "chainComponentCount": len(chain_components),
                "multiRootFaceCount": multi_root_face_count,
                "maximumSharedEdgeRootDisagreementMeters": (
                    maximum_shared_edge_root_disagreement
                ),
                "sharedEdgeRootViolationCount": (
                    shared_edge_root_violation_count
                ),
                "endpoints": endpoint_records,
                "complete": rank_complete,
            }
        )
    shared_segments = set()
    if 2 in segment_keys_by_rank and 3 in segment_keys_by_rank:
        shared_segments = (
            segment_keys_by_rank[2] & segment_keys_by_rank[3]
        )
        if shared_segments:
            complete = False
    cross_rank_intersections = []
    if 2 in segment_records_by_rank and 3 in segment_records_by_rank:
        for proximal_segment in segment_records_by_rank[2]:
            for distal_segment in segment_records_by_rank[3]:
                distance = _segment_distance(
                    *proximal_segment["coordinates"],
                    *distal_segment["coordinates"],
                )
                if distance <= MAXIMUM_RECORDED_ROOT_DISPLACEMENT:
                    cross_rank_intersections.append(
                        {
                            "proximal": proximal_segment["keys"],
                            "distal": distal_segment["keys"],
                            "distanceMeters": distance,
                        }
                    )
        if cross_rank_intersections:
            complete = False
    return {
        "requiredRanks": required_ranks,
        "ranks": rank_reports,
        "sharedSegmentCount": len(shared_segments),
        "crossRankIntersectionCount": len(cross_rank_intersections),
        "crossRankIntersections": cross_rank_intersections,
        "complete": complete,
    }


def _classify_cut_topology(
    bm: bmesh.types.BMesh,
    *,
    surface_fields: dict,
    contour_marker_layers: list,
    virtual_contour_layer,
    inactive_cap_layer,
    inactive_virtual_tangent_layer,
    forced_state_face_layer,
    bridge_face_layer,
    source_zone_records: dict,
    effective_spec: dict,
    hand_region_minimum_y: float,
    closure_pass: int = 0,
    closure_records: list | None = None,
) -> tuple[dict, dict]:
    """Classify hand weights from the inserted seam barriers, not coordinates."""

    if closure_records is None:
        closure_records = []
    if closure_pass > 8:
        raise RuntimeError("Thumb cap closure classification did not converge")
    if len(surface_fields) != 90:
        raise RuntimeError("Topology classification requires all 90 contours")
    source_surface = next(iter(surface_fields.values()))["sourceSurface"]
    source_face_layer = source_surface["sourceFaceLayer"]
    ordered_fields = {}
    contour_by_index = {}
    for side in SIDES:
        for digit in DIGITS:
            fields = []
            for gasket_index, gasket in enumerate(GASKETS):
                for role_index, (field, role, raw_blend) in enumerate(
                    CONTOUR_FIELDS
                ):
                    surface_field = surface_fields[
                        (side, digit, gasket, field)
                    ]
                    contour_index = int(surface_field["index"])
                    rank = 3 * gasket_index + role_index
                    metadata = {
                        "index": contour_index,
                        "side": side,
                        "digit": digit,
                        "gasket": gasket,
                        "field": field,
                        "role": role,
                        "rank": rank,
                        "rawBlendT": raw_blend,
                        "surfaceField": surface_field,
                    }
                    if contour_index in contour_by_index:
                        raise RuntimeError("Duplicate contour index in flood map")
                    contour_by_index[contour_index] = metadata
                    fields.append(surface_field)
            ordered_fields[(side, digit)] = fields
    if set(contour_by_index) != set(range(90)):
        raise RuntimeError("Persistent contour indices are not exactly 0..89")

    bm.verts.ensure_lookup_table()
    bm.edges.ensure_lookup_table()
    bm.faces.ensure_lookup_table()
    bm.verts.index_update()
    bm.edges.index_update()
    bm.faces.index_update()

    edge_copies = {}
    for edge in bm.edges:
        edge_key = tuple(
            sorted(
                (
                    position_key(edge.verts[0].co),
                    position_key(edge.verts[1].co),
                )
            )
        )
        if edge_key[0] == edge_key[1]:
            raise RuntimeError(
                "Collapsed zero-length edge in hinge topology: "
                f"pass={closure_pass} "
                f"edgeIndex={edge.index} "
                f"vertexIndices={[vertex.index for vertex in edge.verts]} "
                "coordinates="
                f"{[[float(value) for value in vertex.co] for vertex in edge.verts]} "
                f"lengthMeters={edge.calc_length()} key={edge_key[0]} "
                "physicalMask="
                f"{_edge_contour_mask(edge, contour_marker_layers)} "
                f"virtualMask={int(edge[virtual_contour_layer])} "
                f"inactive={int(edge[inactive_cap_layer])} "
                "inactiveVirtualMask="
                f"{int(edge[inactive_virtual_tangent_layer])} "
                "incidentSourceFaces="
                f"{sorted(int(face[source_face_layer]) for face in edge.link_faces)} "
                "incidentFaceIndices="
                f"{sorted(face.index for face in edge.link_faces)} "
                "incidentBridgeMarkers="
                f"{sorted({int(face[bridge_face_layer]) for face in edge.link_faces})} "
                "incidentForcedStates="
                f"{sorted({int(face[forced_state_face_layer]) - 1 for face in edge.link_faces if int(face[forced_state_face_layer]) > 0})}"
            )
        edge_copies.setdefault(edge_key, []).append(edge)

    geometric_edges = {}
    marker_copy_conflicts = []
    multi_contour_edges = []
    for edge_key, copies in edge_copies.items():
        copy_masks = {_edge_contour_mask(edge, contour_marker_layers) for edge in copies}
        virtual_masks = {int(edge[virtual_contour_layer]) for edge in copies}
        inactive_values = {int(edge[inactive_cap_layer]) for edge in copies}
        inactive_virtual_masks = {
            int(edge[inactive_virtual_tangent_layer]) for edge in copies
        }
        if (
            len(copy_masks) != 1
            or len(virtual_masks) != 1
            or len(inactive_values) != 1
            or len(inactive_virtual_masks) != 1
        ):
            marker_copy_conflicts.append(edge_key)
            continue
        mask = next(iter(copy_masks))
        virtual_mask = next(iter(virtual_masks))
        inactive = bool(next(iter(inactive_values)))
        inactive_virtual_mask = next(iter(inactive_virtual_masks))
        if mask.bit_count() > 1:
            multi_contour_edges.append(edge_key)
            continue
        if virtual_mask.bit_count() > 1 or virtual_mask & ~((1 << 2) | (1 << 3)):
            raise RuntimeError(
                "Virtual closure edge has an invalid ordered-rank mask"
            )
        if mask and virtual_mask:
            raise RuntimeError(
                "One geometric edge is both recorded and virtual contour"
            )
        if inactive and not mask:
            raise RuntimeError(
                "Inactive cap disposition is attached to a non-recorded edge"
            )
        if inactive_virtual_mask.bit_count() > 1 or inactive_virtual_mask & ~(
            (1 << 2) | (1 << 3)
        ):
            raise RuntimeError("Inactive virtual tangent has an invalid rank")
        if inactive_virtual_mask and (mask or virtual_mask or inactive):
            raise RuntimeError(
                "Inactive virtual tangent overlaps another edge disposition"
            )
        incident_faces = {
            face.index
            for edge in copies
            for face in edge.link_faces
            if face.is_valid
        }
        geometric_edges[edge_key] = {
            "mask": mask,
            "virtualMask": virtual_mask,
            "inactive": inactive,
            "inactiveVirtualMask": inactive_virtual_mask,
            "faces": incident_faces,
        }
    if marker_copy_conflicts:
        raise RuntimeError(
            "Position-collapsed edge copies disagree on contour masks: "
            f"{len(marker_copy_conflicts)}"
        )
    if multi_contour_edges:
        raise RuntimeError(
            "One geometric edge carries multiple logical hinge contours: "
            f"{len(multi_contour_edges)}"
        )

    eligible_faces = set()
    face_owner = {}
    face_source = {}
    face_membership = {}
    face_by_index = {}
    position_faces = {}
    coordinates = {}
    for face in bm.faces:
        if not face.is_valid or max(vertex.co.y for vertex in face.verts) < (
            hand_region_minimum_y
        ):
            continue
        source_face_index = int(face[source_face_layer])
        owner = source_surface["digitOwnerByFace"].get(source_face_index)
        if owner not in {
            (side, digit) for side in SIDES for digit in DIGITS
        }:
            raise RuntimeError(
                f"Hand face {face.index} has no immutable digit owner"
            )
        eligible_faces.add(face.index)
        face_by_index[face.index] = face
        face_owner[face.index] = owner
        face_source[face.index] = source_face_index
        face_membership[face.index] = tuple(
            source_face_index in surface_field["selectedSourceFaces"]
            for surface_field in ordered_fields[owner]
        )
        for vertex in face.verts:
            key = position_key(vertex.co)
            position_faces.setdefault(key, set()).add(face.index)
            coordinates.setdefault(key, vertex.co.copy())
    if not eligible_faces:
        raise RuntimeError("Topology classifier found no hand faces")

    # Immutable source-edge proof for the non-mechanical boundary between the
    # exclusive thumb G0 and G1 routing corridors.  These are classifier caps,
    # not modeled seams: they must never acquire a contour mask or a weight
    # interface merely because selected-field memberships differ across them.
    routed_cap_source_edges_by_side = {}
    for side in SIDES:
        partition = source_surface["thumbAdjacentGasketPartition"][side]
        corridor_owner = partition[
            "exclusiveCorridorOwnerBySourceFace"
        ]
        g0_boundary_edges = {
            record["edgeKey"]
            for record in ordered_fields[(side, "thumb")][0][
                "relativeBoundaryEdges"
            ]
        }
        g1_boundary_edges = {
            record["edgeKey"]
            for record in ordered_fields[(side, "thumb")][3][
                "relativeBoundaryEdges"
            ]
        }
        cap_source_edges = {}
        for source_edge_key, linked_faces in source_surface[
            "weldedEdgeFaces"
        ].items():
            linked_faces = tuple(sorted(linked_faces))
            if len(linked_faces) != 2:
                continue
            owner_sequence = [
                corridor_owner.get(source_face_index)
                for source_face_index in linked_faces
            ]
            if (
                None in owner_sequence
                or sorted(owner_sequence) != ["G0", "G1"]
            ):
                continue
            if (
                source_edge_key not in g0_boundary_edges
                or source_edge_key not in g1_boundary_edges
            ):
                raise RuntimeError(
                    f"{side} thumb exclusive G0/G1 source edge lacks both "
                    "corridor-boundary proofs"
                )
            cap_source_edges[source_edge_key] = {
                "sourceEdgeKey": source_edge_key,
                "linkedSourceFaces": linked_faces,
                "exclusiveOwners": tuple(owner_sequence),
            }
        routed_cap_source_edges_by_side[side] = cap_source_edges

    inactive_cap_edges = []
    for edge_key, edge_record in geometric_edges.items():
        physical_mask = edge_record["mask"]
        edge_record["weightMask"] = (
            0 if edge_record["inactive"] else physical_mask
        )
        if edge_record["inactive"]:
            contour_index = physical_mask.bit_length() - 1
            metadata = contour_by_index[contour_index]
            inactive_cap_edges.append(
                {
                    "edgeKey": edge_key,
                    "contourIndex": contour_index,
                    "rank": metadata["rank"],
                    "owner": (metadata["side"], metadata["digit"]),
                }
            )

    adjacency = {face_index: set() for face_index in eligible_faces}
    virtual_edges = []
    # A source-field membership change is only a cut barrier where an active
    # physical or virtual contour actually reaches one of the edge endpoints.
    # Untagged membership changes are routing evidence inside one uncut cell;
    # flooding across them lets the raw-P1 closure qualifier see the complete
    # conflicting state interval before the central cap solver runs.
    precomputed_tagged_position_keys = {
        key
        for edge_key, edge_record in geometric_edges.items()
        if edge_record["weightMask"] or edge_record["virtualMask"]
        for key in edge_key
    }
    traversable_untagged_membership_boundary_count = 0
    tagged_membership_barrier_count = 0
    routed_cap_boundary_count = 0
    for edge_key, edge_record in geometric_edges.items():
        incident = edge_record["faces"] & eligible_faces
        if (
            len(incident) < 2
            or edge_record["weightMask"]
            or edge_record["virtualMask"]
        ):
            continue
        by_owner = {}
        for face_index in incident:
            by_owner.setdefault(face_owner[face_index], []).append(face_index)
        for owner, owner_faces in by_owner.items():
            by_membership = {}
            for face_index in owner_faces:
                by_membership.setdefault(
                    face_membership[face_index], []
                ).append(face_index)
            for membership_faces in by_membership.values():
                for first_offset, first_face in enumerate(membership_faces):
                    for second_face in membership_faces[first_offset + 1 :]:
                        adjacency[first_face].add(second_face)
                        adjacency[second_face].add(first_face)
            if len(by_membership) > 1:
                tagged_endpoint_keys = tuple(
                    key
                    for key in edge_key
                    if key in precomputed_tagged_position_keys
                )
                changed_ranks = sorted(
                    {
                        rank
                        for first_membership in by_membership
                        for second_membership in by_membership
                        for rank, (first_value, second_value) in enumerate(
                            zip(first_membership, second_membership)
                        )
                        if first_value != second_value
                    }
                )
                routed_cap_matches = []
                if owner[1] == "thumb":
                    first_coordinate = coordinates[edge_key[0]]
                    second_coordinate = coordinates[edge_key[1]]
                    for source_edge_record in (
                        routed_cap_source_edges_by_side[owner[0]].values()
                    ):
                        source_first, source_second = source_surface[
                            "weldedEdgeCoordinates"
                        ][source_edge_record["sourceEdgeKey"]]
                        if max(
                            _point_segment_distance(
                                first_coordinate,
                                source_first,
                                source_second,
                            ),
                            _point_segment_distance(
                                second_coordinate,
                                source_first,
                                source_second,
                            ),
                        ) <= 1e-7:
                            routed_cap_matches.append(source_edge_record)
                if len(routed_cap_matches) > 1:
                    raise RuntimeError(
                        "One routed membership edge matches multiple immutable "
                        "G0/G1 cap source edges"
                    )
                routed_cap_evidence = (
                    routed_cap_matches[0] if routed_cap_matches else None
                )
                routed_cap = routed_cap_evidence is not None
                edge_record["routedCap"] = routed_cap
                virtual_edges.append(
                    {
                        "edgeKey": edge_key,
                        "owner": owner,
                        "faces": set(owner_faces),
                        "sourceFaces": {
                            face_source[face_index]
                            for face_index in owner_faces
                        },
                        "memberships": tuple(sorted(by_membership)),
                        "changedRanks": tuple(changed_ranks),
                        "taggedEndpointKeys": tagged_endpoint_keys,
                        "routedCap": routed_cap,
                        "routedCapEvidence": routed_cap_evidence,
                    }
                )
                if routed_cap:
                    routed_cap_boundary_count += 1
                elif tagged_endpoint_keys:
                    tagged_membership_barrier_count += 1
                else:
                    # This is not a modeled hinge yet.  Keep the membership
                    # record for audit, but traverse it as ordinary mesh
                    # adjacency so missing intermediate contours are proven
                    # and inserted by the raw closure pass.
                    traversable_untagged_membership_boundary_count += 1
                    for first_offset, first_face in enumerate(owner_faces):
                        for second_face in owner_faces[first_offset + 1 :]:
                            adjacency[first_face].add(second_face)
                            adjacency[second_face].add(first_face)

    face_component = {}
    component_faces = {}
    component_owner = {}
    component_index = 0
    for seed in sorted(eligible_faces):
        if seed in face_component:
            continue
        owner = face_owner[seed]
        stack = [seed]
        faces = set()
        while stack:
            face_index = stack.pop()
            if face_index in faces:
                continue
            if face_owner[face_index] != owner:
                raise RuntimeError("Digit-domain flood crossed immutable owner")
            faces.add(face_index)
            face_component[face_index] = component_index
            stack.extend(adjacency[face_index] - faces)
        component_faces[component_index] = faces
        component_owner[component_index] = owner
        component_index += 1
    if set(face_component) != eligible_faces:
        raise RuntimeError("Hand-face topology flood coverage is incomplete")

    position_interfaces = {}
    position_physical_contours = {}
    position_virtual_interfaces = {}
    component_assignments = {index: set() for index in component_faces}
    component_assignment_evidence = {
        index: set() for index in component_faces
    }
    component_assignment_edges = {
        index: [] for index in component_faces
    }
    component_forced_states = {}
    for component, faces in component_faces.items():
        forced_states = {
            int(face_by_index[face_index][forced_state_face_layer]) - 1
            for face_index in faces
            if int(face_by_index[face_index][forced_state_face_layer]) > 0
        }
        if len(forced_states) > 1:
            raise RuntimeError(
                "One merged cap component carries conflicting forced states: "
                f"pass={closure_pass} component={component} "
                f"owner={component_owner[component]} "
                f"forcedStates={sorted(forced_states)} "
                "sourceFaces="
                f"{sorted({face_source[index] for index in faces})} "
                "forcedFaceCounts="
                f"{dict(sorted((state, sum(int(face_by_index[index][forced_state_face_layer]) == state + 1 for index in faces)) for state in forced_states))}"
            )
        if forced_states and component_owner[component][1] != "thumb":
            raise RuntimeError("Forced cap state escaped the thumb domain")
        component_forced_states[component] = forced_states
        if forced_states:
            forced_state = next(iter(forced_states))
            component_assignments[component].add(forced_state)
            component_assignment_evidence[component].add(
                (-1, -1, forced_state, -1)
            )
    tagged_interface_count = 0
    virtual_interface_count = 0
    single_sided_central_components = set()
    single_sided_central_edge_count = 0
    one_sided_virtual_tangent_edges = []
    for edge_key, edge_record in geometric_edges.items():
        mask = edge_record["weightMask"]
        virtual_mask = edge_record["virtualMask"]
        if not mask and not virtual_mask:
            continue
        if mask:
            contour_index = mask.bit_length() - 1
            metadata = contour_by_index[contour_index]
            owner = (metadata["side"], metadata["digit"])
            interface_kind = "activeInterface"
        else:
            contour_index = None
            rank = virtual_mask.bit_length() - 1
            incident_owners = {
                face_owner[face_index]
                for face_index in edge_record["faces"] & eligible_faces
            }
            if len(incident_owners) != 1:
                raise RuntimeError(
                    "Virtual closure edge lacks one immutable digit owner"
                )
            owner = next(iter(incident_owners))
            surface_field = ordered_fields[owner][rank]
            metadata = {
                "side": owner[0],
                "digit": owner[1],
                "gasket": surface_field["gasket"],
                "field": surface_field["field"],
                "role": surface_field["role"],
                "rank": rank,
                "rawBlendT": surface_field["rawBlendT"],
                "surfaceField": surface_field,
            }
            interface_kind = "virtualContinuation"
            virtual_interface_count += 1
        interface_id = (owner[0], owner[1], metadata["rank"])
        for key in edge_key:
            position_interfaces.setdefault(key, set()).add(interface_id)
            if mask:
                position_physical_contours.setdefault(key, set()).add(
                    contour_index
                )
            else:
                position_virtual_interfaces.setdefault(key, set()).add(
                    interface_id
                )
        incident = [
            face_index
            for face_index in edge_record["faces"] & eligible_faces
            if face_owner[face_index] == owner
        ]
        interface_states = set()
        interface_evidence = []
        for face_index in incident:
            face = face_by_index[face_index]
            value = _evaluate_surface_field_face(
                metadata["surfaceField"],
                source_surface,
                face_source[face_index],
                face.calc_center_median(),
            )
            if abs(value) <= AFFINE_SCALAR_TOLERANCE:
                raise RuntimeError(
                    "Tagged contour has an affine-zero incident face centroid"
                )
            state = metadata["rank"] if value < 0.0 else metadata["rank"] + 1
            component = face_component[face_index]
            component_assignments[component].add(state)
            component_assignment_evidence[component].add(
                (
                    contour_index if contour_index is not None else -2,
                    metadata["rank"],
                    state,
                    face_source[face_index],
                )
            )
            component_assignment_edges[component].append(
                {
                    "edgeKey": edge_key,
                    "kind": interface_kind,
                    "contourIndex": contour_index,
                    "rank": metadata["rank"],
                    "state": state,
                }
            )
            interface_states.add(state)
            interface_evidence.append(
                {
                    "faceIndex": face_index,
                    "sourceFaceIndex": face_source[face_index],
                    "value": value,
                    "state": state,
                    "forcedState": (
                        int(face[forced_state_face_layer]) - 1
                        if int(face[forced_state_face_layer]) > 0
                        else None
                    ),
                }
            )
        expected_states = {metadata["rank"], metadata["rank"] + 1}
        edge_record["interfaceOwner"] = owner
        edge_record["interfaceRank"] = metadata["rank"]
        edge_record["interfaceStates"] = set(interface_states)
        if interface_states != expected_states:
            one_sided_virtual_tangent = (
                interface_kind == "virtualContinuation"
                and owner[1] == "thumb"
                and metadata["rank"] in {2, 3}
                and len(interface_states) == 1
                and interface_states < expected_states
            )
            one_sided_central_cap = (
                interface_kind == "activeInterface"
                and owner[1] == "thumb"
                and metadata["rank"] in {1, 2, 3, 4}
                and len(interface_states) == 1
                and interface_states < expected_states
            )
            if not one_sided_central_cap and not one_sided_virtual_tangent:
                raise RuntimeError(
                    f"{interface_kind} rank {metadata['rank']} edge does not "
                    "separate ordered "
                    f"states {sorted(expected_states)}: {sorted(interface_states)}; "
                    f"edgeKey={edge_key}; owner={owner}; "
                    f"contourIndex={contour_index}; evidence={interface_evidence}; "
                    f"physicalMask={edge_record['mask']}; "
                    f"virtualMask={edge_record['virtualMask']}; "
                    f"inactive={edge_record['inactive']}"
                )
            if one_sided_virtual_tangent:
                edge_record["oneSidedVirtualTangent"] = True
                one_sided_virtual_tangent_edges.append(edge_key)
            else:
                edge_record["oneSidedCentralCap"] = True
                single_sided_central_edge_count += 1
                single_sided_central_components.update(
                    face_component[face_index] for face_index in incident
                )
        else:
            edge_record["oneSidedCentralCap"] = False
            edge_record["oneSidedVirtualTangent"] = False
        tagged_interface_count += 1

    if set(position_interfaces) != precomputed_tagged_position_keys:
        raise RuntimeError(
            "Precomputed active-interface endpoints changed during topology "
            "flood construction"
        )

    if one_sided_virtual_tangent_edges:
        tangent_components_audit = []
        grouped_candidates = {}
        for edge_key in one_sided_virtual_tangent_edges:
            edge_record = geometric_edges[edge_key]
            group_key = (
                edge_record["interfaceOwner"],
                edge_record["interfaceRank"],
            )
            grouped_candidates.setdefault(group_key, set()).add(edge_key)
        for (owner, rank), candidate_edges in grouped_candidates.items():
            expected_states = {rank, rank + 1}
            kept_edges = {
                edge_key
                for edge_key, edge_record in geometric_edges.items()
                if edge_key not in candidate_edges
                and edge_record.get("interfaceOwner") == owner
                and edge_record.get("interfaceRank") == rank
                and edge_record.get("interfaceStates") == expected_states
                and (
                    edge_record["weightMask"]
                    or edge_record["virtualMask"]
                )
            }
            kept_physical_nodes = {
                key
                for edge_key in kept_edges
                if geometric_edges[edge_key]["weightMask"]
                for key in edge_key
            }
            kept_graph = {}
            for first, second in kept_edges:
                kept_graph.setdefault(first, set()).add(second)
                kept_graph.setdefault(second, set()).add(first)
            candidate_graph = {}
            for first, second in candidate_edges:
                candidate_graph.setdefault(first, set()).add(second)
                candidate_graph.setdefault(second, set()).add(first)
            unseen = set(candidate_graph)
            while unseen:
                seed = min(unseen)
                stack = [seed]
                nodes = set()
                component_edges = set()
                while stack:
                    node = stack.pop()
                    if node in nodes:
                        continue
                    nodes.add(node)
                    unseen.discard(node)
                    for neighbor in candidate_graph[node]:
                        component_edges.add(tuple(sorted((node, neighbor))))
                        if neighbor not in nodes:
                            stack.append(neighbor)
                if any(len(candidate_graph[node]) > 2 for node in nodes):
                    raise RuntimeError(
                        "Inactive virtual tangent candidate branches"
                    )
                semantic_states = set().union(
                    *(
                        geometric_edges[edge_key]["interfaceStates"]
                        for edge_key in component_edges
                    )
                )
                if len(semantic_states) != 1 or not semantic_states < {
                    rank,
                    rank + 1,
                }:
                    raise RuntimeError(
                        "Inactive virtual tangent mixes semantic sides"
                    )
                endpoints = {
                    node for node in nodes if len(candidate_graph[node]) == 1
                }
                attachments = nodes & set(kept_graph)
                if len(endpoints) != 2:
                    raise RuntimeError(
                        "Inactive virtual tangent is not a nonbranching path"
                    )
                if len(attachments) not in {1, 2}:
                    raise RuntimeError(
                        "Inactive virtual tangent has invalid kept attachment "
                        "cardinality: "
                        f"owner={owner} rank={rank} "
                        f"candidateEdges={sorted(candidate_edges)} "
                        f"componentEdges={sorted(component_edges)} "
                        f"nodes={sorted(nodes)} "
                        f"nodeDegrees={dict(sorted((node, len(candidate_graph[node])) for node in nodes))} "
                        f"endpoints={sorted(endpoints)} "
                        f"attachments={sorted(attachments)} "
                        "keptIntersectionDegrees="
                        f"{dict(sorted((node, len(kept_graph[node])) for node in nodes & set(kept_graph)))} "
                        "keptPhysicalIntersection="
                        f"{sorted(nodes & kept_physical_nodes)}"
                    )
                attachment = min(attachments)
                kept_component = set()
                stack = [attachment]
                while stack:
                    node = stack.pop()
                    if node in kept_component:
                        continue
                    kept_component.add(node)
                    stack.extend(kept_graph[node] - kept_component)
                kept_degrees = {
                    node: len(kept_graph[node]) for node in kept_component
                }
                kept_endpoints = {
                    node for node, degree in kept_degrees.items() if degree == 1
                }
                if len(attachments) == 1:
                    tangent_class = "terminalTangentTail"
                    if attachment not in endpoints:
                        raise RuntimeError(
                            "Terminal virtual tangent attaches through interior"
                        )
                    if nodes & kept_physical_nodes:
                        raise RuntimeError(
                            "Terminal virtual tangent touches active physical"
                        )
                    if any(degree != 2 for degree in kept_degrees.values()):
                        raise RuntimeError(
                            "Terminal tangent pruning opens kept interface"
                        )
                    boundary_evidence = []
                else:
                    tangent_class = "redundantTangentChord"
                    if not attachments.issubset(kept_component):
                        raise RuntimeError(
                            "Redundant tangent endpoints are not connected in "
                            "one kept component"
                        )
                    if any(
                        degree not in {1, 2}
                        for degree in kept_degrees.values()
                    ) or len(kept_endpoints) not in {0, 2}:
                        raise RuntimeError(
                            "Redundant tangent pruning leaves invalid kept "
                            "component degrees"
                        )
                    boundary_evidence = [
                        _source_boundary_membership(
                            coordinates[key],
                            ordered_fields[owner][rank][
                                "relativeBoundaryEdges"
                            ],
                        )
                        for key in sorted(kept_endpoints)
                    ]
                    if kept_endpoints and (
                        any(item is None for item in boundary_evidence)
                        or boundary_evidence[0]["component"]
                        != boundary_evidence[1]["component"]
                    ):
                        raise RuntimeError(
                            "Redundant tangent kept path lacks one relative "
                            "boundary component"
                        )
                tangent_components_audit.append(
                    {
                        "owner": owner,
                        "rank": rank,
                        "class": tangent_class,
                        "edgeCount": len(component_edges),
                        "nodeCount": len(nodes),
                        "attachment": attachment,
                        "semanticState": next(iter(semantic_states)),
                        "keptComponentNodeCount": len(kept_component),
                        "keptEndpointCount": len(kept_endpoints),
                        "keptBoundaryEvidence": boundary_evidence,
                    }
                )
        for edge_key in one_sided_virtual_tangent_edges:
            edge_record = geometric_edges[edge_key]
            rank = edge_record["interfaceRank"]
            rank_mask = 1 << rank
            for edge in edge_copies[edge_key]:
                virtual_mask = int(edge[virtual_contour_layer])
                if virtual_mask != rank_mask:
                    raise RuntimeError(
                        "Virtual tangent marker changed before pruning"
                    )
                edge[virtual_contour_layer] = 0
                edge[inactive_virtual_tangent_layer] = rank_mask
        closure_records.append(
            {
                "pass": closure_pass,
                "mixedComponentCount": 0,
                "qualifiedComponentCount": 0,
                "virtualInsertions": [],
                "newInactiveEdgeCount": 0,
                "forcedFaceCount": sum(
                    int(face[forced_state_face_layer]) > 0 for face in bm.faces
                ),
                "prunedVirtualTangentEdgeCount": len(
                    one_sided_virtual_tangent_edges
                ),
                "prunedVirtualTangentComponents": tangent_components_audit,
            }
        )
        bm.normal_update()
        bm.verts.index_update()
        bm.edges.index_update()
        bm.faces.index_update()
        return _classify_cut_topology(
            bm,
            surface_fields=surface_fields,
            contour_marker_layers=contour_marker_layers,
            virtual_contour_layer=virtual_contour_layer,
            inactive_cap_layer=inactive_cap_layer,
            inactive_virtual_tangent_layer=inactive_virtual_tangent_layer,
            forced_state_face_layer=forced_state_face_layer,
            bridge_face_layer=bridge_face_layer,
            source_zone_records=source_zone_records,
            effective_spec=effective_spec,
            hand_region_minimum_y=hand_region_minimum_y,
            closure_pass=closure_pass + 1,
            closure_records=closure_records,
        )

    conflicting_components = {
        component: states
        for component, states in component_assignments.items()
        if len(states) > 1
    }
    if conflicting_components or single_sided_central_components:
        qualifier_records = []
        incomplete_components = list(single_sided_central_components)
        raw_bridge_diagnostics = []

        def bridge_candidate_summary(candidate):
            return {
                "requiredRanks": candidate["requiredRanks"],
                "ranks": [
                    {
                        "rank": rank_report["rank"],
                        "segmentCount": rank_report["segmentCount"],
                        "componentCount": rank_report[
                            "componentCount"
                        ],
                        "chainComponentCount": rank_report[
                            "chainComponentCount"
                        ],
                        "multiRootFaceCount": rank_report[
                            "multiRootFaceCount"
                        ],
                        "sharedEdgeRootViolationCount": rank_report[
                            "sharedEdgeRootViolationCount"
                        ],
                        "endpoints": rank_report["endpoints"],
                        "complete": rank_report["complete"],
                    }
                    for rank_report in candidate["ranks"]
                ],
                "sharedSegmentCount": candidate[
                    "sharedSegmentCount"
                ],
                "crossRankIntersectionCount": candidate[
                    "crossRankIntersectionCount"
                ],
                "crossRankIntersections": candidate[
                    "crossRankIntersections"
                ],
                "complete": candidate["complete"],
            }

        for component, states in conflicting_components.items():
            owner = component_owner[component]
            raw_bridge_candidate = _raw_bridge_candidate(
                component=component,
                states=states,
                component_faces=component_faces,
                component_owner=component_owner,
                face_by_index=face_by_index,
                face_source=face_source,
                face_component=face_component,
                eligible_faces=eligible_faces,
                geometric_edges=geometric_edges,
                ordered_fields=ordered_fields,
                contour_by_index=contour_by_index,
            )
            has_forced_state = bool(component_forced_states[component])
            has_virtual_evidence = any(
                record["kind"] == "virtualContinuation"
                for record in component_assignment_edges[component]
            )
            component_source_faces = sorted(
                {
                    face_source[face_index]
                    for face_index in component_faces[component]
                }
            )
            raw_bridge_diagnostics.append(
                {
                    "component": component,
                    "owner": owner,
                    "states": sorted(states),
                    "sourceFaces": component_source_faces,
                    "hasForcedState": has_forced_state,
                    "hasVirtualEvidence": has_virtual_evidence,
                    "candidate": bridge_candidate_summary(
                        raw_bridge_candidate
                    ),
                }
            )
            if (
                closure_pass == 0
                and not has_forced_state
                and not has_virtual_evidence
                and raw_bridge_candidate["complete"]
            ):
                qualifier_records.append(
                    {
                        "component": component,
                        "owner": owner,
                        "states": sorted(states),
                        "sourceFaces": component_source_faces,
                        "candidate": raw_bridge_candidate,
                    }
                )
            else:
                if component not in incomplete_components:
                    incomplete_components.append(component)

        inactive_edge_keys = set()
        forced_face_count_before = sum(
            int(face[forced_state_face_layer]) > 0 for face in bm.faces
        )
        constraint_audit = {
            "relevantComponentCount": 0,
            "protectedSeedCount": 0,
            "fallbackSeedCount": 0,
            "fallbackClusters": [],
            "initialTraversableUntaggedMembershipBoundaryCount": (
                traversable_untagged_membership_boundary_count
            ),
            "initialTaggedMembershipBarrierCount": (
                tagged_membership_barrier_count
            ),
            "activeCentralEdgeCount": 0,
            "inactiveCentralEdgeCount": 0,
            "singleSidedCentralCapEdgeCount": (
                single_sided_central_edge_count
            ),
        }
        # Proven virtual cuts change the component graph.  Never choose cap
        # dispositions against the stale pre-cut graph; recurse first.
        solver_seeds = [] if qualifier_records else incomplete_components
        if solver_seeds:
            central_ranks = {1, 2, 3, 4}
            routed_parent = {
                component: component for component in component_faces
            }

            def routed_find(component):
                while routed_parent[component] != component:
                    routed_parent[component] = routed_parent[
                        routed_parent[component]
                    ]
                    component = routed_parent[component]
                return component

            def routed_union(first, second):
                first_root = routed_find(first)
                second_root = routed_find(second)
                if first_root == second_root:
                    return
                if component_owner[first_root] != component_owner[second_root]:
                    raise RuntimeError(
                        "Mandatory routed equality crossed digit owners"
                    )
                if first_root > second_root:
                    first_root, second_root = second_root, first_root
                routed_parent[second_root] = first_root

            routed_equality_edge_count = 0
            routed_cap_equality_exclusion_count = 0
            tagged_position_keys = set(position_interfaces)
            for record in virtual_edges:
                components = sorted(
                    {
                        face_component[face_index]
                        for face_index in record["faces"]
                    }
                )
                terminates_tag = bool(record["taggedEndpointKeys"])
                if terminates_tag != any(
                    key in tagged_position_keys for key in record["edgeKey"]
                ):
                    raise RuntimeError(
                        "Membership-boundary endpoint provenance changed "
                        "before routed equality"
                    )
                if record["routedCap"]:
                    routed_cap_equality_exclusion_count += 1
                    continue
                if terminates_tag:
                    continue
                for component in components[1:]:
                    routed_union(components[0], component)
                routed_equality_edge_count += 1
            routed_groups = {}
            for component in component_faces:
                routed_groups.setdefault(
                    routed_find(component), set()
                ).add(component)
            constraint_audit["mandatoryRoutedEqualityEdgeCount"] = (
                routed_equality_edge_count
            )
            constraint_audit[
                "routedCapEqualityExclusionCount"
            ] = routed_cap_equality_exclusion_count
            constraint_audit["mandatoryRoutedEqualityGroupCount"] = len(
                routed_groups
            )
            central_edges = []
            central_adjacency = {
                component: set() for component in routed_groups
            }
            assignment_states_by_edge = {}
            for component, assignments in component_assignment_edges.items():
                for assignment in assignments:
                    if (
                        assignment["kind"] != "activeInterface"
                        or assignment["rank"] not in central_ranks
                    ):
                        continue
                    assignment_states_by_edge.setdefault(
                        assignment["edgeKey"], {}
                    ).setdefault(component, set()).add(assignment["state"])
            for edge_key, state_map in assignment_states_by_edge.items():
                physical_mask = geometric_edges[edge_key]["weightMask"]
                if not physical_mask:
                    continue
                metadata = contour_by_index[physical_mask.bit_length() - 1]
                if metadata["digit"] != "thumb":
                    continue
                raw_components = tuple(sorted(state_map))
                if len(raw_components) > 2:
                    raise RuntimeError(
                        "Central thumb edge spans more than two flood nodes"
                    )
                raw_local_states = {
                    component: set(states)
                    for component, states in state_map.items()
                }
                combined_states = set().union(*raw_local_states.values())
                expected_edge_states = {
                    metadata["rank"],
                    metadata["rank"] + 1,
                }
                force_inactive = bool(
                    geometric_edges[edge_key].get("oneSidedCentralCap")
                )
                if (
                    combined_states != expected_edge_states
                    and not (
                        force_inactive
                        and len(combined_states) == 1
                        and combined_states < expected_edge_states
                    )
                ):
                    raise RuntimeError(
                        "Central edge lost its ordered local state pair"
                    )
                quotient_local_states = {}
                for component, states in raw_local_states.items():
                    quotient_local_states.setdefault(
                        routed_find(component), set()
                    ).update(states)
                components = tuple(sorted(quotient_local_states))
                collapsed_by_routed_equality = (
                    len(raw_components) == 2 and len(components) == 1
                )
                if len(components) == 2 and not force_inactive and any(
                    len(states) != 1
                    for states in quotient_local_states.values()
                ):
                    raise RuntimeError(
                        "Non-forced central relation side lacks one exact "
                        f"local state: edgeKey={edge_key} "
                        f"rank={metadata['rank']} "
                        f"components={components} "
                        "localStates="
                        f"{dict(sorted((item, sorted(states)) for item, states in quotient_local_states.items()))}"
                    )
                central_edges.append(
                    {
                        "edgeKey": edge_key,
                        "rank": metadata["rank"],
                        "components": components,
                        "rawComponents": raw_components,
                        "localStates": quotient_local_states,
                        "forceInactive": (
                            force_inactive or len(components) == 1
                        ),
                        "collapsedByRoutedEquality": (
                            collapsed_by_routed_equality
                        ),
                    }
                )
                if len(components) == 2:
                    first, second = components
                    central_adjacency[first].add(second)
                    central_adjacency[second].add(first)

            relevant_components = set()
            stack = [routed_find(component) for component in solver_seeds]
            while stack:
                component = stack.pop()
                if component in relevant_components:
                    continue
                group_members = routed_groups[component]
                group_owners = {
                    component_owner[item] for item in group_members
                }
                if len(group_owners) != 1 or next(iter(group_owners))[1] != "thumb":
                    raise RuntimeError(
                        "Central cap constraint graph escaped the thumb"
                    )
                relevant_components.add(component)
                stack.extend(
                    central_adjacency[component] - relevant_components
                )
            relevant_edges = [
                edge
                for edge in central_edges
                if any(
                    component in relevant_components
                    for component in edge["components"]
                )
            ]
            constraint_audit["relevantComponentCount"] = len(
                relevant_components
            )

            protected_states_by_component = {}
            for component in relevant_components:
                group_members = routed_groups[component]
                protected_states = set().union(
                    *(
                        component_forced_states[item]
                        for item in group_members
                    )
                )
                protected_states.update(
                    assignment["state"]
                    for item in group_members
                    for assignment in component_assignment_edges[item]
                    if assignment["kind"] == "virtualContinuation"
                    or assignment["rank"] not in central_ranks
                )
                if len(protected_states) > 1:
                    raise RuntimeError(
                        "Mandatory routed equality crosses protected anchor "
                        f"states: group={sorted(group_members)} "
                        f"states={sorted(protected_states)}"
                    )
                protected_states_by_component[component] = protected_states
            constraint_audit["protectedSeedCount"] = sum(
                bool(states)
                for states in protected_states_by_component.values()
            )

            relation_records_by_nodes = {}
            for edge in relevant_edges:
                relation_records_by_nodes.setdefault(
                    edge["components"], []
                ).append(edge)
            relation_groups = []
            relation_conflict_forced_edge_count = 0
            for components, records_for_nodes in sorted(
                relation_records_by_nodes.items()
            ):
                edge_keys = tuple(
                    sorted(
                        edge["edgeKey"] for edge in records_for_nodes
                    )
                )
                exact_relations = {
                    tuple(
                        (
                            component,
                            tuple(sorted(edge["localStates"][component])),
                        )
                        for component in components
                    )
                    for edge in records_for_nodes
                    if not edge["forceInactive"]
                }
                force_inactive = (
                    len(components) != 2
                    or any(
                        edge["forceInactive"]
                        for edge in records_for_nodes
                    )
                    or len(exact_relations) != 1
                )
                if force_inactive:
                    relation_conflict_forced_edge_count += len(edge_keys)
                    local_states = {
                        component: set().union(
                            *(
                                edge["localStates"].get(component, set())
                                for edge in records_for_nodes
                            )
                        )
                        for component in components
                    }
                else:
                    relation = next(iter(exact_relations))
                    local_states = {
                        component: set(states)
                        for component, states in relation
                    }
                relation_groups.append(
                    {
                        "edgeKey": edge_keys[0],
                        "edgeKeys": edge_keys,
                        "edgeRanks": {
                            edge["edgeKey"]: edge["rank"]
                            for edge in records_for_nodes
                        },
                        "activeWeight": len(edge_keys),
                        "rank": min(
                            edge["rank"] for edge in records_for_nodes
                        ),
                        "components": components,
                        "rawComponents": tuple(
                            sorted(
                                {
                                    component
                                    for edge in records_for_nodes
                                    for component in edge["rawComponents"]
                                }
                            )
                        ),
                        "localStates": local_states,
                        "forceInactive": force_inactive,
                        "collapsedByRoutedEquality": any(
                            edge["collapsedByRoutedEquality"]
                            for edge in records_for_nodes
                        ),
                    }
                )
                if not force_inactive and len(
                    {edge["rank"] for edge in records_for_nodes}
                ) != 1:
                    raise RuntimeError(
                        "Optional central relation group spans ranks"
                    )
            constraint_audit["rawCentralConstraintEdgeCount"] = len(
                relevant_edges
            )
            constraint_audit["centralRelationGroupCount"] = len(
                relation_groups
            )
            constraint_audit[
                "relationConflictForcedInactiveEdgeCount"
            ] = relation_conflict_forced_edge_count

            priority = {1: 0, 4: 1, 2: 2, 3: 3}
            ordered_constraints = sorted(
                relation_groups,
                key=lambda edge: (
                    priority[edge["rank"]],
                    edge["edgeKey"],
                ),
            )
            if os.environ.get("EANPA_HINGE_CSP_PREFLIGHT") == "1":
                preflight_clusters = []
                unseen_preflight = set(relevant_components)
                while unseen_preflight:
                    seed = min(unseen_preflight)
                    cluster = set()
                    stack = [seed]
                    while stack:
                        component = stack.pop()
                        if component in cluster:
                            continue
                        cluster.add(component)
                        unseen_preflight.discard(component)
                        stack.extend(
                            (
                                central_adjacency[component]
                                & relevant_components
                            )
                            - cluster
                        )
                    groups = [
                        edge
                        for edge in ordered_constraints
                        if edge["components"][0] in cluster
                    ]
                    preflight_clusters.append(
                        {
                            "quotientNodeCount": len(cluster),
                            "rawEdgeCount": sum(
                                edge["activeWeight"] for edge in groups
                            ),
                            "relationGroupCount": len(groups),
                            "optionalRelationGroupCount": sum(
                                not edge["forceInactive"] for edge in groups
                            ),
                            "forcedRelationGroupCount": sum(
                                edge["forceInactive"] for edge in groups
                            ),
                            "optionalRawEdgeCount": sum(
                                edge["activeWeight"]
                                for edge in groups
                                if not edge["forceInactive"]
                            ),
                            "forcedRawEdgeCount": sum(
                                edge["activeWeight"]
                                for edge in groups
                                if edge["forceInactive"]
                            ),
                            "protectedNodeCount": sum(
                                bool(
                                    protected_states_by_component[component]
                                )
                                for component in cluster
                            ),
                            "protectedStates": sorted(
                                set().union(
                                    *(
                                        protected_states_by_component[
                                            component
                                        ]
                                        for component in cluster
                                    )
                                )
                            ),
                        }
                    )
                raise RuntimeError(
                    "HINGE_CSP_PREFLIGHT "
                    + json.dumps(
                        {
                            "pass": closure_pass,
                            "rawEdgeCount": len(relevant_edges),
                            "relationGroupCount": len(relation_groups),
                            "clusters": preflight_clusters,
                        },
                        sort_keys=True,
                    )
                )
            evidence_states_by_component = {
                component: set().union(
                    *(
                        component_assignments[member]
                        for member in routed_groups[component]
                    )
                )
                for component in relevant_components
            }
            try:
                solver_result = solve_weighted_relations(
                    components=relevant_components,
                    relation_groups=ordered_constraints,
                    protected_states=protected_states_by_component,
                    evidence_states=evidence_states_by_component,
                    rank_priority=priority,
                )
            except RuntimeError as error:
                right_thumb_diagnostics = [
                    record
                    for record in raw_bridge_diagnostics
                    if record["owner"] == ("right", "thumb")
                ]
                raise RuntimeError(
                    f"{error}; closurePass={closure_pass}; "
                    "rightThumbRawBridgeDiagnostics="
                    f"{right_thumb_diagnostics}"
                ) from error
            decisions = solver_result["decisions"]
            labels = solver_result["labels"]
            search_audit = solver_result["audit"]
            selected_fallback_clusters = []
            for fallback in solver_result["fallbacks"]:
                quotient_components = set(
                    fallback["quotientComponents"]
                )
                selected_fallback_clusters.append(
                    {
                        "seedComponent": min(quotient_components),
                        "componentCount": sum(
                            len(routed_groups[component])
                            for component in quotient_components
                        ),
                        "quotientNodeCount": len(quotient_components),
                        "assignmentStates": fallback[
                            "assignmentStates"
                        ],
                    }
                )

            if set(labels) != relevant_components:
                raise RuntimeError(
                    "Bounded solver did not label every relevant quotient"
                )
            constraint_audit["fallbackClusters"].extend(
                selected_fallback_clusters
            )
            constraint_audit["fallbackSeedCount"] += len(
                selected_fallback_clusters
            )
            constraint_audit["globalConstraintSearch"] = search_audit
            quotient_parent = {
                component: component for component in relevant_components
            }

            def quotient_find(component):
                while quotient_parent[component] != component:
                    quotient_parent[component] = quotient_parent[
                        quotient_parent[component]
                    ]
                    component = quotient_parent[component]
                return component

            def quotient_union(first, second):
                first_root = quotient_find(first)
                second_root = quotient_find(second)
                if first_root != second_root:
                    quotient_parent[second_root] = first_root

            for edge in relevant_edges:
                if decisions[edge["edgeKey"]] != "inactive":
                    continue
                components = edge["components"]
                if len(components) == 2:
                    first, second = components
                    if labels[first] != labels[second]:
                        raise RuntimeError(
                            "Inactive central edge has unequal endpoint states"
                        )
                    quotient_union(first, second)
            for edge in relevant_edges:
                decision = decisions[edge["edgeKey"]]
                components = edge["components"]
                if decision == "inactive":
                    if len(components) == 2 and quotient_find(
                        components[0]
                    ) != quotient_find(components[1]):
                        raise RuntimeError(
                            "Inactive central edge failed quotient contraction"
                        )
                    continue
                if edge["forceInactive"] or len(components) != 2:
                    raise RuntimeError(
                        "One-sided/self central edge remained active"
                    )
                first, second = components
                if any(
                    len(edge["localStates"][component]) != 1
                    for component in components
                ):
                    raise RuntimeError(
                        "Active raw central edge lacks singleton local states"
                    )
                if quotient_find(first) == quotient_find(second):
                    raise RuntimeError(
                        "Kept central edge collapses in final quotient"
                    )
                first_local = next(iter(edge["localStates"][first]))
                second_local = next(iter(edge["localStates"][second]))
                if labels[first] != first_local or labels[second] != second_local:
                    raise RuntimeError(
                        "Kept central edge lacks its exact ordered state pair"
                    )
            constraint_audit["rawRelationValidationEdgeCount"] = len(
                relevant_edges
            )
            inactive_edge_keys = {
                edge_key
                for edge_key, decision in decisions.items()
                if decision == "inactive"
            }
            constraint_audit["inactiveCentralEdgeCount"] = len(
                inactive_edge_keys
            )
            constraint_audit["activeCentralEdgeCount"] = sum(
                decision == "active" for decision in decisions.values()
            )
            for component, target_state in labels.items():
                for group_member in routed_groups[component]:
                    for face_index in component_faces[group_member]:
                        face = face_by_index[face_index]
                        old_value = int(face[forced_state_face_layer])
                        new_value = target_state + 1
                        if old_value not in {0, new_value}:
                            raise RuntimeError(
                                "Cap face received conflicting forced states"
                            )
                        face[forced_state_face_layer] = new_value
        for edge_key in inactive_edge_keys:
            for edge in edge_copies[edge_key]:
                edge[inactive_cap_layer] = 1

        for face in bm.faces:
            face[bridge_face_layer] = 0
        for token, record in enumerate(qualifier_records, start=1):
            for face_index in component_faces[record["component"]]:
                face_by_index[face_index][bridge_face_layer] = token

        insertion_records = []
        propagated_layers = [
            *contour_marker_layers,
            virtual_contour_layer,
            inactive_cap_layer,
            inactive_virtual_tangent_layer,
        ]
        for token, record in enumerate(qualifier_records, start=1):
            owner = record["owner"]
            for rank_report in record["candidate"]["ranks"]:
                rank = rank_report["rank"]
                surface_field = ordered_fields[owner][rank]

                def face_scalar_field(face, coordinate, field=surface_field):
                    return _evaluate_surface_field_face(
                        field,
                        source_surface,
                        int(face[source_face_layer]),
                        coordinate,
                    )

                recorded_endpoint_reuse_keys = set()
                recorded_endpoint_reuse_evidence = []
                maximum_recorded_endpoint_reuse_displacement = 0.0
                ambiguous_recorded_endpoint_reuse_count = 0
                cross_owner_rank_endpoint_reuse_count = 0

                def resolve_virtual_root(
                    face,
                    edge,
                    coordinate,
                    field=surface_field,
                    target_owner=owner,
                    target_rank=rank,
                ):
                    """Prefer an authored physical endpoint on this exact edge.

                    A raw-P1 root can fall nanometers inside a descendant edge
                    whose endpoint already terminates the matching recorded
                    contour.  Quantized coordinate equality is deliberately
                    insufficient here: require the exact requested BMesh edge,
                    the same current descendant face, an active physical
                    contour incident on the endpoint, and identical owner/rank.
                    """

                    nonlocal maximum_recorded_endpoint_reuse_displacement
                    nonlocal ambiguous_recorded_endpoint_reuse_count
                    nonlocal cross_owner_rank_endpoint_reuse_count
                    matching = []
                    cross_owner_rank = []
                    for endpoint in edge.verts:
                        displacement = (endpoint.co - coordinate).length
                        if displacement > MAXIMUM_RECORDED_ROOT_DISPLACEMENT:
                            continue
                        endpoint_incidences = set()
                        for linked_edge in endpoint.link_edges:
                            if not linked_edge.is_valid:
                                continue
                            physical_mask = _edge_contour_mask(
                                linked_edge,
                                contour_marker_layers,
                            )
                            if (
                                physical_mask.bit_count() != 1
                                or int(linked_edge[inactive_cap_layer])
                                or face not in linked_edge.link_faces
                            ):
                                continue
                            metadata = contour_by_index[
                                physical_mask.bit_length() - 1
                            ]
                            endpoint_incidences.add(
                                (
                                    (metadata["side"], metadata["digit"]),
                                    metadata["rank"],
                                    metadata["index"],
                                    linked_edge.index,
                                )
                            )
                        matching_incidences = {
                            incidence
                            for incidence in endpoint_incidences
                            if incidence[0] == target_owner
                            and incidence[1] == target_rank
                        }
                        foreign_incidences = (
                            endpoint_incidences - matching_incidences
                        )
                        if matching_incidences:
                            matching.append(
                                (
                                    displacement,
                                    endpoint,
                                    matching_incidences,
                                )
                            )
                        if foreign_incidences:
                            cross_owner_rank.append(
                                (
                                    displacement,
                                    endpoint,
                                    foreign_incidences,
                                )
                            )
                    if cross_owner_rank:
                        cross_owner_rank_endpoint_reuse_count += len(
                            cross_owner_rank
                        )
                        raise RuntimeError(
                            "Virtual root encountered a nearby authored "
                            "endpoint of a different owner/rank"
                        )
                    if len(matching) > 1:
                        ambiguous_recorded_endpoint_reuse_count += 1
                        raise RuntimeError(
                            "Virtual root has multiple matching authored "
                            "endpoints on one requested edge"
                        )
                    if matching:
                        displacement, endpoint, incidences = matching[0]
                        reuse_key = (
                            edge.index,
                            endpoint.index,
                            target_owner,
                            target_rank,
                        )
                        if reuse_key not in recorded_endpoint_reuse_keys:
                            recorded_endpoint_reuse_keys.add(reuse_key)
                            recorded_endpoint_reuse_evidence.append(
                                {
                                    "sourceFaceIndex": int(
                                        face[source_face_layer]
                                    ),
                                    "descendantFaceIndex": int(face.index),
                                    "requestedEdgeIndex": int(edge.index),
                                    "endpointVertexIndex": int(
                                        endpoint.index
                                    ),
                                    "displacementMeters": displacement,
                                    "physicalContourIndices": sorted(
                                        incidence[2]
                                        for incidence in incidences
                                    ),
                                }
                            )
                        maximum_recorded_endpoint_reuse_displacement = max(
                            maximum_recorded_endpoint_reuse_displacement,
                            displacement,
                        )
                        return endpoint.co.copy()
                    return _resolve_source_edge_root(
                        face=face,
                        edge=edge,
                        coordinate=coordinate,
                        source_face_layer=source_face_layer,
                        surface_field=field,
                    )

                marching = insert_face_linear_contour(
                    bm,
                    face_scalar_field=face_scalar_field,
                    accept_coordinate=lambda _coordinate: True,
                    face_filter=(
                        lambda face, marker=token: (
                            face.is_valid
                            and int(face[bridge_face_layer]) == marker
                        )
                    ),
                    chord_tolerance=CONTOUR_CHORD_TOLERANCE,
                    scalar_tolerance=AFFINE_SCALAR_TOLERANCE,
                    contour_edge_layer=virtual_contour_layer,
                    contour_edge_mask=1 << rank,
                    propagated_edge_layers=propagated_layers,
                    root_coordinate_resolver=resolve_virtual_root,
                    face_identity=lambda face: int(face[source_face_layer]),
                )
                recorded_edge_reuse_count = 0
                virtual_rank_mask = 1 << rank
                for edge in bm.edges:
                    virtual_mask = int(edge[virtual_contour_layer])
                    if not virtual_mask & virtual_rank_mask:
                        continue
                    physical_mask = _edge_contour_mask(
                        edge, contour_marker_layers
                    )
                    if not physical_mask:
                        continue
                    if int(edge[inactive_cap_layer]):
                        raise RuntimeError(
                            "Virtual closure overlaps an inactive recorded edge"
                        )
                    if physical_mask.bit_count() != 1:
                        raise RuntimeError(
                            "Virtual closure reused a multi-contour edge"
                        )
                    physical_metadata = contour_by_index[
                        physical_mask.bit_length() - 1
                    ]
                    physical_owner = (
                        physical_metadata["side"],
                        physical_metadata["digit"],
                    )
                    if (
                        physical_owner != owner
                        or physical_metadata["rank"] != rank
                    ):
                        raise RuntimeError(
                            "Virtual closure overlaps a recorded contour of "
                            "a different owner or rank"
                        )
                    edge[virtual_contour_layer] = (
                        virtual_mask & ~virtual_rank_mask
                    )
                    recorded_edge_reuse_count += 1
                if (
                    marching["contourEdgeCount"] <= 0
                    or marching["singleRootFaceCount"]
                    or marching[
                        "maximumSharedEdgeRootDisagreementMeters"
                    ]
                    > MAXIMUM_RECORDED_ROOT_DISPLACEMENT
                    or marching[
                        "maximumEndpointReuseDisplacementMeters"
                    ]
                    > MAXIMUM_RECORDED_ROOT_DISPLACEMENT
                ):
                    raise RuntimeError(
                        "Qualified raw-P1 closure failed insertion gates"
                    )
                insertion_records.append(
                    {
                        "owner": owner,
                        "rank": rank,
                        "sourceComponentStateSpan": record["states"],
                        "sourceFaces": record["sourceFaces"],
                        "qualifiedChainCount": rank_report[
                            "chainComponentCount"
                        ],
                        "contourEdgeCount": marching["contourEdgeCount"],
                        "insertedRootVertexCount": marching[
                            "insertedRootVertexCount"
                        ],
                        "maximumSharedEdgeRootDisagreementMeters": marching[
                            "maximumSharedEdgeRootDisagreementMeters"
                        ],
                        "endpointReuseCount": marching[
                            "endpointReuseCount"
                        ],
                        "crossQuantizationEndpointReuseCount": marching[
                            "crossQuantizationEndpointReuseCount"
                        ],
                        "recordedRootEndpointReuseCount": len(
                            recorded_endpoint_reuse_keys
                        ),
                        "maximumRecordedRootEndpointReuseDisplacementMeters": (
                            maximum_recorded_endpoint_reuse_displacement
                        ),
                        "ambiguousRecordedRootEndpointReuseCount": (
                            ambiguous_recorded_endpoint_reuse_count
                        ),
                        "crossOwnerRankEndpointReuseCount": (
                            cross_owner_rank_endpoint_reuse_count
                        ),
                        "recordedRootEndpointReuseEvidence": (
                            recorded_endpoint_reuse_evidence
                        ),
                        "recordedEdgeReuseCount": (
                            recorded_edge_reuse_count
                        ),
                        "maximumEndpointReuseDisplacementMeters": marching[
                            "maximumEndpointReuseDisplacementMeters"
                        ],
                    }
                )
        for face in bm.faces:
            face[bridge_face_layer] = 0

        forced_face_count_after = sum(
            int(face[forced_state_face_layer]) > 0 for face in bm.faces
        )
        if (
            not insertion_records
            and not inactive_edge_keys
            and forced_face_count_after == forced_face_count_before
        ):
            raise RuntimeError(
                "Thumb cap fixed point made no progress on mixed components"
            )
        closure_records.append(
            {
                "pass": closure_pass,
                "mixedComponentCount": len(conflicting_components),
                "qualifiedComponentCount": len(qualifier_records),
                "qualifiedCandidates": [
                    {
                        "owner": record["owner"],
                        "sourceComponentStateSpan": record["states"],
                        "sourceFaces": record["sourceFaces"],
                        "candidate": bridge_candidate_summary(
                            record["candidate"]
                        ),
                    }
                    for record in qualifier_records
                ],
                "rawBridgeDiagnostics": raw_bridge_diagnostics,
                "virtualInsertions": insertion_records,
                "newInactiveEdgeCount": len(inactive_edge_keys),
                "forcedFaceCount": forced_face_count_after,
                "centralConstraint": constraint_audit,
            }
        )
        bm.normal_update()
        bm.verts.index_update()
        bm.edges.index_update()
        bm.faces.index_update()
        try:
            return _classify_cut_topology(
                bm,
                surface_fields=surface_fields,
                contour_marker_layers=contour_marker_layers,
                virtual_contour_layer=virtual_contour_layer,
                inactive_cap_layer=inactive_cap_layer,
                inactive_virtual_tangent_layer=(
                    inactive_virtual_tangent_layer
                ),
                forced_state_face_layer=forced_state_face_layer,
                bridge_face_layer=bridge_face_layer,
                source_zone_records=source_zone_records,
                effective_spec=effective_spec,
                hand_region_minimum_y=hand_region_minimum_y,
                closure_pass=closure_pass + 1,
                closure_records=closure_records,
            )
        except RuntimeError as error:
            if closure_pass != 0:
                raise
            concise_history = [
                {
                    "pass": item["pass"],
                    "mixedComponentCount": item[
                        "mixedComponentCount"
                    ],
                    "rightThumbRawBridgeDiagnostics": [
                        record
                        for record in item.get(
                            "rawBridgeDiagnostics", []
                        )
                        if record["owner"] == ("right", "thumb")
                    ],
                    "rightThumbQualifiedCandidates": [
                        record
                        for record in item.get(
                            "qualifiedCandidates", []
                        )
                        if record["owner"] == ("right", "thumb")
                    ],
                    "rightThumbVirtualInsertions": [
                        {
                            key: insertion[key]
                            for key in (
                                "owner",
                                "rank",
                                "sourceComponentStateSpan",
                                "sourceFaces",
                                "qualifiedChainCount",
                                "contourEdgeCount",
                                "insertedRootVertexCount",
                                "recordedEdgeReuseCount",
                            )
                        }
                        for insertion in item.get(
                            "virtualInsertions", []
                        )
                        if insertion["owner"] == ("right", "thumb")
                    ],
                    "prunedVirtualTangentEdgeCount": item.get(
                        "prunedVirtualTangentEdgeCount", 0
                    ),
                    "prunedVirtualTangentComponents": item.get(
                        "prunedVirtualTangentComponents", []
                    ),
                }
                for item in closure_records
            ]
            raise RuntimeError(
                f"{error}; precedingClosureFixedPoint="
                f"{concise_history}"
            ) from error
    parent = {component: component for component in component_faces}

    def find(component: int) -> int:
        while parent[component] != component:
            parent[component] = parent[parent[component]]
            component = parent[component]
        return component

    def union(first: int, second: int) -> None:
        first_root = find(first)
        second_root = find(second)
        if first_root == second_root:
            return
        if component_owner[first_root] != component_owner[second_root]:
            raise RuntimeError("Virtual route boundary crossed digit owners")
        parent[second_root] = first_root

    virtual_boundary_records = []
    tagged_position_keys = set(position_interfaces)
    for record in virtual_edges:
        components = sorted(
            {face_component[face_index] for face_index in record["faces"]}
        )
        terminates_tag = bool(record["taggedEndpointKeys"])
        if terminates_tag != any(
            key in tagged_position_keys for key in record["edgeKey"]
        ):
            raise RuntimeError(
                "Membership-boundary endpoint provenance changed before "
                "final state propagation"
            )
        if not terminates_tag and not record["routedCap"]:
            for component in components[1:]:
                union(components[0], component)
        virtual_boundary_records.append(
            {
                **record,
                "components": components,
                "terminatesTaggedContour": terminates_tag,
            }
        )

    equality_groups = {}
    for component in component_faces:
        equality_groups.setdefault(find(component), set()).add(component)
    position_components = {
        key: {face_component[face_index] for face_index in faces}
        for key, faces in position_faces.items()
    }
    component_state = {}
    source_seed_group_count = 0
    lineage_seeded_components = set()
    for group_components in equality_groups.values():
        direct_states = set().union(
            *(component_assignments[component] for component in group_components)
        )
        if len(direct_states) > 1:
            raise RuntimeError(
                "Virtual boundary equality links conflicting tagged states: "
                f"pass={closure_pass} "
                f"components={sorted(group_components)} "
                f"owners={sorted({component_owner[item] for item in group_components})} "
                "assignments="
                f"{dict(sorted((item, sorted(component_assignments[item])) for item in group_components))} "
                "assignmentEvidence="
                f"{dict(sorted((item, sorted(component_assignment_evidence[item])) for item in group_components))} "
                "sourceFaces="
                f"{dict(sorted((item, sorted({face_source[index] for index in component_faces[item]})) for item in group_components))} "
                "equalityEdges="
                f"{[record for record in virtual_boundary_records if set(record['components']).issubset(group_components) and not record['terminatesTaggedContour']]}"
            )
        if direct_states:
            state = next(iter(direct_states))
        else:
            owners = {component_owner[item] for item in group_components}
            if len(owners) != 1:
                raise RuntimeError("Source seed group spans digit owners")
            owner = next(iter(owners))
            seed_states = set()
            group_faces = set().union(
                *(component_faces[item] for item in group_components)
            )
            for face_index in group_faces:
                for vertex in face_by_index[face_index].verts:
                    key = position_key(vertex.co)
                    if key in tagged_position_keys:
                        continue
                    if not position_components.get(key, set()).issubset(
                        group_components
                    ):
                        continue
                    source_record = source_zone_records.get(key)
                    if source_record is None:
                        continue
                    seed_state = _source_record_topology_state(source_record)
                    if seed_state is None:
                        continue
                    if seed_state and (
                        source_record.get("side"), source_record.get("digit")
                    ) != owner:
                        continue
                    seed_states.add(seed_state)
            if not seed_states:
                # Boundary-only slivers created by subdivision retain no
                # interior source vertex.  They may be labeled only by
                # unanimous source-face lineage evidence; a mixed lineage
                # still fails below rather than guessing a state.
                for face_index in group_faces:
                    for vertex in face_by_index[face_index].verts:
                        key = position_key(vertex.co)
                        if key in tagged_position_keys:
                            continue
                        source_record = source_zone_records.get(key)
                        if source_record is None:
                            continue
                        lineage_state = _source_record_topology_state(
                            source_record
                        )
                        if lineage_state is None:
                            continue
                        if lineage_state and (
                            source_record.get("side"),
                            source_record.get("digit"),
                        ) != owner:
                            continue
                        seed_states.add(lineage_state)
                if seed_states:
                    lineage_seeded_components.update(group_components)
            if len(seed_states) != 1:
                source_zone_evidence = {}
                for face_index in group_faces:
                    for vertex in face_by_index[face_index].verts:
                        key = position_key(vertex.co)
                        source_record = source_zone_records.get(key)
                        if source_record is None:
                            continue
                        evidence_key = (
                            source_record.get("side"),
                            source_record.get("digit"),
                            source_record.get("zone"),
                            source_record.get("blend"),
                        )
                        source_zone_evidence[evidence_key] = (
                            source_zone_evidence.get(evidence_key, 0) + 1
                        )
                raise RuntimeError(
                    f"Unlabeled {owner} flood group lacks one unanimous "
                    f"source state: {sorted(seed_states)}; "
                    f"components={sorted(group_components)}; "
                    "sourceFaces="
                    f"{sorted({face_source[index] for index in group_faces})}; "
                    "memberships="
                    f"{sorted({face_membership[index] for index in group_faces})}; "
                    "sourceZoneEvidence="
                    f"{sorted((key, count) for key, count in source_zone_evidence.items())}"
                )
            state = next(iter(seed_states))
            source_seed_group_count += 1
        for component in group_components:
            component_state[component] = state
    if set(component_state) != set(component_faces):
        raise RuntimeError("Not every flooded component received one state")
    forced_state_violations = [
        component
        for component, forced_states in component_forced_states.items()
        if forced_states
        and component_state[component] != next(iter(forced_states))
    ]
    if forced_state_violations:
        raise RuntimeError(
            "Forced incomplete-triplet caps changed protected state: "
            f"{forced_state_violations}"
        )

    virtual_equal_state_count = 0
    common_gasket_corridor_boundary_count = 0
    virtual_tag_endpoint_count = 0
    virtual_nonadjacent_count = 0
    for record in virtual_boundary_records:
        states = {component_state[item] for item in record["components"]}
        if record["routedCap"]:
            common_gasket_corridor_boundary_count += 1
            if not states or any(state not in range(10) for state in states):
                raise RuntimeError(
                    "Exclusive G0/G1 routed cap lacks valid topology states"
                )
            continue
        if record["terminatesTaggedContour"]:
            virtual_tag_endpoint_count += 1
            if states and max(states) - min(states) > 1:
                virtual_nonadjacent_count += 1
            continue
        if len(states) != 1 or next(iter(states)) not in range(10):
            raise RuntimeError(
                "Untagged routed boundary lacks one equal valid topology state"
            )
        # Selected-field route boundaries can legitimately lie inside a
        # topology-proven gasket half (for example state 1 in G0 or state 5 in
        # G1).  They are equality constraints, not synthetic rigid seams.
        # No current record carries the stricter exclusive-G0/exclusive-G1
        # common-corridor provenance required for an S0-only assertion.
        virtual_equal_state_count += 1
    if virtual_nonadjacent_count:
        raise RuntimeError(
            "Tagged-endpoint virtual boundary spans non-adjacent states"
        )

    traversable_state_conflicts = 0
    for face_index, neighbors in adjacency.items():
        for neighbor in neighbors:
            if component_state[face_component[face_index]] != component_state[
                face_component[neighbor]
            ]:
                traversable_state_conflicts += 1
    if traversable_state_conflicts:
        raise RuntimeError("A traversable untagged edge changes topology state")

    state_face_counts = {}
    state_component_counts = {}
    for component, state in component_state.items():
        side, digit = component_owner[component]
        state_key = f"{side}/{digit}/{state}"
        state_component_counts[state_key] = (
            state_component_counts.get(state_key, 0) + 1
        )
        state_face_counts[state_key] = state_face_counts.get(state_key, 0) + len(
            component_faces[component]
        )
    missing_states = [
        f"{side}/{digit}/{state}"
        for side in SIDES
        for digit in DIGITS
        for state in range(10)
        if state_face_counts.get(f"{side}/{digit}/{state}", 0) == 0
    ]
    if missing_states:
        raise RuntimeError(
            "Topology flood lacks ordered mechanical cells: "
            f"{missing_states}"
        )

    for vertex in bm.verts:
        if vertex.co.y < hand_region_minimum_y:
            continue
        key = position_key(vertex.co)
        coordinates.setdefault(key, vertex.co.copy())
        position_faces.setdefault(key, set())
    hand_keys = {
        key
        for key, coordinate in coordinates.items()
        if coordinate.y >= hand_region_minimum_y
    }
    physical_position_dispositions = {}
    for edge_key, edge_record in geometric_edges.items():
        if not edge_record["mask"]:
            continue
        contour_index = edge_record["mask"].bit_length() - 1
        disposition = (
            "inactiveIncompleteTripletCap"
            if edge_record["inactive"]
            else "activeInterface"
        )
        for key in edge_key:
            physical_position_dispositions.setdefault(key, set()).add(
                (disposition, contour_index)
            )
    mixed_physical_position_count = 0
    for key, dispositions in physical_position_dispositions.items():
        status_names = {item[0] for item in dispositions}
        if len(status_names) <= 1:
            continue
        mixed_physical_position_count += 1
        contour_indices = {item[1] for item in dispositions}
        if len(contour_indices) != 1 or key not in position_interfaces:
            raise RuntimeError(
                "Active/inactive cap branches meet away from a same-contour "
                "endpoint"
            )
    inactive_position_keys = {
        key
        for key, dispositions in physical_position_dispositions.items()
        if any(
            disposition == "inactiveIncompleteTripletCap"
            for disposition, _contour_index in dispositions
        )
    }
    inactive_only_position_keys = inactive_position_keys - set(
        position_interfaces
    )
    inactive_virtual_position_interfaces = {}
    for edge_key, edge_record in geometric_edges.items():
        inactive_virtual_mask = edge_record["inactiveVirtualMask"]
        if not inactive_virtual_mask:
            continue
        rank = inactive_virtual_mask.bit_length() - 1
        owners = {
            face_owner[face_index]
            for face_index in edge_record["faces"] & eligible_faces
        }
        if len(owners) != 1:
            raise RuntimeError(
                "Inactive virtual tangent lacks one immutable owner"
            )
        owner = next(iter(owners))
        interface_id = (owner[0], owner[1], rank)
        for key in edge_key:
            inactive_virtual_position_interfaces.setdefault(key, set()).add(
                interface_id
            )
    inactive_virtual_position_keys = set(
        inactive_virtual_position_interfaces
    )
    for key in inactive_virtual_position_keys & set(position_interfaces):
        if inactive_virtual_position_interfaces[key] != position_interfaces[key]:
            raise RuntimeError(
                "Inactive virtual tangent meets a different active interface"
            )
    inactive_virtual_only_position_keys = (
        inactive_virtual_position_keys - set(position_interfaces)
    )
    for key in inactive_position_keys & set(position_interfaces):
        inactive_interface_ids = {
            (
                contour_by_index[contour_index]["side"],
                contour_by_index[contour_index]["digit"],
                contour_by_index[contour_index]["rank"],
            )
            for disposition, contour_index in physical_position_dispositions[
                key
            ]
            if disposition == "inactiveIncompleteTripletCap"
        }
        if inactive_interface_ids != position_interfaces[key]:
            raise RuntimeError(
                "Inactive branch meets an active/virtual interface of a "
                "different owner or rank"
            )
    records = {}
    zone_counts = {}
    exact_contour_position_count = 0
    exact_virtual_position_count = 0
    inserted_unique_count = 0
    source_record_override_count = 0
    measured_h_override_count = 0
    contour_terminus_adjacency_count = 0
    for key in sorted(hand_keys):
        coordinate = coordinates[key]
        incident_faces = position_faces.get(key, set()) & eligible_faces
        if not incident_faces:
            raise RuntimeError(f"Hand position {key} has no flooded face")
        source_record = source_zone_records.get(key)
        interface_ids = position_interfaces.get(key, set())
        if len(interface_ids) > 1:
            raise RuntimeError(
                f"Position {key} belongs to multiple logical interfaces: "
                f"{sorted(interface_ids)}"
            )
        origin = "source" if source_record is not None else "inserted"
        if source_record is None:
            inserted_unique_count += 1

        if interface_ids:
            owner_side, owner_digit, interface_rank = next(
                iter(interface_ids)
            )
            owner = (owner_side, owner_digit)
            physical_indices = position_physical_contours.get(key, set())
            if len(physical_indices) > 1:
                raise RuntimeError(
                    "One interface position carries multiple recorded contours"
                )
            if physical_indices:
                contour_index = next(iter(physical_indices))
                metadata = contour_by_index[contour_index]
                disposition = "activeInterface"
                exact_contour_position_count += 1
            else:
                surface_field = ordered_fields[owner][interface_rank]
                metadata = {
                    "side": owner_side,
                    "digit": owner_digit,
                    "gasket": surface_field["gasket"],
                    "rawBlendT": surface_field["rawBlendT"],
                    "rank": interface_rank,
                }
                disposition = "virtualContinuation"
                exact_virtual_position_count += 1
            if metadata["rank"] != interface_rank:
                raise RuntimeError(
                    "Recorded and virtual interface ranks disagree at a join"
                )
            incident_states = {
                component_state[face_component[face_index]]
                for face_index in incident_faces
                if face_owner[face_index] == owner
            }
            expected_states = {metadata["rank"], metadata["rank"] + 1}
            if not incident_states or not incident_states.issubset(
                expected_states
            ):
                incident_source_faces = {
                    face_source[face_index] for face_index in incident_faces
                }
                if (
                    incident_states
                    and expected_states & incident_states
                    and len(incident_source_faces) <= 2
                ):
                    # Converging contours pinch this endpoint inside at most
                    # two subdivided source triangles, so cells of a
                    # terminating neighbor band are also incident.  The
                    # tagged record keeps its exact rank blend; the
                    # degenerate-area adjacency is recorded, not hidden.
                    contour_terminus_adjacency_count += 1
                else:
                    raise RuntimeError(
                        f"Contour position {key} lacks its adjacent topology "
                        f"states; owner={owner}; rank={metadata['rank']}; "
                        f"disposition={disposition}; "
                        f"sameOwnerStates={sorted(incident_states)}; "
                        "allOwnerStates="
                        f"{sorted({(face_owner[face_index], component_state[face_component[face_index]]) for face_index in incident_faces})}; "
                        "lineageSeededIncidents="
                        f"{sorted({face_component[face_index] for face_index in incident_faces if face_component[face_index] in lineage_seeded_components})}; "
                        "incidentSourceFaces="
                        f"{sorted(incident_source_faces)}"
                    )
            record = {
                "side": metadata["side"],
                "digit": metadata["digit"],
                "zone": metadata["gasket"],
                "blend": float(metadata["rawBlendT"]),
                "origin": origin,
                "topologyInterfaceRank": metadata["rank"],
                "interfaceDisposition": disposition,
            }
        elif (
            source_record is not None
            and source_record.get("zone") == "H"
            and 0
            in {
                component_state[face_component[face_index]]
                for face_index in incident_faces
            }
        ):
            side = source_record.get("side")
            if side not in SIDES:
                incident_sides = {
                    face_owner[face_index][0]
                    for face_index in incident_faces
                }
                if len(incident_sides) != 1:
                    raise RuntimeError(
                        "Source H position lacks one immutable side owner"
                    )
                side = next(iter(incident_sides))
            record = {
                "side": side,
                "digit": None,
                "zone": "H",
                "blend": None,
                "origin": "source",
                "topologyState": 0,
            }
            source_record_override_count += 1
        else:
            # An authored H vertex with no incident H cell sits where the
            # coarse authored map disagrees with the measured bands (knuckle
            # fans and web termini); it resolves through the same owner-based
            # rules as inserted positions.
            authored_h_override = (
                source_record is not None
                and source_record.get("zone") == "H"
            )
            owner_states = {}
            owner_face_counts = {}
            for face_index in incident_faces:
                owner = face_owner[face_index]
                state = component_state[face_component[face_index]]
                owner_states.setdefault(owner, set()).add(state)
                owner_face_counts[owner] = owner_face_counts.get(owner, 0) + 1
            non_hand_owners = {
                owner
                for owner, states in owner_states.items()
                if any(state != 0 for state in states)
            }
            source_owner = None
            if source_record is not None and source_record.get("digit") is not None:
                candidate = (
                    source_record.get("side"),
                    source_record.get("digit"),
                )
                if candidate in owner_states:
                    source_owner = candidate
            if source_owner is not None:
                owner = source_owner
            elif len(non_hand_owners) == 1:
                owner = next(iter(non_hand_owners))
            elif not non_hand_owners:
                source_side = (
                    source_record.get("side")
                    if source_record is not None
                    else None
                )
                incident_sides = {
                    owner[0] for owner in owner_states
                }
                if source_side in SIDES:
                    side = source_side
                elif len(incident_sides) == 1:
                    side = next(iter(incident_sides))
                else:
                    raise RuntimeError(
                        "Topology H position lacks one immutable side owner"
                    )
                record = {
                    "side": side,
                    "digit": None,
                    "zone": "H",
                    "blend": None,
                    "origin": origin,
                    "topologyState": 0,
                }
                owner = None
            else:
                # An inserted web vertex may touch two digits where a
                # measured gasket corridor of one digit meets rigid chrome
                # of its neighbor.  The measured corridor owns the inserted
                # band vertex; rigid chrome has no claim on it.  Anything
                # but exactly one gasket-state owner still fails.
                gasket_owners = {
                    candidate
                    for candidate in non_hand_owners
                    if any(state % 3 for state in owner_states[candidate])
                }
                if (
                    origin == "inserted" or authored_h_override
                ) and len(gasket_owners) == 1:
                    owner = next(iter(gasket_owners))
                elif (
                    (origin == "inserted" or authored_h_override)
                    and len(gasket_owners) > 1
                    and all(
                        len(owner_states[candidate]) == 1
                        and next(iter(owner_states[candidate])) % 3
                        for candidate in gasket_owners
                    )
                ):
                    # Two measured gasket corridors genuinely meet at an
                    # inserted web vertex; resolve it by the same normalized
                    # radial metric that defines the digit domains.
                    owner = None
                    best_metric = None
                    for candidate in sorted(
                        gasket_owners,
                        key=lambda item: (item[0], DIGITS.index(item[1])),
                    ):
                        digit_document = effective_spec["seams"][
                            candidate[0]
                        ][candidate[1]]
                        _station, radial, _angle = project_coordinate(
                            coordinate,
                            digit_document["chainPoints"],
                        )
                        metric = radial / float(digit_document["radialLimit"])
                        if best_metric is None or metric < best_metric - 1e-12:
                            owner = candidate
                            best_metric = metric
                else:
                    raise RuntimeError(
                        f"Untagged position {key} spans digit owners "
                        f"{sorted(non_hand_owners)}; "
                        "ownerStates="
                        f"{dict(sorted((candidate, sorted(states)) for candidate, states in owner_states.items()))}; "
                        f"ownerFaceCounts={dict(sorted(owner_face_counts.items()))}; "
                        f"sourceRecord={source_record}; "
                        f"origin={origin}; "
                        "incidentSourceFaces="
                        f"{sorted({face_source[face_index] for face_index in incident_faces})}; "
                        "incidentMemberships="
                        f"{sorted({face_membership[face_index] for face_index in incident_faces})}"
                    )
            if owner is not None:
                states = owner_states[owner]
                pinned_blend = None
                if len(states) == 1:
                    state = next(iter(states))
                elif (
                    source_record is not None
                    and _source_record_topology_state(source_record) in states
                ):
                    # The authored zone agrees with one incident cell; that
                    # authored evidence resolves the boundary vertex exactly.
                    state = _source_record_topology_state(source_record)
                elif len(states) == 2 and max(states) == min(states) + 1:
                    # An untagged vertex pinched between the two cells of one
                    # measured contour boundary carries that boundary's exact
                    # weight: the rigid side is weight-identical to a blend of
                    # 0.0/1.0, and a center boundary is exactly 0.5.
                    low, high = sorted(states)
                    if low % 3 == 0:
                        state = low
                    elif high % 3 == 0:
                        state = high
                    else:
                        state = low
                        pinned_blend = 0.5
                elif (
                    (origin == "inserted" or authored_h_override)
                    and len(states) == 2
                    and max(states) == min(states) + 2
                    and (min(states) % 3, max(states) % 3) in {(1, 0), (0, 2)}
                ):
                    # A gasket band collapses to zero width at a proven
                    # exclusive web-cap terminus, so one half-band cell touches
                    # the rigid zone beyond the skipped half.  The degenerate
                    # terminus has no exact blend; the half boundary at 0.5
                    # minimizes the jump against both incident cells.
                    low, high = sorted(states)
                    state = low if low % 3 == 1 else high
                    pinned_blend = 0.5
                elif (
                    (origin == "inserted" or authored_h_override)
                    and len(states) == 2
                    and all(value % 3 for value in states)
                    and (max(states) - 1) // 3 == (min(states) - 1) // 3 + 1
                ):
                    # Two successive gasket bands pinch out the rigid shell
                    # between them at a proven web terminus; the squeezed
                    # rigid zone keeps the pinch welded.
                    state = 3 * ((min(states) - 1) // 3 + 1)
                else:
                    raise RuntimeError(
                        f"Untagged position {key} spans topology states "
                        f"{sorted(states)}; "
                        f"owner={owner}; "
                        f"origin={origin}; "
                        f"sourceRecord={source_record}; "
                        "incidentSourceFaces="
                        f"{sorted({face_source[face_index] for face_index in incident_faces})}"
                    )
                zone, gasket_index = _topology_state_zone(state)
                if zone == "H":
                    record = {
                        "side": owner[0],
                        "digit": None,
                        "zone": "H",
                        "blend": None,
                        "origin": origin,
                        "topologyState": state,
                    }
                elif gasket_index is None:
                    record = {
                        "side": owner[0],
                        "digit": owner[1],
                        "zone": zone,
                        "blend": None,
                        "origin": origin,
                        "topologyState": state,
                    }
                else:
                    joint = effective_spec["seams"][owner[0]][owner[1]][
                        "joints"
                    ][zone]
                    station, _radial, angle = _project_joint_coordinate(
                        coordinate,
                        effective_spec["seams"][owner[0]][owner[1]],
                        joint,
                    )
                    if pinned_blend is not None:
                        blend = pinned_blend
                    else:
                        blend = _raw_blend(station, angle, joint)
                        if state == 3 * gasket_index + 1:
                            blend = max(0.0, min(0.5, blend))
                        else:
                            blend = max(0.5, min(1.0, blend))
                    record = {
                        "side": owner[0],
                        "digit": owner[1],
                        "zone": zone,
                        "blend": blend,
                        "origin": origin,
                        "topologyState": state,
                    }
            if authored_h_override and record["zone"] != "H":
                measured_h_override_count += 1
        if key in inactive_only_position_keys:
            topology_state = record.get("topologyState")
            if topology_state not in range(10) or "topologyInterfaceRank" in record:
                raise RuntimeError(
                    "Inactive-only cap position lacks one proven topology state"
                )
            record["interfaceDisposition"] = (
                "inactiveIncompleteTripletCap"
            )
        if key in inactive_virtual_only_position_keys:
            topology_state = record.get("topologyState")
            if topology_state not in range(10) or "topologyInterfaceRank" in record:
                raise RuntimeError(
                    "Inactive virtual tangent position leaks an exact interface"
                )
            record["interfaceDisposition"] = "inactiveVirtualTangent"
        record.setdefault("interfaceDisposition", "none")
        if record["zone"] in {"H", "S0", "S1", "S2"}:
            if record["blend"] is not None:
                raise RuntimeError("Rigid topology record has a blend value")
        elif record["zone"] in GASKETS:
            if record["blend"] is None:
                raise RuntimeError("Gasket topology record lacks a blend value")
        else:
            raise RuntimeError("Unknown topology record zone")
        records[key] = record
        zone_key = f"{record['side']}/{record['digit'] or 'hand'}/{record['zone']}"
        zone_counts[zone_key] = zone_counts.get(zone_key, 0) + 1

    if set(records) != hand_keys:
        raise RuntimeError("Topology records do not cover exact BMesh hand keys")
    disposition_counts = {}
    interface_rank_position_counts = {}
    for record in records.values():
        disposition = record["interfaceDisposition"]
        if disposition is not None:
            disposition_counts[disposition] = (
                disposition_counts.get(disposition, 0) + 1
            )
        interface_rank = record.get("topologyInterfaceRank")
        if interface_rank is not None:
            rank_key = str(interface_rank)
            interface_rank_position_counts[rank_key] = (
                interface_rank_position_counts.get(rank_key, 0) + 1
            )
    active_physical_edge_count = sum(
        bool(record["weightMask"]) for record in geometric_edges.values()
    )
    inactive_physical_edge_count = sum(
        bool(record["inactive"]) for record in geometric_edges.values()
    )
    virtual_closure_edge_count = sum(
        bool(record["virtualMask"]) for record in geometric_edges.values()
    )
    inactive_virtual_tangent_edge_count = sum(
        bool(record["inactiveVirtualMask"])
        for record in geometric_edges.values()
    )
    physical_edge_count = sum(
        bool(record["mask"]) for record in geometric_edges.values()
    )
    if (
        active_physical_edge_count + inactive_physical_edge_count
        != physical_edge_count
    ):
        raise RuntimeError("Physical contour edge dispositions are incomplete")
    hand_edges = [
        edge
        for edge in bm.edges
        if edge.is_valid
        and any(face.index in eligible_faces for face in edge.link_faces)
    ]
    minimum_hand_edge_length = min(
        (edge.calc_length() for edge in hand_edges),
        default=math.inf,
    )
    submicron_hand_edges = [
        edge
        for edge in hand_edges
        if edge.calc_length() < MAXIMUM_RECORDED_ROOT_DISPLACEMENT
    ]
    if submicron_hand_edges:
        evidence = []
        for edge in sorted(
            submicron_hand_edges,
            key=lambda item: (item.calc_length(), item.index),
        )[:12]:
            evidence.append(
                {
                    "edgeIndex": edge.index,
                    "lengthMeters": edge.calc_length(),
                    "coordinates": [
                        [float(value) for value in vertex.co]
                        for vertex in edge.verts
                    ],
                    "physicalMask": _edge_contour_mask(
                        edge, contour_marker_layers
                    ),
                    "virtualMask": int(edge[virtual_contour_layer]),
                    "inactive": int(edge[inactive_cap_layer]),
                    "sourceFaces": sorted(
                        int(face[source_face_layer])
                        for face in edge.link_faces
                    ),
                }
            )
        raise RuntimeError(
            "Post-cut hand topology contains submicron edges: "
            f"count={len(submicron_hand_edges)} evidence={evidence}"
        )
    audit = {
        "schemaVersion": 1,
        "method": (
            "immutable source-face digit ownership; persistent contour-bit "
            "barriers; membership-aware geometric-edge face flood"
        ),
        "coordinateEligibilityCount": 0,
        "contourIndexCount": len(contour_by_index),
        "eligibleHandFaceCount": len(eligible_faces),
        "floodedHandFaceCount": len(face_component),
        "componentCount": len(component_faces),
        "sourceSeedGroupCount": source_seed_group_count,
        "stateFaceCounts": dict(sorted(state_face_counts.items())),
        "stateComponentCounts": dict(sorted(state_component_counts.items())),
        "geometricEdgeCount": len(geometric_edges),
        "minimumHandEdgeLengthMeters": minimum_hand_edge_length,
        "submicronHandEdgeCount": 0,
        "taggedInterfaceEdgeCount": tagged_interface_count,
        "activePhysicalInterfaceEdgeCount": active_physical_edge_count,
        "virtualContinuationEdgeCount": virtual_closure_edge_count,
        "inactiveVirtualTangentEdgeCount": (
            inactive_virtual_tangent_edge_count
        ),
        "inactiveIncompleteTripletCapEdgeCount": (
            inactive_physical_edge_count
        ),
        "physicalDispositionCoverageCount": physical_edge_count,
        "mixedSameContourEndpointCount": mixed_physical_position_count,
        "markerMaskCopyConflictCount": 0,
        "multiContourGeometricEdgeCount": 0,
        "traversableStateConflictCount": 0,
        "virtualBoundaryEdgeCount": len(virtual_boundary_records),
        "initialTraversableUntaggedMembershipBoundaryCount": (
            traversable_untagged_membership_boundary_count
        ),
        "initialTaggedMembershipBarrierCount": (
            tagged_membership_barrier_count
        ),
        "virtualEqualStateBoundaryCount": virtual_equal_state_count,
        "commonGasketCorridorBoundaryCount": (
            common_gasket_corridor_boundary_count
        ),
        "virtualTaggedEndpointBoundaryCount": virtual_tag_endpoint_count,
        "virtualNonAdjacentStateCount": 0,
        "recordCount": len(records),
        "recordConflictCount": 0,
        "exactContourBlendPositionCount": (
            exact_contour_position_count + exact_virtual_position_count
        ),
        "exactRecordedContourBlendPositionCount": (
            exact_contour_position_count
        ),
        "exactVirtualContinuationBlendPositionCount": (
            exact_virtual_position_count
        ),
        "inactiveOnlyPositionCount": len(inactive_only_position_keys),
        "inactiveVirtualTangentPositionCount": len(
            inactive_virtual_only_position_keys
        ),
        "inactiveVirtualAttachmentPositionCount": len(
            inactive_virtual_position_keys & set(position_interfaces)
        ),
        "inactiveVirtualTangentComponentCount": sum(
            len(record.get("prunedVirtualTangentComponents", []))
            for record in closure_records
        ),
        "activeOneSidedVirtualEdgeCount": 0,
        "inactiveVirtualConnectivityViolationCount": 0,
        "inactiveVirtualExactInterfaceLeakCount": 0,
        "inactiveUnprovenStateCount": 0,
        "inactiveProtectedAnchorCrossingCount": 0,
        "inactiveExactInterfaceLeakCount": 0,
        "interfaceDispositionCounts": dict(
            sorted(disposition_counts.items())
        ),
        "interfaceRankPositionCounts": dict(
            sorted(interface_rank_position_counts.items())
        ),
        "closureFixedPointPassCount": len(closure_records),
        "closureFixedPoint": closure_records,
        "sourceHandOverrideCount": source_record_override_count,
        "measuredContourHandOverrideCount": measured_h_override_count,
        "contourTerminusAdjacencyCount": contour_terminus_adjacency_count,
        "insertedUniqueHandPositionCount": inserted_unique_count,
        "zoneCounts": dict(sorted(zone_counts.items())),
        "rigidBlendViolationCount": 0,
        "missingOrderedStateCount": 0,
    }
    return records, audit


def subdivide_and_classify(
    mesh,
    *,
    hinge_spec: dict,
    source_zone_records: dict[tuple[int, int, int], dict],
    hand_region_minimum_y: float,
) -> tuple[dict, dict, dict]:
    """Insert all 90 contours and return exact post-cut mechanical zones.

    The returned position groups and records are keyed on the post-subdivision
    mesh.  Original source positions retain their source-locked digit/hand
    ownership.  Mechanical cells come only from the persistent contour graph;
    source-P1 continuations close topology-proven thumb gaps, while incomplete
    triplet branches inherit one protected topology state without becoming an
    exact weight interface.
    """

    original_vertex_count = len(mesh.data.vertices)
    original_face_count = len(mesh.data.polygons)
    original_keys = set(source_zone_records)
    effective_spec, fixed_frame_audit = reparameterize_document(hinge_spec)
    fixed_frame_validation = _validate_fixed_frame_reparameterization(
        hinge_spec,
        effective_spec,
        fixed_frame_audit,
    )
    if fixed_frame_audit["maximumFitResidualMeters"] > 2e-7:
        raise RuntimeError(
            "Fixed-frame hinge trace migration exceeds the 0.2 micron gate"
        )
    if fixed_frame_audit["orderingViolationCount"]:
        raise RuntimeError("Fixed-frame hinge envelopes changed field order")
    if fixed_frame_audit["widthContractViolationCount"]:
        raise RuntimeError("Fixed-frame hinge envelopes changed width contract")
    if fixed_frame_audit["adjacentGapViolationCount"]:
        raise RuntimeError("Fixed-frame adjacent hinge gap validation failed")
    station_separation_adjustments = fixed_frame_audit[
        "sourceTraceSeparationAdjustments"
    ]
    bm = bmesh.new()
    bm.from_mesh(mesh.data)
    surface_fields, surface_field_audits, surface_field_summary = (
        _build_surface_fields(
            bm,
            source_spec=hinge_spec,
            effective_spec=effective_spec,
            source_zone_records=source_zone_records,
        )
    )
    adaptive_refinement = _adaptive_subdivide_overlap_faces(bm, effective_spec)
    contour_marker_layers = [
        bm.edges.layers.int.new(f"hinge_contour_bits_{index}")
        for index in range(CONTOUR_MARKER_LAYER_COUNT)
    ]
    virtual_contour_layer = bm.edges.layers.int.new(
        "hinge_virtual_closure_bits"
    )
    inactive_cap_layer = bm.edges.layers.int.new("hinge_inactive_cap")
    inactive_virtual_tangent_layer = bm.edges.layers.int.new(
        "hinge_inactive_virtual_tangent_bits"
    )
    forced_state_face_layer = bm.faces.layers.int.new(
        "hinge_forced_cap_state"
    )
    bridge_face_layer = bm.faces.layers.int.new("hinge_bridge_component")
    cut_records = []
    for side in SIDES:
        for digit in DIGITS:
            side_document = effective_spec["seams"][side]
            digit_document = side_document[digit]
            for gasket in GASKETS:
                joint_document = digit_document["joints"][gasket]
                for field, _role, _blend in CONTOUR_FIELDS:
                    surface_field = surface_fields[(side, digit, gasket, field)]
                    contour_index = int(surface_field["index"])
                    cut_records.append(
                        _cut_contour(
                            bm,
                            side=side,
                            digit=digit,
                            gasket=gasket,
                            field=field,
                            side_document=side_document,
                            digit_document=digit_document,
                            joint_document=joint_document,
                            surface_field=surface_field,
                            contour_edge_layer=contour_marker_layers[
                                contour_index // CONTOURS_PER_MARKER_LAYER
                            ],
                            contour_edge_mask=(
                                1
                                << (
                                    contour_index
                                    % CONTOURS_PER_MARKER_LAYER
                                )
                            ),
                            contour_edge_layers=contour_marker_layers,
                        )
                    )
    contour_topology_audit = _tagged_contour_topology_audit(
        bm,
        surface_fields=surface_fields,
        contour_marker_layers=contour_marker_layers,
    )
    if (
        not contour_topology_audit["allContoursClosed"]
        or contour_topology_audit["crossJointContourIntersectionCount"] != 0
    ):
        failed_ids = [
            item["id"]
            for item in contour_topology_audit["contours"]
            if not item["closed"]
        ]
        critical_ids = {
            "left/thumb/G2/distalBoundary",
            "right/thumb/G0/center",
            "right/thumb/G1/center",
        } | set(failed_ids)
        critical_failures = [
            {
                key: item[key]
                for key in (
                    "id",
                    "componentCount",
                    "degreeHistogram",
                    "boundaryEndpointCount",
                    "boundaryEndpointEvidence",
                    "components",
                )
            }
            for item in contour_topology_audit["contours"]
            if item["id"] in critical_ids
        ]
        critical_crossings = [
            item
            for item in contour_topology_audit[
                "crossJointContourIntersections"
            ]
            if any(contour in critical_ids for contour in item["contours"])
        ]
        critical_cuts = [
            {
                "id": (
                    f"{item['side']}/{item['digit']}/{item['gasket']}/"
                    f"{item['role']}"
                ),
                "singleRootFaceCount": item["singleRootFaceCount"],
                "singleRootFaces": item["singleRootFaces"],
            }
            for item in cut_records
            if (
                f"{item['side']}/{item['digit']}/{item['gasket']}/"
                f"{item['role']}"
            )
            in critical_ids
        ]
        raise RuntimeError(
            "Tagged hinge topology gate failed: "
            f"valid={contour_topology_audit['closedContourCount']}/90; "
            "staticAbsoluteClosed="
            f"{surface_field_summary['absoluteClosedComponentCount']}/90; "
            "crossJointIntersections="
            f"{contour_topology_audit['crossJointContourIntersectionCount']}; "
            f"failed={failed_ids}; criticalFailures="
            f"{json.dumps(critical_failures, sort_keys=True)}; "
            "criticalCrossings="
            f"{json.dumps(critical_crossings, sort_keys=True)}; criticalCuts="
            f"{json.dumps(critical_cuts, sort_keys=True)}"
        )
    final_records, topology_classification = _classify_cut_topology(
        bm,
        surface_fields=surface_fields,
        contour_marker_layers=contour_marker_layers,
        virtual_contour_layer=virtual_contour_layer,
        inactive_cap_layer=inactive_cap_layer,
        inactive_virtual_tangent_layer=inactive_virtual_tangent_layer,
        forced_state_face_layer=forced_state_face_layer,
        bridge_face_layer=bridge_face_layer,
        source_zone_records=source_zone_records,
        effective_spec=effective_spec,
        hand_region_minimum_y=hand_region_minimum_y,
    )
    postclosure_contour_topology_audit = _tagged_contour_topology_audit(
        bm,
        surface_fields=surface_fields,
        contour_marker_layers=contour_marker_layers,
    )
    if (
        not postclosure_contour_topology_audit["allContoursClosed"]
        or postclosure_contour_topology_audit[
            "crossJointContourIntersectionCount"
        ]
        != 0
    ):
        raise RuntimeError(
            "Virtual thumb closures changed the recorded 90-contour audit"
        )
    topology_classification["postclosureRecordedContourCount"] = 90
    topology_classification["postclosureRecordedContoursClosed"] = True
    topology_classification[
        "postclosureRecordedCrossJointIntersectionCount"
    ] = 0
    for marker_layer in contour_marker_layers:
        bm.edges.layers.int.remove(marker_layer)
    bm.edges.layers.int.remove(virtual_contour_layer)
    bm.edges.layers.int.remove(inactive_cap_layer)
    bm.edges.layers.int.remove(inactive_virtual_tangent_layer)
    bm.faces.layers.int.remove(forced_state_face_layer)
    bm.faces.layers.int.remove(bridge_face_layer)
    source_face_layer = next(iter(surface_fields.values()))["sourceSurface"][
        "sourceFaceLayer"
    ]
    bm.faces.layers.int.remove(source_face_layer)
    bm.normal_update()
    bm.to_mesh(mesh.data)
    bm.free()
    mesh.data.update()

    position_groups: dict[tuple[int, int, int], list[int]] = {}
    for vertex in mesh.data.vertices:
        key = position_key(vertex.co)
        position_groups.setdefault(key, []).append(vertex.index)
    postcut_hand_keys = {
        key
        for key, vertex_indices in position_groups.items()
        if mesh.data.vertices[vertex_indices[0]].co.y >= hand_region_minimum_y
    }
    missing_postcut_keys = postcut_hand_keys - set(final_records)
    extra_postcut_keys = set(final_records) - postcut_hand_keys
    if missing_postcut_keys or extra_postcut_keys:
        raise RuntimeError(
            "Exported post-cut hand keys differ from topology records: "
            f"missing={len(missing_postcut_keys)} "
            f"extra={len(extra_postcut_keys)}"
        )
    topology_classification["postcutHandKeyCount"] = len(postcut_hand_keys)
    topology_classification["postcutHandKeyMismatchCount"] = 0

    contour_insertions = sum(item["insertedVertices"] for item in cut_records)
    if len(cut_records) != 90:
        raise RuntimeError(f"Expected 90 hinge contours, built {len(cut_records)}")
    if contour_insertions <= 0 or len(mesh.data.vertices) <= original_vertex_count:
        raise RuntimeError("Hinge subdivision inserted no source topology")
    provenance = {
        "method": (
            "three measured non-planar contours per authored hinge in "
            "continuous joint-local frames"
        ),
        "jointCount": 30,
        "contourCount": len(cut_records),
        "sourceRawVertexCount": original_vertex_count,
        "subdividedRawVertexCount": len(mesh.data.vertices),
        "insertedRawVertexCount": len(mesh.data.vertices) - original_vertex_count,
        "sourceTriangleCount": original_face_count,
        "subdividedFaceCount": len(mesh.data.polygons),
        "insertedUniqueHandPositionCount": topology_classification[
            "insertedUniqueHandPositionCount"
        ],
        "zoneCounts": topology_classification["zoneCounts"],
        "cuts": cut_records,
        "adaptiveOverlapSubdivision": adaptive_refinement,
        "surfaceField": {
            **surface_field_summary,
            "contours": surface_field_audits,
        },
        "contourTopologyAudit": contour_topology_audit,
        "topologyClassification": topology_classification,
        "fixedFrameProjection": {
            **fixed_frame_audit,
            "validation": fixed_frame_validation,
        },
        "stationSeparation": {
            "minimumRigidGap": MINIMUM_RIGID_GAP,
            "adjustments": station_separation_adjustments,
        },
        "attributePolicy": (
            "BMesh edge interpolation preserves each raw UV/custom-normal copy; "
            "no welding across source attribute seams"
        ),
        "weightPolicy": (
            "topology-proven rigid chrome cells outside measured contour "
            "barriers; raw t only inside proven gasket half-cells; builder "
            "applies one smoothstep"
        ),
    }
    return position_groups, final_records, provenance
