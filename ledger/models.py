from dataclasses import dataclass
from datetime import date
from decimal import Decimal, InvalidOperation

KINDS = ("income", "expense")


@dataclass
class Record:
    """A ledger entry with an ISO date and an amount in cents."""

    id: int | None
    kind: str
    amount_cents: int
    category: str
    date: str
    note: str = ""


def parse_amount(text: str) -> int:
    """Convert a positive decimal with at most two decimal places to cents."""
    try:
        amount = Decimal(text)
    except InvalidOperation as exc:
        raise ValueError(f"Invalid amount {text!r}") from exc

    exponent = amount.as_tuple().exponent
    if not isinstance(exponent, int) or amount <= 0:
        raise ValueError("Amount must be positive and finite")
    if exponent < -2:
        raise ValueError("Amount must have at most two decimal places")

    numerator, denominator = amount.as_integer_ratio()
    return numerator * 100 // denominator


def format_cents(cents: int) -> str:
    """Format an integer number of cents with exactly two decimal places."""
    units, remainder = divmod(abs(cents), 100)
    sign = "-" if cents < 0 else ""
    return f"{sign}{units}.{remainder:02d}"


def validate_date(text: str) -> str:
    """Return a calendar date in YYYY-MM-DD format or raise ValueError."""
    try:
        if date.fromisoformat(text).isoformat() == text:
            return text
    except ValueError:
        pass
    raise ValueError(f"Invalid date {text!r}. Expected YYYY-MM-DD.")


def validate_month(text: str) -> str:
    """Return a calendar month in YYYY-MM format or raise ValueError."""
    try:
        validate_date(f"{text}-01")
    except ValueError:
        raise ValueError(f"Invalid month {text!r}. Expected YYYY-MM.") from None
    return text
