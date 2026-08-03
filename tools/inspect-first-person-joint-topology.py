#!/usr/bin/env python3
"""Measure Aletheia finger-joint evidence from the authored source mesh.

This diagnostic intentionally reads the current guide curves from the builder
without importing or executing it.  The guide curves are only used to isolate
each digit and provide a monotonic arc coordinate; reported contour and
topology features come from the source GLB itself.
"""

from __future__ import annotations

import ast
from collections import defaultdict
import math
from pathlib import Path
import statistics
import sys

import bmesh
import bpy
from mathutils import Vector


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "assets" / "player" / "Aletheia_Chrome_1p_arms.glb"
BUILDER = ROOT / "tools" / "build-first-person-viewmodel.py"
BIN_WIDTH = 0.0025
SECTION_STEP = 0.001


def load_guide_points() -> dict:
    import json
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
    return pivots


def percentile(values: list[float], fraction: float) -> float:
    ordered = sorted(values)
    if not ordered:
        return math.nan
    position = fraction * (len(ordered) - 1)
    lower = int(math.floor(position))
    upper = int(math.ceil(position))
    blend = position - lower
    return ordered[lower] * (1.0 - blend) + ordered[upper] * blend


def curve_data(points) -> tuple[tuple[Vector, ...], tuple[float, ...], float]:
    vectors = tuple(Vector(point) for point in points)
    arcs = [0.0]
    for start, end in zip(vectors, vectors[1:]):
        arcs.append(arcs[-1] + (end - start).length)
    return vectors, tuple(arcs), arcs[-1]


def sample_curve(point: Vector, points) -> tuple[float, float, Vector, Vector]:
    vectors, arcs, _total = curve_data(points)
    best = None
    for index, (start, end) in enumerate(zip(vectors, vectors[1:])):
        axis = end - start
        raw = (point - start).dot(axis) / max(axis.length_squared, 1e-12)
        clamped = min(1.0, max(0.0, raw))
        closest = start + axis * clamped
        radial = (point - closest).length
        arc = arcs[index] + clamped * axis.length
        raw_arc = arc
        if index == 0 and raw < 0.0:
            raw_arc = raw * axis.length
        elif index == len(vectors) - 2 and raw > 1.0:
            raw_arc = arcs[index] + raw * axis.length
        candidate = (radial, index, raw_arc, closest, axis.normalized())
        if best is None or candidate[:2] < best[:2]:
            best = candidate
    assert best is not None
    return best[2], best[0], best[3], best[4]


def curve_station(points, arc: float) -> tuple[Vector, Vector]:
    vectors, arcs, total = curve_data(points)
    if arc <= 0.0:
        tangent = (vectors[1] - vectors[0]).normalized()
        return vectors[0] + tangent * arc, tangent
    if arc >= total:
        tangent = (vectors[-1] - vectors[-2]).normalized()
        return vectors[-1] + tangent * (arc - total), tangent
    for index in range(len(vectors) - 1):
        if arc <= arcs[index + 1]:
            axis = vectors[index + 1] - vectors[index]
            fraction = (arc - arcs[index]) / max(axis.length, 1e-12)
            return vectors[index] + axis * fraction, axis.normalized()
    raise AssertionError("Unreachable curve station")


def convex_hull(points: list[tuple[float, float]]) -> list[tuple[float, float]]:
    ordered = sorted(set(points))
    if len(ordered) <= 1:
        return ordered

    def cross(origin, first, second):
        return (
            (first[0] - origin[0]) * (second[1] - origin[1])
            - (first[1] - origin[1]) * (second[0] - origin[0])
        )

    lower = []
    for point in ordered:
        while len(lower) >= 2 and cross(lower[-2], lower[-1], point) <= 0.0:
            lower.pop()
        lower.append(point)
    upper = []
    for point in reversed(ordered):
        while len(upper) >= 2 and cross(upper[-2], upper[-1], point) <= 0.0:
            upper.pop()
        upper.append(point)
    return lower[:-1] + upper[:-1]


def polygon_area_centroid(points: list[tuple[float, float]]) -> tuple[float, tuple[float, float]]:
    if len(points) < 3:
        return math.nan, (math.nan, math.nan)
    twice_area = 0.0
    center_x = 0.0
    center_y = 0.0
    for first, second in zip(points, points[1:] + points[:1]):
        cross = first[0] * second[1] - second[0] * first[1]
        twice_area += cross
        center_x += (first[0] + second[0]) * cross
        center_y += (first[1] + second[1]) * cross
    if abs(twice_area) <= 1e-12:
        return math.nan, (math.nan, math.nan)
    return abs(twice_area) * 0.5, (
        center_x / (3.0 * twice_area),
        center_y / (3.0 * twice_area),
    )


