"""Thread-safe reference implementation of the FIFO queue adapter."""

from collections import deque
from threading import Lock
from types import TracebackType
from typing import Self

from .base import QueueFIFOAdapter, ValueT
from .errors import CapacityExceededError, InvalidConfigError, KeyMissingError, NotOpenError


class QueueFIFO(QueueFIFOAdapter[ValueT]):
    """Append items to the back and remove the oldest from the front."""

    name: str = "queue_fifo"

    def __init__(self, capacity: int) -> None:
        if not isinstance(capacity, int) or isinstance(capacity, bool) or capacity < 1:
            raise InvalidConfigError("capacity must be a positive integer")
        self._capacity = capacity
        self._items: deque[ValueT] = deque()
        self._is_open = False
        self._lock = Lock()

    def open(self) -> None:
        with self._lock:
            self._is_open = True

    def close(self) -> None:
        with self._lock:
            self._items.clear()
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

    def enqueue(self, item: ValueT) -> None:
        with self._lock:
            self._require_open()
            if len(self._items) >= self._capacity:
                raise CapacityExceededError(f"capacity of {self._capacity} items reached")
            self._items.append(item)

    def dequeue(self) -> ValueT:
        with self._lock:
            self._require_open()
            try:
                return self._items.popleft()
            except IndexError:
                raise KeyMissingError("queue is empty") from None

    def _require_open(self) -> None:
        """Check the lifecycle while holding the adapter lock."""
        if not self._is_open:
            raise NotOpenError(f"{self.name} is closed")
