"""Unit tests for full model catalog, L0-L3 ranked recommendations, and 24h daily sync."""

from __future__ import annotations

import json
import os
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

from vibebaton import model_catalog


class ModelCatalogTests(unittest.TestCase):
    def test_tiered_recommendations_on_full_host(self) -> None:
        all_providers = ["gemini_sub", "claude_sub", "codex_sub", "dsh_opencode"]
        self.assertEqual(
            model_catalog.recommend_role_assignment("brainstorm_and_final_gate", all_providers),
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
                self.assertIn("gpt-4o", ids)
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

    def test_ranks_follow_version_within_family_after_bundled(self) -> None:
        synced = self._synced()
        bundled_max = max(m["rank"] for m in model_catalog.BUNDLED_MODELS)
        self.assertTrue(all(m["rank"] > bundled_max for m in synced.values()))
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
                now_fn=lambda: clock[0], wait_fn=sleeper,
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


if __name__ == "__main__":
    unittest.main()