def cross_section(welded, points, arc: float, outer_radius: float):
    center, tangent = curve_station(points, arc)
    reference = Vector((0.0, 0.0, 1.0))
    if abs(tangent.dot(reference)) > 0.9:
        reference = Vector((1.0, 0.0, 0.0))
    axis_u = tangent.cross(reference).normalized()
    axis_v = tangent.cross(axis_u).normalized()
    intersections = []
    for face in welded.faces:
        coordinates = [vertex.co for vertex in face.verts]
        signed = [(coordinate - center).dot(tangent) for coordinate in coordinates]
        if min(signed) > 0.0 or max(signed) < 0.0:
            continue
        for index, first in enumerate(coordinates):
            second_index = (index + 1) % len(coordinates)
            second = coordinates[second_index]
            first_distance = signed[index]
            second_distance = signed[second_index]
            if first_distance * second_distance > 0.0:
                continue
            denominator = first_distance - second_distance
            if abs(denominator) <= 1e-12:
                continue
            fraction = first_distance / denominator
            if not -1e-8 <= fraction <= 1.0 + 1e-8:
                continue
            point = first + (second - first) * fraction
            offset = point - center
            u = offset.dot(axis_u)
            v = offset.dot(axis_v)
            if u * u + v * v <= outer_radius * outer_radius:
                intersections.append((round(u, 6), round(v, 6)))
    hull = convex_hull(intersections)
    area, centroid = polygon_area_centroid(hull)
    if not math.isfinite(area):
        return None
    corrected = center + axis_u * centroid[0] + axis_v * centroid[1]
    radius = math.sqrt(area / math.pi)
    return radius, corrected, len(hull)


def section_candidates(welded, points, digit: str):
    _vectors, joint_arcs, total = curve_data(points)
    outer = 0.058 if digit == "thumb" else 0.035
    rows = []
    sample_count = int(math.ceil((total + 0.030) / SECTION_STEP))
    for sample_index in range(-20, sample_count + 1):
        arc = sample_index * SECTION_STEP
        result = cross_section(welded, points, arc, outer)
        if result is not None:
            radius, center, hull_count = result
            rows.append((arc, radius, center, hull_count))
    smoothed = []
    for index, row in enumerate(rows):
        neighbors = rows[max(0, index - 2) : min(len(rows), index + 3)]
        smoothed.append((row, statistics.median(value[1] for value in neighbors)))
    candidates = []
    windows = (
        (-0.020, min(0.030, joint_arcs[1] * 0.55)),
        (max(0.015, joint_arcs[1] - 0.025), min(total, joint_arcs[1] + 0.025)),
        (max(joint_arcs[1] + 0.015, joint_arcs[2] - 0.022), min(total + 0.005, joint_arcs[2] + 0.022)),
    )
    for window in windows:
        values = [entry for entry in smoothed if window[0] <= entry[0][0] <= window[1]]
        if not values:
            candidates.append(None)
            continue
        best = min(values, key=lambda entry: (entry[1], abs(entry[0][0])))
        candidates.append((best[0], best[1]))
    return rows, candidates


def welded_source():
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    bpy.ops.import_scene.gltf(filepath=str(SOURCE))
    source = next(obj for obj in bpy.context.scene.objects if obj.type == "MESH")
    welded = bmesh.new()
    welded.from_mesh(source.data)
    bmesh.ops.remove_doubles(welded, verts=list(welded.verts), dist=0.00002)
    welded.verts.ensure_lookup_table()
    welded.edges.ensure_lookup_table()
    welded.faces.ensure_lookup_table()
    for face in welded.faces:
        face.normal_update()
    return welded


