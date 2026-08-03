#!/usr/bin/env python3
# Split the optimized 12-rock source and bake reusable three-level geometry LODs.

from __future__ import annotations

import hashlib
import json
import sys
import tempfile
from pathlib import Path

import bmesh
import bpy
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from cliff_glb_tools import repair_all_winding_copy


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / 'assets/terrain/Desert_rock_chunks_12_pieces.glb'
INPUT = ROOT / 'assets/terrain/Desert_rock_chunks_12_pieces_runtime_2k.glb'
OUTPUT = ROOT / 'assets/terrain/Desert_rock_chunks_12_pieces_runtime_2k_lods.glb'
MANIFEST = ROOT / 'assets/terrain/desert_rock_chunks_runtime_lods.json'
PIECE_COUNT = 12
LOD_RATIOS = (1.0, 0.32, 0.10)
LOD_PROJECTED_DIAMETER_PIXELS = (72.0, 18.0, 1.0)
PIECE_CLASSES = {
    'largeFlatWide': (2, 4, 8, 9),
    'mediumIrregular': (0, 5, 6, 7),
    'smallSmoothRound': (1, 10),
    'cliffFaceTallNarrow': (3, 11),
}
PIECE_DIAMETER_METRES = {
    'largeFlatWide': (2.0, 5.8),
    'mediumIrregular': (0.95, 2.75),
    'smallSmoothRound': (0.30, 0.80),
}
PIECE_LONG_AXIS_METRES = {'cliffFaceTallNarrow': (6.0, 14.0)}
WELD_SCALE = 1_000_000


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def reset_scene() -> None:
    bpy.ops.object.select_all(action='SELECT')
    bpy.ops.object.delete(use_global=False)
    for datablocks in (bpy.data.meshes, bpy.data.materials, bpy.data.images):
        for datablock in list(datablocks):
            if datablock.users == 0:
                datablocks.remove(datablock)


def activate(obj: bpy.types.Object) -> None:
    bpy.ops.object.select_all(action='DESELECT')
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj


def apply_modifier(obj: bpy.types.Object, modifier: bpy.types.Modifier) -> None:
    activate(obj)
    bpy.ops.object.modifier_apply(modifier=modifier.name)


def welded_component_faces(mesh: bpy.types.Mesh) -> list[list[int]]:
    keys = [
        tuple(round(component * WELD_SCALE) for component in vertex.co)
        for vertex in mesh.vertices
    ]
    parents: dict[tuple[int, int, int], tuple[int, int, int]] = {}

    def find(key: tuple[int, int, int]) -> tuple[int, int, int]:
        parents.setdefault(key, key)
        while parents[key] != key:
            parents[key] = parents[parents[key]]
            key = parents[key]
        return key

    def union(left: tuple[int, int, int], right: tuple[int, int, int]) -> None:
        left_root = find(left)
        right_root = find(right)
        if left_root != right_root:
            parents[right_root] = left_root

    for polygon in mesh.polygons:
        polygon_keys = [keys[index] for index in polygon.vertices]
        for key in polygon_keys[1:]:
            union(polygon_keys[0], key)
    groups: dict[tuple[int, int, int], list[int]] = {}
    for polygon in mesh.polygons:
        root = find(keys[polygon.vertices[0]])
        groups.setdefault(root, []).append(polygon.index)
    return list(groups.values())


def extract_component(
    source: bpy.types.Object,
    face_indices: list[int],
    component_index: int,
) -> bpy.types.Object:
    mesh = source.data.copy()
    obj = source.copy()
    obj.data = mesh
    obj.name = f'DesertRockComponent{component_index:02d}'
    mesh.name = f'DesertRockComponent{component_index:02d}_Mesh'
    bpy.context.collection.objects.link(obj)
    keep = set(face_indices)
    bm = bmesh.new()
    bm.from_mesh(mesh)
    bm.faces.ensure_lookup_table()
    bm.faces.index_update()
    remove_faces = [face for face in bm.faces if face.index not in keep]
    bmesh.ops.delete(bm, geom=remove_faces, context='FACES')
    loose_vertices = [vertex for vertex in bm.verts if not vertex.link_faces]
    if loose_vertices:
        bmesh.ops.delete(bm, geom=loose_vertices, context='VERTS')
    bm.to_mesh(mesh)
    bm.free()
    mesh.update(calc_edges=True)
    return obj


