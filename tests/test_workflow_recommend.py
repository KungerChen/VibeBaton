"""Golden examples for deterministic recommendations and panel preflight.

Implementation record 20261126-084728-m2-t3-workflow-recommendation
2026-11-26 08:47 America/Los_Angeles. Scope: the two M2-T3 whitelisted files.
Added the pure recommendation, local readiness snapshot and launch preflight;
panel member fallbacks are not counted as ready primaries because the existing
engine only walks them for specific failures. Unknown previous sizes remain
unknown. Required suite: 61 tests passed; guided-session and CLI-registry suite:
56 tests passed. Panel end-to-end tests emitted subprocess ResourceWarnings but
passed. The new preflight is not yet wired to the launch endpoint or checked
against a live provider; integration must call it before creating a run. Status:
self-tested, awaiting user acceptance. Branch baton/e33e97/m2-t3; baseline
bfd0fb16d82d8c906c01ddd8f60867a68665b357. No commit was created; that revision
is the recovery reference, and the new test file is untracked. The whitelist
excludes the project log and index, so this record is retained here.
"""

from __future__ import annotations

import json
import tempfile
import unittest
from copy import deepcopy
from dataclasses import asdict, replace
from pathlib import Path
from unittest.mock import patch

from vibebaton import cli_registry
from vibebaton.config import parse_config_dict
from vibebaton.workflow_recommend import (
    LaunchSelectionError,
    ProviderReadiness,
    ReadinessSnapshot,
    build_readiness_snapshot,
    recommend_workflow,
    validate_launch_selection,
)


def example_config():
    """A complete ready-host example using unchanged baton.toml provider IDs."""
    return parse_config_dict({
        "providers": {
            "agy_sub": {"command": ["agy"]},
            "gemini_sub": {"command": ["gemini"]},
            "claude_sub": {"command": ["claude"]},
            "codex_sub": {"command": ["codex"]},
            "dsh_opencode": {"command": ["dsh"]},
            "gemini_http": {"type": "http", "base_url": "https://example.test/v1", "api_key_env": "GEMINI_API_KEY"},
        },
        "roles": {
            "brainstorm_and_final_gate": {"provider": "agy_sub", "model": "gemini-4-carbon@medium"},
            "tactical_planner": {
                "provider": "claude_sub", "model": "opus@high",
                "fallback": [{"provider": "codex_sub", "model": "gpt-6.2-sol@max"}],
            },
            "micro_orchestrator": {"provider": "codex_sub", "model": "gpt-6.2-sol@max"},
            "bulk_worker": {"provider": "dsh_opencode", "model": "deepseek-v4.1-flash@max"},
            "visual": {"provider": "gemini_http", "model": "gemini-4-neon-high"},
            "research": {"provider": "gemini_sub", "model": "gemini-2.5-pro"},
        },
        "panel": {
            "enabled": True,
            "synthesizer_provider": "gemini_http",
            "synthesizer_model": "gemini-4-neon-high",
            "members": [
                {"id": "ux", "perspective": "UX", "provider": "claude_sub", "model": "opus@high"},
                {"id": "code", "perspective": "Code", "provider": "codex_sub", "model": "gpt-6.2-sol@max"},
            ],
        },
    })


def example_scan(ready: tuple[str, ...], *, http_key: bool = False):
    entries = []
    for driver in cli_registry.load_cli_registry()["drivers"]:
        status = "ready" if driver["id"] in ready else "missing"
        entries.append({
            "id": driver["id"], "status": status,
            "binary_path": f"C:/fake/{driver['binary']}.cmd" if status == "ready" else None,
            "version": "1" if status == "ready" else None,
            "prereq_missing": [], "reason_en": "", "reason_zh": "",
        })
    return {"drivers": entries, "http_api_keys_present": ["GEMINI_API_KEY"] if http_key else [], "scanned_at": 123.0}


class WorkflowRecommendationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.cfg = example_config()
        self.scan = example_scan(("agy", "gemini", "claude", "codex", "dsh"), http_key=True)
        self.snapshot = build_readiness_snapshot(Path("."), self.cfg, scan_result=self.scan)

    def test_golden_example_selects_size_policy_and_real_eco_model(self) -> None:
        # 20261126 workflow tiers: small is a lean tiered team (not one eco model for every role),
        # and preset is always None because presets never changed a Guided run.
        small = recommend_workflow("small", self.snapshot)
        self.assertEqual((small.size, small.mode, small.preset, small.reason_code),
                         ("small", "overnight", None, "small_eco"))
        self.assertFalse(small.fallback)
        self.assertEqual(small.lineup["model_overrides"]["bulk_worker"], "dsh_opencode:deepseek-v4.1-flash@medium")
        self.assertEqual(small.lineup["model_overrides"]["brainstorm_and_final_gate"], "agy_sub:gemini-4-carbon@medium")
        self.assertEqual(small.lineup["size"], "small")

        medium = recommend_workflow("medium", self.snapshot)
        self.assertEqual((medium.mode, medium.preset, medium.reason_code),
                         ("overnight", None, "medium_relay"))
        self.assertEqual(medium.lineup["roles"]["tactical_planner"], "claude_sub")
        self.assertEqual(medium.lineup["roles"]["bulk_worker"], "dsh_opencode")
        large = recommend_workflow("large", self.snapshot)
        self.assertEqual((large.mode, large.preset, large.reason_code),
                         ("panel", None, "large_panel"))
        validate_launch_selection(large.mode, self.snapshot, lineup=large.lineup)

    def test_missing_synthesizer_key_falls_back_and_launch_rejects(self) -> None:
        snapshot = build_readiness_snapshot(Path("."), self.cfg, scan_result=example_scan(("claude",), http_key=False))
        result = recommend_workflow("large", snapshot)
        self.assertEqual((result.mode, result.preset, result.fallback), ("overnight", None, True))
        # reason_code is the arrangement; the panel blocker is a note right after it.
        self.assertEqual(result.reason_code, "large_relay")
        self.assertEqual(result.explanation_codes[2], "synthesizer_credentials_missing")
        self.assertTrue(all(provider == "claude_sub" for provider in result.lineup["roles"].values()))
        with self.assertRaises(LaunchSelectionError) as caught:
            validate_launch_selection("panel", snapshot)
        self.assertIn("synthesizer_credentials_missing", caught.exception.codes)
        self.assertIn("gemini_http", str(caught.exception))

    def test_one_ready_panelist_is_enough_to_launch_but_not_to_recommend(self) -> None:
        # The engine skips a failed specialist, so launch preflight still accepts one ready
        # panelist; the recommendation only proposes the panel when every panelist is ready.
        snapshot = build_readiness_snapshot(Path("."), self.cfg, scan_result=example_scan(("claude",), http_key=True))
        result = recommend_workflow("large", snapshot)
        self.assertEqual(result.mode, "overnight")
        self.assertIn("panelist_not_ready", result.explanation_codes)
        self.assertEqual(result.missing_panelists, ("codex_sub",))
        ready = {provider.provider_id for provider in snapshot.providers if provider.provider_ready and provider.credential_ready}
        self.assertLessEqual(set(result.lineup["roles"].values()), ready)
        validate_launch_selection("panel", snapshot, lineup=result.lineup)

    def test_missing_panelists_and_synthesizer_are_both_explained(self) -> None:
        snapshot = build_readiness_snapshot(Path("."), self.cfg, scan_result=example_scan(("dsh",), http_key=False))
        result = recommend_workflow("large", snapshot)
        self.assertEqual(result.mode, "overnight")
        self.assertIn("synthesizer_credentials_missing", result.explanation_codes)
        self.assertIn("panelist_unavailable", result.explanation_codes)
        with self.assertRaises(LaunchSelectionError) as caught:
            validate_launch_selection("panel", snapshot)
        self.assertEqual(caught.exception.codes, ("synthesizer_credentials_missing", "panelist_unavailable"))

    def test_unknown_or_missing_size_uses_medium_policy(self) -> None:
        for size in (None, "", "huge", "MEDIUM"):
            with self.subTest(size=size):
                result = recommend_workflow(size, self.snapshot)
                self.assertEqual((result.size, result.mode, result.preset), ("medium", "overnight", None))
                # Only direct callers can omit the size; Guided always passes a model or estimated size.
                self.assertEqual(result.explanation_codes, ("size_defaulted_to_medium", "medium_relay"))
                self.assertFalse(result.fallback)

    def test_recommendation_is_pure_deterministic_and_never_mutates_its_inputs(self) -> None:
        original = deepcopy(self.snapshot)
        previous = deepcopy(recommend_workflow("small", self.snapshot).lineup)
        previous_original = deepcopy(previous)
        expected = asdict(recommend_workflow("medium", self.snapshot, previous_lineup=previous))
        with patch("vibebaton.cli_registry.scan_host_clis", side_effect=AssertionError("scan")), \
             patch("vibebaton.presets.list_presets", side_effect=AssertionError("preset read")):
            for _ in range(5):
                self.assertEqual(asdict(recommend_workflow("medium", self.snapshot, previous_lineup=previous)), expected)
        self.assertEqual(self.snapshot, original)
        self.assertEqual(previous, previous_original)

    def test_previous_lineup_is_preserved_and_size_comparison_is_explicit(self) -> None:
        # Only a team the user changed by hand ("customized") is kept in full; an untouched one
        # is the base for medium/large and is replaced by the lean team for small.
        previous = deepcopy(recommend_workflow("small", self.snapshot).lineup)
        previous["future_metadata"] = {"keep": [1, 2]}
        previous["customized"] = True
        result = recommend_workflow("large", self.snapshot, previous_lineup=previous)
        self.assertEqual(result.lineup, previous)
        self.assertIsNot(result.lineup, previous)
        self.assertTrue(result.size_changed)
        self.assertTrue(asdict(result)["size_changed"])
        self.assertEqual(result.reason_code, "custom_lineup_kept")
        self.assertFalse(recommend_workflow("small", self.snapshot, previous_lineup=previous).size_changed)
        legacy = {"roles": dict(previous["roles"]), "model_overrides": dict(previous["model_overrides"])}
        legacy_result = recommend_workflow("large", self.snapshot, previous_lineup=legacy)
        self.assertIsNone(legacy_result.size_changed)
        self.assertEqual(legacy_result.lineup, {**legacy, "size": "large"})
        # For the following iteration, retain the assignments and associate the
        # immediately preceding recommendation's size with the supplied lineup.
        next_previous = deepcopy(result.lineup)
        next_previous["size"] = result.size
        self.assertFalse(recommend_workflow("large", self.snapshot, previous_lineup=next_previous).size_changed)
        self.assertTrue(recommend_workflow("medium", self.snapshot, previous_lineup=next_previous).size_changed)

    def test_unready_or_inconsistent_previous_lineup_is_replaced(self) -> None:
        previous = deepcopy(recommend_workflow("small", self.snapshot).lineup)
        degraded = build_readiness_snapshot(Path("."), self.cfg, scan_result=example_scan(("claude",), http_key=False))
        result = recommend_workflow("medium", degraded, previous_lineup=previous)
        self.assertTrue(result.size_changed)
        self.assertNotEqual(result.lineup["roles"], previous["roles"])
        self.assertEqual(set(result.lineup["roles"].values()), {"claude_sub"})
        inconsistent = deepcopy(self.snapshot.default_lineup)
        inconsistent["model_overrides"]["tactical_planner"] = "dsh_opencode:flash"
        result = recommend_workflow("medium", self.snapshot, previous_lineup=inconsistent)
        self.assertNotEqual(result.lineup, inconsistent)
        self.assertNotIn("custom_lineup_kept", result.explanation_codes)

    def test_panel_revalidated_even_when_previous_lineup_is_preserved(self) -> None:
        snapshot = replace(self.snapshot, synthesizer_provider="gemini_http", providers=tuple(
            replace(provider, credential_ready=False) if provider.provider_id == "gemini_http" else provider
            for provider in self.snapshot.providers
        ))
        prior = {"roles": {name: "claude_sub" for name in self.cfg.roles}, "model_overrides": {}, "size": "medium",
                 "customized": True}
        result = recommend_workflow("large", snapshot, previous_lineup=prior)
        self.assertEqual(result.lineup, prior)
        self.assertTrue(result.size_changed)
        self.assertEqual(result.mode, "overnight")
        self.assertEqual(result.explanation_codes[1:], ("custom_lineup_kept", "synthesizer_credentials_missing"))

    def test_no_ready_provider_or_model_never_produces_a_lineup(self) -> None:
        empty = build_readiness_snapshot(Path("."), self.cfg, scan_result=example_scan(()))
        result = recommend_workflow("medium", empty)
        self.assertIsNone(result.lineup)
        self.assertTrue(result.fallback)
        self.assertEqual(result.explanation_codes[-1], "no_ready_provider")
        cfg = parse_config_dict({"providers": {"gemini_http": {"type": "http", "api_key_env": "GEMINI_API_KEY"}},
                                 "roles": {"bulk_worker": {"provider": "not_configured", "model": "other"}}})
        snapshot = build_readiness_snapshot(Path("."), cfg, scan_result=example_scan((), http_key=True))
        # The config has no model for gemini_http, but the setup step's catalog pick supplies an
        # explicit one, so a ready team exists.
        self.assertEqual(recommend_workflow("medium", snapshot).lineup["roles"], {"bulk_worker": "gemini_http"})
        self.assertNotIn("no_ready_provider", recommend_workflow("medium", snapshot).explanation_codes)
        previous = {"roles": {"bulk_worker": "gemini_http"}, "model_overrides": {}, "size": "small"}
        # A previous team without a resolvable model is not reused; the catalog team replaces it.
        self.assertEqual(recommend_workflow("medium", snapshot, previous_lineup=previous).lineup["model_overrides"],
                         {"bulk_worker": "gemini_http:gemini-4-hydrogen@max"})
        with self.assertRaises(LaunchSelectionError) as caught:
            validate_launch_selection("overnight", snapshot, lineup=previous)
        self.assertEqual(caught.exception.codes, ("lineup_unavailable",))
        # An explicit model for that ready provider remains a valid user choice.
        previous["model_overrides"]["bulk_worker"] = "gemini_http:gemini-explicit"
        self.assertEqual(recommend_workflow("medium", snapshot, previous_lineup=previous).lineup,
                         {**previous, "size": "medium"})

    def test_missing_lean_team_is_reported(self) -> None:
        # With only Claude ready the lean team uses Claude's value model; the note appears only
        # when no lean team can be built at all.
        snapshot = build_readiness_snapshot(Path("."), self.cfg, scan_result=example_scan(("claude",)))
        result = recommend_workflow("small", snapshot)
        self.assertEqual(result.lineup["model_overrides"]["bulk_worker"], "claude_sub:claude-haiku-5-5@medium")
        self.assertEqual(result.explanation_codes, ("size_from_model", "small_eco"))
        result = recommend_workflow("small", replace(snapshot, eco_lineup=None))
        self.assertEqual(result.explanation_codes, ("size_from_model", "small_eco", "eco_model_unavailable"))
        self.assertTrue(result.fallback)


