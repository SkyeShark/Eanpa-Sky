"""Read-only structural/geometry/normal/UV inventory for Eanpa Blend handoffs."""

import hashlib
import json
import math
import os
import struct
import sys

import bpy
import bmesh


def round_float(value, digits=7):
    value = float(value)
    return round(value, digits) if math.isfinite(value) else str(value)


def vector(value):
    return [round_float(component) for component in value]


def matrix(value):
    return [[round_float(component) for component in row] for row in value]


def safe_value(value):
    if isinstance(value, (str, int, bool)) or value is None:
        return value
    if isinstance(value, float):
        return round_float(value)
    try:
        return [safe_value(component) for component in value]
    except (TypeError, ValueError):
        return str(value)


def custom_properties(value):
    return {
        key: safe_value(value[key])
        for key in sorted(value.keys())
        if key != '_RNA_UI'
    }


def hash_float_rows(rows):
    digest = hashlib.sha256()
    for row in rows:
        for value in row:
            digest.update(struct.pack('<d', round(float(value), 7)))
    return digest.hexdigest()


def hash_integer_rows(rows):
    digest = hashlib.sha256()
    for row in rows:
        digest.update(struct.pack('<I', len(row)))
        for value in row:
            digest.update(struct.pack('<I', int(value)))
    return digest.hexdigest()


