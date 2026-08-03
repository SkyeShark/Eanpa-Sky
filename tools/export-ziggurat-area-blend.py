'''Assemble a self-contained, editable Blender scene for the Eanpa compound.

Run Blender with assets/temple/ziggurat_architecture.blend as the input file.
The architecture's authored collections remain intact; Eidoverse perimeter
modules are imported once and linked into the exact runtime socket layout.
'''

import json
import math
import os
import sys

import bpy
from mathutils import Vector


ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
TEMPLE = os.path.join(ROOT, 'assets', 'temple')
PERIMETER = os.path.join(ROOT, 'assets', 'eidoverse', 'perimeter')
PERIMETER_BASE_Y = -0.2708859472739822
ORB_DIAMETER = 4.9
ORB_CENTER_Y = 26.8


def engine_to_blender(point):
    x, y, z = point
    return Vector((x, -z, y))


def new_child(parent, name):
    collection = bpy.data.collections.get(name)
    if collection is not None:
        for scene_parent in list(bpy.data.collections):
            if collection in list(scene_parent.children):
                scene_parent.children.unlink(collection)
        if collection in list(bpy.context.scene.collection.children):
            bpy.context.scene.collection.children.unlink(collection)
        for obj in list(collection.objects):
            bpy.data.objects.remove(obj, do_unlink=True)
        bpy.data.collections.remove(collection)
    collection = bpy.data.collections.new(name)
    parent.children.link(collection)
    return collection


def move_to_collection(objects, target):
    for obj in objects:
        if obj.name not in target.objects:
            target.objects.link(obj)
        for source in list(obj.users_collection):
            if source != target:
                source.objects.unlink(obj)


def hierarchy_bounds(objects):
    points = []
    for obj in objects:
        if obj.type != 'MESH':
            continue
        points.extend(obj.matrix_world @ Vector(corner) for corner in obj.bound_box)
    if not points:
        return Vector((0, 0, 0)), Vector((0, 0, 0))
    minimum = Vector((
        min(point.x for point in points),
        min(point.y for point in points),
        min(point.z for point in points),
    ))
    maximum = Vector((
        max(point.x for point in points),
        max(point.y for point in points),
        max(point.z for point in points),
    ))
    return minimum, maximum


def import_normalized_prototype(filepath, name, collection):
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=filepath)
    imported = list(set(bpy.data.objects) - before)
    move_to_collection(imported, collection)
    imported_set = set(imported)
    roots = [obj for obj in imported if obj.parent not in imported_set]
    minimum, maximum = hierarchy_bounds(imported)
    center = (minimum + maximum) * 0.5
    offset = Vector((-center.x, -center.y, -minimum.z))
    for root in roots:
        root.matrix_world.translation += offset

    wrapper = bpy.data.objects.new(name + '_PROTOTYPE', None)
    collection.objects.link(wrapper)
    for root in roots:
        world = root.matrix_world.copy()
        root.parent = wrapper
        root.matrix_world = world
    wrapper['source_glb'] = os.path.relpath(filepath, ROOT).replace(os.sep, '/')
    wrapper['normalized_to_ground'] = True
    wrapper['asset_dimensions_m'] = tuple(maximum - minimum)
    return wrapper


def duplicate_hierarchy(source, target_collection, name, location, yaw=0.0):
    def recurse(src, parent=None):
        copy = src.copy()
        if getattr(src, 'data', None) is not None:
            copy.data = src.data
        target_collection.objects.link(copy)
        copy.parent = parent
        copy.matrix_local = src.matrix_local.copy()
        for child in src.children:
            recurse(child, copy)
        return copy

    root = recurse(source)
    root.name = name
    root.location = engine_to_blender(location)
    root.rotation_euler.z = yaw
    root['engine_location'] = tuple(location)
    root['engine_yaw_radians'] = yaw
    root['linked_editable_instance'] = True
    return root


def import_orb(filepath, collection):
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=filepath)
    imported = list(set(bpy.data.objects) - before)
    move_to_collection(imported, collection)
    imported_set = set(imported)
    roots = [obj for obj in imported if obj.parent not in imported_set]
    minimum, maximum = hierarchy_bounds(imported)
    center = (minimum + maximum) * 0.5
    size = maximum - minimum
    for root in roots:
        root.matrix_world.translation -= center
    wrapper = bpy.data.objects.new('INANNA_SPHERE_RUNTIME_PIVOT', None)
    collection.objects.link(wrapper)
    for root in roots:
        world = root.matrix_world.copy()
        root.parent = wrapper
        root.matrix_world = world
    wrapper.location = engine_to_blender((0, ORB_CENTER_Y, 0))
    wrapper.scale = (ORB_DIAMETER / max(size),) * 3
    wrapper['source_glb'] = os.path.relpath(filepath, ROOT).replace(os.sep, '/')
    wrapper['runtime_diameter_m'] = ORB_DIAMETER
    wrapper['runtime_center_engine'] = (0.0, ORB_CENTER_Y, 0.0)
    return wrapper


def add_guides(collection):
    bpy.ops.mesh.primitive_plane_add(size=2, location=engine_to_blender((0, -0.34, 0)))
    ground = bpy.context.object
    ground.name = 'REFERENCE_ONLY_compound_ground_datum'
    ground.scale = (58, 58, 1)
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    ground.display_type = 'WIRE'
    ground.hide_render = True
    ground['reference_only'] = True
    ground['note'] = 'Runtime terrain is procedural and intentionally not baked into this edit file.'
    move_to_collection([ground], collection)

    origin = bpy.data.objects.new('ENGINE_COMPOUND_ORIGIN_world_x0_z-72', None)
    collection.objects.link(origin)
    origin.empty_display_type = 'ARROWS'
    origin.empty_display_size = 3
    origin['runtime_world_center'] = (0.0, -72.0)
    origin['axis_conversion'] = 'engine (x,y,z) -> Blender (x,-z,y)'


