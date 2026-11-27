"""Full model catalog, tiered market-rank recommendations, and daily 24h sync cache."""

from __future__ import annotations

import functools
import json
import math
from datetime import date, datetime, timezone
import os
import re
import shutil
import subprocess
import threading
import time
import urllib.request
from collections.abc import Callable, Mapping, Sequence
from pathlib import Path
from typing import Any, Literal, NotRequired, TypedDict

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

# Every effort level any source reports, weakest first (the order "closest lower level" relies on).
EFFORT_LEVELS: tuple[dict[str, str], ...] = (
    {"id": "minimal", "label": "Minimal"},
    {"id": "low", "label": "Low"},
    {"id": "medium", "label": "Medium"},
    {"id": "high", "label": "High"},
    {"id": "xhigh", "label": "XHigh"},
    {"id": "max", "label": "Max"},
    {"id": "ultra", "label": "Ultra"},
)
_EFFORT_IDS = tuple(item["id"] for item in EFFORT_LEVELS)
_EFFORT_RANK = {effort: index for index, effort in enumerate(_EFFORT_IDS)}
# Used only when no tool list, tool declaration or feed flag says anything about a model.
DEFAULT_EFFORTS: tuple[str, ...] = ("low", "medium", "high")
EffortSource = Literal["cli_models", "cli_declared", "feed", "default"]

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
    # Allowed efforts per provider (an empty list: the tool takes no effort, send none).
    provider_efforts: dict[str, list[str]]
    # Where each provider's list came from, and that provider's legal default effort ("" when none).
    effort_sources: NotRequired[dict[str, EffortSource]]
    provider_defaults: NotRequired[dict[str, str]]


class TierRecommendation(TypedDict):
    providers: list[str]
    model: str
    effort: str
    note_en: str
    note_zh: str


def _model(
    model_id: str,
    family: str,
    providers: Sequence[str],
    status: ModelStatus,
    cost_tier: ModelCostTier,
    rank: int,
    default_effort: str,
    *,
    efforts: Sequence[str] | None = None,
    provider_efforts: Mapping[str, Sequence[str]] | None = None,
) -> ModelCatalogEntry:
    return {
        "id": model_id,
        "label": _model_label(model_id),
        "family": family,
        "providers": list(providers),
        "status": status,
        "cost_tier": cost_tier,
        "rank": rank,
        "efforts": list(efforts) if efforts is not None else list(DEFAULT_EFFORTS),
        "default_effort": default_effort,
        "provider_efforts": {k: list(v) for k, v in provider_efforts.items()} if provider_efforts else {},
    }


_VERSION_TOKEN = re.compile(r"^v?(\d{1,3}(?:\.\d{1,3})*)$")
_LABEL_WORDS = {"gpt": "GPT", "claude": "Claude", "gemini": "Gemini", "deepseek": "DeepSeek"}


def _model_label(model_id: str) -> str:
    """Readable label, e.g. claude-opus-4-7 -> Claude Opus 4.7, gpt-5.4-mini -> GPT-5.4 Mini, gpt-4o -> GPT-4o."""
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
        elif words == ["GPT"] and token[:1].isdigit():
            words[0] = f"GPT-{token}"
        elif token.isdigit():
            words.append("-".join(tokens[index:]))
            break
        else:
            words.append(_LABEL_WORDS.get(token.lower(), token.upper() if version else token.capitalize()))
        index += 1
    return " ".join(words)


# Complete active model roster across supported providers. Ordered by tier capability within each family,
# keeping both latest models and older non-retired models selectable; labels come from ``_model_label``.
BUNDLED_MODELS: tuple[ModelCatalogEntry, ...] = (
    # Gemini family
    # Gemini CLI (gemini_sub) does not offer the Gemini 4 line; Antigravity and the API do.
    _model("gemini-4-carbon", "gemini", ("agy_sub", "gemini_http"), "latest", "flagship", 1, "medium"),
    _model("gemini-4-neon", "gemini", ("agy_sub", "gemini_http"), "latest", "standard", 2, "medium"),
    _model("gemini-4-hydrogen", "gemini", ("agy_sub", "gemini_http"), "latest", "eco", 3, "high"),
    _model("gemini-2.5-pro", "gemini", ("agy_sub", "gemini_sub", "gemini_http"), "legacy", "flagship", 4, "medium"),
    _model("gemini-2.5-flash", "gemini", ("agy_sub", "gemini_sub", "gemini_http"), "legacy", "eco", 5, "high"),
    _model("gemini-2.0-flash", "gemini", ("gemini_sub", "gemini_http"), "legacy", "eco", 6, "high"),
    # Claude family
    _model("claude-fable-5-2", "claude", ("claude_sub",), "latest", "flagship", 1, "medium"),
    _model("claude-opus-5-5", "claude", ("claude_sub", "agy_sub"), "latest", "flagship", 2, "medium"),
    _model("claude-sonnet-5-5", "claude", ("claude_sub", "agy_sub"), "latest", "standard", 3, "high"),
    _model("claude-haiku-5-5", "claude", ("claude_sub", "agy_sub"), "latest", "eco", 4, "max"),
    _model("claude-opus-4-6", "claude", ("claude_sub",), "legacy", "flagship", 5, "high"),
    _model("claude-sonnet-4-6", "claude", ("claude_sub",), "legacy", "standard", 6, "high"),
    _model("claude-opus-4-5", "claude", ("claude_sub",), "legacy", "flagship", 7, "high"),
    _model("claude-haiku-4-5", "claude", ("claude_sub",), "legacy", "eco", 8, "max"),
    # OpenAI / Codex family
    _model("gpt-6.2-astra", "openai", ("codex_sub", "openai_http"), "latest", "flagship", 1, "xhigh"),
    _model("gpt-6.2-sol", "openai", ("codex_sub", "openai_http"), "latest", "standard", 2, "max"),
    _model("gpt-6.1-terra", "openai", ("codex_sub", "openai_http"), "latest", "eco", 3, "max"),
    _model("gpt-6-luna", "openai", ("codex_sub", "openai_http"), "latest", "eco", 4, "max"),
    _model("gpt-5-codex", "openai", ("openai_http",), "legacy", "standard", 5, "high"),
    _model("gpt-5", "openai", ("openai_http",), "legacy", "standard", 6, "high"),
    _model("gpt-5-mini", "openai", ("openai_http",), "legacy", "eco", 7, "high"),
    _model("gpt-4.1", "openai", ("openai_http",), "legacy", "standard", 8, "high"),
    _model("gpt-4o", "openai", ("openai_http",), "legacy", "standard", 9, "high"),
    _model("o3", "openai", ("openai_http",), "legacy", "standard", 10, "high"),
    _model("o4-mini", "openai", ("openai_http",), "legacy", "eco", 11, "high"),
    # DeepSeek / DSH family. dsh_opencode lists exactly the models presets/dsh-headless-opencode-go.patch.yml
    # defines (their efforts come from that file); dsh_deepseek lists DeepSeek's own API IDs.
    _model("deepseek-v4.1-flash", "deepseek", ("dsh_opencode",), "latest", "eco", 1, "max"),
    _model("deepseek-v4-pro", "deepseek", ("dsh_opencode", "dsh_deepseek"), "latest", "standard", 2, "high"),
    _model("deepseek-v4-flash", "deepseek", ("dsh_deepseek",), "latest", "eco", 3, "max"),
    _model("deepseek-reasoner", "deepseek", ("dsh_deepseek",), "legacy", "standard", 4, "high"),
    _model("deepseek-chat", "deepseek", ("dsh_deepseek",), "legacy", "eco", 5, "high"),
)
# Channel-only IDs that the first-party feed never lists; never hide them for being absent from it.
_FEED_ABSENCE_EXEMPT_IDS = frozenset({"deepseek-v4.1-flash"})

