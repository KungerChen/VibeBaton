"""Recorded evidence: gate receipts, handoffs, artifacts and the three-state evidence table.

These views only repeat what the run's events say. The tests pin the rule that nothing is inferred:
no receipt means no pass, an unbacked handoff is not recorded, and a criterion is linked only by a
verbatim citation in its own text.
"""

from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

# An editable install can point at the main checkout rather than this worktree.
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from vibebaton import evidence

RFC = (
    "# Greeting\n\n"
    "## Goals\n\n1. This numbered goal is not an acceptance criterion.\n\n"
    "## Verification & Acceptance Criteria\n\n"
    "1. `python -m unittest discover -s tests` passes.\n"
    "2. greeting.txt holds one friendly line,\n   and nothing else changes.\n"
    "3. The page looks right to a person.\n"
    "4. Please make sure the build is clean.\n"
    "5. Run `make` and then npm --prefix web test.\n\n"
    "```bash\npython hello.py\n```\n"
)


def event(event_id: int, kind: str, payload: dict | None = None, **columns: object) -> dict:
    return {"id": event_id, "kind": kind, "payload_json": json.dumps(payload or {}), "created_at": 100.0 + event_id,
            "actor": "engine", "message": "", "task_id": None, "milestone_id": None, **columns}


def receipt(event_id: int, command: str, exit_code: int, scope: str = "milestone", target: str = "M1") -> dict:
    return event(event_id, "gate_receipt", {
        "scope": scope, "target_id": target, "command": command, "exit_code": exit_code,
        "passed": exit_code == 0, "duration_sec": 0.5, "output_tail": "out",
    })


class GateReceiptTests(unittest.TestCase):
    def test_payload_keeps_the_command_its_exit_code_and_a_bounded_output_tail(self) -> None:
        result = SimpleNamespace(command="python hello.py", exit_code=3, passed=False, duration_sec=1.23456,
                                 stdout="x" * 9000, stderr="boom\n")
        payload = evidence.receipt_payload("task", "T1", result)
        self.assertEqual({key: payload[key] for key in ("scope", "target_id", "command", "exit_code", "passed",
                                                        "duration_sec")},
                         {"scope": "task", "target_id": "T1", "command": "python hello.py", "exit_code": 3,
                          "passed": False, "duration_sec": 1.235})
        self.assertEqual(len(payload["output_tail"]), evidence.OUTPUT_TAIL_CHARS)
        self.assertTrue(payload["output_tail"].endswith("boom"))

    def test_receipts_are_read_from_events_and_pass_only_on_exit_code_zero(self) -> None:
        lying = event(3, "gate_receipt", {"scope": "task", "target_id": "T1", "command": "false", "exit_code": 1,
                                          "passed": True})
        events = [event(1, "task_changes"), receipt(2, "python hello.py", 0), lying,
                  event(4, "gate_receipt", {"command": "no exit code"})]
        self.assertEqual([(r["event_id"], r["command"], r["exit_code"], r["passed"]) for r in evidence.gate_receipts(events)],
                         [(2, "python hello.py", 0, True), (3, "false", 1, False)])
        self.assertEqual(evidence.gate_receipts([event(1, "milestone_passed")]), [])


class AcceptanceCriteriaTests(unittest.TestCase):
    def test_numbered_items_of_the_acceptance_section_with_their_continuation_lines(self) -> None:
        criteria = evidence.acceptance_criteria(RFC)
        self.assertEqual([c["index"] for c in criteria], [1, 2, 3, 4, 5])
        self.assertEqual(criteria[1]["text"], "greeting.txt holds one friendly line, and nothing else changes.")
        # A fenced block is not part of any criterion's own text.
        self.assertNotIn("hello.py", " ".join(c["text"] for c in criteria))
        self.assertEqual(evidence.acceptance_criteria("# No sections\n\n1. Not a criterion.\n"), [])


