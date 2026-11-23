"""Unit tests for run stage/model telemetry and bilingual battle reports."""

from __future__ import annotations

import tempfile
import time
import unittest
from pathlib import Path
from typing import Any
from unittest.mock import patch

from vibebaton.db import StateStore
from vibebaton.report import compute_run_telemetry, display_provider_name, generate_battle_report
from vibebaton.schemas import MilestoneSpec, PlanDAG, RunStatus, TaskSpec, TaskStatus, TaskTier


class TestReportTelemetry(unittest.TestCase):
    def setUp(self) -> None:
        self.repo = Path(self.enterContext(tempfile.TemporaryDirectory()))
        self.store = StateStore(self.repo / "state.sqlite")
        self.run_id = self.store.create_run(self.repo, self.repo / "rfc.md", run_id="run-telemetry-1")

    def _register_sample_plan(self) -> None:
        plan = PlanDAG(
            rfc_version="1.0",
            complexity_tier="medium",
            milestones=[
                MilestoneSpec(
                    id="M1",
                    title="Core Backend",
                    tasks=[
                        TaskSpec(id="M1-T1", title="Implement core", tier=TaskTier.CRITICAL, assignee_role="critical_executor"),
                        TaskSpec(id="M1-T2", title="Add worker helpers", tier=TaskTier.ROUTINE, assignee_role="bulk_worker"),
                    ],
                )
            ],
        )
        self.store.register_plan(self.run_id, plan)

    def _log_timed_event(self, created_at: float, kind: str, **fields: Any) -> None:
        with patch("vibebaton.db.time.time", return_value=created_at):
            self.store.log_event(self.run_id, kind, **fields)

    def test_dsh_provider_display_in_both_locales(self) -> None:
        for lang in ("en", "zh"):
            for provider in ("dsh_opencode", "dsh_deepseek"):
                with self.subTest(lang=lang, provider=provider):
                    self.assertEqual(display_provider_name(provider, lang), "DSH")

    def test_exact_role_completed_and_stage_telemetry_with_dsh_display(self) -> None:
        base_t = time.time() - 120.0
        with self.store._connect() as conn:
            conn.execute("UPDATE runs SET created_at = ? WHERE id = ?", (base_t, self.run_id))

        self.store.update_run_status(self.run_id, RunStatus.PLANNING)
        self.store.log_event(
            self.run_id,
            "role_invoked",
            actor="tactical_planner:fable@high",
            message="Invoking tactical_planner (claude_sub/fable@high)",
        )
        self.store.log_event(
            self.run_id,
            "role_completed",
            actor="tactical_planner:fable@high",
            message="Completed tactical_planner (claude_sub/fable@high) in 12.5s (ok)",
            payload={"role": "tactical_planner", "provider": "claude_sub", "model": "fable@high", "duration_sec": 12.5},
        )
        self._register_sample_plan()
        self.store.update_run_status(self.run_id, RunStatus.RUNNING)
        self.store.update_milestone(self.run_id, "M1", TaskStatus.RUNNING)
        self.store.update_task(self.run_id, "M1-T1", status=TaskStatus.PASSED, duration_sec=40.0)
        self.store.update_task(self.run_id, "M1-T2", status=TaskStatus.PASSED, duration_sec=25.0)
        self.store.log_event(
            self.run_id,
            "role_invoked",
            actor="bulk_worker:deepseek-v4.1-flash@max",
            task_id="M1-T2",
            milestone_id="M1",
            message="Invoking bulk_worker (dsh_opencode/deepseek-v4.1-flash@max)",
        )
        self.store.log_event(
            self.run_id,
            "role_completed",
            actor="bulk_worker:deepseek-v4.1-flash@max",
            task_id="M1-T2",
            milestone_id="M1",
            message="Completed bulk_worker (dsh_opencode/deepseek-v4.1-flash@max) in 25.0s (ok)",
            payload={
                "role": "bulk_worker",
                "provider": "dsh_opencode",
                "model": "deepseek-v4.1-flash@max",
                "duration_sec": 25.0,
            },
        )
        self.store.update_milestone(self.run_id, "M1", TaskStatus.PASSED)
        self.store.log_event(self.run_id, "milestone_passed", milestone_id="M1", message="Passed M1")
        self.store.update_run_status(self.run_id, RunStatus.COMPLETED)

        telemetry = compute_run_telemetry(self.store, self.run_id)
        self.assertGreaterEqual(telemetry["elapsed_sec"], 119.0)
        self.assertEqual([s["id"] for s in telemetry["stages"]], ["PLANNING", "M1"])
        self.assertEqual(telemetry["stages"][1]["task_sum_sec"], 65.0)

        models_by_role = {m["role"]: m for m in telemetry["models"]}
        self.assertEqual(models_by_role["bulk_worker"]["provider"], "dsh_opencode")
        self.assertEqual(models_by_role["bulk_worker"]["display_provider"], "DSH")
        self.assertEqual(models_by_role["bulk_worker"]["duration_sec"], 25.0)
        self.assertFalse(models_by_role["bulk_worker"]["estimated"])
        self.assertEqual(models_by_role["tactical_planner"]["duration_sec"], 12.5)
        self.assertEqual(
            round(sum(m["share_pct"] for m in telemetry["models"]), 1),
            100.0,
        )

        en_report = generate_battle_report(self.store, self.run_id, lang="en")
        self.assertIn("## Stage & Milestone Timing", en_report)
        self.assertIn("## Model Calls & Runtime", en_report)
        self.assertIn("| DSH | `deepseek-v4.1-flash@max` |", en_report)

        zh_report = generate_battle_report(self.store, self.run_id, lang="zh")
        self.assertIn("# VibeBaton 运行战报", zh_report)
        self.assertIn("## 分阶段耗时拆解", zh_report)
        self.assertIn("## 模型调用与耗时统计", zh_report)
        self.assertIn("| DSH | `deepseek-v4.1-flash@max` |", zh_report)
        self.assertIn("已完成", zh_report)
        self.assertNotIn("Why It Matters", zh_report)

    def test_report_formats_dsh_references_in_allocation_events(self) -> None:
        self.store.log_event(
            self.run_id,
            "task_allocated",
            payload={
                "task_id": "T1",
                "provider": "dsh_opencode",
                "model": "deepseek-v4.1-flash@low",
                "reason": "Selected dsh_opencode/deepseek-v4.1-flash@low",
                "budget_profile": "eco",
                "pinned": False,
            },
        )
        self.store.log_event(
            self.run_id,
            "task_step_up",
            payload={
                "task_id": "T1",
                "from": "dsh_opencode:deepseek-v4.1-flash@low",
                "to": "dsh_deepseek:deepseek-v4.1-flash@max",
                "attempt": 2,
            },
        )

        for lang in ("en", "zh"):
            with self.subTest(lang=lang):
                report = generate_battle_report(self.store, self.run_id, lang=lang)
                self.assertRegex(report, r"\| `T1` \| `?DSH`? \|")
                self.assertIn("Selected DSH/deepseek-v4.1-flash@low", report)
                self.assertIn("`DSH:deepseek-v4.1-flash@low` → `DSH:deepseek-v4.1-flash@max`", report)
                self.assertNotRegex(report, r"\bdsh_(?:opencode|deepseek)[/:]")

    def test_historical_fallback_estimates_durations_from_invoked_timestamps(self) -> None:
        self._register_sample_plan()
        self.store.update_run_status(self.run_id, RunStatus.RUNNING)
        self.store.log_event(
            self.run_id,
            "role_invoked",
            actor="bulk_worker:deepseek-v4.1-flash@max",
            task_id="M1-T2",
            milestone_id="M1",
            message="Invoking bulk_worker (dsh_opencode/deepseek-v4.1-flash@max)",
        )
        with self.store._connect() as conn:
            conn.execute(
                "UPDATE events SET created_at = created_at - 30.0 WHERE run_id = ? AND kind = 'role_invoked'",
                (self.run_id,),
            )
        self.store.log_event(
            self.run_id,
            "task_passed",
            actor="bulk_worker",
            task_id="M1-T2",
            milestone_id="M1",
            message="Task M1-T2 passed",
        )
        self.store.update_task(self.run_id, "M1-T2", status=TaskStatus.PASSED, duration_sec=30.0)

        telemetry = compute_run_telemetry(self.store, self.run_id)
        self.assertEqual(len(telemetry["models"]), 1)
        self.assertTrue(telemetry["models"][0]["estimated"])
        self.assertGreaterEqual(telemetry["models"][0]["duration_sec"], 29.0)

    def test_unplanned_pending_run_retains_legacy_top_level_keys(self) -> None:
        telemetry = compute_run_telemetry(self.store, self.run_id, now_ts=120.0)

        self.assertEqual(set(telemetry), {"elapsed_sec", "stages", "models", "billing"})

    def test_pending_run_with_registered_tasks_exposes_inactive_timings(self) -> None:
        self._register_sample_plan()

        telemetry = compute_run_telemetry(self.store, self.run_id, now_ts=120.0)

        self.assertEqual(telemetry["server_now"], 120.0)
        self.assertEqual(telemetry["task_timings"], {
            "M1-T1": {"duration_sec": 0.0, "started_at": None, "is_active": False},
            "M1-T2": {"duration_sec": 0.0, "started_at": None, "is_active": False},
        })

    def test_server_now_uses_snapshot_clock_to_millisecond_precision(self) -> None:
        self.store.update_run_status(self.run_id, RunStatus.RUNNING)

        with patch("vibebaton.report.time.time", return_value=123.4567):
            telemetry = compute_run_telemetry(self.store, self.run_id)

        self.assertEqual(telemetry["server_now"], 123.457)
        self.assertEqual(telemetry["task_timings"], {})

    def test_planning_stage_starts_at_run_creation(self) -> None:
        self.store.update_run_status(self.run_id, RunStatus.PLANNING)
        created_at = self.store.get_run(self.run_id)["created_at"]

        stage, = compute_run_telemetry(self.store, self.run_id, now_ts=created_at + 20)["stages"]

        self.assertEqual(stage["id"], "PLANNING")
        self.assertIs(stage["is_active"], True)
        self.assertEqual(stage["started_at"], created_at)
        self.assertEqual(stage["wall_sec"], 20.0)

    def test_milestone_stage_starts_at_its_first_event_while_active(self) -> None:
        self._register_sample_plan()
        self.store.update_run_status(self.run_id, RunStatus.RUNNING)
        self.store.update_milestone(self.run_id, "M1", TaskStatus.RUNNING)
        self._log_timed_event(110.125, "milestone_started", milestone_id="M1")
        self._log_timed_event(112.0, "task_passed", task_id="M1-T1", milestone_id="M1")

        planning, milestone = compute_run_telemetry(self.store, self.run_id, now_ts=120)["stages"]

        self.assertIs(planning["is_active"], False)
        self.assertIsNone(planning["started_at"])
        self.assertIs(milestone["is_active"], True)
        self.assertEqual(milestone["started_at"], 110.125)
        self.assertEqual(milestone["wall_sec"], 9.9)

    def test_model_anchor_uses_earliest_unpaired_invocation_still_running(self) -> None:
        self._register_sample_plan()
        self.store.update_run_status(self.run_id, RunStatus.RUNNING)
        self.store.update_task(self.run_id, "M1-T1", status=TaskStatus.RUNNING)
        self.store.update_task(self.run_id, "M1-T2", status=TaskStatus.RUNNING)
        actor = "bulk_worker:flash"
        self._log_timed_event(101.0, "role_invoked", actor=actor, task_id="M1-T1")
        self._log_timed_event(
            103.0, "role_completed", actor=actor, task_id="M1-T1", payload={"duration_sec": 2.0}
        )
        self._log_timed_event(108.0, "role_invoked", actor=actor, task_id="M1-T1")
        self._log_timed_event(105.0, "role_invoked", actor=actor, task_id="M1-T2")

        model, = compute_run_telemetry(self.store, self.run_id, now_ts=120)["models"]

        self.assertEqual(model["active_started_at"], 105.0)
        self.assertEqual(model["calls"], 3)
        self.assertEqual(model["duration_sec"], 29.0)

    def test_unpaired_invocation_with_legacy_end_event_has_no_live_anchor(self) -> None:
        self._register_sample_plan()
        self.store.update_run_status(self.run_id, RunStatus.RUNNING)
        self.store.update_task(self.run_id, "M1-T1", status=TaskStatus.RUNNING)
        self._log_timed_event(105.0, "role_invoked", actor="critical_executor:gpt", task_id="M1-T1")
        self._log_timed_event(107.0, "task_exec_error", task_id="M1-T1")
        self._log_timed_event(
            110.0, "role_completed", actor="micro_orchestrator:fable", task_id="M1-T1",
            payload={"duration_sec": 3.0},
        )

        telemetry = compute_run_telemetry(self.store, self.run_id, now_ts=120)

        self.assertEqual(
            {model["role"]: model["active_started_at"] for model in telemetry["models"]},
            {"critical_executor": None, "micro_orchestrator": None},
        )
        self.assertEqual(telemetry["task_timings"]["M1-T1"], {
            "duration_sec": 5.0, "started_at": None, "is_active": True,
        })

    def test_task_timings_prefer_recorded_duration_and_sum_fallback_work(self) -> None:
        self._register_sample_plan()
        self.store.update_run_status(self.run_id, RunStatus.RUNNING)
        self.store.update_task(self.run_id, "M1-T1", status=TaskStatus.PASSED, duration_sec=9.125)
        self.store.update_task(self.run_id, "M1-T2", status=TaskStatus.REVIEWING)
        self._log_timed_event(103.0, "role_invoked", actor="bulk_worker:flash", task_id="M1-T2")
        self._log_timed_event(
            105.0, "role_completed", actor="bulk_worker:flash", task_id="M1-T2", payload={"duration_sec": 2.0}
        )
        self._log_timed_event(
            106.0, "role_completed", actor="critical_executor:gpt", task_id="M1-T1",
            payload={"duration_sec": 5.0},
        )
        self._log_timed_event(110.25, "role_invoked", actor="micro_orchestrator:fable", task_id="M1-T2")

        telemetry = compute_run_telemetry(self.store, self.run_id, now_ts=120)

        self.assertEqual(telemetry["task_timings"], {
            "M1-T1": {"duration_sec": 9.125, "started_at": None, "is_active": False},
            "M1-T2": {"duration_sec": 11.75, "started_at": 110.25, "is_active": True},
        })

    def test_finished_run_clears_stale_stage_model_and_task_anchors(self) -> None:
        self._register_sample_plan()
        self.store.update_run_status(self.run_id, RunStatus.RUNNING)
        self.store.update_milestone(self.run_id, "M1", TaskStatus.RUNNING)
        self.store.update_task(self.run_id, "M1-T1", status=TaskStatus.COOLDOWN, duration_sec=7.5)
        self._log_timed_event(
            115.0, "role_invoked", actor="critical_executor:gpt", task_id="M1-T1", milestone_id="M1"
        )

        live = compute_run_telemetry(self.store, self.run_id, now_ts=120)
        self.assertIs(live["stages"][1]["is_active"], True)
        self.assertEqual(live["stages"][1]["started_at"], 115.0)
        self.assertEqual(live["models"][0]["active_started_at"], 115.0)
        self.assertEqual(live["task_timings"]["M1-T1"]["started_at"], 115.0)
        self.assertEqual(live["task_timings"]["M1-T2"], {
            "duration_sec": 0.0, "started_at": None, "is_active": False,
        })

        self.store.update_run_status(self.run_id, RunStatus.COMPLETED)
        finished = compute_run_telemetry(self.store, self.run_id, now_ts=125)

        self.assertEqual(finished["server_now"], 125.0)
        for stage in finished["stages"]:
            self.assertIs(stage["is_active"], False)
            self.assertIsNone(stage["started_at"])
        self.assertIsNone(finished["models"][0]["active_started_at"])
        self.assertEqual(finished["task_timings"], {
            "M1-T1": {"duration_sec": 7.5, "started_at": None, "is_active": False},
            "M1-T2": {"duration_sec": 0.0, "started_at": None, "is_active": False},
        })


if __name__ == "__main__":
    unittest.main()
