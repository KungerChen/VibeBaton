"""Full model catalog, tiered market-rank recommendations, and daily 24h sync cache."""

from __future__ import annotations

import json
import math
from datetime import date, datetime, timezone
import os
import re
import threading
import time
import urllib.request
from collections.abc import Callable, Mapping, Sequence
from pathlib import Path
from typing import Any, Literal, TypedDict

ModelStatus = Literal["latest", "legacy", "synced"]
ModelCostTier = Literal["flagship", "standard", "eco"]
RoleTier = Literal["L0", "L1", "L2", "L3"]
CatalogFetcher = Callable[[str, float], bytes | str | Mapping[str, Any]]

DEFAULT_CATALOG_SOURCE_URL = (
    "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json"
)
DEFAULT_CATALOG_CACHE_PATH = "~/.vibebaton/model_catalog_cache.json"
DAILY_SYNC_INTERVAL_SEC = 86_400.0
DEFAULT_SYNC_TIMEOUT_SEC = 20.0
HOURLY_CHECK_INTERVAL_SEC = 3_600.0
_CACHE_LOCK = threading.Lock()

EFFORT_LEVELS: tuple[dict[str, str], ...] = (
    {"id": "low", "label": "Low"},
    {"id": "medium", "label": "Medium"},
    {"id": "high", "label": "High"},
    {"id": "xhigh", "label": "XHigh"},
    {"id": "max", "label": "Max"},
)
_EFFORT_IDS = tuple(item["id"] for item in EFFORT_LEVELS)

ROLE_TIERS: dict[str, RoleTier] = {
    "brainstorm_and_final_gate": "L0",
    "tactical_planner": "L1",
    "milestone_reviewer": "L1",
    "critical_executor": "L2",
    "micro_orchestrator": "L2",
    "bulk_worker": "L3",
}


class ModelCatalogEntry(TypedDict):
    id: str
    label: str
    family: str
    providers: list[str]
    status: ModelStatus
    cost_tier: ModelCostTier
    rank: int
    efforts: list[str]
    default_effort: str


class TierRecommendation(TypedDict):
    providers: list[str]
    model: str
    effort: str
    note_en: str
    note_zh: str


def _model(
    model_id: str,
    label: str,
    family: str,
    providers: Sequence[str],
    status: ModelStatus,
    cost_tier: ModelCostTier,
    rank: int,
    default_effort: str,
) -> ModelCatalogEntry:
    return {
        "id": model_id,
        "label": label,
        "family": family,
        "providers": list(providers),
        "status": status,
        "cost_tier": cost_tier,
        "rank": rank,
        "efforts": list(_EFFORT_IDS),
        "default_effort": default_effort,
    }


