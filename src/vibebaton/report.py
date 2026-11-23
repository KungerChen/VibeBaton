"""Build-in-Public telemetry & self-hosting battle report generator (`baton report`)."""

from __future__ import annotations

import json
import math
import re
import time
from collections import defaultdict, deque
from typing import Any, TypedDict

from .db import StateStore

_INVOKING_RE = re.compile(r"Invoking\s+([^\s(]+)\s*\(([^/]+)/([^)]+)\)")
_COMPLETED_RE = re.compile(r"Completed\s+([^\s(]+)\s*\(([^/]+)/([^)]+)\)")
_ACTIVE_STAGE_STATUSES = {"PLANNING", "RUNNING", "IN_PROGRESS", "REVIEWING", "GATE_CHECKING"}
_ACTIVE_TASK_STATUSES = {"RUNNING", "REVIEWING", "GATE_CHECKING", "COOLDOWN"}

_PROVIDER_DISPLAY = {
    "en": {
        "dsh_opencode": "DeepSeek API",
        "claude_sub": "Claude CLI",
        "codex_sub": "Codex CLI",
        "host_native": "Local Host",
    },
    "zh": {
        "dsh_opencode": "DeepSeek API",
        "claude_sub": "Claude CLI",
        "codex_sub": "Codex CLI",
        "host_native": "本地宿主",
    },
}

_STATUS_ZH = {
    "PENDING": "等待中",
    "PLANNING": "规划中",
    "RUNNING": "运行中",
    "PAUSED": "已暂停",
    "WAITING_HUMAN": "等待人工审批",
    "READY_FOR_FINAL_GATE": "待终审合入",
    "PASSED": "已通过",
    "COMPLETED": "已完成",
    "FAILED": "已失败",
    "COOLDOWN": "配额冷却中",
    "GATE_CHECKING": "机械门禁检查中",
    "REVIEWING": "微审复核中",
    "SKIPPED": "已跳过",
}

_TIER_ZH = {
    "critical": "关键",
    "routine": "常规",
}

_ROLE_ZH = {
    "brainstorm_and_final_gate": "L0 架构决策与终审",
    "tactical_planner": "L1 战术规划师",
    "milestone_reviewer": "L1 里程碑架构审核",
    "micro_orchestrator": "L2 质量微审与编排",
    "critical_executor": "L2 专家重难任务执行器",
    "bulk_worker": "L3 高吞吐主力执行器",
}


def normalize_report_lang(lang: str | None) -> str:
    return "zh" if (lang or "").strip().lower().startswith("zh") else "en"


def display_provider_name(provider: str, lang: str = "en") -> str:
    locale = normalize_report_lang(lang)
    return _PROVIDER_DISPLAY[locale].get(provider, provider or "unknown")


def _infer_provider_from_model(model: str) -> str:
    lowered = model.lower()
    if "deepseek" in lowered or "flash" in lowered:
        return "dsh_opencode"
    if any(token in lowered for token in ("opus", "fable", "sonnet", "haiku", "claude")):
        return "claude_sub"
    if "gpt" in lowered or "codex" in lowered or "o1" in lowered or "o3" in lowered:
        return "codex_sub"
    return "unknown"


def _parse_json_payload(raw: str | None) -> dict[str, Any]:
    if not raw:
        return {}
    try:
        loaded = json.loads(raw)
        return loaded if isinstance(loaded, dict) else {}
    except json.JSONDecodeError:
        return {}


class _BillingTelemetry(TypedDict):
    total_prompt_tokens: int
    total_completion_tokens: int
    total_cached_tokens: int
    total_tokens: int
    total_cost_usd: float | None
    has_exact_billing: bool


class _ConflictTelemetry(TypedDict):
    conflicts_detected: int
    conflicts_auto_resolved: int
    conflicts_failed: int


class _TaskTiming(TypedDict):
    duration_sec: float
    started_at: float | None
    is_active: bool


class _RunAttention(TypedDict):
    category: str
    severity: str
    title: str
    message: str
    action_hint: str
    milestone_id: str | None
    task_id: str | None
    created_at: float


_BLOCKING_RUN_STATUSES = {"WAITING_HUMAN", "READY_FOR_FINAL_GATE", "FAILED", "PAUSED"}
_ATTENTION_DEFAULTS = {
    "waiting_human": (
        "warning", "Human decision required", "The run is waiting for a human decision.",
        "Review and resolve the blocker in Studio.",
    ),
    "ready_for_final_gate": (
        "info", "Ready for final gate", "All milestones passed and the run is ready for final review.",
        "Open the battle report and review the L0 final gate.",
    ),
    "failed": (
        "error", "Run failed", "The run stopped because of an error.", "Inspect the run events in Studio.",
    ),
    "paused": (
        "warning", "Run paused", "The run was paused by the user or host.", "Resume the run in Studio when ready.",
    ),
    "long_cooldown": (
        "warning", "Provider quota cooldown", "A task is waiting for its provider quota to recover.",
        "The run will retry automatically after the cooldown.",
    ),
}


