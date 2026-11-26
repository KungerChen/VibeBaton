"""Migration tests for legacy run lineage databases; standard library only."""

from __future__ import annotations

import sqlite3
import tempfile
import unittest
from contextlib import closing
from pathlib import Path

from vibebaton.db import StateStore
from vibebaton.schemas import RunStatus


LINEAGE_COLUMNS = ("parent_run_id", "base_ref", "start_sha", "result_sha", "launch_request_id")


def create_legacy_database(db_path: Path, *, partial: bool = False) -> None:
    """Build the old runs table directly, optionally with two migrated columns."""
    with closing(sqlite3.connect(db_path)) as conn, conn:
        conn.execute("""
            CREATE TABLE runs (
                id TEXT PRIMARY KEY, repo_path TEXT NOT NULL, rfc_path TEXT NOT NULL,
                plan_path TEXT, mode TEXT NOT NULL DEFAULT 'overnight', status TEXT NOT NULL,
                model_overrides_json TEXT NOT NULL DEFAULT '{}', summary TEXT NOT NULL DEFAULT '',
                human_prompt TEXT, human_decision TEXT, created_at REAL NOT NULL,
                updated_at REAL NOT NULL, finished_at REAL
            )
        """)
        conn.executemany(
            "INSERT INTO runs (id, repo_path, rfc_path, status, summary, created_at, updated_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
            [
                ("legacy", "old-repo", "old-rfc", RunStatus.FAILED.value, "keep this", 1.25, 2.5),
                ("active", "old-repo", "old-rfc", RunStatus.RUNNING.value, "keep active", 3.5, 4.75),
                ("done", "old-repo", "old-rfc", RunStatus.COMPLETED.value, "keep done", 5.0, 6.25),
            ],
        )
        if partial:
            conn.execute("ALTER TABLE runs ADD COLUMN base_ref TEXT")
            conn.execute("ALTER TABLE runs ADD COLUMN start_sha TEXT")
            conn.execute("UPDATE runs SET base_ref = 'main', start_sha = 'existing' WHERE id = 'legacy'")


def read_columns(db_path: Path) -> list[str]:
    """Return the physical column names of the runs table."""
    with closing(sqlite3.connect(db_path)) as conn:
        return [row[1] for row in conn.execute("PRAGMA table_info(runs)")]


def read_rows(db_path: Path) -> dict[str, dict]:
    """Return every run row keyed by ID exactly as stored on disk."""
    with closing(sqlite3.connect(db_path)) as conn:
        conn.row_factory = sqlite3.Row
        return {row["id"]: dict(row) for row in conn.execute("SELECT * FROM runs")}


class LineageTestCase(unittest.TestCase):
    def setUp(self) -> None:
        self._tempdir = tempfile.TemporaryDirectory(prefix="baton-migration-")
        self.addCleanup(self._tempdir.cleanup)
        self.root = Path(self._tempdir.name)

    def open_db(self, name: str = "state.sqlite") -> StateStore:
        return StateStore(self.root / name)


class TestFreshDatabase(LineageTestCase):
    def test_new_database_gets_each_lineage_column_once(self) -> None:
        self.open_db("fresh.sqlite")
        columns = read_columns(self.root / "fresh.sqlite")
        for column in LINEAGE_COLUMNS:
            with self.subTest(column=column):
                self.assertEqual(columns.count(column), 1)

    def test_new_run_starts_with_null_lineage(self) -> None:
        store = self.open_db()
        store.create_run(self.root / "repo", self.root / "rfc.md", run_id="fresh")
        row = store.get_run("fresh")
        self.assertEqual(row["status"], RunStatus.PENDING.value)
        self.assertTrue(all(row[column] is None for column in LINEAGE_COLUMNS))


class TestLegacyMigration(LineageTestCase):
    def test_legacy_rows_and_statuses_survive_with_null_lineage(self) -> None:
        db_path = self.root / "legacy.sqlite"
        create_legacy_database(db_path)
        original = read_rows(db_path)
        self.assertFalse(set(LINEAGE_COLUMNS) & set(read_columns(db_path)))

        store = self.open_db("legacy.sqlite")
        self.assertEqual(set(read_columns(db_path)) & set(LINEAGE_COLUMNS), set(LINEAGE_COLUMNS))
        for run_id, expected in original.items():
            with self.subTest(run_id=run_id):
                row = store.get_run(run_id)
                self.assertIsNotNone(row)
                self.assertEqual({key: row[key] for key in expected}, expected)
                self.assertTrue(all(row[column] is None for column in LINEAGE_COLUMNS))

    def test_partially_migrated_rows_keep_existing_values(self) -> None:
        db_path = self.root / "partial.sqlite"
        create_legacy_database(db_path, partial=True)
        self.assertEqual(set(read_columns(db_path)) & set(LINEAGE_COLUMNS), {"base_ref", "start_sha"})
        store = self.open_db("partial.sqlite")
        columns = read_columns(db_path)
        self.assertTrue(all(columns.count(column) == 1 for column in LINEAGE_COLUMNS))
        row = store.get_run("legacy")
        self.assertEqual((row["base_ref"], row["start_sha"]), ("main", "existing"))
        self.assertTrue(all(row[column] is None for column in ("parent_run_id", "result_sha", "launch_request_id")))
        untouched = store.get_run("done")
        self.assertTrue(all(untouched[column] is None for column in LINEAGE_COLUMNS))

    def test_repeated_opens_are_idempotent(self) -> None:
        db_path = self.root / "legacy.sqlite"
        create_legacy_database(db_path)
        first = self.open_db("legacy.sqlite")
        before = read_rows(db_path)
        with closing(sqlite3.connect(db_path)) as conn:
            version = conn.execute("PRAGMA schema_version").fetchone()[0]

        for _ in range(2):
            again = self.open_db("legacy.sqlite")
            with closing(sqlite3.connect(db_path)) as conn:
                self.assertEqual(conn.execute("PRAGMA schema_version").fetchone()[0], version)
                columns = [row[1] for row in conn.execute("PRAGMA table_info(runs)")]
            self.assertTrue(all(columns.count(column) == 1 for column in LINEAGE_COLUMNS))
            self.assertEqual(read_rows(db_path), before)
            for run_id in before:
                self.assertEqual(again.get_run(run_id), first.get_run(run_id))


if __name__ == "__main__":
    unittest.main()
