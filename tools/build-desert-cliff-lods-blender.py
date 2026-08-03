#!/usr/bin/env python3
"""Bake real near/mid/far LODs into the optimized user cliff GLBs.

Run from the repository root:
  "C:/Program Files/Blender Foundation/Blender 4.3/blender.exe" \
      --background --factory-startup --python tools/build-desert-cliff-lods-blender.py
"""

from __future__ import annotations

import hashlib
import json
import struct
import sys
import tempfile
from pathlib import Path

import bmesh
import bpy
import numpy as np
sys.path.insert(0, str(Path(__file__).resolve().parent))
from cliff_glb_tools import repair_all_winding_copy


ROOT = Path(__file__).resolve().parents[1]
LOD_RATIOS = (1.0, 0.40, 0.16)
LOD_DISTANCES = (0, 600, 1050)
ASSETS = (
    {
        "key": "wideLow",
        "prefix": "DesertCliffWideLow",
        "master": ROOT / "assets/terrain/Desert_Cliff_Wide_Mesa_Low.glb",
        "input": ROOT / "assets/terrain/Desert_Cliff_Wide_Mesa_Low_runtime_2k.glb",
        "output": ROOT / "assets/terrain/Desert_Cliff_Wide_Mesa_Low_runtime_2k_lods.glb",
    },
    {
        "key": "mesaHigh",
        "prefix": "DesertCliffMesaHigh",
        "master": ROOT / "assets/terrain/Desert_Cliff_Mesa_High.glb",
        "input": ROOT / "assets/terrain/Desert_Cliff_Mesa_High_runtime_2k.glb",
        "output": ROOT / "assets/terrain/Desert_Cliff_Mesa_High_runtime_2k_lods.glb",
    },
)
MANIFEST = ROOT / "assets/terrain/desert_cliff_runtime_lods.json"


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def parse_glb(data: bytes) -> tuple[dict, int, int]:
    magic, version, declared = struct.unpack_from("<4sII", data, 0)
    if magic != b"glTF" or version != 2 or declared != len(data):
        raise RuntimeError("Invalid glTF 2.0 binary")
    offset = 12
    gltf = None
    binary_start = -1
    binary_length = 0
    while offset < len(data):
        length, chunk_type = struct.unpack_from("<II", data, offset)
        payload_start = offset + 8
        if chunk_type == 0x4E4F534A:
            gltf = json.loads(data[payload_start : payload_start + length].rstrip(b" \0"))
        elif chunk_type == 0x004E4942:
            binary_start = payload_start
            binary_length = length
        offset = payload_start + length
    if gltf is None or binary_start < 0:
        raise RuntimeError("GLB is missing JSON or BIN data")
    return gltf, binary_start, binary_length


def repair_winding_copy(source: Path, destination: Path) -> int:
    data = bytearray(source.read_bytes())
    gltf, binary_start, _ = parse_glb(data)
    mesh_nodes = [node for node in gltf["nodes"] if isinstance(node.get("mesh"), int)]
    if len(mesh_nodes) != 1:
        raise RuntimeError(f"{source.name} must contain exactly one mesh")
    primitive = gltf["meshes"][mesh_nodes[0]["mesh"]]["primitives"][0]
    position_accessor = gltf["accessors"][primitive["attributes"]["POSITION"]]
    normal_accessor = gltf["accessors"][primitive["attributes"]["NORMAL"]]
    index_accessor = gltf["accessors"][primitive["indices"]]
    position_view = gltf["bufferViews"][position_accessor["bufferView"]]
    normal_view = gltf["bufferViews"][normal_accessor["bufferView"]]
    index_view = gltf["bufferViews"][index_accessor["bufferView"]]
    if position_view.get("byteStride") or normal_view.get("byteStride"):
        raise RuntimeError("Interleaved cliff attributes are unsupported")
    position_offset = (
        binary_start + position_view.get("byteOffset", 0)
        + position_accessor.get("byteOffset", 0)
    )
    normal_offset = (
        binary_start + normal_view.get("byteOffset", 0)
        + normal_accessor.get("byteOffset", 0)
    )
    index_offset = (
        binary_start + index_view.get("byteOffset", 0)
        + index_accessor.get("byteOffset", 0)
    )
    positions = np.frombuffer(
        data, dtype="<f4", count=position_accessor["count"] * 3, offset=position_offset
    ).reshape((-1, 3))
    normals = np.frombuffer(
        data, dtype="<f4", count=normal_accessor["count"] * 3, offset=normal_offset
    ).reshape((-1, 3))
    index_dtype = {5123: "<u2", 5125: "<u4"}[index_accessor["componentType"]]
    indices = np.frombuffer(
        data, dtype=index_dtype, count=index_accessor["count"], offset=index_offset
    ).reshape((-1, 3))
    a = positions[indices[:, 0]]
    b = positions[indices[:, 1]]
    c = positions[indices[:, 2]]
    face_normals = np.cross(b - a, c - a)
    authored_normals = (
        normals[indices[:, 0]] + normals[indices[:, 1]] + normals[indices[:, 2]]
    )
    reversed_faces = np.einsum("ij,ij->i", face_normals, authored_normals) < 0
    repair_count = int(np.count_nonzero(reversed_faces))
    for triangle in np.flatnonzero(reversed_faces):
        left = int(indices[triangle, 1])
        indices[triangle, 1] = indices[triangle, 2]
        indices[triangle, 2] = left
    destination.write_bytes(data)
    return repair_count


