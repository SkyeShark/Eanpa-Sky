#!/usr/bin/env python3
"""CPU-only visual index for the twelve runtime desert-rock LOD0 meshes.

The renderer reads positions and indices directly from the runtime GLB, uses a
fixed orthographic camera and global authored scale, painter-sorts the visible
triangles, and applies neutral Lambert shading.  Pillow assembles all twelve
tiles in the same process.  No Blender, browser, game server, or GPU is used.
"""

from __future__ import annotations

import json
import math
from pathlib import Path
import struct

from PIL import Image, ImageDraw, ImageFilter, ImageFont


ROOT = Path(__file__).resolve().parents[1]
RUNTIME = ROOT / "assets/terrain/Desert_rock_chunks_12_pieces_runtime_2k_lods.glb"
LOD_MANIFEST = ROOT / "assets/terrain/desert_rock_chunks_runtime_lods.json"
OUTPUT = ROOT / "artifacts/desert-rock-review"
SHEET = OUTPUT / "desert-rock-runtime-lod0-numbered-contact-sheet.png"
MAPPING = OUTPUT / "desert-rock-runtime-lod0-numbered-mapping.json"
TILE_WIDTH = 720
TILE_HEIGHT = 560
LABEL_HEIGHT = 142
HEADER_HEIGHT = 116
REFERENCE_CUBE_METRES = 0.10


def add(a, b):
    return (a[0] + b[0], a[1] + b[1], a[2] + b[2])


def subtract(a, b):
    return (a[0] - b[0], a[1] - b[1], a[2] - b[2])


def multiply(a, value):
    return (a[0] * value, a[1] * value, a[2] * value)


def dot(a, b):
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]


def cross(a, b):
    return (
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    )


def normalize(value):
    length = math.sqrt(max(dot(value, value), 1e-30))
    return multiply(value, 1.0 / length)


def matrix_multiply(left, right):
    return tuple(tuple(
        sum(left[row][inner] * right[inner][column] for inner in range(4))
        for column in range(4)
    ) for row in range(4))


def transform_point(matrix, point):
    value = (point[0], point[1], point[2], 1.0)
    result = tuple(sum(matrix[row][column] * value[column] for column in range(4))
                   for row in range(4))
    return (result[0] / result[3], result[1] / result[3], result[2] / result[3])


IDENTITY = (
    (1.0, 0.0, 0.0, 0.0),
    (0.0, 1.0, 0.0, 0.0),
    (0.0, 0.0, 1.0, 0.0),
    (0.0, 0.0, 0.0, 1.0),
)


def node_matrix(node):
    if "matrix" in node:
        values = node["matrix"]
        return tuple(tuple(values[column * 4 + row] for column in range(4))
                     for row in range(4))
    tx, ty, tz = node.get("translation", (0.0, 0.0, 0.0))
    sx, sy, sz = node.get("scale", (1.0, 1.0, 1.0))
    x, y, z, w = node.get("rotation", (0.0, 0.0, 0.0, 1.0))
    xx, yy, zz = x * x, y * y, z * z
    xy, xz, yz = x * y, x * z, y * z
    wx, wy, wz = w * x, w * y, w * z
    return (
        ((1 - 2 * (yy + zz)) * sx, (2 * (xy - wz)) * sy,
         (2 * (xz + wy)) * sz, tx),
        ((2 * (xy + wz)) * sx, (1 - 2 * (xx + zz)) * sy,
         (2 * (yz - wx)) * sz, ty),
        ((2 * (xz - wy)) * sx, (2 * (yz + wx)) * sy,
         (1 - 2 * (xx + yy)) * sz, tz),
        (0.0, 0.0, 0.0, 1.0),
    )


def parse_glb(filename):
    data = filename.read_bytes()
    if data[:4] != b"glTF" or struct.unpack_from("<I", data, 4)[0] != 2:
        raise RuntimeError(f"Invalid GLB header: {filename}")
    if struct.unpack_from("<I", data, 8)[0] != len(data):
        raise RuntimeError(f"GLB declared length mismatch: {filename}")
    offset = 12
    gltf = None
    binary = None
    while offset < len(data):
        length, chunk_type = struct.unpack_from("<II", data, offset)
        offset += 8
        chunk = data[offset:offset + length]
        offset += length
        if chunk_type == 0x4E4F534A:
            gltf = json.loads(chunk.rstrip(b"\0 \t\r\n").decode("utf8"))
        elif chunk_type == 0x004E4942:
            binary = chunk
    if gltf is None or binary is None:
        raise RuntimeError(f"GLB lacks JSON or BIN chunk: {filename}")
    return gltf, binary


