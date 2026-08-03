#!/usr/bin/env python3
"""Continuous joint-local projection and hinge-trace reparameterization.

The legacy projection chooses the closest segment of a bent digit polyline.
That choice is discontinuous where two segments are equally close, which can
make a scalar hinge field jump across zero without containing a root.  This
module instead gives each gasket one fixed hinge frame:

* G0 uses the first chain-segment tangent.
* G1 uses the normalized average of segment 0 and segment 1 tangents.
* G2 uses the normalized average of segment 1 and segment 2 tangents.

Circumferential axes are parallel-transported from G0, so station, radius, and
angle are continuous functions of the input coordinate for a given gasket.
The reparameterizer maps the recorded PBR-derived contour intersections into
those frames without discarding the effective station-separation correction.
"""

from __future__ import annotations

import argparse
import bisect
import copy
import hashlib
import json
import math
import statistics
from pathlib import Path
from typing import Iterable, Sequence


Vector3 = tuple[float, float, float]
GASKETS = ('G0', 'G1', 'G2')
ROLE_TO_FIELD = {
    'proximalBoundary': 'proximal',
    'center': 'center',
    'distalBoundary': 'distal',
}
FIELDS = ('proximal', 'center', 'distal')
VECTOR_EPSILON = 1e-12


def _vector(value: Iterable[float]) -> Vector3:
    result = tuple(float(component) for component in value)
    if len(result) != 3:
        raise ValueError(f'Expected three vector components, got {len(result)}')
    return result


def _add(first: Vector3, second: Vector3) -> Vector3:
    return tuple(first[index] + second[index] for index in range(3))


def _subtract(first: Vector3, second: Vector3) -> Vector3:
    return tuple(first[index] - second[index] for index in range(3))


def _scale(value: Vector3, factor: float) -> Vector3:
    return tuple(component * factor for component in value)


def _dot(first: Vector3, second: Vector3) -> float:
    return sum(first[index] * second[index] for index in range(3))


def _cross(first: Vector3, second: Vector3) -> Vector3:
    return (
        first[1] * second[2] - first[2] * second[1],
        first[2] * second[0] - first[0] * second[2],
        first[0] * second[1] - first[1] * second[0],
    )


def _length(value: Vector3) -> float:
    return math.sqrt(max(0.0, _dot(value, value)))


def _normalize(value: Vector3, *, fallback: Vector3 | None = None) -> Vector3:
    magnitude = _length(value)
    if magnitude <= VECTOR_EPSILON:
        if fallback is None:
            raise ValueError('Cannot normalize a zero-length vector')
        return _normalize(fallback)
    return _scale(value, 1.0 / magnitude)


def _distance(first: Vector3, second: Vector3) -> float:
    return _length(_subtract(first, second))


def _chain_geometry(
    chain_points: Sequence[Sequence[float]],
) -> tuple[list[Vector3], list[Vector3], list[float], list[float]]:
    if len(chain_points) != 4:
        raise ValueError(f'Expected four chain points, got {len(chain_points)}')
    chain = [_vector(point) for point in chain_points]
    directions = [
        _subtract(chain[index + 1], chain[index])
        for index in range(3)
    ]
    lengths = [_length(direction) for direction in directions]
    if min(lengths) <= VECTOR_EPSILON:
        raise ValueError('Digit chain contains a zero-length segment')
    tangents = [
        _scale(direction, 1.0 / length)
        for direction, length in zip(directions, lengths)
    ]
    arcs = [0.0, lengths[0], lengths[0] + lengths[1]]
    return chain, tangents, lengths, arcs


def _reference_axis(tangent: Vector3) -> Vector3:
    axis = _cross(tangent, (0.0, 0.0, 1.0))
    if _length(axis) <= VECTOR_EPSILON:
        axis = _cross(tangent, (1.0, 0.0, 0.0))
    return _normalize(axis)


def joint_local_frames(
    chain_points: Sequence[Sequence[float]],
) -> list[dict]:
    """Return the three fixed, parallel-transported hinge frames."""

    chain, segment_tangents, _lengths, arcs = _chain_geometry(chain_points)
    tangents = [
        segment_tangents[0],
        _normalize(_add(segment_tangents[0], segment_tangents[1])),
        _normalize(_add(segment_tangents[1], segment_tangents[2])),
    ]
    frames = []
    previous_u = _reference_axis(tangents[0])
    for index, tangent in enumerate(tangents):
        if index == 0:
            axis_u = previous_u
        else:
            transported = _subtract(
                previous_u,
                _scale(tangent, _dot(previous_u, tangent)),
            )
            axis_u = _normalize(
                transported,
                fallback=_reference_axis(tangent),
            )
            if _dot(axis_u, previous_u) < 0.0:
                axis_u = _scale(axis_u, -1.0)
        axis_v = _normalize(_cross(tangent, axis_u))
        frames.append(
            {
                'gasket': GASKETS[index],
                'anchorPoint': chain[index],
                'anchorArc': arcs[index],
                'tangent': tangent,
                'axisU': axis_u,
                'axisV': axis_v,
            }
        )
        previous_u = axis_u
    return frames


def joint_local_projection(
    coordinate: Sequence[float],
    chain_points: Sequence[Sequence[float]],
    gasket: str,
) -> tuple[float, float, float]:
    """Return continuous station, radial distance, and angle for one gasket."""

    try:
        frame = joint_local_frames(chain_points)[GASKETS.index(gasket)]
    except ValueError as error:
        raise ValueError(f'Unknown gasket {gasket!r}') from error
    return project_with_fixed_frame(coordinate, frame)


