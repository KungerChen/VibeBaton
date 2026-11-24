"""HTTP contract tests for the VibeBaton canvas server."""

from __future__ import annotations

import io
import json
import os
import shutil
import socket
import struct
import tempfile
import threading
import time
import unittest
from contextlib import redirect_stdout
from functools import partial
from html import unescape
from http.client import HTTPMessage, HTTPResponse
from http.server import ThreadingHTTPServer
from pathlib import Path
from typing import Any
from unittest.mock import Mock, patch
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from vibebaton import __version__, cli, credentials
from vibebaton.config import BatonConfig, HotReloadConfig
from vibebaton.db import StateStore
from vibebaton.report import compute_run_telemetry
from vibebaton.schemas import MilestoneSpec, PlanDAG, RunStatus, TaskSpec, TaskStatus
from vibebaton.web_server import VibeBatonWebServer, _CanvasRequestHandler, _set_toml_role_keys, create_server

PRESET_IDS = (
    "claude_only_3tier",
    "codex_only_3tier",
    "deepseek_bulk_factory",
    "flagship_4tier",
    "review_only_audit",
    "solo_coder_3tier",
    "specialist_panel",
    "starter_2tier",
)
NON_FINITE_JSON_NUMBERS = ("NaN", "Infinity", "-Infinity", "1e400", "-1e400")


def _graph_payload() -> dict[str, Any]:
    return {
        "schema_version": "1.0",
        "id": "test_graph",
        "name": "Test graph",
        "nodes": [
            {"id": "worker", "type": "worker_node", "label": "Worker"},
            {"id": "gate", "type": "gate_node", "label": "Gate"},
        ],
        "edges": [{"id": "check", "source": "worker", "target": "gate"}],
    }


def _unbounded_cycle() -> dict[str, Any]:
    graph = _graph_payload()
    graph["edges"].append(
        {"id": "retry", "source": "gate", "sourceHandle": "fail", "target": "worker"}
    )
    return graph


def _cycle_json_with_loop_limit(token: str) -> str:
    graph = _unbounded_cycle()
    graph["nodes"][0]["config"] = {"max_loops": "__loop_limit__"}
    return json.dumps(graph).replace('"__loop_limit__"', token)


def _fake_provider_probe(
    config: BatonConfig,
    *,
    provider: str | None = None,
    role: str | None = None,
    model: str | None = None,
    credentials_path: Path | None = None,
) -> credentials.ProbeResult:
    role_config = config.roles.get(role) if role is not None else None
    target = provider or (role_config.provider if role_config else "")
    ok = target in {"codex_sub", "dsh_opencode", "host_native"}
    return {
        "ok": ok,
        "provider": target,
        "detail": "CLI available" if ok else "CLI unavailable",
        "latency_ms": 0.25,
        "install_hint": "" if ok else "Check PATH",
    }


class WebServerTestCase(unittest.TestCase):
    """Run each test against a fresh loopback server and a temporary repository."""

    def setUp(self) -> None:
        temp_dir = tempfile.TemporaryDirectory()
        self.addCleanup(temp_dir.cleanup)
        self.repo = Path(temp_dir.name).resolve()
        self.config_path = self.repo / ".baton" / "baton.toml"
        self.config_path.parent.mkdir()
        self.example_path = Path(__file__).resolve().parents[1] / "baton.example.toml"
        shutil.copy2(self.example_path, self.config_path)
        self.spawn_calls: list[tuple[Path, Path, str]] = []
        self.credentials_path = Path(self.enterContext(tempfile.TemporaryDirectory())) / "credentials.json"
        self.enterContext(patch.dict(os.environ))
        for key in credentials.SUPPORTED_KEYS:
            os.environ.pop(key, None)
        self.provider_probe = Mock(side_effect=_fake_provider_probe)

        self.server = self._create_server()
        self.base = self.start_server(self.server)

    def start_server(self, server: ThreadingHTTPServer) -> str:
        self.addCleanup(server.server_close)
        thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True)
        thread.start()
        self.addCleanup(thread.join, timeout=5)
        self.addCleanup(server.shutdown)
        return f"http://127.0.0.1:{server.server_address[1]}"

    def _create_server(self) -> ThreadingHTTPServer:
        return create_server(
            self.repo,
            port=0,
            daemon_spawner=self.fake_spawner,
            credentials_path=self.credentials_path,
            provider_probe=self.provider_probe,
        )

    def fake_spawner(self, repo_path: Path, config_path: Path, run_id: str) -> int:
        self.spawn_calls.append((repo_path, config_path, run_id))
        return 4242

    def _request(self, request: Request) -> tuple[int, HTTPMessage, Any]:
        try:
            response = urlopen(request, timeout=5)
        except HTTPError as exc:
            response = exc
        with response:
            headers = response.headers
            raw = response.read()
            content_type = headers.get_content_type()
            if raw and content_type == "application/json":
                body = json.loads(raw)
            elif raw and content_type.startswith("text/"):
                body = raw.decode(headers.get_content_charset() or "utf-8")
            else:
                body = raw
            return response.status, headers, body

    DEV_ORIGIN = "http://localhost:5173"  # the Vite dev frontend; the only cross-origin caller allowed

    def get(self, path: str) -> tuple[int, HTTPMessage, Any]:
        return self._request(Request(self.base + path, headers={"Origin": self.DEV_ORIGIN}))

    def send_json(
        self, path: str, payload: dict[str, Any], method: str = "POST"
    ) -> tuple[int, HTTPMessage, Any]:
        return self._send_raw_json(path, json.dumps(payload).encode("utf-8"), method)

    def _send_raw_json(
        self, path: str, payload: bytes, method: str = "POST"
    ) -> tuple[int, HTTPMessage, Any]:
        request = Request(
            self.base + path,
            data=payload,
            headers={"Content-Type": "application/json", "Origin": self.DEV_ORIGIN},
            method=method,
        )
        return self._request(request)


