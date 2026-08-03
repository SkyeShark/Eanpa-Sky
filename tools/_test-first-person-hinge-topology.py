#!/usr/bin/env python3
"""Topology-only smoke test for first_person_hinge_topology.py."""

from __future__ import annotations

from collections import Counter
import json
from pathlib import Path
import runpy

import bpy


ROOT = Path(__file__).resolve().parents[1]
BUILDER = ROOT / "tools" / "build-first-person-viewmodel.py"


def main() -> None:
    build = runpy.run_path(str(BUILDER))
    build["reset_scene"]()
    bpy.ops.import_scene.gltf(filepath=str(build["SOURCE"]))
    mesh = build["imported_aletheia_mesh"]()
    original = {
        "vertices": len(mesh.data.vertices),
        "faces": len(mesh.data.polygons),
        "loops": len(mesh.data.loops),
        "uvLayers": [layer.name for layer in mesh.data.uv_layers],
        "materialSlots": len(mesh.data.materials),
        "materialFaces": dict(Counter(face.material_index for face in mesh.data.polygons)),
        "hasCustomNormals": bool(mesh.data.has_custom_normals),
    }
    _groups, source_records, _skin = build["load_skin_zones"](mesh)
    hinge_spec, _seams = build["load_hinge_spec"](
        build["HINGE_SEAMS"],
        expected_source_sha256=build["EXPECTED_SOURCE_SHA256"],
        expected_source_raw_vertex_count=build["EXPECTED_SOURCE_RAW_VERTEX_COUNT"],
        expected_source_triangle_count=build["EXPECTED_SOURCE_TRIANGLE_COUNT"],
        expected_joint_points=build["SOURCE_CHAIN_POINTS"],
    )
    position_groups, records, provenance = build["subdivide_and_classify"](
        mesh,
        hinge_spec=hinge_spec,
        source_zone_records=source_records,
        hand_region_minimum_y=build["HAND_REGION_MINIMUM_Y"],
    )
    material_indices = {face.material_index for face in mesh.data.polygons}
    if any(index < 0 or index >= len(mesh.data.materials) for index in material_indices):
        raise RuntimeError("Subdivision produced an invalid material index")
    if [layer.name for layer in mesh.data.uv_layers] != original["uvLayers"]:
        raise RuntimeError("Subdivision changed the authored UV layer set")
    for layer in mesh.data.uv_layers:
        if len(layer.data) != len(mesh.data.loops):
            raise RuntimeError(f"UV layer {layer.name} does not cover every loop")
    if len(mesh.data.materials) != original["materialSlots"]:
        raise RuntimeError("Subdivision changed the material slot set")
    if len(provenance["cuts"]) != 90:
        raise RuntimeError("Subdivision did not execute all 90 contours")
    classification = provenance["topologyClassification"]
    if classification["eligibleHandFaceCount"] != classification[
        "floodedHandFaceCount"
    ]:
        raise RuntimeError("Topology flood did not cover every hand face")
    for name in (
        "coordinateEligibilityCount",
        "markerMaskCopyConflictCount",
        "multiContourGeometricEdgeCount",
        "traversableStateConflictCount",
        "virtualNonAdjacentStateCount",
        "recordConflictCount",
        "activeOneSidedVirtualEdgeCount",
        "inactiveVirtualConnectivityViolationCount",
        "inactiveVirtualExactInterfaceLeakCount",
        "inactiveUnprovenStateCount",
        "inactiveProtectedAnchorCrossingCount",
        "inactiveExactInterfaceLeakCount",
        "submicronHandEdgeCount",
        "rigidBlendViolationCount",
        "missingOrderedStateCount",
        "postcutHandKeyMismatchCount",
    ):
        if classification[name] != 0:
            raise RuntimeError(f"Topology classification failed {name}")
    if classification["recordCount"] != classification["postcutHandKeyCount"]:
        raise RuntimeError("Topology record/post-cut hand-key count differs")
    build["validate_inactive_virtual_tangent_provenance"](classification)
    build["validate_recorded_root_endpoint_reuse_provenance"](classification)
    if classification["minimumHandEdgeLengthMeters"] < 1e-6:
        raise RuntimeError("Post-cut hand mesh retained a submicron edge")
    if provenance["contourTopologyAudit"][
        "pairedExclusiveAdjacentGasketCapContourCount"
    ] != 1:
        raise RuntimeError(
            "Strict topology did not retain exactly one proven paired "
            "exclusive adjacent-gasket cap contour"
        )
    virtual_insertions = [
        insertion
        for closure in classification["closureFixedPoint"]
        for insertion in closure.get("virtualInsertions", [])
    ]
    # Cross-quantization endpoint reuse is data-dependent: the corrected
    # digit ownership no longer produces the closure case that required it.
    # The displacement bound below still gates the mechanism whenever the
    # closure does reuse an endpoint.
    if max(
        (
            insertion["maximumEndpointReuseDisplacementMeters"]
            for insertion in virtual_insertions
        ),
        default=0.0,
    ) > 1e-6:
        raise RuntimeError("Virtual endpoint reuse exceeded one micron")
    exact_blends = {0: 0.0, 1: 0.5, 2: 1.0}
    for record in records.values():
        if record["zone"] in {"H", "S0", "S1", "S2"}:
            if record["blend"] is not None:
                raise RuntimeError("Rigid topology record has a blend")
        else:
            if record["blend"] is None:
                raise RuntimeError("Gasket topology record lacks a blend")
        if "topologyInterfaceRank" in record:
            expected = exact_blends[record["topologyInterfaceRank"] % 3]
            if record["blend"] != expected:
                raise RuntimeError("Tagged contour vertex lost its exact blend")

    cuts = provenance["cuts"]
    summary = {
        "original": original,
        "final": {
            "vertices": len(mesh.data.vertices),
            "faces": len(mesh.data.polygons),
            "loops": len(mesh.data.loops),
            "uniquePositions": len(position_groups),
            "handRecords": len(records),
            "uvLayers": [layer.name for layer in mesh.data.uv_layers],
            "materialSlots": len(mesh.data.materials),
            "materialFaces": dict(
                Counter(face.material_index for face in mesh.data.polygons)
            ),
            "hasCustomNormals": bool(mesh.data.has_custom_normals),
        },
        "cuts": {
            "count": len(cuts),
            "minimumContourVertices": min(item["contourVertices"] for item in cuts),
            "maximumContourVertices": max(item["contourVertices"] for item in cuts),
            "insertedVertices": sum(item["insertedVertices"] for item in cuts),
            "connectedEdges": sum(item["connectedEdges"] for item in cuts),
        },
        "stationSeparation": provenance["stationSeparation"],
        "topologyClassification": classification,
        "adaptiveOverlapSubdivision": provenance["adaptiveOverlapSubdivision"],
        "surfaceField": {
            key: provenance["surfaceField"][key]
            for key in (
                "absoluteClosedComponentCount",
                "openComponentCount",
                "maximumUnconstrainedRawRecordedRootDisplacementMeters",
                "maximumFittedRecordedRootDisplacementMeters",
                "maximumRetainedRecordedRootPositionDisplacementMeters",
                "retainedRecordedIntersectionCount",
                "routeRefitComponentFaceSymmetricDifferenceCount",
                "routeRefitRoutedFaceSymmetricDifferenceCount",
            )
        },
        "surfaceFieldOpenContours": [
            {
                "id": (
                    f"{item['side']}/{item['digit']}/{item['gasket']}/"
                    f"{item['role']}"
                ),
                "selectedDegreeHistogram": item["selectedDegreeHistogram"],
                "selectedSourceFaceCount": item["selectedSourceFaceCount"],
            }
            for item in provenance["surfaceField"]["contours"]
            if not item["selectedClosed"]
        ],
        "cutSingleRootFaces": [
            {
                "id": (
                    f"{item['side']}/{item['digit']}/{item['gasket']}/"
                    f"{item['role']}"
                ),
                "singleRootFaceCount": item["singleRootFaceCount"],
            }
            for item in cuts
            if item["singleRootFaceCount"]
        ],
        "contourTopologyAudit": {
            "contourCount": provenance["contourTopologyAudit"]["contourCount"],
            "closedContourCount": provenance["contourTopologyAudit"][
                "closedContourCount"
            ],
            "allContoursClosed": provenance["contourTopologyAudit"][
                "allContoursClosed"
            ],
            "pairedExclusiveAdjacentGasketCapContourCount": provenance[
                "contourTopologyAudit"
            ]["pairedExclusiveAdjacentGasketCapContourCount"],
            "crossJointContourIntersectionCount": provenance[
                "contourTopologyAudit"
            ]["crossJointContourIntersectionCount"],
            "failedContours": [
                item
                for item in provenance["contourTopologyAudit"]["contours"]
                if not item["closed"]
            ],
        },
    }
    print("HINGE_TOPOLOGY_TEST_PASS", json.dumps(summary, sort_keys=True))


if __name__ == "__main__":
    main()