def project_with_fixed_frame(
    coordinate: Sequence[float],
    frame: dict,
) -> tuple[float, float, float]:
    """Project with stored frame metadata without rebuilding chain frames."""

    point = _vector(coordinate)
    anchor = _vector(frame['anchorPoint'])
    tangent = _vector(frame['tangent'])
    axis_u = _vector(frame['axisU'])
    axis_v = _vector(frame['axisV'])
    relative = _subtract(point, anchor)
    axial_offset = _dot(relative, tangent)
    radial_vector = _subtract(
        relative,
        _scale(tangent, axial_offset),
    )
    anchor_arc = (
        float(frame['anchorArc'])
        if 'anchorArc' in frame
        else float(frame['anchorArcMeters'])
    )
    station = anchor_arc + axial_offset
    radial = _length(radial_vector)
    angle = math.atan2(
        _dot(radial_vector, axis_v),
        _dot(radial_vector, axis_u),
    ) % math.tau
    return station, radial, angle


def polyline_projection(
    coordinate: Sequence[float],
    chain_points: Sequence[Sequence[float]],
) -> tuple[float, float, float]:
    """Reproduce the legacy closest-segment projection for trace migration."""

    point = _vector(coordinate)
    chain, tangents, lengths, arcs = _chain_geometry(chain_points)
    best_radial = math.inf
    best_station = 0.0
    best_center = chain[0]
    best_tangent = tangents[0]
    for index in range(3):
        direction = _subtract(chain[index + 1], chain[index])
        raw = _dot(_subtract(point, chain[index]), direction) / _dot(
            direction,
            direction,
        )
        clamped = max(0.0, min(1.0, raw))
        if index == 0 and raw < 0.0:
            clamped = raw
        elif index == 2 and raw > 1.0:
            clamped = raw
        center = _add(chain[index], _scale(direction, clamped))
        radial = _distance(point, center)
        if radial < best_radial:
            best_radial = radial
            best_station = arcs[index] + clamped * lengths[index]
            best_center = center
            best_tangent = tangents[index]
    radial_vector = _subtract(point, best_center)
    axis_u = _reference_axis(best_tangent)
    axis_v = _normalize(_cross(best_tangent, axis_u))
    angle = math.atan2(
        _dot(radial_vector, axis_v),
        _dot(radial_vector, axis_u),
    ) % math.tau
    return best_station, best_radial, angle


def trace_value(values: Sequence[float], angle: float) -> float:
    if not values:
        raise ValueError('Trace has no samples')
    scaled = (angle % math.tau) / math.tau * len(values)
    floor = math.floor(scaled)
    first = int(floor) % len(values)
    second = (first + 1) % len(values)
    fraction = scaled - floor
    return (
        float(values[first]) * (1.0 - fraction)
        + float(values[second]) * fraction
    )


def _cyclic_interpolate(
    samples: Sequence[tuple[float, float]],
    query_angle: float,
) -> float:
    if not samples:
        raise ValueError('Cannot interpolate an empty cyclic trace')
    if len(samples) == 1:
        return float(samples[0][1])
    angles = [sample[0] for sample in samples]
    index = bisect.bisect_right(angles, query_angle % math.tau)
    if index == 0:
        lower_angle, lower_value = samples[-1]
        lower_angle -= math.tau
        upper_angle, upper_value = samples[0]
    elif index == len(samples):
        lower_angle, lower_value = samples[-1]
        upper_angle, upper_value = samples[0]
        upper_angle += math.tau
    else:
        lower_angle, lower_value = samples[index - 1]
        upper_angle, upper_value = samples[index]
    query = query_angle % math.tau
    if query < lower_angle:
        query += math.tau
    span = upper_angle - lower_angle
    if span <= VECTOR_EPSILON:
        return (float(lower_value) + float(upper_value)) * 0.5
    blend = (query - lower_angle) / span
    return float(lower_value) * (1.0 - blend) + float(upper_value) * blend


def _consolidate_samples(
    samples: Sequence[tuple[float, float]],
) -> list[tuple[float, float]]:
    buckets: dict[float, list[float]] = {}
    for angle, value in samples:
        key = round(float(angle) % math.tau, 10)
        buckets.setdefault(key, []).append(float(value))
    return sorted(
        (angle, statistics.median(values))
        for angle, values in buckets.items()
    )


def _maximum_angular_gap(samples: Sequence[tuple[float, float]]) -> float:
    if len(samples) < 2:
        return math.tau
    angles = [sample[0] for sample in samples]
    gaps = [
        angles[index + 1] - angles[index]
        for index in range(len(angles) - 1)
    ]
    gaps.append(angles[0] + math.tau - angles[-1])
    return max(gaps)


def _recorded_positions(contour: dict) -> list[Vector3]:
    positions = {}
    for segment in contour.get('segments', []):
        for intersection in segment.get('intersections', []):
            position = _vector(intersection['position'])
            key = tuple(round(component, 9) for component in position)
            positions[key] = position
    return list(positions.values())


