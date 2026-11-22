"""Behavioral contract for the target's synchronous event bus adapter."""

import os
import subprocess
import sys
import unittest
from concurrent.futures import ThreadPoolExecutor
from importlib import import_module
from pathlib import Path
from threading import Barrier

from benchmarks.hidden_eval._target import TARGET_ENV, load_target

SNAPSHOT_SCENARIO = """
from importlib import import_module

from benchmarks.hidden_eval._target import load_target

load_target()
event_bus = import_module("adapters.event_bus")

received = []
second_id = [0]
unsubscribed = [False]
bus = event_bus.EventBus()
bus.open()


def first(event):
    received.append(("first", event))
    if not unsubscribed[0]:
        bus.unsubscribe(second_id[0])
        unsubscribed[0] = True


def second(event):
    received.append(("second", event))


bus.subscribe("topic", first)
second_id[0] = bus.subscribe("topic", second)
bus.publish("topic", 1)
if received != [("first", 1), ("second", 1)]:
    raise AssertionError(received)
bus.publish("topic", 2)
if received != [("first", 1), ("second", 1), ("first", 2)]:
    raise AssertionError(received)
bus.close()
"""

HANDLER_FINALIZER_SCENARIO = """
from gc import collect
from importlib import import_module
from sys import argv
from unittest import TestCase
from weakref import finalize

from benchmarks.hidden_eval._target import load_target

adapters = load_target()
check = TestCase()
bus = import_module("adapters.event_bus").EventBus()
bus.open()
operation = argv[1]
observed = []
received = []


class Handler:
    def __call__(self, event: object) -> None:
        raise AssertionError("released handler received an event")


def observe_bus() -> None:
    observed.append(bus.health()["open"])


handler = Handler()
finalize(handler, observe_bus)
subscription_id = bus.subscribe("topic", handler)
del handler
check.assertEqual(observed, [])
if operation == "unsubscribe_with_peer":
    bus.subscribe("topic", received.append)

if operation == "close":
    bus.close()
else:
    bus.unsubscribe(subscription_id)

collect()
check.assertEqual(observed, [operation != "close"])
if operation == "close":
    bus.open()
with check.assertRaises(adapters.KeyMissingError):
    bus.unsubscribe(subscription_id)
bus.publish("topic", "event")
check.assertEqual(received, ["event"] if operation == "unsubscribe_with_peer" else [])
bus.close()
"""


