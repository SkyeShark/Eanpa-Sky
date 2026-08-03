#!/usr/bin/env python3
"""Build the deterministic 2K runtime Southwest ground texture pack.

The retained 4K source maps are immutable inputs. Runtime albedo is emitted as
lossless RGB PNG. Normal X/Y, roughness, and AO are packed into lossless RGBA
PNG after vector-aware Lanczos normal resizing and linear scalar resizing.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import tempfile
from typing import Any

import numpy as np
from PIL import Image


REPO_ROOT = Path(__file__).resolve().parents[1]
PACK_ROOT = REPO_ROOT / "assets" / "pbr" / "eanpa_southwest_ground_v2"
SOURCE_DIR = PACK_ROOT / "sources"
RUNTIME_DIR = PACK_ROOT / "runtime"
MANIFEST_PATH = PACK_ROOT / "manifest.json"
TARGET_SIZE = (2048, 2048)
SOURCE_SIZE = (4096, 4096)
RESAMPLE = Image.Resampling.LANCZOS

LAYERS: tuple[dict[str, Any], ...] = (
    {
        "id": "Ground079S",
        "extension": "jpg",
        "tile_span_m": [2, 2],
        "provider": "ambientCG",
        "source_url": "https://ambientcg.com/view?id=Ground079S",
    },
    {
        "id": "GravellySand",
        "extension": "png",
        "tile_span_m": [2.5, 2.5],
        "provider": "Poly Haven",
        "source_url": "https://polyhaven.com/a/gravelly_sand",
    },
    {
        "id": "RedLateriteSoilStones",
        "extension": "png",
        "tile_span_m": [2, 2],
        "provider": "Poly Haven",
        "source_url": "https://polyhaven.com/a/red_laterite_soil_stones",
    },
    {
        "id": "Ground062S",
        "extension": "jpg",
        "tile_span_m": [1.6, 1.6],
        "provider": "ambientCG",
        "source_url": "https://ambientcg.com/view?id=Ground062S",
    },
)

SOURCE_ROLES: tuple[tuple[str, str], ...] = (
    ("albedo", "Color"),
    ("normal_gl", "NormalGL"),
    ("roughness", "Roughness"),
    ("ao", "AO"),
    ("displacement", "Displacement"),
)

CHANNEL_PACKING = {
    "R": "renormalized tangent-space NormalGL X, encoded from [-1, 1] to [0, 255]",
    "G": "renormalized tangent-space NormalGL Y, encoded from [-1, 1] to [0, 255]",
    "B": "linear roughness, [0, 255]",
    "A": "linear ambient occlusion, [0, 255]",
    "normal_z_reconstruction": "sqrt(max(0, 1 - x*x - y*y))",
}


def source_filename(layer: dict[str, Any], role_suffix: str) -> str:
    return f"{layer['id']}_{role_suffix}_4K.{layer['extension']}"


def runtime_filenames(layer_id: str) -> tuple[str, str]:
    return (
        f"{layer_id}_Albedo_2K.png",
        f"{layer_id}_PackedNxyRoughAO_2K.png",
    )


def expected_source_names() -> set[str]:
    return {
        source_filename(layer, suffix)
        for layer in LAYERS
        for _, suffix in SOURCE_ROLES
    }


def expected_runtime_names() -> set[str]:
    return {
        name
        for layer in LAYERS
        for name in runtime_filenames(layer["id"])
    }


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def image_metadata(path: Path) -> dict[str, Any]:
    with Image.open(path) as image:
        return {
            "dimensions": [image.width, image.height],
            "mode": image.mode,
            "format": image.format,
        }


def file_record(path: Path) -> dict[str, Any]:
    record = {
        "path": path.relative_to(PACK_ROOT).as_posix(),
        "sha256": sha256_file(path),
        "byte_size": path.stat().st_size,
    }
    record.update(image_metadata(path))
    return record


def validate_source_inventory() -> None:
    if not SOURCE_DIR.is_dir():
        raise RuntimeError(f"Missing retained source directory: {SOURCE_DIR}")
    actual = {path.name for path in SOURCE_DIR.iterdir() if path.is_file()}
    expected = expected_source_names()
    missing = sorted(expected - actual)
    unexpected = sorted(actual - expected)
    if missing or unexpected:
        raise RuntimeError(
            "Retained source inventory mismatch; "
            f"missing={missing or 'none'}, unexpected={unexpected or 'none'}"
        )
    for name in sorted(expected):
        metadata = image_metadata(SOURCE_DIR / name)
        if metadata["dimensions"] != list(SOURCE_SIZE):
            raise RuntimeError(
                f"Expected retained 4K source {name} to be {SOURCE_SIZE}, "
                f"found {metadata['dimensions']}"
            )


def save_png_atomic(image: Image.Image, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    handle = tempfile.NamedTemporaryFile(
        prefix=f".{destination.name}.", suffix=".tmp", dir=destination.parent, delete=False
    )
    temporary = Path(handle.name)
    handle.close()
    try:
        image.save(
            temporary,
            format="PNG",
            optimize=False,
            compress_level=9,
        )
        os.replace(temporary, destination)
    finally:
        temporary.unlink(missing_ok=True)


def resize_float_component(component: np.ndarray) -> np.ndarray:
    float_image = Image.fromarray(np.asarray(component, dtype=np.float32))
    resized = float_image.resize(TARGET_SIZE, RESAMPLE)
    return np.asarray(resized, dtype=np.float32).copy()


def build_albedo(source: Path, destination: Path) -> None:
    with Image.open(source) as image:
        rgb = image.convert("RGB")
        output = rgb.resize(TARGET_SIZE, RESAMPLE)
    save_png_atomic(output, destination)


def load_scalar_linear(source: Path) -> np.ndarray:
    """Load a scalar source to normalized float without a transfer function."""
    with Image.open(source) as image:
        values = np.asarray(image).copy()
    if values.ndim != 2:
        raise RuntimeError(f"Expected one-channel scalar map: {source} ({values.shape})")
    if not np.issubdtype(values.dtype, np.integer):
        raise RuntimeError(f"Expected integer scalar source: {source} ({values.dtype})")
    maximum = float(np.iinfo(values.dtype).max)
    normalized = values.astype(np.float32) / maximum
    return resize_float_component(normalized)


def resized_normal_xy(source: Path) -> tuple[np.ndarray, np.ndarray]:
    """Decode, resize, then renormalize a tangent-space OpenGL normal map."""
    with Image.open(source) as image:
        encoded = np.asarray(image.convert("RGB"), dtype=np.uint8).copy()

    resized_components: list[np.ndarray] = []
    for channel in range(3):
        signed = encoded[:, :, channel].astype(np.float32)
        signed *= 2.0 / 255.0
        signed -= 1.0
        resized_components.append(resize_float_component(signed))
    del encoded

    x, y, z = resized_components
    magnitude = np.sqrt(x * x + y * y + z * z)
    invalid = magnitude < 1.0e-8
    safe_magnitude = np.where(invalid, 1.0, magnitude)
    x = x / safe_magnitude
    y = y / safe_magnitude
    x[invalid] = 0.0
    y[invalid] = 0.0
    return x, y


def encode_unorm8(values: np.ndarray) -> np.ndarray:
    clipped = np.clip(values, 0.0, 1.0)
    return np.floor(clipped * 255.0 + 0.5).astype(np.uint8)


def build_packed_map(
    normal_source: Path,
    roughness_source: Path,
    ao_source: Path,
    destination: Path,
) -> None:
    normal_x, normal_y = resized_normal_xy(normal_source)
    roughness = load_scalar_linear(roughness_source)
    ao = load_scalar_linear(ao_source)
    packed = np.empty((TARGET_SIZE[1], TARGET_SIZE[0], 4), dtype=np.uint8)
    packed[:, :, 0] = encode_unorm8(normal_x * 0.5 + 0.5)
    packed[:, :, 1] = encode_unorm8(normal_y * 0.5 + 0.5)
    packed[:, :, 2] = encode_unorm8(roughness)
    packed[:, :, 3] = encode_unorm8(ao)
    save_png_atomic(Image.fromarray(packed, mode="RGBA"), destination)


def make_source_records() -> tuple[list[dict[str, Any]], dict[str, str]]:
    layer_records: list[dict[str, Any]] = []
    source_hashes: dict[str, str] = {}
    for layer in LAYERS:
        records: dict[str, Any] = {}
        for role, suffix in SOURCE_ROLES:
            path = SOURCE_DIR / source_filename(layer, suffix)
            record = file_record(path)
            records[role] = record
            source_hashes[record["path"]] = record["sha256"]
        layer_records.append(records)
    return layer_records, source_hashes


def write_manifest_atomic(manifest: dict[str, Any]) -> None:
    payload = json.dumps(manifest, indent=2, ensure_ascii=False) + "\n"
    handle = tempfile.NamedTemporaryFile(
        prefix=".manifest.json.", suffix=".tmp", dir=PACK_ROOT, delete=False
    )
    temporary = Path(handle.name)
    try:
        handle.write(payload.encode("utf-8"))
        handle.close()
        os.replace(temporary, MANIFEST_PATH)
    finally:
        if not handle.closed:
            handle.close()
        temporary.unlink(missing_ok=True)


def build() -> None:
    validate_source_inventory()
    source_records, source_hashes_before = make_source_records()
    RUNTIME_DIR.mkdir(parents=True, exist_ok=True)

    manifest_layers: list[dict[str, Any]] = []
    for order, (layer, sources) in enumerate(zip(LAYERS, source_records, strict=True)):
        layer_id = layer["id"]
        albedo_name, packed_name = runtime_filenames(layer_id)
        albedo_path = RUNTIME_DIR / albedo_name
        packed_path = RUNTIME_DIR / packed_name
        print(f"Building {layer_id} albedo ...", flush=True)
        build_albedo(PACK_ROOT / sources["albedo"]["path"], albedo_path)
        print(f"Building {layer_id} packed normal/roughness/AO ...", flush=True)
        build_packed_map(
            PACK_ROOT / sources["normal_gl"]["path"],
            PACK_ROOT / sources["roughness"]["path"],
            PACK_ROOT / sources["ao"]["path"],
            packed_path,
        )
        manifest_layers.append(
            {
                "id": layer_id,
                "order": order,
                "tile_span_m": layer["tile_span_m"],
                "provenance": {
                    "provider": layer["provider"],
                    "asset_page_url": layer["source_url"],
                    "license": "CC0 1.0 Universal",
                    "license_url": "https://creativecommons.org/publicdomain/zero/1.0/",
                },
                "source": {
                    "resolution_class": "retained 4K masters",
                    "files": sources,
                },
                "runtime": {
                    "albedo": file_record(albedo_path),
                    "packed_normal_xy_roughness_ao": file_record(packed_path),
                },
                "future_spom_height": {
                    "enabled": False,
                    "source_master_path": sources["displacement"]["path"],
                    "runtime_height_path": None,
                    "reason": "Retained at authored 4K for a later SPOM implementation; not loaded by the current runtime.",
                },
            }
        )

    manifest = {
        "schema_version": 1,
        "generated_by": "tools/build-southwest-ground-textures.py",
        "hash_algorithm": "SHA-256",
        "deterministic_build": True,
        "layer_order": [layer["id"] for layer in LAYERS],
        "source_file_count": len(expected_source_names()),
        "runtime_file_count": len(expected_runtime_names()),
        "runtime_resolution": list(TARGET_SIZE),
        "runtime_png": {
            "lossless": True,
            "inherited_metadata_stripped": True,
            "albedo_mode": "RGB",
            "packed_mode": "RGBA",
            "resampling": "Lanczos",
        },
        "channel_packing": CHANNEL_PACKING,
        "layers": manifest_layers,
    }
    write_manifest_atomic(manifest)

    # The build never opens a retained source for writing. This extra hash check
    # makes accidental source mutation a hard failure before success is reported.
    for relative_path, before in source_hashes_before.items():
        after = sha256_file(PACK_ROOT / relative_path)
        if after != before:
            raise RuntimeError(f"Retained source changed during build: {relative_path}")


def verify_record(record: dict[str, Any], expected_mode: str | None = None) -> None:
    path = PACK_ROOT / record["path"]
    if not path.is_file():
        raise RuntimeError(f"Manifest path is missing: {record['path']}")
    actual_hash = sha256_file(path)
    if actual_hash != record["sha256"]:
        raise RuntimeError(f"SHA-256 mismatch: {record['path']}")
    if path.stat().st_size != record["byte_size"]:
        raise RuntimeError(f"Byte-size mismatch: {record['path']}")
    metadata = image_metadata(path)
    for key in ("dimensions", "mode", "format"):
        if metadata[key] != record[key]:
            raise RuntimeError(
                f"Image {key} mismatch for {record['path']}: "
                f"manifest={record[key]!r}, actual={metadata[key]!r}"
            )
    if expected_mode is not None and metadata["mode"] != expected_mode:
        raise RuntimeError(
            f"Expected {record['path']} mode {expected_mode}, found {metadata['mode']}"
        )


def verify() -> None:
    validate_source_inventory()
    if not MANIFEST_PATH.is_file():
        raise RuntimeError(f"Missing manifest: {MANIFEST_PATH}")
    manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    expected_order = [layer["id"] for layer in LAYERS]
    if manifest.get("layer_order") != expected_order:
        raise RuntimeError(
            f"Layer order mismatch: expected {expected_order}, found {manifest.get('layer_order')}"
        )
    if manifest.get("channel_packing") != CHANNEL_PACKING:
        raise RuntimeError("Manifest channel-packing declaration is not exact")
    if manifest.get("runtime_resolution") != list(TARGET_SIZE):
        raise RuntimeError("Manifest runtime resolution is not 2048 x 2048")
    layers = manifest.get("layers", [])
    if len(layers) != len(LAYERS):
        raise RuntimeError(f"Manifest must contain exactly {len(LAYERS)} layers")

    for expected, entry in zip(LAYERS, layers, strict=True):
        if entry.get("id") != expected["id"]:
            raise RuntimeError(f"Manifest layer mismatch: {entry.get('id')}")
        if entry.get("tile_span_m") != expected["tile_span_m"]:
            raise RuntimeError(f"Tile span mismatch for {expected['id']}")
        if entry.get("provenance", {}).get("source_url") is not None:
            raise RuntimeError("Use asset_page_url, not source_url, in manifest provenance")
        if entry.get("provenance", {}).get("asset_page_url") != expected["source_url"]:
            raise RuntimeError(f"Source URL mismatch for {expected['id']}")
        if entry.get("provenance", {}).get("license") != "CC0 1.0 Universal":
            raise RuntimeError(f"License mismatch for {expected['id']}")
        source_files = entry["source"]["files"]
        for role, suffix in SOURCE_ROLES:
            expected_path = f"sources/{source_filename(expected, suffix)}"
            if source_files[role]["path"] != expected_path:
                raise RuntimeError(f"Source path mismatch for {expected['id']} {role}")
            verify_record(source_files[role])

        albedo_name, packed_name = runtime_filenames(expected["id"])
        albedo = entry["runtime"]["albedo"]
        packed = entry["runtime"]["packed_normal_xy_roughness_ao"]
        if albedo["path"] != f"runtime/{albedo_name}":
            raise RuntimeError(f"Albedo runtime path mismatch for {expected['id']}")
        if packed["path"] != f"runtime/{packed_name}":
            raise RuntimeError(f"Packed runtime path mismatch for {expected['id']}")
        verify_record(albedo, "RGB")
        verify_record(packed, "RGBA")
        if albedo["dimensions"] != list(TARGET_SIZE):
            raise RuntimeError(f"Albedo is not 2048 x 2048 for {expected['id']}")
        if packed["dimensions"] != list(TARGET_SIZE):
            raise RuntimeError(f"Packed map is not 2048 x 2048 for {expected['id']}")

        height = entry.get("future_spom_height", {})
        if height.get("enabled") is not False or height.get("runtime_height_path") is not None:
            raise RuntimeError(f"Future SPOM height must remain disabled for {expected['id']}")
        if height.get("source_master_path") != source_files["displacement"]["path"]:
            raise RuntimeError(f"Future SPOM source height mismatch for {expected['id']}")

    runtime_actual = {path.name for path in RUNTIME_DIR.glob("*.png")}
    if runtime_actual != expected_runtime_names():
        raise RuntimeError(
            "Runtime PNG inventory mismatch; "
            f"expected={sorted(expected_runtime_names())}, actual={sorted(runtime_actual)}"
        )

    total = sum((RUNTIME_DIR / name).stat().st_size for name in expected_runtime_names())
    print(
        f"PASS: {len(expected_source_names())} retained source hashes and "
        f"{len(expected_runtime_names())} runtime hashes verified; "
        f"runtime total {total / (1024 * 1024):.2f} MiB."
    )
    for layer in layers:
        albedo = layer["runtime"]["albedo"]
        packed = layer["runtime"]["packed_normal_xy_roughness_ao"]
        print(
            f"  {layer['id']}: albedo {albedo['byte_size'] / (1024 * 1024):.2f} MiB, "
            f"packed {packed['byte_size'] / (1024 * 1024):.2f} MiB"
        )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--check",
        action="store_true",
        help="verify existing outputs and all manifest hashes without rebuilding",
    )
    arguments = parser.parse_args()
    if not arguments.check:
        build()
    verify()


if __name__ == "__main__":
    main()
