#!/usr/bin/env python3
"""Face-local adaptive marching for nonlinear hinge contours.

This companion deliberately knows nothing about Aletheia's digit fields.  The
caller supplies a scalar field, a geometric/domain predicate, and a candidate
face predicate.  The implementation refines only faces whose local contour
chord is ambiguous or exceeds the requested residual, inserts shared edge
roots once, then pairs roots *inside their originating face*.  It never passes
an unordered global vertex cloud to ``connect_verts``.
"""

from __future__ import annotations

import math
from typing import Callable

import bmesh
from mathutils import Vector


ScalarField = Callable[[Vector], float]
CoordinatePredicate = Callable[[Vector], bool]
FacePredicate = Callable[[bmesh.types.BMFace], bool]
FaceScalarField = Callable[[bmesh.types.BMFace, Vector], float]
MINIMUM_ROOT_RESIDUAL_TOLERANCE = 2e-7
MAXIMUM_SHARED_EDGE_ROOT_DISAGREEMENT = 1e-6
POSITION_QUANTIZATION = 1_000_000


def _position_key(coordinate: Vector) -> tuple[int, int, int]:
    return tuple(
        int(round(float(component) * POSITION_QUANTIZATION))
        for component in coordinate
    )


class ContourRefinementError(RuntimeError):
    """Nonconvergence with the complete structured refinement report."""

    def __init__(self, refinement: dict):
        self.refinement = refinement
        super().__init__(
            "Face-local contour refinement did not converge: "
            f"{refinement['remainingFailingFaceCount']} faces remain; "
            f"reasons={refinement['remainingReasonCounts']}; "
            f"maximumResidual={refinement['remainingMaximumChordResidual']}"
        )


def _root_residual_tolerance(scalar_tolerance: float) -> float:
    return max(MINIMUM_ROOT_RESIDUAL_TOLERANCE, scalar_tolerance * 10.0)


def _record_rejected_root(
    statistics: dict | None,
    coordinate: Vector,
    residual: float,
) -> None:
    if statistics is None:
        return
    statistics['evaluationCount'] = statistics.get('evaluationCount', 0) + 1
    statistics['maximumResidual'] = max(
        float(statistics.get('maximumResidual', 0.0)),
        float(residual),
    )
    position_keys = statistics.setdefault('_positionKeys', set())
    position_keys.add(
        tuple(round(float(component), 7) for component in coordinate)
    )


def _rejection_summary(
    statistics: dict,
    scalar_tolerance: float,
) -> dict:
    return {
        'rootResidualTolerance': _root_residual_tolerance(
            scalar_tolerance
        ),
        'evaluationCount': int(statistics.get('evaluationCount', 0)),
        'uniquePositionCount': len(statistics.get('_positionKeys', set())),
        'maximumResidual': float(statistics.get('maximumResidual', 0.0)),
    }


def _sign(value: float, tolerance: float) -> int:
    if value < -tolerance:
        return -1
    if value > tolerance:
        return 1
    return 0


def _bisect_root(
    first: Vector,
    second: Vector,
    first_value: float,
    second_value: float,
    scalar_field: ScalarField,
) -> tuple[float, Vector, float]:
    """Find one bracketed root and return factor, point, and abs residual."""

    low = 0.0
    high = 1.0
    low_value = first_value
    for _iteration in range(40):
        middle = (low + high) * 0.5
        middle_value = float(scalar_field(first.lerp(second, middle)))
        if (low_value <= 0.0) == (middle_value <= 0.0):
            low = middle
            low_value = middle_value
        else:
            high = middle
    factor = (low + high) * 0.5
    coordinate = first.lerp(second, factor)
    return factor, coordinate, abs(float(scalar_field(coordinate)))


def _ordered_face_edges(face: bmesh.types.BMFace):
    """Yield (edge, first vertex, second vertex) in winding order."""

    for loop in face.loops:
        yield loop.edge, loop.vert, loop.link_loop_next.vert


