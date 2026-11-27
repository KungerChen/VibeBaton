"""Guided project size reaches the planner: small projects get a lean plan without per-task review."""

from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

from tests.lineage_fixtures import LineageFixture
from vibebaton.cli_runner import CLIResult
from vibebaton.config import HotReloadConfig
from vibebaton.db import StateStore
from vibebaton.engine import OrchestrationEngine
from vibebaton.schemas import RunStatus

RFC = "# Tiny\n\n## Goals\n\nAdd work.txt.\n\n## Verification & Acceptance Criteria\n\n```bash\ngit status --short\n```\n"
ROLES = ("tactical_planner", "bulk_worker", "micro_orchestrator", "milestone_reviewer", "brainstorm_and_final_gate")


def plan(milestones: int = 1, tasks: int = 2) -> dict:
    return {
        "rfc_version": "v1", "complexity_tier": "S", "summary": "Fixture",
        "milestones": [
            {"id": f"M{m}", "title": f"Milestone {m}", "gate_commands": ["git status --short"], "tasks": [
                {"id": f"M{m}T{t}", "title": f"Task {t}", "reviewer_role": "micro_orchestrator",
                 "allowed_paths": [f"work{m}{t}.txt"], "verify_cmd": "git status --short"}
                for t in range(1, tasks + 1)
            ]}
            for m in range(1, milestones + 1)
        ],
    }


def ok(text: str) -> CLIResult:
    return CLIResult(status="ok", exit_code=0, stdout=text, stderr="", duration_sec=0, command=["fake"])


class ProjectSizePlanningTests(unittest.IsolatedAsyncioTestCase):
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
        self.prompts: list[str] = []
        self.roles: list[str] = []
        self.planned = plan()

    def launch(self, size: str | None) -> str:
        run_id = self.engine.create_run(self.rfc)
        if size is not None:
            lineup = {"roles": {}, "model_overrides": {}, "size": size}
            self.store.log_event(run_id, "guided_launch_selection", payload={"lineup": lineup, "preset": None})
        return run_id

    async def invoke(self, **kwargs: object) -> tuple[CLIResult, str]:
        role = str(kwargs["role_name"])
        self.roles.append(role)
        if role == "tactical_planner":
            self.prompts.append(str(kwargs["prompt"]))
            return ok(json.dumps(self.planned)), "fake:fake-model"
        if role == "bulk_worker":
            for name in json.loads(json.dumps(self.planned))["milestones"]:
                for task in name["tasks"]:
                    if task["id"] in str(kwargs.get("artifact_key", "")):
                        (Path(str(kwargs["workdir"])) / task["allowed_paths"][0]).write_text("work\n", encoding="utf-8")
            return ok("done"), "fake:fake-model"
        return ok(json.dumps({"verdict": "PASS", "summary": "OK"})), "fake:fake-model"

    async def plan_prompt(self, size: str | None) -> str:
        run_id = self.launch(size)
        run = self.store.get_run(run_id)
        with patch.object(self.engine, "_invoke_role", side_effect=self.invoke):
            await self.engine._ensure_plan(run_id, run, RFC, {})
        self.store.update_run_status(run_id, RunStatus.FAILED)  # free the repository for the next probe
        return self.prompts[-1]

    async def test_only_small_adds_the_lean_plan_section(self) -> None:
        baseline = await self.plan_prompt(None)
        # Byte-for-byte the prompt used before project sizes existed.
        self.assertEqual(baseline, (
            "Convert the following Master RFC into a strict executable PlanDAG JSON.\n"
            "Write ONLY valid JSON (or save it to VIBEBATON_OUTPUT_FILE) matching keys:\n"
            "`rfc_version`, `complexity_tier`, `summary`, `milestones[{id, title, reviewer_role, gate_commands, "
            "tasks[{id, title, description, tier, assignee_role, reviewer_role, depends_on, allowed_paths, "
            "golden_example, acceptance_criteria, verify_cmd}]}]`.\n\n"
            f"# Master RFC\n\n{RFC}"
        ))
        for size in ("medium", "large", "huge"):
            with self.subTest(size=size):
                self.assertEqual(await self.plan_prompt(size), baseline)
        small = await self.plan_prompt("small")
        self.assertNotEqual(small, baseline)
        self.assertTrue(small.endswith(f"# Master RFC\n\n{RFC}"))
        for phrase in ("1 milestone", "at most 4 tasks", "`reviewer_role` to null", "`gate_commands`"):
            self.assertIn(phrase, small)

    async def test_small_plan_drops_per_task_review_and_still_builds(self) -> None:
        run_id = self.launch("small")
        with patch.object(self.engine, "_invoke_role", side_effect=self.invoke):
            status = await self.engine.execute_run(run_id)
        self.assertEqual(status, RunStatus.READY_FOR_FINAL_GATE, self.store.get_run(run_id)["summary"])
        saved = json.loads(Path(self.store.get_run(run_id)["plan_path"]).read_text(encoding="utf-8"))
        self.assertEqual([t["reviewer_role"] for m in saved["milestones"] for t in m["tasks"]], [None, None])
        # Both tasks ran and passed with no per-task review call; the milestone review still ran.
        self.assertEqual(self.roles.count("bulk_worker"), 2)
        self.assertNotIn("micro_orchestrator", self.roles)
        self.assertIn("milestone_reviewer", self.roles)
        kinds = [event["kind"] for event in self.store.get_events(run_id, limit=-1)]
        self.assertNotIn("plan_size_exceeded", kinds)

    async def test_without_a_size_per_task_review_is_unchanged(self) -> None:
        run_id = self.launch(None)
        with patch.object(self.engine, "_invoke_role", side_effect=self.invoke):
            status = await self.engine.execute_run(run_id)
        self.assertEqual(status, RunStatus.READY_FOR_FINAL_GATE, self.store.get_run(run_id)["summary"])
        self.assertEqual(self.roles.count("micro_orchestrator"), 2)

    async def test_oversized_small_plan_runs_as_planned_and_is_noted(self) -> None:
        self.planned = plan(milestones=2, tasks=3)
        run_id = self.launch("small")
        with patch.object(self.engine, "_invoke_role", side_effect=self.invoke):
            parsed = await self.engine._ensure_plan(run_id, self.store.get_run(run_id), RFC, {})
        self.assertEqual(len(parsed.milestones), 2)  # never merged or trimmed
        self.assertEqual(sum(len(m.tasks) for m in parsed.milestones), 6)
        self.assertTrue(all(t.reviewer_role is None for m in parsed.milestones for t in m.tasks))
        notes = [e for e in self.store.get_events(run_id, limit=-1) if e["kind"] == "plan_size_exceeded"]
        self.assertEqual(len(notes), 1)
        self.assertIn("2 milestones", notes[0]["message"])
        self.assertIn("6 tasks", notes[0]["message"])


if __name__ == "__main__":
    unittest.main()
