"""Data contracts and strict schema validators for VibeBaton pipelines."""

from __future__ import annotations

import json
import re
from dataclasses import asdict, dataclass, field
from enum import StrEnum
from typing import Any


class RunStatus(StrEnum):
    PENDING = "PENDING"
    PLANNING = "PLANNING"
    RUNNING = "RUNNING"
    PAUSED = "PAUSED"
    WAITING_HUMAN = "WAITING_HUMAN"
    READY_FOR_FINAL_GATE = "READY_FOR_FINAL_GATE"
    COMPLETED = "COMPLETED"
    FAILED = "FAILED"


class TaskStatus(StrEnum):
    PENDING = "PENDING"
    RUNNING = "RUNNING"
    GATE_CHECKING = "GATE_CHECKING"
    REVIEWING = "REVIEWING"
    COOLDOWN = "COOLDOWN"
    WAITING_HUMAN = "WAITING_HUMAN"
    PASSED = "PASSED"
    FAILED = "FAILED"
    SKIPPED = "SKIPPED"


class TaskTier(StrEnum):
    CRITICAL = "critical"
    ROUTINE = "routine"


class VerdictKind(StrEnum):
    PASS = "PASS"
    MINOR_FIX = "MINOR_FIX"
    MAJOR_REWORK = "MAJOR_REWORK"
    PLAN_AMENDMENT = "PLAN_AMENDMENT"


class SchemaValidationError(ValueError):
    """Raised when an agent artifact violates the expected JSON contract."""


@dataclass
class TaskSpec:
    id: str
    title: str
    description: str = ""
    tier: TaskTier = TaskTier.ROUTINE
    assignee_role: str = "bulk_worker"
    reviewer_role: str | None = "micro_orchestrator"
    depends_on: list[str] = field(default_factory=list)
    allowed_paths: list[str] = field(default_factory=list)
    golden_example: str | None = None
    acceptance_criteria: list[str] = field(default_factory=list)
    verify_cmd: str | None = None
    max_self_heal: int | None = None
    max_review_rejects: int | None = None
    escalate_role: str = "critical_executor"
    assigned_model: str | None = None
    allocation_reason: str | None = None
    pinned: bool = False

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> TaskSpec:
        if not isinstance(data, dict):
            raise SchemaValidationError("Task entry must be a JSON object")
        task_id = str(data.get("id", "")).strip()
        title = str(data.get("title", "")).strip()
        if not task_id or not title:
            raise SchemaValidationError("Task must include non-empty 'id' and 'title'")

        raw_tier = str(data.get("tier", "routine")).lower().strip()
        try:
            tier = TaskTier(raw_tier)
        except ValueError as exc:
            raise SchemaValidationError(f"Task {task_id}: invalid tier '{raw_tier}'") from exc

        default_assignee = "critical_executor" if tier == TaskTier.CRITICAL else "bulk_worker"
        default_reviewer = None if tier == TaskTier.CRITICAL else "micro_orchestrator"

        assigned_model = data.get("assigned_model")
        allocation_reason = data.get("allocation_reason")
        pinned = data.get("pinned", False)
        if assigned_model is not None and not isinstance(assigned_model, str):
            raise SchemaValidationError(f"Task {task_id}: assigned_model must be a string or null")
        if allocation_reason is not None and not isinstance(allocation_reason, str):
            raise SchemaValidationError(f"Task {task_id}: allocation_reason must be a string or null")
        if not isinstance(pinned, bool):
            raise SchemaValidationError(f"Task {task_id}: pinned must be a boolean")

        return cls(
            id=task_id,
            title=title,
            description=str(data.get("description", "")),
            tier=tier,
            assignee_role=str(data.get("assignee_role") or data.get("assignee") or default_assignee),
            reviewer_role=(
                None
                if ("reviewer_role" in data and data["reviewer_role"] is None)
                else str(data.get("reviewer_role") or data.get("reviewer") or default_reviewer)
                if (data.get("reviewer_role") or data.get("reviewer") or default_reviewer)
                else None
            ),
            depends_on=[str(x) for x in data.get("depends_on", [])],
            allowed_paths=[str(x) for x in data.get("allowed_paths", [])],
            golden_example=str(data["golden_example"]) if data.get("golden_example") else None,
            acceptance_criteria=[str(x) for x in data.get("acceptance_criteria", [])],
            verify_cmd=str(data["verify_cmd"]) if data.get("verify_cmd") else None,
            max_self_heal=int(data["max_self_heal"]) if data.get("max_self_heal") is not None else None,
            max_review_rejects=(
                int(data["max_review_rejects"]) if data.get("max_review_rejects") is not None else None
            ),
            escalate_role=str(data.get("escalate_role") or data.get("escalate_to") or "critical_executor"),
            assigned_model=assigned_model,
            allocation_reason=allocation_reason,
            pinned=pinned,
        )

    def to_dict(self) -> dict[str, Any]:
        payload = asdict(self)
        payload["tier"] = self.tier.value
        return payload