# Complete active model roster across supported providers. Ranked by tier capability within each family,
# keeping both latest models and older non-retired models selectable.
BUNDLED_MODELS: tuple[ModelCatalogEntry, ...] = (
    # Gemini family
    _model("gemini-4-carbon", "Gemini 4C", "gemini", ("gemini_sub", "gemini_http"), "latest", "flagship", 1, "medium"),
    _model("gemini-4-neon", "Gemini 4N", "gemini", ("gemini_sub", "gemini_http"), "latest", "standard", 2, "medium"),
    _model("gemini-4-hydrogen", "Gemini 4H", "gemini", ("gemini_sub", "gemini_http"), "latest", "eco", 3, "max"),
    _model("gemini-2.5-pro", "Gemini 2.5 Pro", "gemini", ("gemini_sub", "gemini_http"), "legacy", "flagship", 4, "medium"),
    _model("gemini-2.5-flash", "Gemini 2.5 Flash", "gemini", ("gemini_sub", "gemini_http"), "legacy", "eco", 5, "max"),
    _model("gemini-2.0-flash", "Gemini 2.0 Flash", "gemini", ("gemini_sub", "gemini_http"), "legacy", "eco", 6, "high"),
    # Claude family
    _model("claude-fable-5-2", "Fable 5.2", "claude", ("claude_sub",), "latest", "flagship", 1, "medium"),
    _model("claude-opus-5-5", "Opus 5.5", "claude", ("claude_sub",), "latest", "flagship", 2, "medium"),
    _model("claude-sonnet-5-5", "Sonnet 5.5", "claude", ("claude_sub",), "latest", "standard", 3, "max"),
    _model("claude-haiku-5-5", "Haiku 5.5", "claude", ("claude_sub",), "latest", "eco", 4, "max"),
    _model("claude-opus-4-6", "Claude Opus 4.6", "claude", ("claude_sub",), "legacy", "flagship", 5, "high"),
    _model("claude-sonnet-4-6", "Claude Sonnet 4.6", "claude", ("claude_sub",), "legacy", "standard", 6, "high"),
    _model("claude-opus-4-5", "Claude Opus 4.5", "claude", ("claude_sub",), "legacy", "flagship", 7, "high"),
    _model("claude-haiku-4-5", "Claude Haiku 4.5", "claude", ("claude_sub",), "legacy", "eco", 8, "max"),
    # OpenAI / Codex family
    _model("gpt-6.2-astra", "GPT-6.2 Astra", "openai", ("codex_sub", "openai_http"), "latest", "flagship", 1, "xhigh"),
    _model("gpt-6.2-sol", "GPT-6.2 Sol", "openai", ("codex_sub", "openai_http"), "latest", "standard", 2, "max"),
    _model("gpt-6.1-terra", "GPT-6.1 Terra", "openai", ("codex_sub", "openai_http"), "latest", "eco", 3, "max"),
    _model("gpt-6-luna", "GPT-6 Luna", "openai", ("codex_sub", "openai_http"), "latest", "eco", 4, "max"),
    _model("gpt-5-codex", "GPT-5 Codex", "openai", ("openai_http",), "legacy", "standard", 5, "high"),
    _model("gpt-5", "GPT-5", "openai", ("openai_http",), "legacy", "standard", 6, "high"),
    _model("gpt-5-mini", "GPT-5 Mini", "openai", ("openai_http",), "legacy", "eco", 7, "high"),
    _model("gpt-4.1", "GPT-4.1", "openai", ("openai_http",), "legacy", "standard", 8, "high"),
    _model("gpt-4o", "GPT-4o", "openai", ("openai_http",), "legacy", "standard", 9, "high"),
    _model("o3", "o3", "openai", ("openai_http",), "legacy", "standard", 10, "high"),
    _model("o4-mini", "o4-mini", "openai", ("openai_http",), "legacy", "eco", 11, "high"),
    # DeepSeek / DSH family
    _model("deepseek-v4.1-flash", "DeepSeek V4.1 Flash", "deepseek", ("dsh_opencode", "dsh_deepseek"), "latest", "eco", 1, "max"),
    _model("deepseek-v4-pro", "DeepSeek V4 Pro", "deepseek", ("dsh_opencode", "dsh_deepseek"), "latest", "standard", 2, "high"),
    _model("deepseek-reasoner", "DeepSeek Reasoner", "deepseek", ("dsh_opencode", "dsh_deepseek"), "legacy", "standard", 3, "high"),
    _model("deepseek-chat", "DeepSeek Chat", "deepseek", ("dsh_opencode", "dsh_deepseek"), "legacy", "eco", 4, "high"),
)

