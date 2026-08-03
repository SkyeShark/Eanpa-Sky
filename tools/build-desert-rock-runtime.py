#!/usr/bin/env python3
# Deterministic 2K runtime builder for the untouched rock source.

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
SOURCE = ROOT / 'assets/terrain/Desert_rock_chunks_12_pieces.glb'
OUTPUT = ROOT / 'assets/terrain/Desert_rock_chunks_12_pieces_runtime_2k.glb'
MANIFEST = ROOT / 'assets/terrain/desert_rock_chunks_runtime_2k.json'


def align4(data: bytes, fill: bytes = bytes((0,))) -> bytes:
    return data + fill * ((-len(data)) % 4)


def parse_glb(data: bytes) -> tuple[dict, bytes]:
    magic, version, declared_length = struct.unpack_from('<4sII', data, 0)
    if magic != b'glTF' or version != 2 or declared_length != len(data):
        raise ValueError('Input is not a valid glTF 2.0 GLB')
    offset = 12
    gltf = None
    binary = None
    while offset < len(data):
        length, chunk_type = struct.unpack_from('<II', data, offset)
        offset += 8
        chunk = data[offset : offset + length]
        offset += length
        if chunk_type == 0x4E4F534A:
            gltf = json.loads(chunk.rstrip(bytes((32, 0))).decode('utf8'))
        elif chunk_type == 0x004E4942:
            binary = chunk
    if gltf is None or binary is None:
        raise ValueError('GLB is missing JSON or BIN data')
    return gltf, binary


def semantic_image_indices(gltf: dict) -> dict[int, set[str]]:
    roles: dict[int, set[str]] = {}

    def add(texture_info: dict | None, role: str) -> None:
        if not texture_info or not isinstance(texture_info.get('index'), int):
            return
        texture = gltf.get('textures', [])[texture_info['index']]
        source = texture.get('source')
        if isinstance(source, int):
            roles.setdefault(source, set()).add(role)

    for material in gltf.get('materials', []):
        pbr = material.get('pbrMetallicRoughness', {})
        add(pbr.get('baseColorTexture'), 'baseColor')
        add(pbr.get('metallicRoughnessTexture'), 'metallicRoughness')
        add(material.get('normalTexture'), 'normal')
        add(material.get('occlusionTexture'), 'occlusion')
        add(material.get('emissiveTexture'), 'emissive')
    return roles


def resize_normal_map(image: Image.Image, size: tuple[int, int]) -> Image.Image:
    resized = image.convert('RGB').resize(size, Image.Resampling.LANCZOS)
    encoded = np.asarray(resized, dtype=np.float32)
    vectors = encoded / 127.5 - 1.0
    lengths = np.linalg.norm(vectors, axis=2, keepdims=True)
    vectors /= np.maximum(lengths, 1.0e-8)
    encoded = np.clip(np.rint((vectors + 1.0) * 127.5), 0, 255).astype(np.uint8)
    return Image.fromarray(encoded, 'RGB')


def resize_image(payload: bytes, name: str, roles: set[str]) -> tuple[bytes, dict]:
    with Image.open(io.BytesIO(payload)) as source:
        source.load()
        original_size = list(source.size)
        scale = min(1.0, TARGET_SIZE / max(source.size))
        runtime_size = (
            max(1, round(source.size[0] * scale)),
            max(1, round(source.size[1] * scale)),
        )
        if 'normal' in roles:
            resized = resize_normal_map(source, runtime_size)
            treatment = 'lanczos_then_unit_vector_renormalization'
        else:
            resized = source.resize(runtime_size, Image.Resampling.LANCZOS)
            treatment = 'lanczos_downsample' if scale < 1.0 else 'preserved_resolution'
        output = io.BytesIO()
        resized.save(output, format='PNG', optimize=True, compress_level=9)
    encoded = output.getvalue()
    return encoded, {
        'name': name,
        'roles': sorted(roles),
        'sourceSize': original_size,
        'runtimeSize': list(runtime_size),
        'treatment': treatment,
        'encodedBytes': len(encoded),
    }


def build_runtime_glb() -> dict:
    source_data = SOURCE.read_bytes()
    gltf, binary = parse_glb(source_data)
    roles_by_image = semantic_image_indices(gltf)
    image_views = {
        image['bufferView']: (index, image.get('name', f'image_{index}'))
        for index, image in enumerate(gltf.get('images', []))
    }
    rebuilt = bytearray()
    image_report = []
    for index, view in enumerate(gltf['bufferViews']):
        start = view.get('byteOffset', 0)
        payload = binary[start : start + view['byteLength']]
        if index in image_views:
            image_index, image_name = image_views[index]
            payload, report = resize_image(
                payload,
                image_name,
                roles_by_image.get(image_index, set()),
            )
            gltf['images'][image_index]['mimeType'] = 'image/png'
            image_report.append(report)
        while len(rebuilt) % 4:
            rebuilt.append(0)
        view['byteOffset'] = len(rebuilt)
        view['byteLength'] = len(payload)
        rebuilt.extend(payload)
    binary_chunk = align4(bytes(rebuilt))
    gltf['buffers'][0]['byteLength'] = len(binary_chunk)
    extras = gltf.setdefault('asset', {}).setdefault('extras', {})
    extras['runtimeDerivativeOf'] = SOURCE.name
    extras['runtimeTextureMaximum'] = TARGET_SIZE
    extras['normalMapRenormalized'] = True
    json_chunk = align4(
        json.dumps(gltf, separators=(',', ':'), ensure_ascii=False).encode('utf8'),
        bytes((32,)),
    )
    total_length = 12 + 8 + len(json_chunk) + 8 + len(binary_chunk)
    output_data = b''.join(
        (
            struct.pack('<4sII', b'glTF', 2, total_length),
            struct.pack('<II', len(json_chunk), 0x4E4F534A),
            json_chunk,
            struct.pack('<II', len(binary_chunk), 0x004E4942),
            binary_chunk,
        )
    )
    OUTPUT.write_bytes(output_data)
    return {
        'source': SOURCE.relative_to(ROOT).as_posix(),
        'runtime': OUTPUT.relative_to(ROOT).as_posix(),
        'sourceSha256': hashlib.sha256(source_data).hexdigest(),
        'runtimeSha256': hashlib.sha256(output_data).hexdigest(),
        'sourceBytes': len(source_data),
        'runtimeBytes': len(output_data),
        'images': image_report,
    }


def main() -> None:
    report = build_runtime_glb()
    manifest = {
        'schema': 'eanpa-desert-rock-chunks-runtime-2k-v1',
        'targetTextureMaximum': TARGET_SIZE,
        'originalUntouched': True,
        'asset': report,
    }
    MANIFEST.write_text(json.dumps(manifest, indent=2) + chr(10), encoding='utf8')
    print(json.dumps(manifest, indent=2))


if __name__ == '__main__':
    main()
