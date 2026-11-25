"""Shared USD token pricing, with a local cache for the public rate feed."""

from __future__ import annotations

import json
import os
import threading
import time
import urllib.request
from collections.abc import Callable, Iterator, Mapping
from dataclasses import asdict, dataclass
from decimal import Decimal, DecimalException
from pathlib import Path
from typing import Literal, Protocol, TypedDict, cast


_PricingTable = Mapping[str, Mapping[str, float]]
_PricingPath = str | Path | None
PricingFetcher = Callable[[str, float], bytes | str | Mapping[str, object]]
PricingSource = Literal["custom", "official_cache", "builtin"]

_RATE_KEYS = ("input_per_1m", "output_per_1m", "cached_input_per_1m")
_LITELLM_KEYS = ("input_cost_per_token", "output_cost_per_token", "cache_read_input_token_cost")
_TOKENS_PER_MILLION = 1_000_000
_EFFORTS = {"low", "high", "max", "xhigh", "ultra"}
_PROVIDER_PREFIXES = {"anthropic", "openai", "deepseek", "opencode-go"}
_DEFAULT_CACHE_PATH = "~/.vibebaton/pricing_cache.json"
_DEFAULT_CUSTOM_PATH = "~/.vibebaton/custom_pricing.json"
_CUSTOM_WRITE_LOCK = threading.Lock()

# Pricing aliases used by VibeBaton's CLI model targets.
_MODEL_ALIASES = {
    "opus": "claude-opus-4-6",
    "sonnet": "claude-sonnet-4-6",
    "haiku": "claude-haiku-4-5",
    "fable": "claude-fable-5-2",
    "deepseek-v4.1-flash": "deepseek-flash",
}
_OFFICIAL_MODEL_IDS = {
    "claude-opus-4-5": "claude-opus-4-5-20251101",
    "claude-haiku-4-5": "claude-haiku-4-5-20251001",
    "deepseek-flash": "deepseek-v4.1-flash",
}


def _rate_row(input_per_1m: float, output_per_1m: float, cached_input_per_1m: float) -> dict[str, float]:
    return {
        "input_per_1m": input_per_1m,
        "output_per_1m": output_per_1m,
        "cached_input_per_1m": cached_input_per_1m,
    }


# USD per million text tokens in input, output, cached input order.
DEFAULT_MODEL_PRICING: dict[str, dict[str, float]] = {
    # https://platform.claude.com/docs/en/about-claude/pricing
    "claude-opus-4-6": _rate_row(5.0, 25.0, 0.50),
    "claude-opus-4-5": _rate_row(5.0, 25.0, 0.50),
    "claude-sonnet-4-6": _rate_row(3.0, 15.0, 0.30),
    "claude-haiku-4-5": _rate_row(1.0, 5.0, 0.10),
    "claude-fable-5-2": _rate_row(8.0, 40.0, 0.20),
    # Standard rates at https://developers.openai.com/api/docs/models
    "gpt-4o": _rate_row(2.50, 10.00, 1.25),
    "gpt-4o-mini": _rate_row(0.15, 0.60, 0.075),
    "gpt-4.1": _rate_row(2.00, 8.00, 0.50),
    "gpt-5": _rate_row(1.25, 10.00, 0.125),
    "gpt-5-mini": _rate_row(0.25, 2.00, 0.025),
    "gpt-5-codex": _rate_row(1.25, 10.00, 0.125),
    "o3": _rate_row(2.00, 8.00, 0.50),
    "o4-mini": _rate_row(1.10, 4.40, 0.275),
    "gpt-6.2-sol": _rate_row(2.00, 10.00, 0.10),
    "gpt-6.2-astra": _rate_row(8.00, 40.00, 0.40),
    # Peak rates at https://api-docs.deepseek.com/quick_start/pricing/
    "deepseek-flash": _rate_row(0.30, 1.20, 0.006),
    "deepseek-v4-pro": _rate_row(1.32, 3.96, 0.044),
    # Legacy IDs used V4 Flash before retirement.
    # https://api-docs.deepseek.com/quick_start/agent_integrations/pi_mono/
    "deepseek-chat": _rate_row(0.14, 0.28, 0.028),
    "deepseek-reasoner": _rate_row(0.14, 0.28, 0.028),
}
DEFAULT_MODEL_PRICING.update({
    alias: DEFAULT_MODEL_PRICING[model].copy() for alias, model in _MODEL_ALIASES.items()
})