def reparameterize_contour(
    contour: dict,
    *,
    field: str,
    effective_values: Sequence[float],
    chain_points: Sequence[Sequence[float]],
    gasket: str,
    angle_sample_count: int,
) -> tuple[list[float], dict]:
    """Fit one recorded surface contour in its continuous fixed frame.

    The effective station delta is deliberately retained:

    fixed target = fixed station at recorded point
                 + effective old trace at old angle
                 - old station at recorded point.
    """

    positions = _recorded_positions(contour)
    if len(positions) < 3:
        raise ValueError(
            f'{gasket}/{field} has only {len(positions)} recorded positions'
        )
    records = []
    samples = []
    for position in positions:
        old_station, old_radial, old_angle = polyline_projection(
            position,
            chain_points,
        )
        fixed_station, fixed_radial, fixed_angle = joint_local_projection(
            position,
            chain_points,
            gasket,
        )
        effective_old_target = trace_value(effective_values, old_angle)
        separation_delta = effective_old_target - old_station
        fixed_target = fixed_station + separation_delta
        samples.append((fixed_angle, fixed_target))
        records.append(
            {
                'oldStation': old_station,
                'oldRadial': old_radial,
                'oldAngle': old_angle,
                'fixedStation': fixed_station,
                'fixedRadial': fixed_radial,
                'fixedAngle': fixed_angle,
                'effectiveOldTarget': effective_old_target,
                'separationDelta': separation_delta,
                'fixedTarget': fixed_target,
            }
        )
    consolidated = _consolidate_samples(samples)
    uniform_angles = [
        index / angle_sample_count * math.tau
        for index in range(angle_sample_count)
    ]
    values = [
        _cyclic_interpolate(consolidated, angle)
        for angle in uniform_angles
    ]
    residuals = [
        trace_value(values, record['fixedAngle']) - record['fixedTarget']
        for record in records
    ]
    separation_deltas = [
        record['separationDelta']
        for record in records
    ]
    station_frame_shifts = [
        record['fixedStation'] - record['oldStation']
        for record in records
    ]
    radial_frame_shifts = [
        record['fixedRadial'] - record['oldRadial']
        for record in records
    ]
    return values, {
        'field': field,
        'recordedPositionCount': len(records),
        'uniqueFixedAngleCount': len(consolidated),
        'maximumAngularGapRadians': _maximum_angular_gap(consolidated),
        'maximumAngularGapDegrees': math.degrees(
            _maximum_angular_gap(consolidated)
        ),
        'maximumAbsoluteFitResidualMeters': max(
            abs(value) for value in residuals
        ),
        'rmsFitResidualMeters': math.sqrt(
            sum(value * value for value in residuals) / len(residuals)
        ),
        'maximumAbsoluteSeparationDeltaMeters': max(
            abs(value) for value in separation_deltas
        ),
        'separationDeltaRangeMeters': [
            min(separation_deltas),
            max(separation_deltas),
        ],
        'stationFrameShiftRangeMeters': [
            min(station_frame_shifts),
            max(station_frame_shifts),
        ],
        'maximumAbsoluteStationFrameShiftMeters': max(
            abs(value) for value in station_frame_shifts
        ),
        'radialFrameShiftRangeMeters': [
            min(radial_frame_shifts),
            max(radial_frame_shifts),
        ],
    }


def _pivot_audit(
    *,
    side: str,
    digit: str,
    gasket: str,
    chain_points: Sequence[Sequence[float]],
    source_center: Sequence[float],
    fixed_center: Sequence[float],
    center_provenance: dict,
) -> dict:
    frame = joint_local_frames(chain_points)[GASKETS.index(gasket)]
    source_mean = statistics.fmean(float(value) for value in source_center)
    fixed_mean = statistics.fmean(float(value) for value in fixed_center)
    offset = fixed_mean - frame['anchorArc']
    proposed_pivot = _add(
        frame['anchorPoint'],
        _scale(frame['tangent'], offset),
    )
    return {
        'side': side,
        'digit': digit,
        'gasket': gasket,
        'sourceCenterStationMeanMeters': source_mean,
        'sourceCenterStationMinMeters': min(source_center),
        'sourceCenterStationMaxMeters': max(source_center),
        'centerStationMeanMeters': fixed_mean,
        'centerStationMinMeters': min(fixed_center),
        'centerStationMaxMeters': max(fixed_center),
        'anchorArcMeters': frame['anchorArc'],
        'centerOffsetFromAnchorMeters': offset,
        'anchorPoint': list(frame['anchorPoint']),
        'proposedAxisPivot': list(proposed_pivot),
        'tangent': list(frame['tangent']),
        'axisU': list(frame['axisU']),
        'axisV': list(frame['axisV']),
        'surfaceEvidencePositionCount': center_provenance[
            'recordedPositionCount'
        ],
        'surfaceFitMaximumResidualMeters': center_provenance[
            'maximumAbsoluteFitResidualMeters'
        ],
        'surfaceFitRmsResidualMeters': center_provenance[
            'rmsFitResidualMeters'
        ],
        'maximumAngularGapRadians': center_provenance[
            'maximumAngularGapRadians'
        ],
    }


def _mapping_records(
    joint_document: dict,
    chain_points: Sequence[Sequence[float]],
    gasket: str,
) -> list[dict]:
    records = []
    for contour in joint_document.get('contours', []):
        field = ROLE_TO_FIELD.get(contour.get('role'))
        if field is None:
            continue
        for position in _recorded_positions(contour):
            old_station, _old_radial, old_angle = polyline_projection(
                position,
                chain_points,
            )
            fixed_station, _fixed_radial, fixed_angle = (
                joint_local_projection(position, chain_points, gasket)
            )
            records.append(
                {
                    'field': field,
                    'fixedAngle': fixed_angle,
                    'oldAngle': old_angle,
                    'stationShift': fixed_station - old_station,
                    'fixedTarget': (
                        fixed_station
                        + trace_value(joint_document[field], old_angle)
                        - old_station
                    ),
                }
            )
    if not records:
        raise ValueError(f'{gasket} has no recorded mapping positions')
    return records


def _circular_mean(values: Sequence[float]) -> float:
    cosine = sum(math.cos(value) for value in values)
    sine = sum(math.sin(value) for value in values)
    return math.atan2(sine, cosine) % math.tau


