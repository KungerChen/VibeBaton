"""Golden examples for engine lineage and safe replanning; no network required.

Work record 20261126-055904-m1-t3-engine-lineage (2026-11-26, PST).
Scope: M1-T3's allowed engine, graph engine, DB and test paths; branch
baton/e33e97/m1-t3 at base 07b4cb6. The new engine.create_run reserves the
repository, freezes RFC bytes, starts an isolated branch at the recorded SHA,
and atomically replaces a settled revision parent. Valid legacy creations
also freeze their RFC without changing their public rfc_path. The engine
records reviewable SHA and exposes terminal guards and bounded replan stop.
Stopping drains tracked work instead of cancelling potentially writing gates;
a failed run stopped for replan becomes SUPERSEDED and retains its summary.

The specified gate passed 25 tests after the final Git-failure check.
DB lineage (13), panel and notifications (49), guided API (90), guided/web
(160), allocation and conflict engine (36), and case export (39, one skipped)
also passed. The first guided/web attempt had 59 Git setup errors from inherited
Windows Git configuration; the repeat passed with test-process GIT_CONFIG_COUNT=0.
An allocation run initially had six failures because fake non-repository Git
could not resolve a result SHA. The compatibility path was corrected, real Git
missing-ref failure was separately checked, and the 36-test repeat passed.
These are offline tests using temp repositories, not user acceptance.

Status: self-tested, pending user acceptance. The legacy direct-create interface
still permits multiple queued legacy runs, as existing non-guided tests require;
lineage launch and execution reject conflicting reservations/executors. The
existing Web final-gate action does not call the new engine guard; it still
uses configured dev for approval and writes revision notes before its DB guard.
API wiring is outside this task's whitelist. Stale or untracked executors fail closed
and may require operator investigation. Project LOG/LOG-INDEX are outside the
whitelist. Rollback reference: the worktree diff from 07b4cb6; no commit made.
"""

from __future__ import annotations

import asyncio
import json
import sqlite3
import subprocess
import sys
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest.mock import AsyncMock, patch

from tests.lineage_fixtures import LineageFixture
from vibebaton.cli_runner import CLIResult
from vibebaton.config import HotReloadConfig
from vibebaton.db import StateStore
from vibebaton.engine import ActiveRunError, OrchestrationEngine, RunTerminalError, StopRunTimeoutError
from vibebaton.schemas import PlanDAG, RunStatus, TaskStatus


PLAN = {
    "rfc_version": "v1", "complexity_tier": "S", "summary": "Lineage fixture",
    "milestones": [{"id": "M1", "title": "Work", "tasks": [
        {"id": "T1", "title": "First", "allowed_paths": ["work.txt"]},
        {"id": "T2", "title": "Second", "depends_on": ["T1"], "allowed_paths": ["work.txt"]},
    ]}],
}


