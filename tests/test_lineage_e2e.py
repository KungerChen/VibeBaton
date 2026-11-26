"""End-to-end lineage through HTTP, the engine, SQLite, and real Git.

The daemon spawner runs the actual engine in a thread; the only simulated
components are deterministic local model-provider processes. Every run uses
the normal planner, task worktree, gates, reviewer, and merge pipeline.
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
import threading
from concurrent.futures import ThreadPoolExecutor
from http.client import HTTPMessage
from pathlib import Path
from typing import Any
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import Request, urlopen

# An editable install can point at a different checkout.
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from tests.test_guided_api import GuidedApiTestCase, _git
from vibebaton.config import HotReloadConfig
from vibebaton.db import StateStore
from vibebaton.engine import OrchestrationEngine
from vibebaton.schemas import RunStatus


_MODEL_SCRIPT = r'''
import json
import os
import sys
from pathlib import Path

role = os.environ["VIBEBATON_ROLE"]
prompt = sys.stdin.read()
gate = (
    f'"{sys.executable}" -c "from pathlib import Path; p=Path(\'external.txt\'); '
    "print('EXTERNAL_PRESENT='+str(p.exists())); assert Path('work.txt').exists(); "
    "assert not p.exists() or p.read_text().strip() != 'reject'\""
)
if role == "tactical_planner":
    fail = "force-worker-failure" in prompt and "recover-after-failure" not in prompt
    print(json.dumps({
        "rfc_version": "v1", "complexity_tier": "S", "summary": "Lineage example",
        "milestones": [{"id": "M1", "title": "Work", "reviewer_role": "milestone_reviewer",
            "gate_commands": [gate], "tasks": [{
                "id": "T1", "title": "Write work", "description": "fail-worker" if fail else "Write result",
                "tier": "critical", "assignee_role": "critical_executor", "escalate_role": "critical_executor",
                "reviewer_role": None, "allowed_paths": ["work.txt"], "verify_cmd": gate,
            }]}],
    }))
elif role == "critical_executor":
    if "fail-worker" in prompt:
        print("intentional provider failure", file=sys.stderr)
        sys.exit(1)
    path = Path("work.txt")
    before = path.read_text(encoding="utf-8") if path.exists() else ""
    path.write_text(before + chr(ord("B") + len(before.splitlines())) + "\n", encoding="utf-8")
    print("work complete")
elif role == "milestone_reviewer":
    print(json.dumps({"verdict": "PASS", "summary": "Verified"}))
else:
    raise RuntimeError("Unexpected model role: " + role)
'''

_ACTIVE = ("PENDING", "PLANNING", "RUNNING", "PAUSED", "WAITING_HUMAN", "READY_FOR_FINAL_GATE")


class TestLineageEndToEnd(GuidedApiTestCase):
    """Exercise one repository with a database-enforced single active run."""

    def setUp(self) -> None:
        # Keep Git and the subprocess models independent of host Git config.
        self.enterContext(patch.dict(os.environ, {
            "GIT_CONFIG_GLOBAL": os.devnull, "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_COUNT": "0",
            "VIBEBATON_DISABLE_PRICING_SYNC": "1", "PYTHONUTF8": "1",
        }))
        self.threads: dict[str, threading.Thread] = {}
        self.outcomes: dict[str, RunStatus | BaseException] = {}
        super().setUp()
        script = self.repo / ".baton" / "model_stub.py"
        script.write_text(_MODEL_SCRIPT, encoding="utf-8")
        command = json.dumps([sys.executable, str(script)])
        self.config_path.write_text(
            '[daemon]\nbase_branch = "main"\ndev_branch = "dev"\nprevent_sleep_windows = false\n'
            '[notifications]\nenabled = false\n[pricing]\nauto_sync = false\n'
            '[policies]\nauto_resolve_merge_conflicts = false\n'
            f'[providers.fake]\ncommand = {command}\nprompt_via = "stdin"\n'
            + ''.join(f'[roles.{role}]\nprovider = "fake"\nmodel = "fake-model"\n'
                      for role in ("tactical_planner", "critical_executor", "milestone_reviewer")),
            encoding="utf-8",
        )
        self.server.loader.reload(force=True)
        statuses = ", ".join("'" + status + "'" for status in _ACTIVE)
        # Test-only triggers check every DB transition, not just polling snapshots.
        with self.store._connect() as conn:
            for operation in ("INSERT", "UPDATE"):
                conn.execute(
                    f"CREATE TRIGGER one_active_{operation.lower()} BEFORE {operation} ON runs "
                    f"WHEN NEW.status IN ({statuses}) AND EXISTS "
                    f"(SELECT 1 FROM runs WHERE repo_path = NEW.repo_path AND id != NEW.id "
                    f"AND status IN ({statuses})) "
                    "BEGIN SELECT RAISE(ABORT, 'more than one active run'); END"
                )

    def fake_spawner(self, repo_path: Path, config_path: Path, run_id: str) -> int:
        self.spawn_calls.append((repo_path, config_path, run_id))

        def run() -> None:
            try:
                engine = OrchestrationEngine(repo_path, HotReloadConfig(config_path),
                                             StateStore(repo_path / ".baton" / "state.sqlite"))
                self.outcomes[run_id] = asyncio.run(engine.execute_run(run_id))
            except BaseException as exc:
                self.outcomes[run_id] = exc

        thread = threading.Thread(target=run, daemon=True, name=f"engine-{run_id[-6:]}")
        self.threads[run_id] = thread
        thread.start()
        self.addCleanup(thread.join, timeout=30)
        return 4242

    def _request(self, request: Request) -> tuple[int, HTTPMessage, Any]:
        try:
            response = urlopen(request, timeout=60)
        except HTTPError as exc:
            response = exc
        with response:
            return response.status, response.headers, json.loads(response.read())

    def wait_for_run(self, run_id: str, status: RunStatus = RunStatus.READY_FOR_FINAL_GATE) -> dict[str, Any]:
        thread = self.threads[run_id]
        thread.join(timeout=60)
        self.assertFalse(thread.is_alive(), f"Engine did not settle: {run_id}")
        self.assertEqual(self.outcomes.get(run_id), status, self.store.get_run(run_id))
        row = self.store.get_run(run_id)
        self.assertEqual(row["status"], status.value)
        self.assert_single_active()
        return row

    def assert_single_active(self) -> None:
        runs = [row for row in self.store.list_runs() if row["status"] in _ACTIVE]
        self.assertLessEqual(len(runs), 1, runs)

    def launch(self, key: str = "initial", markdown: str = "# RFC\n\nImplement work.\n") -> str:
        status, body = self._post("/api/runs/start", {"rfc_markdown": markdown, "launch_request_id": key})
        self.assertEqual(status, 201, body)
        self.assert_single_active()
        return body["run_id"]

    def revise(self, parent: str, note: str) -> str:
        status, body = self._post(f"/api/runs/{parent}/request-changes", {"note": note})
        self.assertEqual(status, 200, body)
        child = body["revision_run_id"]
        row = self.store.get_run(child)
        self.assertEqual(row["parent_run_id"], parent)
        self.assertEqual(row["start_sha"], self.store.get_run(parent)["result_sha"])
        self.assertEqual(self.store.get_run(parent)["status"], "SUPERSEDED")
        self.assert_single_active()
        return child

    def assert_stale_parent(self, parent: str) -> None:
        for endpoint, payload in (("control", {"action": "resume"}),
                                  ("finalize", {"action": "approve"}),
                                  ("finalize", {"action": "revise", "note": "Too late"})):
            status, body = self._post(f"/api/runs/{parent}/{endpoint}", payload)
            self.assertEqual((status, body.get("code")), (409, "RUN_SUPERSEDED"), body)

    def external_commit(self, content: str, filename: str = "external.txt") -> str:
        (self.repo / filename).write_text(content, encoding="utf-8")
        _git(self.repo, "add", "--", filename)
        _git(self.repo, "commit", "-q", "-m", f"External {content.strip()}")
        return _git(self.repo, "rev-parse", "main")

    def test_rfc_acceptance_1_exact_revision_rollback_and_abandon(self) -> None:
        a = _git(self.repo, "rev-parse", "main")
        first = self.launch()
        first_row = self.wait_for_run(first)
        b = first_row["result_sha"]
        self.assertEqual(first_row["start_sha"], a)
        self.assertNotEqual(a, b)
        self.assertEqual(_git(self.repo, "show", f"{b}:work.txt"), "B")
        original = Path(first_row["rfc_snapshot_path"]).read_bytes()

        second = self.revise(first, "Add the C revision.")
        second_row = self.wait_for_run(second)
        c = second_row["result_sha"]
        self.assertNotEqual(b, c)
        self.assertEqual(_git(self.repo, "show", f"{c}:work.txt"), "B\nC")
        self.assertEqual(Path(first_row["rfc_snapshot_path"]).read_bytes(), original)
        self.assertIn("Add the C revision.", Path(second_row["rfc_snapshot_path"]).read_text(encoding="utf-8"))
        self.assert_stale_parent(first)

        status, body = self._post(f"/api/runs/{second}/rollback", {"mode": "revert_revision"})
        self.assertEqual((status, body.get("restored_to")), (200, b), body)
        self.assertEqual(_git(self.repo, "rev-parse", f"baton/runs/{second}"), b)
        self.assertEqual(self.store.get_run(second)["result_sha"], b)
        status, body = self._post(f"/api/runs/{second}/rollback", {"mode": "abandon_all"})
        self.assertEqual((status, body.get("restored_to")), (200, a), body)
        self.assertEqual(_git(self.repo, "rev-parse", f"baton/runs/{second}"), a)
        self.assertEqual(self.store.get_run(second)["result_sha"], a)
        self.assertEqual(_git(self.repo, "rev-parse", "main"), a)
        self.assert_single_active()

    def test_rfc_acceptance_2_external_main_is_reintegrated_and_gated(self) -> None:
        first = self.launch()
        b = self.wait_for_run(first)["result_sha"]
        second = self.revise(first, "First revision")
        c = self.wait_for_run(second)["result_sha"]
        third = self.revise(second, "Second revision")
        third_row = self.wait_for_run(third)
        d = third_row["result_sha"]
        self.assertEqual((third_row["start_sha"], _git(self.repo, "show", f"{d}:work.txt")), (c, "B\nC\nD"))
        self.assertNotEqual(b, c)
        self.assert_stale_parent(first)
        self.assert_stale_parent(second)

        rejected_head = self.external_commit("reject\n")
        status, rejected = self._post(f"/api/runs/{third}/finalize", {"action": "approve"})
        self.assertEqual((status, rejected.get("code")), (409, "GATE_FAILED"), rejected)
        self.assertTrue(any(not gate["passed"] for gate in rejected["gates"]))
        self.assertEqual(_git(self.repo, "rev-parse", "main"), rejected_head)
        self.assertEqual(self.store.get_run(third)["status"], "READY_FOR_FINAL_GATE")

        external = self.external_commit("accepted\n")
        status, approved = self._post(f"/api/runs/{third}/finalize", {"action": "approve"})
        self.assertEqual(status, 200, approved)
        self.assertTrue(approved["reintegrated"])
        self.assertEqual(len(approved["gates"]), 6)
        self.assertTrue(all(gate["passed"] and "EXTERNAL_PRESENT=True" in gate["stdout"]
                            for gate in approved["gates"]), approved["gates"])
        merged = _git(self.repo, "rev-parse", "main")
        self.assertEqual(approved["merged_commit"], merged)
        _git(self.repo, "merge-base", "--is-ancestor", external, merged)
        _git(self.repo, "merge-base", "--is-ancestor", d, merged)
        self.assertEqual((self.repo / "external.txt").read_text(encoding="utf-8"), "accepted\n")
        self.assertEqual((self.repo / "work.txt").read_text(encoding="utf-8"), "B\nC\nD\n")

        status, undone = self._post(f"/api/runs/{third}/rollback", {"mode": "undo"})
        self.assertEqual((status, undone.get("restored_to")), (200, external), undone)
        self.assertEqual(_git(self.repo, "rev-parse", "main"), external)
        self.assertEqual((self.repo / "external.txt").read_text(encoding="utf-8"), "accepted\n")
        self.assertFalse((self.repo / "work.txt").exists())
        self.assert_single_active()

    def test_abandon_directly_from_revision_result_to_root(self) -> None:
        a = _git(self.repo, "rev-parse", "main")
        first = self.launch()
        self.wait_for_run(first)
        second = self.revise(first, "Add the revision")
        c = self.wait_for_run(second)["result_sha"]
        status, body = self._post(f"/api/runs/{second}/rollback", {"mode": "abandon_all"})
        self.assertEqual((status, body.get("restored_to")), (200, a), body)
        self.assertNotEqual(c, a)
        self.assertEqual(_git(self.repo, "rev-parse", f"baton/runs/{second}"), a)
        self.assertEqual(self.store.get_run(second)["result_sha"], a)
        self.assertEqual(_git(self.repo, "rev-parse", "main"), a)
        self.assert_single_active()

    def test_merged_undo_rejects_a_main_that_moved_after_approval(self) -> None:
        run_id = self.launch()
        self.wait_for_run(run_id)
        status, approved = self._post(f"/api/runs/{run_id}/finalize", {"action": "approve"})
        self.assertEqual(status, 200, approved)
        later = self.external_commit("later\n")
        status, body = self._post(f"/api/runs/{run_id}/rollback", {"mode": "undo"})
        self.assertEqual((status, body.get("code")), (409, "MERGE_NOT_HEAD"), body)
        self.assertIn("git revert", body["guidance"])
        self.assertEqual(_git(self.repo, "rev-parse", "main"), later)
        self.assertEqual((self.repo / "work.txt").read_text(encoding="utf-8"), "B\n")
        self.assertEqual(self.store.get_run(run_id)["status"], "COMPLETED")
        self.assert_single_active()

    def test_duplicate_launch_request_id_starts_one_real_engine(self) -> None:
        payload = {"rfc_markdown": "# RFC\n", "launch_request_id": "duplicate"}
        with ThreadPoolExecutor(max_workers=4) as pool:
            replies = list(pool.map(lambda _: self._post("/api/runs/start", payload), range(4)))
        self.assertEqual(sorted(status for status, _ in replies), [200, 200, 200, 201], replies)
        run_ids = {body["run_id"] for _, body in replies}
        self.assertEqual(len(run_ids), 1)
        run_id = run_ids.pop()
        self.wait_for_run(run_id)
        self.assertEqual(len(self.spawn_calls), 1)
        self.assertEqual(len(self.store.list_runs()), 1)
        status, blocked = self._post("/api/runs/start", {
            "rfc_markdown": "# Another RFC\n", "launch_request_id": "another-key",
        })
        self.assertEqual((status, blocked.get("code")), (409, "RUN_BUSY"), blocked)
        self.assertEqual(len(self.store.list_runs()), 1)
        self.assertEqual(len(self.spawn_calls), 1)
        status, body = self._post("/api/runs/start", {"launch_request_id": "duplicate"})
        self.assertEqual((status, body.get("run_id")), (200, run_id), body)
        self.assertEqual(len(self.spawn_calls), 1)

    def test_stop_and_replan_after_real_worker_failure(self) -> None:
        a = _git(self.repo, "rev-parse", "main")
        failed = self.launch(markdown="# RFC\n\nforce-worker-failure\n")
        self.wait_for_run(failed, RunStatus.FAILED)
        status, context = self._post(f"/api/runs/{failed}/stop-and-replan", {})
        self.assertEqual(status, 200, context)
        self.assertEqual(context["current_sha"], a)
        self.assertEqual([task["id"] for task in context["failed_tasks"]], ["T1"])
        self.assertIn("intentional provider failure", context["last_errors"]["T1"])
        self.assertEqual(self.store.get_run(failed)["status"], "SUPERSEDED")
        self.assert_single_active()
        child = self.revise(failed, "recover-after-failure")
        row = self.wait_for_run(child)
        self.assertEqual(row["start_sha"], a)
        self.assertEqual(_git(self.repo, "show", f"{row['result_sha']}:work.txt"), "B")


if __name__ == "__main__":
    import unittest
    unittest.main()
