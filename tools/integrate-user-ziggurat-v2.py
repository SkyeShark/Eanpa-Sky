"""Integrate the authoritative user ziggurat edit without touching its source.

This processor is intentionally allowlist-driven. It opens the preserved user
scene, retains authored geometry/transforms/normals, repairs UVs only on the
eight new rail pieces, adds Metal010 flush trim and shifted panel fasteners,
then writes versioned editable/runtime handoffs and a machine-readable audit.
"""

import argparse
import hashlib
import json
import math
import os
import struct
import sys

import bpy
import bmesh
from mathutils import Matrix, Vector


PROJECT_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
METAL_ROOT = os.path.join(
    PROJECT_ROOT, 'assets', 'temple', 'materials', 'ambientcg_metal010',
)
FASTENER_IMAGE = os.path.join(
    PROJECT_ROOT, 'assets', 'temple', 'decals', 'panel_fastener_decal-v1.png',
)
FASTENER_MESH = 'inset_scifi_front_01_00_corner_fastener_decal_-1_-1_mesh'

USER_STAIR_WIDTH = 15.5030928
UV_REPEATS_PER_METER = 0.62
PANEL_LEFT_SHIFT = -0.2402391
PANEL_RIGHT_SHIFT = 0.2852621
FASTENER_SUPPORT_SIZE_M = 0.235
FASTENER_VISIBLE_DIAMETER_M = 0.090
FASTENER_CHAMFER_CLEARANCE_M = 0.015
FASTENER_NORMAL_STRENGTH = 0.34

# The first authored flight is the long approach pair; the remaining three
# pairs follow toward the summit. pos_x/neg_x avoids camera-relative labels.
USER_RAILS = (
    ('Cube.075', 1, 'pos_x'),
    ('Cube.076', 1, 'neg_x'),
    ('Cube', 2, 'pos_x'),
    ('Cube.070', 2, 'neg_x'),
    ('Cube.071', 3, 'pos_x'),
    ('Cube.072', 3, 'neg_x'),
    ('Cube.073', 4, 'pos_x'),
    ('Cube.074', 4, 'neg_x'),
)

FORBIDDEN_REGENERATED_OBJECTS = (
    'stone_processional_retaining_walls',
    'scifi_processional_cheek_insets',
)


def sha256_file(path):
    digest = hashlib.sha256()
    with open(path, 'rb') as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest().upper()


def rounded(value, digits=7):
    return round(float(value), digits)


def matrix_values(value):
    return [[rounded(component) for component in row] for row in value]



def matrix_max_abs_delta(left, right):
    return max(
        abs(float(left[row][column]) - float(right[row][column]))
        for row in range(4)
        for column in range(4)
    )


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


def mesh_fingerprint(mesh, include_uv=True):
    positions = [vertex.co[:] for vertex in mesh.vertices]
    faces = [tuple(polygon.vertices) for polygon in mesh.polygons]
    try:
        normals = [item.vector[:] for item in mesh.corner_normals]
    except (AttributeError, RuntimeError):
        normals = []
    payload = {
        'vertices': len(mesh.vertices),
        'edges': len(mesh.edges),
        'polygons': len(mesh.polygons),
        'position_hash': hash_float_rows(positions),
        'topology_hash': hash_integer_rows(faces),
        'corner_normal_hash': hash_float_rows(normals) if normals else None,
    }
    if include_uv:
        payload['uv'] = {
            layer.name: hash_float_rows([loop.uv[:] for loop in layer.data])
            for layer in mesh.uv_layers
        }
    return payload


def object_fingerprint(obj):
    return {
        'type': obj.type,
        'data': getattr(getattr(obj, 'data', None), 'name', None),
        'parent': obj.parent.name if obj.parent else None,
        'collections': sorted(collection.name for collection in obj.users_collection),
        'matrix_world': matrix_values(obj.matrix_world),
        'dimensions': [rounded(value) for value in obj.dimensions],
        'materials': [
            slot.material.name if slot.material else None
            for slot in obj.material_slots
        ],
        'mesh': mesh_fingerprint(obj.data) if obj.type == 'MESH' else None,
    }


def ensure_collection(name):
    collection = bpy.data.collections.get(name)
    if collection is None:
        collection = bpy.data.collections.new(name)
        bpy.context.scene.collection.children.link(collection)
    return collection


def move_to_collection(obj, target):
    if target not in obj.users_collection:
        target.objects.link(obj)
    for collection in list(obj.users_collection):
        if collection != target:
            collection.objects.unlink(obj)


def parent_preserving_world(obj, parent):
    world = obj.matrix_world.copy()
    obj.parent = parent
    obj.matrix_world = world


def image_node(nodes, links, vector, path, label, color_space):
    if not os.path.isfile(path):
        raise FileNotFoundError(path)
    image = bpy.data.images.load(path, check_existing=True)
    image.colorspace_settings.name = color_space
    node = nodes.new('ShaderNodeTexImage')
    node.name = label
    node.label = label
    node.image = image
    node.extension = 'REPEAT'
    node.projection = 'BOX'
    node.projection_blend = 0.16
    links.new(vector, node.inputs['Vector'])
    return node


