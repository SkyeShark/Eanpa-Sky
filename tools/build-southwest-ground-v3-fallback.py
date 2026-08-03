#!/usr/bin/env python3
"""Build/check the lossless 1K RGBA8 fallback for Southwest ground v3.

The authoritative 2K runtime PNGs remain untouched.  Every channel is resized
independently so numeric height, roughness, and AO bytes never participate in a
color or alpha conversion.  Packed NormalGL X/Y are decoded after resizing,
made reconstructable as a unit normal, and re-encoded to UNORM8.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
from typing import Any

import numpy as np
from PIL import Image


REPO_ROOT = Path(__file__).resolve().parents[1]
PACK_ROOT = REPO_ROOT / "assets" / "pbr" / "eanpa_southwest_ground_v3"
RUNTIME_DIR = PACK_ROOT / "runtime"
SOURCE_MANIFEST_PATH = PACK_ROOT / "manifest.json"
FALLBACK_DIR = RUNTIME_DIR / "fallback_1k"
FALLBACK_MANIFEST_PATH = FALLBACK_DIR / "manifest.json"

SOURCE_SIZE = (2048, 2048)
TARGET_SIZE = (1024, 1024)
LAYER_COUNT = 14
CHANNELS_PER_ARRAY = 4
ARRAY_COUNT = 2
TEXTURE_COUNT = LAYER_COUNT * ARRAY_COUNT
BYTES_PER_ARRAY = TARGET_SIZE[0] * TARGET_SIZE[1] * CHANNELS_PER_ARRAY * LAYER_COUNT
TOTAL_DECODED_BYTES = BYTES_PER_ARRAY * ARRAY_COUNT
RESAMPLE = Image.Resampling.LANCZOS
EXPECTED_LAYER_ORDER = (
    "RockyTrail02",
    "DryGroundRocks",
    "RedLateriteSoilStones",
    "CrackedRedGround",
    "MudCrackedDryRiverbed002",
    "Rock029",
    "Rock061",
    "GravellySand",
    "RockFace03",
    "SandyGravel02",
    "RockyTrail",
    "RockFace",
    "RockBoulderCracked",
    "RocksGround02",
)
ROLE_SPECS = (
    ("albedo_height", "albedo"),
    ("packed_normal_xy_roughness_ao", "packed_normal_xy_roughness_ao"),
)


class ValidationError(RuntimeError):
    """Raised when source or fallback pack invariants do not hold."""


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def output_set_sha256(records: list[dict[str, Any]]) -> str:
    """Hash the ordered filename/hash pairs without reading pixels again."""
    digest = hashlib.sha256()
    for record in records:
        digest.update(record["path"].encode("utf-8"))
        digest.update(b"\0")
        digest.update(bytes.fromhex(record["sha256"]))
        digest.update(b"\n")
    return digest.hexdigest()


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValidationError(message)


def load_json(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ValidationError(f"cannot read JSON {path}: {exc}") from exc
    require(isinstance(value, dict), f"JSON root is not an object: {path}")
    return value


def assert_runtime_source(path: Path) -> None:
    resolved = path.resolve()
    require(resolved.parent == RUNTIME_DIR.resolve(), f"source is not a direct runtime PNG: {path}")


def inspect_rgba_png(path: Path, expected_size: tuple[int, int]) -> None:
    require(path.is_file(), f"missing PNG: {path}")
    try:
        with Image.open(path) as image:
            require(image.format == "PNG", f"not PNG: {path}")
            require(image.mode == "RGBA", f"expected RGBA, got {image.mode}: {path}")
            require(image.size == expected_size, f"expected {expected_size}, got {image.size}: {path}")
            image.load()
    except OSError as exc:
        raise ValidationError(f"cannot decode {path}: {exc}") from exc


def read_source_specs() -> tuple[dict[str, Any], list[dict[str, Any]], str]:
    manifest = load_json(SOURCE_MANIFEST_PATH)
    source_manifest_hash = sha256_file(SOURCE_MANIFEST_PATH)
    require(manifest.get("layer_order") == list(EXPECTED_LAYER_ORDER), "authoritative layer order changed")
    require(manifest.get("runtime_file_count") == TEXTURE_COUNT, "source runtime_file_count is not 28")
    require(manifest.get("runtime_resolution") == list(SOURCE_SIZE), "source runtime resolution is not 2048x2048")
    layers = manifest.get("layers")
    require(isinstance(layers, list) and len(layers) == LAYER_COUNT, "source manifest must contain 14 layers")

    specs: list[dict[str, Any]] = []
    for order, expected_id in enumerate(EXPECTED_LAYER_ORDER):
        layer = layers[order]
        require(isinstance(layer, dict), f"source layer {order} is not an object")
        require(layer.get("id") == expected_id, f"source layer {order} is not {expected_id}")
        require(layer.get("order") == order, f"source layer order field is wrong for {expected_id}")
        runtime = layer.get("runtime")
        require(isinstance(runtime, dict), f"source runtime metadata missing for {expected_id}")
        files: list[dict[str, Any]] = []
        for output_role, source_role in ROLE_SPECS:
            metadata = runtime.get(source_role)
            require(isinstance(metadata, dict), f"source {source_role} metadata missing for {expected_id}")
            relative = metadata.get("path")
            require(isinstance(relative, str), f"source path missing for {expected_id}/{source_role}")
            source_path = PACK_ROOT / relative
            assert_runtime_source(source_path)
            require(metadata.get("dimensions") == list(SOURCE_SIZE), f"source metadata dimensions wrong: {relative}")
            require(metadata.get("mode") == "RGBA", f"source metadata mode wrong: {relative}")
            require(metadata.get("format") == "PNG", f"source metadata format wrong: {relative}")
            inspect_rgba_png(source_path, SOURCE_SIZE)
            actual_hash = sha256_file(source_path)
            require(actual_hash == metadata.get("sha256"), f"source hash mismatch: {relative}")
            require(source_path.name.endswith("_2K.png"), f"unexpected source filename: {source_path.name}")
            output_name = (
                f"{expected_id}_AlbedoHeight_1K.png"
                if output_role == "albedo_height"
                else f"{expected_id}_PackedNxyRoughAO_1K.png"
            )
            files.append({
                "role": output_role,
                "source_role": source_role,
                "source_path": source_path,
                "source_relative": relative.replace("\\", "/"),
                "source_sha256": actual_hash,
                "output_name": output_name,
            })
        specs.append({
            "id": expected_id,
            "order": order,
            "semantic": layer.get("semantic"),
            "files": files,
        })
    return manifest, specs, source_manifest_hash


def resize_channels(image: Image.Image) -> list[Image.Image]:
    """Lanczos-filter raw byte channels independently; perform no color conversion."""
    require(image.mode == "RGBA", f"internal mode is not RGBA: {image.mode}")
    return [channel.resize(TARGET_SIZE, RESAMPLE) for channel in image.split()]


def make_normal_xy_valid(red: np.ndarray, green: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Make resized NormalGL XY reconstructable, with minimal UNORM8 repair."""
    xy = np.stack((red, green), axis=-1).astype(np.float32)
    xy = xy * (2.0 / 255.0) - 1.0
    length = np.linalg.norm(xy, axis=-1)
    outside = length > 1.0
    if np.any(outside):
        xy[outside] /= length[outside, None]

    # Reconstruct Z and normalize the full vector.  This is an identity for
    # already-valid XY, but documents and enforces the unit-normal invariant.
    z = np.sqrt(np.maximum(0.0, 1.0 - np.sum(xy * xy, axis=-1)))
    xyz = np.concatenate((xy, z[..., None]), axis=-1)
    xyz /= np.maximum(np.linalg.norm(xyz, axis=-1, keepdims=True), 1.0e-12)
    encoded = np.rint(np.clip(xyz[..., :2] * 0.5 + 0.5, 0.0, 1.0) * 255.0).astype(np.uint8)

    # Quantization can place an exactly grazing vector just outside the unit
    # disk. Move its larger component one code toward neutral until Z is real.
    for _ in range(4):
        decoded = encoded.astype(np.float32) * (2.0 / 255.0) - 1.0
        invalid = np.sum(decoded * decoded, axis=-1) > 1.0
        if not np.any(invalid):
            break
        choose_x = np.abs(decoded[..., 0]) >= np.abs(decoded[..., 1])
        for component, chosen in ((0, choose_x), (1, ~choose_x)):
            mask = invalid & chosen
            values = encoded[..., component]
            values[mask] = np.where(values[mask] >= 128, values[mask] - 1, values[mask] + 1)
    decoded = encoded.astype(np.float32) * (2.0 / 255.0) - 1.0
    require(bool(np.all(np.sum(decoded * decoded, axis=-1) <= 1.0)), "normal XY quantization repair failed")
    return encoded[..., 0], encoded[..., 1]


