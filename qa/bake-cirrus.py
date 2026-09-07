"""Deterministic, periodic optical-depth field of sheared ice fall trails.

This is an authored cloud-shape model, not a fluid or atmospheric simulation.
Each emitter has irregular lengths, a curved fall path and many fine strands.
Run with Python, numpy, numba and Pillow; no downloaded source imagery.
"""
from pathlib import Path
import json
import numpy as np
from numba import njit
from PIL import Image, ImageFilter

SIZE = 2048
WORLD_METERS = 18000
SEED = 509071
rng = np.random.default_rng(SEED)
field = np.zeros((SIZE, SIZE), dtype=np.float32)

@njit
def stroke(dst, xs, ys, widths, strength):
    n = dst.shape[0]
    for k in range(len(xs)):
        sigma = widths[k]
        radius = int(np.ceil(sigma * 2.5))
        x, y = xs[k], ys[k]
        for j in range(int(y)-radius, int(y)+radius+1):
            for i in range(int(x)-radius, int(x)+radius+1):
                d = ((i-x)**2 + (j-y)**2) / (2*sigma*sigma)
                if d < 6.25:
                    dst[j % n, i % n] += strength[k]*np.exp(-d)/sigma

EMITTERS = 94
for group in range(EMITTERS):
    cx, cy = rng.uniform(0, SIZE, 2)
    angle = rng.normal(0, .26)
    length = rng.uniform(65, 250)
    spread = rng.uniform(12, 40)
    curl = rng.uniform(-60, 60)
    phase = rng.uniform(0, np.pi*2)
    strands = int(rng.integers(30, 85))
    density = rng.uniform(.18, .55)
    for strand in range(strands):
        across = rng.normal(0, .48)
        span = length * rng.uniform(.6, 1.2) * (1-.2*abs(across))
        t = np.linspace(0, 1, max(96, int(span*2)))
        start = rng.normal(0, length*.20)
        x = span*(t-.45) + start
        y = across*spread*(.65+.5*t) + curl*t**2
        y += np.sin(t*3+phase)*length*.05*t
        y += np.sin(t*rng.uniform(9, 16)+rng.uniform(0, 6))*rng.uniform(.2, 1.3)*t
        widths = rng.uniform(.6, 1.6)*(1+.9*t)
        envelope = np.minimum(t/.07, 1) * (1-t)**rng.uniform(.65, 1.5)
        modulation = .58 + .24*np.sin(t*13+phase+across*2) + .18*np.sin(t*31+across*6)
        strength = envelope*density*rng.uniform(.4, 1.2)*modulation
        stroke(field, cx+x*np.cos(angle)-y*np.sin(angle),
               cy+x*np.sin(angle)+y*np.cos(angle), widths, strength)

opacity = 1-np.exp(-field*.30)
pixels = np.uint8(np.clip(opacity*255, 0, 255))
destination = Path(__file__).resolve().parents[1]/'assets/weather/cirrus_ice_trails.png'
# Wrap the blur margin as well as the strokes, retaining the periodic seam.
padded = Image.fromarray(np.pad(pixels, 20, mode='wrap'))
fine = padded.filter(ImageFilter.GaussianBlur(.45))
gauze = padded.filter(ImageFilter.GaussianBlur(3.5))
Image.blend(fine, gauze, .35).crop((20,20,SIZE+20,SIZE+20)).save(destination, optimize=True)
metadata = dict(seed=SEED, size=SIZE, worldMeters=WORLD_METERS, emitters=EMITTERS,
                coverage=float(np.mean(opacity>.025)), meanOpacity=float(opacity.mean()),
                model='Procedural optical depth from curved, sheared ice trails; periodic splats')
destination.with_suffix('.json').write_text(json.dumps(metadata, indent=2)+'\n', encoding='utf8')
print(json.dumps(metadata))
