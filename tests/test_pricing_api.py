"""HTTP contract tests for the pricing endpoints on the local canvas server."""

from __future__ import annotations

import json
import os
from http.server import ThreadingHTTPServer
from unittest.mock import Mock, patch
from urllib.request import Request

from vibebaton.web_server import create_server

from tests.test_web_server import WebServerTestCase

SOURCE_URL = "https://pricing.example.test/rates.json"

# The LiteLLM keys exercise the official-feed conversion in pricing.py.
OFFICIAL_FEED = {
    "anthropic/claude-sonnet-4-6": {
        "input_cost_per_token": 3e-6,
        "output_cost_per_token": 15e-6,
        "cache_read_input_token_cost": 3e-7,
    },
    "openai/gpt-4o": {
        "input_cost_per_token": 2.5e-6,
        "output_cost_per_token": 1e-5,
        "cache_read_input_token_cost": 1.25e-6,
    },
}


class TestPricingApi(WebServerTestCase):
    """Run each test against a loopback server with temporary pricing files."""

    def _create_server(self) -> ThreadingHTTPServer:
        self.cache_path = self.repo / "pricing_cache.json"
        self.custom_path = self.repo / "custom_pricing.json"
        self.config_path.write_text(
            "[pricing]\n"
            f"cache_path = {json.dumps(str(self.cache_path))}\n"
            f"custom_path = {json.dumps(str(self.custom_path))}\n"
            f"source_url = {json.dumps(SOURCE_URL)}\n"
            "timeout_sec = 2.5\n"
            "refresh_interval_hours = 24\n"
            "auto_sync = false\n",
            encoding="utf-8",
        )
        os.environ["VIBEBATON_DISABLE_PRICING_SYNC"] = "1"
        self.fetcher = Mock(return_value=json.dumps(OFFICIAL_FEED).encode("utf-8"))
        live_fetcher = self.enterContext(patch(
            "vibebaton.pricing._fetch_pricing",
            side_effect=AssertionError("Unexpected live pricing HTTP request"),
        ))
        self.addCleanup(live_fetcher.assert_not_called)
        return create_server(
            self.repo,
            port=0,
            daemon_spawner=self.fake_spawner,
            credentials_path=self.credentials_path,
            provider_probe=self.provider_probe,
            pricing_fetcher=self.fetcher,
        )

    def test_get_returns_the_builtin_catalog_with_pricing_paths(self) -> None:
        status, headers, body = self.get("/api/pricing")

        self.assertEqual(status, 200)
        self.assertEqual(headers.get_content_type(), "application/json")
        self.assertEqual(headers["Access-Control-Allow-Origin"], "*")
        self.assertEqual(set(body), {"models", "cache", "custom_path"})
        self.assertEqual(body["custom_path"], str(self.custom_path))
        self.assertEqual(body["cache"]["path"], str(self.cache_path))
        self.assertIs(body["cache"]["auto_sync"], False)
        self.assertEqual(body["cache"]["source_url"], SOURCE_URL)
        self.assertTrue(body["models"])
        self.assertEqual({row["source"] for row in body["models"]}, {"builtin"})
        for row in body["models"]:
            self.assertEqual(
                set(row),
                {"model", "input_per_1m", "output_per_1m", "cached_input_per_1m", "source"},
            )
        self.assertFalse(self.cache_path.exists())
        self.fetcher.assert_not_called()

    def test_sync_with_a_working_fetcher_refreshes_the_cache_and_catalog(self) -> None:
        status, headers, body = self.send_json("/api/pricing/sync", {"force": True})

        self.assertEqual(status, 200)
        self.assertEqual(headers.get_content_type(), "application/json")
        self.assertIs(body["ok"], True)
        self.assertIs(body["fetched"], True)
        self.assertIs(body["skipped_fresh"], False)
        self.assertGreater(body["model_count"], 0)
        self.assertIsNone(body["error"])
        self.assertIs(body["preserved_cache"], False)
        self.assertEqual(set(body["catalog"]), {"models", "cache", "custom_path"})
        self.fetcher.assert_called_once_with(SOURCE_URL, 2.5)

        cached = json.loads(self.cache_path.read_text(encoding="utf-8"))
        self.assertEqual(cached["fetched_at"], body["fetched_at"])
        self.assertEqual(cached["models"]["gpt-4o"], {
            "input_per_1m": 2.5,
            "output_per_1m": 10.0,
            "cached_input_per_1m": 1.25,
        })
        models = {row["model"]: row for row in body["catalog"]["models"]}
        self.assertEqual(models["claude-sonnet-4-6"]["source"], "official_cache")
        self.assertEqual(models["claude-sonnet-4-6"]["input_per_1m"], 3.0)
        self.assertEqual(models["gpt-4o"]["source"], "official_cache")
        self.assertEqual(json.loads(json.dumps(body, allow_nan=False)), body)

    def test_sync_without_a_body_skips_a_fresh_cache(self) -> None:
        status, _, body = self._request(Request(self.base + "/api/pricing/sync", method="POST"))

        self.assertEqual(status, 200)
        self.assertIs(body["ok"], True)
        self.assertIs(body["fetched"], True)
        self.assertGreater(body["model_count"], 0)
        self.fetcher.assert_called_once_with(SOURCE_URL, 2.5)

        status, _, body = self._request(Request(self.base + "/api/pricing/sync", method="POST"))
        self.assertEqual(status, 200)
        self.assertIs(body["fetched"], False)
        self.assertIs(body["skipped_fresh"], True)
        self.assertTrue(body["fetched_at"])
        self.fetcher.assert_called_once_with(SOURCE_URL, 2.5)

    def test_failed_sync_returns_ok_false_and_preserves_the_previous_cache(self) -> None:
        self.assertEqual(self.send_json("/api/pricing/sync", {"force": True})[0], 200)
        previous = self.cache_path.read_bytes()
        previous_catalog = self.get("/api/pricing")[2]
        self.fetcher.side_effect = TimeoutError("pricing feed offline")

        status, headers, body = self.send_json("/api/pricing/sync", {"force": True})

        self.assertEqual(status, 200)
        self.assertEqual(headers.get_content_type(), "application/json")
        self.assertIs(body["ok"], False)
        self.assertIs(body["fetched"], False)
        self.assertIs(body["preserved_cache"], True)
        self.assertIn("pricing feed offline", body["error"])
        self.assertGreater(body["model_count"], 0)
        self.assertEqual(self.cache_path.read_bytes(), previous)
        self.assertEqual(body["catalog"]["models"], previous_catalog["models"])
        models = {row["model"]: row for row in body["catalog"]["models"]}
        self.assertEqual(models["claude-sonnet-4-6"]["source"], "official_cache")
        self.assertEqual(models["claude-sonnet-4-6"]["input_per_1m"], 3.0)

    def test_sync_rejects_a_non_boolean_force(self) -> None:
        for force in ("yes", 1, None):
            with self.subTest(force=force):
                status, _, body = self.send_json("/api/pricing/sync", {"force": force})
                self.assertEqual(status, 400)
                self.assertIn("force", body["error"])
        self.fetcher.assert_not_called()

    def test_sync_rejects_negative_content_length(self) -> None:
        status, _, body = self._request(Request(
            self.base + "/api/pricing/sync", headers={"Content-Length": "-1"}, method="POST"
        ))

        self.assertEqual(status, 400)
        self.assertIn("Content-Length", body["error"])
        self.fetcher.assert_not_called()

    def test_custom_put_persists_and_clears_an_override(self) -> None:
        rates = {"input_per_1m": 1.5, "output_per_1m": 6.0, "cached_input_per_1m": 0.15}

        status, headers, body = self.send_json(
            "/api/pricing/custom", {"updates": {"gpt-4o": rates}}, method="PUT"
        )

        self.assertEqual(status, 200)
        self.assertEqual(headers.get_content_type(), "application/json")
        self.assertEqual(json.loads(self.custom_path.read_text(encoding="utf-8")), {"gpt-4o": rates})
        models = {row["model"]: row for row in body["models"]}
        self.assertEqual(models["gpt-4o"], {
            "model": "gpt-4o",
            "source": "custom",
            **rates,
        })

        models = {row["model"]: row for row in self.get("/api/pricing")[2]["models"]}
        self.assertEqual(models["gpt-4o"]["source"], "custom")
        self.assertEqual(models["gpt-4o"]["cached_input_per_1m"], 0.15)

        status, _, cleared = self.send_json(
            "/api/pricing/custom", {"updates": {"gpt-4o": None}}, method="PUT"
        )
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(self.custom_path.read_text(encoding="utf-8")), {})
        models = {row["model"]: row for row in cleared["models"]}
        self.assertEqual(models["gpt-4o"]["source"], "builtin")
        self.assertEqual(models["gpt-4o"]["input_per_1m"], 2.5)
        self.assertEqual(models["gpt-4o"]["output_per_1m"], 10.0)

        self.assertEqual(self.send_json(
            "/api/pricing/custom", {"updates": {"gpt-4o": rates}}, method="PUT"
        )[0], 200)
        status, _, cleared = self.send_json(
            "/api/pricing/custom", {"updates": {"gpt-4o": {}}}, method="PUT"
        )
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(self.custom_path.read_text(encoding="utf-8")), {})
        models = {row["model"]: row for row in cleared["models"]}
        self.assertEqual(models["gpt-4o"]["source"], "builtin")

    def test_custom_put_rejects_a_negative_rate_that_rounds_to_zero(self) -> None:
        status, _, body = self._send_raw_json(
            "/api/pricing/custom",
            b'{"updates":{"gpt-4o":{"input_per_1m":-1e-400,"output_per_1m":2}}}',
            method="PUT",
        )

        self.assertEqual(status, 400)
        self.assertIn("non-negative", body["error"])
        self.assertFalse(self.custom_path.exists())

    def test_custom_put_rejects_invalid_rates_without_writing(self) -> None:
        base = {"input_per_1m": 0, "output_per_1m": 2.0}
        status, _, _ = self.send_json(
            "/api/pricing/custom", {"updates": {"gpt-4o": base}}, method="PUT"
        )
        self.assertEqual(status, 200)
        previous = self.custom_path.read_bytes()

        cases = {
            "negative": {**base, "input_per_1m": -0.01},
            "nan": {**base, "input_per_1m": float("nan")},
            "infinity": {**base, "output_per_1m": float("inf")},
            "non-numeric": {**base, "input_per_1m": "1.0"},
            "boolean": {**base, "output_per_1m": True},
            "missing input": {"output_per_1m": 2.0},
            "unknown field": {**base, "extra": 1.0},
            "oversized integer": {**base, "input_per_1m": 10**400},
        }
        for label, rates in cases.items():
            with self.subTest(label=label):
                status, headers, body = self.send_json(
                    "/api/pricing/custom", {"updates": {"gpt-4o": None, "other": rates}}, method="PUT"
                )
                self.assertEqual(status, 400)
                self.assertEqual(headers.get_content_type(), "application/json")
                expected = "other" if label in {"missing input", "unknown field"} else "finite"
                self.assertIn(expected, body["error"])
                self.assertEqual(self.custom_path.read_bytes(), previous)

        for payload in ({}, {"updates": []}):
            with self.subTest(payload=payload):
                status, _, body = self.send_json("/api/pricing/custom", payload, method="PUT")
                self.assertEqual(status, 400)
                self.assertIn("updates", body["error"])
        status, _, body = self.send_json(
            "/api/pricing/custom", {"updates": {"gpt-4o": 5}}, method="PUT"
        )
        self.assertEqual(status, 400)
        self.assertIn("gpt-4o", body["error"])
        self.assertEqual(self.custom_path.read_bytes(), previous)