class TestWebApi(WebServerTestCase):
    def test_health(self) -> None:
        status, headers, body = self.get("/api/health")
        self.assertEqual(status, 200)
        self.assertEqual(headers.get_content_type(), "application/json")
        self.assertEqual(headers["Access-Control-Allow-Origin"], self.DEV_ORIGIN)
        self.assertEqual(
            set(body),
            {"status", "mode", "version", "repo", "config_path", "providers", "quotas", "roles"},
        )
        self.assertEqual((body["status"], body["mode"], body["version"]), ("ok", "local", __version__))
        self.assertEqual(body["repo"], str(self.repo))
        self.assertEqual(body["config_path"], str(self.config_path))
        self.assertEqual(body["quotas"], [])
        self.assertEqual(set(body["providers"]["codex_sub"]), {"max_concurrency", "command"})
        role = body["roles"]["bulk_worker"]
        self.assertEqual(set(role), {"provider", "model", "fallback"})
        self.assertEqual(set(role["fallback"][0]), {"provider", "model"})

    def test_lists_eight_presets_with_graphs_and_validation(self) -> None:
        status, _, body = self.get("/api/presets")
        self.assertEqual(status, 200)
        self.assertCountEqual([row["id"] for row in body["presets"]], PRESET_IDS)
        for row in body["presets"]:
            with self.subTest(preset_id=row["id"]):
                self.assertEqual(row["graph"]["id"], row["id"])
                self.assertEqual(len(row["graph"]["nodes"]), row["node_count"])
                self.assertEqual(len(row["graph"]["edges"]), row["edge_count"])
                self.assertIs(row["valid"], True)
                self.assertEqual(row["errors"], [])
                self.assertIsInstance(row["warnings"], list)

    def test_preset_readiness_requires_health_and_keys_for_api_providers(self) -> None:
        status, _, body = self.get("/api/presets")

        self.assertEqual(status, 200)
        readiness = {
            row["id"]: (row["host_ready"], row["missing_providers"]) for row in body["presets"]
        }
        self.assertEqual(readiness["codex_only_3tier"], (True, []))
        self.assertEqual(readiness["claude_only_3tier"], (False, ["claude_sub"]))
        self.assertEqual(readiness["deepseek_bulk_factory"], (False, ["dsh_opencode"]))
        self.assertEqual(readiness["flagship_4tier"], (False, ["claude_sub", "dsh_opencode"]))

    def test_signed_in_subscription_presets_and_roles_are_ready_without_api_keys(self) -> None:
        self.provider_probe.side_effect = partial(
            credentials.probe_role_or_provider, health_checker=Mock(return_value=(True, "Logged in")),
        )

        status, _, presets = self.get("/api/presets")
        self.assertEqual(status, 200)
        presets_by_id = {row["id"]: row for row in presets["presets"]}
        status, _, config = self.get("/api/config/roles")
        self.assertEqual(status, 200)

        cases = (
            ("claude_sub", "claude_only_3tier", "tactical_planner"),
            ("codex_sub", "codex_only_3tier", "micro_orchestrator"),
        )
        for provider, preset_id, role in cases:
            with self.subTest(provider=provider):
                preset = presets_by_id[preset_id]
                self.assertIs(preset["host_ready"], True)
                self.assertEqual(preset["missing_providers"], [])
                catalog = [row for row in config["model_catalog"] if row["provider"] == provider]
                self.assertTrue(catalog)
                for row in catalog:
                    self.assertIs(row["ready"], True, row)

                status, _, doctor = self.send_json("/api/doctor/role", {"role": role})
                self.assertEqual(status, 200)
                self.assertEqual(doctor["provider"], provider)
                self.assertIs(doctor["ok"], True)
                self.assertEqual(doctor["install_hint"], "")

        self.assertEqual(presets_by_id["deepseek_bulk_factory"]["missing_providers"], ["dsh_opencode"])

    def test_default_provider_probes_are_cached_across_servers_for_sixty_seconds(self) -> None:
        with (
            patch.object(credentials, "probe_role_or_provider", side_effect=_fake_provider_probe) as probe,
            patch("vibebaton.web_server.monotonic", return_value=100.0) as clock,
        ):
            first, second = (
                self.start_server(create_server(self.repo, port=0, credentials_path=self.credentials_path))
                for _ in range(2)
            )
            self.assertEqual(self._request(Request(first + "/api/config/roles"))[0], 200)
            self.assertCountEqual([call.kwargs["provider"] for call in probe.call_args_list], [
                "claude_sub", "codex_sub", "dsh_opencode", "gemini_http",
            ])

            clock.return_value = 159.999
            self.assertEqual(self._request(Request(second + "/api/presets"))[0], 200)
            self.assertEqual(probe.call_count, 4)

            clock.return_value = 160.0
            self.assertEqual(self._request(Request(second + "/api/config/roles"))[0], 200)
            self.assertEqual(probe.call_count, 8)

    def test_flagship_preset_details(self) -> None:
        status, _, body = self.get("/api/presets/flagship_4tier")
        self.assertEqual(status, 200)
        self.assertEqual(body["preset"]["id"], "flagship_4tier")
        self.assertEqual(body["graph"]["id"], "flagship_4tier")
        validation = body["validation"]
        self.assertEqual(set(validation), {"valid", "errors", "warnings", "entry_nodes", "has_cycles"})
        self.assertIs(validation["valid"], True)
        self.assertIs(validation["has_cycles"], True)

    def test_unknown_preset_returns_json_not_found(self) -> None:
        status, headers, body = self.get("/api/presets/unknown_preset")
        self.assertEqual(status, 404)
        self.assertEqual(headers.get_content_type(), "application/json")
        self.assertIn("unknown_preset", body["error"])

    def test_validate_accepts_object_and_json_string(self) -> None:
        graph = _graph_payload()
        for payload in ({"graph": graph}, {"graph_json": json.dumps(graph)}):
            with self.subTest(payload=payload):
                status, _, body = self.send_json("/api/graph/validate", payload)
                self.assertEqual(status, 200)
                self.assertEqual(
                    body,
                    {"valid": True, "errors": [], "warnings": [], "entry_nodes": ["worker"], "has_cycles": False},
                )

    def test_validate_reports_unbounded_cycle(self) -> None:
        status, _, body = self.send_json("/api/graph/validate", {"graph": _unbounded_cycle()})
        self.assertEqual(status, 200)
        self.assertIs(body["valid"], False)
        self.assertIs(body["has_cycles"], True)
        self.assertTrue(any("Unbounded cycle" in error for error in body["errors"]), body)

    def test_validate_reports_malformed_input_as_a_result(self) -> None:
        for payload in (b"{", b"[]", b"\xff", b'{"graph_json":"{"}', b'{"graph_json":null}', b'{"graph":{}}'):
            with self.subTest(payload=payload):
                status, _, body = self._send_raw_json("/api/graph/validate", payload)
                self.assertEqual(status, 200)
                self.assertIs(body["valid"], False)
                self.assertEqual(len(body["errors"]), 1)
                self.assertTrue(body["errors"][0])
                self.assertEqual(body["warnings"], [])
                self.assertEqual(body["entry_nodes"], [])
                self.assertIs(body["has_cycles"], False)

    def test_validate_rejects_non_finite_json_numbers(self) -> None:
        for token in NON_FINITE_JSON_NUMBERS:
            graph_json = _cycle_json_with_loop_limit(token)
            payloads = {
                "graph": f'{{"graph": {graph_json}}}',
                "graph_json": json.dumps({"graph_json": graph_json}),
            }
            for field, payload in payloads.items():
                with self.subTest(field=field, token=token):
                    status, _, body = self._send_raw_json("/api/graph/validate", payload.encode("utf-8"))
                    self.assertEqual(status, 200)
                    self.assertIs(body["valid"], False)
                    self.assertEqual(len(body["errors"]), 1)
                    self.assertIn("JSON numbers must be finite", body["errors"][0])
                    self.assertEqual(body["entry_nodes"], [])
                    self.assertIs(body["has_cycles"], False)

    def test_graph_endpoints_accept_finite_loop_limit(self) -> None:
        graph = _unbounded_cycle()
        graph["nodes"][0]["config"] = {"max_loops": 2.0}
        graph["nodes"].append({"id": "final", "type": "human_gate_node", "label": "Final"})
        graph["edges"].append({"id": "pass", "source": "gate", "sourceHandle": "pass", "target": "final"})
        for field, value in {"graph": graph, "graph_json": json.dumps(graph)}.items():
            with self.subTest(field=field):
                status, _, body = self.send_json("/api/graph/validate", {field: value})
                self.assertEqual(status, 200)
                self.assertIs(body["valid"], True, body)
                self.assertIs(body["has_cycles"], True)

        status, _, body = self.send_json("/api/graph/simulate", {"graph": graph, "scenario": "gate_retry"})
        self.assertEqual(status, 200)
        self.assertEqual(body["status"], "completed")
        self.assertEqual(body["visited_nodes"], ["worker", "gate", "worker", "gate", "final"])

    def test_simulate_starter_in_each_scenario(self) -> None:
        paths = {
            "happy_path": ["plan", "worker", "gate", "final"],
            "gate_retry": ["plan", "worker", "gate", "worker", "gate", "final"],
            "escalate": ["plan", "worker", "gate", "final"],
        }
        for scenario, visited_nodes in paths.items():
            with self.subTest(scenario=scenario):
                status, _, body = self.send_json(
                    "/api/graph/simulate", {"preset_id": "starter_2tier", "scenario": scenario}
                )
                self.assertEqual(status, 200)
                self.assertEqual(set(body), {"status", "visited_nodes", "trace"})
                self.assertEqual(body["status"], "completed")
                self.assertEqual(body["visited_nodes"], visited_nodes)
                self.assertEqual(body["trace"][-1]["kind"], "graph_completed")

    def test_simulate_accepts_graph_object(self) -> None:
        status, _, body = self.send_json(
            "/api/graph/simulate", {"graph": _graph_payload(), "scenario": "happy_path"}
        )
        self.assertEqual(status, 200)
        self.assertEqual(body["visited_nodes"], ["worker", "gate"])

    def test_simulate_rejects_unknown_scenario(self) -> None:
        status, _, body = self.send_json(
            "/api/graph/simulate", {"preset_id": "starter_2tier", "scenario": "unknown"}
        )
        self.assertEqual(status, 400)
        self.assertIn("scenario", body["error"])

    def test_simulate_rejects_invalid_graph(self) -> None:
        status, _, body = self.send_json(
            "/api/graph/simulate", {"graph": _unbounded_cycle(), "scenario": "happy_path"}
        )
        self.assertEqual(status, 400)
        self.assertIn("Unbounded cycle", body["error"])

    def test_simulate_rejects_non_finite_json_numbers(self) -> None:
        for token in NON_FINITE_JSON_NUMBERS:
            with self.subTest(token=token):
                graph_json = _cycle_json_with_loop_limit(token)
                payload = f'{{"graph": {graph_json}, "scenario": "happy_path"}}'.encode("utf-8")
                status, _, body = self._send_raw_json("/api/graph/simulate", payload)
                self.assertEqual(status, 400)
                self.assertIn("JSON numbers must be finite", body["error"])

    def test_simulate_rejects_file_path_as_preset_id(self) -> None:
        private_graph = self.repo / "private.baton.json"
        private_graph.write_text(json.dumps(_graph_payload()), encoding="utf-8")
        status, _, body = self.send_json(
            "/api/graph/simulate", {"preset_id": str(private_graph), "scenario": "happy_path"}
        )
        self.assertEqual(status, 400)
        self.assertIn("Unknown preset ID", body["error"])

    def test_options_preflight(self) -> None:
        status, headers, body = self._request(
            Request(
                self.base + "/api/graph/simulate",
                headers={"Origin": "http://localhost:5173", "Access-Control-Request-Method": "POST"},
                method="OPTIONS",
            )
        )
        self.assertEqual(status, 204)
        self.assertEqual(headers["Access-Control-Allow-Origin"], self.DEV_ORIGIN)
        self.assertEqual(headers["Access-Control-Allow-Methods"], "GET, POST, PUT, OPTIONS")
        self.assertEqual(headers["Access-Control-Allow-Headers"], "Content-Type")
        self.assertEqual(body, b"")