def _build_irregular_mapping(records: Sequence[dict]) -> dict:
    """Build a shared cyclic map without aliasing it to 32 samples."""

    ordered = sorted(records, key=lambda item: item['fixedAngle'])
    groups = []
    for record in ordered:
        if (
            groups
            and abs(
                record['fixedAngle']
                - groups[-1][-1]['fixedAngle']
            )
            <= 1e-10
        ):
            groups[-1].append(record)
        else:
            groups.append([record])
    fixed_angles = [
        statistics.fmean(item['fixedAngle'] for item in group)
        for group in groups
    ]
    old_angles = [
        _circular_mean([item['oldAngle'] for item in group])
        for group in groups
    ]
    station_shifts = [
        statistics.median(item['stationShift'] for item in group)
        for group in groups
    ]
    cyclic_samples = list(zip(fixed_angles, station_shifts))
    return {
        'schemaVersion': 1,
        'interpolation': (
            'cyclic linear fixed-angle; shortest-arc old-angle; '
            'linear station shift'
        ),
        'fixedAnglesRadians': fixed_angles,
        'oldAnglesRadians': old_angles,
        'stationShiftsMeters': station_shifts,
        'recordedPositionCount': len(records),
        'mapSampleCount': len(groups),
        'maximumAngularGapRadians': _maximum_angular_gap(cyclic_samples),
        'maximumAngularGapDegrees': math.degrees(
            _maximum_angular_gap(cyclic_samples)
        ),
    }


def evaluate_joint_mapping(
    mapping: dict,
    fixed_angle: float,
) -> tuple[float, float]:
    """Evaluate mapped legacy angle and additive station shift."""

    fixed_angles = mapping['fixedAnglesRadians']
    old_angles = mapping['oldAnglesRadians']
    station_shifts = mapping['stationShiftsMeters']
    if len(fixed_angles) != len(old_angles) or len(fixed_angles) != len(
        station_shifts
    ):
        raise ValueError('Joint mapping arrays have inconsistent lengths')
    if not fixed_angles:
        raise ValueError('Joint mapping has no samples')
    if len(fixed_angles) == 1:
        return float(old_angles[0]), float(station_shifts[0])
    query = fixed_angle % math.tau
    index = bisect.bisect_right(fixed_angles, query)
    if index == 0:
        lower_index = len(fixed_angles) - 1
        upper_index = 0
        lower_fixed = fixed_angles[lower_index] - math.tau
        upper_fixed = fixed_angles[upper_index]
    elif index == len(fixed_angles):
        lower_index = len(fixed_angles) - 1
        upper_index = 0
        lower_fixed = fixed_angles[lower_index]
        upper_fixed = fixed_angles[upper_index] + math.tau
    else:
        lower_index = index - 1
        upper_index = index
        lower_fixed = fixed_angles[lower_index]
        upper_fixed = fixed_angles[upper_index]
    if query < lower_fixed:
        query += math.tau
    blend = (query - lower_fixed) / max(
        upper_fixed - lower_fixed,
        VECTOR_EPSILON,
    )
    lower_old = float(old_angles[lower_index])
    upper_old = float(old_angles[upper_index])
    old_delta = (
        (upper_old - lower_old + math.pi) % math.tau
    ) - math.pi
    mapped_old_angle = (lower_old + old_delta * blend) % math.tau
    station_shift = (
        float(station_shifts[lower_index]) * (1.0 - blend)
        + float(station_shifts[upper_index]) * blend
    )
    correction = mapping.get('stationCorrectionByFixedAngleMeters')
    if correction:
        station_shift += trace_value(correction, fixed_angle)
    return mapped_old_angle, station_shift


def _mapping_trace_audits(
    records: Sequence[dict],
    mapping: dict,
    source_joint: dict,
) -> list[dict]:
    result = []
    for field in FIELDS:
        field_records = [
            record for record in records if record['field'] == field
        ]
        residuals = []
        for record in field_records:
            mapped_angle, station_shift = evaluate_joint_mapping(
                mapping,
                record['fixedAngle'],
            )
            predicted = (
                trace_value(source_joint[field], mapped_angle)
                + station_shift
            )
            residuals.append(predicted - record['fixedTarget'])
        result.append(
            {
                'field': field,
                'recordedPositionCount': len(field_records),
                'maximumAbsoluteFitResidualMeters': max(
                    abs(value) for value in residuals
                ),
                'rmsFitResidualMeters': math.sqrt(
                    sum(value * value for value in residuals)
                    / len(residuals)
                ),
            }
        )
    return result


def _derive_fixed_fields(
    source_joint: dict,
    mapping: dict,
    angle_sample_count: int,
) -> dict[str, list[float]]:
    result = {field: [] for field in FIELDS}
    for index in range(angle_sample_count):
        fixed_angle = index / angle_sample_count * math.tau
        mapped_angle, station_shift = evaluate_joint_mapping(
            mapping,
            fixed_angle,
        )
        for field in FIELDS:
            result[field].append(
                trace_value(source_joint[field], mapped_angle)
                + station_shift
            )
    return result


def _accepted_thumb_head_shift(
    side: str,
    digit: str,
    source_digit: dict,
) -> float:
    if digit != 'thumb':
        return 0.0
    source_center = source_digit['joints']['G0']['center']
    offset = statistics.fmean(float(value) for value in source_center)
    if abs(offset) <= 0.002:
        return 0.0
    source_joint = source_digit['joints']['G0']
    if int(source_joint.get('priorityTier', 99)) > 2:
        return 0.0
    center_contour = next(
        (
            contour
            for contour in source_joint.get('contours', [])
            if contour.get('role') == 'center'
        ),
        None,
    )
    if center_contour is None:
        return 0.0
    _values, center_audit = reparameterize_contour(
        center_contour,
        field='center',
        effective_values=source_center,
        chain_points=source_digit['chainPoints'],
        gasket='G0',
        angle_sample_count=32,
    )
    if (
        center_audit['maximumAbsoluteFitResidualMeters']
        >= abs(offset) * 0.25
    ):
        return 0.0
    return offset


