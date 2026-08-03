"""Headless Blender audit for the exported ziggurat GLB."""

import json
import os
import re
import sys

import bpy
import bmesh


def main(path):
    bpy.ops.object.select_all(action='SELECT')
    bpy.ops.object.delete(use_global=False)
    bpy.ops.import_scene.gltf(filepath=path)

    report = {
        'asset': os.path.abspath(path),
        'meshes': 0,
        'raw_export_vertices': 0,
        'vertices': 0,
        'triangles': 0,
        'degenerate_faces': 0,
        'nonmanifold_edges': 0,
        'nonmanifold_edges_by_mesh': {},
        'nonpositive_signed_volume_meshes': [],
        'material_slots': {},
    }
    for obj in bpy.context.scene.objects:
        if obj.type != 'MESH':
            continue
        report['meshes'] += 1
        report['raw_export_vertices'] += len(obj.data.vertices)
        report['triangles'] += len(obj.data.polygons)
        report['material_slots'][obj.name] = [slot.material.name for slot in obj.material_slots if slot.material]
        bm = bmesh.new()
        bm.from_mesh(obj.data)
        # glTF duplicates coincident positions at hard-normal and UV seams.
        # Weld those import representations before asking topological questions
        # or every legitimate hard edge appears as a pair of boundary edges.
        bmesh.ops.remove_doubles(bm, verts=list(bm.verts), dist=1.0e-4)
        report['vertices'] += len(bm.verts)
        report['degenerate_faces'] += sum(face.calc_area() <= 1.0e-12 for face in bm.faces)
        nonmanifold_edges = sum(len(edge.link_faces) != 2 for edge in bm.edges)
        report['nonmanifold_edges'] += nonmanifold_edges
        if nonmanifold_edges:
            report['nonmanifold_edges_by_mesh'][obj.name] = nonmanifold_edges
        signed_volume = bm.calc_volume(signed=True)
        if signed_volume <= 1.0e-10:
            report['nonpositive_signed_volume_meshes'].append({
                'name': obj.name,
                'signed_volume': signed_volume,
            })
        bm.free()

    open_surfaces = report['nonmanifold_edges_by_mesh']
    documented_integrated_rails = (
        len(open_surfaces) == 8
        and all(
            re.fullmatch(r'stone_processional_rail_flight_\d{2}_(?:pos|neg)_x', name)
            and count == 24
            for name, count in open_surfaces.items()
        )
    )
    report['documented_user_rail_open_surfaces'] = documented_integrated_rails
    print(json.dumps(report, indent=2, sort_keys=True))
    unexpected_open_surfaces = bool(open_surfaces) and not documented_integrated_rails
    if (report['degenerate_faces'] or unexpected_open_surfaces
            or report['nonpositive_signed_volume_meshes']):
        raise SystemExit(2)


if __name__ == '__main__':
    args = sys.argv
    source = args[args.index('--') + 1] if '--' in args and len(args) > args.index('--') + 1 else None
    if not source:
        raise SystemExit('Usage: blender --background --python tools/audit-ziggurat-export.py -- path.glb')
    main(os.path.abspath(source))
