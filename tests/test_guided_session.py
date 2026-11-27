"""Golden examples for the M2 guided session and recommendation contracts."""

from __future__ import annotations

import inspect
import json
import os
import subprocess
import sys
import tempfile
import unittest
from dataclasses import asdict
from pathlib import Path
from unittest.mock import patch

from vibebaton.brainstorm import brainstorm_turn
from vibebaton.guided_session import default_session, load_session, reset_session, save_session
from vibebaton.workflow_recommend import (
    ProviderReadiness,
    ReadinessSnapshot,
    WorkflowRecommendation,
    recommend_workflow,
)


class GuidedSessionTests(unittest.TestCase):
    def setUp(self) -> None:
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.repo = Path(temporary.name)
        self.path = self.repo / ".baton" / "guided" / "session.json"

    def example_session(self) -> dict:
        """A complete session, suitable as a template for subsequent milestones."""
        return {
            "schema_version": 1,
            "active_stage": "build",
            "workspace_path": str(self.repo),
            "brainstorm": {
                "messages": [
                    {"role": "user", "content": "Add an endpoint."},
                    {"role": "assistant", "content": "Who will use it?"},
                ],
                "checklist": [
                    {"id": "what", "status": "clear", "value": "An endpoint"},
                    {"id": "who", "status": "open", "value": ""},
                    {"id": "scope", "status": "assumed", "value": "Read-only"},
                    {"id": "limits", "status": "clear", "value": "Stdlib only"},
                    {"id": "done", "status": "clear", "value": "Run tests"},
                ],
                "latest_rfc_draft": "# Endpoint\n\n## Goals\n- Add an endpoint.\n",
                "selected_l0_model": "codex_sub:gpt-6.2-sol@max",
                "has_online_draft": True,
            },
            "workflow": {
                "mode": "panel",
                "lineup": {
                    "roles": {"brainstorm_and_final_gate": "codex_sub", "bulk_worker": "dsh_opencode"},
                    "model_overrides": {"brainstorm_and_final_gate": "codex_sub:gpt-6.2-sol@max"},
                },
                "preset": "specialist_panel",
                "panel_enabled": True,
                "launch_request_id": "launch-123",
            },
            "active_run_id": "run-123",
            "open_human_gate": {"run_id": "run-123", "task_id": "M2-T1"},
            "open_drawer": {"run_id": "run-123", "task_id": "M2-T1"},
        }

    def test_complete_document_round_trips_and_is_utf8_json(self) -> None:
        session = self.example_session()
        session["brainstorm"]["messages"][0]["content"] = "增加状态接口。"
        save_session(self.repo, session)

        self.assertEqual(load_session(self.repo), session)
        self.assertEqual(json.loads(self.path.read_text(encoding="utf-8")), session)

    def test_missing_corrupt_and_invalid_documents_return_fresh_defaults(self) -> None:
        first = load_session(self.repo)
        first["brainstorm"]["messages"].append({"role": "user", "content": "temporary"})
        self.assertEqual(load_session(self.repo), default_session())
        self.path.parent.mkdir(parents=True)
        for bad in (b'{"active_stage":', b'\xff', b'null', b'[]', b'{"active_stage": 4}', b'{"extra": NaN}'):
            with self.subTest(bad=bad):
                self.path.write_bytes(bad)
                self.assertEqual(load_session(self.repo), default_session())

    def test_read_error_other_than_missing_file_is_visible(self) -> None:
        with patch("pathlib.Path.open", side_effect=PermissionError("not readable")):
            with self.assertRaises(PermissionError):
                load_session(self.repo)

    def test_partial_documents_default_missing_fields_and_preserve_unknown_keys(self) -> None:
        self.path.parent.mkdir(parents=True)
        self.path.write_text(json.dumps({
            "schema_version": 2,
            "active_stage": "blueprint",
            "future_top": {"enabled": True},
            "brainstorm": {"future_draft": ["keep"]},
            "workflow": {"lineup": {"future_metadata": "keep"}},
        }), encoding="utf-8")

        session = load_session(self.repo)
        self.assertEqual(session["schema_version"], 2)
        self.assertEqual(session["active_stage"], "blueprint")
        self.assertEqual(session["brainstorm"]["messages"], [])
        self.assertEqual(session["workflow"]["lineup"]["roles"], {})
        save_session(self.repo, session)
        self.assertEqual(load_session(self.repo), session)
        self.assertEqual(session["future_top"], {"enabled": True})
        self.assertEqual(session["brainstorm"]["future_draft"], ["keep"])
        self.assertEqual(session["workflow"]["lineup"]["future_metadata"], "keep")

    def test_reset_atomically_replaces_the_document_with_defaults(self) -> None:
        save_session(self.repo, self.example_session())
        self.assertEqual(reset_session(self.repo), default_session())
        self.assertEqual(load_session(self.repo), default_session())
        self.assertEqual(json.loads(self.path.read_text(encoding="utf-8")), default_session())

    def test_replace_observes_a_complete_temporary_file_in_the_same_directory(self) -> None:
        session = self.example_session()
        save_session(self.repo, session)
        next_session = self.example_session()
        next_session["active_stage"] = "signoff"
        observed = []
        original_replace = os.replace

        def inspect_replace(source: str | Path, destination: str | Path) -> None:
            source_path, destination_path = Path(source), Path(destination)
            observed.append((source_path.parent, destination_path, json.loads(source_path.read_text(encoding="utf-8"))))
            self.assertEqual(load_session(self.repo), session)
            original_replace(source, destination)

        with patch("vibebaton.guided_session.os.replace", side_effect=inspect_replace):
            save_session(self.repo, next_session)
        self.assertEqual(observed, [(self.path.parent, self.path, next_session)])
        self.assertEqual(load_session(self.repo), next_session)

    def test_interrupted_write_and_failed_replace_keep_the_previous_file(self) -> None:
        save_session(self.repo, self.example_session())
        previous = self.path.read_bytes()

        def interrupted_dump(value: object, stream: object, **kwargs: object) -> None:
            stream.write('{"partial":')
            raise OSError("write interrupted")

        with patch("vibebaton.guided_session.json.dump", side_effect=interrupted_dump):
            with self.assertRaises(OSError):
                save_session(self.repo, self.example_session())
        self.assertEqual(self.path.read_bytes(), previous)
        self.assertEqual(list(self.path.parent.iterdir()), [self.path])

        with patch("vibebaton.guided_session.os.replace", side_effect=OSError("replace failed")):
            with self.assertRaises(OSError):
                save_session(self.repo, self.example_session())
        self.assertEqual(self.path.read_bytes(), previous)
        self.assertEqual(list(self.path.parent.iterdir()), [self.path])

    def test_invalid_save_raises_without_overwriting_the_previous_document(self) -> None:
        save_session(self.repo, self.example_session())
        previous = self.path.read_bytes()
        invalid = self.example_session()
        invalid["workflow"]["panel_enabled"] = "yes"
        with self.assertRaises(ValueError):
            save_session(self.repo, invalid)
        self.assertEqual(self.path.read_bytes(), previous)

    def test_process_exit_during_write_does_not_truncate_the_session(self) -> None:
        session = self.example_session()
        save_session(self.repo, session)
        previous = self.path.read_bytes()
        script = """\
import os, sys
from unittest.mock import patch
from vibebaton.guided_session import default_session, save_session
def interrupt(document, stream, **kwargs):
    stream.write('{"unfinished":')
    stream.flush()
    os._exit(71)
with patch('vibebaton.guided_session.json.dump', side_effect=interrupt):
    save_session(sys.argv[1], default_session())
"""
        process = subprocess.run([sys.executable, "-c", script, str(self.repo)], check=False)
        self.assertEqual(process.returncode, 71)
        self.assertEqual(self.path.read_bytes(), previous)
        self.assertEqual(load_session(self.repo), session)


