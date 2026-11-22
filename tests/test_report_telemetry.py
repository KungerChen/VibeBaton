"""Unit tests for run stage/model telemetry and bilingual battle reports."""

from __future__ import annotations

import tempfile
import time
import unittest
from pathlib import Path

from vibebaton.db import StateStore
from vibebaton.report import compute_run_telemetry, generate_battle_report
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

    def test_exact_role_completed_and_stage_telemetry_with_deepseek_display(self) -> None:
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
        self.assertEqual(models_by_role["bulk_worker"]["display_provider"], "DeepSeek API")
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
        self.assertIn("DeepSeek API", en_report)

        zh_report = generate_battle_report(self.store, self.run_id, lang="zh")
        self.assertIn("# VibeBaton 运行战报", zh_report)
        self.assertIn("## 分阶段耗时拆解", zh_report)
        self.assertIn("## 模型调用与耗时统计", zh_report)
        self.assertIn("DeepSeek API", zh_report)
        self.assertIn("已完成", zh_report)
        self.assertNotIn("Why It Matters", zh_report)

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


if __name__ == "__main__":
    unittest.main()
