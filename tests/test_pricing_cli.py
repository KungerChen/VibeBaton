"""Contract tests for the `baton pricing` CLI commands."""

from __future__ import annotations

import contextlib
import io
import json
import os
import tempfile
import unittest
from functools import partial
from pathlib import Path
from unittest.mock import Mock, patch

from vibebaton import cli, pricing

_SOURCE_URL = "https://pricing.example.test/rates.json"
_OFFICIAL_PAYLOAD = {
    "cache-model": {
        "input_per_1m": 1.0,
        "output_per_1m": 2.0,
        "cached_input_per_1m": 0.5,
    },
}


class TestPricingCommands(unittest.TestCase):
    def setUp(self) -> None:
        self.repo = Path(self.enterContext(tempfile.TemporaryDirectory())).resolve()
        home = self.repo / "home"
        self.cache_path = home / "cache" / "pricing_cache.json"
        self.custom_path = home / "cache" / "custom_pricing.json"
        self.config_path = self.repo / ".baton" / "baton.toml"
        self.config_path.parent.mkdir(parents=True)
        self.config_path.write_text(
            "[pricing]\n"
            "refresh_interval_hours = 24\n"
            f'source_url = "{_SOURCE_URL}"\n'
            "timeout_sec = 2.5\n"
            'cache_path = "~/cache/pricing_cache.json"\n'
            'custom_path = "~/cache/custom_pricing.json"\n',
            encoding="utf-8",
        )
        self.enterContext(
            patch.dict(
                os.environ,
                {
                    "VIBEBATON_DISABLE_PRICING_SYNC": "1",
                    "HOME": str(home),
                    "USERPROFILE": str(home),
                },
            )
        )
        network = self.enterContext(
            patch.object(
                pricing.urllib.request,
                "urlopen",
                side_effect=AssertionError("Unexpected pricing HTTP request"),
            )
        )
        self.addCleanup(network.assert_not_called)
        self.fetcher = Mock(return_value=_OFFICIAL_PAYLOAD)
        self.enterContext(
            patch.object(
                pricing,
                "sync_official_pricing",
                partial(pricing.sync_official_pricing, fetcher=self.fetcher),
            )
        )

    def _run_pricing(self, command: str, *options: str) -> tuple[int, str]:
        stdout = io.StringIO()
        with contextlib.redirect_stdout(stdout):
            exit_code = cli.main(["pricing", command, "--repo", str(self.repo), *options])
        return exit_code, stdout.getvalue()

    def test_sync_json_reports_result_and_writes_cache(self) -> None:
        explicit = self.config_path.rename(self.repo / "pricing.toml")
        exit_code, output = self._run_pricing("sync", "--config", str(explicit), "--force", "--json")

        self.assertEqual(exit_code, 0, output)
        payload = json.loads(output)
        self.assertIs(payload["ok"], True)
        self.assertIs(payload["fetched"], True)
        self.assertEqual(payload["model_count"], 1)
        self.assertEqual(payload["cache_path"], str(self.cache_path))
        self.assertIsNone(payload["error"])
        self.fetcher.assert_called_once_with(_SOURCE_URL, 2.5)
        cache = json.loads(self.cache_path.read_text(encoding="utf-8"))
        self.assertEqual(cache["models"], _OFFICIAL_PAYLOAD)

    def test_sync_human_summary_then_skips_a_fresh_cache(self) -> None:
        first_exit, first_output = self._run_pricing("sync")
        second_exit, second_output = self._run_pricing("sync")

        self.assertEqual(first_exit, 0, first_output)
        self.assertIn("ok: True", first_output)
        self.assertIn("skipped_fresh: False", first_output)
        self.assertIn("model_count: 1", first_output)
        self.assertIn(f"cache_path: {self.cache_path}", first_output)
        self.assertNotIn("error:", first_output)

        self.assertEqual(second_exit, 0, second_output)
        self.assertIn("skipped_fresh: True", second_output)
        self.assertIn("model_count: 1", second_output)
        self.fetcher.assert_called_once_with(_SOURCE_URL, 2.5)

    def test_failed_sync_prints_error_exits_zero_and_preserves_cache(self) -> None:
        self.assertEqual(self._run_pricing("sync")[0], 0)
        previous = self.cache_path.read_bytes()

        self.fetcher.reset_mock()
        self.fetcher.side_effect = TimeoutError("offline")
        exit_code, output = self._run_pricing("sync", "--force")

        self.assertEqual(exit_code, 0, output)
        self.assertIn("ok: False", output)
        self.assertIn("error: offline", output)
        self.assertIn(f"cache_path: {self.cache_path}", output)
        self.assertEqual(self.cache_path.read_bytes(), previous)
        self.fetcher.assert_called_once_with(_SOURCE_URL, 2.5)

        exit_code, output = self._run_pricing("sync", "--force", "--json")
        self.assertEqual(exit_code, 0, output)
        result = json.loads(output)
        self.assertIs(result["ok"], False)
        self.assertIs(result["preserved_cache"], True)
        self.assertEqual(result["error"], "offline")
        self.assertEqual(self.cache_path.read_bytes(), previous)

    def test_invalid_config_exits_nonzero_without_fetching(self) -> None:
        for invalid_config in ("[pricing\n", "[pricing]\ntimeout_sec = []\n"):
            self.config_path.write_text(invalid_config, encoding="utf-8")
            for command in ("sync", "show"):
                with self.subTest(command=command, config=invalid_config):
                    stderr = io.StringIO()
                    with contextlib.redirect_stderr(stderr):
                        exit_code, output = self._run_pricing(command)

                    self.assertEqual(exit_code, 1, output)
                    self.assertEqual(output, "")
                    self.assertIn("Error:", stderr.getvalue())

        self.fetcher.assert_not_called()

    def test_show_json_lists_models_from_each_source(self) -> None:
        self.assertEqual(self._run_pricing("sync")[0], 0)
        pricing.save_custom_pricing(
            self.custom_path,
            {"custom-model": {"input_per_1m": 7.0, "output_per_1m": 9.0}},
        )

        exit_code, output = self._run_pricing("show", "--json")

        self.assertEqual(exit_code, 0, output)
        catalog = json.loads(output)
        models = {row["model"]: row for row in catalog["models"]}
        self.assertEqual(models["cache-model"]["source"], "official_cache")
        self.assertEqual(models["custom-model"]["source"], "custom")
        self.assertEqual(models["gpt-4o"]["source"], "builtin")
        self.assertTrue(
            all(
                row["source"] in {"custom", "official_cache", "builtin"}
                for row in models.values()
            )
        )
        self.assertEqual(catalog["cache"]["path"], str(self.cache_path))
        self.assertEqual(catalog["custom_path"], str(self.custom_path))
        self.fetcher.assert_called_once()

    def test_show_human_table_has_aligned_columns(self) -> None:
        pricing.save_custom_pricing(
            self.custom_path,
            {"custom-model": {
                "input_per_1m": 1e-7, "cached_input_per_1m": 0.25, "output_per_1m": 6.0,
            }},
        )

        exit_code, output = self._run_pricing("show")

        self.assertEqual(exit_code, 0, output)
        header, *rows = output.splitlines()
        self.assertEqual(header.split(), ["Model", "Source", "Input/1M", "Cached/1M", "Output/1M"])
        custom_row = next(row for row in rows if row.startswith("custom-model "))
        model, source, input_rate, cached_rate, output_rate = custom_row.split()
        self.assertEqual((model, source), ("custom-model", "custom"))
        self.assertEqual((float(input_rate), float(cached_rate), float(output_rate)), (1e-7, 0.25, 6.0))
        self.assertEqual(custom_row.index("custom", len(model)), header.index("Source"))
        for row in rows:
            self.assertEqual(len(row), len(header), row)
        self.fetcher.assert_not_called()

    def test_show_and_sync_help_exit_zero(self) -> None:
        for argv in (["pricing", "show", "--help"], ["pricing", "sync", "--help"]):
            with self.subTest(argv=argv):
                buffer = io.StringIO()
                with (
                    contextlib.redirect_stdout(buffer),
                    self.assertRaises(SystemExit) as raised,
                ):
                    cli.main(argv)

                self.assertEqual(raised.exception.code, 0)
                help_text = buffer.getvalue()
                for option in ("--repo", "--config", "--json"):
                    self.assertIn(option, help_text)
                if "sync" in argv:
                    self.assertIn("--force", help_text)


if __name__ == "__main__":
    unittest.main()
