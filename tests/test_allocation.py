"""Allocation contract tests using real config fixtures and table-driven cases."""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import DEFAULT, patch

from vibebaton.allocation import (
    ALLOWED_BUDGET_PROFILES,
    compute_step_up_target,
    parse_model_spec,
    resolve_task_allocation,
)
from vibebaton.cli_runner import CLIResult
from vibebaton.config import BatonConfig, HotReloadConfig, ModelCapability, build_model_catalog, parse_config_dict
from vibebaton.db import StateStore
from vibebaton.engine import OrchestrationEngine
from vibebaton.gates import GateSuiteResult
from vibebaton.git_ops import WhitelistCheckResult
from vibebaton.report import generate_battle_report
from vibebaton.schemas import MilestoneSpec, PlanDAG, RunStatus, SchemaValidationError, TaskSpec, TaskTier


def _allocation_config() -> BatonConfig:
    return parse_config_dict({
        "providers": {"bulk": {}, "review": {"type": "fixed"}, "specialist": {}, "unused": {}},
        "roles": {
            "bulk_worker": {
                "provider": "bulk",
                "model": "worker-flash@low",
                "fallback": [
                    {"provider": "missing", "model": "unregistered"},
                    {"provider": "review", "model": "review-opus@high"},
                ],
            },
            "micro_orchestrator": {"provider": "specialist", "model": "solver@max"},
            "critical_executor": {"provider": "specialist", "model": "solver@max"},
            "final_gate": {"provider": "host_native", "model": "host-model"},
        },
    })


class TestModelCatalog(unittest.TestCase):
    def test_builds_only_distinct_targets_on_configured_providers(self) -> None:
        catalog = build_model_catalog(_allocation_config())

        self.assertEqual(catalog, [
            ModelCapability("bulk", "worker-flash@low", ["low", "high", "max"], "eco", True),
            ModelCapability("review", "review-opus@high", ["high"], "flagship", True),
            ModelCapability("specialist", "solver@max", ["low", "high", "max"], "standard", True),
        ])

    def test_readiness_checks_include_detail_and_leave_missing_providers_unready(self) -> None:
        catalog = build_model_catalog(_allocation_config(), {
            "bulk": {"ok": False, "detail": "CLI missing"},
            "review": {"ok": True, "detail": "Ready"},
            "unused": {"ok": True, "detail": "No role target"},
        })

        self.assertEqual(
            [(cap.provider, cap.ready, cap.detail) for cap in catalog],
            [("bulk", False, "CLI missing"), ("review", True, "Ready"), ("specialist", False, "")],
        )
        self.assertTrue(all(not cap.ready for cap in build_model_catalog(_allocation_config(), {})))

    def test_efforts_follow_the_suffix_and_cli_template(self) -> None:
        cfg = parse_config_dict({
            "providers": {"cli": {"command": ["runner", "--effort", "{effort}"]}, "plain": {}},
            "roles": {
                "worker": {"provider": "cli", "model": "worker"},
                "reviewer": {"provider": "cli", "model": "review-astra@xhigh"},
                "planner": {"provider": "plain", "model": "profile"},
            },
        })

        self.assertEqual(build_model_catalog(cfg), [
            ModelCapability("cli", "worker", ["low", "high", "max"], "standard", True),
            ModelCapability("cli", "review-astra@xhigh", ["low", "high", "max", "xhigh"], "flagship", True),
            ModelCapability("plain", "profile", [], "standard", True),
        ])

    def test_capability_serializes_to_an_independent_dict(self) -> None:
        capability = ModelCapability("bulk", "worker-flash@low", ["low"], "eco", False, "CLI missing")
        payload = capability.to_dict()

        self.assertEqual(payload, {
            "provider": "bulk", "model": "worker-flash@low", "efforts": ["low"],
            "cost_tier": "eco", "ready": False, "detail": "CLI missing",
        })
        payload["efforts"].append("max")
        self.assertEqual(capability.efforts, ["low"])


