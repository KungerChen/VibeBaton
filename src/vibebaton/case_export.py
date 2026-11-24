"""Build portable, sanitized replay cases from StateStore rows."""

from __future__ import annotations

import hashlib
import ipaddress
import json
import re
import time
from collections import defaultdict
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING, Any, Iterable, Literal

from . import credentials
from .allocation import parse_model_spec
from .config import HotReloadConfig, find_config_path
from .graph_engine import GraphTraceEvent, TraceKind
from .graph_schema import EdgeSpec, NodeSpec, NodeType, WorkflowGraph, validate_graph
from .report import _BillingTelemetry, _parse_json_payload, _parse_role_event_meta, _record_billing

if TYPE_CHECKING:
    from .db import StateStore


_Row = dict[str, Any]
_NodeIds = tuple[dict[str, str], dict[str, str]]
_PLANNER_ID = "l0_planner"
_FINAL_GATE_ID = "l0_final_gate"
_COLUMN_WIDTH = 260
_ROW_HEIGHT = 120
_DSH_REFERENCE_RE = re.compile(r"(?:dsh_)?opencode|\bdsh_deepseek\b", re.IGNORECASE)
_PANEL_STAGE = "00_PANEL"
_PANEL_KINDS = frozenset(("panel_started", "panel_member_completed", "panel_synthesized"))

_REDACTED = "[REDACTED]"
_REDACTED_RE = re.escape(_REDACTED)
_WEBHOOK_PATH_END = r"""\s?#<>"'`"""
# Named groups capture the prefix to preserve.
_SECRET_RE = re.compile(
    r"sk-[A-Za-z0-9_-]{12,}|ghp_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,}"
    r"|AIza[A-Za-z0-9_-]{20,}|(?:xox[bap]|xapp)-[A-Za-z0-9-]{10,}"
    r"|(?P<bearer>(?i:\bBearer)\s+)[A-Za-z0-9._~+/=-]{8,}"
    r"|(?P<webhook>(?<![\w.-])(?i:open\.feishu\.cn/open-apis/bot/v2/hook/"
    r"|hooks\.slack\.com/services/|discord\.com/api/webhooks/))"
    rf"(?!{_REDACTED_RE}(?=$|[{_WEBHOOK_PATH_END}]))[^{_WEBHOOK_PATH_END}]+"
    # The query rule also covers WeCom's key and DingTalk's access_token.
    r"|(?P<query>[?&](?i:token|key|access_token|api_key|secret)=)"
    rf"(?!{_REDACTED_RE}(?=$|[&\s]))[^&\s]+"
)
_HOME_RE = re.compile(
    r"""(?:(?i:\b[A-Z]:[\\/]Users[\\/])|/(?:Users|home)/)"""
    r"""(?:[^\\/\s"'<>|:,;]+(?: [^\\/\s"'<>|:,;]+)*(?=[\\/"'])|[^\\/\s"'<>|:,;]+)"""
)
_EMAIL_RE = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")
_SEMVER_IDENTIFIERS = r"[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*"
_IPV4_RE = re.compile(
    # Consume a version before looking for an address in its prerelease or build metadata.
    rf"(?<![\w.])(?:v?[0-9]+(?:\.[0-9]+){{2}}(?:-{_SEMVER_IDENTIFIERS})?(?:\+{_SEMVER_IDENTIFIERS})?"
    r"|(?P<ipv4>[0-9]{1,3}(?:\.[0-9]{1,3}){3}))(?!\w|\.[0-9])"
)
_RFC1918_NETWORKS = tuple(
    ipaddress.IPv4Network(cidr) for cidr in ("10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16")
)
_DIFF_RE = re.compile(
    r"^(?:diff --git\b[^\r\n]*|--- a/[^\r\n]+\r?\n\+\+\+ b/[^\r\n]+)"
    r"(?:\r?\n(?:diff --git\b|index |(?:new file|deleted file|old|new) mode "
    r"|(?:dis)?similarity index |(?:rename|copy) (?:from|to) "
    r"|@@|[ +\-]|\\ No newline at end of file)[^\r\n]*)*",
    re.MULTILINE,
)
_PYTHON_EXCEPTION_LINE = r"\r?\n[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*(?::[^\r\n]*)?(?=\r?$)"
_PYTHON_TRACEBACK = (
    r"\bTraceback \(most recent call last\):[^\r\n]*"
    rf"(?:(?:\r?\n[ \t]+[^\r\n]*)+(?:{_PYTHON_EXCEPTION_LINE})?|{_PYTHON_EXCEPTION_LINE})"
)
_STACK_RE = re.compile(
    rf"{_PYTHON_TRACEBACK}(?:\r?\n\r?\n"
    r"(?:The above exception was the direct cause of the following exception:"
    r"|During handling of the above exception, another exception occurred:)"
    rf"\r?\n\r?\n{_PYTHON_TRACEBACK})*",
    re.MULTILINE,
)
_JS_FRAME = r"[ \t]+at [^\r\n]+\([^\r\n]+:\d+:\d+\)[ \t]*"
_JS_STACK_RE = re.compile(rf"^{_JS_FRAME}(?:\r?\n{_JS_FRAME})+(?=\r?$)", re.MULTILINE)
_PATH_START = r"(?<![\w./\\-])"
_PATH_END = r"""\s"'<>|\x60"""
_PROTECTED_PATH_TEXT = (
    r"(?P<protected>(?:(?<![A-Za-z0-9+.-])[A-Za-z][A-Za-z0-9+.-]*://"
    r"|#recipe=|<(?:repo|home|path)>[\\/])"
    rf"[^{_PATH_END}]*)"
)
_ABSOLUTE_PATH = (
    rf"[A-Za-z]:[\\/][^{_PATH_END}]+"
    rf"|\\\\[^{_PATH_END}\\/]+[\\/][^{_PATH_END}\\/][^{_PATH_END}]*"
    rf"|/(?:var|opt|tmp|srv|mnt|etc|usr)/[^{_PATH_END}]*"
)
_LOCAL_PATH = rf"{_PATH_START}(?:(?P<home>{_HOME_RE.pattern})|(?P<absolute>{_ABSOLUTE_PATH}))"


