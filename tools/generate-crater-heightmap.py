#!/usr/bin/env python3
"""Generate the retained 16-bit height source for Eanpa's blast crater.

The browser terrain evaluates the same profile analytically so collision and
render geometry cannot diverge. This PNG is the editable terrain-authoring
source and can be brought into Blender or a sculpt/terrain package.
"""

from __future__ import annotations

import math
import pathlib
import struct
import zlib


SIZE = 1024
# The analytic ejecta field fades to zero at 1.72 crater radii (151.36 m).
# Retain a small zero-height border around that complete footprint so imports
# into Blender/terrain tools cannot create a raised square seam.
WORLD_SPAN_METERS = 320.0
CRATER_RADIUS_METERS = 88.0
# The analytic profile spans -23.5 m to about +16.47 m. Preserve modest
# headroom at both ends so the retained source never clips the asymmetric rim.
MIN_HEIGHT_METERS = -24.0
MAX_HEIGHT_METERS = 18.0
OUTPUT = pathlib.Path(__file__).resolve().parents[1] / "assets" / "terrain" / "nuclear_crater_heightmap.png"


def clamp01(value: float) -> float:
    return max(0.0, min(1.0, value))


def smooth(a: float, b: float, value: float) -> float:
    t = clamp01((value - a) / (b - a))
    return t * t * (3.0 - 2.0 * t)


def profile(x: float, z: float) -> float:
    angle = math.atan2(z, x)
    rim_warp = (
        1.0
        + math.sin(angle * 3.0 + 0.7) * 0.055
        + math.sin(angle * 7.0 - 1.4) * 0.027
        + math.sin(angle * 13.0 + 2.1) * 0.013
    )
    n = math.hypot(x, z) / (CRATER_RADIUS_METERS * rim_warp)
    bowl = -23.5 * (1.0 - smooth(0.13, 0.91, n))
    rim = math.exp(-((n - 1.0) / 0.115) ** 2) * (
        9.5 + 2.4 * math.sin(angle * 5.0 - 0.8)
    )
    ray = max(0.0, math.sin(angle * 9.0 + 0.9)) ** 5
    ejecta = (1.0 - smooth(1.0, 1.72, n)) * smooth(0.88, 1.03, n) * (
        2.1 + ray * 2.8
    )
    return bowl + rim + ejecta


def png_chunk(kind: bytes, data: bytes) -> bytes:
    payload = kind + data
    return struct.pack(">I", len(data)) + payload + struct.pack(">I", zlib.crc32(payload) & 0xFFFFFFFF)


def encode_gray16_png(rows: list[bytes], width: int, height: int) -> bytes:
    header = struct.pack(">IIBBBBB", width, height, 16, 0, 0, 0, 0)
    scanlines = b"".join(b"\x00" + row for row in rows)
    return (
        b"\x89PNG\r\n\x1a\n"
        + png_chunk(b"IHDR", header)
        + png_chunk(b"IDAT", zlib.compress(scanlines, 9))
        + png_chunk(b"IEND", b"")
    )


def main() -> None:
    rows: list[bytes] = []
    extent = WORLD_SPAN_METERS * 0.5
    scale = 65535.0 / (MAX_HEIGHT_METERS - MIN_HEIGHT_METERS)
    for py in range(SIZE):
        z = ((py / (SIZE - 1)) * 2.0 - 1.0) * extent
        row = bytearray()
        for px in range(SIZE):
            x = ((px / (SIZE - 1)) * 2.0 - 1.0) * extent
            height = max(MIN_HEIGHT_METERS, min(MAX_HEIGHT_METERS, profile(x, z)))
            sample = round((height - MIN_HEIGHT_METERS) * scale)
            row.extend(struct.pack(">H", sample))
        rows.append(bytes(row))
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_bytes(encode_gray16_png(rows, SIZE, SIZE))
    print(f"Wrote {OUTPUT} ({SIZE}x{SIZE}, gray16, {WORLD_SPAN_METERS:.0f} m span)")


if __name__ == "__main__":
    main()
