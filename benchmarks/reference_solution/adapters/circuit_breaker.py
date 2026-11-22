"""Thread-safe reference implementation of the circuit breaker adapter."""

from collections.abc import Callable
from math import inf, isfinite, nextafter
from threading import Lock
from time import monotonic
from types import TracebackType
from typing import Self

from .base import CircuitBreakerAdapter, ResultT
from .errors import CircuitOpenError, InvalidConfigError, NotOpenError


class CircuitBreaker(CircuitBreakerAdapter):
    """Trip after consecutive failures and probe recovery after a cooldown."""

    name: str = "circuit_breaker"

    def __init__(
        self,
        failure_threshold: int,
        recovery_timeout: float,
        *,
        clock: Callable[[], float] = monotonic,
    ) -> None:
        if (
            not isinstance(failure_threshold, int)
            or isinstance(failure_threshold, bool)
            or failure_threshold < 1
        ):
            raise InvalidConfigError("failure_threshold must be a positive integer")
        timeout_error = "recovery_timeout must be a positive finite number"
        if (
            not isinstance(recovery_timeout, (int, float))
            or isinstance(recovery_timeout, bool)
        ):
            raise InvalidConfigError(timeout_error)
        try:
            timeout = float(recovery_timeout)
        except OverflowError as error:
            raise InvalidConfigError(timeout_error) from error
        if not isfinite(timeout) or timeout <= 0:
            raise InvalidConfigError(timeout_error)
        if not callable(clock):
            raise InvalidConfigError("clock must be callable")

        self._failure_threshold = failure_threshold
        self._recovery_timeout = timeout
        self._clock = clock
        self._is_open = False
        self._generation = 0
        self._failures = 0
        self._retry_at: float | None = None
        self._probe_in_flight = False
        self._lock = Lock()

    def open(self) -> None:
        with self._lock:
            self._is_open = True

    def close(self) -> None:
        with self._lock:
            if not self._is_open:
                return
            self._is_open = False
            # Invalidate completions from calls admitted before this close.
            self._generation += 1
            self._failures = 0
            self._retry_at = None
            self._probe_in_flight = False

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

    def call(self, operation: Callable[[], ResultT]) -> ResultT:
        generation, probe = self._admit()
        try:
            result = operation()
        except Exception:
            self._record_failure(generation, probe)
            raise
        except BaseException:
            if probe:
                with self._lock:
                    if generation == self._generation:
                        self._probe_in_flight = False
            raise
        self._record_success(generation, probe)
        return result

    def _admit(self) -> tuple[int, bool]:
        """Capture the state generation and reserve the probe slot when needed."""
        with self._lock:
            if not self._is_open:
                raise NotOpenError(f"{self.name} is closed")
            if self._retry_at is None:
                return self._generation, False
            if self._probe_in_flight:
                raise CircuitOpenError(f"{self.name} is probing recovery")
            if self._clock() < self._retry_at:
                raise CircuitOpenError(f"{self.name} is cooling down")
            self._probe_in_flight = True
            return self._generation, True

    def _record_success(self, generation: int, probe: bool) -> None:
        with self._lock:
            if generation != self._generation:
                return
            if probe:
                self._retry_at = None
                self._probe_in_flight = False
            self._failures = 0

    def _record_failure(self, generation: int, probe: bool) -> None:
        with self._lock:
            if generation != self._generation:
                return
            if not probe:
                self._failures += 1
                if self._failures < self._failure_threshold:
                    return
                # Calls admitted before the trip cannot change the recovered state.
                self._generation += 1
            now = self._clock()
            # A positive cooldown must advance even below the clock's float precision.
            self._retry_at = max(now + self._recovery_timeout, nextafter(now, inf))
            self._probe_in_flight = False