# Ranked market recommendations per tier. Each entry's effort is legal for every provider it lists
# (tests/test_effort_invariants.py checks this against a fixed tool/feed fixture); at run time
# ``recommend_role_assignment`` still normalizes it against the live catalog.
TIER_RECOMMENDATIONS: dict[RoleTier, list[TierRecommendation]] = {
    "L0": [
        {
            "providers": ["agy_sub", "gemini_http"],
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
            "providers": ["codex_sub"],
            "model": "gpt-6.2-astra",
            "effort": "xhigh",
            "note_en": "High-reasoning flagship fallback.",
            "note_zh": "第三顺位：GPT-6.2 Astra（XHigh 思考强度）。",
        },
        {
            "providers": ["openai_http"],
            "model": "gpt-6.2-astra",
            "effort": "high",
            "note_en": "High-reasoning flagship fallback over the API.",
            "note_zh": "第三顺位（API）：GPT-6.2 Astra（High 思考强度）。",
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
            "providers": ["agy_sub", "gemini_http"],
            "model": "gemini-4-neon",
            "effort": "medium",
            "note_en": "Secondary L1 planning model at medium effort.",
            "note_zh": "次选：Gemini 4N（中等思考强度）。",
        },
        {
            "providers": ["codex_sub"],
            "model": "gpt-6.2-sol",
            "effort": "max",
            "note_en": "Third L1 ranked alternative.",
            "note_zh": "第三顺位：GPT-6.2 Sol（Max 思考强度）。",
        },
        {
            "providers": ["openai_http"],
            "model": "gpt-6.2-sol",
            "effort": "high",
            "note_en": "Third L1 ranked alternative over the API.",
            "note_zh": "第三顺位（API）：GPT-6.2 Sol（High 思考强度）。",
        },
    ],
    "L2": [
        {
            "providers": ["codex_sub"],
            "model": "gpt-6.2-sol",
            "effort": "max",
            "note_en": "Top L2 code execution & micro-review model at Max effort.",
            "note_zh": "L2 首选：GPT-6.2 Sol（Max 思考强度，专注核心代码攻坚）。",
        },
        {
            "providers": ["openai_http"],
            "model": "gpt-6.2-sol",
            "effort": "high",
            "note_en": "Top L2 code execution model over the API.",
            "note_zh": "L2 首选（API）：GPT-6.2 Sol（High 思考强度）。",
        },
        {
            "providers": ["claude_sub"],
            "model": "claude-sonnet-5-5",
            "effort": "max",
            "note_en": "Secondary L2 specialist at Max effort.",
            "note_zh": "次选：Sonnet 5.5（Max 思考强度）。",
        },
        {
            "providers": ["agy_sub"],
            "model": "gemini-4-hydrogen",
            "effort": "xhigh",
            "note_en": "Third L2 specialist at XHigh effort, the highest Antigravity offers.",
            "note_zh": "第三顺位：Gemini 4H（XHigh 思考强度，Antigravity 的最高档）。",
        },
        {
            "providers": ["gemini_http"],
            "model": "gemini-4-hydrogen",
            "effort": "high",
            "note_en": "Third L2 specialist over the API.",
            "note_zh": "第三顺位（API）：Gemini 4H（High 思考强度）。",
        },
    ],
    "L3": [
        {
            "providers": ["dsh_opencode"],
            "model": "deepseek-v4.1-flash",
            "effort": "max",
            "note_en": "Best value high-concurrency worker at Max effort.",
            "note_zh": "L3 首选高性价比主力：DeepSeek V4.1 Flash（Max 思考强度）。",
        },
        {
            "providers": ["dsh_deepseek"],
            "model": "deepseek-v4-flash",
            "effort": "high",
            "note_en": "Best value worker on the DeepSeek API.",
            "note_zh": "L3 首选（DeepSeek 官方 API）：DeepSeek V4 Flash（High 思考强度）。",
        },
        {
            "providers": ["claude_sub"],
            "model": "claude-haiku-5-5",
            "effort": "max",
            "note_en": "Secondary value worker at Max effort.",
            "note_zh": "次选高性价比：Haiku 5.5（Max 思考强度）。",
        },
        {
            "providers": ["codex_sub"],
            "model": "gpt-6.1-terra",
            "effort": "max",
            "note_en": "Third value worker option at Max effort.",
            "note_zh": "第三顺位：GPT-6.1 Terra（Max 思考强度）。",
        },
        {
            "providers": ["openai_http"],
            "model": "gpt-6.1-terra",
            "effort": "high",
            "note_en": "Third value worker option over the API.",
            "note_zh": "第三顺位（API）：GPT-6.1 Terra（High 思考强度）。",
        },
        {
            "providers": ["codex_sub"],
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
    "gemini": ("gemini", ["agy_sub", "gemini_sub", "gemini_http"]),
    # Only DeepSeek's own API; the OpenCode channel (dsh_opencode) is defined by the DSH patch file.
    "deepseek": ("deepseek", ["dsh_deepseek"]),
}
# Feed keys such as ``gemini/gemini-2.5-pro`` carry the Gemini API row; the bare key is often Vertex.
# ``deepseek/...`` rows (deepseek-r1, deepseek-coder, ...) are not the official API's IDs, so they are skipped.
_FIRST_PARTY_PREFIXES = ("gemini",)


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
_FAMILY_ID_PATTERNS = {
    "claude": r"claude-",
    "openai": r"(?:gpt-|o\d)",
    "gemini": r"gemini-(?!gemma)",
    "deepseek": r"deepseek-",
}
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


def _rank_catalog(entries: list[ModelCatalogEntry]) -> list[ModelCatalogEntry]:
    """Rank each family as one list: bundled models keep their curated order and every other model
    is slotted in by version, so a newer synced model ranks ahead of older bundled ones."""
    curated_order = {entry["id"]: index for index, entry in enumerate(BUNDLED_MODELS)}
    ranked: list[ModelCatalogEntry] = []
    for family in dict.fromkeys(entry["family"] for entry in entries):
        members = [entry for entry in entries if entry["family"] == family]
        curated = sorted((e for e in members if e["id"] in curated_order), key=lambda e: curated_order[e["id"]])
        others = sorted(
            (e for e in members if e["id"] not in curated_order),
            key=lambda e: (
                tuple(-part for part in (_model_version(e["id"]) + (0, 0, 0, 0))[:4]),
                _COST_ORDER[e["cost_tier"]],
                e["id"],
            ),
        )
        merged: list[ModelCatalogEntry] = []
        while curated or others:
            if others and (not curated or _model_version(others[0]["id"]) > _model_version(curated[0]["id"])):
                merged.append(others.pop(0))
            else:
                merged.append(curated.pop(0))
        ranked.extend({**entry, "rank": offset + 1} for offset, entry in enumerate(merged))
    return ranked


def _classify_remote_model(model_id: str, row: Mapping[str, Any]) -> ModelCatalogEntry | None:
    lower = model_id.lower()
    if any(skip in lower for skip in ("embed", "tts", "whisper", "dall-e", "realtime", "audio", "moderation", "image", "sora")):
        return None
    # Mythos is only open to approved organisations, so a Claude subscription cannot call it.
    if lower.startswith("claude-mythos"):
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
    # luna / terra are the eco lines, as for the bundled gpt-6-luna and gpt-6.1-terra.
    cost_tier: ModelCostTier = "eco" if tokens & {"flash", "mini", "nano", "haiku", "hydrogen", "lite", "luna", "terra"} else (
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
        "efforts": list(DEFAULT_EFFORTS),
        "default_effort": "medium" if cost_tier == "flagship" else "high",
        "provider_efforts": {},
    }


# Subscription CLIs that report their own model list; for these, the CLI's list replaces the feed mapping.
CliModels = dict[str, dict[str, list[str]]]
_CLI_FEED_PROVIDER = {"gemini_sub": "gemini", "codex_sub": "openai"}
_GEMINI_MODEL_LINE = re.compile(r"^(gemini-[\w.\-]+) \(")
_ANSI_ESCAPE = re.compile(r"\x1b\[[0-9;]*[A-Za-z]")
_AGY_MODEL_ID_RE = re.compile(r"^(?:gemini|claude|gpt)-[\w.\-]+$", re.IGNORECASE)
_AGY_EFFORT_SUFFIX_RE = re.compile(r"^(.+?)-(low|medium|high|xhigh|max|ultra)$", re.IGNORECASE)
_AGY_EFFORT_ORDER = {"low": 0, "medium": 1, "high": 2, "xhigh": 3, "max": 4, "ultra": 5}
CLI_PROBE_TIMEOUT_SEC = 30.0


def parse_gemini_model_list(text: str) -> list[str]:
    """Model IDs from ``gemini --list-models``; the ``auto`` router entry is not a model and is skipped."""
    # With FORCE_COLOR set (as some launchers do) the CLI wraps model IDs in ANSI bold codes.
    plain = _ANSI_ESCAPE.sub("", text)
    found = (match.group(1) for line in plain.splitlines() if (match := _GEMINI_MODEL_LINE.match(line)))
    return list(dict.fromkeys(found))


def _record_agy_slug(grouped: dict[str, list[str]], slug: str) -> None:
    normalized = slug.strip().lower()
    if not _AGY_MODEL_ID_RE.fullmatch(normalized):
        return
    suffix = _AGY_EFFORT_SUFFIX_RE.match(normalized)
    if suffix:
        base_id, effort = suffix.group(1), suffix.group(2)
        efforts = grouped.setdefault(base_id, [])
        if effort not in efforts:
            efforts.append(effort)
    else:
        grouped.setdefault(normalized, [])


def parse_agy_models(text: str) -> dict[str, list[str]]:
    """``{base_model_id: efforts}`` from ``agy models`` (tab-separated text, ANSI table, or JSON)."""
    clean = _ANSI_ESCAPE.sub("", text).strip()
    if not clean:
        return {}
    grouped: dict[str, list[str]] = {}
    if clean.startswith(("[", "{")):
        try:
            payload = json.loads(clean)
        except (ValueError, RecursionError):
            payload = None
        items = payload.get("models") if isinstance(payload, Mapping) else payload
        if isinstance(items, list):
            for item in items:
                raw_id = item if isinstance(item, str) else (
                    next(
                        (item.get(k) for k in ("id", "slug", "modelId", "name") if isinstance(item.get(k), str)),
                        None,
                    )
                    if isinstance(item, Mapping) else None
                )
                if raw_id:
                    _record_agy_slug(grouped, raw_id)
            if grouped:
                return {
                    model_id: sorted(efforts, key=lambda e: _AGY_EFFORT_ORDER.get(e, 99))
                    for model_id, efforts in grouped.items()
                }
    for line in clean.splitlines():
        stripped = line.strip()
        if not stripped:
            continue
        _record_agy_slug(grouped, stripped.split()[0])
    return {
        model_id: sorted(efforts, key=lambda e: _AGY_EFFORT_ORDER.get(e, 99))
        for model_id, efforts in grouped.items()
    }


def parse_agy_model_list(text: str) -> list[str]:
    """Base model IDs from ``agy models`` (stripping effort suffixes such as ``-medium``)."""
    return list(parse_agy_models(text))


def _infer_cli_feed_provider(provider: str, model_id: str) -> str:
    lower = model_id.lower()
    if provider == "agy_sub":
        if lower.startswith("gemini-"):
            return "gemini"
        if lower.startswith("claude-"):
            return "anthropic"
        if lower.startswith("gpt-") or re.match(r"^o\d", lower):
            return "openai"
    return _CLI_FEED_PROVIDER.get(provider, "")


def parse_codex_models_cache(payload: Any) -> dict[str, list[str]]:
    """``{slug: efforts}`` for models Codex lists in its own picker (``visibility: list``)."""
    models = payload.get("models") if isinstance(payload, Mapping) else None
    found: dict[str, list[str]] = {}
    for item in models if isinstance(models, list) else []:
        if not isinstance(item, Mapping) or item.get("visibility", "list") != "list":
            continue
        slug = item.get("slug")
        if not isinstance(slug, str) or not slug:
            continue
        levels = item.get("supported_reasoning_levels")
        found[slug] = [
            level["effort"] for level in (levels if isinstance(levels, list) else [])
            if isinstance(level, Mapping) and isinstance(level.get("effort"), str)
        ]
    return found


def _default_codex_cache_path() -> Path:
    return Path(os.environ.get("CODEX_HOME") or "~/.codex").expanduser() / "models_cache.json"


def _resolve_agy_for_probe(which: Callable[[str], str | None]) -> str | None:
    found = which("agy")
    if found or which is not shutil.which:
        return found
    from .cli_runner import resolve_cli_binary
    return resolve_cli_binary("agy")


def probe_cli_models(
    *,
    run: Callable[..., subprocess.CompletedProcess[str]] = subprocess.run,
    which: Callable[[str], str | None] = shutil.which,
    codex_cache_path: Path | None = None,
    timeout_sec: float = CLI_PROBE_TIMEOUT_SEC,
) -> CliModels:
    """Ask each subscription CLI what it offers; a missing, slow, or unreadable CLI is simply left out."""
    found: CliModels = {}
    agy = _resolve_agy_for_probe(which)
    if agy:
        try:
            proc = run(
                [agy, "models"], capture_output=True, text=True,
                encoding="utf-8", errors="replace", timeout=timeout_sec,
            )
            agy_models = parse_agy_models(proc.stdout or "") if proc.returncode == 0 else {}
            if agy_models:
                found["agy_sub"] = agy_models
        except (OSError, subprocess.SubprocessError, ValueError):
            pass
    gemini = which("gemini")
    if gemini:
        try:
            proc = run(
                [gemini, "--list-models"], capture_output=True, text=True,
                encoding="utf-8", errors="replace", timeout=timeout_sec,
            )
            gemini_models = parse_gemini_model_list(proc.stdout or "") if proc.returncode == 0 else []
            if gemini_models:
                found["gemini_sub"] = {model_id: [] for model_id in gemini_models}
        except (OSError, subprocess.SubprocessError, ValueError):
            pass
    try:
        path = codex_cache_path or _default_codex_cache_path()
        codex_models = parse_codex_models_cache(json.loads(path.read_text(encoding="utf-8")))
        if codex_models:
            found["codex_sub"] = codex_models
    except (OSError, ValueError, RecursionError):
        pass
    return found


def _apply_cli_models(models: list[ModelCatalogEntry], cli_models: CliModels) -> list[ModelCatalogEntry]:
    """Make each CLI-reported provider list exactly the CLI's models; other providers are untouched."""
    by_id = {entry["id"]: entry for entry in models}
    bundled = {entry["id"]: entry for entry in BUNDLED_MODELS}
    for provider, listed in cli_models.items():
        for entry in models:
            if provider in entry["providers"] and entry["id"] not in listed:
                entry["providers"] = [p for p in entry["providers"] if p != provider]
        for model_id, efforts in listed.items():
            entry = by_id.get(model_id)
            if entry is None:
                base = bundled.get(model_id) or _classify_remote_model(
                    model_id, {"litellm_provider": _infer_cli_feed_provider(provider, model_id)},
                )
                if base is None:
                    continue
                entry = {
                    **base,
                    "providers": [],
                    "efforts": list(base["efforts"]),
                    "provider_efforts": {k: list(v) for k, v in base["provider_efforts"].items()},
                }
                models.append(entry)
                by_id[model_id] = entry
            if provider not in entry["providers"]:
                entry["providers"] = [*entry["providers"], provider]
    return [entry for entry in models if entry["providers"]]


class _CatalogCache(TypedDict):
    fetched_at: float | None
    models: list[ModelCatalogEntry]
    retired_ids: list[str]
    cli_models: CliModels
    last_error: str | None
    # {provider: efforts} a tool declares for all its models (Claude Code's ``--effort`` help line).
    cli_declared: NotRequired[dict[str, list[str]]]
    # {model_id: efforts} derived from the feed's reasoning flags (HTTP channels and dsh_deepseek).
    feed_efforts: NotRequired[dict[str, list[str]]]


def _read_cli_models(raw: Any) -> CliModels:
    result: CliModels = {}
    for provider, listed in (raw.items() if isinstance(raw, dict) else []):
        if isinstance(provider, str) and isinstance(listed, dict):
            result[provider] = {
                str(model_id): [str(e) for e in efforts if isinstance(e, str)]
                for model_id, efforts in listed.items() if isinstance(efforts, list)
            }
    return result


def _read_catalog_cache(path: Path) -> _CatalogCache:
    empty: _CatalogCache = {"fetched_at": None, "models": [], "retired_ids": [], "cli_models": {}, "last_error": None,
                            "cli_declared": {}, "feed_efforts": {}}
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, OSError, ValueError, RecursionError):
        return empty
    if not isinstance(payload, dict):
        return empty
    fetched_at = payload.get("fetched_at")
    fetched = float(fetched_at) if isinstance(fetched_at, (int, float)) and math.isfinite(fetched_at) else None
    raw_retired = payload.get("retired_ids")
    if not isinstance(raw_retired, list) or "cli_models" not in payload:
        # Written by an older sync (unfiltered, or without CLI lists): keep its models readable but re-fetch once.
        fetched = None
    if not isinstance(raw_retired, list):
        raw_retired = []
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
            "efforts": list(DEFAULT_EFFORTS),
            "default_effort": str(item.get("default_effort") or "high"),
            "provider_efforts": {},
        })
    last_error = payload.get("last_error")
    return {
        "fetched_at": fetched,
        "models": entries,
        "retired_ids": retired,
        "cli_models": _read_cli_models(payload.get("cli_models")),
        "last_error": last_error if isinstance(last_error, str) else None,
        "cli_declared": _read_effort_map(payload.get("cli_declared")),
        "feed_efforts": _read_effort_map(payload.get("feed_efforts")),
    }


