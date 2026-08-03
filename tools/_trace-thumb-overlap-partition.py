#!/usr/bin/env python3
"""Audit every raw thumb G0/G1 overlap face for derived ownership."""

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
fields, _field_audits, _summary = topology._build_surface_fields(
    bm,
    source_spec=hinge_spec,
    effective_spec=effective,
    source_zone_records=source_records,
)
source_surface = next(iter(fields.values()))["sourceSurface"]
reports = []
for side in topology.SIDES:
    digit = effective["seams"][side]["thumb"]
    corridors = {}
    for gasket in ("G0", "G1"):
        corridors[gasket] = {
            face_index
            for field, _role, _blend in topology.CONTOUR_FIELDS
            for face_index in fields[
                (side, "thumb", gasket, field)
            ]["sourceZeroComponentFaces"]
            if source_surface["digitOwnerByFace"].get(face_index)
            == (side, "thumb")
        }
    for face_index in sorted(corridors["G0"] & corridors["G1"]):
        face = source_surface["faces"][face_index]
        votes = {"G0": 0, "G1": 0, "H": 0, "other": 0}
        vertex_records = []
        for coordinate in face["coordinates"]:
            key = topology.position_key(coordinate)
            record = source_records.get(key)
            vertex_records.append({"key": key, "record": record})
            if record is None:
                votes["other"] += 1
            elif record.get("zone") in votes:
                votes[record["zone"]] += 1
            else:
                votes["other"] += 1
        center = sum(face["coordinates"], Vector()) / 3.0
        station, _radial, _angle = topology.project_coordinate(
            center, digit["chainPoints"]
        )
        g0 = digit["joints"]["G0"]
        g1 = digit["joints"]["G1"]
        _station, _radial, g0_angle = topology._project_joint_coordinate(
            center, digit, g0
        )
        _station, _radial, g1_angle = topology._project_joint_coordinate(
            center, digit, g1
        )
        g0_distal = topology._joint_trace_value(g0, "distal", g0_angle)
        g1_proximal = topology._joint_trace_value(g1, "proximal", g1_angle)
        midpoint_owner = (
            "G0" if station <= (g0_distal + g1_proximal) * 0.5 else "G1"
        )
        vote_owners = [gasket for gasket in ("G0", "G1") if votes[gasket]]
        derived_owner = vote_owners[0] if len(vote_owners) == 1 else midpoint_owner
        reports.append(
            {
                "side": side,
                "faceIndex": face_index,
                "votes": votes,
                "vertexRecords": vertex_records,
                "station": station,
                "g0Distal": g0_distal,
                "g1Proximal": g1_proximal,
                "midpointOwner": midpoint_owner,
                "derivedOwner": derived_owner,
                "existingOwner": next(
                    (
                        gasket
                        for gasket in ("G0", "G1")
                        if face_index
                        in topology.THUMB_ORDERED_FACE_OWNERS[(side, gasket)]
                    ),
                    None,
                ),
                "preselectedRoles": {
                    gasket: [
                        role
                        for field, role, _blend in topology.CONTOUR_FIELDS
                        if face_index
                        in fields[(side, "thumb", gasket, field)][
                            "sourceZeroComponentFaces"
                        ]
                    ]
                    for gasket in ("G0", "G1")
                },
            }
        )

print(json.dumps(reports, sort_keys=True))
