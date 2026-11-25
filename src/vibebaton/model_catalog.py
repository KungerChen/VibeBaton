"""Full model catalog, tiered market-rank recommendations, and daily 24h sync cache."""

from __future__ import annotations

import json
import math
import os
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
DEFAULT_SYNC_TIMEOUT_SEC = 5.0
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
    _model("fable-5.2", "Fable 5.2", "claude", ("claude_sub",), "latest", "flagship", 1, "medium"),
    _model("opus-5.5", "Opus 5.5", "claude", ("claude_sub",), "latest", "flagship", 2, "medium"),
    _model("sonnet-5.5", "Sonnet 5.5", "claude", ("claude_sub",), "latest", "standard", 3, "max"),
    _model("haiku-5.5", "Haiku 5.5", "claude", ("claude_sub",), "latest", "eco", 4, "max"),
    _model("claude-opus-4-6", "Claude Opus 4.6", "claude", ("claude_sub",), "legacy", "flagship", 5, "high"),
    _model("claude-sonnet-4-6", "Claude Sonnet 4.6", "claude", ("claude_sub",), "legacy", "standard", 6, "high"),
    _model("claude-opus-4-5", "Claude Opus 4.5", "claude", ("claude_sub",), "legacy", "flagship", 7, "high"),
    _model("claude-haiku-4-5", "Claude Haiku 4.5", "claude", ("claude_sub",), "legacy", "eco", 8, "max"),
    # OpenAI / Codex family
    _model("gpt-6.2-astra", "GPT-6.2 Astra", "openai", ("codex_sub", "openai_http"), "latest", "flagship", 1, "xhigh"),
    _model("gpt-6.2-sol", "GPT-6.2 Sol", "openai", ("codex_sub", "openai_http"), "latest", "standard", 2, "max"),
    _model("gpt-6.1-terra", "GPT-6.1 Terra", "openai", ("codex_sub", "openai_http"), "latest", "eco", 3, "max"),
    _model("gpt-6-luna", "GPT-6 Luna", "openai", ("codex_sub", "openai_http"), "latest", "eco", 4, "max"),
    _model("gpt-5-codex", "GPT-5 Codex", "openai", ("codex_sub", "openai_http"), "legacy", "standard", 5, "high"),
    _model("gpt-5", "GPT-5", "openai", ("codex_sub", "openai_http"), "legacy", "standard", 6, "high"),
    _model("gpt-5-mini", "GPT-5 Mini", "openai", ("codex_sub", "openai_http"), "legacy", "eco", 7, "high"),
    _model("gpt-4.1", "GPT-4.1", "openai", ("codex_sub", "openai_http"), "legacy", "standard", 8, "high"),
    _model("gpt-4o", "GPT-4o", "openai", ("codex_sub", "openai_http"), "legacy", "standard", 9, "high"),
    _model("o3", "o3", "openai", ("codex_sub", "openai_http"), "legacy", "standard", 10, "high"),
    _model("o4-mini", "o4-mini", "openai", ("codex_sub", "openai_http"), "legacy", "eco", 11, "high"),
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
            "model": "fable-5.2",
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
            "model": "opus-5.5",
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
            "model": "sonnet-5.5",
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
            "model": "haiku-5.5",
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