def main() -> None:
    guides = load_guide_points()
    welded = welded_source()
    sections_only = "--sections-only" in sys.argv
    sections_profile = "--sections-profile" in sys.argv
    selected_side = next(
        (argument.split("=", 1)[1] for argument in sys.argv if argument.startswith("--side=")),
        None,
    )
    selected_digit = next(
        (argument.split("=", 1)[1] for argument in sys.argv if argument.startswith("--digit=")),
        None,
    )
    print(
        "JOINT_TOPOLOGY_SOURCE",
        "verts", len(welded.verts),
        "edges", len(welded.edges),
        "faces", len(welded.faces),
    )

    for side in ("left", "right"):
        if selected_side and side != selected_side:
            continue
        sign = -1.0 if side == "left" else 1.0
        assignments = {}
        samples = defaultdict(list)
        edge_features = defaultdict(list)
        guide_data = {
            digit: curve_data(points)
            for digit, points in guides[side].items()
        }

        for vertex in welded.verts:
            if vertex.co.x * sign <= 0.0 or vertex.co.y < 0.69:
                continue
            candidates = []
            for digit, points in guides[side].items():
                raw_arc, radial, closest, tangent = sample_curve(vertex.co, points)
                outer = 0.050 if digit == "thumb" else 0.037
                if -0.020 <= raw_arc <= guide_data[digit][2] + 0.030 and radial <= outer:
                    candidates.append((radial / outer, digit, raw_arc, radial, closest, tangent))
            if not candidates:
                continue
            candidate = min(candidates)
            _normalized, digit, arc, radial, closest, tangent = candidate
            assignments[vertex.index] = (digit, arc, tangent)
            bin_index = int(math.floor(arc / BIN_WIDTH))
            samples[(digit, bin_index)].append((vertex.co.copy(), radial))

        for edge in welded.edges:
            first = assignments.get(edge.verts[0].index)
            second = assignments.get(edge.verts[1].index)
            if first is None or second is None or first[0] != second[0]:
                continue
            digit = first[0]
            arc = 0.5 * (first[1] + second[1])
            tangent = (first[2] + second[2]).normalized()
            direction = edge.verts[1].co - edge.verts[0].co
            if direction.length <= 1e-9:
                continue
            alignment = abs(direction.normalized().dot(tangent))
            dihedral = 0.0
            if len(edge.link_faces) == 2:
                dihedral = edge.calc_face_angle_signed()
            bin_index = int(math.floor(arc / BIN_WIDTH))
            edge_features[(digit, bin_index)].append((alignment, abs(dihedral), direction.length))

        for digit, points in guides[side].items():
            if selected_digit and digit != selected_digit:
                continue
            vectors, joint_arcs, total = guide_data[digit]
            print(
                "JOINT_TOPOLOGY_DIGIT", side, digit,
                "guideArcs", tuple(round(value, 6) for value in joint_arcs),
                "guidePoints", tuple(tuple(round(v, 6) for v in point) for point in vectors),
            )
            section_rows, candidates = section_candidates(welded, points, digit)
            if sections_profile:
                for arc, radius, center, hull_count in section_rows:
                    print(
                        "  SECTION_PROFILE",
                        f"arc={arc:.6f}",
                        f"radius={radius:.6f}",
                        f"hull={hull_count}",
                        "center", tuple(round(value, 6) for value in center),
                    )
            for joint_index, candidate in enumerate(candidates):
                if candidate is None:
                    continue
                row, smoothed_radius = candidate
                arc, radius, center, hull_count = row
                current_arc = joint_arcs[joint_index]
                current_center, _current_tangent = curve_station(points, current_arc)
                print(
                    "  SECTION_CANDIDATE",
                    f"joint={joint_index}",
                    f"arc={arc:.6f}",
                    f"currentArc={current_arc:.6f}",
                    f"axialOffset={arc - current_arc:.6f}",
                    f"radius={radius:.6f}",
                    f"smoothedRadius={smoothed_radius:.6f}",
                    f"hull={hull_count}",
                    "center", tuple(round(value, 6) for value in center),
                    f"centerOffset={(center - current_center).length:.6f}",
                )
            if sections_only:
                continue
            rows = []
            start_bin = int(math.floor(-0.010 / BIN_WIDTH))
            end_bin = int(math.ceil((total + 0.020) / BIN_WIDTH))
            for bin_index in range(start_bin, end_bin + 1):
                vertex_rows = samples.get((digit, bin_index), ())
                edge_rows = edge_features.get((digit, bin_index), ())
                if len(vertex_rows) < 3 and len(edge_rows) < 3:
                    continue
                arc = (bin_index + 0.5) * BIN_WIDTH
                radials = [row[1] for row in vertex_rows]
                cross_edges = sum(1 for alignment, _angle, _length in edge_rows if alignment < 0.35)
                longitudinal_edges = sum(1 for alignment, _angle, _length in edge_rows if alignment > 0.80)
                crease = sum(
                    angle * length for _alignment, angle, length in edge_rows
                ) / max(sum(length for _alignment, _angle, length in edge_rows), 1e-12)
                if vertex_rows:
                    center = tuple(
                        statistics.median(row[0][axis] for row in vertex_rows)
                        for axis in range(3)
                    )
                else:
                    center = (math.nan, math.nan, math.nan)
                rows.append(
                    (
                        arc,
                        len(vertex_rows),
                        percentile(radials, 0.25),
                        percentile(radials, 0.50),
                        percentile(radials, 0.75),
                        cross_edges,
                        longitudinal_edges,
                        crease,
                        center,
                    )
                )
            for row in rows:
                arc, count, q25, median, q75, cross, longitudinal, crease, center = row
                marker = ""
                if any(abs(arc - joint) <= BIN_WIDTH * 0.55 for joint in joint_arcs[1:-1]):
                    marker = " CURRENT_JOINT"
                print(
                    "  PROFILE",
                    f"arc={arc:.5f}",
                    f"count={count}",
                    f"radius25={q25:.5f}",
                    f"radius50={median:.5f}",
                    f"radius75={q75:.5f}",
                    f"crossEdges={cross}",
                    f"longEdges={longitudinal}",
                    f"crease={math.degrees(crease):.3f}",
                    "median", tuple(round(value, 5) for value in center),
                    marker,
                )

    welded.free()


if __name__ == "__main__":
    main()
