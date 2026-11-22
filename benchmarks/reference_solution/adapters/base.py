"""Public resource adapter contracts for Python 3.11."""

from abc import ABC, abstractmethod
from collections.abc import Callable, Mapping
from time import monotonic
from types import TracebackType
from typing import Generic, Self, TypeVar

ValueT = TypeVar("ValueT")
ResultT = TypeVar("ResultT")


class ResourceAdapter(ABC):
    """Lifecycle shared by all adapters.

    Instances start closed. Adapter operations raise NotOpenError while closed.
    Invalid constructor configuration raises InvalidConfigError. Positive
    integer bounds exclude bool. Clock callbacks return monotonic seconds.
    """

    name: str

    @abstractmethod
    def open(self) -> None:
        """Open the resource. Repeated calls preserve the current session."""
        raise NotImplementedError

    @abstractmethod
    def close(self) -> None:
        """Close the resource and discard session state. Calls are idempotent."""
        raise NotImplementedError

    @abstractmethod
    def health(self) -> dict[str, object]:
        """Return a fresh status dict with a boolean 'open' in either state."""
        raise NotImplementedError

    @abstractmethod
    def __enter__(self) -> Self:
        """Open the resource and return this instance."""
        raise NotImplementedError

    @abstractmethod
    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc_value: BaseException | None,
        traceback: TracebackType | None,
    ) -> None:
        """Close the resource and let any exception from the block propagate."""
        raise NotImplementedError


class KVMemoryAdapter(ResourceAdapter, Generic[ValueT]):
    """Bounded in-memory storage with thread-safe operations and lifecycle."""

    @abstractmethod
    def __init__(self, capacity: int) -> None:
        """Set a positive maximum number of distinct keys."""
        raise NotImplementedError

    @abstractmethod
    def set(self, key: str, value: ValueT) -> None:
        """Store a value by reference, replacing any existing value.

        A new key at capacity raises CapacityExceededError and preserves
        existing entries. Replacing an existing key uses its current slot.
        """
        raise NotImplementedError

    @abstractmethod
    def get(self, key: str) -> ValueT:
        """Return the stored value, or raise KeyMissingError for an absent key."""
        raise NotImplementedError

    @abstractmethod
    def delete(self, key: str) -> None:
        """Remove a key and free its slot, or raise KeyMissingError if absent."""
        raise NotImplementedError


class KVTTLAdapter(ResourceAdapter, Generic[ValueT]):
    """Bounded key-value storage with a shared time to live."""

    @abstractmethod
    def __init__(
        self, capacity: int, ttl: float, *, clock: Callable[[], float] = monotonic
    ) -> None:
        """Set a positive capacity and a finite, positive TTL in seconds."""
        raise NotImplementedError

    @abstractmethod
    def set(self, key: str, value: ValueT) -> None:
        """Store or replace a value and set its expiry to clock() + ttl.

        Only live keys count toward capacity. A new key at capacity raises
        CapacityExceededError. Updating a live key reuses its slot.
        """
        raise NotImplementedError

    @abstractmethod
    def get(self, key: str) -> ValueT:
        """Return a live value, or raise KeyMissingError for an absent key.

        A key is absent from its expiry time onward. Reads preserve expiry.
        """
        raise NotImplementedError

    @abstractmethod
    def delete(self, key: str) -> None:
        """Remove a live key, or raise KeyMissingError if absent or expired."""
        raise NotImplementedError


class QueueFIFOAdapter(ResourceAdapter, Generic[ValueT]):
    """Bounded queue with first-in, first-out ordering."""

    @abstractmethod
    def __init__(self, capacity: int) -> None:
        """Set a positive maximum number of queued items."""
        raise NotImplementedError

    @abstractmethod
    def enqueue(self, item: ValueT) -> None:
        """Append an item, or raise CapacityExceededError when full."""
        raise NotImplementedError

    @abstractmethod
    def dequeue(self) -> ValueT:
        """Remove and return the oldest item, or raise KeyMissingError if empty."""
        raise NotImplementedError


class QueuePriorityAdapter(ResourceAdapter, Generic[ValueT]):
    """Bounded priority queue with FIFO ordering among equal priorities."""

    @abstractmethod
    def __init__(self, capacity: int) -> None:
        """Set a positive maximum number of queued items."""
        raise NotImplementedError

    @abstractmethod
    def enqueue(self, item: ValueT, priority: int) -> None:
        """Add an item with an integer priority.

        Raise CapacityExceededError when full. Items can be arbitrary values.
        """
        raise NotImplementedError

    @abstractmethod
    def dequeue(self) -> ValueT:
        """Remove and return the item with the lowest priority number.

        Resolve ties by insertion order. An empty queue raises KeyMissingError.
        """
        raise NotImplementedError


