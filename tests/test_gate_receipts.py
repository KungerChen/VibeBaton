"""Every gate command the engine runs leaves one `gate_receipt` event.

Real engine and real git; only the model's answers are made up. A receipt says which gate ran the
command (task check or milestone gate here; the merge and final-approval gates are covered next to
their own tests), for which target, and how it exited.
"""

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
from vibebaton.evidence import derive_evidence, gate_receipts
from vibebaton.schemas import RunStatus

HAS_FILE = "git ls-files --error-unmatch greeting.txt"
CLEAN = "git status --short"
# A task check runs in the task worktree before the change is committed, so it looks at the file itself.
EXISTS = f'"{sys.executable}" -c "import os, sys; sys.exit(not os.path.exists(\'greeting.txt\'))"'
RFC = (
    "# Add a greeting\n\n"
    "## Goals\n\nAdd greeting.txt with one friendly line.\n\n"
    "## Verification & Acceptance Criteria\n\n"
    f"1. greeting.txt is committed: `{HAS_FILE}` exits with 0.\n"
    "2. The greeting reads well.\n\n"
    f"```bash\n{HAS_FILE}\n{CLEAN}\n```\n"
)
ROLES = ("tactical_planner", "critical_executor", "bulk_worker", "micro_orchestrator", "milestone_reviewer",
         "brainstorm_and_final_gate")


def ok(text: str) -> CLIResult:
    return CLIResult(status="ok", exit_code=0, stdout=text, stderr="", duration_sec=0, command=["fake"])


class GateReceiptEngineTests(unittest.IsolatedAsyncioTestCase):
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
        self.builds_on = "T1_exec_1"  # the call that writes greeting.txt

    async def invoke(self, **kwargs: object) -> tuple[CLIResult, str]:
        role, key = str(kwargs["role_name"]), str(kwargs["artifact_key"])
        if role == "critical_executor":
            if key == self.builds_on:
                (Path(str(kwargs["workdir"])) / "greeting.txt").write_text("Hello!\n", encoding="utf-8")
            return ok("done"), "fake:fake-model"
        return ok(json.dumps({"verdict": "PASS", "summary": "OK"})), "fake:fake-model"

    def receipts(self, run_id: str) -> list[dict]:
        return gate_receipts(self.store.get_events(run_id, limit=-1))

    def lean_run(self) -> str:
        run_id = self.engine.create_run(self.rfc, mode="overnight")
        lineup = {"roles": {}, "model_overrides": {}, "size": "small"}
        self.store.log_event(run_id, "guided_launch_selection", payload={"lineup": lineup, "preset": None})
        return run_id

    async def test_milestone_gate_commands_leave_one_receipt_each(self) -> None:
        run_id = self.lean_run()
        status = await self.engine.execute_run(run_id)
        self.assertEqual(status, RunStatus.READY_FOR_FINAL_GATE, self.store.get_run(run_id)["summary"])
        receipts = self.receipts(run_id)
        self.assertEqual([(r["scope"], r["target_id"], r["command"], r["exit_code"], r["passed"]) for r in receipts], [
            ("milestone", "M1", HAS_FILE, 0, True), ("milestone", "M1", CLEAN, 0, True),
        ])
        self.assertTrue(all(r["duration_sec"] >= 0 for r in receipts))
        rows = [event for event in self.store.get_events(run_id, limit=-1) if event["kind"] == "gate_receipt"]
        self.assertEqual({row["milestone_id"] for row in rows}, {"M1"})
        self.assertEqual([row["id"] for row in rows], [r["event_id"] for r in receipts])

        table = derive_evidence(RFC, self.store.get_events(run_id, limit=-1))
        self.assertEqual([(row["state"], row["result"]) for row in table["criteria"]],
                         [("receipt", "passed"), ("not_linked", None)])
        self.assertEqual([r["command"] for r in table["run_level_receipts"]], [CLEAN])

    async def test_a_failing_gate_command_leaves_a_failed_receipt_and_the_suite_stops_there(self) -> None:
        self.builds_on = "milestone_M1_fix_r1"  # the first build misses the file; the fix round adds it
        run_id = self.lean_run()
        status = await self.engine.execute_run(run_id)
        self.assertEqual(status, RunStatus.READY_FOR_FINAL_GATE, self.store.get_run(run_id)["summary"])
        receipts = self.receipts(run_id)
        self.assertEqual([(r["command"], r["passed"]) for r in receipts],
                         [(HAS_FILE, False), (HAS_FILE, True), (CLEAN, True)])
        failed = receipts[0]
        self.assertNotEqual(failed["exit_code"], 0)
        self.assertIn("greeting.txt", failed["output_tail"])
        # The criterion that cites the command shows its latest recorded result, with both receipts behind it.
        row = derive_evidence(RFC, self.store.get_events(run_id, limit=-1))["criteria"][0]
        self.assertEqual((row["result"], len(row["receipts"])), ("passed", 2))

    async def test_a_task_check_leaves_a_task_receipt(self) -> None:
        plan = {
            "rfc_version": "v1", "complexity_tier": "S", "summary": "Planned",
            "milestones": [{"id": "M1", "title": "Planned", "gate_commands": [], "tasks": [
                {"id": "M1T1", "title": "Write the greeting", "reviewer_role": None, "assignee_role": "critical_executor",
                 "allowed_paths": ["greeting.txt"], "verify_cmd": EXISTS},
            ]}],
        }
        plan_file = self.fixture.root / "plan.json"
        plan_file.write_text(json.dumps(plan), encoding="utf-8")
        self.builds_on = "M1T1_exec_1"
        run_id = self.engine.create_run(self.rfc, mode="overnight", plan_path=plan_file)
        status = await self.engine.execute_run(run_id)
        self.assertEqual(status, RunStatus.READY_FOR_FINAL_GATE, self.store.get_run(run_id)["summary"])
        self.assertEqual([(r["scope"], r["target_id"], r["command"], r["passed"]) for r in self.receipts(run_id)],
                         [("task", "M1T1", EXISTS, True)])
        (row,) = [event for event in self.store.get_events(run_id, limit=-1) if event["kind"] == "gate_receipt"]
        self.assertEqual((row["task_id"], row["milestone_id"]), ("M1T1", "M1"))

    async def test_a_plan_without_gate_commands_leaves_no_receipt_and_nothing_passes(self) -> None:
        plan = {
            "rfc_version": "v1", "complexity_tier": "S", "summary": "Planned",
            "milestones": [{"id": "M1", "title": "Planned", "gate_commands": [], "tasks": [
                {"id": "M1T1", "title": "Write the greeting", "reviewer_role": None, "assignee_role": "critical_executor",
                 "allowed_paths": ["greeting.txt"]},
            ]}],
        }
        plan_file = self.fixture.root / "plan.json"
        plan_file.write_text(json.dumps(plan), encoding="utf-8")
        self.builds_on = "M1T1_exec_1"
        run_id = self.engine.create_run(self.rfc, mode="overnight", plan_path=plan_file)
        status = await self.engine.execute_run(run_id)
        self.assertEqual(status, RunStatus.READY_FOR_FINAL_GATE, self.store.get_run(run_id)["summary"])
        self.assertEqual(self.receipts(run_id), [])
        table = derive_evidence(RFC, self.store.get_events(run_id, limit=-1))
        self.assertEqual(table["summary"]["passed"], 0)
        # The run changed greeting.txt, and criterion 1 names that file: neutral, never passed.
        self.assertEqual([(row["state"], row["result"]) for row in table["criteria"]],
                         [("files_only", None), ("not_linked", None)])


if __name__ == "__main__":
    unittest.main()
