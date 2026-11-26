"""Routine tests for run-scoped RFC snapshots; no network required."""

from __future__ import annotations

import json
import unittest
from pathlib import Path
from unittest.mock import patch

from tests.lineage_fixtures import LineageFixture
from vibebaton.config import HotReloadConfig
from vibebaton.db import StateStore
from vibebaton.engine import OrchestrationEngine
from vibebaton.schemas import RunStatus


PLAN = {
    "rfc_version": "v1",
    "complexity_tier": "S",
    "summary": "RFC snapshot fixture",
    "milestones": [{"id": "M1", "title": "Work", "tasks": [
        {"id": "T1", "title": "First", "allowed_paths": ["work.txt"]},
    ]}],
}


class SnapshotTestCase(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        self.fixture = LineageFixture()
        self.addCleanup(self.fixture.cleanup)
        self.repo = self.fixture.repo
        self.baton = self.repo / ".baton"
        self.baton.mkdir()
        self.rfc = self.baton / "00_RFC.md"
        self.rfc.write_bytes(b"# First RFC\n\nOriginal bytes.\n")
        self.plan = self.fixture.root / "plan.json"
        self.plan.write_text(json.dumps(PLAN), encoding="utf-8")
        config = self.fixture.root / "config.json"
        config.write_text(json.dumps({
            "daemon": {"base_branch": "main", "dev_branch": "dev", "prevent_sleep_windows": False},
            "notifications": {"enabled": False},
            "pricing": {"auto_sync": False},
        }), encoding="utf-8")
        self.store = StateStore(self.baton / "state.sqlite")
        self.engine = OrchestrationEngine(self.repo, HotReloadConfig(config), self.store)
        self.enterContext(patch("vibebaton.engine.pricing.trigger_background_pricing_sync"))

    def create(self, run_id: str) -> str:
        return self.engine.create_run(self.rfc, plan_path=self.plan, run_id=run_id)

    def snapshot(self, run_id: str) -> Path:
        return self.baton / "runs" / run_id / "00_RFC.md"


class TestSnapshotCreation(SnapshotTestCase):
    def test_each_run_creation_writes_its_own_rfc_snapshot(self) -> None:
        run_id = self.create("snapshot-run")
        row = self.store.get_run(run_id)
        path = self.snapshot(run_id)
        self.assertTrue(path.is_file())
        self.assertEqual(path.read_bytes(), self.rfc.read_bytes())
        self.assertEqual(Path(row["rfc_path"]), path)
        self.assertEqual(Path(row["rfc_snapshot_path"]), path)
        self.assertNotEqual(path, self.rfc)


class TestSnapshotImmutability(SnapshotTestCase):
    def test_three_runs_and_global_edits_leave_earlier_snapshots_unchanged(self) -> None:
        contents = [b"# RFC one\n", b"# RFC two\n", b"# RFC three\n"]
        run_ids: list[str] = []
        for index, content in enumerate(contents, start=1):
            self.rfc.write_bytes(content)
            run_id = self.create(f"run-{index}")
            run_ids.append(run_id)
            self.assertEqual(self.snapshot(run_id).read_bytes(), content)
            self.store.update_run_status(run_id, RunStatus.COMPLETED)

        self.rfc.write_bytes(b"# RFC changed after every launch\n")
        for run_id, content in zip(run_ids, contents):
            with self.subTest(run_id=run_id):
                snapshot = self.snapshot(run_id)
                self.assertEqual(snapshot.read_bytes(), content)
                self.assertEqual(Path(self.store.get_run(run_id)["rfc_snapshot_path"]), snapshot)
        self.assertEqual(len({self.snapshot(run_id) for run_id in run_ids}), len(run_ids))


class TestLegacySnapshotFallback(SnapshotTestCase):
    async def test_legacy_run_without_snapshot_reads_the_global_rfc(self) -> None:
        run_id = self.store.create_run(self.repo, self.rfc, plan_path=self.plan, run_id="legacy-run")
        snapshot = self.snapshot(run_id)
        self.assertTrue(snapshot.is_file())
        # Emulate a row created before RFC snapshot support existed.
        snapshot.unlink()
        with self.store._connect() as conn:
            conn.execute("UPDATE runs SET rfc_snapshot_path = NULL WHERE id = ?", (run_id,))
        stored = self.store.get_run(run_id)
        self.assertIsNone(stored["rfc_snapshot_path"])
        self.assertEqual(Path(stored["rfc_path"]), self.rfc)

        self.rfc.write_text("# Legacy RFC\n\nChanged after the row was created.\n", encoding="utf-8")
        observed: list[str] = []

        async def capture(**kwargs: object) -> bool:
            observed.append(str(kwargs["rfc_text"]))
            return True

        with patch.object(self.engine, "_execute_milestone", side_effect=capture):
            status = await self.engine.execute_run(run_id)

        self.assertEqual(status, RunStatus.READY_FOR_FINAL_GATE)
        self.assertEqual(len(observed), 1)
        self.assertIn("Changed after the row was created.", observed[0])
        self.assertNotIn("Original bytes.", observed[0])
        self.assertFalse(snapshot.exists())


if __name__ == "__main__":
    unittest.main()
