"""Numerical height/hillshade comparison for the relief bake, independent of GPU."""
import gzip
import struct
from pathlib import Path
import numpy as np
from PIL import Image, ImageDraw

root = Path(__file__).resolve().parents[1]
payload = gzip.decompress((root / 'assets/ringworld/ring_relief_v3.bin.gz').read_bytes())
width, height = struct.unpack_from('<II', payload, 8)
old = np.asarray(Image.open(root / 'assets/ringworld/ring_band_height.png'), dtype=np.float32) / 65535
new = np.frombuffer(payload, dtype='<f2', count=width * height, offset=16).reshape(height, width)[::-1].astype(np.float32)

def hillshade(field):
    dx = (np.roll(field, -1, 1) - np.roll(field, 1, 1)) * (width * .03 / 2)
    dy = (np.roll(field, -1, 0) - np.roll(field, 1, 0)) * (height * .03 / 2)
    light = np.array([-.65, -.45, .62]); light /= np.linalg.norm(light)
    return np.clip((dx * light[0] + dy * light[1] + light[2]) / np.sqrt(1 + dx*dx + dy*dy), 0, 1) * .85 + .1

plot = Image.new('RGB', (1448, 544), '#161a20')
draw = ImageDraw.Draw(plot)
for i, (label, values) in enumerate([
    ('Original height', old), ('Eroded height', new),
    ('Original relief: same light and height scale', hillshade(old)),
    ('Eroded relief: same light and height scale', hillshade(new)),
]):
    x, y = (i % 2) * 724, (i // 2) * 272
    draw.text((x + 8, y + 8), label, fill='#ffffff')
    raster = Image.fromarray((np.clip(values, 0, 1) * 255).astype(np.uint8))
    plot.paste(raster.resize((724, 241), Image.Resampling.LANCZOS).convert('RGB'), (x, y + 27))
destination = root / 'artifacts/overhaul/ring-relief-data.png'
destination.parent.mkdir(parents=True, exist_ok=True)
plot.save(destination)
highlands = old > .3
print({'highland_height_rms_change': float(np.sqrt(np.mean((new[highlands]-old[highlands])**2))),
       'output': str(destination)})
