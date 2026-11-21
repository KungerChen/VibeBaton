"""Run a workflow graph with asynchronous node handlers and a sequential trace.

The engine visits entries and matching edges in FIFO order. Explicit edge
limits count every traversal. An edge that returns to a node on its current
path can inherit a limit from the source, target, or another node in that
cycle, in that order. Inherited limits count returns on that edge. The
context holds per-run ``attempts`` and the latest payload in ``outputs[node_id]``.

This workflow retries the worker once before the gate passes.

    >>> from vibebaton.graph_engine import simulate_graph
    >>> from vibebaton.graph_schema import EdgeSpec, NodeSpec, NodeType, WorkflowGraph
    >>> graph = WorkflowGraph(
    ...     schema_version="1.0",
    ...     id="gate_retry",
    ...     name="Worker and test gate",
    ...     nodes=[
    ...         NodeSpec("worker", NodeType.worker_node, "Worker"),
    ...         NodeSpec("gate", NodeType.gate_node, "Test gate"),
    ...         NodeSpec("approval", NodeType.human_gate_node, "Approval"),
    ...     ],
    ...     edges=[
    ...         EdgeSpec("test", "worker", "gate"),
    ...         EdgeSpec("retry", "gate", "worker", "fail", "fix", max_loops=2),
    ...         EdgeSpec("passed", "gate", "approval", "pass"),
    ...     ],
    ... )
    >>> result = simulate_graph(graph, "gate_retry")
    >>> result.status, result.visited_nodes
    ('completed', ['worker', 'gate', 'worker', 'gate', 'approval'])
    >>> result.context["attempts"]["gate"]
    2
"""

import asyncio
from collections import deque
from dataclasses import asdict, dataclass
from time import time
from typing import Any, Literal, Protocol, get_args

from vibebaton.graph_schema import (
    EdgeSpec,
    NodeSpec,
    NodeType,
    WorkflowGraph,
    _reachable_nodes,
    validate_graph,
)


TraceKind = Literal[
    "node_started",
    "node_completed",
    "node_failed",
    "edge_traversed",
    "loop_limit_reached",
    "graph_completed",
    "graph_halted",
]
GraphRunStatus = Literal["completed", "halted", "failed"]
TRACE_KINDS: frozenset[TraceKind] = frozenset(get_args(TraceKind))
SCENARIOS = ("happy_path", "gate_retry", "escalate")
_Visit = tuple[str, tuple[str, ...]]


@dataclass
class NodeExecutionResult:
    outcome: str
    payload: dict[str, Any]
    message: str = ""


@dataclass
class GraphTraceEvent:
    seq: int
    timestamp: float
    kind: TraceKind
    node_id: str | None
    edge_id: str | None
    outcome: str | None
    message: str

    def __post_init__(self) -> None:
        if self.kind not in TRACE_KINDS:
            raise ValueError(f"Unknown graph trace kind {self.kind!r}")

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class GraphRunResult:
    status: GraphRunStatus
    visited_nodes: list[str]
    trace: list[GraphTraceEvent]
    context: dict[str, Any]

    def __post_init__(self) -> None:
        if self.status not in get_args(GraphRunStatus):
            raise ValueError(f"Unknown graph run status {self.status!r}")

    def to_dict(self) -> dict[str, Any]:
        return {
            "status": self.status,
            "visited_nodes": self.visited_nodes.copy(),
            "trace": [event.to_dict() for event in self.trace],
            "context": self.context.copy(),
        }


class NodeHandler(Protocol):
    async def handle(self, node: NodeSpec, context: dict[str, Any]) -> NodeExecutionResult:
        """Execute one attempt and return an outcome and payload.

        An unmatched outcome falls through to edges with an "out" or "*" handle.
        """
        ...


def _outgoing_edges(graph: WorkflowGraph) -> dict[str, list[EdgeSpec]]:
    outgoing: dict[str, list[EdgeSpec]] = {}
    for edge in graph.edges:
        outgoing.setdefault(edge.source, []).append(edge)
    return outgoing


