"""Verify that the Python canvas server serves the Vite build and its fallback."""

from __future__ import annotations

import re
import shutil
import tempfile
import threading
import unittest
from pathlib import Path
from urllib.parse import urljoin
from urllib.request import urlopen

from vibebaton.web_server import create_server

REPO = Path(__file__).resolve().parents[1]


class WebFullStackTests(unittest.TestCase):
    def setUp(self) -> None:
        temp_dir = tempfile.TemporaryDirectory()
        self.addCleanup(temp_dir.cleanup)
        self.repo = Path(temp_dir.name).resolve()
        config_dir = self.repo / ".baton"
        config_dir.mkdir()
        shutil.copy2(REPO / "baton.example.toml", config_dir / "baton.toml")

    def start_server(self, static_dir: Path | None = None) -> str:
        server = create_server(self.repo, port=0, static_dir=static_dir)
        self.addCleanup(server.server_close)
        thread = threading.Thread(
            target=server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True
        )
        thread.start()
        self.addCleanup(thread.join, timeout=5)
        self.addCleanup(server.shutdown)
        return f"http://127.0.0.1:{server.server_address[1]}/"

    @unittest.skipUnless((REPO / "web" / "dist" / "index.html").exists(), "web/dist not built")
    def test_default_static_directory_serves_built_index_and_javascript(self) -> None:
        base = self.start_server()
        with urlopen(base, timeout=5) as response:
            self.assertEqual(response.status, 200)
            self.assertEqual(response.headers.get_content_type(), "text/html")
            index = response.read().decode("utf-8")
        self.assertIn('id="root"', index)

        script = re.search(r"""<script\b[^>]*\bsrc=["'](\./assets/[^"']+\.js)["']""", index)
        self.assertIsNotNone(script, "Expected a relative JavaScript asset in the built index")
        with urlopen(urljoin(base, script.group(1)), timeout=5) as response:
            self.assertEqual(response.status, 200)
            self.assertIn(response.headers.get_content_type(), {"text/javascript", "application/javascript"})
            self.assertTrue(response.read())

    def test_empty_static_directory_serves_build_notice(self) -> None:
        empty = self.repo / "empty"
        empty.mkdir()
        with urlopen(self.start_server(static_dir=empty), timeout=5) as response:
            self.assertEqual(response.status, 200)
            self.assertIn(b"npm.cmd run build", response.read())


if __name__ == "__main__":
    unittest.main()
