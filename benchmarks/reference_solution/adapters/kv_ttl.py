"""Thread-safe reference implementation of the TTL key-value adapter."""

from collections.abc import Callable
from sys import float_info
from threading import Lock
from time import monotonic
from types import TracebackType
from typing import Self

from .base import KVTTLAdapter, ValueT
from .errors import CapacityExceededError, InvalidConfigError, KeyMissingError, NotOpenError


class KVTTL(KVTTLAdapter[ValueT]):
    """Store values with per-entry expiry and a shared TTL."""

    name: str = "kv_ttl"

    def __init__(
        self, capacity: int, ttl: float, *, clock: Callable[[], float] = monotonic
    ) -> None:
        if not isinstance(capacity, int) or isinstance(capacity, bool) or capacity < 1:
            raise InvalidConfigError("capacity must be a positive integer")
        if (
            not isinstance(ttl, (int, float))
            or isinstance(ttl, bool)
            or not 0 < ttl <= float_info.max
        ):
            raise InvalidConfigError("ttl must be a finite positive number")
        if not callable(clock):
            raise InvalidConfigError("clock must be callable")
        self._capacity = capacity
        self._ttl = ttl
        self._clock = clock
        self._entries: dict[str, tuple[ValueT, float]] = {}
        self._is_open = False
        self._lock = Lock()

    def open(self) -> None:
        with self._lock:
            self._is_open = True

    def close(self) -> None:
        with self._lock:
            self._entries.clear()
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
            now = self._clock()
            if len(self._entries) >= self._capacity and key not in self._entries:
                self._discard_expired(now)
                if len(self._entries) >= self._capacity:
                    raise CapacityExceededError(f"capacity of {self._capacity} keys reached")
            self._entries[key] = (value, now + self._ttl)

    def get(self, key: str) -> ValueT:
        with self._lock:
            self._require_open()
            return self._live_value(key, self._clock())

    def delete(self, key: str) -> None:
        with self._lock:
            self._require_open()
            self._live_value(key, self._clock())
            del self._entries[key]

    def _live_value(self, key: str, now: float) -> ValueT:
        """Return a live value, discarding the entry once it has expired."""
        try:
            value, expires_at = self._entries[key]
        except KeyError:
            raise KeyMissingError(key) from None
        if now >= expires_at:
            del self._entries[key]
            raise KeyMissingError(key)
        return value

    def _discard_expired(self, now: float) -> None:
        """Drop every entry that is no longer live at the given time."""
        expired = [key for key, (_, expires_at) in self._entries.items() if now >= expires_at]
        for key in expired:
            del self._entries[key]

    def _require_open(self) -> None:
        """Check the lifecycle while holding the adapter lock."""
        if not self._is_open:
            raise NotOpenError(f"{self.name} is closed")
