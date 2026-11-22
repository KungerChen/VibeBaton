"""Exceptions shared by all resource adapters."""


class AdapterError(Exception):
    """Base class for adapter contract errors."""


class NotOpenError(AdapterError):
    """An operation requires an open adapter."""


class CapacityExceededError(AdapterError):
    """An insertion would exceed the adapter's capacity."""


class KeyMissingError(AdapterError):
    """A requested key, queue item, or subscription is absent."""


class RateLimitedError(AdapterError):
    """The rate limiter has insufficient tokens."""


class CircuitOpenError(AdapterError):
    """The circuit breaker is blocking calls."""


class RetryExhaustedError(AdapterError):
    """Every attempt in the retry budget failed."""


class InvalidConfigError(AdapterError):
    """An adapter configuration violates its contract."""