def calibrated_channel(nodes, links, source, scale, bias, low, high, label):
    separate = nodes.new('ShaderNodeSeparateColor')
    separate.name = f'{label} separate R'
    links.new(source, separate.inputs['Color'])
    multiply_add = nodes.new('ShaderNodeMath')
    multiply_add.name = f'{label} scale+bias'
    multiply_add.operation = 'MULTIPLY_ADD'
    multiply_add.inputs[1].default_value = scale
    multiply_add.inputs[2].default_value = bias
    links.new(separate.outputs['Red'], multiply_add.inputs[0])
    lower = nodes.new('ShaderNodeMath')
    lower.name = f'{label} lower clamp'
    lower.operation = 'MAXIMUM'
    lower.inputs[1].default_value = low
    links.new(multiply_add.outputs[0], lower.inputs[0])
    upper = nodes.new('ShaderNodeMath')
    upper.name = f'{label} upper clamp'
    upper.operation = 'MINIMUM'
    upper.inputs[1].default_value = high
    links.new(lower.outputs[0], upper.inputs[0])
    return upper.outputs[0]


def rebuild_metal010_material():
    material = bpy.data.materials.get('SciFiMetal')
    if material is None:
        material = bpy.data.materials.new('SciFiMetal')
    material.use_nodes = True
    material.diffuse_color = (0.14, 0.19, 0.23, 1.0)
    material['pbr_source'] = 'ambientCG Metal010 1K JPG (CC0)'
    material['channel_contract'] = 'separate Color, NormalGL, Roughness, Metalness'
    material['runtime_role'] = 'dark panels; object-name overrides select satin rail/burnished dais'
    material['calibration'] = 'rough=.65x+.484 clamp .70-.94; metal=.23x+.55 clamp .55-.78'
    nodes = material.node_tree.nodes
    links = material.node_tree.links
    nodes.clear()
    output = nodes.new('ShaderNodeOutputMaterial')
    principled = nodes.new('ShaderNodeBsdfPrincipled')
    principled.inputs['Base Color'].default_value = (0.14, 0.19, 0.23, 1.0)
    principled.inputs['Roughness'].default_value = 0.80
    principled.inputs['Metallic'].default_value = 0.72
    if 'Coat Weight' in principled.inputs:
        principled.inputs['Coat Weight'].default_value = 0.015
    if 'Coat Roughness' in principled.inputs:
        principled.inputs['Coat Roughness'].default_value = 0.62
    links.new(principled.outputs['BSDF'], output.inputs['Surface'])

    texcoord = nodes.new('ShaderNodeTexCoord')
    mapping = nodes.new('ShaderNodeMapping')
    mapping.name = 'real-metre object projection 0.62 per m'
    mapping.inputs['Scale'].default_value = (
        UV_REPEATS_PER_METER,
        UV_REPEATS_PER_METER,
        UV_REPEATS_PER_METER,
    )
    links.new(texcoord.outputs['Object'], mapping.inputs['Vector'])
    color = image_node(
        nodes, links, mapping.outputs['Vector'],
        os.path.join(METAL_ROOT, 'Metal010_1K-JPG_Color.jpg'),
        'ambientCG Metal010 Color', 'sRGB',
    )
    normal = image_node(
        nodes, links, mapping.outputs['Vector'],
        os.path.join(METAL_ROOT, 'Metal010_1K-JPG_NormalGL.jpg'),
        'ambientCG Metal010 NormalGL', 'Non-Color',
    )
    roughness = image_node(
        nodes, links, mapping.outputs['Vector'],
        os.path.join(METAL_ROOT, 'Metal010_1K-JPG_Roughness.jpg'),
        'ambientCG Metal010 Roughness', 'Non-Color',
    )
    metalness = image_node(
        nodes, links, mapping.outputs['Vector'],
        os.path.join(METAL_ROOT, 'Metal010_1K-JPG_Metalness.jpg'),
        'ambientCG Metal010 Metalness', 'Non-Color',
    )
    normal_map = nodes.new('ShaderNodeNormalMap')
    normal_map.inputs['Strength'].default_value = 0.56
    links.new(color.outputs['Color'], principled.inputs['Base Color'])
    links.new(normal.outputs['Color'], normal_map.inputs['Color'])
    links.new(normal_map.outputs['Normal'], principled.inputs['Normal'])
    links.new(
        calibrated_channel(
            nodes, links, roughness.outputs['Color'],
            0.65, 0.484, 0.70, 0.94, 'panel roughness',
        ),
        principled.inputs['Roughness'],
    )
    links.new(
        calibrated_channel(
            nodes, links, metalness.outputs['Color'],
            0.23, 0.55, 0.55, 0.78, 'panel metalness',
        ),
        principled.inputs['Metallic'],
    )
    return material


