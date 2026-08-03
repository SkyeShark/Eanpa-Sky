#!/usr/bin/env python3
"""Deterministically rebuild the three saguaro body LODs as manifold unions.

Run with Blender 4.3+ in background mode.  The script deliberately reads the
GLB itself instead of using Blender's glTF importer: Blender 4.3 cannot import
this particular file because SeedThree's scalar/vector custom attributes
trigger an importer concatenation bug.  Only body meshes 0/2/4 are rebuilt;
spine cards, billboard cards, materials, textures, and the MSFT_lod hierarchy
remain the responsibility of patch-saguaro-glb.mjs.

The repair is CPU-only:
  1. remove zero-area source faces and weld position seams;
  2. close the buried root opening;
  3. voxel-union the intersecting trunk/arm sleeves;
  4. decimate below the authored body triangle budget;
  5. transfer UV/wind/stem-centre data from the nearest authored triangle;
  6. emit outward normals and orthonormal Mikk-style tangent frames.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import struct
import sys
from pathlib import Path

import bmesh
import bpy
import numpy as np
from mathutils import Vector
from mathutils.bvhtree import BVHTree


CONFIG = (
    # The voxel size remains below the authored rib amplitude at the near LOD.
    # Targets leave a small safety margin below the original body budgets.
    {"lod": 0, "mesh": 0, "voxel": 0.022, "budget": 12800, "target": 12640},
    {"lod": 1, "mesh": 2, "voxel": 0.034, "budget": 4416, "target": 4352},
    {"lod": 2, "mesh": 4, "voxel": 0.052, "budget": 2048, "target": 2016},
)

COMPONENT_DTYPES = {
    5120: np.dtype("<i1"),
    5121: np.dtype("<u1"),
    5122: np.dtype("<i2"),
    5123: np.dtype("<u2"),
    5125: np.dtype("<u4"),
    5126: np.dtype("<f4"),
}
TYPE_COMPONENTS = {
    "SCALAR": 1,
    "VEC2": 2,
    "VEC3": 3,
    "VEC4": 4,
    "MAT2": 4,
    "MAT3": 9,
    "MAT4": 16,
}


def parse_args() -> argparse.Namespace:
    raw = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--output-json", required=True)
    parser.add_argument("--blend", required=True)
    return parser.parse_args(raw)


def read_glb(path: Path):
    blob = path.read_bytes()
    if blob[:4] != b"glTF" or struct.unpack_from("<I", blob, 4)[0] != 2:
        raise RuntimeError(f"Not a glTF 2 GLB: {path}")
    cursor = 12
    document = None
    binary = None
    while cursor < len(blob):
        length, kind = struct.unpack_from("<II", blob, cursor)
        cursor += 8
        payload = blob[cursor : cursor + length]
        cursor += length
        if kind == 0x4E4F534A:
            document = json.loads(payload.rstrip(b" \0").decode("utf8"))
        elif kind == 0x004E4942:
            binary = payload
    if document is None or binary is None:
        raise RuntimeError("GLB is missing its JSON or BIN chunk")
    return blob, document, binary


def accessor_array(document, binary, accessor_index: int) -> np.ndarray:
    accessor = document["accessors"][accessor_index]
    view = document["bufferViews"][accessor["bufferView"]]
    dtype = COMPONENT_DTYPES[accessor["componentType"]]
    width = TYPE_COMPONENTS[accessor["type"]]
    byte_offset = view.get("byteOffset", 0) + accessor.get("byteOffset", 0)
    stride = view.get("byteStride", dtype.itemsize * width)
    array = np.ndarray(
        shape=(accessor["count"], width),
        dtype=dtype,
        buffer=binary,
        offset=byte_offset,
        strides=(stride, dtype.itemsize),
    ).copy()
    if accessor.get("normalized"):
        if np.issubdtype(dtype, np.signedinteger):
            array = np.maximum(array.astype(np.float64) / np.iinfo(dtype).max, -1.0)
        elif np.issubdtype(dtype, np.unsignedinteger):
            array = array.astype(np.float64) / np.iinfo(dtype).max
    return array


def gltf_to_blender(values: np.ndarray) -> np.ndarray:
    # Proper rotation (determinant +1): glTF +Y up -> Blender +Z up.
    out = np.empty_like(values, dtype=np.float64)
    out[:, 0] = values[:, 0]
    out[:, 1] = -values[:, 2]
    out[:, 2] = values[:, 1]
    return out


def blender_to_gltf(values: np.ndarray) -> np.ndarray:
    out = np.empty_like(values, dtype=np.float64)
    out[:, 0] = values[:, 0]
    out[:, 1] = values[:, 2]
    out[:, 2] = -values[:, 1]
    return out


def area_squared(a, b, c) -> float:
    return float(np.dot(np.cross(b - a, c - a), np.cross(b - a, c - a)))


def make_source_object(name: str, positions: np.ndarray, indices: np.ndarray):
    valid_faces = []
    source_face_ids = []
    for source_face, tri in enumerate(indices.reshape((-1, 3))):
        a, b, c = positions[tri]
        if area_squared(a, b, c) <= 1e-18:
            continue
        valid_faces.append(tuple(int(v) for v in tri))
        source_face_ids.append(source_face)
    mesh = bpy.data.meshes.new(f"{name}_source_mesh")
    mesh.from_pydata(positions.tolist(), [], valid_faces)
    mesh.validate(clean_customdata=False)
    mesh.update()
    obj = bpy.data.objects.new(f"{name}_source", mesh)
    bpy.context.scene.collection.objects.link(obj)
    obj.hide_render = True
    obj.hide_set(True)
    obj.display_type = "WIRE"
    return obj, valid_faces, source_face_ids


def clean_for_voxel(source_obj, name: str):
    mesh = source_obj.data.copy()
    mesh.name = f"{name}_work_mesh"
    obj = bpy.data.objects.new(f"{name}_repaired", mesh)
    bpy.context.scene.collection.objects.link(obj)
    obj.hide_set(False)

    bm = bmesh.new()
    bm.from_mesh(mesh)
    bmesh.ops.remove_doubles(bm, verts=list(bm.verts), dist=1e-5)
    bmesh.ops.dissolve_degenerate(bm, edges=list(bm.edges), dist=1e-7)
    boundary = [edge for edge in bm.edges if edge.is_boundary]
    if boundary:
        bmesh.ops.holes_fill(bm, edges=boundary, sides=0)
    bmesh.ops.recalc_face_normals(bm, faces=list(bm.faces))
    bm.to_mesh(mesh)
    bm.free()
    mesh.validate(clean_customdata=False)
    mesh.update()
    return obj


def set_active(obj):
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj


def apply_modifier(obj, modifier):
    set_active(obj)
    result = bpy.ops.object.modifier_apply(modifier=modifier.name)
    if "FINISHED" not in result:
        raise RuntimeError(f"Could not apply {modifier.name}: {result}")


def triangulate(obj):
    modifier = obj.modifiers.new("Deterministic triangulation", "TRIANGULATE")
    modifier.quad_method = "BEAUTY"
    modifier.ngon_method = "BEAUTY"
    apply_modifier(obj, modifier)


def triangle_count(mesh) -> int:
    return sum(max(0, len(poly.vertices) - 2) for poly in mesh.polygons)


def decimate_to_budget(obj, target: int, budget: int):
    before = triangle_count(obj.data)
    if before <= budget:
        triangulate(obj)
        return before, triangle_count(obj.data)
    modifier = obj.modifiers.new("LOD budget decimation", "DECIMATE")
    modifier.decimate_type = "COLLAPSE"
    modifier.ratio = min(1.0, target / before)
    modifier.use_collapse_triangulate = True
    modifier.use_symmetry = False
    apply_modifier(obj, modifier)
    triangulate(obj)
    after = triangle_count(obj.data)
    if after > budget:
        modifier = obj.modifiers.new("LOD budget safety decimation", "DECIMATE")
        modifier.decimate_type = "COLLAPSE"
        modifier.ratio = min(1.0, (budget - 8) / after)
        modifier.use_collapse_triangulate = True
        apply_modifier(obj, modifier)
        triangulate(obj)
        after = triangle_count(obj.data)
    if after > budget:
        raise RuntimeError(f"Decimation missed budget: {after} > {budget}")
    return before, after


def extract_triangles(obj):
    mesh = obj.data
    mesh.calc_loop_triangles()
    positions = np.array([vertex.co[:] for vertex in mesh.vertices], dtype=np.float64)
    triangles = np.array(
        [
            [mesh.loops[loop_index].vertex_index for loop_index in tri.loops]
            for tri in mesh.loop_triangles
        ],
        dtype=np.int64,
    )
    return positions, triangles


def signed_volume(positions: np.ndarray, triangles: np.ndarray) -> float:
    a = positions[triangles[:, 0]]
    b = positions[triangles[:, 1]]
    c = positions[triangles[:, 2]]
    return float(np.einsum("ij,ij->i", a, np.cross(b, c)).sum() / 6.0)


def topology_metrics(positions: np.ndarray, triangles: np.ndarray):
    # glTF may duplicate an otherwise watertight vertex at a UV/hard-normal
    # seam. Canonicalise exact/near-exact positions before counting incidence,
    # just as a renderer sees the coincident surface.
    canonical = []
    canonical_by_position = {}
    for value in positions:
        key = tuple(int(round(component * 1e6)) for component in value)
        canonical.append(canonical_by_position.setdefault(key, len(canonical_by_position)))
    edges = {}
    degenerates = 0
    for tri in triangles:
        a, b, c = positions[tri]
        ids = [canonical[int(vertex)] for vertex in tri]
        if len(set(ids)) < 3 or area_squared(a, b, c) <= 1e-18:
            degenerates += 1
            continue
        for left, right in ((ids[0], ids[1]), (ids[1], ids[2]), (ids[2], ids[0])):
            key = (min(left, right), max(left, right))
            edges[key] = edges.get(key, 0) + 1
    return {
        "degenerateTriangles": degenerates,
        "boundaryEdges": sum(count == 1 for count in edges.values()),
        "nonManifoldEdges": sum(count > 2 for count in edges.values()),
        "maxEdgeIncidence": max(edges.values(), default=0),
    }


def split_problem_normal_faces(positions, triangles, uv, wind, center, minimum_dot=0.08):
    """Give only irreconcilably sharp concave faces their own corner vertices.

    A closed manifold can still have a tiny crotch triangle whose area-weighted
    smooth vertex normal points behind that face. Splitting those few corners is
    the standard glTF representation of a hard normal seam; position topology
    remains exactly closed. The loop repeats because removing one sharp face
    from a smoothing fan can expose another.
    """
    face_vectors = np.cross(
        positions[triangles[:, 1]] - positions[triangles[:, 0]],
        positions[triangles[:, 2]] - positions[triangles[:, 0]],
    )
    face_lengths = np.linalg.norm(face_vectors, axis=1)
    if np.any(face_lengths < 1e-12):
        raise RuntimeError("Cannot split normals on a degenerate repaired face")
    face_units = face_vectors / face_lengths[:, None]
    hard = set()
    for _iteration in range(12):
        smooth_normals = np.zeros_like(positions)
        for face_index, tri in enumerate(triangles):
            if face_index in hard:
                continue
            for vertex in tri:
                smooth_normals[int(vertex)] += face_vectors[face_index]
        lengths = np.linalg.norm(smooth_normals, axis=1)
        valid = lengths > 1e-12
        smooth_normals[valid] /= lengths[valid, None]
        newly_hard = set()
        for face_index, tri in enumerate(triangles):
            if face_index in hard:
                continue
            average = sum((smooth_normals[int(vertex)] for vertex in tri), np.zeros(3)) / 3.0
            if np.dot(face_units[face_index], average) <= minimum_dot:
                newly_hard.add(face_index)
        if not newly_hard:
            break
        hard.update(newly_hard)
    else:
        raise RuntimeError("Hard-normal face isolation did not converge")

    if not hard:
        return positions, triangles, uv, wind, center, 0
    out_position = positions.tolist()
    out_uv = uv.tolist()
    out_wind = wind.tolist()
    out_center = center.tolist()
    out_triangles = triangles.copy()
    for face_index in sorted(hard):
        for corner in range(3):
            source_vertex = int(triangles[face_index, corner])
            target_vertex = len(out_position)
            out_position.append(positions[source_vertex].tolist())
            out_uv.append(uv[source_vertex].tolist())
            out_wind.append(wind[source_vertex].tolist())
            out_center.append(center[source_vertex].tolist())
            out_triangles[face_index, corner] = target_vertex
    return (
        np.asarray(out_position, dtype=np.float64),
        out_triangles,
        np.asarray(out_uv, dtype=np.float64),
        np.asarray(out_wind, dtype=np.float64),
        np.asarray(out_center, dtype=np.float64),
        len(hard),
    )


def barycentric(point: Vector, a: Vector, b: Vector, c: Vector):
    v0, v1, v2 = b - a, c - a, point - a
    d00, d01, d11 = v0.dot(v0), v0.dot(v1), v1.dot(v1)
    d20, d21 = v2.dot(v0), v2.dot(v1)
    denom = d00 * d11 - d01 * d01
    if abs(denom) < 1e-20:
        return (1.0, 0.0, 0.0)
    v = (d11 * d20 - d01 * d21) / denom
    w = (d00 * d21 - d01 * d20) / denom
    u = 1.0 - v - w
    # Nearest-point numerical error may put a weight a few ulps outside the face.
    u, v, w = max(0.0, u), max(0.0, v), max(0.0, w)
    total = u + v + w
    return (u / total, v / total, w / total) if total > 0 else (1.0, 0.0, 0.0)


def transfer_attributes(
    target_positions,
    source_positions,
    source_faces,
    source_uv,
    source_wind,
    source_center,
):
    vectors = [Vector(value) for value in source_positions]
    bvh = BVHTree.FromPolygons(vectors, source_faces, all_triangles=True)
    target_uv = np.zeros((len(target_positions), 2), dtype=np.float64)
    target_wind = np.zeros((len(target_positions), 1), dtype=np.float64)
    target_center = np.zeros((len(target_positions), 3), dtype=np.float64)
    nearest_distances = []
    for index, value in enumerate(target_positions):
        hit = bvh.find_nearest(Vector(value))
        if hit is None or hit[2] is None:
            raise RuntimeError(f"No source surface near repaired vertex {index}")
        location, _normal, face_index, distance = hit
        tri = source_faces[face_index]
        weights = barycentric(location, vectors[tri[0]], vectors[tri[1]], vectors[tri[2]])
        target_uv[index] = sum(weights[i] * source_uv[tri[i]] for i in range(3))
        target_wind[index] = sum(weights[i] * source_wind[tri[i]] for i in range(3))
        target_center[index] = sum(weights[i] * source_center[tri[i]] for i in range(3))
        nearest_distances.append(float(distance))
    return target_uv, target_wind, target_center, nearest_distances


def build_frames(positions: np.ndarray, triangles: np.ndarray, uv: np.ndarray):
    normals = np.zeros_like(positions)
    tan1 = np.zeros_like(positions)
    tan2 = np.zeros_like(positions)
    for tri in triangles:
        i0, i1, i2 = map(int, tri)
        p0, p1, p2 = positions[i0], positions[i1], positions[i2]
        edge1, edge2 = p1 - p0, p2 - p0
        face = np.cross(edge1, edge2)
        normals[i0] += face
        normals[i1] += face
        normals[i2] += face
        duv1, duv2 = uv[i1] - uv[i0], uv[i2] - uv[i0]
        determinant = duv1[0] * duv2[1] - duv1[1] * duv2[0]
        if abs(determinant) < 1e-14:
            continue
        reciprocal = 1.0 / determinant
        tangent = (edge1 * duv2[1] - edge2 * duv1[1]) * reciprocal
        bitangent = (edge2 * duv1[0] - edge1 * duv2[0]) * reciprocal
        for vertex in (i0, i1, i2):
            tan1[vertex] += tangent
            tan2[vertex] += bitangent
    lengths = np.linalg.norm(normals, axis=1)
    if np.any(lengths < 1e-12):
        raise RuntimeError("Repair produced a vertex without a valid normal")
    normals /= lengths[:, None]
    tangents = np.zeros((len(positions), 4), dtype=np.float64)
    for index, normal in enumerate(normals):
        tangent = tan1[index] - normal * np.dot(normal, tan1[index])
        length = np.linalg.norm(tangent)
        if length < 1e-10:
            axis = np.array((1.0, 0.0, 0.0)) if abs(normal[0]) < 0.8 else np.array((0.0, 1.0, 0.0))
            tangent = np.cross(axis, normal)
            length = np.linalg.norm(tangent)
        tangent /= length
        tangents[index, :3] = tangent
        tangents[index, 3] = -1.0 if np.dot(np.cross(normal, tangent), tan2[index]) < 0 else 1.0
    return normals, tangents


def rounded(values: np.ndarray, digits=8):
    return np.round(values.astype(np.float64), digits).tolist()


def add_uv_preview(obj, uv: np.ndarray):
    mesh = obj.data
    layer = mesh.uv_layers.new(name="SeedThree_UV0")
    for loop in mesh.loops:
        layer.data[loop.index].uv = uv[loop.vertex_index]
    for polygon in mesh.polygons:
        polygon.use_smooth = True


def replace_preview_geometry(obj, positions, triangles, uv, material):
    old_mesh = obj.data
    mesh = bpy.data.meshes.new(f"{obj.name}_final_mesh")
    mesh.from_pydata(positions.tolist(), [], triangles.tolist())
    mesh.validate(clean_customdata=False)
    mesh.update()
    mesh.materials.append(material)
    obj.data = mesh
    add_uv_preview(obj, uv)
    if old_mesh.users == 0:
        bpy.data.meshes.remove(old_mesh)


def main():
    args = parse_args()
    input_path = Path(args.input).resolve()
    output_path = Path(args.output_json).resolve()
    blend_path = Path(args.blend).resolve()
    output_path.parent.mkdir(parents=True, exist_ok=True)
    blend_path.parent.mkdir(parents=True, exist_ok=True)

    blob, document, binary = read_glb(input_path)
    source_sha = hashlib.sha256(blob).hexdigest()
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)

    placeholder = bpy.data.materials.new("Saguaro_Skin_material_0_preserved_in_GLB")
    placeholder.diffuse_color = (0.16, 0.34, 0.13, 1.0)
    results = []

    for cfg in CONFIG:
        primitive = document["meshes"][cfg["mesh"]]["primitives"][0]
        attributes = primitive["attributes"]
        source_positions_gltf = accessor_array(document, binary, attributes["POSITION"]).astype(np.float64)
        source_positions = gltf_to_blender(source_positions_gltf)
        source_indices = accessor_array(document, binary, primitive["indices"]).reshape(-1).astype(np.int64)
        source_uv = accessor_array(document, binary, attributes["TEXCOORD_0"]).astype(np.float64)
        source_wind = accessor_array(document, binary, attributes["_AWIND"]).astype(np.float64)
        source_center_gltf = accessor_array(document, binary, attributes["_ASTEMCENTER"]).astype(np.float64)
        source_center = gltf_to_blender(source_center_gltf)

        name = f"Saguaro_LOD{cfg['lod']}_body"
        source_obj, source_faces, _source_face_ids = make_source_object(
            name,
            source_positions,
            source_indices,
        )
        repaired = clean_for_voxel(source_obj, name)
        repaired.data.materials.append(placeholder)
        set_active(repaired)
        repaired.data.remesh_voxel_size = cfg["voxel"]
        repaired.data.remesh_voxel_adaptivity = 0.0
        repaired.data.use_remesh_fix_poles = True
        repaired.data.use_remesh_preserve_volume = True
        result = bpy.ops.object.voxel_remesh()
        if "FINISHED" not in result:
            raise RuntimeError(f"Voxel remesh failed for LOD{cfg['lod']}: {result}")

        raw_triangles, final_triangles = decimate_to_budget(
            repaired,
            cfg["target"],
            cfg["budget"],
        )
        target_positions, triangles = extract_triangles(repaired)
        volume = signed_volume(target_positions, triangles)
        if volume < 0:
            triangles[:, [1, 2]] = triangles[:, [2, 1]]
            volume = -volume
        if volume <= 1e-8:
            raise RuntimeError(f"LOD{cfg['lod']} has no enclosed volume")

        target_uv, target_wind, target_center, distances = transfer_attributes(
            target_positions,
            source_positions,
            source_faces,
            source_uv,
            source_wind,
            source_center,
        )
        (
            target_positions,
            triangles,
            target_uv,
            target_wind,
            target_center,
            hard_normal_faces,
        ) = split_problem_normal_faces(
            target_positions,
            triangles,
            target_uv,
            target_wind,
            target_center,
        )
        normals, tangents = build_frames(target_positions, triangles, target_uv)
        metrics = topology_metrics(target_positions, triangles)
        if any(metrics[key] for key in ("degenerateTriangles", "boundaryEdges", "nonManifoldEdges")):
            raise RuntimeError(f"LOD{cfg['lod']} is not manifold after repair: {metrics}")
        if metrics["maxEdgeIncidence"] != 2:
            raise RuntimeError(f"LOD{cfg['lod']} edge incidence is not exactly two: {metrics}")

        replace_preview_geometry(repaired, target_positions, triangles, target_uv, placeholder)
        repaired["eanpa_source_mesh_index"] = cfg["mesh"]
        repaired["eanpa_authored_triangle_budget"] = cfg["budget"]
        repaired["eanpa_voxel_size"] = cfg["voxel"]
        repaired["eanpa_source_sha256"] = source_sha

        target_positions_gltf = blender_to_gltf(target_positions)
        normals_gltf = blender_to_gltf(normals)
        tangent_xyz_gltf = blender_to_gltf(tangents[:, :3])
        tangents_gltf = np.column_stack((tangent_xyz_gltf, tangents[:, 3]))
        target_center_gltf = blender_to_gltf(target_center)
        result_entry = {
            "lod": cfg["lod"],
            "meshIndex": cfg["mesh"],
            "material": primitive.get("material"),
            "voxelSize": cfg["voxel"],
            "triangleBudget": cfg["budget"],
            "sourceTriangles": int(len(source_indices) // 3),
            "voxelTriangles": int(raw_triangles),
            "triangles": int(len(triangles)),
            "vertices": int(len(target_positions)),
            "hardNormalFaces": int(hard_normal_faces),
            "signedVolume": float(volume),
            "nearestSourceDistance": {
                "max": max(distances),
                "mean": sum(distances) / len(distances),
            },
            "bounds": {
                "sourceMin": rounded(source_positions_gltf.min(axis=0)[None, :])[0],
                "sourceMax": rounded(source_positions_gltf.max(axis=0)[None, :])[0],
                "repairedMin": rounded(target_positions_gltf.min(axis=0)[None, :])[0],
                "repairedMax": rounded(target_positions_gltf.max(axis=0)[None, :])[0],
            },
            "topology": metrics,
            "position": rounded(target_positions_gltf),
            "normal": rounded(normals_gltf),
            "texcoord0": rounded(target_uv),
            "tangent": rounded(tangents_gltf),
            "aWind": rounded(target_wind),
            "aStemCenter": rounded(target_center_gltf),
            "indices": triangles.astype(np.int64).reshape(-1).tolist(),
        }
        results.append(result_entry)
        print(
            f"[saguaro repair] LOD{cfg['lod']}: "
            f"{result_entry['sourceTriangles']} -> {result_entry['triangles']} tris, "
            f"{result_entry['vertices']} verts, nearest max {max(distances):.5f}m"
        )

    payload = {
        "format": "eanpa-saguaro-manifold-repair/1",
        "source": str(input_path),
        "sourceSha256": source_sha,
        "blenderVersion": bpy.app.version_string,
        "coordinateTransform": "gltf(x,y,z)<->blender(x,-z,y)",
        "meshes": results,
    }
    output_path.write_text(json.dumps(payload, separators=(",", ":")), encoding="utf8")
    bpy.context.scene["eanpa_saguaro_repair_source_sha256"] = source_sha
    bpy.context.scene["eanpa_saguaro_repair_manifest"] = str(output_path)
    bpy.ops.wm.save_as_mainfile(filepath=str(blend_path), compress=True)
    print(f"[saguaro repair] wrote {output_path}")
    print(f"[saguaro repair] wrote {blend_path}")


if __name__ == "__main__":
    try:
        main()
    except Exception:
        import traceback

        traceback.print_exc()
        sys.exit(1)