def bounds_for(obj: bpy.types.Object) -> tuple[np.ndarray, np.ndarray]:
    coordinates = np.asarray([vertex.co[:] for vertex in obj.data.vertices], dtype=np.float64)
    if len(coordinates) == 0:
        raise RuntimeError(f'{obj.name} contains no vertices')
    return coordinates.min(axis=0), coordinates.max(axis=0)


def center_on_bottom(obj: bpy.types.Object) -> dict:
    minimum, maximum = bounds_for(obj)
    source_center = (minimum + maximum) * 0.5
    # Blender imports glTF Y-up as Z-up. Center the two Blender horizontal
    # axes (X/Y) and place the Blender vertical minimum (Z) on the ground;
    # export_yup then produces a GLB centered in X/Z with exact Y=0 seating.
    offset = np.asarray((source_center[0], source_center[1], minimum[2]))
    for vertex in obj.data.vertices:
        vertex.co.x -= float(offset[0])
        vertex.co.y -= float(offset[1])
        vertex.co.z -= float(offset[2])
    obj.data.update(calc_edges=True)
    centered_minimum, centered_maximum = bounds_for(obj)
    return {
        'sourceCenter': source_center.tolist(),
        'sourceBoundsMin': minimum.tolist(),
        'sourceBoundsMax': maximum.tolist(),
        'centeredBoundsMin': centered_minimum.tolist(),
        'centeredBoundsMax': centered_maximum.tolist(),
        'dimensions': (maximum - minimum).tolist(),
        'bottomCenteredPivot': True,
    }


def bake_lod(
    source: bpy.types.Object,
    piece: int,
    lod: int,
    ratio: float,
) -> bpy.types.Object:
    obj = source.copy()
    obj.data = source.data.copy()
    obj.name = f'DesertRockPiece{piece:02d}_LOD{lod}'
    obj.data.name = f'DesertRockPiece{piece:02d}_LOD{lod}_Mesh'
    bpy.context.collection.objects.link(obj)
    if ratio < 0.999:
        modifier = obj.modifiers.new(f'LOD{lod}_decimation', 'DECIMATE')
        modifier.decimate_type = 'COLLAPSE'
        modifier.ratio = ratio
        modifier.use_collapse_triangulate = True
        apply_modifier(obj, modifier)
    triangulate = obj.modifiers.new('Deterministic_triangulation', 'TRIANGULATE')
    triangulate.quad_method = 'BEAUTY'
    triangulate.ngon_method = 'BEAUTY'
    apply_modifier(obj, triangulate)
    obj.data.update(calc_edges=True)
    obj['eanpaPiece'] = piece
    obj['eanpaLod'] = lod
    obj['eanpaReductionRatio'] = ratio
    obj['eanpaMinProjectedDiameterPixels'] = LOD_PROJECTED_DIAMETER_PIXELS[lod]
    obj['eanpaBottomCenteredPivot'] = True
    return obj


def mesh_metrics(obj: bpy.types.Object) -> dict:
    mesh = obj.data
    mesh.calc_loop_triangles()
    minimum, maximum = bounds_for(obj)
    return {
        'vertices': len(mesh.vertices),
        'triangles': len(mesh.loop_triangles),
        'uvLayers': len(mesh.uv_layers),
        'materialSlots': len(obj.material_slots),
        'boundsMin': minimum.tolist(),
        'boundsMax': maximum.tolist(),
    }


def import_combined_source(path: Path) -> bpy.types.Object:
    bpy.ops.import_scene.gltf(filepath=str(path))
    sources = [obj for obj in bpy.context.scene.objects if obj.type == 'MESH']
    if not sources:
        raise RuntimeError(f'{path.name} imported no meshes')
    materials = {
        slot.material
        for obj in sources
        for slot in obj.material_slots
        if slot.material is not None
    }
    if len(materials) != 1:
        raise RuntimeError(f'{path.name} must use exactly one shared baked material')
    material = next(iter(materials))
    for obj in sources:
        obj.data.transform(obj.matrix_world)
        obj.matrix_world.identity()
    activate(sources[0])
    for obj in sources[1:]:
        obj.select_set(True)
    if len(sources) > 1:
        bpy.ops.object.join()
    source = bpy.context.view_layer.objects.active
    source.data.materials.clear()
    source.data.materials.append(material)
    for polygon in source.data.polygons:
        polygon.material_index = 0
    source.data.update(calc_edges=True)
    return source