def rebuild_fastener_material():
    material = bpy.data.materials.get('FastenerDecal')
    if material is None:
        material = bpy.data.materials.new('FastenerDecal')
    material.use_nodes = True
    material.diffuse_color = (0.32, 0.34, 0.35, 1.0)
    material['generated_asset'] = 'assets/temple/decals/panel_fastener_decal-v1.png'
    material['treatment'] = 'alpha decal on a near-flush closed support plate with Metal010 normal response'
    material['pbr_source'] = 'ImageGen recessed fastener RGBA + ambientCG Metal010 NormalGL (CC0)'
    material['normal_map'] = True
    material['normal_map_source'] = 'ambientCG Metal010_1K-JPG_NormalGL.jpg (CC0)'
    material['normal_projection'] = 'authored FastenerDecalUV'
    nodes = material.node_tree.nodes
    links = material.node_tree.links
    nodes.clear()
    output = nodes.new('ShaderNodeOutputMaterial')
    principled = nodes.new('ShaderNodeBsdfPrincipled')
    principled.inputs['Roughness'].default_value = 0.48
    principled.inputs['Metallic'].default_value = 0.78
    links.new(principled.outputs['BSDF'], output.inputs['Surface'])
    texcoord = nodes.new('ShaderNodeTexCoord')
    image = bpy.data.images.load(FASTENER_IMAGE, check_existing=True)
    image.colorspace_settings.name = 'sRGB'
    image.alpha_mode = 'STRAIGHT'
    texture = nodes.new('ShaderNodeTexImage')
    texture.name = 'Generated recessed fastener RGBA'
    texture.image = image
    texture.extension = 'CLIP'
    links.new(texcoord.outputs['UV'], texture.inputs['Vector'])
    links.new(texture.outputs['Color'], principled.inputs['Base Color'])
    links.new(texture.outputs['Alpha'], principled.inputs['Alpha'])
    normal = image_node(
        nodes, links, texcoord.outputs['UV'],
        os.path.join(METAL_ROOT, 'Metal010_1K-JPG_NormalGL.jpg'),
        'ambientCG Metal010 NormalGL fastener micro-normal', 'Non-Color',
    )
    normal_map = nodes.new('ShaderNodeNormalMap')
    normal_map.name = 'Fastener Metal010 normal response'
    normal_map.inputs['Strength'].default_value = FASTENER_NORMAL_STRENGTH
    links.new(normal.outputs['Color'], normal_map.inputs['Color'])
    links.new(normal_map.outputs['Normal'], principled.inputs['Normal'])
    if hasattr(material, 'surface_render_method'):
        material.surface_render_method = 'DITHERED'
    elif hasattr(material, 'blend_method'):
        material.blend_method = 'CLIP'
    material.alpha_threshold = 0.10
    return material


def repair_world_box_uv(obj, repeats_per_meter=UV_REPEATS_PER_METER):
    mesh = obj.data
    layer = mesh.uv_layers.get('UVMap') or mesh.uv_layers.new(name='UVMap')
    inverse_transpose = obj.matrix_world.to_3x3().inverted().transposed()
    for polygon in mesh.polygons:
        world_normal = (inverse_transpose @ polygon.normal).normalized()
        axis = max(range(3), key=lambda index: abs(world_normal[index]))
        for loop_index in polygon.loop_indices:
            vertex = mesh.vertices[mesh.loops[loop_index].vertex_index]
            world = obj.matrix_world @ vertex.co
            if axis == 0:
                uv = (world.y, world.z)
            elif axis == 1:
                uv = (world.x, world.z)
            else:
                uv = (world.x, world.y)
            layer.data[loop_index].uv = (
                uv[0] * repeats_per_meter,
                uv[1] * repeats_per_meter,
            )
    return layer


def make_trim_for_rail(rail, name, material, parent, collection):
    bounds_min = Vector((
        min(vertex.co.x for vertex in rail.data.vertices),
        min(vertex.co.y for vertex in rail.data.vertices),
        min(vertex.co.z for vertex in rail.data.vertices),
    ))
    bounds_max = Vector((
        max(vertex.co.x for vertex in rail.data.vertices),
        max(vertex.co.y for vertex in rail.data.vertices),
        max(vertex.co.z for vertex in rail.data.vertices),
    ))
    half_width = min((bounds_max.x - bounds_min.x) * 0.22, 0.11)
    center_x = (bounds_min.x + bounds_max.x) * 0.5
    pad_y = min(0.18, (bounds_max.y - bounds_min.y) * 0.04)
    low_y = bounds_min.y + pad_y
    high_y = bounds_max.y - pad_y
    high_z = bounds_max.z + 0.018
    low_z = high_z - 0.065
    low_x = center_x - half_width
    high_x = center_x + half_width
    vertices = [
        (low_x, low_y, low_z), (high_x, low_y, low_z),
        (high_x, high_y, low_z), (low_x, high_y, low_z),
        (low_x, low_y, high_z), (high_x, low_y, high_z),
        (high_x, high_y, high_z), (low_x, high_y, high_z),
    ]
    faces = [
        (0, 3, 2, 1), (4, 5, 6, 7),
        (0, 1, 5, 4), (1, 2, 6, 5),
        (2, 3, 7, 6), (3, 0, 4, 7),
    ]
    mesh = bpy.data.meshes.new(name + '_mesh')
    mesh.from_pydata(vertices, [], faces)
    mesh.validate()
    mesh.update()
    trim = bpy.data.objects.new(name, mesh)
    collection.objects.link(trim)
    trim.matrix_world = rail.matrix_world.copy()
    parent_preserving_world(trim, parent)
    trim.data.materials.append(material)
    bevel = trim.modifiers.new('flush_trim_edge_softening', 'BEVEL')
    bevel.width = 0.018
    bevel.segments = 3
    bevel.limit_method = 'ANGLE'
    bevel.angle_limit = math.radians(24)
    bevel.harden_normals = True
    bpy.context.view_layer.objects.active = trim
    trim.select_set(True)
    bpy.ops.object.modifier_apply(modifier=bevel.name)
    trim.select_set(False)
    for polygon in trim.data.polygons:
        polygon.use_smooth = False
    repair_world_box_uv(trim)
    trim['generated_from_user_object'] = rail.name
    trim['pbr_source'] = 'ambientCG Metal010 1K JPG (CC0)'
    trim['trim_style'] = 'flush inset; 18 mm local proud; 47 mm local embed'
    trim['uv_repeats_per_meter'] = UV_REPEATS_PER_METER
    return trim