# Ranked market recommendations per tier (strongest reasoning for L0 with medium effort;
# strong balanced planners for L1; crisp code-execution specialists at Max for L2;
# best value high-throughput workers at Max for L3).
TIER_RECOMMENDATIONS: dict[RoleTier, list[TierRecommendation]] = {
    "L0": [
        {
            "providers": ["gemini_sub", "gemini_http"],
            "model": "gemini-4-carbon",
            "effort": "medium",
            "note_en": "Flagship top-ranked architect model at balanced medium effort.",
            "note_zh": "榜单最强档架构模型（中等思考强度，兼顾深度与响应速度）。",
        },
        {
            "providers": ["claude_sub"],
            "model": "claude-fable-5-2",
            "effort": "medium",
            "note_en": "Secondary flagship architect choice at medium effort.",
            "note_zh": "次选旗舰模型 Fable 5.2（中等思考强度）。",
        },
        {
            "providers": ["codex_sub", "openai_http"],
            "model": "gpt-6.2-astra",
            "effort": "xhigh",
            "note_en": "High-reasoning flagship fallback.",
            "note_zh": "第三顺位：GPT-6.2 Astra（XHigh 思考强度）。",
        },
    ],
    "L1": [
        {
            "providers": ["claude_sub"],
            "model": "claude-opus-5-5",
            "effort": "medium",
            "note_en": "Top L1 planning & milestone-gate model at medium effort.",
            "note_zh": "L1 首选：Opus 5.5（中等思考强度，稳健规划与把关）。",
        },
        {
            "providers": ["gemini_sub", "gemini_http"],
            "model": "gemini-4-neon",
            "effort": "medium",
            "note_en": "Secondary L1 planning model at medium effort.",
            "note_zh": "次选：Gemini 4N（中等思考强度）。",
        },
        {
            "providers": ["codex_sub", "openai_http"],
            "model": "gpt-6.2-sol",
            "effort": "max",
            "note_en": "Third L1 ranked alternative.",
            "note_zh": "第三顺位：GPT-6.2 Sol（Max 思考强度）。",
        },
    ],
    "L2": [
        {
            "providers": ["codex_sub", "openai_http"],
            "model": "gpt-6.2-sol",
            "effort": "max",
            "note_en": "Top L2 code execution & micro-review model at Max effort.",
            "note_zh": "L2 首选：GPT-6.2 Sol（Max 思考强度，专注核心代码攻坚）。",
        },
        {
            "providers": ["claude_sub"],
            "model": "claude-sonnet-5-5",
            "effort": "max",
            "note_en": "Secondary L2 specialist at Max effort.",
            "note_zh": "次选：Sonnet 5.5（Max 思考强度）。",
        },
        {
            "providers": ["gemini_sub", "gemini_http"],
            "model": "gemini-4-hydrogen",
            "effort": "max",
            "note_en": "Third L2 specialist at Max effort.",
            "note_zh": "第三顺位：Gemini 4H（Max 思考强度）。",
        },
    ],
    "L3": [
        {
            "providers": ["dsh_opencode", "dsh_deepseek"],
            "model": "deepseek-v4.1-flash",
            "effort": "max",
            "note_en": "Best value high-concurrency worker at Max effort.",
            "note_zh": "L3 首选高性价比主力：DeepSeek V4.1 Flash（Max 思考强度）。",
        },
        {
            "providers": ["claude_sub"],
            "model": "claude-haiku-5-5",
            "effort": "max",
            "note_en": "Secondary value worker at Max effort.",
            "note_zh": "次选高性价比：Haiku 5.5（Max 思考强度）。",
        },
        {
            "providers": ["codex_sub", "openai_http"],
            "model": "gpt-6.1-terra",
            "effort": "max",
            "note_en": "Third value worker option at Max effort.",
            "note_zh": "第三顺位：GPT-6.1 Terra（Max 思考强度）。",
        },
        {
            "providers": ["codex_sub", "openai_http"],
            "model": "gpt-6-luna",
            "effort": "max",
            "note_en": "Fourth value worker option at Max effort.",
            "note_zh": "第四顺位：GPT-6 Luna（Max 思考强度）。",
        },
    ],
}


def resolve_catalog_cache_path(cache_path: str | Path | None = None) -> Path:
    text = str(cache_path).strip() if cache_path is not None else ""
    if text:
        return Path(text).expanduser()
    return Path(DEFAULT_CATALOG_CACHE_PATH).expanduser()


def _default_fetcher(url: str, timeout_sec: float) -> bytes:
    request = urllib.request.Request(
        url,
        headers={"Accept": "application/json", "User-Agent": "VibeBaton/1.2"},
    )
    with urllib.request.urlopen(request, timeout=timeout_sec) as response:
        return response.read()


