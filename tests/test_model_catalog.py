"""Unit tests for full model catalog, L0-L3 ranked recommendations, and 24h daily sync."""

from __future__ import annotations

import json
import os
import subprocess
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

from vibebaton import model_catalog


class ModelCatalogTests(unittest.TestCase):
    def test_tiered_recommendations_on_full_host(self) -> None:
        all_providers = ["agy_sub", "gemini_sub", "claude_sub", "codex_sub", "dsh_opencode"]
        self.assertEqual(
            model_catalog.recommend_role_assignment("brainstorm_and_final_gate", all_providers),
            {"provider": "agy_sub", "model": "gemini-4-carbon", "effort": "medium"},
        )
        self.assertEqual(
            model_catalog.recommend_role_assignment("brainstorm_and_final_gate", ["gemini_sub", "claude_sub", "codex_sub"]),
            {"provider": "gemini_sub", "model": "gemini-4-carbon", "effort": "medium"},
        )
        self.assertEqual(
            model_catalog.recommend_role_assignment("tactical_planner", all_providers),
            {"provider": "claude_sub", "model": "claude-opus-5-5", "effort": "medium"},
        )
        self.assertEqual(
            model_catalog.recommend_role_assignment("critical_executor", all_providers),
            {"provider": "codex_sub", "model": "gpt-6.2-sol", "effort": "max"},
        )
        self.assertEqual(
            model_catalog.recommend_role_assignment("bulk_worker", all_providers),
            {"provider": "dsh_opencode", "model": "deepseek-v4.1-flash", "effort": "max"},
        )

    def test_tiered_fallback_ranks_when_primary_absent(self) -> None:
        # L0: Gemini absent -> Fable 5.2 (Claude), Gemini & Claude absent -> GPT-6.2 Astra XHigh
        self.assertEqual(
            model_catalog.recommend_role_assignment("brainstorm_and_final_gate", ["claude_sub", "codex_sub"]),
            {"provider": "claude_sub", "model": "claude-fable-5-2", "effort": "medium"},
        )
        self.assertEqual(
            model_catalog.recommend_role_assignment("brainstorm_and_final_gate", ["codex_sub"]),
            {"provider": "codex_sub", "model": "gpt-6.2-astra", "effort": "xhigh"},
        )
        # L1: Claude absent -> Gemini 4N Medium
        self.assertEqual(
            model_catalog.recommend_role_assignment("tactical_planner", ["gemini_sub", "codex_sub"]),
            {"provider": "gemini_sub", "model": "gemini-4-neon", "effort": "medium"},
        )
        # L2: Codex absent -> Sonnet 5.5 Max, Codex & Claude absent -> Gemini 4H Max
        self.assertEqual(
            model_catalog.recommend_role_assignment("critical_executor", ["claude_sub", "gemini_sub"]),
            {"provider": "claude_sub", "model": "claude-sonnet-5-5", "effort": "max"},
        )
        self.assertEqual(
            model_catalog.recommend_role_assignment("critical_executor", ["gemini_sub"]),
            {"provider": "gemini_sub", "model": "gemini-4-hydrogen", "effort": "max"},
        )
        # L3: DSH absent -> Haiku 5.5 Max -> GPT-6.1 Terra Max
        self.assertEqual(
            model_catalog.recommend_role_assignment("bulk_worker", ["claude_sub", "codex_sub"]),
            {"provider": "claude_sub", "model": "claude-haiku-5-5", "effort": "max"},
        )
        self.assertEqual(
            model_catalog.recommend_role_assignment("bulk_worker", ["codex_sub"]),
            {"provider": "codex_sub", "model": "gpt-6.1-terra", "effort": "max"},
        )

    def test_sync_merges_remote_models_while_preserving_all_bundled_legacy_models(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            cache_path = Path(tmp) / "model_catalog_cache.json"
            clock = [1_795_564_800.0]  # 2026-11-25; the feed retirement date below is in the past

            def fake_fetch(_url: str, _timeout: float) -> dict[str, object]:
                return {
                    "gpt-6.3-nova": {"litellm_provider": "openai", "mode": "chat"},
                    "text-embedding-3-large": {"litellm_provider": "openai", "mode": "embedding"},
                    "deprecated-gpt-3": {"litellm_provider": "openai", "deprecation_date": "2025-01-01"},
                }

            with patch.dict(os.environ, {}, clear=False):
                os.environ.pop("VIBEBATON_DISABLE_MODEL_SYNC", None)
                first = model_catalog.sync_model_catalog(
                    cache_path=cache_path, fetcher=fake_fetch, now_fn=lambda: clock[0],
                )
                self.assertTrue(first["ok"])
                self.assertTrue(first["fetched"])
                self.assertEqual(first["added_count"], 1)
                ids = {m["id"] for m in first["catalog"]["models"]}
                # Bundled latest + legacy models are all preserved alongside synced models.
                self.assertIn("gpt-6.3-nova", ids)
                self.assertIn("gemini-4-carbon", ids)
                self.assertIn("claude-opus-4-6", ids)
                # The feed carries OpenAI rows but no gpt-4o row at all, so the bundled entry is treated as gone.
                self.assertNotIn("gpt-4o", ids)
                self.assertIn("deepseek-chat", ids)
                self.assertNotIn("text-embedding-3-large", ids)
                self.assertNotIn("deprecated-gpt-3", ids)

                # Within 24 hours, non-forced sync skips remote fetch.
                clock[0] += 3600.0
                fresh = model_catalog.sync_model_catalog(
                    cache_path=cache_path, fetcher=fake_fetch, now_fn=lambda: clock[0],
                )
                self.assertFalse(fresh["fetched"])
                self.assertTrue(fresh["skipped_fresh"])

                # Past 24 hours (or force=True), refreshes again.
                clock[0] += model_catalog.DAILY_SYNC_INTERVAL_SEC + 1.0
                daily = model_catalog.sync_model_catalog(
                    cache_path=cache_path, fetcher=fake_fetch, now_fn=lambda: clock[0],
                )
                self.assertTrue(daily["fetched"])
                self.assertFalse(daily["skipped_fresh"])


DAY = 86_400.0
# 2026-11-25T00:00:00Z
NOW_2026_11_25 = 1_795_564_800.0


def _sync(cache_path: Path, feed: dict[str, object], now: float = NOW_2026_11_25, **kwargs: object) -> dict[str, object]:
    with patch.dict(os.environ, {}, clear=False):
        os.environ.pop("VIBEBATON_DISABLE_MODEL_SYNC", None)
        return model_catalog.sync_model_catalog(
            cache_path=cache_path, fetcher=lambda _u, _t: feed, now_fn=lambda: now, **kwargs,
        )


class BundledIdTests(unittest.TestCase):
    def test_bundled_claude_ids_are_real_cli_model_ids(self) -> None:
        # `claude --model opus-5.5` is rejected as unrecognized; full IDs such as claude-opus-5-5 work.
        claude_ids = [m["id"] for m in model_catalog.BUNDLED_MODELS if m["family"] == "claude"]
        self.assertTrue(all(model_id.startswith("claude-") for model_id in claude_ids), claude_ids)
        ids = {m["id"] for m in model_catalog.BUNDLED_MODELS}
        for recs in model_catalog.TIER_RECOMMENDATIONS.values():
            for rec in recs:
                self.assertIn(rec["model"], ids)

    def test_codex_subscription_only_lists_models_codex_offers(self) -> None:
        # Codex's own picker (~/.codex/models_cache.json) lists the gpt-6.x / gpt-5.6 line only.
        codex = [m["id"] for m in model_catalog.BUNDLED_MODELS if "codex_sub" in m["providers"]]
        self.assertEqual(codex, ["gpt-6.2-astra", "gpt-6.2-sol", "gpt-6.1-terra", "gpt-6-luna"])
        api_only = {m["id"] for m in model_catalog.BUNDLED_MODELS if m["providers"] == ["openai_http"]}
        self.assertEqual(api_only, {"gpt-5-codex", "gpt-5", "gpt-5-mini", "gpt-4.1", "gpt-4o", "o3", "o4-mini"})

    def test_synced_feed_does_not_duplicate_bundled_claude_models(self) -> None:
        feed = {"claude-opus-5-5": {"litellm_provider": "anthropic", "mode": "chat"},
                "claude-opus-6": {"litellm_provider": "anthropic", "mode": "chat"}}
        with tempfile.TemporaryDirectory() as tmp:
            models = _sync(Path(tmp) / "c.json", feed)["catalog"]["models"]
        self.assertEqual([m["id"] for m in models].count("claude-opus-5-5"), 1)
        self.assertEqual(next(m for m in models if m["id"] == "claude-opus-5-5")["status"], "latest")


class RetirementTests(unittest.TestCase):
    def test_future_deprecation_date_is_kept_and_past_is_dropped(self) -> None:
        feed = {
            "gpt-7.1-future": {"litellm_provider": "openai", "mode": "chat", "deprecation_date": "2027-03-01"},
            "gpt-7.0-past": {"litellm_provider": "openai", "mode": "chat", "deprecation_date": "2026-01-01"},
            "gpt-7.2-today": {"litellm_provider": "openai", "mode": "chat", "deprecation_date": "2026-11-25"},
            "gpt-7.3-garbled": {"litellm_provider": "openai", "mode": "chat", "deprecation_date": "soon"},
        }
        with tempfile.TemporaryDirectory() as tmp:
            result = _sync(Path(tmp) / "c.json", feed)
        ids = {m["id"] for m in result["catalog"]["models"]}
        self.assertIn("gpt-7.1-future", ids)
        self.assertIn("gpt-7.3-garbled", ids)
        self.assertNotIn("gpt-7.0-past", ids)
        self.assertNotIn("gpt-7.2-today", ids)

    def test_bundled_model_retired_by_feed_disappears(self) -> None:
        feed = {
            "gpt-4o": {"litellm_provider": "openai", "mode": "chat", "deprecation_date": "2026-01-14"},
            "gpt-4.1": {"litellm_provider": "openai", "mode": "chat", "deprecation_date": "2027-01-14"},
            "gpt-7.1": {"litellm_provider": "openai", "mode": "chat"},
        }
        with tempfile.TemporaryDirectory() as tmp:
            cache_path = Path(tmp) / "c.json"
            result = _sync(cache_path, feed)
            ids = {m["id"] for m in result["catalog"]["models"]}
            self.assertNotIn("gpt-4o", ids)
            self.assertIn("gpt-4.1", ids)
            # The retired list is persisted, so later reads still hide it.
            reread = model_catalog.get_model_catalog(cache_path=cache_path, now_fn=lambda: NOW_2026_11_25)
            self.assertNotIn("gpt-4o", {m["id"] for m in reread["models"]})

    def test_gemini_api_row_wins_over_vertex_row(self) -> None:
        # Vertex retired the top-level row, but the Gemini API (gemini/ prefix) still serves it.
        feed = {
            "gemini-2.5-pro": {"litellm_provider": "vertex_ai-language-models", "mode": "chat", "deprecation_date": "2026-10-20"},
            "gemini/gemini-2.5-pro": {"litellm_provider": "gemini", "mode": "chat", "deprecation_date": "2026-12-01"},
            "gemini/gemini-4-argon": {"litellm_provider": "gemini", "mode": "chat"},
            "gemini/gemini-2.5-flash": {"litellm_provider": "gemini", "mode": "chat", "deprecation_date": "2026-11-01"},
        }
        with tempfile.TemporaryDirectory() as tmp:
            result = _sync(Path(tmp) / "c.json", feed)
        ids = {m["id"] for m in result["catalog"]["models"]}
        self.assertIn("gemini-2.5-pro", ids)
        self.assertIn("gemini-4-argon", ids)
        self.assertNotIn("gemini-2.5-flash", ids)

    def test_old_cache_without_retired_ids_is_still_readable(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            cache_path = Path(tmp) / "c.json"
            cache_path.write_text(json.dumps({
                "fetched_at": NOW_2026_11_25,
                "models": [{"id": "gpt-7.1", "label": "gpt-7.1", "family": "openai", "providers": ["codex_sub"], "rank": 50}],
            }), encoding="utf-8")
            catalog = model_catalog.get_model_catalog(cache_path=cache_path, now_fn=lambda: NOW_2026_11_25)
        ids = {m["id"] for m in catalog["models"]}
        self.assertIn("gpt-7.1", ids)
        self.assertIn("gpt-4o", ids)
        # Written by the old, unfiltered sync: re-fetch once even though it is under 24h old.
        self.assertTrue(catalog["cache"]["stale"])


class NoiseAndLabelTests(unittest.TestCase):
    FEED = {
        "gpt-7.1": {"litellm_provider": "openai", "mode": "chat"},
        "gpt-7.1-2026-09-01": {"litellm_provider": "openai", "mode": "chat"},
        "gpt-7.0-mini": {"litellm_provider": "openai", "mode": "chat"},
        "gpt-7.3-2026-10-01": {"litellm_provider": "openai", "mode": "chat"},
        "gpt-sol-latest": {"litellm_provider": "openai", "mode": "chat"},
        "chat-latest": {"litellm_provider": "openai", "mode": "chat"},
        "gpt-7.1-healthcare": {"litellm_provider": "openai", "mode": "chat"},
        "gpt-7.1-astra-law": {"litellm_provider": "openai", "mode": "chat"},
        "gpt-7-cyber": {"litellm_provider": "openai", "mode": "chat"},
        "gpt-4o-search-preview": {"litellm_provider": "openai", "mode": "chat"},
        "claude-opus-6-1": {"litellm_provider": "anthropic", "mode": "chat"},
        "claude-opus-6-1-20261001": {"litellm_provider": "anthropic", "mode": "chat"},
        "claude-sonnet-6": {"litellm_provider": "anthropic", "mode": "chat"},
        "claude-opus-latest": {"litellm_provider": "anthropic", "mode": "chat"},
        "gemini/gemini-5-pro-preview": {"litellm_provider": "gemini", "mode": "chat"},
        "gemini/gemini-5-pro-preview-customtools": {"litellm_provider": "gemini", "mode": "chat"},
        "gemini/gemini-robotics-er-2-preview": {"litellm_provider": "gemini", "mode": "chat"},
        "gemini/gemini-5-computer-use-preview": {"litellm_provider": "gemini", "mode": "chat"},
        "gemini/gemini-exp-1206": {"litellm_provider": "gemini", "mode": "chat"},
        "gemini/gemini-flash-latest": {"litellm_provider": "gemini", "mode": "chat"},
        "deepseek-v5-flash": {"litellm_provider": "deepseek", "mode": "chat"},
        "deepseek-v5-flash-vision-exp": {"litellm_provider": "deepseek", "mode": "chat"},
        "o5-mini": {"litellm_provider": "openai", "mode": "chat"},
        "ft:gpt-4o-2024-08-06": {"litellm_provider": "openai", "mode": "chat"},
        "gemini/gemma-4-31b-it": {"litellm_provider": "gemini", "mode": "chat"},
        "gemini/gemini-gemma-2-9b-it": {"litellm_provider": "gemini", "mode": "chat"},
        "gemini/lyria-3.5": {"litellm_provider": "gemini", "mode": "chat"},
    }

    def _synced(self) -> dict[str, dict[str, object]]:
        with tempfile.TemporaryDirectory() as tmp:
            result = _sync(Path(tmp) / "c.json", self.FEED)
        return {m["id"]: m for m in result["catalog"]["models"] if m["status"] == "synced"}

    def test_aliases_snapshots_and_vertical_variants_are_filtered(self) -> None:
        self.assertEqual(
            set(self._synced()),
            {"gpt-7.1", "gpt-7.0-mini", "gpt-7.3-2026-10-01", "claude-opus-6-1", "claude-sonnet-6",
             "gemini-5-pro-preview", "deepseek-v5-flash", "o5-mini"},
        )

    def test_labels_are_readable(self) -> None:
        labels = {model_id: m["label"] for model_id, m in self._synced().items()}
        self.assertEqual(labels["gpt-7.1"], "GPT-7.1")
        self.assertEqual(labels["gpt-7.0-mini"], "GPT-7.0 Mini")
        self.assertEqual(labels["claude-opus-6-1"], "Claude Opus 6.1")
        self.assertEqual(labels["claude-sonnet-6"], "Claude Sonnet 6")
        self.assertEqual(labels["gemini-5-pro-preview"], "Gemini 5 Pro Preview")
        self.assertEqual(labels["deepseek-v5-flash"], "DeepSeek V5 Flash")
        self.assertEqual(labels["o5-mini"], "o5-mini")

    def test_cost_tier_uses_whole_name_tokens(self) -> None:
        synced = self._synced()
        # "gemini" contains "mini" but is not an eco model.
        self.assertEqual(synced["gemini-5-pro-preview"]["cost_tier"], "flagship")
        self.assertEqual(synced["gpt-7.0-mini"]["cost_tier"], "eco")
        self.assertEqual(synced["deepseek-v5-flash"]["cost_tier"], "eco")

    def test_ranks_follow_version_within_family_together_with_bundled(self) -> None:
        synced = self._synced()
        with tempfile.TemporaryDirectory() as tmp:
            feed = {**self.FEED, "claude-fable-5-2": {"litellm_provider": "anthropic", "mode": "chat"},
                    "gemini/gemini-4-carbon": {"litellm_provider": "gemini", "mode": "chat"}}
            models = {m["id"]: m for m in _sync(Path(tmp) / "c.json", feed)["catalog"]["models"]}
        # Newer synced versions rank ahead of older bundled ones instead of always trailing them.
        self.assertLess(models["claude-opus-6-1"]["rank"], models["claude-fable-5-2"]["rank"])
        self.assertLess(models["gemini-5-pro-preview"]["rank"], models["gemini-4-carbon"]["rank"])
        self.assertLess(synced["gpt-7.3-2026-10-01"]["rank"], synced["gpt-7.1"]["rank"])
        self.assertLess(synced["gpt-7.1"]["rank"], synced["gpt-7.0-mini"]["rank"])
        self.assertLess(synced["claude-opus-6-1"]["rank"], synced["claude-sonnet-6"]["rank"])
        self.assertEqual(len({m["rank"] for m in synced.values() if m["family"] == "openai"}), 4)

    def test_empty_parse_result_keeps_existing_cache(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            cache_path = Path(tmp) / "c.json"
            _sync(cache_path, {"gpt-7.1": {"litellm_provider": "openai", "mode": "chat"}})
            before = cache_path.read_text(encoding="utf-8")
            result = _sync(cache_path, {"text-embedding-9": {"litellm_provider": "openai", "mode": "embedding"}},
                           now=NOW_2026_11_25 + 2 * DAY)
            self.assertFalse(result["ok"])
            self.assertTrue(result["error"])
            self.assertIn("gpt-7.1", {m["id"] for m in result["catalog"]["models"]})
            self.assertEqual(json.loads(cache_path.read_text(encoding="utf-8"))["models"], json.loads(before)["models"])


class DailySyncTests(unittest.TestCase):
    FEED = {"gpt-7.1": {"litellm_provider": "openai", "mode": "chat"}}

    def test_default_fetch_timeout_is_twenty_seconds(self) -> None:
        seen: list[float] = []

        def fetch(_url: str, timeout: float) -> dict[str, object]:
            seen.append(timeout)
            return self.FEED

        with tempfile.TemporaryDirectory() as tmp, patch.dict(os.environ, {}, clear=False):
            os.environ.pop("VIBEBATON_DISABLE_MODEL_SYNC", None)
            model_catalog.sync_model_catalog(cache_path=Path(tmp) / "c.json", fetcher=fetch, now_fn=lambda: NOW_2026_11_25)
        self.assertEqual(seen, [20.0])

    def test_failure_is_reported_in_cache_and_cleared_on_success(self) -> None:
        def boom(_url: str, _timeout: float) -> dict[str, object]:
            raise OSError("network unreachable")

        with tempfile.TemporaryDirectory() as tmp:
            cache_path = Path(tmp) / "c.json"
            _sync(cache_path, self.FEED)
            with patch.dict(os.environ, {}, clear=False):
                os.environ.pop("VIBEBATON_DISABLE_MODEL_SYNC", None)
                failed = model_catalog.sync_model_catalog(
                    cache_path=cache_path, fetcher=boom, now_fn=lambda: NOW_2026_11_25 + 2 * DAY,
                )
            self.assertFalse(failed["ok"])
            self.assertIn("network unreachable", failed["catalog"]["cache"]["last_error"])
            self.assertIn("gpt-7.1", {m["id"] for m in failed["catalog"]["models"]})
            later = model_catalog.get_model_catalog(cache_path=cache_path, now_fn=lambda: NOW_2026_11_25 + 2 * DAY)
            self.assertIn("network unreachable", later["cache"]["last_error"])
            self.assertTrue(later["cache"]["stale"])

            recovered = _sync(cache_path, self.FEED, now=NOW_2026_11_25 + 3 * DAY)
            self.assertIsNone(recovered["catalog"]["cache"]["last_error"])

    def test_background_loop_checks_hourly_and_fetches_only_when_stale(self) -> None:
        fetches: list[float] = []
        checked = threading.Event()
        clock = [NOW_2026_11_25]

        def fetch(_url: str, _timeout: float) -> dict[str, object]:
            fetches.append(clock[0])
            return self.FEED

        def sleeper(stop: threading.Event, seconds: float) -> bool:
            self.assertEqual(seconds, model_catalog.HOURLY_CHECK_INTERVAL_SEC)
            clock[0] += seconds
            if clock[0] >= NOW_2026_11_25 + 30 * 3600:
                checked.set()
                return True
            return False

        with tempfile.TemporaryDirectory() as tmp, patch.dict(os.environ, {}, clear=False):
            os.environ.pop("VIBEBATON_DISABLE_MODEL_SYNC", None)
            stop = threading.Event()
            thread = model_catalog.start_daily_sync(
                cache_path=Path(tmp) / "c.json", stop_event=stop, fetcher=fetch,
                now_fn=lambda: clock[0], wait_fn=sleeper, cli_probe=lambda: {},
            )
            self.assertIsNotNone(thread)
            assert thread is not None
            self.assertTrue(thread.daemon)
            thread.join(timeout=5)
            self.assertFalse(thread.is_alive())
        self.assertTrue(checked.is_set())
        # One fetch at start-up, one once the cache turned 24h old; the other hourly checks are no-ops.
        self.assertEqual(fetches, [NOW_2026_11_25, NOW_2026_11_25 + 24 * 3600])

    def test_background_loop_is_disabled_by_env_switch(self) -> None:
        with patch.dict(os.environ, {"VIBEBATON_DISABLE_MODEL_SYNC": "1"}):
            self.assertIsNone(model_catalog.start_daily_sync(cache_path="unused.json", stop_event=threading.Event()))


GEMINI_LIST_OUTPUT = """Available Gemini Models:

auto (Auto)
  Description:   Let Gemini CLI decide the best model for the task: gemini-2.5-pro, gemini-3.5-flash
  Context limit: 1,048,576 input tokens / 65,536 output tokens

gemini-2.5-pro (gemini-2.5-pro)
  Context limit: 1,048,576 input tokens / 65,536 output tokens

gemini-3.5-flash (gemini-3.5-flash)
  Context limit: 1,048,576 input tokens / 65,536 output tokens

gemini-3.1-flash-lite (gemini-3.1-flash-lite)
  Context limit: 1,048,576 input tokens / 65,536 output tokens
"""

CODEX_CACHE = {
    "models": [
        {"slug": "gpt-6.2-sol", "visibility": "list",
         "supported_reasoning_levels": [{"effort": e} for e in ("low", "medium", "high", "xhigh", "max", "ultra")]},
        {"slug": "gpt-6.2-astra", "visibility": "list",
         "supported_reasoning_levels": [{"effort": e} for e in ("low", "medium", "high", "xhigh", "max", "ultra")]},
        {"slug": "gpt-reserve", "visibility": "hide", "supported_reasoning_levels": [{"effort": "low"}]},
        {"slug": "gpt-6-luna", "visibility": "list",
         "supported_reasoning_levels": [{"effort": e} for e in ("low", "medium", "high", "xhigh", "max")]},
        {"slug": "gpt-5.6-terra", "visibility": "list", "supported_reasoning_levels": [{"effort": "low"}, {"effort": "max"}]},
        {"slug": "codex-auto-review", "visibility": "hide", "supported_reasoning_levels": [{"effort": "medium"}]},
    ],
}

CLI_MODELS = {
    "gemini_sub": {m: [] for m in model_catalog.parse_gemini_model_list(GEMINI_LIST_OUTPUT)},
    "codex_sub": model_catalog.parse_codex_models_cache(CODEX_CACHE),
}


def _providers(models: list[dict[str, object]], provider: str) -> list[str]:
    return [str(m["id"]) for m in models if provider in m["providers"]]


class CliReportedModelTests(unittest.TestCase):
    def test_gemini_list_parser_skips_auto_and_detail_lines(self) -> None:
        self.assertEqual(
            model_catalog.parse_gemini_model_list(GEMINI_LIST_OUTPUT),
            ["gemini-2.5-pro", "gemini-3.5-flash", "gemini-3.1-flash-lite"],
        )
        self.assertEqual(model_catalog.parse_gemini_model_list("Unknown option --list-models\n"), [])
        # Launchers that set FORCE_COLOR make the CLI wrap IDs in ANSI bold codes.
        colored = "\x1b[1mAvailable Gemini Models:\x1b[22m\n\n\x1b[1mauto\x1b[22m (Auto)\n\n\x1b[1mgemini-2.5-pro\x1b[22m (gemini-2.5-pro)\n"
        self.assertEqual(model_catalog.parse_gemini_model_list(colored), ["gemini-2.5-pro"])

    def test_codex_cache_parser_keeps_listed_models_with_their_efforts(self) -> None:
        parsed = model_catalog.parse_codex_models_cache(CODEX_CACHE)
        self.assertEqual(list(parsed), ["gpt-6.2-sol", "gpt-6.2-astra", "gpt-6-luna", "gpt-5.6-terra"])
        self.assertEqual(parsed["gpt-6.2-sol"][-1], "ultra")
        self.assertNotIn("ultra", parsed["gpt-6-luna"])
        self.assertEqual(model_catalog.parse_codex_models_cache({"models": "nope"}), {})
        self.assertEqual(model_catalog.parse_codex_models_cache([]), {})

    def test_sync_caches_cli_lists_and_subscription_providers_show_only_those(self) -> None:
        feed = {"gpt-7.1": {"litellm_provider": "openai", "mode": "chat"},
                "gpt-6.2-sol": {"litellm_provider": "openai", "mode": "chat"},
                "gemini/gemini-4-carbon": {"litellm_provider": "gemini", "mode": "chat"}}
        with tempfile.TemporaryDirectory() as tmp:
            cache_path = Path(tmp) / "c.json"
            _sync(cache_path, feed, cli_probe=lambda: CLI_MODELS)
            # Read back from the cache: no CLI runs on a plain read.
            models = model_catalog.get_model_catalog(cache_path=cache_path, now_fn=lambda: NOW_2026_11_25)["models"]
        self.assertEqual(sorted(_providers(models, "gemini_sub")),
                         ["gemini-2.5-pro", "gemini-3.1-flash-lite", "gemini-3.5-flash"])
        self.assertEqual(sorted(_providers(models, "codex_sub")),
                         ["gpt-5.6-terra", "gpt-6-luna", "gpt-6.2-astra", "gpt-6.2-sol"])
        # API providers keep the feed mapping.
        self.assertIn("gemini-4-carbon", _providers(models, "gemini_http"))
        self.assertIn("gpt-7.1", _providers(models, "openai_http"))
        by_id = {m["id"]: m for m in models}
        self.assertEqual(by_id["gemini-3.1-flash-lite"]["label"], "Gemini 3.1 Flash Lite")
        self.assertEqual(by_id["gemini-3.1-flash-lite"]["cost_tier"], "eco")
        self.assertEqual(by_id["gpt-6.2-sol"]["provider_efforts"]["codex_sub"][-1], "ultra")
        self.assertEqual(by_id["gpt-5.6-terra"]["provider_efforts"]["codex_sub"], ["low", "max"])
        self.assertNotIn("openai_http", by_id["gpt-6.2-sol"]["provider_efforts"])
        # The bundled roster itself is never mutated.
        self.assertTrue(all(not m["provider_efforts"] for m in model_catalog.BUNDLED_MODELS))

    def test_missing_cli_list_falls_back_to_feed_mapping(self) -> None:
        feed = {"gpt-7.1": {"litellm_provider": "openai", "mode": "chat"}}
        with tempfile.TemporaryDirectory() as tmp:
            models = _sync(Path(tmp) / "c.json", feed, cli_probe=lambda: {})["catalog"]["models"]
        self.assertIn("gemini-4-carbon", _providers(models, "gemini_sub"))
        self.assertIn("gpt-7.1", _providers(models, "codex_sub"))

    def test_old_cache_without_cli_lists_is_due_for_a_refresh(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            cache_path = Path(tmp) / "c.json"
            cache_path.write_text(json.dumps({"fetched_at": NOW_2026_11_25, "models": [], "retired_ids": []}), encoding="utf-8")
            catalog = model_catalog.get_model_catalog(cache_path=cache_path, now_fn=lambda: NOW_2026_11_25)
        self.assertTrue(catalog["cache"]["stale"])

    def test_agy_model_list_parser_supports_text_ansi_and_json(self) -> None:
        text_output = (
            "Fetching available models...\n"
            "  auto                  Automatic router\n"
            "  \x1b[1mgemini-4-carbon-low\x1b[22m\tGemini 4 Carbon (Low)\n"
            "  gemini-4-carbon-medium\tGemini 4 Carbon (Medium)\n"
            "  gemini-4-carbon-high\tGemini 4 Carbon (High)\n"
            "  gemini-4-neon-xhigh\tGemini 4 Neon (XHigh)\n"
            "  gemini-4-neon-medium\tGemini 4 Neon (Medium)\n"
            "  gemini-4-neon-low\tGemini 4 Neon (Low)\n"
            "  gemini-4-neon-high\tGemini 4 Neon (High)\n"
            "  claude-opus-5-5-low\tClaude Opus 5.5 (Low)\n"
            "  claude-opus-5-5-medium\tClaude Opus 5.5 (Medium)\n"
            "  claude-opus-5-5-high\tClaude Opus 5.5 (High)\n"
            "  gpt-oss-120b-medium\tGPT-OSS 120B (Medium)\n"
        )
        parsed = model_catalog.parse_agy_models(text_output)
        self.assertEqual(parsed, {
            "gemini-4-carbon": ["low", "medium", "high"],
            "gemini-4-neon": ["low", "medium", "high", "xhigh"],
            "claude-opus-5-5": ["low", "medium", "high"],
            "gpt-oss-120b": ["medium"],
        })
        self.assertEqual(
            model_catalog.parse_agy_model_list(text_output),
            ["gemini-4-carbon", "gemini-4-neon", "claude-opus-5-5", "gpt-oss-120b"],
        )
        json_output = json.dumps([
            {"id": "gemini-4-carbon"},
            {"slug": "claude-sonnet-5-5"},
            {"modelId": "gemini-4-argon"},
        ])
        self.assertEqual(
            model_catalog.parse_agy_model_list(json_output),
            ["gemini-4-carbon", "claude-sonnet-5-5", "gemini-4-argon"],
        )
        self.assertEqual(model_catalog.parse_agy_models(""), {})
        self.assertEqual(model_catalog.parse_agy_model_list(""), [])

    def test_sync_with_real_agy_effort_slugs_recommends_carbon_medium(self) -> None:
        feed = {"gemini/gemini-4-carbon": {"litellm_provider": "gemini", "mode": "chat"}}
        cli_models = model_catalog.parse_agy_models(
            "gemini-4-carbon-low\tGemini 4 Carbon (Low)\n"
            "gemini-4-carbon-medium\tGemini 4 Carbon (Medium)\n"
            "gemini-4-carbon-high\tGemini 4 Carbon (High)\n"
        )
        with tempfile.TemporaryDirectory() as tmp:
            models = _sync(Path(tmp) / "c.json", feed, cli_probe=lambda: {"agy_sub": cli_models})["catalog"]["models"]
        carbon = next(m for m in models if m["id"] == "gemini-4-carbon")
        self.assertEqual(carbon["provider_efforts"]["agy_sub"], ["low", "medium", "high"])
        self.assertEqual(
            model_catalog.recommend_role_assignment("brainstorm_and_final_gate", ["agy_sub", "gemini_sub", "claude_sub"], models),
            {"provider": "agy_sub", "model": "gemini-4-carbon", "effort": "medium"},
        )

    def test_probe_reads_both_clis_without_a_real_cli(self) -> None:
        calls: list[list[str]] = []

        def run(cmd: list[str], **_kwargs: object) -> subprocess.CompletedProcess[str]:
            calls.append(cmd)
            if cmd[0].endswith("agy"):
                return subprocess.CompletedProcess(
                    cmd, 0, stdout="gemini-4-carbon\nclaude-opus-5-5\ngemini-4-argon\n", stderr="",
                )
            return subprocess.CompletedProcess(cmd, 0, stdout=GEMINI_LIST_OUTPUT, stderr="")

        with tempfile.TemporaryDirectory() as tmp:
            codex_path = Path(tmp) / "models_cache.json"
            codex_path.write_text(json.dumps(CODEX_CACHE), encoding="utf-8")
            found = model_catalog.probe_cli_models(run=run, which=lambda name: f"/bin/{name}", codex_cache_path=codex_path)
        self.assertEqual(calls, [["/bin/agy", "models"], ["/bin/gemini", "--list-models"]])
        self.assertEqual(list(found["agy_sub"]), ["gemini-4-carbon", "claude-opus-5-5", "gemini-4-argon"])
        self.assertEqual(list(found["gemini_sub"]), ["gemini-2.5-pro", "gemini-3.5-flash", "gemini-3.1-flash-lite"])
        self.assertIn("gpt-6.2-sol", found["codex_sub"])

    def test_probe_failures_leave_the_provider_out(self) -> None:
        def timeout(cmd: list[str], **_kwargs: object) -> subprocess.CompletedProcess[str]:
            raise subprocess.TimeoutExpired(cmd, 30)

        def failing(cmd: list[str], **_kwargs: object) -> subprocess.CompletedProcess[str]:
            return subprocess.CompletedProcess(cmd, 1, stdout=GEMINI_LIST_OUTPUT, stderr="boom")

        with tempfile.TemporaryDirectory() as tmp:
            missing = Path(tmp) / "absent.json"
            garbled = Path(tmp) / "garbled.json"
            garbled.write_text("{not json", encoding="utf-8")
            self.assertEqual(model_catalog.probe_cli_models(run=timeout, which=lambda n: n, codex_cache_path=missing), {})
            self.assertEqual(model_catalog.probe_cli_models(run=failing, which=lambda n: n, codex_cache_path=garbled), {})
            self.assertEqual(model_catalog.probe_cli_models(run=timeout, which=lambda n: None, codex_cache_path=missing), {})


class CleanupTests(unittest.TestCase):
    def test_bundled_model_absent_from_a_successful_feed_is_hidden_except_channel_ids(self) -> None:
        feed = {"gemini/gemini-4-carbon": {"litellm_provider": "gemini", "mode": "chat"},
                "gemini/gemini-5-pro": {"litellm_provider": "gemini", "mode": "chat"},
                "deepseek-v4-pro": {"litellm_provider": "deepseek", "mode": "chat"}}
        with tempfile.TemporaryDirectory() as tmp:
            ids = {m["id"] for m in _sync(Path(tmp) / "c.json", feed)["catalog"]["models"]}
        self.assertNotIn("gemini-2.0-flash", ids)
        self.assertIn("gemini-4-carbon", ids)
        # OpenCode's channel-only ID never appears in the first-party feed.
        self.assertIn("deepseek-v4.1-flash", ids)
        # A family the feed does not mention at all is left alone.
        self.assertIn("claude-opus-5-5", ids)

    def test_restricted_mythos_models_are_not_listed(self) -> None:
        feed = {"claude-mythos-5-2": {"litellm_provider": "anthropic", "mode": "chat"},
                "claude-opus-6": {"litellm_provider": "anthropic", "mode": "chat"}}
        with tempfile.TemporaryDirectory() as tmp:
            ids = {m["id"] for m in _sync(Path(tmp) / "c.json", feed)["catalog"]["models"]}
        self.assertNotIn("claude-mythos-5-2", ids)
        self.assertIn("claude-opus-6", ids)

    def test_deepseek_channels_are_split(self) -> None:
        feed = {"deepseek-v4-flash": {"litellm_provider": "deepseek", "mode": "chat"},
                "deepseek-v4-pro": {"litellm_provider": "deepseek", "mode": "chat"},
                "deepseek-v5": {"litellm_provider": "deepseek", "mode": "chat"},
                "deepseek/deepseek-r1": {"litellm_provider": "deepseek", "mode": "chat"},
                "deepseek/deepseek-coder": {"litellm_provider": "deepseek", "mode": "chat"}}
        with tempfile.TemporaryDirectory() as tmp:
            models = _sync(Path(tmp) / "c.json", feed)["catalog"]["models"]
        self.assertEqual(_providers(models, "dsh_opencode"), ["deepseek-v4.1-flash", "deepseek-v4-pro"])
        official = _providers(models, "dsh_deepseek")
        self.assertIn("deepseek-v4-flash", official)
        self.assertIn("deepseek-v5", official)
        self.assertNotIn("deepseek-v4.1-flash", official)
        self.assertNotIn("deepseek-r1", official)
        self.assertNotIn("deepseek-coder", official)

    def test_labels_are_uniform(self) -> None:
        for entry in model_catalog.BUNDLED_MODELS:
            self.assertEqual(entry["label"], model_catalog._model_label(entry["id"]))
        self.assertEqual(model_catalog._model_label("gemini-4-carbon"), "Gemini 4 Carbon")
        self.assertEqual(model_catalog._model_label("gemini-4-argon"), "Gemini 4 Argon")
        self.assertEqual(model_catalog._model_label("gpt-4o"), "GPT-4o")
        self.assertEqual(model_catalog._model_label("gpt-4o-mini"), "GPT-4o Mini")

    def test_luna_and_terra_are_eco(self) -> None:
        feed = {"gpt-5.6-luna": {"litellm_provider": "openai", "mode": "chat"},
                "gpt-5.6-terra": {"litellm_provider": "openai", "mode": "chat"},
                "gpt-5.6-sol": {"litellm_provider": "openai", "mode": "chat"}}
        with tempfile.TemporaryDirectory() as tmp:
            models = {m["id"]: m for m in _sync(Path(tmp) / "c.json", feed)["catalog"]["models"]}
        self.assertEqual(models["gpt-5.6-luna"]["cost_tier"], "eco")
        self.assertEqual(models["gpt-5.6-terra"]["cost_tier"], "eco")
        self.assertEqual(models["gpt-5.6-sol"]["cost_tier"], "standard")


class RecommendationAvailabilityTests(unittest.TestCase):
    def _cli_catalog(self) -> list[dict[str, object]]:
        feed = {"gemini/gemini-4-carbon": {"litellm_provider": "gemini", "mode": "chat"},
                "deepseek-v4-flash": {"litellm_provider": "deepseek", "mode": "chat"}}
        with tempfile.TemporaryDirectory() as tmp:
            return _sync(Path(tmp) / "c.json", feed, cli_probe=lambda: CLI_MODELS)["catalog"]["models"]

    def test_recommendation_falls_back_inside_the_provider_when_model_is_unavailable(self) -> None:
        models = self._cli_catalog()
        # gemini-4-carbon is Gemini API only; the Gemini CLI's flagship is gemini-2.5-pro.
        self.assertEqual(
            model_catalog.recommend_role_assignment("brainstorm_and_final_gate", ["gemini_sub", "claude_sub"], models),
            {"provider": "gemini_sub", "model": "gemini-2.5-pro", "effort": "medium"},
        )
        self.assertEqual(
            model_catalog.recommend_role_assignment("brainstorm_and_final_gate", ["gemini_http"], models),
            {"provider": "gemini_http", "model": "gemini-4-carbon", "effort": "medium"},
        )
        # deepseek-v4.1-flash is OpenCode-only; the official API gets its own eco model.
        self.assertEqual(
            model_catalog.recommend_role_assignment("bulk_worker", ["dsh_deepseek"], models),
            {"provider": "dsh_deepseek", "model": "deepseek-v4-flash", "effort": "max"},
        )
        self.assertEqual(
            model_catalog.recommend_role_assignment("bulk_worker", ["dsh_opencode"], models),
            {"provider": "dsh_opencode", "model": "deepseek-v4.1-flash", "effort": "max"},
        )


class UltraEffortPassThroughTests(unittest.TestCase):
    def test_ultra_reaches_the_codex_command_and_pricing_strips_it(self) -> None:
        from vibebaton import cli_runner, pricing

        template = ["codex", "exec", "--model", "{model_name}", "-c", 'model_reasoning_effort="{effort}"', "-"]
        cmd = cli_runner.format_command_template(
            template, model="gpt-6.2-sol@ultra", workdir=Path("."), prompt_file=Path("p"), output_file=Path("o"),
        )
        self.assertIn('model_reasoning_effort="ultra"', cmd)
        self.assertIn("gpt-6.2-sol", cmd)
        self.assertEqual(pricing.normalize_model_name("gpt-6.2-sol@ultra"), "gpt-6.2-sol")


if __name__ == "__main__":
    unittest.main()