def append_shifted_fasteners(runtime_blend, material, parent, collection):
    with bpy.data.libraries.load(runtime_blend, link=False) as (source, target):
        if FASTENER_MESH not in source.meshes:
            raise RuntimeError(f'Missing canonical fastener mesh {FASTENER_MESH}')
        target.meshes = [FASTENER_MESH]
    mesh = target.meshes[0]
    if mesh is None:
        raise RuntimeError('Failed to append canonical fastener mesh')
    reference_contract = {
        'fastener_revision': 'corner_v2',
        'support_plate_size_m': FASTENER_SUPPORT_SIZE_M,
        'visual_fastener_diameter_m': FASTENER_VISIBLE_DIAMETER_M,
        'chamfer_clearance_m': FASTENER_CHAMFER_CLEARANCE_M,
    }
    for key, expected in reference_contract.items():
        actual = mesh.get(key)
        matches = actual == expected if isinstance(expected, str) else (
            isinstance(actual, (int, float))
            and math.isclose(float(actual), expected, abs_tol=1.0e-7)
        )
        if not matches:
            raise RuntimeError(
                f'Runtime reference fastener contract mismatch {key}: '
                f'{actual!r} != {expected!r}'
            )
    mesh.name = FASTENER_MESH + '_integrated_v2'
    mesh.materials.clear()
    mesh.materials.append(material)
    shifted_left = 0
    shifted_right = 0
    for vertex in mesh.vertices:
        x, y, z = vertex.co
        upper_front = -9.18 <= y <= -8.93 and 18.70 <= z <= 20.02
        shifted_panel_span = 7.2 <= abs(x) <= 11.3
        if not upper_front or not shifted_panel_span:
            continue
        if x < 0:
            vertex.co.x += PANEL_LEFT_SHIFT
            shifted_left += 1
        else:
            vertex.co.x += PANEL_RIGHT_SHIFT
            shifted_right += 1
    mesh.update()
    obj = bpy.data.objects.new('scifi_panel_corner_fasteners', mesh)
    collection.objects.link(obj)
    obj.parent = parent
    obj['generated_asset'] = 'panel_fastener_decal-v1.png'
    obj['surface_proud_m'] = 0.005
    obj['fastener_revision'] = 'corner_v2'
    obj['support_plate_size_m'] = FASTENER_SUPPORT_SIZE_M
    obj['visual_fastener_diameter_m'] = FASTENER_VISIBLE_DIAMETER_M
    obj['chamfer_clearance_m'] = FASTENER_CHAMFER_CLEARANCE_M
    obj['normal_map'] = True
    obj['normal_map_source'] = 'ambientCG Metal010 NormalGL (CC0)'
    obj['integrated_against_user_panel_offsets'] = True
    return obj, shifted_left, shifted_right


def mesh_components(mesh):
    adjacency = [set() for _ in mesh.vertices]
    for edge in mesh.edges:
        a, b = edge.vertices
        adjacency[a].add(b)
        adjacency[b].add(a)
    seen = set()
    components = []
    for start in range(len(mesh.vertices)):
        if start in seen:
            continue
        component = []
        stack = [start]
        seen.add(start)
        while stack:
            current = stack.pop()
            component.append(current)
            for neighbour in adjacency[current]:
                if neighbour not in seen:
                    seen.add(neighbour)
                    stack.append(neighbour)
        components.append(component)
    return components


def connected_components(mesh):
    return len(mesh_components(mesh))


def component_bounds(obj):
    records = []
    matrix = obj.matrix_world
    for component in mesh_components(obj.data):
        points = [matrix @ obj.data.vertices[index].co for index in component]
        minimum = [min(point[axis] for point in points) for axis in range(3)]
        maximum = [max(point[axis] for point in points) for axis in range(3)]
        size = [maximum[axis] - minimum[axis] for axis in range(3)]
        center = [(minimum[axis] + maximum[axis]) * 0.5 for axis in range(3)]
        shallow_axis = min(range(3), key=lambda axis: size[axis])
        if shallow_axis == 2:
            raise RuntimeError(
                f'Unexpected horizontal panel component in {obj.name}: {size}'
            )
        records.append({
            'minimum': minimum,
            'maximum': maximum,
            'size': size,
            'center': center,
            'shallow_axis': shallow_axis,
            'tangent_axis': 1 if shallow_axis == 0 else 0,
        })
    return records


