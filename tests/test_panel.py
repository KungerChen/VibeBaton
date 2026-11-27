"""00_PANEL contract tests: [panel] parsing, cost tiers, panel.py surface, shared fakes.

Later M1 tasks reuse ``make_fake_invoke_provider`` and ``make_panel_store``.
"""

from __future__ import annotations

import ast
import asyncio
import contextlib
import io
import json
import os
import subprocess
import sys
import tempfile
import threading
import time
import tomllib
import unittest
from collections.abc import Mapping
from pathlib import Path
from typing import Any
from unittest.mock import AsyncMock, Mock, patch
from urllib.request import Request, urlopen

from tests.http_mock_server import MockChatCompletionsServer, MockResponse
from vibebaton import cli, panel
from vibebaton.allocation import compute_step_up_target, resolve_task_allocation
from vibebaton.cli_runner import CLIResult
from vibebaton.config import (
    BatonConfig,
    FallbackTarget,
    PanelMemberConfig,
    PanelSettings,
    build_model_catalog,
    parse_config_dict,
)
from vibebaton.case_export import export_sanitized_case
from vibebaton.db import StateStore
from vibebaton.engine import OrchestrationEngine
from vibebaton.report import compute_run_telemetry, generate_battle_report
from vibebaton.schemas import TaskSpec
from vibebaton.web_server import create_server


# ----------------------------------------------------------------------
# Shared helpers
# ----------------------------------------------------------------------

def make_fake_invoke_provider(results_by_member: Mapping[str, Any]):
    """Build an async ``invoke_provider`` stub keyed by member id.

    ``artifact_key`` "panel_<id>" maps to ``results_by_member[<id>]``; the
    synthesizer uses the key "synthesizer". A value may be a str (ok result
    with that text), a CLIResult (returned as-is) or an Exception (raised).
    Missing keys return an ok result with placeholder text. Every call's
    keyword arguments are appended to ``stub.calls``.
    """
    calls: list[dict[str, Any]] = []

    async def invoke_provider(**kwargs: Any) -> CLIResult:
        calls.append(kwargs)
        key = str(kwargs.get("artifact_key", "")).removeprefix("panel_")
        value = results_by_member.get(key, f"# {key} report")
        if isinstance(value, BaseException):
            raise value
        if isinstance(value, CLIResult):
            return value
        return CLIResult(
            status="ok", exit_code=0, stdout=str(value), stderr="", duration_sec=0.01,
            command=[str(kwargs.get("provider", ""))], prompt_tokens=100, completion_tokens=50,
            cost_usd=0.001,
        )

    invoke_provider.calls = calls  # type: ignore[attr-defined]
    return invoke_provider


def make_panel_store(tmp: str | Path) -> tuple[StateStore, str, Path]:
    """Create a StateStore with one panel-mode run. Returns (store, run_id, run_dir)."""
    root = Path(tmp)
    rfc = root / "RFC.md"
    rfc.write_text("# RFC\n\nPanel test.\n", encoding="utf-8")
    store = StateStore(root / ".baton" / "state.sqlite")
    run_id = store.create_run(root, rfc, mode="panel")
    run_dir = root / ".baton" / "runs" / run_id
    run_dir.mkdir(parents=True, exist_ok=True)
    return store, run_id, run_dir


def _panel_raw(**panel_overrides: Any) -> dict[str, Any]:
    panel_raw: dict[str, Any] = {
        "enabled": True,
        "max_concurrency": 2,
        "synthesizer_provider": "claude_sub",
        "synthesizer_model": "sonnet@high",
        "arbitration_rules": ["code truth", "simplicity"],
        "members": [
            {
                "id": "safety",
                "perspective": "Source & Safety",
                "provider": "codex_sub",
                "model": "gpt-6.2-sol@max",
                "fallback": [
                    {"provider": "claude_sub", "model": "opus@high"},
                    {"provider": "claude_sub"},
                    "bogus",
                ],
            },
            {
                "id": "ux",
                "perspective": "UX & Copy",
                "provider": "claude_sub",
                "model": "opus@high",
                "prompt_file": "prompts/custom.md",
            },
        ],
    }
    panel_raw.update(panel_overrides)
    return {
        "providers": {"claude_sub": {}, "codex_sub": {}},
        "roles": {"bulk_worker": {"provider": "codex_sub", "model": "worker"}},
        "panel": panel_raw,
    }


# ----------------------------------------------------------------------
# [panel] parsing
# ----------------------------------------------------------------------

