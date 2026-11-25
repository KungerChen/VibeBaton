"""Unit tests for full model catalog, L0-L3 ranked recommendations, and 24h daily sync."""

from __future__ import annotations

import os
import tempfile
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
            {"provider": "claude_sub", "model": "opus-5.5", "effort": "medium"},
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
            {"provider": "claude_sub", "model": "fable-5.2", "effort": "medium"},
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
            {"provider": "claude_sub", "model": "sonnet-5.5", "effort": "max"},
        )
        self.assertEqual(
            model_catalog.recommend_role_assignment("critical_executor", ["gemini_sub"]),
            {"provider": "gemini_sub", "model": "gemini-4-hydrogen", "effort": "max"},
        )
        # L3: DSH absent -> Haiku 5.5 Max -> GPT-6.1 Terra Max
        self.assertEqual(
            model_catalog.recommend_role_assignment("bulk_worker", ["claude_sub", "codex_sub"]),
            {"provider": "claude_sub", "model": "haiku-5.5", "effort": "max"},
        )
        self.assertEqual(
            model_catalog.recommend_role_assignment("bulk_worker", ["codex_sub"]),
            {"provider": "codex_sub", "model": "gpt-6.1-terra", "effort": "max"},
        )

    def test_sync_merges_remote_models_while_preserving_all_bundled_legacy_models(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            cache_path = Path(tmp) / "model_catalog_cache.json"
            clock = [1000.0]

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


if __name__ == "__main__":
    unittest.main()