class TestStaticHosting(WebServerTestCase):
    def _create_server(self) -> ThreadingHTTPServer:
        self.static_dir = self.repo / "dist"
        return create_server(self.repo, port=0, static_dir=self.static_dir, daemon_spawner=self.fake_spawner)

    def test_root_shows_build_notice_when_dist_is_missing(self) -> None:
        status, headers, body = self.get("/")
        self.assertEqual(status, 200)
        self.assertEqual(headers.get_content_type(), "text/html")
        self.assertIn("cd web && npm.cmd run build", unescape(body))

    def test_missing_dist_returns_204_for_favicon_ico(self) -> None:
        with urlopen(self.base + "/favicon.ico", timeout=5) as response:
            self.assertEqual(response.status, 204)
            self.assertEqual(response.read(), b"")

    def test_serves_favicon_svg_and_ico_with_expected_mime_types(self) -> None:
        self.static_dir.mkdir()
        (self.static_dir / "index.html").write_text("<h1>Canvas</h1>", encoding="utf-8")
        (self.static_dir / "favicon.svg").write_text("<svg/>", encoding="utf-8")
        ico_bytes = struct.pack("<HHH", 0, 1, 0)
        (self.static_dir / "favicon.ico").write_bytes(ico_bytes)

        with urlopen(self.base + "/favicon.svg", timeout=5) as response:
            self.assertEqual(response.status, 200)
            self.assertEqual(response.headers.get_content_type(), "image/svg+xml")
            self.assertEqual(response.read(), b"<svg/>")

        with urlopen(self.base + "/favicon.ico", timeout=5) as response:
            self.assertEqual(response.status, 200)
            self.assertEqual(response.headers.get_content_type(), "image/x-icon")
            self.assertEqual(response.read(), ico_bytes)

    def test_serves_index_and_static_asset_with_mime_types(self) -> None:
        self.static_dir.mkdir()
        (self.static_dir / "index.html").write_text("<h1>Canvas</h1>", encoding="utf-8")
        (self.static_dir / "app.js").write_text("export const canvas = true;", encoding="utf-8")

        status, headers, body = self.get("/")
        self.assertEqual((status, headers.get_content_type(), body), (200, "text/html", "<h1>Canvas</h1>"))
        status, headers, body = self.get("/app.js?v=1")
        self.assertEqual(
            (status, headers.get_content_type(), body), (200, "text/javascript", "export const canvas = true;")
        )

    def test_unknown_api_route_does_not_serve_static_file(self) -> None:
        api_dir = self.static_dir / "api"
        api_dir.mkdir(parents=True)
        (api_dir / "unknown").write_text("static content", encoding="utf-8")
        status, headers, body = self.get("/api/unknown")
        self.assertEqual(status, 404)
        self.assertEqual(headers.get_content_type(), "application/json")
        self.assertIn("error", body)

    def test_rejects_static_traversal(self) -> None:
        self.static_dir.mkdir()
        (self.repo / "pyproject.toml").write_text("outside the static directory", encoding="utf-8")
        for path in ("/../pyproject.toml", "/%2e%2e/pyproject.toml", "/%5c..%5cpyproject.toml"):
            with self.subTest(path=path):
                status, _, body = self.get(path)
                self.assertIn(status, (403, 404))
                self.assertIn("error", body)


