"""Contract tests for async workflow execution and deterministic simulation."""

from __future__ import annotations

import asyncio
import json
import unittest
from dataclasses import replace
from pathlib import Path
from typing import Any

from vibebaton.graph_engine import (
    SCENARIOS,
    TRACE_KINDS,
    GraphExecutionEngine,
    GraphRunResult,
    GraphTraceEvent,
    MockSimulationHandlers,
    NodeExecutionResult,
    NodeHandler,
    run_graph,
    simulate_graph,
)
from vibebaton.graph_schema import EdgeSpec, NodeSpec, NodeType, WorkflowGraph, validate_graph


def _load_preset(preset_id: str) -> WorkflowGraph:
    preset = Path(__file__).resolve().parents[1] / "presets" / f"{preset_id}.baton.json"
    return WorkflowGraph.from_dict(json.loads(preset.read_text(encoding="utf-8")))


class FixedOutcomeHandler:
    def __init__(self, outcome: str) -> None:
        self.outcome = outcome

    async def handle(self, node: NodeSpec, context: dict[str, Any]) -> NodeExecutionResult:
        return NodeExecutionResult(self.outcome, {})


class TestGraphExecutionEngine(unittest.TestCase):
    def test_invalid_graph_lists_validation_errors(self) -> None:
        graph = WorkflowGraph("1.0", "invalid", "Invalid", [], [EdgeSpec("bad", "a", "b")])
        with self.assertRaises(ValueError) as raised:
            GraphExecutionEngine(graph, {})
        for error in validate_graph(graph).errors:
            self.assertIn(error, str(raised.exception))

    def test_exact_match_then_fallback_and_fifo_order(self) -> None:
        node_ids = ["left", "right", "wildcard", "fallback", "exact", "unused"]
        graph = WorkflowGraph(
            "1.0", "fork", "Two entries",
            [NodeSpec(node_id, NodeType.worker_node, node_id) for node_id in node_ids],
            [
                EdgeSpec("wild_left", "left", "wildcard", "*"),
                EdgeSpec("out_left", "left", "fallback"),
                EdgeSpec("exact_right", "right", "exact", "selected"),
                EdgeSpec("wild_right", "right", "unused", "*"),
                EdgeSpec("out_right", "right", "unused"),
            ],
        )
        result = run_graph(graph, {NodeType.worker_node: FixedOutcomeHandler("selected")})
        self.assertEqual(result.status, "completed")
        self.assertEqual(result.visited_nodes, node_ids[:-1])
        self.assertEqual(
            [(event.edge_id, event.outcome) for event in result.trace if event.kind == "edge_traversed"],
            [("wild_left", "selected"), ("out_left", "selected"), ("exact_right", "selected")],
        )

    def test_loop_limit_halts_two_node_cycle(self) -> None:
        graph = WorkflowGraph(
            "1.0", "cycle", "Bounded retry",
            [NodeSpec("worker", NodeType.worker_node, "Worker"), NodeSpec("gate", NodeType.gate_node, "Gate")],
            [
                EdgeSpec("test", "worker", "gate"),
                EdgeSpec("retry", "gate", "worker", "fail", "fix", max_loops=1),
            ],
        )
        handler = FixedOutcomeHandler("fail")
        result = run_graph(graph, {NodeType.worker_node: handler, NodeType.gate_node: handler})
        self.assertEqual(result.status, "halted")
        self.assertEqual(result.visited_nodes, ["worker", "gate", "worker", "gate"])
        self.assertEqual(result.trace[-1].kind, "graph_halted")
        self.assertEqual(
            [(event.edge_id, event.outcome) for event in result.trace if event.kind == "loop_limit_reached"],
            [("retry", "fail")],
        )
        self.assertLess(len(result.trace), 20)

    def test_limit_precedence_is_edge_then_source_then_target(self) -> None:
        for edge_limit, source_limit, target_limit, allowed in [(1, 2, 3, 1), (None, 2, 1, 2), (None, None, 1, 1)]:
            with self.subTest(edge=edge_limit, source=source_limit, target=target_limit):
                graph = WorkflowGraph(
                    "1.0", "limits", "Limit precedence",
                    [
                        NodeSpec("entry", NodeType.worker_node, "Entry"),
                        NodeSpec("source", NodeType.worker_node, "Source", config={"max_loops": source_limit}),
                        NodeSpec("target", NodeType.worker_node, "Target", config={"max_loops": target_limit}),
                    ],
                    [
                        EdgeSpec("start", "entry", "target"),
                        EdgeSpec("forward", "target", "source"),
                        EdgeSpec("retry", "source", "target", "fail", "fix", max_loops=edge_limit),
                    ],
                )
                result = run_graph(graph, {NodeType.worker_node: FixedOutcomeHandler("fail")})
                self.assertEqual(result.status, "halted")
                self.assertEqual(result.context["attempts"], {"entry": 1, "target": allowed + 1, "source": allowed + 1})
                self.assertEqual(result.trace[-2].kind, "loop_limit_reached")
                self.assertEqual(result.trace[-2].edge_id, "retry")

    def test_node_limit_inside_cycle_bounds_the_return_edge(self) -> None:
        graph = WorkflowGraph(
            "1.0", "cycle", "Bounded by a node inside the cycle",
            [
                NodeSpec("entry", NodeType.worker_node, "Entry"),
                NodeSpec("worker", NodeType.worker_node, "Worker"),
                NodeSpec("test", NodeType.worker_node, "Test", config={"max_loops": 1}),
                NodeSpec("review", NodeType.worker_node, "Review"),
            ],
            [
                EdgeSpec("start", "entry", "worker"),
                EdgeSpec("work", "worker", "test"),
                EdgeSpec("check", "test", "review"),
                EdgeSpec("retry", "review", "worker"),
            ],
        )
        result = run_graph(graph, {NodeType.worker_node: FixedOutcomeHandler("out")})
        self.assertEqual(result.status, "halted")
        self.assertEqual(result.visited_nodes, ["entry", "worker", "test", "review", "worker", "test", "review"])
        self.assertEqual([event.edge_id for event in result.trace if event.kind == "loop_limit_reached"], ["retry"])

    def test_solo_coder_can_use_both_retry_budgets(self) -> None:
        class AttemptOutcomeHandler:
            def __init__(self, outcomes: tuple[str, ...]) -> None:
                self.outcomes = outcomes

            async def handle(self, node: NodeSpec, context: dict[str, Any]) -> NodeExecutionResult:
                return NodeExecutionResult(self.outcomes[context["attempts"][node.id] - 1], {})

        cases = [
            (("fail", "fail", "pass"), ("pass",), ["e4", "e4"]),
            (("fail", "pass", "pass"), ("minor_fix", "pass"), ["e4", "e6"]),
            (("fail", "fail", "pass", "pass"), ("minor_fix", "pass"), ["e4", "e4", "e6"]),
        ]
        for legacy_node_limit in (False, True):
            graph = _load_preset("solo_coder_3tier")
            if legacy_node_limit:
                gate = next(node for node in graph.nodes if node.id == "gate")
                gate.config["max_loops"] = 2
            for gate_outcomes, review_outcomes, expected_retries in cases:
                with self.subTest(legacy_node_limit=legacy_node_limit, gate=gate_outcomes, review=review_outcomes):
                    handlers: dict[NodeType | str, NodeHandler] = {
                        NodeType.planner_node: FixedOutcomeHandler("out"),
                        NodeType.worker_node: FixedOutcomeHandler("out"),
                        NodeType.gate_node: AttemptOutcomeHandler(gate_outcomes),
                        NodeType.reviewer_node: AttemptOutcomeHandler(review_outcomes),
                        NodeType.merge_node: FixedOutcomeHandler("out"),
                        NodeType.human_gate_node: FixedOutcomeHandler("approve"),
                    }
                    result = run_graph(graph, handlers)
                    self.assertEqual(result.status, "completed", result.trace[-2:])
                    self.assertEqual(result.context["attempts"]["gate"], len(gate_outcomes))
                    self.assertEqual(result.context["attempts"]["review"], len(review_outcomes))
                    self.assertEqual(result.visited_nodes[-2:], ["merge", "human_final"])
                    retries = [
                        event.edge_id for event in result.trace
                        if event.kind == "edge_traversed" and event.outcome in ("fail", "minor_fix")
                    ]
                    self.assertEqual(retries, expected_retries)
                    self.assertNotIn("loop_limit_reached", [event.kind for event in result.trace])

    def test_loop_limit_leaves_other_visits_queued(self) -> None:
        graph = WorkflowGraph(
            "1.0", "branch", "Finish queued work",
            [NodeSpec("entry", NodeType.worker_node, "Entry"), NodeSpec("exit", NodeType.worker_node, "Exit")],
            [EdgeSpec("loop", "entry", "entry", max_loops=1), EdgeSpec("exit", "entry", "exit")],
        )
        result = run_graph(graph, {NodeType.worker_node: FixedOutcomeHandler("out")})
        self.assertEqual(result.status, "completed")
        self.assertEqual(result.visited_nodes, ["entry", "entry", "exit", "exit"])
        self.assertIn("loop_limit_reached", [event.kind for event in result.trace])
        self.assertEqual(result.trace[-1].kind, "graph_completed")

    def test_max_steps_halts_before_next_attempt(self) -> None:
        graph = WorkflowGraph(
            "1.0", "guard", "Step limit",
            [NodeSpec("worker", NodeType.worker_node, "Worker")],
            [EdgeSpec("loop", "worker", "worker", max_loops=10)],
        )
        engine = GraphExecutionEngine(graph, {NodeType.worker_node: FixedOutcomeHandler("out")}, max_steps=2)
        result = asyncio.run(engine.run())
        self.assertEqual(result.status, "halted")
        self.assertEqual(result.context["attempts"], {"worker": 2})
        self.assertEqual(result.trace[-1].kind, "graph_halted")
        self.assertIn("max_steps=2", result.trace[-1].message)

    def test_missing_or_raising_handler_fails_the_run(self) -> None:
        class RaisingHandler:
            async def handle(self, node: NodeSpec, context: dict[str, Any]) -> NodeExecutionResult:
                raise RuntimeError("handler error")

        graph = WorkflowGraph(
            "1.0", "failure", "Handler failure", [NodeSpec("worker", NodeType.worker_node, "Worker")], [],
        )
        cases: list[tuple[dict[NodeType | str, NodeHandler], str]] = [
            ({}, "No handler"),
            ({NodeType.worker_node: RaisingHandler()}, "RuntimeError: handler error"),
        ]
        for handlers, message in cases:
            with self.subTest(message=message):
                result = run_graph(graph, handlers)
                self.assertEqual(result.status, "failed")
                self.assertEqual([event.kind for event in result.trace], ["node_started", "node_failed"])
                self.assertEqual(result.trace[-1].node_id, "worker")
                self.assertIn(message, result.trace[-1].message)

    def test_node_id_handler_overrides_type_handler(self) -> None:
        class RequestHandler:
            async def handle(self, node: NodeSpec, context: dict[str, Any]) -> NodeExecutionResult:
                return NodeExecutionResult("custom", {"request": context["request"]}, "Used node ID handler")

        graph = WorkflowGraph(
            "1.0", "override", "Node ID handler",
            [NodeSpec(node_id, NodeType.worker_node, node_id) for node_id in ("entry", "chosen", "unused")],
            [EdgeSpec("custom", "entry", "chosen", "custom"), EdgeSpec("default", "entry", "unused")],
        )
        initial_context = {"request": "run unit tests"}
        handlers: dict[NodeType | str, NodeHandler] = {
            NodeType.worker_node: FixedOutcomeHandler("out"),
            "entry": RequestHandler(),
        }
        result = run_graph(graph, handlers, initial_context)
        self.assertEqual(result.status, "completed")
        self.assertEqual(result.visited_nodes, ["entry", "chosen"])
        self.assertEqual(result.context["outputs"]["entry"], initial_context)
        self.assertEqual(initial_context, {"request": "run unit tests"})
        self.assertEqual(result.trace[1].message, "Used node ID handler")

    def test_trace_and_run_serialize_with_constrained_values(self) -> None:
        event = GraphTraceEvent(1, 1.0, "graph_completed", None, None, None, "")
        expected = {
            "seq": 1, "timestamp": 1.0, "kind": "graph_completed",
            "node_id": None, "edge_id": None, "outcome": None, "message": "",
        }
        self.assertIsInstance(TRACE_KINDS, frozenset)
        self.assertEqual(event.to_dict(), expected)
        result = GraphRunResult("completed", ["node"], [event], {"attempts": {"node": 1}})
        self.assertEqual(
            json.loads(json.dumps(result.to_dict())),
            {"status": "completed", "visited_nodes": ["node"], "trace": [expected], "context": result.context},
        )
        with self.assertRaises(ValueError):
            replace(event, kind="unknown")
        with self.assertRaises(ValueError):
            replace(result, status="unknown")


