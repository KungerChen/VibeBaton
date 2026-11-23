"""Golden integration tests for engine attention events and report telemetry."""

from __future__ import annotations

import asyncio
import json
import tempfile
import threading
import unittest
from collections.abc import Awaitable, Callable, Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import Any
from unittest.mock import patch

from tests.test_core import _init_temp_git_repo
from vibebaton.cli_runner import CLIResult
from vibebaton.config import HotReloadConfig, NotificationSettings, ProviderConfig
from vibebaton.db import StateStore
from vibebaton.engine import OrchestrationEngine
from vibebaton.git_ops import MergeConflictError
from vibebaton.notifier import AttentionEvent, AttentionNotifier, NotificationResult
from vibebaton.report import compute_run_telemetry
from vibebaton.schemas import PlanDAG, RunStatus, VerdictKind


class RecordingNotifier(AttentionNotifier):
    def __init__(self, *, raise_on_notify: bool = False) -> None:
        super().__init__()
        self.calls: list[tuple[str, str | None, str | None]] = []
        self.thread_ids: list[int] = []
        self.raise_on_notify = raise_on_notify

    def notify(self, event: AttentionEvent, settings: NotificationSettings) -> NotificationResult:
        self.calls.append((event.category, event.milestone_id, event.task_id))
        self.thread_ids.append(threading.get_ident())
        if self.raise_on_notify:
            raise RuntimeError("Stub notification delivery failed")
        return NotificationResult(True, None, [{"channel": "recording", "ok": True, "detail": "recorded"}])


_Runner = Callable[..., Awaitable[CLIResult]]


@contextmanager
def _make_engine(
    tmp_path: Path,
    runner: _Runner,
    notifier_fakes: AttentionNotifier,
    *,
    notifications: dict[str, Any] | None = None,
    worker_provider: str | None = None,
) -> Iterator[OrchestrationEngine]:
    """Run the real engine and SQLite store with a stub CLI and an injected notifier."""
    repo = tmp_path / "repo"
    repo.mkdir()
    _init_temp_git_repo(repo)
    roles = ("tactical_planner", "bulk_worker", "critical_executor", "micro_orchestrator", "milestone_reviewer")
    notification_settings: dict[str, Any] = {"desktop_toast": False, "terminal_bell": False}
    notification_settings.update(notifications or {})
    providers: dict[str, Any] = {"stub": {"command": ["stub-agent"]}}
    role_providers = {role: "stub" for role in roles}
    if worker_provider is not None:
        providers[worker_provider] = {"command": ["stub-agent"]}
        role_providers["bulk_worker"] = worker_provider
        role_providers["critical_executor"] = worker_provider
    config_path = tmp_path / "baton.json"
    config_path.write_text(json.dumps({
        "daemon": {"prevent_sleep_windows": False},
        "notifications": notification_settings,
        "providers": providers,
        "roles": {role: {"provider": role_providers[role], "model": "stub-model"} for role in roles},
    }), encoding="utf-8")
    store = StateStore(tmp_path / "state.sqlite")
    with patch("vibebaton.engine.run_provider_cli", side_effect=runner):
        yield OrchestrationEngine(repo, HotReloadConfig(config_path), store, notifier=notifier_fakes)


def _pipeline_runner(task_verdict: VerdictKind = VerdictKind.PASS) -> _Runner:
    async def run(
        provider: ProviderConfig, *, workdir: Path, extra_env: dict[str, str], **kwargs: Any,
    ) -> CLIResult:
        role = extra_env["VIBEBATON_ROLE"]
        if role == "tactical_planner":
            stdout = json.dumps({"milestones": [{
                "id": "M1",
                "title": "Implement feature",
                "tasks": [{"id": "T1", "title": "Add feature", "allowed_paths": ["src/feature.py"]}],
            }]})
        elif role == "bulk_worker":
            (workdir / "src" / "feature.py").write_text("FEATURE_ENABLED = True\n", encoding="utf-8")
            stdout = "Feature implemented."
        elif role == "micro_orchestrator":
            summary = "Approve the revised feature scope." if task_verdict == VerdictKind.PLAN_AMENDMENT else "Pass."
            stdout = json.dumps({"verdict": task_verdict.value, "summary": summary})
        elif role == "milestone_reviewer":
            stdout = json.dumps({"verdict": "PASS", "summary": "Milestone passed."})
        else:
            raise AssertionError(f"Unexpected role {role}")
        return CLIResult(status="ok", exit_code=0, stdout=stdout, stderr="", duration_sec=0, command=[])

    return run


