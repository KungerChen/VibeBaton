"""Behavioral contract for the target's bounded LRU cache adapter."""

import os
import subprocess
import sys
import unittest
from concurrent.futures import ThreadPoolExecutor
from importlib import import_module
from pathlib import Path
from threading import Barrier

from benchmarks.hidden_eval._target import DEFAULT_TARGET, TARGET_ENV, load_target

VALUE_FINALIZER_SCENARIO = """
from gc import collect
from importlib import import_module
from sys import argv
from unittest import TestCase
from weakref import finalize

from benchmarks.hidden_eval._target import load_target

adapters = load_target()
check = TestCase()
cache = import_module("adapters.cache_lru").CacheLRU(capacity=1)
cache.open()
operation = argv[1]
replacement_key = {"evict": "new", "overwrite": "old"}.get(operation)
replacement = object() if replacement_key is not None else None
observed = []


class Value:
    pass


def observe_cache() -> None:
    is_open = cache.health()["open"]
    value = cache.get(replacement_key) if replacement_key is not None else None
    observed.append((is_open, value))


value = Value()
finalize(value, observe_cache)
cache.set("old", value)
del value
check.assertIsInstance(cache.get("old"), Value)

if replacement_key is not None:
    cache.set(replacement_key, replacement)
elif operation == "delete":
    cache.delete("old")
else:
    cache.close()

collect()
check.assertEqual(observed, [(operation != "close", replacement)])
if replacement_key is not None:
    check.assertIs(cache.get(replacement_key), replacement)
if operation == "close":
    cache.open()
if replacement_key != "old":
    with check.assertRaises(adapters.KeyMissingError):
        cache.get("old")
cache.close()
"""


class TestCacheLRUContract(unittest.TestCase):
    def setUp(self) -> None:
        self.adapters = load_target()
        self.cache_lru = import_module("adapters.cache_lru")

    def test_operations_require_open(self) -> None:
        cache = self.cache_lru.CacheLRU(capacity=1)

        with self.assertRaises(self.adapters.NotOpenError):
            cache.set("key", "value")
        with self.assertRaises(self.adapters.NotOpenError):
            cache.get("key")
        with self.assertRaises(self.adapters.NotOpenError):
            cache.delete("key")

    def test_lookup_and_delete_of_missing_keys(self) -> None:
        with self.cache_lru.CacheLRU(capacity=1) as cache:
            with self.assertRaises(self.adapters.KeyMissingError):
                cache.get("missing")
            with self.assertRaises(self.adapters.KeyMissingError):
                cache.delete("missing")

            value = object()
            cache.set("key", value)
            self.assertIs(cache.get("key"), value)
            cache.delete("key")
            with self.assertRaises(self.adapters.KeyMissingError):
                cache.get("key")

    def test_eviction_uses_least_recently_used_order(self) -> None:
        with self.cache_lru.CacheLRU(capacity=2) as cache:
            cache.set("a", 1)
            cache.set("b", 2)
            self.assertEqual(cache.get("a"), 1)

            cache.set("c", 3)
            self.assertEqual(cache.get("a"), 1)
            self.assertEqual(cache.get("c"), 3)
            with self.assertRaises(self.adapters.KeyMissingError):
                cache.get("b")

            self.assertEqual(cache.get("c"), 3)
            cache.set("d", 4)
            with self.assertRaises(self.adapters.KeyMissingError):
                cache.get("a")
            self.assertEqual(cache.get("c"), 3)
            self.assertEqual(cache.get("d"), 4)

    def test_overwrite_promotes_and_does_not_evict(self) -> None:
        with self.cache_lru.CacheLRU(capacity=2) as cache:
            cache.set("a", 1)
            cache.set("b", 2)
            cache.set("a", 10)

            cache.set("c", 3)
            with self.assertRaises(self.adapters.KeyMissingError):
                cache.get("b")
            self.assertEqual(cache.get("a"), 10)
            self.assertEqual(cache.get("c"), 3)

    def test_delete_frees_a_slot(self) -> None:
        with self.cache_lru.CacheLRU(capacity=2) as cache:
            cache.set("a", 1)
            cache.set("b", 2)
            cache.delete("a")
            with self.assertRaises(self.adapters.KeyMissingError):
                cache.delete("a")

            cache.set("c", 3)
            self.assertEqual(cache.get("b"), 2)
            self.assertEqual(cache.get("c"), 3)

    def test_value_finalizers_can_read_committed_cache_state(self) -> None:
        target = Path(os.environ.get(TARGET_ENV, str(DEFAULT_TARGET))).resolve()
        for operation in ("evict", "overwrite", "delete", "close"):
            with self.subTest(operation=operation):
                try:
                    completed = subprocess.run(
                        [sys.executable, "-c", VALUE_FINALIZER_SCENARIO, operation],
                        cwd=Path(__file__).resolve().parents[3],
                        env={**os.environ, TARGET_ENV: str(target)},
                        capture_output=True,
                        text=True,
                        timeout=10,
                    )
                except subprocess.TimeoutExpired:
                    raise self.failureException(
                        f"cache stalled during {operation} as a value finalized"
                    ) from None

                self.assertEqual(completed.returncode, 0, completed.stderr)

    def test_invalid_capacity(self) -> None:
        for capacity in (0, -1, True, 1.5):
            with self.subTest(capacity=capacity):
                with self.assertRaises(self.adapters.InvalidConfigError):
                    self.cache_lru.CacheLRU(capacity=capacity)

    def test_close_is_idempotent_and_reopen_starts_empty(self) -> None:
        cache = self.cache_lru.CacheLRU(capacity=1)
        self.addCleanup(cache.close)
        cache.close()
        cache.open()
        cache.set("key", "value")
        cache.open()
        self.assertEqual(cache.get("key"), "value")

        cache.close()
        cache.close()
        self.assertIs(cache.health()["open"], False)
        with self.assertRaises(self.adapters.NotOpenError):
            cache.get("key")

        cache.open()
        self.assertIs(cache.health()["open"], True)
        with self.assertRaises(self.adapters.KeyMissingError):
            cache.get("key")

    def test_context_manager_closes_on_exception(self) -> None:
        cache = self.cache_lru.CacheLRU(capacity=1)
        self.assertEqual(cache.name, "cache_lru")
        self.assertIsInstance(cache, self.adapters.CacheLRUAdapter)
        closed_status = cache.health()
        self.assertIs(closed_status["open"], False)

        with self.assertRaisesRegex(RuntimeError, "context failure"):
            with cache as opened:
                self.assertIs(opened, cache)
                self.assertIs(cache.health()["open"], True)
                self.assertIs(closed_status["open"], False)
                raise RuntimeError("context failure")

        self.assertIs(cache.health()["open"], False)

    def test_concurrent_insertions_never_exceed_capacity(self) -> None:
        capacity = 4
        workers = 12
        start = Barrier(workers, timeout=10)

        with self.cache_lru.CacheLRU(capacity=capacity) as cache:
            def insert(index: int) -> None:
                start.wait()
                cache.set(str(index), index)

            with ThreadPoolExecutor(max_workers=workers) as pool:
                list(pool.map(insert, range(workers)))

            remaining = 0
            for index in range(workers):
                try:
                    value = cache.get(str(index))
                except self.adapters.KeyMissingError:
                    continue
                self.assertEqual(value, index)
                remaining += 1

            self.assertEqual(remaining, capacity)