def save_png_atomic(image: Image.Image, output_path: Path) -> None:
    temporary = output_path.with_name(f".{output_path.name}.tmp.png")
    try:
        image.save(temporary, format="PNG", compress_level=9, optimize=False)
        os.replace(temporary, output_path)
    finally:
        if temporary.exists():
            temporary.unlink()


def build_one(source_path: Path, output_path: Path, role: str) -> None:
    with Image.open(source_path) as source:
        require(source.format == "PNG" and source.mode == "RGBA", f"invalid source: {source_path}")
        require(source.size == SOURCE_SIZE, f"invalid source dimensions: {source_path}")
        channels = resize_channels(source)

    if role == "packed_normal_xy_roughness_ao":
        red = np.asarray(channels[0], dtype=np.uint8).copy()
        green = np.asarray(channels[1], dtype=np.uint8).copy()
        normal_x, normal_y = make_normal_xy_valid(red, green)
        channels[0] = Image.fromarray(normal_x, mode="L")
        channels[1] = Image.fromarray(normal_y, mode="L")
    output = Image.merge("RGBA", tuple(channels))
    save_png_atomic(output, output_path)


def write_json_atomic(path: Path, value: dict[str, Any]) -> None:
    temporary = path.with_name(f".{path.name}.tmp")
    text = json.dumps(value, indent=2, ensure_ascii=False) + "\n"
    try:
        temporary.write_text(text, encoding="utf-8", newline="\n")
        os.replace(temporary, path)
    finally:
        if temporary.exists():
            temporary.unlink()


