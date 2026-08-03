#!/usr/bin/env python3
"""Emit exact provenance for the first unresolved right-thumb routed cap."""

from __future__ import annotations

import inspect
import json
from pathlib import Path
import runpy

import bpy


ROOT = Path(__file__).resolve().parents[1]
BUILD = runpy.run_path(str(ROOT / "tools" / "build-first-person-viewmodel.py"))


def plain(value):
    if isinstance(value, dict):
        return {str(key): plain(item) for key, item in value.items()}
    if isinstance(value, (set, tuple, list)):
        return [plain(item) for item in value]
    try:
        return [float(item) for item in value]
    except (TypeError, ValueError):
        return value


def position_key(coordinate):
    return tuple(int(round(float(value) * 1_000_000)) for value in coordinate)


def source_face_record(mesh, face_index):
    polygon = mesh.polygons[face_index]
    result = {
        "faceIndex": face_index,
        "materialIndex": int(polygon.material_index),
        "smooth": bool(polygon.use_smooth),
        "normal": list(polygon.normal),
        "center": list(polygon.center),
        "vertices": [
            {
                "rawIndex": int(index),
                "positionKey": position_key(mesh.vertices[index].co),
                "coordinate": list(mesh.vertices[index].co),
            }
            for index in polygon.vertices
        ],
        "uvLayers": {},
    }
    for layer in mesh.uv_layers:
        result["uvLayers"][layer.name] = [
            list(layer.data[loop_index].uv)
            for loop_index in polygon.loop_indices
        ]
    return result


