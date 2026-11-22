"""Thread-safe reference implementation of the priority queue adapter."""

from heapq import heappop, heappush
from threading import Lock
from types import TracebackType
from typing import Self

from .base import QueuePriorityAdapter, ValueT
from .errors import CapacityExceededError, InvalidConfigError, KeyMissingError, NotOpenError


class QueuePriority(QueuePriorityAdapter[ValueT]):
    """Order items by priority, breaking ties with insertion order."""

    name: str = "queue_priority"

    def __init__(self, capacity: int) -> None:
        if not isinstance(capacity, int) or isinstance(capacity, bool) or capacity < 1:
            raise InvalidConfigError("capacity must be a positive integer")
        self._capacity = capacity
        self._entries: list[tuple[int, int, ValueT]] = []
        self._sequence = 0
        self._is_open = False
        self._lock = Lock()

    def open(self) -> None:
        with self._lock:
            self._is_open = True

    def close(self) -> None:
        with self._lock:
            self._entries.clear()
            self._sequence = 0
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

    def enqueue(self, item: ValueT, priority: int) -> None:
        with self._lock:
            self._require_open()
            if len(self._entries) >= self._capacity:
                raise CapacityExceededError(f"capacity of {self._capacity} items reached")
            if not isinstance(priority, int):
                raise TypeError("priority must be an integer")
            heappush(self._entries, (priority, self._sequence, item))
            self._sequence += 1

    def dequeue(self) -> ValueT:
        with self._lock:
            self._require_open()
            try:
                return heappop(self._entries)[2]
            except IndexError:
                raise KeyMissingError("queue is empty") from None

    def _require_open(self) -> None:
        """Check the lifecycle while holding the adapter lock."""
        if not self._is_open:
            raise NotOpenError(f"{self.name} is closed")
