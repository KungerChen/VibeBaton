"""Exercise the built Studio and local API on a loopback server."""

from __future__ import annotations

import json
import os
import re
import shutil
import struct
import subprocess
import tempfile
import threading
import tomllib
import unittest
from functools import partial
from pathlib import Path
from typing import Any
from unittest.mock import Mock, patch
from urllib.parse import urljoin
from urllib.request import Request, urlopen

from vibebaton import __version__, credentials
from vibebaton.db import StateStore
from vibebaton.web_server import create_server

REPO = Path(__file__).resolve().parents[1]


class WebFullStackTests(unittest.TestCase):
    def setUp(self) -> None:
        temp_dir = Path(self.enterContext(tempfile.TemporaryDirectory())).resolve()
        self.repo = temp_dir / "repo"
        self.config_path = self.repo / ".baton" / "baton.toml"
        self.config_path.parent.mkdir(parents=True)
        shutil.copy2(REPO / "baton.example.toml", self.config_path)
        self.credentials_path = temp_dir / "credentials.json"
        self.enterContext(patch.dict(os.environ))
        for key in credentials.SUPPORTED_KEYS:
            os.environ.pop(key, None)

    def start_server(self, static_dir: Path | None = None) -> str:
        server = create_server(
            self.repo,
            host="127.0.0.1",
            port=0,
            static_dir=static_dir,
            credentials_path=self.credentials_path,
            provider_probe=partial(
                credentials.probe_role_or_provider,
                health_checker=Mock(return_value=(True, "CLI available")),
            ),
        )
        self.addCleanup(server.server_close)
        thread = threading.Thread(
            target=server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True
        )
        thread.start()
        self.addCleanup(thread.join, timeout=5)
        self.addCleanup(server.shutdown)
        return f"http://127.0.0.1:{server.server_address[1]}/"

    def request_json(
        self, base: str, path: str, *, method: str = "GET", payload: dict[str, str] | None = None
    ) -> dict[str, Any]:
        request = Request(urljoin(base, path), method=method)
        if payload is not None:
            request.data = json.dumps(payload).encode("utf-8")
            request.add_header("Content-Type", "application/json")
        with urlopen(request, timeout=5) as response:
            self.assertEqual(response.status, 200)
            self.assertEqual(response.headers.get_content_type(), "application/json")
            body = json.load(response)
        self.assertIsInstance(body, dict)
        return body

    def test_serves_built_canvas_and_stage3_api(self) -> None:
        web_dir = REPO / "web"
        built_index = web_dir / "dist" / "index.html"
        if not built_index.is_file():
            subprocess.run(
                ["npm.cmd" if os.name == "nt" else "npm", "run", "build"],
                cwd=web_dir,
                check=True,
                timeout=120,
            )

        base = self.start_server()
        with urlopen(base, timeout=5) as response:
            self.assertEqual(response.status, 200)
            self.assertEqual(response.headers.get_content_type(), "text/html")
            index = response.read()
        self.assertEqual(index, built_index.read_bytes())
        self.assertIn(b'id="root"', index)
        self.assertIn(b'href="./favicon.svg"', index)
        self.assertIn(b'href="./favicon.ico"', index)

        with urlopen(urljoin(base, "./favicon.svg"), timeout=5) as response:
            self.assertEqual(response.status, 200)
            self.assertEqual(response.headers.get_content_type(), "image/svg+xml")
            svg_bytes = response.read()
        self.assertIn(b"<svg", svg_bytes)

        with urlopen(urljoin(base, "./favicon.ico"), timeout=5) as response:
            self.assertEqual(response.status, 200)
            self.assertEqual(response.headers.get_content_type(), "image/x-icon")
            ico_bytes = response.read()
        reserved, icon_type, count = struct.unpack("<HHH", ico_bytes[:6])
        self.assertEqual((reserved, icon_type, count), (0, 1, 3))

        script = re.search(r"""<script\b[^>]*\bsrc=["'](\./assets/[^"']+\.js)["']""", index.decode("utf-8"))
        if script is None:
            self.fail("Expected a relative JavaScript asset in the built index")
        asset_path = script.group(1)
        with urlopen(urljoin(base, asset_path), timeout=5) as response:
            self.assertEqual(response.status, 200)
            self.assertIn(response.headers.get_content_type(), {"text/javascript", "application/javascript"})
            asset = response.read()
        self.assertTrue(asset)
        self.assertEqual(asset, (built_index.parent / asset_path).read_bytes())
        self.assertEqual(self.request_json(base, "/api/health")["version"], __version__)

        presets = self.request_json(base, "/api/presets")["presets"]
        self.assertEqual(len(presets), 8)
        for preset in presets:
            with self.subTest(preset_id=preset["id"]):
                missing = preset["missing_providers"]
                self.assertIsInstance(missing, list)
                self.assertIs(preset["host_ready"], not missing)
        readiness = {preset["id"]: preset["missing_providers"] for preset in presets}
        self.assertEqual(readiness["codex_only_3tier"], [])
        self.assertEqual(readiness["deepseek_bulk_factory"], ["dsh_opencode"])
        panel = [preset["id"] for preset in presets if preset["category"] == "panel"]
        self.assertEqual(panel, ["specialist_panel"])

        config = self.request_json(base, "/api/config/roles")
        self.assertEqual(config["budget_profile"], "balanced")
        catalog = config["model_catalog"]
        self.assertIsInstance(catalog, list)
        self.assertTrue(any(model["provider"] == "codex_sub" and model["ready"] is True for model in catalog))
        updated = self.request_json(
            base, "/api/config/budget", method="PUT", payload={"budget_profile": "eco"}
        )
        self.assertEqual(updated, {"budget_profile": "eco", "model_catalog": catalog})
        self.assertEqual(self.request_json(base, "/api/config/roles"), {**config, **updated})
        stored_config = tomllib.loads(self.config_path.read_text(encoding="utf-8"))
        self.assertEqual(stored_config["policies"]["budget_profile"], "eco")

        rfc = (
            "## Goal\nVerify the release integration gate.\n\n"
            "## Constraints\nUse a loopback server and temporary credentials.\n\n"
            "## Acceptance\n```sh\npython -m unittest discover -s tests -v\n```\n"
        )
        readiness = self.request_json(base, "/api/rfc/check", method="POST", payload={"rfc_markdown": rfc})
        self.assertIs(readiness["safe_for_overnight"], True)
        self.assertEqual(readiness["missing_sections"], [])
        self.assertEqual(readiness["detected_commands"], ["python -m unittest"])

    def test_live_snapshot_exposes_exact_billing_and_conflict_counts(self) -> None:
        store = StateStore(self.repo / ".baton" / "state.sqlite")
        run_id = store.create_run(self.repo, self.repo / "rfc.md")
        store.log_event(
            run_id,
            "role_completed",
            actor="bulk_worker:flash",
            payload={
                "role": "bulk_worker",
                "provider": "deepseek_http",
                "model": "flash",
                "duration_sec": 2.0,
                "prompt_tokens": 120,
                "completion_tokens": 30,
                "cached_tokens": 40,
                "cost_usd": 0.0125,
            },
        )
        store.log_event(run_id, "merge_conflict_detected", task_id="M1-T1")
        store.log_event(run_id, "merge_conflict_resolved", task_id="M1-T1")
        store.log_event(run_id, "merge_conflict_detected", task_id="M1-T2")
        store.log_event(run_id, "merge_conflict_failed", task_id="M1-T2")

        stream_url = urljoin(self.start_server(), "/api/runs/stream?once=1")
        with urlopen(stream_url, timeout=5) as response:
            self.assertEqual(response.status, 200)
            self.assertEqual(response.headers.get_content_type(), "text/event-stream")
            self.assertEqual(response.readline(), b"event: snapshot\n")
            data = response.readline()
        self.assertTrue(data.startswith(b"data: "))
        snapshot = json.loads(data.removeprefix(b"data: "))
        self.assertEqual(snapshot["run"]["id"], run_id)
        telemetry = snapshot["telemetry"]
        self.assertIs(telemetry["billing"]["has_exact_billing"], True)
        self.assertEqual(
            telemetry["billing"],
            {
                "total_prompt_tokens": 120,
                "total_completion_tokens": 30,
                "total_cached_tokens": 40,
                "total_tokens": 150,
                "total_cost_usd": 0.0125,
                "has_exact_billing": True,
            },
        )
        self.assertEqual(
            telemetry["conflicts"],
            {"conflicts_detected": 2, "conflicts_auto_resolved": 1, "conflicts_failed": 1},
        )

    def test_empty_static_directory_serves_build_notice(self) -> None:
        empty = self.repo / "empty"
        empty.mkdir()
        with urlopen(self.start_server(static_dir=empty), timeout=5) as response:
            self.assertEqual(response.status, 200)
            self.assertIn(b"npm.cmd run build", response.read())


if __name__ == "__main__":
    unittest.main()
