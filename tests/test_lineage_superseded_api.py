"""HTTP lineage contract: a superseded run rejects every mutating route.

Setup mirrors ``test_guided_lineage_api``: a real launch, a run-branch commit,
and a revision that supersedes the parent. Every documented mutation must
return 409/RUN_SUPERSEDED and leave the parent row and all Git refs unchanged.
"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Any

# The editable install may point to the main checkout, not this worktree.
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from tests.test_guided_api import GuidedApiTestCase, _git
from vibebaton.schemas import RunStatus

SUPERSEDED_REQUESTS: tuple[tuple[str, str, dict[str, Any]], ...] = (
    ("resume", "/control", {"action": "resume"}),
    ("finalize revise", "/finalize", {"action": "revise", "note": "Try again."}),
    ("finalize approve", "/finalize", {"action": "approve"}),
    ("finalize rollback", "/finalize", {"action": "rollback"}),
    ("request changes", "/request-changes", {"note": "Request another revision."}),
    ("rollback revert revision", "/rollback", {"mode": "revert_revision"}),
    ("rollback abandon all", "/rollback", {"mode": "abandon_all"}),
    ("rollback undo", "/rollback", {"mode": "undo"}),
    ("stop and replan", "/stop-and-replan", {}),
)


class TestLineageSupersededApi(GuidedApiTestCase):
    def launch(self) -> str:
        status, body = self._post("/api/runs/start", {
            "rfc_markdown": "# RFC\n\nImplement the requested change.\n",
            "launch_request_id": "superseded-launch",
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

    def superseded_run(self) -> str:
        run_id = self.launch()
        self.commit_run(run_id, "feature.txt", "B\n")
        status, body = self._post(f"/api/runs/{run_id}/finalize", {
            "action": "revise", "note": "Supersede the parent.",
        })
        self.assertEqual(status, 200, body)
        self.assertEqual(body["status"], "SUPERSEDED", body)
        self.assertIsNotNone(body["revision_run_id"])
        self.assertEqual(self.store.get_run(run_id)["status"], "SUPERSEDED")
        return run_id

    def refs(self) -> str:
        return _git(self.repo, "for-each-ref", "--format=%(refname) %(objectname)")

    def test_superseded_run_rejects_every_mutating_contract_route(self) -> None:
        run_id = self.superseded_run()
        before = self.store.get_run(run_id)
        self.assertIsNotNone(before)
        assert before is not None
        refs = self.refs()
        self.assertEqual(before["status"], "SUPERSEDED")
        for name, suffix, payload in SUPERSEDED_REQUESTS:
            with self.subTest(case=name):
                status, body = self._post(f"/api/runs/{run_id}{suffix}", payload)
                self.assertEqual(status, 409, body)
                self.assertIsInstance(body, dict, body)
                self.assertIsInstance(body.get("error"), str, body)
                self.assertEqual(body.get("code"), "RUN_SUPERSEDED", body)
                self.assertEqual(self.store.get_run(run_id), before)
                self.assertEqual(self.store.get_run(run_id)["status"], "SUPERSEDED")
                self.assertEqual(self.refs(), refs)
