"""Contract tests for the packaged .baton.json presets and their loader."""

from __future__ import annotations

import json
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from vibebaton.graph_engine import SCENARIOS, simulate_graph
from vibebaton.graph_schema import NodeType, WorkflowGraph
from vibebaton.presets import list_presets, load_preset, validate_all_presets

PRESET_IDS = (
    "claude_only_3tier",
    "codex_only_3tier",
    "deepseek_bulk_factory",
    "flagship_4tier",
    "review_only_audit",
    "solo_coder_3tier",
    "starter_2tier",
)


class TestPresetsModule(unittest.TestCase):
    def test_list_presets_returns_seven_summaries(self) -> None:
        summaries = list_presets()
        self.assertEqual([summary.id for summary in summaries], list(PRESET_IDS))
        for summary in summaries:
            with self.subTest(preset=summary.id):
                self.assertGreater(summary.node_count, 0)
                self.assertGreater(summary.edge_count, 0)
                self.assertTrue(summary.path.endswith(".baton.json"), summary.path)

    def test_validate_all_presets_are_valid(self) -> None:
        results = validate_all_presets()
        self.assertEqual(sorted(results), list(PRESET_IDS))
        for preset_id, result in results.items():
            with self.subTest(preset=preset_id):
                self.assertTrue(result.valid, result.errors)
                self.assertEqual(result.errors, [])

    def test_original_presets_declare_metadata(self) -> None:
        expected = {
            "flagship_4tier": (
                "general", ["claude_sub", "codex_sub", "dsh_opencode"], "high",
                "VibeBaton Stage 1 four-tier workflow",
            ),
            "review_only_audit": (
                "audit", ["codex_sub", "claude_sub"], "medium",
                "VibeBaton mechanical gate principle",
            ),
            "solo_coder_3tier": (
                "general", ["claude_sub", "dsh_opencode", "codex_sub"], "medium",
                "VibeBaton Stage 1 Golden Example",
            ),
            "starter_2tier": (
                "small_project", ["dsh_opencode"], "low",
                "VibeBaton Stage 1 single-provider workflow",
            ),
        }
        summaries = {summary.id: summary.to_dict() for summary in list_presets()}
        for preset_id, (category, providers, cost_tier, inspired_by) in expected.items():
            with self.subTest(preset=preset_id):
                graph = load_preset(preset_id).to_dict()
                summary = summaries[preset_id]
                metadata = {
                    "category": category,
                    "required_providers": providers,
                    "cost_tier": cost_tier,
                    "inspired_by": inspired_by,
                }
                for field, value in metadata.items():
                    self.assertEqual(graph[field], value)
                    self.assertEqual(summary[field], value)

    def test_legacy_presets_derive_summary_metadata(self) -> None:
        expected = {
            "flagship_4tier": ("general", ["claude_sub", "codex_sub", "dsh_opencode"]),
            "review_only_audit": ("audit", ["codex_sub", "claude_sub"]),
            "solo_coder_3tier": ("general", ["claude_sub", "dsh_opencode", "codex_sub"]),
            "starter_2tier": ("small_project", ["dsh_opencode"]),
        }
        with TemporaryDirectory() as directory:
            for preset_id in expected:
                data = load_preset(preset_id).to_dict()
                for field in ("category", "required_providers", "cost_tier", "inspired_by"):
                    del data[field]
                path = Path(directory) / f"{preset_id}.baton.json"
                path.write_text(json.dumps(data), encoding="utf-8")
            summaries = {summary.id: summary.to_dict() for summary in list_presets(directory)}
        for preset_id, (category, providers) in expected.items():
            with self.subTest(preset=preset_id):
                summary = summaries[preset_id]
                self.assertEqual(summary["category"], category)
                self.assertEqual(summary["required_providers"], providers)
                self.assertEqual(summary["cost_tier"], "medium")
                self.assertIsNone(summary["inspired_by"])

    def test_new_presets_declare_metadata(self) -> None:
        expected = (
            ("claude_only_3tier", "same_family", "claude_sub", "high"),
            ("codex_only_3tier", "same_family", "codex_sub", "medium"),
            ("deepseek_bulk_factory", "bulk_batch", "dsh_opencode", "low"),
        )
        summaries = {summary.id: summary.to_dict() for summary in list_presets()}
        for preset_id, category, provider, cost_tier in expected:
            with self.subTest(preset=preset_id):
                graph = load_preset(preset_id).to_dict()
                summary = summaries[preset_id]
                metadata = {"category": category, "required_providers": [provider], "cost_tier": cost_tier}
                for field, value in metadata.items():
                    self.assertEqual(graph[field], value)
                    self.assertEqual(summary[field], value)

    def test_explicit_empty_provider_list_and_attribution_are_preserved(self) -> None:
        data = load_preset("starter_2tier").to_dict()
        data.update(
            id="custom_starter",
            category="general",
            required_providers=[],
            cost_tier="low",
            inspired_by="starter_2tier",
        )
        with TemporaryDirectory() as directory:
            path = Path(directory) / "custom_starter.baton.json"
            path.write_text(json.dumps(data), encoding="utf-8")
            (summary,) = list_presets(directory)

        self.assertEqual(summary.category, "general")
        self.assertEqual(summary.required_providers, [])
        self.assertEqual(summary.cost_tier, "low")
        self.assertEqual(summary.inspired_by, "starter_2tier")
        self.assertEqual(summary.to_dict()["inspired_by"], "starter_2tier")

    def test_same_family_presets_use_one_provider_for_each_tier(self) -> None:
        tier_types = {NodeType.planner_node, NodeType.worker_node, NodeType.reviewer_node}
        for preset_id, provider in (
            ("claude_only_3tier", "claude_sub"),
            ("codex_only_3tier", "codex_sub"),
        ):
            with self.subTest(preset=preset_id):
                graph = load_preset(preset_id)
                tiers = [node for node in graph.nodes if node.type in tier_types]
                self.assertCountEqual([node.type for node in tiers], tier_types)
                self.assertEqual([node.config.get("provider") for node in tiers], [provider] * 3)

    def test_deepseek_bulk_factory_uses_api_branding_and_model(self) -> None:
        graph = load_preset("deepseek_bulk_factory")
        display_strings = [graph.name, graph.description, *graph.recommended_for]
        display_strings.extend(node.label for node in graph.nodes)
        for display in display_strings:
            with self.subTest(display=display):
                self.assertIn("DeepSeek API", display)
                self.assertNotIn("opencode", display.casefold())

        workers = [node for node in graph.nodes if node.type is NodeType.worker_node]
        self.assertTrue(workers)
        for node in graph.nodes:
            if node.type in {NodeType.planner_node, NodeType.worker_node}:
                with self.subTest(node=node.id):
                    self.assertEqual(node.config.get("provider"), "dsh_opencode")
                    self.assertEqual(node.config.get("model"), "deepseek-v4.1-flash@max")

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
        for summary in list_presets():
            with self.subTest(preset=summary.id):
                path = Path(summary.path)
                source = json.loads(path.read_text(encoding="utf-8"))
                graph = load_preset(path)
                serialized = graph.to_dict()
                self.assertEqual(serialized, source)
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