def _cli_result(stdout: str = "", *, status: str = "ok", exit_code: int = 0, stderr: str = "") -> CLIResult:
    return CLIResult(status=status, exit_code=exit_code, stdout=stdout, stderr=stderr, duration_sec=0, command=[])


def _with_role_result(base: _Runner, role_name: str, make_result: Callable[[], CLIResult]) -> _Runner:
    async def run(
        provider: ProviderConfig, *, workdir: Path, extra_env: dict[str, str], **kwargs: Any,
    ) -> CLIResult:
        if extra_env["VIBEBATON_ROLE"] == role_name:
            return make_result()
        return await base(provider, workdir=workdir, extra_env=extra_env, **kwargs)

    return run


def _with_role_hook(base: _Runner, role_name: str, callback: Callable[[], None]) -> _Runner:
    async def run(
        provider: ProviderConfig, *, workdir: Path, extra_env: dict[str, str], **kwargs: Any,
    ) -> CLIResult:
        result = await base(provider, workdir=workdir, extra_env=extra_env, **kwargs)
        if extra_env["VIBEBATON_ROLE"] == role_name:
            callback()
        return result

    return run


def _fixed_provider_cooldown(remaining_sec: float) -> Callable[[str], float]:
    """Report a fixed cooldown on the first stub-worker query, then zero."""
    pending = {"stub-worker": remaining_sec}

    def get_cooldown(provider: str) -> float:
        return pending.pop(provider, 0.0)

    return get_cooldown


def _plan_runner(plan: dict[str, Any]) -> _Runner:
    return _with_role_result(
        _pipeline_runner(), "tactical_planner", lambda: _cli_result(json.dumps(plan)),
    )


def _milestone_verdict_runner(verdict: str, summary: str) -> _Runner:
    return _with_role_result(
        _pipeline_runner(),
        "milestone_reviewer",
        lambda: _cli_result(json.dumps({"verdict": verdict, "summary": summary})),
    )


def _attention_events(store: StateStore, run_id: str) -> list[dict[str, Any]]:
    return [event for event in store.get_events(run_id, limit=-1) if event["kind"] == "human_attention_required"]


def _events_with_category(store: StateStore, run_id: str, category: str) -> list[dict[str, Any]]:
    return [
        event for event in _attention_events(store, run_id)
        if json.loads(event["payload_json"])["category"] == category
    ]