class TestGraphSimulation(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.flagship = _load_preset("flagship_4tier")

    def test_happy_path_visits_every_flagship_node(self) -> None:
        result = simulate_graph(self.flagship)
        self.assertEqual(result.status, "completed")
        self.assertCountEqual(result.visited_nodes, [node.id for node in self.flagship.nodes])
        for predecessor in ("l2_review", "l2_specialist"):
            self.assertLess(result.visited_nodes.index(predecessor), result.visited_nodes.index("git_merge"))
        self.assertEqual(result.visited_nodes[-3:], ["git_merge", "l1_milestone_review", "l0_final_gate"])
        self.assertEqual(result.trace[-1].kind, "graph_completed")
        self.assertEqual([event.seq for event in result.trace], list(range(1, len(result.trace) + 1)))
        router_outcomes = [
            event.outcome for event in result.trace
            if event.kind == "edge_traversed" and event.node_id == "router_tier"
        ]
        self.assertEqual(router_outcomes, ["routine", "critical"])

    def test_happy_path_merge_uses_only_queued_branches(self) -> None:
        edges = [
            replace(edge, source_handle="alternate")
            if edge.source == "router_tier" and edge.source_handle == "critical" else edge
            for edge in self.flagship.edges
        ]
        graph = replace(self.flagship, edges=edges)
        result = simulate_graph(graph)
        self.assertEqual(result.status, "completed")
        self.assertCountEqual(result.visited_nodes, [node.id for node in graph.nodes if node.id != "l2_specialist"])

    def test_mock_router_prefers_routine_in_the_generic_engine(self) -> None:
        handlers = MockSimulationHandlers("happy_path").for_graph(self.flagship)
        result = run_graph(self.flagship, handlers)
        self.assertEqual(result.status, "completed")
        self.assertIn("l3_bulk", result.visited_nodes)
        self.assertNotIn("l2_specialist", result.visited_nodes)

    def test_gate_retry_traverses_exactly_one_fail_edge(self) -> None:
        result = simulate_graph(self.flagship, "gate_retry")
        self.assertEqual(result.status, "completed")
        fails = [event for event in result.trace if event.kind == "edge_traversed" and event.outcome == "fail"]
        self.assertEqual(len(fails), 1)
        self.assertEqual(fails[0].node_id, "gate_unit")
        self.assertEqual(result.context["attempts"]["gate_unit"], 2)

    def test_escalate_visits_specialist_then_final_review(self) -> None:
        result = simulate_graph(self.flagship, "escalate")
        self.assertEqual(result.status, "completed")
        escalation = next(
            event for event in result.trace if event.kind == "edge_traversed" and event.outcome == "escalate"
        )
        self.assertEqual(escalation.node_id, "l2_review")
        self.assertEqual(
            [event.node_id for event in result.trace if event.kind == "node_started" and event.seq > escalation.seq],
            ["l2_specialist", "git_merge", "l1_milestone_review", "l0_final_gate"],
        )

    def test_escalate_uses_minor_fix_when_that_is_the_available_retry(self) -> None:
        edges = [edge for edge in self.flagship.edges if edge.source_handle != "escalate"]
        graph = replace(self.flagship, edges=edges)
        result = simulate_graph(graph, "escalate")
        self.assertEqual(result.status, "completed")
        outcomes = [
            event.outcome for event in result.trace
            if event.kind == "node_completed" and event.node_id == "l2_review"
        ]
        self.assertEqual(outcomes, ["minor_fix", "pass"])

    def test_unknown_scenario_raises_value_error(self) -> None:
        with self.assertRaisesRegex(ValueError, "Unknown simulation scenario 'unsupported'"):
            simulate_graph(self.flagship, "unsupported")

    def test_consecutive_simulations_match(self) -> None:
        for scenario in SCENARIOS:
            with self.subTest(scenario=scenario):
                first = simulate_graph(self.flagship, scenario)
                second = simulate_graph(self.flagship, scenario)
                self.assertEqual(
                    [(event.kind, event.node_id, event.edge_id, event.outcome) for event in first.trace],
                    [(event.kind, event.node_id, event.edge_id, event.outcome) for event in second.trace],
                )


if __name__ == "__main__":
    unittest.main()
