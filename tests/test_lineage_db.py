"""Golden examples for the additive run lineage contract; no network required."""

from __future__ import annotations

import inspect
import sqlite3
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from pathlib import Path

from tests.lineage_fixtures import LineageFixture
from vibebaton import git_ops
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
        conn.execute(
            "INSERT INTO runs (id, repo_path, rfc_path, status, summary, created_at, updated_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
            ("legacy", "old-repo", "old-rfc", "FAILED", "keep this", 1.25, 2.5),
        )
        if partial:
            conn.execute("ALTER TABLE runs ADD COLUMN base_ref TEXT")
            conn.execute("ALTER TABLE runs ADD COLUMN start_sha TEXT")
            conn.execute("UPDATE runs SET base_ref = 'main', start_sha = 'existing' WHERE id = 'legacy'")


class LineageTestCase(unittest.TestCase):
    def setUp(self) -> None:
        self.fixture = LineageFixture()
        self.addCleanup(self.fixture.cleanup)

    def create_run(self, run_id: str) -> str:
        return self.store.create_run(self.fixture.repo, self.fixture.repo / "README.md", run_id=run_id)


class TestLegacyMigration(LineageTestCase):
    def test_existing_rows_survive_two_opens_with_null_lineage(self) -> None:
        db_path = self.fixture.root / "legacy.sqlite"
        create_legacy_database(db_path)
        with closing(sqlite3.connect(db_path)) as conn:
            conn.row_factory = sqlite3.Row
            original = dict(conn.execute("SELECT * FROM runs WHERE id = 'legacy'").fetchone())

        store = self.fixture.open_db("legacy.sqlite")
        before = store.get_run("legacy")
        self.assertIsNotNone(before)
        self.assertEqual((before["repo_path"], before["status"], before["summary"]),
                         ("old-repo", "FAILED", "keep this"))
        self.assertEqual((before["created_at"], before["updated_at"]), (1.25, 2.5))
        self.assertEqual({key: before[key] for key in original}, original)
        self.assertTrue(all(before[column] is None for column in LINEAGE_COLUMNS))
        with closing(sqlite3.connect(db_path)) as conn:
            version = conn.execute("PRAGMA schema_version").fetchone()[0]
        again = self.fixture.open_db("legacy.sqlite")
        self.assertEqual(again.get_run("legacy"), before)
        with closing(sqlite3.connect(db_path)) as conn:
            self.assertEqual(conn.execute("PRAGMA schema_version").fetchone()[0], version)
            columns = [row[1] for row in conn.execute("PRAGMA table_info(runs)")]
        self.assertTrue(all(columns.count(column) == 1 for column in LINEAGE_COLUMNS))

    def test_partially_migrated_rows_keep_existing_values(self) -> None:
        create_legacy_database(self.fixture.root / "partial.sqlite", partial=True)
        reopened = self.fixture.open_db("partial.sqlite")
        row = reopened.get_run("legacy")
        self.assertEqual((row["base_ref"], row["start_sha"]), ("main", "existing"))
        self.assertTrue(all(row[column] is None for column in ("parent_run_id", "result_sha", "launch_request_id")))

    def test_simultaneous_opens_serialize_the_additive_migration(self) -> None:
        create_legacy_database(self.fixture.root / "concurrent.sqlite")
        barrier = threading.Barrier(4)

        def open_store() -> dict:
            barrier.wait(timeout=10)
            return self.fixture.open_db("concurrent.sqlite").get_run("legacy")

        with ThreadPoolExecutor(max_workers=4) as executor:
            rows = list(executor.map(lambda _: open_store(), range(4)))
        self.assertTrue(all(row == rows[0] for row in rows))
        self.assertTrue(all(rows[0][column] is None for column in LINEAGE_COLUMNS))


