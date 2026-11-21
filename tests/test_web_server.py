"""HTTP contract tests for the VibeBaton canvas server."""

from __future__ import annotations

import io
import json
import shutil
import tempfile
import threading
import unittest
from contextlib import redirect_stdout
from html import unescape
from http.client import HTTPMessage, HTTPResponse
from http.server import ThreadingHTTPServer
from pathlib import Path
from typing import Any
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from vibebaton import __version__, cli
from vibebaton.db import StateStore
from vibebaton.schemas import RunStatus
from vibebaton.web_server import VibeBatonWebServer, _set_toml_role_keys, create_server

PRESET_IDS = ("flagship_4tier", "review_only_audit", "solo_coder_3tier", "starter_2tier")
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

        self.server = self._create_server()
        self.base = f"http://127.0.0.1:{self.server.server_address[1]}"
        self.thread = threading.Thread(
            target=self.server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True
        )
        self.thread.start()

    def _create_server(self) -> ThreadingHTTPServer:
        return create_server(self.repo, port=0, daemon_spawner=self.fake_spawner)

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

    def get(self, path: str) -> tuple[int, HTTPMessage, Any]:
        return self._request(Request(self.base + path))

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
            headers={"Content-Type": "application/json"},
            method=method,
        )
        return self._request(request)

    def tearDown(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)


class TestWebApi(WebServerTestCase):
    def test_health(self) -> None:
        status, headers, body = self.get("/api/health")
        self.assertEqual(status, 200)
        self.assertEqual(headers.get_content_type(), "application/json")
        self.assertEqual(headers["Access-Control-Allow-Origin"], "*")
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

    def test_lists_four_presets_with_graphs_and_validation(self) -> None:
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
        self.assertEqual(headers["Access-Control-Allow-Origin"], "*")
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
        self.assertEqual(headers["Access-Control-Allow-Origin"], "*")
        self.assertEqual(set(body), {"config_path", "providers", "roles"})
        self.assertEqual(body["config_path"], str(self.config_path))
        self.assertEqual(set(body["providers"]["codex_sub"]), {"max_concurrency", "command"})
        self.assertEqual(set(body["roles"]["bulk_worker"]), {"provider", "model", "fallback"})

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
        self.assertEqual(snapshot, {"run": None, "milestones": [], "tasks": [], "events": [], "quotas": []})

    def test_start_writes_rfc_and_records_mode_overrides_and_daemon_spawn(self) -> None:
        overrides = {"bulk_worker": "codex_sub:some-model"}
        run_id = self._start_run(mode="interactive", model_overrides=overrides)
        self.assertEqual(self.spawn_calls, [(self.repo, self.config_path, run_id)])

        status, _, snapshot = self.get(f"/api/runs/{run_id}")
        self.assertEqual(status, 200)
        self.assertEqual(set(snapshot), {"run", "milestones", "tasks", "events", "quotas"})
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
        self.assertEqual(headers["Access-Control-Allow-Origin"], "*")
        event, data, *ending = body.split("\n")
        self.assertEqual(event, "event: snapshot")
        self.assertTrue(data.startswith("data: "))
        self.assertEqual(ending, ["", ""])
        snapshot = json.loads(data.removeprefix("data: "))
        self.assertEqual(set(snapshot), {"run", "milestones", "tasks", "events", "quotas"})
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


if __name__ == "__main__":
    unittest.main()
