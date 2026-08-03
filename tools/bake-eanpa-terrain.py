"""Offline Eanpa terrain bake — Ekigar-method generation to prebaked assets.

The engine's world exists to prove the sky system runs fast; nothing about the
ground should cost runtime. This tool generates the ENTIRE terrain offline —
swiss-turbulence mountain masses (de Carpentier), gully erosion carving, wash
network, thermal talus relaxation — composites the gameplay flats (temple
platform, processional corridor, compound) into the bake, and emits versioned
assets the engine only loads:

  assets/terrain/baked/eanpa_terrain_v1_height.png      16-bit height
  assets/terrain/baked/eanpa_terrain_v1_material.png    RGBA masks:
        R = textureBase-style value map (soil bright / rock dark)
        G = wear/gully mask   B = ridge/crest mask   A = slope mask
  assets/terrain/baked/eanpa_terrain_v1_meta.json       extent/range/datums
  assets/terrain/baked/eanpa_terrain_v1_hillshade_preview.png  (human check)

Deterministic (fixed seed). CPU numpy only. Rerun freely; same bytes out.
Swiss turbulence is a faithful port of Ekigar registry.js swissField; the
gully pass is a slope-aligned stripe carve in phacelle's spirit (exact
phacelle port is a planned upgrade — swiss already carries the carved
flow-line read that motivates it).
"""
import json
import zlib
import struct
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / 'assets' / 'terrain' / 'baked'
VERSION = 1
SEED = 4319

SIZE = 2048                    # texels per side
HALF_EXTENT = 1600.0           # metres; world XZ in [-1600, +1600]
M_PER_TEXEL = HALF_EXTENT * 2 / SIZE

# ---- landscape design (metres) -------------------------------------------
FLOOR_ELEVATION = 2.0          # alluvial valley datum (matches current play floor)
MOUNTAIN_RING_INNER = 420.0    # valley floor stays open inside this radius
MOUNTAIN_RING_OUTER = 1050.0   # full mountain height reached here
MOUNTAIN_HEIGHT = 110.0        # relief of the surrounding ranges
RANGE_FADE_START = 1200.0      # beyond here ranges settle back toward plains
RANGE_FADE_END = 1520.0        # ... so the horizon and sky stay open
PLAINS_RELIEF = 14.0           # rolling structure outside the ranges
FOOTHILL_HEIGHT = 26.0         # rolling structure inside the valley rim
GULLY_DEPTH = 9.0              # max carve of the erosion pass
WASH_DEPTH = 2.2               # braided wash channels on the floor

# gameplay flats composited INTO the bake (centre x, centre z, radius, blend)
FLATS = [
    (0.0, 20.0, 130.0, 60.0),     # temple + compound
    (0.0, 150.0, 46.0, 40.0),     # processional approach, south of the gate
]


def hash2(ix, iy, seed):
    h = (ix.astype(np.int64) * 374761393 + iy.astype(np.int64) * 668265263
         + np.int64(seed) * 2246822519) & 0xFFFFFFFF
    h = (h ^ (h >> 13)) * 1274126177 & 0xFFFFFFFF
    h = h ^ (h >> 16)
    gx = ((h & 0xFFFF) / 32767.5) - 1.0
    gy = (((h >> 16) & 0xFFFF) / 32767.5) - 1.0
    return gx, gy