def uv_report(mesh, layer):
    data = layer.data
    digest = hashlib.sha256()
    finite = 0
    nonfinite = 0
    minimum = [float('inf'), float('inf')]
    maximum = [float('-inf'), float('-inf')]
    for loop in data:
        uv = loop.uv
        values = (float(uv.x), float(uv.y))
        for axis, value in enumerate(values):
            if math.isfinite(value):
                finite += 1
                minimum[axis] = min(minimum[axis], value)
                maximum[axis] = max(maximum[axis], value)
            else:
                nonfinite += 1
            digest.update(struct.pack('<d', round(value, 7)))

    zero_area_faces = 0
    uv_area_sum = 0.0
    density_samples = []
    for polygon in mesh.polygons:
        coords = [data[index].uv for index in polygon.loop_indices]
        twice_area = 0.0
        for index, current in enumerate(coords):
            following = coords[(index + 1) % len(coords)]
            twice_area += current.x * following.y - following.x * current.y
        uv_area = abs(twice_area) * 0.5
        uv_area_sum += uv_area
        if polygon.area > 1e-12 and uv_area <= 1e-12:
            zero_area_faces += 1
        elif polygon.area > 1e-12:
            density_samples.append(math.sqrt(uv_area / polygon.area))

    density_samples.sort()
    median_density = (
        density_samples[len(density_samples) // 2]
        if density_samples else 0.0
    )
    return {
        'name': layer.name,
        'loops': len(data),
        'hash': digest.hexdigest(),
        'nonfinite_components': nonfinite,
        'bounds': [vector(minimum), vector(maximum)] if finite else None,
        'uv_area_sum': round_float(uv_area_sum),
        'zero_area_faces': zero_area_faces,
        'median_uv_per_meter': round_float(median_density),
    }


def mesh_report(mesh):
    mesh.calc_loop_triangles()
    mesh.update()
    positions = [vertex.co[:] for vertex in mesh.vertices]
    faces = [tuple(polygon.vertices) for polygon in mesh.polygons]
    smooth_flags = [[1 if polygon.use_smooth else 0] for polygon in mesh.polygons]
    sharp_flags = [[1 if edge.use_edge_sharp else 0] for edge in mesh.edges]

    corner_normals = []
    try:
        corner_normals = [normal.vector[:] for normal in mesh.corner_normals]
    except (AttributeError, RuntimeError):
        corner_normals = []

    bm = bmesh.new()
    bm.from_mesh(mesh)
    degenerate = sum(face.calc_area() <= 1.0e-12 for face in bm.faces)
    nonmanifold = sum(len(edge.link_faces) != 2 for edge in bm.edges)
    signed_volume = bm.calc_volume(signed=True) if bm.faces else 0.0
    areas = sorted(float(face.calc_area()) for face in bm.faces)
    bm.free()

    minimum = [min((co[axis] for co in positions), default=0.0) for axis in range(3)]
    maximum = [max((co[axis] for co in positions), default=0.0) for axis in range(3)]
    attributes = [
        {'name': attribute.name, 'domain': attribute.domain, 'data_type': attribute.data_type}
        for attribute in mesh.attributes
    ]
    return {
        'name': mesh.name,
        'vertices': len(mesh.vertices),
        'edges': len(mesh.edges),
        'polygons': len(mesh.polygons),
        'loops': len(mesh.loops),
        'triangles': len(mesh.loop_triangles),
        'bounds': [vector(minimum), vector(maximum)],
        'position_hash': hash_float_rows(positions),
        'topology_hash': hash_integer_rows(faces),
        'smooth_hash': hash_integer_rows(smooth_flags),
        'sharp_hash': hash_integer_rows(sharp_flags),
        'corner_normal_hash': hash_float_rows(corner_normals) if corner_normals else None,
        'normals_domain': getattr(mesh, 'normals_domain', None),
        'attributes': attributes,
        'uv_layers': [uv_report(mesh, layer) for layer in mesh.uv_layers],
        'degenerate_faces': degenerate,
        'nonmanifold_edges': nonmanifold,
        'signed_volume': round_float(signed_volume),
        'face_area': {
            'min': round_float(areas[0]) if areas else 0.0,
            'median': round_float(areas[len(areas) // 2]) if areas else 0.0,
            'max': round_float(areas[-1]) if areas else 0.0,
        },
        'custom_properties': custom_properties(mesh),
    }


def material_report(material):
    images = []
    node_types = []
    if material.use_nodes and material.node_tree:
        for node in material.node_tree.nodes:
            node_types.append(node.bl_idname)
            image = getattr(node, 'image', None)
            if image:
                images.append(image.name)
    return {
        'name': material.name,
        'use_nodes': material.use_nodes,
        'blend_method': getattr(material, 'surface_render_method', None),
        'node_types': sorted(node_types),
        'images': sorted(set(images)),
        'custom_properties': custom_properties(material),
    }


def main(output_path=None):
    mesh_cache = {}
    objects = []
    for obj in sorted(bpy.data.objects, key=lambda item: item.name):
        mesh_key = None
        if obj.type == 'MESH' and obj.data:
            mesh_key = obj.data.name
            mesh_cache.setdefault(mesh_key, mesh_report(obj.data))
        objects.append({
            'name': obj.name,
            'type': obj.type,
            'data': mesh_key or getattr(getattr(obj, 'data', None), 'name', None),
            'parent': obj.parent.name if obj.parent else None,
            'collections': sorted(collection.name for collection in obj.users_collection),
            'matrix_world': matrix(obj.matrix_world),
            'dimensions': vector(obj.dimensions),
            'hide_render': obj.hide_render,
            'hide_viewport': obj.hide_viewport,
            'instance_collection': obj.instance_collection.name if obj.instance_collection else None,
            'materials': [
                slot.material.name if slot.material else None
                for slot in obj.material_slots
            ],
            'modifiers': [
                {'name': modifier.name, 'type': modifier.type, 'show_viewport': modifier.show_viewport,
                 'show_render': modifier.show_render}
                for modifier in obj.modifiers
            ],
            'custom_properties': custom_properties(obj),
        })

    source = os.path.abspath(bpy.data.filepath)
    with open(source, 'rb') as handle:
        file_hash = hashlib.sha256(handle.read()).hexdigest().upper()
    report = {
        'source': source,
        'bytes': os.path.getsize(source),
        'sha256': file_hash,
        'blender_version': bpy.app.version_string,
        'scene': bpy.context.scene.name,
        'scene_custom_properties': custom_properties(bpy.context.scene),
        'objects': objects,
        'meshes': mesh_cache,
        'materials': [material_report(material) for material in sorted(bpy.data.materials, key=lambda item: item.name)],
        'images': [
            {'name': image.name, 'filepath': image.filepath, 'packed': image.packed_file is not None}
            for image in sorted(bpy.data.images, key=lambda item: item.name)
        ],
        'collections': [
            {
                'name': collection.name,
                'objects': sorted(obj.name for obj in collection.objects),
                'children': sorted(child.name for child in collection.children),
            }
            for collection in sorted(bpy.data.collections, key=lambda item: item.name)
        ],
    }
    payload = json.dumps(report, indent=2, sort_keys=True)
    if output_path:
        output_path = os.path.abspath(output_path)
        os.makedirs(os.path.dirname(output_path), exist_ok=True)
        with open(output_path, 'w', encoding='utf-8') as handle:
            handle.write(payload + '\n')
        print(output_path)
    else:
        print(payload)


if __name__ == '__main__':
    arguments = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    output = None
    if '--out' in arguments and len(arguments) > arguments.index('--out') + 1:
        output = arguments[arguments.index('--out') + 1]
    main(output)
