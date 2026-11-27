"""Lean small-task flow: a small Guided run whose RFC has a runnable check skips planning.

One model builds (critical_executor), one model reviews (the milestone review), the RFC's own
command lines are the milestone gate, and the final gate stays with a person. Anything else plans
exactly as before.
"""

from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

from tests.lineage_fixtures import LineageFixture
from vibebaton import engine as engine_module
from vibebaton.case_export import export_sanitized_case
from vibebaton.cli_runner import CLIResult
from vibebaton.config import HotReloadConfig
from vibebaton.db import StateStore
from vibebaton.engine import _SMALL_PROJECT_PLAN_RULES, OrchestrationEngine
from vibebaton.report import compute_run_telemetry, generate_battle_report
from vibebaton.schemas import PlanDAG, RunStatus

COMMANDS = ["git ls-files --error-unmatch greeting.txt", "git status --short"]
RFC = (
    "# Add a greeting\n\n"
    "## Goals\n\nAdd greeting.txt with one friendly line.\n\n"
    "## Constraints\n\n- Leave README.md unchanged.\n\n"
    "## Verification & Acceptance Criteria\n\n"
    "1. greeting.txt is committed.\n\n"
    "```bash\n" + "\n".join(COMMANDS) + "\n```\n"
)
# The same RFC with its check named only in prose: nothing the gate could run as written.
PROSE_RFC = RFC.split("```bash")[0] + "Run `git status --short` to check.\n"
PLANNER_HEADER = (
    "Convert the following Master RFC into a strict executable PlanDAG JSON.\n"
    "Write ONLY valid JSON (or save it to VIBEBATON_OUTPUT_FILE) matching keys:\n"
    "`rfc_version`, `complexity_tier`, `summary`, `milestones[{id, title, reviewer_role, gate_commands, "
    "tasks[{id, title, description, tier, assignee_role, reviewer_role, depends_on, allowed_paths, "
    "golden_example, acceptance_criteria, verify_cmd}]}]`.\n\n"
)
ROLES = ("tactical_planner", "critical_executor", "bulk_worker", "micro_orchestrator", "milestone_reviewer",
         "brainstorm_and_final_gate")
PLANNED = {
    "rfc_version": "v1", "complexity_tier": "S", "summary": "Planner fixture",
    "milestones": [{"id": "M1", "title": "Planned", "gate_commands": ["git status --short"], "tasks": [
        {"id": "M1T1", "title": "Planned task", "reviewer_role": "micro_orchestrator",
         "allowed_paths": ["greeting.txt"]},
    ]}],
}


def ok(text: str) -> CLIResult:
    return CLIResult(status="ok", exit_code=0, stdout=text, stderr="", duration_sec=0, command=["fake"])


class LeanFlowTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        self.fixture = LineageFixture()
        self.addCleanup(self.fixture.cleanup)
        self.repo = self.fixture.repo
        baton = self.repo / ".baton"
        baton.mkdir()
        self.rfc = baton / "00_RFC.md"
        self.rfc.write_text(RFC, encoding="utf-8")
        config = self.fixture.root / "config.json"
        config.write_text(json.dumps({
            "daemon": {"base_branch": "main", "dev_branch": "dev", "prevent_sleep_windows": False},
            "notifications": {"enabled": False}, "pricing": {"auto_sync": False},
            "policies": {"auto_resolve_merge_conflicts": False},
            "providers": {"fake": {"command": [sys.executable, "-c", "pass"]}},
            "roles": {role: {"provider": "fake", "model": "fake-model"} for role in ROLES},
        }), encoding="utf-8")
        self.store = StateStore(baton / "state.sqlite")
        self.engine = OrchestrationEngine(self.repo, HotReloadConfig(config), self.store)
        self.enterContext(patch("vibebaton.engine.pricing.trigger_background_pricing_sync"))
        self.enterContext(patch.object(self.engine, "_invoke_role", side_effect=self.invoke))
        real_gate = engine_module.run_gate_suite

        async def gate(commands: list[str], workdir: Path, timeout_sec: int = 600) -> object:
            self.gate_runs.append(list(commands))
            return await real_gate(commands, workdir=workdir, timeout_sec=timeout_sec)

        self.enterContext(patch("vibebaton.engine.run_gate_suite", side_effect=gate))
        self.calls: list[tuple[str, str]] = []  # (role, artifact key) of every model call
        self.prompts: dict[str, str] = {}
        self.workdirs: dict[str, Path] = {}
        self.gate_runs: list[list[str]] = []
        self.builds = True  # whether the build call writes greeting.txt

    async def invoke(self, **kwargs: object) -> tuple[CLIResult, str]:
        role, key = str(kwargs["role_name"]), str(kwargs["artifact_key"])
        self.calls.append((role, key))
        self.prompts[key] = str(kwargs["prompt"])
        self.workdirs[key] = Path(str(kwargs["workdir"]))
        if role == "tactical_planner":
            return ok(json.dumps(PLANNED)), "fake:fake-model"
        if role == "critical_executor":
            if self.builds or "_fix_" in key:
                (self.workdirs[key] / "greeting.txt").write_text("Hello!\n", encoding="utf-8")
            return ok("done"), "fake:fake-model"
        return ok(json.dumps({"verdict": "PASS", "summary": "OK"})), "fake:fake-model"

    def launch(self, size: str | None = "small", *, mode: str = "overnight", **selection: object) -> str:
        run_id = self.engine.create_run(self.rfc, mode=mode)
        if size is not None:
            lineup = {"roles": {}, "model_overrides": {}, "size": size}
            self.store.log_event(run_id, "guided_launch_selection",
                                 payload={"lineup": lineup, "preset": None, **selection})
        return run_id

    async def plan(self, run_id: str, rfc: str = RFC) -> PlanDAG:
        plan = await self.engine._ensure_plan(run_id, self.store.get_run(run_id), rfc, {})
        self.store.update_run_status(run_id, RunStatus.FAILED)  # free the repository for the next launch
        return plan

    def kinds(self, run_id: str) -> list[str]:
        return [event["kind"] for event in self.store.get_events(run_id, limit=-1)]

    def flows(self, run_id: str) -> list[dict]:
        return [json.loads(event["payload_json"]) for event in self.store.get_events(run_id, limit=-1)
                if event["kind"] == "plan_flow_selected"]

    async def test_plan_is_synthesized_from_the_run_rfc_snapshot(self) -> None:
        run_id = self.launch()
        snapshot = Path(self.store.get_run(run_id)["rfc_snapshot_path"]).read_text(encoding="utf-8")
        self.rfc.write_text("# Edited after launch\n\n## Verification\n\n```bash\nnpm test\n```\n", encoding="utf-8")
        status = await self.engine.execute_run(run_id)
        self.assertEqual(status, RunStatus.READY_FOR_FINAL_GATE, self.store.get_run(run_id)["summary"])

        plan_path = Path(self.store.get_run(run_id)["plan_path"])
        self.assertEqual(plan_path, self.repo / ".baton" / "runs" / run_id / "01_PLAN.dag.json")
        saved = json.loads(plan_path.read_text(encoding="utf-8"))
        self.assertEqual(PlanDAG.from_dict(saved).to_dict(), saved)
        (milestone,) = saved["milestones"]
        (task,) = milestone["tasks"]
        self.assertEqual(saved["summary"], "Add a greeting")
        self.assertEqual({key: milestone[key] for key in ("id", "title", "reviewer_role", "gate_commands")}, {
            "id": "M1", "title": "Add a greeting", "reviewer_role": "milestone_reviewer", "gate_commands": COMMANDS,
        })
        self.assertEqual({key: task[key] for key in (
            "id", "title", "tier", "assignee_role", "reviewer_role", "depends_on", "allowed_paths", "verify_cmd",
        )}, {
            "id": "T1", "title": "Add a greeting", "tier": "critical", "assignee_role": "critical_executor",
            "reviewer_role": None, "depends_on": [], "allowed_paths": [], "verify_cmd": None,
        })
        self.assertIn(snapshot, task["description"])
        self.assertTrue(all(f"`{command}`" in "\n".join(task["acceptance_criteria"]) for command in COMMANDS))
        self.assertNotIn("Edited after launch", plan_path.read_text(encoding="utf-8"))
        # The builder's prompt carries the whole RFC, since task prompts are built from the plan alone.
        self.assertIn("## Goals\n\nAdd greeting.txt", self.prompts["T1_exec_1"])
        self.assertEqual([(m["id"], m["status"]) for m in self.store.get_milestones(run_id)], [("M1", "PASSED")])
        self.assertEqual([(t["id"], t["status"]) for t in self.store.get_tasks(run_id)], [("T1", "PASSED")])

    async def test_lean_run_builds_once_gates_reviews_once_and_reaches_the_final_gate(self) -> None:
        run_id = self.launch()
        status = await self.engine.execute_run(run_id)
        run = self.store.get_run(run_id)
        self.assertEqual(status, RunStatus.READY_FOR_FINAL_GATE, run["summary"])
        # No planning call and no per-task review: one build, then exactly one milestone review.
        self.assertEqual(self.calls, [("critical_executor", "T1_exec_1"), ("milestone_reviewer", "milestone_M1_review_r0")])
        self.assertEqual(self.gate_runs, [COMMANDS])  # the RFC's command lines ran as the milestone gate
        self.assertEqual(self.flows(run_id), [{"flow": "lean", "reason": "small_rfc_has_verification"}])
        message = next(e["message"] for e in self.store.get_events(run_id, limit=-1) if e["kind"] == "plan_flow_selected")
        self.assertIn("Lean flow", message)
        kinds = self.kinds(run_id)
        self.assertLess(kinds.index("plan_flow_selected"), kinds.index("plan_registered"))
        self.assertLess(kinds.index("plan_registered"), kinds.index("plan_generated"))
        for kind in ("task_changes", "task_passed", "milestone_passed", "ready_for_final_gate"):
            self.assertIn(kind, kinds)
        for kind in ("plan_size_exceeded", "task_review_passed", "milestone_gate_failed"):
            self.assertNotIn(kind, kinds)
        # Same isolation and lineage as the full flow: the build ran in its own worktree, the whitelist
        # check reported the change, and the run branch holds the result.
        self.assertTrue(self.workdirs["T1_exec_1"].is_relative_to(self.engine._worktree_root()))
        changes = next(e for e in self.store.get_events(run_id, limit=-1) if e["kind"] == "task_changes")
        self.assertEqual(json.loads(changes["payload_json"])["changed_files"], ["greeting.txt"])
        self.assertEqual(run["result_sha"], self.fixture.git("rev-parse", f"baton/runs/{run_id}"))
        self.assertEqual(self.fixture.git("show", f"baton/runs/{run_id}:greeting.txt"), "Hello!")
        # Downstream readers need no planning call either.
        stages = compute_run_telemetry(self.store, run_id)["stages"]
        self.assertEqual([(stage["id"], stage["status"]) for stage in stages], [("PLANNING", "PASSED"), ("M1", "PASSED")])
        self.assertIn("Add a greeting", generate_battle_report(self.store, run_id))
        self.assertEqual(export_sanitized_case(self.store, run_id)["schema_version"], "baton-case/v1")

    async def test_a_failing_gate_uses_the_existing_milestone_fix_loop(self) -> None:
        self.builds = False  # the build misses the file; the RFC's own check catches it
        run_id = self.launch()
        status = await self.engine.execute_run(run_id)
        self.assertEqual(status, RunStatus.READY_FOR_FINAL_GATE, self.store.get_run(run_id)["summary"])
        self.assertEqual(self.calls, [
            ("critical_executor", "T1_exec_1"),
            ("critical_executor", "milestone_M1_fix_r1"),
            ("milestone_reviewer", "milestone_M1_review_r1"),
        ])
        self.assertEqual(self.gate_runs, [COMMANDS, COMMANDS])
        self.assertEqual(self.kinds(run_id).count("milestone_gate_failed"), 1)

    async def test_switch_off_no_command_or_panel_mode_uses_the_full_flow_unchanged(self) -> None:
        cases = (
            ("lean_flow_off", "overnight", {"lean_flow": False}, RFC),
            ("no_verification_command", "overnight", {}, PROSE_RFC),
            ("no_verification_command", "overnight", {"lean_flow": True}, PROSE_RFC),
            ("panel_mode", "panel", {}, RFC),
        )
        for reason, mode, selection, rfc in cases:
            with self.subTest(reason=reason, **selection):
                self.calls.clear()
                run_id = self.launch(mode=mode, **selection)
                plan = await self.plan(run_id, rfc)
                self.assertEqual(self.calls, [("tactical_planner", "plan_attempt_1")])
                # The small full flow of today: the size note, then the planner's plan without per-task review.
                self.assertEqual(self.prompts["plan_attempt_1"],
                                 PLANNER_HEADER + _SMALL_PROJECT_PLAN_RULES + f"# Master RFC\n\n{rfc}")
                self.assertEqual([t.id for m in plan.milestones for t in m.tasks], ["M1T1"])
                self.assertTrue(all(t.reviewer_role is None for m in plan.milestones for t in m.tasks))
                self.assertEqual(self.flows(run_id), [{"flow": "full", "reason": reason}])
                self.assertEqual(self.kinds(run_id)[-3:], ["plan_flow_selected", "plan_registered", "plan_generated"])

    async def test_runs_without_a_small_size_plan_exactly_as_before(self) -> None:
        for size in (None, "medium", "large"):
            with self.subTest(size=size):
                self.calls.clear()
                # The switch never turns the lean flow on: only the size selects it.
                run_id = self.launch(size) if size is None else self.launch(size, lean_flow=True)
                await self.plan(run_id)
                self.assertEqual(self.calls, [("tactical_planner", "plan_attempt_1")])
                self.assertEqual(self.prompts["plan_attempt_1"], PLANNER_HEADER + f"# Master RFC\n\n{RFC}")
                expected = ["run_created", "plan_registered", "plan_generated"]
                if size is not None:
                    expected.insert(1, "guided_launch_selection")
                self.assertEqual(self.kinds(run_id), expected)

    async def test_a_saved_plan_resumes_without_choosing_a_flow(self) -> None:
        plan_file = self.fixture.root / "plan.json"
        plan_file.write_text(json.dumps(PLANNED), encoding="utf-8")
        run_id = self.engine.create_run(self.rfc, plan_path=plan_file)
        lineup = {"roles": {}, "model_overrides": {}, "size": "small"}
        self.store.log_event(run_id, "guided_launch_selection", payload={"lineup": lineup, "preset": None})
        plan = await self.plan(run_id)
        self.assertEqual(plan.to_dict(), PlanDAG.from_dict(PLANNED).to_dict())
        self.assertEqual(self.calls, [])
        self.assertEqual(self.flows(run_id), [])


if __name__ == "__main__":
    unittest.main()
