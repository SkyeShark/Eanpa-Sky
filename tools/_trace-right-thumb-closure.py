#!/usr/bin/env python3
"""Compact, read-only trace for the unresolved right-thumb cap closure."""

from __future__ import annotations

from collections import Counter
import inspect
import json
from pathlib import Path
import runpy
import sys

import bpy


ROOT = Path(__file__).resolve().parents[1]
TOOLS = ROOT / "tools"
sys.path.insert(0, str(TOOLS))

import first_person_hinge_topology as topology


TRACE = {"rawCandidates": [], "solverCalls": [], "terminal": None}


def compact_candidate(result: dict) -> dict:
    return {
        "requiredRanks": result["requiredRanks"],
        "complete": result["complete"],
        "sharedSegmentCount": result["sharedSegmentCount"],
        "crossRankIntersectionCount": result["crossRankIntersectionCount"],
        "ranks": [
            {
                "rank": report["rank"],
                "segmentCount": report["segmentCount"],
                "componentCount": report["componentCount"],
                "chainComponentCount": report["chainComponentCount"],
                "multiRootFaceCount": report["multiRootFaceCount"],
                "sharedEdgeRootViolationCount": report[
                    "sharedEdgeRootViolationCount"
                ],
                "endpointCount": len(report["endpoints"]),
                "invalidEndpoints": [
                    endpoint
                    for endpoint in report["endpoints"]
                    if not endpoint["valid"]
                ],
                "endpoints": report["endpoints"],
                "complete": report["complete"],
            }
            for report in result["ranks"]
        ],
    }


def membership_patterns(frame_locals: dict, faces: set[int]) -> list[list[int]]:
    memberships = frame_locals.get("face_membership", {})
    return sorted(
        {
            tuple(rank for rank, value in enumerate(memberships[index]) if value)
            for index in faces
            if index in memberships
        }
    )


original_candidate = topology._raw_bridge_candidate


def traced_candidate(**kwargs):
    result = original_candidate(**kwargs)
    caller = inspect.currentframe().f_back
    local = caller.f_locals
    component = kwargs["component"]
    owner = kwargs["component_owner"][component]
    if owner == ("right", "thumb"):
        faces = kwargs["component_faces"][component]
        TRACE["rawCandidates"].append(
            {
                "pass": local.get("closure_pass"),
                "component": component,
                "owner": owner,
                "states": sorted(kwargs["states"]),
                "faceCount": len(faces),
                "sourceFaces": sorted(
                    {kwargs["face_source"][index] for index in faces}
                ),
                "membershipPatterns": membership_patterns(local, faces),
                "candidate": compact_candidate(result),
            }
        )
    return result


topology._raw_bridge_candidate = traced_candidate
original_solver = topology.solve_weighted_relations


def compact_closure(records: list[dict]) -> list[dict]:
    compact = []
    for record in records:
        candidates = []
        for item in record.get("qualifiedCandidates", []):
            if tuple(item["owner"]) != ("right", "thumb"):
                continue
            candidates.append(
                {
                    "owner": item["owner"],
                    "sourceComponentStateSpan": item[
                        "sourceComponentStateSpan"
                    ],
                    "candidate": compact_candidate(item["candidate"]),
                }
            )
        insertions = [
            {
                key: item[key]
                for key in (
                    "owner",
                    "rank",
                    "sourceComponentStateSpan",
                    "qualifiedChainCount",
                    "contourEdgeCount",
                    "insertedRootVertexCount",
                    "endpointReuseCount",
                    "crossQuantizationEndpointReuseCount",
                    "recordedRootEndpointReuseCount",
                    "recordedEdgeReuseCount",
                )
            }
            for item in record.get("virtualInsertions", [])
            if tuple(item["owner"]) == ("right", "thumb")
        ]
        compact.append(
            {
                "pass": record["pass"],
                "mixedComponentCount": record["mixedComponentCount"],
                "qualifiedCandidates": candidates,
                "virtualInsertions": insertions,
                "newInactiveEdgeCount": record.get("newInactiveEdgeCount", 0),
                "prunedVirtualTangentEdgeCount": record.get(
                    "prunedVirtualTangentEdgeCount", 0
                ),
            }
        )
    return compact


def component_record(component: int, local: dict, protected: dict, evidence: dict):
    raw_members = sorted(local["routed_groups"][component])
    faces = set().union(*(local["component_faces"][item] for item in raw_members))
    assignments = sorted(
        {
            state
            for item in raw_members
            for state in local["component_assignments"][item]
        }
    )
    forced = sorted(
        {
            state
            for item in raw_members
            for state in local["component_forced_states"][item]
        }
    )
    return {
        "component": component,
        "rawMembers": raw_members,
        "protected": sorted(protected.get(component, set())),
        "evidence": sorted(evidence.get(component, set())),
        "assignments": assignments,
        "forced": forced,
        "sourceFaces": sorted({local["face_source"][index] for index in faces}),
        "membershipPatterns": membership_patterns(local, faces),
    }