class GraphExecutionEngine:
    """Validate a graph and execute each queued attempt in FIFO order."""

    def __init__(
        self,
        graph: WorkflowGraph,
        handlers: dict[NodeType | str, NodeHandler],
        max_steps: int = 500,
    ) -> None:
        validation = validate_graph(graph)
        if not validation.valid:
            raise ValueError("Invalid workflow graph:\n" + "\n".join(validation.errors))

        self._entries = validation.entry_nodes
        self._nodes = {node.id: node for node in graph.nodes}
        self._outgoing = _outgoing_edges(graph)
        self._handlers = handlers.copy()
        self._max_steps = max_steps

    def _routes(self, node: NodeSpec, outcome: str) -> list[tuple[EdgeSpec, str]]:
        edges = self._outgoing.get(node.id, [])
        matches = [edge for edge in edges if edge.source_handle == outcome]
        if not matches:
            matches = [edge for edge in edges if edge.source_handle in ("out", "*")]
        return [(edge, outcome) for edge in matches]

    def _loop_limit(self, edge: EdgeSpec, cycle: tuple[str, ...]) -> int | float | None:
        if edge.max_loops is not None or not cycle:
            return edge.max_loops
        for node_id in (edge.source, *cycle[:-1]):
            limit = self._nodes[node_id].config.get("max_loops")
            if isinstance(limit, (int, float)):
                return limit
        return None

    def _next_visit(self, pending: deque[_Visit]) -> _Visit:
        return pending.popleft()

    async def run(self, initial_context: dict[str, Any] | None = None) -> GraphRunResult:
        """Run with a shallow copy of initial_context and fresh attempts and outputs."""
        attempts: dict[str, int] = {}
        outputs: dict[str, dict[str, Any]] = {}
        context = {**(initial_context or {}), "attempts": attempts, "outputs": outputs}
        trace: list[GraphTraceEvent] = []
        visited_nodes: list[str] = []
        traversals: dict[str, int] = {}
        pending: deque[_Visit] = deque((node_id, ()) for node_id in self._entries)

        def emit(
            kind: TraceKind,
            node_id: str | None = None,
            edge_id: str | None = None,
            outcome: str | None = None,
            message: str = "",
        ) -> None:
            trace.append(GraphTraceEvent(len(trace) + 1, time(), kind, node_id, edge_id, outcome, message))

        while pending:
            if len(visited_nodes) >= self._max_steps:
                emit("graph_halted", message=f"Reached max_steps={self._max_steps}")
                return GraphRunResult("halted", visited_nodes, trace, context)

            node_id, ancestors = self._next_visit(pending)
            path = (*ancestors, node_id)
            node = self._nodes[node_id]
            attempts[node_id] = attempts.get(node_id, 0) + 1
            visited_nodes.append(node_id)
            emit("node_started", node_id)

            handler = self._handlers.get(node_id, self._handlers.get(node.type))
            if handler is None:
                emit("node_failed", node_id, message=f"No handler for node {node_id!r} ({node.type})")
                return GraphRunResult("failed", visited_nodes, trace, context)
            try:
                result = await handler.handle(node, context)
            except Exception as exc:
                emit("node_failed", node_id, message=f"{type(exc).__name__}: {exc}")
                return GraphRunResult("failed", visited_nodes, trace, context)

            outputs[node_id] = result.payload
            emit("node_completed", node_id, outcome=result.outcome, message=result.message)
            limit_reached = False
            for edge, outcome in self._routes(node, result.outcome):
                cycle_start = path.index(edge.target) if edge.target in path else len(path)
                limit = self._loop_limit(edge, path[cycle_start:])
                if limit is not None:
                    count = traversals.get(edge.id, 0) + 1
                    if count > limit:
                        emit("loop_limit_reached", node_id, edge.id, outcome, f"Traversal limit {limit} reached")
                        limit_reached = True
                        continue
                    traversals[edge.id] = count
                emit("edge_traversed", node_id, edge.id, outcome)
                # Restart the path at the target of a return edge so the next
                # visit counts subsequent forward edges as a fresh pass.
                pending.append((edge.target, path[:cycle_start]))

            if limit_reached and not pending:
                emit("graph_halted", message="No queued nodes remain after reaching a loop limit")
                return GraphRunResult("halted", visited_nodes, trace, context)

        emit("graph_completed")
        return GraphRunResult("completed", visited_nodes, trace, context)


