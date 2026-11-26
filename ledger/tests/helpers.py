import tempfile
import unittest
from dataclasses import replace
from pathlib import Path
from threading import Thread
from typing import Any

from ledger import web
from ledger.db import connect
from ledger.models import Record


class TempDbTestCase(unittest.TestCase):
    """Give each test a fresh on-disk ledger and an open connection."""

    def setUp(self) -> None:
        self._temp_dir = tempfile.TemporaryDirectory()
        self.db_path = Path(self._temp_dir.name) / "ledger.db"
        try:
            self.conn = connect(self.db_path)
        except Exception:
            self._temp_dir.cleanup()
            raise

    def tearDown(self) -> None:
        try:
            self.conn.close()
        finally:
            self._temp_dir.cleanup()


def make_record(**overrides: Any) -> Record:
    """Create a fresh test record with the requested fields overridden."""
    record = Record(
        id=None,
        kind="expense",
        amount_cents=1250,
        category="Food",
        date="2026-11-15",
    )
    return replace(record, **overrides)


class ServerThread:
    """Start a ledger server on an OS-assigned loopback port.

    In a ``TempDbTestCase`` test, use the bound URL and release the server
    before database cleanup::

        from urllib.request import urlopen

        server = ServerThread(self.db_path)
        try:
            url = f"{server.base_url}/?month=2024-02"
            with urlopen(url, timeout=2) as response:
                self.assertEqual(response.status, 200)
                self.assertIn("2024-02", response.read().decode("utf-8"))
        finally:
            server.stop()
    """

    def __init__(self, db_path: Path) -> None:
        self._server = web.make_server(db_path, port=0)
        host, port = self._server.server_address
        self.base_url = f"http://{host}:{port}"
        self._thread = Thread(
            target=self._server.serve_forever,
            kwargs={"poll_interval": 0.05},
            daemon=True,
        )
        try:
            self._thread.start()
        except Exception:
            self._server.server_close()
            raise

    def stop(self) -> None:
        """Stop serving, join the thread, and close the listening socket."""
        if self._thread.is_alive():
            self._server.shutdown()
            self._thread.join()
        self._server.server_close()