# Only first-party rows describe what VibeBaton's providers can actually call.
_FIRST_PARTY_PROVIDERS: dict[str, tuple[str, list[str]]] = {
    "anthropic": ("claude", ["claude_sub"]),
    "openai": ("openai", ["codex_sub", "openai_http"]),
    "gemini": ("gemini", ["gemini_sub", "gemini_http"]),
    "deepseek": ("deepseek", ["dsh_opencode", "dsh_deepseek"]),
}
# Feed keys such as ``gemini/gemini-2.5-pro`` carry the Gemini API row; the bare key is often Vertex.
_FIRST_PARTY_PREFIXES = ("gemini", "deepseek")


def _first_party_rows(payload: Mapping[str, Any]) -> dict[str, Mapping[str, Any]]:
    rows: dict[str, Mapping[str, Any]] = {}
    for key, row in payload.items():
        if not isinstance(key, str) or not isinstance(row, Mapping):
            continue
        if str(row.get("litellm_provider") or "").lower() not in _FIRST_PARTY_PROVIDERS:
            continue
        prefix, slash, bare = key.partition("/")
        if not slash:
            rows.setdefault(key, row)
        elif prefix in _FIRST_PARTY_PREFIXES and bare and "/" not in bare:
            rows[bare] = row
    return rows


def _is_retired(row: Mapping[str, Any], today: date) -> bool:
    try:
        retired_on = date.fromisoformat(str(row.get("deprecation_date") or "").strip()[:10])
    except ValueError:
        return False
    return retired_on <= today


_VARIANT_PATTERN = re.compile(
    r"(?:^|-)(?:healthcare|law|cyber|robotics|computer-use|search|customtools|exp|vision-exp)(?:-|$)"
)
_SNAPSHOT_PATTERN = re.compile(r"^(?P<base>.+?)-(?:\d{8}|\d{4}-\d{2}-\d{2}|\d{2}-\d{4}|\d{4})$")
_VERSION_TOKEN = re.compile(r"^v?(\d{1,3}(?:\.\d{1,3})*)$")
_FAMILY_ID_PATTERNS = {
    "claude": r"claude-",
    "openai": r"(?:gpt-|o\d)",
    "gemini": r"gemini-(?!gemma)",
    "deepseek": r"deepseek-",
}
_LABEL_WORDS = {"gpt": "GPT", "claude": "Claude", "gemini": "Gemini", "deepseek": "DeepSeek"}
_COST_ORDER = {"flagship": 0, "standard": 1, "eco": 2}


def _is_noise(model_id: str, known_ids: set[str]) -> bool:
    """Drop moving aliases, dated snapshots of an undated model, and vertical/experimental variants."""
    lower = model_id.lower()
    if lower.endswith("-latest") or _VARIANT_PATTERN.search(lower):
        return True
    snapshot = _SNAPSHOT_PATTERN.match(model_id)
    return snapshot is not None and snapshot.group("base") in known_ids


def _model_version(model_id: str) -> tuple[int, ...]:
    """Leading version numbers, e.g. claude-opus-4-7 -> (4, 7), gpt-5.4-mini -> (5, 4), o3 -> (3,)."""
    parts: list[int] = []
    for token in model_id.lower().split("-"):
        match = _VERSION_TOKEN.match(token) or re.match(r"^o(\d{1,2})$", token)
        if match:
            parts.extend(int(piece) for piece in match.group(1).split("."))
        elif parts:
            break
    return tuple(parts)


def _model_label(model_id: str) -> str:
    """Readable label, e.g. claude-opus-4-7 -> Claude Opus 4.7, gpt-5.4-mini -> GPT-5.4 Mini."""
    if re.match(r"^o\d", model_id):
        return model_id
    tokens = model_id.split("-")
    words: list[str] = []
    index = 0
    while index < len(tokens):
        token = tokens[index]
        version = _VERSION_TOKEN.match(token)
        if version and not token.lower().startswith("v"):
            numbers = [version.group(1)]
            while index + 1 < len(tokens) and tokens[index + 1].isdigit() and len(tokens[index + 1]) <= 3:
                index += 1
                numbers.append(tokens[index])
            text = ".".join(numbers)
            if words == ["GPT"]:
                words[0] = f"GPT-{text}"
            else:
                words.append(text)
        elif token.isdigit():
            words.append("-".join(tokens[index:]))
            break
        else:
            words.append(_LABEL_WORDS.get(token.lower(), token.upper() if version else token.capitalize()))
        index += 1
    return " ".join(words)


