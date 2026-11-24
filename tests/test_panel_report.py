"""Unit tests for 00_PANEL stage telemetry and the bilingual Panel & Synthesis report section."""

from __future__ import annotations

import importlib.util
import re
import subprocess
import tempfile
import unittest
from pathlib import Path
from types import ModuleType
from typing import Any
from unittest.mock import patch

from vibebaton.db import StateStore
from vibebaton.report import compute_run_telemetry, generate_battle_report
from vibebaton.schemas import MilestoneSpec, PlanDAG, RunStatus, TaskSpec, TaskStatus, TaskTier

_HAN_RE = re.compile(r"[㐀-䶿一-鿿]")
# Commit the panel section was introduced on top of; the no-panel output must match it byte-for-byte.
_BASELINE_COMMIT = "15c6833"
_REPO_ROOT = Path(__file__).resolve().parents[1]


def _load_baseline_report() -> ModuleType | None:
    try:
        source = subprocess.run(
            ["git", "show", f"{_BASELINE_COMMIT}:src/vibebaton/report.py"],
            cwd=_REPO_ROOT,
            capture_output=True,
            check=True,
            encoding="utf-8",
        ).stdout
    except (OSError, subprocess.CalledProcessError):
        return None
    name = "vibebaton._baseline_report"
    spec = importlib.util.spec_from_loader(name, loader=None)
    assert spec is not None
    module = importlib.util.module_from_spec(spec)
    module.__package__ = "vibebaton"
    exec(compile(source, f"<{_BASELINE_COMMIT}:report.py>", "exec"), module.__dict__)
    return module