class EngineLineageCase(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        self.fixture = LineageFixture()
        self.addCleanup(self.fixture.cleanup)
        self.repo = self.fixture.repo
        self.baton = self.repo / ".baton"
        self.baton.mkdir()
        self.rfc = self.baton / "00_RFC.md"
        self.rfc.write_bytes(b"# First RFC\r\n\r\nOriginal bytes.\r\n")
        self.plan = self.fixture.root / "plan.json"
        self.plan.write_text(json.dumps(PLAN), encoding="utf-8")
        config = self.fixture.root / "config.json"
        config.write_text(json.dumps({"daemon": {"base_branch": "main", "dev_branch": "dev",
                                                  "prevent_sleep_windows": False},
                                      "notifications": {"enabled": False},
                                      "pricing": {"auto_sync": False}}), encoding="utf-8")
        self.store = StateStore(self.baton / "state.sqlite")
        self.engine = OrchestrationEngine(self.repo, HotReloadConfig(config), self.store)
        self.enterContext(patch("vibebaton.engine.pricing.trigger_background_pricing_sync"))

    def create(self, **kwargs: object) -> str:
        return self.engine.create_run(self.rfc, plan_path=self.plan, **kwargs)

    async def ready(self, run_id: str) -> RunStatus:
        with patch.object(self.engine, "_execute_milestone", AsyncMock(return_value=True)):
            return await self.engine.execute_run(run_id)

    async def test_snapshots_revision_and_reviewable_result_are_isolated(self) -> None:
        first_bytes = self.rfc.read_bytes()
        first = self.create()
        first_row = self.store.get_run(first)
        first_snapshot = self.baton / "runs" / first / "00_RFC.md"
        self.assertEqual(Path(first_row["rfc_path"]), first_snapshot)
        self.assertEqual(first_snapshot.read_bytes(), first_bytes)
        self.assertEqual((first_row["base_ref"], first_row["start_sha"]), ("main", self.fixture.initial_sha))
        branch = f"baton/runs/{first}"
        self.assertEqual(self.fixture.git("rev-parse", branch), self.fixture.initial_sha)
        self.fixture.git("checkout", branch)
        result_sha = self.fixture.add_commit("work.txt", "first result\n", "First result")
        self.fixture.git("checkout", "main")
        self.rfc.write_bytes(b"# Second RFC\nChanged after launch.\n")
        seen: list[str] = []

        async def capture(**kwargs: object) -> bool:
            seen.append(str(kwargs["rfc_text"]))
            return True

        with patch.object(self.engine, "_execute_milestone", side_effect=capture):
            self.assertEqual(await self.engine.execute_run(first), RunStatus.READY_FOR_FINAL_GATE)
        self.assertIn("Original bytes.", seen[0])
        self.assertNotIn("Changed after launch.", seen[0])
        self.assertEqual(self.store.get_run(first)["result_sha"], result_sha)
        second = self.create(parent_run_id=first)
        second_row = self.store.get_run(second)
        self.assertEqual(second_row["start_sha"], result_sha)
        self.assertEqual(self.fixture.git("rev-parse", f"baton/runs/{second}"), result_sha)
        self.assertEqual(self.store.get_run(first)["status"], RunStatus.SUPERSEDED)
        self.assertIsNotNone(self.store.get_run(first)["finished_at"])
        self.assertEqual(first_snapshot.read_bytes(), first_bytes)
        self.assertEqual(Path(second_row["rfc_path"]).read_bytes(), self.rfc.read_bytes())
        self.assertNotEqual(first_snapshot, Path(second_row["rfc_path"]))
        self.assertEqual(self.fixture.git("rev-parse", "main"), self.fixture.initial_sha)

    async def test_terminal_entry_points_change_nothing(self) -> None:
        run_id = self.create()
        self.store.mark_run_superseded(run_id)
        before = self.store.get_run(run_id)
        events = self.store.get_events(run_id, limit=-1)
        with self.assertRaises(RunTerminalError):
            await self.engine.execute_run(run_id)
        with self.assertRaises(RunTerminalError):
            await self.engine.resume_run(run_id)
        with self.assertRaises(RunTerminalError):
            self.engine.finalize_run(run_id)
        with self.assertRaises(RunTerminalError):
            self.store.update_run_status(run_id, RunStatus.RUNNING)
        self.assertEqual(self.store.get_run(run_id), before)
        self.assertEqual(self.store.get_events(run_id, limit=-1), events)
        for status in (RunStatus.FAILED, RunStatus.COMPLETED):
            other = self.store.create_run(self.repo, self.rfc)
            self.store.update_run_status(other, status)
            before = self.store.get_run(other)
            with self.assertRaises(RunTerminalError):
                await self.engine.resume_run(other)
            with self.assertRaises(RunTerminalError):
                self.engine.finalize_run(other)
            self.assertEqual(self.store.get_run(other), before)

    async def test_concurrent_launches_are_serialized_across_store_instances(self) -> None:
        barrier = threading.Barrier(2)

        def launch(_: int) -> object:
            engine = OrchestrationEngine(self.repo, self.engine.config_loader, StateStore(self.store.db_path))
            barrier.wait(timeout=10)
            try:
                return engine.create_run(self.rfc, plan_path=self.plan)
            except ActiveRunError as exc:
                return exc

        with ThreadPoolExecutor(max_workers=2) as pool:
            outcomes = list(pool.map(launch, range(2)))
        self.assertEqual(sum(isinstance(value, str) for value in outcomes), 1)
        self.assertEqual(sum(isinstance(value, ActiveRunError) for value in outcomes), 1)
        with self.assertRaises(ActiveRunError):
            self.store.create_run(self.repo, self.rfc)

    async def test_legacy_resume_cannot_overlap_a_new_lineage_run(self) -> None:
        legacy = self.store.create_run(self.repo, self.rfc)
        self.store.update_run_status(legacy, RunStatus.COMPLETED)
        self.create()
        # Existing rollback behavior may put an old run back into PAUSED.
        self.store.update_run_status(legacy, RunStatus.PAUSED)
        before = self.store.get_run(legacy)
        with self.assertRaises(ActiveRunError):
            await self.engine.resume_run(legacy)
        with self.assertRaises(ActiveRunError):
            self.store.update_run_status(legacy, RunStatus.RUNNING)
        with self.assertRaises(ActiveRunError):
            self.store.record_human_decision(legacy, "approve")
        self.assertEqual(self.store.get_run(legacy), before)

    async def test_failed_revision_creation_preserves_parent_and_existing_snapshot(self) -> None:
        first = self.create()
        self.assertEqual(await self.ready(first), RunStatus.READY_FOR_FINAL_GATE)
        before = self.store.get_run(first)
        with patch("vibebaton.engine.create_run_branch_at", side_effect=RuntimeError("branch failed")):
            with self.assertRaisesRegex(RuntimeError, "branch failed"):
                self.create(parent_run_id=first)
        self.assertEqual(self.store.get_run(first), before)
        self.assertEqual(len(self.store.list_runs()), 1)
        self.assertEqual((self.baton / "runs" / first / "00_RFC.md").read_bytes(), self.rfc.read_bytes())

    async def test_revision_insert_failure_rolls_back_parent_and_new_artifacts(self) -> None:
        first = self.create()
        self.assertEqual(await self.ready(first), RunStatus.READY_FOR_FINAL_GATE)
        before = self.store.get_run(first)
        with self.store._connect() as conn:
            conn.execute("CREATE TRIGGER reject_revision BEFORE INSERT ON runs WHEN NEW.parent_run_id IS NOT NULL "
                         "BEGIN SELECT RAISE(ABORT, 'injected insert failure'); END")
        with self.assertRaisesRegex(sqlite3.IntegrityError, "injected insert failure"):
            self.create(parent_run_id=first, run_id="rejected-child")
        self.assertEqual(self.store.get_run(first), before)
        self.assertIsNone(self.store.get_run("rejected-child"))
        self.assertFalse((self.baton / "runs" / "rejected-child" / "00_RFC.md").exists())
        with self.assertRaises(subprocess.CalledProcessError):
            self.fixture.git("rev-parse", "--verify", "refs/heads/baton/runs/rejected-child")

    async def test_fresh_run_uses_new_main_not_stale_dev_and_snapshot_is_never_replaced(self) -> None:
        first = self.create()
        snapshot = self.baton / "runs" / first / "00_RFC.md"
        original = snapshot.read_bytes()
        self.store.update_run_status(first, RunStatus.COMPLETED)
        self.fixture.git("branch", "dev", self.fixture.initial_sha)
        advanced = self.fixture.add_commit("manual.txt", "manual\n", "Advance main")
        self.rfc.write_text("# New RFC\n", encoding="utf-8")
        second = self.create()
        self.assertEqual(self.store.get_run(second)["start_sha"], advanced)
        self.assertEqual(self.fixture.git("rev-parse", f"baton/runs/{second}"), advanced)
        self.assertEqual(self.fixture.git("rev-parse", "dev"), self.fixture.initial_sha)
        self.assertEqual(snapshot.read_bytes(), original)
        self.store.update_run_status(second, RunStatus.COMPLETED)
        occupied = self.baton / "runs" / "existing" / "00_RFC.md"
        occupied.parent.mkdir(parents=True)
        occupied.write_bytes(b"Do not overwrite")
        with self.assertRaises(FileExistsError):
            self.create(run_id="existing")
        self.assertEqual(occupied.read_bytes(), b"Do not overwrite")

    async def test_missing_lineage_snapshot_never_falls_back_to_mutable_rfc(self) -> None:
        run_id = self.create()
        (self.baton / "runs" / run_id / "00_RFC.md").unlink()
        self.rfc.write_text("# Changed global RFC\n", encoding="utf-8")
        self.assertEqual(await self.engine.execute_run(run_id), RunStatus.FAILED)
        self.assertIn("RFC file missing", self.store.get_run(run_id)["summary"])

    async def test_real_repo_missing_result_branch_cannot_be_marked_ready(self) -> None:
        run_id = self.store.create_run(self.repo, self.rfc, plan_path=self.plan)
        async def remove_branch(**kwargs: object) -> bool:
            self.fixture.git("branch", "-D", "dev")
            return True
        with patch.object(self.engine, "_execute_milestone", side_effect=remove_branch):
            self.assertEqual(await self.engine.execute_run(run_id), RunStatus.FAILED)
        run = self.store.get_run(run_id)
        self.assertIsNone(run["result_sha"])
        self.assertIn("git rev-parse", run["summary"])

    async def test_lineage_pipeline_really_merges_into_run_branch(self) -> None:
        config = self.fixture.root / "live-engine.json"
        config.write_text(json.dumps({
            "daemon": {"base_branch": "main", "dev_branch": "dev", "prevent_sleep_windows": False},
            "notifications": {"enabled": False}, "pricing": {"auto_sync": False},
            "policies": {"auto_resolve_merge_conflicts": False},
            "providers": {"fake": {"command": [sys.executable, "-c", "pass"]}},
            "roles": {role: {"provider": "fake", "model": "fake-model"}
                      for role in ("bulk_worker", "milestone_reviewer")},
        }), encoding="utf-8")
        self.engine = OrchestrationEngine(self.repo, HotReloadConfig(config), self.store)
        plan = dict(PLAN)
        plan["milestones"] = [{"id": "M1", "title": "Work", "gate_commands": ["git status --short"],
                              "tasks": [{"id": "T1", "title": "Write work", "reviewer_role": None,
                                         "allowed_paths": ["work.txt"], "verify_cmd": "git status --short"}]}]
        self.plan.write_text(json.dumps(plan), encoding="utf-8")
        run_id = self.create()

        async def invoke(**kwargs: object) -> tuple[CLIResult, str]:
            role = str(kwargs["role_name"])
            if role == "bulk_worker":
                (Path(kwargs["workdir"]) / "work.txt").write_text("real work\n", encoding="utf-8")
                output = "done"
            else:
                output = json.dumps({"verdict": "PASS", "summary": "OK"})
            return CLIResult(status="ok", exit_code=0, stdout=output, stderr="", duration_sec=0, command=["fake"]), "fake:fake-model"

        with patch.object(self.engine, "_invoke_role", side_effect=invoke):
            self.assertEqual(await self.engine.execute_run(run_id), RunStatus.READY_FOR_FINAL_GATE,
                             self.store.get_run(run_id)["summary"])
        sha = self.store.get_run(run_id)["result_sha"]
        self.assertNotEqual(sha, self.fixture.initial_sha)
        self.assertEqual(sha, self.fixture.git("rev-parse", f"baton/runs/{run_id}"))
        self.assertEqual(self.fixture.git("show", f"{sha}:work.txt"), "real work")
        self.assertEqual(self.fixture.git("rev-parse", "main"), self.fixture.initial_sha)

    async def test_legacy_rfc_is_still_readable(self) -> None:
        run_id = self.store.create_run(self.repo, self.rfc, plan_path=self.plan)
        # Emulate a database row created before snapshot support existed.
        snapshot = Path(self.store.get_run(run_id)["rfc_snapshot_path"])
        with self.store._connect() as conn:
            conn.execute("UPDATE runs SET rfc_snapshot_path = NULL WHERE id = ?", (run_id,))
        snapshot.unlink()
        observed: list[str] = []
        async def capture(**kwargs: object) -> bool:
            observed.append(str(kwargs["rfc_text"]))
            return True
        with patch.object(self.engine, "_execute_milestone", side_effect=capture):
            self.assertEqual(await self.engine.execute_run(run_id), RunStatus.READY_FOR_FINAL_GATE)
        self.assertIn("Original bytes.", observed[0])

    async def test_legacy_create_snapshots_valid_rfc_and_fails_closed_if_it_disappears(self) -> None:
        first = self.store.create_run(self.repo, self.rfc, plan_path=self.plan)
        snapshot = Path(self.store.get_run(first)["rfc_snapshot_path"])
        original = snapshot.read_bytes()
        self.rfc.write_text("# Later global content\n", encoding="utf-8")
        second = self.store.create_run(self.repo, self.rfc, plan_path=self.plan)
        self.assertEqual(snapshot.read_bytes(), original)
        self.assertEqual(Path(self.store.get_run(second)["rfc_snapshot_path"]).read_bytes(), self.rfc.read_bytes())
        observed: list[str] = []
        async def capture(**kwargs: object) -> bool:
            observed.append(str(kwargs["rfc_text"]))
            return True
        with patch.object(self.engine, "_execute_milestone", side_effect=capture):
            self.assertEqual(await self.engine.execute_run(first), RunStatus.READY_FOR_FINAL_GATE)
        self.assertIn("Original bytes.", observed[0])
        snapshot2 = Path(self.store.get_run(second)["rfc_snapshot_path"])
        snapshot2.unlink()
        self.assertEqual(await self.engine.execute_run(second), RunStatus.FAILED)
        self.assertIn("RFC file missing", self.store.get_run(second)["summary"])

    async def test_stop_waits_for_task_writes_and_prevents_new_dispatch(self) -> None:
        run_id = self.create()
        entered = asyncio.Event()
        release = asyncio.Event()
        dispatched: list[str] = []

        async def worker(**kwargs: object) -> bool:
            spec = kwargs["spec"]
            dispatched.append(spec.id)
            entered.set()
            await release.wait()
            self.store.update_task(run_id, spec.id, status=TaskStatus.FAILED, last_error="late failure")
            return False

        with patch.object(self.engine, "_execute_task", side_effect=worker):
            runner = asyncio.create_task(self.engine.execute_run(run_id))
            await asyncio.wait_for(entered.wait(), 5)
            with self.assertRaises(ActiveRunError):
                self.store.mark_run_superseded(run_id)
            stopper = asyncio.create_task(self.engine.stop_run_for_replan(run_id, timeout_sec=5))
            for _ in range(100):
                if self.store.get_run(run_id)["status"] == RunStatus.PAUSED:
                    break
                await asyncio.sleep(0.01)
            self.assertFalse(stopper.done())
            release.set()
            context = await asyncio.wait_for(stopper, 5)
            await asyncio.wait_for(runner, 5)
        self.assertEqual(dispatched, ["T1"])
        self.assertEqual(self.store.get_run(run_id)["status"], RunStatus.SUPERSEDED)
        self.assertEqual([task["id"] for task in context["failed_tasks"]], ["T1"])
        self.assertEqual(context["last_errors"]["T1"], "late failure")
        self.assertEqual(context["current_sha"], self.fixture.initial_sha)
        self.assertFalse(any(task["status"] in ("RUNNING", "GATE_CHECKING", "REVIEWING", "COOLDOWN")
                             for task in self.store.get_tasks(run_id)))
        revision = self.create(parent_run_id=run_id)
        self.assertEqual(self.store.get_run(revision)["start_sha"], context["current_sha"])

    async def test_stop_timeout_keeps_request_and_blocks_restart_until_drained(self) -> None:
        run_id = self.create()
        entered, release = asyncio.Event(), asyncio.Event()
        async def worker(**kwargs: object) -> bool:
            entered.set()
            await release.wait()
            return True
        with patch.object(self.engine, "_execute_task", side_effect=worker):
            runner = asyncio.create_task(self.engine.execute_run(run_id))
            await asyncio.wait_for(entered.wait(), 5)
            with self.assertRaises(StopRunTimeoutError):
                await self.engine.stop_run_for_replan(run_id, timeout_sec=0.05)
            self.assertEqual(self.store.get_run(run_id)["status"], RunStatus.PAUSED)
            with self.assertRaises(ActiveRunError):
                self.create()
            with self.assertRaises(ActiveRunError):
                await self.engine.resume_run(run_id)
            with self.assertRaises(ActiveRunError):
                self.store.update_run_status(run_id, RunStatus.RUNNING)
            with self.assertRaises(ActiveRunError):
                self.store.mark_run_superseded(run_id)
            release.set()
            await asyncio.wait_for(runner, 5)
            context = await self.engine.stop_run_for_replan(run_id, timeout_sec=2)
        self.assertEqual(self.store.get_run(run_id)["status"], RunStatus.SUPERSEDED)
        self.assertEqual(context["current_sha"], self.fixture.initial_sha)

    async def test_failed_executor_is_settled_before_replan_revision(self) -> None:
        run_id = self.create()
        async def crash(**kwargs: object) -> bool:
            raise RuntimeError("worker crashed before task cleanup")
        with patch.object(self.engine, "_execute_task", side_effect=crash):
            self.assertEqual(await self.engine.execute_run(run_id), RunStatus.FAILED)
        self.assertEqual(self.store.get_task(run_id, "T1")["status"], TaskStatus.FAILED)
        context = await self.engine.stop_run_for_replan(run_id, timeout_sec=1)
        self.assertIn("worker crashed", context["last_errors"]["T1"])
        self.assertIn("worker crashed", context["run_summary"])
        self.assertEqual(self.store.get_run(run_id)["status"], RunStatus.SUPERSEDED)
        child = self.create(parent_run_id=run_id)
        self.assertEqual(self.store.get_run(child)["start_sha"], context["current_sha"])

    async def test_failed_run_still_blocks_new_runs_until_sibling_work_settles(self) -> None:
        parallel_plan = dict(PLAN)
        parallel_plan["milestones"] = [{"id": "M1", "title": "Parallel", "tasks": [
            {"id": "T1", "title": "Fail", "allowed_paths": ["work.txt"]},
            {"id": "T2", "title": "Finish late", "allowed_paths": ["work.txt"]},
        ]}]
        self.plan.write_text(json.dumps(parallel_plan), encoding="utf-8")
        run_id = self.create()
        entered, release = asyncio.Event(), asyncio.Event()

        async def worker(**kwargs: object) -> bool:
            task_id = kwargs["spec"].id
            if task_id == "T1":
                await entered.wait()
                raise RuntimeError("first task crashed")
            entered.set()
            await release.wait()
            self.store.update_task(run_id, task_id, status=TaskStatus.PASSED)
            return True

        with patch.object(self.engine, "_execute_task", side_effect=worker):
            runner = asyncio.create_task(self.engine.execute_run(run_id))
            await asyncio.wait_for(entered.wait(), 5)
            for _ in range(200):
                if self.store.get_run(run_id)["status"] == RunStatus.FAILED:
                    break
                await asyncio.sleep(0.01)
            self.assertEqual(self.store.get_run(run_id)["status"], RunStatus.FAILED)
            self.assertFalse(runner.done())
            with self.assertRaises(ActiveRunError):
                self.create()
            with self.assertRaises(ActiveRunError):
                self.store.create_run(self.repo, self.rfc)
            with self.assertRaises(StopRunTimeoutError):
                await self.engine.stop_run_for_replan(run_id, timeout_sec=0.05)
            with self.assertRaises(ActiveRunError):
                self.create()
            release.set()
            await asyncio.wait_for(runner, 5)
            context = await self.engine.stop_run_for_replan(run_id, timeout_sec=2)
        self.assertEqual(context["current_sha"], self.fixture.initial_sha)
        self.assertEqual(self.store.get_task(run_id, "T2")["status"], TaskStatus.PASSED)

    async def test_untracked_running_executor_cannot_be_declared_settled(self) -> None:
        run_id = self.create()
        self.store.update_run_status(run_id, RunStatus.RUNNING)
        with self.assertRaises(StopRunTimeoutError):
            await self.engine.stop_run_for_replan(run_id, timeout_sec=0.05)
        self.assertEqual(self.store.get_run(run_id)["status"], RunStatus.PAUSED)
        with self.assertRaises(ActiveRunError):
            await self.engine.resume_run(run_id)

    async def test_stop_waits_for_inflight_planning_before_returning(self) -> None:
        run_id = self.create()
        entered, release = asyncio.Event(), asyncio.Event()
        async def plan(*args: object) -> PlanDAG:
            entered.set()
            await release.wait()
            return PlanDAG.from_dict(PLAN)
        with patch.object(self.engine, "_ensure_plan", side_effect=plan), \
             patch.object(self.engine, "_execute_milestone", AsyncMock()) as milestone:
            runner = asyncio.create_task(self.engine.execute_run(run_id))
            await asyncio.wait_for(entered.wait(), 5)
            other = OrchestrationEngine(self.repo, self.engine.config_loader, StateStore(self.store.db_path))
            stopper = asyncio.create_task(other.stop_run_for_replan(run_id, timeout_sec=5))
            for _ in range(100):
                if self.store.get_run(run_id)["status"] == RunStatus.PAUSED:
                    break
                await asyncio.sleep(0.01)
            self.assertFalse(stopper.done())
            release.set()
            context = await asyncio.wait_for(stopper, 5)
            await asyncio.wait_for(runner, 5)
        milestone.assert_not_awaited()
        self.assertEqual(context["current_sha"], self.fixture.initial_sha)
        self.assertEqual(self.store.get_run(run_id)["status"], RunStatus.SUPERSEDED)


if __name__ == "__main__":
    unittest.main()