def _rank_synced(entries: list[ModelCatalogEntry]) -> list[ModelCatalogEntry]:
    """Rank synced models after the bundled roster: newest version first within each family."""
    first_rank = max(entry["rank"] for entry in BUNDLED_MODELS) + 1
    ranked: list[ModelCatalogEntry] = []
    for family in sorted({entry["family"] for entry in entries}):
        members = sorted(
            (entry for entry in entries if entry["family"] == family),
            key=lambda entry: (
                tuple(-part for part in (_model_version(entry["id"]) + (0, 0, 0, 0))[:4]),
                _COST_ORDER[entry["cost_tier"]],
                entry["id"],
            ),
        )
        ranked.extend({**entry, "rank": first_rank + offset} for offset, entry in enumerate(members))
    return ranked


def _classify_remote_model(model_id: str, row: Mapping[str, Any]) -> ModelCatalogEntry | None:
    lower = model_id.lower()
    if any(skip in lower for skip in ("embed", "tts", "whisper", "dall-e", "realtime", "audio", "moderation", "image", "sora")):
        return None

    mode = str(row.get("mode") or "").lower()
    if mode and mode not in ("chat", "responses"):
        return None

    family_providers = _FIRST_PARTY_PROVIDERS.get(str(row.get("litellm_provider") or "").lower())
    if family_providers is None:
        return None
    family, providers = family_providers[0], list(family_providers[1])
    # Provider feeds also list fine-tunes and sibling products (gemma, lyria, ...); keep the family's own models.
    if not re.match(_FAMILY_ID_PATTERNS[family], lower):
        return None

    tokens = set(lower.split("-"))
    cost_tier: ModelCostTier = "eco" if tokens & {"flash", "mini", "nano", "haiku", "hydrogen", "lite"} else (
        "flagship" if tokens & {"opus", "astra", "fable", "carbon", "pro"} else "standard"
    )
    return {
        "id": model_id,
        "label": _model_label(model_id),
        "family": family,
        "providers": providers,
        "status": "synced",
        "cost_tier": cost_tier,
        "rank": 50,
        "efforts": list(_EFFORT_IDS),
        "default_effort": "medium" if cost_tier == "flagship" else "high",
    }


class _CatalogCache(TypedDict):
    fetched_at: float | None
    models: list[ModelCatalogEntry]
    retired_ids: list[str]
    last_error: str | None


def _read_catalog_cache(path: Path) -> _CatalogCache:
    empty: _CatalogCache = {"fetched_at": None, "models": [], "retired_ids": [], "last_error": None}
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, OSError, ValueError, RecursionError):
        return empty
    if not isinstance(payload, dict):
        return empty
    fetched_at = payload.get("fetched_at")
    fetched = float(fetched_at) if isinstance(fetched_at, (int, float)) and math.isfinite(fetched_at) else None
    raw_retired = payload.get("retired_ids")
    if not isinstance(raw_retired, list):
        # Written by the older, unfiltered sync: keep its models readable but treat it as due for a re-fetch.
        fetched, raw_retired = None, []
    retired = [item for item in raw_retired if isinstance(item, str)]
    raw_models = payload.get("models")
    entries: list[ModelCatalogEntry] = []
    for item in raw_models if isinstance(raw_models, list) else []:
        if not isinstance(item, dict) or not isinstance(item.get("id"), str):
            continue
        entries.append({
            "id": item["id"],
            "label": str(item.get("label") or item["id"]),
            "family": str(item.get("family") or "other"),
            "providers": [str(p) for p in item.get("providers", []) if isinstance(p, str)],
            "status": "synced",
            "cost_tier": item.get("cost_tier") if item.get("cost_tier") in ("flagship", "standard", "eco") else "standard",
            "rank": int(item.get("rank", 50)),
            "efforts": list(_EFFORT_IDS),
            "default_effort": str(item.get("default_effort") or "high"),
        })
    last_error = payload.get("last_error")
    return {
        "fetched_at": fetched,
        "models": entries,
        "retired_ids": retired,
        "last_error": last_error if isinstance(last_error, str) else None,
    }