class TestTaskAllocation(unittest.TestCase):
    def setUp(self) -> None:
        self.cfg = _allocation_config()
        self.catalog = build_model_catalog(self.cfg)

    def test_parses_only_known_provider_prefixes(self) -> None:
        cases = (
            ("worker-flash@low", ("bulk", "worker-flash@low")),
            ("specialist:solver@max", ("specialist", "solver@max")),
            ("unknown:model@high", ("bulk", "unknown:model@high")),
            ("specialist:family:version@high", ("specialist", "family:version@high")),
        )
        for spec, expected in cases:
            with self.subTest(spec=spec):
                self.assertEqual(parse_model_spec(spec, "bulk", iter(self.cfg.providers)), expected)

    def test_honors_a_ready_pin_ahead_of_budget_preferences(self) -> None:
        task = TaskSpec("T1", "Pinned task", assigned_model="bulk:worker-flash@high", pinned=True)
        single_provider_catalog = build_model_catalog(self.cfg, {"bulk": {"ok": True}})
        for catalog in (self.catalog, single_provider_catalog):
            with self.subTest(ready_providers=sum(cap.ready for cap in catalog)):
                provider, model, reason = resolve_task_allocation(task, self.cfg, catalog, "max_quality")

                self.assertEqual((provider, model), ("bulk", "worker-flash@high"))
                self.assertIn("pinned", reason)

    def test_keeps_ready_planner_assignment_with_multiple_ready_providers(self) -> None:
        task = TaskSpec("T1", "Assigned task", assigned_model="specialist:solver@high")

        provider, model, reason = resolve_task_allocation(task, self.cfg, self.catalog)

        self.assertEqual((provider, model), ("specialist", "solver@high"))
        self.assertIn("planner assignment", reason)

    def test_corrects_unknown_models_and_unsupported_efforts(self) -> None:
        for spec in ("unconfigured@max", "unknown:solver@max", "review:review-opus@max"):
            with self.subTest(spec=spec):
                task = TaskSpec("T1", "Corrected task", assigned_model=spec, pinned=True)

                provider, model, reason = resolve_task_allocation(task, self.cfg, self.catalog)

                self.assertEqual((provider, model), ("bulk", "worker-flash@low"))
                self.assertIn(spec, reason)
                self.assertIn("unknown or has unsupported effort", reason)

    def test_offline_pin_is_corrected_to_the_ready_role_fallback(self) -> None:
        catalog = build_model_catalog(self.cfg, {
            "bulk": {"ok": False, "detail": "CLI missing"},
            "review": {"ok": True},
            "specialist": {"ok": True},
        })
        task = TaskSpec("T1", "Offline task", assigned_model="worker-flash@low", pinned=True)

        provider, model, reason = resolve_task_allocation(task, self.cfg, catalog)

        self.assertEqual((provider, model), ("review", "review-opus@high"))
        self.assertIn("worker-flash@low", reason)
        self.assertIn("offline", reason)

    def test_empty_catalog_uses_role_fallback_or_default(self) -> None:
        cases = (
            ("bulk_worker", ("review", "review-opus@high"), "fallback"),
            ("critical_executor", ("specialist", "solver@max"), "default"),
        )
        for role, target, source in cases:
            with self.subTest(role=role):
                task = TaskSpec("T1", "Unverified task", assignee_role=role, assigned_model="invented")

                provider, model, reason = resolve_task_allocation(task, self.cfg, [])

                self.assertEqual((provider, model), target)
                self.assertIn("empty", reason)
                self.assertIn(source, reason)

    def test_catalog_with_no_ready_targets_raises(self) -> None:
        catalog = build_model_catalog(self.cfg, {"bulk": {"ok": False}})

        with self.assertRaisesRegex(ValueError, "No ready models.*T1"):
            resolve_task_allocation(TaskSpec("T1", "Unavailable task"), self.cfg, catalog)

    def test_single_ready_provider_effort_matrix(self) -> None:
        catalog = build_model_catalog(self.cfg, {"bulk": {"ok": True}})
        cases = (
            ("eco", TaskTier.ROUTINE, "low"),
            ("eco", TaskTier.CRITICAL, "high"),
            ("balanced", TaskTier.ROUTINE, "high"),
            ("balanced", TaskTier.CRITICAL, "max"),
            ("max_quality", TaskTier.ROUTINE, "max"),
            ("max_quality", TaskTier.CRITICAL, "max"),
        )
        for profile, tier, effort in cases:
            with self.subTest(profile=profile, tier=tier):
                task = TaskSpec("T1", "Budgeted task", tier=tier, assigned_model="worker-flash@low")

                provider, model, reason = resolve_task_allocation(task, self.cfg, catalog, profile)

                self.assertEqual((provider, model), ("bulk", f"worker-flash@{effort}"))
                self.assertIn(profile, reason)

    def test_single_provider_uses_policy_and_prefers_flagship_for_max_quality(self) -> None:
        cfg = parse_config_dict({
            "policies": {"budget_profile": "max_quality"},
            "providers": {"bulk": {}},
            "roles": {
                "bulk_worker": {"provider": "bulk", "model": "worker-flash@low"},
                "critical_executor": {"provider": "bulk", "model": "solver-flagship@high"},
            },
        })

        task = TaskSpec("T1", "Quality task")
        provider, model, reason = resolve_task_allocation(task, cfg, build_model_catalog(cfg))

        self.assertEqual((provider, model), ("bulk", "solver-flagship@max"))
        self.assertIn("max_quality", reason)

    def test_preserves_configured_effort_when_requested_effort_is_unsupported(self) -> None:
        catalog = build_model_catalog(self.cfg, {"review": {"ok": True}})
        task = TaskSpec("T1", "Fixed effort task")

        provider, model, _ = resolve_task_allocation(task, self.cfg, catalog, "max_quality")

        self.assertEqual((provider, model), ("review", "review-opus@high"))

    def test_multi_provider_budget_preferences(self) -> None:
        cases = (
            ("eco", ("bulk", "worker-flash@low")),
            ("balanced", ("specialist", "solver@max")),
            ("max_quality", ("review", "review-opus@high")),
        )
        task = TaskSpec("T1", "Unassigned task", assignee_role="critical_executor")
        for profile, expected in cases:
            with self.subTest(profile=profile):
                provider, model, _ = resolve_task_allocation(task, self.cfg, self.catalog, profile)

                self.assertEqual((provider, model), expected)


