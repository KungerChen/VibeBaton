"""Exercise HTTP role dispatch, billing, and quota handling on loopback."""

from __future__ import annotations

import json
import os
import tempfile
import unittest
from pathlib import Path
from typing import Any
from unittest.mock import patch

from tests.http_mock_server import MockChatCompletionsServer, MockResponse
from vibebaton.cli_runner import CLIResult
from vibebaton.config import HotReloadConfig
from vibebaton.db import StateStore
from vibebaton.engine import OrchestrationEngine
from vibebaton.report import compute_run_telemetry, generate_battle_report


_KEY_ENV = "VIBEBATON_ENGINE_TEST_KEY"
_API_KEY = "mock-engine-token"
_MODEL = "test-reasoning-model"
_MODEL_SPEC = f"{_MODEL}@high"
_COMBINED_PROMPT = "Role instructions\n\n---\n\nImplement the task."


def _completion(prompt_tokens: int, completion_tokens: int, cached_tokens: int) -> MockResponse:
    return MockResponse.from_json({
        "choices": [{"message": {"content": "Task complete"}}],
        "usage": {
            "prompt_tokens": prompt_tokens,
            "completion_tokens": completion_tokens,
            "prompt_tokens_details": {"cached_tokens": cached_tokens},
        },
    })


class TestHTTPProviderEngine(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        self.repo = Path(self.enterContext(tempfile.TemporaryDirectory())).resolve()
        self.workdir = self.repo / "worktree"
        self.workdir.mkdir()
        rfc_path = self.repo / "rfc.md"
        rfc_path.write_text("# HTTP engine integration\n", encoding="utf-8")
        (self.repo / "role.md").write_text("Role instructions\n", encoding="utf-8")
        self.store = StateStore(self.repo / "state.sqlite")
        self.run_id = self.store.create_run(self.repo, rfc_path)
        self.run_dir = self.repo / ".baton" / "runs" / self.run_id
        self.credentials_path = self.repo / "credentials.json"
        self.credentials_path.write_text(json.dumps({_KEY_ENV: _API_KEY}), encoding="utf-8")
        self.enterContext(patch.dict(os.environ, {"NO_PROXY": "127.0.0.1"}))
        os.environ.pop(_KEY_ENV, None)

    def _make_engine(self, base_url: str = "http://127.0.0.1:0") -> OrchestrationEngine:
        config_path = self.repo / "baton.json"
        config_path.write_text(json.dumps({
            "daemon": {"default_stall_timeout_sec": 3, "default_hard_timeout_sec": 5},
            "providers": {
                "gateway": {
                    "type": "http",
                    "base_url": base_url,
                    "api_key_env": _KEY_ENV,
                    "cooldown_backoff_sec": [120],
                    "model_pricing": {
                        _MODEL: {"input_per_1m": 2.0, "output_per_1m": 3.0, "cached_input_per_1m": 0.4},
                    },
                },
                "local_cli": {"type": "cli", "command": ["fake-agent"]},
            },
            "roles": {"bulk_worker": {"provider": "gateway", "model": _MODEL_SPEC, "prompt_file": "role.md"}},
        }), encoding="utf-8")
        return OrchestrationEngine(
            self.repo, HotReloadConfig(config_path), self.store, credentials_path=self.credentials_path,
        )

    async def _invoke(
        self, engine: OrchestrationEngine, model_overrides: dict[str, str] | None = None,
    ) -> tuple[CLIResult, str]:
        return await engine._invoke_role(
            self.run_id, "bulk_worker", "Implement the task.", self.workdir, "task-T1", model_overrides or {},
            task_id="T1", milestone_id="M1", max_rate_limit_waits=0,
        )

    def _event(self, kind: str) -> dict[str, Any]:
        events = [event for event in self.store.get_events(self.run_id) if event["kind"] == kind]
        self.assertEqual(len(events), 1, events)
        return events[0]

    async def test_http_completion_reaches_audit_telemetry_and_bilingual_reports(self) -> None:
        with MockChatCompletionsServer([_completion(1000, 500, 250)]) as server:
            result, target = await self._invoke(self._make_engine(f"{server.base_url}/v1"))

        self.assertEqual(result.status, "ok", result.stderr)
        self.assertEqual(target, f"gateway:{_MODEL_SPEC}")
        self.assertEqual((self.run_dir / "out" / "task-T1.json").read_text(encoding="utf-8"), "Task complete")
        self.assertEqual(len(server.requests), 1)
        request = server.requests[0]
        self.assertEqual(request.path, "/v1/chat/completions")
        self.assertEqual(request.headers["Authorization"], f"Bearer {_API_KEY}")
        self.assertEqual(json.loads(request.body), {
            "model": _MODEL,
            "messages": [{"role": "user", "content": _COMBINED_PROMPT}],
            "reasoning_effort": "high",
        })

        completed = self._event("role_completed")
        self.assertEqual(completed["actor"], f"bulk_worker:{_MODEL_SPEC}")
        payload = json.loads(completed["payload_json"])
        self.assertEqual(payload["prompt_tokens"], 1000)
        self.assertEqual(payload["completion_tokens"], 500)
        self.assertEqual(payload["cached_tokens"], 250)
        self.assertEqual(payload["cost_usd"], 0.0031)
        self.assertEqual(compute_run_telemetry(self.store, self.run_id)["billing"], {
            "total_prompt_tokens": 1000,
            "total_completion_tokens": 500,
            "total_cached_tokens": 250,
            "total_tokens": 1500,
            "total_cost_usd": 0.0031,
            "has_exact_billing": True,
        })

        for lang, title in (("en", "Token Usage & Cost Breakdown"), ("zh", "Token 与美元成本统计")):
            with self.subTest(lang=lang):
                report = generate_battle_report(self.store, self.run_id, lang=lang)
                _, heading, section = report.partition(f"## {title}\n")
                self.assertTrue(heading)
                self.assertIn(f"| `{_MODEL_SPEC}` | 1000 | 500 | $0.0031 |", section)

    async def test_explicit_zero_cost_is_recorded_and_zero_token_fields_are_omitted(self) -> None:
        with MockChatCompletionsServer([_completion(0, 0, 0)]) as server:
            result, _ = await self._invoke(self._make_engine(server.base_url))

        self.assertEqual(result.status, "ok", result.stderr)
        payload = json.loads(self._event("role_completed")["payload_json"])
        self.assertEqual(payload["cost_usd"], 0.0)
        self.assertTrue({"prompt_tokens", "completion_tokens", "cached_tokens"}.isdisjoint(payload))

    async def test_http_retry_after_sets_provider_cooldown_and_audit_event(self) -> None:
        throttled = MockResponse.from_json(
            {"error": {"message": "Too many requests, try again in 3 sec"}},
            status=429,
            headers={"Retry-After": "42"},
        )
        with MockChatCompletionsServer([throttled]) as server:
            result, target = await self._invoke(self._make_engine(server.base_url))

        self.assertEqual(result.status, "rate_limited", result.stderr)
        self.assertEqual(result.retry_after_sec, 42.0)
        self.assertEqual(target, f"gateway:{_MODEL_SPEC}")
        self.assertEqual(len(server.requests), 1)
        cooldown = self.store.get_provider_cooldown("gateway")
        self.assertGreater(cooldown, 0.0)
        self.assertLessEqual(cooldown, 42.0)
        event = self._event("quota_rate_limited")
        self.assertEqual((event["actor"], event["task_id"], event["milestone_id"]), ("gateway", "T1", "M1"))
        self.assertEqual(json.loads(event["payload_json"]), {"wait_sec": 42.0, "model": _MODEL_SPEC})

    async def test_cli_dispatch_preserves_runner_arguments_and_audit_payload(self) -> None:
        engine = self._make_engine()
        expected = CLIResult("ok", 0, "Task complete", "", 1.25, ["fake-agent"])
        with patch("vibebaton.cli_runner.run_provider_cli", autospec=True, return_value=expected) as runner:
            result, target = await self._invoke(engine, {"bulk_worker": "local_cli:cli-model@max"})

        self.assertIs(result, expected)
        self.assertEqual(target, "local_cli:cli-model@max")
        runner.assert_awaited_once_with(
            engine.cfg.providers["local_cli"],
            model="cli-model@max",
            prompt=_COMBINED_PROMPT,
            workdir=self.workdir,
            prompt_file=self.run_dir / "prompts" / "task-T1.md",
            output_file=self.run_dir / "out" / "task-T1.json",
            default_stall_timeout=3,
            default_hard_timeout=5,
            extra_env={
                "VIBEBATON_RUN_ID": self.run_id,
                "VIBEBATON_ROLE": "bulk_worker",
                "VIBEBATON_TASK_ID": "T1",
                "VIBEBATON_MILESTONE_ID": "M1",
            },
        )
        self.assertEqual(json.loads(self._event("role_completed")["payload_json"]), {
            "role": "bulk_worker",
            "provider": "local_cli",
            "model": "cli-model@max",
            "duration_sec": 1.25,
            "status": "ok",
            "exit_code": 0,
        })


if __name__ == "__main__":
    unittest.main()