class TestPanelConfig(unittest.TestCase):
    def test_omitted_panel_is_disabled_and_empty(self) -> None:
        cfg = parse_config_dict({"providers": {}, "roles": {}})

        self.assertEqual(cfg.panel, PanelSettings())
        self.assertFalse(cfg.panel.enabled)
        self.assertEqual(cfg.panel.members, [])

    def test_parses_typed_members_with_normalized_fallbacks(self) -> None:
        cfg = parse_config_dict(_panel_raw())

        self.assertEqual(cfg.panel, PanelSettings(
            enabled=True,
            max_concurrency=2,
            synthesizer_provider="claude_sub",
            synthesizer_model="sonnet@high",
            synthesizer_prompt_file="prompts/panel_synthesizer.md",
            arbitration_rules=["code truth", "simplicity"],
            members=[
                PanelMemberConfig(
                    id="safety",
                    perspective="Source & Safety",
                    provider="codex_sub",
                    model="gpt-6.2-sol@max",
                    fallback=[FallbackTarget("claude_sub", "opus@high")],
                ),
                PanelMemberConfig(
                    id="ux",
                    perspective="UX & Copy",
                    provider="claude_sub",
                    model="opus@high",
                    prompt_file="prompts/custom.md",
                ),
            ],
        ))

    def test_invalid_members_raise_value_error(self) -> None:
        base = _panel_raw()["panel"]["members"]
        cases = {
            "duplicate id": [base[0], {**base[1], "id": "safety"}],
            "empty id": [{**base[0], "id": "  "}],
            "empty perspective": [{**base[0], "perspective": ""}],
            "unknown provider": [{**base[0], "provider": "missing"}],
            "not a table": ["safety"],
        }
        for label, members in cases.items():
            with self.subTest(label), self.assertRaises(ValueError):
                parse_config_dict(_panel_raw(members=members))

    def test_panel_must_be_a_table(self) -> None:
        with self.assertRaises(ValueError):
            parse_config_dict({"providers": {}, "roles": {}, "panel": "on"})


# ----------------------------------------------------------------------
# Cost tiers and allocation compatibility
# ----------------------------------------------------------------------

def _tier_config(models: list[str]) -> BatonConfig:
    return parse_config_dict({
        "providers": {"p": {"type": "fixed"}},
        "roles": {f"r{i}": {"provider": "p", "model": model} for i, model in enumerate(models)},
    })


class TestPanelCostTiers(unittest.TestCase):
    def test_classifies_new_and_existing_markers(self) -> None:
        expected = {
            "gemini-4-hydrogen-high": "eco",
            "sonnet@high": "standard",
            "gemini-4-neon-high": "standard",
            "gpt-6.2-sol@max": "standard",
            "opus@high": "flagship",
            "gemini-4-astra": "flagship",
            "fable": "flagship",
            "gemini-3-pro": "flagship",
        }
        catalog = build_model_catalog(_tier_config(list(expected)))

        self.assertEqual({cap.model: cap.cost_tier for cap in catalog}, expected)

    def test_budget_routing_and_step_up_accept_hydrogen_as_eco(self) -> None:
        cfg = parse_config_dict({
            "providers": {"gem": {"type": "fixed"}, "claude": {"type": "fixed"}, "codex": {"type": "fixed"}},
            "roles": {
                "bulk_worker": {"provider": "gem", "model": "gemini-4-hydrogen-high"},
                "micro_orchestrator": {"provider": "claude", "model": "sonnet@high"},
                "reviewer": {"provider": "claude", "model": "opus@high"},
                "critical_executor": {"provider": "codex", "model": "gpt-6.2-sol@max"},
            },
        })
        catalog = build_model_catalog(cfg)
        task = TaskSpec("T1", "Routine", assignee_role="micro_orchestrator")

        self.assertEqual(
            resolve_task_allocation(task, cfg, catalog, "eco")[:2], ("gem", "gemini-4-hydrogen-high")
        )
        self.assertEqual(resolve_task_allocation(task, cfg, catalog, "balanced")[:2], ("claude", "sonnet@high"))
        self.assertEqual(resolve_task_allocation(task, cfg, catalog, "max_quality")[:2], ("claude", "opus@high"))
        self.assertEqual(
            [compute_step_up_target("gem", "gemini-4-hydrogen-high", cfg, catalog, n) for n in (1, 2, 3)],
            [("claude", "opus@high"), ("codex", "gpt-6.2-sol@max"), None],
        )


# ----------------------------------------------------------------------
# panel.py surface and helpers
# ----------------------------------------------------------------------

