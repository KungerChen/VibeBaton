"""Tests for monthly ledger statistics with a temporary DB."""

from ledger.db import add_record
from ledger.stats import CategoryTotal, month_total, monthly_summary
from ledger.tests.helpers import TempDbTestCase, make_record


class TestMonthlySummary(TempDbTestCase):
    def test_groups_expenses_by_category(self) -> None:
        add_record(self.conn, make_record(category="Food", amount_cents=1200))
        add_record(self.conn, make_record(category="Food", amount_cents=800))
        add_record(self.conn, make_record(category="Rent", amount_cents=50000))

        summary = monthly_summary(self.conn, "2026-11")

        self.assertEqual(
            summary,
            [
                CategoryTotal(category="Rent", total_cents=50000, count=1),
                CategoryTotal(category="Food", total_cents=2000, count=2),
            ],
        )

    def test_sums_cents_beyond_the_sqlite_integer_range(self) -> None:
        add_record(self.conn, make_record(amount_cents=9223372036854775807))
        add_record(self.conn, make_record(amount_cents=1))

        summary = monthly_summary(self.conn, "2026-11")

        self.assertEqual(
            summary,
            [CategoryTotal(category="Food", total_cents=9223372036854775808, count=2)],
        )

    def test_excludes_records_from_other_months(self) -> None:
        add_record(self.conn, make_record(date="2026-11-01", amount_cents=100))
        add_record(self.conn, make_record(date="2026-10-31", amount_cents=999))
        add_record(self.conn, make_record(date="2026-12-01", amount_cents=999))

        summary = monthly_summary(self.conn, "2026-11")

        self.assertEqual(
            summary,
            [CategoryTotal(category="Food", total_cents=100, count=1)],
        )

    def test_excludes_income_from_expense_totals(self) -> None:
        add_record(self.conn, make_record(kind="expense", amount_cents=1250))
        add_record(
            self.conn,
            make_record(kind="income", category="Salary", amount_cents=500000),
        )

        summary = monthly_summary(self.conn, "2026-11")

        self.assertEqual(
            summary,
            [CategoryTotal(category="Food", total_cents=1250, count=1)],
        )

    def test_returns_empty_list_for_a_month_without_expenses(self) -> None:
        add_record(self.conn, make_record(date="2026-10-31"))

        self.assertEqual(monthly_summary(self.conn, "2026-09"), [])

    def test_orders_by_total_descending_then_category_ascending(self) -> None:
        add_record(self.conn, make_record(category="Beta", amount_cents=500))
        add_record(self.conn, make_record(category="Alpha", amount_cents=500))
        add_record(self.conn, make_record(category="Gamma", amount_cents=900))

        summary = monthly_summary(self.conn, "2026-11")

        self.assertEqual(
            [(total.category, total.total_cents) for total in summary],
            [("Gamma", 900), ("Alpha", 500), ("Beta", 500)],
        )

    def test_rejects_an_invalid_month(self) -> None:
        for text in ("2026-00", "2026-13", "2026-1", "202611", "0000-01"):
            with self.subTest(text=text):
                with self.assertRaises(ValueError):
                    monthly_summary(self.conn, text)


class TestMonthTotal(TempDbTestCase):
    def test_sums_expenses_for_the_month(self) -> None:
        add_record(self.conn, make_record(amount_cents=1200))
        add_record(self.conn, make_record(amount_cents=800))
        add_record(self.conn, make_record(kind="income", amount_cents=500000))
        add_record(self.conn, make_record(date="2026-10-31", amount_cents=999))

        self.assertEqual(month_total(self.conn, "2026-11"), 2000)

    def test_sums_income_when_requested(self) -> None:
        add_record(self.conn, make_record(kind="income", amount_cents=500000))
        add_record(self.conn, make_record(kind="income", amount_cents=10000))
        add_record(self.conn, make_record(kind="expense", amount_cents=1250))

        self.assertEqual(month_total(self.conn, "2026-11", "income"), 510000)

    def test_sums_cents_beyond_the_sqlite_integer_range(self) -> None:
        add_record(self.conn, make_record(amount_cents=9223372036854775807))
        add_record(self.conn, make_record(amount_cents=1))

        self.assertEqual(month_total(self.conn, "2026-11"), 9223372036854775808)

    def test_returns_zero_for_a_month_without_matching_records(self) -> None:
        add_record(self.conn, make_record(date="2026-10-31"))

        self.assertEqual(month_total(self.conn, "2026-09"), 0)

    def test_rejects_an_invalid_month(self) -> None:
        with self.assertRaises(ValueError):
            month_total(self.conn, "2026-%")