class _PricingSettings(Protocol):
    """The pricing fields supplied by config.PricingSettings."""

    auto_sync: bool
    refresh_interval_hours: int
    source_url: str
    timeout_sec: float
    cache_path: str
    custom_path: str
    custom: dict[str, dict[str, float]]


@dataclass(frozen=True)
class ResolvedModelPricing:
    model: str
    input_per_1m: float
    output_per_1m: float
    cached_input_per_1m: float
    source: PricingSource


@dataclass(frozen=True)
class PricingSyncResult:
    ok: bool
    fetched: bool
    skipped_fresh: bool
    model_count: int
    cache_path: str
    fetched_at: float | None
    error: str | None = None
    preserved_cache: bool = False


class _CatalogModel(TypedDict):
    model: str
    input_per_1m: float
    output_per_1m: float
    cached_input_per_1m: float
    source: PricingSource


class _CatalogCache(TypedDict):
    path: str
    fetched_at: float | None
    age_sec: float | None
    stale: bool
    refresh_interval_hours: int
    auto_sync: bool
    source_url: str


class PricingCatalog(TypedDict):
    models: list[_CatalogModel]
    cache: _CatalogCache
    custom_path: str


@dataclass(frozen=True)
class _OfficialCache:
    models: dict[str, dict[str, float]]
    fetched_at: float | None

    def age_sec(self, now: float) -> float | None:
        return None if self.fetched_at is None else max(0.0, now - self.fetched_at)


def normalize_model_name(model: str) -> str:
    """Strip known effort suffixes and provider prefixes from a model ID."""
    model = model.strip()
    base, separator, effort = model.rpartition("@")
    if separator and effort in _EFFORTS:
        model = base
    while "/" in model:
        prefix, name = model.split("/", 1)
        if prefix not in _PROVIDER_PREFIXES:
            break
        model = name
    return model


def _nonnegative_float(value: object, scale: int = 1) -> float | None:
    try:
        number = Decimal(str(value))
        if not number.is_finite() or number < 0:
            return None
        result = float(number * scale)
    except (DecimalException, OverflowError):
        return None
    return result if result < float("inf") else None


def _parse_rates(
    rates: object,
    keys: tuple[str, str, str] = _RATE_KEYS,
    scale: int = 1,
) -> dict[str, float] | None:
    if not isinstance(rates, Mapping) or keys[0] not in rates or keys[1] not in rates:
        return None
    result = {}
    for target, key in zip(_RATE_KEYS, keys):
        if key in rates:
            rate = _nonnegative_float(rates[key], scale)
            if rate is None:
                return None
            result[target] = rate
    return result


def _normalized_rows(table: Mapping[str, object]) -> dict[str, object]:
    rows = {}
    for key, rates in table.items():
        if isinstance(key, str):
            name = normalize_model_name(key)
            if name and (key == name or name not in rows):
                rows[name] = rates
    return rows


def _parse_rate_table(raw: object, *, official: bool = False) -> dict[str, dict[str, float]]:
    if not isinstance(raw, Mapping):
        return {}
    models = {}
    for model, row in _normalized_rows(raw).items():
        if official and model == "sample_spec":
            continue
        rates = _parse_rates(row)
        if rates is None and official:
            rates = _parse_rates(row, _LITELLM_KEYS, _TOKENS_PER_MILLION)
        if rates is not None:
            models[model] = rates
    return models


def _read_json_object(path: Path) -> dict[str, object]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError, RecursionError):
        return {}
    return value if isinstance(value, dict) else {}


