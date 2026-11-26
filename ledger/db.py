import os
import sqlite3
from pathlib import Path

from .models import Record, validate_month

DEFAULT_DB_PATH = Path(__file__).resolve().parent / "ledger.db"

_SELECT_RECORDS = "SELECT id, kind, amount_cents, category, date, note FROM records"


def resolve_db_path(cli_value: str | None) -> Path:
    """Use the first nonempty path from --db, LEDGER_DB, and the package default."""
    return Path(cli_value or os.environ.get("LEDGER_DB") or DEFAULT_DB_PATH)


def connect(path: str | Path) -> sqlite3.Connection:
    """Open the database, initialize the schema, and return a row-aware connection."""
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    try:
        init_schema(conn)
    except sqlite3.Error:
        conn.close()
        raise
    return conn


def init_schema(conn: sqlite3.Connection) -> None:
    """Create the records table if it is absent."""
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS records (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            kind TEXT NOT NULL CHECK(kind IN ('income', 'expense')),
            amount_cents INTEGER NOT NULL CHECK(amount_cents > 0),
            category TEXT NOT NULL,
            date TEXT NOT NULL,
            note TEXT NOT NULL DEFAULT ''
        )
        """
    )


def add_record(conn: sqlite3.Connection, record: Record) -> int:
    """Insert and commit a record, returning its generated ID."""
    if not isinstance(record.amount_cents, int):
        raise TypeError("amount_cents must be an integer")

    with conn:
        cursor = conn.execute(
            """
            INSERT INTO records (kind, amount_cents, category, date, note)
            VALUES (?, ?, ?, ?, ?)
            """,
            (record.kind, record.amount_cents, record.category, record.date, record.note),
        )
        record_id = cursor.lastrowid
        assert record_id is not None
    return record_id


def list_records(conn: sqlite3.Connection, month: str | None = None) -> list[Record]:
    """List records by ascending date and ID, optionally for one YYYY-MM month."""
    query = _SELECT_RECORDS
    params: tuple[str, ...] = ()
    if month is not None:
        query += " WHERE date LIKE ?"
        params = (f"{validate_month(month)}-%",)
    return [
        Record(**row)
        for row in conn.execute(query + " ORDER BY date, id", params)
    ]


def get_record(conn: sqlite3.Connection, id: int) -> Record | None:
    """Fetch a record by ID or return None when it is absent."""
    row = conn.execute(f"{_SELECT_RECORDS} WHERE id = ?", (id,)).fetchone()
    return Record(**row) if row is not None else None


def delete_record(conn: sqlite3.Connection, id: int) -> bool:
    """Commit deletion by ID and report whether a row was removed."""
    with conn:
        cursor = conn.execute("DELETE FROM records WHERE id = ?", (id,))
    return cursor.rowcount == 1