class TestEventBusContract(unittest.TestCase):
    def setUp(self) -> None:
        self.adapters = load_target()
        self.event_bus = import_module("adapters.event_bus")

    def test_operations_require_open(self) -> None:
        bus = self.event_bus.EventBus()

        with self.assertRaises(self.adapters.NotOpenError):
            bus.subscribe("topic", lambda event: None)
        with self.assertRaises(self.adapters.NotOpenError):
            bus.unsubscribe(1)
        with self.assertRaises(self.adapters.NotOpenError):
            bus.publish("topic", "event")

    def test_publish_calls_handlers_in_subscription_order_for_exact_topic(
        self,
    ) -> None:
        received = []
        with self.event_bus.EventBus() as bus:
            first_id = bus.subscribe(
                "topic", lambda event: received.append(("first", event))
            )
            second_id = bus.subscribe(
                "topic", lambda event: received.append(("second", event))
            )
            bus.subscribe(
                "other", lambda event: received.append(("other", event))
            )

            event = object()
            bus.publish("topic", event)
            self.assertEqual(received, [("first", event), ("second", event)])
            self.assertIs(received[0][1], event)

            bus.publish("unobserved", event)
            self.assertEqual(received, [("first", event), ("second", event)])

            self.assertIsInstance(first_id, int)
            self.assertIsInstance(second_id, int)
            self.assertNotEqual(first_id, second_id)

    def test_unsubscribe_removes_only_the_requested_subscription(self) -> None:
        received = []
        with self.event_bus.EventBus() as bus:
            first_id = bus.subscribe("topic", lambda event: received.append("first"))
            second_id = bus.subscribe(
                "topic", lambda event: received.append("second")
            )
            third_id = bus.subscribe("topic", lambda event: received.append("third"))

            bus.unsubscribe(second_id)
            bus.publish("topic", "event")
            self.assertEqual(received, ["first", "third"])

            with self.assertRaises(self.adapters.KeyMissingError):
                bus.unsubscribe(second_id)
            with self.assertRaises(self.adapters.KeyMissingError):
                bus.unsubscribe(max(first_id, second_id, third_id) + 1)

    def test_publish_uses_a_snapshot_of_subscriptions(self) -> None:
        self._run_scenario(
            SNAPSHOT_SCENARIO,
            "publish did not return after a handler unsubscribed",
        )

    def test_handler_finalizers_can_read_bus_health(self) -> None:
        for operation in ("unsubscribe_last", "unsubscribe_with_peer", "close"):
            with self.subTest(operation=operation):
                self._run_scenario(
                    HANDLER_FINALIZER_SCENARIO,
                    f"event bus stalled during {operation} as a handler finalized",
                    operation,
                )

    def _run_scenario(self, scenario: str, timeout_message: str, *args: str) -> None:
        repo_root = Path(__file__).resolve().parents[3]
        env = os.environ.copy()
        target = env.get(TARGET_ENV)
        if target is not None:
            env[TARGET_ENV] = str(Path(target).resolve())
        python_path = env.get("PYTHONPATH")
        env["PYTHONPATH"] = (
            str(repo_root)
            if not python_path
            else str(repo_root) + os.pathsep + python_path
        )

        try:
            completed = subprocess.run(
                [sys.executable, "-c", scenario, *args],
                cwd=repo_root,
                env=env,
                capture_output=True,
                text=True,
                timeout=10,
            )
        except subprocess.TimeoutExpired:
            raise self.failureException(timeout_message) from None

        self.assertEqual(
            completed.returncode,
            0,
            f"stdout: {completed.stdout}\nstderr: {completed.stderr}",
        )

    def test_handler_exception_propagates_and_stops_delivery(self) -> None:
        received = []

        class HandlerError(Exception):
            pass

        failure = HandlerError("handler failure")
        with self.event_bus.EventBus() as bus:
            def failing(event: object) -> None:
                raise failure

            failed_id = bus.subscribe("topic", failing)
            bus.subscribe("topic", lambda event: received.append(event))

            with self.assertRaises(HandlerError) as raised:
                bus.publish("topic", "event")
            self.assertIs(raised.exception, failure)
            self.assertEqual(received, [])
            self.assertIs(bus.health()["open"], True)

            with self.assertRaises(HandlerError):
                bus.publish("topic", "again")
            self.assertEqual(received, [])

            bus.unsubscribe(failed_id)
            bus.publish("topic", "recovered")
            self.assertEqual(received, ["recovered"])

    def test_close_is_idempotent_and_reopen_starts_without_subscriptions(
        self,
    ) -> None:
        bus = self.event_bus.EventBus()
        self.addCleanup(bus.close)
        received = []
        bus.open()
        subscription_id = bus.subscribe("topic", received.append)
        bus.open()
        bus.publish("topic", "preserved")
        self.assertEqual(received, ["preserved"])
        received.clear()

        bus.close()
        bus.close()
        self.assertIs(bus.health()["open"], False)
        with self.assertRaises(self.adapters.NotOpenError):
            bus.publish("topic", "event")
        with self.assertRaises(self.adapters.NotOpenError):
            bus.subscribe("topic", received.append)
        with self.assertRaises(self.adapters.NotOpenError):
            bus.unsubscribe(subscription_id)

        bus.open()
        self.assertIs(bus.health()["open"], True)
        bus.publish("topic", "event")
        self.assertEqual(received, [])
        with self.assertRaises(self.adapters.KeyMissingError):
            bus.unsubscribe(subscription_id)

        new_id = bus.subscribe("topic", received.append)
        self.assertNotEqual(new_id, subscription_id)
        with self.assertRaises(self.adapters.KeyMissingError):
            bus.unsubscribe(subscription_id)
        bus.publish("topic", "event")
        self.assertEqual(received, ["event"])

        bus.unsubscribe(new_id)
        with self.assertRaises(self.adapters.KeyMissingError):
            bus.unsubscribe(new_id)

    def test_context_manager_closes_on_exception(self) -> None:
        bus = self.event_bus.EventBus()
        self.assertEqual(bus.name, "event_bus")
        self.assertIsInstance(bus, self.adapters.EventBusAdapter)
        closed_status = bus.health()
        self.assertIs(closed_status["open"], False)

        with self.assertRaisesRegex(RuntimeError, "context failure"):
            with bus as opened:
                self.assertIs(opened, bus)
                self.assertIs(bus.health()["open"], True)
                self.assertIs(closed_status["open"], False)
                raise RuntimeError("context failure")

        self.assertIs(bus.health()["open"], False)

    def test_concurrent_subscriptions_receive_one_publish(self) -> None:
        workers = 12
        calls = []
        start = Barrier(workers, timeout=10)

        with self.event_bus.EventBus() as bus:
            def register(index: int) -> int:
                start.wait()
                return bus.subscribe(
                    "topic", lambda event: calls.append(index)
                )

            with ThreadPoolExecutor(max_workers=workers) as pool:
                subscription_ids = list(pool.map(register, range(workers)))

            self.assertEqual(len(set(subscription_ids)), workers)
            bus.publish("topic", "event")
            self.assertCountEqual(calls, list(range(workers)))