def _write_json_atomic(path: Path, data: Mapping[str, object]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{os.urandom(8).hex()}.tmp")
    stream = temporary.open("x", encoding="utf-8")
    try:
        with stream:
            json.dump(data, stream, ensure_ascii=False, indent=2, allow_nan=False)
            stream.write("\n")
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def load_custom_pricing(path: _PricingPath) -> dict[str, dict[str, float]]:
    """Read usable per-model overrides from the custom JSON file."""
    return _parse_rate_table(_read_json_object(Path(path or _DEFAULT_CUSTOM_PATH).expanduser()))


def save_custom_pricing(
    path: _PricingPath, updates: Mapping[str, Mapping[str, float] | None],
) -> dict[str, dict[str, float]]:
    """Apply overrides atomically and return the saved table.

    A null or empty rate object clears its model. A replacement needs both
    input and output rates, with an optional cached input rate.
    """
    file = Path(path or _DEFAULT_CUSTOM_PATH).expanduser()
    with _CUSTOM_WRITE_LOCK:
        models = load_custom_pricing(file)
        for model, row in updates.items():
            name = normalize_model_name(model) if isinstance(model, str) else ""
            if not name:
                raise ValueError("Custom pricing requires a non-empty model name.")
            if row is None or (isinstance(row, Mapping) and not row):
                models.pop(name, None)
                continue
            rates = _parse_rates(row)
            if rates is None or rates.keys() != row.keys():
                raise ValueError(f"Invalid custom rates for {model!r}. Expected finite non-negative token rates.")
            models[name] = rates
        _write_json_atomic(file, models)
    return models


def _load_official_cache(path: Path) -> _OfficialCache:
    data = _read_json_object(path)
    models = _parse_rate_table(data.get("models"))
    fetched_at = _nonnegative_float(data.get("fetched_at")) if models else None
    return _OfficialCache(models, fetched_at)


def _pricing_sources(
    provider_pricing: _PricingTable | None,
    custom_pricing: _PricingTable | None,
    cache_path: _PricingPath,
    custom_path: _PricingPath,
    *,
    cache: _OfficialCache | None = None,
) -> Iterator[tuple[PricingSource, _PricingTable]]:
    yield "custom", provider_pricing or {}
    yield "custom", custom_pricing or {}
    yield "custom", load_custom_pricing(custom_path)
    if cache is None:
        cache = _load_official_cache(Path(cache_path or _DEFAULT_CACHE_PATH).expanduser())
    yield "official_cache", cache.models
    yield "builtin", DEFAULT_MODEL_PRICING


def _resolved_row(model: str, row: object, source: PricingSource) -> ResolvedModelPricing | None:
    rates = _parse_rates(row)
    if rates is None:
        return None
    input_rate = rates["input_per_1m"]
    return ResolvedModelPricing(
        model=model,
        input_per_1m=input_rate,
        output_per_1m=rates["output_per_1m"],
        cached_input_per_1m=rates.get("cached_input_per_1m", input_rate),
        source=source,
    )


def resolve_model_pricing(
    model: str,
    *,
    provider_pricing: _PricingTable | None = None,
    custom_pricing: _PricingTable | None = None,
    cache_path: _PricingPath = None,
    custom_path: _PricingPath = None,
) -> ResolvedModelPricing | None:
    """Resolve a model from provider, TOML, custom file, cache, then built-in rates.

    An exact model key wins within its own table. Normalized keys provide a
    fallback for prefixed and effort-qualified model IDs.
    """
    name = normalize_model_name(model)
    if not name:
        return None
    for source, table in _pricing_sources(provider_pricing, custom_pricing, cache_path, custom_path):
        row = table.get(model)
        if row is None and name != model:
            row = table.get(name)
        if row is None:
            row = next(
                (rates for key, rates in table.items() if normalize_model_name(key) == name), None,
            )
        if row is not None:
            # An explicit incomplete override retains the legacy unpriced result.
            return _resolved_row(name, row, source)
    return None


def compute_token_cost_usd(
    model: str,
    prompt_tokens: int,
    completion_tokens: int,
    cached_tokens: int = 0,
    pricing_table: _PricingTable | None = None,
    custom_pricing: _PricingTable | None = None,
    cache_path: _PricingPath = None,
    custom_path: _PricingPath = None,
) -> float | None:
    """Price one completion, with cached tokens counted within the prompt."""
    if not 0 <= cached_tokens <= prompt_tokens or completion_tokens < 0:
        raise ValueError("Token counts must be non-negative and cached tokens cannot exceed prompt tokens.")
    rates = resolve_model_pricing(
        model, provider_pricing=pricing_table, custom_pricing=custom_pricing,
        cache_path=cache_path, custom_path=custom_path,
    )
    if rates is None:
        return None
    total = (
        (prompt_tokens - cached_tokens) * Decimal(str(rates.input_per_1m))
        + cached_tokens * Decimal(str(rates.cached_input_per_1m))
        + completion_tokens * Decimal(str(rates.output_per_1m))
    )
    return float(total / _TOKENS_PER_MILLION)


def _fetch_pricing(url: str, timeout_sec: float) -> bytes:
    with urllib.request.urlopen(url, timeout=timeout_sec) as response:
        return response.read()


def _parse_official_payload(payload: bytes | str | Mapping[str, object]) -> dict[str, dict[str, float]]:
    raw = json.loads(payload, parse_float=Decimal) if isinstance(payload, (bytes, str)) else payload
    if not isinstance(raw, Mapping):
        raise ValueError("Expected a JSON object containing model rates.")
    models = _parse_rate_table(raw, official=True)
    if not models and "models" in raw:
        models = _parse_rate_table(raw["models"], official=True)
    if not models:
        raise ValueError("Pricing feed contained no usable model rates.")
    for aliases in (_OFFICIAL_MODEL_IDS, _MODEL_ALIASES):
        for name, model in aliases.items():
            if model in models:
                models.setdefault(name, models[model])
    return models


def _cache_is_fresh(age_sec: float | None, refresh_interval_hours: int) -> bool:
    return age_sec is not None and age_sec < refresh_interval_hours * 3600


def sync_official_pricing(
    settings: _PricingSettings,
    *,
    force: bool = False,
    fetcher: PricingFetcher | None = None,
    cache_path: _PricingPath = None,
    now: float | None = None,
) -> PricingSyncResult:
    """Refresh the cache using fetcher(source_url, timeout_sec).

    The fetcher can return JSON bytes, JSON text, or a decoded model map.
    Timestamps are Unix seconds. A failed refresh reports the previous cache
    metadata and leaves the cache file in place.
    """
    path = Path(cache_path or settings.cache_path or _DEFAULT_CACHE_PATH).expanduser()
    cache = _load_official_cache(path)
    timestamp = time.time() if now is None else now
    if not force and _cache_is_fresh(cache.age_sec(timestamp), settings.refresh_interval_hours):
        return PricingSyncResult(
            ok=True, fetched=False, skipped_fresh=True, model_count=len(cache.models),
            cache_path=str(path), fetched_at=cache.fetched_at,
        )
    try:
        models = _parse_official_payload((fetcher or _fetch_pricing)(settings.source_url, settings.timeout_sec))
        _write_json_atomic(path, {"fetched_at": timestamp, "source_url": settings.source_url, "models": models})
    except Exception as exc:
        return PricingSyncResult(
            ok=False, fetched=False, skipped_fresh=False, model_count=len(cache.models),
            cache_path=str(path), fetched_at=cache.fetched_at,
            error=str(exc) or type(exc).__name__, preserved_cache=True,
        )
    return PricingSyncResult(
        ok=True, fetched=True, skipped_fresh=False, model_count=len(models),
        cache_path=str(path), fetched_at=timestamp,
    )


def trigger_background_pricing_sync(
    settings: _PricingSettings, *, cache_path: _PricingPath = None, fetcher: PricingFetcher | None = None,
) -> threading.Thread | None:
    """Start a daemon refresh when background pricing sync is enabled."""
    if not settings.auto_sync or os.environ.get("VIBEBATON_DISABLE_PRICING_SYNC") == "1":
        return None
    thread = threading.Thread(
        target=sync_official_pricing,
        kwargs={"settings": settings, "cache_path": cache_path, "fetcher": fetcher},
        name="vibebaton-pricing-sync",
        daemon=True,
    )
    thread.start()
    return thread


def build_pricing_catalog(
    settings: _PricingSettings,
    *,
    provider_pricing: _PricingTable | None = None,
    cache_path: _PricingPath = None,
    custom_path: _PricingPath = None,
) -> PricingCatalog:
    """Return the resolved model rates and cache status as JSON-ready data."""
    cache_file = Path(cache_path or settings.cache_path or _DEFAULT_CACHE_PATH).expanduser()
    custom_file = Path(custom_path or settings.custom_path or _DEFAULT_CUSTOM_PATH).expanduser()
    cache = _load_official_cache(cache_file)
    age_sec = cache.age_sec(time.time())
    models: list[_CatalogModel] = []
    seen: set[str] = set()
    sources = _pricing_sources(provider_pricing, settings.custom, cache_file, custom_file, cache=cache)
    for source, table in sources:
        for name, row in _normalized_rows(table).items():
            if row is None or name in seen:
                continue
            seen.add(name)
            resolved = _resolved_row(name, row, source)
            if resolved is not None:
                models.append(cast(_CatalogModel, asdict(resolved)))
    models.sort(key=lambda row: row["model"])
    return {
        "models": models,
        "cache": {
            "path": str(cache_file),
            "fetched_at": cache.fetched_at,
            "age_sec": age_sec,
            "stale": not _cache_is_fresh(age_sec, settings.refresh_interval_hours),
            "refresh_interval_hours": settings.refresh_interval_hours,
            "auto_sync": settings.auto_sync,
            "source_url": settings.source_url,
        },
        "custom_path": str(custom_file),
    }
