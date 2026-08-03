#!/usr/bin/env python3
"""Build Eanpa's image-authored desert escarpments and explicit mesh LODs.

Run with Blender 4.3+:
  blender --background --factory-startup --python tools/build-authored-escarpments-blender.py

The retained gray16 map owns the broad plan/cap.  This stage adds distinct
side-profile terracing and forward rim shear, closes every mesh below grade,
encodes cap/face/talus/macro data in COLOR_0, bakes three LODs, saves an
editable Blend file, and exports a texture-free GLB for the browser runtime.
"""

from __future__ import annotations

import hashlib
import json
import math
from pathlib import Path

import bmesh
import bpy
import numpy as np


ROOT = Path(__file__).resolve().parents[1]
HEIGHTMAP = ROOT / "assets" / "terrain" / "painted_escarpment_height_v1.png"
HEIGHT_MANIFEST = ROOT / "assets" / "terrain" / "painted_escarpment_height_v1.json"
OUTPUT_BLEND = ROOT / "assets" / "terrain" / "authored_escarpments_v1.blend"
OUTPUT_GLB = ROOT / "assets" / "terrain" / "authored_escarpments_v1.glb"
OUTPUT_REPORT = ROOT / "assets" / "terrain" / "authored_escarpments_v1.json"

LOD_RATIOS = (1.0, 0.34, 0.11)
LOD_DISTANCES_METRES = (0, 760, 1450)
BURY_DEPTH = 4.5
BOTTOM_DEPTH = 34.0

# Each crop owns a genuinely different generated landform.  World dimensions
# are final engine metres; no runtime non-uniform scaling hides repetition.
MODULES = (
    {
        "name": "WesternButtress",
        "crop": (0.035, 0.105, 0.525, 0.805),
        "size": (510.0, 286.0, 94.0),
        "grid": (177, 121),
        "terraces": 7,
        "terrace_strength": 0.16,
        "overhang": 13.5,
        "phase": 0.37,
    },
    {
        "name": "NorthernShoulder",
        "crop": (0.350, 0.205, 0.685, 0.810),
        "size": (352.0, 222.0, 76.0),
        "grid": (145, 105),
        "terraces": 5,
        "terrace_strength": 0.11,
        "overhang": 9.5,
        "phase": 1.81,
    },
    {
        "name": "EasternFins",
        "crop": (0.555, 0.195, 0.900, 0.810),
        "size": (388.0, 238.0, 81.0),
        "grid": (153, 109),
        "terraces": 9,
        "terrace_strength": 0.14,
        "overhang": 11.0,
        "phase": 3.13,
    },
    {
        "name": "FarOutlier",
        "crop": (0.715, 0.405, 0.980, 0.845),
        "size": (264.0, 178.0, 57.0),
        "grid": (121, 89),
        "terraces": 6,
        "terrace_strength": 0.09,
        "overhang": 7.0,
        "phase": 4.67,
    },
)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def smoothstep(value: np.ndarray | float) -> np.ndarray | float:
    value = np.clip(value, 0.0, 1.0)
    return value * value * (3.0 - 2.0 * value)


def reset_scene() -> None:
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    for collection in tuple(bpy.data.collections):
        if collection.name != "Collection":
            bpy.data.collections.remove(collection)
    root_collection = bpy.context.scene.collection.children.get("Collection")
    if root_collection:
        root_collection.name = "Eanpa Authored Escarpments v1"


def load_heightmap() -> np.ndarray:
    image = bpy.data.images.load(str(HEIGHTMAP), check_existing=False)
    try:
        image.colorspace_settings.name = "Non-Color"
    except TypeError:
        image.colorspace_settings.name = "Raw"
    width, height = image.size
    rgba = np.asarray(image.pixels[:], dtype=np.float32).reshape(height, width, 4)
    # bpy image storage begins at the lower-left; the retained authoring
    # contract and crop coordinates use a conventional top-left image origin.
    return np.flipud(rgba[:, :, 0]).copy()


def bilinear_crop(heightmap: np.ndarray, crop: tuple[float, ...], cols: int, rows: int) -> np.ndarray:
    source_h, source_w = heightmap.shape
    left, top, right, bottom = crop
    u = np.linspace(left * (source_w - 1), right * (source_w - 1), cols)
    v = np.linspace(top * (source_h - 1), bottom * (source_h - 1), rows)
    xx, yy = np.meshgrid(u, v)
    x0 = np.floor(xx).astype(np.int32)
    y0 = np.floor(yy).astype(np.int32)
    x1 = np.minimum(x0 + 1, source_w - 1)
    y1 = np.minimum(y0 + 1, source_h - 1)
    fx = xx - x0
    fy = yy - y0
    return (
        heightmap[y0, x0] * (1 - fx) * (1 - fy)
        + heightmap[y0, x1] * fx * (1 - fy)
        + heightmap[y1, x0] * (1 - fx) * fy
        + heightmap[y1, x1] * fx * fy
    )


