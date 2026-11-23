"""Run-case contract shared by the exporter and replay player."""

from __future__ import annotations

import hashlib
import io
import json
import runpy
import sys
import tempfile
import unittest
from contextlib import chdir, redirect_stderr, redirect_stdout
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from unittest.mock import patch
from urllib.parse import urlencode

from vibebaton.case_export import audit_serialized, export_sanitized_case, redact_identity, redact_secrets
from vibebaton.db import StateStore
from vibebaton.graph_engine import TRACE_KINDS
from vibebaton.graph_schema import WorkflowGraph, validate_graph
from vibebaton.schemas import MilestoneSpec, PlanDAG, RunStatus, TaskSpec, TaskStatus
from vibebaton import case_export

from tests.test_web_server import WebServerTestCase


_OPENAI_KEY = "sk-fake-for-case-export-123"
_GITHUB_KEY = "ghp_fakeforcaseexport012345"
_SLACK_APP_TOKEN = "xapp-1-FAKE-123456789012"
_HOME_PATH = r"C:\Users\caseworker\notes.txt"
_DRIVE_PATH = "E:/work/secret/file.txt"
_UNC_PATH = r"\\server\share\private\artifact.json"
_EMAIL = "worker@example.test"
_PRIVATE_IP = "192.168.1.10"
_WEBHOOK = "https://open.feishu.cn/open-apis/bot/v2/hook/fake-case-hook"
_RAW_DIFF = "\n".join((
    "diff --git a/demo.txt b/demo.txt",
    "--- a/demo.txt",
    "+++ b/demo.txt",
    "@@ -1 +1 @@",
    "-old content",
    "+private source line",
))
_RAW_STACK = "\n".join((
    "Traceback (most recent call last):",
    '  File "/home/caseworker/export.py", line 1, in <module>',
    "    build_case()",
    "ValueError: private exception detail",
))
_REVIEW_SUMMARY = f"Reviewed the sample report with {_GITHUB_KEY}."
_GOLDEN_FIXTURE = Path(__file__).parent / "fixtures" / "golden_case_bundle.json"
_GOLDEN_START = 1795334400
_COUNTERS = (
    "secrets_redacted",
    "paths_anonymized",
    "emails_redacted",
    "ips_redacted",
    "raw_diff_stripped",
    "raw_stack_stripped",
)


def _write_role_config(repo_path: Path) -> None:
    repo_path.mkdir(parents=True, exist_ok=True)
    roles = {
        "tactical_planner": ("claude_sub", "plan-default"),
        "milestone_reviewer": ("claude_sub", "review-default"),
        "bulk_worker": ("dsh_opencode", "deepseek-flash"),
        "critical_executor": ("codex_sub", "sol-default"),
        "brainstorm_and_final_gate": ("host_native", "signoff"),
    }
    (repo_path / "baton.json").write_text(json.dumps({
        "providers": {provider: {} for provider, _ in roles.values() if provider != "host_native"},
        "roles": {role: {"provider": provider, "model": model} for role, (provider, model) in roles.items()},
    }), encoding="utf-8")


def _seed_run(tmp_path: Path, **overrides: Any) -> tuple[StateStore, str]:
    """Build a real SQLite run. Overrides accept create_run fields, summary, and status."""
    store = StateStore(tmp_path / "state.sqlite")
    repo_path = Path(overrides.pop("repo_path", tmp_path / "repo")).resolve()
    _write_role_config(repo_path)
    status = overrides.pop("status", RunStatus.COMPLETED)
    summary = overrides.pop("summary", f"Packaged the sample run from {repo_path}.")
    run_fields = {
        "run_id": "run-golden",
        "repo_path": repo_path,
        "rfc_path": repo_path / "00_RFC.md",
        **overrides,
    }
    run_id = store.create_run(**run_fields)
    store.register_plan(
        run_id,
        PlanDAG(
            rfc_version="v1.0",
            complexity_tier="S",
            milestones=[
                MilestoneSpec(
                    id="M1",
                    title="Prepare the case export",
                    tasks=[
                        TaskSpec(
                            id="M1-T1",
                            title=f"Package the sample report from {_HOME_PATH}",
                            description=f"Test data includes {_OPENAI_KEY}.",
                        )
                    ],
                )
            ],
        ),
    )
    store.log_event(
        run_id, "task_started", task_id="M1-T1", milestone_id="M1",
        message=f"Started packaging from {repo_path} with {_OPENAI_KEY}.",
    )
    store.update_task(
        run_id, "M1-T1", status=TaskStatus.PASSED, duration_sec=4.0,
        last_review_json={"verdict": "PASS", "summary": _REVIEW_SUMMARY},
    )
    store.log_event(
        run_id, "task_passed", task_id="M1-T1", milestone_id="M1",
        message=(
            f"Packaged a report for {_EMAIL} at {_PRIVATE_IP} with {_GITHUB_KEY}.\n"
            f"Notification destination: {_WEBHOOK}\n\n{_RAW_DIFF}\n\n{_RAW_STACK}"
        ),
    )
    store.update_milestone(
        run_id, "M1", TaskStatus.PASSED,
        review_json={"verdict": "PASS", "summary": _REVIEW_SUMMARY},
    )
    store.log_event(run_id, "milestone_passed", milestone_id="M1", message=_REVIEW_SUMMARY)
    store.update_run_status(run_id, status, summary=summary)
    return store, run_id