class TestUiCommand(unittest.TestCase):
    def test_parser_accepts_ui_no_open(self) -> None:
        args = cli.build_parser().parse_args(["ui", "--no-open"])
        self.assertEqual(args.command, "ui")
        self.assertEqual((args.repo, args.host, args.port), (".", "127.0.0.1", 7860))
        self.assertIs(args.no_open, True)
        self.assertIs(args.func, cli.cmd_ui)

    def test_ui_prints_bound_url_and_closes_on_interrupt(self) -> None:
        with tempfile.TemporaryDirectory() as repo:
            for options in ([], ["--no-open"]):
                stdout = io.StringIO()
                with (
                    self.subTest(options=options),
                    redirect_stdout(stdout),
                    patch.object(VibeBatonWebServer, "serve_forever", autospec=True, side_effect=KeyboardInterrupt) as serve,
                    patch.object(cli.webbrowser, "open") as open_browser,
                ):
                    self.assertEqual(cli.main(["ui", "--repo", repo, "--port", "0", *options]), 0)
                    ui = serve.call_args.args[0]
                    port = ui.server.server_address[1]
                    self.assertGreater(port, 0)
                    self.assertEqual(stdout.getvalue(), f"Listening on http://127.0.0.1:{port}\n")
                    self.assertEqual(ui.server.socket.fileno(), -1)
                    if options:
                        open_browser.assert_not_called()
                    else:
                        open_browser.assert_called_once_with(ui.url)


class TestRoleConfigApi(WebServerTestCase):
    def test_reads_providers_and_roles_from_current_config(self) -> None:
        status, headers, body = self.get("/api/config/roles")
        self.assertEqual(status, 200)
        self.assertEqual(headers["Access-Control-Allow-Origin"], self.DEV_ORIGIN)
        self.assertEqual(set(body), {"config_path", "providers", "roles", "budget_profile", "model_catalog"})
        self.assertEqual(body["config_path"], str(self.config_path))
        self.assertEqual(set(body["providers"]["codex_sub"]), {"max_concurrency", "command"})
        self.assertEqual(set(body["roles"]["bulk_worker"]), {"provider", "model", "fallback"})
        self.assertEqual(body["budget_profile"], "balanced")
        self.assertIn({
            "provider": "codex_sub",
            "model": "gpt-6.2-sol@max",
            "efforts": ["low", "high", "max"],
            "cost_tier": "standard",
            "ready": True,
            "detail": "CLI available",
        }, body["model_catalog"])
        self.assertIn({
            "provider": "claude_sub",
            "model": "opus@high",
            "efforts": ["low", "high", "max"],
            "cost_tier": "flagship",
            "ready": False,
            "detail": "CLI unavailable",
        }, body["model_catalog"])

    def test_put_persists_the_bulk_worker_model_and_preserves_other_lines(self) -> None:
        header = b"[roles.bulk_worker]"
        before, bulk = self.config_path.read_bytes().split(header, 1)
        example_model_line = next(line for line in bulk.splitlines() if line.startswith(b"model ="))
        previous_model_line = b"model = 'previous#model'  # model comment"
        source = (
            before + header + bulk.replace(example_model_line, previous_model_line, 1)
            + b'\n[roles.bulk_worker_extra]\nprovider = "host_native"\n' + previous_model_line + b"\n"
        )
        self.config_path.write_bytes(source)
        _, _, initial = self.get("/api/config/roles")
        self.assertEqual(initial["roles"]["bulk_worker"]["model"], "previous#model")

        model = "deepseek-v4.1-flash@max"
        status, _, result = self.send_json(
            "/api/config/roles/bulk_worker", {"model": model}, method="PUT"
        )
        self.assertEqual(status, 200)
        self.assertEqual(
            result,
            {
                "role_name": "bulk_worker",
                "role": {**initial["roles"]["bulk_worker"], "model": model},
                "config_path": str(self.config_path),
            },
        )
        expected_line = b'model = "deepseek-v4.1-flash@max"  # model comment'
        self.assertEqual(self.config_path.read_bytes(), source.replace(previous_model_line, expected_line, 1))
        _, _, current = self.get("/api/config/roles")
        self.assertEqual(current["roles"], {**initial["roles"], "bulk_worker": result["role"]})

    def test_put_rejects_unknown_role(self) -> None:
        status, _, body = self.send_json(
            "/api/config/roles/missing", {"model": "example"}, method="PUT"
        )
        self.assertEqual(status, 404)
        self.assertIn("error", body)

    def test_put_rejects_unknown_provider_and_missing_or_empty_model(self) -> None:
        original = self.config_path.read_bytes()
        for payload in (
            {"model": "example", "provider": "missing"},
            {"provider": "host_native"},
            {"model": ""},
            {"model": "  "},
        ):
            with self.subTest(payload=payload):
                status, _, body = self.send_json("/api/config/roles/bulk_worker", payload, method="PUT")
                self.assertEqual(status, 400)
                self.assertIn("error", body)
        self.assertEqual(self.config_path.read_bytes(), original)


class TestExampleConfigApi(WebServerTestCase):
    def _create_server(self) -> ThreadingHTTPServer:
        self.config_path.unlink()
        return super()._create_server()

    def test_put_copies_packaged_config_to_the_repository_and_reloads_it(self) -> None:
        self.assertFalse(self.config_path.exists())
        example = self.example_path.read_bytes()
        _, _, initial = self.get("/api/config/roles")
        self.assertEqual(initial["config_path"], str(self.example_path))

        updates = {"provider": "host_native", "model": 'local-"model"#1 🚀'}
        status, _, result = self.send_json("/api/config/roles/bulk_worker", updates, method="PUT")
        self.assertEqual(status, 200)
        self.assertEqual(result["config_path"], str(self.config_path))
        self.assertEqual(result["role"], {**initial["roles"]["bulk_worker"], **updates})
        self.assertIn(b"# VibeBaton Configuration", self.config_path.read_bytes())
        self.assertEqual(self.example_path.read_bytes(), example)
        _, _, current = self.get("/api/config/roles")
        self.assertEqual(current["config_path"], str(self.config_path))
        self.assertEqual(current["roles"], {**initial["roles"], "bulk_worker": result["role"]})

    def test_budget_put_creates_a_local_override_from_the_active_toml(self) -> None:
        self.assertFalse(self.config_path.exists())
        example = self.example_path.read_bytes()
        _, _, initial = self.get("/api/config/roles")

        status, _, result = self.send_json("/api/config/budget", {"budget_profile": "eco"}, method="PUT")

        self.assertEqual(status, 200)
        self.assertEqual(result, {"budget_profile": "eco", "model_catalog": initial["model_catalog"]})
        self.assertEqual(self.example_path.read_bytes(), example)
        newline = b"\r\n" if b"\r\n" in example else b"\n"
        self.assertEqual(self.config_path.read_bytes(), example.replace(
            b"[policies]" + newline, b"[policies]" + newline + b'budget_profile = "eco"' + newline, 1,
        ))
        current = self.get("/api/config/roles")[2]
        self.assertEqual(current, {**initial, "config_path": str(self.config_path), "budget_profile": "eco"})