def main(output_path):
    scene = bpy.context.scene
    scene.unit_settings.system = 'METRIC'
    scene.unit_settings.length_unit = 'METERS'
    scene['eanpa_editable_area'] = True
    scene['engine_compound_world_center'] = (0.0, -72.0)
    scene['perimeter_base_engine_y'] = PERIMETER_BASE_Y
    scene['orb_runtime_diameter_m'] = ORB_DIAMETER

    old_area = bpy.data.collections.get('EANPA_ZIGGURAT_AREA_EDITABLE')
    if old_area is not None:
        bpy.data.collections.remove(old_area)
    area = bpy.data.collections.new('EANPA_ZIGGURAT_AREA_EDITABLE')
    scene.collection.children.link(area)

    architecture = bpy.data.collections.get('00_ZIGGURAT_ARCHITECTURE')
    if architecture is None:
        raise RuntimeError('Input Blend is missing 00_ZIGGURAT_ARCHITECTURE')
    for parent in list(bpy.data.collections):
        if architecture in list(parent.children):
            parent.children.unlink(architecture)
    if architecture in list(scene.collection.children):
        scene.collection.children.unlink(architecture)
    area.children.link(architecture)

    gate_collection = new_child(area, '10_EIDOVERSE_MAIN_GATE')
    walls_collection = new_child(area, '20_EIDOVERSE_WALL_BAYS')
    supports_collection = new_child(area, '30_EIDOVERSE_PILLARS')
    towers_collection = new_child(area, '40_EIDOVERSE_WATCHTOWERS')
    orb_collection = new_child(area, '50_INANNA_SPHERE')
    guides_collection = new_child(area, '80_EDITING_GUIDES')
    prototypes_collection = new_child(area, '90_LINKED_SOURCE_PROTOTYPES')

    sources = {
        'gate': import_normalized_prototype(
            os.path.join(PERIMETER, 'scifi_perimeter_wall_gate.glb'),
            'EIDOVERSE_GATE', prototypes_collection,
        ),
        'wall': import_normalized_prototype(
            os.path.join(PERIMETER, 'scifi_perimeter_wall_middle_geometry.glb'),
            'EIDOVERSE_WALL_BAY', prototypes_collection,
        ),
        'pillar': import_normalized_prototype(
            os.path.join(PERIMETER, 'scifi_perimeter_wall_pillar_geometry.glb'),
            'EIDOVERSE_PILLAR', prototypes_collection,
        ),
        'watchtower': import_normalized_prototype(
            os.path.join(PERIMETER, 'scifi_perimeter_watchtower_geometry.glb'),
            'EIDOVERSE_WATCHTOWER', prototypes_collection,
        ),
    }

    quarter_turn = math.pi * 0.5
    front_z = 48
    back_z = -42
    side_x = 40
    bay = 10
    placements = []

    def place(kind, name, x, z, yaw=0.0):
        target = {
            'gate': gate_collection,
            'wall': walls_collection,
            'pillar': supports_collection,
            'watchtower': towers_collection,
        }[kind]
        placements.append(duplicate_hierarchy(
            sources[kind], target, name, (x, PERIMETER_BASE_Y, z), yaw,
        ))

    place('gate', 'authored_main_gate', 0, front_z, quarter_turn)
    for side in (-1, 1):
        for x in (15, 25, 35):
            place('wall', f'front_wall_{side}_{x}', side * x, front_z, quarter_turn)
        for x in (20, 30):
            place('pillar', f'front_pillar_{side}_{x}', side * x, front_z)
        place('watchtower', f'front_corner_watchtower_{side}', side * side_x, front_z)
        place('watchtower', f'rear_corner_watchtower_{side}', side * side_x, back_z)
        for index in range(9):
            z = front_z - (index + 0.5) * bay
            place('wall', f'side_wall_{side}_{z}', side * side_x, z)
        for index in range(1, 9):
            z = front_z - index * bay
            place('pillar', f'side_pillar_{side}_{z}', side * side_x, z)
    for index in range(8):
        x = -side_x + (index + 0.5) * bay
        place('wall', f'rear_wall_{x}', x, back_z, quarter_turn)
    for index in range(1, 8):
        x = -side_x + index * bay
        place('pillar', f'rear_pillar_{x}', x, back_z)

    import_orb(os.path.join(TEMPLE, 'inanna_orb.glb'), orb_collection)
    add_guides(guides_collection)
    prototypes_collection.hide_render = True
    prototypes_collection.hide_viewport = True

    scene['perimeter_instance_count'] = len(placements)
    scene['perimeter_gate_count'] = 1
    scene['perimeter_wall_bay_count'] = 32
    scene['perimeter_pillar_count'] = 27
    scene['perimeter_watchtower_count'] = 4
    scene['gate_has_integrated_posts_no_extra_pillars'] = True

    bpy.ops.wm.save_as_mainfile(filepath=output_path, compress=True)
    print(json.dumps({
        'output': output_path,
        'perimeter_instances': len(placements),
        'collections': [collection.name for collection in area.children],
        'orb_diameter_m': ORB_DIAMETER,
        'prototype_mesh_data_linked': True,
    }, indent=2))


if __name__ == '__main__':
    arguments = sys.argv
    output = (
        arguments[arguments.index('--') + 1]
        if '--' in arguments and len(arguments) > arguments.index('--') + 1
        else os.path.join(TEMPLE, 'eanpa_ziggurat_area_editable.blend')
    )
    main(os.path.abspath(output))
