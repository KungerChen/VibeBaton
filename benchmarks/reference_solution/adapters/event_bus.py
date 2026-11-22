"""Thread-safe reference implementation of the synchronous event bus."""

from collections.abc import Callable
from threading import Lock
from types import TracebackType
from typing import Self

from .base import EventBusAdapter, ValueT
from .errors import KeyMissingError, NotOpenError


class EventBus(EventBusAdapter[ValueT]):
    """Dispatch events synchronously to ordered topic subscriptions.

    Subscription IDs increase for the lifetime of the instance, including
    across close and reopen cycles.
    """

    name: str = "event_bus"

    def __init__(self) -> None:
        self._subscriptions: dict[
            str, list[tuple[int, Callable[[ValueT], None]]]
        ] = {}
        self._topic_by_id: dict[int, str] = {}
        self._next_id = 1
        self._is_open = False
        self._lock = Lock()

    def open(self) -> None:
        with self._lock:
            self._is_open = True

    def close(self) -> None:
        with self._lock:
            subscriptions = self._subscriptions
            self._subscriptions = {}
            self._topic_by_id.clear()
            self._is_open = False
        # Handler finalizers may call back into the bus.
        del subscriptions

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

    def subscribe(self, topic: str, handler: Callable[[ValueT], None]) -> int:
        with self._lock:
            self._require_open()
            subscription_id = self._next_id
            self._next_id += 1
            self._topic_by_id[subscription_id] = topic
            self._subscriptions.setdefault(topic, []).append(
                (subscription_id, handler)
            )
            return subscription_id

    def unsubscribe(self, subscription_id: int) -> None:
        with self._lock:
            self._require_open()
            try:
                topic = self._topic_by_id.pop(subscription_id)
            except KeyError:
                raise KeyMissingError(subscription_id) from None
            previous_entries = self._subscriptions[topic]
            entries = [
                entry
                for entry in previous_entries
                if entry[0] != subscription_id
            ]
            if entries:
                self._subscriptions[topic] = entries
            else:
                del self._subscriptions[topic]
        del previous_entries

    def publish(self, topic: str, event: ValueT) -> None:
        with self._lock:
            self._require_open()
            handlers = [
                handler for _, handler in self._subscriptions.get(topic, ())
            ]
        for handler in handlers:
            handler(event)

    def _require_open(self) -> None:
        """Check the lifecycle while holding the adapter lock."""
        if not self._is_open:
            raise NotOpenError(f"{self.name} is closed")
