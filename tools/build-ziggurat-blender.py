"""Build the measured, authored Eanpa ziggurat as GLB + editable Blend source.

The dimensional contract is illustrated in the retained SVG architectural
reference. Blender and the engine share its four-flight schedule verbatim:
110 true geometric steps, each with a 0.20 m riser and 0.30 m tread, plus
three 1.60 m landings. All decorative pieces are shallow, face-aligned
architectural insets rather than loose boxes. Blender coordinates are
converted from the engine's Y-up convention here.
"""

import math
import os
import sys

import bpy
import bmesh
from mathutils import Vector

PROJECT_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))

# Corner hardware is deliberately surface detail, not a field of chunky studs.
# The generated decal's visible washer occupies 0.13 / 0.34 of its support
# plate, so a 0.235 m plate yields a measured ~0.090 m visible diameter.
FASTENER_SUPPORT_SIZE_M = 0.235
FASTENER_VISIBLE_DIAMETER_M = 0.090
FASTENER_CHAMFER_CLEARANCE_M = 0.015
FASTENER_NORMAL_STRENGTH = 0.34


def engine_to_blender(point):
    x, y, z = point
    return (x, -z, y)


def clear_scene():
    bpy.ops.object.select_all(action='SELECT')
    bpy.ops.object.delete(use_global=False)
    for datablocks in (bpy.data.meshes, bpy.data.curves, bpy.data.materials):
        for datablock in list(datablocks):
            if datablock.users == 0:
                datablocks.remove(datablock)


def make_material(name, color, roughness, metallic=0.0, emission=None, emission_strength=0.0):
    material = bpy.data.materials.new(name)
    material.use_nodes = True
    material.diffuse_color = (*color, 1.0)
    node = material.node_tree.nodes.get('Principled BSDF')
    if node:
        node.inputs['Base Color'].default_value = (*color, 1.0)
        node.inputs['Roughness'].default_value = roughness
        node.inputs['Metallic'].default_value = metallic
        if 'Coat Weight' in node.inputs:
            node.inputs['Coat Weight'].default_value = 0.32 if name in {'LapisPBR', 'CarnelianPBR'} else 0.08
        if 'Coat Roughness' in node.inputs:
            node.inputs['Coat Roughness'].default_value = 0.2
        if emission:
            emission_input = node.inputs.get('Emission Color') or node.inputs.get('Emission')
            strength_input = node.inputs.get('Emission Strength')
            if emission_input:
                emission_input.default_value = (*emission, 1.0)
            if strength_input:
                strength_input.default_value = emission_strength
    return material


def _image_node(nodes, links, vector_socket, image_path, label, color_space):
    if not os.path.isfile(image_path):
        raise FileNotFoundError(image_path)
    image = bpy.data.images.load(image_path, check_existing=True)
    image.colorspace_settings.name = color_space
    texture = nodes.new('ShaderNodeTexImage')
    texture.name = label
    texture.label = label
    texture.image = image
    texture.extension = 'REPEAT'
    texture.projection = 'BOX'
    texture.projection_blend = 0.16
    links.new(vector_socket, texture.inputs['Vector'])
    return texture


def make_brushed_metal_material(name):
    """Editable-Blend material; runtime uses the same source maps triplanar."""
    root = os.path.join(
        PROJECT_ROOT, 'assets', 'temple', 'materials', 'ambientcg_metal010',
    )
    material = make_material(name, (0.12, 0.16, 0.19), 0.58, metallic=0.78)
    material['pbr_source'] = 'ambientCG Metal010 1K JPG (CC0)'
    material['channel_contract'] = 'separate Color, NormalGL, Roughness, Metalness'
    nodes = material.node_tree.nodes
    links = material.node_tree.links
    principled = nodes.get('Principled BSDF')
    texcoord = nodes.new('ShaderNodeTexCoord')
    mapping = nodes.new('ShaderNodeMapping')
    mapping.inputs['Scale'].default_value = (0.62, 0.62, 0.62)
    links.new(texcoord.outputs['Generated'], mapping.inputs['Vector'])

    color = _image_node(
        nodes, links, mapping.outputs['Vector'],
        os.path.join(root, 'Metal010_1K-JPG_Color.jpg'),
        'ambientCG Metal010 Color', 'sRGB',
    )
    normal = _image_node(
        nodes, links, mapping.outputs['Vector'],
        os.path.join(root, 'Metal010_1K-JPG_NormalGL.jpg'),
        'ambientCG Metal010 NormalGL', 'Non-Color',
    )
    roughness = _image_node(
        nodes, links, mapping.outputs['Vector'],
        os.path.join(root, 'Metal010_1K-JPG_Roughness.jpg'),
        'ambientCG Metal010 Roughness', 'Non-Color',
    )
    metalness = _image_node(
        nodes, links, mapping.outputs['Vector'],
        os.path.join(root, 'Metal010_1K-JPG_Metalness.jpg'),
        'ambientCG Metal010 Metalness', 'Non-Color',
    )
    normal_map = nodes.new('ShaderNodeNormalMap')
    normal_map.inputs['Strength'].default_value = 0.56
    links.new(color.outputs['Color'], principled.inputs['Base Color'])
    links.new(normal.outputs['Color'], normal_map.inputs['Color'])
    links.new(normal_map.outputs['Normal'], principled.inputs['Normal'])
    links.new(roughness.outputs['Color'], principled.inputs['Roughness'])
    links.new(metalness.outputs['Color'], principled.inputs['Metallic'])
    return material