COMPONENT_FORMAT = {
    5120: "b",
    5121: "B",
    5122: "h",
    5123: "H",
    5125: "I",
    5126: "f",
}
TYPE_COMPONENTS = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4}


def read_accessor(gltf, binary, accessor_index):
    accessor = gltf["accessors"][accessor_index]
    view = gltf["bufferViews"][accessor["bufferView"]]
    component_format = COMPONENT_FORMAT[accessor["componentType"]]
    components = TYPE_COMPONENTS[accessor["type"]]
    component_bytes = struct.calcsize("<" + component_format)
    stride = view.get("byteStride", components * component_bytes)
    start = view.get("byteOffset", 0) + accessor.get("byteOffset", 0)
    unpack_format = "<" + component_format * components
    values = []
    for index in range(accessor["count"]):
        item = struct.unpack_from(unpack_format, binary, start + index * stride)
        values.append(item[0] if components == 1 else item)
    return values


def world_matrices(gltf):
    parents = {}
    for parent, node in enumerate(gltf.get("nodes", [])):
        for child in node.get("children", []):
            parents[child] = parent
    cache = {}

    def resolve(index):
        if index in cache:
            return cache[index]
        local = node_matrix(gltf["nodes"][index])
        cache[index] = (matrix_multiply(resolve(parents[index]), local)
                        if index in parents else local)
        return cache[index]

    return [resolve(index) for index in range(len(gltf.get("nodes", [])))]


def load_pieces():
    gltf, binary = parse_glb(RUNTIME)
    matrices = world_matrices(gltf)
    manifest = json.loads(LOD_MANIFEST.read_text(encoding="utf8"))
    manifest_pieces = manifest["asset"]["pieces"]
    pieces = []
    for node_index, node in enumerate(gltf.get("nodes", [])):
        name = node.get("name", "")
        if not (name.startswith("DesertRockPiece") and name.endswith("_LOD0")
                and isinstance(node.get("mesh"), int)):
            continue
        piece_index = int(name[len("DesertRockPiece"):len("DesertRockPiece") + 2])
        mesh_index = node["mesh"]
        mesh = gltf["meshes"][mesh_index]
        primitives = mesh.get("primitives", [])
        if len(primitives) != 1:
            raise RuntimeError(f"{name} has {len(primitives)} primitives; expected one")
        primitive = primitives[0]
        positions = read_accessor(gltf, binary, primitive["attributes"]["POSITION"])
        positions = [transform_point(matrices[node_index], point) for point in positions]
        indices = read_accessor(gltf, binary, primitive["indices"])
        triangles = [tuple(indices[offset:offset + 3])
                     for offset in range(0, len(indices), 3)]
        minimum = tuple(min(point[axis] for point in positions) for axis in range(3))
        maximum = tuple(max(point[axis] for point in positions) for axis in range(3))
        center = ((minimum[0] + maximum[0]) * 0.5, minimum[1],
                  (minimum[2] + maximum[2]) * 0.5)
        centered = [subtract(point, center) for point in positions]
        dimensions = tuple(maximum[axis] - minimum[axis] for axis in range(3))
        manifest_piece = manifest_pieces[piece_index]
        pieces.append({
            "piece": piece_index,
            "sourcePiece": manifest_piece["piece"],
            "sourceCenter": manifest_piece["sourceCenter"],
            "nodeIndex": node_index,
            "node": name,
            "meshIndex": mesh_index,
            "mesh": mesh.get("name", f"mesh {mesh_index}"),
            "submeshIndex": 0,
            "submesh": primitive.get("name", "primitive 0"),
            "positions": centered,
            "triangles": triangles,
            "dimensionsMetres": dimensions,
            "triangleCount": len(triangles),
        })
    pieces.sort(key=lambda item: item["piece"])
    if [item["piece"] for item in pieces] != list(range(12)):
        raise RuntimeError("Runtime GLB does not expose exactly LOD0 pieces 00 through 11")
    return pieces


VIEW_DIRECTION = normalize((3.4, 3.15, 5.0))
CAMERA_RIGHT = normalize(cross((0.0, 1.0, 0.0), VIEW_DIRECTION))
CAMERA_UP = normalize(cross(VIEW_DIRECTION, CAMERA_RIGHT))
LIGHT_DIRECTION = normalize((-0.45, 0.90, 0.55))


