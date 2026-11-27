"""Size-based team tiers, kept custom teams, strict panel recommendation, and size estimation."""

from __future__ import annotations

import unittest
from copy import deepcopy
from pathlib import Path

from vibebaton import model_catalog
from vibebaton.workflow_recommend import (
    build_readiness_snapshot,
    estimate_project_size,
    recommend_workflow,
    validate_launch_selection,
)

from tests.test_workflow_recommend import example_config, example_scan

ALL_READY = ("agy", "gemini", "claude", "codex", "dsh")
PLANNING_ROLES = ("brainstorm_and_final_gate", "tactical_planner")
EXECUTION_ROLES = ("micro_orchestrator", "bulk_worker", "visual", "research")


class SizeTierTests(unittest.TestCase):
    def setUp(self) -> None:
        self.cfg = example_config()
        self.snapshot = build_readiness_snapshot(Path("."), self.cfg, scan_result=example_scan(ALL_READY, http_key=True))
        # The team confirmed in step 1 without manual changes.
        self.confirmed = {k: deepcopy(v) for k, v in self.snapshot.default_lineup.items()}

    def test_small_medium_and_large_get_different_teams(self) -> None:
        small = recommend_workflow("small", self.snapshot, previous_lineup=self.confirmed)
        medium = recommend_workflow("medium", self.snapshot, previous_lineup=self.confirmed)
        large = recommend_workflow("large", self.snapshot, previous_lineup=self.confirmed)
        self.assertNotEqual(small.lineup["model_overrides"], medium.lineup["model_overrides"])
        self.assertEqual(medium.lineup["roles"], self.confirmed["roles"])
        self.assertEqual(medium.lineup["model_overrides"], self.confirmed["model_overrides"])
        self.assertEqual(large.lineup["model_overrides"], medium.lineup["model_overrides"])
        self.assertEqual((small.mode, medium.mode, large.mode), ("overnight", "overnight", "panel"))
        self.assertEqual((small.reason_code, medium.reason_code, large.reason_code),
                         ("small_eco", "medium_relay", "large_panel"))
        for result in (small, medium, large):
            self.assertNotIn("previous_lineup_preserved", result.explanation_codes)
            self.assertIsNone(result.preset)  # presets only ever reached the run log
            validate_launch_selection(result.mode, self.snapshot, lineup=result.lineup)

    def test_small_is_two_models_planning_shared_and_one_standard_worker(self) -> None:
        small = recommend_workflow("small", self.snapshot).lineup["model_overrides"]
        planning = {small[role] for role in PLANNING_ROLES}
        execution = {small[role] for role in EXECUTION_ROLES}
        self.assertEqual(len(planning), 1)
        self.assertEqual(len(execution), 1)
        self.assertNotEqual(planning, execution)
        worker = next(iter(execution))
        provider, model, effort = worker.partition(":")[0], *worker.partition(":")[2].rpartition("@")[::2]
        entry = next(m for m in self.snapshot.catalog if m["id"] == model)
        self.assertEqual(entry["cost_tier"], "standard")  # one worker carries more, so not the cheapest model
        self.assertIn(effort, ("", "minimal", "low", "medium", "high"))

    def test_default_team_matches_the_setup_step_recommendation(self) -> None:
        ready = [p.provider_id for p in self.snapshot.providers if p.provider_ready and p.credential_ready]
        lineup = recommend_workflow("medium", self.snapshot).lineup
        for role in ("brainstorm_and_final_gate", "tactical_planner", "micro_orchestrator", "bulk_worker"):
            pick = model_catalog.recommend_role_assignment(role, ready)
            self.assertEqual(lineup["model_overrides"][role], f"{pick['provider']}:{pick['model']}@{pick['effort']}", role)

    def test_a_customized_team_is_always_kept(self) -> None:
        custom = deepcopy(self.confirmed)
        custom["roles"]["bulk_worker"] = "claude_sub"
        custom["model_overrides"]["bulk_worker"] = "claude_sub:claude-opus-5-5@high"
        custom["customized"] = True
        for size in ("small", "medium", "large"):
            with self.subTest(size=size):
                result = recommend_workflow(size, self.snapshot, previous_lineup=custom)
                self.assertEqual(result.lineup, custom)
                self.assertEqual(result.reason_code, "custom_lineup_kept")
                self.assertEqual(result.explanation_codes[:2], ("size_from_model", "custom_lineup_kept"))

    def test_a_kept_custom_team_has_impossible_efforts_corrected_and_explained(self) -> None:
        custom = deepcopy(self.confirmed)
        custom["roles"]["bulk_worker"] = "dsh_opencode"
        custom["model_overrides"]["bulk_worker"] = "dsh_opencode:deepseek-v4.1-flash@medium"
        custom["customized"] = True
        result = recommend_workflow("medium", self.snapshot, previous_lineup=custom)
        self.assertEqual(result.reason_code, "custom_lineup_kept")
        # medium is not offered; low and high are equally near, so the cheaper low wins.
        self.assertEqual(result.lineup["model_overrides"]["bulk_worker"], "dsh_opencode:deepseek-v4.1-flash@low")
        self.assertIn("effort_adjusted", result.explanation_codes)
        self.assertEqual(result.effort_changes, ({
            "role": "bulk_worker", "before": "dsh_opencode:deepseek-v4.1-flash@medium",
            "after": "dsh_opencode:deepseek-v4.1-flash@low", "reason": "effort_adjusted",
        },))
        self.assertEqual(custom["model_overrides"]["bulk_worker"], "dsh_opencode:deepseek-v4.1-flash@medium")  # input untouched

    def test_panel_needs_every_panelist_but_launch_tolerates_missing_members(self) -> None:
        snapshot = build_readiness_snapshot(Path("."), self.cfg, scan_result=example_scan(("claude",), http_key=True))
        result = recommend_workflow("large", snapshot)
        self.assertEqual(result.mode, "overnight")
        self.assertEqual(result.reason_code, "large_relay")
        self.assertIn("panelist_not_ready", result.explanation_codes)
        self.assertEqual(result.missing_panelists, ("codex_sub",))
        # The engine skips a failed specialist, so an explicit panel launch is still allowed.
        validate_launch_selection("panel", snapshot)

    def test_reasons_are_size_then_arrangement_then_notes(self) -> None:
        snapshot = build_readiness_snapshot(Path("."), self.cfg, scan_result=example_scan(("claude",), http_key=False))
        result = recommend_workflow("large", snapshot, size_basis="estimated")
        self.assertEqual(result.explanation_codes[0], "size_estimated")
        self.assertEqual(result.explanation_codes[1], "large_relay")
        self.assertIn("synthesizer_credentials_missing", result.explanation_codes[2:])
        self.assertNotIn("size_defaulted_to_medium", result.explanation_codes)
        model = recommend_workflow("medium", self.snapshot, size_basis="model")
        self.assertEqual(model.explanation_codes, ("size_from_model", "medium_relay"))