def run_graph(
    graph: WorkflowGraph,
    handlers: dict[NodeType | str, NodeHandler],
    initial_context: dict[str, Any] | None = None,
) -> GraphRunResult:
    """Execute a graph from a synchronous caller."""
    return asyncio.run(GraphExecutionEngine(graph, handlers).run(initial_context))


_MOCK_OUTCOMES = {
    NodeType.planner_node: ("out",),
    NodeType.router_node: ("routine", "critical", "out"),
    NodeType.worker_node: ("out",),
    NodeType.gate_node: ("pass", "out"),
    NodeType.reviewer_node: ("pass", "out"),
    NodeType.merge_node: ("out",),
    NodeType.human_gate_node: ("approve", "out"),
}


@dataclass
class _MockNodeHandler:
    scenario: str
    preferred_outcomes: tuple[str, ...]
    handles: dict[str, list[str]]

    async def handle(self, node: NodeSpec, context: dict[str, Any]) -> NodeExecutionResult:
        handles = self.handles.get(node.id, [])
        preferences = self.preferred_outcomes
        if context["attempts"][node.id] == 1:
            if node.type == NodeType.gate_node and self.scenario == "gate_retry":
                preferences = ("fail", *preferences)
            elif node.type == NodeType.reviewer_node and self.scenario == "escalate" and handles:
                preferences = ("escalate", "minor_fix", *preferences)

        fallback = handles[0] if handles else preferences[0]
        outcome = next((candidate for candidate in preferences if candidate in handles), fallback)
        return NodeExecutionResult(outcome, {})


class MockSimulationHandlers:
    """Build a mock handler per node type using the graph's declared handles."""

    def __init__(self, scenario: str) -> None:
        if scenario not in SCENARIOS:
            raise ValueError(f"Unknown simulation scenario {scenario!r}. Choose from {', '.join(SCENARIOS)}.")
        self._scenario = scenario

    def for_graph(self, graph: WorkflowGraph) -> dict[NodeType | str, NodeHandler]:
        handles = {
            node_id: [edge.source_handle for edge in edges]
            for node_id, edges in _outgoing_edges(graph).items()
        }
        return {
            node_type: _MockNodeHandler(self._scenario, preferences, handles)
            for node_type, preferences in _MOCK_OUTCOMES.items()
        }


class _HappyPathSimulationEngine(GraphExecutionEngine):
    def __init__(self, graph: WorkflowGraph, handlers: dict[NodeType | str, NodeHandler]) -> None:
        super().__init__(graph, handlers)
        incoming: dict[str, list[str]] = {node_id: [] for node_id in self._nodes}
        for edge in graph.edges:
            incoming[edge.target].append(edge.source)
        self._merge_ancestors: dict[str, set[str]] = {}
        for node in graph.nodes:
            if node.type != NodeType.merge_node or len(incoming[node.id]) < 2:
                continue
            ancestors = _reachable_nodes(incoming, incoming[node.id])
            if node.id not in ancestors:
                self._merge_ancestors[node.id] = ancestors

    def _next_visit(self, pending: deque[_Visit]) -> _Visit:
        while True:
            visit = pending.popleft()
            node_id, _ = visit
            ancestors = self._merge_ancestors.get(node_id)
            if ancestors is None:
                return visit
            if any(other_id in ancestors for other_id, _ in pending):
                pending.append(visit)
                continue
            remaining = [queued for queued in pending if queued[0] != node_id]
            pending.clear()
            pending.extend(remaining)
            return visit

    def _routes(self, node: NodeSpec, outcome: str) -> list[tuple[EdgeSpec, str]]:
        routes = super()._routes(node, outcome)
        if node.type == NodeType.router_node and outcome == "routine":
            routes.extend(
                (edge, "critical")
                for edge in self._outgoing.get(node.id, [])
                if edge.source_handle == "critical"
            )
        return routes


def simulate_graph(graph: WorkflowGraph, scenario: str = "happy_path") -> GraphRunResult:
    """Simulate with mock handlers.

    The happy path previews routine and critical routes when both are
    available. For a merge outside a cycle, queued upstream work finishes
    before pending arrivals are combined into one merge visit.
    """
    handlers = MockSimulationHandlers(scenario).for_graph(graph)
    engine_type = _HappyPathSimulationEngine if scenario == "happy_path" else GraphExecutionEngine
    return asyncio.run(engine_type(graph, handlers).run())
