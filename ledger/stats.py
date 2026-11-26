from dataclasses import dataclass
from sqlite3 import Connection

from .models import validate_month


@dataclass(frozen=True)
class CategoryTotal:
    """An expense category's total in cents and number of records."""

    category: str
    total_cents: int
    count: int


def monthly_summary(conn: Connection, month: str) -> list[CategoryTotal]:
    """Group expense records in the YYYY-MM month by category.

    Return each category's total cents and count, ordered by descending
    total_cents and then ascending category.
    """
    totals: dict[str, tuple[int, int]] = {}
    rows = conn.execute(
        """
        SELECT category, amount_cents
        FROM records
        WHERE kind = 'expense' AND date LIKE ?
        """,
        (f"{validate_month(month)}-%",),
    )
    for row in rows:
        total_cents, count = totals.get(row["category"], (0, 0))
        totals[row["category"]] = (total_cents + row["amount_cents"], count + 1)
    return sorted(
        (
            CategoryTotal(category=category, total_cents=total_cents, count=count)
            for category, (total_cents, count) in totals.items()
        ),
        key=lambda total: (-total.total_cents, total.category),
    )


def month_total(conn: Connection, month: str, kind: str = "expense") -> int:
    """Sum cents for the given kind in the YYYY-MM month, or return 0 if empty."""
    return sum(
        row["amount_cents"]
        for row in conn.execute(
            """
            SELECT amount_cents
            FROM records
            WHERE kind = ? AND date LIKE ?
            """,
            (kind, f"{validate_month(month)}-%"),
        )
    )