def measure_fastener_geometry(fasteners, panels):
    panel_records = component_bounds(panels)
    fastener_records = component_bounds(fasteners)
    horizontal_insets = []
    vertical_insets = []
    support_widths = []
    support_heights = []
    normal_offsets = []
    panel_counts = [0] * len(panel_records)

    for fastener in fastener_records:
        tangent = fastener['tangent_axis']
        normal = fastener['shallow_axis']
        vertical = 2
        center = fastener['center']
        candidates = []
        for index, panel in enumerate(panel_records):
            if panel['shallow_axis'] != normal:
                continue
            within_tangent = (
                panel['minimum'][tangent] - 1.0e-4
                <= center[tangent]
                <= panel['maximum'][tangent] + 1.0e-4
            )
            within_vertical = (
                panel['minimum'][vertical] - 1.0e-4
                <= center[vertical]
                <= panel['maximum'][vertical] + 1.0e-4
            )
            if not within_tangent or not within_vertical:
                continue
            normal_offset = abs(center[normal] - panel['center'][normal])
            candidates.append((normal_offset, index, panel))
        if not candidates:
            raise RuntimeError(
                f'Fastener component at {center} does not lie in any actual panel bounds'
            )
        normal_offset, panel_index, panel = min(candidates, key=lambda item: item[0])
        panel_counts[panel_index] += 1
        normal_offsets.append(normal_offset)
        support_widths.append(fastener['size'][tangent])
        support_heights.append(fastener['size'][vertical])
        horizontal_insets.append(min(
            center[tangent] - panel['minimum'][tangent],
            panel['maximum'][tangent] - center[tangent],
        ))
        vertical_insets.append(min(
            center[vertical] - panel['minimum'][vertical],
            panel['maximum'][vertical] - center[vertical],
        ))

    if any(count != 4 for count in panel_counts):
        raise RuntimeError(
            f'Expected exactly four corner fasteners inside each actual panel: {panel_counts}'
        )

    value_range = lambda values: {
        'min': rounded(min(values), 6),
        'max': rounded(max(values), 6),
    }
    return {
        'host_panel_components': len(panel_records),
        'fastener_components': len(fastener_records),
        'all_fasteners_matched_to_actual_panel_bounds': True,
        'fasteners_per_panel': 4,
        'support_tangent_width_m': value_range(support_widths),
        'support_vertical_height_m': value_range(support_heights),
        'corner_center_horizontal_inset_m': value_range(horizontal_insets),
        'corner_center_vertical_inset_m': value_range(vertical_insets),
        'max_host_plane_center_offset_m': rounded(max(normal_offsets), 6),
        'visible_decal_diameter_m': FASTENER_VISIBLE_DIAMETER_M,
        'chamfer_line_clearance_m': FASTENER_CHAMFER_CLEARANCE_M,
    }


def architecture_audit(root):
    audit = {
        'meshes': 0,
        'vertices': 0,
        'triangles': 0,
        'degenerate_faces': 0,
        'nonmanifold_edges': 0,
    }
    for obj in root.children_recursive:
        if obj.type != 'MESH':
            continue
        mesh = obj.data
        mesh.calc_loop_triangles()
        audit['meshes'] += 1
        audit['vertices'] += len(mesh.vertices)
        audit['triangles'] += len(mesh.loop_triangles)
        bm = bmesh.new()
        bm.from_mesh(mesh)
        audit['degenerate_faces'] += sum(
            face.calc_area() <= 1.0e-12 for face in bm.faces
        )
        audit['nonmanifold_edges'] += sum(
            len(edge.link_faces) != 2 for edge in bm.edges
        )
        bm.free()
    return audit


def scalar_material(name, color, roughness, metallic):
    material = bpy.data.materials.new(name)
    material.use_nodes = True
    material.diffuse_color = (*color, 1.0)
    principled = material.node_tree.nodes.get('Principled BSDF')
    principled.inputs['Base Color'].default_value = (*color, 1.0)
    principled.inputs['Roughness'].default_value = roughness
    principled.inputs['Metallic'].default_value = metallic
    material['runtime_payload'] = 'scalar name-preserving slot; PBR loaded externally'
    return material