def _separate_adjacent_joint_traces(
    document: dict,
    *,
    minimum_gap: float = 0.0005,
) -> tuple[dict, list[dict]]:
    separated = copy.deepcopy(document)
    adjustment_totals = {}
    for _pass in range(6):
        changed = False
        for side, side_document in separated['seams'].items():
            for digit, digit_document in side_document.items():
                joints = digit_document['joints']
                for proximal_name, distal_name in zip(
                    GASKETS,
                    GASKETS[1:],
                ):
                    proximal_joint = joints[proximal_name]
                    distal_joint = joints[distal_name]
                    for sample in range(32):
                        gap = (
                            float(distal_joint['proximal'][sample])
                            - float(proximal_joint['distal'][sample])
                        )
                        if gap >= minimum_gap - 1e-12:
                            continue
                        changed = True
                        shift = (minimum_gap - gap) * 0.5
                        for field in FIELDS:
                            proximal_joint[field][sample] = (
                                float(proximal_joint[field][sample]) - shift
                            )
                            distal_joint[field][sample] = (
                                float(distal_joint[field][sample]) + shift
                            )
                        key = (side, digit, proximal_name, distal_name)
                        record = adjustment_totals.setdefault(
                            key,
                            {
                                'side': side,
                                'digit': digit,
                                'proximalJoint': proximal_name,
                                'distalJoint': distal_name,
                                'adjustedSamples': set(),
                                'maximumOneSidedShift': 0.0,
                            },
                        )
                        record['adjustedSamples'].add(sample)
                        record['maximumOneSidedShift'] = max(
                            record['maximumOneSidedShift'],
                            shift,
                        )
        if not changed:
            break
    else:
        raise RuntimeError('Adjacent trace separation did not converge')
    adjustments = []
    for record in adjustment_totals.values():
        adjustments.append(
            {
                **record,
                'adjustedSamples': sorted(record['adjustedSamples']),
            }
        )
    return separated, sorted(
        adjustments,
        key=lambda item: (
            item['side'],
            item['digit'],
            item['proximalJoint'],
        ),
    )