def build() -> None:
    _, specs, source_manifest_hash = read_source_specs()
    FALLBACK_DIR.mkdir(parents=True, exist_ok=True)
    output_records: list[dict[str, Any]] = []
    manifest_layers: list[dict[str, Any]] = []

    for layer in specs:
        manifest_files: dict[str, Any] = {}
        for file_spec in layer["files"]:
            output_path = FALLBACK_DIR / file_spec["output_name"]
            build_one(file_spec["source_path"], output_path, file_spec["role"])
            inspect_rgba_png(output_path, TARGET_SIZE)
            record = {
                "role": file_spec["role"],
                "path": output_path.name,
                "sha256": sha256_file(output_path),
                "byte_size": output_path.stat().st_size,
                "dimensions": list(TARGET_SIZE),
                "mode": "RGBA",
                "format": "PNG",
                "source_path": file_spec["source_relative"],
                "source_sha256": file_spec["source_sha256"],
            }
            output_records.append(record)
            manifest_files[file_spec["role"]] = {key: value for key, value in record.items() if key != "role"}
        manifest_layers.append({
            "id": layer["id"],
            "order": layer["order"],
            "semantic": layer["semantic"],
            "files": manifest_files,
        })
        print(f"built {layer['order']:02d} {layer['id']}")

    manifest = {
        "schema_version": 1,
        "generated_by": "tools/build-southwest-ground-v3-fallback.py",
        "source_manifest": {
            "path": "../../manifest.json",
            "sha256": source_manifest_hash,
        },
        "deterministic_build": {
            "source": "28 verified 2048x2048 RGBA PNGs in authoritative layer order",
            "resampling": "Pillow Lanczos, each byte channel filtered independently",
            "numeric_channel_color_conversion": "none",
            "normal_xy": "resize R/G; decode NormalGL XY; unit-disk/full-vector renormalize; re-encode UNORM8",
            "png": "lossless RGBA, compress_level=9, optimize=false, no generated metadata",
        },
        "runtime_representation": "uncompressed RGBA8 texture-array source decoded from lossless PNG; no block-compression dependency",
        "layer_order": list(EXPECTED_LAYER_ORDER),
        "layer_count": LAYER_COUNT,
        "texture_count": TEXTURE_COUNT,
        "resolution": list(TARGET_SIZE),
        "mode": "RGBA",
        "decoded_memory": {
            "array_count": ARRAY_COUNT,
            "layer_count_per_array": LAYER_COUNT,
            "channels_per_array": CHANNELS_PER_ARRAY,
            "bytes_per_channel": 1,
            "base_level_bytes_per_array": BYTES_PER_ARRAY,
            "base_level_bytes_total": TOTAL_DECODED_BYTES,
        },
        "albedo_height_packing": {
            "RGB": "graded sRGB albedo bytes",
            "A": "linear relative height UNORM8",
        },
        "packed_pbr_packing": {
            "R": "renormalized tangent-space NormalGL X UNORM8",
            "G": "renormalized tangent-space NormalGL Y UNORM8",
            "B": "linear roughness UNORM8",
            "A": "linear ambient occlusion UNORM8",
            "normal_z_reconstruction": "sqrt(max(0, 1 - x*x - y*y))",
        },
        "png_disk_bytes": sum(record["byte_size"] for record in output_records),
        "output_set_sha256": output_set_sha256(output_records),
        "layers": manifest_layers,
    }
    write_json_atomic(FALLBACK_MANIFEST_PATH, manifest)
    print(f"wrote {FALLBACK_MANIFEST_PATH.relative_to(REPO_ROOT)}")