def _edge_descriptor(
    edge: bmesh.types.BMEdge,
    first: bmesh.types.BMVert,
    second: bmesh.types.BMVert,
    *,
    scalar_field: ScalarField,
    accept_coordinate: CoordinatePredicate,
    scalar_tolerance: float,
    rejection_statistics: dict | None = None,
    analytic_affine: bool = False,
):
    first_value = float(scalar_field(first.co))
    second_value = float(scalar_field(second.co))
    first_sign = _sign(first_value, scalar_tolerance)
    second_sign = _sign(second_value, scalar_tolerance)

    if first_sign == 0 and accept_coordinate(first.co):
        return {
            "kind": "vertex",
            "vertex": first,
            "coordinate": first.co.copy(),
            "residual": abs(first_value),
        }
    if second_sign == 0 and accept_coordinate(second.co):
        return {
            "kind": "vertex",
            "vertex": second,
            "coordinate": second.co.copy(),
            "residual": abs(second_value),
        }
    if first_sign == 0 or second_sign == 0 or first_sign == second_sign:
        return None

    if analytic_affine:
        factor = first_value / (first_value - second_value)
        coordinate = first.co.lerp(second.co, factor)
        residual = abs(float(scalar_field(coordinate)))
    else:
        factor, coordinate, residual = _bisect_root(
            first.co.copy(),
            second.co.copy(),
            first_value,
            second_value,
            scalar_field,
        )
    if residual > _root_residual_tolerance(scalar_tolerance):
        _record_rejected_root(rejection_statistics, coordinate, residual)
        return None
    if not accept_coordinate(coordinate):
        return None
    # Store the factor relative to edge.verts[0], independent of face winding.
    direction = edge.verts[1].co - edge.verts[0].co
    edge_factor = (
        (coordinate - edge.verts[0].co).dot(direction)
        / max(direction.length_squared, 1e-30)
    )
    return {
        "kind": "edge",
        "edge": edge,
        "factor": max(0.0, min(1.0, edge_factor)),
        "coordinate": coordinate,
        "residual": residual,
    }


def _face_roots(
    face: bmesh.types.BMFace,
    *,
    scalar_field: ScalarField,
    accept_coordinate: CoordinatePredicate,
    scalar_tolerance: float,
    rejection_statistics: dict | None = None,
    analytic_affine: bool = False,
):
    """Return unique boundary roots and any already-existing zero edges."""

    roots = {}
    zero_edges = []
    for edge, first, second in _ordered_face_edges(face):
        first_value = float(scalar_field(first.co))
        second_value = float(scalar_field(second.co))
        if (
            abs(first_value) <= scalar_tolerance
            and abs(second_value) <= scalar_tolerance
            and accept_coordinate((first.co + second.co) * 0.5)
        ):
            zero_edges.append(edge)
            continue
        descriptor = _edge_descriptor(
            edge,
            first,
            second,
            scalar_field=scalar_field,
            accept_coordinate=accept_coordinate,
            scalar_tolerance=scalar_tolerance,
            rejection_statistics=rejection_statistics,
            analytic_affine=analytic_affine,
        )
        if descriptor is None:
            continue
        if descriptor["kind"] == "vertex":
            key = ("vertex", descriptor["vertex"])
        else:
            key = ("edge", descriptor["edge"])
        roots[key] = descriptor
    return list(roots.values()), zero_edges


def _hidden_edge_crossing(
    edge: bmesh.types.BMEdge,
    scalar_field: ScalarField,
    accept_coordinate: CoordinatePredicate,
    scalar_tolerance: float,
    rejection_statistics: dict | None = None,
) -> bool:
    """Detect an edge interval containing more roots than its endpoints show."""

    first_coordinate = edge.verts[0].co
    second_coordinate = edge.verts[1].co
    middle_coordinate = (first_coordinate + second_coordinate) * 0.5
    if not all(
        accept_coordinate(coordinate)
        for coordinate in (
            first_coordinate,
            middle_coordinate,
            second_coordinate,
        )
    ):
        return False
    first = float(scalar_field(first_coordinate))
    second = float(scalar_field(second_coordinate))
    middle = float(scalar_field(middle_coordinate))
    first_sign = _sign(first, scalar_tolerance)
    middle_sign = _sign(middle, scalar_tolerance)
    second_sign = _sign(second, scalar_tolerance)
    left_crosses = first_sign == 0 or middle_sign == 0 or first_sign != middle_sign
    right_crosses = middle_sign == 0 or second_sign == 0 or middle_sign != second_sign
    if not (left_crosses and right_crosses and first_sign == second_sign):
        return False
    for (
        first_interval_coordinate,
        second_interval_coordinate,
        first_interval_value,
        second_interval_value,
    ) in (
        (first_coordinate, middle_coordinate, first, middle),
        (middle_coordinate, second_coordinate, middle, second),
    ):
        if abs(first_interval_value) <= scalar_tolerance:
            root_coordinate = first_interval_coordinate
            residual = abs(first_interval_value)
        elif abs(second_interval_value) <= scalar_tolerance:
            root_coordinate = second_interval_coordinate
            residual = abs(second_interval_value)
        else:
            _factor, root_coordinate, residual = _bisect_root(
                first_interval_coordinate,
                second_interval_coordinate,
                first_interval_value,
                second_interval_value,
                scalar_field,
            )
        if residual > _root_residual_tolerance(scalar_tolerance):
            _record_rejected_root(
                rejection_statistics,
                root_coordinate,
                residual,
            )
            return False
    return True