class GuideSizeTests(unittest.TestCase):
    RFC = (
        "# Health endpoint\n\n## Goals\n- Add a health endpoint.\n\n"
        "## Constraints\n- Use stdlib.\n\n## Non-Goals\n- No authentication.\n\n"
        "## Architecture & Deliverables\n- Add a route.\n\n"
        "## Verification & Acceptance Criteria\n1. Run tests.\n"
    )

    def _live_guide(self, guide: dict) -> dict:
        text = f"Reply.\n```guide\n{json.dumps(guide)}\n```\n````rfc\n{self.RFC}````\n"
        with tempfile.TemporaryDirectory() as repo, patch.dict(os.environ, {
            "VIBEBATON_OFFLINE_BRAINSTORM": "", "VIBEBATON_BRAINSTORM_OFFLINE": "",
        }):
            result = brainstorm_turn(
                Path(repo), [{"role": "user", "content": "Add health endpoint"}],
                dispatch=lambda prompt: ("codex", text),
            )
        self.assertFalse(result["offline"])
        self.assertIsNone(result["error"])
        return result["guide"]

    def test_size_is_case_insensitive_and_other_fields_are_unchanged(self) -> None:
        base = {"question": "Who?", "options": ["Team"], "checklist": []}
        without_size = self._live_guide(base)
        self.assertEqual(set(without_size), {"question", "options", "checklist"})
        self.assertIsNone(without_size.get("size"))
        for raw, expected in (("small", "small"), ("MEDIUM", "medium"), (" LaRgE ", "large")):
            with self.subTest(raw=raw):
                parsed = self._live_guide({**base, "size": raw})
                self.assertEqual(parsed.pop("size"), expected)
                self.assertEqual(parsed, without_size)

    def test_invalid_sizes_are_none_without_causing_a_live_turn_failure(self) -> None:
        for raw in ("huge", "", None, 1, True, ["small"], {"size": "small"}):
            with self.subTest(raw=raw):
                self.assertIsNone(self._live_guide({"size": raw})["size"])


class WorkflowRecommendationContractTests(unittest.TestCase):
    def test_types_and_keyword_only_previous_lineup(self) -> None:
        lineup = {"roles": {"bulk_worker": "dsh_opencode"}, "model_overrides": {}}
        provider = ProviderReadiness(
            provider_id="dsh_opencode", kind="cli", provider_ready=True, credential_ready=True,
        )
        snapshot = ReadinessSnapshot(providers=(provider,), default_lineup=lineup)
        recommendation = WorkflowRecommendation(
            mode="overnight", preset="starter_2tier", lineup=lineup, size="small",
            reason_code="example", explanation_key="workflow.example", fallback=False,
        )
        self.assertEqual(asdict(snapshot)["providers"][0]["provider_id"], "dsh_opencode")
        self.assertEqual(asdict(recommendation), {
            "mode": "overnight", "preset": "starter_2tier", "lineup": lineup,
            "size": "small", "reason_code": "example",
            "explanation_key": "workflow.example", "fallback": False,
        })
        parameters = inspect.signature(recommend_workflow).parameters
        # size_basis (20261126 workflow tiers) is a new optional keyword-only argument.
        self.assertEqual(list(parameters), ["size", "readiness", "previous_lineup", "size_basis"])
        for name in ("previous_lineup", "size_basis"):
            self.assertEqual(parameters[name].kind, inspect.Parameter.KEYWORD_ONLY)
            self.assertIsNone(parameters[name].default)


if __name__ == "__main__":
    unittest.main()