class TestEngineNotifications(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        self.tmp_path = Path(self.enterContext(tempfile.TemporaryDirectory())).resolve()
        self.rfc_path = self.tmp_path / "rfc.md"

    async def test_missing_rfc_logs_one_failed_attention_when_notifier_raises(self) -> None:
        notifier = RecordingNotifier(raise_on_notify=True)
        engine = self.enterContext(_make_engine(self.tmp_path, _pipeline_runner(), notifier))
        run_id = engine.store.create_run(engine.repo_path, self.rfc_path)

        with self.assertLogs("vibebaton.engine", level="WARNING"):
            self.assertEqual(await engine.execute_run(run_id), RunStatus.FAILED)
        self.assertEqual(await engine.execute_run(run_id), RunStatus.FAILED)

        [event] = _attention_events(engine.store, run_id)
        payload = json.loads(event["payload_json"])
        self.assertEqual(
            (payload["category"], payload["severity"], payload["title"]), ("failed", "error", "RFC file missing"),
        )
        self.assertEqual(payload["channels"], [])
        self.assertEqual(notifier.calls, [("failed", None, None)])
        [dispatch_thread] = notifier.thread_ids
        self.assertNotEqual(dispatch_thread, threading.get_ident())

    async def test_task_plan_amendment_persists_scoped_waiting_human_attention(self) -> None:
        notifier = RecordingNotifier()
        runner = _pipeline_runner(VerdictKind.PLAN_AMENDMENT)
        engine = self.enterContext(_make_engine(self.tmp_path, runner, notifier))
        self.rfc_path.write_text("# RFC\nAdd the feature.\n", encoding="utf-8")
        run_id = engine.store.create_run(engine.repo_path, self.rfc_path)

        self.assertEqual(await engine.execute_run(run_id), RunStatus.WAITING_HUMAN)

        [event] = _attention_events(engine.store, run_id)
        self.assertEqual((event["milestone_id"], event["task_id"]), ("M1", "T1"))
        self.assertEqual(notifier.calls, [("waiting_human", "M1", "T1")])
        payload = json.loads(event["payload_json"])
        self.assertEqual(payload["channels"], [{"channel": "recording", "ok": True, "detail": "recorded"}])
        run = engine.store.get_run(run_id)
        self.assertEqual(payload["message"], run["human_prompt"])
        self.assertEqual(compute_run_telemetry(engine.store, run_id)["attention"], {
            "category": "waiting_human",
            "severity": "warning",
            "title": payload["title"],
            "message": run["human_prompt"],
            "action_hint": payload["action_hint"],
            "milestone_id": "M1",
            "task_id": "T1",
            "created_at": event["created_at"],
        })

    async def test_completed_run_clears_final_gate_attention(self) -> None:
        notifier = RecordingNotifier()
        engine = self.enterContext(_make_engine(self.tmp_path, _pipeline_runner(), notifier))
        self.rfc_path.write_text("# RFC\nAdd the feature.\n", encoding="utf-8")
        run_id = engine.store.create_run(engine.repo_path, self.rfc_path)

        self.assertEqual(await engine.execute_run(run_id), RunStatus.READY_FOR_FINAL_GATE)
        self.assertEqual(await engine.execute_run(run_id), RunStatus.READY_FOR_FINAL_GATE)

        [event] = _attention_events(engine.store, run_id)
        self.assertEqual((event["milestone_id"], event["task_id"]), (None, None))
        payload = json.loads(event["payload_json"])
        self.assertEqual((payload["category"], payload["severity"]), ("ready_for_final_gate", "info"))
        self.assertEqual(payload["channels"], [{"channel": "recording", "ok": True, "detail": "recorded"}])
        self.assertEqual(compute_run_telemetry(engine.store, run_id)["attention"]["category"], "ready_for_final_gate")
        self.assertEqual(notifier.calls, [("ready_for_final_gate", None, None)])

        engine.store.update_run_status(run_id, RunStatus.COMPLETED)
        self.assertIsNone(compute_run_telemetry(engine.store, run_id)["attention"])

    async def test_milestone_plan_amendment_emits_milestone_scoped_waiting_human(self) -> None:
        notifier = RecordingNotifier()
        runner = _milestone_verdict_runner("PLAN_AMENDMENT", "Revise the milestone scope.")
        engine = self.enterContext(_make_engine(self.tmp_path, runner, notifier))
        self.rfc_path.write_text("# RFC\nAdd the feature.\n", encoding="utf-8")
        run_id = engine.store.create_run(engine.repo_path, self.rfc_path)

        self.assertEqual(await engine.execute_run(run_id), RunStatus.WAITING_HUMAN)

        [event] = _attention_events(engine.store, run_id)
        self.assertEqual((event["milestone_id"], event["task_id"]), ("M1", None))
        payload = json.loads(event["payload_json"])
        self.assertEqual((payload["category"], payload["severity"]), ("waiting_human", "warning"))
        run = engine.store.get_run(run_id)
        self.assertEqual(payload["message"], run["human_prompt"])
        self.assertIn("Milestone M1 reviewer requested PLAN_AMENDMENT", payload["message"])
        self.assertEqual(notifier.calls, [("waiting_human", "M1", None)])
        attention = compute_run_telemetry(engine.store, run_id)["attention"]
        self.assertEqual(
            (attention["category"], attention["milestone_id"], attention["task_id"]),
            ("waiting_human", "M1", None),
        )

    async def test_task_merge_conflict_exhaustion_emits_one_waiting_human(self) -> None:
        notifier = RecordingNotifier()
        engine = self.enterContext(_make_engine(self.tmp_path, _pipeline_runner(), notifier))
        self.rfc_path.write_text("# RFC\nAdd the feature.\n", encoding="utf-8")
        run_id = engine.store.create_run(engine.repo_path, self.rfc_path)
        conflict = MergeConflictError(
            "baton/branch", "milestone/branch", ["src/feature.py"], reason="resolution attempts exhausted",
        )

        with patch("vibebaton.engine.merge_branch_with_resolver", side_effect=conflict):
            self.assertEqual(await engine.execute_run(run_id), RunStatus.WAITING_HUMAN)

        [event] = _attention_events(engine.store, run_id)
        self.assertEqual((event["milestone_id"], event["task_id"]), ("M1", "T1"))
        payload = json.loads(event["payload_json"])
        self.assertEqual(payload["category"], "waiting_human")
        self.assertIn("Merge conflict", payload["message"])
        self.assertEqual(notifier.calls, [("waiting_human", "M1", "T1")])
        conflict_events = [
            record for record in engine.store.get_events(run_id, limit=-1)
            if record["kind"] == "merge_conflict_failed"
        ]
        [conflict_event] = conflict_events
        self.assertEqual(
            json.loads(conflict_event["payload_json"])["reason"], "resolution attempts exhausted",
        )

    async def test_external_pause_mid_run_emits_one_paused_attention(self) -> None:
        notifier = RecordingNotifier()
        engine_ref: dict[str, Any] = {}

        def pause_run() -> None:
            engine_ref["engine"].store.update_run_status(engine_ref["run_id"], RunStatus.PAUSED)

        runner = _with_role_hook(_pipeline_runner(), "tactical_planner", pause_run)
        engine = self.enterContext(_make_engine(self.tmp_path, runner, notifier))
        self.rfc_path.write_text("# RFC\nAdd the feature.\n", encoding="utf-8")
        run_id = engine.store.create_run(engine.repo_path, self.rfc_path)
        engine_ref["engine"] = engine
        engine_ref["run_id"] = run_id

        self.assertEqual(await engine.execute_run(run_id), RunStatus.PAUSED)
        self.assertEqual(await engine.execute_run(run_id), RunStatus.PAUSED)

        [event] = _attention_events(engine.store, run_id)
        self.assertEqual((event["milestone_id"], event["task_id"]), (None, None))
        payload = json.loads(event["payload_json"])
        self.assertEqual(
            (payload["category"], payload["severity"], payload["title"]), ("paused", "warning", "Run paused"),
        )
        self.assertEqual(notifier.calls, [("paused", None, None)])
        self.assertEqual(compute_run_telemetry(engine.store, run_id)["attention"]["category"], "paused")

    async def test_milestone_failure_emits_one_failed_attention(self) -> None:
        notifier = RecordingNotifier()
        base = _pipeline_runner()

        async def run(
            provider: ProviderConfig, *, workdir: Path, extra_env: dict[str, str], **kwargs: Any,
        ) -> CLIResult:
            if extra_env["VIBEBATON_ROLE"] in ("bulk_worker", "critical_executor"):
                return _cli_result(status="error", exit_code=1, stderr="simulated worker failure")
            return await base(provider, workdir=workdir, extra_env=extra_env, **kwargs)

        engine = self.enterContext(_make_engine(self.tmp_path, run, notifier))
        self.rfc_path.write_text("# RFC\nAdd the feature.\n", encoding="utf-8")
        run_id = engine.store.create_run(engine.repo_path, self.rfc_path)

        self.assertEqual(await engine.execute_run(run_id), RunStatus.FAILED)

        [event] = _attention_events(engine.store, run_id)
        self.assertEqual((event["milestone_id"], event["task_id"]), ("M1", None))
        payload = json.loads(event["payload_json"])
        self.assertEqual(
            (payload["category"], payload["severity"], payload["title"]), ("failed", "error", "Milestone failed"),
        )
        self.assertEqual(notifier.calls, [("failed", "M1", None)])
        self.assertEqual(compute_run_telemetry(engine.store, run_id)["attention"]["category"], "failed")

    async def test_dag_deadlock_emits_one_failed_attention(self) -> None:
        notifier = RecordingNotifier()
        plan = {
            "milestones": [{
                "id": "M1",
                "title": "Deadlocked milestone",
                "tasks": [
                    {"id": "T1", "title": "First", "allowed_paths": ["src/a.py"], "depends_on": ["T2"]},
                    {"id": "T2", "title": "Second", "allowed_paths": ["src/b.py"], "depends_on": ["T1"]},
                ],
            }],
        }
        engine = self.enterContext(_make_engine(self.tmp_path, _plan_runner(plan), notifier))
        self.rfc_path.write_text("# RFC\nAdd the feature.\n", encoding="utf-8")
        run_id = engine.store.create_run(engine.repo_path, self.rfc_path)

        with patch.object(PlanDAG, "validate_graph", return_value=None):
            self.assertEqual(await engine.execute_run(run_id), RunStatus.FAILED)

        [event] = _attention_events(engine.store, run_id)
        self.assertEqual((event["milestone_id"], event["task_id"]), ("M1", None))
        payload = json.loads(event["payload_json"])
        self.assertEqual(
            (payload["category"], payload["severity"], payload["title"]),
            ("failed", "error", "Milestone DAG deadlock"),
        )
        self.assertEqual(notifier.calls, [("failed", "M1", None)])
        event_kinds = [record["kind"] for record in engine.store.get_events(run_id, limit=-1)]
        self.assertIn("dag_deadlock", event_kinds)
        self.assertEqual(compute_run_telemetry(engine.store, run_id)["attention"]["category"], "failed")

    async def test_short_cooldown_below_threshold_emits_no_long_cooldown_attention(self) -> None:
        notifier = RecordingNotifier()
        engine = self.enterContext(_make_engine(
            self.tmp_path,
            _pipeline_runner(),
            notifier,
            notifications={"on_long_cooldown_sec": 1},
            worker_provider="stub-worker",
        ))
        self.rfc_path.write_text("# RFC\nAdd the feature.\n", encoding="utf-8")
        run_id = engine.store.create_run(engine.repo_path, self.rfc_path)

        with patch.object(
            engine.store, "get_provider_cooldown", side_effect=_fixed_provider_cooldown(0.5),
        ):
            self.assertEqual(await engine.execute_run(run_id), RunStatus.READY_FOR_FINAL_GATE)

        self.assertEqual(_events_with_category(engine.store, run_id, "long_cooldown"), [])
        self.assertEqual([call for call in notifier.calls if call[0] == "long_cooldown"], [])
        event_kinds = [record["kind"] for record in engine.store.get_events(run_id, limit=-1)]
        self.assertIn("quota_cooldown_wait", event_kinds)

    async def test_cooldown_at_threshold_emits_one_long_cooldown_attention_with_task_id(self) -> None:
        notifier = RecordingNotifier()
        engine = self.enterContext(_make_engine(
            self.tmp_path,
            _pipeline_runner(),
            notifier,
            notifications={"on_long_cooldown_sec": 1},
            worker_provider="stub-worker",
        ))
        self.rfc_path.write_text("# RFC\nAdd the feature.\n", encoding="utf-8")
        run_id = engine.store.create_run(engine.repo_path, self.rfc_path)

        with patch.object(
            engine.store, "get_provider_cooldown", side_effect=_fixed_provider_cooldown(1.0),
        ):
            self.assertEqual(await engine.execute_run(run_id), RunStatus.READY_FOR_FINAL_GATE)

        [event] = _events_with_category(engine.store, run_id, "long_cooldown")
        self.assertEqual((event["milestone_id"], event["task_id"]), ("M1", "T1"))
        payload = json.loads(event["payload_json"])
        self.assertEqual((payload["category"], payload["severity"]), ("long_cooldown", "warning"))
        self.assertEqual(
            [call for call in notifier.calls if call[0] == "long_cooldown"],
            [("long_cooldown", "M1", "T1")],
        )

    async def test_zero_cooldown_threshold_never_emits_long_cooldown_attention(self) -> None:
        notifier = RecordingNotifier()
        engine = self.enterContext(_make_engine(
            self.tmp_path,
            _pipeline_runner(),
            notifier,
            notifications={"on_long_cooldown_sec": 0},
            worker_provider="stub-worker",
        ))
        self.rfc_path.write_text("# RFC\nAdd the feature.\n", encoding="utf-8")
        run_id = engine.store.create_run(engine.repo_path, self.rfc_path)

        with patch.object(
            engine.store, "get_provider_cooldown", side_effect=_fixed_provider_cooldown(0.5),
        ):
            self.assertEqual(await engine.execute_run(run_id), RunStatus.READY_FOR_FINAL_GATE)

        self.assertEqual(_events_with_category(engine.store, run_id, "long_cooldown"), [])
        self.assertEqual([call for call in notifier.calls if call[0] == "long_cooldown"], [])
        event_kinds = [record["kind"] for record in engine.store.get_events(run_id, limit=-1)]
        self.assertIn("quota_cooldown_wait", event_kinds)

    async def test_notifier_failure_does_not_change_status_or_hang(self) -> None:
        notifier = RecordingNotifier(raise_on_notify=True)
        engine = self.enterContext(_make_engine(self.tmp_path, _pipeline_runner(), notifier))
        self.rfc_path.write_text("# RFC\nAdd the feature.\n", encoding="utf-8")
        run_id = engine.store.create_run(engine.repo_path, self.rfc_path)

        with self.assertLogs("vibebaton.engine", level="WARNING"):
            status = await asyncio.wait_for(engine.execute_run(run_id), timeout=30)

        self.assertEqual(status, RunStatus.READY_FOR_FINAL_GATE)
        run = engine.store.get_run(run_id)
        self.assertEqual(run["status"], RunStatus.READY_FOR_FINAL_GATE.value)
        [event] = _attention_events(engine.store, run_id)
        payload = json.loads(event["payload_json"])
        self.assertEqual(payload["category"], "ready_for_final_gate")
        self.assertEqual(payload["channels"], [])
        self.assertEqual(notifier.calls, [("ready_for_final_gate", None, None)])

    async def test_disabled_notifications_still_log_attention_without_notifier(self) -> None:
        notifier = RecordingNotifier()
        engine = self.enterContext(_make_engine(
            self.tmp_path, _pipeline_runner(), notifier, notifications={"enabled": False},
        ))
        run_id = engine.store.create_run(engine.repo_path, self.rfc_path)

        self.assertEqual(await engine.execute_run(run_id), RunStatus.FAILED)

        [event] = _attention_events(engine.store, run_id)
        payload = json.loads(event["payload_json"])
        self.assertEqual(
            (payload["category"], payload["title"]), ("failed", "RFC file missing"),
        )
        self.assertEqual(payload["channels"], [])
        self.assertEqual(notifier.calls, [])

    async def test_legacy_waiting_human_run_synthesizes_attention_from_human_prompt(self) -> None:
        notifier = RecordingNotifier()
        engine = self.enterContext(_make_engine(self.tmp_path, _pipeline_runner(), notifier))
        run_id = engine.store.create_run(engine.repo_path, self.rfc_path)
        engine.store.update_run_status(
            run_id, RunStatus.WAITING_HUMAN, human_prompt="Approve the revised plan scope.",
        )
        self.assertEqual(_attention_events(engine.store, run_id), [])

        attention = compute_run_telemetry(engine.store, run_id)["attention"]
        self.assertEqual(attention["category"], "waiting_human")
        self.assertEqual(attention["message"], "Approve the revised plan scope.")
        self.assertEqual((attention["milestone_id"], attention["task_id"]), (None, None))

        engine.store.update_run_status(run_id, RunStatus.COMPLETED)
        self.assertIsNone(compute_run_telemetry(engine.store, run_id)["attention"])

    async def test_resumed_and_reblocked_run_emits_second_waiting_human(self) -> None:
        notifier = RecordingNotifier()
        runner = _pipeline_runner(VerdictKind.PLAN_AMENDMENT)
        engine = self.enterContext(_make_engine(self.tmp_path, runner, notifier))
        self.rfc_path.write_text("# RFC\nAdd the feature.\n", encoding="utf-8")
        run_id = engine.store.create_run(engine.repo_path, self.rfc_path)

        self.assertEqual(await engine.execute_run(run_id), RunStatus.WAITING_HUMAN)
        self.assertEqual(len(_attention_events(engine.store, run_id)), 1)

        engine.store.record_human_decision(run_id, "approve", "Approved the revised scope.")
        self.assertEqual(await engine.execute_run(run_id), RunStatus.WAITING_HUMAN)

        events = _attention_events(engine.store, run_id)
        self.assertEqual(len(events), 2)
        self.assertEqual(
            [(event["milestone_id"], event["task_id"]) for event in events],
            [("M1", "T1"), ("M1", "T1")],
        )
        self.assertEqual(
            notifier.calls,
            [("waiting_human", "M1", "T1"), ("waiting_human", "M1", "T1")],
        )
