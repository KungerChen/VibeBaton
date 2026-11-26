"""Exercise the ledger CLI in separate processes against temporary databases."""

import os
import subprocess
import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory


REPO_ROOT = Path(__file__).resolve().parents[2]


class TestCliIntegration(unittest.TestCase):
    def setUp(self) -> None:
        temp_dir = Path(self.enterContext(TemporaryDirectory()))
        self.db_path = temp_dir / "explicit.db"
        self.env_db_path = temp_dir / "environment.db"
        self.env = {**os.environ, "LEDGER_DB": str(self.env_db_path)}

    def run_cli(
        self, *argv: str, expected_code: int = 0, expected_stderr: str = ""
    ) -> str:
        result = subprocess.run(
            [sys.executable, "-m", "ledger", *argv],
            cwd=REPO_ROOT,
            env=self.env,
            capture_output=True,
            text=True,
            timeout=10,
        )
        self.assertEqual(
            (result.returncode, result.stderr),
            (expected_code, expected_stderr),
            f"ledger {argv!r} wrote {result.stdout!r} to stdout",
        )
        return result.stdout

    def add_record(
        self,
        db_options: tuple[str, ...],
        *,
        amount: str,
        category: str,
        date: str,
        note: str,
        kind: str = "expense",
    ) -> int:
        stdout = self.run_cli(
            *db_options,
            "add",
            "--type",
            kind,
            "--amount",
            amount,
            "--category",
            category,
            "--date",
            date,
            "--note",
            note,
        )
        self.assertRegex(stdout, r"\AAdded record #[1-9][0-9]*\n\Z")
        return int(stdout.removeprefix("Added record #"))

    def test_add_list_stats_and_delete(self) -> None:
        db_options = ("--db", str(self.db_path))
        food_id = self.add_record(
            db_options, amount="12.50", category="Food", date="2026-11-30", note="Lunch"
        )
        transit_id = self.add_record(
            db_options, amount="20.75", category="Transit", date="2026-11-01", note="Bus pass"
        )
        salary_id = self.add_record(
            db_options,
            kind="income",
            amount="1000",
            category="Salary",
            date="2026-11-15",
            note="November",
        )
        prior_food_id = self.add_record(
            db_options, amount="99", category="Food", date="2026-10-31", note="Groceries"
        )
        self.assertTrue(self.db_path.is_file())
        self.assertFalse(self.env_db_path.exists())

        self.assertEqual(
            self.run_cli(*db_options, "list", "--month", "2026-11"),
            f"{transit_id}\t2026-11-01\texpense\tTransit\t20.75\tBus pass\n"
            f"{salary_id}\t2026-11-15\tincome\tSalary\t1000.00\tNovember\n"
            f"{food_id}\t2026-11-30\texpense\tFood\t12.50\tLunch\n",
        )
        self.assertEqual(
            self.run_cli(*db_options, "list", "--month", "2026-10"),
            f"{prior_food_id}\t2026-10-31\texpense\tFood\t99.00\tGroceries\n",
        )
        self.assertEqual(
            self.run_cli(*db_options, "stats", "--month", "2026-11"),
            "Transit\t20.75\nFood\t12.50\nTOTAL\t33.25\n",
        )

        self.assertEqual(
            self.run_cli(*db_options, "delete", str(food_id)),
            f"Deleted record #{food_id}\n",
        )
        self.assertEqual(
            self.run_cli(*db_options, "stats", "--month", "2026-11"),
            "Transit\t20.75\nTOTAL\t20.75\n",
        )
        self.assertEqual(
            self.run_cli(
                *db_options,
                "delete",
                str(food_id),
                expected_code=1,
                expected_stderr=f"Record #{food_id} not found\n",
            ),
            "",
        )

    def test_uses_ledger_db_environment_variable(self) -> None:
        self.assertEqual(self.run_cli("list"), "")
        self.assertTrue(self.env_db_path.is_file())

        book_id = self.add_record(
            (), amount="7.25", category="Books", date="2026-11-05", note="Paperback"
        )
        self.assertEqual(
            self.run_cli("list"),
            f"{book_id}\t2026-11-05\texpense\tBooks\t7.25\tPaperback\n",
        )
