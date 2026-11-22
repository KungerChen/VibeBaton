"""Build-in-Public telemetry & self-hosting battle report generator (`baton report`)."""

from __future__ import annotations

import json
import time
from typing import Any

from .db import StateStore


def generate_battle_report(store: StateStore, run_id: str) -> str:
    """Compile structured run telemetry into a shareable Markdown battle report."""
    run = store.get_run(run_id)
    if not run:
        raise ValueError(f"Run '{run_id}' not found")

    milestones = store.get_milestones(run_id)
    tasks = store.get_tasks(run_id)
    events = store.get_events(run_id, limit=-1)
    # Keep the existing metric window while reading the full allocation history.
    recent_events = events[-2000:]

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

    end_ts = run["finished_at"] or run["updated_at"] or time.time()
    elapsed_sec = max(0.0, float(end_ts) - float(run["created_at"]))

    routine_rate = (
        f"{(routine_first_pass / len(routine_tasks)) * 100:.1f}%"
        if routine_tasks
        else "N/A"
    )

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
        "",
        "## Task Breakdown",
        "",
        "| Task | Tier | Final Role | Status | Self-Heals | Rejects | Escalated | Duration |",
        "| :--- | :--- | :--- | :--- | :---: | :---: | :---: | :---: |",
    ]

    for t in tasks:
        lines.append(
            f"| `{t['id']}` {t['title']} | {t['tier']} | `{t['current_role']}` | `{t['status']}` | "
            f"{t['self_heal_count']} | {t['review_reject_count']} | "
            f"{'Yes' if t['escalated'] else 'No'} | {float(t['duration_sec']):.1f}s |"
        )

    if run.get("summary"):
        lines.extend(["", "## Summary", "", str(run["summary"])])

    lines.extend(_smart_allocation_summary(events))
    return "\n".join(lines) + "\n"


def _smart_allocation_summary(events: list[dict[str, Any]]) -> list[str]:
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

    profile_text = ", ".join(f"`{profile}`" for profile in sorted(profiles)) or "unavailable"
    pinned_count = sum(allocation["pinned"] for allocation in allocations.values())
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
            escaped_cells = [" ".join(cell.splitlines()).replace("|", r"\|") for cell in cells]
            lines.append("| " + " | ".join(escaped_cells) + " |")
    if step_ups:
        lines.extend(["", "**Step-ups**", ""])
        for event in step_ups:
            lines.append(f"- `{event['task_id']}` attempt {event['attempt']} — `{event['from']}` → `{event['to']}`")
    return lines