@dataclass
class RedactionReport:
    """Count replacements made while preparing the bundle."""

    secrets_redacted: int = 0
    paths_anonymized: int = 0
    emails_redacted: int = 0
    ips_redacted: int = 0
    raw_diff_stripped: int = 0
    raw_stack_stripped: int = 0
    clean: bool = False

    def to_dict(self) -> dict[str, int | bool]:
        return asdict(self)


@dataclass
class _RedactionContext:
    """Redaction settings and counts shared by one export."""

    repo_path: str | Path | None = None
    literal_secrets: tuple[re.Pattern[str], ...] = field(default=(), repr=False)
    include_review_summaries: bool = True
    source_run_id: str | None = None
    rfc_path: str | None = None
    report: RedactionReport = field(default_factory=RedactionReport)


def _literal_secret_patterns(extra_secrets: Iterable[str] | None) -> tuple[re.Pattern[str], ...]:
    if isinstance(extra_secrets, str):
        extra_secrets = (extra_secrets,)
    literals = {secret for secret in extra_secrets or () if isinstance(secret, str) and secret}
    try:
        local = credentials._read_local_credentials(credentials.default_credentials_path())
    except (OSError, ValueError):
        local = {}
    ordered = sorted({*literals, *local.values()}, key=lambda secret: (-len(secret), secret))
    return tuple(re.compile(re.escape(secret)) for secret in ordered)


def _replace_secrets(text: str, literals: tuple[re.Pattern[str], ...]) -> tuple[str, int]:
    spans = [
        (match.end(match.lastgroup) if match.lastgroup else match.start(), match.end())
        for match in _SECRET_RE.finditer(text)
    ]
    if literals:
        for literal in literals:
            spans.extend(match.span() for match in literal.finditer(text))
        spans.sort()

    # Merge overlapping matches before inserting placeholders so partial secrets cannot survive.
    parts: list[str] = []
    cursor = 0
    replacements = 0
    for start, end in spans:
        if start >= cursor:
            parts.extend((text[cursor:start], _REDACTED))
            replacements += 1
        cursor = max(cursor, end)
    parts.append(text[cursor:])
    return "".join(parts), replacements


def redact_secrets(text: str, extra_secrets: Iterable[str] | None) -> tuple[str, int]:
    """Replace known token formats and configured literal secrets."""
    return _replace_secrets(text, _literal_secret_patterns(extra_secrets))


def _basename(path: str) -> str:
    return re.split(r"[\\/]", path.rstrip("\\/"))[-1]


def _known_path_pattern(path: str) -> str:
    if re.match(r"^(?:[A-Za-z]:[\\/]|\\\\)", path):
        parts = r"[\\/]".join(re.escape(part) for part in re.split(r"[\\/]", path))
        return rf"(?i:{parts})"
    return re.escape(path)


