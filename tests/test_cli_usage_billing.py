"""Verify CLI response parsing and token billing through the orchestration engine."""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import tomllib
import unittest
from pathlib import Path
from unittest.mock import patch

from vibebaton import pricing
from vibebaton.cli_runner import ParsedCLIOutput, invoke_provider, parse_cli_output_and_usage
from vibebaton.config import HotReloadConfig, PricingSettings, ProviderConfig, parse_config_dict
from vibebaton.db import StateStore
from vibebaton.engine import OrchestrationEngine
from vibebaton.report import compute_run_telemetry
from vibebaton.schemas import RunStatus


def _jsonl(*events: dict[str, object]) -> str:
    return "".join(json.dumps(event) + "\n" for event in events)


def _python_cli(stdout: str, *flags: str, setup: str = "") -> list[str]:
    script = (
        "import os, sys\nfrom pathlib import Path\nsys.stdin.read()\n"
        f"{setup}\nsys.stdout.buffer.write({stdout.encode('utf-8')!r})"
    )
    return [sys.executable, "-c", script, *flags]


class TestParseCLIOutput(unittest.TestCase):
    def test_claude_json_counts_cache_creation_and_prefers_file(self) -> None:
        stdout = json.dumps({
            "type": "result", "result": "Claude response",
            "usage": {"input_tokens": 100, "cache_read_input_tokens": 40,
                      "cache_creation_input_tokens": 30, "output_tokens": 20},
        }, indent=2)
        for file_text, text in ((None, "Claude response"), (" artifact\n", " artifact\n"), (" \n", "Claude response")):
            with self.subTest(file_text=file_text):
                self.assertEqual(
                    parse_cli_output_and_usage(
                        stdout, "", file_text, provider_type="cli",
                        command=["wrapped-claude", "--output-format", "json"], provider_name="local",
                    ),
                    ParsedCLIOutput(text, 170, 20, 40, structured=True),
                )

    def test_claude_stream_uses_final_result_usage(self) -> None:
        stdout = _jsonl(
            {"type": "assistant", "message": {"usage": {"input_tokens": 50, "output_tokens": 10}}},
            {"type": "result", "result": "Earlier result", "usage": {"input_tokens": 70, "output_tokens": 15}},
            {"type": "result", "result": "Final result",
             "usage": {"input_tokens": 90, "cache_read_input_tokens": 5,
                       "cache_creation_input_tokens": 10, "output_tokens": 25}},
        )
        self.assertEqual(
            parse_cli_output_and_usage(
                stdout, "", None, provider_type="cli", command=["claude", "--output-format=stream-json"],
                provider_name="claude_sub",
            ),
            ParsedCLIOutput("Final result", 105, 25, 5, structured=True),
        )

    def test_claude_stream_uses_message_usage_when_result_omits_it(self) -> None:
        stdout = _jsonl(
            {"type": "assistant", "message": {"usage": {"input_tokens": 50, "output_tokens": 10}}},
            {"type": "assistant", "usage": {"input_tokens": 60, "cache_read_input_tokens": 5, "output_tokens": 20}},
            {"type": "result", "result": "Final result"},
        )
        self.assertEqual(
            parse_cli_output_and_usage(stdout, "", None, provider_type="claude", command=[], provider_name="local"),
            ParsedCLIOutput("Final result", 115, 30, 5, structured=True),
        )

    def test_codex_sums_turn_usage_and_prefers_file_then_last_agent_message(self) -> None:
        stdout = _jsonl(
            {"type": "thread.started", "thread_id": "test"},
            {"type": "item.completed", "item": {"type": "agent_message", "text": "Draft"}},
            {"type": "turn.completed", "usage": {"input_tokens": 100, "cached_input_tokens": 20, "output_tokens": 10}},
            {"type": "item.completed", "item": {"type": "agent_message", "text": "Final response"}},
            {"type": "item.completed", "item": {"type": "command_execution", "text": "Tool output"}},
            {"type": "turn.completed", "usage": {"input_tokens": 50, "cached_input_tokens": 10, "output_tokens": 5}},
        )
        for file_text, text in (("", "Final response"), ("Saved response", "Saved response")):
            with self.subTest(file_text=file_text):
                self.assertEqual(
                    parse_cli_output_and_usage(
                        stdout, "", file_text, provider_type="cli",
                        command=[r"C:\CLI\codex.exe", "exec", "--json"], provider_name="local",
                    ),
                    ParsedCLIOutput(text, 150, 15, 30, structured=True),
                )

    def test_dsh_sums_all_usage_blocks_and_prefers_final_assistant_content(self) -> None:
        stdout = _jsonl(
            {"type": "assistant", "message": "Draft",
             "usage": {"prompt_tokens": 100, "completion_tokens": 20, "cached_tokens": 15}},
            {"token_usage": {"input_tokens": 50, "output_tokens": 10, "cached_input_tokens": 5},
             "metrics": {"input_tokens": 30, "output_tokens": 8, "cache_read_input_tokens": 10}},
            {"type": "message", "message": {"role": "assistant", "content": [
                {"type": "text", "text": "Final "}, {"type": "tool_use", "text": "Tool output"},
                {"type": "text", "text": "answer"},
            ]}},
            {"type": "message", "message": {"role": "user", "content": "User input"}},
        )
        self.assertEqual(
            parse_cli_output_and_usage(
                stdout, "", "Saved draft", provider_type="cli",
                command=["dsh", "--profile", "headless", "--json"], provider_name="local",
            ),
            ParsedCLIOutput("Final answer", 180, 38, 30, structured=True),
        )

    def test_dsh_preserves_file_or_stdout_when_no_assistant_text_exists(self) -> None:
        stdout = _jsonl({"type": "progress", "text": "Starting", "usage": {"prompt_tokens": 2}})
        for file_text, text in ((None, stdout), ("Artifact", "Artifact")):
            with self.subTest(file_text=file_text):
                self.assertEqual(
                    parse_cli_output_and_usage(stdout, "", file_text, provider_type="dsh", command=[], provider_name="local"),
                    ParsedCLIOutput(text, 2, 0, 0, structured=True),
                )

    def test_wrapped_cli_formats_detected_from_content(self) -> None:
        for event, expected in (
            ({"type": "result", "result": "Claude", "usage": {"input_tokens": 5, "cache_read_input_tokens": 3}},
             ParsedCLIOutput("Claude", 8, 0, 3, structured=True)),
            ({"type": "item.completed", "item": {"type": "agent_message", "text": "Codex"},
              "usage": {"input_tokens": 5, "cached_input_tokens": 3}},
             ParsedCLIOutput("Codex", 5, 0, 3, structured=True)),
            ({"type": "result", "result": "DSH", "token_usage": {"input_tokens": 5, "cache_read_input_tokens": 3}},
             ParsedCLIOutput("DSH", 5, 0, 3, structured=True)),
            ({"type": "done", "result": [{"type": "text", "text": "DSH result"}],
              "usage": {"input_tokens": 5, "cached_input_tokens": 3}},
             ParsedCLIOutput("DSH result", 5, 0, 3, structured=True)),
            ({"message": {"role": "assistant", "text": "DSH message"}},
             ParsedCLIOutput("DSH message", structured=True)),
        ):
            with self.subTest(text=expected.text):
                self.assertEqual(
                    parse_cli_output_and_usage(
                        _jsonl(event), "", None, provider_type="cli", command=["wrapper"], provider_name="local",
                    ),
                    expected,
                )

    def test_malformed_lines_and_invalid_counters_do_not_erase_valid_events(self) -> None:
        stdout = "\n{truncated\r\nnull\n[]\n" + _jsonl(
            {"type": "turn.completed", "usage": {"input_tokens": True, "cached_input_tokens": -1, "output_tokens": "big"}},
            {"type": "turn.completed", "usage": {"input_tokens": 12, "cached_input_tokens": 4, "output_tokens": 6}},
        ) + "{partial\n" + _jsonl({"item": {"type": "agent_message", "text": "Still here"}})
        self.assertEqual(
            parse_cli_output_and_usage(stdout, "", None, provider_type="cli", command=[], provider_name="local"),
            ParsedCLIOutput("Still here", 12, 6, 4, structured=True),
        )

    def test_plain_output_preserves_stdout_verbatim(self) -> None:
        for stdout in ("  Plain response\r\n", "{unfinished", '{"verdict":"PASS"}\n'):
            with self.subTest(stdout=stdout):
                self.assertEqual(
                    parse_cli_output_and_usage(
                        stdout, '{"type":"result","result":"Diagnostic"}', None,
                        provider_type="cli", command=["claude", "--output-format", "text"], provider_name="claude_sub",
                    ),
                    ParsedCLIOutput(stdout),
                )

    def test_gemini_json_output_and_usage(self) -> None:
        stdout = json.dumps({
            "response": "Gemini task complete",
            "stats": {"models": {"gemini-2.5-pro": {"tokens": {"prompt": 100, "candidates": 40, "cached": 10}}}},
        })
        self.assertEqual(
            parse_cli_output_and_usage(
                stdout, "", None,
                provider_type="cli",
                command=["gemini", "--output-format", "json", "-p", "."],
                provider_name="gemini_sub",
            ),
            ParsedCLIOutput("Gemini task complete", 100, 40, 10, structured=True),
        )

    def test_agy_json_output_usage_and_command_template(self) -> None:
        from vibebaton import cli_runner

        stdout = json.dumps({
            "conversation_id": "055a398f-db14-4c5f-abbb-1bf03f8120a7",
            "status": "SUCCESS",
            "response": "Antigravity task complete",
            "usage": {
                "input_tokens": 10415,
                "output_tokens": 657,
                "thinking_tokens": 616,
                "cache_read_tokens": 8113,
                "total_tokens": 11072,
            },
        })
        self.assertEqual(
            parse_cli_output_and_usage(
                stdout, "", None,
                provider_type="cli",
                command=["agy", "-p", "--model", "gemini-4-carbon", "--effort", "medium", "--output-format", "json"],
                provider_name="agy_sub",
            ),
            ParsedCLIOutput("Antigravity task complete", 10415, 657, 8113, structured=True),
        )
        cmd = cli_runner.format_command_template(
            ["agy", "--model", "{model_name}", "--effort", "{effort}", "--dangerously-skip-permissions", "--output-format", "json", "-p", "{prompt}"],
            model="gemini-4-carbon@medium", workdir=Path("."), prompt_file=Path("p"), output_file=Path("o"),
            prompt="Design a health check",
        )
        self.assertEqual(
            cmd,
            ["agy", "--model", "gemini-4-carbon", "--effort", "medium", "--dangerously-skip-permissions", "--output-format", "json", "-p", "Design a health check"],
        )
        long_cmd = cli_runner.format_command_template(
            ["agy", "--model", "{model_name}", "-p", "{prompt}"],
            model="gemini-4-carbon@medium", workdir=Path("."), prompt_file=Path("C:/tmp/prompt.md"), output_file=Path("o"),
            prompt="x" * 20_001,
        )
        self.assertIn("Read and follow the complete instructions in", long_cmd[-1])
        self.assertIn("prompt.md", long_cmd[-1])

    def test_example_templates_parse_with_native_json_flags(self) -> None:
        path = Path(__file__).resolve().parents[1] / "baton.example.toml"
        cfg = parse_config_dict(tomllib.loads(path.read_text(encoding="utf-8")))
        claude = cfg.providers["claude_sub"].command
        mode_index = claude.index("--output-format") + 1
        self.assertEqual(claude[mode_index], "json")
        agy = cfg.providers["agy_sub"].command
        self.assertEqual(agy[agy.index("--output-format") + 1], "json")
        self.assertEqual(cfg.roles["brainstorm_and_final_gate"].provider, "agy_sub")
        self.assertEqual(cfg.roles["brainstorm_and_final_gate"].model, "gemini-4-carbon@medium")
        self.assertIn("--json", cfg.providers["codex_sub"].command)
        self.assertIn("--json", cfg.providers["dsh_opencode"].command)
        self.assertEqual(cfg.pricing, PricingSettings())