def _read_effort_map(raw: Any) -> dict[str, list[str]]:
    return {
        str(key): [str(e) for e in value if isinstance(e, str)]
        for key, value in (raw.items() if isinstance(raw, dict) else []) if isinstance(value, list)
    }


def _write_catalog_cache(path: Path, cache: _CatalogCache) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(cache, indent=2) + "\n", encoding="utf-8")
    os.replace(tmp, path)


def _merge_catalog(synced: list[ModelCatalogEntry], retired_ids: Sequence[str] = ()) -> list[ModelCatalogEntry]:
    retired = set(retired_ids)
    merged: list[ModelCatalogEntry] = [
        {
            **entry,
            "providers": list(entry["providers"]),
            "efforts": list(entry["efforts"]),
            "provider_efforts": {k: list(v) for k, v in entry["provider_efforts"].items()},
        }
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
    cli_probe: Callable[[], CliModels] | None = None,
    declared_probe: Callable[[], dict[str, list[str]]] | None = None,
) -> dict[str, Any]:
    """Fetch the public model feed once per 24h; models the feed has retired are hidden, failures are kept in the cache.

    ``cli_probe`` (``probe_cli_models`` in the Studio server) refreshes the subscription CLIs' own model lists
    in the same pass; without it the previously cached lists are kept.
    """
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
    previous_cache = _read_catalog_cache(resolved_cache)
    cli_models = previous_cache["cli_models"]
    cli_declared = previous_cache.get("cli_declared", {})
    if cli_probe is not None:
        try:
            cli_models = cli_probe()
        except Exception:
            pass
    if declared_probe is not None:
        try:
            cli_declared = declared_probe()
        except Exception:
            pass
    try:
        raw = fn(source_url, timeout_sec)
        payload = json.loads(raw.decode("utf-8") if isinstance(raw, bytes) else raw) if not isinstance(raw, Mapping) else raw
        if not isinstance(payload, Mapping):
            raise ValueError("Model catalog payload must be a JSON object")
        today = datetime.fromtimestamp(now, timezone.utc).date()
        rows = _first_party_rows(payload)
        retired = {model_id for model_id, row in rows.items() if _is_retired(row, today)}
        # A bundled model whose family the feed covers but which the feed no longer lists at all is gone too.
        feed_families = {_FIRST_PARTY_PROVIDERS[str(row.get("litellm_provider")).lower()][0] for row in rows.values()}
        retired.update(
            entry["id"] for entry in BUNDLED_MODELS
            if entry["family"] in feed_families and entry["id"] not in rows
            and entry["id"] not in _FEED_ABSENCE_EXEMPT_IDS
        )
        retired_ids = sorted(retired)
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
        feed_efforts = {
            model_id: efforts for model_id, row in rows.items()
            if (efforts := feed_reasoning_efforts(row)) is not None
        }
        with _CACHE_LOCK:
            _write_catalog_cache(
                resolved_cache,
                {"fetched_at": now, "models": discovered, "retired_ids": retired_ids,
                 "cli_models": cli_models, "last_error": None,
                 "cli_declared": cli_declared, "feed_efforts": feed_efforts},
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
                _write_catalog_cache(
                    resolved_cache,
                    {**previous, "cli_models": cli_models, "cli_declared": cli_declared,
                     "last_error": str(exc) or type(exc).__name__},
                )
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
        "models": resolve_catalog_efforts(
            _rank_catalog(
                _apply_cli_models(_merge_catalog(cached["models"], cached["retired_ids"]), cached["cli_models"]),
            ),
            cli_models=cached["cli_models"],
            cli_declared=cached.get("cli_declared", {}),
            feed_efforts=cached.get("feed_efforts", {}),
        ),
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
    cli_probe: Callable[[], CliModels] = probe_cli_models,
    declared_probe: Callable[[], dict[str, list[str]]] | None = None,
) -> threading.Thread | None:
    """Check right away and then hourly in a daemon thread; ``sync_model_catalog`` only fetches once 24h old."""
    if os.environ.get("VIBEBATON_DISABLE_MODEL_SYNC") == "1":
        return None
    wait = wait_fn or (lambda event, seconds: event.wait(seconds))
    kwargs: dict[str, Any] = {"cache_path": cache_path, "now_fn": now_fn, "cli_probe": cli_probe,
                              "declared_probe": declared_probe or probe_cli_declared_efforts}
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
    """Pick the top-ranked {provider, model, effort} for ``role_name`` filtered to ``ready_providers``.

    A recommended model the provider does not offer (per ``models``) falls back to that provider's
    best model of the same cost tier; the frontend's ``recommendRoleSpec`` mirrors this. The effort is
    always legal for that provider and model (``""`` when the tool takes none).
    """
    ready_list = list(dict.fromkeys(ready_providers))
    if not ready_list:
        return None
    ready_set = set(ready_list)
    tier = ROLE_TIERS.get(role_name, "L2")
    models = ensure_resolved(models)

    for rec in TIER_RECOMMENDATIONS[tier]:
        for pid in rec["providers"]:
            if pid in ready_set:
                if any(m["id"] == rec["model"] and pid in m["providers"] for m in models):
                    return _legal_pick(pid, rec["model"], rec["effort"], models)
                return _provider_tier_fallback(pid, tier, models)

    return _provider_tier_fallback(ready_list[0], tier, models)