class EvidenceTableTests(unittest.TestCase):
    def rows(self, events: list[dict]) -> dict:
        return evidence.derive_evidence(RFC, events)

    def test_three_states_and_only_receipts_count(self) -> None:
        table = self.rows([
            event(1, "task_changes", {"changed_files": ["greeting.txt", "docs/notes.md"]}, task_id="T1"),
            receipt(2, "python -m unittest discover -s tests", 0),
            receipt(3, "python hello.py", 0),
        ])
        self.assertEqual([(row["index"], row["state"], row["result"]) for row in table["criteria"]], [
            (1, "receipt", "passed"), (2, "files_only", None), (3, "not_linked", None), (4, "not_linked", None),
            (5, "not_linked", None),
        ])
        self.assertEqual(table["criteria"][0]["receipts"][0]["event_id"], 2)
        self.assertEqual(table["criteria"][1]["files"], ["greeting.txt"])
        # The command of the fenced block is cited by no criterion: it stays a run-level receipt.
        self.assertEqual([r["command"] for r in table["run_level_receipts"]], ["python hello.py"])
        self.assertEqual(table["summary"], {"criteria": 5, "passed": 1, "failed": 0, "files_only": 1, "not_linked": 3,
                                            "receipts": 2})
        self.assertTrue(table["rfc_available"])

    def test_a_failed_receipt_is_failed_and_the_latest_receipt_of_a_command_decides(self) -> None:
        command = "python -m unittest discover -s tests"
        failed = self.rows([receipt(1, command, 1)])
        self.assertEqual((failed["criteria"][0]["state"], failed["criteria"][0]["result"]), ("receipt", "failed"))
        self.assertEqual(failed["summary"]["passed"], 0)
        fixed = self.rows([receipt(1, command, 1), receipt(2, command, 0)])
        self.assertEqual(fixed["criteria"][0]["result"], "passed")
        self.assertEqual([r["event_id"] for r in fixed["criteria"][0]["receipts"]], [1, 2])
        broken = self.rows([receipt(1, command, 0), receipt(2, command, 2)])
        self.assertEqual(broken["criteria"][0]["result"], "failed")

    def test_every_cited_command_must_pass(self) -> None:
        table = self.rows([receipt(1, "make", 0), receipt(2, "npm --prefix web test", 5)])
        row = table["criteria"][4]
        self.assertEqual((row["state"], row["result"], len(row["receipts"])), ("receipt", "failed", 2))

    def test_a_one_word_command_is_cited_only_as_inline_code(self) -> None:
        table = self.rows([receipt(1, "make", 0)])
        # Criterion 4 says "make sure" in prose; only criterion 5 writes `make`.
        self.assertEqual([row["state"] for row in table["criteria"]][3:], ["not_linked", "receipt"])
        self.assertEqual(table["run_level_receipts"], [])

    def test_a_path_is_cited_only_as_a_whole_path(self) -> None:
        table = self.rows([event(1, "task_changes", {"changed_files": ["my-greeting.txt", "old/greeting.txt"]})])
        self.assertEqual(table["criteria"][1]["state"], "not_linked")

    def test_changed_files_never_count_as_passed_and_a_run_without_receipts_passes_nothing(self) -> None:
        table = self.rows([event(1, "task_changes", {"changed_files": ["greeting.txt"]}),
                           event(2, "milestone_passed", milestone_id="M1"), event(3, "task_passed", task_id="T1")])
        self.assertEqual(table["summary"]["passed"], 0)
        self.assertTrue(all(row["result"] is None for row in table["criteria"]))
        self.assertEqual(table["run_level_receipts"], [])

    def test_a_missing_rfc_snapshot_gives_no_rows_and_keeps_the_receipts(self) -> None:
        table = evidence.derive_evidence(None, [receipt(1, "python hello.py", 0)])
        self.assertEqual((table["rfc_available"], table["criteria"]), (False, []))
        self.assertEqual(len(table["run_level_receipts"]), 1)


MILESTONES = [{"id": "M1", "status": "PASSED", "reviewer_role": "milestone_reviewer"},
              {"id": "M2", "status": "PENDING", "reviewer_role": "milestone_reviewer"}]
