#!/usr/bin/env python3
"""Print topology/anatomy statistics for an Aletheia arm source GLB.

Pass a project-relative or absolute GLB path after Blender's -- separator.
Without an argument the current Aletheia Chrome source is inspected.
"""

from collections import defaultdict
from pathlib import Path
import sys

import bpy
from mathutils import Vector


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_SOURCE = ROOT / "assets" / "player" / "Aletheia_Chrome_1p_arms.glb"


def source_path() -> Path:
    arguments = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    if not arguments:
        return DEFAULT_SOURCE
    candidate = Path(arguments[0])
    return candidate if candidate.is_absolute() else ROOT / candidate


def main() -> None:
    source = source_path()
    if not source.exists():
        raise FileNotFoundError(source)
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    bpy.ops.import_scene.gltf(filepath=str(source))
    meshes = [obj for obj in bpy.context.scene.objects if obj.type == "MESH"]
    armatures = [obj for obj in bpy.context.scene.objects if obj.type == "ARMATURE"]
    label = source.relative_to(ROOT) if source.is_relative_to(ROOT) else source
    print(f"SOURCE_FILE {label}")
    print(f"SOURCE_OBJECTS {len(bpy.context.scene.objects)}")
    print(f"SOURCE_MESHES {len(meshes)}")
    print(f"SOURCE_ARMATURES {len(armatures)}")
    print(f"SOURCE_ACTIONS {len(bpy.data.actions)}")
    if len(meshes) != 1:
        raise RuntimeError(f"Expected one source mesh, found {len(meshes)}")
    mesh = meshes[0]
    world_corners = [mesh.matrix_world @ Vector(corner) for corner in mesh.bound_box]
    world_minimum = tuple(min(point[axis] for point in world_corners) for axis in range(3))
    world_maximum = tuple(max(point[axis] for point in world_corners) for axis in range(3))
    print(f"SOURCE_MESH_NAME {mesh.name}")
    print(f"SOURCE_VERTICES {len(mesh.data.vertices)}")
    print(f"SOURCE_EDGES {len(mesh.data.edges)}")
    print(f"SOURCE_POLYGONS {len(mesh.data.polygons)}")
    print(f"SOURCE_UV_LAYERS {[layer.name for layer in mesh.data.uv_layers]}")
    print(f"SOURCE_SHAPE_KEYS {list(mesh.data.shape_keys.key_blocks) if mesh.data.shape_keys else []}")
    print(f"SOURCE_WORLD_MIN {tuple(round(value, 6) for value in world_minimum)}")
    print(f"SOURCE_WORLD_MAX {tuple(round(value, 6) for value in world_maximum)}")
    print(f"SOURCE_OBJECT_MATRIX {tuple(round(value, 6) for row in mesh.matrix_world for value in row)}")
    print(f"SOURCE_MATERIALS {[material.name for material in mesh.data.materials if material]}")
    for image in bpy.data.images:
        if image.name == "Render Result":
            continue
        print(
            "SOURCE_IMAGE",
            image.name,
            tuple(int(value) for value in image.size),
            image.colorspace_settings.name,
            "PACKED" if image.packed_file else "EXTERNAL",
        )
    count = len(mesh.data.vertices)
    parent = list(range(count))

    def find(index: int) -> int:
        while parent[index] != index:
            parent[index] = parent[parent[index]]
            index = parent[index]
        return index

    def union(first: int, second: int) -> None:
        first_root = find(first)
        second_root = find(second)
        if first_root != second_root:
            parent[second_root] = first_root

    for edge in mesh.data.edges:
        union(*edge.vertices)
    components: dict[int, list] = defaultdict(list)
    for vertex in mesh.data.vertices:
        components[find(vertex.index)].append(vertex.co.copy())
    ordered = sorted(components.values(), key=len, reverse=True)
    print(f"SOURCE_COMPONENTS {len(ordered)}")
    for index, vertices in enumerate(ordered[:32]):
        minimum = tuple(min(point[axis] for point in vertices) for axis in range(3))
        maximum = tuple(max(point[axis] for point in vertices) for axis in range(3))
        average = tuple(
            sum(point[axis] for point in vertices) / len(vertices) for axis in range(3)
        )
        print(
            index,
            len(vertices),
            "MIN",
            tuple(round(value, 4) for value in minimum),
            "MAX",
            tuple(round(value, 4) for value in maximum),
            "AVG",
            tuple(round(value, 4) for value in average),
        )


if __name__ == "__main__":
    main()