class TestPathAndCodeLayers(unittest.TestCase):
    def setUp(self) -> None:
        self.directory = Path(self.enterContext(tempfile.TemporaryDirectory()))
        self.enterContext(patch(
            "vibebaton.credentials.default_credentials_path",
            return_value=self.directory / "credentials.json",
        ))
        self.store, self.run_id = _seed_run(self.directory)

    def test_path_precedence_and_protected_text(self) -> None:
        repo = r"C:\Users\caseworker\repo"
        protected = (
            "https://example.test/var/log/x.log?local=/home/caseworker/private.txt",
            f"https://example.test/?repo={repo}",
            f"https://example.test/?drive={_DRIVE_PATH}&network={_UNC_PATH}",
            "#recipe=/tmp/private/recipe.json",
            r"#recipe=D:\work\thing\recipe.json",
            "worker_1 l0_planner data/var/log/x.log",
        )
        original = (
            "C:/USERS/CASEWORKER/REPO/var/log/repo.log", _HOME_PATH,
            r"D:\work\thing\file.py", "/var/log/x.log", _DRIVE_PATH, _UNC_PATH, *protected,
        )
        expected = (
            "<repo>/var/log/repo.log", r"<home>\notes.txt",
            "<path>/file.py", "<path>/x.log", "<path>/file.txt", "<path>/artifact.json", *protected,
        )
        result = "\n".join(expected)
        self.assertEqual(case_export.anonymize_paths("\n".join(original), repo), (result, 6))
        self.assertTrue(audit_serialized(json.dumps({"message": result})))
        for root in ("var", "opt", "tmp", "srv", "mnt", "etc", "usr"):
            with self.subTest(root=root):
                path = f"/{root}/private/file.txt"
                self.assertEqual(case_export.anonymize_paths(path, None), ("<path>/file.txt", 1))
                self.assertFalse(audit_serialized(json.dumps({"message": path})))

    def test_patch_headers_and_last_hunk_line(self) -> None:
        diff = "\r\n".join((
            "--- a/demo.txt", "+++ b/demo.txt", "@@ -1,2 +1,2 @@",
            "-old content", "+private source line", " context line",
            r"\ No newline at end of file",
        ))
        original = f"Before\r\n{diff}\r\nBetween\n{_RAW_DIFF}\nAfter"
        expected = "Before\r\n[diff stripped]\r\nBetween\n[diff stripped]\nAfter"
        self.assertEqual(case_export.strip_code_blocks(original), (expected, 2, 0))
        self.assertFalse(audit_serialized(json.dumps({"message": diff})))

    def test_python_and_js_traceback_boundaries(self) -> None:
        frame = "    at start (runner.js:9:2)"
        js = f"{frame}\n    at async run (runner.js:12:4)"
        python = (
            f"{_RAW_STACK}\n\nThe above exception was the direct cause of the following exception:\n\n"
            f"{_RAW_STACK.replace('ValueError: private exception detail', 'KeyboardInterrupt')}"
        )
        original = f"Before\n{python}\nBetween\n{js}\nAfter\n{frame}"
        expected = f"Before\n[stack trace stripped]\nBetween\n[stack trace stripped]\nAfter\n{frame}"
        self.assertEqual(case_export.strip_code_blocks(original), (expected, 0, 2))
        self.assertFalse(audit_serialized(json.dumps({"message": js})))
        self.assertTrue(audit_serialized(json.dumps({"message": frame})))
        self.assertEqual(
            case_export.strip_code_blocks("Traceback (most recent call last):\nValueError: detail"),
            ("[stack trace stripped]", 0, 1),
        )

    def test_seeded_case_contains_the_redacted_replay(self) -> None:
        url = "https://example.test/var/log/x.log"
        message = (
            rf"Open D:\work\thing\file.py and /var/log/x.log. See {url}." "\n"
            "    at first (/opt/private/runner.js:2:4)\n"
            r"    at second (D:\work\thing\runner.js:4:6)"
        )
        self.store.log_event(self.run_id, "task_passed", message=message, task_id="M1-T1")

        bundle = export_sanitized_case(self.store, self.run_id)
        event = bundle["trace"][-1]
        self.assertEqual(event["node_id"], "t_M1-T1")
        self.assertEqual(
            event["message"], f"Open <path>/file.py and <path>/x.log. See {url}.\n[stack trace stripped]",
        )
        messages = "\n".join(event["message"] for event in bundle["trace"])
        self.assertIn("[diff stripped]\n\n[stack trace stripped]", messages)
        for counter in _COUNTERS:
            self.assertGreater(bundle["redaction_report"][counter], 0, counter)
        self.assertEqual(bundle["redaction_report"]["raw_diff_stripped"], 1)
        self.assertEqual(bundle["redaction_report"]["raw_stack_stripped"], 2)
        self.assertIs(bundle["redaction_report"]["clean"], True)

    def test_rfc_reference_and_plan_description(self) -> None:
        run = self.store.get_run(self.run_id) or {}
        rfc_path = Path(run["rfc_path"])
        body = "# RFC\n\nPrivate RFC body for the task."
        rfc_path.parent.mkdir(exist_ok=True)
        rfc_path.write_text(body, encoding="utf-8")
        self.store.log_event(self.run_id, "rfc_loaded", message=body, payload={"rfc_markdown": body})
        self.store.log_event(self.run_id, "plan_generated", message=f"Loaded {rfc_path}")
        description = "Plan description: " + "x" * 222
        self.store.log_event(self.run_id, "plan_registered", message=description)
        self.store.log_event(self.run_id, "plan_registered", message=description + " private tail")

        with patch.object(self.store, "get_run", return_value={**run, "rfc_markdown": body}):
            bundle = export_sanitized_case(self.store, self.run_id)
        messages = [event["message"] for event in bundle["trace"]]
        self.assertEqual(messages[-3:], ["Loaded 00_RFC.md", description, description[:239] + "…"])
        self.assertEqual(messages[-4], "RFC: 00_RFC.md")
        self.assertNotIn("Private RFC body", json.dumps(bundle))

    def test_review_messages_project_both_outcomes(self) -> None:
        review_events = (
            ("task_review_passed", "Task review passed privately", "Passed review"),
            ("task_review_rejected", "Task review rejected privately", "Review revision requested"),
            ("milestone_rejected", "Milestone review rejected privately", "Review revision requested"),
            ("plan_amendment_requested", "Private plan amendment details", "Review revision requested"),
            ("task_escalated", "MAJOR_REWORK escalated M1-T1 to critical_executor", "Review revision requested"),
            (
                "human_attention_required",
                "Milestone M1 reviewer requested PLAN_AMENDMENT: private",
                "Review revision requested",
            ),
        )
        for kind, message, _ in review_events:
            self.store.log_event(
                self.run_id, kind, message=message, milestone_id="M1",
                task_id="M1-T1" if kind.startswith("task_") else None,
            )

        bundle = export_sanitized_case(self.store, self.run_id, include_review_summaries=False)
        messages = [event["message"] for event in bundle["trace"]]
        expected = [
            "Passed review",
            "Prepare the case export → Final sign-off",
            "Run status COMPLETED",
            *(label for _, _, label in review_events),
        ]
        self.assertEqual(messages[-len(expected):], expected)
        self.assertTrue(messages[0].startswith("Run created"))

    def test_anonymous_id_is_shared_across_the_bundle(self) -> None:
        self.store.update_run_status(self.run_id, RunStatus.COMPLETED, summary=f"Finished {self.run_id}")
        self.store.log_event(self.run_id, "task_started", message=f"Mentioned {self.run_id}")
        alias = f"case-{hashlib.sha256(self.run_id.encode()).hexdigest()[:10]}"

        default = export_sanitized_case(self.store, self.run_id)
        self.assertEqual(default["case_id"], "case-d34fcd56467b")
        self.assertEqual(default["meta"]["source_run_id"], self.run_id)
        bundle = export_sanitized_case(self.store, self.run_id, anonymize_run_id=True)
        self.assertEqual(bundle["case_id"], alias)
        self.assertEqual(bundle["graph"]["id"], alias)
        self.assertEqual(bundle["meta"]["source_run_id"], alias)
        self.assertEqual(bundle["title"], f"Run {alias}")
        self.assertEqual(bundle["summary"], f"Finished {alias}")
        self.assertEqual(bundle["trace"][-1]["message"], f"Mentioned {alias}")
        self.assertNotIn(self.run_id, json.dumps(bundle))


