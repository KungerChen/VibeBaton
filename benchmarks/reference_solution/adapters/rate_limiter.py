"""Thread-safe reference implementation of the token-bucket rate limiter."""

from collections.abc import Callable
from fractions import Fraction
from math import isfinite
from threading import RLock
from time import monotonic
from types import TracebackType
from typing import Self

from .base import RateLimiterAdapter
from .errors import InvalidConfigError, NotOpenError, RateLimitedError


class RateLimiter(RateLimiterAdapter):
    """Refill a bounded token bucket from an injectable monotonic clock."""

    name: str = "rate_limiter"

    def __init__(
        self,
        capacity: int,
        refill_rate: float,
        *,
        clock: Callable[[], float] = monotonic,
    ) -> None:
        if not isinstance(capacity, int) or isinstance(capacity, bool) or capacity < 1:
            raise InvalidConfigError("capacity must be a positive integer")
        if not isinstance(refill_rate, (int, float)) or isinstance(refill_rate, bool):
            raise InvalidConfigError("refill_rate must be a finite positive number")
        if refill_rate <= 0:
            raise InvalidConfigError("refill_rate must be a finite positive number")
        if isinstance(refill_rate, float) and not isfinite(refill_rate):
            raise InvalidConfigError("refill_rate must be a finite positive number")
        if not callable(clock):
            raise InvalidConfigError("clock must be callable")

        self._capacity = capacity
        # Exact fractions keep failed attempts from changing future refills.
        self._refill_rate = Fraction(refill_rate)
        self._clock = clock
        self._tokens: Fraction = Fraction(0)
        self._last_refill: Fraction = Fraction(0)
        self._is_open = False
        # The injected clock can read health while the bucket is locked.
        self._lock = RLock()

    def open(self) -> None:
        with self._lock:
            if self._is_open:
                return
            self._tokens = Fraction(self._capacity)
            self._last_refill = Fraction(self._clock())
            self._is_open = True

    def close(self) -> None:
        with self._lock:
            self._tokens = Fraction(0)
            self._last_refill = Fraction(0)
            self._is_open = False

    def health(self) -> dict[str, object]:
        with self._lock:
            return {"open": self._is_open}

    def __enter__(self) -> Self:
        self.open()
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc_value: BaseException | None,
        traceback: TracebackType | None,
    ) -> None:
        self.close()

    def acquire(self) -> None:
        with self._lock:
            self._require_open()
            # Convert at read time so timestamp subtraction stays exact.
            now = Fraction(self._clock())
            elapsed = now - self._last_refill
            if elapsed > 0:
                self._tokens = min(
                    Fraction(self._capacity),
                    self._tokens + elapsed * self._refill_rate,
                )
                self._last_refill = now
            if self._tokens < 1:
                raise RateLimitedError(f"{self.name} has no token available")
            self._tokens -= 1

    def _require_open(self) -> None:
        """Check the lifecycle while holding the adapter lock."""
        if not self._is_open:
            raise NotOpenError(f"{self.name} is closed")