def _legal_pick(provider: str, model: str, effort: str, models: Sequence[ModelCatalogEntry]) -> dict[str, str]:
    normalized = normalize_spec(provider, model, effort, models)
    return {"provider": provider, "model": model, "effort": normalized["effort"]}


def _provider_tier_fallback(provider: str, tier: RoleTier, models: Sequence[ModelCatalogEntry]) -> dict[str, str]:
    effort = "medium" if tier in ("L0", "L1") else "max"
    provider_models = sorted((m for m in models if provider in m["providers"]), key=lambda m: m["rank"])
    if not provider_models:
        return {"provider": provider, "model": "", "effort": effort}
    target_tier: ModelCostTier = "flagship" if tier == "L0" else "eco" if tier == "L3" else "standard"
    chosen = next((m for m in provider_models if m["cost_tier"] == target_tier), provider_models[0])
    return _legal_pick(provider, chosen["id"], effort, models)


# ---- Effort sources and the one normalization every spec goes through ---------------------------------

# Claude Code accepts these aliases for ``--model``; they map to catalog IDs for checking and display only.
CLAUDE_MODEL_ALIASES: dict[str, str] = {
    "opus": "claude-opus-5-5",
    "sonnet": "claude-sonnet-5-5",
    "haiku": "claude-haiku-5-5",
    "fable": "claude-fable-5-2",
}
# Providers whose models are checked against feed reasoning flags.
_FEED_EFFORT_PROVIDERS = frozenset({"openai_http", "gemini_http", "dsh_deepseek"})
# Gemini CLI has no effort flag at all.
_NO_EFFORT_PROVIDERS = frozenset({"gemini_sub"})
DSH_PATCH_FILE = "dsh-headless-opencode-go.patch.yml"