def _face_needs_refinement(
    face: bmesh.types.BMFace,
    *,
    scalar_field: ScalarField,
    accept_coordinate: CoordinatePredicate,
    chord_tolerance: float,
    scalar_tolerance: float,
    rejection_statistics: dict | None = None,
):
    roots, zero_edges = _face_roots(
        face,
        scalar_field=scalar_field,
        accept_coordinate=accept_coordinate,
        scalar_tolerance=scalar_tolerance,
        rejection_statistics=rejection_statistics,
    )
    if zero_edges:
        return False, 0.0, "existing"
    if len(roots) == 2:
        midpoint = (roots[0]["coordinate"] + roots[1]["coordinate"]) * 0.5
        residual = abs(float(scalar_field(midpoint)))
        if residual <= chord_tolerance and accept_coordinate(midpoint):
            return False, residual, "chord"
        return True, residual, "residual"
    if len(roots) > 2:
        return True, math.inf, "multiple-roots"

    # A level set can lie entirely inside a coarse face even when no boundary
    # endpoint brackets it.  Sample its center and boundary midpoints before
    # deciding the face is irrelevant.
    center = face.calc_center_median()
    sample_coordinates = [vertex.co for vertex in face.verts]
    sample_coordinates.append(center)
    sample_coordinates.extend(
        (edge.verts[0].co + edge.verts[1].co) * 0.5
        for edge in face.edges
    )
    accepted_samples = [
        (coordinate, float(scalar_field(coordinate)))
        for coordinate in sample_coordinates
        if accept_coordinate(coordinate)
    ]
    if not accepted_samples:
        return False, 0.0, 'domain-empty'
    has_negative = min(value for _coordinate, value in accepted_samples) < -scalar_tolerance
    has_positive = max(value for _coordinate, value in accepted_samples) > scalar_tolerance
    if has_negative and has_positive:
        maximum_rejected_residual = 0.0
        for first_index, (
            first_coordinate,
            first_value,
        ) in enumerate(accepted_samples):
            first_sign = _sign(first_value, scalar_tolerance)
            if first_sign == 0:
                continue
            for second_coordinate, second_value in accepted_samples[
                first_index + 1 :
            ]:
                second_sign = _sign(second_value, scalar_tolerance)
                if second_sign == 0 or first_sign == second_sign:
                    continue
                _factor, root_coordinate, residual = _bisect_root(
                    first_coordinate,
                    second_coordinate,
                    first_value,
                    second_value,
                    scalar_field,
                )
                if (
                    residual <= _root_residual_tolerance(scalar_tolerance)
                    and accept_coordinate(root_coordinate)
                ):
                    return True, math.inf, 'hidden-crossing'
                maximum_rejected_residual = max(
                    maximum_rejected_residual,
                    residual,
                )
                _record_rejected_root(
                    rejection_statistics,
                    root_coordinate,
                    residual,
                )
        return False, maximum_rejected_residual, 'discontinuous-field'
    if len(roots) == 1:
        maximum_edge_length = max(
            (edge.calc_length() for edge in face.edges),
            default=0.0,
        )
        if maximum_edge_length <= chord_tolerance:
            return False, maximum_edge_length, 'single-root-tangent'
        return True, maximum_edge_length, 'single-root'
    return False, 0.0, "empty"