class SnapshotAndLaunchTests(unittest.TestCase):
    def test_all_shipped_provider_ids_and_dsh_local_profile_are_recognised(self) -> None:
        cfg = example_config()
        scan = example_scan(("agy", "gemini", "claude", "codex", "dsh"), http_key=True)
        snapshot = build_readiness_snapshot(Path("."), cfg, scan_result=scan)
        self.assertEqual([p.provider_id for p in snapshot.providers], list(cfg.providers))
        self.assertTrue(all(p.provider_ready and p.credential_ready for p in snapshot.providers))
        self.assertEqual(snapshot.synthesizer_provider, "gemini_http")
        self.assertEqual(snapshot.panelist_providers, ("claude_sub", "codex_sub"))
        self.assertNotIn("scanned_at", repr(snapshot))

    def test_ready_driver_must_match_configured_binary_and_cli_auth_status(self) -> None:
        cfg = example_config()
        cfg.providers["dsh_opencode"].command = ["dsh"]
        scan = example_scan(("opencode", "codex"))
        codex = next(entry for entry in scan["drivers"] if entry["id"] == "codex")
        codex["status"] = "installed_unauthenticated"
        snapshot = build_readiness_snapshot(Path("."), cfg, scan_result=scan)
        by_name = {p.provider_id: p for p in snapshot.providers}
        self.assertFalse(by_name["dsh_opencode"].provider_ready)
        self.assertTrue(by_name["codex_sub"].provider_ready)
        self.assertFalse(by_name["codex_sub"].credential_ready)
        self.assertIsNone(recommend_workflow("medium", snapshot).lineup)

    def test_host_native_configured_role_is_remapped_to_a_real_ready_provider(self) -> None:
        cfg = example_config()
        cfg.roles["brainstorm_and_final_gate"].provider = "host_native"
        snapshot = build_readiness_snapshot(Path("."), cfg, scan_result=example_scan(("dsh",)))
        result = recommend_workflow("medium", snapshot)
        self.assertEqual(set(result.lineup["roles"].values()), {"dsh_opencode"})
        # The setup step's tiered pick for the only ready provider (L0 keeps medium effort).
        self.assertEqual(result.lineup["model_overrides"]["brainstorm_and_final_gate"],
                         "dsh_opencode:deepseek-v4.1-flash@medium")

    def test_live_scanner_reads_credentials_without_exposing_values(self) -> None:
        cfg = example_config()
        with tempfile.TemporaryDirectory() as directory:
            credentials_path = Path(directory) / "credentials.json"
            credentials_path.write_text(json.dumps({"GEMINI_API_KEY": "private-example-value"}), encoding="utf-8")
            with patch.dict("os.environ", {}, clear=True), \
                 patch("vibebaton.cli_registry.resolve_cli_binary", side_effect=lambda binary: f"C:/fake/{binary}.cmd"), \
                 patch("vibebaton.cli_registry._probe", return_value=(0, "ok")):
                snapshot = build_readiness_snapshot(Path(directory), cfg, credentials_path)
        self.assertTrue(next(p for p in snapshot.providers if p.provider_id == "gemini_http").credential_ready)
        self.assertTrue(next(p for p in snapshot.providers if p.provider_id == "dsh_opencode").credential_ready)
        self.assertNotIn("private-example-value", repr(snapshot))
        self.assertEqual(recommend_workflow("large", snapshot).mode, "panel")

    def test_http_key_and_url_are_independent_preflight_flags(self) -> None:
        cfg = example_config()
        cfg.providers["gemini_http"].base_url = "https://example.test:bad/v1"
        snapshot = build_readiness_snapshot(Path("."), cfg, scan_result=example_scan(("claude",), http_key=True))
        http = next(p for p in snapshot.providers if p.provider_id == "gemini_http")
        self.assertFalse(http.provider_ready)
        self.assertTrue(http.credential_ready)
        self.assertIn("synthesizer_provider_unavailable", recommend_workflow("large", snapshot).explanation_codes)
        with self.assertRaises(LaunchSelectionError):
            validate_launch_selection("panel", snapshot)

    def test_effective_default_panel_and_unready_primary_member_are_checked(self) -> None:
        cfg = example_config()
        cfg.panel.members.clear()
        snapshot = build_readiness_snapshot(Path("."), cfg, scan_result=example_scan(("claude", "dsh")))
        self.assertTrue(snapshot.panelist_providers)
        self.assertEqual(snapshot.synthesizer_provider, "dsh_opencode")
        # The default panel also lists unready providers, so it is not recommended, yet launching
        # it is allowed because the engine skips the specialists that fail.
        self.assertEqual(recommend_workflow("large", snapshot).mode, "overnight")
        validate_launch_selection("panel", snapshot)

        cfg = example_config()
        member = cfg.panel.members[0]
        from vibebaton.config import FallbackTarget
        member.fallback.append(FallbackTarget("dsh_opencode", "deepseek-v4.1-flash@max"))
        snapshot = build_readiness_snapshot(Path("."), cfg, scan_result=example_scan(("dsh",), http_key=True))
        # The engine only walks this fallback for specific results, so it cannot
        # make an unready primary panelist a reliable preflight success.
        self.assertNotIn("dsh_opencode", snapshot.panelist_providers)
        self.assertIn("panelist_unavailable", recommend_workflow("large", snapshot).explanation_codes)
        with self.assertRaises(LaunchSelectionError) as caught:
            validate_launch_selection("panel", snapshot)
        self.assertEqual(caught.exception.codes, ("panelist_unavailable",))

    def test_launch_rejects_stale_unready_lineup_and_bad_mode(self) -> None:
        snapshot = ReadinessSnapshot(
            providers=(ProviderReadiness("claude_sub", "cli", True, True),),
            panelist_providers=("claude_sub",), synthesizer_provider="claude_sub",
        )
        bad = {"roles": {"bulk_worker": "claude_sub"}, "model_overrides": {"bulk_worker": "codex_sub:model"}}
        with self.assertRaises(LaunchSelectionError) as caught:
            validate_launch_selection("panel", snapshot, lineup=bad)
        self.assertEqual(caught.exception.codes, ("lineup_unavailable",))
        with self.assertRaises(LaunchSelectionError) as caught:
            validate_launch_selection("other", snapshot)
        self.assertEqual(caught.exception.codes, ("invalid_mode",))
        malformed = {"roles": {"bulk_worker": []}, "model_overrides": {}}
        with self.assertRaises(LaunchSelectionError) as caught:
            validate_launch_selection("panel", snapshot, lineup=malformed)
        self.assertEqual(caught.exception.codes, ("lineup_unavailable",))


if __name__ == "__main__":
    unittest.main()