def _known_efforts(values: Sequence[str]) -> list[str]:
    seen = dict.fromkeys(v.strip().lower() for v in values if isinstance(v, str))
    return sorted((v for v in seen if v in _EFFORT_RANK), key=_EFFORT_RANK.__getitem__)


def parse_dsh_patch_efforts(text: str) -> dict[str, list[str]]:
    """``{model_id: efforts}`` from the DSH patch file's ``models:`` list (``reasoningEfforts`` keys).

    Only this file's fixed shape is read: ``- id: <model>`` items inside a ``models:`` block, with an
    optional ``reasoningEfforts:`` mapping below them. Keys we do not recognise (such as ``off``) are
    dropped; a model without ``reasoningEfforts`` takes no effort.
    """
    found: dict[str, list[str]] = {}
    models_indent: int | None = None
    current: str | None = None
    item_indent = -1
    efforts_indent: int | None = None
    for raw in text.splitlines():
        if not raw.strip() or raw.lstrip().startswith("#"):
            continue
        indent = len(raw) - len(raw.lstrip(" "))
        line = raw.strip()
        if efforts_indent is not None:
            if indent > efforts_indent and current is not None:
                key = line.split(":", 1)[0].strip().strip("'\"")
                if key.lower() in _EFFORT_RANK:
                    found[current] = _known_efforts([*found[current], key])
                continue
            efforts_indent = None
        if models_indent is not None and indent <= models_indent and not line.startswith("- "):
            models_indent, current = None, None
        if line == "models:":
            models_indent, current = indent, None
            continue
        match = re.match(r"^-\s+id:\s*['\"]?([\w.\-]+)['\"]?\s*$", line)
        if match and models_indent is not None and indent >= models_indent:
            current, item_indent = match.group(1), indent
            found.setdefault(current, [])
            continue
        if match:
            models_indent, current = None, None
            continue
        if current is not None and indent <= item_indent:
            current = None
        if current is not None and line == "reasoningEfforts:":
            efforts_indent = indent
    return found


