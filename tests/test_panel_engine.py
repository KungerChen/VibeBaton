"""Engine/CLI/REST wiring for ``mode="panel"``: 00_PANEL runs before 01_PLAN and feeds the planner."""

from __future__ import annotations

import asyncio
import contextlib
import io
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from typing import Any
from unittest.mock import AsyncMock, patch

from vibebaton import cli
from vibebaton.cli_runner import CLIResult
from vibebaton.config import HotReloadConfig
from vibebaton.db import StateStore
from vibebaton.engine import OrchestrationEngine
from vibebaton.schemas import RunStatus

from test_web_server import WebServerTestCase


MASTER_SPEC = "MASTER-SPEC-MARKER: ship the calculator with a friendly error message."
PLAN = {
    "rfc_version": "v1.0",
    "complexity_tier": "S",
    "summary": "Single milestone plan",
    "milestones": [{
        "id": "M1",
        "title": "Core",
        "tasks": [{"id": "T-1", "title": "Implement core", "allowed_paths": ["src/core.py"]}],
    }],
}


def _ok(text: str) -> CLIResult:
    return CLIResult(
        status="ok", exit_code=0, stdout=text, stderr="", duration_sec=0.01, command=["fake"],
        prompt_tokens=10, completion_tokens=5, cost_usd=0.001,
    )


class PanelEngineTestCase(unittest.TestCase):
    """A real git repo + config; every provider call goes through a recording fake."""

    def setUp(self) -> None:
        self.repo = Path(self.enterContext(tempfile.TemporaryDirectory())).resolve()
        for args in (["init", "-b", "main"], ["config", "user.email", "ci@vibebaton.local"],
                     ["config", "user.name", "VibeBaton CI"]):
            subprocess.run(["git", *args], cwd=self.repo, check=True, capture_output=True)
        (self.repo / "README.md").write_text("# Demo\n", encoding="utf-8")
        subprocess.run(["git", "add", "-A"], cwd=self.repo, check=True, capture_output=True)
        subprocess.run(["git", "commit", "-m", "init"], cwd=self.repo, check=True, capture_output=True)

        baton = self.repo / ".baton"
        baton.mkdir()
        self.rfc = baton / "00_RFC.md"
        self.rfc.write_text("# RFC\nBuild a calculator.\n", encoding="utf-8")
        provider = {"max_concurrency": 2, "command": [sys.executable, "-c", "pass"], "prompt_via": "stdin"}
        cfg = {
            "daemon": {"base_branch": "main", "dev_branch": "dev", "prevent_sleep_windows": False},
            "providers": {"claude_sub": provider, "codex_sub": provider},
            "roles": {
                "tactical_planner": {"provider": "claude_sub", "model": "opus@high"},
                "milestone_reviewer": {"provider": "claude_sub", "model": "sonnet@high"},
                "micro_orchestrator": {"provider": "codex_sub", "model": "gpt-5.5-mini"},
                "critical_executor": {"provider": "codex_sub", "model": "gpt-5.5"},
                "bulk_worker": {"provider": "codex_sub", "model": "gpt-5.5-mini"},
            },
        }
        cfg_path = baton / "config.json"
        cfg_path.write_text(json.dumps(cfg), encoding="utf-8")
        self.store = StateStore(baton / "state.sqlite")
        self.engine = OrchestrationEngine(repo_path=self.repo, config_loader=HotReloadConfig(cfg_path), store=self.store)
        self.calls: list[tuple[str, str]] = []  # (VIBEBATON_ROLE, prompt)

    async def _fake_invoke(self, provider: Any, **kwargs: Any) -> CLIResult:
        role = kwargs["extra_env"]["VIBEBATON_ROLE"]
        self.calls.append((role, kwargs["prompt"]))
        if role == "tactical_planner":
            return _ok(json.dumps(PLAN))
        if role == "panel_synthesizer":
            return _ok(MASTER_SPEC)
        return _ok(f"# {role} report")

    def _execute(self, mode: str) -> tuple[str, RunStatus]:
        run_id = self.store.create_run(repo_path=self.repo, rfc_path=self.rfc, mode=mode)
        return run_id, self._resume(run_id)

    def _resume(self, run_id: str) -> RunStatus:
        with patch("vibebaton.engine.invoke_provider", side_effect=self._fake_invoke), \
                patch.object(OrchestrationEngine, "_execute_milestone", AsyncMock(return_value=True)):
            return asyncio.run(self.engine.execute_run(run_id))

    def _kinds(self, run_id: str) -> list[str]:
        return [e["kind"] for e in self.store.get_events(run_id, limit=-1)]

    def _planner_prompts(self) -> list[str]:
        return [prompt for role, prompt in self.calls if role == "tactical_planner"]