def _attention_from_event(
    category: str, event: dict[str, Any], payload: dict[str, Any] | None = None,
) -> _RunAttention:
    severity, title, message, action_hint = _ATTENTION_DEFAULTS[category]
    payload = payload or {}
    return {
        "category": category,
        "severity": str(payload.get("severity") or severity),
        "title": str(payload.get("title") or title),
        "message": str(payload.get("message") or event.get("message") or message),
        "action_hint": str(payload.get("action_hint") or action_hint),
        "milestone_id": event.get("milestone_id"),
        "task_id": event.get("task_id"),
        "created_at": float(event["created_at"]),
    }


def _compute_run_attention(
    run: dict[str, Any],
    run_status: str,
    milestones: list[dict[str, Any]],
    task_map: dict[str, dict[str, Any]],
    events: list[dict[str, Any]],
    now: float,
) -> _RunAttention | None:
    if run_status in _BLOCKING_RUN_STATUSES:
        category = run_status.lower()
        for event in reversed(events):
            if event["kind"] == "human_attention_required":
                payload = _parse_json_payload(event.get("payload_json"))
                if payload.get("category") == category:
                    return _attention_from_event(category, event, payload)
                # A prior cooldown or blocker can precede the current status transition.
                break

        context: dict[str, Any] = {}
        task_id = milestone_id = None
        message = run.get("summary")
        if run_status in ("WAITING_HUMAN", "FAILED"):
            context = next((event for event in reversed(events) if (
                event["kind"].endswith(("_error", "_failed"))
                or event["kind"] in (
                    "error", "run_exception", "dag_deadlock", "milestone_rejected", "plan_amendment_requested",
                )
            )), {})
            task = next((task for task in task_map.values() if task["status"] == run_status), {})
            task_id = task.get("id") or context.get("task_id")
            milestone_id = (
                (task_map.get(task_id, {}).get("milestone_id") if task_id else None) or context.get("milestone_id")
                or next((m["id"] for m in milestones if m["status"] == run_status), None)
            )
            if run_status == "WAITING_HUMAN":
                message = run.get("human_prompt") or task.get("last_error") or message
        elif run_status == "PAUSED":
            context = next((event for event in reversed(events) if event["kind"] == "run_paused"), {})
            message = context.get("message") or message

        return _attention_from_event(category, {
            "message": message or context.get("message"),
            "milestone_id": milestone_id,
            "task_id": task_id,
            "created_at": run.get("updated_at") or run["created_at"],
        })

    if run_status not in ("RUNNING", "PLANNING"):
        return None

    cooling_tasks = {task_id for task_id, task in task_map.items() if task["status"] == "COOLDOWN"}
    cooldown_attentions: dict[str, _RunAttention] = {}
    for event in reversed(events):
        if not cooling_tasks:
            break
        task_id = event.get("task_id")
        if task_id not in cooling_tasks:
            continue
        kind = event["kind"]
        if kind in ("role_invoked", "role_fallback"):
            cooling_tasks.remove(task_id)
        elif kind == "human_attention_required":
            payload = _parse_json_payload(event.get("payload_json"))
            if payload.get("category") == "long_cooldown" and task_id not in cooldown_attentions:
                cooldown_attentions[task_id] = _attention_from_event("long_cooldown", event, payload)
        elif kind in ("quota_rate_limited", "quota_cooldown_wait"):
            cooling_tasks.remove(task_id)
            wait_sec = _parse_json_payload(event.get("payload_json")).get("wait_sec")
            if isinstance(wait_sec, (int, float)) and float(event["created_at"]) + wait_sec <= now:
                cooldown_attentions.pop(task_id, None)
            elif task_id not in cooldown_attentions:
                cooldown_attentions[task_id] = _attention_from_event("long_cooldown", event)
    return max(cooldown_attentions.values(), key=lambda attention: attention["created_at"], default=None)


def _parse_token_count(value: object) -> int:
    return value if type(value) is int and value > 0 else 0


def _parse_cost_usd(value: object) -> float | None:
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        return None
    try:
        cost = float(value)
    except OverflowError:
        return None
    return cost if math.isfinite(cost) else None


def _record_billing(entry: dict[str, Any], billing: _BillingTelemetry, payload: dict[str, Any]) -> None:
    prompt_tokens = _parse_token_count(payload.get("prompt_tokens"))
    completion_tokens = _parse_token_count(payload.get("completion_tokens"))
    cached_tokens = _parse_token_count(payload.get("cached_tokens"))
    cost_usd = _parse_cost_usd(payload.get("cost_usd"))
    if prompt_tokens == 0 and completion_tokens == 0 and cached_tokens == 0 and cost_usd is None:
        return

    billing["has_exact_billing"] = True
    billing["total_prompt_tokens"] += prompt_tokens
    billing["total_completion_tokens"] += completion_tokens
    billing["total_cached_tokens"] += cached_tokens
    entry["prompt_tokens"] += prompt_tokens
    entry["completion_tokens"] += completion_tokens
    if cost_usd is not None:
        billing["total_cost_usd"] = (billing["total_cost_usd"] or 0.0) + cost_usd
        entry["cost_usd"] = (entry["cost_usd"] or 0.0) + cost_usd