def anonymize_paths(
    text: str, repo_path: str | Path | None, *, rfc_path: str | None = None,
) -> tuple[str, int]:
    """Replace local paths while preserving URLs, recipe fragments, and relative paths."""
    repo = str(repo_path or "").rstrip("\\/")
    rfc = rfc_path or ""
    # Match the longest known reference first, before its parent repository or home.
    patterns = [_PROTECTED_PATH_TEXT]
    replacements = {"home": "<home>"}
    for kind, path, replacement in (("rfc", rfc, _basename(rfc)), ("repo", repo, "<repo>")):
        if not path or path == replacement or re.fullmatch(r"[A-Za-z]:", path):
            continue
        patterns.append(rf"{_PATH_START}(?P<{kind}>{_known_path_pattern(path)})(?![\w-]|\.\w)")
        replacements[kind] = replacement
    patterns.append(_LOCAL_PATH)
    count = 0

    def replace(match: re.Match[str]) -> str:
        nonlocal count
        kind = match.lastgroup or ""
        if kind == "protected":
            return match[0]
        count += 1
        if kind == "absolute":
            return f"<path>/{_basename(match[0])}"
        return replacements[kind]

    text = re.sub("|".join(patterns), replace, text)
    return text, count


def _is_private_ipv4(candidate: str | None) -> bool:
    if candidate is None:
        return False
    try:
        address = ipaddress.ip_address(candidate)
    except ValueError:
        return False
    return address.is_private and any(address in network for network in _RFC1918_NETWORKS)


def redact_identity(text: str) -> tuple[str, int, int]:
    """Replace email addresses and RFC 1918 IPv4 literals."""
    text, emails = _EMAIL_RE.subn("[REDACTED_EMAIL]", text)
    ips = 0

    def replace_ip(match: re.Match[str]) -> str:
        nonlocal ips
        if _is_private_ipv4(match["ipv4"]):
            ips += 1
            return "[REDACTED_IP]"
        return match[0]

    text = _IPV4_RE.sub(replace_ip, text)
    return text, emails, ips


def strip_code_blocks(text: str) -> tuple[str, int, int]:
    """Replace Git patches and Python and JavaScript stack traces with replay markers."""
    text, diffs = _DIFF_RE.subn("[diff stripped]", text)
    text, python_stacks = _STACK_RE.subn("[stack trace stripped]", text)
    text, js_stacks = _JS_STACK_RE.subn("[stack trace stripped]", text)
    return text, diffs, python_stacks + js_stacks


def _case_id(run_id: str, *, anonymized: bool = False) -> str:
    length = 10 if anonymized else 12
    return f"case-{hashlib.sha256(run_id.encode()).hexdigest()[:length]}"


def _plan_excerpt(text: str) -> str:
    return text[:239] + "…" if len(text) > 240 else text


def sanitize_text(text: str, ctx: _RedactionContext) -> str:
    """Apply the four layers in order and accumulate their counts."""
    text, secrets = _replace_secrets(text, ctx.literal_secrets)
    text, paths = anonymize_paths(text, ctx.repo_path, rfc_path=ctx.rfc_path)
    text, emails, ips = redact_identity(text)
    text, diffs, stacks = strip_code_blocks(text)
    ctx.report.secrets_redacted += secrets
    ctx.report.paths_anonymized += paths
    ctx.report.emails_redacted += emails
    ctx.report.ips_redacted += ips
    ctx.report.raw_diff_stripped += diffs
    ctx.report.raw_stack_stripped += stacks
    if ctx.source_run_id:
        text = text.replace(ctx.source_run_id, _case_id(ctx.source_run_id, anonymized=True))
    return _DSH_REFERENCE_RE.sub("DSH", text)


def _node_ids(milestones: list[_Row], tasks: list[_Row], ctx: _RedactionContext) -> _NodeIds:
    reviewer_ids = {row["id"]: f"m{row['idx']}_review" for row in milestones}
    worker_ids: dict[str, str] = {}
    for task in tasks:
        task_id = task["id"]
        # A stable alias keeps IDs distinct when two redactions would produce the same text.
        safe_id = task_id if sanitize_text(task_id, ctx) == task_id else _case_id(task_id)
        worker_ids[task_id] = f"t_{safe_id}"
    return reviewer_ids, worker_ids


