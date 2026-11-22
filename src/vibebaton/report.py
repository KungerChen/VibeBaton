"""Build-in-Public telemetry & self-hosting battle report generator (`baton report`)."""

from __future__ import annotations

import json
import re
import time
from collections import defaultdict, deque
from typing import Any

from .db import StateStore

_INVOKING_RE = re.compile(r"Invoking\s+([^\s(]+)\s*\(([^/]+)/([^)]+)\)")
_COMPLETED_RE = re.compile(r"Completed\s+([^\s(]+)\s*\(([^/]+)/([^)]+)\)")

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


def _estimate_invocation_duration(
    events: list[dict[str, Any]],
    index: int,
    role: str,
    run_status: str,
    task_map: dict[str, dict[str, Any]],
    now: float,
) -> float:
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
                return max(0.0, t1 - t0)
            if kind == "role_invoked" and c_actor == actor:
                return max(0.0, t1 - t0)
            continue

        if task_id:
            if c_task != task_id:
                continue
            if role == "micro_orchestrator":
                if kind in ("task_review_passed", "task_review_rejected", "task_escalated", "task_passed"):
                    return max(0.0, t1 - t0)
            elif kind in (
                "task_exec_error",
                "mechanical_gate_caught",
                "task_escalated",
                "task_passed",
                "quota_rate_limited",
                "role_fallback",
                "role_invoked",
            ):
                return max(0.0, t1 - t0)
            continue

        if milestone_id and c_ms == milestone_id:
            if role == "milestone_reviewer" and kind in ("milestone_passed", "milestone_rejected"):
                return max(0.0, t1 - t0)
            if role != "milestone_reviewer" and kind in ("milestone_fix_applied", "milestone_passed", "role_invoked"):
                return max(0.0, t1 - t0)

    if run_status in ("RUNNING", "PLANNING"):
        if task_id:
            task = task_map.get(task_id)
            if task and task.get("status") not in ("RUNNING", "COOLDOWN", "REVIEWING", "GATE_CHECKING"):
                return 0.0
        return max(0.0, now - t0)
    return 0.0


def compute_run_telemetry(
    store: StateStore,
    run_id: str,
    *,
    now_ts: float | None = None,
) -> dict[str, Any]:
    """Compute structured elapsed, stage-level, and model-level run telemetry."""
    run = store.get_run(run_id)
    if not run:
        raise ValueError(f"Run '{run_id}' not found")

    milestones = store.get_milestones(run_id)
    tasks = store.get_tasks(run_id)
    events = store.get_events(run_id, limit=-1)
    now = time.time() if now_ts is None else float(now_ts)
    run_status = str(run.get("status") or "PENDING")
    created_at = float(run["created_at"])

    if run.get("finished_at") is not None:
        end_ts = float(run["finished_at"])
    elif run_status in ("RUNNING", "PLANNING"):
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

        if m_status == "PENDING" and not m_events:
            wall_sec = 0.0
        else:
            m_start = min((float(e["created_at"]) for e in m_events), default=cursor)
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

    model_buckets: dict[tuple[str, str, str], dict[str, Any]] = {}
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
            estimated = False
        else:
            dur = _estimate_invocation_duration(events, idx, role, run_status, task_map, now)
            estimated = True

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
            }
            model_buckets[bucket_key] = entry
        entry["calls"] += 1
        entry["duration_sec"] += dur
        entry["estimated"] = bool(entry["estimated"] or estimated)

    for leftover_queue in completed_queues.values():
        unpaired_completed.extend(leftover_queue)
    for event in unpaired_completed:
        role, provider, model = _parse_role_event_meta(event)
        payload = _parse_json_payload(event.get("payload_json"))
        dur = max(0.0, float(payload.get("duration_sec") or 0.0))
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
            }
            model_buckets[bucket_key] = entry
        entry["calls"] += 1
        entry["duration_sec"] += dur

    total_model_sec = sum(item["duration_sec"] for item in model_buckets.values())
    models: list[dict[str, Any]] = []
    for item in model_buckets.values():
        dur_rounded = round(float(item["duration_sec"]), 1)
        avg_rounded = round(float(item["duration_sec"]) / max(1, int(item["calls"])), 1)
        share_pct = round((float(item["duration_sec"]) / total_model_sec) * 100.0, 1) if total_model_sec > 0 else 0.0
        models.append(
            {
                **item,
                "duration_sec": dur_rounded,
                "avg_sec": avg_rounded,
                "share_pct": share_pct,
            }
        )
    models.sort(key=lambda item: (-item["duration_sec"], -item["calls"], item["role"]))

    return {
        "elapsed_sec": elapsed_sec,
        "stages": stages,
        "models": models,
    }


def _escape_cell(value: str) -> str:
    return " ".join(str(value).splitlines()).replace("|", r"\|")


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