class TestPanelModuleContract(unittest.TestCase):
    def test_event_and_stage_constants(self) -> None:
        self.assertEqual(
            (panel.PANEL_STARTED, panel.PANEL_MEMBER_COMPLETED, panel.PANEL_SYNTHESIZED, panel.STAGE_PANEL),
            ("panel_started", "panel_member_completed", "panel_synthesized", "00_PANEL"),
        )
        self.assertTrue(issubclass(panel.PanelPhaseError, RuntimeError))
        self.assertTrue(asyncio.iscoroutinefunction(panel.run_panel_phase))

    def test_docstring_documents_every_payload_key(self) -> None:
        for key in (
            "member_id", "perspective", "provider", "model", "ok", "tokens_in", "tokens_out",
            "cost_usd", "elapsed_sec", "preview", "output_path", "error", "master_spec_path",
            "member_count", "succeeded_count",
        ):
            self.assertIn(key, panel.__doc__ or "")

    def test_result_dataclasses(self) -> None:
        member = panel.PanelMemberResult("ux", "UX", "claude_sub", "opus@high", ok=True)
        result = panel.PanelPhaseResult(1, 1, 0.5, "m.md", "# spec", [member])

        self.assertEqual((member.error, member.tokens_in, member.cost_usd), ("", 0, None))
        self.assertEqual(result.members, [member])

    def test_fake_invoke_provider_and_store_helpers(self) -> None:
        stub = make_fake_invoke_provider({"ux": "UX report", "bad": RuntimeError("boom")})

        ok = asyncio.run(stub(provider="claude_sub", model="opus", prompt="p", artifact_key="panel_ux"))
        default = asyncio.run(stub(provider="claude_sub", model="opus", prompt="p", artifact_key="panel_synthesizer"))
        with self.assertRaisesRegex(RuntimeError, "boom"):
            asyncio.run(stub(provider="codex_sub", model="sol", prompt="p", artifact_key="panel_bad"))

        self.assertEqual((ok.status, ok.text), ("ok", "UX report"))
        self.assertEqual(default.text, "# synthesizer report")
        self.assertEqual([call["artifact_key"] for call in stub.calls], ["panel_ux", "panel_synthesizer", "panel_bad"])

        with tempfile.TemporaryDirectory() as tmp:
            store, run_id, run_dir = make_panel_store(tmp)
            self.assertEqual(store.get_run(run_id)["mode"], "panel")
            self.assertTrue(run_dir.is_dir())


def _panel_settings(member_ids: tuple[str, ...] = ("ux", "visual", "safety"), **overrides: Any) -> PanelSettings:
    values: dict[str, Any] = {
        "enabled": True,
        "max_concurrency": 2,
        "synthesizer_provider": "claude_sub",
        "synthesizer_model": "sonnet@high",
        "arbitration_rules": ["prefer stdlib"],
        "members": [
            PanelMemberConfig(member_id, f"{member_id} perspective", "claude_sub", "sonnet@high")
            for member_id in member_ids
        ],
    }
    values.update(overrides)
    return PanelSettings(**values)


def _snapshot(root: Path) -> dict[str, tuple[int, int]]:
    return {
        str(path.relative_to(root)): (path.stat().st_mtime_ns, path.stat().st_size)
        for path in sorted(root.rglob("*"))
    }


def _payloads(store: StateStore, run_id: str, kind: str) -> list[dict[str, Any]]:
    return [json.loads(e["payload_json"]) for e in store.get_events(run_id, limit=1000) if e["kind"] == kind]


