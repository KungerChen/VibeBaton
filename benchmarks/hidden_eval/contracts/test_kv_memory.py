"""Behavioral contract for the target's bounded memory adapter."""

import unittest
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier

from benchmarks.hidden_eval._target import load_target


class TestKVMemoryContract(unittest.TestCase):
    def setUp(self) -> None:
        self.adapters = load_target()

    def test_operations_require_open(self) -> None:
        memory = self.adapters.KVMemory(capacity=1)

        with self.assertRaises(self.adapters.NotOpenError):
            memory.set("key", "value")
        with self.assertRaises(self.adapters.NotOpenError):
            memory.get("key")
        with self.assertRaises(self.adapters.NotOpenError):
            memory.delete("key")

    def test_lookup_and_delete_of_missing_keys(self) -> None:
        with self.adapters.KVMemory(capacity=1) as memory:
            with self.assertRaises(self.adapters.KeyMissingError):
                memory.get("missing")
            with self.assertRaises(self.adapters.KeyMissingError):
                memory.delete("missing")

            value = object()
            memory.set("key", value)
            self.assertIs(memory.get("key"), value)
            memory.delete("key")
            with self.assertRaises(self.adapters.KeyMissingError):
                memory.get("key")

    def test_capacity_rejects_new_keys_and_delete_releases_a_slot(self) -> None:
        with self.adapters.KVMemory(capacity=2) as memory:
            memory.set("first", 1)
            memory.set("second", 2)

            with self.assertRaises(self.adapters.CapacityExceededError):
                memory.set("third", 3)
            self.assertEqual(memory.get("first"), 1)
            self.assertEqual(memory.get("second"), 2)
            with self.assertRaises(self.adapters.KeyMissingError):
                memory.get("third")

            memory.delete("first")
            memory.set("third", 3)
            self.assertEqual(memory.get("third"), 3)

    def test_overwrite_reuses_existing_slot_at_capacity(self) -> None:
        with self.adapters.KVMemory(capacity=1) as memory:
            memory.set("key", "old")
            memory.set("key", None)

            self.assertIsNone(memory.get("key"))
            with self.assertRaises(self.adapters.CapacityExceededError):
                memory.set("another", "value")

    def test_invalid_capacity(self) -> None:
        for capacity in (0, -1, True, 1.5):
            with self.subTest(capacity=capacity):
                with self.assertRaises(self.adapters.InvalidConfigError):
                    self.adapters.KVMemory(capacity=capacity)

    def test_close_is_idempotent_and_reopen_starts_empty(self) -> None:
        memory = self.adapters.KVMemory(capacity=1)
        self.addCleanup(memory.close)
        memory.close()
        memory.open()
        memory.set("key", "value")
        memory.open()
        self.assertEqual(memory.get("key"), "value")

        memory.close()
        memory.close()
        self.assertIs(memory.health()["open"], False)
        with self.assertRaises(self.adapters.NotOpenError):
            memory.get("key")

        memory.open()
        self.assertIs(memory.health()["open"], True)
        with self.assertRaises(self.adapters.KeyMissingError):
            memory.get("key")

    def test_context_manager_closes_on_exception(self) -> None:
        memory = self.adapters.KVMemory(capacity=1)
        self.assertEqual(memory.name, "kv_memory")
        self.assertIsInstance(memory, self.adapters.KVMemoryAdapter)
        closed_status = memory.health()
        self.assertIs(closed_status["open"], False)

        with self.assertRaisesRegex(RuntimeError, "context failure"):
            with memory as opened:
                self.assertIs(opened, memory)
                self.assertIs(memory.health()["open"], True)
                self.assertIs(closed_status["open"], False)
                raise RuntimeError("context failure")

        self.assertIs(memory.health()["open"], False)

    def test_concurrent_insertions_respect_capacity(self) -> None:
        capacity = 4
        workers = 12
        start = Barrier(workers, timeout=10)

        with self.adapters.KVMemory(capacity=capacity) as memory:
            def insert(index: int) -> bool:
                key = str(index)
                start.wait()
                try:
                    memory.set(key, index)
                except self.adapters.CapacityExceededError:
                    return False
                self.assertEqual(memory.get(key), index)
                return True

            with ThreadPoolExecutor(max_workers=workers) as pool:
                inserted = list(pool.map(insert, range(workers)))

            self.assertEqual(sum(inserted), capacity)
            for index, accepted in enumerate(inserted):
                if accepted:
                    self.assertEqual(memory.get(str(index)), index)
                else:
                    with self.assertRaises(self.adapters.KeyMissingError):
                        memory.get(str(index))
