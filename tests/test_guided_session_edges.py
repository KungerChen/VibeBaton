"""Edge-case coverage for the M2 Guided session persistence contract."""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from vibebaton.guided_session import default_session, load_session, reset_session, save_session


class GuidedSessionEdgeTests(unittest.TestCase):
    def setUp(self) -> None:
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.repo = Path(temporary.name)
        self.path = self.repo / ".baton" / "guided" / "session.json"

    def example_session(self) -> dict:
        """A complete session used as the baseline for edge-case documents."""
        return {
            "schema_version": 1,
            "active_stage": "build",
            "workspace_path": str(self.repo),
            "brainstorm": {
                "messages": [
                    {"role": "user", "content": "Add a status endpoint."},
                    {"role": "assistant", "content": "Who will use it?"},
                ],
                "checklist": [
                    {"id": "what", "status": "clear", "value": "A status endpoint"},
                    {"id": "who", "status": "open", "value": ""},
                    {"id": "scope", "status": "assumed", "value": "Read-only"},
                    {"id": "limits", "status": "clear", "value": "Stdlib only"},
                    {"id": "done", "status": "clear", "value": "Run tests"},
                ],
                "latest_rfc_draft": "# Status endpoint\n\n## Goals\n- Report health.\n",
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
                "launch_request_id": "launch-edges",
            },
            "active_run_id": "run-edges",
            "open_human_gate": {"run_id": "run-edges", "task_id": "M2-T1"},
            "open_drawer": {"run_id": "run-edges", "task_id": "M2-T1"},
        }

    def test_save_creates_the_missing_guided_directory(self) -> None:
        self.assertFalse(self.path.parent.exists())
        self.assertEqual(load_session(self.repo), default_session())
        self.assertFalse(self.path.parent.exists())

        session = self.example_session()
        save_session(self.repo, session)

        self.assertTrue(self.path.parent.is_dir())
        self.assertTrue(self.path.is_file())
        self.assertEqual(load_session(self.repo), session)

    def test_unknown_keys_are_preserved_and_ignored_by_validation(self) -> None:
        self.path.parent.mkdir(parents=True)
        document = self.example_session()
        document["future_top"] = {"enabled": "yes"}
        document["brainstorm"]["future_draft"] = [1, "keep"]
        document["workflow"]["lineup"]["future_metadata"] = {"nested": True}
        document["workflow"]["future_selection"] = None
        self.path.write_text(json.dumps(document), encoding="utf-8")

        loaded = load_session(self.repo)
        self.assertEqual(loaded["future_top"], {"enabled": "yes"})
        self.assertEqual(loaded["brainstorm"]["future_draft"], [1, "keep"])
        self.assertEqual(loaded["workflow"]["lineup"]["future_metadata"], {"nested": True})
        self.assertIsNone(loaded["workflow"]["future_selection"])

        save_session(self.repo, loaded)
        self.assertEqual(load_session(self.repo), loaded)
        self.assertEqual(load_session(self.repo)["future_top"], {"enabled": "yes"})

    def test_older_partial_document_is_upgraded_with_current_defaults(self) -> None:
        # schema_version 1 is the oldest supported document. Documents written
        # before later fields existed gain those defaults without a version bump.
        self.path.parent.mkdir(parents=True)
        self.path.write_text(json.dumps({
            "schema_version": 1,
            "active_stage": "blueprint",
            "workspace_path": str(self.repo),
            "brainstorm": {
                "messages": [{"role": "user", "content": "Legacy draft."}],
                "latest_rfc_draft": "# Legacy draft\n",
            },
            "workflow": {
                "lineup": {"roles": {"bulk_worker": "dsh_opencode"}},
            },
            "active_run_id": "run-legacy",
        }), encoding="utf-8")

        upgraded = load_session(self.repo)
        self.assertEqual(upgraded["schema_version"], 1)
        self.assertEqual(upgraded["active_stage"], "blueprint")
        self.assertEqual(upgraded["workspace_path"], str(self.repo))
        self.assertEqual(upgraded["brainstorm"]["messages"], [{"role": "user", "content": "Legacy draft."}])
        self.assertEqual(upgraded["brainstorm"]["latest_rfc_draft"], "# Legacy draft\n")
        self.assertEqual(upgraded["brainstorm"]["checklist"], [])
        self.assertIsNone(upgraded["brainstorm"]["selected_l0_model"])
        self.assertFalse(upgraded["brainstorm"]["has_online_draft"])
        self.assertIsNone(upgraded["workflow"]["mode"])
        self.assertEqual(upgraded["workflow"]["lineup"], {
            "roles": {"bulk_worker": "dsh_opencode"}, "model_overrides": {},
        })
        self.assertIsNone(upgraded["workflow"]["preset"])
        self.assertFalse(upgraded["workflow"]["panel_enabled"])
        self.assertIsNone(upgraded["workflow"]["launch_request_id"])
        self.assertEqual(upgraded["active_run_id"], "run-legacy")
        self.assertIsNone(upgraded["open_human_gate"])
        self.assertIsNone(upgraded["open_drawer"])

        save_session(self.repo, upgraded)
        self.assertEqual(load_session(self.repo), upgraded)
        persisted = json.loads(self.path.read_text(encoding="utf-8"))
        self.assertEqual(persisted["brainstorm"]["checklist"], [])
        self.assertEqual(persisted["workflow"]["lineup"]["model_overrides"], {})
        self.assertFalse(persisted["workflow"]["panel_enabled"])

    def test_legacy_document_without_schema_version_gets_the_current_version(self) -> None:
        # Documents written before schema_version existed are upgraded in memory
        # with the current version and saved as a complete current document.
        self.path.parent.mkdir(parents=True)
        self.path.write_text(json.dumps({
            "active_stage": "setup",
            "brainstorm": {"messages": [], "latest_rfc_draft": "# Legacy\n"},
        }), encoding="utf-8")

        upgraded = load_session(self.repo)
        self.assertEqual(upgraded["schema_version"], 1)
        self.assertEqual(upgraded["brainstorm"]["latest_rfc_draft"], "# Legacy\n")
        self.assertEqual(upgraded["workflow"]["lineup"], {"roles": {}, "model_overrides": {}})

        save_session(self.repo, upgraded)
        self.assertEqual(load_session(self.repo)["schema_version"], 1)

    def test_empty_file_returns_fresh_defaults_without_repairing_it(self) -> None:
        self.path.parent.mkdir(parents=True)
        self.path.write_bytes(b"")

        self.assertEqual(load_session(self.repo), default_session())
        self.assertEqual(self.path.read_bytes(), b"")

    def test_non_object_json_returns_fresh_defaults(self) -> None:
        self.path.parent.mkdir(parents=True)
        for payload in (b"null", b"[]", b'"session"', b"0", b"true"):
            with self.subTest(payload=payload):
                self.path.write_bytes(payload)
                self.assertEqual(load_session(self.repo), default_session())
                self.assertEqual(self.path.read_bytes(), payload)

    def test_reset_removes_state_and_next_load_returns_defaults(self) -> None:
        save_session(self.repo, self.example_session())

        self.assertEqual(reset_session(self.repo), default_session())
        loaded = load_session(self.repo)
        self.assertEqual(loaded, default_session())
        self.assertEqual(json.loads(self.path.read_text(encoding="utf-8")), default_session())
        self.assertIsNone(loaded["active_run_id"])
        self.assertEqual(loaded["brainstorm"]["messages"], [])

    def test_chinese_content_round_trips_as_utf8(self) -> None:
        session = self.example_session()
        session["brainstorm"]["messages"] = [
            {"role": "user", "content": "增加状态接口。"},
            {"role": "assistant", "content": "谁会使用它？"},
        ]
        session["brainstorm"]["checklist"][0]["value"] = "状态接口"
        session["brainstorm"]["latest_rfc_draft"] = "# 状态接口\n\n## 目标\n- 返回健康状态。\n"

        save_session(self.repo, session)

        raw = self.path.read_bytes()
        text = raw.decode("utf-8")
        self.assertEqual(json.loads(text), session)
        self.assertEqual(load_session(self.repo), session)


if __name__ == "__main__":
    unittest.main()