class TestRunPanelPhase(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.store, self.run_id, self.run_dir = make_panel_store(self._tmp.name)
        self.repo = Path(self._tmp.name) / "repo"
        (self.repo / "src").mkdir(parents=True)
        (self.repo / "README.md").write_text("# demo\n", encoding="utf-8")
        (self.repo / "src" / "app.py").write_text("print('hi')\n", encoding="utf-8")
        self.cfg = parse_config_dict(_panel_raw())

    def _run(self, invoke: Any, settings: PanelSettings | None = None) -> panel.PanelPhaseResult:
        return asyncio.run(panel.run_panel_phase(
            cfg=self.cfg, settings=settings or _panel_settings(), store=self.store, run_id=self.run_id,
            repo_path=self.repo, rfc_text="# RFC\nBuild the thing.", invoke_provider=invoke, run_dir=self.run_dir,
        ))

    def test_concurrency_is_bounded_and_reports_written(self) -> None:
        state = {"in_flight": 0, "peak": 0}
        inner = make_fake_invoke_provider({"synthesizer": "# Master Spec\n\nDone."})

        async def counting(**kwargs: Any) -> CLIResult:
            state["in_flight"] += 1
            state["peak"] = max(state["peak"], state["in_flight"])
            try:
                await asyncio.sleep(0.02)
                return await inner(**kwargs)
            finally:
                state["in_flight"] -= 1

        result = self._run(counting)

        self.assertEqual(state["peak"], 2)
        self.assertEqual((result.member_count, result.succeeded_count), (3, 3))
        for member_id in ("ux", "visual", "safety"):
            report = self.run_dir / "panel" / f"{member_id}.md"
            self.assertEqual(report.read_text(encoding="utf-8"), f"# {member_id} report")
        member_calls = [c for c in inner.calls if c["artifact_key"] != "panel_synthesizer"]
        self.assertEqual(len(member_calls), 3)
        for call in member_calls:
            self.assertEqual(call["cwd"], self.repo)
            self.assertIn(str(self.repo), call["prompt"])
            self.assertIn("Build the thing.", call["prompt"])
            self.assertNotIn("{{", call["prompt"])

    def test_single_member_failure_is_recorded_without_raising(self) -> None:
        bad = CLIResult(status="error", exit_code=1, stdout="", stderr="boom", duration_sec=0.1, command=["x"])
        invoke = make_fake_invoke_provider({"visual": RuntimeError("down")})
        result = self._run(invoke)

        self.assertEqual((result.member_count, result.succeeded_count), (3, 2))
        completed = {p["member_id"]: p for p in _payloads(self.store, self.run_id, panel.PANEL_MEMBER_COMPLETED)}
        self.assertEqual(len(completed), 3)
        self.assertFalse(completed["visual"]["ok"])
        self.assertIn("down", completed["visual"]["error"])
        self.assertEqual(completed["visual"]["output_path"], "")
        self.assertTrue(completed["ux"]["ok"])
        self.assertFalse((self.run_dir / "panel" / "visual.md").exists())
        synth_prompt = invoke.calls[-1]["prompt"]
        self.assertIn("# ux report", synth_prompt)
        self.assertNotIn("# visual report", synth_prompt)

        # A non-ok CLIResult counts as a failure too.
        result = self._run(make_fake_invoke_provider({"safety": bad}))
        self.assertEqual(result.succeeded_count, 2)
        safety = [m for m in result.members if m.member_id == "safety"][0]
        self.assertFalse(safety.ok)
        self.assertIn("boom", safety.error)

    def test_all_members_failing_raises_without_master_spec(self) -> None:
        invoke = make_fake_invoke_provider({m: RuntimeError("no") for m in ("ux", "visual", "safety")})
        with self.assertRaises(panel.PanelPhaseError):
            self._run(invoke)

        self.assertFalse((self.run_dir / "panel" / "master_spec.md").exists())
        self.assertEqual(len(_payloads(self.store, self.run_id, panel.PANEL_MEMBER_COMPLETED)), 3)
        self.assertEqual(_payloads(self.store, self.run_id, panel.PANEL_SYNTHESIZED), [])
        self.assertNotIn("panel_synthesizer", [c["artifact_key"] for c in invoke.calls])

    def test_synthesizer_failure_raises(self) -> None:
        bad = CLIResult(status="timeout", exit_code=-1, stdout="", stderr="", duration_sec=9.0, command=["x"])
        for failure in (RuntimeError("synth down"), bad):
            with self.subTest(failure=type(failure).__name__), self.assertRaises(panel.PanelPhaseError):
                self._run(make_fake_invoke_provider({"synthesizer": failure}))
        self.assertFalse((self.run_dir / "panel" / "master_spec.md").exists())
        self.assertEqual(_payloads(self.store, self.run_id, panel.PANEL_SYNTHESIZED), [])

    def test_master_spec_and_synthesizer_prompt(self) -> None:
        spec = "# Master Spec\n\n## Goals\n- ship"
        invoke = make_fake_invoke_provider({"synthesizer": spec})
        result = self._run(invoke)

        path = self.run_dir / "panel" / "master_spec.md"
        self.assertEqual(Path(result.master_spec_path), path)
        self.assertEqual(path.read_text(encoding="utf-8"), spec)
        self.assertEqual(result.master_spec_text, spec)
        synth = invoke.calls[-1]
        self.assertEqual(
            (synth["artifact_key"], synth["provider"], synth["model"]),
            ("panel_synthesizer", "claude_sub", "sonnet@high"),
        )
        for needle in ("Build the thing.", "# ux report", "# visual report", "# safety report", "- prefer stdlib"):
            self.assertIn(needle, synth["prompt"])
        self.assertNotIn("{{", synth["prompt"])

    def test_event_payload_keys(self) -> None:
        long_text = "word \n\t " * 400
        self._run(make_fake_invoke_provider({"ux": long_text}))

        started = _payloads(self.store, self.run_id, panel.PANEL_STARTED)
        self.assertEqual(started, [{"member_count": 3, "run_id": self.run_id}])
        member_keys = {
            "member_id", "perspective", "provider", "model", "ok", "tokens_in", "tokens_out",
            "cost_usd", "elapsed_sec", "preview", "output_path", "error",
        }
        completed = _payloads(self.store, self.run_id, panel.PANEL_MEMBER_COMPLETED)
        self.assertEqual(len(completed), 3)
        for payload in completed:
            self.assertEqual(set(payload), member_keys)
            self.assertEqual((payload["tokens_in"], payload["tokens_out"], payload["cost_usd"]), (100, 50, 0.001))
            self.assertLessEqual(len(payload["preview"]), 600)
        ux = next(p for p in completed if p["member_id"] == "ux")
        self.assertNotRegex(ux["preview"], r"\s{2}|[\n\t]")
        self.assertEqual(len((self.run_dir / "panel" / "ux.md").read_text(encoding="utf-8")), len(long_text))

        (synth,) = _payloads(self.store, self.run_id, panel.PANEL_SYNTHESIZED)
        self.assertEqual(set(synth), {
            "member_count", "succeeded_count", "provider", "model", "tokens_in", "tokens_out",
            "cost_usd", "elapsed_sec", "preview", "master_spec_path",
        })
        for key in ("tokens_in", "tokens_out", "cost_usd", "elapsed_sec"):
            self.assertIsInstance(synth[key], (int, float))
        self.assertEqual((synth["member_count"], synth["succeeded_count"]), (3, 3))

    def test_artifacts_keep_provider_newlines_verbatim(self) -> None:
        # CLI stdout on Windows carries CRLF; text-mode writes used to turn it into CR CR LF.
        self._run(make_fake_invoke_provider({"ux": "a\r\nb", "synthesizer": "# Spec\r\n\r\nok"}))
        self.assertEqual((self.run_dir / "panel" / "ux.md").read_bytes(), b"a\r\nb")
        self.assertEqual((self.run_dir / "panel" / "master_spec.md").read_bytes(), b"# Spec\r\n\r\nok")

    def test_repo_working_tree_unchanged(self) -> None:
        before = _snapshot(self.repo)
        self._run(make_fake_invoke_provider({}))
        self.assertEqual(_snapshot(self.repo), before)


class TestBuildDefaultPanelSettings(unittest.TestCase):
    def test_explicit_members_are_returned_as_is(self) -> None:
        cfg = parse_config_dict(_panel_raw())
        self.assertIs(panel.build_default_panel_settings(cfg), cfg.panel)

    def test_derives_deterministic_members_from_roles(self) -> None:
        raw = {
            "providers": {"claude_sub": {}, "codex_sub": {}, "gem": {}},
            "roles": {
                "reviewer": {"provider": "claude_sub", "model": "opus@high"},
                "micro_orchestrator": {"provider": "claude_sub", "model": "sonnet@high"},
                "critical_executor": {"provider": "codex_sub", "model": "gpt-6.2-sol@max"},
                "bulk_worker": {"provider": "gem", "model": "gemini-4-hydrogen-high"},
            },
        }
        first = panel.build_default_panel_settings(parse_config_dict(raw))
        second = panel.build_default_panel_settings(parse_config_dict(raw))

        self.assertEqual(first, second)
        self.assertTrue(first.enabled)
        self.assertEqual(
            [(m.id, m.perspective, m.provider, m.model) for m in first.members],
            [
                ("ux", "UX & Copy", "claude_sub", "sonnet@high"),
                ("visual", "Visual & Structure", "codex_sub", "gpt-6.2-sol@max"),
                ("safety", "Source & Safety", "gem", "gemini-4-hydrogen-high"),
            ],
        )
        self.assertEqual((first.synthesizer_provider, first.synthesizer_model), ("gem", "gemini-4-hydrogen-high"))

    def test_single_provider_without_roles_still_has_members(self) -> None:
        settings = panel.build_default_panel_settings(parse_config_dict({"providers": {"only": {}}, "roles": {}}))
        self.assertEqual(len(settings.members), 3)
        self.assertEqual({m.provider for m in settings.members}, {"only"})


class TestPanelImports(unittest.TestCase):
    def test_panel_imports_only_stdlib_and_vibebaton(self) -> None:
        tree = ast.parse(Path(panel.__file__).read_text(encoding="utf-8"))
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                names = [alias.name for alias in node.names]
            elif isinstance(node, ast.ImportFrom):
                if node.level:
                    continue
                names = [node.module or ""]
            else:
                continue
            for name in names:
                with self.subTest(module=name):
                    self.assertTrue(name.split(".")[0] in sys.stdlib_module_names | {"vibebaton"})


# ----------------------------------------------------------------------
# End-to-end: CLI and REST launch with a CLI mock + an HTTP mock provider
# ----------------------------------------------------------------------

_E2E_KEY_ENV = "VIBEBATON_PANEL_E2E_KEY"
_E2E_API_KEY = "panel-e2e-secret-token"
_E2E_HTTP_DELAY_SEC = 1.0
_E2E_MASTER_SPEC = "# Master Spec\n\nMASTER-SPEC-MARKER: ship the calculator."
_E2E_PLAN = {
    "rfc_version": "v1.0",
    "complexity_tier": "S",
    "summary": "Single milestone plan",
    "milestones": [{
        "id": "M1",
        "title": "Core",
        "tasks": [{"id": "T-1", "title": "Implement core", "allowed_paths": ["src/core.py"]}],
    }],
}

# Real subprocess CLI agent. Panel specialists stay in flight until the HTTP
# specialist's request reaches the loopback server, which proves the overlap.
_E2E_MOCK_AGENT = r'''
import os, sys, time
from pathlib import Path

role = os.environ["VIBEBATON_ROLE"]
state = Path(os.environ["MOCK_STATE_DIR"])
sys.stdin.read()
if role == "tactical_planner":
    print(os.environ["MOCK_PLAN_JSON"])
elif role == "panel_synthesizer":
    print(os.environ["MOCK_MASTER_SPEC"])
elif role.startswith("panel_"):
    (state / f"{role}.start").write_text(repr(time.time()), encoding="utf-8")
    deadline = time.time() + 20
    while not (state / "http_seen").exists() and time.time() < deadline:
        time.sleep(0.02)
    (state / f"{role}.end").write_text(repr(time.time()), encoding="utf-8")
    print(f"# {role} report\n\nCLI specialist findings.")
else:
    sys.stderr.write(f"Unhandled mock call: {role}\n")
    sys.exit(1)
'''


class _SignalingRequests(list):
    """Request log that timestamps the HTTP arrival and drops a flag file for the CLI mock."""

    def __init__(self, flag: Path) -> None:
        super().__init__()
        self.flag = flag
        self.arrivals: list[float] = []

    def append(self, item: Any) -> None:
        self.arrivals.append(time.time())
        super().append(item)
        self.flag.touch()


class TestPanelEndToEnd(unittest.TestCase):
    """mode=panel launched via ``baton run`` and via POST /api/runs/start, then reported and exported."""

    def setUp(self) -> None:
        tmp = Path(self.enterContext(tempfile.TemporaryDirectory())).resolve()
        self.repo = tmp / "repo"
        self.repo.mkdir()
        for args in (["init", "-b", "main"], ["config", "user.email", "ci@vibebaton.local"],
                     ["config", "user.name", "VibeBaton CI"]):
            subprocess.run(["git", *args], cwd=self.repo, check=True, capture_output=True)
        (self.repo / "README.md").write_text("# Demo\n", encoding="utf-8")
        subprocess.run(["git", "add", "-A"], cwd=self.repo, check=True, capture_output=True)
        subprocess.run(["git", "commit", "-m", "init"], cwd=self.repo, check=True, capture_output=True)

        self.state_dir = tmp / "mock_state"
        self.state_dir.mkdir()
        self.mock_agent = tmp / "mock_agent.py"
        self.mock_agent.write_text(_E2E_MOCK_AGENT, encoding="utf-8")
        self.rfc = self.repo / ".baton" / "00_RFC.md"
        self.rfc.parent.mkdir()
        self.rfc.write_text("# RFC\nBuild a calculator.\n", encoding="utf-8")
        self.config_path = self.repo / ".baton" / "config.json"
        self.credentials_path = tmp / "credentials.json"

        self.enterContext(patch.dict(os.environ, {"NO_PROXY": "127.0.0.1", _E2E_KEY_ENV: _E2E_API_KEY}))
        self.http = self.enterContext(MockChatCompletionsServer([MockResponse.from_json({
            "choices": [{"message": {"content": "# safety report\n\nHTTP specialist findings."}}],
            "usage": {"prompt_tokens": 200, "completion_tokens": 100},
        }, delay_sec=_E2E_HTTP_DELAY_SEC)]))
        self.http.requests = _SignalingRequests(self.state_dir / "http_seen")
        self._write_config(self.http.base_url)
        # Milestone execution is covered by test_e2e_pipeline; this suite stops after 01_PLAN.
        self.enterContext(patch.object(OrchestrationEngine, "_execute_milestone", AsyncMock(return_value=True)))

    def _write_config(self, base_url: str) -> None:
        cfg = {
            "daemon": {
                "base_branch": "main", "dev_branch": "dev", "prevent_sleep_windows": False,
                "default_stall_timeout_sec": 30, "default_hard_timeout_sec": 60,
            },
            "providers": {
                "cli_mock": {
                    "type": "cli",
                    "max_concurrency": 2,
                    "command": [sys.executable, str(self.mock_agent)],
                    "prompt_via": "stdin",
                    "env": {
                        "MOCK_STATE_DIR": str(self.state_dir),
                        "MOCK_PLAN_JSON": json.dumps(_E2E_PLAN),
                        "MOCK_MASTER_SPEC": _E2E_MASTER_SPEC,
                    },
                },
                "http_mock": {
                    "type": "http",
                    "base_url": f"{base_url}/v1",
                    "api_key_env": _E2E_KEY_ENV,
                    "model_pricing": {"mock-reasoner": {"input_per_1m": 2.0, "output_per_1m": 4.0}},
                },
            },
            "roles": {
                "tactical_planner": {"provider": "cli_mock", "model": "opus@high"},
                "bulk_worker": {"provider": "cli_mock", "model": "sonnet@high"},
            },
            "panel": {
                "enabled": True,
                "max_concurrency": 3,
                "synthesizer_provider": "cli_mock",
                "synthesizer_model": "sonnet@high",
                "members": [
                    {"id": "ux", "perspective": "UX & Copy", "provider": "cli_mock", "model": "sonnet@high"},
                    {"id": "safety", "perspective": "Source & Safety", "provider": "http_mock",
                     "model": "mock-reasoner@high"},
                ],
            },
        }
        self.config_path.write_text(json.dumps(cfg), encoding="utf-8")

    def _cli(self, *argv: str) -> tuple[int, str]:
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            code = cli.main([*argv, "--repo", str(self.repo), "--config", str(self.config_path)])
        return code, out.getvalue()

    def _assert_panel_run(self, store: StateStore, run_id: str) -> None:
        run = store.get_run(run_id)
        events = store.get_events(run_id, limit=-1)
        kinds = [e["kind"] for e in events]
        self.assertEqual((run["mode"], run["status"]), ("panel", "READY_FOR_FINAL_GATE"), kinds)

        # 00_PANEL completes before 01_PLAN.
        first = {k: kinds.index(k) for k in ("panel_started", "panel_synthesized", "stage_completed", "plan_generated")}
        last_member = len(kinds) - 1 - kinds[::-1].index("panel_member_completed")
        self.assertLess(first["panel_started"], last_member)
        self.assertLess(last_member, first["panel_synthesized"])
        self.assertLess(first["panel_synthesized"], first["stage_completed"])
        self.assertLess(first["stage_completed"], first["plan_generated"])
        self.assertEqual(json.loads(events[first["stage_completed"]]["payload_json"])["stage"], panel.STAGE_PANEL)

        members = {p["member_id"]: p for p in _payloads(store, run_id, panel.PANEL_MEMBER_COMPLETED)}
        self.assertEqual(set(members), {"ux", "safety"})
        self.assertTrue(all(p["ok"] for p in members.values()), members)
        self.assertEqual(members["ux"]["provider"], "cli_mock")
        self.assertEqual(
            (members["safety"]["provider"], members["safety"]["tokens_in"], members["safety"]["tokens_out"]),
            ("http_mock", 200, 100),
        )

        # Artifacts.
        panel_dir = self.repo / ".baton" / "runs" / run_id / "panel"
        self.assertIn("CLI specialist findings.", (panel_dir / "ux.md").read_text(encoding="utf-8"))
        self.assertIn("HTTP specialist findings.", (panel_dir / "safety.md").read_text(encoding="utf-8"))
        self.assertEqual((panel_dir / "master_spec.md").read_text(encoding="utf-8").strip(), _E2E_MASTER_SPEC)

        # The CLI and HTTP specialists were in flight at the same time.
        (arrival,) = self.http.requests.arrivals
        cli_start = float((self.state_dir / "panel_ux.start").read_text(encoding="utf-8"))
        cli_end = float((self.state_dir / "panel_ux.end").read_text(encoding="utf-8"))
        self.assertLess(cli_start, arrival + _E2E_HTTP_DELAY_SEC)
        self.assertGreaterEqual(cli_end, arrival)
        self.assertEqual(self.http.requests[0].headers["Authorization"], f"Bearer {_E2E_API_KEY}")

        # Telemetry, bilingual battle report and a clean case export.
        stages = [s["id"] for s in compute_run_telemetry(store, run_id)["stages"]]
        self.assertLess(stages.index(panel.STAGE_PANEL), stages.index("PLANNING"))
        panel_stage = compute_run_telemetry(store, run_id)["stages"][stages.index(panel.STAGE_PANEL)]
        self.assertEqual(panel_stage["status"], "PASSED")
        en = generate_battle_report(store, run_id, lang="en")
        zh = generate_battle_report(store, run_id, lang="zh")
        self.assertIn("## Panel & Synthesis", en)
        self.assertIn("## 专家会诊与综合", zh)
        for report in (en, zh):
            self.assertIn("`safety`", report)
            self.assertIn("`ux`", report)
        bundle = export_sanitized_case(store, run_id)
        self.assertTrue(bundle["redaction_report"]["clean"], bundle["redaction_report"])
        serialized = json.dumps(bundle, ensure_ascii=False)
        self.assertIn(panel.STAGE_PANEL, serialized)
        for leak in (_E2E_API_KEY, str(self.repo), str(self.state_dir)):
            self.assertNotIn(leak, serialized)

    def test_cli_run_mode_panel(self) -> None:
        code, out = self._cli("run", "--rfc", str(self.rfc), "--mode", "panel")
        store = StateStore(self.repo / ".baton" / "state.sqlite")
        run_id = store.get_latest_run()["id"]
        self.assertEqual(code, 0, out)
        self.assertIn(f"run_id={run_id} final_status=READY_FOR_FINAL_GATE", out)
        self._assert_panel_run(store, run_id)

    def test_rest_start_mode_panel(self) -> None:
        spawned: list[tuple[Path, Path, str]] = []

        def spawner(repo: Path, config: Path, run_id: str) -> int:
            spawned.append((repo, config, run_id))
            return 4242

        server = create_server(
            self.repo, port=0, config_path=self.config_path, daemon_spawner=spawner,
            credentials_path=self.credentials_path, provider_probe=Mock(return_value=(True, "ok")),
        )
        self.addCleanup(server.server_close)
        thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True)
        thread.start()
        self.addCleanup(thread.join, timeout=5)
        self.addCleanup(server.shutdown)

        request = Request(
            f"http://127.0.0.1:{server.server_address[1]}/api/runs/start", method="POST",
            data=json.dumps({"rfc_markdown": "# RFC\nBuild a calculator.\n", "mode": "panel"}).encode("utf-8"),
            headers={"Content-Type": "application/json"},
        )
        with urlopen(request, timeout=5) as response:
            self.assertEqual(response.status, 201)
            run_id = json.load(response)["run_id"]
        self.assertEqual(spawned, [(self.repo, self.config_path, run_id)])

        # Act as the detached daemon the server would have spawned.
        code, out = self._cli("daemon", "--run-id", run_id)
        self.assertEqual(code, 0, out)
        self._assert_panel_run(server.store, run_id)


