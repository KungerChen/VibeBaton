"""Behavioral contract for the target's token-bucket rate limiter."""

import os
import subprocess
import sys
import unittest
from concurrent.futures import ThreadPoolExecutor
from importlib import import_module
from pathlib import Path
from threading import Barrier

from benchmarks.hidden_eval._target import DEFAULT_TARGET, TARGET_ENV, load_target

CLOCK_HEALTH_SCENARIO = """
from importlib import import_module
from unittest import TestCase

from benchmarks.hidden_eval._target import load_target

adapters = load_target()
rate_limiter = import_module("adapters.rate_limiter")
limiter = None
now = 0.0


def clock() -> float:
    if limiter is not None:
        limiter.health()
    return now


limiter = rate_limiter.RateLimiter(capacity=1, refill_rate=1.0, clock=clock)
with limiter:
    limiter.acquire()
    with TestCase().assertRaises(adapters.RateLimitedError):
        limiter.acquire()
    now = 1.0
    limiter.acquire()
"""


class TestRateLimiterContract(unittest.TestCase):
    def setUp(self) -> None:
        self.adapters = load_target()
        self.rate_limiter = import_module("adapters.rate_limiter")

    def test_operations_require_open(self) -> None:
        limiter = self.rate_limiter.RateLimiter(capacity=1, refill_rate=1.0)

        with self.assertRaises(self.adapters.NotOpenError):
            limiter.acquire()

    def test_burst_is_limited_then_refills_with_injected_clock(self) -> None:
        now = [0.0]
        limiter = self.rate_limiter.RateLimiter(
            capacity=2, refill_rate=1.0, clock=lambda: now[0]
        )

        with limiter:
            limiter.acquire()
            limiter.acquire()
            with self.assertRaises(self.adapters.RateLimitedError):
                limiter.acquire()

            now[0] = 0.5
            with self.assertRaises(self.adapters.RateLimitedError):
                limiter.acquire()

            now[0] = 1.0
            limiter.acquire()
            with self.assertRaises(self.adapters.RateLimitedError):
                limiter.acquire()

    def test_clock_can_read_health_during_open_and_acquire(self) -> None:
        target = Path(os.environ.get(TARGET_ENV, str(DEFAULT_TARGET))).resolve()
        try:
            completed = subprocess.run(
                [sys.executable, "-c", CLOCK_HEALTH_SCENARIO],
                cwd=Path(__file__).resolve().parents[3],
                env={**os.environ, TARGET_ENV: str(target)},
                capture_output=True,
                text=True,
                timeout=10,
            )
        except subprocess.TimeoutExpired:
            raise self.failureException(
                "limiter stalled when its clock called health()"
            ) from None

        self.assertEqual(completed.returncode, 0, completed.stderr)

    def test_fractional_refill_accumulates_between_attempts(self) -> None:
        now = [0.0]
        limiter = self.rate_limiter.RateLimiter(
            capacity=1, refill_rate=2.0, clock=lambda: now[0]
        )

        with limiter:
            limiter.acquire()

            now[0] = 0.25
            with self.assertRaises(self.adapters.RateLimitedError):
                limiter.acquire()

            now[0] = 0.5
            limiter.acquire()

            now[0] = 0.75
            with self.assertRaises(self.adapters.RateLimitedError):
                limiter.acquire()

            now[0] = 1.0
            limiter.acquire()

    def test_refill_is_capped_at_capacity(self) -> None:
        now = [0.0]
        limiter = self.rate_limiter.RateLimiter(
            capacity=2, refill_rate=1.0, clock=lambda: now[0]
        )

        with limiter:
            limiter.acquire()
            limiter.acquire()

            now[0] = 10.0
            limiter.acquire()
            limiter.acquire()
            with self.assertRaises(self.adapters.RateLimitedError):
                limiter.acquire()

    def test_refill_is_independent_of_failed_attempts(self) -> None:
        now = [0.0]
        limiter = self.rate_limiter.RateLimiter(
            capacity=1, refill_rate=0.1, clock=lambda: now[0]
        )

        with limiter:
            limiter.acquire()
            for second in range(1, 10):
                now[0] = float(second)
                with self.assertRaises(self.adapters.RateLimitedError):
                    limiter.acquire()

            now[0] = 10.0
            limiter.acquire()
            with self.assertRaises(self.adapters.RateLimitedError):
                limiter.acquire()

        now[0] = 0.0
        direct = self.rate_limiter.RateLimiter(
            capacity=1, refill_rate=0.1, clock=lambda: now[0]
        )
        with direct:
            direct.acquire()
            now[0] = 10.0
            direct.acquire()
            with self.assertRaises(self.adapters.RateLimitedError):
                direct.acquire()

    def test_rejected_attempt_does_not_delay_the_next_token(self) -> None:
        now = [0.0]

        direct = self.rate_limiter.RateLimiter(
            capacity=1, refill_rate=1.0, clock=lambda: now[0]
        )
        with direct:
            direct.acquire()
            now[0] = 1.0
            direct.acquire()
            with self.assertRaises(self.adapters.RateLimitedError):
                direct.acquire()

        now[0] = 0.0
        interrupted = self.rate_limiter.RateLimiter(
            capacity=1, refill_rate=1.0, clock=lambda: now[0]
        )
        with interrupted:
            interrupted.acquire()
            now[0] = 0.3
            with self.assertRaises(self.adapters.RateLimitedError):
                interrupted.acquire()
            now[0] = 1.0
            interrupted.acquire()
            with self.assertRaises(self.adapters.RateLimitedError):
                interrupted.acquire()

    def test_invalid_configuration(self) -> None:
        for capacity in (0, -1, True, 1.5):
            with self.subTest(capacity=capacity):
                with self.assertRaises(self.adapters.InvalidConfigError):
                    self.rate_limiter.RateLimiter(
                        capacity=capacity, refill_rate=1.0
                    )

        for refill_rate in (
            0,
            0.0,
            -1,
            -0.5,
            -(10**400),
            True,
            float("inf"),
            float("nan"),
            "1",
        ):
            with self.subTest(refill_rate=refill_rate):
                with self.assertRaises(self.adapters.InvalidConfigError):
                    self.rate_limiter.RateLimiter(
                        capacity=1, refill_rate=refill_rate
                    )

        for clock in (None, 1, "clock"):
            with self.subTest(clock=clock):
                with self.assertRaises(self.adapters.InvalidConfigError):
                    self.rate_limiter.RateLimiter(
                        capacity=1, refill_rate=1.0, clock=clock
                    )

    def test_large_integer_capacity_opens_and_consumes(self) -> None:
        for capacity in (2**54, 10**400):
            with self.subTest(capacity=capacity):
                limiter = self.rate_limiter.RateLimiter(
                    capacity=capacity, refill_rate=1.0, clock=lambda: 0.0
                )

                with limiter:
                    limiter.acquire()
                    limiter.acquire()

    def test_close_is_idempotent_and_reopen_starts_full(self) -> None:
        now = [0.0]
        limiter = self.rate_limiter.RateLimiter(
            capacity=1, refill_rate=1.0, clock=lambda: now[0]
        )
        self.addCleanup(limiter.close)

        limiter.close()
        limiter.open()
        limiter.acquire()
        with self.assertRaises(self.adapters.RateLimitedError):
            limiter.acquire()

        limiter.open()
        with self.assertRaises(self.adapters.RateLimitedError):
            limiter.acquire()

        limiter.close()
        limiter.close()
        self.assertIs(limiter.health()["open"], False)
        with self.assertRaises(self.adapters.NotOpenError):
            limiter.acquire()

        limiter.open()
        self.assertIs(limiter.health()["open"], True)
        limiter.acquire()
        with self.assertRaises(self.adapters.RateLimitedError):
            limiter.acquire()

    def test_context_manager_closes_on_exception(self) -> None:
        limiter = self.rate_limiter.RateLimiter(capacity=1, refill_rate=1.0)
        self.assertEqual(limiter.name, "rate_limiter")
        self.assertIsInstance(limiter, self.adapters.RateLimiterAdapter)
        closed_status = limiter.health()
        self.assertIs(closed_status["open"], False)

        with self.assertRaisesRegex(RuntimeError, "context failure"):
            with limiter as opened:
                self.assertIs(opened, limiter)
                self.assertIs(limiter.health()["open"], True)
                self.assertIs(closed_status["open"], False)
                raise RuntimeError("context failure")

        self.assertIs(limiter.health()["open"], False)

    def test_concurrent_acquires_never_exceed_capacity(self) -> None:
        capacity = 4
        workers = 12
        start = Barrier(workers, timeout=10)
        limiter = self.rate_limiter.RateLimiter(
            capacity=capacity, refill_rate=1.0, clock=lambda: 0.0
        )

        with limiter:
            def acquire(_: int) -> bool:
                start.wait()
                try:
                    limiter.acquire()
                except self.adapters.RateLimitedError:
                    return False
                return True

            with ThreadPoolExecutor(max_workers=workers) as pool:
                acquired = list(pool.map(acquire, range(workers)))

        self.assertEqual(sum(acquired), capacity)