def project(point):
    return (dot(point, CAMERA_RIGHT), dot(point, CAMERA_UP), dot(point, VIEW_DIRECTION))


def cube_geometry(center, size):
    x, y, z = center
    half = size * 0.5
    vertices = [
        (x + dx * half, y + (dy + 1) * half, z + dz * half)
        for dy in (-1, 1) for dz in (-1, 1) for dx in (-1, 1)
    ]
    triangles = [
        (0, 1, 3), (0, 3, 2), (4, 7, 5), (4, 6, 7),
        (0, 4, 5), (0, 5, 1), (2, 3, 7), (2, 7, 6),
        (0, 2, 6), (0, 6, 4), (1, 5, 7), (1, 7, 3),
    ]
    return vertices, triangles


def render_triangle_model(image, vertices, triangles, origin, scale, base_color):
    draw = ImageDraw.Draw(image)
    projected = [project(point) for point in vertices]
    visible = []
    for triangle in triangles:
        a, b, c = (vertices[index] for index in triangle)
        normal = normalize(cross(subtract(b, a), subtract(c, a)))
        facing = dot(normal, VIEW_DIRECTION)
        if facing <= 1e-7:
            continue
        lambert = 0.34 + 0.66 * max(0.0, dot(normal, LIGHT_DIRECTION))
        rim = 0.08 * (1.0 - min(1.0, facing))
        factor = min(1.20, lambert + rim)
        color = tuple(max(0, min(255, round(channel * factor))) for channel in base_color)
        points = tuple((origin[0] + projected[index][0] * scale,
                        origin[1] - projected[index][1] * scale)
                       for index in triangle)
        depth = sum(projected[index][2] for index in triangle) / 3.0
        visible.append((depth, points, color))
    visible.sort(key=lambda item: item[0])
    for _, points, color in visible:
        draw.polygon(points, fill=color)


def render_tile(piece, global_bounds, reference_center):
    min_u, max_u, min_v, max_v = global_bounds
    span_u = max_u - min_u
    span_v = max_v - min_v
    scale = min((TILE_WIDTH - 54) / span_u, (TILE_HEIGHT - 48) / span_v)
    origin = (
        TILE_WIDTH * 0.5 - (min_u + max_u) * 0.5 * scale,
        TILE_HEIGHT * 0.5 + (min_v + max_v) * 0.5 * scale,
    )
    image = Image.new("RGB", (TILE_WIDTH, TILE_HEIGHT), (45, 51, 59))
    draw = ImageDraw.Draw(image)
    ground_y = origin[1]
    draw.rectangle((0, ground_y, TILE_WIDTH, TILE_HEIGHT), fill=(54, 60, 67))

    projected = [project(point) for point in piece["positions"]]
    rock_min_u = min(value[0] for value in projected)
    rock_max_u = max(value[0] for value in projected)
    base_x = origin[0]
    base_y = origin[1]
    shadow = Image.new("RGBA", image.size, (0, 0, 0, 0))
    shadow_draw = ImageDraw.Draw(shadow)
    shadow_width = max(42, (rock_max_u - rock_min_u) * scale * 0.86)
    shadow_draw.ellipse(
        (base_x - shadow_width * 0.55, base_y - shadow_width * 0.08,
         base_x + shadow_width * 0.55, base_y + shadow_width * 0.17),
        fill=(0, 0, 0, 112),
    )
    shadow = shadow.filter(ImageFilter.GaussianBlur(max(3, round(shadow_width * 0.045))))
    image = Image.alpha_composite(image.convert("RGBA"), shadow).convert("RGB")

    render_triangle_model(
        image, piece["positions"], piece["triangles"], origin, scale,
        (157, 126, 98),
    )
    cube_vertices, cube_triangles = cube_geometry(reference_center, REFERENCE_CUBE_METRES)
    render_triangle_model(
        image, cube_vertices, cube_triangles, origin, scale,
        (244, 91, 28),
    )
    draw = ImageDraw.Draw(image)
    regular = ImageFont.truetype(r"C:\Windows\Fonts\segoeui.ttf", 19)
    draw.rounded_rectangle((14, 13, 162, 45), radius=8, fill=(21, 25, 30), outline=(98, 108, 120))
    draw.text((25, 17), "LOD0 • 0.10 m cube", font=regular, fill=(231, 235, 240))
    return image


