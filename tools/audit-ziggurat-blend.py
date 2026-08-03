"""CPU-only audit for the retained editable ziggurat Blender handoff."""

import json

import bpy


EXPECTED_COLLECTIONS = {
    '00_ZIGGURAT_ARCHITECTURE',
    '10_MASONRY_TIERS_AND_DAIS',
    '20_PROCESSIONAL_STAIRS_AND_LANDINGS',
    '30_LAPIS_AND_CARNELIAN_INLAYS',
    '40_INTEGRATED_SCIFI_METAL',
}


def main():
    root = bpy.data.objects.get('ziggurat_architecture_root')
    if root is None:
        raise RuntimeError('Missing ziggurat_architecture_root')
    collections = set(bpy.data.collections.keys())
    missing = sorted(EXPECTED_COLLECTIONS - collections)
    meshes = [obj for obj in root.children_recursive if obj.type == 'MESH']
    material_names = {
        slot.material.name
        for obj in meshes
        for slot in obj.material_slots
        if slot.material
    }
    fasteners = bpy.data.objects.get('scifi_panel_corner_fasteners')
    metal = bpy.data.materials.get('SciFiMetal')
    fastener_material = bpy.data.materials.get('FastenerDecal')
    packed_images = sorted(
        image.name for image in bpy.data.images if image.packed_file is not None
    )
    report = {
        'blend': bpy.data.filepath,
        'root': root.name,
        'meshes': len(meshes),
        'integration_version': root.get('integration_version'),
        'collections': sorted(EXPECTED_COLLECTIONS & collections),
        'missing_collections': missing,
        'materials': sorted(material_names),
        'stair_steps': root.get('stair_steps'),
        'stair_flights': root.get('stair_flights'),
        'stair_landings': root.get('stair_landings'),
        'stair_riser_m': root.get('stair_riser_m'),
        'stair_tread_m': root.get('stair_tread_m'),
        'lighting_source': root.get('lighting_source'),
        'panel_corner_fasteners': root.get('panel_corner_fasteners'),
        'fastener_style': root.get('fastener_style'),
        'fastener_revision': root.get('fastener_revision'),
        'fastener_support_plate_size_m': root.get('fastener_support_plate_size_m'),
        'fastener_visible_diameter_m': root.get('fastener_visible_diameter_m'),
        'fastener_chamfer_clearance_m': root.get('fastener_chamfer_clearance_m'),
        'fastener_uv_layers': list(fasteners.data.uv_layers.keys()) if fasteners else [],
        'metal_pbr_source': metal.get('pbr_source') if metal else None,
        'fastener_generated_asset': fastener_material.get('generated_asset') if fastener_material else None,
        'fastener_normal_map': fastener_material.get('normal_map') if fastener_material else None,
        'fastener_normal_map_source': fastener_material.get('normal_map_source') if fastener_material else None,
        'packed_images': packed_images,
    }
    print(json.dumps(report, indent=2, sort_keys=True))
    if missing:
        raise RuntimeError(f'Missing edit collections: {missing}')
    expected_meshes = 31 if root.get('integration_version') == 'integrated_v2' else 17
    if len(meshes) != expected_meshes:
        raise RuntimeError(
            f'Expected {expected_meshes} authored meshes, found {len(meshes)}'
        )
    fasteners = bpy.data.objects.get('scifi_panel_corner_fasteners')
    if fasteners is None or fasteners.parent != root:
        raise RuntimeError('Mapped panel corner-fastener mesh is missing from the editable handoff')
    if root.get('panel_corner_fasteners') != 176:
        raise RuntimeError('Editable Blend corner-fastener count is stale')
    if not {'SandstonePBR', 'LapisPBR', 'CarnelianPBR', 'SciFiMetal', 'FastenerDecal'} <= material_names:
        raise RuntimeError(f'Incomplete material handoff: {sorted(material_names)}')
    if [slot.material.name for slot in fasteners.material_slots if slot.material] != ['FastenerDecal']:
        raise RuntimeError('Editable fastener mesh is not assigned to FastenerDecal')
    if 'FastenerDecalUV' not in fasteners.data.uv_layers:
        raise RuntimeError('Editable fastener mesh is missing authored decal UVs')
    if 'generated RGBA recessed decals' not in root.get('fastener_style', ''):
        raise RuntimeError('Editable Blend fastener-style metadata is stale')
    if (root.get('fastener_revision') != 'corner_v2'
            or abs(root.get('fastener_support_plate_size_m', 0) - 0.235) > 1.0e-7
            or abs(root.get('fastener_visible_diameter_m', 0) - 0.090) > 1.0e-7
            or abs(root.get('fastener_chamfer_clearance_m', 0) - 0.015) > 1.0e-7):
        raise RuntimeError('Editable Blend fastener size/corner metadata is stale')
    if metal is None or metal.get('pbr_source') != 'ambientCG Metal010 1K JPG (CC0)':
        raise RuntimeError('Editable Blend is missing dedicated ambientCG metal provenance')
    if (fastener_material is None
            or fastener_material.get('generated_asset') != 'assets/temple/decals/panel_fastener_decal-v1.png'):
        raise RuntimeError('Editable Blend is missing generated decal provenance')
    normal_nodes = [
        node for node in fastener_material.node_tree.nodes
        if node.type == 'TEX_IMAGE'
        and node.image
        and node.image.name == 'Metal010_1K-JPG_NormalGL.jpg'
    ] if fastener_material else []
    normal_map_nodes = [
        node for node in fastener_material.node_tree.nodes
        if node.type == 'NORMAL_MAP'
        and abs(node.inputs['Strength'].default_value - 0.34) <= 1.0e-7
    ] if fastener_material else []
    if (fastener_material.get('normal_map') is not True
            or fastener_material.get('normal_map_source') != 'ambientCG Metal010_1K-JPG_NormalGL.jpg (CC0)'
            or len(normal_nodes) != 1
            or len(normal_map_nodes) != 1
            or not normal_map_nodes[0].outputs['Normal'].is_linked):
        raise RuntimeError('Editable FastenerDecal is missing its linked Metal010 NormalGL response')
    required_packed = {
        'Metal010_1K-JPG_Color.jpg',
        'Metal010_1K-JPG_NormalGL.jpg',
        'Metal010_1K-JPG_Roughness.jpg',
        'Metal010_1K-JPG_Metalness.jpg',
        'panel_fastener_decal-v1.png',
    }
    if not required_packed <= set(packed_images):
        raise RuntimeError(f'Editable Blend has unpacked/missing material images: {sorted(required_packed - set(packed_images))}')
    if (root.get('stair_steps'), root.get('stair_flights'), root.get('stair_landings')) != (110, 4, 3):
        raise RuntimeError('Editable Blend stair schedule does not match runtime contract')
    if root.get('lighting_source') != 'Inanna sphere emissive side meshes; no detached fixtures':
        raise RuntimeError('Editable Blend lighting-source contract is stale')


if __name__ == '__main__':
    main()
