#!/usr/bin/env python3
"""Print connected-component and coordinate diagnostics for the Chrome source."""

from pathlib import Path

import bpy
import bmesh


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "assets" / "player" / "Aletheia_Chrome_1p_arms.glb"


def main() -> None:
    bpy.ops.import_scene.gltf(filepath=str(SOURCE))
    mesh = next(obj for obj in bpy.context.scene.objects if obj.type == "MESH")
    data = mesh.data
    parent = list(range(len(data.vertices)))

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

    for edge in data.edges:
        union(edge.vertices[0], edge.vertices[1])
    components: dict[int, list[int]] = {}
    for vertex in data.vertices:
        components.setdefault(find(vertex.index), []).append(vertex.index)

    print(
        "TOPOLOGY",
        len(data.vertices),
        len(data.edges),
        len(data.polygons),
        "COMPONENTS",
        len(components),
    )
    rows = []
    for indices in components.values():
        coordinates = [data.vertices[index].co for index in indices]
        minimum = tuple(min(co[axis] for co in coordinates) for axis in range(3))
        maximum = tuple(max(co[axis] for co in coordinates) for axis in range(3))
        center = tuple(
            sum(co[axis] for co in coordinates) / len(coordinates)
            for axis in range(3)
        )
        rows.append((len(indices), minimum, maximum, center))
    for count, minimum, maximum, center in sorted(rows, reverse=True):
        print(
            "COMP",
            count,
            "MIN",
            tuple(round(value, 5) for value in minimum),
            "MAX",
            tuple(round(value, 5) for value in maximum),
            "CENTER",
            tuple(round(value, 5) for value in center),
        )

    for side, predicate in (
        ("LEFT", lambda x: x < 0.0),
        ("RIGHT", lambda x: x >= 0.0),
    ):
        coordinates = [vertex.co for vertex in data.vertices if predicate(vertex.co.x)]
        print("SIDE", side, len(coordinates))
        for axis, name in enumerate(("X", "Y", "Z")):
            values = sorted(co[axis] for co in coordinates)
            quantiles = [
                values[int((len(values) - 1) * fraction)]
                for fraction in (0.0, 0.01, 0.05, 0.1, 0.25, 0.5, 0.75, 0.9, 0.95, 0.99, 1.0)
            ]
            print(name, [round(value, 5) for value in quantiles])

    welded = data.copy()
    welded.name = "Aletheia_Topology_Probe_Welded"
    probe = bpy.data.objects.new("Aletheia_Topology_Probe_Welded", welded)
    bpy.context.collection.objects.link(probe)
    bm = bmesh.new()
    bm.from_mesh(welded)
    original_count = len(bm.verts)
    bmesh.ops.remove_doubles(bm, verts=list(bm.verts), dist=0.00002)
    bm.to_mesh(welded)
    bm.free()
    welded.update()
    parent = list(range(len(welded.vertices)))

    def welded_find(index: int) -> int:
        while parent[index] != index:
            parent[index] = parent[parent[index]]
            index = parent[index]
        return index

    for edge in welded.edges:
        first, second = edge.vertices
        first_root = welded_find(first)
        second_root = welded_find(second)
        if first_root != second_root:
            parent[second_root] = first_root
    welded_components: dict[int, list[int]] = {}
    for vertex in welded.vertices:
        welded_components.setdefault(welded_find(vertex.index), []).append(vertex.index)
    print(
        "WELDED",
        original_count,
        "TO",
        len(welded.vertices),
        "COMPONENTS",
        len(welded_components),
    )
    welded_rows = []
    for indices in welded_components.values():
        coordinates = [welded.vertices[index].co for index in indices]
        minimum = tuple(min(co[axis] for co in coordinates) for axis in range(3))
        maximum = tuple(max(co[axis] for co in coordinates) for axis in range(3))
        center = tuple(
            sum(co[axis] for co in coordinates) / len(coordinates)
            for axis in range(3)
        )
        welded_rows.append((len(indices), minimum, maximum, center))
    for count, minimum, maximum, center in sorted(welded_rows, reverse=True)[:40]:
        print(
            "WCOMP",
            count,
            "MIN",
            tuple(round(value, 5) for value in minimum),
            "MAX",
            tuple(round(value, 5) for value in maximum),
            "CENTER",
            tuple(round(value, 5) for value in center),
        )


if __name__ == "__main__":
    main()
