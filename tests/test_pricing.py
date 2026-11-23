"""Contract tests for pricing with isolated files and injected fetchers."""

from __future__ import annotations

import json
import os
import tempfile
import tomllib
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

from vibebaton import pricing
from vibebaton.config import PricingSettings, parse_config_dict


_NOW = 1_800_000_000.0


class TestPricingConfig(unittest.TestCase):
    def test_default_settings_for_existing_configs(self) -> None:
        settings = parse_config_dict({}).pricing

        self.assertTrue(settings.auto_sync)
        self.assertEqual(settings.refresh_interval_hours, 24)
        self.assertEqual(settings.timeout_sec, 5.0)
        self.assertEqual(
            settings.source_url,
            "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json",
        )
        self.assertEqual(settings.cache_path, "")
        self.assertEqual(settings.custom_path, "")
        self.assertEqual(settings.custom, {})

    def test_parses_pricing_and_model_overrides_from_toml(self) -> None:
        raw = tomllib.loads("""
[pricing]
auto_sync = false
refresh_interval_hours = 12
source_url = "https://pricing.example.test/rates.json"
timeout_sec = 2.5
cache_path = "~/rates/cache.json"
custom_path = "~/rates/custom.json"

[pricing.custom."gateway/model.v1"]
input_per_1m = 2
output_per_1m = 8
cached_input_per_1m = 0.2
""")
        settings = parse_config_dict(raw).pricing

        self.assertEqual(settings, PricingSettings(
            auto_sync=False,
            refresh_interval_hours=12,
            source_url="https://pricing.example.test/rates.json",
            timeout_sec=2.5,
            cache_path="~/rates/cache.json",
            custom_path="~/rates/custom.json",
            custom={
                "gateway/model.v1": {
                    "input_per_1m": 2.0,
                    "output_per_1m": 8.0,
                    "cached_input_per_1m": 0.2,
                },
            },
        ))
        self.assertIsInstance(settings.custom["gateway/model.v1"]["input_per_1m"], float)