def _parse_role_event_meta(event: dict[str, Any]) -> tuple[str, str, str]:
    payload = _parse_json_payload(event.get("payload_json"))
    p_role = payload.get("role")
    p_provider = payload.get("provider")
    p_model = payload.get("model")
    if isinstance(p_role, str) and isinstance(p_provider, str) and isinstance(p_model, str) and p_role:
        return p_role, p_provider, p_model

    message = str(event.get("message") or "")
    for pattern in (_INVOKING_RE, _COMPLETED_RE):
        match = pattern.search(message)
        if match:
            return match.group(1), match.group(2), match.group(3)

    actor = str(event.get("actor") or "")
    if ":" in actor:
        role_name, model_name = actor.split(":", 1)
    else:
        role_name, model_name = (actor or "unknown"), "unknown"
    return role_name, _infer_provider_from_model(model_name), model_name


def _estimate_invocation_timing(
    events: list[dict[str, Any]],
    index: int,
    role: str,
    run_is_active: bool,
    task_map: dict[str, dict[str, Any]],
    now: float,
) -> tuple[float, float | None]:
    """Return estimated duration and the start time if the invocation is still in flight."""
    ev = events[index]
    t0 = float(ev["created_at"])
    task_id = ev.get("task_id")
    milestone_id = ev.get("milestone_id")
    actor = str(ev.get("actor") or "")

    for candidate in events[index + 1 :]:
        kind = candidate.get("kind")
        t1 = float(candidate["created_at"])
        c_task = candidate.get("task_id")
        c_ms = candidate.get("milestone_id")
        c_actor = str(candidate.get("actor") or "")

        if role == "tactical_planner":
            if kind in ("plan_generated", "plan_registered"):
                return max(0.0, t1 - t0), None
            if kind == "role_invoked" and c_actor == actor:
                return max(0.0, t1 - t0), None
            continue

        if task_id:
            if c_task != task_id:
                continue
            if role == "micro_orchestrator":
                if kind in ("task_review_passed", "task_review_rejected", "task_escalated", "task_passed"):
                    return max(0.0, t1 - t0), None
            elif kind in (
                "task_exec_error",
                "mechanical_gate_caught",
                "task_escalated",
                "task_passed",
                "quota_rate_limited",
                "role_fallback",
                "role_invoked",
            ):
                return max(0.0, t1 - t0), None
            continue

        if milestone_id and c_ms == milestone_id:
            if role == "milestone_reviewer" and kind in ("milestone_passed", "milestone_rejected"):
                return max(0.0, t1 - t0), None
            if role != "milestone_reviewer" and kind in ("milestone_fix_applied", "milestone_passed", "role_invoked"):
                return max(0.0, t1 - t0), None

    if run_is_active:
        if task_id:
            task = task_map.get(task_id)
            if task and task.get("status") not in _ACTIVE_TASK_STATUSES:
                return 0.0, None
        return max(0.0, now - t0), t0
    return 0.0, None