class TestCLIBilling(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        self.enterContext(patch.dict(os.environ, {"VIBEBATON_DISABLE_PRICING_SYNC": "1"}))
        self.root = Path(self.enterContext(tempfile.TemporaryDirectory())).resolve()

    async def test_plain_cli_keeps_zero_usage_and_no_cost(self) -> None:
        result = await invoke_provider(
            ProviderConfig("claude_sub", command=_python_cli("  Plain output\n", "--output-format", "json")),
            model="sonnet@high", effort=None, prompt="Respond", cwd=self.root,
            prompt_file=self.root / "prompt.md", output_file=self.root / "output.json",
        )
        self.assertEqual(result.status, "ok", result.stderr)
        self.assertEqual(result.stdout, "  Plain output\n")
        self.assertEqual(result.text, result.stdout)
        self.assertEqual((result.prompt_tokens, result.completion_tokens, result.cached_tokens), (0, 0, 0))
        self.assertIsNone(result.cost_usd)

    async def test_provider_rate_prices_structured_cli_without_pricing_settings(self) -> None:
        stdout = _jsonl(
            {"type": "item.completed", "item": {"type": "agent_message", "text": "Done"}},
            {"type": "turn.completed", "usage": {"input_tokens": 1000, "cached_input_tokens": 200, "output_tokens": 300}},
        )
        provider = ProviderConfig(
            "local", command=_python_cli(stdout),
            model_pricing={"test-model": {"input_per_1m": 2, "output_per_1m": 4, "cached_input_per_1m": 1}},
        )
        result = await invoke_provider(
            provider, model="test-model@max", effort=None, prompt="Respond", cwd=self.root,
            prompt_file=self.root / "prompt.md", output_file=self.root / "output.json",
        )
        self.assertEqual(result.status, "ok", result.stderr)
        self.assertEqual(result.stdout, stdout)
        self.assertEqual(result.text, "Done")
        self.assertEqual((result.prompt_tokens, result.completion_tokens, result.cached_tokens), (1000, 300, 200))
        self.assertIsInstance(result.cost_usd, float)
        self.assertEqual(result.cost_usd, 0.003)

    async def test_invalid_cached_total_leaves_the_response_available(self) -> None:
        stdout = _jsonl(
            {"type": "item.completed", "item": {"type": "agent_message", "text": "Done"}},
            {"type": "turn.completed", "usage": {"input_tokens": 5, "cached_input_tokens": 10, "output_tokens": 3}},
        )
        result = await invoke_provider(
            ProviderConfig("codex_sub", command=_python_cli(stdout, "--json")),
            model="gpt-5@max", effort=None, prompt="Respond", cwd=self.root,
            prompt_file=self.root / "prompt.md", output_file=self.root / "output.json",
        )
        self.assertEqual(result.status, "ok", result.stderr)
        self.assertEqual(result.text, "Done")
        self.assertIsNone(result.cost_usd)

    async def test_pricing_sync_start_failure_preserves_run_validation(self) -> None:
        config_path = self.root / "baton.json"
        config_path.write_text('{"notifications":{"enabled":false}}', encoding="utf-8")
        missing_rfc = self.root / "missing.md"
        store = StateStore(self.root / "state.sqlite")
        run_id = store.create_run(self.root, missing_rfc)
        engine = OrchestrationEngine(self.root, HotReloadConfig(config_path), store)
        with patch.object(pricing, "trigger_background_pricing_sync", side_effect=RuntimeError("Thread start failed")) as sync:
            status = await engine.execute_run(run_id)

        sync.assert_called_once_with(engine.cfg.pricing)
        self.assertEqual(status, RunStatus.FAILED)
        self.assertEqual(store.get_run(run_id)["summary"], f"RFC file missing: {missing_rfc}")

    async def test_run_bills_builtin_cached_and_toml_rates_through_role_events(self) -> None:
        repo = self.root / "repo"
        repo.mkdir()
        (repo / ".gitignore").write_text(".baton/\n", encoding="utf-8")
        for args in (
            ["init", "-b", "main"],
            ["config", "user.name", "VibeBaton CI"],
            ["config", "user.email", "ci@vibebaton.local"],
            ["add", ".gitignore"],
            ["commit", "-m", "Initial commit"],
        ):
            subprocess.run(["git", *args], cwd=repo, capture_output=True, check=True)

        plan = {"milestones": [{"id": "M1", "title": "Billing", "tasks": [
            {"id": "T1", "title": "Write the result", "tier": "critical", "allowed_paths": ["result.txt"]},
        ]}]}
        planner = _python_cli(_jsonl({
            "type": "result", "result": json.dumps(plan),
            "usage": {"input_tokens": 1000, "cache_read_input_tokens": 200,
                      "cache_creation_input_tokens": 100, "output_tokens": 100},
        }), "--output-format", "json")
        worker = _python_cli(_jsonl(
            {"type": "item.completed", "item": {"type": "agent_message", "text": "Implemented"}},
            {"type": "turn.completed", "usage": {"input_tokens": 1500, "cached_input_tokens": 500, "output_tokens": 300}},
        ), "--json", setup="Path('result.txt').write_text('implemented', encoding='utf-8')")
        reviewer = _python_cli(_jsonl(
            {"type": "assistant", "content": [{"type": "text", "text": '{"verdict":"PASS"}'}]},
            {"metrics": {"prompt_tokens": 800, "completion_tokens": 100, "cached_tokens": 0}},
        ), "--json", setup="Path(os.environ['VIBEBATON_OUTPUT_FILE']).write_text('old draft', encoding='utf-8')")

        cache_path = self.root / "pricing_cache.json"
        cache_rates = {"input_per_1m": 4, "output_per_1m": 8, "cached_input_per_1m": 1}
        cache_path.write_text(json.dumps({"models": {"gpt-5": cache_rates, "deepseek-v4-pro": cache_rates}}), encoding="utf-8")
        config_path = self.root / "baton.toml"
        config_path.write_text(f"""
[daemon]
worktree_root = {json.dumps(str(self.root / 'worktrees'))}
prevent_sleep_windows = false

[notifications]
enabled = false

[pricing]
cache_path = {json.dumps(str(cache_path))}
custom_path = {json.dumps(str(self.root / 'custom_pricing.json'))}

[pricing.custom.deepseek-v4-pro]
input_per_1m = 2
output_per_1m = 3
cached_input_per_1m = 0.5

[providers.claude_sub]
command = {json.dumps(planner)}
[providers.codex_sub]
command = {json.dumps(worker)}
[providers.dsh_opencode]
command = {json.dumps(reviewer)}

[roles.tactical_planner]
provider = "claude_sub"
model = "sonnet@high"
[roles.critical_executor]
provider = "codex_sub"
model = "gpt-5@max"
[roles.milestone_reviewer]
provider = "dsh_opencode"
model = "deepseek-v4-pro@high"
""", encoding="utf-8")

        rfc_path = self.root / "rfc.md"
        rfc_path.write_text("# CLI billing integration\n", encoding="utf-8")
        store = StateStore(self.root / "state.sqlite")
        run_id = store.create_run(repo, rfc_path)
        engine = OrchestrationEngine(repo, HotReloadConfig(config_path), store)
        sync_results = []
        trigger_sync = pricing.trigger_background_pricing_sync

        def record_sync(settings: PricingSettings) -> None:
            sync_results.append(trigger_sync(settings))

        with (
            patch.object(pricing, "trigger_background_pricing_sync", side_effect=record_sync) as sync,
            patch.object(pricing, "_fetch_pricing", side_effect=AssertionError("Unexpected pricing HTTP request")) as fetch,
        ):
            status = await engine.execute_run(run_id)

        self.assertEqual(status, RunStatus.READY_FOR_FINAL_GATE, store.get_run(run_id)["summary"])
        sync.assert_called_once_with(engine.cfg.pricing)
        self.assertEqual(sync_results, [None])
        fetch.assert_not_called()
        events = [
            json.loads(event["payload_json"])
            for event in store.get_events(run_id)
            if event["kind"] == "role_completed"
        ]
        expected = {
            "tactical_planner": (1300, 100, 200, 0.00486),
            "critical_executor": (1500, 300, 500, 0.0069),
            "milestone_reviewer": (800, 100, 0, 0.0019),
        }
        self.assertEqual([event["role"] for event in events], list(expected))
        for event in events:
            self.assertEqual(event["status"], "ok")
            self.assertIsInstance(event["cost_usd"], float)
            self.assertEqual(
                (event["prompt_tokens"], event["completion_tokens"], event["cached_tokens"], event["cost_usd"]),
                expected[event["role"]],
            )
        self.assertEqual(compute_run_telemetry(store, run_id)["billing"], {
            "total_prompt_tokens": 3600, "total_completion_tokens": 500, "total_cached_tokens": 700,
            "total_tokens": 4100, "total_cost_usd": 0.01366, "has_exact_billing": True,
            "total_calls": 3, "reported_calls": 3,
        })


if __name__ == "__main__":
    unittest.main()
