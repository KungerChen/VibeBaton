"""Behavioral contract for the target's TTL key-value adapter."""

import unittest
from concurrent.futures import ThreadPoolExecutor
from importlib import import_module
from threading import Barrier

from benchmarks.hidden_eval._target import load_target


class _FakeClock:
    """Report a manually advanced time in seconds."""

    def __init__(self) -> None:
        self.now = 0.0

    def __call__(self) -> float:
        return self.now


class TestKVTTLContract(unittest.TestCase):
    def setUp(self) -> None:
        self.adapters = load_target()
        self.kv_ttl = import_module(f"{self.adapters.__name__}.kv_ttl")
        self.clock = _FakeClock()

    def test_operations_require_open(self) -> None:
        ttl = self.kv_ttl.KVTTL(capacity=1, ttl=1.0)

        with self.assertRaises(self.adapters.NotOpenError):
            ttl.set("key", "value")
        with self.assertRaises(self.adapters.NotOpenError):
            ttl.get("key")
        with self.assertRaises(self.adapters.NotOpenError):
            ttl.delete("key")

    def test_lookup_and_delete_of_missing_keys(self) -> None:
        with self.kv_ttl.KVTTL(capacity=1, ttl=10.0, clock=self.clock) as ttl:
            with self.assertRaises(self.adapters.KeyMissingError):
                ttl.get("missing")
            with self.assertRaises(self.adapters.KeyMissingError):
                ttl.delete("missing")

            value = object()
            ttl.set("key", value)
            self.assertIs(ttl.get("key"), value)
            ttl.delete("key")
            with self.assertRaises(self.adapters.KeyMissingError):
                ttl.get("key")

    def test_capacity_rejects_new_keys_and_delete_releases_a_slot(self) -> None:
        with self.kv_ttl.KVTTL(capacity=2, ttl=10.0, clock=self.clock) as ttl:
            ttl.set("first", 1)
            ttl.set("second", 2)

            with self.assertRaises(self.adapters.CapacityExceededError):
                ttl.set("third", 3)
            self.assertEqual(ttl.get("first"), 1)
            self.assertEqual(ttl.get("second"), 2)
            with self.assertRaises(self.adapters.KeyMissingError):
                ttl.get("third")

            ttl.delete("first")
            ttl.set("third", 3)
            self.assertEqual(ttl.get("third"), 3)

    def test_overwrite_reuses_existing_slot_at_capacity(self) -> None:
        with self.kv_ttl.KVTTL(capacity=1, ttl=10.0, clock=self.clock) as ttl:
            ttl.set("key", "old")
            ttl.set("key", None)

            self.assertIsNone(ttl.get("key"))
            with self.assertRaises(self.adapters.CapacityExceededError):
                ttl.set("another", "value")

    def test_expiry_boundary_with_injected_clock(self) -> None:
        self.clock.now = 100.0
        with self.kv_ttl.KVTTL(capacity=1, ttl=2.5, clock=self.clock) as ttl:
            ttl.set("key", "value")

            self.clock.now = 102.0
            self.assertEqual(ttl.get("key"), "value")

            self.clock.now = 102.5
            with self.assertRaises(self.adapters.KeyMissingError):
                ttl.get("key")

    def test_delete_of_expired_key_raises_key_missing(self) -> None:
        with self.kv_ttl.KVTTL(capacity=1, ttl=10.0, clock=self.clock) as ttl:
            ttl.set("key", "value")

            self.clock.now = 10.0
            with self.assertRaises(self.adapters.KeyMissingError):
                ttl.delete("key")

    def test_refreshing_a_live_key_extends_its_expiry(self) -> None:
        with self.kv_ttl.KVTTL(capacity=1, ttl=10.0, clock=self.clock) as ttl:
            ttl.set("key", "old")
            self.clock.now = 5.0
            ttl.set("key", "new")

            self.clock.now = 14.0
            self.assertEqual(ttl.get("key"), "new")

            self.clock.now = 15.0
            with self.assertRaises(self.adapters.KeyMissingError):
                ttl.get("key")

    def test_expired_keys_release_capacity(self) -> None:
        with self.kv_ttl.KVTTL(capacity=2, ttl=10.0, clock=self.clock) as ttl:
            ttl.set("first", 1)
            self.clock.now = 5.0
            ttl.set("second", 2)
            with self.assertRaises(self.adapters.CapacityExceededError):
                ttl.set("third", 3)

            self.clock.now = 10.0
            ttl.set("third", 3)
            self.assertEqual(ttl.get("second"), 2)
            self.assertEqual(ttl.get("third"), 3)
            with self.assertRaises(self.adapters.KeyMissingError):
                ttl.get("first")

    def test_invalid_capacity(self) -> None:
        for capacity in (0, -1, True, 1.5):
            with self.subTest(capacity=capacity):
                with self.assertRaises(self.adapters.InvalidConfigError):
                    self.kv_ttl.KVTTL(capacity=capacity, ttl=1.0)

    def test_invalid_ttl(self) -> None:
        for ttl in (0, -1.5, True, float("inf"), float("nan"), "1"):
            with self.subTest(ttl=ttl):
                with self.assertRaises(self.adapters.InvalidConfigError):
                    self.kv_ttl.KVTTL(capacity=1, ttl=ttl)

    def test_close_is_idempotent_and_reopen_starts_empty(self) -> None:
        ttl = self.kv_ttl.KVTTL(capacity=1, ttl=10.0, clock=self.clock)
        self.addCleanup(ttl.close)
        ttl.close()
        ttl.open()
        ttl.set("key", "value")
        ttl.open()
        self.assertEqual(ttl.get("key"), "value")

        ttl.close()
        ttl.close()
        self.assertIs(ttl.health()["open"], False)
        with self.assertRaises(self.adapters.NotOpenError):
            ttl.get("key")

        ttl.open()
        self.assertIs(ttl.health()["open"], True)
        with self.assertRaises(self.adapters.KeyMissingError):
            ttl.get("key")

    def test_context_manager_closes_on_exception(self) -> None:
        ttl = self.kv_ttl.KVTTL(capacity=1, ttl=60.0)
        self.assertEqual(ttl.name, "kv_ttl")
        self.assertIsInstance(ttl, self.adapters.KVTTLAdapter)
        closed_status = ttl.health()
        self.assertIs(closed_status["open"], False)
        self.assertIsNot(closed_status, ttl.health())

        with self.assertRaisesRegex(RuntimeError, "context failure"):
            with ttl as opened:
                self.assertIs(opened, ttl)
                open_status = ttl.health()
                self.assertIs(open_status["open"], True)
                self.assertIsNot(open_status, ttl.health())
                self.assertIs(closed_status["open"], False)
                raise RuntimeError("context failure")

        self.assertIs(ttl.health()["open"], False)

    def test_concurrent_insertions_respect_capacity(self) -> None:
        capacity = 4
        workers = 12
        start = Barrier(workers, timeout=10)

        with self.kv_ttl.KVTTL(capacity=capacity, ttl=10.0, clock=self.clock) as ttl:
            def insert(index: int) -> bool:
                key = str(index)
                start.wait()
                try:
                    ttl.set(key, index)
                except self.adapters.CapacityExceededError:
                    return False
                self.assertEqual(ttl.get(key), index)
                return True

            with ThreadPoolExecutor(max_workers=workers) as pool:
                inserted = list(pool.map(insert, range(workers)))

            self.assertEqual(sum(inserted), capacity)
            for index, accepted in enumerate(inserted):
                if accepted:
                    self.assertEqual(ttl.get(str(index)), index)
                else:
                    with self.assertRaises(self.adapters.KeyMissingError):
                        ttl.get(str(index))