def compute_run_telemetry(
    store: StateStore,
    run_id: str,
    *,
    now_ts: float | None = None,
) -> dict[str, Any]:
    """Compute timing, billing, merge-conflict, and attention telemetry from recorded events.

    A pending run with no stages or tasks keeps its original top-level keys.
    """
    run = store.get_run(run_id)
    if not run:
        raise ValueError(f"Run '{run_id}' not found")

    milestones = store.get_milestones(run_id)
    tasks = store.get_tasks(run_id)
    events = store.get_events(run_id, limit=-1)
    now = time.time() if now_ts is None else float(now_ts)
    run_status = str(run.get("status") or "PENDING")
    run_is_active = run_status in ("RUNNING", "PLANNING")
    created_at = float(run["created_at"])

    if run.get("finished_at") is not None:
        end_ts = float(run["finished_at"])
    elif run_is_active:
        end_ts = max(now, float(run.get("updated_at") or created_at))
    else:
        latest_event_ts = max((float(e["created_at"]) for e in events), default=created_at)
        end_ts = max(float(run.get("updated_at") or created_at), latest_event_ts)

    elapsed_sec = round(max(0.0, end_ts - created_at), 1)

    plan_ts = next(
        (float(e["created_at"]) for e in events if e.get("kind") in ("plan_generated", "plan_registered")),
        None,
    )
    stages: list[dict[str, Any]] = []
    if plan_ts is not None or milestones or run_status == "PLANNING":
        plan_end = plan_ts if plan_ts is not None else end_ts
        plan_status = "PASSED" if (plan_ts is not None or milestones) else run_status
        is_active = run_is_active and plan_status in _ACTIVE_STAGE_STATUSES
        stages.append(
            {
                "id": "PLANNING",
                "kind": "planning",
                "title": "DAG Planning",
                "status": plan_status,
                "wall_sec": round(max(0.0, plan_end - created_at), 1),
                "task_sum_sec": 0.0,
                "passed_tasks": 0,
                "total_tasks": 0,
                "started_at": created_at if is_active else None,
                "is_active": is_active,
            }
        )

    events_by_ms: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for event in events:
        ms_id = event.get("milestone_id")
        if ms_id:
            events_by_ms[str(ms_id)].append(event)

    tasks_by_ms: dict[str, list[dict[str, Any]]] = defaultdict(list)
    task_map: dict[str, dict[str, Any]] = {}
    for task in tasks:
        task_map[str(task["id"])] = task
        tasks_by_ms[str(task["milestone_id"])].append(task)

    cursor = plan_ts if plan_ts is not None else created_at
    for milestone in milestones:
        mid = str(milestone["id"])
        m_status = str(milestone["status"])
        m_tasks = tasks_by_ms.get(mid, [])
        m_events = events_by_ms.get(mid, [])
        passed_tasks = sum(1 for t in m_tasks if t["status"] == "PASSED")
        task_sum_sec = round(sum(float(t.get("duration_sec") or 0.0) for t in m_tasks), 1)

        is_active = run_is_active and m_status in _ACTIVE_STAGE_STATUSES
        m_start = min((float(e["created_at"]) for e in m_events), default=cursor)
        if m_status == "PENDING" and not m_events:
            wall_sec = 0.0
        else:
            pass_ts = next(
                (float(e["created_at"]) for e in m_events if e.get("kind") == "milestone_passed"),
                None,
            )
            if pass_ts is not None:
                m_end = pass_ts
            elif m_status == "RUNNING":
                m_end = max(now, m_start)
            else:
                m_end = max(
                    m_start,
                    float(milestone.get("updated_at") or m_start),
                    max((float(e["created_at"]) for e in m_events), default=m_start),
                )
            wall_sec = round(max(0.0, m_end - m_start), 1)
            cursor = max(cursor, m_end)

        stages.append(
            {
                "id": mid,
                "kind": "milestone",
                "title": str(milestone["title"]),
                "status": m_status,
                "wall_sec": wall_sec,
                "task_sum_sec": task_sum_sec,
                "passed_tasks": passed_tasks,
                "total_tasks": len(m_tasks),
                "started_at": m_start if is_active else None,
                "is_active": is_active,
            }
        )

    # Match `role_invoked` events with exact `role_completed` telemetry when available.
    completed_queues: dict[tuple[str, str, str], deque[dict[str, Any]]] = defaultdict(deque)
    unpaired_completed: list[dict[str, Any]] = []
    for event in events:
        if event.get("kind") != "role_completed":
            continue
        key = (
            str(event.get("actor") or ""),
            str(event.get("task_id") or ""),
            str(event.get("milestone_id") or ""),
        )
        completed_queues[key].append(event)

    billing: _BillingTelemetry = {
        "total_prompt_tokens": 0,
        "total_completion_tokens": 0,
        "total_cached_tokens": 0,
        "total_tokens": 0,
        "total_cost_usd": None,
        "has_exact_billing": False,
    }
    model_buckets: dict[tuple[str, str, str], dict[str, Any]] = {}
    model_starts: dict[tuple[str, str, str], float] = {}
    task_starts: dict[str, float] = {}
    task_durations: dict[str, float] = defaultdict(float)
    for idx, event in enumerate(events):
        if event.get("kind") != "role_invoked":
            continue
        role, provider, model = _parse_role_event_meta(event)
        key = (
            str(event.get("actor") or ""),
            str(event.get("task_id") or ""),
            str(event.get("milestone_id") or ""),
        )
        queue = completed_queues.get(key)
        matched: dict[str, Any] | None = None
        while queue and float(queue[0]["created_at"]) < float(event["created_at"]):
            unpaired_completed.append(queue.popleft())
        if queue:
            matched = queue.popleft()

        if matched is not None:
            payload = _parse_json_payload(matched.get("payload_json"))
            dur = max(0.0, float(payload.get("duration_sec") or 0.0))
            active_start = None
            estimated = False
        else:
            dur, active_start = _estimate_invocation_timing(events, idx, role, run_is_active, task_map, now)
            estimated = True

        bucket_key = (role, provider, model)
        if active_start is not None:
            model_starts[bucket_key] = min(active_start, model_starts.get(bucket_key, active_start))
        task_id = key[1]
        if task_id in task_map:
            task_durations[task_id] += dur
            if active_start is not None:
                task_starts[task_id] = min(active_start, task_starts.get(task_id, active_start))

        entry = model_buckets.get(bucket_key)
        if entry is None:
            entry = {
                "actor": f"{role}:{model}",
                "role": role,
                "provider": provider,
                "display_provider": display_provider_name(provider, "en"),
                "model": model,
                "calls": 0,
                "duration_sec": 0.0,
                "estimated": False,
                "prompt_tokens": 0,
                "completion_tokens": 0,
                "cost_usd": None,
            }
            model_buckets[bucket_key] = entry
        entry["calls"] += 1
        entry["duration_sec"] += dur
        entry["estimated"] = bool(entry["estimated"] or estimated)
        if matched is not None:
            _record_billing(entry, billing, payload)

    for leftover_queue in completed_queues.values():
        unpaired_completed.extend(leftover_queue)
    for event in unpaired_completed:
        role, provider, model = _parse_role_event_meta(event)
        payload = _parse_json_payload(event.get("payload_json"))
        dur = max(0.0, float(payload.get("duration_sec") or 0.0))
        task_id = str(event.get("task_id") or "")
        if task_id in task_map:
            task_durations[task_id] += dur
        bucket_key = (role, provider, model)
        entry = model_buckets.get(bucket_key)
        if entry is None:
            entry = {
                "actor": f"{role}:{model}",
                "role": role,
                "provider": provider,
                "display_provider": display_provider_name(provider, "en"),
                "model": model,
                "calls": 0,
                "duration_sec": 0.0,
                "estimated": False,
                "prompt_tokens": 0,
                "completion_tokens": 0,
                "cost_usd": None,
            }
            model_buckets[bucket_key] = entry
        entry["calls"] += 1
        entry["duration_sec"] += dur
        _record_billing(entry, billing, payload)

    total_model_sec = sum(item["duration_sec"] for item in model_buckets.values())
    models: list[dict[str, Any]] = []
    for bucket_key, item in model_buckets.items():
        dur_rounded = round(float(item["duration_sec"]), 1)
        avg_rounded = round(float(item["duration_sec"]) / max(1, int(item["calls"])), 1)
        share_pct = round((float(item["duration_sec"]) / total_model_sec) * 100.0, 1) if total_model_sec > 0 else 0.0
        models.append(
            {
                **item,
                "duration_sec": dur_rounded,
                "avg_sec": avg_rounded,
                "share_pct": share_pct,
                "active_started_at": model_starts.get(bucket_key),
            }
        )
    models.sort(key=lambda item: (-item["duration_sec"], -item["calls"], item["role"]))

    task_timings: dict[str, _TaskTiming] = {}
    for task_id, task in task_map.items():
        is_active = run_is_active and task["status"] in _ACTIVE_TASK_STATUSES
        task_timings[task_id] = {
            "duration_sec": float(task.get("duration_sec") or task_durations.get(task_id, 0.0)),
            "started_at": task_starts.get(task_id) if is_active else None,
            "is_active": is_active,
        }

    # Cached tokens are included in the prompt count.
    billing["total_tokens"] = billing["total_prompt_tokens"] + billing["total_completion_tokens"]
    total_cost_usd = billing["total_cost_usd"]
    if total_cost_usd is not None:
        billing["total_cost_usd"] = round(total_cost_usd, 6)

    conflicts: _ConflictTelemetry = {
        "conflicts_detected": 0,
        "conflicts_auto_resolved": 0,
        "conflicts_failed": 0,
    }
    for event in events:
        kind = event.get("kind")
        if kind == "merge_conflict_detected":
            conflicts["conflicts_detected"] += 1
        elif kind == "merge_conflict_resolved":
            conflicts["conflicts_auto_resolved"] += 1
        elif kind == "merge_conflict_failed":
            conflicts["conflicts_failed"] += 1

    telemetry: dict[str, Any] = {
        "elapsed_sec": elapsed_sec,
        "stages": stages,
        "models": models,
        "billing": billing,
    }
    if any(conflicts.values()):
        telemetry["conflicts"] = conflicts
    if run_status != "PENDING" or stages or tasks:
        telemetry["server_now"] = round(now, 3)
        telemetry["task_timings"] = task_timings
        telemetry["attention"] = _compute_run_attention(run, run_status, milestones, task_map, events, now)
    return telemetry