TASKS = [
    {"id": "T1", "milestone_id": "M1", "status": "PASSED", "assigned_model": "codex:gpt", "last_error": None},
    {"id": "T2", "milestone_id": "M2", "status": "PENDING", "assignee_role": "bulk_worker", "last_error": None},
]


class HandoffTests(unittest.TestCase):
    def handoffs(self, events: list[dict]) -> dict[str, dict]:
        return {handoff["id"]: handoff for handoff in evidence.derive_handoffs(events, MILESTONES, TASKS)}

    def test_every_plan_edge_is_listed_and_only_event_backed_ones_are_recorded(self) -> None:
        events = [
            event(1, "role_invoked", {"artifact_key": "plan_attempt_1"}, actor="tactical_planner:fable"),
            event(2, "role_completed", {"status": "ok", "duration_sec": 4.0}, actor="tactical_planner:fable"),
            event(3, "role_invoked", {"artifact_key": "T1_exec_1"}, actor="critical_executor:gpt", task_id="T1",
                  milestone_id="M1"),
            event(4, "role_completed", {"status": "ok", "duration_sec": 9.5}, actor="critical_executor:gpt",
                  task_id="T1", milestone_id="M1"),
            event(5, "task_changes", {"changed_files": ["greeting.txt"]}, task_id="T1", milestone_id="M1"),
            receipt(6, "python check.py", 0, scope="task", target="T1"),
            event(7, "task_review_passed", actor="micro_orchestrator", message="Looks right", task_id="T1"),
            event(8, "task_passed", task_id="T1", milestone_id="M1"),
            receipt(9, "python -m unittest", 1),
            event(10, "role_invoked", {"artifact_key": "milestone_M1_review_r0"}, actor="milestone_reviewer:opus",
                  milestone_id="M1"),
        ]
        handoffs = self.handoffs(events)
        self.assertEqual(list(handoffs), ["planner>task:T1", "task:T1>milestone:M1", "milestone:M1>task:T2",
                                          "task:T2>milestone:M2", "milestone:M2>final_gate"])
        self.assertEqual({key: value["recorded"] for key, value in handoffs.items()}, {
            "planner>task:T1": True, "task:T1>milestone:M1": True, "milestone:M1>task:T2": False,
            "task:T2>milestone:M2": False, "milestone:M2>final_gate": False,
        })

        into = handoffs["planner>task:T1"]
        self.assertEqual((into["from"], into["to"]), ({"kind": "planner", "id": None}, {"kind": "task", "id": "T1"}))
        self.assertEqual([(call["artifact_key"], call["side"], call["status"], call["duration_sec"])
                          for call in into["invocations"]],
                         [("plan_attempt_1", "from", "ok", 4.0), ("T1_exec_1", "to", "ok", 9.5)])
        self.assertEqual((into["event_ids"], into["at"]), ([3], 103.0))
        self.assertEqual(into["takeover"], {"status": "PASSED", "holder": "codex:gpt"})

        out = handoffs["task:T1>milestone:M1"]
        self.assertEqual(out["event_ids"], [8])
        self.assertEqual(out["changed_files"], ["greeting.txt"])
        self.assertEqual([(r["command"], r["exit_code"]) for r in out["receipts"]], [("python check.py", 0)])
        self.assertEqual(out["review"], {"verdict": "PASS", "summary": "Looks right", "reviewer": "micro_orchestrator",
                                         "event_id": 7})

        # The milestone gate failed and the milestone never merged: its receipt is shown, the handoff is not recorded.
        onward = handoffs["milestone:M1>task:T2"]
        self.assertEqual([(r["command"], r["passed"]) for r in onward["receipts"]], [("python -m unittest", False)])
        self.assertEqual((onward["recorded"], onward["event_ids"], onward["at"], onward["review"]), (False, [], None, None))
        self.assertEqual([call["artifact_key"] for call in onward["invocations"]], ["milestone_M1_review_r0"])

    def test_a_run_without_events_knows_nothing(self) -> None:
        for handoff in self.handoffs([]).values():
            self.assertEqual((handoff["recorded"], handoff["invocations"], handoff["changed_files"], handoff["receipts"],
                              handoff["review"]), (False, [], None, [], None))

    def test_calls_recorded_before_artifact_keys_have_none(self) -> None:
        handoffs = self.handoffs([event(1, "role_invoked", actor="critical_executor:gpt", task_id="T1")])
        (call,) = handoffs["planner>task:T1"]["invocations"]
        self.assertEqual((call["artifact_key"], call["status"], call["duration_sec"]), (None, None, None))
        self.assertTrue(handoffs["planner>task:T1"]["recorded"])

    def test_the_final_gate_handoff_needs_the_ready_event_and_blocking_reasons_are_the_recorded_error(self) -> None:
        tasks = [{**TASKS[0], "status": "WAITING_HUMAN", "last_error": "Reviewer asked for a plan change"}]
        events = [event(1, "milestone_passed", actor="milestone_reviewer", message="merged", milestone_id="M1"),
                  event(2, "ready_for_final_gate"), receipt(3, "python hello.py", 0, scope="final", target="run-1")]
        handoffs = {h["id"]: h for h in evidence.derive_handoffs(events, MILESTONES[:1], tasks)}
        final = handoffs["milestone:M1>final_gate"]
        self.assertEqual((final["recorded"], final["event_ids"]), (True, [2]))
        self.assertEqual(final["review"]["verdict"], "PASS")
        self.assertEqual([r["scope"] for r in final["receipts"]], ["final"])
        self.assertEqual(handoffs["planner>task:T1"]["blocked_reason"], "Reviewer asked for a plan change")