def build_case_graph(
    run: _Row, milestones: list[_Row], tasks: list[_Row], ctx: _RedactionContext,
    *, node_ids: _NodeIds | None = None,
) -> dict[str, Any]:
    """Arrange parallel workers between successive milestone reviews."""
    reviewer_ids, worker_ids = node_ids if node_ids is not None else _node_ids(milestones, tasks, ctx)
    tasks_by_milestone: dict[str, list[_Row]] = defaultdict(list)
    for task in tasks:
        tasks_by_milestone[task["milestone_id"]].append(task)
    orphan_workers = [worker_ids[task["id"]] for task in tasks if task["milestone_id"] not in reviewer_ids]
    if orphan_workers:
        raise ValueError("Invalid replay graph: task nodes without milestones: " + ", ".join(orphan_workers))

    try:
        config = HotReloadConfig(find_config_path(Path(run["repo_path"]))).current
    except (OSError, ValueError, KeyError, RuntimeError):
        config = None  # Historical runs can outlive their configuration file.
    overrides = {
        role: target for role, target in _parse_json_payload(run.get("model_overrides_json")).items()
        if isinstance(target, str) and target.strip()
    }
    known_providers = {"host_native", "dsh_opencode", "dsh_deepseek"}
    if config is not None:
        known_providers.update(config.providers)

    def model_config(role: str, assigned_model: str | None = None) -> dict[str, str]:
        default = config.roles.get(role) if config is not None else None
        provider, model = (default.provider, default.model) if default is not None else ("", "")
        target = assigned_model or overrides.get(role)
        if isinstance(target, str) and target.strip():
            provider, model = parse_model_spec(target.strip(), provider, known_providers)
        return {key: sanitize_text(value, ctx) for key, value in (("provider", provider), ("model", model)) if value}

    nodes = [NodeSpec(
        _PLANNER_ID, NodeType.planner_node, "Planner", position={"x": 0, "y": 0},
        config=model_config("tactical_planner"),
    )]
    edges: list[EdgeSpec] = []

    def connect(source: str, target: str, handle: str) -> None:
        edges.append(EdgeSpec(f"e{len(edges) + 1}", source, target, source_handle=handle))

    source_id, source_handle = _PLANNER_ID, "dag"
    for column, milestone in enumerate(milestones):
        milestone_id = milestone["id"]
        reviewer_id = reviewer_ids[milestone_id]
        milestone_tasks = tasks_by_milestone.get(milestone_id, [])
        worker_x = _COLUMN_WIDTH * (2 * column + 1)
        for row, task in enumerate(milestone_tasks):
            worker_id = worker_ids[task["id"]]
            role = task.get("current_role") or task["assignee_role"]
            assigned_model = _parse_json_payload(task.get("spec_json")).get("assigned_model")
            if not task.get("attempts") and role in overrides:
                assigned_model = None  # The run override takes priority before dispatch.
            nodes.append(NodeSpec(
                worker_id, NodeType.worker_node, _plan_excerpt(sanitize_text(task["title"], ctx)),
                position={"x": worker_x, "y": _ROW_HEIGHT * row},
                config=model_config(role, assigned_model),
            ))
            connect(source_id, worker_id, source_handle)
            connect(worker_id, reviewer_id, "out")
        if not milestone_tasks:
            connect(source_id, reviewer_id, source_handle)
        nodes.append(NodeSpec(
            reviewer_id, NodeType.reviewer_node, _plan_excerpt(sanitize_text(milestone["title"], ctx)),
            position={"x": worker_x + _COLUMN_WIDTH, "y": 0},
            config=model_config(milestone["reviewer_role"]),
        ))
        source_id, source_handle = reviewer_id, "pass"

    nodes.append(NodeSpec(
        _FINAL_GATE_ID, NodeType.human_gate_node, "Final sign-off",
        position={"x": _COLUMN_WIDTH * (2 * len(milestones) + 1), "y": 0},
        config=model_config("brainstorm_and_final_gate"),
    ))
    connect(source_id, _FINAL_GATE_ID, source_handle)
    graph_id = _case_id(run["id"], anonymized=ctx.source_run_id is not None)
    graph = WorkflowGraph("1.0", graph_id, "Run replay", nodes, edges)
    result = validate_graph(graph)
    if not result.valid:
        raise ValueError("Invalid replay graph: " + "; ".join(result.errors))
    return graph.to_dict()


