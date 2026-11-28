"""HTTP contract of the three read-only evidence views of a run.

    GET /api/runs/<id>/handoffs              -> 200 {run_id, handoffs: [Handoff]}; 404 unknown run
    GET /api/runs/<id>/artifacts/<key>       -> 200 {run_id, artifact_key, prompt, output}
                                                (each {text, truncated, bytes} or null); 404 unknown run, or a
                                                key no `role_invoked` event of this run recorded
    GET /api/runs/<id>/evidence              -> 200 {run_id, rfc_available, criteria, run_level_receipts, summary};
                                                404 unknown run

They only read: events, plan rows, the run's RFC snapshot and the files behind a recorded artifact key.
"""

from __future__ import annotations

import sys
from pathlib import Path

# The editable install may point to the main checkout, not this worktree.
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from tests.test_guided_api import GuidedApiTestCase
from vibebaton.schemas import MilestoneSpec, PlanDAG, TaskSpec

CHECK = "python -m unittest discover -s tests"
RFC = (
    "# RFC\n\n## Goals\n\nAdd a greeting file for the people who open this folder.\n\n"
    "## Verification & Acceptance Criteria\n\n"
    f"1. `{CHECK}` passes.\n2. greeting.txt exists.\n3. It reads well.\n"
)


class EvidenceApiTests(GuidedApiTestCase):
    def launch(self) -> str:
        status, body = self._post("/api/runs/start", {"rfc_markdown": RFC, "launch_request_id": "evidence-1"})
        self.assertEqual(status, 201, body)
        run_id = body["run_id"]
        self.store.register_plan(run_id, PlanDAG(rfc_version="v1", complexity_tier="S", milestones=[MilestoneSpec(
            id="M1", title="Greeting", gate_commands=[CHECK], tasks=[
                TaskSpec(id="T1", title="Write it", description="Write it"),
            ],
        )]))
        return run_id

    def record(self, run_id: str) -> None:
        log = self.store.log_event
        log(run_id, "role_invoked", actor="critical_executor:gpt", task_id="T1", milestone_id="M1",
            payload={"artifact_key": "T1_exec_1"})
        log(run_id, "task_changes", task_id="T1", milestone_id="M1", payload={"changed_files": ["greeting.txt"]})
        log(run_id, "task_passed", task_id="T1", milestone_id="M1")
        log(run_id, "gate_receipt", milestone_id="M1", payload={
            "scope": "milestone", "target_id": "M1", "command": CHECK, "exit_code": 0, "passed": True,
            "duration_sec": 1.5, "output_tail": "OK",
        })
        run_dir = self.repo / ".baton" / "runs" / run_id
        (run_dir / "prompts").mkdir(parents=True, exist_ok=True)
        (run_dir / "out").mkdir(exist_ok=True)
        (run_dir / "prompts" / "T1_exec_1.md").write_text("Write greeting.txt", encoding="utf-8")
        (run_dir / "out" / "T1_exec_1.json").write_text("done", encoding="utf-8")
        (run_dir / "prompts" / "unrecorded.md").write_text("never invoked", encoding="utf-8")

    def test_handoffs_list_every_plan_edge_with_what_was_recorded(self) -> None:
        run_id = self.launch()
        self.record(run_id)
        status, body = self._get(f"/api/runs/{run_id}/handoffs")
        self.assertEqual(status, 200, body)
        self.assertEqual(body["run_id"], run_id)
        handoffs = {handoff["id"]: handoff for handoff in body["handoffs"]}
        self.assertEqual({key: value["recorded"] for key, value in handoffs.items()}, {
            "planner>task:T1": True, "task:T1>milestone:M1": True, "milestone:M1>final_gate": False,
        })
        self.assertEqual(handoffs["task:T1>milestone:M1"]["changed_files"], ["greeting.txt"])
        self.assertEqual(handoffs["planner>task:T1"]["invocations"][0]["artifact_key"], "T1_exec_1")
        self.assertEqual(handoffs["milestone:M1>final_gate"]["receipts"][0]["command"], CHECK)

    def test_artifact_returns_the_prompt_and_output_of_a_recorded_key_only(self) -> None:
        run_id = self.launch()
        self.record(run_id)
        status, body = self._get(f"/api/runs/{run_id}/artifacts/T1_exec_1")
        self.assertEqual(status, 200, body)
        self.assertEqual(body, {
            "run_id": run_id, "artifact_key": "T1_exec_1",
            "prompt": {"text": "Write greeting.txt", "truncated": False, "bytes": 18},
            "output": {"text": "done", "truncated": False, "bytes": 4},
        })
        (self.repo / ".baton" / "runs" / "secret.md").write_text("outside the run", encoding="utf-8")
        for key in ("unrecorded", "..%5Csecret", "..%2Fsecret", "%2E%2E%2Fsecret", "T1_exec_1.md", "00_RFC"):
            status, body = self._get(f"/api/runs/{run_id}/artifacts/{key}")
            self.assertEqual(status, 404, (key, body))
            self.assertNotIn("outside the run", str(body))

    def test_evidence_table_has_one_row_per_criterion_of_the_run_snapshot(self) -> None:
        run_id = self.launch()
        self.record(run_id)
        status, body = self._get(f"/api/runs/{run_id}/evidence")
        self.assertEqual(status, 200, body)
        self.assertEqual((body["run_id"], body["rfc_available"]), (run_id, True))
        self.assertEqual([(row["index"], row["state"], row["result"]) for row in body["criteria"]],
                         [(1, "receipt", "passed"), (2, "files_only", None), (3, "not_linked", None)])
        self.assertEqual(body["summary"], {"criteria": 3, "passed": 1, "failed": 0, "files_only": 1, "not_linked": 1,
                                           "receipts": 1})
        self.assertEqual(body["run_level_receipts"], [])

    def test_a_run_recorded_without_receipts_or_keys_opens_and_shows_nothing_as_passed(self) -> None:
        run_id = self.launch()
        log = self.store.log_event
        log(run_id, "role_invoked", actor="critical_executor:gpt", task_id="T1", milestone_id="M1")
        log(run_id, "task_passed", task_id="T1", milestone_id="M1")
        log(run_id, "milestone_passed", milestone_id="M1")
        status, evidence = self._get(f"/api/runs/{run_id}/evidence")
        self.assertEqual(status, 200, evidence)
        self.assertEqual(evidence["summary"]["passed"], 0)
        self.assertEqual({row["state"] for row in evidence["criteria"]}, {"not_linked"})
        status, body = self._get(f"/api/runs/{run_id}/handoffs")
        self.assertEqual(status, 200, body)
        self.assertTrue(all(handoff["receipts"] == [] for handoff in body["handoffs"]))
        self.assertEqual(body["handoffs"][0]["invocations"][0]["artifact_key"], None)

    def test_unknown_runs_are_404(self) -> None:
        for path in ("handoffs", "evidence", "artifacts/T1_exec_1"):
            status, body = self._get(f"/api/runs/missing/{path}")
            self.assertEqual(status, 404, body)
            self.assertIn("error", body)


if __name__ == "__main__":
    import unittest

    unittest.main()
