"""Thread-safe reference implementation of the retry policy adapter."""

import time
from collections.abc import Callable
from threading import Lock
from types import TracebackType
from typing import Self

from .base import ResultT, RetryPolicyAdapter
from .errors import InvalidConfigError, NotOpenError, RetryExhaustedError


class RetryPolicy(RetryPolicyAdapter):
    """Double the delay from 0.1 seconds up to 60 seconds between retries."""

    name: str = "retry_policy"
    _INITIAL_DELAY = 0.1
    _MAX_DELAY = 60.0

    def __init__(
        self,
        max_attempts: int,
        *,
        sleep: Callable[[float], None] = time.sleep,
    ) -> None:
        if (
            not isinstance(max_attempts, int)
            or isinstance(max_attempts, bool)
            or max_attempts < 1
        ):
            raise InvalidConfigError("max_attempts must be a positive integer")
        if not callable(sleep):
            raise InvalidConfigError("sleep must be callable")
        self._max_attempts = max_attempts
        self._sleep = sleep
        self._is_open = False
        self._lock = Lock()

    def open(self) -> None:
        with self._lock:
            self._is_open = True

    def close(self) -> None:
        with self._lock:
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

    def call(self, operation: Callable[[], ResultT]) -> ResultT:
        with self._lock:
            if not self._is_open:
                raise NotOpenError(f"{self.name} is closed")

        delay = self._INITIAL_DELAY
        last_error: Exception | None = None
        for attempt in range(1, self._max_attempts + 1):
            try:
                return operation()
            except Exception as error:
                last_error = error

            if attempt < self._max_attempts:
                self._sleep(delay)
                delay = min(delay * 2, self._MAX_DELAY)

        raise RetryExhaustedError(
            f"{self.name} exhausted {self._max_attempts} attempts"
        ) from last_error
