#!/usr/bin/env python3
"""Sample effective G0/G1 rigid-gap margins on the routed thumb cap."""

from __future__ import annotations

import json
from pathlib import Path
import runpy

from mathutils import Vector


ROOT = Path(__file__).resolve().parents[1]
BUILD = runpy.run_path(str(ROOT / "tools" / "build-first-person-viewmodel.py"))
import first_person_hinge_topology as topology


hinge_spec, _seams = BUILD["load_hinge_spec"](
    BUILD["HINGE_SEAMS"],
    expected_source_sha256=BUILD["EXPECTED_SOURCE_SHA256"],
    expected_source_raw_vertex_count=BUILD["EXPECTED_SOURCE_RAW_VERTEX_COUNT"],
    expected_source_triangle_count=BUILD["EXPECTED_SOURCE_TRIANGLE_COUNT"],
    expected_joint_points=BUILD["SOURCE_CHAIN_POINTS"],
)
effective, _audit = topology.reparameterize_document(hinge_spec)
digit = effective["seams"]["right"]["thumb"]
g0 = digit["joints"]["G0"]
g1 = digit["joints"]["G1"]

keys = [
    (206298, 723735, 294141),
    (208101, 726121, 295912),
    (209904, 728508, 297683),
    (211708, 730894, 299455),
    (212138, 731463, 299877),
]
coordinates = [Vector(tuple(value / 1_000_000 for value in key)) for key in keys]
coordinates.append(Vector((0.20910899341106415, 0.7322266697883606, 0.2960059344768524)))
samples = []
for label, coordinate in [
    *(('vertex', item) for item in coordinates),
    *(('edgeMidpoint', (coordinates[index] + coordinates[index + 1]) / 2.0)
      for index in range(len(coordinates) - 1)),
]:
    station, _radial, _angle = topology.project_coordinate(
        coordinate, digit["chainPoints"]
    )
    _g0_station, _g0_radial, g0_angle = topology._project_joint_coordinate(
        coordinate, digit, g0
    )
    _g1_station, _g1_radial, g1_angle = topology._project_joint_coordinate(
        coordinate, digit, g1
    )
    g0_distal = topology._joint_trace_value(g0, "distal", g0_angle)
    g1_proximal = topology._joint_trace_value(g1, "proximal", g1_angle)
    samples.append(
        {
            "kind": label,
            "coordinate": list(coordinate),
            "station": station,
            "g0Distal": g0_distal,
            "g1Proximal": g1_proximal,
            "proximalMargin": station - g0_distal,
            "distalMargin": g1_proximal - station,
            "insideRigidS0Gap": g0_distal < station < g1_proximal,
            "gapWidth": g1_proximal - g0_distal,
        }
    )
print(json.dumps(samples, sort_keys=True))
