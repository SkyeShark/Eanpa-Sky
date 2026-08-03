#!/usr/bin/env python3
"""Normalize the retained image-generated escarpment reference to gray16.

The generated source is deliberately preserved verbatim.  This build step
removes presentation-range contrast, suppresses pixel-scale faux shading, and
enforces a zero-height border before any geometry is authored from the image.
"""

from __future__ import annotations

import hashlib
import json
import math
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "assets" / "terrain" / "painted_escarpment_height_source_v1.png"
OUTPUT = ROOT / "assets" / "terrain" / "painted_escarpment_height_v1.png"
MANIFEST = ROOT / "assets" / "terrain" / "painted_escarpment_height_v1.json"
SIZE = 1024
LOW_LUMA = 46.0
HIGH_LUMA = 205.0
EDGE_FADE = 0.075


def smoothstep(value: np.ndarray) -> np.ndarray:
    value = np.clip(value, 0.0, 1.0)
    return value * value * (3.0 - 2.0 * value)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def main() -> None:
    if not SOURCE.is_file():
        raise FileNotFoundError(SOURCE)

    source = Image.open(SOURCE).convert("L")
    source_size = source.size
    source = source.resize((SIZE, SIZE), Image.Resampling.LANCZOS)

    # Two controlled scales retain authored benches and drainage while
    # discarding the fine relief that belongs in the PBR normal maps.
    broad = np.asarray(source.filter(ImageFilter.GaussianBlur(3.4)), dtype=np.float32)
    medium = np.asarray(source.filter(ImageFilter.GaussianBlur(1.2)), dtype=np.float32)
    luminance = broad * 0.82 + medium * 0.18
    height = np.clip((luminance - LOW_LUMA) / (HIGH_LUMA - LOW_LUMA), 0.0, 1.0)
    height = smoothstep(height) ** 1.10

    yy, xx = np.mgrid[0:SIZE, 0:SIZE]
    edge_distance = np.minimum.reduce((xx, yy, SIZE - 1 - xx, SIZE - 1 - yy))
    edge_mask = smoothstep(edge_distance / (SIZE * EDGE_FADE))
    height *= edge_mask
    height[edge_distance < 4] = 0.0

    encoded = np.rint(np.clip(height, 0.0, 1.0) * 65535.0).astype("<u2")
    Image.fromarray(encoded, mode="I;16").save(OUTPUT, compress_level=9)

    nonzero = height[height > 0]
    manifest = {
        "schema": "eanpa-authored-heightmap-v1",
        "source": SOURCE.relative_to(ROOT).as_posix(),
        "sourceSha256": sha256(SOURCE),
        "sourcePixels": list(source_size),
        "output": OUTPUT.relative_to(ROOT).as_posix(),
        "outputSha256": sha256(OUTPUT),
        "outputPixels": [SIZE, SIZE],
        "encoding": "unsigned 16-bit linear grayscale; 0=buried terrain datum; 65535=module peak",
        "orientation": "top-left image origin; module front is image bottom",
        "normalization": {
            "lowLuma": LOW_LUMA,
            "highLuma": HIGH_LUMA,
            "broadBlurRadius": 3.4,
            "mediumBlurRadius": 1.2,
            "broadWeight": 0.82,
            "mediumWeight": 0.18,
            "edgeFadeFraction": EDGE_FADE,
        },
        "statistics": {
            "nonzeroFraction": float(np.count_nonzero(height) / height.size),
            "nonzeroMin": float(nonzero.min()) if nonzero.size else 0.0,
            "mean": float(height.mean()),
            "max": float(height.max()),
        },
        "authoringContract": {
            "preserveZeroBorder": True,
            "heightfieldProvidesPlanAndCap": True,
            "sideProfileAddsBenchesButtressesAndUndercuts": True,
            "runtimeCollision": False,
        },
    }
    MANIFEST.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(
        f"[heightmap] {OUTPUT.relative_to(ROOT)} {SIZE}x{SIZE} gray16 "
        f"sha256={manifest['outputSha256']}"
    )


if __name__ == "__main__":
    main()
