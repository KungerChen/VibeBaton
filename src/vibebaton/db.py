"""SQLite WAL state machine, quota cooldown tracker, and telemetry event store."""

from __future__ import annotations

import json
import sqlite3
import time
import uuid
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Callable, Iterator

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

CREATE TABLE IF NOT EXISTS run_execution_locks (
    run_id TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
    token TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS run_stop_requests (
    run_id TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
    had_executor INTEGER NOT NULL
);
"""

_LINEAGE_COLUMNS = ("parent_run_id", "base_ref", "start_sha", "result_sha", "launch_request_id")
_ACTIVE_RUN_STATUSES = (
    RunStatus.PENDING, RunStatus.PLANNING, RunStatus.RUNNING, RunStatus.PAUSED,
    RunStatus.WAITING_HUMAN, RunStatus.READY_FOR_FINAL_GATE,
)
_TERMINAL_RUN_STATUSES = (RunStatus.COMPLETED, RunStatus.FAILED, RunStatus.SUPERSEDED)
_BUSY_TASK_STATUSES = (TaskStatus.RUNNING, TaskStatus.GATE_CHECKING, TaskStatus.REVIEWING, TaskStatus.COOLDOWN)


class RunTerminalError(ValueError):
    """A terminal run cannot be resumed or finalized."""

    def __init__(self, run_id: str, status: str) -> None:
        self.run_id, self.status = run_id, status
        super().__init__(f"Run {run_id} is {status} and cannot be resumed or finalized")


class ActiveRunError(ValueError):
    """A conflicting run, executor, or pending stop prevents this operation."""


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
            # Switching a legacy database to WAL can return SQLITE_BUSY without
            # honoring busy_timeout when another opener is switching it too.
            deadline = time.monotonic() + 10.0
            while True:
                try:
                    conn.executescript(_SCHEMA_SQL)
                    break
                except sqlite3.OperationalError as exc:
                    code = getattr(exc, "sqlite_errorcode", 0) & 0xFF
                    if code not in (sqlite3.SQLITE_BUSY, sqlite3.SQLITE_LOCKED) or time.monotonic() >= deadline:
                        raise
                    time.sleep(0.05)
            # Serialize the check and ALTERs across store instances. SQLite's
            # executescript commits first, so start a transaction afterwards.
            conn.execute("BEGIN IMMEDIATE")
            columns = {row["name"] for row in conn.execute("PRAGMA table_info(runs)")}
            for column in (*_LINEAGE_COLUMNS, "rfc_snapshot_path"):
                if column not in columns:
                    conn.execute(f"ALTER TABLE runs ADD COLUMN {column} TEXT")
            conn.execute(
                "CREATE UNIQUE INDEX IF NOT EXISTS idx_runs_launch_request_id "
                "ON runs(launch_request_id) WHERE launch_request_id IS NOT NULL"
            )

    # ------------------------------------------------------------------
    # Runs
    # ------------------------------------------------------------------

    @staticmethod
    def _conflicting_run(conn: sqlite3.Connection, run: sqlite3.Row) -> str | None:
        """Find other reservations or executors in the same repository."""
        placeholders = ", ".join("?" for _ in _ACTIVE_RUN_STATUSES)
        status_test = f"status IN ({placeholders})"
        if not run["start_sha"]:
            # Legacy callers retain their historical queued-run behavior, but
            # must not overlap a lineage run or a live executor.
            status_test = f"(start_sha IS NOT NULL AND {status_test})"
        row = conn.execute(
            f"SELECT id FROM runs WHERE repo_path = ? AND id != ? AND ({status_test} "
            "OR EXISTS (SELECT 1 FROM run_execution_locks WHERE run_id = runs.id) "
            "OR (status != ? AND EXISTS (SELECT 1 FROM run_stop_requests WHERE run_id = runs.id))) LIMIT 1",
            (run["repo_path"], run["id"], *(s.value for s in _ACTIVE_RUN_STATUSES), RunStatus.SUPERSEDED.value),
        ).fetchone()
        return row["id"] if row else None

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
        if rid in ("", ".", "..") or "/" in rid or "\\" in rid:
            raise ValueError("Invalid run ID")
        snapshot = repo_path.resolve() / ".baton" / "runs" / rid / "00_RFC.md"
        made_snapshot = False
        try:
            with self._connect() as conn:
                conn.execute("BEGIN IMMEDIATE")
                placeholders = ", ".join("?" for _ in _ACTIVE_RUN_STATUSES)
                active = conn.execute(
                    f"SELECT id FROM runs WHERE repo_path = ? AND "
                    f"((start_sha IS NOT NULL AND status IN ({placeholders})) "
                    "OR EXISTS (SELECT 1 FROM run_execution_locks WHERE run_id = runs.id) "
                    "OR (status != ? AND EXISTS (SELECT 1 FROM run_stop_requests WHERE run_id = runs.id))) LIMIT 1",
                    (str(repo_path.resolve()), *(s.value for s in _ACTIVE_RUN_STATUSES), RunStatus.SUPERSEDED.value),
                ).fetchone()
                if active:
                    raise ActiveRunError(f"Repository already has active run {active['id']}")
                if conn.execute("SELECT 1 FROM runs WHERE id = ?", (rid,)).fetchone():
                    raise ValueError(f"Run {rid} already exists")
                snapshot_path = None
                # Keep the historical missing-RFC behavior: execute_run reports
                # the missing input. Existing files are frozen at creation.
                if rfc_path.is_file():
                    content = rfc_path.read_bytes()
                    snapshot.parent.mkdir(parents=True, exist_ok=True)
                    with snapshot.open("xb") as handle:
                        made_snapshot = True
                        handle.write(content)
                    snapshot_path = str(snapshot)
                conn.execute(
                    """
                    INSERT INTO runs (
                        id, repo_path, rfc_path, plan_path, mode, status,
                        model_overrides_json, created_at, updated_at, rfc_snapshot_path
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        rid, str(repo_path.resolve()), str(rfc_path.resolve()),
                        str(plan_path.resolve()) if plan_path else None, mode, RunStatus.PENDING.value,
                        json.dumps(model_overrides or {}, ensure_ascii=False), now, now, snapshot_path,
                    ),
                )
        except BaseException:
            if made_snapshot:
                snapshot.unlink(missing_ok=True)
                try:
                    snapshot.parent.rmdir()
                except OSError:
                    pass
            raise
        self.log_event(rid, "run_created", message=f"Run created in {mode} mode")
        return rid

    def create_lineage_run(
        self, repo_path: Path, run_id: str, *, parent_run_id: str | None,
        mode: str, plan_path: Path | None, model_overrides: dict[str, str] | None,
        prepare: Callable[[dict[str, Any] | None], tuple[Path, str]],
    ) -> str:
        """Reserve one repository run and supersede its settled parent atomically.

        ``prepare`` writes the immutable snapshot and branch under the same
        reservation; the caller cleans up its own artifacts if this fails.
        """
        repo = str(repo_path.resolve())
        with self._connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            placeholders = ", ".join("?" for _ in _ACTIVE_RUN_STATUSES)
            active = conn.execute(
                f"SELECT id FROM runs WHERE repo_path = ? AND (status IN ({placeholders}) "
                "OR EXISTS (SELECT 1 FROM run_execution_locks WHERE run_id = runs.id) "
                "OR (status != ? AND EXISTS (SELECT 1 FROM run_stop_requests WHERE run_id = runs.id)))",
                (repo, *(s.value for s in _ACTIVE_RUN_STATUSES), RunStatus.SUPERSEDED.value),
            ).fetchall()
            conflicting = [row["id"] for row in active if row["id"] != parent_run_id]
            if conflicting:
                raise ActiveRunError(f"Repository already has active run {conflicting[0]}")
            if conn.execute("SELECT 1 FROM runs WHERE id = ?", (run_id,)).fetchone():
                raise ValueError(f"Run {run_id} already exists")
            # Existing task/milestone branches use the last six ID characters.
            # Reusing a suffix could silently attach a run to an old branch.
            if conn.execute("SELECT 1 FROM runs WHERE repo_path = ? AND substr(id, -6) = ? LIMIT 1",
                            (repo, run_id[-6:])).fetchone():
                raise ValueError(f"Run ID {run_id} shares an existing branch suffix")
            parent = None
            if parent_run_id is not None:
                row = conn.execute("SELECT * FROM runs WHERE id = ?", (parent_run_id,)).fetchone()
                if not row or row["repo_path"] != repo:
                    raise ValueError(f"Parent run {parent_run_id} not found in this repository")
                parent = dict(row)
                stop = conn.execute("SELECT 1 FROM run_stop_requests WHERE run_id = ?", (parent_run_id,)).fetchone()
                if parent["status"] in (RunStatus.COMPLETED, RunStatus.FAILED):
                    raise RunTerminalError(parent_run_id, parent["status"])
                if parent["status"] == RunStatus.SUPERSEDED and not stop:
                    raise RunTerminalError(parent_run_id, parent["status"])
                if stop and parent["status"] != RunStatus.SUPERSEDED:
                    raise ActiveRunError(f"Run {parent_run_id} is still stopping for replan")
                if conn.execute("SELECT 1 FROM runs WHERE parent_run_id = ?", (parent_run_id,)).fetchone():
                    raise ActiveRunError(f"Run {parent_run_id} already has a revision")
                if parent["status"] in (RunStatus.RUNNING, RunStatus.PLANNING):
                    raise ActiveRunError(f"Run {parent_run_id} must be stopped before revision")
                busy = ", ".join("?" for _ in _BUSY_TASK_STATUSES)
                if (conn.execute("SELECT 1 FROM run_execution_locks WHERE run_id = ?", (parent_run_id,)).fetchone()
                    or conn.execute(f"SELECT 1 FROM tasks WHERE run_id = ? AND status IN ({busy}) LIMIT 1",
                                    (parent_run_id, *(s.value for s in _BUSY_TASK_STATUSES))).fetchone()):
                    raise ActiveRunError(f"Run {parent_run_id} still has work in flight")
                if not parent["result_sha"]:
                    raise ValueError(f"Parent run {parent_run_id} has no result SHA")
            snapshot, start_sha = prepare(parent)
            now = time.time()
            if parent and parent["status"] != RunStatus.SUPERSEDED:
                conn.execute("UPDATE runs SET status = ?, updated_at = ?, finished_at = ? WHERE id = ?",
                             (RunStatus.SUPERSEDED.value, now, now, parent_run_id))
            conn.execute(
                "INSERT INTO runs (id, repo_path, rfc_path, plan_path, mode, status, model_overrides_json, "
                "created_at, updated_at, parent_run_id, base_ref, start_sha, rfc_snapshot_path) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (run_id, repo, str(snapshot), str(plan_path.resolve()) if plan_path else None, mode,
                 RunStatus.PENDING.value, json.dumps(model_overrides or {}, ensure_ascii=False), now, now,
                 parent_run_id, "main", start_sha, str(snapshot)),
            )
            conn.execute("INSERT INTO events (run_id, kind, message, created_at) VALUES (?, ?, ?, ?)",
                         (run_id, "run_created", f"Run created in {mode} mode", now))
        return run_id

    def claim_run_execution(self, run_id: str) -> str:
        """Claim an executor across processes; never steal an unconfirmed lock."""
        token = uuid.uuid4().hex
        with self._connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            row = conn.execute("SELECT * FROM runs WHERE id = ?", (run_id,)).fetchone()
            if not row:
                raise ValueError(f"Run '{run_id}' not found")
            if row["status"] in _TERMINAL_RUN_STATUSES:
                raise RunTerminalError(run_id, row["status"])
            if conn.execute("SELECT 1 FROM run_stop_requests WHERE run_id = ?", (run_id,)).fetchone():
                raise ActiveRunError(f"Run {run_id} is stopping for replan")
            if conn.execute("SELECT 1 FROM run_execution_locks WHERE run_id = ?", (run_id,)).fetchone():
                raise ActiveRunError(f"Run {run_id} already has an executor")
            conflict = self._conflicting_run(conn, row)
            if conflict:
                raise ActiveRunError(f"Repository already has active run {conflict}")
            conn.execute("INSERT INTO run_execution_locks (run_id, token) VALUES (?, ?)", (run_id, token))
        return token

    def release_run_execution(self, run_id: str, token: str) -> None:
        with self._connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            owner = conn.execute("SELECT token FROM run_execution_locks WHERE run_id = ?", (run_id,)).fetchone()
            run = conn.execute("SELECT status, summary FROM runs WHERE id = ?", (run_id,)).fetchone()
            if owner and owner["token"] == token and run and run["status"] == RunStatus.FAILED:
                busy = ", ".join("?" for _ in _BUSY_TASK_STATUSES)
                conn.execute(
                    f"UPDATE tasks SET status = ?, last_error = COALESCE(NULLIF(last_error, ''), ?), updated_at = ? "
                    f"WHERE run_id = ? AND status IN ({busy})",
                    (TaskStatus.FAILED.value, run["summary"] or "Run failed", time.time(), run_id,
                     *(s.value for s in _BUSY_TASK_STATUSES)),
                )
            conn.execute("DELETE FROM run_execution_locks WHERE run_id = ? AND token = ?", (run_id, token))

    def try_dispatch_task(self, run_id: str, task_id: str) -> bool:
        """Order task dispatch against a cross-process stop request."""
        with self._connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            row = conn.execute("SELECT status FROM runs WHERE id = ?", (run_id,)).fetchone()
            if (not row or row["status"] == RunStatus.PAUSED or row["status"] in _TERMINAL_RUN_STATUSES
                or conn.execute("SELECT 1 FROM run_stop_requests WHERE run_id = ?", (run_id,)).fetchone()):
                return False
            updated = conn.execute("UPDATE tasks SET status = ?, updated_at = ? WHERE run_id = ? AND id = ?",
                                   (TaskStatus.RUNNING.value, time.time(), run_id, task_id))
            return updated.rowcount == 1

    def is_stop_requested(self, run_id: str) -> bool:
        with self._connect() as conn:
            return bool(conn.execute("SELECT 1 FROM run_stop_requests WHERE run_id = ?", (run_id,)).fetchone())

    def request_run_stop(self, run_id: str) -> None:
        with self._connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            row = conn.execute("SELECT status FROM runs WHERE id = ?", (run_id,)).fetchone()
            if not row:
                raise ValueError(f"Run '{run_id}' not found")
            existing = conn.execute("SELECT 1 FROM run_stop_requests WHERE run_id = ?", (run_id,)).fetchone()
            if row["status"] == RunStatus.COMPLETED or (row["status"] == RunStatus.SUPERSEDED and not existing):
                raise RunTerminalError(run_id, row["status"])
            if existing:
                return
            has_executor = bool(conn.execute("SELECT 1 FROM run_execution_locks WHERE run_id = ?", (run_id,)).fetchone())
            # A pre-upgrade or orphaned RUNNING/PLANNING daemon has no lease;
            # its absence is not evidence that external writes have stopped.
            executor_state = 1 if has_executor else (-1 if row["status"] in (RunStatus.RUNNING, RunStatus.PLANNING) else 0)
            conn.execute("INSERT INTO run_stop_requests (run_id, had_executor) VALUES (?, ?)", (run_id, executor_state))
            if row["status"] != RunStatus.FAILED:
                conn.execute("UPDATE runs SET status = ?, updated_at = ? WHERE id = ?",
                             (RunStatus.PAUSED.value, time.time(), run_id))

    def run_stop_settled(self, run_id: str) -> bool:
        with self._connect() as conn:
            stop = conn.execute("SELECT had_executor FROM run_stop_requests WHERE run_id = ?", (run_id,)).fetchone()
            if (not stop or stop["had_executor"] < 0
                or conn.execute("SELECT 1 FROM run_execution_locks WHERE run_id = ?", (run_id,)).fetchone()):
                return False
            busy = ", ".join("?" for _ in _BUSY_TASK_STATUSES)
            task = conn.execute(f"SELECT 1 FROM tasks WHERE run_id = ? AND status IN ({busy}) LIMIT 1",
                                (run_id, *(s.value for s in _BUSY_TASK_STATUSES))).fetchone()
            return not task or bool(stop["had_executor"])

    def complete_run_stop(self, run_id: str, sha: str) -> None:
        with self._connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            row = conn.execute("SELECT status, summary FROM runs WHERE id = ?", (run_id,)).fetchone()
            stop = conn.execute("SELECT had_executor FROM run_stop_requests WHERE run_id = ?", (run_id,)).fetchone()
            if not row or not stop:
                raise ValueError(f"Run {run_id} has no stop request")
            if row["status"] == RunStatus.SUPERSEDED:
                return
            if stop["had_executor"] < 0:
                raise ActiveRunError(f"Run {run_id} has an unverified executor")
            if conn.execute("SELECT 1 FROM run_execution_locks WHERE run_id = ?", (run_id,)).fetchone():
                raise ActiveRunError(f"Run {run_id} still has an executor")
            busy = ", ".join("?" for _ in _BUSY_TASK_STATUSES)
            if not stop["had_executor"] and conn.execute(
                f"SELECT 1 FROM tasks WHERE run_id = ? AND status IN ({busy}) LIMIT 1",
                (run_id, *(s.value for s in _BUSY_TASK_STATUSES)),
            ).fetchone():
                raise ActiveRunError(f"Run {run_id} has unverified in-flight tasks")
            now = time.time()
            conn.execute(f"UPDATE tasks SET status = ?, last_error = COALESCE(NULLIF(last_error, ''), ?), updated_at = ? "
                         f"WHERE run_id = ? AND status IN ({busy})",
                         (TaskStatus.FAILED.value, "Stopped for replan", now, run_id,
                          *(s.value for s in _BUSY_TASK_STATUSES)))
            conn.execute("UPDATE milestones SET status = ?, updated_at = ? WHERE run_id = ? AND status = ?",
                         (TaskStatus.FAILED.value, now, run_id, TaskStatus.RUNNING.value))
            conn.execute("UPDATE runs SET status = ?, result_sha = ?, summary = ?, updated_at = ?, finished_at = ? WHERE id = ?",
                         (RunStatus.SUPERSEDED.value, sha, row["summary"] or "Stopped for replan", now, now, run_id))
            conn.execute("INSERT INTO events (run_id, kind, message, created_at) VALUES (?, ?, ?, ?)",
                         (run_id, "run_stopped_for_replan", "Stopped for replan", now))

    def mark_run_ready(self, run_id: str, sha: str | None, summary: str) -> bool:
        with self._connect() as conn:
            updated = conn.execute(
                "UPDATE runs SET status = ?, result_sha = ?, summary = ?, updated_at = ? "
                "WHERE id = ? AND status NOT IN (?, ?, ?, ?) "
                "AND NOT EXISTS (SELECT 1 FROM run_stop_requests WHERE run_id = ?)",
                (RunStatus.READY_FOR_FINAL_GATE.value, sha, summary, time.time(), run_id,
                 RunStatus.PAUSED.value, *(s.value for s in _TERMINAL_RUN_STATUSES), run_id),
            )
            return updated.rowcount == 1

    def get_run(self, run_id: str) -> dict[str, Any] | None:
        with self._connect() as conn:
            row = conn.execute("SELECT * FROM runs WHERE id = ?", (run_id,)).fetchone()
            return dict(row) if row else None

    def set_run_lineage(
        self, run_id: str, *, parent_run_id: str | None, base_ref: str | None, start_sha: str | None,
    ) -> None:
        """Record the parent and starting base for an existing run."""
        with self._connect() as conn:
            conn.execute(
                "UPDATE runs SET parent_run_id = ?, base_ref = ?, start_sha = ?, updated_at = ? WHERE id = ?",
                (parent_run_id, base_ref, start_sha, time.time(), run_id),
            )

    def set_run_result_sha(self, run_id: str, sha: str) -> None:
        """Record the result commit for an existing run."""
        with self._connect() as conn:
            conn.execute("UPDATE runs SET result_sha = ?, updated_at = ? WHERE id = ?", (sha, time.time(), run_id))

    def mark_run_superseded(self, run_id: str) -> None:
        """Supersede an active run; repeated calls on a superseded run are a no-op."""
        self.update_run_status(run_id, RunStatus.SUPERSEDED)

    def get_run_by_launch_request_id(self, request_id: str) -> dict[str, Any] | None:
        """Look up the run claimed by a non-null launch request ID."""
        with self._connect() as conn:
            row = conn.execute("SELECT * FROM runs WHERE launch_request_id = ?", (request_id,)).fetchone()
            return dict(row) if row else None

    def get_active_run(self) -> dict[str, Any] | None:
        """Return the newest nonterminal run in this store, including one awaiting sign-off."""
        placeholders = ", ".join("?" for _ in _ACTIVE_RUN_STATUSES)
        with self._connect() as conn:
            row = conn.execute(
                f"SELECT * FROM runs WHERE status IN ({placeholders}) ORDER BY created_at DESC, rowid DESC LIMIT 1",
                tuple(status.value for status in _ACTIVE_RUN_STATUSES),
            ).fetchone()
            return dict(row) if row else None

    def get_run_lineage_chain(self, run_id: str) -> list[dict[str, Any]]:
        """Return root-to-run rows; report broken parent links or cycles rather than truncating."""
        chain: list[dict[str, Any]] = []
        visited: set[str] = set()
        current = run_id
        with self._connect() as conn:
            conn.execute("BEGIN")  # Keep the chain in one consistent read snapshot.
            while current is not None:
                if current in visited:
                    raise ValueError(f"Run lineage cycle at {current}")
                visited.add(current)
                row = conn.execute("SELECT * FROM runs WHERE id = ?", (current,)).fetchone()
                if row is None:
                    if not chain:
                        return []
                    raise ValueError(f"Run lineage has missing parent {current}")
                item = dict(row)
                chain.append(item)
                current = item["parent_run_id"]
        chain.reverse()
        return chain

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
        finished_at = now if status in (RunStatus.COMPLETED, RunStatus.FAILED, RunStatus.SUPERSEDED) else None
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
            if status == RunStatus.RUNNING:
                conn.execute("BEGIN IMMEDIATE")
                current = conn.execute("SELECT * FROM runs WHERE id = ?", (run_id,)).fetchone()
                if current and current["status"] not in _TERMINAL_RUN_STATUSES:
                    conflict = self._conflicting_run(conn, current)
                    if conflict:
                        raise ActiveRunError(f"Repository already has active run {conflict}")
            if status == RunStatus.SUPERSEDED:
                placeholders = ", ".join("?" for _ in _ACTIVE_RUN_STATUSES)
                where = (f"status IN ({placeholders}) AND NOT EXISTS "
                         "(SELECT 1 FROM run_stop_requests WHERE run_id = runs.id) AND NOT EXISTS "
                         "(SELECT 1 FROM run_execution_locks WHERE run_id = runs.id)")
                values.extend(item.value for item in _ACTIVE_RUN_STATUSES)
            else:
                where = "status != ?"
                values.append(RunStatus.SUPERSEDED.value)
                if status == RunStatus.RUNNING:
                    where += " AND status NOT IN (?, ?)"
                    values.extend((RunStatus.COMPLETED.value, RunStatus.FAILED.value))
                if status != RunStatus.PAUSED:
                    where += " AND NOT EXISTS (SELECT 1 FROM run_stop_requests WHERE run_id = runs.id)"
            updated = conn.execute(f"UPDATE runs SET {', '.join(fields)} WHERE id = ? AND {where}", values)
            if updated.rowcount == 0:
                row = conn.execute("SELECT status FROM runs WHERE id = ?", (run_id,)).fetchone()
                if row and row["status"] == RunStatus.SUPERSEDED.value:
                    if status == RunStatus.SUPERSEDED:
                        return
                    raise RunTerminalError(run_id, row["status"])
                if row and status == RunStatus.RUNNING and row["status"] in _TERMINAL_RUN_STATUSES:
                    raise RunTerminalError(run_id, row["status"])
                # An executor already in flight may finish writes while stopping;
                # its late status updates must not undo the stop request.
                if row and conn.execute("SELECT 1 FROM run_stop_requests WHERE run_id = ?", (run_id,)).fetchone():
                    if status in (RunStatus.RUNNING, RunStatus.SUPERSEDED):
                        raise ActiveRunError(f"Run {run_id} is stopping for replan")
                    return
                if (row and status == RunStatus.SUPERSEDED
                    and conn.execute("SELECT 1 FROM run_execution_locks WHERE run_id = ?", (run_id,)).fetchone()):
                    raise ActiveRunError(f"Run {run_id} still has an executor")
                if row and status == RunStatus.SUPERSEDED:
                    raise ValueError(f"Run {run_id} cannot be superseded from {row['status']}")

    def resume_run(self, run_id: str) -> None:
        """Atomically reject terminal, stopping, or still-executing runs."""
        with self._connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            row = conn.execute("SELECT * FROM runs WHERE id = ?", (run_id,)).fetchone()
            if not row:
                raise ValueError(f"Run '{run_id}' not found")
            if row["status"] in _TERMINAL_RUN_STATUSES:
                raise RunTerminalError(run_id, row["status"])
            if (conn.execute("SELECT 1 FROM run_stop_requests WHERE run_id = ?", (run_id,)).fetchone()
                or conn.execute("SELECT 1 FROM run_execution_locks WHERE run_id = ?", (run_id,)).fetchone()):
                raise ActiveRunError(f"Run {run_id} is stopping or still has an executor")
            conflict = self._conflicting_run(conn, row)
            if conflict:
                raise ActiveRunError(f"Repository already has active run {conflict}")
            conn.execute("UPDATE runs SET status = ?, updated_at = ? WHERE id = ?",
                         (RunStatus.RUNNING.value, time.time(), run_id))

    def record_human_decision(
        self, run_id: str, decision: str, note: str = "", task_id: str | None = None
    ) -> None:
        now = time.time()
        payload = json.dumps({"decision": decision, "note": note, "at": now, "task_id": task_id}, ensure_ascii=False)
        next_status = RunStatus.RUNNING if decision == "approve" else RunStatus.PAUSED
        with self._connect() as conn:
            if next_status == RunStatus.RUNNING:
                conn.execute("BEGIN IMMEDIATE")
                current = conn.execute("SELECT * FROM runs WHERE id = ?", (run_id,)).fetchone()
                if current and current["status"] not in _TERMINAL_RUN_STATUSES:
                    conflict = self._conflicting_run(conn, current)
                    if conflict:
                        raise ActiveRunError(f"Repository already has active run {conflict}")
            updated = conn.execute(
                "UPDATE runs SET human_decision = ?, status = ?, updated_at = ? WHERE id = ? "
                "AND status NOT IN (?, ?, ?) "
                "AND NOT EXISTS (SELECT 1 FROM run_stop_requests WHERE run_id = runs.id)",
                (payload, next_status.value, now, run_id, *(s.value for s in _TERMINAL_RUN_STATUSES)),
            )
            if updated.rowcount == 0:
                row = conn.execute("SELECT status FROM runs WHERE id = ?", (run_id,)).fetchone()
                if row and row["status"] in _TERMINAL_RUN_STATUSES:
                    raise RunTerminalError(run_id, row["status"])
                if row and conn.execute("SELECT 1 FROM run_stop_requests WHERE run_id = ?", (run_id,)).fetchone():
                    raise ActiveRunError(f"Run {run_id} is stopping for replan")
        self.log_event(
            run_id,
            "human_decision",
            actor="human",
            message=f"Human resolved with '{decision}': {note}",
            payload={"decision": decision, "note": note},
            task_id=task_id,
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