def refine_face_local_contour(
    bm: bmesh.types.BMesh,
    *,
    scalar_field: ScalarField,
    accept_coordinate: CoordinatePredicate,
    face_filter: FacePredicate,
    chord_tolerance: float = 0.00015,
    scalar_tolerance: float = 2e-8,
    maximum_depth: int = 8,
    rejection_statistics: dict | None = None,
) -> dict:
    """Adaptively triangulate only locally failing contour faces.

    Face centers are poked in-plane.  Boundary edges are split only when a
    midpoint sample proves that their endpoint signs hide multiple roots.
    """

    if rejection_statistics is None:
        rejection_statistics = {}
    rounds = []
    for depth in range(maximum_depth):
        failing_faces = []
        hidden_edges = set()
        maximum_residual = 0.0
        reasons = {}
        for face in list(bm.faces):
            if not face.is_valid or not face_filter(face):
                continue
            needs_refinement, residual, reason = _face_needs_refinement(
                face,
                scalar_field=scalar_field,
                accept_coordinate=accept_coordinate,
                chord_tolerance=chord_tolerance,
                scalar_tolerance=scalar_tolerance,
                rejection_statistics=rejection_statistics,
            )
            if not needs_refinement:
                continue
            failing_faces.append(face)
            maximum_residual = max(maximum_residual, residual)
            reasons[reason] = reasons.get(reason, 0) + 1
            hidden_edges.update(
                edge
                for edge in face.edges
                if edge.is_valid
                and _hidden_edge_crossing(
                    edge,
                    scalar_field,
                    accept_coordinate,
                    scalar_tolerance,
                    rejection_statistics,
                )
            )
            if reason == 'single-root':
                longest_edge = max(
                    (edge for edge in face.edges if edge.is_valid),
                    key=lambda edge: edge.calc_length(),
                    default=None,
                )
                if (
                    longest_edge is not None
                    and longest_edge.calc_length() > chord_tolerance
                ):
                    hidden_edges.add(longest_edge)
        if not failing_faces:
            break

        inserted_edge_vertices = 0
        for edge in list(hidden_edges):
            if not edge.is_valid:
                continue
            bmesh.utils.edge_split(edge, edge.verts[0], 0.5)
            inserted_edge_vertices += 1

        poke_faces = [face for face in failing_faces if face.is_valid]
        before_vertices = len(bm.verts)
        before_faces = len(bm.faces)
        if poke_faces:
            bmesh.ops.poke(
                bm,
                faces=poke_faces,
                offset=0.0,
                center_mode="MEAN_WEIGHTED",
                use_relative_offset=False,
            )
        bm.verts.index_update()
        bm.edges.index_update()
        bm.faces.index_update()
        rounds.append(
            {
                "depth": depth + 1,
                "failingFaceCount": len(failing_faces),
                "reasonCounts": dict(sorted(reasons.items())),
                "maximumPreRefinementResidual": maximum_residual,
                "hiddenEdgesSplit": inserted_edge_vertices,
                "insertedVertices": len(bm.verts) - before_vertices
                + inserted_edge_vertices,
                "insertedFaces": len(bm.faces) - before_faces,
            }
        )

    remaining = []
    maximum_remaining_residual = 0.0
    for face in list(bm.faces):
        if not face.is_valid or not face_filter(face):
            continue
        needs_refinement, residual, reason = _face_needs_refinement(
            face,
            scalar_field=scalar_field,
            accept_coordinate=accept_coordinate,
            chord_tolerance=chord_tolerance,
            scalar_tolerance=scalar_tolerance,
            rejection_statistics=rejection_statistics,
        )
        if needs_refinement:
            remaining.append((face, reason))
            maximum_remaining_residual = max(maximum_remaining_residual, residual)
    source_face_layer = bm.faces.layers.int.get('hinge_source_face')
    remaining_face_details = []
    for face, reason in remaining:
        roots, _zero_edges = _face_roots(
            face,
            scalar_field=scalar_field,
            accept_coordinate=accept_coordinate,
            scalar_tolerance=scalar_tolerance,
            rejection_statistics=rejection_statistics,
        )
        center = face.calc_center_median()
        remaining_face_details.append(
            {
                'faceIndex': int(face.index),
                'sourceFaceIndex': (
                    int(face[source_face_layer])
                    if source_face_layer is not None
                    else None
                ),
                'reason': reason,
                'center': [float(value) for value in center],
                'centerAccepted': bool(accept_coordinate(center)),
                'centerScalar': float(scalar_field(center)),
                'rootCoordinates': [
                    [float(value) for value in root['coordinate']]
                    for root in roots
                ],
                'vertexCoordinates': [
                    [float(value) for value in vertex.co]
                    for vertex in face.verts
                ],
            }
        )
    return {
        'remainingFaces': remaining_face_details,
        'discontinuousRootRejections': _rejection_summary(
            rejection_statistics,
            scalar_tolerance,
        ),
        "tolerance": chord_tolerance,
        "maximumDepth": maximum_depth,
        "rounds": rounds,
        "remainingFailingFaceCount": len(remaining),
        "remainingReasonCounts": {
            reason: sum(item_reason == reason for _face, item_reason in remaining)
            for reason in sorted({item_reason for _face, item_reason in remaining})
        },
        "remainingMaximumChordResidual": maximum_remaining_residual,
    }