class CaseExportTests(unittest.TestCase):
    def setUp(self) -> None:
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        tmp_path = Path(directory.name)
        self.enterContext(patch(
            "vibebaton.credentials.default_credentials_path", return_value=tmp_path / "credentials.json",
        ))
        self.store, self.run_id = _seed_run(tmp_path)

    def _assert_bundle_shape(self, bundle: dict[str, Any]) -> None:
        self.assertEqual(bundle["schema_version"], "baton-case/v1")
        for field in ("case_id", "title", "summary"):
            self.assertIsInstance(bundle[field], str)
        self.assertTrue(bundle["case_id"])
        created_at = datetime.fromisoformat(bundle["created_at"])
        self.assertEqual(created_at.utcoffset(), timezone.utc.utcoffset(created_at))

        meta = bundle["meta"]
        self.assertIsInstance(meta["source_run_id"], str)
        self.assertIsInstance(meta["status"], str)
        self.assertIsInstance(meta["elapsed_sec"], (int, float))
        for field in (
            "milestones_passed", "milestones_total", "tasks_passed", "tasks_total",
            "gate_catches", "whitelist_catches", "escalations",
        ):
            self.assertIs(type(meta[field]), int)
        self.assertIsInstance(meta["models"], list)
        self.assertIsInstance(meta["stages"], list)
        self.assertIsInstance(meta["billing"], dict)

        report = bundle["redaction_report"]
        for counter in _COUNTERS:
            self.assertIs(type(report[counter]), int)
            self.assertGreater(report[counter], 0, counter)
        self.assertIs(report["clean"], True)

        serialized = json.dumps(bundle)
        for raw in (
            _OPENAI_KEY, _GITHUB_KEY, "caseworker", _EMAIL, _PRIVATE_IP, _WEBHOOK,
            "diff --git", "private source line", "Traceback (most recent call last)",
            "private exception detail",
        ):
            self.assertNotIn(raw, serialized)
        self.assertTrue(audit_serialized(serialized))

    def _assert_valid_graph(self, graph: dict[str, Any]) -> None:
        self.assertEqual(graph["schema_version"], "1.0")
        result = validate_graph(WorkflowGraph.from_dict(graph))
        self.assertTrue(result.valid, result.errors)
        self.assertFalse(result.has_cycles)
        self.assertEqual(result.entry_nodes, ["l0_planner"])
        nodes = {node["id"]: node["type"] for node in graph["nodes"]}
        self.assertEqual(nodes["l0_planner"], "planner_node")
        self.assertEqual(nodes["l0_final_gate"], "human_gate_node")
        self.assertEqual(list(nodes.values()).count("worker_node"), 1)
        self.assertEqual(list(nodes.values()).count("reviewer_node"), 1)

    def _assert_ordered_trace(self, bundle: dict[str, Any]) -> None:
        trace = bundle["trace"]
        self.assertIsInstance(trace, list)
        self.assertTrue(trace)
        self.assertEqual([event["seq"] for event in trace], list(range(1, len(trace) + 1)))
        timestamps = [event["timestamp"] for event in trace]
        self.assertEqual(timestamps, sorted(timestamps))
        node_ids = {node["id"] for node in bundle["graph"]["nodes"]}
        edge_ids = {edge["id"] for edge in bundle["graph"]["edges"]}
        for event in trace:
            self.assertIn(event["kind"], {
                "node_started", "node_completed", "node_failed", "edge_traversed",
                "loop_limit_reached", "graph_completed", "graph_halted",
            })
            self.assertIn(event["node_id"], node_ids | {None})
            self.assertIn(event["edge_id"], edge_ids | {None})
            self.assertIsInstance(event["timestamp"], (int, float))
            self.assertIsInstance(event["message"], str)
            self.assertIn(event["outcome"], {"passed", "retry", "escalated", "failed", "info"})

    def test_bundle_shape(self) -> None:
        bundle = export_sanitized_case(self.store, self.run_id)
        self._assert_bundle_shape(bundle)
        self.assertEqual(bundle["meta"]["source_run_id"], self.run_id)

    def test_graph_validates(self) -> None:
        bundle = export_sanitized_case(self.store, self.run_id)
        self._assert_valid_graph(bundle["graph"])

    def test_trace_nonempty_and_ordered(self) -> None:
        latest_event = self.store.get_events(self.run_id, limit=1)[0]
        with patch("vibebaton.db.time.time", return_value=latest_event["created_at"] - 1):
            self.store.log_event(
                self.run_id, "task_review_rejected", task_id="M1-T1", milestone_id="M1",
                message="Earlier revision request recorded after the run",
            )
        self._assert_ordered_trace(export_sanitized_case(self.store, self.run_id))

    def test_unknown_run_raises(self) -> None:
        with self.assertRaises(LookupError):
            export_sanitized_case(self.store, "run-missing")

    def test_golden_fixture(self) -> None:
        fixture = _GOLDEN_FIXTURE.read_text(encoding="utf-8")
        bundle = json.loads(fixture)
        self._assert_bundle_shape(bundle)
        self._assert_valid_graph(bundle["graph"])
        self._assert_ordered_trace(bundle)
        directory = Path(self.enterContext(tempfile.TemporaryDirectory()))
        with patch("vibebaton.db.time.time", side_effect=map(float, range(_GOLDEN_START, _GOLDEN_START + 10))):
            store, run_id = _seed_run(directory)
        # The replay fixture uses the original redaction markers.
        expected = json.loads(
            fixture.replace(
                "Notification destination: [REDACTED]",
                "Notification destination: https://open.feishu.cn/open-apis/bot/v2/hook/[REDACTED]",
            )
            .replace("[RAW_DIFF_STRIPPED]", "[diff stripped]")
            .replace("[RAW_STACK_STRIPPED]", "[stack trace stripped]")
        )
        self.assertEqual(export_sanitized_case(store, run_id, title="Sanitized Run Case"), expected)

    def test_audit_detects_leaks_in_serialized_text(self) -> None:
        for raw in (
            _OPENAI_KEY, _GITHUB_KEY, _SLACK_APP_TOKEN, _HOME_PATH, _DRIVE_PATH, _UNC_PATH,
            _EMAIL, _PRIVATE_IP, _WEBHOOK, _RAW_DIFF, _RAW_STACK,
        ):
            with self.subTest(raw=raw):
                self.assertFalse(audit_serialized(json.dumps({"nested": [{"message": raw}]})))
        self.assertTrue(audit_serialized(json.dumps({"version": "1.0.4", "ip": "8.8.8.8"})))

    def test_export_redacts_slack_app_token_and_absolute_windows_paths(self) -> None:
        baseline = export_sanitized_case(self.store, self.run_id)["redaction_report"]
        self.store.log_event(
            self.run_id, "task_started", task_id="M1-T1",
            message=f"Compared {_DRIVE_PATH} with {_UNC_PATH}",
        )

        bundle = export_sanitized_case(self.store, self.run_id, title=f"Replay with {_SLACK_APP_TOKEN}")

        self.assertEqual(bundle["title"], "Replay with [REDACTED]")
        self.assertEqual(bundle["trace"][-1]["message"], "Compared <path>/file.txt with <path>/artifact.json")
        report = bundle["redaction_report"]
        self.assertEqual(report["secrets_redacted"], baseline["secrets_redacted"] + 1)
        self.assertEqual(report["paths_anonymized"], baseline["paths_anonymized"] + 2)
        self.assertIs(report["clean"], True)

    def test_export_options(self) -> None:
        bundle = export_sanitized_case(
            self.store,
            self.run_id,
            title=f"{self.run_id} held CUSTOM+SECRET",
            extra_secrets=["CUSTOM+SECRET"],
            include_review_summaries=False,
            anonymize_run_id=True,
        )
        alias = bundle["meta"]["source_run_id"]
        self.assertRegex(alias, r"^case-[0-9a-f]+$")
        self.assertEqual(bundle["title"], f"{alias} held [REDACTED]")
        self.assertNotIn(self.run_id, json.dumps(bundle))
        messages = [event["message"] for event in bundle["trace"]]
        self.assertIn("Passed review", messages)
        self.assertFalse(any(message.startswith("Reviewed the sample report") for message in messages))
        self.assertTrue(bundle["redaction_report"]["clean"])