_Outcome = Literal["passed", "retry", "escalated", "failed", "info"]
_TraceTransition = tuple[TraceKind, _Outcome]
_STATUS_TRANSITIONS: dict[str, _TraceTransition] = {
    "running": ("node_started", "info"),
    "gate_checking": ("node_started", "info"),
    "reviewing": ("node_started", "info"),
    "cooldown": ("node_completed", "retry"),
    "waiting_human": ("node_completed", "escalated"),
    "passed": ("node_completed", "passed"),
    "failed": ("node_failed", "failed"),
    "skipped": ("node_completed", "info"),
}
_STATUS_ALIASES = {
    "task_started": "task_running",
    "task_allocated": "task_running",
    "milestone_started": "milestone_running",
}
_GATE_FAILURES = {"gate_failed", "mechanical_gate_caught", "milestone_gate_failed"}
_TRACE_TRANSITIONS: dict[str, _TraceTransition] = {
    **{
        f"{scope}_{status}": transition
        for scope in ("task", "milestone")
        for status, transition in _STATUS_TRANSITIONS.items()
    },
    "run_created": ("node_started", "info"),
    "plan_registered": ("node_completed", "passed"),
    "plan_schema_error": ("node_completed", "retry"),
    "role_invoked": ("node_started", "info"),
    "task_review_passed": ("node_completed", "passed"),
    "task_review_rejected": ("node_completed", "retry"),
    "task_exec_error": ("node_completed", "retry"),
    "task_step_up": ("node_completed", "retry"),
    "task_escalated": ("node_completed", "escalated"),
    "milestone_rejected": ("node_completed", "retry"),
    "plan_amendment_requested": ("node_completed", "escalated"),
    "whitelist_violation": ("node_completed", "retry"),
    "ready_for_final_gate": ("node_started", "info"),
    "run_completed": ("graph_completed", "passed"),
    "run_failed": ("graph_halted", "failed"),
    "run_exception": ("graph_halted", "failed"),
    **{kind: ("node_completed", "retry") for kind in _GATE_FAILURES},
}
_REVIEW_MESSAGES = {
    "task_review_passed": "Passed review",
    "task_review_rejected": "Review revision requested",
    "milestone_passed": "Passed review",
    "milestone_rejected": "Review revision requested",
    "plan_amendment_requested": "Review revision requested",
}


def _review_message(event_kind: str, message: str) -> str | None:
    if event_kind == "task_escalated" and message.startswith("MAJOR_REWORK "):
        return _REVIEW_MESSAGES["task_review_rejected"]
    if event_kind == "human_attention_required" and " reviewer requested PLAN_AMENDMENT:" in message:
        return _REVIEW_MESSAGES["plan_amendment_requested"]
    return _REVIEW_MESSAGES.get(event_kind)


def _trace_history(run: _Row, events: list[_Row], milestones: list[_Row], tasks: list[_Row]) -> list[_Row]:
    """Fill gaps from the latest stored status of each task and milestone."""
    history = list(events)
    event_kinds = {event["kind"] for event in events}
    observed_statuses = {
        (_STATUS_ALIASES.get(event["kind"], event["kind"]), event.get("task_id") or event.get("milestone_id"))
        for event in events
    }
    if "run_created" not in event_kinds:
        history.append({"kind": "run_created", "created_at": run["created_at"], "message": "Run created"})
    if milestones and "plan_registered" not in event_kinds:
        history.append({
            "kind": "plan_registered", "created_at": min(row["created_at"] for row in milestones),
            "message": f"Registered {len(milestones)} milestone(s) and {len(tasks)} task(s)",
        })
    for scope, rows in (("task", tasks), ("milestone", milestones)):
        for row in rows:
            status = row["status"].lower()
            kind = f"{scope}_{status}"
            if status not in _STATUS_TRANSITIONS or (kind, row["id"]) in observed_statuses:
                continue
            history.append({
                "kind": kind, f"{scope}_id": row["id"], "created_at": row["updated_at"],
                "message": f"{scope.capitalize()} status {row['status']}",
            })
    final_kind = {
        "READY_FOR_FINAL_GATE": "ready_for_final_gate", "COMPLETED": "run_completed", "FAILED": "run_failed",
    }.get(run["status"])
    if final_kind == "run_failed" and "run_exception" in event_kinds:
        final_kind = None
    if final_kind is not None and final_kind not in event_kinds:
        finished_at = run["finished_at"]
        history.append({
            "kind": final_kind, "created_at": finished_at if finished_at is not None else run["updated_at"],
            "message": f"Run status {run['status']}",
        })
    return sorted(history, key=lambda row: row["created_at"])


def _panel_payload(event: _Row) -> dict[str, Any]:
    return _parse_json_payload(event.get("payload_json"))


def _panel_text(value: Any) -> str:
    return value.strip() if isinstance(value, str) else ""


def _panel_count(value: Any) -> int | None:
    return value if type(value) is int and value >= 0 else None


def _panel_elapsed(value: Any) -> float | None:
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        return None
    return round(max(0.0, float(value)), 1)


def _panel_member_label(payload: dict[str, Any]) -> str:
    member = _panel_text(payload.get("member_id")) or "panel member"
    perspective = _panel_text(payload.get("perspective"))
    return f"{member} ({perspective})" if perspective else member


def _panel_transition(event_kind: str, payload: dict[str, Any]) -> _TraceTransition:
    if event_kind == "panel_started":
        return "node_started", "info"
    if event_kind == "panel_synthesized":
        return "node_completed", "passed"
    ok = payload.get("ok", not payload.get("error"))
    return "node_completed", "passed" if ok else "failed"