def insert_face_local_contour(
    bm: bmesh.types.BMesh,
    *,
    scalar_field: ScalarField,
    accept_coordinate: CoordinatePredicate,
    face_filter: FacePredicate,
    chord_tolerance: float = 0.00015,
    scalar_tolerance: float = 2e-8,
    maximum_depth: int = 8,
) -> dict:
    """Refine, march, and insert one contour with face-local root pairing."""

    rejection_statistics = {}
    refinement = refine_face_local_contour(
        bm,
        scalar_field=scalar_field,
        accept_coordinate=accept_coordinate,
        face_filter=face_filter,
        chord_tolerance=chord_tolerance,
        scalar_tolerance=scalar_tolerance,
        maximum_depth=maximum_depth,
        rejection_statistics=rejection_statistics,
    )
    if refinement["remainingFailingFaceCount"]:
        raise ContourRefinementError(refinement)

    face_chords = []
    existing_edges = set()
    edge_requests = {}
    maximum_preinsert_residual = 0.0
    for face in list(bm.faces):
        if not face.is_valid or not face_filter(face):
            continue
        roots, zero_edges = _face_roots(
            face,
            scalar_field=scalar_field,
            accept_coordinate=accept_coordinate,
            scalar_tolerance=scalar_tolerance,
            rejection_statistics=rejection_statistics,
        )
        existing_edges.update(zero_edges)
        if zero_edges or len(roots) != 2:
            continue
        midpoint = (roots[0]["coordinate"] + roots[1]["coordinate"]) * 0.5
        residual = abs(float(scalar_field(midpoint)))
        if residual > chord_tolerance or not accept_coordinate(midpoint):
            raise RuntimeError("Unrefined contour chord reached insertion")
        maximum_preinsert_residual = max(maximum_preinsert_residual, residual)
        face_chords.append((face, roots))
        for root in roots:
            if root["kind"] != "edge":
                continue
            old = edge_requests.get(root["edge"])
            if old is not None and (
                old["coordinate"] - root["coordinate"]
            ).length > 1e-7:
                raise RuntimeError("One BMesh edge requested two contour roots")
            edge_requests[root["edge"]] = root

    split_vertices = {}
    for edge, request in list(edge_requests.items()):
        if not edge.is_valid:
            raise RuntimeError("Contour edge became invalid before split")
        factor = max(1e-8, min(1.0 - 1e-8, float(request["factor"])))
        _new_edge, new_vertex = bmesh.utils.edge_split(
            edge, edge.verts[0], factor
        )
        split_vertices[edge] = new_vertex

    contour_edges = set(existing_edges)
    split_face_count = 0
    for face, roots in face_chords:
        if not face.is_valid:
            raise RuntimeError("Marching face became invalid before face_split")
        vertices = []
        for root in roots:
            vertex = (
                root["vertex"]
                if root["kind"] == "vertex"
                else split_vertices[root["edge"]]
            )
            if vertex not in vertices:
                vertices.append(vertex)
        if len(vertices) != 2:
            continue
        first, second = vertices
        existing = bm.edges.get((first, second))
        if existing is not None:
            contour_edges.add(existing)
            continue
        if first not in face.verts or second not in face.verts:
            raise RuntimeError("Face-local roots no longer belong to their face")
        result = bmesh.utils.face_split(
            face,
            first,
            second,
            use_exist=True,
        )
        if result is None:
            raise RuntimeError("BMesh face_split rejected a valid contour chord")
        edge = bm.edges.get((first, second))
        if edge is None:
            raise RuntimeError("face_split produced no contour edge")
        contour_edges.add(edge)
        split_face_count += 1

    bm.normal_update()
    bm.verts.index_update()
    bm.edges.index_update()
    bm.faces.index_update()
    maximum_postinsert_residual = 0.0
    rejected_edges = 0
    for edge in contour_edges:
        midpoint = (edge.verts[0].co + edge.verts[1].co) * 0.5
        residual = abs(float(scalar_field(midpoint)))
        maximum_postinsert_residual = max(maximum_postinsert_residual, residual)
        if residual > chord_tolerance or not accept_coordinate(midpoint):
            rejected_edges += 1
    if rejected_edges:
        raise RuntimeError(
            f"Inserted contour has {rejected_edges} high-residual/domain edges"
        )
    return {
        'discontinuousRootRejections': _rejection_summary(
            rejection_statistics,
            scalar_tolerance,
        ),
        "refinement": refinement,
        "candidateFaceChordCount": len(face_chords),
        "requestedEdgeRootCount": len(edge_requests),
        "insertedRootVertexCount": len(split_vertices),
        "splitFaceCount": split_face_count,
        "existingContourEdgeCount": len(existing_edges),
        "contourEdgeCount": len(contour_edges),
        "maximumPreinsertChordResidual": maximum_preinsert_residual,
        "maximumPostinsertChordResidual": maximum_postinsert_residual,
    }


