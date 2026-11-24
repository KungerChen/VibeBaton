"""00_PANEL events in the sanitized run-case export."""

from __future__ import annotations

import json
import re
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from vibebaton.case_export import audit_serialized, export_sanitized_case
from vibebaton.db import StateStore
from vibebaton.schemas import MilestoneSpec, PlanDAG, RunStatus, TaskSpec, TaskStatus

from tests.test_case_export import _GOLDEN_FIXTURE, _GOLDEN_START, _seed_run, _write_role_config


_FAKE_SECRET = "sk-" + "A1b2C3d4E5f6G7h8I9j0K1l2"
_FAKE_USER_PATH = r"C:\Users\panelworker\private\member-notes.md"


def _seed_panel_run(tmp_path: Path) -> tuple[StateStore, str, Path]:
    """Seed a completed panel run whose previews carry a secret and a raw user path."""
    store = StateStore(tmp_path / "state.sqlite")
    repo_path = (tmp_path / "repo").resolve()
    _write_role_config(repo_path)
    run_id = store.create_run(
        repo_path, repo_path / "00_RFC.md", mode="panel", run_id="run-panel",
    )
    store.log_event(run_id, "panel_started", message="Panel started", payload={"member_count": 2})
    store.log_event(run_id, "panel_member_completed", message="Specialist finished", payload={
        "member_id": "safety",
        "perspective": "Source & Safety",
        "provider": "codex_sub",
        "model": "gpt-6.2-sol@max",
        "ok": True,
        "tokens_in": 120,
        "tokens_out": 80,
        "cost_usd": 0.004,
        "elapsed_sec": 3.5,
        "preview": f"Found {_FAKE_SECRET} in {_FAKE_USER_PATH}",
        "output_path": str(repo_path / ".baton" / "runs" / run_id / "panel" / "safety.md"),
        "error": "",
    })
    store.log_event(run_id, "panel_member_completed", message="Specialist failed", payload={
        "member_id": "ux",
        "perspective": "UX & Copy",
        "provider": "claude_sub",
        "model": "opus@high",
        "ok": False,
        "tokens_in": 0,
        "tokens_out": 0,
        "cost_usd": None,
        "elapsed_sec": 1.0,
        "preview": "",
        "output_path": "",
        "error": f"Could not read {_FAKE_USER_PATH} while handling {_FAKE_SECRET}",
    })
    store.log_event(run_id, "panel_synthesized", message="Synthesis complete", payload={
        "member_count": 2,
        "succeeded_count": 1,
        "provider": "claude_sub",
        "model": "sonnet@high",
        "tokens_in": 300,
        "tokens_out": 200,
        "cost_usd": 0.01,
        "elapsed_sec": 12.5,
        "preview": f"# Master Spec\nKeep {_FAKE_SECRET} out of shared cases.",
        "master_spec_path": str(repo_path / ".baton" / "runs" / run_id / "panel" / "master_spec.md"),
    })
    store.register_plan(run_id, PlanDAG(
        rfc_version="v1.0",
        complexity_tier="S",
        milestones=[
            MilestoneSpec(
                id="M1",
                title="Implement the panel plan",
                tasks=[TaskSpec(id="M1-T1", title="Write the worker output")],
            ),
        ],
    ))
    store.log_event(run_id, "task_started", task_id="M1-T1", milestone_id="M1", message="Worker started")
    store.update_task(run_id, "M1-T1", status=TaskStatus.PASSED, duration_sec=2.0)
    store.log_event(run_id, "task_passed", task_id="M1-T1", milestone_id="M1", message="Worker passed")
    store.update_milestone(run_id, "M1", TaskStatus.PASSED)
    store.log_event(run_id, "milestone_passed", milestone_id="M1", message="Milestone passed")
    store.update_run_status(run_id, RunStatus.COMPLETED, summary=f"Panel run for {repo_path}")
    return store, run_id, repo_path


class PanelCaseExportTests(unittest.TestCase):
    def setUp(self) -> None:
        self.directory = Path(self.enterContext(tempfile.TemporaryDirectory()))
        self.enterContext(patch(
            "vibebaton.credentials.default_credentials_path",
            return_value=self.directory / "credentials.json",
        ))
        self.store, self.run_id, self.repo_path = _seed_panel_run(self.directory)

    def test_panel_trace_entries_are_redacted_and_summarized(self) -> None:
        bundle = export_sanitized_case(self.store, self.run_id)
        panel_events = [
            event for event in self.store.get_events(self.run_id, limit=-1)
            if event["kind"].startswith("panel_")
        ]
        panel_trace = [event for event in bundle["trace"] if event["node_id"] == "00_PANEL"]

        self.assertEqual(len(panel_trace), len(panel_events))
        self.assertEqual(
            [event["kind"] for event in panel_trace],
            ["node_started", "node_completed", "node_completed", "node_completed"],
        )
        messages = "\n".join(event["message"] for event in panel_trace)
        self.assertIn("Panel started with 2 specialist(s)", messages)
        self.assertIn("safety (Source & Safety) completed via codex_sub/gpt-6.2-sol@max", messages)
        self.assertIn("ux (UX & Copy) failed via claude_sub/opus@high", messages)
        self.assertIn("Synthesized 1/2 specialist report(s) in 12.5s", messages)
        self.assertIn("[REDACTED]", messages)
        self.assertNotIn("panelworker", messages)

        self.assertEqual(bundle["meta"]["panel"], {
            "member_count": 2,
            "succeeded_count": 1,
            "elapsed_sec": 12.5,
        })
        report = bundle["redaction_report"]
        self.assertIs(report["clean"], True)
        self.assertGreaterEqual(report["secrets_redacted"], 3)
        self.assertGreaterEqual(report["paths_anonymized"], 2)
        serialized = json.dumps(bundle, ensure_ascii=False)
        self.assertNotIn(_FAKE_SECRET, serialized)
        self.assertNotIn("panelworker", serialized)
        self.assertIsNone(re.search(r"sk-[A-Za-z0-9]{20,}", serialized))
        self.assertTrue(audit_serialized(serialized))

    def test_non_panel_export_is_unchanged(self) -> None:
        directory = Path(self.enterContext(tempfile.TemporaryDirectory()))
        with patch("vibebaton.db.time.time", side_effect=map(float, range(_GOLDEN_START, _GOLDEN_START + 10))):
            store, run_id = _seed_run(directory)
        # The replay fixture uses the original redaction markers.
        expected = json.loads(
            _GOLDEN_FIXTURE.read_text(encoding="utf-8")
            .replace(
                "Notification destination: [REDACTED]",
                "Notification destination: https://open.feishu.cn/open-apis/bot/v2/hook/[REDACTED]",
            )
            .replace("[RAW_DIFF_STRIPPED]", "[diff stripped]")
            .replace("[RAW_STACK_STRIPPED]", "[stack trace stripped]")
        )

        bundle = export_sanitized_case(store, run_id, title="Sanitized Run Case")

        self.assertEqual(bundle, expected)
        self.assertNotIn("panel", bundle["meta"])
        self.assertNotIn("00_PANEL", [event["node_id"] for event in bundle["trace"]])


if __name__ == "__main__":
    unittest.main()