def _classify_remote_model(model_id: str, row: Mapping[str, Any]) -> ModelCatalogEntry | None:
    if "/" in model_id:
        return None
    lower = model_id.lower()
    if any(skip in lower for skip in ("embed", "tts", "whisper", "dall-e", "realtime", "audio", "moderation", "image", "sora")):
        return None
    if row.get("deprecation_date") is not None:
        return None

    mode = str(row.get("mode") or "").lower()
    if mode and mode not in ("chat", "responses"):
        return None

    litellm_provider = str(row.get("litellm_provider") or "").lower()
    if litellm_provider == "anthropic" or lower.startswith("claude-"):
        family, providers = "claude", ["claude_sub"]
    elif litellm_provider in ("openai", "azure") or lower.startswith(("gpt-", "o1", "o3", "o4")):
        family, providers = "openai", ["codex_sub", "openai_http"]
    elif litellm_provider in ("gemini", "vertex_ai") or lower.startswith("gemini-"):
        family, providers = "gemini", ["gemini_sub", "gemini_http"]
    elif litellm_provider == "deepseek" or lower.startswith("deepseek-"):
        family, providers = "deepseek", ["dsh_opencode", "dsh_deepseek"]
    else:
        return None

    cost_tier: ModelCostTier = "eco" if any(k in lower for k in ("flash", "mini", "nano", "haiku", "hydrogen", "lite")) else (
        "flagship" if any(k in lower for k in ("opus", "astra", "fable", "carbon", "pro")) else "standard"
    )
    return {
        "id": model_id,
        "label": model_id,
        "family": family,
        "providers": providers,
        "status": "synced",
        "cost_tier": cost_tier,
        "rank": 50,
        "efforts": list(_EFFORT_IDS),
        "default_effort": "medium" if cost_tier == "flagship" else "high",
    }


def _read_catalog_cache(path: Path) -> tuple[float | None, list[ModelCatalogEntry]]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, OSError, ValueError, RecursionError):
        return None, []
    if not isinstance(payload, dict):
        return None, []
    fetched_at = payload.get("fetched_at")
    fetched = float(fetched_at) if isinstance(fetched_at, (int, float)) and math.isfinite(fetched_at) else None
    raw_models = payload.get("models")
    if not isinstance(raw_models, list):
        return fetched, []
    entries: list[ModelCatalogEntry] = []
    for item in raw_models:
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
    return fetched, entries


def _write_catalog_cache(path: Path, fetched_at: float, synced_models: list[ModelCatalogEntry]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(
        json.dumps({"fetched_at": fetched_at, "models": synced_models}, indent=2) + "\n",
        encoding="utf-8",
    )
    os.replace(tmp, path)


def _merge_catalog(synced: list[ModelCatalogEntry]) -> list[ModelCatalogEntry]:
    bundled_ids = {entry["id"] for entry in BUNDLED_MODELS}
    merged: list[ModelCatalogEntry] = [{**entry, "providers": list(entry["providers"]), "efforts": list(entry["efforts"])} for entry in BUNDLED_MODELS]
    seen = set(bundled_ids)
    for item in sorted(synced, key=lambda entry: (entry["family"], entry["id"])):
        if item["id"] in seen:
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
    """Fetch remote public model feed once per 24h without ever deleting bundled active/legacy models."""
    resolved_cache = resolve_catalog_cache_path(cache_path)
    now = now_fn()
    fetched_at, existing_synced = _read_catalog_cache(resolved_cache)
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
        bundled_ids = {entry["id"] for entry in BUNDLED_MODELS}
        discovered: list[ModelCatalogEntry] = []
        for model_id, row in payload.items():
            if not isinstance(model_id, str) or model_id in bundled_ids or not isinstance(row, Mapping):
                continue
            classified = _classify_remote_model(model_id, row)
            if classified is not None:
                discovered.append(classified)
        with _CACHE_LOCK:
            _write_catalog_cache(resolved_cache, now, discovered)
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
    fetched_at, synced = _read_catalog_cache(resolved_cache)
    now = now_fn()
    age_sec = None if fetched_at is None else round(max(0.0, now - fetched_at), 1)
    stale = fetched_at is None or (age_sec is not None and age_sec >= DAILY_SYNC_INTERVAL_SEC)
    return {
        "models": _merge_catalog(synced),
        "tier_recommendations": TIER_RECOMMENDATIONS,
        "role_tiers": dict(ROLE_TIERS),
        "efforts": list(EFFORT_LEVELS),
        "cache": {
            "path": str(resolved_cache),
            "fetched_at": fetched_at,
            "age_sec": age_sec,
            "stale": stale,
            "refresh_interval_hours": 24,
        },
    }


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