def build_library() -> dict:
    reset_scene()
    with tempfile.TemporaryDirectory(prefix='eanpa_desert_rocks_') as temp_dir:
        temp_root = Path(temp_dir)
        repaired_input = temp_root / INPUT.name
        input_winding_repairs = repair_all_winding_copy(INPUT, repaired_input)
        source = import_combined_source(repaired_input)
        component_faces = welded_component_faces(source.data)
        if len(component_faces) != PIECE_COUNT:
            raise RuntimeError(
                f'{SOURCE.name} contains {len(component_faces)} welded components, '
                f'expected {PIECE_COUNT}'
            )
        raw_components = []
        for index, face_indices in enumerate(component_faces):
            obj = extract_component(source, face_indices, index)
            minimum, maximum = bounds_for(obj)
            center = (minimum + maximum) * 0.5
            raw_components.append((center, obj))
        bpy.data.objects.remove(source, do_unlink=True)
        raw_components.sort(
            key=lambda item: tuple(round(float(value), 6) for value in item[0])
        )

        lod_objects = []
        piece_reports = []
        for piece, (_, component) in enumerate(raw_components):
            component.name = f'DesertRockPiece{piece:02d}_Source'
            source_metrics = center_on_bottom(component)
            levels = []
            for lod, ratio in enumerate(LOD_RATIOS):
                obj = bake_lod(component, piece, lod, ratio)
                metrics = mesh_metrics(obj)
                if metrics['uvLayers'] < 1 or metrics['materialSlots'] != 1:
                    raise RuntimeError(f'{obj.name} lost UVs or its baked material')
                lod_objects.append(obj)
                levels.append({'lod': lod, 'ratio': ratio, **metrics})
            piece_reports.append({
                'piece': piece,
                **source_metrics,
                'lods': levels,
            })
            bpy.data.objects.remove(component, do_unlink=True)

        bpy.ops.object.select_all(action='DESELECT')
        for obj in lod_objects:
            obj.select_set(True)
        bpy.context.view_layer.objects.active = lod_objects[0]
        bpy.ops.export_scene.gltf(
            filepath=str(OUTPUT),
            export_format='GLB',
            use_selection=True,
            export_apply=True,
            export_yup=True,
            export_normals=True,
            export_texcoords=True,
            export_attributes=True,
            export_extras=True,
            export_materials='EXPORT',
            export_image_format='AUTO',
        )
        repaired_output = temp_root / OUTPUT.name
        lod_winding_repairs = repair_all_winding_copy(OUTPUT, repaired_output)
        repaired_output.replace(OUTPUT)

    return {
        'master': SOURCE.relative_to(ROOT).as_posix(),
        'masterSha256': sha256(SOURCE),
        'masterBytes': SOURCE.stat().st_size,
        'optimizedSource': INPUT.relative_to(ROOT).as_posix(),
        'optimizedSourceSha256': sha256(INPUT),
        'runtime': OUTPUT.relative_to(ROOT).as_posix(),
        'runtimeSha256': sha256(OUTPUT),
        'runtimeBytes': OUTPUT.stat().st_size,
        'sourceConnectedComponents': len(component_faces),
        'pieceCount': len(piece_reports),
        'inputWindingRepairs': input_winding_repairs,
        'lodWindingRepairs': lod_winding_repairs,
        'pieces': piece_reports,
    }


def main() -> None:
    report = build_library()
    triangles_by_lod = [
        sum(piece['lods'][lod]['triangles'] for piece in report['pieces'])
        for lod in range(len(LOD_RATIOS))
    ]
    manifest = {
        'schema': 'eanpa-desert-rock-chunks-instanced-lods-v4',
        'blenderVersion': bpy.app.version_string,
        'lodRatios': list(LOD_RATIOS),
        'lodProjectedDiameterPixels': list(LOD_PROJECTED_DIAMETER_PIXELS),
        'subpixelCullDiameterPixels': LOD_PROJECTED_DIAMETER_PIXELS[-1],
        'pieceClasses': {
            key: list(pieces) for key, pieces in PIECE_CLASSES.items()
        },
        'pieceDiameterMetres': {
            key: list(size_range)
            for key, size_range in PIECE_DIAMETER_METRES.items()
        },
        'pieceLongAxisMetres': {
            key: list(size_range)
            for key, size_range in PIECE_LONG_AXIS_METRES.items()
        },
        'textureMaximum': 2048,
        'decodedTextureMemoryMiB': 48,
        'originalUntouched': True,
        'trianglesByLod': triangles_by_lod,
        'asset': report,
    }
    MANIFEST.write_text(json.dumps(manifest, indent=2) + chr(10), encoding='utf8')
    print(json.dumps(manifest, indent=2))


if __name__ == '__main__':
    main()
