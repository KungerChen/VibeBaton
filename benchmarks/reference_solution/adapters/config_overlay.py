"""Thread-safe reference implementation of the configuration overlay adapter."""

from collections.abc import Mapping
from threading import Lock
from types import TracebackType
from typing import Self, cast

from .base import ConfigOverlayAdapter, ValueT
from .errors import InvalidConfigError, KeyMissingError, NotOpenError


class ConfigOverlay(ConfigOverlayAdapter[ValueT]):
    """Merge mapping layers recursively and copy mapping and list containers."""

    name: str = "config_overlay"

    def __init__(self, base: Mapping[str, ValueT], overlay: Mapping[str, ValueT]) -> None:
        self._values = _copy_mapping(base, "base")
        _merge(self._values, _copy_mapping(overlay, "overlay"))
        self._is_open = False
        self._lock = Lock()

    def open(self) -> None:
        with self._lock:
            self._is_open = True

    def close(self) -> None:
        with self._lock:
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

    def get(self, key: str) -> ValueT:
        with self._lock:
            self._require_open()
            try:
                value = self._values[key]
            except KeyError:
                raise KeyMissingError(key) from None
        return cast(ValueT, _copy_value(value, "configuration"))

    def snapshot(self) -> dict[str, ValueT]:
        with self._lock:
            self._require_open()
        return cast(dict[str, ValueT], _copy_mapping(self._values, "configuration"))

    def _require_open(self) -> None:
        """Check the lifecycle while holding the adapter lock."""
        if not self._is_open:
            raise NotOpenError(f"{self.name} is closed")


def _copy_mapping(source: Mapping[str, object], label: str) -> dict[str, object]:
    """Normalize a layer to a private dictionary with string keys."""
    if not isinstance(source, Mapping):
        raise InvalidConfigError(f"{label} must be a mapping")
    copied: dict[str, object] = {}
    for key, value in source.items():
        if not isinstance(key, str):
            raise InvalidConfigError(f"{label} keys must be strings")
        copied[key] = _copy_value(value, label)
    return copied


def _copy_value(value: object, label: str) -> object:
    if isinstance(value, Mapping):
        return _copy_mapping(value, label)
    if isinstance(value, list):
        return [_copy_value(item, label) for item in value]
    return value


def _merge(
    base: dict[str, object],
    overlay: dict[str, object],
    prefix: tuple[str, ...] = (),
) -> None:
    """Merge private copies and reject a mapping paired with a leaf value."""
    for key, value in overlay.items():
        if key in base:
            current = base[key]
            if isinstance(current, dict) and isinstance(value, dict):
                _merge(current, value, (*prefix, key))
                continue
            if isinstance(current, dict) != isinstance(value, dict):
                path = ".".join((*prefix, key))
                raise InvalidConfigError(f"type conflict at {path!r}")
        base[key] = value