class TestSecretAndIdentityLayers(unittest.TestCase):
    def setUp(self) -> None:
        self.directory = Path(self.enterContext(tempfile.TemporaryDirectory()))
        self.credentials_path = self.directory / "credentials.json"
        self.enterContext(patch(
            "vibebaton.credentials.default_credentials_path", return_value=self.credentials_path,
        ))

    def test_each_secret_pattern_and_its_serialized_audit(self) -> None:
        cases = (
            ("", _OPENAI_KEY, ""),
            ("", _GITHUB_KEY, ""),
            ("", "github_pat_fake_for_case_export_012345", ""),
            ("", "AIzaFakeForCaseExport0123456789", ""),
            ("Bearer\n", "ab._~+/=", ""),
            ("bearer\t", "fake-token_0123", ""),
            ("", "xoxb-fake-0123456789", ""),
            ("", "xoxa-fake-0123456789", ""),
            ("", "xoxp-fake-0123456789", ""),
            ("", _SLACK_APP_TOKEN, ""),
            ("https://open.feishu.cn/open-apis/bot/v2/hook/", "fake-case-hook", "?format=json"),
            ("https://hooks.slack.com/services/", "T000/B000/fake-slack-hook", ""),
            ("https://discord.com/api/webhooks/", "1234567890/fake-discord-hook", ""),
            ("https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=", "fake-wecom-key", "&format=json"),
            ("https://oapi.dingtalk.com/robot/send?access_token=", "fake-dingtalk-token", ""),
        )
        for prefix, secret, suffix in cases:
            raw = f"{prefix}{secret}{suffix}"
            expected = f"{prefix}[REDACTED]{suffix}"
            with self.subTest(raw=raw):
                self.assertEqual(redact_secrets(raw, None), (expected, 1))
                self.assertEqual(redact_secrets(expected, None), (expected, 0))
                self.assertFalse(audit_serialized(json.dumps({"message": raw})))
                self.assertTrue(audit_serialized(json.dumps({"message": expected})))

    def test_generic_query_tokens_preserve_parameter_names_and_neighbors(self) -> None:
        for name in ("token", "key", "Access_Token", "API_KEY", "secret"):
            prefix = f"https://example.test/?mode=json&{name}="
            raw = f"{prefix}fake%2Fvalue+=&dry_run=1"
            expected = f"{prefix}[REDACTED]&dry_run=1"
            with self.subTest(name=name):
                self.assertEqual(redact_secrets(raw, None), (expected, 1))
                self.assertEqual(redact_secrets(expected, None), (expected, 0))
                self.assertFalse(audit_serialized(json.dumps({"message": raw})))
                self.assertTrue(audit_serialized(json.dumps({"message": expected})))

    def test_webhook_path_and_query_count_as_separate_hits(self) -> None:
        raw = f"{_WEBHOOK}?token=fake-query-token&mode=json"
        expected = "https://open.feishu.cn/open-apis/bot/v2/hook/[REDACTED]?token=[REDACTED]&mode=json"
        self.assertEqual(redact_secrets(raw, None), (expected, 2))
        self.assertTrue(audit_serialized(json.dumps({"message": expected})))

    def test_longest_literal_wins_over_shorter_literal_and_catalog_prefixes(self) -> None:
        longer = f"{_OPENAI_KEY}+.[extra]"
        raw = f"{longer} then {_OPENAI_KEY} then Bearer {longer}"
        self.assertEqual(
            redact_secrets(raw, (_OPENAI_KEY, "", longer)),
            ("[REDACTED] then [REDACTED] then Bearer [REDACTED]", 3),
        )
        self.assertEqual(
            redact_secrets("prefix+longer.secret", ("prefix+long", "longer.secret")),
            ("[REDACTED]", 1),
        )

    def test_missing_invalid_and_unreadable_credentials_store(self) -> None:
        raw = f"Bearer abc-123 {_OPENAI_KEY}"
        expected = ("Bearer abc-123 [REDACTED]", 1)
        self.assertEqual(redact_secrets(raw, None), expected)
        self.credentials_path.write_text("invalid JSON", encoding="utf-8")
        self.assertEqual(redact_secrets(raw, None), expected)
        with patch("vibebaton.credentials._read_local_credentials", side_effect=PermissionError):
            self.assertEqual(redact_secrets(raw, None), expected)

    def test_export_redacts_store_and_literal_secrets_then_audits_the_bundle(self) -> None:
        local_secret = "local+store.credential"
        extra_secret = f"{local_secret} with suffix"
        self.credentials_path.write_text(json.dumps({"DEEPSEEK_API_KEY": local_secret}), encoding="utf-8")
        raw = f"Used {extra_secret} and {local_secret}"
        expected = "Used [REDACTED] and [REDACTED]"
        store, run_id = _seed_run(self.directory, run_id=f"run-{local_secret}", summary=raw)
        store.log_event(run_id, "task_started", task_id="M1-T1", message=raw)

        bundle = export_sanitized_case(store, run_id, title=raw, extra_secrets=[extra_secret])
        self.assertEqual(bundle["title"], expected)
        self.assertEqual(bundle["summary"], expected)
        self.assertEqual(bundle["meta"]["source_run_id"], "run-[REDACTED]")
        messages = [event["message"] for event in bundle["trace"]]
        self.assertIn(expected, messages)
        self.assertIn(
            "Notification destination: https://open.feishu.cn/open-apis/bot/v2/hook/[REDACTED]",
            "\n".join(messages),
        )
        self.assertEqual(bundle["redaction_report"]["secrets_redacted"], 11)
        self.assertIs(bundle["redaction_report"]["clean"], True)
        serialized = json.dumps(bundle)
        for secret in (local_secret, extra_secret, _OPENAI_KEY, _GITHUB_KEY, _EMAIL, _PRIVATE_IP, _WEBHOOK):
            self.assertNotIn(secret, serialized)
        self.assertTrue(audit_serialized(serialized))

        bundle["summary"] += f" {_OPENAI_KEY}"
        self.assertFalse(audit_serialized(json.dumps(bundle)))

    def test_email_and_rfc1918_addresses_are_counted(self) -> None:
        email = "first.last+case%tag@example.test"
        for ip in ("10.0.0.1", "172.16.0.1", "172.31.255.254", "192.168.1.10"):
            with self.subTest(ip=ip):
                self.assertEqual(
                    redact_identity(f"{email} connects to {ip}:443."),
                    ("[REDACTED_EMAIL] connects to [REDACTED_IP]:443.", 1, 1),
                )
                self.assertFalse(audit_serialized(json.dumps({"ip": ip})))
        self.assertFalse(audit_serialized(json.dumps({"email": email})))

    def test_public_ips_versions_and_timestamps_survive_unchanged(self) -> None:
        for raw in (
            "1.0.4", "1.0.4-rc.10.0.0.1+192.168.1.1", "2026-11-22T10:00:00", "8.8.8.8",
            "127.0.0.1", "169.254.1.2", "172.15.0.1", "172.32.0.1", "192.168.1.256",
            "192.168.1", "192.168.1.1.2", "1.192.168.1.1", "2026.11.22.10.0.0.1",
        ):
            with self.subTest(raw=raw):
                self.assertEqual(redact_identity(raw), (raw, 0, 0))
                self.assertTrue(audit_serialized(json.dumps({"message": raw})))