def main():
    pieces = load_pieces()
    maximum_horizontal = max(max(item["dimensionsMetres"][0], item["dimensionsMetres"][2])
                             for item in pieces)
    reference_center = (-maximum_horizontal * 0.70, 0.0, maximum_horizontal * 0.43)
    reference_vertices, _ = cube_geometry(reference_center, REFERENCE_CUBE_METRES)
    min_u = math.inf
    max_u = -math.inf
    min_v = math.inf
    max_v = -math.inf
    for item in pieces:
        for point in item["positions"] + reference_vertices:
            u, v, _ = project(point)
            min_u = min(min_u, u)
            max_u = max(max_u, u)
            min_v = min(min_v, v)
            max_v = max(max_v, v)
    padding_u = (max_u - min_u) * 0.09
    padding_v = (max_v - min_v) * 0.10
    global_bounds = (min_u - padding_u, max_u + padding_u,
                     min_v - padding_v, max_v + padding_v)

    columns, rows = 4, 3
    cell_height = TILE_HEIGHT + LABEL_HEIGHT
    canvas = Image.new(
        "RGB",
        (columns * TILE_WIDTH, HEADER_HEIGHT + rows * cell_height),
        (20, 23, 27),
    )
    draw = ImageDraw.Draw(canvas)
    regular = ImageFont.truetype(r"C:\Windows\Fonts\segoeui.ttf", 25)
    small = ImageFont.truetype(r"C:\Windows\Fonts\segoeui.ttf", 21)
    bold = ImageFont.truetype(r"C:\Windows\Fonts\segoeuib.ttf", 38)
    title = ImageFont.truetype(r"C:\Windows\Fonts\segoeuib.ttf", 34)
    draw.text(
        (24, 14),
        "Runtime desert-rock LOD0 visual index — authored scale preserved",
        font=title,
        fill=(245, 247, 250),
    )
    draw.text(
        (24, 62),
        "CPU orthographic render • fixed camera/global scale/light • orange cube = 0.10 m",
        font=regular,
        fill=(182, 192, 204),
    )
    for index, item in enumerate(pieces):
        column = index % columns
        row = index // columns
        left = column * TILE_WIDTH
        top = HEADER_HEIGHT + row * cell_height
        canvas.paste(render_tile(item, global_bounds, reference_center), (left, top))
        band_top = top + TILE_HEIGHT
        draw.rectangle(
            (left, band_top, left + TILE_WIDTH - 1, top + cell_height - 1),
            fill=(28, 32, 38),
            outline=(79, 88, 99),
            width=2,
        )
        draw.text((left + 16, band_top + 8), f"piece {item['piece']:02d}",
                  font=bold, fill=(255, 205, 92))
        draw.text((left + 176, band_top + 12), f"node: {item['node']}",
                  font=regular, fill=(240, 242, 245))
        draw.text((left + 16, band_top + 59), f"mesh: {item['mesh']}",
                  font=small, fill=(205, 213, 222))
        draw.text(
            (left + 16, band_top + 96),
            f"submesh: {item['submesh']}  (index {item['submeshIndex']})",
            font=small,
            fill=(205, 213, 222),
        )

    OUTPUT.mkdir(parents=True, exist_ok=True)
    canvas.save(SHEET, optimize=True)
    public_pieces = []
    for item in pieces:
        public_pieces.append({key: value for key, value in item.items()
                              if key not in ("positions", "triangles")})
    mapping = {
        "schema": "eanpa-desert-rock-runtime-visual-index-v1",
        "runtime": str(RUNTIME.relative_to(ROOT)).replace("\\", "/"),
        "contactSheet": str(SHEET.relative_to(ROOT)).replace("\\", "/"),
        "render": {
            "mode": "single-process CPU triangle renderer",
            "projection": "orthographic",
            "cameraDirection": VIEW_DIRECTION,
            "equalReferenceScale": True,
            "authoredObjectScale": 1.0,
            "referenceCubeMetres": REFERENCE_CUBE_METRES,
            "tilePixels": [TILE_WIDTH, TILE_HEIGHT],
            "consistentCameraLightMaterial": True,
            "shading": "neutral Lambert plus ambient",
        },
        "pieces": public_pieces,
    }
    MAPPING.write_text(json.dumps(mapping, indent=2) + "\n", encoding="utf8")
    print(SHEET)
    print(MAPPING)


if __name__ == "__main__":
    main()
