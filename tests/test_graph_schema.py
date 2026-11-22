"""Contract tests for .baton.json parsing and graph validation."""

from __future__ import annotations

import json
import unittest
from pathlib import Path
from typing import Any

from vibebaton.graph_schema import (
    EdgeSpec,
    GraphValidationResult,
    NodeSpec,
    NodeType,
    SchemaValidationError,
    WorkflowGraph,
    validate_graph,
)


def _graph_payload() -> dict[str, Any]:
    return {
        "schema_version": "1.0",
        "id": "test_graph",
        "name": "Test graph",
        "nodes": [
            {"id": "A", "type": "worker_node", "label": "Worker"},
            {"id": "B", "type": "gate_node", "label": "Gate"},
        ],
        "edges": [{"id": "ab", "source": "A", "target": "B"}],
    }


class TestWorkflowGraph(unittest.TestCase):
    def test_all_seven_node_types_parse(self) -> None:
        values = [
            "planner_node",
            "router_node",
            "worker_node",
            "gate_node",
            "reviewer_node",
            "merge_node",
            "human_gate_node",
        ]
        self.assertCountEqual([member.value for member in NodeType], values)
        self.assertEqual(len(NodeType.__members__), 7)

        data = _graph_payload()
        data["nodes"] = [{"id": value, "type": value, "label": value} for value in values]
        data["edges"] = []
        graph = WorkflowGraph.from_dict(data)
        for node, value in zip(graph.nodes, values, strict=True):
            self.assertIs(node.type, NodeType(value))

    def test_round_trip_reads_both_edge_key_styles(self) -> None:
        canonical = {
            "id": "ba",
            "source": "B",
            "target": "A",
            "sourceHandle": "fail",
            "targetHandle": "fix",
            "max_loops": 2,
            "condition": "tests failed",
        }
        key_styles = [
            {"sourceHandle": "fail", "targetHandle": "fix", "maxLoops": 2},
            {"source_handle": "fail", "target_handle": "fix", "max_loops": 2},
        ]
        for edge_keys in key_styles:
            with self.subTest(edge_keys=edge_keys):
                data = _graph_payload()
                data["edges"].append(
                    {"id": "ba", "source": "B", "target": "A", "condition": "tests failed", **edge_keys}
                )
                graph = WorkflowGraph.from_dict(data)
                self.assertEqual(
                    graph.edges[1],
                    EdgeSpec("ba", "B", "A", "fail", "fix", 2, "tests failed"),
                )
                serialized = graph.to_dict()
                self.assertEqual(serialized["edges"][1], canonical)
                self.assertEqual(WorkflowGraph.from_dict(serialized).to_dict(), serialized)

    def test_metadata_round_trips(self) -> None:
        metadata = {
            "category": "general",
            "required_providers": ["codex_sub", "claude_sub"],
            "cost_tier": "high",
            "inspired_by": "solo_coder_3tier",
        }
        graph = WorkflowGraph.from_dict({**_graph_payload(), **metadata})
        self.assertEqual(graph.category, "general")
        self.assertEqual(graph.required_providers, ["codex_sub", "claude_sub"])
        self.assertEqual(graph.cost_tier, "high")
        self.assertEqual(graph.inspired_by, "solo_coder_3tier")
        serialized = graph.to_dict()
        self.assertEqual({key: serialized[key] for key in metadata}, metadata)
        self.assertEqual(WorkflowGraph.from_dict(serialized), graph)

    def test_metadata_validates_field_types(self) -> None:
        for field, value in (
            ("category", 1),
            ("required_providers", "claude_sub"),
            ("required_providers", ["claude_sub", 1]),
            ("cost_tier", True),
            ("inspired_by", {}),
        ):
            with self.subTest(field=field, value=value):
                with self.assertRaisesRegex(SchemaValidationError, field):
                    WorkflowGraph.from_dict({**_graph_payload(), field: value})

    def test_defaults_and_none_fields_preserve_legacy_serialization(self) -> None:
        data = _graph_payload()
        data["nodes"][0].update(role=None, position=None, config={"note": None})
        data["edges"][0].update(maxLoops=None, condition=None)
        expected = {
            **data,
            "nodes": [
                {"id": "A", "type": "worker_node", "label": "Worker", "config": {"note": None}},
                {"id": "B", "type": "gate_node", "label": "Gate", "config": {}},
            ],
            "edges": [
                {"id": "ab", "source": "A", "target": "B", "sourceHandle": "out", "targetHandle": "in"},
            ],
            "difficulty": "pro",
            "description": "",
            "recommended_for": [],
        }
        null_metadata = dict.fromkeys(("category", "required_providers", "cost_tier", "inspired_by"))
        for metadata in ({}, null_metadata):
            with self.subTest(metadata=metadata):
                serialized = WorkflowGraph.from_dict({**data, **metadata}).to_dict()
                self.assertEqual(json.dumps(serialized), json.dumps(expected))
                self.assertIs(type(serialized["nodes"][0]["type"]), str)

    def test_missing_required_fields(self) -> None:
        required_fields = {
            "graph": ("schema_version", "id", "name", "nodes", "edges"),
            "nodes": ("id", "type", "label"),
            "edges": ("id", "source", "target"),
        }
        for section, fields in required_fields.items():
            for field in fields:
                with self.subTest(section=section, field=field):
                    data = _graph_payload()
                    record = data if section == "graph" else data[section][0]
                    del record[field]
                    with self.assertRaisesRegex(SchemaValidationError, f"missing required field '{field}'"):
                        WorkflowGraph.from_dict(data)

    def test_unknown_node_type(self) -> None:
        data = _graph_payload()
        data["nodes"][0]["type"] = "unknown_node"
        with self.assertRaisesRegex(SchemaValidationError, "Unknown node type 'unknown_node'"):
            WorkflowGraph.from_dict(data)

    def test_existing_presets_are_valid(self) -> None:
        presets_dir = Path(__file__).resolve().parents[1] / "presets"
        for preset in ("flagship_4tier", "starter_2tier", "solo_coder_3tier"):
            with self.subTest(preset=preset):
                path = presets_dir / f"{preset}.baton.json"
                graph = WorkflowGraph.from_dict(json.loads(path.read_text(encoding="utf-8")))
                self.assertEqual(graph.id, preset)
                result = validate_graph(graph)
                self.assertTrue(result.valid, result.errors)
                self.assertEqual(result.warnings, [])
                self.assertTrue(result.has_cycles)
                self.assertEqual(WorkflowGraph.from_dict(graph.to_dict()), graph)


