"""Unit tests for merge-conflict telemetry counters and the bilingual conflict report section."""

from __future__ import annotations

import re
import tempfile
import unittest
from pathlib import Path

from vibebaton.db import StateStore
from vibebaton.report import compute_run_telemetry, generate_battle_report

_HAN_RE = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff]")


class TestReportConflicts(unittest.TestCase):
    def setUp(self) -> None:
        self.repo = Path(self.enterContext(tempfile.TemporaryDirectory()))
        self.store = StateStore(self.repo / "state.sqlite")
        self.run_id = self.store.create_run(self.repo, self.repo / "rfc.md", run_id="run-conflicts-1")

    def _log_conflict_events(self) -> None:
        self.store.log_event(
            self.run_id,
            "merge_conflict_detected",
            actor="micro_orchestrator:review-opus@high",
            task_id="M1-T1",
            message="Merge conflict detected in M1-T1",
            payload={"files": ["src/a.py"]},
        )
        self.store.log_event(
            self.run_id,
            "merge_conflict_detected",
            actor="micro_orchestrator:review-opus@high",
            task_id="M1-T2",
            message="Merge conflict detected in M1-T2",
            payload={"files": ["src/b.py"]},
        )
        self.store.log_event(
            self.run_id,
            "merge_conflict_resolved",
            actor="micro_orchestrator:review-opus@high",
            task_id="M1-T1",
            message="Auto-resolved merge conflict in M1-T1",
            payload={"files": ["src/a.py"], "attempts": 2},
        )
        self.store.log_event(
            self.run_id,
            "merge_conflict_failed",
            actor="micro_orchestrator:review-opus@high",
            task_id="M1-T2",
            message="Merge conflict in M1-T2 escalated for human resolution",
            payload={"files": ["src/b.py"]},
        )

    def _log_billing_event(self) -> None:
        self.store.log_event(
            self.run_id,
            "role_completed",
            actor="bulk_worker:deepseek-v4.1-flash@max",
            message="Completed bulk_worker (dsh_opencode/deepseek-v4.1-flash@max) in 5.0s (ok)",
            payload={"duration_sec": 5.0, "prompt_tokens": 10, "completion_tokens": 2, "cost_usd": 0.01},
        )

    def test_conflict_counters_and_bilingual_sections(self) -> None:
        self._log_billing_event()
        self._log_conflict_events()

        telemetry = compute_run_telemetry(self.store, self.run_id)

        self.assertEqual(
            telemetry["conflicts"],
            {"conflicts_detected": 2, "conflicts_auto_resolved": 1, "conflicts_failed": 1},
        )

        en_report = generate_battle_report(self.store, self.run_id, lang="en")
        before, heading, section = en_report.partition("## Merge Conflict Resolution\n")
        self.assertTrue(heading)
        self.assertIn("## Token Usage & Cost Breakdown", before)
        self.assertIn("- Detected: **2**", section)
        self.assertIn("- Auto-resolved: **1**", section)
        self.assertIn("- Escalated: **1**", section)
        self.assertNotRegex(section, _HAN_RE)

        zh_report = generate_battle_report(self.store, self.run_id, lang="zh")
        before, heading, section = zh_report.partition("## 合并冲突自动解决\n")
        self.assertTrue(heading)
        self.assertIn("## Token 与美元成本统计", before)
        self.assertIn("- 检测到的冲突：**2**", section)
        self.assertIn("- 自动解决：**1**", section)
        self.assertIn("- 升级人工处理：**1**", section)
        self.assertRegex(heading, _HAN_RE)
        self.assertNotIn("## Merge Conflict Resolution", zh_report)

    def test_no_conflict_events_keep_key_absent_and_report_bytes_unchanged(self) -> None:
        self.store.log_event(self.run_id, "mechanical_gate_caught")
        with self.store._connect() as conn:
            updated_at = float(
                conn.execute("SELECT updated_at FROM runs WHERE id = ?", (self.run_id,)).fetchone()["updated_at"]
            )

        telemetry = compute_run_telemetry(self.store, self.run_id)
        self.assertEqual(set(telemetry), {"elapsed_sec", "stages", "models", "billing"})
        self.assertNotIn("conflicts", telemetry)
        without_conflicts = generate_battle_report(self.store, self.run_id, lang="en")
        self.assertNotIn("## Merge Conflict Resolution", without_conflicts)

        self._log_conflict_events()
        self.assertNotEqual(generate_battle_report(self.store, self.run_id, lang="en"), without_conflicts)

        with self.store._connect() as conn:
            conn.execute(
                """
                DELETE FROM events
                WHERE run_id = ?
                  AND kind IN ('merge_conflict_detected', 'merge_conflict_resolved', 'merge_conflict_failed')
                """,
                (self.run_id,),
            )
            conn.execute("UPDATE runs SET updated_at = ? WHERE id = ?", (updated_at, self.run_id))

        self.assertEqual(generate_battle_report(self.store, self.run_id, lang="en"), without_conflicts)

    def test_single_failed_conflict_event_is_enough_to_expose_conflicts(self) -> None:
        self.store.log_event(self.run_id, "merge_conflict_failed", message="Escalated for human resolution")

        telemetry = compute_run_telemetry(self.store, self.run_id)

        self.assertEqual(
            telemetry["conflicts"],
            {"conflicts_detected": 0, "conflicts_auto_resolved": 0, "conflicts_failed": 1},
        )
        self.assertIn("## Merge Conflict Resolution", generate_battle_report(self.store, self.run_id, lang="en"))


if __name__ == "__main__":
    unittest.main()
