#!/usr/bin/env python3
"""Sample embedded authored PBR maps across the routed thumb cap UV edge."""

from __future__ import annotations

import json
from pathlib import Path
import runpy

import bpy
from mathutils import Vector


ROOT = Path(__file__).resolve().parents[1]
BUILD = runpy.run_path(str(ROOT / "tools" / "build-first-person-viewmodel.py"))
BUILD["reset_scene"]()
bpy.ops.import_scene.gltf(filepath=str(BUILD["SOURCE"]))
mesh = BUILD["imported_aletheia_mesh"]()

first = Vector((0.11130700260400772, 0.5771679878234863))
second = Vector((0.11438599973917007, 0.5805749893188477))
direction = second - first
normal = Vector((-direction.y, direction.x)).normalized()
samples = []

for image in bpy.data.images:
    role = BUILD["texture_role"](image)
    if role is None:
        continue
    width, height = (int(image.size[0]), int(image.size[1]))
    pixels = image.pixels
    image_samples = []
    for fraction in (0.0, 0.25, 0.5, 0.75, 1.0):
        center = first.lerp(second, fraction)
        for offset_pixels in (-16, -8, -4, 0, 4, 8, 16):
            uv = center + normal * (offset_pixels / max(width, height))
            x = max(0, min(width - 1, int(round(uv.x * (width - 1)))))
            y = max(0, min(height - 1, int(round(uv.y * (height - 1)))))
            start = 4 * (y * width + x)
            image_samples.append(
                {
                    "fraction": fraction,
                    "normalOffsetPixels": offset_pixels,
                    "uv": list(uv),
                    "pixel": [x, y],
                    "rgba": [float(pixels[start + index]) for index in range(4)],
                }
            )
    samples.append(
        {
            "role": role,
            "image": image.name,
            "size": [width, height],
            "samples": image_samples,
        }
    )

print(json.dumps(samples, sort_keys=True))