def insert_face_linear_contour(
    bm: bmesh.types.BMesh,
    *,
    face_scalar_field: FaceScalarField,
    accept_coordinate: CoordinatePredicate,
    face_filter: FacePredicate,
    chord_tolerance: float = 0.00015,
    scalar_tolerance: float = 2e-8,
    contour_edge_layer=None,
    contour_edge_mask: int = 0,
    propagated_edge_layers=(),
    root_coordinate_resolver=None,
    face_identity=None,
) -> dict:
    """Insert a contour from one affine scalar field per immutable source face.

    Unlike :func:`insert_face_local_contour`, this path deliberately performs no
    adaptive refinement.  The caller has cached a scalar value at each source
    vertex, so its barycentric extension is affine on every source triangle and
    remains affine on all descendants.  A valid child face therefore contains
    at most one zero chord and its midpoint residual is numerical roundoff.

    The scalar callback receives the current face as well as the coordinate.
    That distinction is essential at hard source-face boundaries and avoids a
    coordinate-only nearest-face lookup.  Shared-edge root requests are still
    reconciled globally before any split.
    """

    face_chords = []
    existing_edges = set()
    edge_requests = {}
    edge_request_faces = {}
    maximum_preinsert_residual = 0.0
    maximum_shared_edge_disagreement = 0.0
    rejected_root_statistics = {}
    single_root_face_count = 0
    single_root_faces = []
    candidate_face_count = 0
    endpoint_reuse_count = 0
    cross_quantization_endpoint_reuse_count = 0
    maximum_endpoint_reuse_displacement = 0.0

    for face in list(bm.faces):
        if not face.is_valid or not face_filter(face):
            continue
        candidate_face_count += 1

        def scalar_field(coordinate, candidate_face=face):
            return face_scalar_field(candidate_face, coordinate)

        roots, zero_edges = _face_roots(
            face,
            scalar_field=scalar_field,
            accept_coordinate=accept_coordinate,
            scalar_tolerance=scalar_tolerance,
            rejection_statistics=rejected_root_statistics,
            analytic_affine=True,
        )
        roots_before_resolver = [
            {
                "kind": root["kind"],
                "coordinate": [float(value) for value in root["coordinate"]],
            }
            for root in roots
        ]
        pre_resolver_coordinates = {
            id(root): root["coordinate"].copy() for root in roots
        }
        if root_coordinate_resolver is not None:
            for root in roots:
                if root["kind"] != "edge":
                    continue
                resolved = Vector(
                    root_coordinate_resolver(
                        face,
                        root["edge"],
                        root["coordinate"],
                    )
                )
                direction = root["edge"].verts[1].co - root["edge"].verts[0].co
                root["coordinate"] = resolved
                root["factor"] = max(
                    0.0,
                    min(
                        1.0,
                        (resolved - root["edge"].verts[0].co).dot(direction)
                        / max(direction.length_squared, 1e-30),
                    ),
                )
        for root in roots:
            if root["kind"] != "edge":
                continue
            matching_endpoints = [
                vertex
                for vertex in root["edge"].verts
                if (vertex.co - root["coordinate"]).length
                <= MAXIMUM_SHARED_EDGE_ROOT_DISAGREEMENT
            ]
            if not matching_endpoints:
                continue
            endpoint = min(
                matching_endpoints,
                key=lambda vertex: (
                    (vertex.co - root["coordinate"]).length,
                    vertex.index,
                ),
            )
            displacement = (endpoint.co - root["coordinate"]).length
            if displacement > MAXIMUM_SHARED_EDGE_ROOT_DISAGREEMENT:
                raise RuntimeError(
                    "Quantized endpoint reuse exceeds the shared-root gate"
                )
            maximum_endpoint_reuse_displacement = max(
                maximum_endpoint_reuse_displacement,
                displacement,
            )
            endpoint_reuse_count += 1
            if _position_key(endpoint.co) != _position_key(
                pre_resolver_coordinates[id(root)]
            ):
                cross_quantization_endpoint_reuse_count += 1
            root.clear()
            root.update(
                {
                    "kind": "vertex",
                    "vertex": endpoint,
                    "coordinate": endpoint.co.copy(),
                    "residual": abs(float(scalar_field(endpoint.co))),
                }
            )
        unique_roots = {}
        for root in roots:
            root_key = (
                ("vertex", root["vertex"])
                if root["kind"] == "vertex"
                else ("edge", root["edge"])
            )
            unique_roots[root_key] = root
        roots = list(unique_roots.values())
        roots_after_resolver = [
            {
                "kind": root["kind"],
                "coordinate": [float(value) for value in root["coordinate"]],
            }
            for root in roots
        ]
        existing_edges.update(zero_edges)
        if zero_edges:
            continue
        if len(roots) > 2:
            raise RuntimeError(
                "Affine source-face contour produced more than two roots in "
                f"face {face.index}"
            )
        if len(roots) == 1:
            single_root_face_count += 1
            single_root_faces.append(
                {
                    "faceIndex": int(face.index),
                    "sourceFaceIndex": (
                        face_identity(face) if face_identity is not None else None
                    ),
                    "center": [float(value) for value in face.calc_center_median()],
                    "rootCoordinate": [
                        float(value) for value in roots[0]["coordinate"]
                    ],
                    "vertexScalarValues": [
                        float(scalar_field(vertex.co)) for vertex in face.verts
                    ],
                    "rootsBeforeResolver": roots_before_resolver,
                    "rootsAfterResolver": roots_after_resolver,
                    "vertexCoordinates": [
                        [float(value) for value in vertex.co]
                        for vertex in face.verts
                    ],
                }
            )
            continue
        if len(roots) != 2:
            continue
        midpoint = (roots[0]["coordinate"] + roots[1]["coordinate"]) * 0.5
        residual = abs(float(scalar_field(midpoint)))
        if residual > chord_tolerance or not accept_coordinate(midpoint):
            raise RuntimeError(
                "Affine source-face chord exceeded its residual/domain gate"
            )
        maximum_preinsert_residual = max(maximum_preinsert_residual, residual)
        face_chords.append((face, roots))
        for root in roots:
            if root["kind"] != "edge":
                continue
            old = edge_requests.get(root["edge"])
            if old is not None:
                disagreement = (old["coordinate"] - root["coordinate"]).length
                maximum_shared_edge_disagreement = max(
                    maximum_shared_edge_disagreement,
                    disagreement,
                )
                if disagreement > MAXIMUM_SHARED_EDGE_ROOT_DISAGREEMENT:
                    old_face = edge_request_faces[root["edge"]]
                    raise RuntimeError(
                        "Adjacent source-face fields requested different roots "
                        f"on one BMesh edge ({disagreement} m; faces "
                        f"{old_face.index}/{face.index})"
                    )
            edge_requests[root["edge"]] = root
            edge_request_faces[root["edge"]] = face

    split_vertices = {}
    for edge, request in list(edge_requests.items()):
        if not edge.is_valid:
            raise RuntimeError("Affine contour edge became invalid before split")
        factor = max(1e-8, min(1.0 - 1e-8, float(request["factor"])))
        propagated_values = [
            int(edge[layer]) for layer in propagated_edge_layers
        ]
        new_edge, new_vertex = bmesh.utils.edge_split(
            edge,
            edge.verts[0],
            factor,
        )
        for layer, value in zip(propagated_edge_layers, propagated_values):
            edge[layer] = value
            new_edge[layer] = value
        new_vertex.co = request["coordinate"]
        split_vertices[edge] = new_vertex

    contour_edges = set(existing_edges)
    split_face_count = 0
    contour_edge_source_faces = {}
    for face, roots in face_chords:
        if not face.is_valid:
            raise RuntimeError("Affine marching face became invalid before split")
        vertices = []
        for root in roots:
            vertex = (
                root["vertex"]
                if root["kind"] == "vertex"
                else split_vertices[root["edge"]]
            )
            if vertex not in vertices:
                vertices.append(vertex)
        if len(vertices) != 2:
            continue
        first, second = vertices
        edge = bm.edges.get((first, second))
        if edge is None:
            if first not in face.verts or second not in face.verts:
                raise RuntimeError(
                    "Affine face-local roots no longer belong to their face"
                )
            result = bmesh.utils.face_split(
                face,
                first,
                second,
                use_exist=True,
            )
            if result is None:
                raise RuntimeError(
                    "BMesh face_split rejected an affine contour chord"
                )
            edge = bm.edges.get((first, second))
            if edge is None:
                raise RuntimeError("Affine face_split produced no contour edge")
            split_face_count += 1
        contour_edges.add(edge)
        contour_edge_source_faces.setdefault(edge, face)

    if contour_edge_layer is not None:
        if not contour_edge_mask:
            raise ValueError("A nonzero contour edge mask is required")
        for edge in contour_edges:
            edge[contour_edge_layer] = (
                int(edge[contour_edge_layer]) | int(contour_edge_mask)
            )

    bm.normal_update()
    bm.verts.index_update()
    bm.edges.index_update()
    bm.faces.index_update()
    maximum_postinsert_residual = 0.0
    rejected_edges = 0
    for edge in contour_edges:
        source_face = contour_edge_source_faces.get(edge)
        if source_face is None or not source_face.is_valid:
            source_face = next(
                (face for face in edge.link_faces if face_filter(face)),
                None,
            )
        if source_face is None:
            raise RuntimeError("Affine contour edge lost its source face")
        midpoint = (edge.verts[0].co + edge.verts[1].co) * 0.5
        residual = abs(float(face_scalar_field(source_face, midpoint)))
        maximum_postinsert_residual = max(
            maximum_postinsert_residual,
            residual,
        )
        if residual > chord_tolerance or not accept_coordinate(midpoint):
            rejected_edges += 1
    if rejected_edges:
        raise RuntimeError(
            f"Inserted affine contour has {rejected_edges} invalid edges"
        )

    return {
        "mode": "cached-source-vertex-piecewise-affine",
        "discontinuousRootRejections": _rejection_summary(
            rejected_root_statistics,
            scalar_tolerance,
        ),
        "refinement": {
            "tolerance": chord_tolerance,
            "maximumDepth": 0,
            "rounds": [],
            "remainingFailingFaceCount": 0,
            "remainingReasonCounts": {},
            "remainingMaximumChordResidual": 0.0,
        },
        "candidateFaceCount": candidate_face_count,
        "candidateFaceChordCount": len(face_chords),
        "requestedEdgeRootCount": len(edge_requests),
        "insertedRootVertexCount": len(split_vertices),
        "splitFaceCount": split_face_count,
        "existingContourEdgeCount": len(existing_edges),
        "contourEdgeCount": len(contour_edges),
        "singleRootFaceCount": single_root_face_count,
        "singleRootFaces": single_root_faces,
        "maximumSharedEdgeRootDisagreementMeters": (
            maximum_shared_edge_disagreement
        ),
        "endpointReuseCount": endpoint_reuse_count,
        "crossQuantizationEndpointReuseCount": (
            cross_quantization_endpoint_reuse_count
        ),
        "maximumEndpointReuseDisplacementMeters": (
            maximum_endpoint_reuse_displacement
        ),
        "maximumPreinsertChordResidual": maximum_preinsert_residual,
        "maximumPostinsertChordResidual": maximum_postinsert_residual,
    }