class TestBudgetConfigApi(WebServerTestCase):
    def test_budget_put_replaces_only_the_profile_value_and_reloads(self) -> None:
        old_line = b"\t'budget_profile'\t= 'eco' \t# budget comment"
        source = self.config_path.read_bytes().replace(b"\r\n", b"\n").replace(b"[policies]", (
            b'[ "policies" ] # policy comment\n' + old_line
        ), 1)
        source += b"\n[policies.other]\n" + old_line + b"\n"
        source = source.replace(b"\n", b"\r\n")
        self.config_path.write_bytes(source)

        status, headers, result = self.send_json(
            "/api/config/budget", {"budget_profile": "max_quality"}, method="PUT"
        )

        self.assertEqual(status, 200)
        self.assertEqual(headers["Access-Control-Allow-Origin"], self.DEV_ORIGIN)
        self.assertEqual(set(result), {"budget_profile", "model_catalog"})
        self.assertEqual(result["budget_profile"], "max_quality")
        self.assertEqual(self.config_path.read_bytes(), source.replace(
            old_line, b'\t\'budget_profile\'\t= "max_quality" \t# budget comment', 1,
        ))
        self.assertEqual(HotReloadConfig(self.config_path).current.policies.budget_profile, "max_quality")
        current = self.get("/api/config/roles")[2]
        self.assertEqual(current["budget_profile"], "max_quality")
        self.assertEqual(current["model_catalog"], result["model_catalog"])

    def test_budget_put_appends_a_missing_policy_table(self) -> None:
        source = b'# existing config\r\n[daemon]\r\npoll_interval_sec = 0.5 # keep this'
        self.config_path.write_bytes(source)

        status, _, result = self.send_json(
            "/api/config/budget", {"budget_profile": "balanced"}, method="PUT"
        )

        self.assertEqual(status, 200)
        self.assertEqual(result, {"budget_profile": "balanced", "model_catalog": []})
        self.assertEqual(self.config_path.read_bytes(), source + (
            b'\r\n\r\n[policies]\r\nbudget_profile = "balanced"\r\n'
        ))

    def test_budget_put_rejects_missing_or_invalid_values_without_writing(self) -> None:
        original = self.config_path.read_bytes()
        for payload in ({}, {"budget_profile": None}, {"budget_profile": True}, {"budget_profile": "fast"}):
            with self.subTest(payload=payload):
                status, _, body = self.send_json("/api/config/budget", payload, method="PUT")
                self.assertEqual(status, 400)
                self.assertIn("budget_profile", body["error"])
        self.assertEqual(self.config_path.read_bytes(), original)
        self.provider_probe.assert_not_called()


class TestDoctorApi(WebServerTestCase):
    def test_doctor_passes_the_selected_provider_role_and_model_to_a_fresh_probe(self) -> None:
        self.get("/api/config/roles")
        self.provider_probe.reset_mock()
        request = {"provider": "codex_sub", "role": "bulk_worker", "model": "gpt-6.2-sol@max"}

        status, _, result = self.send_json("/api/doctor/role", request)

        self.assertEqual(status, 200)
        self.assertEqual(result, {
            "ok": True,
            "provider": "codex_sub",
            "detail": "CLI available",
            "latency_ms": 0.25,
            "install_hint": "",
        })
        self.provider_probe.assert_called_once()
        self.assertEqual(self.provider_probe.call_args.kwargs, {**request, "credentials_path": self.credentials_path})

    def test_doctor_accepts_a_role_or_a_provider_and_reports_probe_failure(self) -> None:
        for request in ({"role": "tactical_planner"}, {"provider": "claude_sub"}):
            with self.subTest(request=request):
                status, _, result = self.send_json("/api/doctor/role", request)
                self.assertEqual(status, 200)
                self.assertEqual(result, {
                    "ok": False,
                    "provider": "claude_sub",
                    "detail": "CLI unavailable",
                    "latency_ms": 0.25,
                    "install_hint": "Check PATH",
                })

    def test_doctor_rejects_missing_selectors_and_non_string_fields(self) -> None:
        for payload, field in (
            ({}, "provider or role"),
            ({"model": "codex_sub:gpt-6.2-sol"}, "provider or role"),
            ({"provider": " ", "role": ""}, "provider or role"),
            ({"provider": 1}, "provider"),
            ({"role": []}, "role"),
            ({"role": "bulk_worker", "model": False}, "model"),
        ):
            with self.subTest(payload=payload):
                status, _, body = self.send_json("/api/doctor/role", payload)
                self.assertEqual(status, 400)
                self.assertIn(field, body["error"])
        self.provider_probe.assert_not_called()


class TestCredentialsApi(WebServerTestCase):
    def test_credentials_get_reports_an_empty_store(self) -> None:
        status, headers, result = self.get("/api/credentials")

        self.assertEqual(status, 200)
        self.assertEqual(headers["Access-Control-Allow-Origin"], self.DEV_ORIGIN)
        self.assertEqual(result, [
            {"provider_key": key, "configured": False, "source": "none", "masked": ""}
            for key in credentials.SUPPORTED_KEYS
        ])
        self.assertFalse(self.credentials_path.exists())

    def test_credentials_post_masks_both_sources_and_keeps_secrets_in_the_local_store(self) -> None:
        raw = "sk-file-credential-1234"
        env = "sk-environment-5678"
        os.environ["OPENAI_API_KEY"] = env
        config = self.config_path.read_bytes()
        workflow_path = self.repo / "example.baton.json"
        workflow_path.write_text(json.dumps(_graph_payload()), encoding="utf-8")
        workflow = workflow_path.read_bytes()

        status, _, saved = self.send_json("/api/credentials", {"updates": {
            "OPENAI_API_KEY": raw, "OPENCODE_API_KEY": raw,
        }})

        self.assertEqual(status, 200)
        self.assertIn({
            "provider_key": "OPENAI_API_KEY", "configured": True, "source": "env", "masked": "sk-e••••5678",
        }, saved)
        self.assertIn({
            "provider_key": "OPENCODE_API_KEY", "configured": True, "source": "local_file", "masked": "sk-f••••1234",
        }, saved)
        self.assertEqual(self.get("/api/credentials")[2], saved)
        self.assertNotIn(raw, json.dumps(saved))
        self.assertNotIn(env, json.dumps(saved))
        self.assertEqual(json.loads(self.credentials_path.read_text(encoding="utf-8")), {
            "OPENAI_API_KEY": raw, "OPENCODE_API_KEY": raw,
        })

        status, _, cleared = self.send_json("/api/credentials", {"OPENCODE_API_KEY": ""})
        self.assertEqual(status, 200)
        self.assertIn({
            "provider_key": "OPENCODE_API_KEY", "configured": False, "source": "none", "masked": "",
        }, cleared)
        self.assertEqual(self.get("/api/credentials")[2], cleared)
        self.assertEqual(self.config_path.read_bytes(), config)
        self.assertEqual(workflow_path.read_bytes(), workflow)

    def test_credentials_post_rejects_invalid_updates_without_writing_or_echoing(self) -> None:
        raw = "test-secret-value"
        for payload in (
            {"updates": {"OPENAI_API_KEY": raw, "UNKNOWN_KEY": raw}},
            {"updates": []},
            {"OPENAI_API_KEY": 123},
            {"OPENAI_API_KEY": raw + "\0"},
        ):
            with self.subTest(payload=payload):
                status, _, body = self.send_json("/api/credentials", payload)
                self.assertEqual(status, 400)
                self.assertEqual(set(body), {"error"})
                self.assertNotIn(raw, body["error"])
        self.assertFalse(self.credentials_path.exists())

    def test_credentials_post_refreshes_the_cached_provider_checks(self) -> None:
        self.get("/api/config/roles")
        self.provider_probe.reset_mock()

        self.assertEqual(self.send_json("/api/credentials", {"OPENAI_API_KEY": "test-credential"})[0], 200)
        self.assertEqual(self.get("/api/config/roles")[0], 200)
        self.assertEqual(self.provider_probe.call_count, 4)

    def test_credentials_post_cannot_write_into_the_served_repository(self) -> None:
        original = self.config_path.read_bytes()
        self.base = self.start_server(create_server(self.repo, port=0, credentials_path=self.config_path))

        status, _, body = self.send_json("/api/credentials", {"OPENAI_API_KEY": "test-credential"})

        self.assertEqual(status, 400)
        self.assertIn("outside the repository", body["error"])
        self.assertEqual(self.config_path.read_bytes(), original)