class TestGraphAndTraceSynthesis(unittest.TestCase):
    def setUp(self) -> None:
        directory = Path(self.enterContext(tempfile.TemporaryDirectory()))
        self.enterContext(patch(
            "vibebaton.credentials.default_credentials_path", return_value=directory / "credentials.json",
        ))
        self.repo_path = directory / "repo"
        _write_role_config(self.repo_path)
        self.store = StateStore(directory / "state.sqlite")
        with patch("vibebaton.db.time.time", return_value=100.0):
            self.run_id = self.store.create_run(
                self.repo_path, self.repo_path / "RFC.md", run_id="run-synthesis",
                model_overrides={"tactical_planner": "claude_sub:plan-override"},
            )
        with patch("vibebaton.db.time.time", return_value=101.0):
            self.store.register_plan(self.run_id, PlanDAG(
                rfc_version="1.0", complexity_tier="S", milestones=[
                    MilestoneSpec(id="M1", title="First stage", tasks=[
                        TaskSpec(id="A", title="First worker", assigned_model="dsh_opencode:deepseek-task"),
                        TaskSpec(id="B", title="Second DSH_OpenCode worker"),
                    ]),
                    MilestoneSpec(id="M2", title="Second stage", tasks=[
                        TaskSpec(id="C", title="Final worker", assignee_role="critical_executor"),
                    ]),
                ],
            ))
        with patch("vibebaton.db.time.time", return_value=102.0):
            self.store.log_event(self.run_id, "task_started", task_id="A", message="Started dsh_opencode")
            self.store.log_event(
                self.run_id, "role_invoked", task_id="A",
                actor="bulk_worker:deepseek-task", message="Invoking bulk_worker (dsh_opencode/deepseek-task)",
            )
        with patch("vibebaton.db.time.time", return_value=104.0):
            self.store.log_event(self.run_id, "mechanical_gate_caught", task_id="A", message="Test failed")
            self.store.log_event(self.run_id, "task_escalated", task_id="A", message="Specialist took over")
        with patch("vibebaton.db.time.time", return_value=106.0):
            self.store.log_event(
                self.run_id, "role_completed", task_id="A", actor="bulk_worker:deepseek-task",
                payload={
                    "role": "bulk_worker", "provider": "dsh_opencode", "model": "deepseek-task",
                    "duration_sec": 4.0, "prompt_tokens": 12, "completion_tokens": 4,
                    "cached_tokens": 2, "cost_usd": 0.0123,
                },
            )
            self.store.update_task(self.run_id, "A", status=TaskStatus.PASSED, escalated=1)
            self.store.log_event(self.run_id, "task_passed", task_id="A", message="Worker merged")
        with patch("vibebaton.db.time.time", return_value=107.0):
            self.store.update_task(self.run_id, "B", status=TaskStatus.PASSED)
        with patch("vibebaton.db.time.time", return_value=108.0):
            self.store.log_event(self.run_id, "milestone_gate_failed", milestone_id="M1", message="Milestone check failed")
        with patch("vibebaton.db.time.time", return_value=111.0):
            self.store.update_milestone(self.run_id, "M1", TaskStatus.PASSED)
        with patch("vibebaton.db.time.time", return_value=112.0):
            self.store.log_event(self.run_id, "task_started", task_id="C", message="Started the final worker")
        with patch("vibebaton.db.time.time", return_value=116.0):
            self.store.update_task(self.run_id, "C", status=TaskStatus.FAILED)
            self.store.update_milestone(self.run_id, "M2", TaskStatus.FAILED)
        with patch("vibebaton.db.time.time", return_value=117.0):
            self.store.update_run_status(self.run_id, RunStatus.FAILED)
        with patch("vibebaton.db.time.time", return_value=103.0):
            self.store.log_event(self.run_id, "whitelist_violation", task_id="A", message="Blocked out-of-scope change")

    def test_graph_layout_and_handles_round_trip(self) -> None:
        bundle = export_sanitized_case(self.store, self.run_id)
        graph = WorkflowGraph.from_dict(json.loads(json.dumps(bundle["graph"])))
        result = validate_graph(graph)
        self.assertTrue(result.valid, result.errors)
        self.assertEqual(result.errors, [])
        self.assertEqual(graph.to_dict(), bundle["graph"])
        self.assertEqual(len(graph.nodes), 7)
        self.assertEqual(len(graph.edges), 7)
        self.assertEqual({node.id: (node.type.value, node.position) for node in graph.nodes}, {
            "l0_planner": ("planner_node", {"x": 0, "y": 0}),
            "t_A": ("worker_node", {"x": 260, "y": 0}),
            "t_B": ("worker_node", {"x": 260, "y": 120}),
            "m0_review": ("reviewer_node", {"x": 520, "y": 0}),
            "t_C": ("worker_node", {"x": 780, "y": 0}),
            "m1_review": ("reviewer_node", {"x": 1040, "y": 0}),
            "l0_final_gate": ("human_gate_node", {"x": 1300, "y": 0}),
        })
        self.assertEqual({(e.source, e.source_handle, e.target, e.target_handle) for e in graph.edges}, {
            ("l0_planner", "dag", "t_A", "in"), ("l0_planner", "dag", "t_B", "in"),
            ("t_A", "out", "m0_review", "in"), ("t_B", "out", "m0_review", "in"),
            ("m0_review", "pass", "t_C", "in"), ("t_C", "out", "m1_review", "in"),
            ("m1_review", "pass", "l0_final_gate", "in"),
        })
        configs = {node.id: node.config for node in graph.nodes}
        self.assertEqual(configs["t_A"], {"provider": "DSH", "model": "deepseek-task"})
        self.assertEqual(configs["l0_planner"], {"provider": "claude_sub", "model": "plan-override"})
        self.assertEqual(configs["m0_review"], {"provider": "claude_sub", "model": "review-default"})
        self.assertEqual(configs["l0_final_gate"], {"provider": "host_native", "model": "signoff"})
        self.assertNotIn("opencode", json.dumps(bundle).lower())

    def test_trace_uses_stored_events_and_missing_status_transitions(self) -> None:
        bundle = export_sanitized_case(self.store, self.run_id)
        trace = bundle["trace"]
        self.assertEqual([event["seq"] for event in trace], list(range(1, len(trace) + 1)))
        timestamps = [event["timestamp"] for event in trace]
        self.assertEqual(timestamps, sorted(timestamps))
        node_ids = {node["id"] for node in bundle["graph"]["nodes"]}
        edge_ids = {edge["id"] for edge in bundle["graph"]["edges"]}
        self.assertLessEqual({event["node_id"] for event in trace}, node_ids)
        self.assertLessEqual({event["kind"] for event in trace}, TRACE_KINDS)
        self.assertEqual({event["edge_id"] for event in trace if event["kind"] == "edge_traversed"},
                         {"e1", "e2", "e3", "e4", "e5"})
        self.assertLessEqual({event["edge_id"] for event in trace if event["edge_id"] is not None}, edge_ids)
        events = [(e["node_id"], e["kind"], e["outcome"], e["timestamp"]) for e in trace]
        self.assertEqual(events.count(("t_A", "node_completed", "passed", 106.0)), 1)
        self.assertIn(("t_A", "node_completed", "retry", 103.0), events)
        self.assertIn(("t_A", "node_completed", "escalated", 104.0), events)
        self.assertIn(("t_B", "node_completed", "passed", 107.0), events)
        self.assertIn(("m0_review", "node_completed", "passed", 111.0), events)
        self.assertIn(("t_C", "node_failed", "failed", 116.0), events)
        self.assertEqual(events[-1][1:], ("graph_halted", "failed", 117.0))
        self.assertIn("Started DSH", [event["message"] for event in trace])

    def test_meta_counts_models_stages_and_billing(self) -> None:
        meta = export_sanitized_case(self.store, self.run_id)["meta"]
        expected = {
            "source_run_id": self.run_id, "status": "FAILED", "elapsed_sec": 17.0,
            "milestones_passed": 1, "milestones_total": 2, "tasks_passed": 2, "tasks_total": 3,
            "gate_catches": 2, "whitelist_catches": 1, "escalations": 1,
        }
        self.assertEqual({field: meta[field] for field in expected}, expected)
        self.assertEqual([(m["provider"], m["model"]) for m in meta["models"]], [
            ("DSH", "deepseek-flash"), ("DSH", "deepseek-task"), ("claude_sub", "plan-override"),
            ("claude_sub", "review-default"), ("codex_sub", "sol-default"), ("host_native", "signoff"),
        ])
        self.assertEqual([(s["id"], s["wall_sec"]) for s in meta["stages"]], [("M1", 9.0), ("M2", 4.0)])
        self.assertEqual(meta["billing"], {
            "total_prompt_tokens": 12, "total_completion_tokens": 4, "total_cached_tokens": 2,
            "total_tokens": 16, "total_cost_usd": 0.0123, "has_exact_billing": True,
        })

    def test_unfinished_run_uses_export_time(self) -> None:
        with patch("vibebaton.db.time.time", return_value=200.0):
            run_id = self.store.create_run(self.repo_path, self.repo_path / "RFC.md")
        with patch("vibebaton.case_export.time.time", return_value=225.0):
            bundle = export_sanitized_case(self.store, run_id)
        self.assertEqual(bundle["meta"]["elapsed_sec"], 25.0)
        self.assertEqual(bundle["meta"]["stages"], [])
        self.assertEqual([node["id"] for node in bundle["graph"]["nodes"]], ["l0_planner", "l0_final_gate"])

    def test_pending_workers_use_run_override_and_keep_redacted_ids_distinct(self) -> None:
        run_id = self.store.create_run(
            self.repo_path, self.repo_path / "RFC.md", run_id="run-OpenCode",
            model_overrides={"bulk_worker": "dsh_opencode:opencode-model"},
        )
        self.store.register_plan(run_id, PlanDAG(
            rfc_version="1.0", complexity_tier="S", milestones=[
                MilestoneSpec(id="DSH_OpenCode", title="Stage", tasks=[
                    TaskSpec(id="DSH", title="First worker", assigned_model="codex_sub:sol-planned"),
                    TaskSpec(id="OpenCode", title="Second worker"),
                ]),
            ],
        ))
        self.store.log_event(run_id, "task_started", task_id="OpenCode", message="Started OpenCode worker")

        bundle = export_sanitized_case(self.store, run_id)
        workers = [node for node in bundle["graph"]["nodes"] if node["type"] == "worker_node"]
        self.assertEqual([node["config"] for node in workers], [{"provider": "DSH", "model": "DSH-model"}] * 2)
        self.assertEqual(workers[0]["id"], "t_DSH")
        self.assertNotEqual(workers[1]["id"], workers[0]["id"])
        started = next(event for event in bundle["trace"] if event["message"] == "Started DSH worker")
        self.assertEqual(started["node_id"], workers[1]["id"])
        self.assertNotIn("opencode", json.dumps(bundle).lower())

    def test_paused_stage_includes_task_updates_without_lifecycle_events(self) -> None:
        with patch("vibebaton.db.time.time", return_value=200.0):
            run_id = self.store.create_run(self.repo_path, self.repo_path / "RFC.md")
            self.store.register_plan(run_id, PlanDAG(
                rfc_version="1.0", complexity_tier="S", milestones=[
                    MilestoneSpec(id="M1", title="Stage", tasks=[TaskSpec(id="A", title="Worker")]),
                ],
            ))
        with patch("vibebaton.db.time.time", return_value=202.0):
            self.store.update_milestone(run_id, "M1", TaskStatus.RUNNING)
            self.store.log_event(run_id, "milestone_running", milestone_id="M1", message="Stage started")
        with patch("vibebaton.db.time.time", return_value=212.0):
            self.store.update_task(run_id, "A", status=TaskStatus.PASSED, duration_sec=9.0)
            self.store.update_run_status(run_id, RunStatus.PAUSED)

        stage = export_sanitized_case(self.store, run_id)["meta"]["stages"][0]
        self.assertEqual(stage["wall_sec"], 10.0)
        self.assertEqual(stage["task_sum_sec"], 9.0)


