"""Render a month of ledger records as HTML and serve it over HTTP."""

import html
from contextlib import closing
from datetime import date
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from sqlite3 import Connection
from urllib.parse import parse_qs, urlsplit

from . import db, models, stats

_STYLE = """
body { font-family: sans-serif; margin: 2rem; color: #222; }
table { border-collapse: collapse; margin-bottom: 2rem; }
th, td { border: 1px solid #bbb; padding: 0.35rem 0.75rem; text-align: left; }
th { background: #eee; }
"""


def _message_page(message: str) -> str:
    """Return a minimal HTML document for an HTTP error response."""
    text = html.escape(message)
    return (
        "<!DOCTYPE html>\n"
        '<html lang="zh">\n'
        "<head>\n"
        '<meta charset="utf-8">\n'
        f"<title>{text}</title>\n"
        "</head>\n"
        f"<body><h1>{text}</h1></body>\n"
        "</html>\n"
    )


def render_page(conn: Connection, month: str) -> str:
    """Return a complete HTML document for the given YYYY-MM month.

    Use the caller's open ledger connection and leave it open. An invalid
    month raises ValueError as defined by ``models.validate_month``.

    Declare UTF-8 with ``<meta charset="utf-8">`` and show the month in an
    ``<h1>``.

    The ``<table id="summary">`` has columns 分类, 合计, 笔数 in that order.
    Show the expense categories in ``stats.monthly_summary`` order. The last
    row is labeled 合计 and shows the summed expense amount and count,
    with 0.00 and 0 when there are no expenses.

    The ``<table id="records">`` has columns ID, 日期, 类型, 分类, 金额,
    备注 in that order. Show all entries for the month in the date and ID
    order returned by ``db.list_records``.

    Escape every user-provided text value with ``html.escape`` and format
    every displayed amount with ``models.format_cents``.
    """
    month = models.validate_month(month)
    summary = stats.monthly_summary(conn, month)
    total_cents = stats.month_total(conn, month)
    records = db.list_records(conn, month)

    summary_rows = [
        f"<tr><td>{html.escape(total.category)}</td>"
        f"<td>{models.format_cents(total.total_cents)}</td>"
        f"<td>{total.count}</td></tr>"
        for total in summary
    ]
    summary_rows.append(
        f"<tr><td>合计</td><td>{models.format_cents(total_cents)}</td>"
        f"<td>{sum(total.count for total in summary)}</td></tr>"
    )
    record_rows = [
        f"<tr><td>{record.id}</td><td>{html.escape(record.date)}</td>"
        f"<td>{html.escape(record.kind)}</td>"
        f"<td>{html.escape(record.category)}</td>"
        f"<td>{models.format_cents(record.amount_cents)}</td>"
        f"<td>{html.escape(record.note)}</td></tr>"
        for record in records
    ]

    lines = [
        "<!DOCTYPE html>",
        '<html lang="zh">',
        "<head>",
        '<meta charset="utf-8">',
        f"<title>台账 {html.escape(month)}</title>",
        f"<style>{_STYLE}</style>",
        "</head>",
        "<body>",
        f"<h1>{html.escape(month)}</h1>",
        '<table id="summary">',
        "<thead><tr><th>分类</th><th>合计</th><th>笔数</th></tr></thead>",
        "<tbody>",
        *summary_rows,
        "</tbody>",
        "</table>",
        '<table id="records">',
        "<thead><tr><th>ID</th><th>日期</th><th>类型</th>"
        "<th>分类</th><th>金额</th><th>备注</th></tr></thead>",
        "<tbody>",
        *record_rows,
        "</tbody>",
        "</table>",
        "</body>",
        "</html>",
    ]
    return "\n".join(lines) + "\n"


class _RequestHandler(BaseHTTPRequestHandler):
    """Answer GET requests from the ledger's read-only page server."""

    server: "_LedgerServer"

    def do_GET(self) -> None:
        """Serve the monthly page for "/" and reject every other path."""
        url = urlsplit(self.path)
        if url.path != "/":
            self._send(404, _message_page("404 Not Found"))
            return

        values = parse_qs(url.query, keep_blank_values=True).get("month")
        try:
            month = models.validate_month(
                values[0] if values is not None else date.today().strftime("%Y-%m")
            )
        except ValueError:
            self._send(400, _message_page("400 Bad Request"))
            return

        with closing(db.connect(self.server.db_path)) as conn:
            page = render_page(conn, month)
        self._send(200, page)

    def _send(self, status: int, page: str) -> None:
        """Write a UTF-8 HTML response with the given status code."""
        body = page.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format: str, *args: object) -> None:
        """Discard the per-request access log."""


class _LedgerServer(ThreadingHTTPServer):
    """Threading server that hands its database path to the request handler."""

    def __init__(self, server_address: tuple[str, int], db_path: Path) -> None:
        self.db_path = db_path
        super().__init__(server_address, _RequestHandler)


def make_server(
    db_path: Path, host: str = "127.0.0.1", port: int = 8000
) -> ThreadingHTTPServer:
    """Bind a ledger server that the caller can start with ``serve_forever``.

    ``GET /`` serves ``render_page(conn, month)`` as UTF-8 with status 200.
    The optional ``?month=YYYY-MM`` selects a month. When the parameter is
    absent, use the server's local current month at request time. Validate
    a supplied value with ``models.validate_month`` and return 400 for an
    invalid value, including an empty value. Other GET paths return 404.
    Set ``Content-Type: text/html; charset=utf-8`` for these responses.

    For each valid page request, open a fresh ``db.connect(db_path)``
    connection and close it even if rendering fails. Pass ``port=0`` for an
    OS-assigned port available in ``server_address``. The caller owns server
    shutdown and socket cleanup.
    """
    return _LedgerServer((host, port), db_path)