def _escape_cell(value: str) -> str:
    return " ".join(str(value).splitlines()).replace("|", r"\|")


def _format_cost_usd(value: float | None) -> str:
    return f"${value:.4f}" if value is not None else "—"


def _token_cost_section(
    billing: _BillingTelemetry, models: list[dict[str, Any]], *, lang: str,
) -> list[str]:
    if not billing["has_exact_billing"]:
        return []

    if lang == "zh":
        heading = "## Token 与美元成本统计"
        header = "| 模型 | 输入 Token | 输出 Token | 美元成本 |"
        total_label = "合计"
    else:
        heading = "## Token Usage & Cost Breakdown"
        header = "| Model | Prompt tokens | Completion tokens | Cost USD |"
        total_label = "Total"

    lines = ["", heading, "", header, "| :--- | ---: | ---: | ---: |"]
    for model in models:
        name = model["model"]
        if lang == "en":
            name = name.encode("ascii", errors="backslashreplace").decode("ascii")
        lines.append(
            f"| `{_escape_cell(name)}` | {model['prompt_tokens']} | {model['completion_tokens']} | "
            f"{_format_cost_usd(model['cost_usd'])} |"
        )
    lines.append(
        f"| **{total_label}** | **{billing['total_prompt_tokens']}** | **{billing['total_completion_tokens']}** | "
        f"**{_format_cost_usd(billing['total_cost_usd'])}** |"
    )
    return lines


