"""Public adapter interfaces, exceptions, and reference implementations."""

from .base import (
    CacheLRUAdapter,
    CircuitBreakerAdapter,
    ConfigOverlayAdapter,
    EventBusAdapter,
    KVMemoryAdapter,
    KVTTLAdapter,
    QueueFIFOAdapter,
    QueuePriorityAdapter,
    RateLimiterAdapter,
    ResourceAdapter,
    RetryPolicyAdapter,
)
from .cache_lru import CacheLRU
from .circuit_breaker import CircuitBreaker
from .config_overlay import ConfigOverlay
from .errors import (
    AdapterError,
    CapacityExceededError,
    CircuitOpenError,
    InvalidConfigError,
    KeyMissingError,
    NotOpenError,
    RateLimitedError,
    RetryExhaustedError,
)
from .event_bus import EventBus
from .kv_memory import KVMemory
from .kv_ttl import KVTTL
from .queue_fifo import QueueFIFO
from .queue_priority import QueuePriority
from .rate_limiter import RateLimiter
from .retry_policy import RetryPolicy

__all__ = [
    "ResourceAdapter",
    "KVMemoryAdapter",
    "KVTTLAdapter",
    "QueueFIFOAdapter",
    "QueuePriorityAdapter",
    "RateLimiterAdapter",
    "CacheLRUAdapter",
    "EventBusAdapter",
    "RetryPolicyAdapter",
    "CircuitBreakerAdapter",
    "ConfigOverlayAdapter",
    "AdapterError",
    "NotOpenError",
    "CapacityExceededError",
    "KeyMissingError",
    "RateLimitedError",
    "CircuitOpenError",
    "RetryExhaustedError",
    "InvalidConfigError",
    "KVMemory",
    "KVTTL",
    "QueueFIFO",
    "QueuePriority",
    "RateLimiter",
    "CacheLRU",
    "EventBus",
    "RetryPolicy",
    "CircuitBreaker",
    "ConfigOverlay",
]
