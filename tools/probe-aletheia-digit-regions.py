#!/usr/bin/env python3
"""Measure source vertex distance from the authored digit centerlines."""

from pathlib import Path

import bpy
from mathutils import Vector


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "assets" / "player" / "Aletheia_Chrome_1p_arms.glb"
DIGITS = ("thumb", "index", "middle", "ring", "pinky")


def points(sign):
    return {
        "thumb_base": (sign * 0.265, 0.715, 0.275),
        "thumb_tip": (sign * 0.115, 0.875, 0.205),
        "index_base": (sign * 0.245, 0.745, 0.355),
        "index_tip": (sign * 0.200, 0.910, 0.490),
        "middle_base": (sign * 0.292, 0.755, 0.370),
        "middle_tip": (sign * 0.282, 0.925, 0.530),
        "ring_base": (sign * 0.340, 0.745, 0.355),
        "ring_tip": (sign * 0.360, 0.910, 0.510),
        "pinky_base": (sign * 0.390, 0.720, 0.325),
        "pinky_tip": (sign * 0.460, 0.880, 0.450),
    }


def sample(point, start, end):
    start = Vector(start)
    axis = Vector(end) - start
    raw = (point - start).dot(axis) / axis.length_squared
    along = max(0.0, min(1.0, raw))
    return raw, (point - (start + axis * along)).length


def quantiles(values):
    values = sorted(values)
    return [
        round(values[int((len(values) - 1) * fraction)], 5)
        for fraction in (0.0, 0.1, 0.5, 0.9, 0.95, 0.99, 1.0)
    ]


def main():
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    bpy.ops.import_scene.gltf(filepath=str(SOURCE))
    mesh = next(obj for obj in bpy.context.scene.objects if obj.type == "MESH")
    for side, sign in (("left", -1.0), ("right", 1.0)):
        anatomy = points(sign)
        buckets = {digit: [] for digit in DIGITS}
        gated = {digit: 0 for digit in DIGITS}
        for vertex in mesh.data.vertices:
            if (vertex.co.x < 0.0) != (sign < 0.0) or vertex.co.y < 0.64:
                continue
            candidates = []
            for digit in DIGITS:
                raw, distance = sample(
                    vertex.co,
                    anatomy[f"{digit}_base"],
                    anatomy[f"{digit}_tip"],
                )
                candidates.append((distance, digit, raw))
            distance, digit, raw = min(candidates)
            if raw < 0.05:
                continue
            buckets[digit].append(distance)
            radius = 0.115 if digit == "thumb" else 0.092
            if distance > radius * 1.08:
                gated[digit] += 1
        for digit in DIGITS:
            print(
                "DIGIT_REGION",
                side,
                digit,
                len(buckets[digit]),
                "DIST",
                quantiles(buckets[digit]),
                "OUTSIDE",
                gated[digit],
            )


if __name__ == "__main__":
    main()