def authored_surface(config: dict, heightmap: np.ndarray) -> tuple[np.ndarray, ...]:
    cols, rows = config["grid"]
    length, depth, peak_height = config["size"]
    raw = bilinear_crop(heightmap, config["crop"], cols, rows)
    u = np.linspace(0.0, 1.0, cols)
    v = np.linspace(0.0, 1.0, rows)
    uu, vv = np.meshgrid(u, v)

    # Every crop receives its own zero-height perimeter.  This is the terrain
    # seating skirt, not a visible rectangular patch.
    edge_distance = np.minimum.reduce((uu, vv, 1 - uu, 1 - vv))
    crop_fade = smoothstep(edge_distance / 0.055)
    raw = np.clip(raw * crop_fade, 0.0, 1.0)
    raw[edge_distance < 0.012] = 0.0

    # Irregularly phase-shifted benches preserve the image-generated massing
    # without reviving the old globally identical six-step cross-section.
    phase = config["phase"]
    strata_warp = (
        np.sin(uu * math.tau * 2.3 + phase) * 0.035
        + np.sin(vv * math.tau * 1.7 - phase * 0.71) * 0.022
    )
    levels = config["terraces"]
    stepped_coordinate = np.clip(raw + strata_warp * raw * (1 - raw), 0.0, 1.0) * levels
    band = np.floor(stepped_coordinate)
    band_phase = stepped_coordinate - band
    softened_step = (band + smoothstep((band_phase - 0.16) / 0.76)) / levels
    h = raw * (1 - config["terrace_strength"]) + softened_step * config["terrace_strength"]
    h *= crop_fade

    # Keep the pivot on the visual rock mass instead of the rectangular crop.
    mass = np.maximum(h - 0.055, 0.0) ** 1.35
    mass_total = float(mass.sum())
    centroid_u = float((mass * uu).sum() / mass_total) if mass_total else 0.5
    centroid_v = float((mass * vv).sum() / mass_total) if mass_total else 0.5
    x = (uu - centroid_u) * length
    y = (vv - centroid_v) * depth

    # Height-dependent rim shear creates actual forward ledges/undercuts in
    # the closed mesh.  It is strongest on the authored image's front half,
    # modulated independently per module, and absent at the buried perimeter.
    front = smoothstep((vv - 0.30) / 0.48)
    rim = smoothstep((h - 0.12) / 0.52)
    shear_variation = 0.72 + 0.28 * np.sin(uu * math.tau * 3.1 + phase)
    y += config["overhang"] * (h ** 1.52) * front * rim * shear_variation * crop_fade
    x += np.sin(vv * math.tau * 1.35 + phase) * (h ** 1.25) * length * 0.012

    z = -BURY_DEPTH + h * peak_height
    z[h < 0.004] = -BURY_DEPTH

    dx = length / max(cols - 1, 1)
    dy = depth / max(rows - 1, 1)
    dz_dy, dz_dx = np.gradient(z, dy, dx)
    up = 1.0 / np.sqrt(1.0 + dz_dx * dz_dx + dz_dy * dz_dy)
    high = smoothstep((h - 0.18) / 0.34)
    cap = smoothstep((up - 0.54) / 0.34) * high
    talus = smoothstep((0.42 - h) / 0.32) * smoothstep((up - 0.24) / 0.53)
    face = np.maximum(0.0, 1.0 - cap - talus)
    zone_sum = np.maximum(cap + face + talus, 1e-6)
    cap, face, talus = cap / zone_sum, face / zone_sum, talus / zone_sum
    macro = np.clip(
        0.91
        + np.sin(uu * math.tau * 1.17 + phase) * 0.055
        + np.sin(vv * math.tau * 1.83 - phase) * 0.035,
        0.82,
        1.0,
    )
    return x, y, z, cap, face, talus, macro