# ----------------------------------------------------------------------
# Shipped configs still parse
# ----------------------------------------------------------------------

_REPO_ROOT = Path(__file__).resolve().parents[1]


class TestShippedConfigsParse(unittest.TestCase):
    def test_baton_example_toml_parses(self) -> None:
        raw = tomllib.loads((_REPO_ROOT / "baton.example.toml").read_text(encoding="utf-8"))
        cfg = parse_config_dict(raw)

        self.assertTrue(cfg.panel.enabled)
        self.assertEqual(cfg.panel.synthesizer_provider, "claude_sub")
        self.assertEqual(cfg.panel.synthesizer_model, "sonnet@high")
        self.assertEqual(
            [(m.perspective, m.provider, m.model) for m in cfg.panel.members],
            [
                ("UX & Copy", "claude_sub", "opus@high"),
                ("Visual & Structure", "gemini_http", "gemini-4-neon@high"),
                ("Source & Safety", "codex_sub", "gpt-6.2-sol@max"),
            ],
        )
        roles = {name: f"{role.provider}:{role.model}" for name, role in cfg.roles.items()}
        self.assertEqual(roles["tactical_planner"], "claude_sub:opus@high")
        self.assertEqual(roles["critical_executor"], "codex_sub:gpt-6.2-sol@max")
        self.assertEqual(roles["micro_orchestrator"], "codex_sub:gpt-6.2-sol@high")
        self.assertEqual(roles["bulk_worker"], "dsh_opencode:deepseek-v4.1-flash@max")
        self.assertIn("max_quality", (_REPO_ROOT / "baton.example.toml").read_text(encoding="utf-8"))

    def test_local_baton_toml_parses_if_present(self) -> None:
        path = _REPO_ROOT / ".baton" / "baton.toml"
        if not path.is_file():
            self.skipTest(f"{path} not present")
        parse_config_dict(tomllib.loads(path.read_text(encoding="utf-8")))


if __name__ == "__main__":
    unittest.main()