def export_runtime_glb(root, output_path):
    sources = {
        name: bpy.data.materials.get(name)
        for name in ('SandstonePBR', 'LapisPBR', 'CarnelianPBR', 'SciFiMetal', 'FastenerDecal')
    }
    missing = [name for name, material in sources.items() if material is None]
    if missing:
        raise RuntimeError(f'Missing export materials: {missing}')
    specs = {
        'SandstonePBR': ((0.54, 0.38, 0.23), 0.86, 0.0),
        'LapisPBR': ((0.018, 0.085, 0.31), 0.20, 0.05),
        'CarnelianPBR': ((0.55, 0.055, 0.018), 0.24, 0.02),
        'SciFiMetal': ((0.14, 0.19, 0.23), 0.80, 0.72),
        'FastenerDecal': ((0.32, 0.34, 0.35), 0.48, 0.78),
    }
    placeholders = {}
    pointer_to_placeholder = {}
    for name, source in sources.items():
        source.name = name + '__EDITABLE_SOURCE'
        color, roughness, metallic = specs[name]
        placeholder = scalar_material(name, color, roughness, metallic)
        placeholders[name] = placeholder
        pointer_to_placeholder[source.as_pointer()] = placeholder

    selected_objects = [root, *root.children_recursive]
    restored = []
    for obj in selected_objects:
        if obj.type != 'MESH':
            continue
        for slot in obj.material_slots:
            source = slot.material
            if source is None:
                continue
            replacement = pointer_to_placeholder.get(source.as_pointer())
            if replacement is not None:
                restored.append((slot, source))
                slot.material = replacement

    bpy.ops.object.select_all(action='DESELECT')
    for obj in selected_objects:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = root
    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    try:
        bpy.ops.export_scene.gltf(
            filepath=output_path,
            export_format='GLB',
            use_selection=True,
            export_yup=True,
            export_apply=True,
            export_materials='EXPORT',
            export_normals=True,
            export_cameras=False,
            export_lights=False,
            export_extras=True,
        )
    finally:
        for slot, source in restored:
            slot.material = source
        for placeholder in placeholders.values():
            bpy.data.materials.remove(placeholder)
        for name, source in sources.items():
            source.name = name


def save_architecture_sources(root, versioned_path, canonical_path):
    keep = {root, *root.children_recursive}
    for obj in list(bpy.data.objects):
        if obj not in keep:
            bpy.data.objects.remove(obj, do_unlink=True)
    for collection in list(bpy.data.collections):
        if not collection.objects and not collection.children:
            bpy.data.collections.remove(collection)
    try:
        bpy.ops.outliner.orphans_purge(
            do_local_ids=True, do_linked_ids=True, do_recursive=True,
        )
    except (RuntimeError, TypeError):
        pass
    bpy.ops.file.pack_all()
    os.makedirs(os.path.dirname(versioned_path), exist_ok=True)
    bpy.ops.wm.save_as_mainfile(filepath=versioned_path)
    bpy.ops.wm.save_as_mainfile(filepath=canonical_path)


def parse_args(argv):
    parser = argparse.ArgumentParser()
    parser.add_argument('--expected-sha256', required=True)
    parser.add_argument('--runtime-reference', required=True)
    parser.add_argument('--out-area', required=True)
    parser.add_argument('--out-glb', required=True)
    parser.add_argument('--out-architecture-blend', required=True)
    parser.add_argument('--out-canonical-architecture-blend', required=True)
    parser.add_argument('--report', required=True)
    return parser.parse_args(argv)


