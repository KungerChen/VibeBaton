"""Contract tests for the packaged .baton.json presets and their loader."""

from __future__ import annotations

import unittest
from pathlib import Path

from vibebaton.graph_engine import SCENARIOS, simulate_graph
from vibebaton.graph_schema import NodeType, WorkflowGraph
from vibebaton.presets import list_presets, load_preset, validate_all_presets

PRESET_IDS = ("flagship_4tier", "review_only_audit", "solo_coder_3tier", "starter_2tier")


class TestPresetsModule(unittest.TestCase):
    def test_list_presets_returns_four_summaries(self) -> None:
        summaries = list_presets()
        self.assertEqual(len(summaries), 4)
        self.assertEqual(sorted(summary.id for summary in summaries), list(PRESET_IDS))
        for summary in summaries:
            with self.subTest(preset=summary.id):
                self.assertGreater(summary.node_count, 0)
                self.assertGreater(summary.edge_count, 0)
                self.assertTrue(summary.path.endswith(".baton.json"), summary.path)

    def test_validate_all_presets_are_valid(self) -> None:
        results = validate_all_presets()
        self.assertEqual(len(results), 4)
        self.assertEqual(sorted(results), list(PRESET_IDS))
        for preset_id, result in results.items():
            with self.subTest(preset=preset_id):
                self.assertTrue(result.valid, result.errors)
                self.assertEqual(result.errors, [])

    def test_load_preset_by_id_and_path(self) -> None:
        presets_dir = Path(__file__).resolve().parents[1] / "presets"
        for preset_id in PRESET_IDS:
            with self.subTest(preset=preset_id):
                by_id = load_preset(preset_id)
                self.assertIsInstance(by_id, WorkflowGraph)
                self.assertEqual(by_id.id, preset_id)

                by_path = load_preset(presets_dir / f"{preset_id}.baton.json")
                self.assertIsInstance(by_path, WorkflowGraph)
                self.assertEqual(by_path, by_id)

    def test_load_preset_unknown_id_raises_file_not_found(self) -> None:
        with self.assertRaisesRegex(FileNotFoundError, "does_not_exist"):
            load_preset("does_not_exist")

    def test_every_preset_round_trips_through_dict(self) -> None:
        for preset_id in PRESET_IDS:
            with self.subTest(preset=preset_id):
                graph = load_preset(preset_id)
                serialized = graph.to_dict()
                self.assertEqual(WorkflowGraph.from_dict(serialized), graph)
                self.assertEqual(WorkflowGraph.from_dict(serialized).to_dict(), serialized)

    def test_every_preset_simulates_all_scenarios(self) -> None:
        for preset_id in PRESET_IDS:
            graph = load_preset(preset_id)
            for scenario in SCENARIOS:
                with self.subTest(preset=preset_id, scenario=scenario):
                    result = simulate_graph(graph, scenario)
                    self.assertEqual(result.status, "completed", result.trace[-2:])

    def test_flagship_preset_uses_expected_models(self) -> None:
        graph = load_preset("flagship_4tier")
        models = {node.config["model"] for node in graph.nodes if node.config.get("model")}
        expected = {
            "fable@high",
            "opus@high",
            "gpt-6.2-astra@xhigh",
            "gpt-6.2-sol@max",
            "deepseek-v4.1-flash@max",
        }
        self.assertTrue(expected.issubset(models), sorted(models))

    def test_review_only_audit_has_no_worker_node(self) -> None:
        graph = load_preset("review_only_audit")
        self.assertNotIn(NodeType.worker_node, {node.type for node in graph.nodes})


if __name__ == "__main__":
    unittest.main()
