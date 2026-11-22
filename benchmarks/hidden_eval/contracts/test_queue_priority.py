"""Behavioral contract for the target's priority queue adapter."""

import unittest
from concurrent.futures import ThreadPoolExecutor
from importlib import import_module
from threading import Barrier

from benchmarks.hidden_eval._target import load_target


class TestQueuePriorityContract(unittest.TestCase):
    def setUp(self) -> None:
        self.adapters = load_target()
        self.queue_priority = import_module(f"{self.adapters.__name__}.queue_priority")

    def test_operations_require_open(self) -> None:
        queue = self.queue_priority.QueuePriority(capacity=1)

        with self.assertRaises(self.adapters.NotOpenError):
            queue.enqueue("item", priority=1)
        with self.assertRaises(self.adapters.NotOpenError):
            queue.dequeue()

    def test_dequeue_from_empty_queue(self) -> None:
        with self.queue_priority.QueuePriority(capacity=1) as queue:
            with self.assertRaises(self.adapters.KeyMissingError):
                queue.dequeue()

    def test_lowest_priority_number_is_dequeued_first(self) -> None:
        with self.queue_priority.QueuePriority(capacity=3) as queue:
            queue.enqueue("positive", priority=3)
            queue.enqueue("negative", priority=-5)
            queue.enqueue("zero", priority=0)

            self.assertEqual(queue.dequeue(), "negative")
            self.assertEqual(queue.dequeue(), "zero")
            self.assertEqual(queue.dequeue(), "positive")
            with self.assertRaises(self.adapters.KeyMissingError):
                queue.dequeue()

    def test_equal_priorities_preserve_insertion_order(self) -> None:
        with self.queue_priority.QueuePriority(capacity=3) as queue:
            for item in ("zebra", "apple", "pear"):
                queue.enqueue(item, priority=2)

            self.assertEqual(queue.dequeue(), "zebra")
            self.assertEqual(queue.dequeue(), "apple")
            self.assertEqual(queue.dequeue(), "pear")

    def test_arbitrary_items_are_ordered_by_priority(self) -> None:
        with self.queue_priority.QueuePriority(capacity=3) as queue:
            items = ({"id": 1}, {"id": 2}, None)
            queue.enqueue(items[0], priority=1)
            queue.enqueue(items[1], priority=1)
            queue.enqueue(items[2], priority=0)

            self.assertIs(queue.dequeue(), items[2])
            self.assertIs(queue.dequeue(), items[0])
            self.assertIs(queue.dequeue(), items[1])

    def test_capacity_rejects_new_items_and_dequeue_releases_a_slot(self) -> None:
        with self.queue_priority.QueuePriority(capacity=2) as queue:
            queue.enqueue("first", priority=2)
            queue.enqueue("second", priority=1)

            with self.assertRaises(self.adapters.CapacityExceededError):
                queue.enqueue("third", priority=0)

            self.assertEqual(queue.dequeue(), "second")
            queue.enqueue("third", priority=0)
            self.assertEqual(queue.dequeue(), "third")
            self.assertEqual(queue.dequeue(), "first")
            with self.assertRaises(self.adapters.KeyMissingError):
                queue.dequeue()

    def test_invalid_capacity(self) -> None:
        for capacity in (0, -1, True, 1.5):
            with self.subTest(capacity=capacity):
                with self.assertRaises(self.adapters.InvalidConfigError):
                    self.queue_priority.QueuePriority(capacity=capacity)

    def test_close_is_idempotent_and_reopen_starts_empty(self) -> None:
        queue = self.queue_priority.QueuePriority(capacity=1)
        self.addCleanup(queue.close)
        queue.close()
        queue.open()
        queue.enqueue("item", priority=1)
        queue.open()
        self.assertEqual(queue.dequeue(), "item")

        queue.enqueue("item", priority=1)
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
        queue = self.queue_priority.QueuePriority(capacity=1)
        self.assertEqual(queue.name, "queue_priority")
        self.assertIsInstance(queue, self.adapters.QueuePriorityAdapter)
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

        with self.queue_priority.QueuePriority(capacity=capacity) as queue:
            def enqueue(index: int) -> bool:
                start.wait()
                try:
                    queue.enqueue(str(index), priority=index)
                except self.adapters.CapacityExceededError:
                    return False
                return True

            with ThreadPoolExecutor(max_workers=workers) as pool:
                accepted = list(pool.map(enqueue, range(workers)))

            self.assertEqual(sum(accepted), capacity)
            queued = [
                str(index) for index, was_accepted in enumerate(accepted) if was_accepted
            ]
            self.assertEqual([queue.dequeue() for _ in range(capacity)], queued)
            with self.assertRaises(self.adapters.KeyMissingError):
                queue.dequeue()

    def test_concurrent_dequeues_return_each_item_once(self) -> None:
        items = list(range(4))
        workers = 12
        start = Barrier(workers, timeout=10)
        empty = object()

        with self.queue_priority.QueuePriority(capacity=len(items)) as queue:
            for item in items:
                queue.enqueue(item, priority=0)

            def dequeue(_: int) -> object:
                start.wait()
                try:
                    return queue.dequeue()
                except self.adapters.KeyMissingError:
                    return empty

            with ThreadPoolExecutor(max_workers=workers) as pool:
                dequeued = list(pool.map(dequeue, range(workers)))

            self.assertCountEqual(dequeued, items + [empty] * (workers - len(items)))
