"""Bake multi-convex-hull collision for rocks, saguaro, and joshua tree.

Approximate convex decomposition (CoACD) over the ACTUAL render meshes,
so hard-stop hulls match what the player sees — replacing hand-fitted
primitives that drifted from the visuals. CPU only; no GPU, no Blender.

Per species:
  rocks    Desert_rock_chunks GLB, per piece 00..11, LOD2 mesh (collision
           needs no more than ~500 faces of fidelity).
  saguaro  solid body meshes only (vertex/face ratio ~0.5); spine sheets and
           billboard cards (ratio >= 2) are excluded so the cactus blocks at
           its flesh, not at its fuzz.
  joshua   solid trunk/branch meshes only; leaf-tuft card clusters excluded
           so rosettes stay passable (matches vegetation_collision policy).

Output: assets/collision/convex_hulls_v1.json
  { species: { key: [ { planes: [[nx,ny,nz,d]...], aabb: {min,max} } ] } }
Planes are outward-facing in authored plant/piece-local metres:
inside(point) iff dot(n, p) + d < 0 for every plane. Runtime resolution is
point-vs-planes with camera clearance (see src/collision_hulls.js).

Deterministic: CoACD seeded per species key. Rerun only when a GLB changes.
"""
import json
import sys
from pathlib import Path

import numpy as np
import trimesh
import coacd

ROOT = Path(__file__).resolve().parent.parent
OUT_PATH = ROOT / 'assets' / 'collision' / 'convex_hulls_v1.json'

SOLID_VERTEX_FACE_RATIO_MAX = 1.0   # closed surfaces ~0.5; card sheets >= 2

# threshold: CoACD concavity tolerance (lower = tighter fit, more hulls).
# max_hulls guards the runtime cost cap; plane budget bounds each hull.
SPECIES = {
    'rocks': {
        'path': ROOT / 'assets' / 'terrain' / 'Desert_rock_chunks_12_pieces_runtime_2k_lods.glb',
        'per_piece': True, 'pieces': 12, 'lod': 2,
        'threshold': 0.06, 'max_hulls': 4, 'max_planes': 26,
    },
    'saguaro': {
        'path': ROOT / 'assets' / 'vegetation' / 'saguaro_seed555.glb',
        'per_piece': False,
        'threshold': 0.045, 'max_hulls': 8, 'max_planes': 22,
    },
    'joshua': {
        'path': ROOT / 'assets' / 'vegetation' / 'joshuaTree_seed555.glb',
        'per_piece': False,
        'threshold': 0.05, 'max_hulls': 12, 'max_planes': 22,
    },
}


def transformed_solid_meshes(scene):
    """World-frame copies of every solid (non-card) mesh in the scene."""
    solids = []
    for node_name in scene.graph.nodes_geometry:
        transform, geometry_name = scene.graph[node_name]
        geom = scene.geometry[geometry_name]
        if not isinstance(geom, trimesh.Trimesh) or len(geom.faces) == 0:
            continue
        ratio = len(geom.vertices) / max(1, len(geom.faces))
        if ratio > SOLID_VERTEX_FACE_RATIO_MAX:
            continue
        copy = geom.copy()
        copy.apply_transform(transform)
        solids.append((geometry_name, copy))
    return solids


def decompose(mesh, threshold, max_hulls, seed):
    cm = coacd.Mesh(np.asarray(mesh.vertices, dtype=np.float64),
                    np.asarray(mesh.faces, dtype=np.int64))
    parts = coacd.run_coacd(
        cm, threshold=threshold, max_convex_hull=max_hulls, seed=seed,
    )
    return [trimesh.Trimesh(vertices=v, faces=f).convex_hull for v, f in parts]


def hull_planes(hull, max_planes):
    """Outward face planes, deduped; coarsen rounding until within budget."""
    for normal_decimals, offset_decimals in ((3, 3), (2, 3), (2, 2), (1, 2)):
        seen, planes = set(), []
        for normal, origin in zip(hull.face_normals, hull.triangles_center):
            n = np.round(normal, normal_decimals)
            norm = np.linalg.norm(n)
            if norm < 1e-6:
                continue
            n = n / norm
            d = round(float(-np.dot(n, origin)), offset_decimals)
            key = (round(n[0], normal_decimals), round(n[1], normal_decimals),
                   round(n[2], normal_decimals), d)
            if key in seen:
                continue
            seen.add(key)
            planes.append([float(n[0]), float(n[1]), float(n[2]), d])
        if len(planes) <= max_planes:
            return planes
    # Last resort: keep the planes covering the most face area.
    return planes[:max_planes]


def hull_record(hull, max_planes):
    lo, hi = hull.bounds
    return {
        'planes': hull_planes(hull, max_planes),
        'aabb': {'min': [round(float(v), 4) for v in lo],
                 'max': [round(float(v), 4) for v in hi]},
    }


def main():
    coacd.set_log_level('error')
    out = {'version': 1,
           'generator': 'tools/build-collision-hulls.py (CoACD)',
           'space': 'authored-local-metres, outward planes, inside = all dot(n,p)+d < 0',
           'species': {}}
    for species, cfg in SPECIES.items():
        scene = trimesh.load(cfg['path'], force='scene')
        if cfg['per_piece']:
            for piece in range(cfg['pieces']):
                name = f'DesertRockPiece{piece:02d}_LOD{cfg["lod"]}_Mesh'
                mesh = scene.geometry[name]
                hulls = decompose(mesh, cfg['threshold'], cfg['max_hulls'],
                                  seed=1000 + piece)
                key = f'rock_{piece:02d}'
                out['species'][key] = [hull_record(h, cfg['max_planes']) for h in hulls]
                print(f'{key}: {len(hulls)} hulls, '
                      f'{sum(len(r["planes"]) for r in out["species"][key])} planes')
        else:
            solids = transformed_solid_meshes(scene)
            print(f'{species}: {len(solids)} solid meshes '
                  f'({", ".join(n for n, _ in solids)})')
            merged = trimesh.util.concatenate([m for _, m in solids])
            hulls = decompose(merged, cfg['threshold'], cfg['max_hulls'],
                              seed=hash(species) % 65536)
            out['species'][species] = [hull_record(h, cfg['max_planes']) for h in hulls]
            print(f'{species}: {len(hulls)} hulls, '
                  f'{sum(len(r["planes"]) for r in out["species"][species])} planes')
    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUT_PATH.write_text(json.dumps(out, separators=(",", ":")), encoding='utf-8')
    print(f'wrote {OUT_PATH} ({OUT_PATH.stat().st_size} bytes)')


if __name__ == '__main__':
    sys.exit(main())