def _panel_trace_message(event_kind: str, payload: dict[str, Any], fallback: str) -> str:
    message = "" if fallback == event_kind else fallback
    if event_kind == "panel_started":
        count = _panel_count(payload.get("member_count"))
        head = f"Panel started with {count} specialist(s)" if count is not None else "Panel started"
        detail = message
    elif event_kind == "panel_member_completed":
        ok = payload.get("ok", not payload.get("error"))
        route = "/".join(
            part for part in (_panel_text(payload.get("provider")), _panel_text(payload.get("model"))) if part
        )
        head = f"{_panel_member_label(payload)} {'completed' if ok else 'failed'}"
        if route:
            head += f" via {route}"
        detail = _panel_text(payload.get("preview" if ok else "error")) or message
    else:
        member_count = _panel_count(payload.get("member_count"))
        succeeded_count = _panel_count(payload.get("succeeded_count"))
        head = "Synthesized"
        if member_count is not None and succeeded_count is not None:
            head += f" {succeeded_count}/{member_count} specialist report(s)"
        elapsed_sec = _panel_elapsed(payload.get("elapsed_sec"))
        if elapsed_sec is not None:
            head += f" in {elapsed_sec:g}s"
        detail = (
            _panel_text(payload.get("preview"))
            or _panel_text(payload.get("master_spec_path"))
            or message
        )
    return f"{head}: {detail}" if detail and detail not in head else head


def _panel_summary(panel_events: list[_Row]) -> dict[str, Any] | None:
    if not panel_events:
        return None
    started = next((_panel_payload(event) for event in panel_events if event["kind"] == "panel_started"), {})
    synthesized = next(
        (_panel_payload(event) for event in reversed(panel_events) if event["kind"] == "panel_synthesized"), {},
    )
    members = [
        _panel_payload(event) for event in panel_events if event["kind"] == "panel_member_completed"
    ]
    member_count = _panel_count(synthesized.get("member_count"))
    if member_count is None:
        member_count = _panel_count(started.get("member_count"))
    if member_count is None:
        member_count = len(members)
    succeeded_count = _panel_count(synthesized.get("succeeded_count"))
    if succeeded_count is None:
        succeeded_count = sum(1 for payload in members if payload.get("ok", not payload.get("error")))
    elapsed_sec = _panel_elapsed(synthesized.get("elapsed_sec"))
    if elapsed_sec is None:
        elapsed_sec = round(max(0.0, panel_events[-1]["created_at"] - panel_events[0]["created_at"]), 1)
    return {
        "member_count": member_count,
        "succeeded_count": succeeded_count,
        "elapsed_sec": elapsed_sec,
    }


def build_case_trace(
    run: _Row, events: list[_Row], milestones: list[_Row], tasks: list[_Row],
    ctx: _RedactionContext,
    *, graph: _Row | None = None, node_ids: _NodeIds | None = None,
) -> list[dict[str, Any]]:
    """Project recorded events onto the graph in timestamp order."""
    ids = node_ids if node_ids is not None else _node_ids(milestones, tasks, ctx)
    reviewer_ids, worker_ids = ids
    if graph is None:
        graph = build_case_graph(run, milestones, tasks, ctx, node_ids=ids)
    rfc_name = _basename(run.get("rfc_path") or "")
    labels = {node["id"]: node["label"] for node in graph["nodes"]}
    incoming: dict[str, list[_Row]] = defaultdict(list)
    for edge in graph["edges"]:
        incoming[edge["target"]].append(edge)
    passed_nodes: set[str] = set()
    traversed: set[str] = set()
    trace: list[_Row] = []

    def emit(
        kind: TraceKind, node_id: str, outcome: _Outcome, timestamp: float, message: str,
        edge_id: str | None = None,
    ) -> None:
        trace.append(GraphTraceEvent(len(trace) + 1, timestamp, kind, node_id, edge_id, outcome, message).to_dict())

    for event in _trace_history(run, events, milestones, tasks):
        event_kind = event["kind"]
        if event_kind in _PANEL_KINDS:
            payload = _panel_payload(event)
            kind, outcome = _panel_transition(event_kind, payload)
            message = _panel_trace_message(event_kind, payload, event.get("message") or event_kind)
            emit(kind, _PANEL_STAGE, outcome, event["created_at"], sanitize_text(message, ctx))
            continue
        transition = _STATUS_ALIASES.get(event_kind, event_kind)
        kind, outcome = _TRACE_TRANSITIONS.get(transition, ("node_completed", "info"))
        if event_kind in ("ready_for_final_gate", "run_completed"):
            node_id = _FINAL_GATE_ID
        else:
            node_id = (
                worker_ids.get(event.get("task_id"))
                or reviewer_ids.get(event.get("milestone_id"))
                or _PLANNER_ID
            )
        message = event.get("message") or event_kind
        if event_kind.startswith("rfc_"):
            message = f"RFC: {rfc_name}" if rfc_name else "RFC referenced"
        review_label = None if ctx.include_review_summaries else _review_message(event_kind, message)
        message = review_label if review_label is not None else sanitize_text(message, ctx)
        if event_kind.startswith("plan_"):
            message = _plan_excerpt(message)
        timestamp = event["created_at"]
        # A handoff is supported once the source passed and the destination is observed.
        if kind == "node_started" or outcome != "info":
            for edge in incoming.get(node_id, ()):
                source, edge_id = edge["source"], edge["id"]
                if source in passed_nodes and edge_id not in traversed:
                    emit("edge_traversed", source, "passed", timestamp, f"{labels[source]} → {labels[node_id]}", edge_id)
                    traversed.add(edge_id)
        emit(kind, node_id, outcome, timestamp, message)
        if event_kind in ("plan_registered", "task_passed", "milestone_passed"):
            passed_nodes.add(node_id)
    return trace


