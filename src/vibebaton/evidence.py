"""Recorded evidence of a run, derived on read from its events, plan rows and RFC snapshot.

Nothing here is inferred. A gate result exists only as a ``gate_receipt`` event, a handoff only
when an event backs it, and an acceptance criterion is linked to a receipt or a changed file only
when its own text contains the command or the path verbatim.
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any, Iterable

from .rfc_checker import _parse_document

OUTPUT_TAIL_CHARS = 4000
ARTIFACT_MAX_BYTES = 200_000

_NUMBERED = re.compile(r"^[ \t]*(?P<index>\d+)[.)][ \t]+(?P<text>\S.*)$")
_INLINE_CODE = re.compile(r"`([^`\n]+)`")
_ARTIFACT_KEY = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]*")


def _payload(event: dict[str, Any]) -> dict[str, Any]:
    try:
        value = json.loads(event.get("payload_json") or "{}")
    except (TypeError, ValueError):
        return {}
    return value if isinstance(value, dict) else {}


def receipt_payload(scope: str, target_id: str, result: Any) -> dict[str, Any]:
    """The ``gate_receipt`` payload for one gate command result (a ``GateCommandResult`` or its dict)."""
    field = result.get if isinstance(result, dict) else lambda name: getattr(result, name)
    output = "\n".join(part.strip() for part in (field("stdout"), field("stderr")) if part.strip())
    return {
        "scope": scope,
        "target_id": target_id,
        "command": field("command"),
        "exit_code": field("exit_code"),
        "passed": field("exit_code") == 0,
        "duration_sec": round(float(field("duration_sec")), 3),
        "output_tail": output[-OUTPUT_TAIL_CHARS:],
    }


def record_gate_receipts(
    store: Any, run_id: str, scope: str, target_id: str, results: Iterable[Any],
    *, task_id: str | None = None, milestone_id: str | None = None,
) -> None:
    """Write one ``gate_receipt`` event per gate command that ran."""
    for result in results:
        payload = receipt_payload(scope, target_id, result)
        verdict = "PASS" if payload["passed"] else f"FAIL (exit={payload['exit_code']})"
        store.log_event(
            run_id, "gate_receipt", task_id=task_id, milestone_id=milestone_id,
            message=f"Gate `{payload['command'][:200]}` -> {verdict}", payload=payload,
        )


def gate_receipts(events: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Every recorded gate command of a run, oldest first."""
    receipts: list[dict[str, Any]] = []
    for event in events:
        if event.get("kind") != "gate_receipt":
            continue
        payload = _payload(event)
        if not isinstance(payload.get("command"), str) or not isinstance(payload.get("exit_code"), int):
            continue
        receipts.append({
            "event_id": event["id"],
            "scope": str(payload.get("scope") or ""),
            "target_id": str(payload.get("target_id") or ""),
            "command": payload["command"],
            "exit_code": payload["exit_code"],
            # A pass is an exit code of 0 and nothing else.
            "passed": payload["exit_code"] == 0,
            "duration_sec": float(payload.get("duration_sec") or 0.0),
            "output_tail": str(payload.get("output_tail") or ""),
            "created_at": event["created_at"],
        })
    return receipts


def recorded_artifact_keys(events: list[dict[str, Any]]) -> set[str]:
    return {
        key for event in events if event.get("kind") == "role_invoked"
        if isinstance(key := _payload(event).get("artifact_key"), str) and key
    }


def _read_bounded(path: Path) -> dict[str, Any] | None:
    try:
        with path.open("rb") as handle:
            data = handle.read(ARTIFACT_MAX_BYTES + 1)
        size = path.stat().st_size
    except OSError:
        return None
    return {
        "text": data[:ARTIFACT_MAX_BYTES].decode("utf-8", errors="replace"),
        "truncated": len(data) > ARTIFACT_MAX_BYTES,
        "bytes": size,
    }