class TestRunLineageFields(LineageTestCase):
    def setUp(self) -> None:
        super().setUp()
        self.store = self.fixture.open_db()

    def test_set_lineage_and_result_sha(self) -> None:
        self.create_run("root")
        self.create_run("child")
        start_sha = self.fixture.initial_sha
        result_sha = self.fixture.add_commit("feature.txt", "B\n", "Produce B")
        self.store.set_run_lineage("child", parent_run_id="root", base_ref="main", start_sha=start_sha)
        self.store.set_run_result_sha("child", result_sha)
        child = self.store.get_run("child")
        self.assertEqual((child["parent_run_id"], child["base_ref"], child["start_sha"], child["result_sha"]),
                         ("root", "main", start_sha, result_sha))
        self.assertIsNone(self.store.get_run("root")["parent_run_id"])


class TestLaunchRequestIdentity(LineageTestCase):
    def setUp(self) -> None:
        super().setUp()
        self.store = self.fixture.open_db()

    def test_non_null_request_ids_are_unique_and_retrievable(self) -> None:
        self.create_run("first")
        self.create_run("second")
        self.assertIsNone(self.store.get_run_by_launch_request_id("missing"))
        with self.store._connect() as conn:
            conn.execute("UPDATE runs SET launch_request_id = ? WHERE id = ?", ("request-1", "first"))
        self.assertEqual(self.store.get_run_by_launch_request_id("request-1")["id"], "first")
        with self.assertRaises(sqlite3.IntegrityError):
            with self.store._connect() as conn:
                conn.execute("UPDATE runs SET launch_request_id = ? WHERE id = ?", ("request-1", "second"))
        self.assertIsNone(self.store.get_run("second")["launch_request_id"])


class TestSupersededStatus(LineageTestCase):
    def setUp(self) -> None:
        super().setUp()
        self.store = self.fixture.open_db()

    def test_active_states_can_be_superseded_and_terminal_time_is_stable(self) -> None:
        active = (RunStatus.PENDING, RunStatus.PLANNING, RunStatus.RUNNING, RunStatus.PAUSED,
                  RunStatus.WAITING_HUMAN, RunStatus.READY_FOR_FINAL_GATE)
        for status in active:
            with self.subTest(status=status):
                run_id = self.create_run(status.value)
                self.store.update_run_status(run_id, status)
                self.store.mark_run_superseded(run_id)
                row = self.store.get_run(run_id)
                self.assertEqual(row["status"], RunStatus.SUPERSEDED.value)
                self.assertIsNotNone(row["finished_at"])
                self.store.mark_run_superseded(run_id)
                self.assertEqual(self.store.get_run(run_id)["finished_at"], row["finished_at"])

    def test_superseded_cannot_be_resumed_or_changed_by_a_human_decision(self) -> None:
        self.create_run("obsolete")
        self.store.update_run_status("obsolete", RunStatus.SUPERSEDED)
        before = self.store.get_run("obsolete")
        for status in (RunStatus.RUNNING, RunStatus.PAUSED, RunStatus.COMPLETED):
            with self.subTest(status=status), self.assertRaises(ValueError):
                self.store.update_run_status("obsolete", status)
        with self.assertRaises(ValueError):
            self.store.record_human_decision("obsolete", "approve")
        self.assertEqual(self.store.get_run("obsolete"), before)

    def test_completed_and_failed_runs_are_not_superseded(self) -> None:
        for status in (RunStatus.COMPLETED, RunStatus.FAILED):
            with self.subTest(status=status):
                self.create_run(status.value)
                self.store.update_run_status(status.value, status)
                before = self.store.get_run(status.value)
                with self.assertRaises(ValueError):
                    self.store.mark_run_superseded(status.value)
                self.assertEqual(self.store.get_run(status.value), before)