class TestCliAndApi(WebServerTestCase):
    def setUp(self) -> None:
        super().setUp()
        self.enterContext(patch(
            "vibebaton.credentials.default_credentials_path", return_value=self.credentials_path,
        ))
        _, self.run_id = _seed_run(self.repo / ".baton", repo_path=self.repo)
        self.export_path = f"/api/runs/{self.run_id}/case-export"

    def _run_cli(self, *args: str) -> tuple[int, str, str]:
        stdout, stderr = io.StringIO(), io.StringIO()
        with (
            patch.object(sys, "argv", ["vibebaton", "export-case", *args]),
            redirect_stdout(stdout),
            redirect_stderr(stderr),
            self.assertRaises(SystemExit) as raised,
        ):
            runpy.run_module("vibebaton", run_name="__main__")
        self.assertIsInstance(raised.exception.code, int)
        return raised.exception.code, stdout.getvalue(), stderr.getvalue()

    def test_cli_help(self) -> None:
        code, stdout, stderr = self._run_cli("--help")
        self.assertEqual(code, 0, stderr)
        for flag in ("--repo", "--config", "--run-id", "--out", "--title", "--no-reviews", "--anonymize"):
            self.assertIn(flag, stdout)

    def test_cli_writes_clean_bundle_in_current_directory(self) -> None:
        output_dir = self.repo / "exports"
        output_dir.mkdir()
        title = "案例回放"
        with chdir(output_dir):
            code, stdout, stderr = self._run_cli("--repo", str(self.repo), "--run-id", self.run_id, "--title", title)

        self.assertEqual(code, 0, stderr)
        serialized = (output_dir / f"{self.run_id}.baton-case.json").read_text(encoding="utf-8")
        bundle = json.loads(serialized)
        self.assertEqual(bundle["schema_version"], "baton-case/v1")
        self.assertIn(f'\n  "title": "{title}"', serialized)
        report = bundle["redaction_report"]
        self.assertIs(report["clean"], True)
        for counter in _COUNTERS:
            self.assertIn(f"{counter}: {report[counter]}", stdout.splitlines())
        self.assertIn("clean: yes", stdout.splitlines())

    def test_cli_respects_config_output_path_and_redaction_options(self) -> None:
        _, run_id = _seed_run(self.repo, repo_path=self.repo, run_id="run-configured")
        config = self.repo / "export.toml"
        config.write_text('[daemon]\ndb_path = "state.sqlite"\n', encoding="utf-8")
        output = self.repo / "configured.baton-case.json"

        with chdir(self.repo):
            code, _, stderr = self._run_cli(
                "--config", str(config), "--run-id", run_id, "--out", str(output),
                "--no-reviews", "--anonymize",
            )

        self.assertEqual(code, 0, stderr)
        bundle = json.loads(output.read_text(encoding="utf-8"))
        self.assertEqual(bundle["meta"]["source_run_id"], bundle["case_id"])
        self.assertNotIn(run_id, json.dumps(bundle))
        self.assertIn("Passed review", [event["message"] for event in bundle["trace"]])

    def test_cli_reports_unknown_run(self) -> None:
        output = self.repo / "missing.baton-case.json"
        code, _, stderr = self._run_cli(
            "--repo", str(self.repo), "--run-id", "run-missing", "--out", str(output),
        )
        self.assertEqual(code, 1)
        self.assertEqual(stderr.strip(), "Run not found: run-missing")
        self.assertFalse(output.exists())

    def test_cli_keeps_existing_file_when_redaction_audit_fails(self) -> None:
        output = self.repo / "existing.baton-case.json"
        output.write_text("previous contents", encoding="utf-8")
        with patch("vibebaton.case_export.audit_serialized", return_value=False):
            code, stdout, _ = self._run_cli(
                "--repo", str(self.repo), "--run-id", self.run_id, "--out", str(output),
            )

        self.assertEqual(code, 2)
        self.assertIn("clean: no", stdout.splitlines())
        self.assertEqual(output.read_text(encoding="utf-8"), "previous contents")

    def test_api_returns_404_for_unknown_run(self) -> None:
        status, headers, body = self.get("/api/runs/run-missing/case-export")
        self.assertEqual(status, 404)
        self.assertEqual(headers.get_content_type(), "application/json")
        self.assertEqual(body, {"error": "Run not found"})

    def test_api_respects_title_and_flags(self) -> None:
        status, headers, default_bundle = self.get(self.export_path)
        self.assertEqual(status, 200)
        self.assertEqual(headers.get_content_type(), "application/json")
        self.assertEqual(default_bundle["schema_version"], "baton-case/v1")
        self.assertEqual(default_bundle["meta"]["source_run_id"], self.run_id)
        self.assertIn(
            "Reviewed the sample report with [REDACTED].",
            [event["message"] for event in default_bundle["trace"]],
        )

        query = urlencode({"title": f"回放 + {self.run_id}", "include_reviews": "0", "anonymize": "1"})
        status, _, bundle = self.get(f"{self.export_path}?{query}")
        self.assertEqual(status, 200)
        self.assertEqual(bundle["schema_version"], "baton-case/v1")
        self.assertIs(bundle["redaction_report"]["clean"], True)
        alias = bundle["meta"]["source_run_id"]
        self.assertRegex(alias, r"^case-[0-9a-f]+$")
        self.assertEqual(bundle["title"], f"回放 + {alias}")
        self.assertNotIn(self.run_id, json.dumps(bundle))
        messages = [event["message"] for event in bundle["trace"]]
        self.assertIn("Passed review", messages)
        self.assertFalse(any(message.startswith("Reviewed the sample report") for message in messages))

    def test_api_rejects_invalid_flags(self) -> None:
        for flag in ("include_reviews", "anonymize"):
            with self.subTest(flag=flag):
                status, _, body = self.get(f"{self.export_path}?{flag}=invalid")
                self.assertEqual(status, 400)
                self.assertIn(flag, body["error"])

    def test_api_returns_400_when_exporter_rejects_run(self) -> None:
        with patch("vibebaton.case_export.export_sanitized_case", side_effect=ValueError("Invalid replay graph")):
            status, _, body = self.get(self.export_path)

        self.assertEqual(status, 400)
        self.assertEqual(body, {"error": "Invalid replay graph"})


if __name__ == "__main__":
    unittest.main()
