from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
TOOLS = ROOT / "tools"
sys.path.insert(0, str(TOOLS))

from mathutils import Vector
import first_person_hinge_topology as topology

import runpy

build = runpy.run_path(str(TOOLS / "build-first-person-viewmodel.py"))
spec, _provenance = build["load_hinge_spec"](
    build["HINGE_SEAMS"],
    expected_source_sha256=build["EXPECTED_SOURCE_SHA256"],
    expected_source_raw_vertex_count=build["EXPECTED_SOURCE_RAW_VERTEX_COUNT"],
    expected_source_triangle_count=build["EXPECTED_SOURCE_TRIANGLE_COUNT"],
    expected_joint_points=build["SOURCE_CHAIN_POINTS"],
)
effective, _adjustments = topology._separate_adjacent_joint_traces(spec)
digit = effective["seams"]["left"]["thumb"]
joint = digit["joints"]["G0"]
first = Vector((-0.2075631320476532, 0.7580769658088684, 0.2623651623725891))
second = Vector((-0.20539715886116028, 0.7589966654777527, 0.26172733306884766))
root = Vector((-0.20714378356933594, 0.7582550048828125, 0.2622416615486145))
direction = second - first
factor = (root - first).dot(direction) / direction.length_squared
chain = [Vector(value) for value in digit["chainPoints"]]
lengths = [(chain[index + 1] - chain[index]).length for index in range(3)]
arcs = (0.0, lengths[0], lengths[0] + lengths[1], sum(lengths))
for delta in (-1e-4, -1e-6, -1e-8, 0.0, 1e-8, 1e-6, 1e-4):
    coordinate = first.lerp(second, factor + delta)
    value, station, radial, angle = topology._field_value(
        coordinate, digit, joint, "proximal"
    )
    candidates = []
    for index in range(3):
        start = chain[index]
        segment = chain[index + 1] - start
        raw = (coordinate - start).dot(segment) / segment.length_squared
        clamped = raw
        if index != 0 or raw >= 0.0:
            clamped = max(0.0, clamped)
        if index != 2 or raw <= 1.0:
            clamped = min(1.0, clamped)
        center = start + segment * clamped
        candidates.append(
            (index, (coordinate - center).length, arcs[index] + clamped * lengths[index])
        )
print(
        "FIELD_SAMPLE",
        delta,
        "value",
        value,
        "station",
        station,
        "radial",
        radial,
        "angle",
        angle,
        "segments",
        candidates,
    )
print("CHAIN", [list(value) for value in chain], "LENGTHS", lengths, "ARCS", arcs)
for gasket_name in topology.GASKETS:
    gasket_document = digit["joints"][gasket_name]
    print(
        "JOINT_TRACE",
        gasket_name,
        "proximalRange",
        (min(gasket_document["proximal"]), max(gasket_document["proximal"])),
        "centerRange",
        (min(gasket_document["center"]), max(gasket_document["center"])),
        "distalRange",
        (min(gasket_document["distal"]), max(gasket_document["distal"])),
    )