class TestRFCApi(WebServerTestCase):
    def test_brainstorm_generates_a_document_that_the_check_endpoint_can_score(self) -> None:
        request = {
            "goal": "Integrate local service configuration and verify its persistence after a reload.",
            "constraints": "Use the standard library and preserve TOML comments.",
            "acceptance_cmd": "python -m unittest discover -s tests -v",
            "non_goals": "Rewrite the canvas frontend.",
        }
        status, _, generated = self.send_json("/api/rfc/brainstorm", request)

        self.assertEqual(status, 200)
        self.assertEqual(set(generated), {"rfc_markdown", "readiness"})
        for value in request.values():
            self.assertIn(value, generated["rfc_markdown"])
        status, _, readiness = self.send_json("/api/rfc/check", {"rfc_markdown": generated["rfc_markdown"]})
        self.assertEqual(status, 200)
        self.assertEqual(readiness, generated["readiness"])
        self.assertEqual(readiness, {
            "score": 100,
            "safe_for_overnight": True,
            "missing_sections": [],
            "warnings": [],
            "detected_commands": ["python -m unittest"],
        })

    def test_rfc_routes_accept_incomplete_drafts_and_goal_only_brainstorms(self) -> None:
        status, _, result = self.send_json("/api/rfc/check", {"rfc_markdown": "# Draft\n\nTODO"})
        self.assertEqual(status, 200)
        self.assertIs(result["safe_for_overnight"], False)
        self.assertEqual(result["missing_sections"], ["goal", "constraints", "acceptance"])

        status, _, result = self.send_json("/api/rfc/brainstorm", {"goal": "Add tests"})
        self.assertEqual(status, 200)
        self.assertIn("Add tests", result["rfc_markdown"])
        self.assertIs(result["readiness"]["safe_for_overnight"], False)

    def test_rfc_routes_reject_missing_or_invalid_fields(self) -> None:
        for route, required in (("check", "rfc_markdown"), ("brainstorm", "goal")):
            for payload in ({}, {required: "  "}, {required: []}):
                with self.subTest(route=route, payload=payload):
                    status, _, body = self.send_json(f"/api/rfc/{route}", payload)
                    self.assertEqual(status, 400)
                    self.assertIn(required, body["error"])
        for field in ("constraints", "acceptance_cmd", "non_goals"):
            with self.subTest(field=field):
                status, _, body = self.send_json("/api/rfc/brainstorm", {"goal": "Add tests", field: []})
                self.assertEqual(status, 400)
                self.assertIn(field, body["error"])


class TestTomlRoleEditor(unittest.TestCase):
    def test_inserts_a_missing_key_after_the_exact_header_and_keeps_crlf(self) -> None:
        source = (
            "[roles.bulk_worker_extra]\r\n"
            "model = 'other'\r\n"
            "[roles.bulk_worker]  # role comment\r\n"
            "model\t= 'old # model'\t# model comment\r\n"
            "[roles.later]\r\n"
            "model = 'later'"
        )
        result = _set_toml_role_keys(
            source, "bulk_worker", {"provider": "host_native", "model": "new"}
        )
        self.assertEqual(
            result,
            "[roles.bulk_worker_extra]\r\n"
            "model = 'other'\r\n"
            "[roles.bulk_worker]  # role comment\r\n"
            'provider = "host_native"\r\n'
            'model\t= "new"\t# model comment\r\n'
            "[roles.later]\r\n"
            "model = 'later'",
        )


