"""Golden examples for testing ledger behavior with unittest and a temporary DB."""

import os
import sqlite3
import unittest
from contextlib import closing
from dataclasses import replace
from decimal import localcontext
from pathlib import Path
from unittest.mock import patch

from ledger.db import add_record, connect, delete_record, get_record, list_records
from ledger.db import resolve_db_path
from ledger.models import format_cents, parse_amount, validate_date, validate_month
from ledger.tests.helpers import TempDbTestCase, make_record


class TestRecords(TempDbTestCase):
    def test_add_record_assigns_id_and_commits(self) -> None:
        record = make_record(kind="income", category="Salary", note="November")

        record_id = add_record(self.conn, record)

        self.assertIsInstance(record_id, int)
        self.assertGreater(record_id, 0)
        with closing(connect(self.db_path)) as reader:
            self.assertEqual(get_record(reader, record_id), replace(record, id=record_id))

    def test_list_records_orders_by_date_then_id(self) -> None:
        later_id = add_record(self.conn, make_record(date="2026-11-20"))
        earlier_id = add_record(self.conn, make_record(date="2026-11-01"))
        same_date_id = add_record(self.conn, make_record(date="2026-11-01"))

        records = list_records(self.conn)

        self.assertEqual(
            [record.id for record in records],
            [earlier_id, same_date_id, later_id],
        )

    def test_list_records_filters_by_year_and_month(self) -> None:
        add_record(self.conn, make_record(date="2025-11-15"))
        add_record(self.conn, make_record(date="2026-10-31"))
        november_id = add_record(self.conn, make_record(date="2026-11-30"))
        add_record(self.conn, make_record(date="2026-12-01"))

        records = list_records(self.conn, "2026-11")

        self.assertEqual([record.id for record in records], [november_id])
        self.assertEqual(list_records(self.conn, "2026-09"), [])

    def test_list_records_rejects_an_invalid_month(self) -> None:
        with self.assertRaises(ValueError):
            list_records(self.conn, "2026-%")

    def test_delete_record_removes_existing_record(self) -> None:
        record_id = add_record(self.conn, make_record())

        self.assertTrue(delete_record(self.conn, record_id))
        with closing(connect(self.db_path)) as reader:
            self.assertIsNone(get_record(reader, record_id))

    def test_delete_record_returns_false_for_missing_id(self) -> None:
        self.assertFalse(delete_record(self.conn, 999))

    def test_schema_checks_kind_and_amount(self) -> None:
        for overrides in ({"kind": "refund"}, {"amount_cents": 0}, {"amount_cents": -1}):
            with self.subTest(**overrides):
                with self.assertRaisesRegex(sqlite3.IntegrityError, "CHECK constraint"):
                    add_record(self.conn, make_record(**overrides))
        self.assertEqual(list_records(self.conn), [])

    def test_add_record_rejects_fractional_cents(self) -> None:
        with self.assertRaises(TypeError):
            add_record(self.conn, make_record(amount_cents=12.5))


class TestDatabasePath(unittest.TestCase):
    def test_cli_path_takes_precedence_over_environment(self) -> None:
        with patch.dict(os.environ, {"LEDGER_DB": "environment.db"}):
            self.assertEqual(resolve_db_path("cli.db"), Path("cli.db"))
            self.assertEqual(resolve_db_path(None), Path("environment.db"))

    def test_path_defaults_to_database_in_package(self) -> None:
        with patch.dict(os.environ):
            os.environ.pop("LEDGER_DB", None)
            expected_path = Path(__file__).resolve().parents[1] / "ledger.db"
            self.assertEqual(resolve_db_path(None), expected_path)


class TestModels(unittest.TestCase):
    def test_parse_amount_returns_exact_cents(self) -> None:
        for text, cents in (("12", 1200), ("12.5", 1250), ("12.50", 1250), ("0.1", 10)):
            with self.subTest(text=text):
                self.assertEqual(parse_amount(text), cents)

        self.assertEqual(parse_amount("0.1") + parse_amount("0.2"), 30)

    def test_parse_amount_preserves_precision_with_a_smaller_decimal_context(self) -> None:
        with localcontext() as context:
            context.prec = 3
            self.assertEqual(parse_amount("12345.67"), 1234567)

    def test_parse_amount_rejects_invalid_values(self) -> None:
        for text in ("0", "-1", "1.234", "1.230", "invalid", "", "NaN", "Infinity"):
            with self.subTest(text=text):
                with self.assertRaises(ValueError):
                    parse_amount(text)

    def test_format_cents_uses_two_decimal_places(self) -> None:
        for cents, text in ((1250, "12.50"), (0, "0.00"), (-1, "-0.01")):
            with self.subTest(cents=cents):
                self.assertEqual(format_cents(cents), text)

    def test_validate_date_requires_a_calendar_date_in_canonical_format(self) -> None:
        self.assertEqual(validate_date("2024-02-29"), "2024-02-29")
        for text in ("2026-02-29", "2026-11-1", "20261125", "2026-W48-3"):
            with self.subTest(text=text):
                with self.assertRaises(ValueError):
                    validate_date(text)

    def test_validate_month_requires_a_calendar_month_in_canonical_format(self) -> None:
        self.assertEqual(validate_month("2026-11"), "2026-11")
        for text in ("2026-00", "2026-13", "2026-1", "202611", "0000-01"):
            with self.subTest(text=text):
                with self.assertRaises(ValueError):
                    validate_month(text)