class TestPricing(unittest.TestCase):
    def setUp(self) -> None:
        root = Path(self.enterContext(tempfile.TemporaryDirectory()))
        self.cache_path = root / "rates" / "pricing_cache.json"
        self.custom_path = root / "rates" / "custom_pricing.json"
        self.settings = PricingSettings(
            source_url="https://pricing.example.test/rates.json",
            timeout_sec=2.5,
            cache_path=str(self.cache_path),
            custom_path=str(self.custom_path),
        )
        network = self.enterContext(patch.object(
            pricing.urllib.request, "urlopen", side_effect=AssertionError("Unexpected pricing HTTP request"),
        ))
        self.addCleanup(network.assert_not_called)

    def test_golden_example_refresh_price_and_catalog(self) -> None:
        """Use the same settings for a refresh, token billing, and the catalog."""
        settings = self.settings
        fetcher = Mock(return_value=json.dumps({
            "anthropic/claude-sonnet-4-6": {
                "input_cost_per_token": 3e-6,
                "output_cost_per_token": 15e-6,
                "cache_read_input_token_cost": 3e-7,
            },
        }).encode("utf-8"))

        result = pricing.sync_official_pricing(
            settings, fetcher=fetcher, cache_path=self.cache_path, now=_NOW,
        )
        self.assertTrue(result.ok)
        self.assertTrue(result.fetched)
        self.assertEqual(result.cache_path, str(self.cache_path))
        fetcher.assert_called_once_with(settings.source_url, settings.timeout_sec)

        cost = pricing.compute_token_cost_usd(
            "anthropic/claude-sonnet-4-6@high", 1000, 500, 250,
            custom_pricing=settings.custom, cache_path=settings.cache_path, custom_path=settings.custom_path,
        )
        self.assertEqual(cost, 0.009825)

        with patch.object(pricing.time, "time", return_value=_NOW + 1800):
            catalog = pricing.build_pricing_catalog(settings)
        self.assertEqual(catalog["cache"], {
            "path": str(self.cache_path),
            "fetched_at": _NOW,
            "age_sec": 1800.0,
            "stale": False,
            "refresh_interval_hours": 24,
            "auto_sync": True,
            "source_url": settings.source_url,
        })
        self.assertEqual(catalog["custom_path"], str(self.custom_path))
        models = {row["model"]: row for row in catalog["models"]}
        for name in ("claude-sonnet-4-6", "sonnet"):
            self.assertEqual(models[name], {
                "model": name,
                "input_per_1m": 3.0,
                "output_per_1m": 15.0,
                "cached_input_per_1m": 0.3,
                "source": "official_cache",
            })
        self.assertEqual(json.loads(json.dumps(catalog, allow_nan=False)), catalog)

    def test_provider_toml_and_file_precedence_over_cache_and_builtin(self) -> None:
        model = "gpt-4o"
        paths = {"cache_path": self.cache_path, "custom_path": self.custom_path}
        self.assertEqual(
            pricing.resolve_model_pricing(model, **paths),
            pricing.ResolvedModelPricing(model, 2.5, 10.0, 1.25, "builtin"),
        )
        self.assertIsNone(pricing.resolve_model_pricing("unknown", **paths))

        fetcher = Mock(return_value={model: {"input_per_1m": 1.0, "output_per_1m": 5.0}})
        self.assertTrue(pricing.sync_official_pricing(self.settings, fetcher=fetcher, now=_NOW).ok)
        self.assertEqual(
            pricing.resolve_model_pricing(model, **paths),
            pricing.ResolvedModelPricing(model, 1.0, 5.0, 1.0, "official_cache"),
        )

        pricing.save_custom_pricing(
            self.custom_path, {model: {"input_per_1m": 2.0, "output_per_1m": 5.0}},
        )
        self.assertEqual(
            pricing.resolve_model_pricing(model, **paths),
            pricing.ResolvedModelPricing(model, 2.0, 5.0, 2.0, "custom"),
        )
        self.settings.custom = {model: {"input_per_1m": 3.0, "output_per_1m": 5.0}}
        self.assertEqual(
            pricing.resolve_model_pricing(model, custom_pricing=self.settings.custom, **paths),
            pricing.ResolvedModelPricing(model, 3.0, 5.0, 3.0, "custom"),
        )

        provider = {"openai/gpt-4o@high": {
            "input_per_1m": 4.0, "output_per_1m": 5.0, "cached_input_per_1m": 0.0,
        }}
        self.assertEqual(
            pricing.resolve_model_pricing(
                model, provider_pricing=provider, custom_pricing=self.settings.custom, **paths,
            ),
            pricing.ResolvedModelPricing(model, 4.0, 5.0, 0.0, "custom"),
        )
        catalog = pricing.build_pricing_catalog(self.settings, provider_pricing=provider)
        models = {row["model"]: row for row in catalog["models"]}
        self.assertEqual(models[model]["input_per_1m"], 4.0)
        self.assertEqual(models[model]["source"], "custom")

    def test_normalizes_known_efforts_and_prefixes(self) -> None:
        for raw, name in (
            ("anthropic/claude-sonnet-4-6@high", "claude-sonnet-4-6"),
            ("opencode-go/deepseek-v4-pro@max", "deepseek-v4-pro"),
            ("openai/gpt-6.2-astra@xhigh", "gpt-6.2-astra"),
            ("deepseek/deepseek-chat@low", "deepseek-chat"),
            ("gateway/model@version", "gateway/model@version"),
        ):
            with self.subTest(model=raw):
                self.assertEqual(pricing.normalize_model_name(raw), name)
        self.assertEqual(
            pricing.resolve_model_pricing(
                "opencode-go/deepseek-v4-pro@max", cache_path=self.cache_path, custom_path=self.custom_path,
            ),
            pricing.ResolvedModelPricing("deepseek-v4-pro", 1.32, 3.96, 0.044, "builtin"),
        )

    def test_exact_provider_key_keeps_the_legacy_override(self) -> None:
        model = "openai/gpt-4o"
        provider = {
            model: {"input_per_1m": 1.0, "output_per_1m": 2.0},
            "gpt-4o": {"input_per_1m": 3.0, "output_per_1m": 4.0},
        }
        self.assertEqual(
            pricing.compute_token_cost_usd(model, 1000, 500, pricing_table=provider),
            0.002,
        )

    def test_fresh_cache_skips_and_stale_or_forced_cache_refetches(self) -> None:
        fetcher = Mock(return_value={"example": {"input_per_1m": 1.0, "output_per_1m": 2.0}})
        first = pricing.sync_official_pricing(self.settings, fetcher=fetcher, now=_NOW)
        fresh = pricing.sync_official_pricing(self.settings, fetcher=fetcher, now=_NOW + 86_399)
        self.assertTrue(first.fetched)
        self.assertTrue(fresh.ok)
        self.assertTrue(fresh.skipped_fresh)
        self.assertFalse(fresh.fetched)
        self.assertEqual(fresh.fetched_at, _NOW)
        self.assertEqual(fresh.model_count, 1)
        fetcher.assert_called_once()
        with patch.object(pricing.time, "time", return_value=_NOW + 86_400):
            self.assertTrue(pricing.build_pricing_catalog(self.settings)["cache"]["stale"])

        old_time = _NOW + 25 * 3600
        stale = pricing.sync_official_pricing(self.settings, fetcher=fetcher, now=old_time)
        forced = pricing.sync_official_pricing(self.settings, fetcher=fetcher, now=old_time + 1, force=True)
        self.assertTrue(stale.fetched)
        self.assertEqual(stale.fetched_at, old_time)
        self.assertTrue(forced.fetched)
        self.assertEqual(forced.fetched_at, old_time + 1)
        self.assertEqual(fetcher.call_count, 3)

    def test_litellm_conversion_preserves_canonical_ids_and_explicit_aliases(self) -> None:
        fetcher = Mock(return_value=json.dumps({
            "sample_spec": {"input_cost_per_token": 1, "output_cost_per_token": 1},
            "anthropic/claude-haiku-4-5-20251001": {
                "input_cost_per_token": 1e-6,
                "output_cost_per_token": 5e-6,
                "cache_read_input_token_cost": 1e-7,
            },
            "gpt-4o": {"input_cost_per_token": 2.5e-6, "output_cost_per_token": 1e-5},
            "openai/gpt-4o": {"input_cost_per_token": 3e-6, "output_cost_per_token": 1e-5},
            "haiku": {"input_per_1m": 2.0, "output_per_1m": 5.0},
        }))
        result = pricing.sync_official_pricing(self.settings, fetcher=fetcher, now=_NOW)

        self.assertTrue(result.ok)
        cached = json.loads(self.cache_path.read_text(encoding="utf-8"))
        self.assertEqual(cached["source_url"], self.settings.source_url)
        self.assertEqual(cached["fetched_at"], _NOW)
        self.assertEqual(cached["models"], {
            "claude-haiku-4-5-20251001": {
                "input_per_1m": 1.0, "output_per_1m": 5.0, "cached_input_per_1m": 0.1,
            },
            "claude-haiku-4-5": {
                "input_per_1m": 1.0, "output_per_1m": 5.0, "cached_input_per_1m": 0.1,
            },
            "gpt-4o": {"input_per_1m": 2.5, "output_per_1m": 10.0},
            "haiku": {"input_per_1m": 2.0, "output_per_1m": 5.0},
        })
        self.assertEqual(result.model_count, len(cached["models"]))

    def test_failed_refresh_preserves_previous_cache(self) -> None:
        fetcher = Mock(return_value={"example": {"input_per_1m": 1.0, "output_per_1m": 2.0}})
        self.assertTrue(pricing.sync_official_pricing(self.settings, fetcher=fetcher, now=_NOW).ok)
        previous = self.cache_path.read_bytes()
        failed_fetchers = (
            Mock(side_effect=TimeoutError("offline")),
            Mock(return_value=b"not json"),
            Mock(return_value=b'{"example": {"input_per_1m": -1.0, "output_per_1m": 2.0}}'),
        )
        for failed_fetcher in failed_fetchers:
            with self.subTest(fetcher=failed_fetcher):
                result = pricing.sync_official_pricing(
                    self.settings, fetcher=failed_fetcher, now=_NOW + 86_400,
                )
                self.assertFalse(result.ok)
                self.assertFalse(result.fetched)
                self.assertTrue(result.preserved_cache)
                self.assertTrue(result.error)
                self.assertEqual(result.fetched_at, _NOW)
                self.assertEqual(result.model_count, 1)
                self.assertEqual(self.cache_path.read_bytes(), previous)
                failed_fetcher.assert_called_once()

    def test_atomic_replace_failure_leaves_cache_and_cleans_temporary_file(self) -> None:
        fetcher = Mock(return_value={"example": {"input_per_1m": 1.0, "output_per_1m": 2.0}})
        self.assertTrue(pricing.sync_official_pricing(self.settings, fetcher=fetcher, now=_NOW).ok)
        previous = self.cache_path.read_bytes()
        with patch.object(pricing.os, "replace", side_effect=PermissionError("file busy")) as replace:
            result = pricing.sync_official_pricing(
                self.settings, force=True, fetcher=fetcher, now=_NOW + 1,
            )
        replace.assert_called_once()
        temporary, destination = replace.call_args.args
        self.assertEqual(temporary.parent, self.cache_path.parent)
        self.assertEqual(destination, self.cache_path)
        self.assertFalse(temporary.exists())
        self.assertFalse(result.ok)
        self.assertTrue(result.preserved_cache)
        self.assertEqual(self.cache_path.read_bytes(), previous)

    def test_custom_file_persists_float_rates_updates_and_clears(self) -> None:
        self.assertEqual(pricing.load_custom_pricing(self.custom_path), {})
        model_a = {"input_per_1m": 0, "output_per_1m": 5, "cached_input_per_1m": 0}
        model_b = {"input_per_1m": 1.5, "output_per_1m": 5.0}
        saved = pricing.save_custom_pricing(self.custom_path, {"a": model_a, "b": model_b})
        self.assertIsInstance(saved["a"]["input_per_1m"], float)
        self.assertEqual(pricing.load_custom_pricing(self.custom_path), {"a": model_a, "b": model_b})

        pricing.save_custom_pricing(self.custom_path, {"a": None, "b": {}, "c": model_b})
        self.assertEqual(pricing.load_custom_pricing(self.custom_path), {"c": model_b})
        self.assertEqual(json.loads(self.custom_path.read_text(encoding="utf-8")), {"c": model_b})

    def test_invalid_custom_update_preserves_previous_file(self) -> None:
        rates = {"input_per_1m": 1.0, "output_per_1m": 2.0}
        pricing.save_custom_pricing(self.custom_path, {"example": rates})
        previous = self.custom_path.read_bytes()
        for invalid in (-1, float("inf"), float("nan")):
            with self.subTest(rate=invalid):
                with self.assertRaises(ValueError):
                    pricing.save_custom_pricing(
                        self.custom_path, {"example": None, "invalid": {**rates, "input_per_1m": invalid}},
                    )
                self.assertEqual(self.custom_path.read_bytes(), previous)

    def test_background_refresh_honors_setting_and_environment_switch(self) -> None:
        fetcher = Mock(return_value={"example": {"input_per_1m": 1.0, "output_per_1m": 2.0}})
        with patch.dict(os.environ, {"VIBEBATON_DISABLE_PRICING_SYNC": "1"}):
            self.assertIsNone(pricing.trigger_background_pricing_sync(self.settings, fetcher=fetcher))
        with patch.dict(os.environ, {"VIBEBATON_DISABLE_PRICING_SYNC": "0"}):
            disabled = PricingSettings(auto_sync=False)
            self.assertIsNone(pricing.trigger_background_pricing_sync(
                disabled, cache_path=self.cache_path, fetcher=fetcher,
            ))
        fetcher.assert_not_called()
        self.assertFalse(self.cache_path.exists())

    def test_background_refresh_returns_started_daemon_thread(self) -> None:
        fetcher = Mock(return_value={"example": {"input_per_1m": 1.0, "output_per_1m": 2.0}})
        with patch.dict(os.environ, {"VIBEBATON_DISABLE_PRICING_SYNC": "0"}):
            thread = pricing.trigger_background_pricing_sync(
                self.settings, cache_path=self.cache_path, fetcher=fetcher,
            )
            self.assertIsNotNone(thread)
            self.assertTrue(thread.daemon)
            thread.join(timeout=5)
        self.assertFalse(thread.is_alive())
        fetcher.assert_called_once_with(self.settings.source_url, self.settings.timeout_sec)
        self.assertTrue(self.cache_path.is_file())