class TestRunApi(WebServerTestCase):
    RFC_MARKDOWN = "# Test RFC\n\nA canvas run.\n"

    def _start_run(self, **options: Any) -> str:
        status, _, result = self.send_json(
            "/api/runs/start", {"rfc_markdown": self.RFC_MARKDOWN, **options}
        )
        self.assertEqual(status, 201)
        self.assertEqual(set(result), {"run_id", "status", "daemon_pid"})
        self.assertEqual((result["status"], result["daemon_pid"]), ("STARTED", 4242))
        return result["run_id"]

    def test_latest_has_an_empty_snapshot_before_the_first_run(self) -> None:
        status, _, snapshot = self.get("/api/runs/latest")
        self.assertEqual(status, 200)
        self.assertEqual(
            snapshot,
            {"run": None, "milestones": [], "tasks": [], "events": [], "quotas": [], "telemetry": None},
        )

    def test_start_writes_rfc_and_records_mode_overrides_and_daemon_spawn(self) -> None:
        overrides = {"bulk_worker": "codex_sub:some-model"}
        run_id = self._start_run(mode="interactive", model_overrides=overrides)
        self.assertEqual(self.spawn_calls, [(self.repo, self.config_path, run_id)])

        status, _, snapshot = self.get(f"/api/runs/{run_id}")
        self.assertEqual(status, 200)
        self.assertEqual(set(snapshot), {"run", "milestones", "tasks", "events", "quotas", "telemetry"})
        self.assertIsNotNone(snapshot["telemetry"])
        self.assertIn("elapsed_sec", snapshot["telemetry"])
        run = snapshot["run"]
        self.assertEqual(run["id"], run_id)
        self.assertEqual(run["repo_path"], str(self.repo))
        self.assertEqual(run["mode"], "interactive")
        self.assertIsNone(run["plan_path"])
        self.assertEqual(json.loads(run["model_overrides_json"]), overrides)
        rfc_path = Path(run["rfc_path"])
        self.assertEqual(rfc_path.parent, self.repo / ".baton" / "ui_rfcs")
        self.assertRegex(rfc_path.name, r"^\d{8}-\d{6}-[0-9a-f]{4}\.md$")
        self.assertEqual(rfc_path.read_text(encoding="utf-8"), self.RFC_MARKDOWN)
        self.assertEqual([row["kind"] for row in snapshot["events"]], ["run_created", "daemon_spawned"])
        self.assertEqual(snapshot["events"][-1]["message"], "Detached daemon started (pid=4242)")
        self.assertEqual(self.get("/api/runs/latest")[2], snapshot)

    def test_run_snapshots_pass_through_billing_and_conflicts(self) -> None:
        run_id = self._start_run()
        store = StateStore(self.repo / ".baton" / "state.sqlite")
        store.log_event(
            run_id,
            "role_completed",
            actor="bulk_worker:flash",
            payload={
                "role": "bulk_worker",
                "provider": "deepseek_http",
                "model": "flash",
                "duration_sec": 2.0,
                "prompt_tokens": 80,
                "completion_tokens": 20,
            },
        )
        store.log_event(run_id, "merge_conflict_detected", task_id="M1-T1")
        expected = compute_run_telemetry(store, run_id)

        for path in (f"/api/runs/{run_id}", "/api/runs/latest"):
            with self.subTest(path=path):
                status, headers, snapshot = self.get(path)
                self.assertEqual(status, 200)
                self.assertEqual(headers.get_content_type(), "application/json")
                telemetry = snapshot["telemetry"]
                self.assertIs(telemetry["billing"]["has_exact_billing"], True)
                self.assertEqual(telemetry["billing"], expected["billing"])
                self.assertEqual(telemetry["conflicts"], expected["conflicts"])

    def test_start_accepts_an_existing_repository_relative_file(self) -> None:
        rfc = self.repo / "draft.md"
        rfc.write_text(self.RFC_MARKDOWN, encoding="utf-8")
        status, _, result = self.send_json("/api/runs/start", {"rfc_path": rfc.name})
        self.assertEqual(status, 201)
        run_id = result["run_id"]
        self.assertEqual(self.spawn_calls, [(self.repo, self.config_path, run_id)])
        _, _, snapshot = self.get(f"/api/runs/{run_id}")
        self.assertEqual(snapshot["run"]["rfc_path"], str(rfc))
        self.assertEqual(snapshot["run"]["mode"], "overnight")

    def test_start_rejects_paths_outside_the_repository_without_creating_a_run(self) -> None:
        with tempfile.TemporaryDirectory() as outside:
            outside_rfc = Path(outside) / "outside.md"
            outside_rfc.write_text("# Outside the repository", encoding="utf-8")
            for path in ("../../pyproject.toml", str(outside_rfc)):
                with self.subTest(path=path):
                    status, _, body = self.send_json("/api/runs/start", {"rfc_path": path})
                    self.assertEqual(status, 400)
                    self.assertIn("error", body)
        self.assertEqual(self.spawn_calls, [])
        self.assertIsNone(self.get("/api/runs/latest")[2]["run"])

    def test_start_rejects_missing_rfc_and_invalid_metadata(self) -> None:
        for payload in (
            {},
            {"rfc_path": "missing.md"},
            {"rfc_path": ".baton"},
            {"rfc_markdown": self.RFC_MARKDOWN, "mode": "bogus"},
            {"rfc_markdown": self.RFC_MARKDOWN, "model_overrides": {"bulk_worker": 1}},
        ):
            with self.subTest(payload=payload):
                status, _, body = self.send_json("/api/runs/start", payload)
                self.assertEqual(status, 400)
                self.assertIn("error", body)
        self.assertFalse((self.repo / ".baton" / "ui_rfcs").exists())
        self.assertEqual(self.spawn_calls, [])

    def test_start_records_a_spawn_failure_on_the_run(self) -> None:
        with patch.object(self.server, "daemon_spawner", side_effect=OSError("cannot launch")):
            status, _, response = self.send_json("/api/runs/start", {"rfc_markdown": self.RFC_MARKDOWN})
        self.assertEqual(status, 500)
        _, _, snapshot = self.get(f"/api/runs/{response['run_id']}")
        self.assertEqual(snapshot["run"]["status"], "FAILED")
        self.assertEqual(snapshot["events"][-1]["kind"], "daemon_spawn_failed")

    def test_report_returns_battle_report_markdown(self) -> None:
        run_id = self._start_run()
        status, _, report = self.get(f"/api/runs/{run_id}/report")
        self.assertEqual(status, 200)
        self.assertEqual(set(report), {"run_id", "battle_report_markdown"})
        self.assertEqual(report["run_id"], run_id)
        self.assertTrue(report["battle_report_markdown"].startswith("# VibeBaton Run Report"))

        status_zh, _, report_zh = self.get(f"/api/runs/{run_id}/report?lang=zh")
        self.assertEqual(status_zh, 200)
        self.assertIn("# VibeBaton 运行战报", report_zh["battle_report_markdown"])
        self.assertIn("## 效率与防线战绩", report_zh["battle_report_markdown"])

    def test_list_runs_returns_recent_runs_with_counts_and_elapsed(self) -> None:
        first = self._start_run()
        second = self._start_run()
        status, _, payload = self.get("/api/runs")
        self.assertEqual(status, 200)
        ids = [row["id"] for row in payload["runs"]]
        self.assertIn(first, ids)
        self.assertIn(second, ids)
        for row in payload["runs"]:
            self.assertIn("elapsed_sec", row)
            self.assertIn("passed_tasks", row)
            self.assertIn("total_tasks", row)

    def test_control_pauses_and_resumes_and_rejects_other_actions(self) -> None:
        run_id = self._start_run()
        self.spawn_calls.clear()
        run_path = f"/api/runs/{run_id}"
        path = f"{run_path}/control"

        status, _, response = self.send_json(path, {"action": "pause"})
        self.assertEqual(status, 200)
        self.assertEqual(response, {"run_id": run_id, "status": "PAUSED"})
        self.assertEqual(self.spawn_calls, [])
        _, _, snapshot = self.get(run_path)
        self.assertEqual(snapshot["run"]["status"], "PAUSED")
        self.assertEqual(snapshot["events"][-1]["kind"], "run_paused")

        status, _, response = self.send_json(path, {"action": "resume"})
        self.assertEqual(status, 200)
        self.assertEqual(self.spawn_calls, [(self.repo, self.config_path, run_id)])
        self.assertEqual(response, {"run_id": run_id, "status": "RUNNING", "daemon_pid": 4242})
        _, _, snapshot = self.get(run_path)
        self.assertEqual(snapshot["run"]["status"], "RUNNING")
        self.assertEqual(
            [event["kind"] for event in snapshot["events"][-2:]],
            ["run_resumed", "daemon_spawned"],
        )

        self.assertEqual(self.send_json(path, {"action": "bogus"})[0], 400)
        self.assertEqual(self.spawn_calls, [(self.repo, self.config_path, run_id)])

    def test_control_resume_leaves_the_run_paused_when_daemon_launch_fails(self) -> None:
        run_id = self._start_run()
        self.spawn_calls.clear()
        path = f"/api/runs/{run_id}/control"
        self.assertEqual(self.send_json(path, {"action": "pause"})[0], 200)

        with patch.object(self.server, "daemon_spawner", side_effect=OSError("cannot launch")) as spawner:
            status, _, response = self.send_json(path, {"action": "resume"})
        spawner.assert_called_once_with(self.repo, self.config_path, run_id)
        self.assertEqual(status, 500)
        self.assertEqual(response["run_id"], run_id)
        self.assertIn("cannot launch", response["error"])
        _, _, snapshot = self.get(f"/api/runs/{run_id}")
        self.assertEqual(snapshot["run"]["status"], "PAUSED")
        self.assertEqual(
            [event["kind"] for event in snapshot["events"][-2:]],
            ["run_resumed", "daemon_spawn_failed"],
        )

        status, _, response = self.send_json(path, {"action": "resume"})
        self.assertEqual(status, 200)
        self.assertEqual(response, {"run_id": run_id, "status": "RUNNING", "daemon_pid": 4242})
        self.assertEqual(self.spawn_calls, [(self.repo, self.config_path, run_id)])

    def test_resolve_records_decisions_and_respawns_only_on_approval(self) -> None:
        run_id = self._start_run()
        path = f"/api/runs/{run_id}/resolve"
        self.assertEqual(self.send_json(path, {"decision": "bogus"})[0], 400)
        for decision, pid, expected in (("reject", None, "PAUSED"), ("approve", 4242, "RUNNING")):
            with self.subTest(decision=decision):
                note = f"Human chose {decision}"
                status, _, response = self.send_json(path, {"decision": decision, "note": note})
                self.assertEqual(status, 200)
                self.assertEqual(response, {"run_id": run_id, "decision": decision, "daemon_pid": pid})
                _, _, snapshot = self.get(f"/api/runs/{run_id}")
                self.assertEqual(snapshot["run"]["status"], expected)
                recorded = json.loads(snapshot["run"]["human_decision"])
                self.assertEqual((recorded["decision"], recorded["note"]), (decision, note))
                self.assertEqual(self.spawn_calls, [(self.repo, self.config_path, run_id)] * (1 if pid is None else 2))

    def test_run_endpoints_return_not_found_for_an_unknown_run(self) -> None:
        for response in (
            self.get("/api/runs/missing"),
            self.get("/api/runs/missing/report"),
            self.send_json("/api/runs/missing/control", {"action": "pause"}),
            self.send_json("/api/runs/missing/resolve", {"decision": "approve"}),
        ):
            status, _, body = response
            self.assertEqual(status, 404)
            self.assertIn("error", body)
        self.assertEqual(self.spawn_calls, [])

    def test_stream_once_writes_exactly_one_snapshot_frame_and_closes(self) -> None:
        run_id = self._start_run()
        status, headers, body = self.get("/api/runs/stream?once=1")
        self.assertEqual(status, 200)
        self.assertEqual(headers.get_content_type(), "text/event-stream")
        self.assertEqual(headers["Cache-Control"], "no-cache")
        self.assertEqual(headers["Connection"], "keep-alive")
        self.assertEqual(headers["Access-Control-Allow-Origin"], self.DEV_ORIGIN)
        event, data, *ending = body.split("\n")
        self.assertEqual(event, "event: snapshot")
        self.assertTrue(data.startswith("data: "))
        self.assertEqual(ending, ["", ""])
        snapshot = json.loads(data.removeprefix("data: "))
        self.assertEqual(set(snapshot), {"run", "milestones", "tasks", "events", "quotas", "telemetry"})
        self.assertEqual(snapshot["run"]["id"], run_id)

    def _read_sse_frame(self, stream: HTTPResponse) -> tuple[bytes, dict[str, Any]]:
        event = stream.readline().removesuffix(b"\n")
        data = stream.readline().removesuffix(b"\n")
        self.assertTrue(event.startswith(b"event: "))
        self.assertTrue(data.startswith(b"data: "))
        self.assertEqual(stream.readline(), b"\n")
        return event.removeprefix(b"event: "), json.loads(data.removeprefix(b"data: "))

    def test_live_stream_emits_status_changes_and_new_events_then_closes_on_shutdown(self) -> None:
        run_id = self._start_run()
        store = StateStore(self.repo / ".baton" / "state.sqlite")
        for _ in range(100):
            store.log_event(run_id, "prior_event")

        with urlopen(self.base + "/api/runs/stream", timeout=5) as stream:
            event, initial = self._read_sse_frame(stream)
            self.assertEqual(event, b"snapshot")
            self.assertEqual(len(initial["events"]), 102)

            store.update_run_status(run_id, RunStatus.RUNNING)
            event, status_change = self._read_sse_frame(stream)
            self.assertEqual(event, b"snapshot")
            self.assertEqual(status_change["run"]["status"], "RUNNING")
            self.assertEqual(status_change["events"], initial["events"])

            store.log_event(run_id, "new_event")
            event, update = self._read_sse_frame(stream)
            self.assertEqual(event, b"snapshot")
            self.assertEqual(update["events"][:-1], initial["events"])
            event, row = self._read_sse_frame(stream)
            self.assertEqual(event, b"event")
            self.assertEqual(row, update["events"][-1])
            self.assertEqual(row["kind"], "new_event")

            self.server.shutdown()
            self.assertEqual(stream.read(), b"")

    def test_live_stream_emits_on_task_status_and_quota_change_without_tick_churn(self) -> None:
        run_id = self._start_run()
        store = StateStore(self.repo / ".baton" / "state.sqlite")
        store.register_plan(
            run_id,
            PlanDAG(
                rfc_version="1.0",
                complexity_tier="simple",
                milestones=[
                    MilestoneSpec(
                        id="M1",
                        title="Milestone 1",
                        tasks=[TaskSpec(id="M1-T1", title="Build widget")],
                    )
                ],
            ),
        )

        with urlopen(self.base + "/api/runs/stream", timeout=5) as stream:
            event, initial = self._read_sse_frame(stream)
            self.assertEqual(event, b"snapshot")
            self.assertEqual(initial["tasks"][0]["status"], "PENDING")
            initial_updated_at = initial["run"]["updated_at"]

            # Changing a task status without advancing run.updated_at must still emit an SSE snapshot.
            store.update_task(run_id, "M1-T1", status=TaskStatus.RUNNING, attempts=1)
            event, task_update = self._read_sse_frame(stream)
            self.assertEqual(event, b"snapshot")
            self.assertEqual(task_update["run"]["updated_at"], initial_updated_at)
            self.assertEqual(task_update["tasks"][0]["status"], "RUNNING")
            self.assertEqual(task_update["tasks"][0]["attempts"], 1)

            # Triggering a provider quota cooldown without touching the run row must emit an SSE snapshot.
            store.trigger_provider_cooldown("dsh_opencode", [60], "429 rate limit", explicit_wait_sec=45.0)
            event, quota_update = self._read_sse_frame(stream)
            self.assertEqual(event, b"snapshot")
            self.assertEqual(quota_update["run"]["updated_at"], initial_updated_at)
            self.assertEqual(quota_update["quotas"][0]["provider"], "dsh_opencode")
            self.assertEqual(quota_update["quotas"][0]["cooldown_hits"], 1)

            # Purely ticking remaining_sec with unchanged state must keep the stream idle (no spurious frame).
            sig_t0 = _CanvasRequestHandler._sse_snapshot_signature(
                {**quota_update, "quotas": [{**quota_update["quotas"][0], "remaining_sec": 44.8}]}
            )
            sig_t1 = _CanvasRequestHandler._sse_snapshot_signature(
                {**quota_update, "quotas": [{**quota_update["quotas"][0], "remaining_sec": 43.2}]}
            )
            self.assertEqual(sig_t0, sig_t1)

            stream.fp.raw._sock.settimeout(1.3)
            with self.assertRaises((TimeoutError, socket.timeout)):
                stream.readline()

            self.server.shutdown()


if __name__ == "__main__":
    unittest.main()
