"""Behavioral contract for the target's circuit breaker adapter."""

import unittest
from concurrent.futures import ThreadPoolExecutor
from importlib import import_module
from math import ulp
from threading import Barrier, Event

from benchmarks.hidden_eval._target import load_target


class _ManualClock:
    def __init__(self) -> None:
        self._now = 100.0

    def __call__(self) -> float:
        return self._now

    def advance(self, seconds: float) -> None:
        self._now += seconds


def _fail_operation() -> None:
    raise ValueError("operation failed")


class TestCircuitBreakerContract(unittest.TestCase):
    def setUp(self) -> None:
        self.adapters = load_target()
        module = import_module(".circuit_breaker", self.adapters.__name__)
        self.CircuitBreaker = module.CircuitBreaker

    def test_operations_require_open(self) -> None:
        breaker = self.CircuitBreaker(1, 5.0)
        calls: list[None] = []

        with self.assertRaises(self.adapters.NotOpenError):
            breaker.call(lambda: calls.append(None))
        self.assertEqual(calls, [])

    def test_invalid_configuration(self) -> None:
        for failure_threshold in (0, -1, True, 1.0):
            with self.subTest(failure_threshold=failure_threshold):
                with self.assertRaises(self.adapters.InvalidConfigError):
                    self.CircuitBreaker(failure_threshold, 1.0)

        for recovery_timeout in (0, -1, True, float("inf"), float("nan"), 10**400):
            with self.subTest(recovery_timeout=recovery_timeout):
                with self.assertRaises(self.adapters.InvalidConfigError):
                    self.CircuitBreaker(1, recovery_timeout)

        with self.assertRaises(self.adapters.InvalidConfigError):
            self.CircuitBreaker(1, 1.0, clock=None)

    def test_threshold_blocks_calls_until_the_cooldown_boundary(self) -> None:
        clock = _ManualClock()
        failure = ValueError("operation failed")

        def fail() -> None:
            raise failure

        with self.CircuitBreaker(2, 5.1, clock=clock) as breaker:
            for _ in range(2):
                with self.assertRaises(ValueError) as caught:
                    breaker.call(fail)
                self.assertIs(caught.exception, failure)

            self.assertIs(breaker.health()["open"], True)
            with self.assertRaises(self.adapters.CircuitOpenError):
                breaker.call(self.fail)

            breaker.open()
            clock.advance(4.5)
            with self.assertRaises(self.adapters.CircuitOpenError):
                breaker.call(self.fail)

            clock.advance(0.6)
            marker = object()
            self.assertIs(breaker.call(lambda: marker), marker)
            with self.assertRaises(ValueError):
                breaker.call(_fail_operation)
            self.assertEqual(breaker.call(lambda: "admitted"), "admitted")

    def test_success_resets_consecutive_failure_count(self) -> None:
        clock = _ManualClock()
        with self.CircuitBreaker(2, 5.0, clock=clock) as breaker:
            with self.assertRaises(ValueError):
                breaker.call(_fail_operation)
            self.assertEqual(breaker.call(lambda: "ok"), "ok")
            with self.assertRaises(ValueError):
                breaker.call(_fail_operation)
            self.assertEqual(breaker.call(lambda: "admitted"), "admitted")

    def test_short_positive_cooldown_requires_the_clock_to_advance(self) -> None:
        clock = _ManualClock()
        clock_increment = ulp(clock())
        with self.CircuitBreaker(1, clock_increment / 4, clock=clock) as breaker:
            with self.assertRaises(ValueError):
                breaker.call(_fail_operation)
            with self.assertRaises(self.adapters.CircuitOpenError):
                breaker.call(self.fail)

            clock.advance(clock_increment)
            self.assertEqual(breaker.call(lambda: "probe"), "probe")

    def test_half_open_probe_rejects_other_calls(self) -> None:
        clock = _ManualClock()
        started = Event()
        release = Event()

        def probe() -> str:
            started.set()
            self.assertTrue(release.wait(10))
            return "probe result"

        with self.CircuitBreaker(1, 5.0, clock=clock) as breaker:
            with self.assertRaises(ValueError):
                breaker.call(_fail_operation)
            clock.advance(5.0)

            with ThreadPoolExecutor(max_workers=2) as pool:
                admitted = pool.submit(breaker.call, probe)
                try:
                    self.assertTrue(started.wait(10))
                    rejected = pool.submit(breaker.call, self.fail)
                    with self.assertRaises(self.adapters.CircuitOpenError):
                        rejected.result(timeout=10)
                finally:
                    release.set()
                self.assertEqual(admitted.result(timeout=10), "probe result")

            self.assertEqual(breaker.call(lambda: "admitted"), "admitted")

    def test_failed_probe_restarts_cooldown_from_its_failure(self) -> None:
        clock = _ManualClock()

        def fail_probe() -> None:
            clock.advance(2.0)
            raise ValueError("probe failed")

        with self.CircuitBreaker(1, 5.0, clock=clock) as breaker:
            with self.assertRaises(ValueError):
                breaker.call(_fail_operation)

            clock.advance(5.0)
            with self.assertRaises(ValueError):
                breaker.call(fail_probe)

            clock.advance(4.5)
            with self.assertRaises(self.adapters.CircuitOpenError):
                breaker.call(self.fail)

            clock.advance(0.5)
            self.assertEqual(breaker.call(lambda: "recovered"), "recovered")

    def test_interrupted_probe_can_be_retried(self) -> None:
        clock = _ManualClock()
        interruption = KeyboardInterrupt()

        def interrupt() -> None:
            raise interruption

        with self.CircuitBreaker(1, 5.0, clock=clock) as breaker:
            with self.assertRaises(ValueError):
                breaker.call(_fail_operation)
            clock.advance(5.0)

            with self.assertRaises(KeyboardInterrupt) as caught:
                breaker.call(interrupt)
            self.assertIs(caught.exception, interruption)
            self.assertEqual(breaker.call(lambda: "next probe"), "next probe")
            self.assertEqual(breaker.call(lambda: "admitted"), "admitted")

    def test_base_exception_does_not_count_as_failure(self) -> None:
        clock = _ManualClock()

        def interrupt() -> None:
            raise SystemExit()

        with self.CircuitBreaker(1, 5.0, clock=clock) as breaker:
            with self.assertRaises(SystemExit):
                breaker.call(interrupt)
            self.assertEqual(breaker.call(lambda: "admitted"), "admitted")

    def test_close_is_idempotent_and_reopen_resets_state(self) -> None:
        clock = _ManualClock()
        breaker = self.CircuitBreaker(1, 5.0, clock=clock)
        self.addCleanup(breaker.close)
        breaker.close()
        breaker.open()

        with self.assertRaises(ValueError):
            breaker.call(_fail_operation)
        with self.assertRaises(self.adapters.CircuitOpenError):
            breaker.call(self.fail)

        breaker.close()
        breaker.close()
        self.assertIs(breaker.health()["open"], False)
        with self.assertRaises(self.adapters.NotOpenError):
            breaker.call(self.fail)

        breaker.open()
        self.assertEqual(breaker.call(lambda: "fresh session"), "fresh session")

    def test_context_manager_closes_on_exception(self) -> None:
        breaker = self.CircuitBreaker(1, 5.0)
        self.assertEqual(breaker.name, "circuit_breaker")
        self.assertIsInstance(breaker, self.adapters.CircuitBreakerAdapter)
        closed_status = breaker.health()
        self.assertIs(closed_status["open"], False)

        with self.assertRaisesRegex(RuntimeError, "context failure"):
            with breaker as opened:
                self.assertIs(opened, breaker)
                self.assertIs(breaker.health()["open"], True)
                self.assertIs(closed_status["open"], False)
                raise RuntimeError("context failure")

        self.assertIs(breaker.health()["open"], False)

    def test_concurrent_failures_trip_circuit(self) -> None:
        clock = _ManualClock()
        threshold = 3
        workers = 9
        start = Barrier(workers, timeout=10)

        with self.CircuitBreaker(threshold, 5.0, clock=clock) as breaker:
            def run(index: int) -> bool:
                def fail() -> None:
                    raise ValueError(f"failure {index}")

                start.wait()
                try:
                    breaker.call(fail)
                except ValueError:
                    return True
                except self.adapters.CircuitOpenError:
                    return False
                self.fail("the failing operation returned")

            with ThreadPoolExecutor(max_workers=workers) as pool:
                failures = list(pool.map(run, range(workers)))

            self.assertGreaterEqual(sum(failures), threshold)
            with self.assertRaises(self.adapters.CircuitOpenError):
                breaker.call(self.fail)

    def test_late_failure_cannot_trip_a_new_session(self) -> None:
        clock = _ManualClock()
        started = Event()
        release = Event()
        failure = ValueError("previous session failed")

        def fail_after_reopen() -> None:
            started.set()
            self.assertTrue(release.wait(10))
            raise failure

        with self.CircuitBreaker(1, 5.0, clock=clock) as breaker:
            with ThreadPoolExecutor(max_workers=1) as pool:
                old_call = pool.submit(breaker.call, fail_after_reopen)
                try:
                    self.assertTrue(started.wait(10))
                    breaker.close()
                    breaker.open()
                finally:
                    release.set()
                with self.assertRaises(ValueError) as caught:
                    old_call.result(timeout=10)
                self.assertIs(caught.exception, failure)

            self.assertEqual(breaker.call(lambda: "fresh session"), "fresh session")

    def test_late_failure_cannot_trip_the_recovered_circuit(self) -> None:
        clock = _ManualClock()
        started = Event()
        release = Event()

        def fail_after_recovery() -> None:
            started.set()
            self.assertTrue(release.wait(10))
            raise ValueError("admitted before trip")

        with self.CircuitBreaker(1, 5.0, clock=clock) as breaker:
            with ThreadPoolExecutor(max_workers=1) as pool:
                old_call = pool.submit(breaker.call, fail_after_recovery)
                try:
                    self.assertTrue(started.wait(10))
                    with self.assertRaises(ValueError):
                        breaker.call(_fail_operation)
                    clock.advance(5.0)
                    self.assertEqual(breaker.call(lambda: "probe"), "probe")
                finally:
                    release.set()
                with self.assertRaisesRegex(ValueError, "admitted before trip"):
                    old_call.result(timeout=10)

            self.assertEqual(breaker.call(lambda: "recovered"), "recovered")
