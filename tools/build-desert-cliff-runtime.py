#!/usr/bin/env python3
"""Build deterministic 2K runtime GLBs from the untouched user cliff assets."""

from __future__ import annotations

import hashlib
import io
import json
import struct
from pathlib import Path

import numpy as np
from PIL import Image


ROOT = Path(__file__).resolve().parents[1]
TARGET_SIZE = 2048
ASSETS = (
    (
        ROOT / "assets/terrain/Desert_Cliff_Wide_Mesa_Low.glb",
        ROOT / "assets/terrain/Desert_Cliff_Wide_Mesa_Low_runtime_2k.glb",
    ),
    (
        ROOT / "assets/terrain/Desert_Cliff_Mesa_High.glb",
        ROOT / "assets/terrain/Desert_Cliff_Mesa_High_runtime_2k.glb",
    ),
)
MANIFEST = ROOT / "assets/terrain/desert_cliff_runtime_2k.json"


def align4(data: bytes, fill: bytes = b"\0") -> bytes:
    return data + fill * ((-len(data)) % 4)


def parse_glb(data: bytes) -> tuple[dict, bytes]:
    magic, version, declared_length = struct.unpack_from("<4sII", data, 0)
    if magic != b"glTF" or version != 2 or declared_length != len(data):
        raise ValueError("Input is not a valid glTF 2.0 GLB")
    offset = 12
    gltf = None
    binary = None
    while offset < len(data):
        length, chunk_type = struct.unpack_from("<II", data, offset)
        offset += 8
        chunk = data[offset : offset + length]
        offset += length
        if chunk_type == 0x4E4F534A:
            gltf = json.loads(chunk.rstrip(b" \0").decode("utf8"))
        elif chunk_type == 0x004E4942:
            binary = chunk
    if gltf is None or binary is None:
        raise ValueError("GLB is missing JSON or BIN data")
    return gltf, binary


def resize_normal_map(image: Image.Image) -> Image.Image:
    resized = image.convert("RGB").resize(
        (TARGET_SIZE, TARGET_SIZE), Image.Resampling.LANCZOS
    )
    encoded = np.asarray(resized, dtype=np.float32)
    vectors = encoded / 127.5 - 1.0
    lengths = np.linalg.norm(vectors, axis=2, keepdims=True)
    vectors /= np.maximum(lengths, 1.0e-8)
    encoded = np.clip(np.rint((vectors + 1.0) * 127.5), 0, 255).astype(np.uint8)
    return Image.fromarray(encoded, "RGB")


def resize_png(payload: bytes, name: str) -> tuple[bytes, dict]:
    with Image.open(io.BytesIO(payload)) as source:
        source.load()
        original_size = list(source.size)
        if "normal" in name.lower():
            resized = resize_normal_map(source)
            treatment = "lanczos_then_unit_vector_renormalization"
        else:
            resized = source.resize(
                (TARGET_SIZE, TARGET_SIZE), Image.Resampling.LANCZOS
            )
            treatment = "lanczos"
        output = io.BytesIO()
        resized.save(output, format="PNG", optimize=True, compress_level=9)
    encoded = output.getvalue()
    return encoded, {
        "name": name,
        "sourceSize": original_size,
        "runtimeSize": [TARGET_SIZE, TARGET_SIZE],
        "treatment": treatment,
        "encodedBytes": len(encoded),
    }


def build_runtime_glb(source_path: Path, output_path: Path) -> dict:
    source_data = source_path.read_bytes()
    gltf, binary = parse_glb(source_data)
    image_views = {
        image["bufferView"]: (index, image.get("name", f"image_{index}"))
        for index, image in enumerate(gltf.get("images", []))
    }
    rebuilt = bytearray()
    image_report = []
    for index, view in enumerate(gltf["bufferViews"]):
        start = view.get("byteOffset", 0)
        payload = binary[start : start + view["byteLength"]]
        if index in image_views:
            _, image_name = image_views[index]
            payload, report = resize_png(payload, image_name)
            image_report.append(report)
        while len(rebuilt) % 4:
            rebuilt.append(0)
        view["byteOffset"] = len(rebuilt)
        view["byteLength"] = len(payload)
        rebuilt.extend(payload)
    binary_chunk = align4(bytes(rebuilt))
    gltf["buffers"][0]["byteLength"] = len(binary_chunk)
    asset_extras = gltf.setdefault("asset", {}).setdefault("extras", {})
    asset_extras["runtimeDerivativeOf"] = source_path.name
    asset_extras["runtimeTextureMaximum"] = TARGET_SIZE
    asset_extras["normalMapRenormalized"] = True
    json_chunk = align4(
        json.dumps(gltf, separators=(",", ":"), ensure_ascii=False).encode("utf8"),
        b" ",
    )
    total_length = 12 + 8 + len(json_chunk) + 8 + len(binary_chunk)
    output_data = b"".join(
        (
            struct.pack("<4sII", b"glTF", 2, total_length),
            struct.pack("<II", len(json_chunk), 0x4E4F534A),
            json_chunk,
            struct.pack("<II", len(binary_chunk), 0x004E4942),
            binary_chunk,
        )
    )
    output_path.write_bytes(output_data)
    return {
        "source": source_path.relative_to(ROOT).as_posix(),
        "runtime": output_path.relative_to(ROOT).as_posix(),
        "sourceSha256": hashlib.sha256(source_data).hexdigest(),
        "runtimeSha256": hashlib.sha256(output_data).hexdigest(),
        "sourceBytes": len(source_data),
        "runtimeBytes": len(output_data),
        "images": image_report,
    }


def main() -> None:
    reports = [build_runtime_glb(source, output) for source, output in ASSETS]
    manifest = {
        "schema": "eanpa-desert-cliff-runtime-2k-v1",
        "targetTextureSize": TARGET_SIZE,
        "originalsUntouched": True,
        "assets": reports,
    }
    MANIFEST.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf8")
    print(json.dumps(manifest, indent=2))


if __name__ == "__main__":
    main()