class TestStepUp(unittest.TestCase):
    def test_increases_effort_then_uses_flagship_then_critical_executor(self) -> None:
        cfg = _allocation_config()
        catalog = build_model_catalog(cfg)
        ladder = (
            ("bulk", "worker-flash@low"),
            ("bulk", "worker-flash@high"),
            ("bulk", "worker-flash@max"),
            ("review", "review-opus@high"),
            ("specialist", "solver@max"),
        )
        for current, expected in zip(ladder, (*ladder[1:], None), strict=True):
            with self.subTest(current=current):
                self.assertEqual(compute_step_up_target(*current, cfg, catalog), expected)

    def test_attempt_counts_higher_ready_rungs_from_the_same_failed_target(self) -> None:
        cfg = _allocation_config()
        catalog = build_model_catalog(cfg, {"bulk": {"ok": True}, "specialist": {"ok": True}})
        cases = ((2, ("bulk", "worker-flash@max")), (3, ("specialist", "solver@max")), (4, None))
        for attempt, expected in cases:
            with self.subTest(attempt=attempt):
                target = compute_step_up_target("bulk", "worker-flash@low", cfg, catalog, attempt)

                self.assertEqual(target, expected)

    def test_skips_unsupported_efforts_on_same_model(self) -> None:
        cfg = parse_config_dict({
            "providers": {"bulk": {"type": "fixed"}},
            "roles": {
                "bulk_worker": {
                    "provider": "bulk", "model": "worker@low",
                    "fallback": [{"provider": "bulk", "model": "worker@max"}],
                },
                "critical_executor": {"provider": "bulk", "model": "worker@low"},
            },
        })
        catalog = build_model_catalog(cfg)

        self.assertEqual(compute_step_up_target("bulk", "worker@low", cfg, catalog), ("bulk", "worker@max"))
        self.assertIsNone(compute_step_up_target("bulk", "worker@max", cfg, catalog))

    def test_step_up_cannot_select_offline_targets(self) -> None:
        cfg = _allocation_config()
        catalog = build_model_catalog(cfg, {"bulk": {"ok": True}})

        self.assertIsNone(compute_step_up_target("bulk", "worker-flash@max", cfg, catalog))
        self.assertIsNone(compute_step_up_target("bulk", "worker-flash@low", cfg, []))