def _write_catalog_cache(path: Path, cache: _CatalogCache) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(cache, indent=2) + "\n", encoding="utf-8")
    os.replace(tmp, path)


def _merge_catalog(synced: list[ModelCatalogEntry], retired_ids: Sequence[str] = ()) -> list[ModelCatalogEntry]:
    retired = set(retired_ids)
    merged: list[ModelCatalogEntry] = [
        {**entry, "providers": list(entry["providers"]), "efforts": list(entry["efforts"])}
        for entry in BUNDLED_MODELS
        if entry["id"] not in retired
    ]
    seen = {entry["id"] for entry in BUNDLED_MODELS}
    for item in sorted(synced, key=lambda entry: (entry["family"], entry["id"])):
        if item["id"] in seen or item["id"] in retired:
            continue
        seen.add(item["id"])
        merged.append(item)
    return merged


def sync_model_catalog(
    *,
    force: bool = False,
    cache_path: str | Path | None = None,
    source_url: str = DEFAULT_CATALOG_SOURCE_URL,
    timeout_sec: float = DEFAULT_SYNC_TIMEOUT_SEC,
    fetcher: Callable[[str, float], bytes | str | Mapping[str, Any]] | None = None,
    now_fn: Callable[[], float] = time.time,
) -> dict[str, Any]:
    """Fetch the public model feed once per 24h; models the feed has retired are hidden, failures are kept in the cache."""
    resolved_cache = resolve_catalog_cache_path(cache_path)
    now = now_fn()
    fetched_at = _read_catalog_cache(resolved_cache)["fetched_at"]
    age_sec = None if fetched_at is None else max(0.0, now - fetched_at)
    stale = fetched_at is None or (age_sec is not None and age_sec >= DAILY_SYNC_INTERVAL_SEC)

    if os.environ.get("VIBEBATON_DISABLE_MODEL_SYNC") == "1" and not force:
        return {
            "ok": True,
            "fetched": False,
            "skipped_fresh": True,
            "added_count": 0,
            "error": None,
            "catalog": get_model_catalog(cache_path=resolved_cache, now_fn=now_fn),
        }

    if not force and not stale:
        return {
            "ok": True,
            "fetched": False,
            "skipped_fresh": True,
            "added_count": 0,
            "error": None,
            "catalog": get_model_catalog(cache_path=resolved_cache, now_fn=now_fn),
        }

    fn = fetcher or _default_fetcher
    try:
        raw = fn(source_url, timeout_sec)
        payload = json.loads(raw.decode("utf-8") if isinstance(raw, bytes) else raw) if not isinstance(raw, Mapping) else raw
        if not isinstance(payload, Mapping):
            raise ValueError("Model catalog payload must be a JSON object")
        today = datetime.fromtimestamp(now, timezone.utc).date()
        rows = _first_party_rows(payload)
        retired_ids = sorted(model_id for model_id, row in rows.items() if _is_retired(row, today))
        bundled_ids = {entry["id"] for entry in BUNDLED_MODELS}
        discovered: list[ModelCatalogEntry] = []
        for model_id, row in rows.items():
            if model_id in bundled_ids or _is_retired(row, today):
                continue
            classified = _classify_remote_model(model_id, row)
            if classified is not None and not _is_noise(model_id, set(rows)):
                discovered.append(classified)
        if not discovered:
            raise ValueError("Model feed contained no usable models; keeping the previous catalog")
        discovered = _rank_synced(discovered)
        with _CACHE_LOCK:
            _write_catalog_cache(
                resolved_cache,
                {"fetched_at": now, "models": discovered, "retired_ids": retired_ids, "last_error": None},
            )
        catalog = get_model_catalog(cache_path=resolved_cache, now_fn=now_fn)
        return {
            "ok": True,
            "fetched": True,
            "skipped_fresh": False,
            "added_count": len(discovered),
            "error": None,
            "catalog": catalog,
        }
    except Exception as exc:
        # Keep the previous catalog and fetched_at (so the hourly check retries), but surface the failure.
        try:
            with _CACHE_LOCK:
                previous = _read_catalog_cache(resolved_cache)
                _write_catalog_cache(resolved_cache, {**previous, "last_error": str(exc) or type(exc).__name__})
        except OSError:
            pass
        return {
            "ok": False,
            "fetched": False,
            "skipped_fresh": False,
            "added_count": 0,
            "error": str(exc),
            "catalog": get_model_catalog(cache_path=resolved_cache, now_fn=now_fn),
        }