class RateLimiterAdapter(ResourceAdapter):
    """Token bucket that starts each open session full."""

    @abstractmethod
    def __init__(
        self, capacity: int, refill_rate: float, *, clock: Callable[[], float] = monotonic
    ) -> None:
        """Set a positive token capacity and finite, positive tokens per second."""
        raise NotImplementedError

    @abstractmethod
    def acquire(self) -> None:
        """Refill by elapsed time up to capacity and consume one token.

        Keep fractional refills. Raise RateLimitedError when less than one
        token is available.
        """
        raise NotImplementedError


class CacheLRUAdapter(ResourceAdapter, Generic[ValueT]):
    """Bounded cache with least-recently-used eviction."""

    @abstractmethod
    def __init__(self, capacity: int) -> None:
        """Set a positive maximum number of cached keys."""
        raise NotImplementedError

    @abstractmethod
    def set(self, key: str, value: ValueT) -> None:
        """Store or replace a value and make its key the most recently used.

        Inserting a new key into a full cache evicts the least recently used key.
        """
        raise NotImplementedError

    @abstractmethod
    def get(self, key: str) -> ValueT:
        """Return and promote a value, or raise KeyMissingError if absent."""
        raise NotImplementedError

    @abstractmethod
    def delete(self, key: str) -> None:
        """Remove a cached key, or raise KeyMissingError if absent."""
        raise NotImplementedError


class EventBusAdapter(ResourceAdapter, Generic[ValueT]):
    """Synchronous publish and subscribe by exact topic."""

    @abstractmethod
    def __init__(self) -> None:
        """Create an event bus with no subscriptions."""
        raise NotImplementedError

    @abstractmethod
    def subscribe(self, topic: str, handler: Callable[[ValueT], None]) -> int:
        """Register a handler and return a distinct integer subscription ID."""
        raise NotImplementedError

    @abstractmethod
    def unsubscribe(self, subscription_id: int) -> None:
        """Remove a subscription, or raise KeyMissingError for an unknown ID."""
        raise NotImplementedError

    @abstractmethod
    def publish(self, topic: str, event: ValueT) -> None:
        """Call the topic's handlers in subscription order using a snapshot.

        An unobserved topic succeeds. Propagate the first handler exception
        unchanged and stop delivery of this event at that handler.
        """
        raise NotImplementedError


class RetryPolicyAdapter(ResourceAdapter):
    """Retry a synchronous operation after ordinary exceptions."""

    @abstractmethod
    def __init__(self, max_attempts: int) -> None:
        """Set a positive call limit that includes the first attempt."""
        raise NotImplementedError

    @abstractmethod
    def call(self, operation: Callable[[], ResultT]) -> ResultT:
        """Return the first successful result, retrying on Exception.

        Each call gets its own attempt budget. When exhausted, raise
        RetryExhaustedError chained from the last exception. BaseException
        outside Exception propagates immediately.
        """
        raise NotImplementedError


class CircuitBreakerAdapter(ResourceAdapter):
    """Block calls temporarily after consecutive failures."""

    @abstractmethod
    def __init__(
        self,
        failure_threshold: int,
        recovery_timeout: float,
        *,
        clock: Callable[[], float] = monotonic,
    ) -> None:
        """Set a positive failure threshold and finite, positive cooldown in seconds."""
        raise NotImplementedError

    @abstractmethod
    def call(self, operation: Callable[[], ResultT]) -> ResultT:
        """Return the result of an admitted call, propagating its exception.

        Each session starts admitting calls. Consecutive Exception failures
        trip the circuit at the threshold. A success resets the failure count.
        During cooldown, calls raise CircuitOpenError without invoking the
        operation. At the end of cooldown, admit one probe and reject other
        calls while it runs. A successful probe restores admission. A failed
        probe restarts cooldown. BaseException outside Exception propagates
        without counting as a failure and leaves an interrupted probe eligible
        for another attempt.
        """
        raise NotImplementedError


class ConfigOverlayAdapter(ResourceAdapter, Generic[ValueT]):
    """Read a shallow overlay of top-level configuration keys."""

    @abstractmethod
    def __init__(self, base: Mapping[str, ValueT], overlay: Mapping[str, ValueT]) -> None:
        """Copy both input mappings at construction.

        Non-mapping inputs and non-string keys raise InvalidConfigError.
        """
        raise NotImplementedError

    @abstractmethod
    def get(self, key: str) -> ValueT:
        """Read the overlay value when present, otherwise read the base value.

        Raise KeyMissingError when both mappings lack the key.
        """
        raise NotImplementedError

    @abstractmethod
    def snapshot(self) -> dict[str, ValueT]:
        """Return a fresh shallow dict of the effective configuration."""
        raise NotImplementedError
