"""Read-only vertex delta analysis for the user-authored ziggurat handoff."""

import json
import math
import os
import sys

import bpy


TARGET_OBJECTS = (
    'scifi_dais_inset_metal_reveal',
    'scifi_inset_metal_panels',
    'stone_integrated_terrace_cornices',
    'stone_orb_dais',
    'stone_processional_staircase',
    'stone_rectilinear_tier_01',
    'stone_rectilinear_tier_02',
    'stone_rectilinear_tier_03',
    'stone_rectilinear_tier_04',
    'stone_summit_plinth',
    'tile_carnelian_inlays',
    'tile_lapis_inlays',
)


def rounded(values, digits=7):
    return [round(float(value), digits) for value in values]


def analyze_mesh(user_mesh, runtime_mesh):
    result = {
        'user_counts': {
            'vertices': len(user_mesh.vertices),
            'edges': len(user_mesh.edges),
            'polygons': len(user_mesh.polygons),
            'loops': len(user_mesh.loops),
        },
        'runtime_counts': {
            'vertices': len(runtime_mesh.vertices),
            'edges': len(runtime_mesh.edges),
            'polygons': len(runtime_mesh.polygons),
            'loops': len(runtime_mesh.loops),
        },
    }
    if len(user_mesh.vertices) != len(runtime_mesh.vertices):
        result['vertex_order_comparable'] = False
        return result

    deltas = []
    moved = []
    for index, (user_vertex, runtime_vertex) in enumerate(
        zip(user_mesh.vertices, runtime_mesh.vertices)
    ):
        delta = user_vertex.co - runtime_vertex.co
        length = delta.length
        deltas.append(length)
        if length > 1.0e-7:
            moved.append({
                'index': index,
                'runtime': rounded(runtime_vertex.co),
                'user': rounded(user_vertex.co),
                'delta': rounded(delta),
                'distance': round(length, 7),
            })

    unique = {}
    for item in moved:
        key = ','.join(f'{value:.7f}' for value in item['delta'])
        unique[key] = unique.get(key, 0) + 1
    result.update({
        'vertex_order_comparable': True,
        'moved_vertices': len(moved),
        'unchanged_vertices': len(user_mesh.vertices) - len(moved),
        'max_vertex_delta': round(max(deltas, default=0.0), 7),
        'rms_vertex_delta': round(
            math.sqrt(sum(value * value for value in deltas) / max(1, len(deltas))),
            7,
        ),
        'unique_delta_counts': dict(sorted(unique.items())),
        'moved_vertex_bounds_runtime': None,
        'moved_vertex_bounds_user': None,
        'moved_vertex_samples': moved[:64],
    })
    if moved:
        for key in ('runtime', 'user'):
            coords = [item[key] for item in moved]
            result[f'moved_vertex_bounds_{key}'] = [
                [min(row[axis] for row in coords) for axis in range(3)],
                [max(row[axis] for row in coords) for axis in range(3)],
            ]
    return result


def main(runtime_path, output_path):
    runtime_path = os.path.abspath(runtime_path)
    output_path = os.path.abspath(output_path)
    user_objects = {
        name: bpy.data.objects.get(name)
        for name in TARGET_OBJECTS
    }
    requested_mesh_names = [
        obj.data.name for obj in user_objects.values()
        if obj and obj.type == 'MESH'
    ]
    with bpy.data.libraries.load(runtime_path, link=False) as (source, target):
        available_names = list(source.meshes)
        available = set(available_names)
        load_names = [name for name in requested_mesh_names if name in available]
        source_names = tuple(load_names)
        target.meshes = load_names
    loaded_meshes = {
        source_name: mesh
        for source_name, mesh in zip(source_names, target.meshes)
        if mesh is not None
    }

    comparisons = {}
    for name, obj in user_objects.items():
        if not obj or obj.type != 'MESH':
            comparisons[name] = {'status': 'missing_user_object'}
            continue
        runtime_mesh = loaded_meshes.get(obj.data.name)
        if runtime_mesh is None:
            comparisons[name] = {
                'status': 'missing_runtime_mesh',
                'user_mesh': obj.data.name,
            }
            continue
        comparisons[name] = {
            'status': 'compared',
            'user_mesh': obj.data.name,
            'runtime_loaded_mesh': runtime_mesh.name,
            **analyze_mesh(obj.data, runtime_mesh),
        }

    report = {
        'user_source': os.path.abspath(bpy.data.filepath),
        'runtime_source': runtime_path,
        'runtime_available_meshes': available_names,
        'requested_runtime_meshes': requested_mesh_names,
        'loaded_runtime_meshes': {
            source_name: mesh.name if mesh else None
            for source_name, mesh in zip(source_names, target.meshes)
        },
        'comparisons': comparisons,
    }
    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    with open(output_path, 'w', encoding='utf-8') as handle:
        json.dump(report, handle, indent=2, sort_keys=True)
        handle.write('\n')
    print(output_path)


if __name__ == '__main__':
    args = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    if '--runtime' not in args or '--out' not in args:
        raise SystemExit('required: --runtime RUNTIME.blend --out REPORT.json')
    main(args[args.index('--runtime') + 1], args[args.index('--out') + 1])
