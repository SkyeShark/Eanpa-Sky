#!/usr/bin/env python3
"""Print spatial slices through the authored right hand for rig landmarks."""

from pathlib import Path
import statistics

import bpy


ROOT = Path(__file__).resolve().parents[1]
ASSET = ROOT / "assets" / "player" / "Aletheia_Chrome_1p_arms.glb"


def summarize(label, vertices, axis, start, end, step, predicate) -> None:
    print("HAND_GEOMETRY", label)
    lower = start
    while lower < end - 1e-9:
        upper = lower + step
        points = [
            vertex.co for vertex in vertices
            if lower <= vertex.co[axis] < upper and predicate(vertex.co)
        ]
        if points:
            centers = tuple(statistics.median(point[i] for point in points) for i in range(3))
            minimum = tuple(min(point[i] for point in points) for i in range(3))
            maximum = tuple(max(point[i] for point in points) for i in range(3))
            print(
                "  SLICE", round(lower, 3), round(upper, 3), "count", len(points),
                "median", tuple(round(value, 5) for value in centers),
                "min", tuple(round(value, 5) for value in minimum),
                "max", tuple(round(value, 5) for value in maximum),
            )
        lower = upper


def main() -> None:
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    bpy.ops.import_scene.gltf(filepath=str(ASSET))
    mesh = next(obj for obj in bpy.context.scene.objects if obj.type == "MESH")
    vertices = list(mesh.data.vertices)
    summarize(
        "thumb_by_y", vertices, 1, 0.66, 0.96, 0.02,
        lambda co: 0.04 < co.x < 0.29 and co.z < 0.30,
    )
    summarize(
        "index_by_y", vertices, 1, 0.70, 0.96, 0.02,
        lambda co: 0.17 < co.x < 0.27 and 0.30 < co.z < 0.56,
    )
    summarize(
        "middle_by_y", vertices, 1, 0.78, 0.96, 0.02,
        lambda co: 0.265 < co.x < 0.325 and 0.34 < co.z < 0.56,
    )
    summarize(
        "ring_by_y", vertices, 1, 0.78, 0.96, 0.02,
        lambda co: 0.325 < co.x < 0.405 and 0.33 < co.z < 0.55,
    )
    summarize(
        "pinky_by_y", vertices, 1, 0.68, 0.96, 0.02,
        lambda co: 0.37 < co.x < 0.53 and 0.28 < co.z < 0.52,
    )


if __name__ == "__main__":
    main()