class TestPanelReport(unittest.TestCase):
    def setUp(self) -> None:
        self.repo = Path(self.enterContext(tempfile.TemporaryDirectory()))
        self.store = StateStore(self.repo / "state.sqlite")
        self.base_t = 1_700_000_000.0
        with patch("vibebaton.db.time.time", return_value=self.base_t):
            self.run_id = self.store.create_run(self.repo, self.repo / "rfc.md", run_id="run-panel-1")

    def _at(self, offset: float, kind: str, **fields: Any) -> None:
        with patch("vibebaton.db.time.time", return_value=self.base_t + offset):
            self.store.log_event(self.run_id, kind, **fields)

    def _register_plan(self) -> None:
        plan = PlanDAG(
            rfc_version="1.0",
            complexity_tier="medium",
            milestones=[
                MilestoneSpec(
                    id="M1",
                    title="Core",
                    tasks=[TaskSpec(id="M1-T1", title="Core", tier=TaskTier.ROUTINE, assignee_role="bulk_worker")],
                )
            ],
        )
        with patch("vibebaton.db.time.time", return_value=self.base_t + 40.0):
            self.store.register_plan(self.run_id, plan)
            self.store.update_task(self.run_id, "M1-T1", status=TaskStatus.PASSED, duration_sec=12.0)
            self.store.update_run_status(self.run_id, RunStatus.COMPLETED)

    def _log_common_events(self) -> None:
        self._at(
            35.0,
            "role_completed",
            actor="bulk_worker:flash",
            message="Completed bulk_worker",
            payload={
                "role": "bulk_worker",
                "provider": "dsh_opencode",
                "model": "flash",
                "duration_sec": 5.0,
                "prompt_tokens": 100,
                "completion_tokens": 50,
                "cost_usd": 0.01,
            },
        )

    def _log_panel_events(self) -> None:
        self._at(1.0, "panel_started", message="Panel started", payload={"member_count": 2})
        self._at(
            8.0,
            "panel_member_completed",
            message="architect done",
            payload={
                "member_id": "architect",
                "perspective": "System architecture",
                "provider": "claude_sub",
                "model": "opus",
                "ok": True,
                "tokens_in": 1000,
                "tokens_out": 200,
                "cost_usd": 0.5,
                "elapsed_sec": 7.0,
                "preview": "...",
                "output_path": "panel/architect.md",
                "error": "",
            },
        )
        self._at(
            9.0,
            "panel_member_completed",
            message="security failed",
            payload={
                "member_id": "security",
                "perspective": "Threat model",
                "provider": "codex_sub",
                "model": "gpt",
                "ok": False,
                "tokens_in": 300,
                "tokens_out": 0,
                "cost_usd": 0.25,
                "elapsed_sec": 8.0,
                "preview": "",
                "output_path": "",
                "error": "timeout",
            },
        )
        self._at(
            21.0,
            "panel_synthesized",
            message="Panel synthesized",
            payload={
                "member_count": 2,
                "succeeded_count": 1,
                "provider": "claude_sub",
                "model": "fable",
                "tokens_in": 1500,
                "tokens_out": 700,
                "cost_usd": 1.0,
                "elapsed_sec": 12.0,
                "preview": "...",
                "master_spec_path": "panel/master_spec.md",
            },
        )

    def _render(self, report_fn: Any = generate_battle_report, lang: str = "en") -> str:
        with patch("time.time", return_value=self.base_t + 100.0):
            return report_fn(self.store, self.run_id, lang=lang)

    def test_panel_stage_and_billing_included_when_panel_events_exist(self) -> None:
        self._log_panel_events()
        self._log_common_events()
        self._register_plan()

        telemetry = compute_run_telemetry(self.store, self.run_id, now_ts=self.base_t + 100.0)
        stages = {stage["id"]: stage for stage in telemetry["stages"]}
        self.assertIn("00_PANEL", stages)
        self.assertEqual(stages["00_PANEL"]["wall_sec"], 20.0)
        self.assertGreater(stages["00_PANEL"]["wall_sec"], 0)
        self.assertEqual(telemetry["stages"][0]["id"], "00_PANEL")

        billing = telemetry["billing"]
        self.assertEqual(billing["total_prompt_tokens"], 100 + 1000 + 300 + 1500)
        self.assertEqual(billing["total_completion_tokens"], 50 + 200 + 0 + 700)
        self.assertAlmostEqual(billing["total_cost_usd"], 0.01 + 0.5 + 0.25 + 1.0)

    def test_panel_stage_omitted_without_panel_events(self) -> None:
        self._log_common_events()
        self._register_plan()

        telemetry = compute_run_telemetry(self.store, self.run_id, now_ts=self.base_t + 100.0)
        self.assertNotIn("00_PANEL", [stage["id"] for stage in telemetry["stages"]])
        self.assertEqual(telemetry["billing"]["total_prompt_tokens"], 100)

    def test_english_panel_section(self) -> None:
        self._log_panel_events()
        self._register_plan()

        report = self._render(lang="en")
        self.assertIn("## Panel & Synthesis", report)
        self.assertIn("`architect`", report)
        self.assertIn("`security`", report)
        self.assertIn("System architecture", report)
        self.assertIn("| 1200 |", report)
        self.assertIn("Synthesizer", report)
        self.assertIn("panel/master_spec.md", report)

    def test_chinese_panel_section(self) -> None:
        self._log_panel_events()
        self._register_plan()

        report = self._render(lang="zh")
        self.assertIn("## 专家会诊与综合", report)
        section = report.split("## 专家会诊与综合", 1)[1].split("\n## ", 1)[0]
        self.assertIn("`architect`", section)
        self.assertIn("panel/master_spec.md", section)
        self.assertRegex(section, _HAN_RE)

    def test_no_panel_report_is_byte_identical_to_baseline(self) -> None:
        baseline = _load_baseline_report()
        if baseline is None:
            self.skipTest(f"git baseline {_BASELINE_COMMIT} unavailable")
        self._log_common_events()
        self._register_plan()

        for lang in ("en", "zh"):
            with self.subTest(lang=lang):
                current = self._render(lang=lang)
                self.assertNotIn("Panel & Synthesis", current)
                self.assertNotIn("专家会诊与综合", current)
                self.assertEqual(current.encode("utf-8"), self._render(baseline.generate_battle_report, lang).encode("utf-8"))


if __name__ == "__main__":
    unittest.main()