@dataclass
class MilestoneSpec:
    id: str
    title: str
    reviewer_role: str = "milestone_reviewer"
    gate_commands: list[str] = field(default_factory=list)
    tasks: list[TaskSpec] = field(default_factory=list)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> MilestoneSpec:
        if not isinstance(data, dict):
            raise SchemaValidationError("Milestone entry must be a JSON object")
        m_id = str(data.get("id", "")).strip()
        title = str(data.get("title", "")).strip()
        if not m_id or not title:
            raise SchemaValidationError("Milestone must include non-empty 'id' and 'title'")
        raw_tasks = data.get("tasks", [])
        if not isinstance(raw_tasks, list) or not raw_tasks:
            raise SchemaValidationError(f"Milestone {m_id} must contain at least one task")
        tasks = [TaskSpec.from_dict(item) for item in raw_tasks]
        return cls(
            id=m_id,
            title=title,
            reviewer_role=str(data.get("reviewer_role") or data.get("reviewer") or "milestone_reviewer"),
            gate_commands=[str(c) for c in data.get("gate_commands", [])],
            tasks=tasks,
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "title": self.title,
            "reviewer_role": self.reviewer_role,
            "gate_commands": list(self.gate_commands),
            "tasks": [t.to_dict() for t in self.tasks],
        }


@dataclass
class PlanDAG:
    rfc_version: str
    complexity_tier: str
    milestones: list[MilestoneSpec]
    summary: str = ""

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> PlanDAG:
        if not isinstance(data, dict):
            raise SchemaValidationError("PlanDAG root must be a JSON object")
        raw_milestones = data.get("milestones", [])
        if not isinstance(raw_milestones, list) or not raw_milestones:
            raise SchemaValidationError("PlanDAG must contain at least one milestone")

        milestones = [MilestoneSpec.from_dict(m) for m in raw_milestones]
        plan = cls(
            rfc_version=str(data.get("rfc_version", "v1.0")),
            complexity_tier=str(data.get("complexity_tier", "M")).upper(),
            milestones=milestones,
            summary=str(data.get("summary", "")),
        )
        plan.validate_graph()
        return plan

    def validate_graph(self) -> None:
        """Ensure unique task IDs and acyclic task dependencies within each milestone."""
        seen_ids: set[str] = set()
        for milestone in self.milestones:
            local_ids: set[str] = set()
            for task in milestone.tasks:
                if task.id in seen_ids:
                    raise SchemaValidationError(f"Duplicate task id detected: '{task.id}'")
                seen_ids.add(task.id)
                local_ids.add(task.id)

            # Topological cycle check inside milestone
            deps = {t.id: set(t.depends_on) for t in milestone.tasks}
            for task_id, dep_set in deps.items():
                unknown = dep_set - seen_ids
                if unknown:
                    raise SchemaValidationError(
                        f"Task '{task_id}' depends on unknown task(s): {sorted(unknown)}"
                    )
            visiting: set[str] = set()
            visited: set[str] = set()

            def dfs(node: str) -> None:
                if node in visited:
                    return
                if node in visiting:
                    raise SchemaValidationError(f"Dependency cycle detected involving task '{node}'")
                visiting.add(node)
                for dep in deps.get(node, ()):
                    if dep in local_ids:
                        dfs(dep)
                visiting.remove(node)
                visited.add(node)

            for tid in local_ids:
                dfs(tid)

    def to_dict(self) -> dict[str, Any]:
        return {
            "rfc_version": self.rfc_version,
            "complexity_tier": self.complexity_tier,
            "summary": self.summary,
            "milestones": [m.to_dict() for m in self.milestones],
        }


