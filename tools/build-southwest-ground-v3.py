#!/usr/bin/env python3
"""Build and verify Eanpa's deterministic Southwest ground v3 runtime pack.

Fourteen retained 4K CC0 masters become two true 2048-square lossless texture
arrays: graded sRGB albedo with linear relative height in alpha, plus linear
normalXY/roughness/AO. Published capture spans remain provenance only; explicit
4-8 m scene-calibrated repeats retain 256-512 runtime texels per metre. The
decoded array cost is recorded explicitly in the manifest; no runtime/FPS claim
is inferred.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import tempfile
from typing import Any

import numpy as np
from PIL import Image


REPO_ROOT = Path(__file__).resolve().parents[1]
PACK_ROOT = REPO_ROOT / "assets" / "pbr" / "eanpa_southwest_ground_v3"
SOURCE_DIR = PACK_ROOT / "sources"
RUNTIME_DIR = PACK_ROOT / "runtime"
MANIFEST_PATH = PACK_ROOT / "manifest.json"
TARGET_SIZE = (2048, 2048)
SOURCE_SIZE = (4096, 4096)
RESAMPLE = Image.Resampling.LANCZOS
ROLE_SUFFIX = {
    "albedo": "Color",
    "normal_gl": "NormalGL",
    "roughness": "Roughness",
    "ao": "AO",
    "displacement": "Displacement",
}

LAYERS: tuple[dict[str, Any], ...] = (
    {
        "id": "RockyTrail02", "extension": "jpg", "provider": "Poly Haven",
        "asset_page_url": "https://polyhaven.com/a/rocky_trail_02",
        "physical_span_m": [2.0, 2.0], "span_basis": "author-published 2 m width",
        "scene_repeat_m": [4.0, 4.0],
        "scene_repeat_basis": "SeedThree 4 m base-ground period; doubled after live motif-scale review",
        "semantic": "dominant-alluvial-gravel-and-stony-trail",
        "grade": {"target_srgb": [0.67, 0.43, 0.22], "chroma_mix": 0.22,
                  "exposure_stops": 0.02, "luma_contrast": 1.02},
    },
    {
        "id": "DryGroundRocks", "extension": "jpg", "provider": "Poly Haven",
        "asset_page_url": "https://polyhaven.com/a/dry_ground_rocks",
        "physical_span_m": [4.0, 4.0], "span_basis": "author-published 4 m width",
        "scene_repeat_m": [8.0, 8.0],
        "scene_repeat_basis": "rounded above SeedThree 7.27 m rock period for large stony motifs",
        "semantic": "stony-transition-soil",
        "grade": {"target_srgb": [0.72, 0.45, 0.22], "chroma_mix": 0.20,
                  "exposure_stops": 0.0, "luma_contrast": 1.0},
    },
    {
        "id": "RedLateriteSoilStones", "extension": "png", "provider": "Poly Haven",
        "asset_page_url": "https://polyhaven.com/a/red_laterite_soil_stones",
        "physical_span_m": [2.0, 2.0], "span_basis": "author-published 2 m width",
        "scene_repeat_m": [4.0, 4.0],
        "scene_repeat_basis": "SeedThree 4 m base-ground period; doubled after live motif-scale review",
        "semantic": "warm-gravel-transition-soil",
        "grade": {"target_srgb": [0.71, 0.45, 0.24], "chroma_mix": 0.52,
                  "exposure_stops": 0.65, "luma_contrast": 1.0},
    },
    {
        "id": "CrackedRedGround", "extension": "jpg", "provider": "Poly Haven",
        "asset_page_url": "https://polyhaven.com/a/cracked_red_ground",
        "physical_span_m": [2.0, 2.0], "span_basis": "author-published 2 m width",
        "scene_repeat_m": [6.0, 6.0],
        "scene_repeat_basis": "expanded beyond SeedThree ground period so crack plates read above pebble scale",
        "semantic": "compacted-cracked-flats",
        "grade": {"target_srgb": [0.70, 0.41, 0.21], "chroma_mix": 0.35,
                  "exposure_stops": 0.24, "luma_contrast": 1.03},
    },
    {
        "id": "MudCrackedDryRiverbed002", "extension": "jpg", "provider": "Poly Haven",
        "asset_page_url": "https://polyhaven.com/a/mud_cracked_dry_riverbed_002",
        "physical_span_m": [2.0, 2.0], "span_basis": "author-published 2 m width",
        "scene_repeat_m": [6.0, 6.0],
        "scene_repeat_basis": "expanded beyond SeedThree ground period so wash polygons remain legible",
        "semantic": "authored-dry-washes-only",
        "grade": {"target_srgb": [0.69, 0.43, 0.21], "chroma_mix": 0.46,
                  "exposure_stops": -0.04, "luma_contrast": 1.05},
    },
    {
        "id": "Rock029", "extension": "jpg", "provider": "ambientCG",
        "asset_page_url": "https://ambientcg.com/view?id=Rock029",
        "physical_span_m": [4.0, 4.0],
        "span_basis": "calibrated 4 m projection; procedural source publishes no metre span",
        "scene_repeat_m": [8.0, 8.0],
        "scene_repeat_basis": "rounded above SeedThree 7.27 m rock period for terrain-scale bedrock relief",
        "semantic": "orange-bedrock-and-steep-outcrop",
        "grade": {"target_srgb": [0.73, 0.43, 0.21], "chroma_mix": 0.34,
                  "exposure_stops": 0.32, "luma_contrast": 1.02},
    },
    {
        "id": "Rock061", "extension": "jpg", "provider": "ambientCG",
        "asset_page_url": "https://ambientcg.com/view?id=Rock061",
        "physical_span_m": [4.0, 4.0],
        "span_basis": "calibrated 4 m projection; procedural source publishes no metre span",
        "scene_repeat_m": [8.0, 8.0],
        "scene_repeat_basis": "rounded above SeedThree 7.27 m rock period for terrain-scale bedrock relief",
        "semantic": "tan-bedrock-and-outcrop-transition",
        "grade": {"target_srgb": [0.68, 0.43, 0.22], "chroma_mix": 0.60,
                  "exposure_stops": 0.10, "luma_contrast": 1.0},
    },
)

LAYERS = LAYERS + (
    {
        'id': 'GravellySand', 'extension': 'jpg', 'provider': 'Poly Haven',
        'asset_page_url': 'https://polyhaven.com/a/gravelly_sand',
        'physical_span_m': [2.5, 2.5], 'span_basis': 'author-published 2.5 m width',
        'scene_repeat_m': [5.0, 5.0],
        'scene_repeat_basis': 'two authored spans per repeat for wash-scale grit without giant stones',
        'semantic': 'wash-and-alluvial-sandy-gravel',
        'grade': {'target_srgb': [0.68, 0.45, 0.25], 'chroma_mix': 0.38,
                  'exposure_stops': 0.16, 'luma_contrast': 1.02},
    },
    {
        'id': 'RockFace03', 'extension': 'jpg', 'provider': 'Poly Haven',
        'asset_page_url': 'https://polyhaven.com/a/rock_face_03',
        'physical_span_m': [2.7, 2.7], 'span_basis': 'author-published 2.7 m width',
        'scene_repeat_m': [8.0, 8.0],
        'scene_repeat_basis': 'terrain-scale triplanar projection for elevated and steep rock',
        'semantic': 'elevated-steep-weathered-rock-face',
        'grade': {'target_srgb': [0.70, 0.43, 0.22], 'chroma_mix': 0.42,
                  'exposure_stops': 0.24, 'luma_contrast': 1.03},
    },
    {
        'id': 'SandyGravel02', 'extension': 'jpg', 'provider': 'Poly Haven',
        'asset_page_url': 'https://polyhaven.com/a/sandy_gravel_02',
        'physical_span_m': [2.5, 2.5], 'span_basis': 'author-published 2.5 m width',
        'scene_repeat_m': [5.0, 5.0],
        'scene_repeat_basis': 'two authored spans per repeat for alluvial gravel at scene scale',
        'semantic': 'wash-and-alluvial-warm-sandy-gravel',
        'grade': {'target_srgb': [0.70, 0.44, 0.23], 'chroma_mix': 0.30,
                  'exposure_stops': 0.10, 'luma_contrast': 1.01},
    },
    {
        'id': 'RockyTrail', 'extension': 'jpg', 'provider': 'Poly Haven',
        'asset_page_url': 'https://polyhaven.com/a/rocky_trail',
        'physical_span_m': [2.0, 2.0], 'span_basis': 'author-published 2 m width',
        'scene_repeat_m': [4.0, 4.0],
        'scene_repeat_basis': 'SeedThree-scale general gravel and talus repeat',
        'semantic': 'general-gravel-and-broken-talus',
        'grade': {'target_srgb': [0.69, 0.44, 0.23], 'chroma_mix': 0.42,
                  'exposure_stops': 0.22, 'luma_contrast': 1.02},
    },
    {
        'id': 'RockFace', 'extension': 'jpg', 'provider': 'Poly Haven',
        'asset_page_url': 'https://polyhaven.com/a/rock_face',
        'physical_span_m': [2.4, 2.4], 'span_basis': 'author-published 2.4 m width',
        'scene_repeat_m': [8.0, 8.0],
        'scene_repeat_basis': 'terrain-scale triplanar projection for elevated and steep rock',
        'semantic': 'elevated-steep-reddish-rock-face',
        'grade': {'target_srgb': [0.72, 0.43, 0.21], 'chroma_mix': 0.34,
                  'exposure_stops': 0.85, 'luma_contrast': 0.99},
    },
    {
        'id': 'RockBoulderCracked', 'extension': 'jpg', 'provider': 'Poly Haven',
        'asset_page_url': 'https://polyhaven.com/a/rock_boulder_cracked',
        'physical_span_m': [1.4, 1.4], 'span_basis': 'author-published 1.4 m height',
        'scene_repeat_m': [6.0, 6.0],
        'scene_repeat_basis': 'enlarged cracked-boulder motifs for elevated and steep terrain',
        'semantic': 'elevated-steep-cracked-orange-boulder',
        'grade': {'target_srgb': [0.74, 0.44, 0.20], 'chroma_mix': 0.26,
                  'exposure_stops': 0.16, 'luma_contrast': 1.04},
    },
    {
        'id': 'RocksGround02', 'extension': 'jpg', 'provider': 'Poly Haven',
        'asset_page_url': 'https://polyhaven.com/a/rocks_ground_02',
        'physical_span_m': [2.0, 2.0], 'span_basis': 'author-published 2 m width',
        'scene_repeat_m': [7.0, 7.0],
        'scene_repeat_basis': 'enlarged slope-only coarse scree repeat to suppress large-stone tiling',
        'semantic': 'elevated-coarse-scree-talus-and-rocky-shoulders',
        'grade': {'target_srgb': [0.68, 0.44, 0.24], 'chroma_mix': 0.52,
                  'exposure_stops': 0.28, 'luma_contrast': 1.02},
    },
)


GRADE_OVERRIDES: dict[str, dict[str, Any]] = {
    'RockyTrail02': {
        'target_srgb': [0.58, 0.34, 0.21], 'chroma_mix': 0.65,
        'exposure_stops': 0.0, 'luma_contrast': 1.02,
    },
    'DryGroundRocks': {
        'target_srgb': [0.60, 0.33, 0.18], 'chroma_mix': 0.65,
        'exposure_stops': -0.15, 'luma_contrast': 1.0,
    },
    'RedLateriteSoilStones': {
        'target_srgb': [0.61, 0.30, 0.16], 'chroma_mix': 0.65,
        'exposure_stops': 0.60, 'luma_contrast': 1.0,
    },
    'CrackedRedGround': {
        'target_srgb': [0.58, 0.29, 0.17], 'chroma_mix': 0.60,
        'exposure_stops': 0.24, 'luma_contrast': 1.03,
    },
    'MudCrackedDryRiverbed002': {
        'target_srgb': [0.58, 0.33, 0.21], 'chroma_mix': 0.65,
        'exposure_stops': -0.10, 'luma_contrast': 1.05,
    },
    'Rock029': {
        'target_srgb': [0.59, 0.29, 0.16], 'chroma_mix': 0.65,
        'exposure_stops': 0.30, 'luma_contrast': 1.02,
    },
    'Rock061': {
        'target_srgb': [0.56, 0.28, 0.18], 'chroma_mix': 0.80,
        'exposure_stops': 0.30, 'luma_contrast': 1.0,
    },
    'GravellySand': {
        'target_srgb': [0.59, 0.34, 0.21], 'chroma_mix': 0.68,
        'exposure_stops': 0.0, 'luma_contrast': 1.02,
    },
    'RockFace03': {
        'target_srgb': [0.57, 0.28, 0.17], 'chroma_mix': 0.78,
        'exposure_stops': 0.0, 'luma_contrast': 1.03,
    },
    'SandyGravel02': {
        'target_srgb': [0.60, 0.32, 0.18], 'chroma_mix': 0.65,
        'exposure_stops': -0.15, 'luma_contrast': 1.01,
    },
    'RockyTrail': {
        'target_srgb': [0.59, 0.31, 0.18], 'chroma_mix': 0.75,
        'exposure_stops': -0.38, 'luma_contrast': 1.02,
    },
    'RockFace': {
        'target_srgb': [0.56, 0.27, 0.16], 'chroma_mix': 0.72,
        'exposure_stops': 0.92, 'luma_contrast': 0.99,
    },
    'RockBoulderCracked': {
        'target_srgb': [0.60, 0.29, 0.15], 'chroma_mix': 0.70,
        'exposure_stops': -1.00, 'luma_contrast': 1.04,
    },
    'RocksGround02': {
        'target_srgb': [0.58, 0.30, 0.18], 'chroma_mix': 0.78,
        'exposure_stops': 0.20, 'luma_contrast': 1.02,
    },
}
if set(GRADE_OVERRIDES) != {layer['id'] for layer in LAYERS}:
    raise RuntimeError('Grade override inventory must exactly match all fourteen layers')
LAYERS = tuple({
    **layer,
    'grade': dict(GRADE_OVERRIDES[layer['id']]),
} for layer in LAYERS)


PALETTE_REFERENCE_ASSETS: tuple[dict[str, Any], ...] = (
    {
        'path': 'assets/terrain/Desert_Cliff_Wide_Mesa_Low_runtime_2k_lods.glb',
        'sha256': 'a5251237247627bf10197fb59643183cce5cfbff2441fe38d39fb5ef4410c5f7',
        'visible_mean_rgb8': [148.1, 87.3, 61.8],
        'visible_median_rgb8': [150, 88, 61],
        'visible_median_hsv': [0.050, 0.586, 0.588],
    },
    {
        'path': 'assets/terrain/Desert_Cliff_Mesa_High_runtime_2k_lods.glb',
        'sha256': 'fa2e557fb0e6a5da17bc82d850e693f8406b77ecf43ae709fea80284f49746c6',
        'visible_mean_rgb8': [134.9, 71.0, 47.0],
        'visible_median_rgb8': [137, 72, 46],
        'visible_median_hsv': [0.046, 0.657, 0.537],
    },
    {
        'path': 'assets/terrain/Desert_rock_chunks_12_pieces_runtime_2k_lods.glb',
        'sha256': '781d4ed5816140066d3e1c793385c42c037cf00dec996206c11e91810922721d',
        'visible_mean_rgb8': [156.6, 94.4, 53.5],
        'visible_median_rgb8': [162, 97, 54],
        'visible_median_hsv': [0.066, 0.661, 0.631],
    },
)
PALETTE_REFERENCE_METHOD = {
    'source': 'embedded baseColor image in each authored runtime LOD GLB',
    'resize': 'Pillow Lanczos into a 512x512 bounding box, aspect preserved',
    'visible_texel_rule': 'include texels only when max(sRGB RGB) > 0.08',
    'rgb_statistics': 'arithmetic mean and per-channel median of visible encoded sRGB bytes',
    'hsv_statistics': 'per-channel median after encoded sRGB RGB-to-HSV conversion',
    'hsv_range': [0.0, 1.0],
    'purpose': 'deterministic cliff-calibrated terrain albedo grade reference',
}


OFFICIAL_POLY_HAVEN_4K: dict[str, dict[str, str]] = {
    'GravellySand': {'slug': 'gravelly_sand', 'albedo': 'diff', 'height': 'disp'},
    'RockFace03': {'slug': 'rock_face_03', 'albedo': 'diff', 'height': 'disp'},
    'SandyGravel02': {'slug': 'sandy_gravel_02', 'albedo': 'diff', 'height': 'disp'},
    'RockyTrail': {'slug': 'rocky_trail', 'albedo': 'diff', 'height': 'disp'},
    'RockFace': {'slug': 'rock_face', 'albedo': 'diff', 'height': 'disp'},
    'RockBoulderCracked': {
        'slug': 'rock_boulder_cracked', 'albedo': 'diff', 'height': 'disp',
    },
    'RocksGround02': {
        'slug': 'rocks_ground_02', 'albedo': 'col', 'height': 'height',
    },
}


CHANNEL_PACKING = {
    "R": "renormalized tangent-space NormalGL X encoded as UNORM8",
    "G": "renormalized tangent-space NormalGL Y encoded as UNORM8",
    "B": "linear roughness encoded as UNORM8",
    "A": "linear ambient occlusion encoded as UNORM8",
    "normal_z_reconstruction": "sqrt(max(0, 1 - x*x - y*y))",
}
ALBEDO_PACKING = {
    "RGB": "graded sRGB albedo; decoded to the renderer working color space",
    "A": "linear per-source relative displacement height encoded as UNORM8",
    "alpha_color_conversion": "none; sRGB transfer applies to RGB only",
    "height_use": "bounded transition-weight bias only; not displacement or SPOM",
}


def source_name(layer: dict[str, Any], role: str) -> str:
    return f"{layer['id']}_{ROLE_SUFFIX[role]}_4K.{layer['extension']}"


def runtime_names(layer: dict[str, Any]) -> tuple[str, str]:
    return (
        f"{layer['id']}_AlbedoGrade_2K.png",
        f"{layer['id']}_PackedNxyRoughAO_2K.png",
    )


def official_poly_haven_sources() -> dict[str, Any]:
    base = 'https://dl.polyhaven.org/file/ph-assets/Textures/jpg/4k'
    role_suffixes = {
        'albedo': None,
        'normal_gl': 'nor_gl',
        'roughness': 'rough',
        'ao': 'ao',
        'displacement': None,
    }
    records: dict[str, Any] = {}
    for layer_id, remote in OFFICIAL_POLY_HAVEN_4K.items():
        slug = remote['slug']
        files = {}
        for role, default_suffix in role_suffixes.items():
            suffix = default_suffix
            if role == 'albedo':
                suffix = remote['albedo']
            elif role == 'displacement':
                suffix = remote['height']
            filename = f'{slug}_{suffix}_4k.jpg'
            files[role] = {
                'filename': filename,
                'url': f'{base}/{slug}/{filename}',
            }
        records[layer_id] = {
            'asset_page_url': f'https://polyhaven.com/a/{slug}',
            'files': files,
        }
    return records


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def palette_reference_metadata() -> dict[str, Any]:
    assets = []
    for expected in PALETTE_REFERENCE_ASSETS:
        relative = expected['path']
        expected_hash = expected['sha256']
        source = REPO_ROOT / relative
        if not source.is_file():
            raise RuntimeError(f'Missing palette-reference GLB: {relative}')
        actual_hash = sha256_file(source)
        if actual_hash != expected_hash:
            raise RuntimeError(
                f'Palette-reference GLB hash mismatch: {relative}; '
                f'expected {expected_hash}, got {actual_hash}'
            )
        assets.append(dict(expected))
    return {
        'method': dict(PALETTE_REFERENCE_METHOD),
        'assets': assets,
    }


def image_metadata(path: Path) -> dict[str, Any]:
    with Image.open(path) as image:
        return {
            "dimensions": [image.width, image.height], "mode": image.mode,
            "format": image.format,
        }


def file_record(path: Path) -> dict[str, Any]:
    return {
        "path": path.relative_to(PACK_ROOT).as_posix(),
        "sha256": sha256_file(path), "byte_size": path.stat().st_size,
        **image_metadata(path),
    }


def validate_sources() -> None:
    expected = {
        source_name(layer, role) for layer in LAYERS for role in ROLE_SUFFIX
    }
    actual = {path.name for path in SOURCE_DIR.iterdir() if path.is_file()}
    if actual != expected:
        raise RuntimeError(
            f"Source inventory mismatch; missing={sorted(expected - actual)}, "
            f"unexpected={sorted(actual - expected)}"
        )
    for name in sorted(expected):
        if image_metadata(SOURCE_DIR / name)["dimensions"] != list(SOURCE_SIZE):
            raise RuntimeError(f"Retained source is not 4K: {name}")


def save_png_atomic(image: Image.Image, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    handle = tempfile.NamedTemporaryFile(
        prefix=f".{destination.name}.", suffix=".tmp", dir=destination.parent,
        delete=False,
    )
    temporary = Path(handle.name)
    handle.close()
    try:
        image.save(temporary, format="PNG", compress_level=9, optimize=False)
        os.replace(temporary, destination)
    finally:
        temporary.unlink(missing_ok=True)


def srgb_to_linear(values: np.ndarray) -> np.ndarray:
    return np.where(
        values <= 0.04045, values / 12.92,
        np.power((values + 0.055) / 1.055, 2.4),
    )


def linear_to_srgb(values: np.ndarray) -> np.ndarray:
    values = np.clip(values, 0.0, 1.0)
    return np.where(
        values <= 0.0031308, values * 12.92,
        1.055 * np.power(values, 1 / 2.4) - 0.055,
    )


def luma_stats(linear_rgb: np.ndarray) -> dict[str, float]:
    luminance = np.tensordot(
        linear_rgb, np.array([0.2126, 0.7152, 0.0722], dtype=np.float32),
        axes=([2], [0]),
    )
    q05, median, q95 = np.quantile(luminance, [0.05, 0.5, 0.95])
    return {"q05": float(q05), "median": float(median), "q95": float(q95)}


def grade_albedo(
    source: Path,
    height_source: Path,
    destination: Path,
    grade: dict[str, Any],
) -> dict[str, Any]:
    with Image.open(source) as image:
        resized = image.convert("RGB").resize(TARGET_SIZE, RESAMPLE)
    srgb = np.asarray(resized, dtype=np.float32) / 255.0
    linear = srgb_to_linear(srgb)
    weights = np.array([0.2126, 0.7152, 0.0722], dtype=np.float32)
    luminance = np.tensordot(linear, weights, axes=([2], [0]))
    safe_luminance = np.maximum(luminance, 1.0e-5)
    source_chroma = linear / safe_luminance[:, :, None]

    target = srgb_to_linear(np.array(grade["target_srgb"], dtype=np.float32))
    target_chroma = target / max(float(np.dot(target, weights)), 1.0e-5)
    chroma_mix = float(grade["chroma_mix"])
    chroma = source_chroma * (1.0 - chroma_mix) + target_chroma * chroma_mix

    median = max(float(np.median(luminance)), 1.0e-5)
    contrast = float(grade["luma_contrast"])
    exposure = 2.0 ** float(grade["exposure_stops"])
    graded_luma = median * np.power(safe_luminance / median, contrast) * exposure
    graded_linear = chroma * graded_luma[:, :, None]
    graded_srgb = linear_to_srgb(graded_linear)
    encoded = np.floor(np.clip(graded_srgb, 0, 1) * 255.0 + 0.5).astype(np.uint8)
    height = resized_scalar(height_source)
    height_q01, height_q99 = np.quantile(height, [0.01, 0.99])
    height_span = max(float(height_q99 - height_q01), 1.0e-6)
    relative_height = np.clip((height - height_q01) / height_span, 0.0, 1.0)
    encoded_height = encode_unorm8(relative_height)
    encoded_rgba = np.empty((TARGET_SIZE[1], TARGET_SIZE[0], 4), dtype=np.uint8)
    encoded_rgba[:, :, :3] = encoded
    encoded_rgba[:, :, 3] = encoded_height
    save_png_atomic(Image.fromarray(encoded_rgba, mode="RGBA"), destination)
    return {
        "method": "linear-luminance-preserving-individual-chroma-grade-v1",
        "parameters": grade,
        "source_luminance": luma_stats(linear),
        "runtime_luminance": luma_stats(srgb_to_linear(encoded.astype(np.float32) / 255.0)),
        "detail_policy": "local scan luminance retained; only modest exposure/contrast and per-layer chroma alignment",
        "height_alpha": {
            "source": height_source.relative_to(PACK_ROOT).as_posix(),
            "normalization": "source 1st-99th percentile remapped to linear UNORM8 0-1",
            "source_q01": float(height_q01),
            "source_q99": float(height_q99),
            "runtime_min": int(encoded_height.min()),
            "runtime_max": int(encoded_height.max()),
            "runtime_mean": float(encoded_height.mean() / 255.0),
            "runtime_stddev": float(encoded_height.std() / 255.0),
        },
    }


def resized_scalar(source: Path) -> np.ndarray:
    with Image.open(source) as image:
        resized = image.convert("F").resize(TARGET_SIZE, RESAMPLE)
        values = np.asarray(resized, dtype=np.float32).copy()
        source_max = 65535.0 if image.mode in {"I;16", "I;16B", "I;16L"} else 255.0
    return np.clip(values / source_max, 0.0, 1.0)


def resized_normal_xy(source: Path) -> tuple[np.ndarray, np.ndarray]:
    with Image.open(source) as image:
        resized = image.convert("RGB").resize(TARGET_SIZE, RESAMPLE)
    normal = np.asarray(resized, dtype=np.float32) * (2.0 / 255.0) - 1.0
    magnitude = np.linalg.norm(normal, axis=2)
    magnitude = np.maximum(magnitude, 1.0e-8)
    normal /= magnitude[:, :, None]
    return normal[:, :, 0], normal[:, :, 1]


def encode_unorm8(values: np.ndarray) -> np.ndarray:
    return np.floor(np.clip(values, 0, 1) * 255.0 + 0.5).astype(np.uint8)


def build_packed(layer: dict[str, Any], destination: Path) -> None:
    x, y = resized_normal_xy(SOURCE_DIR / source_name(layer, "normal_gl"))
    roughness = resized_scalar(SOURCE_DIR / source_name(layer, "roughness"))
    ao = resized_scalar(SOURCE_DIR / source_name(layer, "ao"))
    packed = np.empty((TARGET_SIZE[1], TARGET_SIZE[0], 4), dtype=np.uint8)
    packed[:, :, 0] = encode_unorm8(x * 0.5 + 0.5)
    packed[:, :, 1] = encode_unorm8(y * 0.5 + 0.5)
    packed[:, :, 2] = encode_unorm8(roughness)
    packed[:, :, 3] = encode_unorm8(ao)
    save_png_atomic(Image.fromarray(packed, mode="RGBA"), destination)


def build() -> None:
    validate_sources()
    source_hashes = {
        path.name: sha256_file(path) for path in SOURCE_DIR.iterdir() if path.is_file()
    }
    RUNTIME_DIR.mkdir(parents=True, exist_ok=True)
    layers = []
    for order, layer in enumerate(LAYERS):
        albedo_name, packed_name = runtime_names(layer)
        albedo_path = RUNTIME_DIR / albedo_name
        packed_path = RUNTIME_DIR / packed_name
        print(f"Building {layer['id']} graded albedo ...", flush=True)
        grade_record = grade_albedo(
            SOURCE_DIR / source_name(layer, "albedo"),
            SOURCE_DIR / source_name(layer, "displacement"),
            albedo_path,
            layer["grade"],
        )
        print(f"Building {layer['id']} packed PBR ...", flush=True)
        build_packed(layer, packed_path)
        source_records = {
            role: file_record(SOURCE_DIR / source_name(layer, role)) for role in ROLE_SUFFIX
        }
        layers.append({
            "id": layer["id"], "order": order, "semantic": layer["semantic"],
            "physical_span_m": layer["physical_span_m"], "span_basis": layer["span_basis"],
            "scene_repeat_m": layer["scene_repeat_m"],
            "scene_repeat_basis": layer["scene_repeat_basis"],
            "scene_scale_factor_from_physical": [
                round(scene / physical, 6)
                for scene, physical in zip(
                    layer["scene_repeat_m"], layer["physical_span_m"], strict=True
                )
            ],
            "runtime_texels_per_m": [
                round(size / repeat, 6)
                for size, repeat in zip(TARGET_SIZE, layer["scene_repeat_m"], strict=True)
            ],
            "provenance": {
                "provider": layer["provider"], "asset_page_url": layer["asset_page_url"],
                "license": "CC0 1.0 Universal",
                "license_url": "https://creativecommons.org/publicdomain/zero/1.0/",
            },
            "source": {"resolution_class": "retained 4K masters", "files": source_records},
            "runtime": {
                "albedo": file_record(albedo_path),
                "packed_normal_xy_roughness_ao": file_record(packed_path),
                "albedo_grade": grade_record,
            },
            "future_spom_height": {
                "enabled": False,
                "source_master_path": source_records["displacement"]["path"],
                "runtime_height_path": file_record(albedo_path)["path"],
                "runtime_blend_path": file_record(albedo_path)["path"],
                "runtime_blend_channel": "A",
                "runtime_blend_resolution": list(TARGET_SIZE),
                "dominant_layer_ready": True,
                "reason": "The normalized 2K alpha is active only for bounded material-transition weighting. Geometric displacement/SPOM remains disabled; the authored 4K master is retained for that later implementation.",
            },
        })

    base_bytes = TARGET_SIZE[0] * TARGET_SIZE[1] * 4 * len(LAYERS) * 2
    manifest = {
        'palette_reference': palette_reference_metadata(),
        'official_poly_haven_4k_jpg_sources': official_poly_haven_sources(),
        "schema_version": 4,
        "generated_by": "tools/build-southwest-ground-v3.py",
        "source_acquisition": "tools/download-southwest-ground-v3.py",
        "hash_algorithm": "SHA-256", "deterministic_build": True,
        "layer_order": [layer["id"] for layer in LAYERS],
        "source_file_count": len(LAYERS) * len(ROLE_SUFFIX),
        "runtime_file_count": len(LAYERS) * 2,
        "runtime_resolution": list(TARGET_SIZE),
        "runtime_resolution_rationale": "True 2K is the visual-quality floor after the rejected low-resolution pass. At 4-8 m scene repeats it supplies 256-512 texels/m; future GPU block compression should reduce the honestly recorded decoded cost without reducing authored resolution.",
        "scene_scale_calibration": {
            "source_span_policy": "physical_span_m records source/capture provenance and does not drive runtime UVs",
            "runtime_span_policy": "scene_repeat_m is the complete world-XZ texture repeat used by the shader",
            "seedthree_base_ground_repeat_m": 4.0,
            "seedthree_rock_repeat_m": 7.272727,
            "seedthree_derivation": "560 m terrain / 140 base repeats = 4 m; rock UV multiplier 0.55 gives 4 / 0.55 = 7.272727 m",
            "stochastic_cell_m": 12.0,
        },
        "decoded_array_memory": {
            "base_level_bytes": base_bytes,
            "estimated_with_complete_mips_bytes": math.ceil(base_bytes * 4 / 3),
            "array_count": 2, "layer_count": len(LAYERS), "channels_per_array": 4,
        },
        "runtime_png": {
            "lossless": True, "albedo_mode": "RGBA", "packed_mode": "RGBA",
            "resampling": "Lanczos", "mips_generated_at_runtime": True,
            "anisotropy_requested": 8,
        },
        "albedo_packing": ALBEDO_PACKING,
        "channel_packing": CHANNEL_PACKING,
        "layers": layers,
    }
    payload = json.dumps(manifest, indent=2, ensure_ascii=False) + "\n"
    MANIFEST_PATH.write_text(payload, encoding="utf-8")
    for name, before in source_hashes.items():
        if sha256_file(SOURCE_DIR / name) != before:
            raise RuntimeError(f"Retained source changed during build: {name}")


def verify_record(record: dict[str, Any], mode: str) -> None:
    path = PACK_ROOT / record["path"]
    if not path.is_file() or sha256_file(path) != record["sha256"]:
        raise RuntimeError(f"Missing or hash-mismatched manifest file: {record['path']}")
    metadata = image_metadata(path)
    if metadata != {key: record[key] for key in ("dimensions", "mode", "format")}:
        raise RuntimeError(f"Metadata mismatch: {record['path']}")
    if metadata["mode"] != mode:
        raise RuntimeError(f"Mode mismatch: {record['path']}")


def verify() -> None:
    palette_manifest = json.loads(MANIFEST_PATH.read_text(encoding='utf-8'))
    if palette_manifest.get('palette_reference') != palette_reference_metadata():
        raise RuntimeError('Palette-reference metadata mismatch')
    validate_sources()
    manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    if manifest["layer_order"] != [layer["id"] for layer in LAYERS]:
        raise RuntimeError("Layer order mismatch")
    if manifest["runtime_resolution"] != list(TARGET_SIZE):
        raise RuntimeError("Runtime resolution mismatch")
    for expected, entry in zip(LAYERS, manifest["layers"], strict=True):
        if entry["id"] != expected["id"] or entry["semantic"] != expected["semantic"]:
            raise RuntimeError(f"Layer metadata mismatch: {expected['id']}")
        if entry["physical_span_m"] != expected["physical_span_m"]:
            raise RuntimeError(f"Physical span mismatch: {expected['id']}")
        if entry["scene_repeat_m"] != expected["scene_repeat_m"]:
            raise RuntimeError(f"Scene repeat mismatch: {expected['id']}")
        expected_texels = [
            round(size / repeat, 6)
            for size, repeat in zip(TARGET_SIZE, expected["scene_repeat_m"], strict=True)
        ]
        if entry["runtime_texels_per_m"] != expected_texels:
            raise RuntimeError(f"Runtime texel density mismatch: {expected['id']}")
        for role in ROLE_SUFFIX:
            verify_record(entry["source"]["files"][role], image_metadata(
                SOURCE_DIR / source_name(expected, role))["mode"])
        verify_record(entry["runtime"]["albedo"], "RGBA")
        verify_record(entry["runtime"]["packed_normal_xy_roughness_ao"], "RGBA")
        height = entry["future_spom_height"]
        if (height["enabled"] is not False
                or height["runtime_height_path"] != entry["runtime"]["albedo"]["path"]
                or height["runtime_blend_path"] != entry["runtime"]["albedo"]["path"]
                or height["runtime_blend_channel"] != "A"):
            raise RuntimeError(f"SPOM height unexpectedly enabled: {expected['id']}")
        with Image.open(PACK_ROOT / entry["runtime"]["albedo"]["path"]) as image:
            alpha = np.asarray(image.getchannel("A"))
        if int(alpha.min()) != 0 or int(alpha.max()) != 255 or float(alpha.std()) < 8.0:
            raise RuntimeError(f"Runtime height alpha lacks useful range: {expected['id']}")
    if (
        manifest.get('official_poly_haven_4k_jpg_sources')
        != official_poly_haven_sources()
    ):
        raise RuntimeError('Official Poly Haven source filename provenance mismatch')
    for expected in LAYERS:
        layer_id = expected['id']
        packed_runtime = RUNTIME_DIR / runtime_names(expected)[1]
        with Image.open(packed_runtime) as packed_image:
            packed_array = np.asarray(packed_image)
        normal_xy_std = packed_array[:, :, :2].std(axis=(0, 1))
        if float(normal_xy_std.min()) < 2.0:
            raise RuntimeError(
                f'Packed runtime normal lacks authored variation: {layer_id}'
            )
    expected_runtime = {name for layer in LAYERS for name in runtime_names(layer)}
    actual_runtime = {path.name for path in RUNTIME_DIR.glob("*.png")}
    if actual_runtime != expected_runtime:
        raise RuntimeError("Runtime inventory mismatch")
    runtime_bytes = sum((RUNTIME_DIR / name).stat().st_size for name in expected_runtime)
    print(
        f"PASS: {len(LAYERS) * len(ROLE_SUFFIX)} retained 4K hashes and "
        f"{len(expected_runtime)} runtime hashes verified; disk runtime "
        f"{runtime_bytes / (1024 * 1024):.2f} MiB."
    )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="verify without rebuilding")
    args = parser.parse_args()
    if not args.check:
        build()
    verify()


if __name__ == "__main__":
    main()