def _conflict_section(conflicts: _ConflictTelemetry | None, *, lang: str) -> list[str]:
    if conflicts is None:
        return []

    if lang == "zh":
        heading = "## 合并冲突自动解决"
        labels = ("检测到的冲突", "自动解决", "升级人工处理")
        separator = "："
    else:
        heading = "## Merge Conflict Resolution"
        labels = ("Detected", "Auto-resolved", "Escalated")
        separator = ": "

    return [
        "",
        heading,
        "",
        f"- {labels[0]}{separator}**{conflicts['conflicts_detected']}**",
        f"- {labels[1]}{separator}**{conflicts['conflicts_auto_resolved']}**",
        f"- {labels[2]}{separator}**{conflicts['conflicts_failed']}**",
    ]


def generate_battle_report(store: StateStore, run_id: str, lang: str = "en") -> str:
    """Compile structured run telemetry into a shareable Markdown battle report."""
    run = store.get_run(run_id)
    if not run:
        raise ValueError(f"Run '{run_id}' not found")

    locale = normalize_report_lang(lang)
    milestones = store.get_milestones(run_id)
    tasks = store.get_tasks(run_id)
    events = store.get_events(run_id, limit=-1)
    # Keep the existing metric window while reading the full allocation history.
    recent_events = events[-2000:]

    telemetry = compute_run_telemetry(store, run_id)
    elapsed_sec = telemetry["elapsed_sec"]

    total_tasks = len(tasks)
    passed_tasks = sum(1 for t in tasks if t["status"] == "PASSED")
    escalated_tasks = sum(1 for t in tasks if t["escalated"])
    routine_tasks = [t for t in tasks if t["tier"] == "routine"]
    routine_first_pass = sum(
        1
        for t in routine_tasks
        if t["status"] == "PASSED" and t["review_reject_count"] == 0 and not t["escalated"]
    )
    gate_catches = sum(1 for e in recent_events if e["kind"] == "mechanical_gate_caught")
    whitelist_catches = sum(1 for e in recent_events if e["kind"] == "whitelist_violation")
    cooldown_hits = sum(1 for e in recent_events if e["kind"] == "quota_rate_limited")

    routine_rate = (
        f"{(routine_first_pass / len(routine_tasks)) * 100:.1f}%"
        if routine_tasks
        else ("暂无" if locale == "zh" else "N/A")
    )

    if locale == "zh":
        lines = _build_zh_report(
            run_id=run_id,
            run=run,
            milestones=milestones,
            tasks=tasks,
            elapsed_sec=elapsed_sec,
            passed_tasks=passed_tasks,
            total_tasks=total_tasks,
            gate_catches=gate_catches,
            whitelist_catches=whitelist_catches,
            routine_rate=routine_rate,
            escalated_tasks=escalated_tasks,
            cooldown_hits=cooldown_hits,
            telemetry=telemetry,
        )
    else:
        lines = _build_en_report(
            run_id=run_id,
            run=run,
            milestones=milestones,
            tasks=tasks,
            elapsed_sec=elapsed_sec,
            passed_tasks=passed_tasks,
            total_tasks=total_tasks,
            gate_catches=gate_catches,
            whitelist_catches=whitelist_catches,
            routine_rate=routine_rate,
            escalated_tasks=escalated_tasks,
            cooldown_hits=cooldown_hits,
            telemetry=telemetry,
        )

    lines.extend(_smart_allocation_summary(events, lang=locale))
    lines.extend(_token_cost_section(telemetry["billing"], telemetry["models"], lang=locale))
    lines.extend(_conflict_section(telemetry.get("conflicts"), lang=locale))
    return "\n".join(lines) + "\n"