def reset_scene() -> None:
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    for datablocks in (bpy.data.meshes, bpy.data.materials, bpy.data.images):
        for datablock in list(datablocks):
            if datablock.users == 0:
                datablocks.remove(datablock)


def activate(obj: bpy.types.Object) -> None:
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj


def apply_modifier(obj: bpy.types.Object, modifier: bpy.types.Modifier) -> None:
    activate(obj)
    bpy.ops.object.modifier_apply(modifier=modifier.name)


def bake_lod(source: bpy.types.Object, prefix: str, lod: int, ratio: float) -> bpy.types.Object:
    obj = source.copy()
    obj.data = source.data.copy()
    obj.name = f"{prefix}_LOD{lod}"
    obj.data.name = f"{prefix}_LOD{lod}_Mesh"
    bpy.context.collection.objects.link(obj)
    if ratio < 0.999:
        modifier = obj.modifiers.new(f"LOD{lod}_conservative_decimation", "DECIMATE")
        modifier.decimate_type = "COLLAPSE"
        modifier.ratio = ratio
        modifier.use_collapse_triangulate = True
        apply_modifier(obj, modifier)
    triangulate = obj.modifiers.new("Deterministic_triangulation", "TRIANGULATE")
    triangulate.quad_method = "BEAUTY"
    triangulate.ngon_method = "BEAUTY"
    apply_modifier(obj, triangulate)
    obj.data.update(calc_edges=True)
    obj["eanpaLod"] = lod
    obj["eanpaReductionRatio"] = ratio
    obj["eanpaDistanceMetres"] = LOD_DISTANCES[lod]
    return obj


def mesh_metrics(obj: bpy.types.Object) -> dict:
    mesh = obj.data
    mesh.calc_loop_triangles()
    coords = np.asarray([vertex.co[:] for vertex in mesh.vertices], dtype=np.float64)
    bm = bmesh.new()
    bm.from_mesh(mesh)
    boundary = sum(1 for edge in bm.edges if edge.is_boundary)
    nonmanifold = sum(1 for edge in bm.edges if not edge.is_manifold)
    bm.free()
    return {
        "vertices": len(mesh.vertices),
        "triangles": len(mesh.loop_triangles),
        "uvLayers": len(mesh.uv_layers),
        "materialSlots": len(obj.material_slots),
        "boundaryEdges": boundary,
        "nonManifoldEdges": nonmanifold,
        "boundsMin": coords.min(axis=0).tolist(),
        "boundsMax": coords.max(axis=0).tolist(),
    }


def build_asset(config: dict) -> dict:
    reset_scene()
    with tempfile.TemporaryDirectory(prefix="eanpa_cliff_lod_") as temp_dir:
        repaired_input = Path(temp_dir) / config["input"].name
        winding_repairs = repair_winding_copy(config["input"], repaired_input)
        bpy.ops.import_scene.gltf(filepath=str(repaired_input))
        sources = [obj for obj in bpy.context.scene.objects if obj.type == "MESH"]
        if len(sources) != 1:
            raise RuntimeError(f"{config['input'].name} imported {len(sources)} meshes")
        source = sources[0]
        if len(source.data.uv_layers) < 1 or len(source.material_slots) != 1:
            raise RuntimeError(f"{config['input'].name} lost UVs or its baked material")
        lod_objects = []
        lod_reports = []
        for lod, ratio in enumerate(LOD_RATIOS):
            obj = bake_lod(source, config["prefix"], lod, ratio)
            metrics = mesh_metrics(obj)
            if metrics["uvLayers"] < 1 or metrics["materialSlots"] != 1:
                raise RuntimeError(f"{obj.name} lost UVs or baked material")
            lod_objects.append(obj)
            lod_reports.append({"lod": lod, "ratio": ratio, **metrics})
        bpy.data.objects.remove(source, do_unlink=True)
        bpy.ops.object.select_all(action="DESELECT")
        for obj in lod_objects:
            obj.select_set(True)
        bpy.context.view_layer.objects.active = lod_objects[0]
        bpy.ops.export_scene.gltf(
            filepath=str(config["output"]),
            export_format="GLB",
            use_selection=True,
            export_apply=True,
            export_yup=True,
            export_normals=True,
            export_texcoords=True,
            export_attributes=True,
            export_extras=True,
            export_materials="EXPORT",
            export_image_format="AUTO",
        )
        repaired_output = Path(temp_dir) / config['output'].name
        lod_winding_repairs = repair_all_winding_copy(config['output'], repaired_output)
        repaired_output.replace(config['output'])
    return {
        'lodWindingRepairs': lod_winding_repairs,
        "key": config["key"],
        "master": config["master"].relative_to(ROOT).as_posix(),
        "masterSha256": sha256(config["master"]),
        "optimizedSource": config["input"].relative_to(ROOT).as_posix(),
        "optimizedSourceSha256": sha256(config["input"]),
        "runtime": config["output"].relative_to(ROOT).as_posix(),
        "runtimeSha256": sha256(config["output"]),
        "runtimeBytes": config["output"].stat().st_size,
        "windingRepairs": winding_repairs,
        "lods": lod_reports,
    }


def main() -> None:
    reports = [build_asset(config) for config in ASSETS]
    manifest = {
        "schema": "eanpa-user-desert-cliff-lods-v1",
        "blenderVersion": bpy.app.version_string,
        "lodRatios": list(LOD_RATIOS),
        "lodDistancesMetres": list(LOD_DISTANCES),
        "textureMaximum": 2048,
        "originalsUntouched": True,
        "assets": reports,
    }
    MANIFEST.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf8")
    print(json.dumps(manifest, indent=2))


if __name__ == "__main__":
    main()
