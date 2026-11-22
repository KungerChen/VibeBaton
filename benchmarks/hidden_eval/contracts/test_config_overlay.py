"""Behavioral contract for the target's configuration overlay adapter."""

import unittest
from collections import UserDict
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
from importlib import import_module
from threading import Barrier
from types import MappingProxyType

from benchmarks.hidden_eval._target import load_target


class TestConfigOverlayContract(unittest.TestCase):
    def setUp(self) -> None:
        self.adapters = load_target()
        module = import_module(".config_overlay", self.adapters.__name__)
        self.ConfigOverlay = module.ConfigOverlay

    def test_operations_require_open(self) -> None:
        config = self.ConfigOverlay({"alpha": 1}, {})

        with self.assertRaises(self.adapters.NotOpenError):
            config.get("alpha")
        with self.assertRaises(self.adapters.NotOpenError):
            config.snapshot()

    def test_overlay_precedence_and_missing_keys(self) -> None:
        base = MappingProxyType({"alpha": 1, "shared": "base", "nullable": "base"})
        overlay = UserDict({"shared": "overlay", "beta": 2, "nullable": None})

        with self.ConfigOverlay(base, overlay) as config:
            self.assertEqual(config.get("alpha"), 1)
            self.assertEqual(config.get("shared"), "overlay")
            self.assertEqual(config.get("beta"), 2)
            self.assertIsNone(config.get("nullable"))
            self.assertEqual(
                config.snapshot(),
                {"alpha": 1, "shared": "overlay", "beta": 2, "nullable": None},
            )
            with self.assertRaises(self.adapters.KeyMissingError):
                config.get("missing")

    def test_nested_layers_merge_without_mutating_inputs(self) -> None:
        base = {
            "database": {"host": "localhost", "pool": {"size": 4, "timeout": 30}},
            "items": [1, 2],
        }
        overlay = {
            "database": {"port": 5432, "pool": {"size": 8}},
            "items": [3],
        }
        original_base = deepcopy(base)
        original_overlay = deepcopy(overlay)
        expected_database = {
            "host": "localhost",
            "port": 5432,
            "pool": {"size": 8, "timeout": 30},
        }

        with self.ConfigOverlay(base, overlay) as config:
            self.assertEqual(config.get("database"), expected_database)
            self.assertEqual(config.snapshot(), {"database": expected_database, "items": [3]})

        self.assertEqual(base, original_base)
        self.assertEqual(overlay, original_overlay)

    def test_mapping_and_leaf_type_conflicts_are_rejected(self) -> None:
        conflicts = (
            ({"database": {"host": "localhost"}}, {"database": "sqlite"}),
            ({"database": "sqlite"}, {"database": {"host": "localhost"}}),
            ({"database": {"pool": {"size": 4}}}, {"database": {"pool": 8}}),
        )
        for base, overlay in conflicts:
            with self.subTest(base=base, overlay=overlay):
                with self.assertRaises(self.adapters.InvalidConfigError):
                    self.ConfigOverlay(base, overlay)

    def test_empty_layers_are_valid(self) -> None:
        with self.ConfigOverlay({}, {}) as config:
            self.assertEqual(config.snapshot(), {})
            with self.assertRaises(self.adapters.KeyMissingError):
                config.get("missing")

    def test_invalid_mapping_inputs(self) -> None:
        for invalid in (None, [("key", "value")], "config", 3):
            with self.subTest(base=invalid):
                with self.assertRaises(self.adapters.InvalidConfigError):
                    self.ConfigOverlay(invalid, {})
            with self.subTest(overlay=invalid):
                with self.assertRaises(self.adapters.InvalidConfigError):
                    self.ConfigOverlay({}, invalid)

    def test_configuration_keys_must_be_strings(self) -> None:
        for key in (1, None, 1.5, b"bytes"):
            with self.subTest(key=key):
                with self.assertRaises(self.adapters.InvalidConfigError):
                    self.ConfigOverlay({key: "value"}, {})
                with self.assertRaises(self.adapters.InvalidConfigError):
                    self.ConfigOverlay({}, {key: "value"})
                with self.assertRaises(self.adapters.InvalidConfigError):
                    self.ConfigOverlay({"nested": {key: "value"}}, {})
                with self.assertRaises(self.adapters.InvalidConfigError):
                    self.ConfigOverlay({}, {"nested": {key: "value"}})

    def test_constructor_copies_configuration_containers(self) -> None:
        base = {"database": {"host": "localhost"}}
        overlay = {"features": [{"enabled": True}]}
        config = self.ConfigOverlay(base, overlay)
        base["database"]["host"] = "remote"
        base.clear()
        overlay["features"][0]["enabled"] = False
        overlay.clear()

        with config:
            self.assertEqual(
                config.snapshot(),
                {"database": {"host": "localhost"}, "features": [{"enabled": True}]},
            )

    def test_get_and_snapshot_return_independent_containers(self) -> None:
        expected = {"database": {"host": "localhost", "ports": [5432]}}
        with self.ConfigOverlay(deepcopy(expected), {}) as config:
            first = config.snapshot()
            second = config.snapshot()
            self.assertIsInstance(first, dict)
            first["database"]["ports"].append(6000)
            first.clear()
            config.get("database")["host"] = "remote"

            self.assertEqual(second, expected)
            self.assertEqual(config.snapshot(), expected)
            self.assertEqual(config.get("database"), expected["database"])

    def test_close_is_idempotent_and_reopen_keeps_configuration(self) -> None:
        config = self.ConfigOverlay({"alpha": 1}, {"beta": 2})
        self.addCleanup(config.close)
        config.close()
        config.open()
        config.open()
        self.assertEqual(config.snapshot(), {"alpha": 1, "beta": 2})

        config.close()
        config.close()
        self.assertIs(config.health()["open"], False)
        with self.assertRaises(self.adapters.NotOpenError):
            config.get("alpha")
        with self.assertRaises(self.adapters.NotOpenError):
            config.snapshot()

        config.open()
        self.assertEqual(config.snapshot(), {"alpha": 1, "beta": 2})

    def test_context_manager_closes_on_exception(self) -> None:
        config = self.ConfigOverlay({"alpha": 1}, {})
        self.assertEqual(config.name, "config_overlay")
        self.assertIsInstance(config, self.adapters.ConfigOverlayAdapter)
        closed_status = config.health()
        self.assertIs(closed_status["open"], False)

        with self.assertRaisesRegex(RuntimeError, "context failure"):
            with config as opened:
                self.assertIs(opened, config)
                self.assertIs(config.health()["open"], True)
                self.assertIs(closed_status["open"], False)
                raise RuntimeError("context failure")

        self.assertIs(config.health()["open"], False)

    def test_concurrent_reads_get_independent_snapshots(self) -> None:
        workers = 12
        start = Barrier(workers, timeout=10)
        base = {"nested": {"value": 7}, "shared": "base"}
        overlay = {"nested": {"enabled": True}, "shared": "overlay"}
        expected = {"nested": {"value": 7, "enabled": True}, "shared": "overlay"}

        with self.ConfigOverlay(base, overlay) as config:
            def read(index: int) -> dict[str, object]:
                start.wait()
                self.assertEqual(config.get("nested"), expected["nested"])
                snapshot = config.snapshot()
                snapshot["nested"]["value"] = index
                return snapshot

            with ThreadPoolExecutor(max_workers=workers) as pool:
                snapshots = list(pool.map(read, range(workers)))

            for index, snapshot in enumerate(snapshots):
                self.assertEqual(
                    snapshot,
                    {"nested": {"value": index, "enabled": True}, "shared": "overlay"},
                )
            self.assertEqual(config.snapshot(), expected)