def create_closed_mesh(config: dict, heightmap: np.ndarray) -> bpy.types.Object:
    cols, rows = config["grid"]
    x, y, z, cap, face, talus, macro = authored_surface(config, heightmap)
    vertices = [
        (float(x[row, col]), float(y[row, col]), float(z[row, col]))
        for row in range(rows)
        for col in range(cols)
    ]
    colors = [
        (
            float(cap[row, col]),
            float(face[row, col]),
            float(talus[row, col]),
            float(macro[row, col]),
        )
        for row in range(rows)
        for col in range(cols)
    ]
    faces: list[tuple[int, ...]] = []
    index = lambda row, col: row * cols + col
    for row in range(rows - 1):
        for col in range(cols - 1):
            a = index(row, col)
            b = index(row, col + 1)
            c = index(row + 1, col)
            d = index(row + 1, col + 1)
            faces.append((a, b, d, c))
    top_face_count = len(faces)

    perimeter = []
    perimeter.extend(index(0, col) for col in range(cols))
    perimeter.extend(index(row, cols - 1) for row in range(1, rows))
    perimeter.extend(index(rows - 1, col) for col in range(cols - 2, -1, -1))
    perimeter.extend(index(row, 0) for row in range(rows - 2, 0, -1))
    bottom_start = len(vertices)
    bottom_z = -BURY_DEPTH - BOTTOM_DEPTH
    for top_index in perimeter:
        vx, vy, _ = vertices[top_index]
        vertices.append((vx, vy, bottom_z))
        source_color = colors[top_index]
        colors.append((0.0, 0.10, 0.90, source_color[3]))
    for edge, top_a in enumerate(perimeter):
        next_edge = (edge + 1) % len(perimeter)
        top_b = perimeter[next_edge]
        bottom_a = bottom_start + edge
        bottom_b = bottom_start + next_edge
        faces.append((top_a, bottom_a, bottom_b, top_b))
    bottom_center = len(vertices)
    vertices.append((0.0, 0.0, bottom_z))
    colors.append((0.0, 0.0, 1.0, 0.91))
    for edge in range(len(perimeter)):
        next_edge = (edge + 1) % len(perimeter)
        faces.append((bottom_center, bottom_start + next_edge, bottom_start + edge))

    mesh = bpy.data.meshes.new(f"{config['name']}_AuthoringMesh")
    mesh.from_pydata(vertices, [], faces)
    mesh.update(calc_edges=True)
    for polygon in mesh.polygons[:top_face_count]:
        polygon.use_smooth = True
    color_attribute = mesh.color_attributes.new(
        name="CliffZone",
        type="FLOAT_COLOR",
        domain="POINT",
    )
    for item, color in zip(color_attribute.data, colors):
        item.color = color
    mesh.color_attributes.active_color = color_attribute
    try:
        mesh.color_attributes.render_color_index = 0
    except AttributeError:
        pass

    obj = bpy.data.objects.new(config["name"], mesh)
    bpy.context.collection.objects.link(obj)
    obj["eanpaSourceHeightmap"] = HEIGHTMAP.name
    obj["eanpaModule"] = config["name"]
    obj["eanpaWorldSizeMetres"] = list(config["size"])
    obj["eanpaCrop"] = list(config["crop"])
    obj["eanpaSideProfile"] = "image-cap + unequal-benches + forward-rim-undercut"
    return obj


def activate(obj: bpy.types.Object) -> None:
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj


def apply_modifier(obj: bpy.types.Object, modifier: bpy.types.Modifier) -> None:
    activate(obj)
    bpy.ops.object.modifier_apply(modifier=modifier.name)


def bake_lod(source: bpy.types.Object, lod: int, ratio: float) -> bpy.types.Object:
    obj = source.copy()
    obj.data = source.data.copy()
    obj.name = f"{source.name}_LOD{lod}"
    obj.data.name = f"{obj.name}_Mesh"
    bpy.context.collection.objects.link(obj)
    obj["eanpaLod"] = lod
    obj["eanpaReductionRatio"] = ratio
    obj["eanpaDistanceMetres"] = LOD_DISTANCES_METRES[lod]
    if ratio < 0.999:
        decimate = obj.modifiers.new(f"LOD{lod} silhouette decimation", "DECIMATE")
        decimate.decimate_type = "COLLAPSE"
        decimate.ratio = ratio
        decimate.use_collapse_triangulate = True
        apply_modifier(obj, decimate)
    triangulate = obj.modifiers.new("Deterministic triangulation", "TRIANGULATE")
    triangulate.quad_method = "BEAUTY"
    triangulate.ngon_method = "BEAUTY"
    apply_modifier(obj, triangulate)
    obj.data.update(calc_edges=True)
    return obj