class TestValidateGraph(unittest.TestCase):
    def setUp(self) -> None:
        self.graph = WorkflowGraph(
            schema_version="1.0",
            id="test_graph",
            name="Test graph",
            nodes=[NodeSpec("A", NodeType.worker_node, "Worker"), NodeSpec("B", NodeType.gate_node, "Gate")],
            edges=[EdgeSpec("ab", "A", "B")],
        )

    def test_acyclic_graph(self) -> None:
        result = validate_graph(self.graph)
        self.assertEqual(
            result,
            GraphValidationResult(valid=True, errors=[], warnings=[], entry_nodes=["A"], has_cycles=False),
        )

    def test_forward_edges_with_loop_markers_keep_their_in_degree(self) -> None:
        for marker in (
            {"max_loops": 2},
            {"target_handle": "fix"},
            {"source_handle": "fail"},
            {"source_handle": "minor_fix"},
            {"source_handle": "retry"},
        ):
            with self.subTest(marker=marker):
                self.graph.edges = [EdgeSpec("ab", "A", "B", **marker)]
                result = validate_graph(self.graph)
                self.assertTrue(result.valid, result.errors)
                self.assertEqual(result.entry_nodes, ["A"])

    def test_failure_branch_to_a_dedicated_fixer_is_reached_from_the_worker(self) -> None:
        graph = WorkflowGraph(
            "1.0", "fixer", "Dedicated fixer",
            [
                NodeSpec("w", NodeType.worker_node, "Worker"),
                NodeSpec("g", NodeType.gate_node, "Gate"),
                NodeSpec("fixer", NodeType.worker_node, "Fix worker"),
                NodeSpec("h", NodeType.human_gate_node, "Approval"),
            ],
            [
                EdgeSpec("test", "w", "g"),
                EdgeSpec("fail", "g", "fixer", "fail", max_loops=2),
                EdgeSpec("retest", "fixer", "g"),
                EdgeSpec("pass", "g", "h", "pass"),
            ],
        )
        result = validate_graph(graph)
        self.assertTrue(result.valid, result.errors)
        self.assertEqual(result.entry_nodes, ["w"])
        self.assertEqual(result.warnings, [])
        self.assertTrue(result.has_cycles)

    def test_rootless_cycle_uses_marked_feedback_and_keeps_forward_branches(self) -> None:
        self.graph.nodes.append(NodeSpec("C", NodeType.worker_node, "Failure handler"))
        self.graph.edges.extend([
            EdgeSpec("ba", "B", "A", "retry", max_loops=2),
            EdgeSpec("bc", "B", "C", "fail"),
        ])
        result = validate_graph(self.graph)
        self.assertTrue(result.valid, result.errors)
        self.assertEqual(result.entry_nodes, ["A"])

    def test_empty_graph(self) -> None:
        self.graph.nodes.clear()
        self.graph.edges.clear()
        result = validate_graph(self.graph)
        self.assertFalse(result.valid)
        self.assertIn("Workflow graph must contain at least one node", result.errors)
        self.assertIn("Workflow graph has no entry nodes", result.errors)
        self.assertEqual(result.entry_nodes, [])
        self.assertFalse(result.has_cycles)

    def test_dangling_source_and_target(self) -> None:
        self.graph.edges.append(EdgeSpec("bad", "missing_source", "missing_target"))
        result = validate_graph(self.graph)
        self.assertFalse(result.valid)
        self.assertEqual(
            result.errors,
            [
                "Edge 'bad' has dangling source 'missing_source'",
                "Edge 'bad' has dangling target 'missing_target'",
            ],
        )

    def test_duplicate_node_and_edge_ids(self) -> None:
        self.graph.nodes.append(self.graph.nodes[0])
        self.graph.edges.append(self.graph.edges[0])
        result = validate_graph(self.graph)
        self.assertFalse(result.valid)
        self.assertEqual(result.errors, ["Duplicate node id 'A'", "Duplicate edge id 'ab'"])

    def test_positive_edge_limit_bounds_cycle(self) -> None:
        for limit in (1, 2):
            with self.subTest(limit=limit):
                self.graph.edges = [EdgeSpec("ab", "A", "B"), EdgeSpec("ba", "B", "A", max_loops=limit)]
                result = validate_graph(self.graph)
                self.assertEqual(
                    result,
                    GraphValidationResult(valid=True, errors=[], warnings=[], entry_nodes=["A"], has_cycles=True),
                )

    def test_unbounded_cycle_without_entry(self) -> None:
        self.graph.edges.append(EdgeSpec("ba", "B", "A"))
        result = validate_graph(self.graph)
        self.assertFalse(result.valid)
        self.assertTrue(result.has_cycles)
        self.assertEqual(result.entry_nodes, [])
        self.assertIn("Workflow graph has no entry nodes", result.errors)
        self.assertIn("Unbounded cycle without max_loops >= 1: A -> B -> A", result.errors)

    def test_loop_markers_exclude_incoming_edge_without_bounding_it(self) -> None:
        for marker in (
            {"max_loops": 0},
            {"target_handle": "fix"},
            {"source_handle": "fail"},
            {"source_handle": "minor_fix"},
            {"source_handle": "retry"},
        ):
            with self.subTest(marker=marker):
                self.graph.edges = [EdgeSpec("ab", "A", "B"), EdgeSpec("ba", "B", "A", **marker)]
                result = validate_graph(self.graph)
                self.assertFalse(result.valid)
                self.assertTrue(result.has_cycles)
                self.assertEqual(result.entry_nodes, ["A"])
                self.assertEqual(result.errors, ["Unbounded cycle without max_loops >= 1: A -> B -> A"])

    def test_node_config_limit_bounds_cycle(self) -> None:
        self.graph.edges.append(EdgeSpec("ba", "B", "A", target_handle="fix"))
        for node in self.graph.nodes:
            with self.subTest(node=node.id):
                node.config["max_loops"] = 1
                result = validate_graph(self.graph)
                self.assertTrue(result.valid, result.errors)
                self.assertTrue(result.has_cycles)
                del node.config["max_loops"]

    def test_parallel_edge_can_bypass_a_cycle_limit(self) -> None:
        self.graph.edges = [
            EdgeSpec("bounded_ab", "A", "B", max_loops=2),
            EdgeSpec("ab", "A", "B"),
            EdgeSpec("ba", "B", "A", source_handle="retry"),
        ]
        result = validate_graph(self.graph)
        self.assertFalse(result.valid)
        self.assertTrue(result.has_cycles)
        self.assertEqual(result.errors, ["Unbounded cycle without max_loops >= 1: A -> B -> A"])

    def test_unreachable_nodes_are_warnings_and_can_be_reached_through_feedback(self) -> None:
        self.graph.nodes.append(NodeSpec("C", NodeType.worker_node, "Worker C", config={"max_loops": 1}))
        self.graph.edges.append(EdgeSpec("cc", "C", "C"))
        result = validate_graph(self.graph)
        self.assertTrue(result.valid, result.errors)
        self.assertEqual(result.entry_nodes, ["A"])
        self.assertTrue(result.has_cycles)
        self.assertEqual(result.warnings, ["Unreachable node 'C'"])

        self.graph.edges.append(EdgeSpec("bc", "B", "C", source_handle="retry"))
        self.assertEqual(validate_graph(self.graph).warnings, [])


if __name__ == "__main__":
    unittest.main()