def noised(px, py, seed):
    """IQ gradient noise with analytic derivatives, vectorized."""
    ix, iy = np.floor(px), np.floor(py)
    fx, fy = px - ix, py - iy
    u = fx * fx * fx * (fx * (fx * 6 - 15) + 10)
    v = fy * fy * fy * (fy * (fy * 6 - 15) + 10)
    du = 30 * fx * fx * (fx * (fx - 2) + 1)
    dv = 30 * fy * fy * (fy * (fy - 2) + 1)
    gax, gay = hash2(ix, iy, seed)
    gbx, gby = hash2(ix + 1, iy, seed)
    gcx, gcy = hash2(ix, iy + 1, seed)
    gdx, gdy = hash2(ix + 1, iy + 1, seed)
    va = gax * fx + gay * fy
    vb = gbx * (fx - 1) + gby * fy
    vc = gcx * fx + gcy * (fy - 1)
    vd = gdx * (fx - 1) + gdy * (fy - 1)
    n = va + u * (vb - va) + v * (vc - va) + u * v * (va - vb - vc + vd)
    dx = (gax + u * (gbx - gax) + v * (gcx - gax) + u * v * (gax - gbx - gcx + gdx)
          + du * (vb - va + v * (va - vb - vc + vd)))
    dy = (gay + u * (gby - gay) + v * (gcy - gay) + u * v * (gay - gby - gcy + gdy)
          + dv * (vc - va + u * (va - vb - vc + vd)))
    return n, dx, dy


def swiss(px, py, seed, octaves=7, lacunarity=2.0, gain=0.5, warp=0.15):
    """de Carpentier swiss turbulence — Ekigar registry.js swissField port.
    Derivative feedback shears octaves downhill; amplitude damps on ridges'
    complement so detail concentrates where erosion would leave it."""
    total = np.zeros_like(px)
    dsum_x = np.zeros_like(px)
    dsum_y = np.zeros_like(px)
    freq, amp = 1.0, 1.0
    for octave in range(octaves):
        n, dx, dy = noised(px * freq + warp * dsum_x / max(freq, 1.0),
                           py * freq + warp * dsum_y / max(freq, 1.0),
                           seed + octave * 133)
        ridged = 1.0 - np.abs(n)
        total = total + amp * ridged
        sign = -np.sign(n)
        dsum_x = dsum_x + amp * sign * dx
        dsum_y = dsum_y + amp * sign * dy
        freq *= lacunarity
        amp *= gain * np.clip(total, 0.0, 1.0)
    return total / 1.9      # ~[0, 1]


def fbm(px, py, seed, octaves=5, lacunarity=2.0, gain=0.5):
    total = np.zeros_like(px)
    freq, amp, norm = 1.0, 1.0, 0.0
    for octave in range(octaves):
        n, _, _ = noised(px * freq, py * freq, seed + octave * 71)
        total = total + amp * n
        norm += amp
        freq *= lacunarity
        amp *= gain
    return total / norm


def gully_carve(height, strength, seed):
    """Slope-aligned stripe erosion in phacelle's spirit: stripes run along
    the local downslope direction, deepened where slope is strong, with a
    second octave carving what the first exposed."""
    carved = height.copy()
    yy, xx = np.mgrid[0:SIZE, 0:SIZE].astype(np.float64)
    for octave, (freq, share) in enumerate(((0.055, 0.62), (0.11, 0.38))):
        gy, gx = np.gradient(carved, M_PER_TEXEL)
        slope = np.hypot(gx, gy)
        inv = 1.0 / np.maximum(slope, 1e-6)
        dx, dy = gx * inv, gy * inv
        # phase advances ACROSS the slope => stripes run WITH the fall line
        phase = (xx * -dy + yy * dx) * (M_PER_TEXEL * freq * 2 * np.pi)
        wob = fbm(xx * 0.004 + octave * 7, yy * 0.004 - octave * 3, seed + octave)
        stripe = 0.5 - 0.5 * np.cos(phase + wob * 5.2)
        gate = np.clip((slope - 0.06) * 6.0, 0.0, 1.0)
        carved = carved - strength * share * (stripe ** 1.6) * gate
    return carved


def thermal(height, iterations=24, talus=0.85):
    """Mass-conserving talus relaxation: oversteep faces shed to neighbours."""
    h = height.copy()
    limit = talus * M_PER_TEXEL
    for _ in range(iterations):
        moved = np.zeros_like(h)
        for shift_y, shift_x in ((0, 1), (0, -1), (1, 0), (-1, 0)):
            n = np.roll(h, (shift_y, shift_x), axis=(0, 1))
            d = h - n
            flux = np.clip((d - limit) * 0.25, 0.0, None)
            moved -= flux
            moved += np.roll(flux, (-shift_y, -shift_x), axis=(0, 1))
        h = h + moved
    return h