class TestActiveRun(LineageTestCase):
    def setUp(self) -> None:
        super().setUp()
        self.store = self.fixture.open_db()

    def test_latest_active_run_includes_awaiting_sign_off_and_excludes_terminal(self) -> None:
        self.assertIsNone(self.store.get_active_run())
        self.create_run("active")
        for status in (RunStatus.PENDING, RunStatus.PLANNING, RunStatus.RUNNING, RunStatus.PAUSED,
                       RunStatus.WAITING_HUMAN, RunStatus.READY_FOR_FINAL_GATE):
            with self.subTest(status=status):
                self.store.update_run_status("active", status)
                self.assertEqual(self.store.get_active_run()["id"], "active")
        self.create_run("later")
        self.store.update_run_status("later", RunStatus.COMPLETED)
        self.assertEqual(self.store.get_active_run()["id"], "active")
        self.store.mark_run_superseded("active")
        self.assertIsNone(self.store.get_active_run())


class TestRunLineageChain(LineageTestCase):
    def setUp(self) -> None:
        super().setUp()
        self.store = self.fixture.open_db()

    def test_root_to_current_order_tracks_a_b_c(self) -> None:
        a = self.fixture.initial_sha
        b = self.fixture.add_commit("feature.txt", "B\n", "Produce B")
        c = self.fixture.add_commit("feature.txt", "C\n", "Produce C")
        self.create_run("root")
        self.create_run("revision")
        self.store.set_run_lineage("root", parent_run_id=None, base_ref="main", start_sha=a)
        self.store.set_run_result_sha("root", b)
        self.store.set_run_lineage("revision", parent_run_id="root", base_ref="main", start_sha=b)
        self.store.set_run_result_sha("revision", c)
        chain = self.store.get_run_lineage_chain("revision")
        self.assertEqual([row["id"] for row in chain], ["root", "revision"])
        self.assertEqual((chain[0]["start_sha"], chain[0]["result_sha"], chain[1]["result_sha"]), (a, b, c))
        self.assertEqual(self.store.get_run_lineage_chain("missing"), [])

    def test_cycles_and_dangling_parents_are_reported(self) -> None:
        self.create_run("one")
        self.create_run("two")
        self.store.set_run_lineage("one", parent_run_id="two", base_ref="main", start_sha=None)
        self.store.set_run_lineage("two", parent_run_id="one", base_ref="main", start_sha=None)
        with self.assertRaisesRegex(ValueError, "cycle"):
            self.store.get_run_lineage_chain("one")
        self.store.set_run_lineage("one", parent_run_id="missing", base_ref="main", start_sha=None)
        with self.assertRaisesRegex(ValueError, "missing"):
            self.store.get_run_lineage_chain("one")


class TestGitContract(LineageTestCase):
    def test_fixture_creates_main_and_real_commit_history(self) -> None:
        second = self.fixture.add_commit("feature.txt", "B\n", "Produce B")
        self.assertEqual(self.fixture.git("branch", "--show-current"), "main")
        self.assertEqual(self.fixture.git("rev-parse", "HEAD^"), self.fixture.initial_sha)
        self.assertEqual(self.fixture.git("rev-parse", "HEAD"), second)

    def test_lineage_git_functions_have_documented_signatures(self) -> None:
        functions = {
            "resolve_ref_sha": ("repo", "ref"),
            "create_run_branch_at": ("repo", "branch", "sha"),
            "has_ref_advanced": ("repo", "base_ref", "recorded_sha"),
            "integrate_in_isolated_worktree": ("repo", "base_ref", "result_sha", "worktree_root"),
            "revert_range": ("repo", "branch", "from_sha", "to_sha"),
            "reset_branch_to": ("repo", "branch", "commit"),
            "is_head_commit": ("repo", "branch", "commit"),
        }
        for name, parameters in functions.items():
            with self.subTest(name=name):
                function = getattr(git_ops, name)
                self.assertEqual(tuple(inspect.signature(function).parameters), parameters)
                self.assertTrue(inspect.getdoc(function))


if __name__ == "__main__":
    unittest.main()
