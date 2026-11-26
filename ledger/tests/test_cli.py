"""Tests for the ledger command-line interface with a temporary DB."""

import io
from contextlib import redirect_stderr
from unittest.mock import patch

from ledger import cli
from ledger.db import add_record, get_record, list_records
from ledger.stats import CategoryTotal
from ledger.tests.helpers import TempDbTestCase, make_record


class CliTestCase(TempDbTestCase):
    def run_cli(self, *argv: str) -> tuple[int, str, str]:
        stdout = io.StringIO()
        stderr = io.StringIO()
        with redirect_stderr(stderr):
            code = cli.main(["--db", str(self.db_path), *argv], stdout=stdout)
        return code, stdout.getvalue(), stderr.getvalue()


class TestAddCommand(CliTestCase):
    def test_add_writes_an_expense_and_an_income(self) -> None:
        code, stdout, stderr = self.run_cli(
            "add",
            "--amount",
            "12.50",
            "--category",
            "Food",
            "--date",
            "2026-11-15",
            "--note",
            "Lunch",
        )
        self.assertEqual((code, stderr), (0, ""))
        expense = list_records(self.conn)[0]
        self.assertEqual(stdout, f"Added record #{expense.id}\n")

        code, stdout, stderr = self.run_cli(
            "add",
            "--type",
            "income",
            "--amount",
            "1000",
            "--category",
            "Salary",
            "--date",
            "2026-11-20",
            "--note",
            "November",
        )
        self.assertEqual((code, stderr), (0, ""))
        records = list_records(self.conn)
        self.assertEqual(stdout, f"Added record #{records[1].id}\n")
        self.assertEqual(
            [
                (record.kind, record.amount_cents, record.category, record.note)
                for record in records
            ],
            [
                ("expense", 1250, "Food", "Lunch"),
                ("income", 100000, "Salary", "November"),
            ],
        )

    def test_invalid_amount_or_date_writes_nothing(self) -> None:
        for argv in (
            ("add", "--amount", "1.234", "--category", "Food"),
            ("add", "--amount", "92233720368547758.08", "--category", "Food"),
            ("add", "--amount", "12.50", "--category", "Food", "--date", "2026-02-30"),
        ):
            with self.subTest(argv=argv):
                code, stdout, stderr = self.run_cli(*argv)

                self.assertEqual(code, 1)
                self.assertEqual(stdout, "")
                self.assertTrue(stderr.startswith("Error:"))
        self.assertEqual(list_records(self.conn), [])

    def test_overflowing_amount_does_not_create_a_database(self) -> None:
        db_path = self.db_path.parent / "overflow.db"
        stdout = io.StringIO()
        stderr = io.StringIO()
        with redirect_stderr(stderr):
            code = cli.main(
                [
                    "--db",
                    str(db_path),
                    "add",
                    "--amount",
                    "92233720368547758.08",
                    "--category",
                    "Food",
                    "--date",
                    "2026-11-15",
                ],
                stdout=stdout,
            )

        self.assertEqual(code, 1)
        self.assertEqual(stdout.getvalue(), "")
        self.assertTrue(stderr.getvalue().startswith("Error:"))
        self.assertFalse(db_path.exists())

    def test_missing_required_argument_returns_2(self) -> None:
        code, stdout, stderr = self.run_cli("add", "--category", "Food")

        self.assertEqual(code, 2)
        self.assertEqual(stdout, "")
        self.assertIn("error:", stderr)


class TestListCommand(CliTestCase):
    def test_list_prints_records_and_filters_by_month(self) -> None:
        food_id = add_record(self.conn, make_record(date="2026-11-15", note="Lunch"))
        salary_id = add_record(
            self.conn,
            make_record(
                kind="income",
                amount_cents=100000,
                category="Salary",
                date="2026-12-01",
                note="December",
            ),
        )

        code, stdout, stderr = self.run_cli("list")

        self.assertEqual((code, stderr), (0, ""))
        self.assertEqual(
            stdout,
            f"{food_id}\t2026-11-15\texpense\tFood\t12.50\tLunch\n"
            f"{salary_id}\t2026-12-01\tincome\tSalary\t1000.00\tDecember\n",
        )

        code, stdout, stderr = self.run_cli("list", "--month", "2026-11")

        self.assertEqual((code, stderr), (0, ""))
        self.assertEqual(stdout, f"{food_id}\t2026-11-15\texpense\tFood\t12.50\tLunch\n")

    def test_list_rejects_an_invalid_month(self) -> None:
        code, stdout, stderr = self.run_cli("list", "--month", "2026-13")

        self.assertEqual(code, 1)
        self.assertEqual(stdout, "")
        self.assertTrue(stderr.startswith("Error:"))

    def test_list_escapes_tabs_and_line_breaks(self) -> None:
        record_id = add_record(
            self.conn,
            make_record(category="Food\tDining", note="Lunch\nDinner\rTeam"),
        )

        code, stdout, stderr = self.run_cli("list", "--month", "2026-11")

        self.assertEqual((code, stderr), (0, ""))
        self.assertEqual(
            stdout,
            f"{record_id}\t2026-11-15\texpense\tFood\\tDining\t12.50\t"
            "Lunch\\nDinner\\rTeam\n",
        )
        self.assertEqual(len(stdout.splitlines()), 1)
        self.assertEqual(len(stdout.rstrip("\n").split("\t")), 6)


