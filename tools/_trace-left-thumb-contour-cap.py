#!/usr/bin/env python3
"""Trace failed left-thumb G0 distal endpoints to exclusive corridor edges."""

from __future__ import annotations

import json
from pathlib import Path
import runpy

import bmesh
import bpy
from mathutils import Vector


ROOT = Path(__file__).resolve().parents[1]
BUILD = runpy.run_path(str(ROOT / "tools" / "build-first-person-viewmodel.py"))
import first_person_hinge_topology as topology


TARGETS = (
    (-0.22391629219055176, 0.760858416557312, 0.28913307189941406),
    (-0.20944930613040924, 0.7304288744926453, 0.29295191168785095),
    (-0.22313395142555237, 0.7535486221313477, 0.33391183614730835),
    (-0.2179381102323532, 0.7474247217178345, 0.2956981658935547),
)


BUILD["reset_scene"]()
bpy.ops.import_scene.gltf(filepath=str(BUILD["SOURCE"]))
mesh = BUILD["imported_aletheia_mesh"]()
_groups, source_records, _skin = BUILD["load_skin_zones"](mesh)
hinge_spec, _seams = BUILD["load_hinge_spec"](
    BUILD["HINGE_SEAMS"],
    expected_source_sha256=BUILD["EXPECTED_SOURCE_SHA256"],
    expected_source_raw_vertex_count=BUILD["EXPECTED_SOURCE_RAW_VERTEX_COUNT"],
    expected_source_triangle_count=BUILD["EXPECTED_SOURCE_TRIANGLE_COUNT"],
    expected_joint_points=BUILD["SOURCE_CHAIN_POINTS"],
)
effective, _audit = topology.reparameterize_document(hinge_spec)
bm = bmesh.new()
bm.from_mesh(mesh.data)
fields, _audits, summary = topology._build_surface_fields(
    bm,
    source_spec=hinge_spec,
    effective_spec=effective,
    source_zone_records=source_records,
)
source_surface = next(iter(fields.values()))["sourceSurface"]
partition = source_surface["thumbAdjacentGasketPartition"]["left"]
field = fields[("left", "thumb", "G0", "distal")]
corridor = field["routeCorridorSourceFaces"]
boundary = field["relativeBoundaryEdges"]
results = []
for target_values in TARGETS:
    target = Vector(target_values)
    nearest = min(
        boundary,
        key=lambda edge: topology._point_segment_distance(
            target, edge["first"], edge["second"]
        ),
    )
    edge_key = min(
        source_surface["weldedEdgeCoordinates"],
        key=lambda key: topology._point_segment_distance(
            target,
            *source_surface["weldedEdgeCoordinates"][key],
        ),
    )
    linked_faces = sorted(source_surface["weldedEdgeFaces"][edge_key])
    results.append(
        {
            "target": target_values,
            "boundaryComponent": nearest["component"],
            "boundaryDistance": topology._point_segment_distance(
                target, nearest["first"], nearest["second"]
            ),
            "sourceEdgeKey": edge_key,
            "sourceEdgeDistance": topology._point_segment_distance(
                target,
                *source_surface["weldedEdgeCoordinates"][edge_key],
            ),
            "linkedSourceFaces": linked_faces,
            "corridorMembership": {
                str(face): face in corridor for face in linked_faces
            },
            "rawOverlapMembership": {
                str(face): face in partition["overlapSourceFaces"]
                for face in linked_faces
            },
            "exclusiveOwner": {
                str(face): partition["ownerBySourceFace"].get(face)
                for face in linked_faces
            },
            "sourceZones": {
                str(key): source_records.get(key)
                for key in edge_key
            },
        }
    )
print(json.dumps({
    "partition": summary["thumbGasketCorridorSynchronization"],
    "targets": results,
}, sort_keys=True))
