"""Versioned, atomic persistence for a workspace's Guided session."""

from __future__ import annotations

import copy
import json
import os
import tempfile
from pathlib import Path
from typing import Literal, TypedDict, cast

from .workflow_recommend import WorkflowLineup, WorkflowMode

SESSION_VERSION = 1
SESSION_RELATIVE_PATH = Path(".baton") / "guided" / "session.json"
GuidedStage = Literal["setup", "blueprint", "build", "signoff"]


class SessionMessage(TypedDict):
    role: Literal["user", "assistant"]
    content: str


class SessionChecklistItem(TypedDict):
    id: Literal["what", "who", "scope", "limits", "done"]
    status: Literal["clear", "assumed", "open"]
    value: str


class BrainstormDraft(TypedDict):
    messages: list[SessionMessage]
    checklist: list[SessionChecklistItem]
    latest_rfc_draft: str
    selected_l0_model: str | None
    has_online_draft: bool


class WorkflowSelection(TypedDict):
    mode: WorkflowMode | None
    lineup: WorkflowLineup
    preset: str | None
    panel_enabled: bool
    launch_request_id: str | None


class HumanGateState(TypedDict):
    run_id: str
    task_id: str | None


class DrawerState(TypedDict):
    run_id: str
    task_id: str


class GuidedSession(TypedDict):
    schema_version: int
    active_stage: GuidedStage
    workspace_path: str | None
    brainstorm: BrainstormDraft
    workflow: WorkflowSelection
    active_run_id: str | None
    open_human_gate: HumanGateState | None
    open_drawer: DrawerState | None


def default_session() -> GuidedSession:
    """Return a new, independent empty session."""
    return {
        "schema_version": SESSION_VERSION,
        "active_stage": "setup",
        "workspace_path": None,
        "brainstorm": {
            "messages": [],
            "checklist": [],
            "latest_rfc_draft": "",
            "selected_l0_model": None,
            "has_online_draft": False,
        },
        "workflow": {
            "mode": None,
            "lineup": {"roles": {}, "model_overrides": {}},
            "preset": None,
            "panel_enabled": False,
            "launch_request_id": None,
        },
        "active_run_id": None,
        "open_human_gate": None,
        "open_drawer": None,
    }


def _with_defaults(data: object, defaults: dict) -> dict:
    """Fill absent known fields while retaining unknown fields at each level."""
    if not isinstance(data, dict):
        raise ValueError("Session fields must be objects")
    merged = copy.deepcopy(data)
    for key, default in defaults.items():
        if key not in merged:
            merged[key] = copy.deepcopy(default)
        elif isinstance(default, dict):
            merged[key] = _with_defaults(merged[key], default)
    return merged


def _string_or_none(value: object) -> bool:
    return value is None or isinstance(value, str)


def _valid_session(session: dict) -> bool:
    """Validate known fields; additions from newer writers are left intact."""
    version = session["schema_version"]
    draft = session["brainstorm"]
    workflow = session["workflow"]
    lineup = workflow["lineup"]
    if (
        type(version) is not int or version < 1
        or session["active_stage"] not in ("setup", "blueprint", "build", "signoff")
        or not _string_or_none(session["workspace_path"])
        or not _string_or_none(session["active_run_id"])
        or not isinstance(draft["latest_rfc_draft"], str)
        or not _string_or_none(draft["selected_l0_model"])
        or not isinstance(draft["has_online_draft"], bool)
        or workflow["mode"] not in (None, "interactive", "overnight", "panel")
        or not _string_or_none(workflow["preset"])
        or not isinstance(workflow["panel_enabled"], bool)
        or not _string_or_none(workflow["launch_request_id"])
    ):
        return False
    messages = draft["messages"]
    if not isinstance(messages, list) or any(
        not isinstance(message, dict)
        or message.get("role") not in ("user", "assistant")
        or not isinstance(message.get("content"), str)
        for message in messages
    ):
        return False
    checklist = draft["checklist"]
    if not isinstance(checklist, list) or any(
        not isinstance(item, dict)
        or item.get("id") not in ("what", "who", "scope", "limits", "done")
        or item.get("status") not in ("clear", "assumed", "open")
        or not isinstance(item.get("value"), str)
        for item in checklist
    ):
        return False
    for field in ("roles", "model_overrides"):
        mapping = lineup[field]
        if not isinstance(mapping, dict) or any(
            not isinstance(key, str) or not isinstance(value, str) for key, value in mapping.items()
        ):
            return False
    gate = session["open_human_gate"]
    if gate is not None and (
        not isinstance(gate, dict) or not isinstance(gate.get("run_id"), str)
        or "task_id" not in gate or not _string_or_none(gate["task_id"])
    ):
        return False
    drawer = session["open_drawer"]
    return drawer is None or (
        isinstance(drawer, dict) and isinstance(drawer.get("run_id"), str)
        and isinstance(drawer.get("task_id"), str)
    )


def _normalize_session(data: object) -> GuidedSession:
    session = _with_defaults(data, default_session())
    if not _valid_session(session):
        raise ValueError("Invalid Guided session document")
    return cast(GuidedSession, session)


def _invalid_json_constant(value: str) -> None:
    raise ValueError(f"Invalid JSON constant: {value}")


def load_session(repo_path: str | Path) -> GuidedSession:
    """Load a workspace session; missing or corrupt documents yield defaults.

    Other filesystem errors propagate so callers can distinguish unreadable
    storage from an absent session. Loading never writes or repairs the file.
    """
    path = Path(repo_path) / SESSION_RELATIVE_PATH
    try:
        with path.open(encoding="utf-8") as stream:
            return _normalize_session(json.load(stream, parse_constant=_invalid_json_constant))
    except (FileNotFoundError, UnicodeDecodeError, ValueError):
        return default_session()


def save_session(repo_path: str | Path, session: GuidedSession) -> None:
    """Atomically replace the session with a complete, validated JSON document."""
    document = _normalize_session(session)
    path = Path(repo_path) / SESSION_RELATIVE_PATH
    path.parent.mkdir(parents=True, exist_ok=True)
    temp_path: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=path.parent, delete=False) as stream:
            temp_path = Path(stream.name)
            json.dump(document, stream, ensure_ascii=False, indent=2, allow_nan=False)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temp_path, path)
    finally:
        if temp_path is not None:
            temp_path.unlink(missing_ok=True)


def reset_session(repo_path: str | Path) -> GuidedSession:
    """Persist and return a fresh default session."""
    session = default_session()
    save_session(repo_path, session)
    return session
