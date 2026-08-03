#!/usr/bin/env python3
"""Render and assemble a numbered review sheet for the runtime desert rocks.

Run this file with the system Python.  It relaunches itself in Blender's
background mode to render the twelve LOD0 meshes at one fixed orthographic
scale, then uses Pillow to add the exact glTF node/mesh/primitive labels.
No browser or game server is involved.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
import struct
import subprocess
import sys


ROOT = Path(__file__).resolve().parents[1]
RUNTIME = ROOT / "assets/terrain/Desert_rock_chunks_12_pieces_runtime_2k_lods.glb"
OUTPUT = ROOT / "artifacts/desert-rock-review"
TILES = OUTPUT / "tiles"
SHEET = OUTPUT / "desert-rock-runtime-lod0-numbered-contact-sheet.png"
MAPPING = OUTPUT / "desert-rock-runtime-lod0-numbered-mapping.json"
TILE_WIDTH = 720
TILE_HEIGHT = 560
REFERENCE_CUBE_METRES = 0.10


def read_glb_json(filename: Path) -> dict:
    with filename.open("rb") as handle:
        if handle.read(4) != b"glTF":
            raise RuntimeError(f"Not a GLB file: {filename}")
        version, declared_length = struct.unpack("<II", handle.read(8))
        if version != 2 or declared_length != filename.stat().st_size:
            raise RuntimeError(f"Invalid GLB header: {filename}")
        while handle.tell() < declared_length:
            length, chunk_type = struct.unpack("<II", handle.read(8))
            payload = handle.read(length)
            if chunk_type == 0x4E4F534A:
                return json.loads(payload.rstrip(b"\0 \t\r\n").decode("utf8"))
    raise RuntimeError(f"GLB has no JSON chunk: {filename}")


def runtime_mapping() -> list[dict]:
    gltf = read_glb_json(RUNTIME)
    mapping = []
    for node_index, node in enumerate(gltf.get("nodes", [])):
        name = node.get("name", "")
        if not (isinstance(node.get("mesh"), int) and name.endswith("_LOD0")):
            continue
        marker = "DesertRockPiece"
        if not name.startswith(marker):
            continue
        piece = int(name[len(marker):len(marker) + 2])
        mesh_index = node["mesh"]
        mesh = gltf["meshes"][mesh_index]
        primitives = mesh.get("primitives", [])
        if len(primitives) != 1:
            raise RuntimeError(f"{name} has {len(primitives)} primitives; expected one")
        mapping.append({
            "piece": piece,
            "sourcePiece": piece,
            "lod": 0,
            "nodeIndex": node_index,
            "node": name,
            "meshIndex": mesh_index,
            "mesh": mesh.get("name", f"mesh {mesh_index}"),
            "submeshIndex": 0,
            "submesh": primitives[0].get("name", "primitive 0"),
        })
    mapping.sort(key=lambda item: item["piece"])
    if [item["piece"] for item in mapping] != list(range(12)):
        raise RuntimeError("Runtime GLB does not expose exactly LOD0 pieces 00 through 11")
    return mapping


def locate_blender() -> Path:
    candidates = [
        os.environ.get("BLENDER"),
        r"C:\Program Files\Blender Foundation\Blender 4.3\blender.exe",
        r"C:\Program Files\Blender Foundation\Blender 4.4\blender.exe",
        r"C:\Program Files\Blender Foundation\Blender 4.5\blender.exe",
    ]
    for candidate in candidates:
        if candidate and Path(candidate).is_file():
            return Path(candidate)
    raise RuntimeError("Blender executable was not found")


def compose_sheet(mapping: list[dict]) -> None:
    from PIL import Image, ImageDraw, ImageFont

    columns, rows = 4, 3
    label_height = 142
    header_height = 116
    cell_width = TILE_WIDTH
    cell_height = TILE_HEIGHT + label_height
    canvas = Image.new(
        "RGB",
        (columns * cell_width, header_height + rows * cell_height),
        (20, 23, 27),
    )
    draw = ImageDraw.Draw(canvas)
    regular_path = Path(r"C:\Windows\Fonts\segoeui.ttf")
    bold_path = Path(r"C:\Windows\Fonts\segoeuib.ttf")
    regular = ImageFont.truetype(str(regular_path), 25)
    small = ImageFont.truetype(str(regular_path), 21)
    bold = ImageFont.truetype(str(bold_path), 38)
    title = ImageFont.truetype(str(bold_path), 34)
    draw.text(
        (24, 14),
        "Runtime desert-rock LOD0 visual index — authored scale preserved",
        font=title,
        fill=(245, 247, 250),
    )
    draw.text(
        (24, 62),
        "Fixed orthographic camera/light/scale for every tile • orange cube = 0.10 m",
        font=regular,
        fill=(182, 192, 204),
    )
    for index, item in enumerate(mapping):
        column = index % columns
        row = index // columns
        left = column * cell_width
        top = header_height + row * cell_height
        tile = Image.open(TILES / f"piece{item['piece']:02d}.png").convert("RGB")
        if tile.size != (TILE_WIDTH, TILE_HEIGHT):
            raise RuntimeError(f"Unexpected tile size for piece {item['piece']:02d}: {tile.size}")
        canvas.paste(tile, (left, top))
        band_top = top + TILE_HEIGHT
        draw.rectangle(
            (left, band_top, left + cell_width - 1, top + cell_height - 1),
            fill=(28, 32, 38),
            outline=(79, 88, 99),
            width=2,
        )
        draw.text(
            (left + 16, band_top + 8),
            f"piece {item['piece']:02d}",
            font=bold,
            fill=(255, 205, 92),
        )
        draw.text(
            (left + 176, band_top + 12),
            f"node: {item['node']}",
            font=regular,
            fill=(240, 242, 245),
        )
        draw.text(
            (left + 16, band_top + 59),
            f"mesh: {item['mesh']}",
            font=small,
            fill=(205, 213, 222),
        )
        draw.text(
            (left + 16, band_top + 96),
            f"submesh: {item['submesh']}  (index {item['submeshIndex']})",
            font=small,
            fill=(205, 213, 222),
        )
    OUTPUT.mkdir(parents=True, exist_ok=True)
    canvas.save(SHEET, optimize=True)


def orchestrate() -> None:
    mapping = runtime_mapping()
    OUTPUT.mkdir(parents=True, exist_ok=True)
    TILES.mkdir(parents=True, exist_ok=True)
    blender = locate_blender()
    subprocess.run(
        [
            str(blender),
            "--background",
            "--factory-startup",
            "--python",
            str(Path(__file__).resolve()),
            "--",
            "--render-tiles",
        ],
        cwd=ROOT,
        check=True,
    )
    compose_sheet(mapping)
    payload = {
        "schema": "eanpa-desert-rock-runtime-visual-index-v1",
        "runtime": str(RUNTIME.relative_to(ROOT)).replace("\\", "/"),
        "contactSheet": str(SHEET.relative_to(ROOT)).replace("\\", "/"),
        "render": {
            "mode": "Blender background",
            "engine": "BLENDER_EEVEE_NEXT",
            "projection": "orthographic",
            "equalReferenceScale": True,
            "authoredObjectScale": 1.0,
            "referenceCubeMetres": REFERENCE_CUBE_METRES,
            "tilePixels": [TILE_WIDTH, TILE_HEIGHT],
            "consistentCameraLightMaterial": True,
        },
        "pieces": mapping,
    }
    MAPPING.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf8")
    print(SHEET)
    print(MAPPING)


def blender_render_tiles() -> None:
    import bpy
    from mathutils import Matrix, Vector

    mapping = runtime_mapping()
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    for datablocks in (
        bpy.data.meshes,
        bpy.data.curves,
        bpy.data.materials,
        bpy.data.cameras,
        bpy.data.lights,
    ):
        for datablock in list(datablocks):
            if datablock.users == 0:
                datablocks.remove(datablock)

    bpy.ops.import_scene.gltf(filepath=str(RUNTIME))
    bpy.context.view_layer.update()
    imported = {obj.name: obj for obj in bpy.context.scene.objects if obj.type == "MESH"}
    lod0_objects = []
    for item in mapping:
        obj = imported.get(item["node"])
        if obj is None:
            raise RuntimeError(f"Blender import did not preserve runtime node {item['node']}")
        lod0_objects.append(obj)
    imported_rocks = [
        obj for obj in bpy.context.scene.objects
        if obj.type == "MESH" and obj.name.startswith("DesertRockPiece")
    ]

    def world_bounds(obj):
        points = [obj.matrix_world @ Vector(corner) for corner in obj.bound_box]
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

    original_matrices = {obj.name: obj.matrix_world.copy() for obj in lod0_objects}
    maximum_extent = 0.0
    for obj in lod0_objects:
        minimum, maximum = world_bounds(obj)
        dimensions = maximum - minimum
        maximum_extent = max(maximum_extent, dimensions.x, dimensions.y, dimensions.z)

    scene = bpy.context.scene
    scene.render.engine = "BLENDER_EEVEE_NEXT"
    scene.render.resolution_x = TILE_WIDTH
    scene.render.resolution_y = TILE_HEIGHT
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGB"
    scene.render.film_transparent = False
    scene.render.use_file_extension = True
    scene.render.image_settings.color_depth = "8"
    scene.view_settings.view_transform = "AgX"
    scene.view_settings.look = "Medium High Contrast"
    scene.view_settings.exposure = 0.2
    scene.view_settings.gamma = 1.0
    world = scene.world
    world.use_nodes = True
    world.node_tree.nodes["Background"].inputs["Color"].default_value = (0.055, 0.065, 0.078, 1)
    world.node_tree.nodes["Background"].inputs["Strength"].default_value = 0.45

    ground_material = bpy.data.materials.new("ContactSheetNeutralGround")
    ground_material.diffuse_color = (0.18, 0.20, 0.23, 1)
    ground_material.use_nodes = True
    ground_principled = ground_material.node_tree.nodes.get("Principled BSDF")
    ground_principled.inputs["Base Color"].default_value = (0.18, 0.20, 0.23, 1)
    ground_principled.inputs["Roughness"].default_value = 0.82
    bpy.ops.mesh.primitive_plane_add(size=maximum_extent * 6, location=(0, 0, 0))
    ground = bpy.context.object
    ground.name = "contact_sheet_ground"
    ground.data.materials.append(ground_material)

    reference_material = bpy.data.materials.new("ContactSheetTenCentimetreReference")
    reference_material.diffuse_color = (0.95, 0.30, 0.045, 1)
    reference_material.use_nodes = True
    reference_principled = reference_material.node_tree.nodes.get("Principled BSDF")
    reference_principled.inputs["Base Color"].default_value = (0.95, 0.30, 0.045, 1)
    reference_principled.inputs["Roughness"].default_value = 0.5
    bpy.ops.mesh.primitive_cube_add(
        size=REFERENCE_CUBE_METRES,
        location=(-maximum_extent * 0.58, -maximum_extent * 0.36, REFERENCE_CUBE_METRES * 0.5),
    )
    reference = bpy.context.object
    reference.name = "ten_centimetre_reference_cube"
    reference.data.materials.append(reference_material)

    camera_data = bpy.data.cameras.new("ContactSheetOrthographicCamera")
    camera = bpy.data.objects.new("ContactSheetOrthographicCamera", camera_data)
    scene.collection.objects.link(camera)
    camera_data.type = "ORTHO"
    camera_data.ortho_scale = maximum_extent * 1.72
    camera_data.lens = 55
    camera_data.clip_start = 0.001
    camera_data.clip_end = maximum_extent * 40
    target = Vector((0, 0, maximum_extent * 0.24))
    camera.location = Vector((3.4, -5.0, 3.15)).normalized() * maximum_extent * 7
    camera.rotation_euler = (target - camera.location).to_track_quat("-Z", "Y").to_euler()
    scene.camera = camera

    def add_area(name, location, energy, size):
        data = bpy.data.lights.new(name, "AREA")
        data.energy = energy
        data.shape = "DISK"
        data.size = size
        obj = bpy.data.objects.new(name, data)
        scene.collection.objects.link(obj)
        obj.location = Vector(location) * maximum_extent
        obj.rotation_euler = (target - obj.location).to_track_quat("-Z", "Y").to_euler()
        return obj

    add_area("contact_sheet_key", (-3.8, -4.2, 6.5), 430, maximum_extent * 4.0)
    add_area("contact_sheet_fill", (4.8, -1.5, 3.8), 210, maximum_extent * 3.2)
    add_area("contact_sheet_rim", (1.5, 4.2, 5.0), 300, maximum_extent * 2.8)

    TILES.mkdir(parents=True, exist_ok=True)
    for item, obj in zip(mapping, lod0_objects):
        for rock in imported_rocks:
            rock.hide_render = rock is not obj
        obj.matrix_world = original_matrices[obj.name]
        bpy.context.view_layer.update()
        minimum, maximum = world_bounds(obj)
        center = (minimum + maximum) * 0.5
        obj.matrix_world = Matrix.Translation(Vector((-center.x, -center.y, -minimum.z))) @ obj.matrix_world
        bpy.context.view_layer.update()
        scene.render.filepath = str(TILES / f"piece{item['piece']:02d}.png")
        bpy.ops.render.render(write_still=True)


try:
    import bpy  # type: ignore  # noqa: F401
except ImportError:
    bpy = None

if bpy is None:
    orchestrate()
else:
    blender_render_tiles()