def read_artifact(run_dir: Path, events: list[dict[str, Any]], artifact_key: str) -> dict[str, Any] | None:
    """Prompt and output behind a key this run recorded; ``None`` for any other key.

    The key is looked up among the run's ``role_invoked`` events, so a client can never name a path.
    """
    if artifact_key not in recorded_artifact_keys(events) or not _ARTIFACT_KEY.fullmatch(artifact_key):
        return None
    return {
        "artifact_key": artifact_key,
        "prompt": _read_bounded(run_dir / "prompts" / f"{artifact_key}.md"),
        "output": _read_bounded(run_dir / "out" / f"{artifact_key}.json"),
    }


def _invocations(events: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Each ``role_invoked`` event with the outcome of the ``role_completed`` event that follows it."""
    calls: list[dict[str, Any]] = []
    open_calls: dict[tuple[str, str, str], dict[str, Any]] = {}
    for event in events:
        kind = event.get("kind")
        if kind not in ("role_invoked", "role_completed"):
            continue
        actor = str(event.get("actor") or "")
        key = (actor, str(event.get("task_id") or ""), str(event.get("milestone_id") or ""))
        if kind == "role_invoked":
            role, _, model = actor.partition(":")
            artifact_key = _payload(event).get("artifact_key")
            call = {
                "event_id": event["id"],
                "artifact_key": artifact_key if isinstance(artifact_key, str) and artifact_key else None,
                "role": role,
                "model": model,
                "task_id": event.get("task_id"),
                "milestone_id": event.get("milestone_id"),
                "created_at": event["created_at"],
                "status": None,
                "duration_sec": None,
            }
            calls.append(call)
            open_calls[key] = call
        elif key in open_calls:
            payload = _payload(event)
            call = open_calls.pop(key)
            call["status"] = payload.get("status") if isinstance(payload.get("status"), str) else None
            duration = payload.get("duration_sec")
            call["duration_sec"] = float(duration) if isinstance(duration, (int, float)) else None
    return calls


def _side(calls: list[dict[str, Any]], side: str) -> list[dict[str, Any]]:
    return [
        {key: call[key] for key in ("event_id", "artifact_key", "role", "model", "created_at", "status",
                                    "duration_sec")} | {"side": side}
        for call in calls
    ]


def _review(events: list[dict[str, Any]], passed: str, rejected: str, **match: str) -> dict[str, Any] | None:
    for event in reversed(events):
        if event.get("kind") not in (passed, rejected):
            continue
        if any(event.get(column) != value for column, value in match.items()):
            continue
        return {
            "verdict": "PASS" if event["kind"] == passed else "REJECT",
            "summary": str(event.get("message") or ""),
            "reviewer": str(event.get("actor") or ""),
            "event_id": event["id"],
        }
    return None


def derive_handoffs(
    events: list[dict[str, Any]], milestones: list[dict[str, Any]], tasks: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """One entry per relay edge of the plan: who handed to whom and what the events recorded of it.

    The edges follow the plan (planner or previous milestone -> task -> milestone -> next task or
    final gate). ``recorded`` is true only when an event backs the handoff: a call to the receiving
    task, a ``task_passed`` merge, a ``milestone_passed`` merge. Every other field is a recorded value
    or empty; nothing is filled in from the plan.
    """
    calls = _invocations(events)
    receipts = gate_receipts(events)
    by_kind: dict[str, list[dict[str, Any]]] = {}
    for event in events:
        by_kind.setdefault(str(event.get("kind")), []).append(event)

    def first(kind: str, **match: str) -> dict[str, Any] | None:
        return next((event for event in by_kind.get(kind, [])
                     if all(event.get(column) == value for column, value in match.items())), None)

    planner_calls = [call for call in calls if call["role"] == "tactical_planner"]
    milestone_ids = [str(m["id"]) for m in milestones]
    tasks_by_milestone: dict[str, list[dict[str, Any]]] = {mid: [] for mid in milestone_ids}
    for task in tasks:
        tasks_by_milestone.setdefault(str(task.get("milestone_id")), []).append(task)

    def milestone_out(mid: str) -> dict[str, Any]:
        """What a milestone hands on once its review passed and it merged."""
        passed = first("milestone_passed", milestone_id=mid)
        own = [call for call in calls if call["milestone_id"] == mid and not call["task_id"]]
        task_ids = {task["id"] for task in tasks_by_milestone.get(mid, [])}
        changes = [event for event in by_kind.get("task_changes", []) if event.get("task_id") in task_ids]
        files = [str(item) for event in changes for item in _payload(event).get("changed_files") or []]
        return {
            "recorded": passed is not None,
            "event_ids": [passed["id"]] if passed else [],
            "at": passed["created_at"] if passed else None,
            "invocations": _side(own, "from"),
            "changed_files": list(dict.fromkeys(files)) if changes else None,
            "receipts": [r for r in receipts if (r["scope"], r["target_id"]) in (("milestone", mid), ("merge", f"milestone_{mid}"))],
            "review": _review(events, "milestone_passed", "milestone_rejected", milestone_id=mid),
        }

    handoffs: list[dict[str, Any]] = []
    previous: dict[str, Any] = {"kind": "planner", "id": None}
    for index, milestone in enumerate(milestones):
        mid = str(milestone["id"])
        upstream = milestone_out(milestone_ids[index - 1]) if index else None
        for task in tasks_by_milestone.get(mid, []):
            tid = str(task["id"])
            own = [call for call in calls if call["task_id"] == tid]
            into: dict[str, Any] = {
                "from": previous, "to": {"kind": "task", "id": tid},
                "recorded": bool(own),
                "event_ids": [own[0]["event_id"]] if own else [],
                "at": own[0]["created_at"] if own else None,
                "invocations": (_side(planner_calls, "from") if index == 0 else upstream["invocations"]) + _side(own[:1], "to"),
                "changed_files": upstream["changed_files"] if upstream else None,
                "receipts": upstream["receipts"] if upstream else [],
                "review": upstream["review"] if upstream else None,
                "takeover": {"status": task.get("status"), "holder": task.get("assigned_model") or task.get("current_role")
                             or task.get("assignee_role")},
                "blocked_reason": task.get("last_error") or None,
            }
            handoffs.append(into)

            passed = first("task_passed", task_id=tid)
            changes = [event for event in by_kind.get("task_changes", []) if event.get("task_id") == tid]
            files = [str(item) for event in changes for item in _payload(event).get("changed_files") or []]
            handoffs.append({
                "from": {"kind": "task", "id": tid}, "to": {"kind": "milestone", "id": mid},
                "recorded": passed is not None,
                "event_ids": [passed["id"]] if passed else [],
                "at": passed["created_at"] if passed else None,
                "invocations": _side(own, "from"),
                "changed_files": list(dict.fromkeys(files)) if changes else None,
                "receipts": [r for r in receipts if (r["scope"], r["target_id"]) in (("task", tid), ("merge", f"task_{tid}"))],
                "review": _review(events, "task_review_passed", "task_review_rejected", task_id=tid),
                "takeover": {"status": milestone.get("status"), "holder": milestone.get("reviewer_role")},
                "blocked_reason": task.get("last_error") or None,
            })
        if not tasks_by_milestone.get(mid):
            handoffs.append({
                "from": previous, "to": {"kind": "milestone", "id": mid},
                "recorded": False, "event_ids": [], "at": None, "invocations": [], "changed_files": None,
                "receipts": [], "review": None,
                "takeover": {"status": milestone.get("status"), "holder": milestone.get("reviewer_role")},
                "blocked_reason": None,
            })
        previous = {"kind": "milestone", "id": mid}

    ready = first("ready_for_final_gate")
    approved = first("final_gate_approved")
    last = milestone_out(milestone_ids[-1]) if milestone_ids else None
    handoffs.append({
        "from": previous, "to": {"kind": "final_gate", "id": None},
        "recorded": ready is not None,
        "event_ids": [ready["id"]] if ready else [],
        "at": ready["created_at"] if ready else None,
        "invocations": last["invocations"] if last else _side(planner_calls, "from"),
        "changed_files": last["changed_files"] if last else None,
        "receipts": (last["receipts"] if last else []) + [r for r in receipts if r["scope"] == "final"],
        "review": last["review"] if last else None,
        "takeover": {"status": "APPROVED" if approved else ("WAITING" if ready else None), "holder": "human" if ready else None},
        "blocked_reason": None,
    })
    for handoff in handoffs:
        handoff["id"] = ">".join(
            ref["kind"] if ref["id"] is None else f"{ref['kind']}:{ref['id']}" for ref in (handoff["from"], handoff["to"])
        )
    return handoffs


def acceptance_criteria(rfc_text: str) -> list[dict[str, Any]]:
    """The numbered acceptance criteria of an RFC, each with its own text (fenced blocks excluded)."""
    criteria: list[dict[str, Any]] = []
    current: dict[str, Any] | None = None
    for line in _parse_document(rfc_text)[0].get("acceptance", []):
        match = _NUMBERED.match(line)
        if match:
            current = {"index": int(match.group("index")), "text": match.group("text").strip()}
            criteria.append(current)
        elif not line.strip():
            current = None
        elif current is not None:
            current["text"] += " " + line.strip()
    return criteria


def _cites_command(text: str, command: str) -> bool:
    command = command.strip()
    if not command:
        return False
    if not any(char.isspace() for char in command):
        # One word could be ordinary prose ("make sure ..."); it counts only as inline code.
        return any(span.strip() == command for span in _INLINE_CODE.findall(text))
    return command in text


def _cites_path(text: str, path: str) -> bool:
    path = path.strip()
    if not path:
        return False
    return re.search(rf"(?<![\w./\\-]){re.escape(path)}(?![\w/\\-])", text) is not None


def derive_evidence(rfc_text: str | None, events: list[dict[str, Any]]) -> dict[str, Any]:
    """Acceptance criteria against gate receipts and changed files; three states, never inferred.

    ``receipt``: the criterion's text cites the command of a receipt; its result is the recorded one
    (the latest receipt of each cited command, all of them exit code 0 to count as passed).
    ``files_only``: it cites a changed file and no receipt. ``not_linked``: neither.
    """
    receipts = gate_receipts(events)
    changed: list[str] = []
    for event in events:
        files = _payload(event).get("changed_files") if event.get("kind") == "task_changes" else None
        if isinstance(files, list):
            changed.extend(str(item) for item in files)
    changed = list(dict.fromkeys(changed))

    cited_commands: set[str] = set()
    rows: list[dict[str, Any]] = []
    for criterion in acceptance_criteria(rfc_text or ""):
        text = criterion["text"]
        linked = [receipt for receipt in receipts if _cites_command(text, receipt["command"])]
        files = [path for path in changed if _cites_path(text, path)]
        result = None
        if linked:
            cited_commands.update(receipt["command"] for receipt in linked)
            latest = {receipt["command"]: receipt for receipt in linked}
            result = "passed" if all(receipt["exit_code"] == 0 for receipt in latest.values()) else "failed"
        rows.append({
            **criterion,
            "state": "receipt" if linked else "files_only" if files else "not_linked",
            "result": result,
            "receipts": linked,
            "files": files,
        })
    return {
        "rfc_available": rfc_text is not None,
        "criteria": rows,
        "run_level_receipts": [receipt for receipt in receipts if receipt["command"] not in cited_commands],
        "summary": {
            "criteria": len(rows),
            "passed": sum(row["result"] == "passed" for row in rows),
            "failed": sum(row["result"] == "failed" for row in rows),
            "files_only": sum(row["state"] == "files_only" for row in rows),
            "not_linked": sum(row["state"] == "not_linked" for row in rows),
            "receipts": len(receipts),
        },
    }
