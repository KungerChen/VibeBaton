"""SQLite WAL state machine, quota cooldown tracker, and telemetry event store."""

from __future__ import annotations

import json
import sqlite3
import time
import uuid
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator

from .schemas import PlanDAG, RunStatus, TaskStatus

_SCHEMA_SQL = """
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 10000;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS runs (
    id TEXT PRIMARY KEY,
    repo_path TEXT NOT NULL,
    rfc_path TEXT NOT NULL,
    plan_path TEXT,
    mode TEXT NOT NULL DEFAULT 'overnight',
    status TEXT NOT NULL,
    model_overrides_json TEXT NOT NULL DEFAULT '{}',
    summary TEXT NOT NULL DEFAULT '',
    human_prompt TEXT,
    human_decision TEXT,
    created_at REAL NOT NULL,
    updated_at REAL NOT NULL,
    finished_at REAL
);

CREATE TABLE IF NOT EXISTS milestones (
    run_id TEXT NOT NULL,
    id TEXT NOT NULL,
    idx INTEGER NOT NULL,
    title TEXT NOT NULL,
    reviewer_role TEXT NOT NULL,
    gate_commands_json TEXT NOT NULL DEFAULT '[]',
    branch_name TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL,
    review_json TEXT,
    created_at REAL NOT NULL,
    updated_at REAL NOT NULL,
    PRIMARY KEY (run_id, id),
    FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS tasks (
    run_id TEXT NOT NULL,
    milestone_id TEXT NOT NULL,
    id TEXT NOT NULL,
    title TEXT NOT NULL,
    tier TEXT NOT NULL,
    assignee_role TEXT NOT NULL,
    current_role TEXT NOT NULL,
    reviewer_role TEXT,
    spec_json TEXT NOT NULL,
    status TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    self_heal_count INTEGER NOT NULL DEFAULT 0,
    review_reject_count INTEGER NOT NULL DEFAULT 0,
    escalated INTEGER NOT NULL DEFAULT 0,
    worktree_path TEXT,
    branch_name TEXT,
    last_error TEXT,
    last_review_json TEXT,
    duration_sec REAL NOT NULL DEFAULT 0.0,
    created_at REAL NOT NULL,
    updated_at REAL NOT NULL,
    PRIMARY KEY (run_id, id),
    FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS provider_quotas (
    provider TEXT PRIMARY KEY,
    cooldown_until REAL NOT NULL DEFAULT 0.0,
    backoff_step INTEGER NOT NULL DEFAULT 0,
    cooldown_hits INTEGER NOT NULL DEFAULT 0,
    last_reason TEXT NOT NULL DEFAULT '',
    updated_at REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL,
    task_id TEXT,
    milestone_id TEXT,
    kind TEXT NOT NULL,
    actor TEXT NOT NULL DEFAULT 'engine',
    message TEXT NOT NULL DEFAULT '',
    payload_json TEXT NOT NULL DEFAULT '{}',
    created_at REAL NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_events_run ON events(run_id, id);
CREATE INDEX IF NOT EXISTS idx_tasks_run_status ON tasks(run_id, status);
"""