def edge_dispositions(local: dict) -> dict:
    counts = Counter()
    examples = {}
    for edge_key, record in local["geometric_edges"].items():
        owners = {
            local["face_owner"][index]
            for index in record["faces"] & local["eligible_faces"]
        }
        if ("right", "thumb") not in owners:
            continue
        dispositions = []
        if record["weightMask"]:
            metadata = local["contour_by_index"][
                record["weightMask"].bit_length() - 1
            ]
            if metadata["rank"] in {2, 3}:
                dispositions.append(f"physical{metadata['rank']}")
        for rank in (2, 3):
            if record["virtualMask"] & (1 << rank):
                dispositions.append(f"virtual{rank}")
            if record["inactiveVirtualMask"] & (1 << rank):
                dispositions.append(f"inactiveVirtual{rank}")
        for disposition in dispositions:
            counts[disposition] += 1
            if len(examples.setdefault(disposition, [])) < 8:
                examples[disposition].append(
                    {
                        "edgeKey": edge_key,
                        "sourceFaces": sorted(
                            {
                                local["face_source"][index]
                                for index in record["faces"]
                                & local["eligible_faces"]
                            }
                        ),
                        "faceComponents": sorted(
                            {
                                local["face_component"][index]
                                for index in record["faces"]
                                & local["eligible_faces"]
                            }
                        ),
                    }
                )
    return {"counts": dict(sorted(counts.items())), "examples": examples}


def boundary_dispositions(local: dict) -> dict:
    selected = [
        record
        for record in local["virtual_edges"]
        if record["owner"] == ("right", "thumb")
        and 3 in record["changedRanks"]
    ]
    counts = Counter(
        (
            tuple(record["changedRanks"]),
            bool(record["taggedEndpointKeys"]),
        )
        for record in selected
    )
    return {
        "count": len(selected),
        "histogram": [
            {
                "changedRanks": ranks,
                "tagged": tagged,
                "count": count,
            }
            for (ranks, tagged), count in sorted(counts.items())
        ],
        "examples": [
            {
                "edgeKey": record["edgeKey"],
                "sourceFaces": sorted(record["sourceFaces"]),
                "changedRanks": record["changedRanks"],
                "taggedEndpointKeys": record["taggedEndpointKeys"],
                "memberships": [
                    [rank for rank, value in enumerate(pattern) if value]
                    for pattern in record["memberships"]
                ],
            }
            for record in selected[:12]
        ],
    }


def traced_solver(*args, **kwargs):
    caller = inspect.currentframe().f_back
    local = caller.f_locals
    components = set(kwargs["components"])
    protected = kwargs["protected_states"]
    evidence = kwargs["evidence_states"]
    owner_by_quotient = {
        component: local["component_owner"][
            min(local["routed_groups"][component])
        ]
        for component in components
    }
    right_thumb = {
        component
        for component, owner in owner_by_quotient.items()
        if owner == ("right", "thumb")
    }
    relations = [
        relation
        for relation in kwargs["relation_groups"]
        if set(relation["components"]) & right_thumb
    ]
    state5 = {
        component
        for component in right_thumb
        if protected.get(component) == {5}
    }
    suspect = set(state5)
    for relation in relations:
        if relation["rank"] == 4 and set(relation["components"]) & state5:
            suspect.update(relation["components"])
    suspect.update({component for component in (66, 311) if component in right_thumb})
    relation_records = []
    for relation in relations:
        if not set(relation["components"]) & suspect:
            continue
        relation_records.append(
            {
                "components": relation["components"],
                "rank": relation["rank"],
                "edgeCount": relation["activeWeight"],
                "forceInactive": relation["forceInactive"],
                "localStates": {
                    str(component): sorted(states)
                    for component, states in relation["localStates"].items()
                },
                "edgeRanks": [
                    {"edgeKey": key, "rank": rank}
                    for key, rank in sorted(relation["edgeRanks"].items())
                ],
            }
        )
    record = {
        "pass": local.get("closure_pass"),
        "closureHistory": compact_closure(local.get("closure_records", [])),
        "rightThumbComponentCount": len(right_thumb),
        "state5ProtectedComponents": sorted(state5),
        "suspectComponents": [
            component_record(component, local, protected, evidence)
            for component in sorted(suspect)
        ],
        "suspectRelations": relation_records,
        "rank23EdgeDispositions": edge_dispositions(local),
        "rank3MembershipBoundaries": boundary_dispositions(local),
    }
    TRACE["solverCalls"].append(record)
    try:
        return original_solver(*args, **kwargs)
    except Exception as error:
        record["error"] = str(error)[:12000]
        raise


topology.solve_weighted_relations = traced_solver


def main() -> None:
    build = runpy.run_path(str(TOOLS / "build-first-person-viewmodel.py"))
    build["reset_scene"]()
    bpy.ops.import_scene.gltf(filepath=str(build["SOURCE"]))
    mesh = build["imported_aletheia_mesh"]()
    _groups, source_records, _skin = build["load_skin_zones"](mesh)
    hinge_spec, _seams = build["load_hinge_spec"](
        build["HINGE_SEAMS"],
        expected_source_sha256=build["EXPECTED_SOURCE_SHA256"],
        expected_source_raw_vertex_count=build[
            "EXPECTED_SOURCE_RAW_VERTEX_COUNT"
        ],
        expected_source_triangle_count=build["EXPECTED_SOURCE_TRIANGLE_COUNT"],
        expected_joint_points=build["SOURCE_CHAIN_POINTS"],
    )
    try:
        build["subdivide_and_classify"](
            mesh,
            hinge_spec=hinge_spec,
            source_zone_records=source_records,
            hand_region_minimum_y=build["HAND_REGION_MINIMUM_Y"],
        )
    except Exception as error:
        TRACE["terminal"] = {
            "status": "error",
            "type": type(error).__name__,
            "messagePrefix": str(error)[:400],
        }
    else:
        TRACE["terminal"] = {"status": "success"}
    print("RIGHT_THUMB_CLOSURE_TRACE", json.dumps(TRACE, sort_keys=True))


if __name__ == "__main__":
    main()