class TestAllocationSerialization(unittest.TestCase):
    def test_budget_profile_loads_from_json_and_toml(self) -> None:
        self.assertEqual(ALLOWED_BUDGET_PROFILES, ("eco", "balanced", "max_quality"))
        with tempfile.TemporaryDirectory() as temp:
            for profile in (*ALLOWED_BUDGET_PROFILES, None):
                data = {} if profile is None else {"budget_profile": profile}
                toml = "[policies]\n" if profile is None else f'[policies]\nbudget_profile = "{profile}"\n'
                for extension, content in (("json", json.dumps({"policies": data})), ("toml", toml)):
                    with self.subTest(profile=profile, format=extension):
                        path = Path(temp) / f"baton.{extension}"
                        path.write_text(content, encoding="utf-8")

                        self.assertEqual(HotReloadConfig(path).current.policies.budget_profile, profile or "balanced")

    def test_loader_rejects_invalid_budget_profiles_with_value_error(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            toml_path = Path(temp) / "baton.toml"
            toml_path.write_text('[policies]\nbudget_profile = "fast"\n', encoding="utf-8")
            with self.assertRaisesRegex(ValueError, r"policies\.budget_profile.*eco, balanced, max_quality"):
                HotReloadConfig(toml_path)

            json_path = Path(temp) / "baton.json"
            for invalid in ("fast", "", None, True, ["eco"]):
                with self.subTest(invalid=invalid):
                    json_path.write_text(json.dumps({"policies": {"budget_profile": invalid}}), encoding="utf-8")

                    with self.assertRaisesRegex(ValueError, r"policies\.budget_profile.*eco, balanced, max_quality"):
                        HotReloadConfig(json_path)

    def test_task_spec_round_trips_all_allocation_fields(self) -> None:
        task = TaskSpec.from_dict({
            "id": "T1", "title": "Round trip", "tier": "critical",
            "assigned_model": "specialist:solver@max", "allocation_reason": "High complexity", "pinned": True,
        })
        payload = json.loads(json.dumps(task.to_dict()))

        self.assertEqual(payload["assigned_model"], "specialist:solver@max")
        self.assertEqual(payload["allocation_reason"], "High complexity")
        self.assertIs(payload["pinned"], True)
        self.assertEqual(TaskSpec.from_dict(payload), task)

    def test_allocation_fields_reject_wrong_json_types(self) -> None:
        for key, value in (("assigned_model", []), ("allocation_reason", 5), ("pinned", "false")):
            with self.subTest(key=key):
                with self.assertRaisesRegex(SchemaValidationError, f"T1.*{key}"):
                    TaskSpec.from_dict({"id": "T1", "title": "Wrong type", key: value})

    def test_legacy_plan_uses_original_role_defaults_and_optional_allocation(self) -> None:
        plan = PlanDAG.from_dict({
            "milestones": [{
                "id": "M1", "title": "Legacy plan",
                "tasks": [
                    {"id": "T1", "title": "Routine"},
                    {"id": "T2", "title": "Critical", "tier": "critical", "depends_on": ["T1"]},
                ],
            }],
        })

        self.assertEqual(plan.milestones[0].tasks, [
            TaskSpec("T1", "Routine"),
            TaskSpec("T2", "Critical", tier=TaskTier.CRITICAL, assignee_role="critical_executor",
                     reviewer_role=None, depends_on=["T1"]),
        ])
        for task in plan.milestones[0].tasks:
            with self.subTest(task=task.id):
                self.assertIsNone(task.assigned_model)
                self.assertIsNone(task.allocation_reason)
                self.assertIs(task.pinned, False)
        self.assertEqual(PlanDAG.from_dict(plan.to_dict()), plan)


class TestTaskDispatchAllocation(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        self.repo = Path(self.enterContext(tempfile.TemporaryDirectory()))
        config_path = self.repo / "baton.json"
        config_path.write_text(json.dumps({
            "daemon": {"prevent_sleep_windows": False},
            "providers": {"worker": {}, "manual": {}},
            "roles": {"bulk_worker": {"provider": "worker", "model": "flash@low"}},
        }), encoding="utf-8")
        self.rfc_path = self.repo / "rfc.md"
        self.rfc_path.write_text("# Allocation test", encoding="utf-8")
        self.store = StateStore(self.repo / "state.sqlite")
        self.engine = OrchestrationEngine(self.repo, HotReloadConfig(config_path), self.store)
        git_ops = self.enterContext(patch.multiple(
            "vibebaton.engine", ensure_git_ready=DEFAULT, ensure_branch=DEFAULT,
            create_worktree=DEFAULT, remove_worktree=DEFAULT,
            commit_worktree_changes=DEFAULT, merge_branch_into=DEFAULT,
        ))
        git_ops["ensure_git_ready"].return_value = "main"
        self.enterContext(patch(
            "vibebaton.engine.check_path_whitelist", return_value=WhitelistCheckResult(True, [], []),
        ))
        self.enterContext(patch.object(self.engine, "_run_milestone_gate_and_review", return_value=True))
        self.cli = self.enterContext(patch(
            "vibebaton.engine.run_provider_cli", return_value=CLIResult("ok", 0, "", "", 0, []),
        ))
        self.gates = self.enterContext(patch("vibebaton.engine.run_gate_suite"))

    async def _run_task(
        self, task: TaskSpec, overrides: dict[str, str] | None = None,
    ) -> tuple[str, RunStatus]:
        plan_path = self.repo / "plan.json"
        plan = PlanDAG("v1", "M", [MilestoneSpec("M1", "Allocation", tasks=[task])])
        plan_path.write_text(json.dumps(plan.to_dict()), encoding="utf-8")
        run_id = self.store.create_run(self.repo, self.rfc_path, plan_path=plan_path, model_overrides=overrides)
        return run_id, await self.engine.execute_run(run_id)

    def _worker_targets(self) -> list[tuple[str, str]]:
        return [(call.args[0].name, call.kwargs["model"]) for call in self.cli.await_args_list]

    async def test_override_then_ready_pin_then_smart_allocation(self) -> None:
        cases = (
            (None, {}, ("worker", "flash@high"), "balanced routine allocation"),
            ("flash@low", {}, ("worker", "flash@low"), "pinned assignment"),
            (None, {"bulk_worker": "manual:custom@max"}, ("manual", "custom@max"), "override"),
            ("flash@low", {"bulk_worker": "manual:custom@max"}, ("manual", "custom@max"), "override"),
        )
        for pin, overrides, target, reason in cases:
            with self.subTest(pin=pin, overrides=overrides):
                self.cli.reset_mock()
                task = TaskSpec(
                    "T1", "Route worker", reviewer_role=None, assigned_model=pin, pinned=pin is not None,
                )

                run_id, status = await self._run_task(task, overrides)

                self.assertEqual(status, RunStatus.READY_FOR_FINAL_GATE)
                self.assertEqual(self._worker_targets(), [target])
                allocations = [e for e in self.store.get_events(run_id) if e["kind"] == "task_allocated"]
                self.assertEqual(len(allocations), 1)
                payload = json.loads(allocations[0]["payload_json"])
                self.assertEqual(payload["task_id"], "T1")
                self.assertEqual((payload["provider"], payload["model"]), target)
                self.assertEqual(payload["budget_profile"], "balanced")
                self.assertIs(payload["pinned"], pin is not None)
                self.assertIn(reason, payload["reason"])
                stored = json.loads(self.store.get_task(run_id, "T1")["spec_json"])
                self.assertEqual(stored["assigned_model"], ":".join(target))
                self.assertEqual(stored["allocation_reason"], payload["reason"])

    async def test_self_heal_ceiling_redispatches_at_higher_effort(self) -> None:
        self.gates.side_effect = [
            GateSuiteResult(False, []), GateSuiteResult(False, []), GateSuiteResult(True, []),
        ]
        task = TaskSpec("T1", "Fix gate", reviewer_role=None, verify_cmd="verify", max_self_heal=1)

        run_id, status = await self._run_task(task)

        self.assertEqual(status, RunStatus.READY_FOR_FINAL_GATE)
        self.assertEqual(self._worker_targets(), [
            ("worker", "flash@high"), ("worker", "flash@high"), ("worker", "flash@max"),
        ])
        step_ups = [e for e in self.store.get_events(run_id) if e["kind"] == "task_step_up"]
        self.assertEqual(len(step_ups), 1)
        self.assertEqual(json.loads(step_ups[0]["payload_json"]), {
            "task_id": "T1", "from": "worker:flash@high", "to": "worker:flash@max", "attempt": 3,
        })

    async def test_exhausted_ladder_retains_the_existing_failure_path(self) -> None:
        self.gates.return_value = GateSuiteResult(False, [])
        task = TaskSpec(
            "T1", "Fail gate at max effort", tier=TaskTier.CRITICAL, reviewer_role=None,
            verify_cmd="verify", max_self_heal=0, escalate_role="bulk_worker",
        )

        run_id, status = await self._run_task(task)

        self.assertEqual(status, RunStatus.FAILED)
        self.assertEqual(self._worker_targets(), [("worker", "flash@max")])
        self.assertNotIn("task_step_up", [e["kind"] for e in self.store.get_events(run_id)])

    async def test_valid_pin_and_override_hold_at_retry_ceiling(self) -> None:
        self.gates.return_value = GateSuiteResult(False, [])
        for pinned, overrides in ((True, {}), (False, {"bulk_worker": "worker:flash@low"})):
            with self.subTest(pinned=pinned, overrides=overrides):
                self.cli.reset_mock()
                task = TaskSpec(
                    "T1", "Keep the requested model", reviewer_role=None, verify_cmd="verify",
                    max_self_heal=0, escalate_role="bulk_worker", pinned=pinned,
                    assigned_model="flash@low" if pinned else None,
                )

                run_id, status = await self._run_task(task, overrides)

                self.assertEqual(status, RunStatus.FAILED)
                self.assertEqual(self._worker_targets(), [("worker", "flash@low")])
                self.assertNotIn("task_step_up", [e["kind"] for e in self.store.get_events(run_id)])

    async def test_next_dispatch_observes_a_hot_reloaded_role_default(self) -> None:
        def reload_role_during_gate(commands: list[str], *, workdir: Path) -> GateSuiteResult:
            config_path = self.engine.config_loader.path
            config = json.loads(config_path.read_text(encoding="utf-8"))
            config["roles"]["bulk_worker"]["model"] = "updated-model@low"
            config_path.write_text(json.dumps(config), encoding="utf-8")
            self.engine.config_loader.reload(force=True)
            self.gates.side_effect = None
            self.gates.return_value = GateSuiteResult(True, [])
            return GateSuiteResult(False, [])

        self.gates.side_effect = reload_role_during_gate
        task = TaskSpec("T1", "Reload between attempts", reviewer_role=None, verify_cmd="verify", max_self_heal=1)

        _, status = await self._run_task(task)

        self.assertEqual(status, RunStatus.READY_FOR_FINAL_GATE)
        self.assertEqual(self._worker_targets(), [("worker", "flash@high"), ("worker", "updated-model@low")])


class TestAllocationReport(unittest.TestCase):
    def setUp(self) -> None:
        repo = Path(self.enterContext(tempfile.TemporaryDirectory()))
        self.store = StateStore(repo / "state.sqlite")
        self.run_id = self.store.create_run(repo, repo / "rfc.md", run_id="legacy-run")

    def test_report_without_allocation_events_matches_legacy_bytes(self) -> None:
        self.store.log_event(self.run_id, "mechanical_gate_caught")
        expected = """# VibeBaton Run Report — `legacy-run`

- **Status**: `PENDING`
- **Mode**: `overnight`
- **Elapsed Time**: `0.0s`
- **Milestones**: `0/0` passed
- **Tasks**: `0/0` passed

## Efficiency & Guardrail Highlights

| Metric | Value | Why It Matters |
| :--- | :--- | :--- |
| Mechanical Gate Catches | **1** | Defects fixed locally before spending upper-tier AI review quota |
| Path Whitelist Catches | **0** | Out-of-scope edits blocked & auto-reverted |
| Bulk Worker First-Pass Rate | **N/A** | Routine tasks accepted by micro-review without rework |
| Circuit-Breaker Escalations | **0** | Tough tasks automatically handed off to Specialist tier |
| Subscription Cooldowns Handled | **0** | Rate-limit windows survived automatically without failing the run |

## Task Breakdown

| Task | Tier | Final Role | Status | Self-Heals | Rejects | Escalated | Duration |
| :--- | :--- | :--- | :--- | :---: | :---: | :---: | :---: |
"""
        self.assertEqual(generate_battle_report(self.store, self.run_id).encode(), expected.encode())

    def test_section_shows_latest_assignment_and_counts_distinct_pinned_tasks(self) -> None:
        for model in ("flash@low", "flash@high"):
            self.store.log_event(self.run_id, "task_allocated", task_id="T1", payload={
                "task_id": "T1", "provider": "worker", "model": model,
                "reason": "Pinned assignment", "budget_profile": "eco", "pinned": True,
            })

        report = generate_battle_report(self.store, self.run_id)

        self.assertIn("## Smart Allocation Summary\n", report)
        self.assertIn("Budget profile `eco`", report)
        self.assertIn("Pinned tasks `1`", report)
        self.assertIn("| `T1` | `worker` | `flash@high` | Pinned assignment |", report)
        self.assertNotIn("flash@low", report)

    def test_step_up_alone_is_enough_to_show_the_section(self) -> None:
        self.store.log_event(self.run_id, "task_step_up", task_id="T1", payload={
            "task_id": "T1", "from": "worker:flash@high", "to": "worker:flash@max", "attempt": 3,
        })

        report = generate_battle_report(self.store, self.run_id)

        self.assertIn("## Smart Allocation Summary\n", report)
        self.assertIn("`T1` attempt 3", report)
        self.assertIn("`worker:flash@high` → `worker:flash@max`", report)


if __name__ == "__main__":
    unittest.main()
