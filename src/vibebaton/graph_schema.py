"""Typed contracts and validation for .baton.json workflows.

A workflow requires schema_version, id, name, nodes and edges. Each node
requires id, type and label. Each edge requires id, source and target, with
endpoints given by node IDs and handles defaulting to "out" and "in".
A graph can include category, required_providers, cost_tier and inspired_by
metadata.
WorkflowGraph.from_dict also accepts source_handle, target_handle and maxLoops.
WorkflowGraph.to_dict writes sourceHandle, targetHandle and max_loops and omits
optional fields whose value is None.

validate_graph starts with nodes that have no incoming edges and follows all
edges for reachability. For an unreached cycle, a node can seed the cycle if
all its incoming edges are marked feedback and come from within the cycle.
The markers are max_loops, targetHandle "fix", and sourceHandle "fail",
"minor_fix" or "retry". Every cycle must include an edge with max_loops of
at least one or a node with that limit in its config.

This example starts at a worker and allows two retries from the gate.
The complete four-tier example is in presets/flagship_4tier.baton.json.

    {
      "schema_version": "1.0",
      "id": "gate_retry",
      "name": "Worker with a bounded gate retry",
      "nodes": [
        {"id": "worker", "type": "worker_node", "label": "Worker"},
        {"id": "gate", "type": "gate_node", "label": "Test gate"}
      ],
      "edges": [
        {"id": "test", "source": "worker", "target": "gate"},
        {
          "id": "retry", "source": "gate", "sourceHandle": "fail",
          "target": "worker", "targetHandle": "fix", "max_loops": 2
        }
      ]
    }
"""

from __future__ import annotations

from collections.abc import Iterable, Iterator
from dataclasses import asdict, dataclass, field
from enum import Enum
from typing import Any


class NodeType(str, Enum):
    planner_node = "planner_node"
    router_node = "router_node"
    worker_node = "worker_node"
    gate_node = "gate_node"
    reviewer_node = "reviewer_node"
    merge_node = "merge_node"
    human_gate_node = "human_gate_node"


class SchemaValidationError(ValueError):
    """Raised when a workflow document violates the schema."""


@dataclass
class NodeSpec:
    id: str
    type: NodeType
    label: str
    role: str | None = None
    position: dict[str, float] | None = None
    config: dict[str, Any] = field(default_factory=dict)


@dataclass
class EdgeSpec:
    id: str
    source: str
    target: str
    source_handle: str = "out"
    target_handle: str = "in"
    max_loops: int | None = None
    condition: str | None = None


@dataclass
class WorkflowGraph:
    schema_version: str
    id: str
    name: str
    nodes: list[NodeSpec]
    edges: list[EdgeSpec]
    difficulty: str = "pro"
    description: str = ""
    recommended_for: list[str] = field(default_factory=list)
    category: str | None = None
    required_providers: list[str] | None = None
    cost_tier: str | None = None
    inspired_by: str | None = None

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> WorkflowGraph:
        _require_fields(data, "Workflow graph", schema_version=str, id=str, name=str, nodes=list, edges=list)
        for field_name in ("category", "cost_tier", "inspired_by"):
            value = data.get(field_name)
            if value is not None and not isinstance(value, str):
                raise SchemaValidationError(f"Workflow graph.{field_name} must be a string")
        required_providers = data.get("required_providers")
        if required_providers is not None and (
            not isinstance(required_providers, list)
            or any(not isinstance(provider, str) for provider in required_providers)
        ):
            raise SchemaValidationError("Workflow graph.required_providers must be a list of strings")

        return cls(
            schema_version=data["schema_version"],
            id=data["id"],
            name=data["name"],
            nodes=[_parse_node(node, index) for index, node in enumerate(data["nodes"])],
            edges=[_parse_edge(edge, index) for index, edge in enumerate(data["edges"])],
            difficulty=data.get("difficulty", "pro"),
            description=data.get("description", ""),
            recommended_for=data.get("recommended_for", []),
            category=data.get("category"),
            required_providers=required_providers,
            cost_tier=data.get("cost_tier"),
            inspired_by=data.get("inspired_by"),
        )

    def to_dict(self) -> dict[str, Any]:
        data = asdict(self)
        for node in data["nodes"]:
            node["type"] = node["type"].value
        for edge in data["edges"]:
            edge["sourceHandle"] = edge.pop("source_handle")
            edge["targetHandle"] = edge.pop("target_handle")
        for section in ("nodes", "edges"):
            data[section] = [_omit_none(item) for item in data[section]]
        return _omit_none(data)


@dataclass
class GraphValidationResult:
    valid: bool
    errors: list[str]
    warnings: list[str]
    entry_nodes: list[str]
    has_cycles: bool


def _require_fields(data: dict[str, Any], path: str, **field_types: type) -> None:
    if not isinstance(data, dict):
        raise SchemaValidationError(f"{path} must be a JSON object")
    for name, expected_type in field_types.items():
        if name not in data:
            raise SchemaValidationError(f"{path} is missing required field {name!r}")
        if not isinstance(data[name], expected_type):
            raise SchemaValidationError(f"{path}.{name} must have type {expected_type.__name__}")


def _parse_node(data: dict[str, Any], index: int) -> NodeSpec:
    path = f"nodes[{index}]"
    _require_fields(data, path, id=str, type=str, label=str)
    try:
        node_type = NodeType(data["type"])
    except ValueError as exc:
        raise SchemaValidationError(f"Unknown node type {data['type']!r} at {path}.type") from exc

    config = data.get("config", {})
    if not isinstance(config, dict):
        raise SchemaValidationError(f"{path}.config must be a JSON object")
    return NodeSpec(
        id=data["id"],
        type=node_type,
        label=data["label"],
        role=data.get("role"),
        position=data.get("position"),
        config=config,
    )