def _milestone_stages(
    run: _Row, milestones: list[_Row], tasks: list[_Row], events: list[_Row],
    ended_at: float, ctx: _RedactionContext,
) -> list[_Row]:
    tasks_by_milestone: dict[str, list[_Row]] = defaultdict(list)
    milestone_for_task = {task["id"]: task["milestone_id"] for task in tasks}
    for task in tasks:
        tasks_by_milestone[task["milestone_id"]].append(task)
    events_by_milestone: dict[str, list[_Row]] = defaultdict(list)
    for event in events:
        milestone_id = event.get("milestone_id") or milestone_for_task.get(event.get("task_id"))
        if milestone_id:
            events_by_milestone[milestone_id].append(event)

    stages: list[_Row] = []
    cursor = run["created_at"]
    for milestone in milestones:
        milestone_id, status = milestone["id"], milestone["status"]
        stage_events = events_by_milestone[milestone_id]
        stage_tasks = tasks_by_milestone[milestone_id]
        activity = [event["created_at"] for event in stage_events]
        started_at = min(activity, default=max(cursor, milestone["created_at"]))
        if status == "PENDING" and not activity:
            stage_end = started_at
        elif status == "RUNNING" and run["status"] == "RUNNING":
            stage_end = ended_at
        else:
            last_task_update = max((task["updated_at"] for task in stage_tasks), default=started_at)
            stage_end = max(last_task_update, milestone["updated_at"], max(activity, default=started_at))
            if status in ("PASSED", "FAILED", "SKIPPED"):
                terminal_kind = f"milestone_{status.lower()}"
                stage_end = max(
                    (event["created_at"] for event in stage_events if event["kind"] == terminal_kind),
                    default=stage_end,
                )
        cursor = max(cursor, stage_end)
        stages.append({
            "id": sanitize_text(milestone_id, ctx),
            "kind": "milestone",
            "title": sanitize_text(milestone["title"], ctx),
            "status": sanitize_text(status, ctx),
            "wall_sec": round(max(0.0, stage_end - started_at), 1),
            "task_sum_sec": round(sum(task["duration_sec"] for task in stage_tasks), 1),
            "passed_tasks": sum(task["status"] == "PASSED" for task in stage_tasks),
            "total_tasks": len(stage_tasks),
        })
    return stages