def reparameterize_document(document: dict) -> tuple[dict, dict]:
    """Reparameterize all contours through one shared irregular map per joint."""

    angle_sample_count = int(document.get('angleSampleCount', 32))
    if angle_sample_count != 32:
        raise ValueError(
            f'Expected 32 angle samples, got {angle_sample_count}'
        )
    effective_document, separation_adjustments = (
        _separate_adjacent_joint_traces(document)
    )
    result = copy.deepcopy(effective_document)
    trace_audits = []
    pivot_audits = []
    mapping_audits = []
    order_audits = []
    pivot_relocations = []
    for side, side_document in effective_document['seams'].items():
        for digit, source_digit in side_document.items():
            original_digit = document['seams'][side][digit]
            original_chain = source_digit['chainPoints']
            target_digit = result['seams'][side][digit]
            head_shift = _accepted_thumb_head_shift(
                side,
                digit,
                original_digit,
            )
            target_chain = copy.deepcopy(original_chain)
            if head_shift:
                first_tangent = _chain_geometry(original_chain)[1][0]
                old_head = _vector(original_chain[0])
                new_head = _add(
                    old_head,
                    _scale(first_tangent, head_shift),
                )
                pivot_relocations.append(
                    {
                        'side': side,
                        'digit': digit,
                        'gasket': 'G0',
                        'oldHead': list(old_head),
                        'newHead': list(new_head),
                        'shiftMeters': head_shift,
                        'selectionRule': (
                            'absolute G0 center offset >2mm and '
                            'surface residual <25% of offset'
                        ),
                    }
                )
            target_frames = joint_local_frames(target_chain)
            for gasket in GASKETS:
                source_joint = source_digit['joints'][gasket]
                target_joint = target_digit['joints'][gasket]
                records = _mapping_records(
                    source_joint,
                    original_chain,
                    gasket,
                )
                mapping = _build_irregular_mapping(records)
                field_audits = _mapping_trace_audits(
                    records,
                    mapping,
                    source_joint,
                )
                for item in field_audits:
                    item.update(
                        {
                            'side': side,
                            'digit': digit,
                            'gasket': gasket,
                        }
                    )
                    trace_audits.append(item)
                fixed_fields = _derive_fixed_fields(
                    source_joint,
                    mapping,
                    angle_sample_count,
                )
                for field in FIELDS:
                    target_joint[field] = fixed_fields[field]
                target_joint['halfWidth'] = [
                    (
                        fixed_fields['distal'][index]
                        - fixed_fields['proximal'][index]
                    )
                    * 0.5
                    for index in range(angle_sample_count)
                ]
                for contour in target_joint.get('contours', []):
                    field = ROLE_TO_FIELD.get(contour.get('role'))
                    if field is not None:
                        contour[
                            'stationOffsetFromCenterMetersByAngle'
                        ] = [
                            fixed_fields[field][index]
                            - fixed_fields['center'][index]
                            for index in range(angle_sample_count)
                        ]
                frame = target_frames[GASKETS.index(gasket)]
                target_joint['fixedFrameProjection'] = {
                    'schemaVersion': 2,
                    'gasket': gasket,
                    'anchorPoint': list(frame['anchorPoint']),
                    'anchorArcMeters': frame['anchorArc'],
                    'tangent': list(frame['tangent']),
                    'axisU': list(frame['axisU']),
                    'axisV': list(frame['axisV']),
                    'sourceEffectiveTraces': {
                        field: list(source_joint[field])
                        for field in FIELDS
                    },
                    'mapping': mapping,
                    'traceFitAudit': field_audits,
                }
                mapping_audits.append(
                    {
                        'side': side,
                        'digit': digit,
                        'gasket': gasket,
                        'mapSampleCount': mapping['mapSampleCount'],
                        'recordedPositionCount': mapping[
                            'recordedPositionCount'
                        ],
                        'maximumAngularGapRadians': mapping[
                            'maximumAngularGapRadians'
                        ],
                        'maximumAngularGapDegrees': mapping[
                            'maximumAngularGapDegrees'
                        ],
                    }
                )
                pivot = _pivot_audit(
                    side=side,
                    digit=digit,
                    gasket=gasket,
                    chain_points=target_chain,
                    source_center=source_joint['center'],
                    fixed_center=fixed_fields['center'],
                    center_provenance={
                        'recordedPositionCount': next(
                            item['recordedPositionCount']
                            for item in field_audits
                            if item['field'] == 'center'
                        ),
                        'maximumAbsoluteFitResidualMeters': next(
                            item['maximumAbsoluteFitResidualMeters']
                            for item in field_audits
                            if item['field'] == 'center'
                        ),
                        'rmsFitResidualMeters': next(
                            item['rmsFitResidualMeters']
                            for item in field_audits
                            if item['field'] == 'center'
                        ),
                        'maximumAngularGapRadians': mapping[
                            'maximumAngularGapRadians'
                        ],
                    },
                )
                target_joint['pivotAudit'] = pivot
                pivot_audits.append(pivot)
                proximal_center = [
                    fixed_fields['center'][index]
                    - fixed_fields['proximal'][index]
                    for index in range(angle_sample_count)
                ]
                center_distal = [
                    fixed_fields['distal'][index]
                    - fixed_fields['center'][index]
                    for index in range(angle_sample_count)
                ]
                order_audits.append(
                    {
                        'side': side,
                        'digit': digit,
                        'gasket': gasket,
                        'proximalCenterViolationCount': sum(
                            value < 0.0 for value in proximal_center
                        ),
                        'centerDistalViolationCount': sum(
                            value < 0.0 for value in center_distal
                        ),
                        'minimumProximalCenterGapMeters': min(
                            proximal_center
                        ),
                        'minimumCenterDistalGapMeters': min(
                            center_distal
                        ),
                        'minimumFullWidthMeters': min(
                            fixed_fields['distal'][index]
                            - fixed_fields['proximal'][index]
                            for index in range(angle_sample_count)
                        ),
                        'maximumFullWidthMeters': max(
                            fixed_fields['distal'][index]
                            - fixed_fields['proximal'][index]
                            for index in range(angle_sample_count)
                        ),
                    }
                )
    pre_correction_trace_audits = trace_audits
    fixed_frame_separation_adjustments = []
    trace_audits = []
    pivot_audits = []
    for side, side_document in effective_document['seams'].items():
        for digit, source_digit in side_document.items():
            target_digit = result['seams'][side][digit]
            for gasket in GASKETS:
                source_joint = source_digit['joints'][gasket]
                target_joint = target_digit['joints'][gasket]
                mapping = target_joint[
                    'fixedFrameProjection'
                ]['mapping']
                records = _mapping_records(
                    source_joint,
                    source_digit['chainPoints'],
                    gasket,
                )
                field_audits = _mapping_trace_audits(
                    records,
                    mapping,
                    source_joint,
                )
                for item in field_audits:
                    item.update(
                        {
                            'side': side,
                            'digit': digit,
                            'gasket': gasket,
                        }
                    )
                    trace_audits.append(item)
                target_joint[
                    'fixedFrameProjection'
                ]['traceFitAudit'] = field_audits
                previous_pivot = target_joint['pivotAudit']
                pivot = _pivot_audit(
                    side=side,
                    digit=digit,
                    gasket=gasket,
                    chain_points=source_digit['chainPoints'],
                    source_center=source_joint['center'],
                    fixed_center=target_joint['center'],
                    center_provenance={
                        'recordedPositionCount': next(
                            item['recordedPositionCount']
                            for item in field_audits
                            if item['field'] == 'center'
                        ),
                        'maximumAbsoluteFitResidualMeters': next(
                            item['maximumAbsoluteFitResidualMeters']
                            for item in field_audits
                            if item['field'] == 'center'
                        ),
                        'rmsFitResidualMeters': next(
                            item['rmsFitResidualMeters']
                            for item in field_audits
                            if item['field'] == 'center'
                        ),
                        'maximumAngularGapRadians': previous_pivot[
                            'maximumAngularGapRadians'
                        ],
                    },
                )
                target_joint['pivotAudit'] = pivot
                pivot_audits.append(pivot)
    adjacent_gap_audits = []
    for side, side_document in result['seams'].items():
        for digit, digit_document in side_document.items():
            joints = digit_document['joints']
            source_joints = effective_document[
                'seams'
            ][side][digit]['joints']
            for proximal_gasket, distal_gasket in (
                ('G0', 'G1'),
                ('G1', 'G2'),
            ):
                proximal_joint = source_joints[proximal_gasket]
                distal_joint = source_joints[distal_gasket]
                evaluation_angles = [
                    index / 2048 * math.tau
                    for index in range(2048)
                ]
                gaps = [
                    (
                        trace_value(
                            distal_joint['proximal'],
                            angle,
                        )
                        - trace_value(
                            proximal_joint['distal'],
                            angle,
                        )
                    )
                    for angle in evaluation_angles
                ]
                adjacent_gap_audits.append(
                    {
                        'side': side,
                        'digit': digit,
                        'proximalGasket': proximal_gasket,
                        'distalGasket': distal_gasket,
                        'correspondence': 'shared legacy/source angle',
                        'minimumGapMeters': min(gaps),
                        'requiredGapMeters': 0.0005,
                        'evaluationCount': len(gaps),
                        'violationCount': sum(
                            value < 0.0005 - 1e-10 for value in gaps
                        ),
                    }
                )
    result['fixedFrameReparameterization'] = {
        'schemaVersion': 2,
        'projection': (
            'fixed joint-local tangent with parallel-transported '
            'circumferential axes'
        ),
        'runtimeTargetRule': (
            'trace_value(sourceEffectiveField, '
            'mappedOldAngle(fixedAngle)) + mappedStationShift(fixedAngle)'
        ),
        'traceRecordCount': len(trace_audits),
        'pivotRelocations': pivot_relocations,
        'sourceTraceSeparationAdjustments': separation_adjustments,
        'fixedFrameSeparationAdjustments': (
            fixed_frame_separation_adjustments
        ),
    }
    audit = {
        'schemaVersion': 2,
        'jointCount': len(pivot_audits),
        'traceRecordCount': len(trace_audits),
        'angleSampleCount': angle_sample_count,
        'preCorrectionMaximumFitResidualMeters': max(
            item['maximumAbsoluteFitResidualMeters']
            for item in pre_correction_trace_audits
        ),
        'maximumFitResidualMeters': max(
            item['maximumAbsoluteFitResidualMeters']
            for item in trace_audits
        ),
        'maximumAdditionalSeparationCorrectionMeters': max(
            (
                item['maximumOneSidedShift']
                for item in fixed_frame_separation_adjustments
            ),
            default=0.0,
        ),
        'maximumAngularGapRadians': max(
            item['maximumAngularGapRadians']
            for item in mapping_audits
        ),
        'maximumAngularGapDegrees': max(
            item['maximumAngularGapDegrees']
            for item in mapping_audits
        ),
        'orderingViolationCount': sum(
            item['proximalCenterViolationCount']
            + item['centerDistalViolationCount']
            for item in order_audits
        ),
        'widthContractViolationCount': sum(
            item['minimumFullWidthMeters'] < 0.002 - 1e-9
            or item['maximumFullWidthMeters'] > 0.007 + 1e-9
            for item in order_audits
        ),
        'adjacentGapViolationCount': sum(
            item['violationCount'] for item in adjacent_gap_audits
        ),
        'largeG0PivotOffsets': [
            item
            for item in pivot_audits
            if item['gasket'] == 'G0'
            and abs(item['sourceCenterStationMeanMeters']) > 0.005
        ],
        'traceAudits': trace_audits,
        'mappingAudits': mapping_audits,
        'pivotAudits': pivot_audits,
        'pivotRelocations': pivot_relocations,
        'sourceTraceSeparationAdjustments': separation_adjustments,
        'fixedFrameSeparationAdjustments': (
            fixed_frame_separation_adjustments
        ),
        'orderAudits': order_audits,
        'adjacentGapAudits': adjacent_gap_audits,
    }
    return result, audit


