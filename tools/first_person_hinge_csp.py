#!/usr/bin/env python3
"""Memory-bounded exact solver for central mechanical hinge relations."""

from __future__ import annotations


def solve_weighted_relations(
    *,
    components,
    relation_groups,
    protected_states,
    evidence_states,
    rank_priority,
):
    """Maximize retained active edges under equality-or-oriented-pair rules.

    ``relation_groups`` may combine many subdivided geometric edges with one
    identical quotient relation.  The returned decision map is expanded back
    to every raw edge key.  Search uses a rollback DSU, a greedy incumbent, and
    a sound upper bound; it stores no per-state mesh dictionaries.
    """

    components = set(components)
    decisions = {}
    adjacency = {component: set() for component in components}
    for group in relation_groups:
        nodes = tuple(group["components"])
        if len(nodes) == 2:
            first, second = nodes
            adjacency[first].add(second)
            adjacency[second].add(first)

    clusters = []
    unseen = set(components)
    while unseen:
        seed = min(unseen)
        cluster = set()
        stack = [seed]
        while stack:
            component = stack.pop()
            if component in cluster:
                continue
            cluster.add(component)
            unseen.discard(component)
            stack.extend(adjacency[component] - cluster)
        clusters.append(cluster)

    audit = {
        "solver": "weighted-rollback-dsu-branch-and-bound",
        "objective": (
            "maximum total active physical edge count; ties use rank priority "
            "1,4,2,3 then geometric edge key"
        ),
        "boundProof": (
            "remaining active weight is bounded by individually compatible "
            "groups and one required label per current DSU root; future "
            "assignments and unions only remove support"
        ),
        "tieCountEnumerated": False,
        "optimalityProven": True,
        "clusterCount": len(clusters),
        "rawEdgeCount": sum(group["activeWeight"] for group in relation_groups),
        "relationGroupCount": len(relation_groups),
        "visitedNodeCount": 0,
        "upperBoundPruneCount": 0,
        "infeasibleBranchCount": 0,
        "feasibleLeafCount": 0,
        "infeasibleLeafCount": 0,
        "rejectedFallbackLeafCount": 0,
        "maximumDepth": 0,
        "peakRollbackLogSize": 0,
        "optimalActiveEdgeCount": 0,
        "clusters": [],
    }
    solved_parent = {}
    solved_labels = {}
    fallback_records = []

    for cluster_index, cluster in enumerate(clusters):
        nodes = sorted(cluster)
        node_offset = {
            component: offset for offset, component in enumerate(nodes)
        }
        parent = list(range(len(nodes)))
        size = [1] * len(nodes)
        label = [-1] * len(nodes)
        rollback_log = []
        cluster_groups = [
            group
            for group in relation_groups
            if group["components"][0] in cluster
        ]
        cluster_audit = {
            "clusterIndex": cluster_index,
            "quotientNodeCount": len(nodes),
            "rawEdgeCount": sum(
                group["activeWeight"] for group in cluster_groups
            ),
            "initialRelationGroupCount": len(cluster_groups),
            "visitedNodeCount": 0,
            "upperBoundPruneCount": 0,
            "infeasibleBranchCount": 0,
            "feasibleLeafCount": 0,
            "infeasibleLeafCount": 0,
            "rejectedFallbackLeafCount": 0,
            "maximumDepth": 0,
            "peakRollbackLogSize": 0,
            "greedyVisitedNodeCount": 0,
        }

        def find(node):
            while parent[node] != node:
                node = parent[node]
            return node

        def update_peak_log():
            cluster_audit["peakRollbackLogSize"] = max(
                cluster_audit["peakRollbackLogSize"], len(rollback_log)
            )

        def assign(node, state):
            root = find(node)
            old_state = label[root]
            if old_state >= 0 and old_state != state:
                return False
            if old_state < 0:
                rollback_log.append(("label", root, old_state))
                label[root] = state
                update_peak_log()
            return True

        def union(first, second):
            first_root = find(first)
            second_root = find(second)
            if first_root == second_root:
                return True
            first_label = label[first_root]
            second_label = label[second_root]
            if (
                first_label >= 0
                and second_label >= 0
                and first_label != second_label
            ):
                return False
            if (
                size[first_root] < size[second_root]
                or (
                    size[first_root] == size[second_root]
                    and first_root > second_root
                )
            ):
                first_root, second_root = second_root, first_root
                first_label, second_label = second_label, first_label
            rollback_log.append(
                (
                    "union",
                    second_root,
                    first_root,
                    size[first_root],
                    label[first_root],
                )
            )
            parent[second_root] = first_root
            size[first_root] += size[second_root]
            if first_label < 0 <= second_label:
                label[first_root] = second_label
            update_peak_log()
            return True

        def rollback(checkpoint):
            while len(rollback_log) > checkpoint:
                record = rollback_log.pop()
                if record[0] == "label":
                    _kind, root, old_state = record
                    label[root] = old_state
                else:
                    _kind, child, root, old_size, old_label = record
                    parent[child] = child
                    size[root] = old_size
                    label[root] = old_label

        for component in nodes:
            states = set(protected_states.get(component, set()))
            if len(states) > 1:
                raise RuntimeError(
                    "One quotient node carries multiple protected states"
                )
            if states and not assign(
                node_offset[component], next(iter(states))
            ):
                raise RuntimeError("Protected hinge anchors disagree")

        working_optional = []
        for group in cluster_groups:
            if group["forceInactive"]:
                for edge_key in group["edgeKeys"]:
                    decisions[edge_key] = "inactive"
                if len(group["components"]) == 2 and not union(
                    node_offset[group["components"][0]],
                    node_offset[group["components"][1]],
                ):
                    raise RuntimeError(
                        "Forced central equality joins protected states"
                    )
            else:
                if len(group["components"]) != 2 or any(
                    len(group["localStates"][component]) != 1
                    for component in group["components"]
                ):
                    raise RuntimeError(
                        "Optional weighted relation lacks one oriented local "
                        "state per endpoint"
                    )
                working_optional.append(group)

        fixed_point_forced_weight = 0
        while True:
            mapped = []
            forced_ids = set()
            by_root_pair = {}
            for group in working_optional:
                first_component, second_component = group["components"]
                first_root = find(node_offset[first_component])
                second_root = find(node_offset[second_component])
                if first_root == second_root:
                    forced_ids.add(group["edgeKey"])
                    continue
                first_local = next(iter(group["localStates"][first_component]))
                second_local = next(
                    iter(group["localStates"][second_component])
                )
                if first_root > second_root:
                    first_root, second_root = second_root, first_root
                    first_local, second_local = second_local, first_local
                record = {
                    "source": group,
                    "roots": (first_root, second_root),
                    "locals": (first_local, second_local),
                }
                mapped.append(record)
                by_root_pair.setdefault(record["roots"], []).append(record)
            conflicting_pairs = []
            for root_pair, pair_records in by_root_pair.items():
                if len({record["locals"] for record in pair_records}) > 1:
                    conflicting_pairs.append((root_pair, pair_records))
                    forced_ids.update(
                        record["source"]["edgeKey"]
                        for record in pair_records
                    )
            if not forced_ids:
                break
            for group in working_optional:
                if group["edgeKey"] not in forced_ids:
                    continue
                for edge_key in group["edgeKeys"]:
                    decisions[edge_key] = "inactive"
                fixed_point_forced_weight += group["activeWeight"]
            for root_pair, _pair_records in conflicting_pairs:
                if not union(*root_pair):
                    raise RuntimeError(
                        "Conflicting parallel relations join protected states"
                    )
            working_optional = [
                group
                for group in working_optional
                if group["edgeKey"] not in forced_ids
            ]

        remaining_ids = {group["edgeKey"] for group in working_optional}
        aggregated = {}
        for record in mapped:
            group = record["source"]
            if group["edgeKey"] not in remaining_ids:
                continue
            relation = (record["roots"], record["locals"])
            target = aggregated.setdefault(
                relation,
                {
                    "first": record["roots"][0],
                    "second": record["roots"][1],
                    "firstLocal": record["locals"][0],
                    "secondLocal": record["locals"][1],
                    "edgeKeys": [],
                    "edgeRanks": {},
                    "activeWeight": 0,
                    "rank": group["rank"],
                },
            )
            target["edgeKeys"].extend(group["edgeKeys"])
            target["edgeRanks"].update(group["edgeRanks"])
            target["activeWeight"] += group["activeWeight"]
            target["rank"] = min(target["rank"], group["rank"])
        search_groups = list(aggregated.values())
        for group in search_groups:
            group["edgeKeys"] = tuple(sorted(group["edgeKeys"]))
            group["signatureSortKey"] = min(
                (
                    rank_priority[group["edgeRanks"][edge_key]],
                    edge_key,
                )
                for edge_key in group["edgeKeys"]
            )
        search_groups.sort(key=lambda group: group["signatureSortKey"])
        current_roots = sorted(
            {find(node) for node in range(len(nodes))}
        )
        state_universe = {3}
        state_universe.update(
            state
            for root in current_roots
            for state in ([label[root]] if label[root] >= 0 else [])
        )
        state_universe.update(
            state
            for group in search_groups
            for state in (group["firstLocal"], group["secondLocal"])
        )
        domains = {
            root: (
                {label[root]}
                if label[root] >= 0
                else set(state_universe)
            )
            for root in current_roots
        }
        direct_anchor_conflicts = []
        for group in search_groups:
            first_root = find(group["first"])
            second_root = find(group["second"])
            first_state = label[first_root]
            second_state = label[second_root]
            if first_state < 0 or second_state < 0:
                continue
            if not (
                first_state == second_state
                or (
                    first_state == group["firstLocal"]
                    and second_state == group["secondLocal"]
                )
            ):
                direct_anchor_conflicts.append(
                    {
                        "edgeKeys": group["edgeKeys"],
                        "components": (
                            nodes[first_root],
                            nodes[second_root],
                        ),
                        "anchorStates": (first_state, second_state),
                        "localStates": (
                            group["firstLocal"],
                            group["secondLocal"],
                        ),
                    }
                )
        if direct_anchor_conflicts:
            raise RuntimeError(
                "Central quotient has direct protected-anchor relation "
                f"conflicts: {direct_anchor_conflicts[:12]}"
            )

        directed_arcs = []
        for group_index, group in enumerate(search_groups):
            directed_arcs.append((group_index, False))
            directed_arcs.append((group_index, True))
        removal_records = []
        changed = True
        while changed:
            changed = False
            for group_index, reverse in directed_arcs:
                group = search_groups[group_index]
                first_root = find(group["first"])
                second_root = find(group["second"])
                if reverse:
                    source_root, target_root = second_root, first_root
                    source_local = group["secondLocal"]
                    target_local = group["firstLocal"]
                else:
                    source_root, target_root = first_root, second_root
                    source_local = group["firstLocal"]
                    target_local = group["secondLocal"]
                unsupported = {
                    source_state
                    for source_state in domains[source_root]
                    if not any(
                        source_state == target_state
                        or (
                            source_state == source_local
                            and target_state == target_local
                        )
                        for target_state in domains[target_root]
                    )
                }
                if not unsupported:
                    continue
                before = sorted(domains[source_root])
                target_domain = sorted(domains[target_root])
                domains[source_root] -= unsupported
                removal_records.append(
                    {
                        "component": nodes[source_root],
                        "removedStates": sorted(unsupported),
                        "domainBefore": before,
                        "neighborComponent": nodes[target_root],
                        "neighborDomain": target_domain,
                        "edgeKeys": group["edgeKeys"],
                        "requiredPair": (source_local, target_local),
                    }
                )
                changed = True
                if not domains[source_root]:
                    incident_relations = [
                        {
                            "edgeKeys": candidate["edgeKeys"],
                            "components": (
                                nodes[find(candidate["first"])],
                                nodes[find(candidate["second"])],
                            ),
                            "localStates": (
                                candidate["firstLocal"],
                                candidate["secondLocal"],
                            ),
                        }
                        for candidate in search_groups
                        if source_root
                        in {
                            find(candidate["first"]),
                            find(candidate["second"]),
                        }
                    ]
                    raise RuntimeError(
                        "Central quotient AC-3 emptied a topology-state "
                        f"domain: cluster={cluster_index} "
                        f"component={nodes[source_root]} "
                        "protected="
                        f"{dict((nodes[root], label[root]) for root in current_roots if label[root] >= 0)} "
                        f"recentRemovals={removal_records[-20:]} "
                        f"incidentRelations={incident_relations}"
                    )
        forced_domain_assignment_count = 0
        for root, domain in domains.items():
            if label[root] < 0 and len(domain) == 1:
                if not assign(root, next(iter(domain))):
                    raise RuntimeError(
                        "AC-3 singleton contradicted a protected state"
                    )
                forced_domain_assignment_count += 1
        cluster_audit["arcConsistencyRemovalCount"] = len(
            removal_records
        )
        cluster_audit["arcConsistencySingletonAssignmentCount"] = (
            forced_domain_assignment_count
        )
        raw_signature_slots = sorted(
            (
                rank_priority[group["edgeRanks"][edge_key]],
                edge_key,
                group_index,
            )
            for group_index, group in enumerate(search_groups)
            for edge_key in group["edgeKeys"]
        )
        decision_bits = [-1] * len(search_groups)
        evidence_by_node = [
            set(evidence_states.get(component, set())) for component in nodes
        ]

        def active_compatible(group):
            first_root = find(group["first"])
            second_root = find(group["second"])
            if first_root == second_root:
                return False
            return (
                label[first_root] in {-1, group["firstLocal"]}
                and label[second_root] in {-1, group["secondLocal"]}
            )

        def optimistic_bound(offset):
            feasible = [False] * len(search_groups)
            total_weight = 0
            root_buckets = {}
            for group_index in range(offset, len(search_groups)):
                group = search_groups[group_index]
                if not active_compatible(group):
                    continue
                feasible[group_index] = True
                total_weight += group["activeWeight"]
                for root, required_state in (
                    (find(group["first"]), group["firstLocal"]),
                    (find(group["second"]), group["secondLocal"]),
                ):
                    bucket = root_buckets.setdefault(root, {})
                    bucket[required_state] = (
                        bucket.get(required_state, 0)
                        + group["activeWeight"]
                    )
            capacity = 0
            for root, buckets in root_buckets.items():
                state = label[root]
                capacity += (
                    max(buckets.values())
                    if state < 0
                    else buckets.get(state, 0)
                )
            return min(total_weight, capacity // 2), feasible

        def signature(bits, optimistic=None):
            return tuple(
                (
                    bits[group_index]
                    if bits[group_index] >= 0
                    else int(bool(optimistic[group_index]))
                )
                for _rank, _edge_key, group_index in raw_signature_slots
            )

        def apply_fallback(*, commit):
            checkpoint = len(rollback_log)
            records = []
            for root in sorted({find(node) for node in range(len(nodes))}):
                if label[root] >= 0:
                    continue
                members = {
                    node for node in range(len(nodes)) if find(node) == root
                }
                states = set().union(*(evidence_by_node[node] for node in members))
                if not states or not min(states) <= 3 <= max(states):
                    rollback(checkpoint)
                    return None
                if not assign(root, 3):
                    raise RuntimeError("Fallback state contradicted rollback DSU")
                records.append(
                    {
                        "quotientComponents": sorted(nodes[node] for node in members),
                        "assignmentStates": sorted(states),
                    }
                )
            labels_snapshot = [label[find(node)] for node in range(len(nodes))]
            if not commit:
                rollback(checkpoint)
            return labels_snapshot, records

        best_active = -1
        best_signature = None
        best_bits = None

        def accept_leaf(active_weight):
            nonlocal best_active, best_signature, best_bits
            fallback = apply_fallback(commit=False)
            if fallback is None:
                cluster_audit["infeasibleLeafCount"] += 1
                cluster_audit["rejectedFallbackLeafCount"] += 1
                return False
            cluster_audit["feasibleLeafCount"] += 1
            candidate_signature = signature(decision_bits)
            if (
                best_bits is None
                or (active_weight, candidate_signature)
                > (best_active, best_signature)
            ):
                best_active = active_weight
                best_signature = candidate_signature
                best_bits = list(decision_bits)
            return True

        def greedy(offset, active_weight):
            cluster_audit["greedyVisitedNodeCount"] += 1
            if offset == len(search_groups):
                return accept_leaf(active_weight)
            group = search_groups[offset]
            checkpoint = len(rollback_log)
            if active_compatible(group):
                decision_bits[offset] = 1
                if (
                    assign(group["first"], group["firstLocal"])
                    and assign(group["second"], group["secondLocal"])
                    and greedy(
                        offset + 1,
                        active_weight + group["activeWeight"],
                    )
                ):
                    rollback(checkpoint)
                    decision_bits[offset] = -1
                    return True
                rollback(checkpoint)
            decision_bits[offset] = 0
            if union(group["first"], group["second"]) and greedy(
                offset + 1, active_weight
            ):
                rollback(checkpoint)
                decision_bits[offset] = -1
                return True
            rollback(checkpoint)
            decision_bits[offset] = -1
            return False

        if not greedy(0, 0):
            raise RuntimeError(
                "Central quotient constraint cluster is infeasible: "
                f"cluster={cluster_index} nodes={len(nodes)} "
                f"initialGroups={len(cluster_groups)} "
                f"postForcedGroups={len(search_groups)} "
                f"greedyVisited={cluster_audit['greedyVisitedNodeCount']} "
                f"feasibleLeaves={cluster_audit['feasibleLeafCount']} "
                f"infeasibleLeaves={cluster_audit['infeasibleLeafCount']} "
                "rejectedFallbackLeaves="
                f"{cluster_audit['rejectedFallbackLeafCount']}"
            )
        greedy_active = best_active

        def search(offset, active_weight):
            cluster_audit["visitedNodeCount"] += 1
            cluster_audit["maximumDepth"] = max(
                cluster_audit["maximumDepth"], offset
            )
            remaining_weight, feasible = optimistic_bound(offset)
            optimistic_signature = signature(decision_bits, feasible)
            if (
                active_weight + remaining_weight,
                optimistic_signature,
            ) <= (best_active, best_signature):
                cluster_audit["upperBoundPruneCount"] += 1
                return
            if offset == len(search_groups):
                accept_leaf(active_weight)
                return
            group = search_groups[offset]
            checkpoint = len(rollback_log)
            if active_compatible(group):
                decision_bits[offset] = 1
                if (
                    assign(group["first"], group["firstLocal"])
                    and assign(group["second"], group["secondLocal"])
                ):
                    search(
                        offset + 1,
                        active_weight + group["activeWeight"],
                    )
                else:
                    cluster_audit["infeasibleBranchCount"] += 1
                rollback(checkpoint)
            else:
                cluster_audit["infeasibleBranchCount"] += 1
            decision_bits[offset] = 0
            if union(group["first"], group["second"]):
                search(offset + 1, active_weight)
            else:
                cluster_audit["infeasibleBranchCount"] += 1
            rollback(checkpoint)
            decision_bits[offset] = -1

        search(0, 0)
        if best_bits is None:
            raise RuntimeError("Bounded solver lost its greedy incumbent")

        for group_index, group in enumerate(search_groups):
            decision = "active" if best_bits[group_index] else "inactive"
            for edge_key in group["edgeKeys"]:
                decisions[edge_key] = decision
            if decision == "active":
                if not assign(
                    group["first"], group["firstLocal"]
                ) or not assign(group["second"], group["secondLocal"]):
                    raise RuntimeError("Selected active relation failed replay")
            elif not union(group["first"], group["second"]):
                raise RuntimeError("Selected inactive relation failed replay")
        fallback = apply_fallback(commit=True)
        if fallback is None:
            raise RuntimeError("Selected solution failed fallback replay")
        _labels_snapshot, selected_fallbacks = fallback
        fallback_records.extend(selected_fallbacks)
        for node, component in enumerate(nodes):
            root = find(node)
            root_component = nodes[root]
            solved_parent[component] = root_component
            solved_labels[root_component] = label[root]

        cluster_audit.update(
            {
                "postForcedRelationGroupCount": len(search_groups),
                "postForcedOptionalRawEdgeCount": sum(
                    group["activeWeight"] for group in search_groups
                ),
                "fixedPointForcedInactiveRawEdgeCount": (
                    fixed_point_forced_weight
                ),
                "greedyIncumbentActiveEdgeCount": greedy_active,
                "optimalActiveEdgeCount": best_active,
                "selectedSignature": list(best_signature),
            }
        )
        for name in (
            "visitedNodeCount",
            "upperBoundPruneCount",
            "infeasibleBranchCount",
            "feasibleLeafCount",
            "infeasibleLeafCount",
            "rejectedFallbackLeafCount",
        ):
            audit[name] += cluster_audit[name]
        audit["maximumDepth"] = max(
            audit["maximumDepth"], cluster_audit["maximumDepth"]
        )
        audit["peakRollbackLogSize"] = max(
            audit["peakRollbackLogSize"],
            cluster_audit["peakRollbackLogSize"],
        )
        audit["optimalActiveEdgeCount"] += best_active
        audit["clusters"].append(cluster_audit)

    expected_edge_keys = {
        edge_key
        for group in relation_groups
        for edge_key in group["edgeKeys"]
    }
    if set(decisions) != expected_edge_keys:
        raise RuntimeError("Bounded solver did not decide every raw edge")
    raw_order = sorted(
        (
            rank_priority[group["edgeRanks"][edge_key]],
            edge_key,
        )
        for group in relation_groups
        for edge_key in group["edgeKeys"]
    )
    audit["optimalInactiveEdgeCount"] = sum(
        decision == "inactive" for decision in decisions.values()
    )
    audit["selectedSignature"] = [
        1 if decisions[edge_key] == "active" else 0
        for _rank, edge_key in raw_order
    ]
    audit["completeLeafCount"] = (
        audit["feasibleLeafCount"] + audit["infeasibleLeafCount"]
    )
    return {
        "decisions": decisions,
        "labels": {
            component: solved_labels[solved_parent[component]]
            for component in components
        },
        "parent": solved_parent,
        "fallbacks": fallback_records,
        "audit": audit,
    }
