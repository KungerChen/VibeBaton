"""Behavioral contract for the target's retry policy adapter."""

import unittest
from concurrent.futures import ThreadPoolExecutor
from importlib import import_module
from math import isfinite
from threading import Barrier, Lock

from benchmarks.hidden_eval._target import load_target


class TestRetryPolicyContract(unittest.TestCase):
    def setUp(self) -> None:
        self.adapters = load_target()
        module = import_module(".retry_policy", self.adapters.__name__)
        self.RetryPolicy = module.RetryPolicy

    def test_operations_require_open(self) -> None:
        policy = self.RetryPolicy(max_attempts=2, sleep=self.fail)
        calls: list[None] = []

        with self.assertRaises(self.adapters.NotOpenError):
            policy.call(lambda: calls.append(None))
        self.assertEqual(calls, [])

    def test_first_success_returns_the_operation_result(self) -> None:
        calls = 0
        marker = object()
        delays: list[float] = []

        def operation() -> object:
            nonlocal calls
            calls += 1
            return marker

        with self.RetryPolicy(max_attempts=3, sleep=delays.append) as policy:
            self.assertIs(policy.call(operation), marker)
            self.assertEqual(calls, 1)
            self.assertEqual(delays, [])

    def test_operation_can_succeed_on_the_last_attempt(self) -> None:
        attempts = 0
        delays: list[float] = []

        def operation() -> None:
            nonlocal attempts
            attempts += 1
            if attempts < 3:
                raise ValueError(f"failure {attempts}")

        with self.RetryPolicy(max_attempts=3, sleep=delays.append) as policy:
            self.assertIsNone(policy.call(operation))
            self.assertEqual(attempts, 3)
            self.assertEqual(len(delays), 2)

    def test_exhaustion_chains_the_last_failure_and_waits_between_attempts(self) -> None:
        for max_attempts in (1, 4, 1026):
            with self.subTest(max_attempts=max_attempts):
                failures: list[ValueError] = []
                waits: list[tuple[int, float]] = []

                def operation() -> None:
                    error = ValueError(f"failure {len(failures) + 1}")
                    failures.append(error)
                    raise error

                def record_sleep(delay: float) -> None:
                    waits.append((len(failures), delay))

                with self.RetryPolicy(max_attempts=max_attempts, sleep=record_sleep) as policy:
                    with self.assertRaises(self.adapters.RetryExhaustedError) as caught:
                        policy.call(operation)

                self.assertEqual(len(failures), max_attempts)
                self.assertIs(caught.exception.__cause__, failures[-1])
                self.assertEqual([attempt for attempt, _ in waits], list(range(1, max_attempts)))
                delays = [delay for _, delay in waits]
                self.assertTrue(all(isfinite(delay) and delay > 0 for delay in delays))
                self.assertEqual(delays, sorted(delays))

    def test_each_call_gets_a_fresh_attempt_budget(self) -> None:
        attempts = 0
        delays: list[float] = []

        def operation() -> str:
            nonlocal attempts
            attempts += 1
            if attempts < 4:
                raise ValueError(f"failure {attempts}")
            return "recovered"

        with self.RetryPolicy(max_attempts=2, sleep=delays.append) as policy:
            with self.assertRaises(self.adapters.RetryExhaustedError):
                policy.call(operation)
            self.assertEqual(attempts, 2)

            self.assertEqual(policy.call(operation), "recovered")
            self.assertEqual(attempts, 4)
            self.assertEqual(len(delays), 2)
            self.assertEqual(delays[0], delays[1])

    def test_base_exceptions_propagate_without_retrying(self) -> None:
        for error in (KeyboardInterrupt(), SystemExit()):
            with self.subTest(error=type(error).__name__):
                calls = 0
                delays: list[float] = []

                def operation() -> None:
                    nonlocal calls
                    calls += 1
                    raise error

                with self.RetryPolicy(max_attempts=3, sleep=delays.append) as policy:
                    with self.assertRaises(type(error)) as caught:
                        policy.call(operation)

                self.assertIs(caught.exception, error)
                self.assertEqual(calls, 1)
                self.assertEqual(delays, [])

    def test_invalid_max_attempts(self) -> None:
        for max_attempts in (0, -1, True, 1.0, "2"):
            with self.subTest(max_attempts=max_attempts):
                with self.assertRaises(self.adapters.InvalidConfigError):
                    self.RetryPolicy(max_attempts=max_attempts)

    def test_invalid_sleep_callback(self) -> None:
        with self.assertRaises(self.adapters.InvalidConfigError):
            self.RetryPolicy(max_attempts=1, sleep=None)

    def test_close_is_idempotent_and_reopen_preserves_configuration(self) -> None:
        policy = self.RetryPolicy(max_attempts=2, sleep=self.fail)
        self.addCleanup(policy.close)
        policy.close()
        policy.open()
        policy.open()
        self.assertIs(policy.health()["open"], True)
        self.assertEqual(policy.call(lambda: "open"), "open")

        policy.close()
        policy.close()
        self.assertIs(policy.health()["open"], False)
        with self.assertRaises(self.adapters.NotOpenError):
            policy.call(self.fail)

        policy.open()
        self.assertEqual(policy.call(lambda: "reopened"), "reopened")

    def test_context_manager_closes_on_exception(self) -> None:
        policy = self.RetryPolicy(max_attempts=1)
        self.assertEqual(policy.name, "retry_policy")
        self.assertIsInstance(policy, self.adapters.RetryPolicyAdapter)
        closed_status = policy.health()
        self.assertIs(closed_status["open"], False)

        with self.assertRaisesRegex(RuntimeError, "context failure"):
            with policy as opened:
                self.assertIs(opened, policy)
                self.assertIs(policy.health()["open"], True)
                self.assertIs(closed_status["open"], False)
                raise RuntimeError("context failure")

        self.assertIs(policy.health()["open"], False)

    def test_concurrent_calls_keep_independent_budgets(self) -> None:
        max_attempts = 3
        workers = 8
        start = Barrier(workers, timeout=10)
        delay_lock = Lock()
        delays: list[float] = []

        def record_sleep(delay: float) -> None:
            with delay_lock:
                delays.append(delay)

        with self.RetryPolicy(max_attempts=max_attempts, sleep=record_sleep) as policy:
            def run(index: int) -> tuple[int, int]:
                attempts = 0

                def operation() -> int:
                    nonlocal attempts
                    attempts += 1
                    if attempts < max_attempts:
                        raise ValueError(f"failure {index}")
                    return index

                start.wait()
                result = policy.call(operation)
                return result, attempts

            with ThreadPoolExecutor(max_workers=workers) as pool:
                results = list(pool.map(run, range(workers)))

        self.assertEqual(results, [(index, max_attempts) for index in range(workers)])
        self.assertEqual(len(delays), workers * (max_attempts - 1))