def _build_en_report(
    *,
    run_id: str,
    run: dict[str, Any],
    milestones: list[dict[str, Any]],
    tasks: list[dict[str, Any]],
    elapsed_sec: float,
    passed_tasks: int,
    total_tasks: int,
    gate_catches: int,
    whitelist_catches: int,
    routine_rate: str,
    escalated_tasks: int,
    cooldown_hits: int,
    telemetry: dict[str, Any],
) -> list[str]:
    lines: list[str] = [
        f"# VibeBaton Run Report — `{run_id}`",
        "",
        f"- **Status**: `{run['status']}`",
        f"- **Mode**: `{run['mode']}`",
        f"- **Elapsed Time**: `{elapsed_sec:.1f}s`",
        f"- **Milestones**: `{sum(1 for m in milestones if m['status'] == 'PASSED')}/{len(milestones)}` passed",
        f"- **Tasks**: `{passed_tasks}/{total_tasks}` passed",
        "",
        "## Efficiency & Guardrail Highlights",
        "",
        "| Metric | Value | Why It Matters |",
        "| :--- | :--- | :--- |",
        f"| Mechanical Gate Catches | **{gate_catches}** | Defects fixed locally before spending upper-tier AI review quota |",
        f"| Path Whitelist Catches | **{whitelist_catches}** | Out-of-scope edits blocked & auto-reverted |",
        f"| Bulk Worker First-Pass Rate | **{routine_rate}** | Routine tasks accepted by micro-review without rework |",
        f"| Circuit-Breaker Escalations | **{escalated_tasks}** | Tough tasks automatically handed off to Specialist tier |",
        f"| Subscription Cooldowns Handled | **{cooldown_hits}** | Rate-limit windows survived automatically without failing the run |",
    ]

    if telemetry["stages"]:
        lines.extend(
            [
                "",
                "## Stage & Milestone Timing",
                "",
                "| Stage | Title | Status | Tasks | Wall Time | Parallel Task Sum |",
                "| :--- | :--- | :--- | :---: | :---: | :---: |",
            ]
        )
        for stage in telemetry["stages"]:
            task_col = f"{stage['passed_tasks']}/{stage['total_tasks']}" if stage["kind"] == "milestone" else "—"
            sum_col = f"{float(stage['task_sum_sec']):.1f}s" if stage["kind"] == "milestone" else "—"
            lines.append(
                f"| `{stage['id']}` | {_escape_cell(stage['title'])} | `{stage['status']}` | "
                f"{task_col} | {float(stage['wall_sec']):.1f}s | {sum_col} |"
            )

    if telemetry["models"]:
        lines.extend(
            [
                "",
                "## Model Calls & Runtime",
                "",
                "| Role | Provider | Model | Calls | Total Runtime | Avg / Call | Share |",
                "| :--- | :--- | :--- | :---: | :---: | :---: | :---: |",
            ]
        )
        for model in telemetry["models"]:
            lines.append(
                f"| `{model['role']}` | {model['display_provider']} | `{model['model']}` | "
                f"{model['calls']} | {float(model['duration_sec']):.1f}s | "
                f"{float(model['avg_sec']):.1f}s | {float(model['share_pct']):.1f}% |"
            )

    lines.extend(
        [
            "",
            "## Task Breakdown",
            "",
            "| Task | Tier | Final Role | Status | Self-Heals | Rejects | Escalated | Duration |",
            "| :--- | :--- | :--- | :--- | :---: | :---: | :---: | :---: |",
        ]
    )

    for t in tasks:
        lines.append(
            f"| `{t['id']}` {t['title']} | {t['tier']} | `{t['current_role']}` | `{t['status']}` | "
            f"{t['self_heal_count']} | {t['review_reject_count']} | "
            f"{'Yes' if t['escalated'] else 'No'} | {float(t['duration_sec']):.1f}s |"
        )

    if run.get("summary"):
        lines.extend(["", "## Summary", "", str(run["summary"])])
    return lines


def _build_zh_report(
    *,
    run_id: str,
    run: dict[str, Any],
    milestones: list[dict[str, Any]],
    tasks: list[dict[str, Any]],
    elapsed_sec: float,
    passed_tasks: int,
    total_tasks: int,
    gate_catches: int,
    whitelist_catches: int,
    routine_rate: str,
    escalated_tasks: int,
    cooldown_hits: int,
    telemetry: dict[str, Any],
) -> list[str]:
    mode_zh = "通宵无人值守" if run["mode"] == "overnight" else "交互式"
    status_zh = _STATUS_ZH.get(str(run["status"]), str(run["status"]))
    passed_ms = sum(1 for m in milestones if m["status"] == "PASSED")
    lines: list[str] = [
        f"# VibeBaton 运行战报 — `{run_id}`",
        "",
        f"- **运行状态**：`{status_zh}`",
        f"- **执行模式**：`{mode_zh}`",
        f"- **累计耗时**：`{elapsed_sec:.1f}s`",
        f"- **里程碑通过**：`{passed_ms}/{len(milestones)}`",
        f"- **任务通过**：`{passed_tasks}/{total_tasks}`",
        "",
        "## 效率与防线战绩",
        "",
        "| 核心指标 | 数值 | 实战意义 |",
        "| :--- | :--- | :--- |",
        f"| 机械门禁本地拦截 | **{gate_catches}** | 在消耗上层高阶审核额度前，先由自动化测试就地拦住缺陷 |",
        f"| 路径白名单越界拦截 | **{whitelist_catches}** | 自动回滚越界改动，防止并发任务互相踩踏污染 |",
        f"| 常规执行器首次通过率 | **{routine_rate}** | 常规批量任务一次性通过微审验收的比例 |",
        f"| 熔断自动升级次数 | **{escalated_tasks}** | 连续返修受阻的棘手任务自动接力交给 L2 专家接管完成 |",
        f"| 限流冷却自动续跑 | **{cooldown_hits}** | 遭遇 429 配额窗口后自动退避等待并无缝续跑 |",
    ]

    if telemetry["stages"]:
        lines.extend(
            [
                "",
                "## 分阶段耗时拆解",
                "",
                "| 阶段 | 名称 | 状态 | 任务进度 | 挂钟耗时 | 任务并发累计耗时 |",
                "| :--- | :--- | :--- | :---: | :---: | :---: |",
            ]
        )
        for stage in telemetry["stages"]:
            title = "DAG 架构规划拆解" if stage["kind"] == "planning" else _escape_cell(stage["title"])
            stage_status = _STATUS_ZH.get(str(stage["status"]), str(stage["status"]))
            task_col = f"{stage['passed_tasks']}/{stage['total_tasks']}" if stage["kind"] == "milestone" else "—"
            sum_col = f"{float(stage['task_sum_sec']):.1f}s" if stage["kind"] == "milestone" else "—"
            lines.append(
                f"| `{stage['id']}` | {title} | `{stage_status}` | "
                f"{task_col} | {float(stage['wall_sec']):.1f}s | {sum_col} |"
            )

    if telemetry["models"]:
        lines.extend(
            [
                "",
                "## 模型调用与耗时统计",
                "",
                "| 逻辑角色 | 提供方 | 模型 | 调用次数 | 累计运行耗时 | 单次均值 | 耗时占比 |",
                "| :--- | :--- | :--- | :---: | :---: | :---: | :---: |",
            ]
        )
        for model in telemetry["models"]:
            role_label = _ROLE_ZH.get(str(model["role"]), str(model["role"]))
            provider_label = display_provider_name(str(model["provider"]), "zh")
            lines.append(
                f"| {role_label} | {provider_label} | `{model['model']}` | "
                f"{model['calls']} | {float(model['duration_sec']):.1f}s | "
                f"{float(model['avg_sec']):.1f}s | {float(model['share_pct']):.1f}% |"
            )

    lines.extend(
        [
            "",
            "## 任务明细清单",
            "",
            "| 任务 | 层级 | 最终执行角色 | 状态 | 自愈次数 | 审核打回 | 是否升级 | 耗时 |",
            "| :--- | :--- | :--- | :--- | :---: | :---: | :---: | :---: |",
        ]
    )

    for t in tasks:
        tier_label = _TIER_ZH.get(str(t["tier"]), str(t["tier"]))
        role_label = _ROLE_ZH.get(str(t["current_role"]), str(t["current_role"]))
        t_status = _STATUS_ZH.get(str(t["status"]), str(t["status"]))
        lines.append(
            f"| `{t['id']}` {_escape_cell(t['title'])} | {tier_label} | {role_label} | `{t_status}` | "
            f"{t['self_heal_count']} | {t['review_reject_count']} | "
            f"{'是' if t['escalated'] else '否'} | {float(t['duration_sec']):.1f}s |"
        )

    if run.get("summary"):
        lines.extend(["", "## 运行总结", "", str(run["summary"])])
    return lines