class ArtifactTests(unittest.TestCase):
    def setUp(self) -> None:
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.run_dir = self.root / "runs" / "run-1"
        (self.run_dir / "prompts").mkdir(parents=True)
        (self.run_dir / "out").mkdir()
        (self.run_dir / "prompts" / "T1_exec_1.md").write_text("Build it", encoding="utf-8")
        (self.run_dir / "out" / "T1_exec_1.json").write_text("done", encoding="utf-8")
        (self.root / "secret.md").write_text("outside", encoding="utf-8")
        self.events = [event(1, "role_invoked", {"artifact_key": "T1_exec_1"}),
                       event(2, "role_invoked", {"artifact_key": "http_only"}),
                       event(3, "role_invoked", {"artifact_key": "../../secret"}),
                       event(4, "role_completed", {"artifact_key": "not_a_call"})]

    def test_a_recorded_key_returns_its_prompt_and_output(self) -> None:
        artifact = evidence.read_artifact(self.run_dir, self.events, "T1_exec_1")
        self.assertEqual(artifact, {
            "artifact_key": "T1_exec_1",
            "prompt": {"text": "Build it", "truncated": False, "bytes": 8},
            "output": {"text": "done", "truncated": False, "bytes": 4},
        })

    def test_a_recorded_call_without_files_says_so(self) -> None:
        artifact = evidence.read_artifact(self.run_dir, self.events, "http_only")
        self.assertEqual((artifact["prompt"], artifact["output"]), (None, None))

    def test_unrecorded_keys_and_path_shaped_keys_are_never_read(self) -> None:
        (self.run_dir / "prompts" / "unlisted.md").write_text("exists but was never recorded", encoding="utf-8")
        for key in ("unlisted", "not_a_call", "../../secret", "..\\..\\secret", "", "T1_exec_1.md", "prompts/T1_exec_1"):
            self.assertIsNone(evidence.read_artifact(self.run_dir, self.events, key), key)

    def test_large_files_are_cut_at_the_limit(self) -> None:
        (self.run_dir / "prompts" / "T1_exec_1.md").write_bytes(b"a" * (evidence.ARTIFACT_MAX_BYTES + 10))
        prompt = evidence.read_artifact(self.run_dir, self.events, "T1_exec_1")["prompt"]
        self.assertEqual((len(prompt["text"]), prompt["truncated"], prompt["bytes"]),
                         (evidence.ARTIFACT_MAX_BYTES, True, evidence.ARTIFACT_MAX_BYTES + 10))


if __name__ == "__main__":
    unittest.main()