def build_case_meta(
    run: _Row, milestones: list[_Row], tasks: list[_Row], events: list[_Row],
    *, ctx: _RedactionContext | None = None, graph: _Row | None = None,
) -> dict[str, Any]:
    """Summarize the same run rows used to build the graph and trace."""
    if ctx is None:
        ctx = _RedactionContext(repo_path=run["repo_path"])
    if graph is None:
        graph = build_case_graph(run, milestones, tasks, ctx)
    ended_at = run["finished_at"]
    if ended_at is None:
        ended_at = time.time()

    billing: _BillingTelemetry = {
        "total_prompt_tokens": 0,
        "total_completion_tokens": 0,
        "total_cached_tokens": 0,
        "total_tokens": 0,
        "total_cost_usd": None,
        "has_exact_billing": False,
    }
    # The report accumulator writes per-model totals alongside the bundle totals.
    model_totals: dict[str, Any] = {"prompt_tokens": 0, "completion_tokens": 0, "cost_usd": None}
    models: set[tuple[str, str]] = {
        (config["provider"], config["model"])
        for node in graph["nodes"]
        if (config := node["config"]).get("provider") and config.get("model")
    }
    recorded_models: set[tuple[str, str]] = set()
    for event in events:
        kind = event["kind"]
        if kind in ("role_invoked", "role_completed"):
            _, provider, model = _parse_role_event_meta(event)
            if provider and model and model != "unknown":
                recorded_models.add((provider, model))
        if kind == "role_completed":
            _record_billing(model_totals, billing, _parse_json_payload(event.get("payload_json")))
    models.update((sanitize_text(p, ctx), sanitize_text(m, ctx)) for p, m in sorted(recorded_models))
    billing["total_tokens"] = billing["total_prompt_tokens"] + billing["total_completion_tokens"]
    if billing["total_cost_usd"] is not None:
        billing["total_cost_usd"] = round(billing["total_cost_usd"], 6)

    escalated_tasks = {task["id"] for task in tasks if task["escalated"]}
    escalated_tasks.update(
        event["task_id"] for event in events if event["kind"] == "task_escalated" and event.get("task_id")
    )
    meta: _Row = {
        "source_run_id": (
            _case_id(run["id"], anonymized=True) if ctx.source_run_id else sanitize_text(run["id"], ctx)
        ),
        "status": sanitize_text(run["status"], ctx),
        "elapsed_sec": round(max(0.0, ended_at - run["created_at"]), 1),
        "milestones_passed": sum(row["status"] == "PASSED" for row in milestones),
        "milestones_total": len(milestones),
        "tasks_passed": sum(row["status"] == "PASSED" for row in tasks),
        "tasks_total": len(tasks),
        "gate_catches": sum(event["kind"] in _GATE_FAILURES for event in events),
        "whitelist_catches": sum(event["kind"] == "whitelist_violation" for event in events),
        "escalations": len(escalated_tasks),
        "models": [{"provider": provider, "model": model} for provider, model in sorted(models)],
        "stages": _milestone_stages(run, milestones, tasks, events, ended_at, ctx),
        "billing": billing,
    }
    panel_events = sorted(
        (event for event in events if event["kind"] in _PANEL_KINDS),
        key=lambda event: event["created_at"],
    )
    panel = _panel_summary(panel_events)
    if panel is not None:
        meta["panel"] = panel
    return meta


def audit_serialized(bundle_json: str) -> bool:
    """Scan escaped JSON keys and values for any surviving supported patterns."""
    try:
        pending = [json.loads(bundle_json)]
    except json.JSONDecodeError:
        return False
    patterns = (_SECRET_RE, _EMAIL_RE, _DIFF_RE, _STACK_RE, _JS_STACK_RE)
    while pending:
        value = pending.pop()
        if isinstance(value, dict):
            pending.extend(value)
            pending.extend(value.values())
        elif isinstance(value, list):
            pending.extend(value)
        elif isinstance(value, str):
            if (
                anonymize_paths(value, None)[1]
                or any(pattern.search(value) for pattern in patterns)
                or any(_is_private_ipv4(match["ipv4"]) for match in _IPV4_RE.finditer(value))
            ):
                return False
    return True


def export_sanitized_case(
    store: StateStore,
    run_id: str,
    *,
    title: str | None = None,
    include_review_summaries: bool = True,
    anonymize_run_id: bool = False,
    extra_secrets: Iterable[str] | None = None,
) -> dict[str, Any]:
    """Export a run as baton-case/v1. Raise KeyError for an unknown run."""
    run = store.get_run(run_id)
    if run is None:
        raise KeyError(run_id)
    # Plan registration inserts milestones and tasks together.
    tasks = store.get_tasks(run_id)
    milestones = store.get_milestones(run_id)
    events = store.get_events(run_id, limit=-1)
    ctx = _RedactionContext(
        repo_path=run["repo_path"],
        literal_secrets=_literal_secret_patterns(extra_secrets),
        include_review_summaries=include_review_summaries,
        source_run_id=run_id if anonymize_run_id else None,
        rfc_path=run.get("rfc_path"),
    )
    case_id = _case_id(run_id, anonymized=anonymize_run_id)
    display_id = case_id if anonymize_run_id else run_id
    case_title = sanitize_text(title if title is not None else f"Run {display_id}", ctx)
    summary = sanitize_text(run["summary"], ctx)
    node_ids = _node_ids(milestones, tasks, ctx)
    graph = build_case_graph(run, milestones, tasks, ctx, node_ids=node_ids)
    trace = build_case_trace(run, events, milestones, tasks, ctx, graph=graph, node_ids=node_ids)
    meta = build_case_meta(run, milestones, tasks, events, ctx=ctx, graph=graph)
    bundle: dict[str, Any] = {
        "schema_version": "baton-case/v1",
        "case_id": case_id,
        "title": case_title,
        "summary": summary,
        "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(run["created_at"])),
        "meta": meta,
        "redaction_report": ctx.report.to_dict(),
        "graph": graph,
        "trace": trace,
    }
    ctx.report.clean = audit_serialized(json.dumps(bundle, ensure_ascii=False))
    bundle["redaction_report"]["clean"] = ctx.report.clean
    return bundle