def main(args):
    source_path = os.path.abspath(bpy.data.filepath)
    runtime_reference = os.path.abspath(args.runtime_reference)
    output_paths = {
        'area': os.path.abspath(args.out_area),
        'glb': os.path.abspath(args.out_glb),
        'architecture_blend': os.path.abspath(args.out_architecture_blend),
        'canonical_architecture_blend': os.path.abspath(args.out_canonical_architecture_blend),
        'report': os.path.abspath(args.report),
    }
    source_hash = sha256_file(source_path)
    expected_hash = args.expected_sha256.upper()
    if source_hash != expected_hash:
        raise RuntimeError(f'Authoritative source hash mismatch: {source_hash} != {expected_hash}')
    for label, path in output_paths.items():
        if path == source_path:
            raise RuntimeError(f'Refusing to overwrite user source via {label}: {path}')

    root = bpy.data.objects.get('ziggurat_architecture_root')
    if root is None:
        raise RuntimeError('Missing ziggurat_architecture_root')
    for forbidden in FORBIDDEN_REGENERATED_OBJECTS:
        if bpy.data.objects.get(forbidden) is not None:
            raise RuntimeError(f'User authority unexpectedly contains forbidden generated object {forbidden}')
    if bpy.data.objects.get('scifi_panel_corner_fasteners') is not None:
        raise RuntimeError('User authority already contains scifi_panel_corner_fasteners')

    allowed_existing = {name for name, _flight, _side in USER_RAILS}
    allowed_existing.add(root.name)
    protected_before = {
        obj.name: object_fingerprint(obj)
        for obj in bpy.data.objects
        if obj.name not in allowed_existing
    }
    rail_records = []
    rail_authority = {}
    rail_objects = []
    for source_name, flight, side in USER_RAILS:
        obj = bpy.data.objects.get(source_name)
        if obj is None or obj.type != 'MESH':
            raise RuntimeError(f'Missing user-authored rail {source_name}')
        rail_authority[source_name] = {
            'mesh_without_uv': mesh_fingerprint(obj.data, include_uv=False),
            'matrix_world': matrix_values(obj.matrix_world),
        }
        rail_objects.append((obj, source_name, flight, side))

    metal = rebuild_metal010_material()
    fastener_material = rebuild_fastener_material()
    stair_collection = ensure_collection('20_PROCESSIONAL_STAIRS_AND_LANDINGS')
    metal_collection = ensure_collection('40_INTEGRATED_SCIFI_METAL')

    trims = []
    for obj, source_name, flight, side in rail_objects:
        new_name = f'stone_processional_rail_flight_{flight:02d}_{side}'
        repair_world_box_uv(obj)
        move_to_collection(obj, stair_collection)
        parent_preserving_world(obj, root)
        obj.name = new_name
        obj.data.name = new_name + '_mesh'
        obj['user_authoritative_source_object'] = source_name
        obj['uv_repaired'] = True
        obj['uv_repeats_per_meter'] = UV_REPEATS_PER_METER
        trim_name = f'scifi_processional_cheek_insets_integrated_v2_flight_{flight:02d}_{side}'
        trim = make_trim_for_rail(
            obj, trim_name, metal, root, metal_collection,
        )
        trims.append(trim)
        after_without_uv = mesh_fingerprint(obj.data, include_uv=False)
        before = rail_authority[source_name]
        if after_without_uv != before['mesh_without_uv']:
            raise RuntimeError(f'Rail authority geometry/normals changed: {source_name}')
        transform_delta = matrix_max_abs_delta(
            matrix_values(obj.matrix_world), before['matrix_world'],
        )
        if transform_delta > 1.0e-6:
            raise RuntimeError(
                f'Rail authority world transform changed: {source_name} delta={transform_delta}'
            )
        rail_records.append({
            'source_name': source_name,
            'integrated_name': obj.name,
            'flight': flight,
            'side': side,
            'world_matrix_preserved': True,
            'world_matrix_max_abs_delta': transform_delta,
            'geometry_topology_normals_preserved': True,
            'uv_action': f'world box projection at {UV_REPEATS_PER_METER} repeats/m',
            'trim_name': trim.name,
        })

    fasteners, shifted_left, shifted_right = append_shifted_fasteners(
        runtime_reference, fastener_material, root, metal_collection,
    )
    fastener_components = connected_components(fasteners.data)
    if fastener_components != 176:
        raise RuntimeError(f'Expected 176 fastener components, got {fastener_components}')
    if shifted_left != shifted_right or shifted_left == 0:
        raise RuntimeError(
            f'Unexpected shifted fastener vertices left={shifted_left}, right={shifted_right}'
        )
    panel_object = bpy.data.objects.get('scifi_inset_metal_panels')
    if panel_object is None or panel_object.type != 'MESH':
        raise RuntimeError('Missing user-authoritative scifi_inset_metal_panels')
    fastener_measurements = measure_fastener_geometry(fasteners, panel_object)
    if fastener_measurements['host_panel_components'] != 44:
        raise RuntimeError(
            'Expected 44 actual panel components, got {}'.format(
                fastener_measurements['host_panel_components']
            )
        )
    for key in ('support_tangent_width_m', 'support_vertical_height_m'):
        measured = fastener_measurements[key]
        if (abs(measured['min'] - FASTENER_SUPPORT_SIZE_M) > 1.0e-5
                or abs(measured['max'] - FASTENER_SUPPORT_SIZE_M) > 1.0e-5):
            raise RuntimeError(f'Fastener support measurement drift in {key}: {measured}')
    for key in ('corner_center_horizontal_inset_m', 'corner_center_vertical_inset_m'):
        measured = fastener_measurements[key]
        if measured['min'] < 0.225 or measured['max'] > 0.236:
            raise RuntimeError(f'Fastener corner inset is outside v2 contract: {key}={measured}')

    root['integration_version'] = 'integrated_v2'
    root['integration_source_sha256'] = source_hash
    root['user_edit_authority'] = True
    root['walkable_stair_half_width'] = USER_STAIR_WIDTH * 0.5
    root['rail_trim_pieces'] = len(trims)
    root['rail_uv_repeats_per_meter'] = UV_REPEATS_PER_METER
    root['panel_corner_fasteners'] = fastener_components
    root['fastener_revision'] = 'corner_v2'
    root['fastener_support_plate_size_m'] = FASTENER_SUPPORT_SIZE_M
    root['fastener_visible_diameter_m'] = FASTENER_VISIBLE_DIAMETER_M
    root['fastener_chamfer_clearance_m'] = FASTENER_CHAMFER_CLEARANCE_M
    root['fastener_normal_map'] = 'ambientCG Metal010 NormalGL (CC0)'
    root['fastener_style'] = 'generated RGBA recessed decals; 5 mm proud; 0.090 m visible diameter; 0.235 m support; Metal010 normal-mapped'
    root['material_language'] = (
        'user-authored rectilinear stone; Harness minerals; ambientCG CC0 '
        'Metal010 panels/flush rail trim; generated flush fastener decals'
    )
    root['runtime_material_payload'] = 'named scalar slots; external optimized PBR/decal maps'
    root['old_generated_cheek_geometry'] = False
    root['user_rail_topology'] = 'intentionally preserved user open-surface seams; runtime uses object-specific double-sided stone material'

    protected_changed = []
    for name, before in protected_before.items():
        obj = bpy.data.objects.get(name)
        if obj is None:
            protected_changed.append({'name': name, 'reason': 'missing'})
            continue
        after = object_fingerprint(obj)
        if after != before:
            protected_changed.append({'name': name, 'reason': 'fingerprint_changed'})
    if protected_changed:
        raise RuntimeError(f'Non-allowlisted user objects changed: {protected_changed}')

    audit = architecture_audit(root)
    root['audit_zero_degenerate_faces'] = audit['degenerate_faces'] == 0
    root['audit_zero_nonmanifold_edges'] = audit['nonmanifold_edges'] == 0
    root['audit_nonmanifold_edges_preserved_user_rails'] = audit['nonmanifold_edges']
    root['audit_triangles'] = audit['triangles']
    root['audit_meshes'] = audit['meshes']
    if audit['degenerate_faces']:
        raise RuntimeError(f'Integrated architecture contains degenerate faces: {audit}')

    os.makedirs(os.path.dirname(output_paths['area']), exist_ok=True)
    bpy.ops.file.pack_all()
    bpy.ops.wm.save_as_mainfile(filepath=output_paths['area'])
    export_runtime_glb(root, output_paths['glb'])

    report = {
        'authority': {
            'source': source_path,
            'bytes': os.path.getsize(source_path),
            'sha256': source_hash,
            'source_untouched': sha256_file(source_path) == source_hash,
        },
        'integration': {
            'version': 'integrated_v2',
            'user_stair_width_m': USER_STAIR_WIDTH,
            'user_stair_half_width_m': USER_STAIR_WIDTH * 0.5,
            'rails': rail_records,
            'trim_count': len(trims),
            'user_rail_topology': {
                'nonmanifold_edges': audit['nonmanifold_edges'],
                'interpretation': '24 authored open-surface seam edges on each of eight user rail meshes',
                'runtime_safeguard': 'object-specific double-sided triplanar sandstone material',
            },
            'forbidden_generated_objects_absent': all(
                bpy.data.objects.get(name) is None
                for name in FORBIDDEN_REGENERATED_OBJECTS
            ),
            'fasteners': {
                'components': fastener_components,
                'revision': 'corner_v2',
                'shifted_vertex_count_left': shifted_left,
                'shifted_vertex_count_right': shifted_right,
                'left_shift_m': PANEL_LEFT_SHIFT,
                'right_shift_m': PANEL_RIGHT_SHIFT,
                'material': 'FastenerDecal',
                'support_plate_size_m': FASTENER_SUPPORT_SIZE_M,
                'visible_diameter_m': FASTENER_VISIBLE_DIAMETER_M,
                'surface_proud_m': 0.005,
                'normal_map': True,
                'normal_map_source': 'ambientCG Metal010 NormalGL (CC0)',
                'normal_projection': 'authored FastenerDecalUV',
                'measurements_against_actual_panel_bounds': fastener_measurements,
            },
            'metal010': {
                'source': 'ambientCG Metal010 1K JPG (CC0)',
                'maps': ['Color', 'NormalGL', 'Roughness', 'Metalness'],
                'editable_panel_calibration': {
                    'roughness': {'scale': 0.65, 'bias': 0.484, 'range': [0.70, 0.94]},
                    'metalness': {'scale': 0.23, 'bias': 0.55, 'range': [0.55, 0.78]},
                },
            },
        },
        'allowlist_audit': {
            'protected_object_count': len(protected_before),
            'protected_changed': protected_changed,
            'pass': not protected_changed,
            'permitted_existing_changes': [
                'ziggurat_architecture_root custom properties',
                'eight user rail objects: rename, parent/collection, UV only',
                'SciFiMetal node/material payload',
            ],
            'permitted_additions': [
                'eight scifi_processional_cheek_insets_integrated_v2 trim meshes',
                'one shifted scifi_panel_corner_fasteners mesh',
                'FastenerDecal material/decal plus existing Metal010 NormalGL payload',
            ],
        },
        'architecture_audit': audit,
        'outputs': {},
    }

    save_architecture_sources(
        root,
        output_paths['architecture_blend'],
        output_paths['canonical_architecture_blend'],
    )
    for label in ('area', 'glb', 'architecture_blend', 'canonical_architecture_blend'):
        path = output_paths[label]
        report['outputs'][label] = {
            'path': path,
            'bytes': os.path.getsize(path),
            'sha256': sha256_file(path),
        }
    report['authority']['source_untouched_after_all_outputs'] = (
        sha256_file(source_path) == source_hash
    )
    os.makedirs(os.path.dirname(output_paths['report']), exist_ok=True)
    with open(output_paths['report'], 'w', encoding='utf-8') as handle:
        json.dump(report, handle, indent=2, sort_keys=True)
        handle.write('\n')
    print(output_paths['report'])
    print(json.dumps({
        'audit': audit,
        'fasteners': fastener_components,
        'shifted_left': shifted_left,
        'shifted_right': shifted_right,
        'trims': len(trims),
        'source_untouched': report['authority']['source_untouched_after_all_outputs'],
    }, sort_keys=True))


if __name__ == '__main__':
    argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    main(parse_args(argv))
