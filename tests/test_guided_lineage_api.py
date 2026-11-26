"""HTTP lineage contract: real Git commits and the in-process Guided server.

Golden path: main=A, run=A->B, revision=B->C. A revision preserves B as its
starting SHA; an external main commit is integrated and gated before approval.
"""

from __future__ import annotations

import json
import sys
from concurrent.futures import ThreadPoolExecutor
from http.client import HTTPMessage
from pathlib import Path
from typing import Any
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import Request, urlopen

# The editable install may point to the main checkout, not this worktree.
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from tests.test_guided_api import GuidedApiTestCase, _git
from vibebaton import web_server
from vibebaton.schemas import MilestoneSpec, PlanDAG, RunStatus, TaskSpec, TaskStatus


class TestGuidedLineageApi(GuidedApiTestCase):
    def _request(self, request: Request) -> tuple[int, HTTPMessage, Any]:
        # Real Git integration and multiple gate subprocesses can exceed the
        # short timeout used by the other in-process API tests.
        try:
            response = urlopen(request, timeout=30)
        except HTTPError as exc:
            response = exc
        with response:
            return response.status, response.headers, json.loads(response.read())

    def launch(self, key: str = "launch-1") -> str:
        status, body = self._post("/api/runs/start", {
            "rfc_markdown": "# RFC\n\nImplement the requested change.\n",
            "launch_request_id": key,
        })
        self.assertEqual(status, 201, body)
        return body["run_id"]

    def commit_run(self, run_id: str, filename: str, content: str) -> str:
        _git(self.repo, "checkout", "-q", f"baton/runs/{run_id}")
        (self.repo / filename).write_text(content, encoding="utf-8")
        _git(self.repo, "add", "-f", "--", filename)
        _git(self.repo, "commit", "-q", "-m", filename)
        sha = _git(self.repo, "rev-parse", "HEAD")
        _git(self.repo, "checkout", "-q", "main")
        self.store.set_run_result_sha(run_id, sha)
        self.store.update_run_status(run_id, RunStatus.READY_FOR_FINAL_GATE)
        return sha

    def revise(self, run_id: str) -> str:
        status, body = self._post(f"/api/runs/{run_id}/finalize", {
            "action": "revise", "note": "Adjust the result."
        })
        self.assertEqual(status, 200, body)
        return body["revision_run_id"]

    def register_gates(self, run_id: str, task_command: str, milestone_command: str) -> None:
        self.store.register_plan(run_id, PlanDAG(
            rfc_version="v1", complexity_tier="S", milestones=[MilestoneSpec(
                id="M1", title="Tests", gate_commands=[milestone_command], tasks=[
                    TaskSpec(id="M1-T1", title="Check result", description="Check result",
                             verify_cmd=task_command)
                ],
            )],
        ))

    def external_commit(self, filename: str = "external.txt", text: str = "external\n") -> str:
        (self.repo / filename).write_text(text, encoding="utf-8")
        _git(self.repo, "add", "--", filename)
        _git(self.repo, "commit", "-q", "-m", "external")
        return _git(self.repo, "rev-parse", "main")

    def test_idempotent_launch_is_atomic_across_concurrent_requests(self) -> None:
        payload = {"rfc_markdown": "# RFC\n", "launch_request_id": "repeat-key"}
        other = self.start_server(self._create_server())

        def launch_to(index: int) -> tuple[int, object]:
            base = self.base if index % 2 else other
            request = Request(base + "/api/runs/start", data=json.dumps(payload).encode(),
                              headers={"Content-Type": "application/json"}, method="POST")
            status, _, body = self._request(request)
            return status, body

        create_run = web_server.OrchestrationEngine.create_run
        committed_keys: list[str | None] = []

        def capture_key(engine: object, *args: object, **kwargs: object) -> str:
            run_id = create_run(engine, *args, **kwargs)
            committed_keys.append(self.store.get_run(run_id)["launch_request_id"])
            return run_id

        with patch.object(web_server.OrchestrationEngine, "create_run", capture_key):
            with ThreadPoolExecutor(max_workers=4) as pool:
                replies = list(pool.map(launch_to, range(4)))
        self.assertTrue(all(status in (200, 201) for status, _ in replies), replies)
        ids = {body["run_id"] for _, body in replies}
        self.assertEqual(len(ids), 1)
        self.assertEqual(committed_keys, ["repeat-key"])
        self.assertEqual(len(self.store.list_runs()), 1)
        self.assertEqual(len(self.spawn_calls), 1)
        row = self.store.get_run_by_launch_request_id("repeat-key")
        self.assertEqual(row["id"], ids.pop())
        self.assertEqual(row["start_sha"], _git(self.repo, "rev-parse", "main"))
        self.assertEqual(row["base_ref"], "main")
        status, duplicate = self._post("/api/runs/start", {"launch_request_id": "repeat-key"})
        self.assertEqual(status, 200, duplicate)
        self.assertEqual(duplicate["run_id"], row["id"])
        # Simulate a process stopping after the row insert but before indexing the key.
        with self.store._connect() as conn:
            conn.execute("UPDATE runs SET launch_request_id = NULL WHERE id = ?", (row["id"],))
        status, recovered = self._post("/api/runs/start", {"launch_request_id": "repeat-key"})
        self.assertEqual((status, recovered["run_id"]), (200, row["id"]))
        self.assertEqual(self.store.get_run_by_launch_request_id("repeat-key")["id"], row["id"])
        self.assertEqual(len(self.spawn_calls), 1)

    def test_launch_without_a_key_still_creates_a_lineage_run(self) -> None:
        status, body = self._post("/api/runs/start", {"rfc_markdown": "# RFC\n"})
        self.assertEqual(status, 201, body)
        run = self.store.get_run(body["run_id"])
        self.assertIsNone(run["launch_request_id"])
        self.assertEqual(run["start_sha"], _git(self.repo, "rev-parse", "main"))
        self.assertEqual(_git(self.repo, "rev-parse", f"baton/runs/{run['id']}"), run["start_sha"])

    def test_revision_and_superseded_routes(self) -> None:
        first = self.launch()
        a = _git(self.repo, "rev-parse", "main")
        b = self.commit_run(first, "first.txt", "B\n")
        revision = self.revise(first)
        row = self.store.get_run(revision)
        self.assertEqual((row["parent_run_id"], row["start_sha"], row["base_ref"]), (first, b, "main"))
        self.assertEqual(_git(self.repo, "rev-parse", f"baton/runs/{revision}"), b)
        self.assertEqual(self.store.get_run(first)["status"], "SUPERSEDED")
        self.assertIn("Adjust the result.", Path(row["rfc_path"]).read_text(encoding="utf-8"))
        c = self.commit_run(revision, "revision.txt", "C\n")
        self.assertNotEqual(a, c)
        for path, payload in (
            (f"/api/runs/{first}/control", {"action": "resume"}),
            (f"/api/runs/{first}/finalize", {"action": "approve"}),
            (f"/api/runs/{first}/finalize", {"action": "revise", "note": "Again"}),
            (f"/api/runs/{first}/resolve", {"decision": "approve"}),
        ):
            status, body = self._post(path, payload)
            self.assertEqual(status, 409, body)
            self.assertEqual(body["code"], "RUN_SUPERSEDED")
        snapshot = self._get(f"/api/runs/{revision}")[1]["run"]
        listing = self._get("/api/runs")[1]["runs"]
        for field in ("parent_run_id", "base_ref", "start_sha", "result_sha"):
            self.assertIn(field, snapshot)
            self.assertIn(field, next(item for item in listing if item["id"] == revision))

    def test_revision_creation_failure_preserves_parent_and_removes_preparation(self) -> None:
        first = self.launch()
        self.commit_run(first, "first.txt", "B\n")
        before = self.store.get_run(first)
        run_dirs = {path.name for path in (self.repo / ".baton" / "runs").iterdir()}
        with patch.object(web_server.OrchestrationEngine, "create_run", side_effect=ValueError("injected failure")):
            status, body = self._post(f"/api/runs/{first}/finalize", {"action": "revise", "note": "Fix it"})
        self.assertEqual((status, body.get("code")), (409, "RUN_STALE"), body)
        self.assertEqual(self.store.get_run(first), before)
        self.assertEqual(len(self.store.list_runs()), 1)
        self.assertEqual({path.name for path in (self.repo / ".baton" / "runs").iterdir()}, run_dirs)

    def test_drift_is_integrated_then_both_inherited_and_revision_gates_run(self) -> None:
        first = self.launch()
        b = self.commit_run(first, "first.txt", "B\n")
        command = 'python -c "from pathlib import Path; assert Path(\'external.txt\').read_text().strip() == \'external\'"'
        self.register_gates(first, command, command)
        revision = self.revise(first)
        self.assertEqual(self.store.get_run(revision)["start_sha"], b)
        self.commit_run(revision, "revision.txt", "C\n")
        external = self.external_commit()
        status, body = self._post(f"/api/runs/{revision}/finalize", {"action": "approve"})
        self.assertEqual(status, 200, body)
        head = _git(self.repo, "rev-parse", "main")
        self.assertEqual(body["merged_commit"], head)
        self.assertTrue(body["reintegrated"])
        self.assertEqual(len(body["gates"]), 2)
        self.assertTrue(all(gate["passed"] for gate in body["gates"]))
        self.assertEqual(_git(self.repo, "merge-base", "--is-ancestor", external, head), "")
        self.assertTrue((self.repo / "external.txt").is_file())
        self.assertTrue((self.repo / "first.txt").is_file())
        self.assertTrue((self.repo / "revision.txt").is_file())

    def test_gate_failure_and_conflict_do_not_move_main(self) -> None:
        first = self.launch()
        self.commit_run(first, "feature.txt", "run\n")
        self.register_gates(first, 'python -c "import sys; sys.exit(7)"', "")
        external = self.external_commit()
        status, body = self._post(f"/api/runs/{first}/finalize", {"action": "approve"})
        self.assertEqual(status, 409, body)
        self.assertEqual(body["code"], "GATE_FAILED")
        self.assertEqual(_git(self.repo, "rev-parse", "main"), external)
        self.assertEqual(self.store.get_run(first)["status"], "READY_FOR_FINAL_GATE")

    def test_new_main_commit_during_gates_is_never_discarded(self) -> None:
        first = self.launch()
        self.commit_run(first, "feature.txt", "B\n")
        self.external_commit()
        real_gate = web_server._gate_integrated_commit
        raced: list[str] = []

        def advance_main(*args: object, **kwargs: object) -> list[dict[str, object]]:
            result = real_gate(*args, **kwargs)
            raced.append(self.external_commit("race.txt", "race\n"))
            return result

        with patch.object(web_server, "_gate_integrated_commit", side_effect=advance_main):
            status, body = self._post(f"/api/runs/{first}/finalize", {"action": "approve"})
        self.assertEqual((status, body.get("code")), (409, "BASE_MOVED"), body)
        self.assertEqual(_git(self.repo, "rev-parse", "main"), raced[0])
        self.assertTrue((self.repo / "race.txt").is_file())
        self.assertFalse((self.repo / "feature.txt").exists())
        self.assertEqual(self.store.get_run(first)["status"], "READY_FOR_FINAL_GATE")

    def test_run_branch_change_at_ref_update_is_rejected_atomically(self) -> None:
        first = self.launch()
        b = self.commit_run(first, "feature.txt", "B\n")
        external = self.external_commit()
        move = web_server._move_base_ref

        def change_run(*args: object, **kwargs: object) -> None:
            _git(self.repo, "update-ref", f"refs/heads/baton/runs/{first}", external, b)
            move(*args, **kwargs)

        with patch.object(web_server, "_move_base_ref", side_effect=change_run):
            status, body = self._post(f"/api/runs/{first}/finalize", {"action": "approve"})
        self.assertEqual((status, body.get("code")), (409, "RUN_STALE"), body)
        self.assertEqual(_git(self.repo, "rev-parse", "main"), external)
        self.assertEqual(self.store.get_run(first)["status"], "READY_FOR_FINAL_GATE")

    def test_tracked_baton_edits_block_a_conflicting_checkout_before_ref_move(self) -> None:
        protected = self.repo / ".baton" / "protected.txt"
        protected.write_text("original\n", encoding="utf-8")
        _git(self.repo, "add", "-f", ".baton/protected.txt")
        _git(self.repo, "commit", "-q", "-m", "track protected file")
        first = self.launch()
        self.commit_run(first, ".baton/protected.txt", "run change\n")
        head = _git(self.repo, "rev-parse", "main")
        protected.write_text("local change\n", encoding="utf-8")
        status, body = self._post(f"/api/runs/{first}/finalize", {"action": "approve"})
        self.assertEqual(status, 409, body)
        self.assertEqual(_git(self.repo, "rev-parse", "main"), head)
        self.assertEqual(protected.read_text(encoding="utf-8"), "local change\n")

    def test_conflicts_are_structured_and_leave_main_untouched(self) -> None:
        first = self.launch()
        self.commit_run(first, "README.md", "run version\n")
        external = self.external_commit("README.md", "external version\n")
        status, body = self._post(f"/api/runs/{first}/finalize", {"action": "approve"})
        self.assertEqual((status, body.get("code")), (409, "INTEGRATION_CONFLICT"), body)
        self.assertIn("README.md", body["conflicts"])
        self.assertEqual(_git(self.repo, "rev-parse", "main"), external)
        self.assertEqual((self.repo / "README.md").read_text(encoding="utf-8"), "external version\n")

    def test_unmerged_rollback_reaches_exact_parent_or_root(self) -> None:
        first = self.launch()
        a = _git(self.repo, "rev-parse", "main")
        b = self.commit_run(first, "first.txt", "B\n")
        revision = self.revise(first)
        self.commit_run(revision, "revision.txt", "C\n")
        status, body = self._post(f"/api/runs/{revision}/rollback", {"mode": "revert_revision"})
        self.assertEqual(status, 200, body)
        self.assertEqual(body["restored_to"], b)
        self.assertEqual(_git(self.repo, "rev-parse", f"baton/runs/{revision}"), b)
        self.assertEqual(self.store.get_run(revision)["result_sha"], b)
        status, body = self._post(f"/api/runs/{revision}/rollback", {"mode": "abandon_all"})
        self.assertEqual(status, 200, body)
        self.assertEqual(body["restored_to"], a)
        self.assertEqual(_git(self.repo, "rev-parse", f"baton/runs/{revision}"), a)
        self.assertEqual(_git(self.repo, "rev-parse", "main"), a)

    def test_abandon_all_rewinds_directly_from_c_to_a(self) -> None:
        first = self.launch()
        a = _git(self.repo, "rev-parse", "main")
        self.commit_run(first, "first.txt", "B\n")
        revision = self.revise(first)
        c = self.commit_run(revision, "revision.txt", "C\n")
        status, body = self._post(f"/api/runs/{revision}/rollback", {"mode": "abandon_all"})
        self.assertEqual(status, 200, body)
        self.assertEqual(body["restored_to"], a)
        self.assertEqual(_git(self.repo, "rev-parse", f"baton/runs/{revision}"), a)
        event = self.store.get_events(revision, limit=-1)[-1]
        self.assertEqual(json.loads(event["payload_json"])["from_sha"], c)

    def test_rollback_refuses_when_merge_ancestry_cannot_be_verified(self) -> None:
        first = self.launch()
        self.commit_run(first, "first.txt", "B\n")
        revision = self.revise(first)
        c = self.commit_run(revision, "revision.txt", "C\n")
        real_git = web_server._git

        def failing_ancestry(repo: Path, *args: str) -> object:
            if args[:2] == ("merge-base", "--is-ancestor"):
                return None
            return real_git(repo, *args)

        with patch.object(web_server, "_git", side_effect=failing_ancestry):
            status, body = self._post(f"/api/runs/{revision}/rollback", {"mode": "abandon_all"})
        self.assertEqual((status, body.get("code")), (409, "GIT_ERROR"), body)
        self.assertEqual(_git(self.repo, "rev-parse", f"baton/runs/{revision}"), c)
        self.assertEqual(self.store.get_run(revision)["result_sha"], c)

    def test_merged_undo_refuses_after_new_commit_and_returns_guidance(self) -> None:
        first = self.launch()
        self.commit_run(first, "feature.txt", "B\n")
        status, approved = self._post(f"/api/runs/{first}/finalize", {"action": "approve"})
        self.assertEqual(status, 200, approved)
        external = self.external_commit()
        status, body = self._post(f"/api/runs/{first}/rollback", {"mode": "undo"})
        self.assertEqual((status, body.get("code")), (409, "MERGE_NOT_HEAD"), body)
        self.assertIn("git revert", body["guidance"])
        self.assertEqual(_git(self.repo, "rev-parse", "main"), external)
        self.assertEqual(self.store.get_run(first)["status"], "COMPLETED")

    def test_merged_undo_restores_premerge_head_including_external_commit(self) -> None:
        first = self.launch()
        self.commit_run(first, "feature.txt", "B\n")
        external = self.external_commit()
        status, approved = self._post(f"/api/runs/{first}/finalize", {"action": "approve"})
        self.assertEqual(status, 200, approved)
        status, body = self._post(f"/api/runs/{first}/rollback", {"mode": "undo"})
        self.assertEqual(status, 200, body)
        self.assertEqual(body["restored_to"], external)
        self.assertEqual(_git(self.repo, "rev-parse", "main"), external)
        self.assertTrue((self.repo / "external.txt").is_file())
        self.assertFalse((self.repo / "feature.txt").exists())

    def test_stop_and_replan_returns_failure_context(self) -> None:
        first = self.launch()
        sha = self.commit_run(first, "feature.txt", "B\n")
        self.register_gates(first, "", "")
        self.store.update_task(first, "M1-T1", status=TaskStatus.FAILED, last_error="test failure")
        status, body = self._post(f"/api/runs/{first}/stop-and-replan", {})
        self.assertEqual(status, 200, body)
        self.assertEqual(body["current_sha"], sha)
        self.assertEqual(body["last_errors"]["M1-T1"], "test failure")
        self.assertEqual(body["failed_tasks"][0]["id"], "M1-T1")
        self.assertEqual(self.store.get_run(first)["status"], "SUPERSEDED")
        status, body = self._post(f"/api/runs/{first}/request-changes", {"note": "Replan around the failure"})
        self.assertEqual(status, 200, body)
        revision = self.store.get_run(body["revision_run_id"])
        self.assertEqual((revision["parent_run_id"], revision["start_sha"]), (first, sha))

    def test_stop_timeout_remains_pending_and_blocks_resume(self) -> None:
        first = self.launch()
        self.store.update_run_status(first, RunStatus.RUNNING)
        status, body = self._post(f"/api/runs/{first}/stop-and-replan", {"timeout_sec": 0})
        self.assertEqual((status, body.get("code")), (409, "STOP_PENDING"), body)
        self.assertTrue(self.store.is_stop_requested(first))
        status, body = self._post(f"/api/runs/{first}/control", {"action": "resume"})
        self.assertEqual((status, body.get("code")), (409, "RUN_BUSY"), body)
        status, body = self._post(f"/api/runs/{first}/finalize", {"action": "revise", "note": "Wait"})
        self.assertEqual((status, body.get("code")), (409, "RUN_BUSY"), body)
        self.assertFalse((self.repo / ".baton" / "runs" / first / "revisions.md").exists())

    def test_changed_run_branch_is_rejected_as_stale(self) -> None:
        first = self.launch()
        self.commit_run(first, "feature.txt", "B\n")
        _git(self.repo, "checkout", "-q", f"baton/runs/{first}")
        (self.repo / "late.txt").write_text("late\n", encoding="utf-8")
        _git(self.repo, "add", "late.txt")
        _git(self.repo, "commit", "-q", "-m", "late")
        _git(self.repo, "checkout", "-q", "main")
        for path, payload in (("control", {"action": "resume"}), ("finalize", {"action": "approve"})):
            status, body = self._post(f"/api/runs/{first}/{path}", payload)
            self.assertEqual((status, body.get("code")), (409, "RUN_STALE"), body)
