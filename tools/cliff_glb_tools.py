"""Small GLB topology helpers shared by the offline desert-cliff builders."""

from __future__ import annotations

import json
import struct
from pathlib import Path

import numpy as np


def parse_glb(data: bytes) -> tuple[dict, int]:
    magic, version, declared = struct.unpack_from("<4sII", data, 0)
    if magic != b"glTF" or version != 2 or declared != len(data):
        raise RuntimeError("Invalid glTF 2.0 binary")
    offset = 12
    gltf = None
    binary_start = -1
    while offset < len(data):
        length, chunk_type = struct.unpack_from("<II", data, offset)
        payload_start = offset + 8
        if chunk_type == 0x4E4F534A:
            gltf = json.loads(data[payload_start : payload_start + length].rstrip(b" \0"))
        elif chunk_type == 0x004E4942:
            binary_start = payload_start
        offset = payload_start + length
    if gltf is None or binary_start < 0:
        raise RuntimeError("GLB is missing JSON or BIN data")
    return gltf, binary_start


def repair_all_winding_copy(source: Path, destination: Path) -> list[dict]:
    """Copy a GLB while flipping faces whose winding opposes authored normals."""
    data = bytearray(source.read_bytes())
    gltf, binary_start = parse_glb(data)
    reports = []
    for node in gltf["nodes"]:
        if not isinstance(node.get("mesh"), int):
            continue
        mesh = gltf["meshes"][node["mesh"]]
        node_repairs = 0
        for primitive in mesh["primitives"]:
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
                data,
                dtype="<f4",
                count=position_accessor["count"] * 3,
                offset=position_offset,
            ).reshape((-1, 3))
            normals = np.frombuffer(
                data,
                dtype="<f4",
                count=normal_accessor["count"] * 3,
                offset=normal_offset,
            ).reshape((-1, 3))
            index_dtype = {5123: "<u2", 5125: "<u4"}.get(index_accessor["componentType"])
            if index_dtype is None:
                raise RuntimeError("Unsupported cliff index component type")
            indices = np.frombuffer(
                data,
                dtype=index_dtype,
                count=index_accessor["count"],
                offset=index_offset,
            ).reshape((-1, 3))
            a = positions[indices[:, 0]]
            b = positions[indices[:, 1]]
            c = positions[indices[:, 2]]
            face_normals = np.cross(b - a, c - a)
            authored_normals = (
                normals[indices[:, 0]]
                + normals[indices[:, 1]]
                + normals[indices[:, 2]]
            )
            reversed_faces = np.einsum("ij,ij->i", face_normals, authored_normals) < 0
            node_repairs += int(np.count_nonzero(reversed_faces))
            for triangle in np.flatnonzero(reversed_faces):
                left = int(indices[triangle, 1])
                indices[triangle, 1] = indices[triangle, 2]
                indices[triangle, 2] = left
        reports.append({"node": node.get("name", ""), "repairs": node_repairs})
    destination.write_bytes(data)
    return reports
