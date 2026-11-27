"""Guided HTTP golden path: persisted drafts, preflight and lineage launches.

These tests use the real session store, recommendation and Git-backed run API;
the local CLI scan and model runner are deterministic fakes. No daemon is run.
"""

from __future__ import annotations

import json
import os
import sys
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest.mock import patch
from urllib.request import Request

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from tests.test_guided_api import GuidedApiTestCase, _git
from tests.test_workflow_recommend import example_scan
from vibebaton import brainstorm, guided_session, web_server
from vibebaton.schemas import RunStatus
from vibebaton.workflow_recommend import build_readiness_snapshot, recommend_workflow


class TestGuidedSessionApi(GuidedApiTestCase):
    RFC = """# Health endpoint

## Goals
- Provide a health endpoint.

## Constraints
- Use the existing HTTP server.

## Non-Goals
- No authentication changes.

## Architecture & Deliverables
- Add the endpoint.

## Verification & Acceptance Criteria
- Run `python -m unittest`.
"""
    MESSAGE = [{"role": "user", "content": "Add a health endpoint."}]

    def setUp(self) -> None:
        super().setUp()
        self.scan = example_scan(("agy", "gemini", "claude", "codex", "dsh"), http_key=True)
        self.scan_patch = patch("vibebaton.cli_registry.scan_host_clis", side_effect=lambda *a, **kw: self.scan)
        self.scan_patch.start()
        self.addCleanup(self.scan_patch.stop)
        self.enterContext(patch.dict(os.environ, {name: "" for name in brainstorm.OFFLINE_ENV_VARS}))

    def put_session(self, update: dict) -> tuple[int, dict]:
        status, _, body = self.send_json("/api/guided/session", {"session": update}, method="PUT")
        return status, body

    def get_session(self) -> dict:
        status, body = self._get("/api/guided/session")
        self.assertEqual(status, 200, body)
        return body["session"]

    def lineup(self) -> dict:
        snapshot = build_readiness_snapshot(self.repo, self.server.loader.current, self.credentials_path)
        selection = recommend_workflow("medium", snapshot).lineup
        self.assertIsNotNone(selection)
        return selection

    def launch(self, key: str = "request-1") -> str:
        status, body = self._post("/api/runs/start", {
            "rfc_markdown": self.RFC, "mode": "overnight", "lineup": self.lineup(),
            "launch_request_id": key,
        })
        self.assertEqual(status, 201, body)
        return body["run_id"]

    def settle(self, run_id: str) -> None:
        _git(self.repo, "checkout", "-q", f"baton/runs/{run_id}")
        (self.repo / "feature.txt").write_text(f"feature for {run_id}\n", encoding="utf-8")
        _git(self.repo, "add", "feature.txt")
        _git(self.repo, "commit", "-q", "-m", "feature")
        sha = _git(self.repo, "rev-parse", "HEAD")
        _git(self.repo, "checkout", "-q", "main")
        self.store.set_run_result_sha(run_id, sha)
        self.store.update_run_status(run_id, RunStatus.READY_FOR_FINAL_GATE)

    def test_session_partial_update_restart_reset_and_workspace_scope(self) -> None:
        status, body = self.put_session({
            "active_stage": "blueprint", "brainstorm": {"latest_rfc_draft": self.RFC},
            "workflow": {"mode": "overnight", "preset": "starter_2tier"},
            "future_field": {"keep": True},
        })
        self.assertEqual(status, 200, body)
        status, body = self.put_session({"workflow": {"lineup": self.lineup()}})
        self.assertEqual(status, 200, body)
        before = body["session"]
        self.assertEqual(before["brainstorm"]["latest_rfc_draft"], self.RFC)
        self.assertEqual(before["workflow"]["mode"], "overnight")
        status, _ = self.put_session({"brainstorm": []})
        self.assertEqual(status, 400)
        self.assertEqual(self.get_session(), before)
        run_id = self.launch()
        before = self.get_session()
        self.assertEqual(before["active_run_id"], run_id)
        self.server.shutdown()
        self.base = self.start_server(self._create_server())  # fresh server, same workspace
        self.assertEqual(self.get_session(), before)
        other = self.repo / "other"
        other.mkdir()
        status, body = self._post("/api/workspace/select", {"path": str(other)})
        self.assertEqual(status, 200, body)
        self.assertIsNone(self.get_session()["active_run_id"])
        self._post("/api/guided/session/reset", {})
        status, body = self._post("/api/workspace/select", {"path": str(self.repo)})
        self.assertEqual(status, 200, body)
        self.assertEqual(self.get_session(), before)
        status, body = self._post("/api/guided/session/reset", {})
        self.assertEqual(status, 200, body)
        self.assertEqual(body["session"]["active_stage"], "setup")
        self.assertIsNone(body["session"]["active_run_id"])
        self.assertIsNotNone(self.store.get_run(run_id))

    def test_panel_missing_synthesizer_credentials_creates_nothing(self) -> None:
        claude = next(item for item in self.scan["drivers"] if item["id"] == "claude")
        claude["status"] = "installed_unauthenticated"
        status, body = self._post("/api/runs/start", {"mode": "panel", "rfc_markdown": self.RFC})
        self.assertEqual(status, 409, body)
        self.assertIn("synthesizer_credentials_missing", body["codes"])
        self.assertEqual(body["fallback"]["mode"], "overnight")
        self.assertEqual(self.store.list_runs(), [])
        self.assertEqual(self.spawn_calls, [])
        self.assertFalse((self.repo / ".baton" / "ui_rfcs").exists())
        self.assertIsNone(self.get_session()["active_run_id"])

    def test_custom_cli_panel_uses_a_real_local_provider_probe(self) -> None:
        config_path = self.repo / ".baton" / "custom-config.json"
        config_path.write_text(json.dumps({
            "providers": {"local_cli": {"type": "cli", "command": [sys.executable]}},
            "roles": {"bulk_worker": {"provider": "local_cli", "model": "local-model"}},
            "panel": {"enabled": True, "synthesizer_provider": "local_cli", "synthesizer_model": "local-model",
                      "members": [{"id": "review", "perspective": "Review", "provider": "local_cli",
                                   "model": "local-model"}]},
        }), encoding="utf-8")
        server = web_server.create_server(self.repo, port=0, config_path=config_path,
                                          daemon_spawner=self.fake_spawner, credentials_path=self.credentials_path)
        self.base = self.start_server(server)
        status, body = self._post("/api/runs/start", {"mode": "panel", "rfc_markdown": self.RFC})
        self.assertEqual(status, 201, body)
        self.assertEqual(self.store.get_run(body["run_id"])["mode"], "panel")
        self.assertEqual(len(self.spawn_calls), 1)

    def test_known_cli_provider_cannot_bypass_registry_auth_with_another_binary(self) -> None:
        config = self.server.loader.current
        config.providers["claude_sub"].command = [sys.executable]
        snapshot = build_readiness_snapshot(self.repo, config, self.credentials_path)
        claude = next(provider for provider in snapshot.providers if provider.provider_id == "claude_sub")
        self.assertFalse(claude.provider_ready)
        self.assertFalse(claude.credential_ready)

    def test_online_draft_recommendation_and_failure_survive_restart(self) -> None:
        prompts: list[str] = []
        guide = {"question": "", "options": [], "checklist": [], "size": "LaRGe"}

        def runner(prompt: str) -> tuple[str, str, str]:
            prompts.append(prompt)
            return "codex_sub", "gpt-6.2-astra@xhigh", (
                "Ready.\n```guide\n" + json.dumps(guide) + "\n```\n````rfc\n" + self.RFC + "````\n"
            )

        with patch.object(brainstorm, "_provider_dispatch", return_value=runner):
            status, body = self._post("/api/brainstorm/chat", {
                "messages": self.MESSAGE, "requested_l0_model": "codex_sub:gpt-6.2-astra@xhigh",
                "revision_context": {"prior_rfc": self.RFC, "requested_changes": "Add a check."},
                "failure_context": "The old check failed.",
            })
        self.assertEqual(status, 200, body)
        self.assertEqual(body["responding_model"], "gpt-6.2-astra@xhigh")
        self.assertEqual(body["guide"]["size"], "large")
        self.assertTrue(body["blueprint"]["ready_to_launch"])
        self.assertEqual(body["recommendation"]["mode"], "panel")
        self.assertIn("The old check failed.", prompts[0])
        original = body["rfc_markdown"]
        self.assertTrue(self.get_session()["brainstorm"]["has_online_draft"])
        saved = self.get_session()
        status, _ = self.put_session({"brainstorm": {"has_online_draft": False}})
        self.assertEqual(status, 400)
        status, _ = self.put_session({"brainstorm": {"latest_rfc_draft": ""}})
        self.assertEqual(status, 400)
        self.assertEqual(self.get_session(), saved)
        self.server.shutdown()
        self.base = self.start_server(self._create_server())
        with patch.object(brainstorm, "_provider_dispatch", return_value=lambda _: (_ for _ in ()).throw(RuntimeError("offline"))):
            status, failed = self._post("/api/brainstorm/chat", {"messages": self.MESSAGE})
        self.assertEqual(status, 200, failed)
        self.assertTrue(failed["retryable"])
        self.assertEqual(failed["rfc_markdown"], original)
        self.assertEqual(self.get_session()["brainstorm"]["latest_rfc_draft"], original)
        status, offline = self._post("/api/brainstorm/chat", {"messages": self.MESSAGE, "offline": True})
        self.assertEqual(status, 200, offline)
        self.assertTrue(offline["retryable"])
        self.assertEqual(offline["rfc_markdown"], original)

    def test_recommendation_estimates_size_and_starts_from_the_setup_team(self) -> None:
        def runner(prompt: str) -> tuple[str, str, str]:
            guide = {"question": "", "options": [], "checklist": []}  # no size from the model
            return "codex_sub", "gpt-6.2-astra@xhigh", (
                "Ready.\n```guide\n" + json.dumps(guide) + "\n```\n````rfc\n" + self.RFC + "````\n"
            )

        def chat() -> dict:
            with patch.object(brainstorm, "_provider_dispatch", return_value=runner):
                status, body = self._post("/api/brainstorm/chat", {"messages": self.MESSAGE})
            self.assertEqual(status, 200, body)
            return body["recommendation"]

        setup_team = self.lineup()
        setup_team.pop("size", None)
        self.assertEqual(self.put_session({"workflow": {"guided_selected_lineup": json.dumps(
            {**setup_team, "ready": True, "source": "cli", "notes_en": "", "notes_zh": ""})}})[0], 200)
        # Only README/.gitignore so far: an empty project is at least medium; the setup team is reused.
        first = chat()
        self.assertEqual(first["explanation_codes"][:2], ["size_estimated", "medium_relay"])
        self.assertEqual(first["size"], "medium")
        self.assertEqual(first["lineup"]["model_overrides"], setup_team["model_overrides"])
        self.assertIsNone(first["preset"])

        # One goal and one area in an existing project is small: a lean team, not the setup team.
        (self.repo / "app.py").write_text("print('hi')\n", encoding="utf-8")
        small = chat()
        self.assertEqual(small["explanation_codes"][:2], ["size_estimated", "small_eco"])
        self.assertNotEqual(small["lineup"]["model_overrides"], setup_team["model_overrides"])

        # A team the user edited by hand is kept whatever the size.
        custom = {**setup_team, "customized": True}
        self.assertEqual(self.put_session({"workflow": {"guided_selected_lineup": json.dumps(
            {**custom, "ready": True, "source": "cli", "notes_en": "", "notes_zh": ""})}})[0], 200)
        kept = chat()
        self.assertEqual(kept["explanation_codes"][:2], ["size_estimated", "custom_lineup_kept"])
        self.assertEqual(kept["lineup"]["model_overrides"], setup_team["model_overrides"])

    def test_invalid_added_fields_and_lineups_do_not_create_runs(self) -> None:
        for extra in (
            {"requested_l0_model": "unknown:bad"},
            {"revision_context": "bad"},
            {"failure_context": "failed without a revision"},
            {"previous_lineup": []},
        ):
            with self.subTest(extra=extra):
                status, body = self._post("/api/brainstorm/chat", {"messages": self.MESSAGE, **extra})
                self.assertEqual(status, 400, body)
        selection = self.lineup()
        role = next(iter(selection["roles"]))
        selection["model_overrides"][role] = "unknown:model"
        status, body = self._post("/api/runs/start", {"rfc_markdown": self.RFC, "lineup": selection})
        self.assertEqual(status, 400, body)
        self.assertEqual(self.store.list_runs(), [])
        self.assertEqual(self.spawn_calls, [])

    def test_readiness_failure_preserves_a_completed_online_turn(self) -> None:
        def runner(_: str) -> tuple[str, str, str]:
            return "codex_sub", "gpt-6.2-sol@high", f"Ready.\n````rfc\n{self.RFC}````\n"

        with patch.object(brainstorm, "_provider_dispatch", return_value=runner), \
             patch("vibebaton.cli_registry.scan_host_clis", side_effect=OSError("scan failed")):
            status, body = self._post("/api/brainstorm/chat", {"messages": self.MESSAGE})
        self.assertEqual(status, 500, body)
        self.assertEqual(body["code"], "READINESS_UNAVAILABLE")
        session = self.get_session()
        self.assertTrue(session["brainstorm"]["has_online_draft"])
        self.assertEqual(session["brainstorm"]["latest_rfc_draft"], self.RFC)

    def test_session_remains_accessible_during_live_turn(self) -> None:
        entered, release = threading.Event(), threading.Event()
        initial = "# Existing online draft\n"
        self.assertEqual(self.put_session({"brainstorm": {
            "latest_rfc_draft": initial, "has_online_draft": True,
            "selected_l0_model": "codex_sub:old-model",
        }})[0], 200)

        def runner(_: str) -> tuple[str, str, str]:
            entered.set()
            if not release.wait(10):
                raise RuntimeError("test did not release dispatcher")
            return "codex_sub", "new-model", f"Ready.\n````rfc\n{self.RFC}````\n"

        with patch.object(brainstorm, "_provider_dispatch", return_value=runner), \
             ThreadPoolExecutor(max_workers=3) as pool:
            turn = pool.submit(self._post, "/api/brainstorm/chat", {"messages": self.MESSAGE})
            try:
                self.assertTrue(entered.wait(5), "model dispatch did not start")
                restored = pool.submit(self.get_session).result(timeout=2)
                self.assertEqual(restored["brainstorm"]["latest_rfc_draft"], initial)
                status, body = pool.submit(self.put_session, {
                    "active_stage": "build", "active_run_id": "new-run",
                    "workflow": {"mode": "overnight", "preset": "starter_2tier"},
                    "brainstorm": {"selected_l0_model": "codex_sub:new-selection"},
                }).result(timeout=2)
                self.assertEqual(status, 200, body)
            finally:
                release.set()
            status, body = turn.result(timeout=5)
        self.assertEqual(status, 200, body)
        saved = self.get_session()
        self.assertEqual(saved["workflow"]["preset"], "starter_2tier")
        self.assertEqual((saved["active_stage"], saved["active_run_id"]), ("build", "new-run"))
        self.assertEqual(saved["brainstorm"]["selected_l0_model"], "codex_sub:new-selection")
        self.assertEqual(saved["brainstorm"]["latest_rfc_draft"], self.RFC)
        self.assertTrue(saved["brainstorm"]["has_online_draft"])

    def test_session_remains_accessible_during_readiness_scan(self) -> None:
        entered, release = threading.Event(), threading.Event()
        original = web_server._CanvasRequestHandler._readiness

        def slow_readiness(handler: object, repo: object = None, config: object = None) -> object:
            entered.set()
            if not release.wait(10):
                raise RuntimeError("test did not release readiness scan")
            return original(handler, repo, config)

        def runner(_: str) -> tuple[str, str, str]:
            return "codex_sub", "model", f"Ready.\n````rfc\n{self.RFC}````\n"

        with patch.object(brainstorm, "_provider_dispatch", return_value=runner), \
             patch.object(web_server._CanvasRequestHandler, "_readiness", slow_readiness), \
             ThreadPoolExecutor(max_workers=3) as pool:
            turn = pool.submit(self._post, "/api/brainstorm/chat", {"messages": self.MESSAGE})
            try:
                self.assertTrue(entered.wait(5), "readiness scan did not start")
                restored = pool.submit(self.get_session).result(timeout=2)
                self.assertEqual(restored["brainstorm"]["latest_rfc_draft"], self.RFC)
                status, body = pool.submit(self.put_session, {"workflow": {"preset": "starter_2tier"}}).result(timeout=2)
                self.assertEqual(status, 200, body)
            finally:
                release.set()
            status, body = turn.result(timeout=5)
        self.assertEqual(status, 200, body)
        self.assertEqual(self.get_session()["workflow"]["preset"], "starter_2tier")

    def test_new_online_draft_wins_over_an_in_flight_turn(self) -> None:
        for successful in (False, True):
            with self.subTest(successful=successful):
                self._post("/api/guided/session/reset", {})
                entered, release = threading.Event(), threading.Event()

                def runner(_: str) -> tuple[str, str, str]:
                    entered.set()
                    if not release.wait(10):
                        raise RuntimeError("test did not release dispatcher")
                    if not successful:
                        raise RuntimeError("model failed")
                    return "codex_sub", "model", f"Ready.\n````rfc\n{self.RFC}````\n"

                with patch.object(brainstorm, "_provider_dispatch", return_value=runner), \
                     ThreadPoolExecutor(max_workers=2) as pool:
                    turn = pool.submit(self._post, "/api/brainstorm/chat", {"messages": self.MESSAGE})
                    try:
                        self.assertTrue(entered.wait(5))
                        status, body = pool.submit(self.put_session, {"brainstorm": {
                            "latest_rfc_draft": "# Newer online draft\n",
                            "has_online_draft": True,
                            "messages": [{"role": "assistant", "content": "Newer conversation"}],
                        }}).result(timeout=2)
                        self.assertEqual(status, 200, body)
                        newer = body["session"]
                    finally:
                        release.set()
                    status, body = turn.result(timeout=5)
                self.assertEqual((status, body["code"]), (409, "BRAINSTORM_SESSION_CHANGED"))
                self.assertEqual(self.get_session(), newer)

    def test_changes_during_readiness_scan_invalidate_the_old_response(self) -> None:
        for reset in (False, True):
            with self.subTest(reset=reset):
                self._post("/api/guided/session/reset", {})
                entered, release = threading.Event(), threading.Event()
                original = web_server._CanvasRequestHandler._readiness

                def slow_readiness(handler: object, repo: object = None, config: object = None) -> object:
                    entered.set()
                    if not release.wait(10):
                        raise RuntimeError("test did not release readiness scan")
                    return original(handler, repo, config)

                def runner(_: str) -> tuple[str, str, str]:
                    return "codex_sub", "model", f"Ready.\n````rfc\n{self.RFC}````\n"

                with patch.object(brainstorm, "_provider_dispatch", return_value=runner), \
                     patch.object(web_server._CanvasRequestHandler, "_readiness", slow_readiness), \
                     ThreadPoolExecutor(max_workers=2) as pool:
                    turn = pool.submit(self._post, "/api/brainstorm/chat", {"messages": self.MESSAGE})
                    try:
                        self.assertTrue(entered.wait(5))
                        self.assertEqual(self.get_session()["brainstorm"]["latest_rfc_draft"], self.RFC)
                        if reset:
                            status, body = pool.submit(self._post, "/api/guided/session/reset", {}).result(timeout=2)
                        else:
                            status, body = pool.submit(self.put_session, {"brainstorm": {
                                "latest_rfc_draft": "# Edited while scanning\n",
                            }}).result(timeout=2)
                        self.assertEqual(status, 200, body)
                        newer = body["session"]
                    finally:
                        release.set()
                    status, body = turn.result(timeout=5)
                self.assertEqual((status, body["code"]), (409, "BRAINSTORM_SESSION_CHANGED"))
                self.assertEqual(self.get_session(), newer)

    def test_reset_cancels_in_flight_turn_even_for_an_empty_session(self) -> None:
        entered, release = threading.Event(), threading.Event()

        def runner(_: str) -> tuple[str, str, str]:
            entered.set()
            if not release.wait(10):
                raise RuntimeError("test did not release dispatcher")
            return "codex_sub", "model", f"Ready.\n````rfc\n{self.RFC}````\n"

        with patch.object(brainstorm, "_provider_dispatch", return_value=runner), \
             ThreadPoolExecutor(max_workers=2) as pool:
            turn = pool.submit(self._post, "/api/brainstorm/chat", {"messages": self.MESSAGE})
            try:
                self.assertTrue(entered.wait(5))
                status, body = pool.submit(self._post, "/api/guided/session/reset", {}).result(timeout=2)
                self.assertEqual(status, 200, body)
                reset_session = body["session"]
            finally:
                release.set()
            status, body = turn.result(timeout=5)
        self.assertEqual((status, body["code"]), (409, "BRAINSTORM_SESSION_CHANGED"))
        self.assertEqual(self.get_session(), reset_session)

    def test_explicit_legacy_l0_override_takes_precedence_over_saved_selection(self) -> None:
        seen: list[dict | None] = []

        def dispatch(_cfg: object, overrides: dict | None) -> object:
            seen.append(overrides)
            return lambda _: ("codex_sub", "gpt-6.2-sol@high", f"Ready.\n````rfc\n{self.RFC}````\n")

        with patch.object(brainstorm, "_provider_dispatch", side_effect=dispatch):
            status, body = self._post("/api/brainstorm/chat", {
                "messages": self.MESSAGE, "requested_l0_model": "codex_sub:gpt-6.2-astra@xhigh",
            })
            self.assertEqual(status, 200, body)
            status, body = self._post("/api/brainstorm/chat", {
                "messages": self.MESSAGE,
                "model_overrides": {"brainstorm_and_final_gate": "codex_sub:gpt-6.2-sol@high"},
            })
        self.assertEqual(status, 200, body)
        self.assertEqual(seen[-1]["brainstorm_and_final_gate"], "codex_sub:gpt-6.2-sol@high")
        self.assertEqual(self.get_session()["brainstorm"]["selected_l0_model"], "codex_sub:gpt-6.2-sol@high")

    def test_concurrent_partial_updates_merge_across_servers(self) -> None:
        other = self.start_server(self._create_server())

        def update(item: tuple[str, dict]) -> tuple[int, dict]:
            base, payload = item
            request = Request(base + "/api/guided/session", data=json.dumps({"session": payload}).encode(),
                              method="PUT", headers={"Content-Type": "application/json"})
            status, _, body = self._request(request)
            return status, body

        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(update, [
                (self.base, {"brainstorm": {"latest_rfc_draft": self.RFC}}),
                (other, {"workflow": {"preset": "starter_2tier"}}),
            ]))
        self.assertTrue(all(status == 200 for status, _ in results), results)
        session = self.get_session()
        self.assertEqual(session["brainstorm"]["latest_rfc_draft"], self.RFC)
        self.assertEqual(session["workflow"]["preset"], "starter_2tier")

    def test_lineup_map_updates_preserve_other_roles_and_allow_removal(self) -> None:
        status, body = self.put_session({"workflow": {"lineup": {
            "roles": {"first": "codex_sub", "second": "claude_sub"},
            "model_overrides": {"first": "codex_sub:model"},
        }}})
        self.assertEqual(status, 200, body)
        status, body = self.put_session({"workflow": {"lineup": {"roles": {"second": "dsh_opencode"}}}})
        self.assertEqual(status, 200, body)
        self.assertEqual(body["session"]["workflow"]["lineup"]["roles"],
                         {"first": "codex_sub", "second": "dsh_opencode"})
        status, body = self.put_session({"workflow": {"lineup": {
            "roles": {"first": None}, "model_overrides": {},
        }}})
        self.assertEqual(status, 200, body)
        self.assertEqual(body["session"]["workflow"]["lineup"], {
            "roles": {"second": "dsh_opencode"}, "model_overrides": {},
        })

    def test_ready_l0_models_and_auto_selection(self) -> None:
        status, body = self._get("/api/guided/l0-models")
        self.assertEqual(status, 200, body)
        self.assertTrue(body["models"])
        self.assertIn(body["auto_selected"], [model["spec"] for model in body["models"]])
        claude = next(item for item in self.scan["drivers"] if item["id"] == "claude")
        claude["status"] = "installed_unauthenticated"
        status, body = self._get("/api/guided/l0-models")
        self.assertEqual(status, 200, body)
        self.assertTrue(all(model["provider"] != "claude_sub" for model in body["models"]))

    def test_saved_teams_with_impossible_efforts_are_corrected_once(self) -> None:
        path = self.credentials_path.parent / "lineup_profiles.json"
        path.write_text(json.dumps({"profiles": [], "last_used": {
            "roles": {"bulk_worker": "dsh_opencode", "brainstorm_and_final_gate": "codex_sub"},
            "model_overrides": {"bulk_worker": "dsh_opencode:deepseek-v4.1-flash@medium",
                                "brainstorm_and_final_gate": "codex_sub:gpt-6.2-astra@high"},
        }}), encoding="utf-8")
        status, body = self._get("/api/lineup-profiles")
        self.assertEqual(status, 200, body)
        self.assertEqual(body["last_used"]["model_overrides"]["bulk_worker"], "dsh_opencode:deepseek-v4.1-flash@max")
        self.assertEqual(body["last_used"]["model_overrides"]["brainstorm_and_final_gate"], "codex_sub:gpt-6.2-astra@high")
        self.assertEqual(body["corrections"], [{
            "where": "last_used", "role": "bulk_worker", "before": "dsh_opencode:deepseek-v4.1-flash@medium",
            "after": "dsh_opencode:deepseek-v4.1-flash@max", "reason": "effort_adjusted",
        }])
        self.assertEqual(self._get("/api/lineup-profiles")[1]["corrections"], [])  # saved: shown once
        # A new save cannot reintroduce the impossible effort.
        status, saved = self._post("/api/lineup-profiles/last-used", {
            "roles": {"bulk_worker": "dsh_opencode"}, "model_overrides": {"bulk_worker": "dsh_opencode:deepseek-v4.1-flash@medium"},
        })
        self.assertEqual(status, 200, saved)
        self.assertEqual(saved["last_used"]["model_overrides"]["bulk_worker"], "dsh_opencode:deepseek-v4.1-flash@max")

    def test_launch_refuses_an_effort_the_tool_does_not_offer_and_suggests_one(self) -> None:
        lineup = self.lineup()
        lineup["roles"]["bulk_worker"] = "dsh_opencode"
        lineup["model_overrides"]["bulk_worker"] = "dsh_opencode:deepseek-v4.1-flash@medium"
        status, body = self._post("/api/runs/start", {
            "rfc_markdown": self.RFC, "mode": "overnight", "lineup": lineup, "launch_request_id": "bad-effort",
        })
        self.assertEqual(status, 409, body)
        self.assertEqual(body["code"], "LAUNCH_PREFLIGHT")
        self.assertIn("effort_not_allowed", body["codes"])
        self.assertEqual(body["effort_changes"][0]["after"], "dsh_opencode:deepseek-v4.1-flash@max")
        self.assertEqual(body["suggested_lineup"]["model_overrides"]["bulk_worker"], "dsh_opencode:deepseek-v4.1-flash@max")
        self.assertEqual(self.store.list_runs(limit=5), [])

    def test_guided_launch_hands_the_project_size_to_the_planner(self) -> None:
        from vibebaton.config import HotReloadConfig
        from vibebaton.engine import OrchestrationEngine

        lineup = {**self.lineup(), "size": "small"}
        status, body = self._post("/api/runs/start", {
            "rfc_markdown": self.RFC, "mode": "overnight", "lineup": lineup, "launch_request_id": "sized",
        })
        self.assertEqual(status, 201, body)
        engine = OrchestrationEngine(self.repo, HotReloadConfig(self.server.loader.path), self.store)
        self.assertEqual(engine._guided_project_size(body["run_id"]), "small")

    def test_duplicate_key_recovers_one_run_and_one_session_across_servers(self) -> None:
        other = self.start_server(self._create_server())
        payload = {"rfc_markdown": self.RFC, "launch_request_id": "same-key", "lineup": self.lineup()}

        def launch(index: int) -> tuple[int, dict]:
            request = Request((self.base if index % 2 else other) + "/api/runs/start",
                              data=json.dumps(payload).encode(), method="POST",
                              headers={"Content-Type": "application/json"})
            status, _, body = self._request(request)
            return status, body

        with ThreadPoolExecutor(max_workers=4) as pool:
            replies = list(pool.map(launch, range(4)))
        self.assertTrue(all(status in (200, 201) for status, _ in replies), replies)
        run_ids = {body["run_id"] for _, body in replies}
        self.assertEqual(len(run_ids), 1)
        self.assertEqual(len(self.store.list_runs()), 1)
        self.assertEqual(len(self.spawn_calls), 1)
        session = self.get_session()
        self.assertEqual(session["active_run_id"], run_ids.pop())
        self.assertEqual(session["workflow"]["launch_request_id"], "same-key")

    def test_session_write_failure_returns_run_id_and_retry_restores_session(self) -> None:
        payload = {"rfc_markdown": self.RFC, "launch_request_id": "recover-session", "lineup": self.lineup()}
        with patch.object(guided_session, "save_session", side_effect=OSError("storage unavailable")):
            status, failed = self._post("/api/runs/start", payload)
        self.assertEqual(status, 500, failed)
        self.assertEqual(failed["code"], "SESSION_IO_ERROR")
        self.assertIsNotNone(self.store.get_run(failed["run_id"]))
        self.assertEqual(len(self.spawn_calls), 1)
        status, replay = self._post("/api/runs/start", {"launch_request_id": "recover-session"})
        self.assertEqual((status, replay["run_id"]), (200, failed["run_id"]))
        self.assertEqual(self.get_session()["active_run_id"], failed["run_id"])
        self.assertEqual(len(self.spawn_calls), 1)

    def test_revision_revalidates_parent_lineup_and_rollback_updates_stage(self) -> None:
        first = self.launch()
        selected = self.get_session()["workflow"]["lineup"]
        self.settle(first)
        self.scan = example_scan(())
        status, body = self._post(f"/api/runs/{first}/finalize", {"action": "revise", "note": "Fix it"})
        self.assertEqual(status, 409, body)
        self.assertIn("lineup_unavailable", body["codes"])
        self.assertEqual(len(self.store.list_runs()), 1)
        self.assertEqual(len(self.spawn_calls), 1)
        self.scan = example_scan(("agy", "gemini", "claude", "codex", "dsh"), http_key=True)
        status, body = self._post(f"/api/runs/{first}/finalize", {"action": "revise", "note": "Fix it"})
        self.assertEqual(status, 200, body)
        child = body["revision_run_id"]
        self.assertEqual(self.get_session()["active_run_id"], child)
        self.assertEqual(self.get_session()["workflow"]["lineup"], selected)
        self.assertEqual(json.loads(self.store.get_run(child)["model_overrides_json"]), selected["model_overrides"])
        self.settle(child)
        status, body = self._post(f"/api/runs/{child}/rollback", {"mode": "revert_revision"})
        self.assertEqual(status, 200, body)
        self.assertEqual(self.get_session()["active_stage"], "signoff")

    def test_corrupt_parent_overrides_reject_revision_without_starting_child(self) -> None:
        status, body = self._post("/api/runs/start", {"rfc_markdown": self.RFC})
        self.assertEqual(status, 201, body)
        run_id = body["run_id"]
        self.settle(run_id)
        with self.store._connect() as conn:
            conn.execute("UPDATE runs SET model_overrides_json = ? WHERE id = ?", ("{broken", run_id))
        status, body = self._post(f"/api/runs/{run_id}/finalize", {"action": "revise", "note": "Fix it"})
        self.assertEqual((status, body["code"]), (409, "RUN_STALE"))
        self.assertEqual(len(self.store.list_runs()), 1)
        self.assertEqual(len(self.spawn_calls), 1)

    def test_stop_and_replan_returns_session_to_blueprint(self) -> None:
        run_id = self.launch()
        self.settle(run_id)
        status, body = self._post(f"/api/runs/{run_id}/stop-and-replan", {})
        self.assertEqual(status, 200, body)
        session = self.get_session()
        self.assertEqual(session["active_stage"], "blueprint")
        self.assertEqual(session["active_run_id"], run_id)
        status, replay = self._post("/api/runs/start", {"launch_request_id": "request-1"})
        self.assertEqual((status, replay["run_id"]), (200, run_id))
        self.assertEqual(self.get_session(), session)
        self.assertEqual(len(self.spawn_calls), 1)


if __name__ == "__main__":
    import unittest
    unittest.main()
