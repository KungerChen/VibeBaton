"""Thread-safe reference implementation of the LRU cache adapter."""

from collections import OrderedDict
from threading import Lock
from types import TracebackType
from typing import Self

from .base import CacheLRUAdapter, ValueT
from .errors import InvalidConfigError, KeyMissingError, NotOpenError


class CacheLRU(CacheLRUAdapter[ValueT]):
    """Store values in a bounded mapping ordered from least to most recent."""

    name: str = "cache_lru"

    def __init__(self, capacity: int) -> None:
        if not isinstance(capacity, int) or isinstance(capacity, bool) or capacity < 1:
            raise InvalidConfigError("capacity must be a positive integer")
        self._capacity = capacity
        self._values: OrderedDict[str, ValueT] = OrderedDict()
        self._is_open = False
        self._lock = Lock()

    def open(self) -> None:
        with self._lock:
            self._is_open = True

    def close(self) -> None:
        with self._lock:
            values = self._values
            self._values = OrderedDict()
            self._is_open = False
        # Dropping a value can run a finalizer that calls back into the cache.
        del values

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
            removed_value: ValueT | None = None
            if key in self._values:
                removed_value = self._values[key]
                self._values.move_to_end(key)
            elif len(self._values) >= self._capacity:
                _, removed_value = self._values.popitem(last=False)
            self._values[key] = value
        del removed_value

    def get(self, key: str) -> ValueT:
        with self._lock:
            self._require_open()
            try:
                value = self._values[key]
            except KeyError:
                raise KeyMissingError(key) from None
            self._values.move_to_end(key)
            return value

    def delete(self, key: str) -> None:
        with self._lock:
            self._require_open()
            try:
                removed_value = self._values.pop(key)
            except KeyError:
                raise KeyMissingError(key) from None
        del removed_value

    def _require_open(self) -> None:
        """Check the lifecycle while holding the adapter lock."""
        if not self._is_open:
            raise NotOpenError(f"{self.name} is closed")