def make_fastener_decal_material(name):
    image_path = os.path.join(
        PROJECT_ROOT, 'assets', 'temple', 'decals', 'panel_fastener_decal-v1.png',
    )
    material = make_material(name, (0.32, 0.34, 0.35), 0.48, metallic=0.78)
    material['generated_asset'] = 'assets/temple/decals/panel_fastener_decal-v1.png'
    material['treatment'] = 'alpha decal on a near-flush closed support plate with Metal010 normal response'
    material['pbr_source'] = 'ImageGen recessed fastener RGBA + ambientCG Metal010 NormalGL (CC0)'
    material['normal_map'] = True
    material['normal_map_source'] = 'ambientCG Metal010_1K-JPG_NormalGL.jpg (CC0)'
    material['normal_projection'] = 'authored FastenerDecalUV'
    nodes = material.node_tree.nodes
    links = material.node_tree.links
    principled = nodes.get('Principled BSDF')
    texcoord = nodes.new('ShaderNodeTexCoord')
    image = bpy.data.images.load(image_path, check_existing=True)
    image.colorspace_settings.name = 'sRGB'
    image.alpha_mode = 'STRAIGHT'
    texture = nodes.new('ShaderNodeTexImage')
    texture.name = 'Generated recessed fastener RGBA'
    texture.image = image
    texture.extension = 'CLIP'
    links.new(texcoord.outputs['UV'], texture.inputs['Vector'])
    links.new(texture.outputs['Color'], principled.inputs['Base Color'])
    links.new(texture.outputs['Alpha'], principled.inputs['Alpha'])
    normal = _image_node(
        nodes, links, texcoord.outputs['UV'],
        os.path.join(
            PROJECT_ROOT, 'assets', 'temple', 'materials',
            'ambientcg_metal010', 'Metal010_1K-JPG_NormalGL.jpg',
        ),
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


def add_bevel(obj, width=0.12, segments=3):
    modifier = obj.modifiers.new('architectural_bevel', 'BEVEL')
    modifier.width = width
    modifier.segments = segments
    modifier.limit_method = 'ANGLE'
    modifier.angle_limit = math.radians(24)
    modifier.harden_normals = True
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.modifier_apply(modifier=modifier.name)
    for polygon in obj.data.polygons:
        polygon.use_smooth = False
    return obj


def dissolve_exact_degenerates(obj, distance=1.0e-8):
    if obj.type != 'MESH':
        return
    mesh = obj.data
    bm = bmesh.new()
    bm.from_mesh(mesh)
    bmesh.ops.dissolve_degenerate(bm, dist=distance, edges=list(bm.edges))
    # glTF must triangulate the long stepped side profiles. Do it here under
    # our control, then collapse only the shortest edge of any mathematical
    # zero-area result. This preserves the stair silhouette without exporting
    # the one degenerate triangle that generic n-gon triangulation produced
    # for each separate flight.
    bmesh.ops.triangulate(
        bm, faces=list(bm.faces), quad_method='BEAUTY', ngon_method='BEAUTY',
    )
    for _ in range(4):
        bad_faces = [face for face in bm.faces if face.calc_area() <= 1.0e-12]
        if not bad_faces:
            break
        collapse_edges = {
            min(face.edges, key=lambda edge: edge.calc_length())
            for face in bad_faces if face.edges
        }
        if not collapse_edges:
            break
        bmesh.ops.collapse(bm, edges=list(collapse_edges), uvs=True)
    # Enforce one consistent outward orientation for every disconnected closed
    # shell. This is essential for WebGPU's front-face culling: the old stair
    # side strip was manifold but its tread/riser winding pointed inward.
    bmesh.ops.recalc_face_normals(bm, faces=list(bm.faces))
    bm.to_mesh(mesh)
    bm.free()
    mesh.validate(clean_customdata=False)
    mesh.update()


def add_box_engine(name, location, dimensions, material, bevel=0.0, collection=None):
    bpy.ops.mesh.primitive_cube_add(location=engine_to_blender(location))
    obj = bpy.context.object
    obj.name = name
    obj.dimensions = (dimensions[0], dimensions[2], dimensions[1])
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    if material is not None:
        obj.data.materials.append(material)
    if bevel > 0:
        add_bevel(obj, bevel, 3)
    if collection is not None:
        collection.append(obj)
    return obj


def make_rectilinear_block(name, width, depth, base_y, height, material):
    bx = tx = width * 0.5
    bz = tz = depth * 0.5
    engine_vertices = [
        (-bx, base_y, -bz), (bx, base_y, -bz), (bx, base_y, bz), (-bx, base_y, bz),
        (-tx, base_y + height, -tz), (tx, base_y + height, -tz),
        (tx, base_y + height, tz), (-tx, base_y + height, tz),
    ]
    vertices = [engine_to_blender(vertex) for vertex in engine_vertices]
    faces = [
        (0, 3, 2, 1),
        (4, 5, 6, 7),
        (0, 1, 5, 4),
        (1, 2, 6, 5),
        (2, 3, 7, 6),
        (3, 0, 4, 7),
    ]
    mesh = bpy.data.meshes.new(name + '_mesh')
    mesh.from_pydata(vertices, [], faces)
    mesh.validate()
    mesh.update()
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(obj)
    obj.data.materials.append(material)
    return obj


def make_rectangular_cornice(name, width, depth, base_y, height, material):
    """Closed projecting rectangular ring for a horizontal masonry cornice."""
    outer_x = width * 0.5 + 0.28
    outer_z = depth * 0.5 + 0.28
    inner_x = width * 0.5 - 0.34
    inner_z = depth * 0.5 - 0.34
    outer = [(-outer_x, -outer_z), (outer_x, -outer_z), (outer_x, outer_z), (-outer_x, outer_z)]
    inner = [(-inner_x, -inner_z), (inner_x, -inner_z), (inner_x, inner_z), (-inner_x, inner_z)]
    engine_vertices = []
    for y in (base_y, base_y + height):
        engine_vertices.extend((x, y, z) for x, z in outer)
        engine_vertices.extend((x, y, z) for x, z in inner)
    vertices = [engine_to_blender(vertex) for vertex in engine_vertices]
    faces = []
    for index in range(4):
        nxt = (index + 1) % 4
        faces.append((index, nxt, 8 + nxt, 8 + index))
        faces.append((4 + nxt, 4 + index, 12 + index, 12 + nxt))
        faces.append((8 + index, 8 + nxt, 12 + nxt, 12 + index))
        faces.append((nxt, index, 4 + index, 4 + nxt))
    mesh = bpy.data.meshes.new(name + '_mesh')
    mesh.from_pydata(vertices, [], faces)
    mesh.validate()
    mesh.update()
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(obj)
    obj.data.materials.append(material)
    return obj


def make_face_panel(
    name, face, center_u, center_y, width, panel_height,
    tier_spec, material, thickness=0.07, bevel=0.0, chamfer=0.0,
    decal_uv=False,
):
    """Make a closed shallow prism that follows its tier host face exactly.

    face is front/rear/left/right. center_u is X on front/rear faces and Z on
    side faces. Unlike an axis-aligned box, both the high and low panel edges
    are sampled from the actual host plane, so nothing floats away from or
    visibly tunnels through the masonry.
    """
    _, bw, bd, tw, td, base_y, tier_height = tier_spec
    low_y = center_y - panel_height * 0.5
    high_y = center_y + panel_height * 0.5
    low_u = center_u - width * 0.5
    high_u = center_u + width * 0.5
    chamfer = max(0.0, min(chamfer, width * 0.22, panel_height * 0.34))
    if chamfer > 0:
        outline = [
            (low_u + chamfer, low_y), (high_u - chamfer, low_y),
            (high_u, low_y + chamfer), (high_u, high_y - chamfer),
            (high_u - chamfer, high_y), (low_u + chamfer, high_y),
            (low_u, high_y - chamfer), (low_u, low_y + chamfer),
        ]
    else:
        outline = [
            (low_u, low_y), (high_u, low_y),
            (high_u, high_y), (low_u, high_y),
        ]

    def half_extent_at(y, bottom, top):
        t = max(0.0, min(1.0, (y - base_y) / tier_height))
        return bottom * 0.5 + (top - bottom) * 0.5 * t

    def surface_point(u, y, outward=0.0):
        if face in {'front', 'rear'}:
            sign = 1.0 if face == 'front' else -1.0
            z = sign * (half_extent_at(y, bd, td) + outward)
            return (u, y, z)
        sign = 1.0 if face == 'right' else -1.0
        x = sign * (half_extent_at(y, bw, tw) + outward)
        return (x, y, u)

    engine_vertices = [surface_point(u, y, 0.006) for u, y in outline]
    engine_vertices += [surface_point(u, y, thickness) for u, y in outline]
    vertices = [engine_to_blender(vertex) for vertex in engine_vertices]
    count = len(outline)
    faces = [
        tuple(range(count - 1, -1, -1)),
        tuple(range(count, count * 2)),
    ]
    for index in range(count):
        nxt = (index + 1) % count
        faces.append((index, nxt, count + nxt, count + index))
    mesh = bpy.data.meshes.new(name + '_mesh')
    mesh.from_pydata(vertices, [], faces)
    mesh.validate()
    mesh.update()
    if decal_uv:
        # Only the outward face receives the RGBA decal. All support-plate
        # side/back loops sample the fully transparent texture corner, so the
        # authored piece reads as recessed surface detail rather than a box.
        uv_layer = mesh.uv_layers.new(name='FastenerDecalUV')
        for polygon in mesh.polygons:
            outward = all(
                mesh.loops[loop_index].vertex_index >= count
                for loop_index in polygon.loop_indices
            )
            for loop_index in polygon.loop_indices:
                vertex_index = mesh.loops[loop_index].vertex_index
                if outward:
                    outline_index = vertex_index - count
                    u, y = outline[outline_index]
                    uv_layer.data[loop_index].uv = (
                        (u - low_u) / width, (y - low_y) / panel_height,
                    )
                else:
                    uv_layer.data[loop_index].uv = (0.0, 0.0)
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(obj)
    obj.data.materials.append(material)
    if bevel > 0:
        add_bevel(obj, bevel, 2)
    obj['architectural_inset'] = True
    obj['host_face'] = face
    return obj


def make_staircase(
    name, width, front_z, back_z, front_y, summit_y, steps, material,
    foundation_y=None,
):
    depth = (front_z - back_z) / steps
    rise = (summit_y - front_y) / steps
    base_y = front_y - 1.0 if foundation_y is None else foundation_y
    profile = [(front_z, base_y), (front_z, front_y)]
    for index in range(steps):
        z0 = front_z - index * depth
        z1 = front_z - (index + 1) * depth
        y1 = front_y + (index + 1) * rise
        profile.append((z0, y1))
        profile.append((z1, y1))
    profile.append((back_z, base_y))

    half = width * 0.5
    vertices = []
    for x in (-half, half):
        vertices.extend(engine_to_blender((x, y, z)) for z, y in profile)
    count = len(profile)
    faces = []
    # Natural profile order points outward on the -X cheek; reverse it on +X.
    faces.append(tuple(range(count)))
    faces.append(tuple(range(count * 2 - 1, count - 1, -1)))
    for index in range(count):
        nxt = (index + 1) % count
        # Across-profile order gives +Y on treads and +Z on front-facing
        # risers. The previous order produced the exact inward normals seen in
        # the live approach render.
        faces.append((index, count + index, count + nxt, nxt))

    mesh = bpy.data.meshes.new(name + '_mesh')
    mesh.from_pydata(vertices, [], faces)
    mesh.validate()
    mesh.update()
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(obj)
    obj.data.materials.append(material)
    add_bevel(obj, 0.035, 2)
    obj['eanpa_steps'] = steps
    obj['eanpa_front_z'] = front_z
    obj['eanpa_back_z'] = back_z
    obj['eanpa_summit_y'] = summit_y
    return obj


def make_sloped_wall(
    name, center_x, width, front_z, back_z, front_y, back_y,
    wall_height, material, foundation_depth=0.7, bevel=0.08,
):
    """Closed, beveled cheek wall following one ceremonial stair flight."""
    half = width * 0.5
    left = center_x - half
    right = center_x + half
    engine_vertices = [
        (left, back_y - foundation_depth, back_z),
        (right, back_y - foundation_depth, back_z),
        (right, front_y - foundation_depth, front_z),
        (left, front_y - foundation_depth, front_z),
        (left, back_y + wall_height, back_z),
        (right, back_y + wall_height, back_z),
        (right, front_y + wall_height, front_z),
        (left, front_y + wall_height, front_z),
    ]
    vertices = [engine_to_blender(vertex) for vertex in engine_vertices]
    faces = [
        (0, 3, 2, 1), (4, 5, 6, 7),
        (0, 1, 5, 4), (1, 2, 6, 5),
        (2, 3, 7, 6), (3, 0, 4, 7),
    ]
    mesh = bpy.data.meshes.new(name + '_mesh')
    mesh.from_pydata(vertices, [], faces)
    mesh.validate()
    mesh.update()
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(obj)
    obj.data.materials.append(material)
    if bevel > 0:
        add_bevel(obj, bevel, 3)
    return obj


def join_objects(objects, name, material, bevel=0.0):
    if not objects:
        return None
    bpy.ops.object.select_all(action='DESELECT')
    for obj in objects:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = objects[0]
    bpy.ops.object.join()
    joined = bpy.context.object
    joined.name = name
    if material and (not joined.data.materials or joined.data.materials[0] != material):
        joined.data.materials.clear()
        joined.data.materials.append(material)
    if bevel > 0:
        add_bevel(joined, bevel, 2)
    return joined


def cylinder_between(name, start, end, radius, material, vertices=12, collection=None):
    a = Vector(engine_to_blender(start))
    b = Vector(engine_to_blender(end))
    direction = b - a
    length = direction.length
    bpy.ops.mesh.primitive_cylinder_add(vertices=vertices, radius=radius, depth=length, location=(a + b) * 0.5)
    obj = bpy.context.object
    obj.name = name
    obj.rotation_mode = 'QUATERNION'
    obj.rotation_quaternion = Vector((0, 0, 1)).rotation_difference(direction.normalized())
    obj.data.materials.append(material)
    if collection is not None:
        collection.append(obj)
    return obj


def add_vertical_cylinder(name, location, radius, depth, material, vertices=64, bevel=0.0):
    bpy.ops.mesh.primitive_cylinder_add(
        vertices=vertices,
        radius=radius,
        depth=depth,
        location=engine_to_blender(location),
    )
    obj = bpy.context.object
    obj.name = name
    obj.data.materials.append(material)
    if bevel > 0:
        add_bevel(obj, bevel, 3)
    return obj


def add_vertical_cone(name, location, bottom_radius, top_radius, depth, material, vertices=64, bevel=0.0):
    bpy.ops.mesh.primitive_cone_add(
        vertices=vertices,
        radius1=bottom_radius,
        radius2=top_radius,
        depth=depth,
        location=engine_to_blender(location),
    )
    obj = bpy.context.object
    obj.name = name
    obj.data.materials.append(material)
    if bevel > 0:
        add_bevel(obj, bevel, 3)
    return obj


def boolean_corridor(tiers, width, front_z, back_z):
    center_z = (front_z + back_z) * 0.5
    depth = front_z - back_z
    cutter = add_box_engine(
        'boolean_stair_corridor_cutter',
        (0, 12.0, center_z),
        (width, 32.0, depth),
        None,
    )
    cutter.display_type = 'WIRE'
    for tier in tiers:
        modifier = tier.modifiers.new('recessed_processional_channel', 'BOOLEAN')
        modifier.operation = 'DIFFERENCE'
        modifier.solver = 'EXACT'
        modifier.object = cutter
        bpy.context.view_layer.objects.active = tier
        bpy.ops.object.modifier_apply(modifier=modifier.name)
    bpy.data.objects.remove(cutter, do_unlink=True)


def build(output_path):
    clear_scene()
    scene = bpy.context.scene
    scene.unit_settings.system = 'METRIC'
    scene.unit_settings.scale_length = 1.0

    sandstone = make_material('SandstonePBR', (0.54, 0.38, 0.23), 0.86)
    lapis = make_material('LapisPBR', (0.018, 0.085, 0.31), 0.2, metallic=0.05)
    carnelian = make_material('CarnelianPBR', (0.55, 0.055, 0.018), 0.24, metallic=0.02)
    metal = make_brushed_metal_material('SciFiMetal')
    fastener_decal = make_fastener_decal_material('FastenerDecal')

    # Proper rectilinear ziggurat massing: four vertical load-bearing masonry
    # blocks with large horizontal terrace setbacks. Equal bottom/top plans
    # deliberately remove the rejected continuous pyramidal/frustum read.
    tier_specs = [
        ('stone_rectilinear_tier_01', 70.0, 68.0, 70.0, 68.0, -2.0, 8.8),
        ('stone_rectilinear_tier_02', 58.0, 50.0, 58.0, 50.0, 6.8, 5.6),
        ('stone_rectilinear_tier_03', 46.0, 34.0, 46.0, 34.0, 12.4, 5.0),
        ('stone_rectilinear_tier_04', 34.0, 18.0, 34.0, 18.0, 17.4, 4.4),
    ]
    tiers = [
        make_rectilinear_block(name, bw, bd, base, height, sandstone)
        for name, bw, bd, tw, td, base, height in tier_specs
    ]
    cornices = [
        make_rectangular_cornice(
            f'stone_integrated_cornice_{index + 1:02d}',
            bw, bd, base + height - 0.42, 0.30, sandstone,
        )
        for index, (_, bw, bd, _, _, base, height) in enumerate(tier_specs)
    ]
    stair_width = 13.4
    stair_corridor_width = 15.4
    stair_front_z = 43.35
    stair_back_z = 5.55
    boolean_corridor(tiers + cornices, stair_corridor_width, stair_front_z + 0.30, 4.92)
    for tier in tiers:
        add_bevel(tier, 0.105, 3)
    for cornice in cornices:
        add_bevel(cornice, 0.045, 2)
    join_objects(cornices, 'stone_integrated_terrace_cornices', sandstone)

    # The rejected stair used 0.28-0.35 m risers and irregular short treads,
    # which collapsed into a striped wall from the court. This measured
    # schedule is exactly 0.20 m rise x 0.30 m tread throughout. Four broad
    # flights meet the terrace datums through three supported 1.60 m landings.
    # Each staircase body is a closed stone substructure, never floating slabs.
    stair_front_y = -0.20
    stair_top_y = 21.80
    stair_profile = [
        (43.35, 32.85, stair_front_y, 6.80, 35, 31.25),
        (31.25, 22.85, 6.80, 12.40, 28, 21.25),
        (21.25, 13.75, 12.40, 17.40, 25, 12.15),
        (12.15, 5.55, 17.40, stair_top_y, 22, None),
    ]
    stair_parts = []
    retaining_parts = []
    metal_curb_parts = []
    landing_support_y = -1.45
    cheek_width = 0.76
    # Seat the cheek four centimetres into the tread edge. The former 8 cm
    # air slot between x=6.70 and x=6.78 read as a broken railing/stair join.
    cheek_overlap = 0.04
    for flight_index, (front_z, back_z, front_y, back_y, steps, landing_back) in enumerate(stair_profile):
        flight = make_staircase(
            f'stone_stair_flight_{flight_index + 1:02d}',
            stair_width, front_z, back_z, front_y, back_y, steps,
            sandstone, foundation_y=landing_support_y,
        )
        stair_parts.append(flight)
        for side in (-1, 1):
            center_x = side * (
                stair_width * 0.5 + cheek_width * 0.5 - cheek_overlap
            )
            retaining_parts.append(make_sloped_wall(
                f'stone_stair_cheek_{flight_index + 1:02d}_{side:+d}',
                center_x, cheek_width, front_z, back_z, front_y, back_y,
                0.48, sandstone, 0.38, 0.065,
            ))
            # A narrow flush metal cap ties the four flights into the science-
            # fiction language without detached fixtures or box clutter.
            metal_curb_parts.append(make_sloped_wall(
                f'scifi_stair_cheek_cap_{flight_index + 1:02d}_{side:+d}',
                center_x, 0.22, front_z, back_z,
                front_y + 0.48, back_y + 0.48,
                0.065, metal, 0.055, 0.025,
            ))
        if landing_back is not None:
            landing_depth = back_z - landing_back
            landing_center = (back_z + landing_back) * 0.5
            support_height = back_y - landing_support_y
            stair_parts.append(add_box_engine(
                f'stone_processional_landing_{flight_index + 1:02d}',
                (0, landing_support_y + support_height * 0.5, landing_center),
                (stair_width, support_height, landing_depth), sandstone, 0.08,
            ))
            for side in (-1, 1):
                center_x = side * (
                    stair_width * 0.5 + cheek_width * 0.5 - cheek_overlap
                )
                retaining_parts.append(add_box_engine(
                    f'stone_landing_parapet_{flight_index + 1:02d}_{side:+d}',
                    (center_x, back_y + 0.21, landing_center),
                    (0.76, 0.62, landing_depth + 0.06), sandstone, 0.065,
                ))
                metal_curb_parts.append(add_box_engine(
                    f'scifi_landing_cheek_cap_{flight_index + 1:02d}_{side:+d}',
                    (center_x, back_y + 0.55, landing_center),
                    (0.22, 0.09, landing_depth + 0.02), metal, 0.025,
                ))

    # The final flight used to stop at z=5.55 while its summit landing
    # continued behind it, leaving a large open slot on both sides. Continue
    # the parapet/cap across the landing and return it into the tier's cut
    # corridor edge so the processional rail terminates in real masonry.
    summit_landing_back = 4.75
    summit_landing_front = stair_profile[-1][1]
    summit_landing_depth = summit_landing_front - summit_landing_back
    summit_landing_center = (
        summit_landing_front + summit_landing_back
    ) * 0.5
    corridor_half = stair_corridor_width * 0.5
    for side in (-1, 1):
        center_x = side * (
            stair_width * 0.5 + cheek_width * 0.5 - cheek_overlap
        )
        retaining_parts.append(add_box_engine(
            f'stone_summit_landing_parapet_{side:+d}',
            (center_x, stair_top_y + 0.21, summit_landing_center),
            (cheek_width, 0.62, summit_landing_depth + 0.06),
            sandstone, 0.065,
        ))
        metal_curb_parts.append(add_box_engine(
            f'scifi_summit_landing_cap_{side:+d}',
            (center_x, stair_top_y + 0.55, summit_landing_center),
            (0.22, 0.09, summit_landing_depth + 0.02),
            metal, 0.025,
        ))
        cheek_outer = abs(center_x) + cheek_width * 0.5
        return_width = corridor_half - cheek_outer + 0.10
        return_center_x = side * (cheek_outer + return_width * 0.5)
        retaining_parts.append(add_box_engine(
            f'stone_summit_parapet_return_{side:+d}',
            (return_center_x, stair_top_y + 0.21, summit_landing_back + 0.13),
            (return_width, 0.62, 0.72), sandstone, 0.055,
        ))
        metal_curb_parts.append(add_box_engine(
            f'scifi_summit_cap_return_{side:+d}',
            (return_center_x, stair_top_y + 0.55, summit_landing_back + 0.13),
            (return_width, 0.09, 0.22), metal, 0.025,
        ))
    join_objects(stair_parts, 'stone_processional_staircase', sandstone)
    join_objects(retaining_parts, 'stone_processional_retaining_walls', sandstone)
    join_objects(metal_curb_parts, 'scifi_processional_cheek_insets', metal)
    stair_steps = sum(profile[4] for profile in stair_profile)

    add_box_engine(
        'stone_entry_threshold', (0, stair_front_y - 0.12, 43.95),
        (15.2, 0.24, 1.20), sandstone, 0.08,
    )
    add_box_engine(
        'stone_summit_landing',
        (0, stair_top_y - 0.15, summit_landing_center),
        (stair_width, 0.30, summit_landing_depth), sandstone, 0.07,
    )

    # Lapis and carnelian form one deliberate face-aligned masonry course below
    # each terrace cornice. Every tessera follows its vertical host plane; none
    # are loose stair blocks. Runtime swaps these named slots to the existing
    # Harness lapis/carnelian PBR texture sets.
    lapis_tiles = []
    carnelian_tiles = []
    tile_index = 0
    for tier_index, tier_spec in enumerate(tier_specs):
        _, bw, bd, tw, td, base_y, height = tier_spec
        top_y = base_y + height
        course_y = top_y - 0.48
        tile_width = 1.62 if tier_index < 2 else 1.42
        tile_height = 0.38
        pitch = tile_width + 0.14
        # Front/rear courses; front maintains the complete stair aperture.
        for face in ('front', 'rear'):
            count = max(1, int((tw - 0.8) / pitch))
            first_x = -(count - 1) * pitch * 0.5
            for index in range(count):
                x = first_x + index * pitch
                if face == 'front' and abs(x) < stair_corridor_width * 0.5 + 0.28:
                    continue
                target = lapis_tiles if (tile_index + tier_index) % 5 else carnelian_tiles
                material = lapis if target is lapis_tiles else carnelian
                target.append(make_face_panel(
                    f'inset_mineral_{face}_{tier_index + 1:02d}_{index:02d}',
                    face, x, course_y, tile_width, tile_height,
                    tier_spec, material, 0.075, 0.014,
                ))
                tile_index += 1
        # Side courses terminate short of corners to avoid co-planar overlaps.
        count = max(1, int((td - 1.4) / pitch))
        first_z = -(count - 1) * pitch * 0.5
        for face in ('left', 'right'):
            for index in range(count):
                z = first_z + index * pitch
                target = lapis_tiles if (tile_index + tier_index) % 5 else carnelian_tiles
                material = lapis if target is lapis_tiles else carnelian
                target.append(make_face_panel(
                    f'inset_mineral_{face}_{tier_index + 1:02d}_{index:02d}',
                    face, z, course_y, tile_width, tile_height,
                    tier_spec, material, 0.075, 0.014,
                ))
                tile_index += 1

    join_objects(lapis_tiles, 'tile_lapis_inlays', lapis)
    join_objects(carnelian_tiles, 'tile_carnelian_inlays', carnelian)

    # Chamfered dark-metal access plates are flush with and aligned to the same
    # vertical tier faces. Their sparse, symmetrical structural rhythm weaves
    # a restrained science-fiction layer with the ancient stone construction.
    metal_panels = []
    metal_fasteners = []

    def add_metal_panel(name, face, center_u, center_y, width, height, tier_spec, chamfer):
        metal_panels.append(make_face_panel(
            name, face, center_u, center_y, width, height,
            tier_spec, metal, 0.105, 0.028, chamfer,
        ))
        # Four small generated RGBA fasteners sit on near-flush closed support
        # plates. The visible detail is alpha/decal-like; the 5 mm separation
        # only prevents z-fighting and never reads as a chunky bolt box.
        # Fit the square support inside the actual chamfered host outline.  At
        # the closest support corner, the two edge deficits sum to chamfer +
        # FASTENER_CHAMFER_CLEARANCE_M, leaving a real 15 mm diagonal safety
        # margin while moving the hardware materially closer to both corners.
        corner_inset = (
            FASTENER_SUPPORT_SIZE_M * 0.5
            + chamfer * 0.5
            + FASTENER_CHAMFER_CLEARANCE_M * 0.5
        )
        for horizontal in (-1, 1):
            for vertical in (-1, 1):
                bolt_u = center_u + horizontal * (width * 0.5 - corner_inset)
                bolt_y = center_y + vertical * (height * 0.5 - corner_inset)
                fastener = make_face_panel(
                    f'{name}_corner_fastener_decal_{horizontal:+d}_{vertical:+d}',
                    face, bolt_u, bolt_y,
                    FASTENER_SUPPORT_SIZE_M, FASTENER_SUPPORT_SIZE_M,
                    tier_spec, fastener_decal, 0.110, 0.0, 0.0,
                    decal_uv=True,
                )
                fastener['surface_proud_m'] = 0.005
                fastener['support_plate_size_m'] = FASTENER_SUPPORT_SIZE_M
                fastener['visual_fastener_diameter_m'] = FASTENER_VISIBLE_DIAMETER_M
                fastener['corner_center_inset_m'] = corner_inset
                fastener['chamfer_clearance_m'] = FASTENER_CHAMFER_CLEARANCE_M
                fastener['normal_map'] = True
                fastener['normal_map_source'] = 'ambientCG Metal010 NormalGL (CC0)'
                fastener['generated_asset'] = 'panel_fastener_decal-v1.png'
                metal_fasteners.append(fastener)

    for tier_index, tier_spec in enumerate(tier_specs):
        _, _, _, tw, td, base_y, height = tier_spec
        panel_y = base_y + height * (0.48 if tier_index == 0 else 0.44)
        panel_width = 4.2 if tier_index == 0 else max(2.3, 3.6 - tier_index * 0.35)
        panel_height = 1.18 if tier_index < 2 else 0.92
        chamfer = min(0.22, panel_height * 0.22)
        # Front panels flank the processional aperture. Rear panels form a
        # complementary service rhythm without copying the mineral cadence.
        flank_x = stair_corridor_width * 0.5 + panel_width * 0.68
        front_positions = [-flank_x, flank_x]
        outer_x = tw * 0.5 - panel_width * 0.75
        if outer_x > flank_x + panel_width * 0.8:
            front_positions = [-outer_x, -flank_x, flank_x, outer_x]
        for index, x in enumerate(front_positions):
            add_metal_panel(
                f'inset_scifi_front_{tier_index + 1:02d}_{index:02d}',
                'front', x, panel_y, panel_width, panel_height,
                tier_spec, chamfer,
            )
        rear_positions = (-tw * 0.27, 0.0, tw * 0.27)
        for index, x in enumerate(rear_positions):
            add_metal_panel(
                f'inset_scifi_rear_{tier_index + 1:02d}_{index:02d}',
                'rear', x, panel_y, panel_width, panel_height,
                tier_spec, chamfer,
            )
        side_positions = (-td * 0.22, td * 0.22) if td > 16 else (0.0,)
        for face in ('left', 'right'):
            for index, z in enumerate(side_positions):
                add_metal_panel(
                    f'inset_scifi_{face}_{tier_index + 1:02d}_{index:02d}',
                    face, z, panel_y, panel_width, panel_height,
                    tier_spec, chamfer,
                )
    join_objects(metal_panels, 'scifi_inset_metal_panels', metal)
    joined_fasteners = join_objects(
        metal_fasteners, 'scifi_panel_corner_fasteners', fastener_decal,
    )
    joined_fasteners['support_plate_size_m'] = FASTENER_SUPPORT_SIZE_M
    joined_fasteners['visual_fastener_diameter_m'] = FASTENER_VISIBLE_DIAMETER_M
    joined_fasteners['chamfer_clearance_m'] = FASTENER_CHAMFER_CLEARANCE_M
    joined_fasteners['normal_map'] = True
    joined_fasteners['normal_map_source'] = 'ambientCG Metal010 NormalGL (CC0)'
    joined_fasteners.data['fastener_revision'] = 'corner_v2'
    joined_fasteners.data['support_plate_size_m'] = FASTENER_SUPPORT_SIZE_M
    joined_fasteners.data['visual_fastener_diameter_m'] = FASTENER_VISIBLE_DIAMETER_M
    joined_fasteners.data['chamfer_clearance_m'] = FASTENER_CHAMFER_CLEARANCE_M

    # High-segment cylindrical summit dais; no extra pyramidal taper.
    lower = add_vertical_cylinder(
        'stone_summit_plinth', (0, 22.325, 0),
        4.7, 1.05, sandstone, 96, 0.08,
    )
    upper = add_vertical_cylinder(
        'stone_orb_dais', (0, 23.21, 0),
        3.55, 0.72, sandstone, 96, 0.065,
    )
    lower['walkable_top_y'] = 22.85
    upper['walkable_top_y'] = 23.57

    # One recessed metal reveal locks the stone dais together. No detached
    # emitter boxes or upward fixtures are authored here: red/blue light comes
    # from the existing emissive islands on the Inanna sphere GLB itself.
    add_vertical_cylinder(
        'scifi_dais_inset_metal_reveal', (0, 22.96, 0),
        4.38, 0.18, metal, 96, 0.025,
    )

    root = bpy.data.objects.new('ziggurat_architecture_root', None)
    bpy.context.collection.objects.link(root)
    for obj in list(bpy.context.scene.objects):
        if obj != root and obj.type == 'MESH' and obj.parent is None:
            obj.parent = root
    root['coordinate_system'] = 'Eanpa local Y-up; stair approaches from +Z'
    root['architectural_reference'] = 'ziggurat_architecture_reference.svg'
    root['summit_y'] = 21.8
    root['stair_top_y'] = stair_top_y
    root['stair_front_y'] = stair_front_y
    root['stair_steps'] = stair_steps
    root['stair_riser_m'] = 0.20
    root['stair_tread_m'] = 0.30
    root['landing_depth_m'] = 1.60
    root['gate_forecourt_clearance_m'] = 4.65
    root['walkable_stair_half_width'] = stair_width * 0.5
    root['stair_flights'] = len(stair_profile)
    root['stair_landings'] = len(stair_profile) - 1
    root['stair_profile'] = ';'.join(
        f'{front_z},{back_z},{front_y},{back_y},{steps},{landing_back}'
        for front_z, back_z, front_y, back_y, steps, landing_back in stair_profile
    )
    root['lighting_source'] = 'Inanna sphere emissive side meshes; no detached fixtures'
    root['panel_corner_fasteners'] = len(metal_fasteners)
    root['fastener_revision'] = 'corner_v2'
    root['fastener_support_plate_size_m'] = FASTENER_SUPPORT_SIZE_M
    root['fastener_visible_diameter_m'] = FASTENER_VISIBLE_DIAMETER_M
    root['fastener_chamfer_clearance_m'] = FASTENER_CHAMFER_CLEARANCE_M
    root['fastener_normal_map'] = 'ambientCG Metal010 NormalGL (CC0)'
    root['fastener_style'] = 'generated RGBA recessed decals; 5 mm proud; 0.090 m visible diameter; 0.235 m support; Metal010 normal-mapped'
    root['material_language'] = 'rectilinear terraced stone; inset Harness minerals; ambientCG CC0 brushed metal; generated flush fastener decals'

    # Organize the retained Blend source by architectural responsibility. GLB
    # hierarchy stays under one root, while artists get predictable collections
    # for stone masses, traversal geometry, mineral work, and sci-fi metal.
    master_collection = bpy.data.collections.new('00_ZIGGURAT_ARCHITECTURE')
    scene.collection.children.link(master_collection)
    source_collections = {
        'masonry': bpy.data.collections.new('10_MASONRY_TIERS_AND_DAIS'),
        'stairs': bpy.data.collections.new('20_PROCESSIONAL_STAIRS_AND_LANDINGS'),
        'minerals': bpy.data.collections.new('30_LAPIS_AND_CARNELIAN_INLAYS'),
        'metal': bpy.data.collections.new('40_INTEGRATED_SCIFI_METAL'),
    }
    for collection in source_collections.values():
        master_collection.children.link(collection)
    master_collection.objects.link(root)
    for collection in list(root.users_collection):
        if collection != master_collection:
            collection.objects.unlink(root)
    for obj in root.children_recursive:
        key = obj.name.lower()
        if 'lapis' in key or 'carnelian' in key or 'mineral' in key:
            destination = source_collections['minerals']
        elif 'scifi' in key or 'metal' in key:
            destination = source_collections['metal']
        elif 'stair' in key or 'landing' in key or 'threshold' in key or 'retaining' in key:
            destination = source_collections['stairs']
        else:
            destination = source_collections['masonry']
        destination.objects.link(obj)
        for collection in list(obj.users_collection):
            if collection != destination:
                collection.objects.unlink(obj)

    # Boolean/bevel intersections can leave coincident zero-area triangles at
    # exact seam endpoints. Dissolve only mathematical degenerates; retain the
    # intentionally tiny bevel faces that carry the high-detail silhouette.
    audit = {
        'meshes': 0,
        'vertices': 0,
        'triangles': 0,
        'degenerate_faces': 0,
        'nonmanifold_edges': 0,
    }
    for child in root.children_recursive:
        dissolve_exact_degenerates(child)
        if child.type != 'MESH':
            continue
        audit['meshes'] += 1
        audit['vertices'] += len(child.data.vertices)
        audit['triangles'] += len(child.data.polygons)
        bm = bmesh.new()
        bm.from_mesh(child.data)
        audit['degenerate_faces'] += sum(face.calc_area() <= 1.0e-12 for face in bm.faces)
        audit['nonmanifold_edges'] += sum(len(edge.link_faces) != 2 for edge in bm.edges)
        bm.free()
    if audit['degenerate_faces'] or audit['nonmanifold_edges']:
        raise RuntimeError(f'Ziggurat closed-mesh audit failed: {audit}')
    root['audit_zero_degenerate_faces'] = True
    root['audit_zero_nonmanifold_edges'] = True
    root['audit_triangles'] = audit['triangles']

    bpy.ops.object.select_all(action='DESELECT')
    root.select_set(True)
    for child in root.children_recursive:
        child.select_set(True)
    bpy.context.view_layer.objects.active = root

    # Runtime loads the optimized external PBR/decal files exactly once. Swap
    # only the export slots to scalar materials with identical names, then
    # restore the full node materials before packing the editable Blend.
    export_material_specs = [
        (sandstone, 'SandstonePBR', (0.54, 0.38, 0.23), 0.86, 0.0),
        (lapis, 'LapisPBR', (0.018, 0.085, 0.31), 0.20, 0.05),
        (carnelian, 'CarnelianPBR', (0.55, 0.055, 0.018), 0.24, 0.02),
        (metal, 'SciFiMetal', (0.12, 0.16, 0.19), 0.58, 0.78),
        (fastener_decal, 'FastenerDecal', (0.32, 0.34, 0.35), 0.48, 0.78),
    ]
    export_placeholders = []
    replacement_by_pointer = {}
    for source, slot_name, color, roughness, metallic in export_material_specs:
        source.name = f'{slot_name}__EDITABLE_SOURCE'
        placeholder = make_material(slot_name, color, roughness, metallic=metallic)
        placeholder['runtime_payload'] = 'scalar name-preserving slot; PBR loaded externally'
        export_placeholders.append(placeholder)
        replacement_by_pointer[source.as_pointer()] = placeholder

    restored_slots = []
    for child in root.children_recursive:
        if child.type != 'MESH':
            continue
        for slot in child.material_slots:
            source = slot.material
            if source is None:
                continue
            placeholder = replacement_by_pointer.get(source.as_pointer())
            if placeholder is None:
                continue
            restored_slots.append((slot, source))
            slot.material = placeholder
    root['runtime_material_payload'] = 'named scalar slots; external optimized PBR/decal maps'

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
        for slot, source in restored_slots:
            slot.material = source
        for placeholder in export_placeholders:
            bpy.data.materials.remove(placeholder)
        for source, slot_name, _color, _roughness, _metallic in export_material_specs:
            source.name = slot_name
    blend_path = os.path.splitext(output_path)[0] + '.blend'
    # Keep the editable handoff self-contained with its CC0 metal and generated
    # decal sources. The GLB retains material identities so runtime can route
    # each authored slot before applying its calibrated triplanar materials.
    bpy.ops.file.pack_all()
    bpy.ops.wm.save_as_mainfile(filepath=blend_path)
    print('Exported', output_path)
    print('Saved editable source', blend_path)
    print('Geometry audit', audit)
    print('Stair schedule', {
        'steps': stair_steps,
        'riser': 0.20,
        'tread': 0.30,
        'landings': len(stair_profile) - 1,
        'landingDepth': 1.60,
        'width': stair_width,
        'frontZ': stair_front_z,
        'backZ': stair_back_z,
    })


if __name__ == '__main__':
    args = sys.argv
    output = args[args.index('--') + 1] if '--' in args and len(args) > args.index('--') + 1 else None
    if not output:
        output = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', 'assets', 'temple', 'ziggurat_architecture.glb'))
    build(os.path.abspath(output))