def _parse_edge(data: dict[str, Any], index: int) -> EdgeSpec:
    path = f"edges[{index}]"
    _require_fields(data, path, id=str, source=str, target=str)
    source_handle = data.get("sourceHandle", data.get("source_handle", "out"))
    target_handle = data.get("targetHandle", data.get("target_handle", "in"))
    max_loops = data.get("max_loops", data.get("maxLoops"))
    if not isinstance(source_handle, str) or not isinstance(target_handle, str):
        raise SchemaValidationError(f"{path} handles must be strings")
    if max_loops is not None and not isinstance(max_loops, int):
        raise SchemaValidationError(f"{path}.max_loops must be an integer")
    return EdgeSpec(
        id=data["id"],
        source=data["source"],
        target=data["target"],
        source_handle=source_handle,
        target_handle=target_handle,
        max_loops=max_loops,
        condition=data.get("condition"),
    )


def _omit_none(data: dict[str, Any]) -> dict[str, Any]:
    return {name: value for name, value in data.items() if value is not None}


def _reachable_nodes(adjacency: dict[str, list[str]], starts: Iterable[str]) -> set[str]:
    pending = list(starts)
    reachable = set(pending)
    while pending:
        for target in adjacency[pending.pop()]:
            if target not in reachable:
                reachable.add(target)
                pending.append(target)
    return reachable


def _cycle_paths(outgoing: dict[str, list[str]]) -> Iterator[list[str]]:
    """Yield a cycle for each back edge encountered by depth-first search."""
    finished: set[str] = set()
    for root in outgoing:
        if root in finished:
            continue
        stack = [(root, iter(outgoing[root]))]
        active = {root: 0}
        while stack:
            node_id, neighbors = stack[-1]
            target = next(neighbors, None)
            if target is None:
                finished.add(node_id)
                del active[node_id]
                stack.pop()
            elif target in active:
                cycle = [ancestor for ancestor, _ in stack[active[target]:]]
                yield [*cycle, target]
            elif target not in finished:
                active[target] = len(stack)
                stack.append((target, iter(outgoing[target])))


def validate_graph(graph: WorkflowGraph) -> GraphValidationResult:
    """Check graph structure, reachability, and cycle limits."""
    errors: list[str] = []
    if not graph.nodes:
        errors.append("Workflow graph must contain at least one node")

    nodes: dict[str, NodeSpec] = {}
    for node in graph.nodes:
        if node.id in nodes:
            errors.append(f"Duplicate node id {node.id!r}")
        nodes[node.id] = node

    bounded_nodes: set[str] = set()
    for node in nodes.values():
        limit = node.config.get("max_loops", 0)
        if isinstance(limit, (int, float)) and limit >= 1:
            bounded_nodes.add(node.id)

    outgoing: dict[str, list[str]] = {node_id: [] for node_id in nodes}
    unbounded_outgoing: dict[str, list[str]] = {node_id: [] for node_id in nodes}
    incoming: dict[str, list[EdgeSpec]] = {node_id: [] for node_id in nodes}
    edge_ids: set[str] = set()
    for edge in graph.edges:
        if edge.id in edge_ids:
            errors.append(f"Duplicate edge id {edge.id!r}")
        edge_ids.add(edge.id)

        source_exists = edge.source in nodes
        target_exists = edge.target in nodes
        if not source_exists:
            errors.append(f"Edge {edge.id!r} has dangling source {edge.source!r}")
        if not target_exists:
            errors.append(f"Edge {edge.id!r} has dangling target {edge.target!r}")
        if not source_exists or not target_exists:
            continue

        outgoing[edge.source].append(edge.target)
        incoming[edge.target].append(edge)

        # An unbounded cycle survives the removal of every bounded edge and
        # every edge incident to a bounded node.
        edge_is_bounded = edge.max_loops is not None and edge.max_loops >= 1
        if not (edge_is_bounded or edge.source in bounded_nodes or edge.target in bounded_nodes):
            unbounded_outgoing[edge.source].append(edge.target)

    entries = {node_id for node_id, edges in incoming.items() if not edges}
    reachable = _reachable_nodes(outgoing, entries)
    for node_id, edges in incoming.items():
        if node_id in reachable or any(
            edge.max_loops is None
            and edge.target_handle != "fix"
            and edge.source_handle not in {"fail", "minor_fix", "retry"}
            for edge in edges
        ):
            continue
        # A marked incoming edge can seed an unreached cycle if it returns
        # from a node reachable from this entry candidate.
        downstream = _reachable_nodes(outgoing, [node_id])
        if all(edge.source in downstream for edge in edges):
            entries.add(node_id)
            reachable.update(downstream)

    entry_nodes = [node_id for node_id in nodes if node_id in entries]
    if not entry_nodes:
        errors.append("Workflow graph has no entry nodes")

    warnings = [f"Unreachable node {node_id!r}" for node_id in nodes if node_id not in reachable]

    has_cycles = next(_cycle_paths(outgoing), None) is not None
    if has_cycles:
        for cycle in _cycle_paths(unbounded_outgoing):
            errors.append(f"Unbounded cycle without max_loops >= 1: {' -> '.join(cycle)}")

    return GraphValidationResult(
        valid=not errors,
        errors=errors,
        warnings=warnings,
        entry_nodes=entry_nodes,
        has_cycles=has_cycles,
    )
