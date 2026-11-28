"""Unit tests for billing telemetry and the bilingual Token & Cost report section."""

from __future__ import annotations

import re
import tempfile
import unittest
from pathlib import Path

from vibebaton.db import StateStore
from vibebaton.report import compute_run_telemetry, generate_battle_report

_HAN_RE = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff]")


class TestReportBilling(unittest.TestCase):
    def setUp(self) -> None:
        self.repo = Path(self.enterContext(tempfile.TemporaryDirectory()))
        self.store = StateStore(self.repo / "state.sqlite")
        self.run_id = self.store.create_run(self.repo, self.repo / "rfc.md", run_id="run-billing-1")

    def _log_billing_events(self) -> None:
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
            payload={
                "role": "tactical_planner",
                "provider": "claude_sub",
                "model": "fable@high",
                "duration_sec": 12.5,
                "prompt_tokens": 1200,
                "completion_tokens": 300,
                "cached_tokens": 200,
                "cost_usd": 0.0142004,
            },
        )
        self.store.log_event(
            self.run_id,
            "role_completed",
            actor="bulk_worker:deepseek-v4.1-flash@max",
            message="Completed bulk_worker (dsh_opencode/deepseek-v4.1-flash@max) in 20.0s (ok)",
            payload={
                "role": "bulk_worker",
                "provider": "dsh_opencode",
                "model": "deepseek-v4.1-flash@max",
                "duration_sec": 20.0,
                "prompt_tokens": 3000,
                "completion_tokens": 800,
                "cached_tokens": 100,
                "cost_usd": 0.0201004,
            },
        )
        self._log_worker_completion(prompt_tokens=100, completion_tokens=30, cached_tokens=10, cost_usd=0.0000004)

    def _log_worker_completion(self, **usage: int | float | None) -> None:
        self.store.log_event(
            self.run_id,
            "role_completed",
            actor="bulk_worker:deepseek-v4.1-flash@max",
            message="Completed bulk_worker (dsh_opencode/deepseek-v4.1-flash@max) in 5.0s (ok)",
            payload={"duration_sec": 5.0, **usage},
        )

    def test_billing_totals_and_per_model_fields(self) -> None:
        self._log_billing_events()

        telemetry = compute_run_telemetry(self.store, self.run_id)

        self.assertEqual(set(telemetry), {"elapsed_sec", "stages", "models", "billing"})
        self.assertEqual(
            telemetry["billing"],
            {
                "total_prompt_tokens": 4300,
                "total_completion_tokens": 1130,
                "total_cached_tokens": 310,
                "total_tokens": 5430,
                "total_cost_usd": 0.034301,
                "has_exact_billing": True,
                "total_calls": 3,
                "reported_calls": 3,
            },
        )
        models_by_role = {model["role"]: model for model in telemetry["models"]}
        planner = models_by_role["tactical_planner"]
        self.assertEqual(planner["prompt_tokens"], 1200)
        self.assertEqual(planner["completion_tokens"], 300)
        self.assertEqual(planner["cost_usd"], 0.0142004)
        self.assertEqual(planner["duration_sec"], 12.5)
        self.assertFalse(planner["estimated"])
        worker = models_by_role["bulk_worker"]
        self.assertEqual(worker["calls"], 2)
        self.assertEqual(worker["prompt_tokens"], 3100)
        self.assertEqual(worker["completion_tokens"], 830)
        self.assertAlmostEqual(worker["cost_usd"], 0.0201008, places=10)
        self.assertEqual(worker["duration_sec"], 25.0)

    def test_reports_include_localized_token_cost_section(self) -> None:
        self._log_billing_events()
        self.store.log_event(
            self.run_id,
            "task_step_up",
            payload={"task_id": "M1-T1", "attempt": 1, "from": "flash@low", "to": "flash@high"},
        )

        en_report = generate_battle_report(self.store, self.run_id, lang="en")
        before, heading, section = en_report.partition("## Token Usage & Cost Breakdown\n")
        self.assertTrue(heading)
        self.assertIn("## Smart Allocation Summary", before)
        self.assertIn("| Model | Prompt tokens | Completion tokens | Cost USD |", section)
        self.assertIn("| `fable@high` | 1200 | 300 | $0.0142 |", section)
        self.assertIn("| **Total** | **4300** | **1130** | **$0.0343** |", section)
        self.assertNotRegex(section, _HAN_RE)

        zh_report = generate_battle_report(self.store, self.run_id, lang="zh")
        before, heading, section = zh_report.partition("## Token 与美元成本统计\n")
        self.assertRegex(heading, _HAN_RE)
        self.assertIn("## 智能配给摘要", before)
        self.assertIn("| 模型 | 输入 Token | 输出 Token | 美元成本 |", section)
        self.assertIn("| **合计** | **4300** | **1130** | **$0.0343** |", section)

    def test_no_token_payloads_yields_no_billing_and_no_section(self) -> None:
        self._log_worker_completion()
        self._log_worker_completion(prompt_tokens=0, completion_tokens=0, cached_tokens=0, cost_usd=None)
        self.store.log_event(self.run_id, "role_invoked", payload={"prompt_tokens": 100, "cost_usd": 1.0})

        telemetry = compute_run_telemetry(self.store, self.run_id)

        self.assertEqual(
            telemetry["billing"],
            {
                "total_prompt_tokens": 0,
                "total_completion_tokens": 0,
                "total_cached_tokens": 0,
                "total_tokens": 0,
                "total_cost_usd": None,
                "has_exact_billing": False,
                "total_calls": 3,
                "reported_calls": 0,
            },
        )
        for model in telemetry["models"]:
            self.assertEqual(model["prompt_tokens"], 0)
            self.assertEqual(model["completion_tokens"], 0)
            self.assertIsNone(model["cost_usd"])
        self.assertNotIn("## Token Usage & Cost Breakdown", generate_battle_report(self.store, self.run_id, lang="en"))
        self.assertNotIn("## Token 与美元成本统计", generate_battle_report(self.store, self.run_id, lang="zh"))

    def test_zero_cost_without_tokens_counts_and_missing_model_cost_stays_none(self) -> None:
        self._log_worker_completion()
        self.store.log_event(
            self.run_id, "role_completed", actor="tactical_planner:fable@high", payload={"cost_usd": 0.0},
        )

        telemetry = compute_run_telemetry(self.store, self.run_id)

        self.assertTrue(telemetry["billing"]["has_exact_billing"])
        self.assertEqual(telemetry["billing"]["total_tokens"], 0)
        self.assertEqual(telemetry["billing"]["total_cost_usd"], 0.0)
        models_by_role = {model["role"]: model for model in telemetry["models"]}
        self.assertIsNone(models_by_role["bulk_worker"]["cost_usd"])
        self.assertEqual(models_by_role["tactical_planner"]["cost_usd"], 0.0)
        self.assertIn("$0.0000", generate_battle_report(self.store, self.run_id, lang="en"))

    def test_cached_tokens_without_cost_trigger_billing(self) -> None:
        self._log_worker_completion(cached_tokens=25)

        billing = compute_run_telemetry(self.store, self.run_id)["billing"]
        self.assertTrue(billing["has_exact_billing"])
        self.assertEqual(billing["total_cached_tokens"], 25)
        self.assertEqual(billing["total_tokens"], 0)
        self.assertIsNone(billing["total_cost_usd"])
        self.assertIn("| **Total** | **0** | **0** | **—** |", generate_battle_report(self.store, self.run_id))

    def test_invalid_billing_values_do_not_trigger_billing(self) -> None:
        self._log_worker_completion(
            prompt_tokens=True, completion_tokens=float("inf"), cached_tokens=-2, cost_usd=float("nan"),
        )

        billing = compute_run_telemetry(self.store, self.run_id)["billing"]
        self.assertFalse(billing["has_exact_billing"])
        self.assertIsNone(billing["total_cost_usd"])

    def test_english_billing_section_escapes_cjk_model_names_and_table_pipes(self) -> None:
        self.store.log_event(
            self.run_id, "role_completed", actor="bulk_worker:模型|lite", payload={"prompt_tokens": 10},
        )

        en_report = generate_battle_report(self.store, self.run_id, lang="en")
        _, heading, section = en_report.partition("## Token Usage & Cost Breakdown\n")
        self.assertTrue(heading)
        self.assertNotRegex(section, _HAN_RE)
        self.assertIn(r"| `\u6a21\u578b\|lite` | 10 | 0 | — |", section)

    def test_counts_calls_and_how_many_reported_usage(self) -> None:
        self._log_billing_events()
        self._log_worker_completion()
        self.store.log_event(self.run_id, "role_invoked", actor="milestone_reviewer:sonnet@high")
        self.store.log_event(self.run_id, "panel_member_completed", payload={"tokens_in": 40, "tokens_out": 10})
        self.store.log_event(self.run_id, "panel_synthesized", payload={"tokens_in": 0, "tokens_out": 0})

        billing = compute_run_telemetry(self.store, self.run_id)["billing"]

        # Three role calls with usage, one without, one still running, and two panel calls (one reported).
        self.assertEqual((billing["total_calls"], billing["reported_calls"]), (7, 4))

    def test_report_totals_state_how_many_calls_reported_usage(self) -> None:
        self._log_billing_events()
        self._log_worker_completion()

        en_section = generate_battle_report(self.store, self.run_id, lang="en").partition(
            "## Token Usage & Cost Breakdown\n")[2]
        self.assertIn("| **Total** | **4300** | **1130** | **$0.0343** |\n\n3 of 4 calls reported usage.", en_section)
        self.assertNotRegex(en_section, _HAN_RE)
        zh_section = generate_battle_report(self.store, self.run_id, lang="zh").partition("## Token 与美元成本统计\n")[2]
        self.assertIn("| **合计** | **4300** | **1130** | **$0.0343** |\n\n4 次调用中 3 次上报了用量。", zh_section)

    def test_missing_cost_for_claude_medium_model_falls_back_to_pricing_table(self) -> None:
        self.store.log_event(
            self.run_id,
            "role_completed",
            actor="tactical_planner:claude-opus-5-5@medium",
            message="Completed tactical_planner (claude_sub/claude-opus-5-5@medium) in 9.0s (ok)",
            payload={
                "role": "tactical_planner",
                "provider": "claude_sub",
                "model": "claude-opus-5-5@medium",
                "duration_sec": 9.0,
                "prompt_tokens": 1_000_000,
                "completion_tokens": 100_000,
                "cached_tokens": 200_000,
            },
        )
        telemetry = compute_run_telemetry(self.store, self.run_id)
        self.assertIsNotNone(telemetry["billing"]["total_cost_usd"])
        self.assertAlmostEqual(telemetry["billing"]["total_cost_usd"], 5.24, places=4)
        planner = telemetry["models"][0]
        self.assertAlmostEqual(planner["cost_usd"], 5.24, places=4)


if __name__ == "__main__":
    unittest.main()