def write_png16(path, array01):
    data = np.clip(array01 * 65535.0 + 0.5, 0, 65535).astype('>u2')
    raw = b''.join(b'\x00' + row.tobytes() for row in data)
    def chunk(tag, body):
        c = tag + body
        return struct.pack('>I', len(body)) + c + struct.pack('>I', zlib.crc32(c))
    ihdr = struct.pack('>IIBBBBB', SIZE, SIZE, 16, 0, 0, 0, 0)
    path.write_bytes(b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', ihdr)
                     + chunk(b'IDAT', zlib.compress(raw, 9)) + chunk(b'IEND', b''))


def write_png8_rgba(path, r, g, b, a):
    data = np.stack([np.clip(c * 255.0 + 0.5, 0, 255).astype(np.uint8)
                     for c in (r, g, b, a)], axis=-1)
    raw = b''.join(b'\x00' + row.tobytes() for row in data)
    def chunk(tag, body):
        c = tag + body
        return struct.pack('>I', len(body)) + c + struct.pack('>I', zlib.crc32(c))
    ihdr = struct.pack('>IIBBBBB', SIZE, SIZE, 8, 6, 0, 0, 0)
    path.write_bytes(b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', ihdr)
                     + chunk(b'IDAT', zlib.compress(raw, 9)) + chunk(b'IEND', b''))