@functools.lru_cache(maxsize=1)
def _dsh_patch_efforts_cached() -> tuple[tuple[str, tuple[str, ...]], ...]:
    from .presets import presets_dir

    try:
        parsed = parse_dsh_patch_efforts((presets_dir() / DSH_PATCH_FILE).read_text(encoding="utf-8"))
    except OSError:
        return ()
    return tuple((model, tuple(efforts)) for model, efforts in parsed.items())


def _dsh_patch_efforts() -> dict[str, list[str]]:
    """The shipped DSH patch file is repository data, read like the bundled catalog (no command runs)."""
    return {model: list(efforts) for model, efforts in _dsh_patch_efforts_cached()}


def ensure_resolved(models: Sequence[ModelCatalogEntry]) -> list[ModelCatalogEntry]:
    """Catalog entries with per-provider effort data; raw entries (e.g. ``BUNDLED_MODELS``) are resolved
    from the shipped data only (no tool or feed lists)."""
    if all("effort_sources" in entry for entry in models):
        return list(models)
    return resolve_catalog_efforts(models)


_CLAUDE_EFFORT_HELP = re.compile(r"--effort\b[^\n]*(?:\n[^\n]*){0,2}?\(([^)]*)\)")


def parse_claude_effort_help(text: str) -> list[str] | None:
    """Effort levels from ``claude --help`` (``--effort <level> ... (low, medium, high, xhigh, max)``)."""
    match = _CLAUDE_EFFORT_HELP.search(_ANSI_ESCAPE.sub("", text))
    if not match:
        return None
    efforts = _known_efforts([part for part in re.split(r"[,\s|/]+", match.group(1)) if part])
    return efforts or None


