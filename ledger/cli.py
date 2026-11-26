import argparse
import sys
import webbrowser
from contextlib import closing, redirect_stdout
from datetime import date

from . import db, models, stats, web

_SQLITE_INT_MIN = -(2**63)
_SQLITE_INT_MAX = 2**63 - 1


def _escape_field(text: str) -> str:
    """Escape tabs and line breaks so a record stays on one six-column line."""
    return text.replace("\t", "\\t").replace("\r", "\\r").replace("\n", "\\n")


def build_parser() -> argparse.ArgumentParser:
    """Build the ledger command parser with a global --db database path.

    add requires --amount and --category. --type accepts income or expense
    and defaults to expense. --date defaults to today. --note defaults to "".
    list accepts an optional --month. delete requires a positional integer id.
    stats accepts --month, which defaults to the current month.
    serve accepts --host, --port, and --no-browser.
    """
    parser = argparse.ArgumentParser(prog="ledger")
    parser.add_argument("--db", help="Path to the SQLite database.")
    commands = parser.add_subparsers(dest="command", required=True)

    add_parser = commands.add_parser("add", help="Add a record.")
    add_parser.add_argument("--amount", required=True)
    add_parser.add_argument("--category", required=True)
    add_parser.add_argument("--type", choices=models.KINDS, default="expense")
    add_parser.add_argument("--date", default=date.today().isoformat())
    add_parser.add_argument("--note", default="")

    list_parser = commands.add_parser("list", help="List records.")
    list_parser.add_argument("--month")

    delete_parser = commands.add_parser("delete", help="Delete a record.")
    delete_parser.add_argument("id", type=int)

    stats_parser = commands.add_parser("stats", help="Show monthly totals.")
    stats_parser.add_argument("--month", default=date.today().strftime("%Y-%m"))

    serve_parser = commands.add_parser("serve", help="Serve the monthly ledger page.")
    serve_parser.add_argument(
        "--host", default="127.0.0.1", help="Bind address. Defaults to %(default)s."
    )
    serve_parser.add_argument(
        "--port", type=int, default=8000,
        help="Port to bind. Defaults to %(default)s. Use 0 for an available port.",
    )
    serve_parser.add_argument(
        "--no-browser", action="store_true", help="Skip opening the default browser."
    )

    return parser


def main(argv: list[str] | None = None, stdout=None) -> int:
    r"""Run the ledger command with the supplied arguments and output stream.

    Default argv to the process arguments and stdout to sys.stdout. Write one
    line per result and use format_cents for displayed amounts.

    add writes 'Added record #<id>'.
    list writes '<id>\t<date>\t<kind>\t<category>\t<amount>\t<note>' per record.
    delete writes 'Deleted record #<id>' for an existing record.
    stats writes '<category>\t<amount>' per category and ends with
    'TOTAL\t<amount>'.
    serve writes 'Serving on http://<host>:<port>/' and runs until interrupted.

    Return 0 on success. For a missing delete target, write
    'Record #<id> not found' to stderr and return 1. For ValueError, write
    'Error: ...' to stderr and return 1. Return 2 for argparse input errors.
    """
    output = sys.stdout if stdout is None else stdout
    parser = build_parser()
    try:
        with redirect_stdout(output):
            args = parser.parse_args(argv)
    except SystemExit as exc:
        return exc.code if isinstance(exc.code, int) else 2

    try:
        if args.command == "add":
            amount_cents = models.parse_amount(args.amount)
            if amount_cents > _SQLITE_INT_MAX:
                raise ValueError(f"Amount {args.amount!r} is too large")
            record = models.Record(
                id=None,
                kind=args.type,
                amount_cents=amount_cents,
                category=args.category,
                date=models.validate_date(args.date),
                note=args.note,
            )
            with closing(db.connect(db.resolve_db_path(args.db))) as conn:
                record_id = db.add_record(conn, record)
            print(f"Added record #{record_id}", file=output)
        elif args.command == "list":
            with closing(db.connect(db.resolve_db_path(args.db))) as conn:
                records = db.list_records(conn, args.month)
            for record in records:
                print(
                    "\t".join(
                        (
                            str(record.id),
                            record.date,
                            record.kind,
                            _escape_field(record.category),
                            models.format_cents(record.amount_cents),
                            _escape_field(record.note),
                        )
                    ),
                    file=output,
                )
        elif args.command == "delete":
            if not _SQLITE_INT_MIN <= args.id <= _SQLITE_INT_MAX:
                print(f"Record #{args.id} not found", file=sys.stderr)
                return 1
            with closing(db.connect(db.resolve_db_path(args.db))) as conn:
                deleted = db.delete_record(conn, args.id)
            if not deleted:
                print(f"Record #{args.id} not found", file=sys.stderr)
                return 1
            print(f"Deleted record #{args.id}", file=output)
        elif args.command == "stats":
            with closing(db.connect(db.resolve_db_path(args.db))) as conn:
                summary = stats.monthly_summary(conn, args.month)
                total = stats.month_total(conn, args.month)
            for category_total in summary:
                print(
                    f"{category_total.category}\t"
                    f"{models.format_cents(category_total.total_cents)}",
                    file=output,
                )
            print(f"TOTAL\t{models.format_cents(total)}", file=output)
        elif args.command == "serve":
            server = web.make_server(
                db.resolve_db_path(args.db), host=args.host, port=args.port
            )
            try:
                port = server.server_address[1]
                url = f"http://{args.host}:{port}/"
                print(f"Serving on {url}", file=output, flush=True)
                if not args.no_browser:
                    webbrowser.open(url)
                server.serve_forever()
            except KeyboardInterrupt:
                pass
            finally:
                server.server_close()
    except ValueError as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 1

    return 0