class TestDeleteCommand(CliTestCase):
    def test_delete_removes_an_existing_record(self) -> None:
        record_id = add_record(self.conn, make_record())

        code, stdout, stderr = self.run_cli("delete", str(record_id))

        self.assertEqual((code, stderr), (0, ""))
        self.assertEqual(stdout, f"Deleted record #{record_id}\n")
        self.assertIsNone(get_record(self.conn, record_id))

    def test_delete_reports_a_missing_record(self) -> None:
        code, stdout, stderr = self.run_cli("delete", "999")

        self.assertEqual(code, 1)
        self.assertEqual(stdout, "")
        self.assertEqual(stderr, "Record #999 not found\n")

    def test_delete_reports_an_id_outside_the_sqlite_range(self) -> None:
        record_id = add_record(self.conn, make_record())

        code, stdout, stderr = self.run_cli("delete", "9223372036854775808")

        self.assertEqual(code, 1)
        self.assertEqual(stdout, "")
        self.assertEqual(stderr, "Record #9223372036854775808 not found\n")
        self.assertIsNotNone(get_record(self.conn, record_id))


class TestStatsCommand(CliTestCase):
    def test_stats_prints_category_totals_and_total(self) -> None:
        summary = [CategoryTotal("Rent", 100000, 1), CategoryTotal("Food", 1250, 2)]
        with (
            patch("ledger.cli.stats.monthly_summary", return_value=summary) as monthly_summary,
            patch("ledger.cli.stats.month_total", return_value=101250) as month_total,
        ):
            code, stdout, stderr = self.run_cli("stats", "--month", "2026-11")

        self.assertEqual((code, stderr), (0, ""))
        self.assertEqual(stdout, "Rent\t1000.00\nFood\t12.50\nTOTAL\t1012.50\n")
        monthly_summary.assert_called_once()
        month_total.assert_called_once()
        self.assertEqual(monthly_summary.call_args.args[1], "2026-11")
        self.assertEqual(month_total.call_args.args[1], "2026-11")


class TestServeCommand(CliTestCase):
    def test_serve_opens_the_default_url_and_closes_after_interrupt(self) -> None:
        with (
            patch("ledger.cli.web.make_server") as make_server,
            patch("webbrowser.open") as open_browser,
        ):
            server = make_server.return_value
            server.server_address = ("127.0.0.1", 8000)
            server.serve_forever.side_effect = KeyboardInterrupt

            code, stdout, stderr = self.run_cli("serve")

        url = "http://127.0.0.1:8000/"
        self.assertEqual((code, stdout, stderr), (0, f"Serving on {url}\n", ""))
        make_server.assert_called_once_with(self.db_path, host="127.0.0.1", port=8000)
        open_browser.assert_called_once_with(url)
        server.serve_forever.assert_called_once_with()
        server.server_close.assert_called_once_with()

    def test_serve_without_browser_reports_the_assigned_port(self) -> None:
        with (
            patch("ledger.cli.web.make_server") as make_server,
            patch("webbrowser.open") as open_browser,
        ):
            server = make_server.return_value
            server.server_address = ("127.0.0.1", 49152)

            code, stdout, stderr = self.run_cli(
                "serve", "--host", "localhost", "--port", "0", "--no-browser"
            )

        self.assertEqual((code, stderr), (0, ""))
        self.assertEqual(stdout, "Serving on http://localhost:49152/\n")
        make_server.assert_called_once_with(self.db_path, host="localhost", port=0)
        open_browser.assert_not_called()
        server.serve_forever.assert_called_once_with()
        server.server_close.assert_called_once_with()


class TestHelpOutput(CliTestCase):
    def test_help_goes_to_the_supplied_stdout(self) -> None:
        for argv in (
            ("--help",),
            ("add", "--help"),
            ("list", "--help"),
            ("delete", "--help"),
            ("stats", "--help"),
            ("serve", "--help"),
        ):
            with self.subTest(argv=argv):
                code, stdout, stderr = self.run_cli(*argv)

                self.assertEqual((code, stderr), (0, ""))
                self.assertIn("usage: ledger", stdout)