class StateStore:
    """Cross-process safe SQLite WAL store shared by MCP Server and background Daemon."""

    def __init__(self, db_path: Path) -> None:
        self.db_path = db_path.resolve()
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._init_schema()

    @contextmanager
    def _connect(self) -> Iterator[sqlite3.Connection]:
        conn = sqlite3.connect(str(self.db_path), timeout=15.0)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA busy_timeout = 10000")
        conn.execute("PRAGMA foreign_keys = ON")
        try:
            yield conn
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()

    def _init_schema(self) -> None:
        with self._connect() as conn:
            conn.executescript(_SCHEMA_SQL)

    # ------------------------------------------------------------------
    # Runs
    # ------------------------------------------------------------------

    def create_run(
        self,
        repo_path: Path,
        rfc_path: Path,
        mode: str = "overnight",
        plan_path: Path | None = None,
        model_overrides: dict[str, str] | None = None,
        run_id: str | None = None,
    ) -> str:
        now = time.time()
        rid = run_id or f"run-{time.strftime('%Y%m%d-%H%M%S')}-{uuid.uuid4().hex[:6]}"
        with self._connect() as conn:
            conn.execute(
                """
                INSERT INTO runs (
                    id, repo_path, rfc_path, plan_path, mode, status,
                    model_overrides_json, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    rid,
                    str(repo_path.resolve()),
                    str(rfc_path.resolve()),
                    str(plan_path.resolve()) if plan_path else None,
                    mode,
                    RunStatus.PENDING.value,
                    json.dumps(model_overrides or {}, ensure_ascii=False),
                    now,
                    now,
                ),
            )
        self.log_event(rid, "run_created", message=f"Run created in {mode} mode")
        return rid

    def get_run(self, run_id: str) -> dict[str, Any] | None:
        with self._connect() as conn:
            row = conn.execute("SELECT * FROM runs WHERE id = ?", (run_id,)).fetchone()
            return dict(row) if row else None

    def get_latest_run(self) -> dict[str, Any] | None:
        with self._connect() as conn:
            row = conn.execute("SELECT * FROM runs ORDER BY created_at DESC LIMIT 1").fetchone()
            return dict(row) if row else None

    def list_runs(self, limit: int = 20) -> list[dict[str, Any]]:
        with self._connect() as conn:
            rows = conn.execute(
                "SELECT * FROM runs ORDER BY created_at DESC LIMIT ?", (limit,)
            ).fetchall()
            return [dict(r) for r in rows]

    def update_run_status(
        self,
        run_id: str,
        status: RunStatus,
        summary: str | None = None,
        human_prompt: str | None = None,
        plan_path: str | None = None,
    ) -> None:
        now = time.time()
        finished_at = now if status in (RunStatus.COMPLETED, RunStatus.FAILED) else None
        fields = ["status = ?", "updated_at = ?"]
        values: list[Any] = [status.value, now]
        if summary is not None:
            fields.append("summary = ?")
            values.append(summary)
        if human_prompt is not None:
            fields.append("human_prompt = ?")
            values.append(human_prompt)
        if plan_path is not None:
            fields.append("plan_path = ?")
            values.append(plan_path)
        if finished_at is not None:
            fields.append("finished_at = ?")
            values.append(finished_at)
        values.append(run_id)
        with self._connect() as conn:
            conn.execute(f"UPDATE runs SET {', '.join(fields)} WHERE id = ?", values)

    def record_human_decision(self, run_id: str, decision: str, note: str = "") -> None:
        now = time.time()
        payload = json.dumps({"decision": decision, "note": note, "at": now}, ensure_ascii=False)
        next_status = RunStatus.RUNNING if decision == "approve" else RunStatus.PAUSED
        with self._connect() as conn:
            conn.execute(
                "UPDATE runs SET human_decision = ?, status = ?, updated_at = ? WHERE id = ?",
                (payload, next_status.value, now, run_id),
            )
        self.log_event(
            run_id,
            "human_decision",
            actor="human",
            message=f"Human resolved with '{decision}': {note}",
            payload={"decision": decision, "note": note},
        )

    # ------------------------------------------------------------------
    # Plan / Milestones / Tasks
    # ------------------------------------------------------------------

    def register_plan(self, run_id: str, plan: PlanDAG) -> None:
        now = time.time()
        with self._connect() as conn:
            for idx, m in enumerate(plan.milestones):
                branch = f"milestone/{run_id[-6:]}-{m.id.lower()}"
                conn.execute(
                    """
                    INSERT OR IGNORE INTO milestones (
                        run_id, id, idx, title, reviewer_role, gate_commands_json,
                        branch_name, status, created_at, updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        run_id,
                        m.id,
                        idx,
                        m.title,
                        m.reviewer_role,
                        json.dumps(m.gate_commands, ensure_ascii=False),
                        branch,
                        TaskStatus.PENDING.value,
                        now,
                        now,
                    ),
                )
                for task in m.tasks:
                    conn.execute(
                        """
                        INSERT OR IGNORE INTO tasks (
                            run_id, milestone_id, id, title, tier,
                            assignee_role, current_role, reviewer_role,
                            spec_json, status, created_at, updated_at
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                        """,
                        (
                            run_id,
                            m.id,
                            task.id,
                            task.title,
                            task.tier.value,
                            task.assignee_role,
                            task.assignee_role,
                            task.reviewer_role,
                            json.dumps(task.to_dict(), ensure_ascii=False),
                            TaskStatus.PENDING.value,
                            now,
                            now,
                        ),
                    )
        self.log_event(
            run_id,
            "plan_registered",
            message=f"Registered {len(plan.milestones)} milestone(s) and "
            f"{sum(len(m.tasks) for m in plan.milestones)} task(s)",
        )

    def get_milestones(self, run_id: str) -> list[dict[str, Any]]:
        with self._connect() as conn:
            rows = conn.execute(
                "SELECT * FROM milestones WHERE run_id = ? ORDER BY idx ASC", (run_id,)
            ).fetchall()
            return [dict(r) for r in rows]

    def update_milestone(
        self,
        run_id: str,
        milestone_id: str,
        status: TaskStatus,
        review_json: dict[str, Any] | None = None,
    ) -> None:
        now = time.time()
        with self._connect() as conn:
            if review_json is not None:
                conn.execute(
                    "UPDATE milestones SET status = ?, review_json = ?, updated_at = ? "
                    "WHERE run_id = ? AND id = ?",
                    (status.value, json.dumps(review_json, ensure_ascii=False), now, run_id, milestone_id),
                )
            else:
                conn.execute(
                    "UPDATE milestones SET status = ?, updated_at = ? WHERE run_id = ? AND id = ?",
                    (status.value, now, run_id, milestone_id),
                )

    def get_tasks(self, run_id: str, milestone_id: str | None = None) -> list[dict[str, Any]]:
        with self._connect() as conn:
            if milestone_id:
                rows = conn.execute(
                    "SELECT * FROM tasks WHERE run_id = ? AND milestone_id = ? ORDER BY created_at ASC, id ASC",
                    (run_id, milestone_id),
                ).fetchall()
            else:
                rows = conn.execute(
                    "SELECT * FROM tasks WHERE run_id = ? ORDER BY created_at ASC, id ASC",
                    (run_id,),
                ).fetchall()
            return [dict(r) for r in rows]

    def get_task(self, run_id: str, task_id: str) -> dict[str, Any] | None:
        with self._connect() as conn:
            row = conn.execute(
                "SELECT * FROM tasks WHERE run_id = ? AND id = ?", (run_id, task_id)
            ).fetchone()
            return dict(row) if row else None

    def update_task(self, run_id: str, task_id: str, **kwargs: Any) -> None:
        if not kwargs:
            return
        now = time.time()
        fields: list[str] = ["updated_at = ?"]
        values: list[Any] = [now]
        for key, value in kwargs.items():
            if isinstance(value, TaskStatus):
                value = value.value
            if key == "last_review_json" and isinstance(value, dict):
                value = json.dumps(value, ensure_ascii=False)
            fields.append(f"{key} = ?")
            values.append(value)
        values.extend([run_id, task_id])
        with self._connect() as conn:
            conn.execute(
                f"UPDATE tasks SET {', '.join(fields)} WHERE run_id = ? AND id = ?",
                values,
            )

    # ------------------------------------------------------------------
    # Provider Subscription Quota Cooldowns
    # ------------------------------------------------------------------

    def get_provider_cooldown(self, provider: str) -> float:
        """Return remaining cooldown seconds (0.0 if ready)."""
        with self._connect() as conn:
            row = conn.execute(
                "SELECT cooldown_until FROM provider_quotas WHERE provider = ?", (provider,)
            ).fetchone()
            if not row:
                return 0.0
            remaining = float(row["cooldown_until"]) - time.time()
            return max(0.0, remaining)

    def get_all_quotas(self) -> list[dict[str, Any]]:
        now = time.time()
        with self._connect() as conn:
            rows = conn.execute("SELECT * FROM provider_quotas ORDER BY provider ASC").fetchall()
            result = []
            for r in rows:
                item = dict(r)
                item["remaining_sec"] = max(0.0, float(item["cooldown_until"]) - now)
                result.append(item)
            return result

    def trigger_provider_cooldown(
        self,
        provider: str,
        backoff_schedule: list[int],
        reason: str,
        explicit_wait_sec: float | None = None,
    ) -> float:
        """Record a subscription rate-limit event and return applied wait seconds."""
        now = time.time()
        with self._connect() as conn:
            row = conn.execute(
                "SELECT backoff_step, cooldown_hits FROM provider_quotas WHERE provider = ?",
                (provider,),
            ).fetchone()
            step = int(row["backoff_step"]) if row else 0
            hits = int(row["cooldown_hits"]) if row else 0
            if explicit_wait_sec is not None and explicit_wait_sec > 0:
                wait_sec = float(explicit_wait_sec)
            else:
                schedule = backoff_schedule or [60, 300, 900]
                wait_sec = float(schedule[min(step, len(schedule) - 1)])
            until = now + wait_sec
            conn.execute(
                """
                INSERT INTO provider_quotas (provider, cooldown_until, backoff_step, cooldown_hits, last_reason, updated_at)
                VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(provider) DO UPDATE SET
                    cooldown_until = excluded.cooldown_until,
                    backoff_step = excluded.backoff_step,
                    cooldown_hits = excluded.cooldown_hits,
                    last_reason = excluded.last_reason,
                    updated_at = excluded.updated_at
                """,
                (provider, until, step + 1, hits + 1, reason[:300], now),
            )
        return wait_sec

    def reset_provider_backoff(self, provider: str) -> None:
        now = time.time()
        with self._connect() as conn:
            conn.execute(
                """
                INSERT INTO provider_quotas (provider, cooldown_until, backoff_step, cooldown_hits, last_reason, updated_at)
                VALUES (?, 0.0, 0, 0, '', ?)
                ON CONFLICT(provider) DO UPDATE SET
                    cooldown_until = 0.0,
                    backoff_step = 0,
                    updated_at = excluded.updated_at
                """,
                (provider, now),
            )

    # ------------------------------------------------------------------
    # Telemetry & Audit Events
    # ------------------------------------------------------------------

    def log_event(
        self,
        run_id: str,
        kind: str,
        message: str = "",
        actor: str = "engine",
        task_id: str | None = None,
        milestone_id: str | None = None,
        payload: dict[str, Any] | None = None,
    ) -> None:
        now = time.time()
        with self._connect() as conn:
            conn.execute(
                """
                INSERT INTO events (run_id, task_id, milestone_id, kind, actor, message, payload_json, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    run_id,
                    task_id,
                    milestone_id,
                    kind,
                    actor,
                    message,
                    json.dumps(payload or {}, ensure_ascii=False),
                    now,
                ),
            )
            conn.execute("UPDATE runs SET updated_at = ? WHERE id = ?", (now, run_id))

    def get_events(
        self,
        run_id: str,
        task_id: str | None = None,
        limit: int = 100,
    ) -> list[dict[str, Any]]:
        with self._connect() as conn:
            if task_id:
                rows = conn.execute(
                    "SELECT * FROM events WHERE run_id = ? AND task_id = ? ORDER BY id DESC LIMIT ?",
                    (run_id, task_id, limit),
                ).fetchall()
            else:
                rows = conn.execute(
                    "SELECT * FROM events WHERE run_id = ? ORDER BY id DESC LIMIT ?",
                    (run_id, limit),
                ).fetchall()
            return [dict(r) for r in reversed(rows)]
