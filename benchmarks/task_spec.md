# Implement the resource adapters

Complete the ten adapters in your copy of the starter repository using the
Python 3.11 standard library.

| Module | Concrete class | Abstract interface in `adapters.base` |
| --- | --- | --- |
| `adapters/kv_memory.py` | `KVMemory` | `KVMemoryAdapter` |
| `adapters/kv_ttl.py` | `KVTTL` | `KVTTLAdapter` |
| `adapters/queue_fifo.py` | `QueueFIFO` | `QueueFIFOAdapter` |
| `adapters/queue_priority.py` | `QueuePriority` | `QueuePriorityAdapter` |
| `adapters/rate_limiter.py` | `RateLimiter` | `RateLimiterAdapter` |
| `adapters/cache_lru.py` | `CacheLRU` | `CacheLRUAdapter` |
| `adapters/event_bus.py` | `EventBus` | `EventBusAdapter` |
| `adapters/retry_policy.py` | `RetryPolicy` | `RetryPolicyAdapter` |
| `adapters/circuit_breaker.py` | `CircuitBreaker` | `CircuitBreakerAdapter` |
| `adapters/config_overlay.py` | `ConfigOverlay` | `ConfigOverlayAdapter` |

Subclass the listed interface and set each adapter's `name` to its module
basename. Preserve the public signatures and behaviors in `adapters/base.py`,
including the shared lifecycle, context manager, configuration bounds, and
operation-specific errors. Raise the shared exception classes from
`adapters/errors.py`. Keep both contract files as provided.

Add each concrete class to the package exports in `adapters/__init__.py`,
including `__all__`, so callers can import it from `adapters`. Keep the
submission self-contained and use public tests for development and verification.

Add public `unittest` tests under `tests/`. From your repository root, run

```sh
python -m unittest discover -s tests -v
```