def main():
    BUILD["reset_scene"]()
    bpy.ops.import_scene.gltf(filepath=str(BUILD["SOURCE"]))
    mesh_object = BUILD["imported_aletheia_mesh"]()
    source_mesh = mesh_object.data
    target_sources = {19206, 19207, 19209}
    source_faces = {
        face_index: source_face_record(source_mesh, face_index)
        for face_index in sorted(target_sources)
    }

    import first_person_hinge_topology as topology

    original_solver = topology.solve_weighted_relations

    def probe_solver(*args, **kwargs):
        frame = inspect.currentframe().f_back
        local = frame.f_locals
        bm = local["bm"]
        source_face_layer = local["source_face_layer"]
        face_source = local["face_source"]
        face_by_index = local["face_by_index"]
        ordered_fields = local["ordered_fields"]
        source_surface = local["source_surface"]
        edge_copies = local["edge_copies"]
        virtual_edges = local["virtual_edges"]
        geometric_edges = local["geometric_edges"]
        face_component = local["face_component"]
        component_assignments = local["component_assignments"]
        component_assignment_evidence = local[
            "component_assignment_evidence"
        ]

        descendants = {
            source_index: [
                face
                for face in bm.faces
                if face.is_valid
                and int(face[source_face_layer]) == source_index
            ]
            for source_index in target_sources
        }
        face_fields = {}
        fields = ordered_fields[("right", "thumb")]
        for source_index, faces in sorted(descendants.items()):
            records = []
            for face in faces:
                center = face.calc_center_median()
                records.append(
                    {
                        "descendantFaceIndex": int(face.index),
                        "component": int(face_component[face.index]),
                        "center": list(center),
                        "normal": list(face.normal),
                        "materialIndex": int(face.material_index),
                        "smooth": bool(face.smooth),
                        "assignments": sorted(
                            component_assignments[
                                face_component[face.index]
                            ]
                        ),
                        "assignmentEvidence": sorted(
                            component_assignment_evidence[
                                face_component[face.index]
                            ]
                        ),
                        "ranks": [
                            {
                                "rank": rank,
                                "gasket": field["gasket"],
                                "role": field["role"],
                                "selected": (
                                    source_index
                                    in field["selectedSourceFaces"]
                                ),
                                "routeCorridorSelected": (
                                    source_index
                                    in field.get(
                                        "routeCorridorSourceFaces", set()
                                    )
                                ),
                                "centroidScalar": topology._evaluate_surface_field_face(
                                    field,
                                    source_surface,
                                    source_index,
                                    center,
                                ),
                            }
                            for rank, field in enumerate(fields[:6])
                        ],
                    }
                )
            face_fields[str(source_index)] = records

        routed_edges = []
        for record in virtual_edges:
            if not (record["sourceFaces"] & target_sources):
                continue
            copies = []
            for edge in edge_copies[record["edgeKey"]]:
                linked = []
                for face in edge.link_faces:
                    source_index = int(face[source_face_layer])
                    uv_by_layer = {}
                    for layer in bm.loops.layers.uv:
                        uv_by_layer[layer.name] = {
                            str(position_key(loop.vert.co)): list(loop[layer].uv)
                            for loop in face.loops
                            if position_key(loop.vert.co) in record["edgeKey"]
                        }
                    linked.append(
                        {
                            "faceIndex": int(face.index),
                            "sourceFaceIndex": source_index,
                            "normal": list(face.normal),
                            "materialIndex": int(face.material_index),
                            "smooth": bool(face.smooth),
                            "uv": uv_by_layer,
                        }
                    )
                copies.append(
                    {
                        "edgeIndex": int(edge.index),
                        "smooth": bool(edge.smooth),
                        "seam": bool(edge.seam),
                        "lengthMeters": float(edge.calc_length()),
                        "linkedFaces": linked,
                    }
                )
            midpoint = sum(
                (
                    local["coordinates"][key]
                    for key in record["edgeKey"]
                ),
                topology.Vector(),
            ) / 2.0
            field_boundaries = []
            for rank, field in enumerate(fields[:6]):
                membership = topology._source_boundary_membership(
                    midpoint,
                    field["relativeBoundaryEdges"],
                )
                scalar_samples = []
                for face_index in record["faces"]:
                    source_index = face_source[face_index]
                    if source_index not in target_sources:
                        continue
                    scalar_samples.append(
                        {
                            "sourceFaceIndex": source_index,
                            "value": topology._evaluate_surface_field_face(
                                field,
                                source_surface,
                                source_index,
                                midpoint,
                            ),
                        }
                    )
                field_boundaries.append(
                    {
                        "rank": rank,
                        "boundary": membership,
                        "midpointScalars": scalar_samples,
                    }
                )
            routed_edges.append(
                {
                    **record,
                    "components": sorted(
                        {
                            face_component[index]
                            for index in record["faces"]
                        }
                    ),
                    "midpoint": list(midpoint),
                    "physicalMask": geometric_edges[record["edgeKey"]][
                        "weightMask"
                    ],
                    "virtualMask": geometric_edges[record["edgeKey"]][
                        "virtualMask"
                    ],
                    "fieldBoundaries": field_boundaries,
                    "copies": copies,
                }
            )

        source_adjacency = []
        for edge_key, linked_faces in source_surface[
            "weldedEdgeFaces"
        ].items():
            if linked_faces & target_sources and len(linked_faces) > 1:
                source_adjacency.append(
                    {
                        "edgeKey": edge_key,
                        "linkedSourceFaces": sorted(linked_faces),
                    }
                )

        report = {
            "closurePass": int(local["closure_pass"]),
            "sourceFaces": source_faces,
            "descendantFieldEvidence": face_fields,
            "routedEdges": routed_edges,
            "sourceAdjacency": source_adjacency,
        }
        print("CAP_PROVENANCE_JSON=" + json.dumps(plain(report), sort_keys=True))
        raise RuntimeError("CAP_PROVENANCE_COMPLETE")

    topology.solve_weighted_relations = probe_solver
    try:
        _groups, source_records, _skin = BUILD["load_skin_zones"](
            mesh_object
        )
        hinge_spec, _seams = BUILD["load_hinge_spec"](
            BUILD["HINGE_SEAMS"],
            expected_source_sha256=BUILD["EXPECTED_SOURCE_SHA256"],
            expected_source_raw_vertex_count=BUILD[
                "EXPECTED_SOURCE_RAW_VERTEX_COUNT"
            ],
            expected_source_triangle_count=BUILD[
                "EXPECTED_SOURCE_TRIANGLE_COUNT"
            ],
            expected_joint_points=BUILD["SOURCE_CHAIN_POINTS"],
        )
        BUILD["subdivide_and_classify"](
            mesh_object,
            hinge_spec=hinge_spec,
            source_zone_records=source_records,
            hand_region_minimum_y=BUILD["HAND_REGION_MINIMUM_Y"],
        )
    except RuntimeError as error:
        if "CAP_PROVENANCE_COMPLETE" not in str(error):
            raise
    finally:
        topology.solve_weighted_relations = original_solver


if __name__ == "__main__":
    main()