def normal_xy_stats(path: Path) -> dict[str, float]:
    with Image.open(path) as image:
        values = np.asarray(image, dtype=np.uint8)
    xy = values[..., :2].astype(np.float32) * (2.0 / 255.0) - 1.0
    length_squared = np.sum(xy * xy, axis=-1)
    return {
        "rms_xy": float(np.sqrt(np.mean(length_squared, dtype=np.float64))),
        "max_xy": float(np.sqrt(np.max(length_squared))),
        "r_span": float(np.ptp(values[..., 0])),
        "g_span": float(np.ptp(values[..., 1])),
    }


def check() -> dict[str, Any]:
    _, specs, source_manifest_hash = read_source_specs()
    manifest = load_json(FALLBACK_MANIFEST_PATH)
    require(manifest.get("schema_version") == 1, "fallback schema_version is not 1")
    require(manifest.get("generated_by") == "tools/build-southwest-ground-v3-fallback.py", "fallback builder id mismatch")
    require(manifest.get("source_manifest", {}).get("sha256") == source_manifest_hash, "fallback source manifest hash mismatch")
    require(manifest.get("layer_order") == list(EXPECTED_LAYER_ORDER), "fallback layer order mismatch")
    require(manifest.get("layer_count") == LAYER_COUNT, "fallback layer_count is not 14")
    require(manifest.get("texture_count") == TEXTURE_COUNT, "fallback texture_count is not 28")
    require(manifest.get("resolution") == list(TARGET_SIZE), "fallback resolution is not 1024x1024")
    require(manifest.get("mode") == "RGBA", "fallback mode is not RGBA")
    memory = manifest.get("decoded_memory", {})
    require(BYTES_PER_ARRAY == 58_720_256, "internal per-array decoded memory calculation changed")
    require(TOTAL_DECODED_BYTES == 117_440_512, "internal total decoded memory calculation changed")
    require(memory.get("base_level_bytes_per_array") == BYTES_PER_ARRAY, "fallback per-array decoded memory mismatch")
    require(memory.get("base_level_bytes_total") == TOTAL_DECODED_BYTES, "fallback total decoded memory mismatch")
    require(memory.get("array_count") == ARRAY_COUNT, "fallback array count mismatch")
    require(memory.get("layer_count_per_array") == LAYER_COUNT, "fallback array layer count mismatch")

    layers = manifest.get("layers")
    require(isinstance(layers, list) and len(layers) == LAYER_COUNT, "fallback must contain 14 layer entries")
    expected_names = {"manifest.json"}
    output_records: list[dict[str, Any]] = []
    normal_summaries: list[dict[str, Any]] = []
    for order, (expected_id, source_layer) in enumerate(zip(EXPECTED_LAYER_ORDER, specs, strict=True)):
        layer = layers[order]
        require(layer.get("id") == expected_id and layer.get("order") == order, f"fallback layer order mismatch at {order}")
        files = layer.get("files")
        require(isinstance(files, dict), f"fallback files missing for {expected_id}")
        source_by_role = {item["role"]: item for item in source_layer["files"]}
        for role, _ in ROLE_SPECS:
            metadata = files.get(role)
            require(isinstance(metadata, dict), f"fallback {role} missing for {expected_id}")
            source_spec = source_by_role[role]
            require(metadata.get("path") == source_spec["output_name"], f"fallback filename mismatch for {expected_id}/{role}")
            require(metadata.get("source_path") == source_spec["source_relative"], f"fallback source path mismatch for {expected_id}/{role}")
            require(metadata.get("source_sha256") == source_spec["source_sha256"], f"fallback source hash mismatch for {expected_id}/{role}")
            require(metadata.get("dimensions") == list(TARGET_SIZE), f"fallback metadata dimensions mismatch for {expected_id}/{role}")
            require(metadata.get("mode") == "RGBA" and metadata.get("format") == "PNG", f"fallback metadata format mismatch for {expected_id}/{role}")
            output_path = FALLBACK_DIR / metadata["path"]
            expected_names.add(output_path.name)
            inspect_rgba_png(output_path, TARGET_SIZE)
            actual_hash = sha256_file(output_path)
            require(actual_hash == metadata.get("sha256"), f"fallback hash mismatch: {output_path.name}")
            require(output_path.stat().st_size == metadata.get("byte_size"), f"fallback byte size mismatch: {output_path.name}")
            record = {"path": output_path.name, "sha256": actual_hash, "byte_size": output_path.stat().st_size}
            output_records.append(record)
            if role == "packed_normal_xy_roughness_ao":
                stats = normal_xy_stats(output_path)
                require(stats["max_xy"] <= 1.0 + 1.0e-6, f"invalid reconstructed normal XY: {output_path.name}")
                require(stats["rms_xy"] > 0.01, f"flat normal XY: {output_path.name}")
                require(max(stats["r_span"], stats["g_span"]) >= 2.0, f"constant normal XY: {output_path.name}")
                normal_summaries.append({"layer": expected_id, **stats})

    actual_names = {path.name for path in FALLBACK_DIR.iterdir() if path.is_file()}
    require(actual_names == expected_names, f"unexpected/missing fallback files: {sorted(actual_names ^ expected_names)}")
    require(manifest.get("png_disk_bytes") == sum(item["byte_size"] for item in output_records), "fallback png_disk_bytes mismatch")
    require(manifest.get("output_set_sha256") == output_set_sha256(output_records), "fallback output-set hash mismatch")
    return {
        "layer_count": LAYER_COUNT,
        "texture_count": TEXTURE_COUNT,
        "png_disk_bytes": manifest["png_disk_bytes"],
        "directory_disk_bytes": sum(path.stat().st_size for path in FALLBACK_DIR.iterdir() if path.is_file()),
        "decoded_bytes_per_array": BYTES_PER_ARRAY,
        "decoded_bytes_total": TOTAL_DECODED_BYTES,
        "output_set_sha256": manifest["output_set_sha256"],
        "manifest_sha256": sha256_file(FALLBACK_MANIFEST_PATH),
        "minimum_normal_xy_rms": min(item["rms_xy"] for item in normal_summaries),
        "maximum_normal_xy_length": max(item["max_xy"] for item in normal_summaries),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="validate existing fallback without writing")
    args = parser.parse_args()
    try:
        if not args.check:
            build()
        result = check()
    except ValidationError as exc:
        print(f"ERROR: {exc}")
        return 1
    print(json.dumps(result, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
