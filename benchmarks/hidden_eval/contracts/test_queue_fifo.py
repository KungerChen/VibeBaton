"""Behavioral contract for the target's FIFO queue adapter."""

import unittest
from concurrent.futures import ThreadPoolExecutor
from importlib import import_module
from threading import Barrier

from benchmarks.hidden_eval._target import load_target


class TestQueueFIFOContract(unittest.TestCase):
    def setUp(self) -> None:
        self.adapters = load_target()
        self.queue_fifo = import_module(f"{self.adapters.__name__}.queue_fifo")

    def test_operations_require_open(self) -> None:
        queue = self.queue_fifo.QueueFIFO(capacity=1)

        with self.assertRaises(self.adapters.NotOpenError):
            queue.enqueue("item")
        with self.assertRaises(self.adapters.NotOpenError):
            queue.dequeue()

    def test_dequeue_from_empty_queue(self) -> None:
        with self.queue_fifo.QueueFIFO(capacity=1) as queue:
            with self.assertRaises(self.adapters.KeyMissingError):
                queue.dequeue()

    def test_fifo_order_returns_oldest_item_first(self) -> None:
        first = object()
        items = (first, None, first, object())
        with self.queue_fifo.QueueFIFO(capacity=len(items)) as queue:
            for item in items:
                queue.enqueue(item)

            for item in items:
                self.assertIs(queue.dequeue(), item)
            with self.assertRaises(self.adapters.KeyMissingError):
                queue.dequeue()

    def test_capacity_rejects_new_items_and_dequeue_releases_a_slot(self) -> None:
        with self.queue_fifo.QueueFIFO(capacity=2) as queue:
            queue.enqueue("first")
            queue.enqueue("second")

            with self.assertRaises(self.adapters.CapacityExceededError):
                queue.enqueue("third")
            self.assertEqual(queue.dequeue(), "first")

            queue.enqueue("third")
            self.assertEqual(queue.dequeue(), "second")
            self.assertEqual(queue.dequeue(), "third")
            with self.assertRaises(self.adapters.KeyMissingError):
                queue.dequeue()

    def test_invalid_capacity(self) -> None:
        for capacity in (0, -1, True, 1.5):
            with self.subTest(capacity=capacity):
                with self.assertRaises(self.adapters.InvalidConfigError):
                    self.queue_fifo.QueueFIFO(capacity=capacity)

    def test_close_is_idempotent_and_reopen_starts_empty(self) -> None:
        queue = self.queue_fifo.QueueFIFO(capacity=1)
        self.addCleanup(queue.close)
        queue.close()
        queue.open()
        queue.enqueue("item")
        queue.open()
        self.assertEqual(queue.dequeue(), "item")

        queue.enqueue("item")
        queue.close()
        queue.close()
        self.assertIs(queue.health()["open"], False)
        with self.assertRaises(self.adapters.NotOpenError):
            queue.dequeue()

        queue.open()
        self.assertIs(queue.health()["open"], True)
        with self.assertRaises(self.adapters.KeyMissingError):
            queue.dequeue()

    def test_context_manager_closes_on_exception(self) -> None:
        queue = self.queue_fifo.QueueFIFO(capacity=1)
        self.assertEqual(queue.name, "queue_fifo")
        self.assertIsInstance(queue, self.adapters.QueueFIFOAdapter)
        closed_status = queue.health()
        self.assertIs(closed_status["open"], False)
        self.assertIsNot(closed_status, queue.health())

        with self.assertRaisesRegex(RuntimeError, "context failure"):
            with queue as opened:
                self.assertIs(opened, queue)
                open_status = queue.health()
                self.assertIs(open_status["open"], True)
                self.assertIsNot(open_status, queue.health())
                self.assertIs(closed_status["open"], False)
                raise RuntimeError("context failure")

        self.assertIs(queue.health()["open"], False)

    def test_concurrent_enqueues_respect_capacity(self) -> None:
        capacity = 4
        workers = 12
        start = Barrier(workers, timeout=10)

        with self.queue_fifo.QueueFIFO(capacity=capacity) as queue:
            def enqueue(index: int) -> bool:
                start.wait()
                try:
                    queue.enqueue(index)
                except self.adapters.CapacityExceededError:
                    return False
                return True

            with ThreadPoolExecutor(max_workers=workers) as pool:
                accepted = list(pool.map(enqueue, range(workers)))

            self.assertEqual(sum(accepted), capacity)
            queued = [index for index, was_accepted in enumerate(accepted) if was_accepted]
            self.assertEqual(sorted(queue.dequeue() for _ in range(capacity)), queued)
            with self.assertRaises(self.adapters.KeyMissingError):
                queue.dequeue()

    def test_concurrent_dequeues_return_each_item_once(self) -> None:
        items = list(range(4))
        workers = 12
        start = Barrier(workers, timeout=10)
        empty = object()

        with self.queue_fifo.QueueFIFO(capacity=len(items)) as queue:
            for item in items:
                queue.enqueue(item)

            def dequeue(_: int) -> object:
                start.wait()
                try:
                    return queue.dequeue()
                except self.adapters.KeyMissingError:
                    return empty

            with ThreadPoolExecutor(max_workers=workers) as pool:
                dequeued = list(pool.map(dequeue, range(workers)))

            self.assertCountEqual(dequeued, items + [empty] * (workers - len(items)))
