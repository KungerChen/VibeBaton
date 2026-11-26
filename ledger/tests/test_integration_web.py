"""Compare a running ledger Web server with CLI output from the same database."""

import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor
from datetime import date, timedelta
from pathlib import Path
from urllib.request import urlopen
from xml.etree import ElementTree

from ledger.tests.test_cli import CliTestCase


REPO_ROOT = Path(__file__).resolve().parents[2]


class TestWebIntegration(CliTestCase):
    def _run_successful_cli(self, *argv: str) -> str:
        code, stdout, stderr = self.run_cli(*argv)
        self.assertEqual((code, stderr), (0, ""), f"ledger {argv!r}")
        return stdout

    def _add_entry(
        self, day: str, kind: str, category: str, amount: str, note: str
    ) -> int:
        output = self._run_successful_cli(
            "add",
            "--date", day,
            "--type", kind,
            "--category", category,
            "--amount", amount,
            "--note", note,
        )
        self.assertRegex(output, r"\AAdded record #[1-9][0-9]*\n\Z")
        return int(output.removeprefix("Added record #"))

    def _table_rows(self, page: str, table_id: str) -> list[list[str]]:
        _, opening_tag, remainder = page.partition(f'<table id="{table_id}">')
        body, closing_tag, _ = remainder.partition("</table>")
        self.assertTrue(opening_tag and closing_tag, f"Missing table {table_id!r}")
        table = ElementTree.fromstring(f"{opening_tag}{body}{closing_tag}")
        return [
            [cell.text or "" for cell in row.findall("td")]
            for row in table.findall("tbody/tr")
        ]

    def _assert_page_matches_cli(self, url: str, month: str, deleted_id: int) -> None:
        with urlopen(url, timeout=5) as response:
            self.assertEqual(response.status, 200)
            self.assertEqual(response.headers["Content-Type"], "text/html; charset=utf-8")
            page = response.read().decode("utf-8")
        self.assertIn(f"<h1>{month}</h1>", page)

        stats_output = self._run_successful_cli("stats", "--month", month)
        stats_rows = [line.split("\t") for line in stats_output.splitlines()]
        label, total = stats_rows[-1]
        self.assertEqual(label, "TOTAL")
        self.assertEqual(
            [row[:2] for row in self._table_rows(page, "summary")],
            [*stats_rows[:-1], ["合计", total]],
        )

        list_output = self._run_successful_cli("list", "--month", month)
        record_rows = self._table_rows(page, "records")
        self.assertEqual(record_rows, [line.split("\t") for line in list_output.splitlines()])
        self.assertNotIn(str(deleted_id), [row[0] for row in record_rows])

    def test_serve_shows_current_and_previous_months_after_deletion(self) -> None:
        today = date.today()
        current = today.strftime("%Y-%m")
        previous = (today.replace(day=1) - timedelta(days=1)).strftime("%Y-%m")
        for entry in (
            (f"{current}-15", "expense", "Food & Drink", "12.50", "Lunch"),
            (f"{current}-20", "expense", "Food & Drink", "2.25", "Coffee"),
            (f"{current}-01", "expense", "Transit", "20.75", "Bus pass"),
            (f"{current}-15", "income", "Salary", "1000", "Payday"),
            (f"{previous}-15", "expense", "Food & Drink", "99", "Groceries"),
            (f"{previous}-15", "income", "Salary", "900", "Previous payday"),
        ):
            self._add_entry(*entry)
        deleted_id = self._add_entry(
            f"{current}-15", "expense", "Food & Drink", "90", "Deleted meal"
        )
        self.assertEqual(
            self._run_successful_cli("delete", str(deleted_id)),
            f"Deleted record #{deleted_id}\n",
        )

        command = [
            sys.executable,
            "-m", "ledger",
            "--db", str(self.db_path),
            "serve",
            "--port", "0",
            "--no-browser",
        ]
        with (
            subprocess.Popen(
                command,
                cwd=REPO_ROOT,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
            ) as server,
            ThreadPoolExecutor(max_workers=1) as reader,
        ):
            try:
                assert server.stdout is not None
                startup = reader.submit(server.stdout.readline).result(timeout=10)
                self.assertRegex(startup, r"\AServing on http://127\.0\.0\.1:[1-9][0-9]*/\n\Z")
                base_url = startup.removeprefix("Serving on ").rstrip("\n")
                for month, query in ((current, ""), (previous, f"?month={previous}")):
                    with self.subTest(month=month):
                        self._assert_page_matches_cli(f"{base_url}{query}", month, deleted_id)
            finally:
                server.kill()
                server.wait(timeout=5)
