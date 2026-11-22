"""Thread-safe reference implementation of the memory adapter."""

from threading import Lock
from types import TracebackType
from typing import Self

from .base import KVMemoryAdapter, ValueT
from .errors import CapacityExceededError, InvalidConfigError, KeyMissingError, NotOpenError


class KVMemory(KVMemoryAdapter[ValueT]):
    """Store values in a bounded dictionary protected by one lock."""

    name: str = "kv_memory"

    def __init__(self, capacity: int) -> None:
        if not isinstance(capacity, int) or isinstance(capacity, bool) or capacity < 1:
            raise InvalidConfigError("capacity must be a positive integer")
        self._capacity = capacity
        self._values: dict[str, ValueT] = {}
        self._is_open = False
        self._lock = Lock()

    def open(self) -> None:
        with self._lock:
            self._is_open = True

    def close(self) -> None:
        with self._lock:
            self._values.clear()
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

    def set(self, key: str, value: ValueT) -> None:
        with self._lock:
            self._require_open()
            if len(self._values) >= self._capacity and key not in self._values:
                raise CapacityExceededError(f"capacity of {self._capacity} keys reached")
            self._values[key] = value

    def get(self, key: str) -> ValueT:
        with self._lock:
            self._require_open()
            try:
                return self._values[key]
            except KeyError:
                raise KeyMissingError(key) from None

    def delete(self, key: str) -> None:
        with self._lock:
            self._require_open()
            try:
                del self._values[key]
            except KeyError:
                raise KeyMissingError(key) from None

    def _require_open(self) -> None:
        """Check the lifecycle while holding the adapter lock."""
        if not self._is_open:
            raise NotOpenError(f"{self.name} is closed")