@dataclass
class BlockingIssue:
    file: str
    message: str
    line: int | None = None
    category: str = "defect"
    suggested_fix: str = ""

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> BlockingIssue:
        return cls(
            file=str(data.get("file", "")),
            message=str(data.get("message", "")),
            line=int(data["line"]) if data.get("line") is not None else None,
            category=str(data.get("category", "defect")),
            suggested_fix=str(data.get("suggested_fix", "")),
        )


@dataclass
class ReviewVerdict:
    target_id: str
    reviewer: str
    verdict: VerdictKind
    summary: str = ""
    confidence: float = 0.85
    blocking_issues: list[BlockingIssue] = field(default_factory=list)
    nitpicks: list[str] = field(default_factory=list)
    escalate_reason: str | None = None

    @classmethod
    def from_dict(cls, data: dict[str, Any], default_target: str = "", default_reviewer: str = "") -> ReviewVerdict:
        if not isinstance(data, dict):
            raise SchemaValidationError("ReviewVerdict must be a JSON object")
        raw_verdict = str(data.get("verdict", "")).upper().strip()
        try:
            verdict = VerdictKind(raw_verdict)
        except ValueError as exc:
            raise SchemaValidationError(f"Invalid review verdict '{raw_verdict}'") from exc

        issues = [
            BlockingIssue.from_dict(item)
            for item in data.get("blocking_issues", [])
            if isinstance(item, dict)
        ]
        return cls(
            target_id=str(data.get("target_id") or default_target),
            reviewer=str(data.get("reviewer") or default_reviewer),
            verdict=verdict,
            summary=str(data.get("summary", "")),
            confidence=float(data.get("confidence", 0.85)),
            blocking_issues=issues,
            nitpicks=[str(n) for n in data.get("nitpicks", [])],
            escalate_reason=str(data["escalate_reason"]) if data.get("escalate_reason") else None,
        )

    def to_dict(self) -> dict[str, Any]:
        payload = asdict(self)
        payload["verdict"] = self.verdict.value
        return payload


_FENCE_RE = re.compile(r"```(?:json)?\s*(\{.*?\})\s*```", re.DOTALL | re.IGNORECASE)


def extract_json_object(raw_text: str) -> dict[str, Any]:
    """Robustly parse a JSON object from direct CLI stdout or fenced markdown output."""
    text = raw_text.strip()
    if not text:
        raise SchemaValidationError("Empty output where a JSON object was expected")

    # 1. Try direct JSON parse
    try:
        parsed = json.loads(text)
        if isinstance(parsed, dict):
            return parsed
    except json.JSONDecodeError:
        pass

    # 2. Try markdown ```json ... ``` blocks (prefer the last valid one)
    matches = _FENCE_RE.findall(text)
    for candidate in reversed(matches):
        try:
            parsed = json.loads(candidate)
            if isinstance(parsed, dict):
                return parsed
        except json.JSONDecodeError:
            continue

    # 3. Fallback: scan for outermost balanced {...} object
    start = text.find("{")
    end = text.rfind("}")
    if start != -1 and end != -1 and end > start:
        try:
            parsed = json.loads(text[start : end + 1])
            if isinstance(parsed, dict):
                return parsed
        except json.JSONDecodeError:
            pass

    raise SchemaValidationError(f"Could not extract a valid JSON object from output: {text[:240]!r}")
