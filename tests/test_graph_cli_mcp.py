"""Contract tests for the preset/graph CLI commands and the graph MCP tools."""

from __future__ import annotations

import contextlib
import io
import json
import tempfile
import unittest
from pathlib import Path
from typing import Any

from vibebaton import cli
from vibebaton.mcp_server import VibeBatonMCPServer

PRESET_IDS = ("flagship_4tier", "review_only_audit", "solo_coder_3tier", "starter_2tier")
FLAGSHIP_PRESET_PATH = "presets/flagship_4tier.baton.json"
UNBOUNDED_CYCLE_GRAPH: dict[str, Any] = {
    "schema_version": "1.0",
    "id": "unbounded_cycle",
    "name": "Unbounded retry cycle",
    "nodes": [
        {"id": "entry", "type": "planner_node", "label": "Entry"},
        {"id": "worker", "type": "worker_node", "label": "Worker"},
        {"id": "gate", "type": "gate_node", "label": "Gate"},
    ],
    "edges": [
        {"id": "start", "source": "entry", "target": "worker"},
        {"id": "check", "source": "worker", "target": "gate"},
        {
            "id": "retry",
            "source": "gate",
            "sourceHandle": "fail",
            "target": "worker",
            "targetHandle": "fix",
        },
    ],
}


def _run_cli(argv: list[str]) -> tuple[int, str]:
    """Run the CLI in-process and return its exit code and captured stdout."""
    buffer = io.StringIO()
    with contextlib.redirect_stdout(buffer):
        exit_code = cli.main(argv)
    return exit_code, buffer.getvalue()


class TestPresetCommands(unittest.TestCase):
    def test_lists_all_four_presets(self) -> None:
        exit_code, output = _run_cli(["presets"])
        self.assertEqual(exit_code, 0, output)
        for preset_id in PRESET_IDS:
            with self.subTest(preset=preset_id):
                self.assertIn(preset_id, output)

    def test_validate_exits_zero(self) -> None:
        exit_code, output = _run_cli(["presets", "--validate"])
        self.assertEqual(exit_code, 0, output)
        self.assertEqual(output.count("valid=True"), 4)

    def test_json_outputs_four_entries(self) -> None:
        exit_code, output = _run_cli(["presets", "--json"])
        self.assertEqual(exit_code, 0, output)
        rows = json.loads(output)
        self.assertIsInstance(rows, list)
        self.assertEqual(len(rows), 4)
        self.assertEqual(sorted(row["id"] for row in rows), list(PRESET_IDS))


class TestGraphCommands(unittest.TestCase):
    def test_validate_accepts_a_builtin_preset(self) -> None:
        exit_code, output = _run_cli(["graph", "validate", "flagship_4tier"])
        self.assertEqual(exit_code, 0, output)
        self.assertIn("Valid: True", output)

    def test_validate_rejects_an_unbounded_cycle(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            graph_path = Path(tmp) / "unbounded_cycle.baton.json"
            graph_path.write_text(json.dumps(UNBOUNDED_CYCLE_GRAPH), encoding="utf-8")
            exit_code, output = _run_cli(["graph", "validate", str(graph_path)])
        self.assertEqual(exit_code, 1, output)
        self.assertIn("Unbounded cycle", output)

    def test_simulate_escalate_mentions_the_human_gate(self) -> None:
        exit_code, output = _run_cli(
            ["graph", "simulate", FLAGSHIP_PRESET_PATH, "--scenario", "escalate"]
        )
        self.assertEqual(exit_code, 0, output)
        self.assertIn("escalate", output)
        self.assertIn("l0_final_gate", output)

    def test_simulate_gate_retry_json(self) -> None:
        exit_code, output = _run_cli(
            ["graph", "simulate", "solo_coder_3tier", "--scenario", "gate_retry", "--json"]
        )
        self.assertEqual(exit_code, 0, output)
        result = json.loads(output)
        self.assertEqual(result["status"], "completed")
        self.assertIn("fail", [event["outcome"] for event in result["trace"]])


class TestMCPGraphTools(unittest.TestCase):
    def setUp(self) -> None:
        self.server = VibeBatonMCPServer(default_repo=Path("."))

    def _call_tool(self, name: str, arguments: dict[str, Any]) -> dict[str, Any]:
        response = self.server.handle_request(
            {
                "jsonrpc": "2.0",
                "id": 1,
                "method": "tools/call",
                "params": {"name": name, "arguments": arguments},
            }
        )
        self.assertIsNotNone(response)
        result = response["result"]
        self.assertIs(result["isError"], False, result["content"])
        return json.loads(result["content"][0]["text"])

    def test_tools_list_has_nine_tools(self) -> None:
        response = self.server.handle_request({"jsonrpc": "2.0", "id": 1, "method": "tools/list"})
        self.assertIsNotNone(response)
        tools = response["result"]["tools"]
        names = {tool["name"] for tool in tools}
        self.assertEqual(len(tools), 9)
        self.assertIn("baton_list_presets", names)
        self.assertIn("baton_validate_graph", names)

    def test_list_presets_tool_returns_four_valid_presets(self) -> None:
        payload = self._call_tool("baton_list_presets", {})
        self.assertEqual(payload["count"], 4)
        self.assertEqual(
            sorted(preset["id"] for preset in payload["presets"]), list(PRESET_IDS)
        )
        for preset in payload["presets"]:
            with self.subTest(preset=preset["id"]):
                self.assertIs(preset["valid"], True, preset["errors"])

    def test_validate_graph_tool_simulates_a_preset(self) -> None:
        payload = self._call_tool(
            "baton_validate_graph",
            {"graph_path": FLAGSHIP_PRESET_PATH, "simulate_scenario": "escalate"},
        )
        self.assertIs(payload["valid"], True, payload["errors"])
        self.assertIn("simulation", payload)
        simulation = payload["simulation"]
        self.assertEqual(simulation["status"], "completed")
        self.assertIn("escalate", [event["outcome"] for event in simulation["trace"]])

    def test_validate_graph_tool_rejects_invalid_json_without_raising(self) -> None:
        invalid_inputs = {
            "missing_required_fields": json.dumps(
                {"schema_version": "1.0", "id": "broken", "name": "Broken graph"}
            ),
            "unbounded_cycle": json.dumps(UNBOUNDED_CYCLE_GRAPH),
            "malformed_json": "{not valid json",
        }
        for label, graph_json in invalid_inputs.items():
            with self.subTest(case=label):
                payload = self._call_tool(
                    "baton_validate_graph", {"graph_json": graph_json}
                )
                self.assertIs(payload["valid"], False)
                self.assertTrue(payload["errors"])


if __name__ == "__main__":
    unittest.main()
