#!/usr/bin/env python3
"""Acquire the immutable 4K CC0 masters for Eanpa's Southwest ground v3.

The twelve Poly Haven surfaces are fetched from their official 4K JPG map URLs.
AmbientCG's two surfaces are extracted from the official 4K-JPG archives.
The Red Laterite inputs are copied byte-for-byte from the retained v2 masters
only when every SHA-256 matches the v2 manifest; this avoids downloading a
second, differently encoded copy of an identical authored source.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import tempfile
import urllib.request
import zipfile

from PIL import Image


REPO_ROOT = Path(__file__).resolve().parents[1]
PACK_ROOT = REPO_ROOT / "assets" / "pbr" / "eanpa_southwest_ground_v3"
SOURCE_DIR = PACK_ROOT / "sources"
V2_ROOT = REPO_ROOT / "assets" / "pbr" / "eanpa_southwest_ground_v2"
USER_AGENT = "Eanpa-Engine-terrain-source-builder/3"

ROLES = {
    "Color": "diff",
    "NormalGL": "nor_gl",
    "Roughness": "rough",
    "AO": "ao",
    "Displacement": "disp",
}

POLY_HAVEN = {
    "DryGroundRocks": "dry_ground_rocks",
    "CrackedRedGround": "cracked_red_ground",
    "RockyTrail02": "rocky_trail_02",
    "MudCrackedDryRiverbed002": "mud_cracked_dry_riverbed_002",
}

AMBIENT_CG = ("Rock029", "Rock061")


POLY_HAVEN = {
    layer_id: {'slug': slug, 'albedo': 'diff'}
    for layer_id, slug in POLY_HAVEN.items()
}
POLY_HAVEN.update({
    'GravellySand': {'slug': 'gravelly_sand', 'albedo': 'diff'},
    'RockFace03': {'slug': 'rock_face_03', 'albedo': 'diff'},
    'SandyGravel02': {'slug': 'sandy_gravel_02', 'albedo': 'diff'},
    'RockyTrail': {'slug': 'rocky_trail', 'albedo': 'diff'},
    'RockFace': {'slug': 'rock_face', 'albedo': 'diff'},
    'RockBoulderCracked': {'slug': 'rock_boulder_cracked', 'albedo': 'diff'},
    # This older Poly Haven asset calls its albedo map 'col', not 'diff'.
    'RocksGround02': {
        'slug': 'rocks_ground_02', 'albedo': 'col', 'displacement': 'height',
    },
})


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def atomic_copy(source: Path, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    handle = tempfile.NamedTemporaryFile(
        prefix=f".{destination.name}.", suffix=".part", dir=destination.parent,
        delete=False,
    )
    temporary = Path(handle.name)
    handle.close()
    try:
        shutil.copyfile(source, temporary)
        os.replace(temporary, destination)
    finally:
        temporary.unlink(missing_ok=True)


def download(url: str, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    handle = tempfile.NamedTemporaryFile(
        prefix=f".{destination.name}.", suffix=".part", dir=destination.parent,
        delete=False,
    )
    temporary = Path(handle.name)
    try:
        request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
        with urllib.request.urlopen(request, timeout=120) as response:
            expected = int(response.headers.get("Content-Length", 0))
            copied = 0
            while True:
                block = response.read(1024 * 1024)
                if not block:
                    break
                handle.write(block)
                copied += len(block)
            if expected and copied != expected:
                raise RuntimeError(
                    f"Incomplete download for {url}: expected {expected}, received {copied}"
                )
        handle.close()
        os.replace(temporary, destination)
    finally:
        if not handle.closed:
            handle.close()
        temporary.unlink(missing_ok=True)


def validate_4k_image(path: Path) -> None:
    with Image.open(path) as image:
        if image.size != (4096, 4096):
            raise RuntimeError(f"Expected 4096 x 4096 source: {path} ({image.size})")
        image.verify()


def retain_red_laterite() -> None:
    manifest_path = V2_ROOT / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    entry = next(
        layer for layer in manifest["layers"] if layer["id"] == "RedLateriteSoilStones"
    )
    records = entry["source"]["files"]
    role_keys = {
        "Color": "albedo",
        "NormalGL": "normal_gl",
        "Roughness": "roughness",
        "AO": "ao",
        "Displacement": "displacement",
    }
    for suffix, role in role_keys.items():
        record = records[role]
        source = V2_ROOT / record["path"]
        if sha256_file(source) != record["sha256"]:
            raise RuntimeError(f"Retained v2 source hash mismatch: {source}")
        destination = SOURCE_DIR / f"RedLateriteSoilStones_{suffix}_4K.png"
        if not destination.exists() or sha256_file(destination) != record["sha256"]:
            print(f"Retaining exact v2 master {destination.name}", flush=True)
            atomic_copy(source, destination)
        validate_4k_image(destination)


def acquire_poly_haven() -> None:
    base = "https://dl.polyhaven.org/file/ph-assets/Textures/jpg/4k"
    for layer_id, asset in POLY_HAVEN.items():
        slug = asset['slug']
        for suffix, remote_suffix in ROLES.items():
            if suffix == 'Color':
                remote_suffix = asset['albedo']
            elif suffix == 'Displacement':
                remote_suffix = asset.get('displacement', 'disp')
            destination = SOURCE_DIR / f"{layer_id}_{suffix}_4K.jpg"
            if not destination.exists():
                url = f"{base}/{slug}/{slug}_{remote_suffix}_4k.jpg"
                print(f"Downloading {url}", flush=True)
                download(url, destination)
            validate_4k_image(destination)


def archive_member(archive: zipfile.ZipFile, layer_id: str, suffix: str) -> str:
    if suffix == 'AO':
        suffix = 'AmbientOcclusion'
    target = f"_{suffix}.jpg".lower()
    candidates = [
        name for name in archive.namelist()
        if Path(name).name.lower().startswith(layer_id.lower())
        and Path(name).name.lower().endswith(target)
    ]
    if len(candidates) != 1:
        raise RuntimeError(
            f"Expected one {layer_id} {suffix} JPG in archive, found {candidates}"
        )
    return candidates[0]


def acquire_ambient_cg() -> None:
    for layer_id in AMBIENT_CG:
        expected = [SOURCE_DIR / f"{layer_id}_{suffix}_4K.jpg" for suffix in ROLES]
        if all(path.exists() for path in expected):
            for path in expected:
                validate_4k_image(path)
            continue
        with tempfile.TemporaryDirectory(prefix=f"eanpa-{layer_id}-") as temp:
            archive_path = Path(temp) / f"{layer_id}_4K-JPG.zip"
            url = f"https://ambientcg.com/get?file={layer_id}_4K-JPG.zip"
            print(f"Downloading {url}", flush=True)
            download(url, archive_path)
            with zipfile.ZipFile(archive_path) as archive:
                for suffix in ROLES:
                    destination = SOURCE_DIR / f"{layer_id}_{suffix}_4K.jpg"
                    if destination.exists():
                        continue
                    member = archive_member(archive, layer_id, suffix)
                    with archive.open(member) as source:
                        handle = tempfile.NamedTemporaryFile(
                            prefix=f".{destination.name}.", suffix=".part",
                            dir=SOURCE_DIR, delete=False,
                        )
                        temporary = Path(handle.name)
                        try:
                            shutil.copyfileobj(source, handle, 1024 * 1024)
                            handle.close()
                            os.replace(temporary, destination)
                        finally:
                            if not handle.closed:
                                handle.close()
                            temporary.unlink(missing_ok=True)
                    validate_4k_image(destination)


def inventory() -> list[Path]:
    expected = []
    for layer_id in POLY_HAVEN:
        expected.extend(SOURCE_DIR / f"{layer_id}_{suffix}_4K.jpg" for suffix in ROLES)
    expected.extend(
        SOURCE_DIR / f"RedLateriteSoilStones_{suffix}_4K.png" for suffix in ROLES
    )
    for layer_id in AMBIENT_CG:
        expected.extend(SOURCE_DIR / f"{layer_id}_{suffix}_4K.jpg" for suffix in ROLES)
    return expected


def verify() -> None:
    missing = [path for path in inventory() if not path.is_file()]
    if missing:
        raise RuntimeError(f"Missing v3 sources: {[path.name for path in missing]}")
    for path in inventory():
        validate_4k_image(path)
    print(f"PASS: {len(inventory())} immutable 4K terrain masters verified.")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="verify without downloading")
    args = parser.parse_args()
    SOURCE_DIR.mkdir(parents=True, exist_ok=True)
    if not args.check:
        retain_red_laterite()
        acquire_poly_haven()
        acquire_ambient_cg()
    verify()


if __name__ == "__main__":
    main()