class TestPanelEngine(PanelEngineTestCase):
    def test_panel_run_executes_panel_then_plan_with_master_spec(self) -> None:
        run_id, status = self._execute("panel")
        self.assertEqual(status, RunStatus.READY_FOR_FINAL_GATE)

        kinds = self._kinds(run_id)
        first = {kind: kinds.index(kind) for kind in (
            "panel_started", "panel_member_completed", "panel_synthesized", "stage_completed", "plan_generated",
        )}
        last_member = len(kinds) - 1 - kinds[::-1].index("panel_member_completed")
        self.assertLess(first["panel_started"], first["panel_member_completed"])
        self.assertLess(last_member, first["panel_synthesized"])
        self.assertLess(first["panel_synthesized"], first["stage_completed"])
        self.assertLess(first["stage_completed"], first["plan_generated"])
        self.assertLess(first["panel_synthesized"], kinds.index("role_invoked"))  # first planner call

        stage = next(e for e in self.store.get_events(run_id, limit=-1) if e["kind"] == "stage_completed")
        self.assertEqual(json.loads(stage["payload_json"])["stage"], "00_PANEL")

        # Default panel (no [panel] section): three specialists, then the synthesizer, then the planner.
        roles = [role for role, _ in self.calls]
        self.assertEqual(sorted(roles[:3]), ["panel_safety", "panel_ux", "panel_visual"])
        self.assertEqual(roles[3:], ["panel_synthesizer", "tactical_planner"])
        planner_prompt = self._planner_prompts()[0]
        self.assertIn("# Panel Master Spec", planner_prompt)
        self.assertIn(MASTER_SPEC, planner_prompt)
        self.assertIn("Build a calculator.", planner_prompt)
        master_spec = self.repo / ".baton" / "runs" / run_id / "panel" / "master_spec.md"
        self.assertEqual(master_spec.read_text(encoding="utf-8"), MASTER_SPEC)

    def test_resume_with_existing_master_spec_skips_panel(self) -> None:
        run_id = self.store.create_run(repo_path=self.repo, rfc_path=self.rfc, mode="panel")
        panel_dir = self.repo / ".baton" / "runs" / run_id / "panel"
        panel_dir.mkdir(parents=True)
        (panel_dir / "master_spec.md").write_text("SAVED-SPEC from an earlier attempt", encoding="utf-8")

        self.assertEqual(self._resume(run_id), RunStatus.READY_FOR_FINAL_GATE)
        self.assertFalse([k for k in self._kinds(run_id) if k.startswith("panel_") or k == "stage_completed"])
        self.assertEqual([role for role, _ in self.calls], ["tactical_planner"])
        self.assertIn("SAVED-SPEC from an earlier attempt", self._planner_prompts()[0])

    def test_completed_panel_run_resume_emits_no_new_panel_events(self) -> None:
        run_id, _ = self._execute("panel")
        before = self._kinds(run_id).count("panel_started")
        self.calls.clear()
        self._resume(run_id)
        self.assertEqual(self._kinds(run_id).count("panel_started"), before)
        self.assertFalse([role for role, _ in self.calls if role.startswith("panel_")])

    def test_panel_failure_fails_the_run(self) -> None:
        async def failing(provider: Any, **kwargs: Any) -> CLIResult:
            self.calls.append((kwargs["extra_env"]["VIBEBATON_ROLE"], kwargs["prompt"]))
            return CLIResult(status="error", exit_code=1, stdout="", stderr="boom", duration_sec=0.0, command=["x"])

        self._fake_invoke = failing  # type: ignore[method-assign]
        run_id, status = self._execute("panel")
        self.assertEqual(status, RunStatus.FAILED)
        self.assertIn("run_exception", self._kinds(run_id))
        self.assertEqual(self._planner_prompts(), [])

    def test_overnight_and_interactive_runs_have_no_panel_stage(self) -> None:
        for mode in ("overnight", "interactive"):
            with self.subTest(mode=mode):
                self.calls.clear()
                run_id, status = self._execute(mode)
                self.assertEqual(status, RunStatus.READY_FOR_FINAL_GATE)
                kinds = self._kinds(run_id)
                self.assertFalse([k for k in kinds if k.startswith("panel_") or k == "stage_completed"])
                self.assertEqual([role for role, _ in self.calls], ["tactical_planner"])
                self.assertNotIn("# Panel Master Spec", self._planner_prompts()[0])
                self.assertFalse((self.repo / ".baton" / "runs" / run_id / "panel").exists())


class TestPanelCli(unittest.TestCase):
    def test_run_parser_accepts_panel_mode(self) -> None:
        parser = cli.build_parser()
        for mode in ("panel", "interactive", "overnight"):
            with self.subTest(mode=mode):
                self.assertEqual(parser.parse_args(["run", "--rfc", "x.md", "--mode", mode]).mode, mode)
        with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
            parser.parse_args(["run", "--rfc", "x.md", "--mode", "bogus"])


class TestPanelRunApi(WebServerTestCase):
    def test_start_accepts_panel_mode(self) -> None:
        status, _, result = self.send_json("/api/runs/start", {"rfc_markdown": "# RFC\n\nPanel.\n", "mode": "panel"})
        self.assertEqual(status, 201)
        _, _, snapshot = self.get(f"/api/runs/{result['run_id']}")
        self.assertEqual(snapshot["run"]["mode"], "panel")

    def test_start_rejects_unknown_mode(self) -> None:
        status, _, body = self.send_json("/api/runs/start", {"rfc_markdown": "# RFC\n", "mode": "bogus"})
        self.assertEqual(status, 400)
        self.assertEqual(body["error"], "mode must be overnight, interactive or panel")
        self.assertEqual(self.spawn_calls, [])


if __name__ == "__main__":
    unittest.main()