def main():
    yy, xx = np.mgrid[0:SIZE, 0:SIZE]
    wx = (xx + 0.5) * M_PER_TEXEL - HALF_EXTENT
    wz = (yy + 0.5) * M_PER_TEXEL - HALF_EXTENT
    radius = np.hypot(wx, wz)

    # mountain envelope: opens the valley, DIRECTIONAL ranges beyond. A pure
    # radial ring read as a bowl walling off the horizon — the one thing this
    # world must never do to its sky. Angular noise breaks the ring into
    # separate ranges with wide passes between them, and past the fade band
    # the ranges settle back into rolling plains so the horizon stays open.
    t = np.clip((radius - MOUNTAIN_RING_INNER)
                / (MOUNTAIN_RING_OUTER - MOUNTAIN_RING_INNER), 0.0, 1.0)
    ring = t * t * (3 - 2 * t)
    angle = np.arctan2(wz, wx)
    sector = fbm(np.cos(angle) * 1.7 + 5.0, np.sin(angle) * 1.7 - 3.0, SEED + 77,
                 octaves=3)
    sector_mask = np.clip((sector + 0.18) * 2.6, 0.0, 1.0)
    far_fade = 1.0 - np.clip((radius - RANGE_FADE_START)
                             / (RANGE_FADE_END - RANGE_FADE_START), 0.0, 1.0)
    envelope = ring * sector_mask * (far_fade ** 1.5)

    print('swiss turbulence…')
    mountains = swiss(wx / 900.0, wz / 900.0, SEED) * MOUNTAIN_HEIGHT
    foothills = swiss(wx / 260.0, wz / 260.0, SEED + 9000, octaves=5) * FOOTHILL_HEIGHT
    floor_relief = fbm(wx / 60.0, wz / 60.0, SEED + 500) * 1.6

    wash = fbm(wx / 140.0, wz / 190.0, SEED + 700)
    wash_mask = np.clip(1.0 - np.abs(wash) * 7.0, 0.0, 1.0) ** 2
    inner = 1.0 - envelope

    height = (FLOOR_ELEVATION
              + envelope * mountains
              + inner * (0.35 + 0.65 * envelope) * foothills * 0.4
              + inner * foothills * 0.28
              + floor_relief
              - inner * wash_mask * WASH_DEPTH)

    print('gully carve…')
    height = gully_carve(height, GULLY_DEPTH, SEED + 300)
    print('thermal relaxation…')
    height = thermal(height)

    # composite gameplay flats INTO the bake
    for (fx, fz, frad, fblend) in FLATS:
        d = np.hypot(wx - fx, wz - fz)
        k = np.clip((d - frad) / fblend, 0.0, 1.0)
        k = k * k * (3 - 2 * k)
        height = FLOOR_ELEVATION * (1 - k) + height * k

    h_min, h_max = float(height.min()), float(height.max())
    print(f'height range: {h_min:.2f}..{h_max:.2f} m')

    # material masks from the FINAL height (finite differences, Ekigar's rule)
    gy, gx = np.gradient(height, M_PER_TEXEL)
    slope = np.hypot(gx, gy)
    slope_mask = np.clip(slope / 0.9, 0.0, 1.0)
    lap = (np.roll(height, 1, 0) + np.roll(height, -1, 0)
           + np.roll(height, 1, 1) + np.roll(height, -1, 1) - 4 * height) \
        / (M_PER_TEXEL ** 2)
    concave = np.clip(lap * 2.2, 0.0, 1.0)
    ridge = np.clip(-lap * 2.2, 0.0, 1.0) * np.clip((height - FLOOR_ELEVATION) / 60.0, 0, 1)
    patches = fbm(wx / 130.0, wz / 130.0, SEED + 41) * 0.5 + 0.5
    soil = np.clip(1.0 - slope / 0.35, 0.0, 1.0) * np.clip(concave + 0.25, 0.0, 1.0)
    value = np.clip(0.5 + soil * 0.42 * 0.5 - slope_mask * 0.55 * 0.6
                    + ridge * 0.45 * 0.45 + (patches - 0.5) * 0.42 * 0.42, 0.0, 1.0)
    wear = np.clip(slope_mask * 0.75 + concave * 0.35, 0.0, 1.0)

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    # raw float32 metres, row 0 = north (wz = -halfExtent): the engine loads
    # this directly via fetch/Float32Array — no PNG decode risk in the loop
    (OUT_DIR / 'eanpa_terrain_v1_height.f32').write_bytes(
        height.astype('<f4').tobytes())
    write_png16(OUT_DIR / 'eanpa_terrain_v1_height.png', (height - h_min) / (h_max - h_min))
    write_png8_rgba(OUT_DIR / 'eanpa_terrain_v1_material.png', value, wear, ridge, slope_mask)

    # hillshade preview for human review
    azimuth, altitude = np.deg2rad(315), np.deg2rad(38)
    shade = (np.sin(altitude) - np.cos(altitude)
             * (gx * np.cos(azimuth) - gy * np.sin(azimuth))) \
        / np.sqrt(1 + slope ** 2)
    shade = np.clip((shade - shade.min()) / (shade.max() - shade.min()), 0, 1)
    write_png8_rgba(OUT_DIR / 'eanpa_terrain_v1_hillshade_preview.png',
                    shade, shade, shade, np.ones_like(shade))

    (OUT_DIR / 'eanpa_terrain_v1_meta.json').write_text(json.dumps({
        'version': VERSION, 'seed': SEED, 'size': SIZE,
        'halfExtentMeters': HALF_EXTENT, 'metersPerTexel': M_PER_TEXEL,
        'heightMinMeters': round(h_min, 4), 'heightMaxMeters': round(h_max, 4),
        'floorElevationMeters': FLOOR_ELEVATION,
        'rowOrder': 'north-to-south (row 0 = wz -halfExtent)',
        'encoding': 'height01 = (png16 / 65535); meters = min + height01 * (max - min)',
        'materialChannels': {'r': 'textureBaseValue', 'g': 'wearGully',
                             'b': 'ridgeCrest', 'a': 'slopeMask'},
        'flats': [{'x': f[0], 'z': f[1], 'radius': f[2], 'blend': f[3],
                   'elevation': FLOOR_ELEVATION} for f in FLATS],
        'generator': 'tools/bake-eanpa-terrain.py (swiss turbulence + gully carve + thermal talus)',
    }, indent=2), encoding='utf-8')
    print('assets written to', OUT_DIR)


if __name__ == '__main__':
    main()