def mesh_metrics(obj: bpy.types.Object) -> dict:
    mesh = obj.data
    mesh.calc_loop_triangles()
    bm = bmesh.new()
    bm.from_mesh(mesh)
    boundary = sum(1 for edge in bm.edges if edge.is_boundary)
    nonmanifold = sum(1 for edge in bm.edges if not edge.is_manifold)
    bm.free()
    coords = np.asarray([vertex.co[:] for vertex in mesh.vertices], dtype=np.float64)
    if len(coords):
        minimum = coords.min(axis=0).tolist()
        maximum = coords.max(axis=0).tolist()
    else:
        minimum = maximum = [0.0, 0.0, 0.0]
    colors = mesh.color_attributes.active_color
    return {
        "vertices": len(mesh.vertices),
        "triangles": len(mesh.loop_triangles),
        "boundaryEdges": boundary,
        "nonManifoldEdges": nonmanifold,
        "boundsMinBlender": minimum,
        "boundsMaxBlender": maximum,
        "colorAttribute": colors.name if colors else None,
        "colorDomain": colors.domain if colors else None,
        "colorType": colors.data_type if colors else None,
    }


def main() -> None:
    if not HEIGHTMAP.is_file() or not HEIGHT_MANIFEST.is_file():
        raise FileNotFoundError("Run tools/prepare-escarpment-heightmap.py first")
    reset_scene()
    heightmap = load_heightmap()
    export_objects = []
    report_modules = []

    for config in MODULES:
        source = create_closed_mesh(config, heightmap)
        lods = []
        for lod, ratio in enumerate(LOD_RATIOS):
            baked = bake_lod(source, lod, ratio)
            export_objects.append(baked)
            metrics = mesh_metrics(baked)
            if metrics["nonManifoldEdges"] != 0 or metrics["boundaryEdges"] != 0:
                raise RuntimeError(f"{baked.name} is not a closed two-manifold: {metrics}")
            if metrics["colorAttribute"] != "CliffZone":
                raise RuntimeError(f"{baked.name} lost the authored COLOR_0 source")
            lods.append({"lod": lod, "ratio": ratio, **metrics})
        bpy.data.objects.remove(source, do_unlink=True)
        report_modules.append({
            "name": config["name"],
            "crop": list(config["crop"]),
            "worldSizeMetres": list(config["size"]),
            "terraces": config["terraces"],
            "sideProfileOverhangMetres": config["overhang"],
            "lods": lods,
        })

    for obj in export_objects:
        obj.hide_render = False
        obj.hide_set(False)
    bpy.context.scene["eanpaAssetSchema"] = "authored-escarpments-v1"
    bpy.context.scene["eanpaHeightmapSha256"] = sha256(HEIGHTMAP)
    bpy.context.scene["eanpaLodDistancesMetres"] = list(LOD_DISTANCES_METRES)
    bpy.ops.wm.save_as_mainfile(filepath=str(OUTPUT_BLEND), compress=True)

    bpy.ops.object.select_all(action="DESELECT")
    for obj in export_objects:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = export_objects[0]
    bpy.ops.export_scene.gltf(
        filepath=str(OUTPUT_GLB),
        export_format="GLB",
        use_selection=True,
        export_apply=True,
        export_yup=True,
        export_normals=True,
        export_attributes=True,
        export_extras=True,
        export_materials="NONE",
        export_vertex_color="ACTIVE",
        export_all_vertex_colors=True,
        export_active_vertex_color_when_no_material=True,
    )

    report = {
        "schema": "eanpa-authored-escarpments-v1",
        "blenderVersion": bpy.app.version_string,
        "heightmap": HEIGHTMAP.relative_to(ROOT).as_posix(),
        "heightmapSha256": sha256(HEIGHTMAP),
        "heightManifestSha256": sha256(HEIGHT_MANIFEST),
        "blend": OUTPUT_BLEND.relative_to(ROOT).as_posix(),
        "blendSha256": sha256(OUTPUT_BLEND),
        "glb": OUTPUT_GLB.relative_to(ROOT).as_posix(),
        "glbSha256": sha256(OUTPUT_GLB),
        "lodRatios": list(LOD_RATIOS),
        "lodDistancesMetres": list(LOD_DISTANCES_METRES),
        "buriedTopBorderMetres": BURY_DEPTH,
        "closedBottomDepthMetres": BOTTOM_DEPTH,
        "materialPayload": "COLOR_0 rgba = cap, exposed-face, talus, macro",
        "runtimeCollision": False,
        "modules": report_modules,
    }
    OUTPUT_REPORT.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    total = [sum(module["lods"][lod]["triangles"] for module in report_modules) for lod in range(3)]
    print(
        f"[escarpments] {len(report_modules)} unique modules; "
        f"LOD triangles={total}; GLB={OUTPUT_GLB.stat().st_size / 1048576:.2f} MiB"
    )


if __name__ == "__main__":
    main()