class SizeEstimateTests(unittest.TestCase):
    @staticmethod
    def _rfc(goals: int, areas: int) -> str:
        goal_lines = "\n".join(f"- Goal {n}" for n in range(goals))
        area_lines = "\n".join(f"- `src/part{n}.py`" for n in range(areas)) or "- Implementation areas are chosen during planning."
        return (f"# T\n\n## Goals\n\nSummary.\n\n{goal_lines}\n\n## Constraints\n\n- Keep it.\n\n## Non-Goals\n\n- Later.\n\n"
                f"## Architecture & Deliverables\n\n{area_lines}\n\n## Verification & Acceptance Criteria\n\n1. Works.\n")

    def test_estimate_from_blueprint_content(self) -> None:
        self.assertEqual(estimate_project_size(self._rfc(2, 1), repo_is_empty=False), "small")
        self.assertEqual(estimate_project_size(self._rfc(4, 3), repo_is_empty=False), "medium")
        self.assertEqual(estimate_project_size(self._rfc(7, 2), repo_is_empty=False), "large")
        self.assertEqual(estimate_project_size(self._rfc(2, 7), repo_is_empty=False), "large")
        # Starting from an empty folder is never a small change.
        self.assertEqual(estimate_project_size(self._rfc(2, 1), repo_is_empty=True), "medium")
        # The placeholder area line is not a real deliverable; fenced code is ignored.
        fenced = self._rfc(1, 0).replace("1. Works.", "1. Works.\n\n```bash\n- not a bullet\n```")
        self.assertEqual(estimate_project_size(fenced, repo_is_empty=False), "small")
        self.assertEqual(estimate_project_size("", repo_is_empty=False), "medium")


if __name__ == "__main__":
    unittest.main()