PIVOT_ANGLE_BIN_COUNT = 32
PIVOT_RADIAL_MAX_FIT_RMS_METERS = 0.0016
PIVOT_RADIAL_MAX_ANGULAR_GAP_RADIANS = math.pi / 4.0
PIVOT_RADIAL_MAX_CORRECTION_METERS = 0.008
PIVOT_AXIAL_MAX_CORRECTION_METERS = 0.040


def _kasa_circle_center_2d(
    points: Sequence[tuple[float, float]],
) -> tuple[float, float, float, float]:
    """Algebraic circle fit; returns (centerX, centerY, radius, rmsResidual)."""

    count = len(points)
    if count < 3:
        raise ValueError('Circle fit requires at least three ring samples')
    sum_x = sum(x for x, _y in points)
    sum_y = sum(y for _x, y in points)
    sum_xx = sum(x * x for x, _y in points)
    sum_yy = sum(y * y for _x, y in points)
    sum_xy = sum(x * y for x, y in points)
    sum_z = sum(x * x + y * y for x, y in points)
    sum_zx = sum((x * x + y * y) * x for x, y in points)
    sum_zy = sum((x * x + y * y) * y for x, y in points)
    rows = [
        [4.0 * sum_xx, 4.0 * sum_xy, 2.0 * sum_x, 2.0 * sum_zx],
        [4.0 * sum_xy, 4.0 * sum_yy, 2.0 * sum_y, 2.0 * sum_zy],
        [2.0 * sum_x, 2.0 * sum_y, float(count), sum_z],
    ]
    for index in range(3):
        pivot_row = max(range(index, 3), key=lambda row: abs(rows[row][index]))
        rows[index], rows[pivot_row] = rows[pivot_row], rows[index]
        if abs(rows[index][index]) < 1e-15:
            raise ValueError('Circle fit normal equations are singular')
        for row in range(3):
            if row != index:
                factor = rows[row][index] / rows[index][index]
                rows[row] = [
                    value - factor * basis
                    for value, basis in zip(rows[row], rows[index])
                ]
    center_x, center_y, offset = (
        rows[index][3] / rows[index][index] for index in range(3)
    )
    radius = math.sqrt(max(offset + center_x**2 + center_y**2, 0.0))
    rms = math.sqrt(
        sum(
            (math.hypot(x - center_x, y - center_y) - radius) ** 2
            for x, y in points
        )
        / count
    )
    return center_x, center_y, radius, rms