def _smart_allocation_summary(events: list[dict[str, Any]], *, lang: str = "en") -> list[str]:
    allocations: dict[str, dict[str, Any]] = {}
    profiles: set[str] = set()
    step_ups: list[dict[str, Any]] = []
    for event in events:
        if event["kind"] == "task_allocated":
            allocation = json.loads(event["payload_json"])
            allocations[allocation["task_id"]] = allocation
            profiles.add(allocation["budget_profile"])
        elif event["kind"] == "task_step_up":
            step_ups.append(json.loads(event["payload_json"]))

    if not allocations and not step_ups:
        return []

    locale = normalize_report_lang(lang)
    profile_text = ", ".join(f"`{profile}`" for profile in sorted(profiles)) or (
        "未指定" if locale == "zh" else "unavailable"
    )
    pinned_count = sum(allocation["pinned"] for allocation in allocations.values())

    if locale == "zh":
        lines = [
            "", "## 智能配给摘要", "",
            f"- 预算档位：{profile_text}",
            f"- 人工锁定任务数：`{pinned_count}`",
        ]
        if allocations:
            lines.extend(["", "| 任务 | 提供方 | 模型 | 配给原因 |", "| :--- | :--- | :--- | :--- |"])
            for task_id, allocation in allocations.items():
                provider_label = display_provider_name(str(allocation["provider"]), "zh")
                cells = (f"`{task_id}`", provider_label, f"`{allocation['model']}`", str(allocation["reason"]))
                lines.append("| " + " | ".join(_escape_cell(c) for c in cells) + " |")
        if step_ups:
            lines.extend(["", "**运行期阶梯升档记录**", ""])
            for event in step_ups:
                lines.append(
                    f"- `{event['task_id']}` 第 {event['attempt']} 次尝试 — `{event['from']}` → `{event['to']}`"
                )
        return lines

    lines = [
        "", "## Smart Allocation Summary", "",
        f"- Budget profile {profile_text}",
        f"- Pinned tasks `{pinned_count}`",
    ]
    if allocations:
        lines.extend(["", "| Task | Provider | Model | Reason |", "| :--- | :--- | :--- | :--- |"])
        for task_id, allocation in allocations.items():
            cells = (
                f"`{task_id}`", f"`{allocation['provider']}`", f"`{allocation['model']}`", allocation["reason"],
            )
            lines.append("| " + " | ".join(_escape_cell(c) for c in cells) + " |")
    if step_ups:
        lines.extend(["", "**Step-ups**", ""])
        for event in step_ups:
            lines.append(f"- `{event['task_id']}` attempt {event['attempt']} — `{event['from']}` → `{event['to']}`")
    return lines