def probe_cli_declared_efforts(
    *,
    run: Callable[..., subprocess.CompletedProcess[str]] = subprocess.run,
    which: Callable[[str], str | None] = shutil.which,
    timeout_sec: float = CLI_PROBE_TIMEOUT_SEC,
) -> dict[str, list[str]]:
    """Tool-wide effort lists a CLI declares; a missing or unparsable CLI is left out."""
    found: dict[str, list[str]] = {}
    claude = which("claude")
    if claude:
        try:
            proc = run([claude, "--help"], capture_output=True, text=True,
                       encoding="utf-8", errors="replace", timeout=timeout_sec)
            efforts = parse_claude_effort_help(proc.stdout or "") if proc.returncode == 0 else None
            if efforts:
                found["claude_sub"] = efforts
        except (OSError, subprocess.SubprocessError, ValueError):
            pass
    return found


def feed_reasoning_efforts(row: Mapping[str, Any]) -> list[str] | None:
    """Efforts derived from a feed row's reasoning flags; None for anything that is not a feed row.

    The feed omits false flags, so a row without ``supports_reasoning`` (gpt-4o, gpt-4.1, deepseek-chat)
    is a model that takes no effort: [] (sending one would be rejected). ``reasoning_effort_levels`` ->
    exactly the levels we know. Otherwise low/medium/high, adding minimal/xhigh/max when their
    ``supports_*_reasoning_effort`` flag is true and dropping low when ``supports_low_reasoning_effort`` is false.
    """
    if not isinstance(row, Mapping) or not row:
        return None
    if not row.get("supports_reasoning") and not isinstance(row.get("reasoning_effort_levels"), list):
        return []
    levels = row.get("reasoning_effort_levels")
    if isinstance(levels, list):
        return _known_efforts([str(level) for level in levels])
    efforts = list(DEFAULT_EFFORTS)
    for level in ("minimal", "xhigh", "max"):
        if row.get(f"supports_{level}_reasoning_effort") is True:
            efforts.append(level)
    if row.get("supports_low_reasoning_effort") is False:
        efforts.remove("low")
    return _known_efforts(efforts)


def _provider_efforts(
    model_id: str,
    provider: str,
    *,
    cli_models: CliModels,
    cli_declared: Mapping[str, Sequence[str]],
    feed_efforts: Mapping[str, Sequence[str]],
    dsh_efforts: Mapping[str, Sequence[str]],
) -> tuple[list[str], EffortSource]:
    """The most reliable effort list for a model on a provider, and where it came from."""
    if provider == "dsh_opencode" and model_id in dsh_efforts:
        return _known_efforts(list(dsh_efforts[model_id])), "cli_models"
    if provider in ("codex_sub", "agy_sub") and model_id in cli_models.get(provider, {}):
        # Tools report their own names (Codex's "ultra"); keep every level we can order.
        return _known_efforts(cli_models[provider][model_id]), "cli_models"
    if provider in _NO_EFFORT_PROVIDERS:
        return [], "cli_declared"
    if provider in cli_declared and cli_declared[provider]:
        return _known_efforts(list(cli_declared[provider])), "cli_declared"
    if provider in _FEED_EFFORT_PROVIDERS and model_id in feed_efforts:
        return _known_efforts(list(feed_efforts[model_id])), "feed"
    return list(DEFAULT_EFFORTS), "default"