def get_model_catalog(
    *,
    cache_path: str | Path | None = None,
    now_fn: Callable[[], float] = time.time,
) -> dict[str, Any]:
    """Return full active+legacy model catalog, L0..L3 recommendations, efforts, and cache metadata."""
    resolved_cache = resolve_catalog_cache_path(cache_path)
    cached = _read_catalog_cache(resolved_cache)
    fetched_at = cached["fetched_at"]
    now = now_fn()
    age_sec = None if fetched_at is None else round(max(0.0, now - fetched_at), 1)
    stale = fetched_at is None or (age_sec is not None and age_sec >= DAILY_SYNC_INTERVAL_SEC)
    return {
        "models": _merge_catalog(cached["models"], cached["retired_ids"]),
        "tier_recommendations": TIER_RECOMMENDATIONS,
        "role_tiers": dict(ROLE_TIERS),
        "efforts": list(EFFORT_LEVELS),
        "cache": {
            "path": str(resolved_cache),
            "fetched_at": fetched_at,
            "age_sec": age_sec,
            "stale": stale,
            "last_error": cached["last_error"],
            "refresh_interval_hours": 24,
        },
    }


def start_daily_sync(
    *,
    cache_path: str | Path | None,
    stop_event: threading.Event,
    fetcher: CatalogFetcher | None = None,
    now_fn: Callable[[], float] = time.time,
    wait_fn: Callable[[threading.Event, float], bool] | None = None,
) -> threading.Thread | None:
    """Check right away and then hourly in a daemon thread; ``sync_model_catalog`` only fetches once 24h old."""
    if os.environ.get("VIBEBATON_DISABLE_MODEL_SYNC") == "1":
        return None
    wait = wait_fn or (lambda event, seconds: event.wait(seconds))
    kwargs: dict[str, Any] = {"cache_path": cache_path, "now_fn": now_fn}
    if fetcher is not None:
        kwargs["fetcher"] = fetcher

    def loop() -> None:
        while not stop_event.is_set():
            sync_model_catalog(**kwargs)
            if wait(stop_event, HOURLY_CHECK_INTERVAL_SEC):
                return

    thread = threading.Thread(target=loop, name="vibebaton-model-catalog-sync", daemon=True)
    thread.start()
    return thread


def recommend_role_assignment(
    role_name: str,
    ready_providers: Sequence[str],
    models: Sequence[ModelCatalogEntry] = BUNDLED_MODELS,
) -> dict[str, str] | None:
    """Pick the top-ranked {provider, model, effort} for ``role_name`` filtered to ``ready_providers``."""
    ready_list = list(dict.fromkeys(ready_providers))
    if not ready_list:
        return None
    ready_set = set(ready_list)
    tier = ROLE_TIERS.get(role_name, "L2")

    for rec in TIER_RECOMMENDATIONS[tier]:
        for pid in rec["providers"]:
            if pid in ready_set:
                return {"provider": pid, "model": rec["model"], "effort": rec["effort"]}

    fallback_provider = ready_list[0]
    provider_models = [m for m in models if fallback_provider in m["providers"]]
    if not provider_models:
        return {"provider": fallback_provider, "model": "", "effort": "medium" if tier in ("L0", "L1") else "max"}

    target_tier: ModelCostTier = "flagship" if tier == "L0" else "eco" if tier == "L3" else "standard"
    chosen = next((m for m in provider_models if m["cost_tier"] == target_tier), provider_models[0])
    effort = "medium" if tier in ("L0", "L1") else "max"
    return {"provider": fallback_provider, "model": chosen["id"], "effort": effort}