def derive_measured_digit_pivots(document: dict) -> tuple[dict, list[dict]]:
    """Derive one bone pivot per digit joint from its measured center ring.

    The chain points remain the immutable trace frame; the returned pivots are
    a product of that evidence for rig placement only.  Every joint receives
    the axial station-mean correction along its fixed-frame tangent.  The
    in-plane (radial) correction from an algebraic circle fit of the recorded
    center-ring evidence is applied only when the ring is well covered and
    near-circular; partial or irregular rings (knuckle collars, thumb bases)
    keep their axial-only pivot rather than trusting a biased fit.
    """

    _effective, audit = reparameterize_document(document)
    station_by_joint = {
        (item['side'], item['digit'], item['gasket']): item
        for item in audit['pivotAudits']
    }
    pivots: dict = {}
    provenance: list[dict] = []
    for side, side_document in document['seams'].items():
        pivots[side] = {}
        for digit, digit_document in side_document.items():
            chain_points = digit_document['chainPoints']
            frames = joint_local_frames(chain_points)
            joint_pivots = []
            for gasket_index, gasket in enumerate(GASKETS):
                frame = frames[gasket_index]
                anchor = _vector(frame['anchorPoint'])
                tangent = _vector(frame['tangent'])
                axis_u = _vector(frame['axisU'])
                axis_v = _vector(frame['axisV'])
                station = station_by_joint[(side, digit, gasket)]
                axial = float(station['centerOffsetFromAnchorMeters'])
                if abs(axial) > PIVOT_AXIAL_MAX_CORRECTION_METERS:
                    raise RuntimeError(
                        f'{side} {digit} {gasket} measured axial pivot '
                        f'correction {axial} exceeds the sanity cap'
                    )
                center_contour = next(
                    contour
                    for contour in digit_document['joints'][gasket]['contours']
                    if contour.get('role') == 'center'
                )
                ring_bins: dict[int, list[tuple[float, float]]] = {}
                for position in _recorded_positions(center_contour):
                    relative = _subtract(position, anchor)
                    angle = math.atan2(
                        _dot(relative, axis_v),
                        _dot(relative, axis_u),
                    ) % math.tau
                    ring_bins.setdefault(
                        int(angle / math.tau * PIVOT_ANGLE_BIN_COUNT)
                        % PIVOT_ANGLE_BIN_COUNT,
                        [],
                    ).append((_dot(relative, axis_u), _dot(relative, axis_v)))
                bin_means = [
                    (
                        sum(x for x, _y in samples) / len(samples),
                        sum(y for _x, y in samples) / len(samples),
                    )
                    for samples in ring_bins.values()
                ]
                occupied = sorted(ring_bins)
                maximum_gap = (
                    max(
                        (occupied[(index + 1) % len(occupied)] - occupied[index])
                        % PIVOT_ANGLE_BIN_COUNT
                        for index in range(len(occupied))
                    )
                    * math.tau
                    / PIVOT_ANGLE_BIN_COUNT
                )
                radial_u, radial_v, ring_radius, fit_rms = (
                    _kasa_circle_center_2d(bin_means)
                )
                radial_magnitude = math.hypot(radial_u, radial_v)
                radial_accepted = (
                    fit_rms <= PIVOT_RADIAL_MAX_FIT_RMS_METERS
                    and maximum_gap <= PIVOT_RADIAL_MAX_ANGULAR_GAP_RADIANS
                    and radial_magnitude <= PIVOT_RADIAL_MAX_CORRECTION_METERS
                )
                pivot = _add(anchor, _scale(tangent, axial))
                if radial_accepted:
                    pivot = _add(
                        _add(pivot, _scale(axis_u, radial_u)),
                        _scale(axis_v, radial_v),
                    )
                joint_pivots.append(list(pivot))
                provenance.append(
                    {
                        'side': side,
                        'digit': digit,
                        'gasket': gasket,
                        'method': (
                            'axial+radial' if radial_accepted else 'axial-only'
                        ),
                        'axialOffsetMeters': axial,
                        'radialOffsetUMeters': radial_u,
                        'radialOffsetVMeters': radial_v,
                        'radialOffsetMeters': radial_magnitude,
                        'radialAccepted': radial_accepted,
                        'ringFitRmsMeters': fit_rms,
                        'ringFitRadiusMeters': ring_radius,
                        'ringMaximumAngularGapRadians': maximum_gap,
                        'ringOccupiedBinCount': len(occupied),
                        'anchorPoint': list(anchor),
                        'pivot': list(pivot),
                        'selectionRule': (
                            'axial station mean always; in-plane circle-fit '
                            f'center only when fit rms <= '
                            f'{PIVOT_RADIAL_MAX_FIT_RMS_METERS} m, angular '
                            f'gap <= pi/4, and correction <= '
                            f'{PIVOT_RADIAL_MAX_CORRECTION_METERS} m'
                        ),
                    }
                )
            joint_pivots.append(list(chain_points[3]))
            pivots[side][digit] = joint_pivots
    return pivots, provenance


def _sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def main() -> int:
    parser = argparse.ArgumentParser(
        description='Reparameterize hinge traces into continuous fixed frames.'
    )
    parser.add_argument('input', type=Path)
    parser.add_argument('--output', type=Path)
    parser.add_argument('--audit-output', type=Path)
    arguments = parser.parse_args()
    source_bytes = arguments.input.read_bytes()
    document = json.loads(source_bytes)
    result, audit = reparameterize_document(document)
    encoded = (
        json.dumps(result, indent=2, ensure_ascii=False) + chr(10)
    ).encode('utf-8')
    audit['sourceFile'] = str(arguments.input)
    audit['sourceSha256'] = _sha256_bytes(source_bytes)
    audit['resultSha256'] = _sha256_bytes(encoded)
    if arguments.output is not None:
        arguments.output.parent.mkdir(parents=True, exist_ok=True)
        arguments.output.write_bytes(encoded)
    if arguments.audit_output is not None:
        arguments.audit_output.parent.mkdir(parents=True, exist_ok=True)
        arguments.audit_output.write_text(
            json.dumps(audit, indent=2, ensure_ascii=False) + chr(10),
            encoding='utf-8',
        )
    print(json.dumps({
        key: value
        for key, value in audit.items()
        if key not in {
            'traceAudits',
            'mappingAudits',
            'pivotAudits',
            'pivotRelocations',
            'orderAudits',
            'adjacentGapAudits',
            'largeG0PivotOffsets',
        }
    }, sort_keys=True))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