def legal_default_effort(preferred: str, allowed: Sequence[str]) -> str:
    """``preferred`` when allowed, else the closest lower allowed level, else the lowest allowed; "" if none."""
    if not allowed:
        return ""
    if preferred in allowed:
        return preferred
    rank = _EFFORT_RANK.get(preferred)
    ordered = sorted(allowed, key=lambda e: _EFFORT_RANK.get(e, 99))
    if rank is not None:
        lower = [e for e in ordered if _EFFORT_RANK.get(e, 99) < rank]
        if lower:
            return lower[-1]
    return ordered[0]


def resolve_catalog_efforts(
    models: Sequence[ModelCatalogEntry],
    *,
    cli_models: CliModels | None = None,
    cli_declared: Mapping[str, Sequence[str]] | None = None,
    feed_efforts: Mapping[str, Sequence[str]] | None = None,
    dsh_efforts: Mapping[str, Sequence[str]] | None = None,
) -> list[ModelCatalogEntry]:
    """Fill ``provider_efforts``, ``effort_sources`` and ``provider_defaults`` for every provider of every model.

    Sources, most reliable first: the tool's per-model list (Codex cache, ``agy models``, the DSH patch
    file), a tool-wide declaration (Claude Code ``--effort``; Gemini CLI has none), feed reasoning flags
    (HTTP channels and dsh_deepseek), then low/medium/high marked ``default``. ``efforts`` becomes the
    union over providers.
    """
    dsh = _dsh_patch_efforts() if dsh_efforts is None else dsh_efforts
    resolved: list[ModelCatalogEntry] = []
    for entry in models:
        per_provider: dict[str, list[str]] = {}
        sources: dict[str, EffortSource] = {}
        defaults: dict[str, str] = {}
        for provider in entry["providers"]:
            efforts, source = _provider_efforts(
                entry["id"], provider, cli_models=cli_models or {}, cli_declared=cli_declared or {},
                feed_efforts=feed_efforts or {}, dsh_efforts=dsh,
            )
            per_provider[provider], sources[provider] = efforts, source
            defaults[provider] = legal_default_effort(entry["default_effort"], efforts)
        union = _known_efforts([e for efforts in per_provider.values() for e in efforts])
        resolved.append({
            **entry,
            "efforts": union,
            "provider_efforts": per_provider,
            "effort_sources": sources,
            "provider_defaults": defaults,
        })
    return resolved


class NormalizedSpec(TypedDict):
    provider: str
    model: str
    effort: str
    spec: str
    changed: bool
    # ok | effort_adjusted | effort_removed | effort_defaulted | unverifiable
    reason: str


def split_spec(spec: str, default_provider: str = "") -> tuple[str, str, str]:
    """``provider:model@effort`` -> (provider, model, effort); a missing part is ""."""
    text = spec.strip()
    provider, colon, rest = text.partition(":")
    if not colon:
        provider, rest = default_provider, text
    model, at, effort = rest.rpartition("@")
    if not at:
        model, effort = rest, ""
    return provider, model, effort


def join_spec(provider: str, model: str, effort: str) -> str:
    body = f"{model}@{effort}" if effort else model
    return f"{provider}:{body}" if provider else body


def find_catalog_model(provider: str, model: str, models: Sequence[ModelCatalogEntry]) -> ModelCatalogEntry | None:
    """The catalog entry for ``model`` on ``provider`` (Claude aliases resolve to their catalog ID)."""
    lookup = CLAUDE_MODEL_ALIASES.get(model, model) if provider == "claude_sub" else model
    return next((m for m in models if m["id"] == lookup and provider in m["providers"]), None)


def allowed_efforts(entry: ModelCatalogEntry, provider: str) -> list[str]:
    efforts = entry.get("provider_efforts", {}).get(provider)
    return list(efforts) if efforts is not None else list(entry["efforts"])


def normalize_spec(
    provider: str, model: str, effort: str, models: Sequence[ModelCatalogEntry],
) -> NormalizedSpec:
    """The one check every provider/model/effort choice goes through.

    An effort outside the allowed set becomes the model's legal default on that provider; an empty
    allowed set drops the effort; a model the catalog does not list for the provider is kept as is and
    marked ``unverifiable`` (the model is never changed here).
    """
    def result(new_effort: str, reason: str) -> NormalizedSpec:
        return {"provider": provider, "model": model, "effort": new_effort,
                "spec": join_spec(provider, model, new_effort), "changed": new_effort != effort, "reason": reason}

    entry = find_catalog_model(provider, model, ensure_resolved(models)) if model else None
    if entry is None:
        return result(effort, "unverifiable")
    allowed = allowed_efforts(entry, provider)
    if not allowed:
        return result("", "effort_removed" if effort else "ok")
    if effort in allowed:
        return result(effort, "ok")
    preferred = entry.get("provider_defaults", {}).get(provider) or entry["default_effort"]
    fixed = legal_default_effort(preferred, allowed)
    return result(fixed, "effort_adjusted" if effort else "effort_defaulted")


def normalize_spec_string(spec: str, models: Sequence[ModelCatalogEntry], default_provider: str = "") -> NormalizedSpec:
    provider, model, effort = split_spec(spec, default_provider)
    normalized = normalize_spec(provider, model, effort, models)
    if not normalized["changed"]:
        normalized["spec"] = spec  # keep the original text exactly when nothing changes
    elif not spec.partition(":")[1]:
        normalized["spec"] = join_spec("", model, normalized["effort"])
    return normalized
