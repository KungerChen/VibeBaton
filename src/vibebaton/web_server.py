"""Local HTTP API and static hosting for the VibeBaton canvas."""

from __future__ import annotations

import json
import math
import mimetypes
import os
import re
import shutil
import tempfile
import threading
import time
import tomllib
import uuid
from dataclasses import asdict
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Callable, Mapping, TypedDict
from urllib.parse import parse_qs, unquote, urlsplit

from . import __version__, presets
from .config import HotReloadConfig, RoleConfig, find_config_path
from .db import StateStore
from .graph_engine import SCENARIOS, simulate_graph
from .graph_schema import GraphValidationResult, WorkflowGraph, validate_graph
from .mcp_server import _spawn_detached_daemon
from .report import generate_battle_report
from .schemas import RunStatus

# Capture groups are passed to the handler as positional arguments. The full
# request target, including the query string, remains available in self.path.
ROUTES: list[tuple[str, re.Pattern[str], str]] = [
    ("GET", re.compile(r"/api/health"), "_get_health"),
    ("GET", re.compile(r"/api/presets"), "_get_presets"),
    ("GET", re.compile(r"/api/presets/([^/]+)"), "_get_preset"),
    ("POST", re.compile(r"/api/graph/validate"), "_post_graph_validate"),
    ("POST", re.compile(r"/api/graph/simulate"), "_post_graph_simulate"),
    ("GET", re.compile(r"/api/config/roles"), "_get_config_roles"),
    ("PUT", re.compile(r"/api/config/roles/([^/]+)"), "_put_config_role"),
    ("GET", re.compile(r"/api/runs/latest"), "_get_latest_run"),
    ("GET", re.compile(r"/api/runs/stream"), "_get_run_stream"),
    ("GET", re.compile(r"/api/runs/([^/]+)"), "_get_run"),
    ("GET", re.compile(r"/api/runs/([^/]+)/report"), "_get_run_report"),
    ("POST", re.compile(r"/api/runs/start"), "_post_run_start"),
    ("POST", re.compile(r"/api/runs/([^/]+)/control"), "_post_run_control"),
    ("POST", re.compile(r"/api/runs/([^/]+)/resolve"), "_post_run_resolve"),
]

_TOML_ROLE_KEY_LINE = re.compile(
    r"""(?P<assignment>[ \t]*(?P<quote>["']?)(?P<key>provider|model)(?P=quote)[ \t]*=[ \t]*)"""
    r"""(?:"{3}(?:[^\\]|\\.)*?"{3,5}|'{3}.*?'{3,5}|"(?:[^"\\]|\\.)*"|'[^']*'|[^#"']*?)"""
    r"""(?P<suffix>[ \t]*(?:#.*)?)"""
)

_STATIC_MIME_TYPES = {
    ".html": "text/html",
    ".js": "text/javascript",
    ".css": "text/css",
    ".svg": "image/svg+xml",
    ".json": "application/json",
    ".png": "image/png",
    ".ico": "image/x-icon",
    ".map": "application/json",
    ".woff2": "font/woff2",
}
_BUILD_NOTICE = b"""<!doctype html>
<html lang="en">
<meta charset="utf-8">
<title>VibeBaton Canvas</title>
<h1>Build the VibeBaton Canvas</h1>
<p>Run <code>cd web &amp;&amp; npm.cmd run build</code> from the project root,
then reload this page.</p>
</html>
"""


class _BadRequest(ValueError):
    """A request error serialized by the dispatcher as a JSON 400."""


class _RunSnapshot(TypedDict):
    run: dict[str, Any] | None
    milestones: list[dict[str, Any]]
    tasks: list[dict[str, Any]]
    events: list[dict[str, Any]]
    quotas: list[dict[str, Any]]


def _parse_finite_float(token: str) -> float:
    value = float(token)
    if not math.isfinite(value):
        raise ValueError("JSON numbers must be finite")
    return value


def _load_json(data: str | bytes | bytearray) -> Any:
    return json.loads(data, parse_constant=_parse_finite_float, parse_float=_parse_finite_float)


def _find_preset(preset_id: str) -> presets.PresetSummary:
    for summary in presets.list_presets():
        if summary.id == preset_id:
            return summary
    raise FileNotFoundError(f"Unknown preset ID {preset_id!r}")


def _role_payload(role: RoleConfig) -> dict[str, Any]:
    return {
        "provider": role.provider,
        "model": role.model,
        "fallback": [asdict(target) for target in role.fallback],
    }


def _config_roles_payload(loader: HotReloadConfig) -> dict[str, Any]:
    config = loader.current
    return {
        "config_path": str(loader.path),
        "providers": {
            name: {"max_concurrency": provider.max_concurrency, "command": provider.command}
            for name, provider in config.providers.items()
        },
        "roles": {name: _role_payload(role) for name, role in config.roles.items()},
    }


def _set_toml_role_keys(text: str, role: str, updates: dict[str, str]) -> str:
    """Replace role values in a TOML table while retaining its original formatting."""
    lines = text.split("\n")
    header = re.compile(rf"[ \t]*\[roles\.{re.escape(role)}\][ \t]*(?:#.*)?")
    for index, line in enumerate(lines):
        if header.fullmatch(line.removesuffix("\r")):
            start = index
            break
    else:
        raise ValueError(f"Missing [roles.{role}] section")

    # JSON basic string escapes also work in TOML. TOML additionally requires escaping DEL.
    pending = {
        key: json.dumps(value, ensure_ascii=False).replace("\x7f", r"\u007f")
        for key, value in updates.items()
    }
    for index in range(start + 1, len(lines)):
        line = lines[index]
        if line.lstrip(" \t").startswith("["):
            break
        match = _TOML_ROLE_KEY_LINE.fullmatch(line.removesuffix("\r"))
        if match is None or match["key"] not in pending:
            continue
        value = pending.pop(match["key"])
        carriage_return = "\r" if line.endswith("\r") else ""
        lines[index] = match["assignment"] + value + match["suffix"] + carriage_return

    carriage_return = "\r" if lines[start].endswith("\r") else ""
    lines[start + 1 : start + 1] = [
        f"{key} = {value}{carriage_return}" for key, value in pending.items()
    ]
    return "\n".join(lines)


def _replace_config_file(path: Path, contents: bytes) -> None:
    """Publish a complete TOML file so concurrent daemon reads see a valid version."""
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary_path = None
    try:
        with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as temporary:
            temporary_path = Path(temporary.name)
            temporary.write(contents)
        if os.name != "nt" and path.exists():
            shutil.copymode(path, temporary_path)
        temporary_path.replace(path)
    finally:
        if temporary_path is not None:
            temporary_path.unlink(missing_ok=True)


def _run_snapshot(store: StateStore, run_id: str | None) -> _RunSnapshot:
    run = store.get_run(run_id) if run_id is not None else None
    if run is None:
        return {"run": None, "milestones": [], "tasks": [], "events": [], "quotas": []}
    return {
        "run": run,
        "milestones": store.get_milestones(run["id"]),
        "tasks": store.get_tasks(run["id"]),
        # SQLite LIMIT -1 retains the full append-only history for SSE.
        "events": store.get_events(run["id"], limit=-1),
        "quotas": store.get_all_quotas(),
    }


def _latest_run_snapshot(store: StateStore) -> _RunSnapshot:
    run = store.get_latest_run()
    return _run_snapshot(store, run["id"] if run is not None else None)


def _resolve_rfc_path(repo: Path, supplied_path: str) -> Path:
    try:
        path = (repo / supplied_path).resolve()
        if path.is_relative_to(repo) and path.is_file():
            return path
    except (OSError, RuntimeError, ValueError) as exc:
        raise _BadRequest("Invalid RFC path") from exc
    raise _BadRequest("rfc_path must point to an existing file inside the repository")


def _save_ui_rfc(repo: Path, markdown: str) -> Path:
    try:
        contents = markdown.encode("utf-8")
    except UnicodeEncodeError as exc:
        raise _BadRequest("rfc_markdown must be valid UTF-8 text") from exc
    directory = (repo / ".baton" / "ui_rfcs").resolve()
    if not directory.is_relative_to(repo):
        raise _BadRequest("The UI RFC directory must be inside the repository")
    directory.mkdir(parents=True, exist_ok=True)
    while True:
        path = directory / f"{time.strftime('%Y%m%d-%H%M%S')}-{uuid.uuid4().hex[:4]}.md"
        try:
            output = path.open("xb")
        except FileExistsError:
            continue
        try:
            with output:
                output.write(contents)
        except OSError:
            path.unlink(missing_ok=True)
            raise
        return path


class _CanvasHTTPServer(ThreadingHTTPServer):
    repo_path: Path
    loader: HotReloadConfig
    store: StateStore
    static_dir: Path
    daemon_spawner: Callable[[Path, Path, str], int] | None

    def __init__(self, address: tuple[str, int]) -> None:
        self.shutdown_event = threading.Event()
        self.config_lock = threading.Lock()
        self._lifecycle_lock = threading.Lock()
        self._serving = False
        super().__init__(address, _CanvasRequestHandler)

    def serve_forever(self, poll_interval: float = 0.5) -> None:
        try:
            with self._lifecycle_lock:
                if self.shutdown_event.is_set():
                    return
                self._serving = True
            super().serve_forever(poll_interval)
        finally:
            with self._lifecycle_lock:
                self._serving = False
                self.shutdown_event.set()

    def shutdown(self) -> None:
        # BaseServer.shutdown blocks until its serving loop exits.
        with self._lifecycle_lock:
            self.shutdown_event.set()
            serving = self._serving
        if serving:
            super().shutdown()


class _CanvasRequestHandler(BaseHTTPRequestHandler):
    server: _CanvasHTTPServer

    def _send_cors_headers(self) -> None:
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PUT, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def _send_bytes(self, status: int, content_type: str, body: bytes, *, cors: bool = False) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        if cors:
            self._send_cors_headers()
        self.end_headers()
        self.wfile.write(body)

    def _send_json(self, status: int, payload: Mapping[str, Any]) -> None:
        self._send_bytes(status, "application/json", json.dumps(dict(payload)).encode("utf-8"), cors=True)

    def _read_json_body(self) -> dict[str, Any]:
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError as exc:
            raise _BadRequest("Invalid Content-Length") from exc
        if length <= 0:
            raise _BadRequest("A JSON request body is required")

        body = bytearray()
        while len(body) < length:
            chunk = self.rfile.read(min(length - len(body), 64 * 1024))
            if not chunk:
                raise _BadRequest("Incomplete JSON request body")
            body.extend(chunk)
        try:
            payload = _load_json(body)
        except (ValueError, RecursionError) as exc:
            raise _BadRequest(f"Invalid JSON request body: {exc}") from exc
        if not isinstance(payload, dict):
            raise _BadRequest("Request body must be a JSON object")
        return payload

    def do_OPTIONS(self) -> None:
        self.send_response(204)
        self._send_cors_headers()
        self.end_headers()

    def _dispatch(self) -> None:
        try:
            raw_path = urlsplit(self.path).path
        except ValueError:
            self._send_json(400, {"error": "Invalid request path"})
            return
        path = unquote(raw_path)
        for method, pattern, handler_name in ROUTES:
            if self.command != method:
                continue
            match = pattern.fullmatch(path)
            if match is not None:
                try:
                    getattr(self, handler_name)(*match.groups())
                except _BadRequest as exc:
                    self._send_json(400, {"error": str(exc)})
                return
        if self.command == "GET" and path != "/api" and not path.startswith("/api/"):
            self._serve_static(raw_path, path)
        else:
            self._send_json(404, {"error": "Route not found"})

    do_GET = _dispatch
    do_POST = _dispatch
    do_PUT = _dispatch

    def _get_health(self) -> None:
        with self.server.config_lock:
            config = _config_roles_payload(self.server.loader)
        self._send_json(
            200,
            {
                "status": "ok",
                "mode": "local",
                "version": __version__,
                "repo": str(self.server.repo_path),
                **config,
                "quotas": self.server.store.get_all_quotas(),
            },
        )

    def _get_presets(self) -> None:
        rows = []
        for summary in presets.list_presets():
            graph = presets.load_preset(summary.path)
            validation = validate_graph(graph)
            rows.append(
                {
                    **summary.to_dict(),
                    "valid": validation.valid,
                    "errors": validation.errors,
                    "warnings": validation.warnings,
                    "graph": graph.to_dict(),
                }
            )
        self._send_json(200, {"presets": rows})

    def _get_preset(self, preset_id: str) -> None:
        try:
            summary = _find_preset(preset_id)
            graph = presets.load_preset(summary.path)
        except FileNotFoundError as exc:
            self._send_json(404, {"error": str(exc)})
            return
        self._send_json(
            200,
            {
                "preset": summary.to_dict(),
                "graph": graph.to_dict(),
                "validation": asdict(validate_graph(graph)),
            },
        )

    def _post_graph_validate(self) -> None:
        try:
            payload = self._read_json_body()
            if "graph" in payload:
                graph_data = payload["graph"]
            elif isinstance(payload.get("graph_json"), str):
                graph_data = _load_json(payload["graph_json"])
            else:
                raise _BadRequest("Provide a graph object or a graph_json string")
            validation = validate_graph(WorkflowGraph.from_dict(graph_data))
        except (ValueError, RecursionError) as exc:
            validation = GraphValidationResult(
                valid=False, errors=[str(exc)], warnings=[], entry_nodes=[], has_cycles=False
            )
        self._send_json(200, asdict(validation))

    def _post_graph_simulate(self) -> None:
        payload = self._read_json_body()
        try:
            if "graph" in payload:
                graph = WorkflowGraph.from_dict(payload["graph"])
            elif isinstance(payload.get("preset_id"), str):
                graph = presets.load_preset(_find_preset(payload["preset_id"]).path)
            else:
                raise ValueError("Provide a graph object or a preset_id string")
        except (FileNotFoundError, ValueError, RecursionError) as exc:
            raise _BadRequest(str(exc)) from exc

        validation = validate_graph(graph)
        if not validation.valid:
            raise _BadRequest("\n".join(validation.errors))
        scenario = payload.get("scenario")
        if not isinstance(scenario, str) or scenario not in SCENARIOS:
            raise _BadRequest(f"Unknown simulation scenario. Choose from {', '.join(SCENARIOS)}.")

        result = simulate_graph(graph, scenario).to_dict()
        self._send_json(200, {key: result[key] for key in ("status", "visited_nodes", "trace")})

    def _get_config_roles(self) -> None:
        with self.server.config_lock:
            payload = _config_roles_payload(self.server.loader)
        self._send_json(200, payload)

    def _put_config_role(self, role_name: str) -> None:
        payload = self._read_json_body()
        with self.server.config_lock:
            loader = self.server.loader
            config = loader.current
            if role_name not in config.roles:
                self._send_json(404, {"error": f"Unknown role {role_name!r}"})
                return
            model = payload.get("model")
            if not isinstance(model, str) or not model.strip():
                raise _BadRequest("model must be a non-empty string")
            updates = {"model": model}
            if "provider" in payload:
                provider = payload["provider"]
                if not isinstance(provider, str) or (
                    provider not in config.providers and provider != "host_native"
                ):
                    raise _BadRequest("provider must name a configured provider or host_native")
                updates["provider"] = provider

            if loader.path.suffix.lower() != ".toml":
                raise _BadRequest("Role editing requires a TOML configuration")
            repo = self.server.repo_path
            try:
                config_path = (repo / ".baton" / "baton.toml").resolve()
                if not config_path.is_relative_to(repo):
                    raise _BadRequest("The local configuration must be inside the repository")
                if loader.path != config_path and config_path.exists():
                    self._send_json(409, {"error": "A different repo-local baton.toml already exists"})
                    return

                original_text = loader.path.read_bytes().decode("utf-8")
                try:
                    updated_text = _set_toml_role_keys(original_text, role_name, updates)
                    expected = tomllib.loads(original_text, parse_float=str)
                    expected["roles"][role_name].update(updates)
                    if tomllib.loads(updated_text, parse_float=str) != expected:
                        raise ValueError("The edit did not change exactly the requested role keys")
                    contents = updated_text.encode("utf-8")
                except (KeyError, ValueError) as exc:
                    raise _BadRequest(f"Cannot edit role {role_name!r} ({exc})") from exc

                _replace_config_file(config_path, contents)
                if loader.path != config_path:
                    loader = HotReloadConfig(config_path)
                role = loader.reload(force=True).roles[role_name]
            except OSError as exc:
                self._send_json(500, {"error": f"Cannot save the role configuration ({exc})"})
                return

            if any(getattr(role, key) != value for key, value in updates.items()):
                self._send_json(500, {"error": f"Reloaded values did not match role {role_name!r}"})
                return
            self.server.loader = loader
        self._send_json(
            200, {"role_name": role_name, "role": _role_payload(role), "config_path": str(loader.path)}
        )

    def _get_latest_run(self) -> None:
        self._send_json(200, _latest_run_snapshot(self.server.store))

    def _send_run_not_found(self, run_id: str) -> None:
        self._send_json(404, {"error": f"Unknown run {run_id!r}"})

    def _get_run(self, run_id: str) -> None:
        snapshot = _run_snapshot(self.server.store, run_id)
        if snapshot["run"] is None:
            self._send_run_not_found(run_id)
            return
        self._send_json(200, snapshot)

    def _get_run_report(self, run_id: str) -> None:
        store = self.server.store
        if store.get_run(run_id) is None:
            self._send_run_not_found(run_id)
            return
        self._send_json(
            200, {"run_id": run_id, "battle_report_markdown": generate_battle_report(store, run_id)}
        )

    def _write_sse(self, event: str, payload: Mapping[str, Any]) -> None:
        frame = f"event: {event}\ndata: {json.dumps(dict(payload))}\n\n"
        self.wfile.write(frame.encode("utf-8"))
        self.wfile.flush()

    def _get_run_stream(self) -> None:
        once = "1" in parse_qs(urlsplit(self.path).query).get("once", [])
        previous = _latest_run_snapshot(self.server.store)
        try:
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Connection", "keep-alive")
            self._send_cors_headers()
            self.end_headers()
            self._write_sse("snapshot", previous)
            if once:
                return

            last_write = time.monotonic()
            while not self.server.shutdown_event.wait(1.0):
                current = _latest_run_snapshot(self.server.store)
                before, after = previous["run"] or {}, current["run"] or {}
                same_run = before.get("id") == after.get("id")
                previous_count = len(previous["events"])
                if (
                    not same_run
                    or before.get("status") != after.get("status")
                    or before.get("updated_at") != after.get("updated_at")
                    or previous_count != len(current["events"])
                ):
                    self._write_sse("snapshot", current)
                    first_new_event = previous_count if same_run else 0
                    for event in current["events"][first_new_event:]:
                        self._write_sse("event", event)
                    previous = current
                    last_write = time.monotonic()
                elif time.monotonic() - last_write >= 15:
                    # An idle write also gives the socket a chance to detect a disconnect.
                    self.wfile.write(b": keep-alive\n\n")
                    self.wfile.flush()
                    last_write = time.monotonic()
        except ConnectionError:
            pass
        finally:
            self.close_connection = True

    def _spawn_run_daemon(self, run_id: str, failure_status: RunStatus) -> int | None:
        server = self.server
        spawner = server.daemon_spawner or _spawn_detached_daemon
        try:
            pid = spawner(server.repo_path, server.loader.path, run_id)
        except OSError as exc:
            message = f"Detached daemon failed to start ({exc})"
            server.store.update_run_status(run_id, failure_status, summary=message)
            server.store.log_event(run_id, "daemon_spawn_failed", message=message)
            self._send_json(500, {"run_id": run_id, "error": message})
            return None
        return pid

    def _post_run_start(self) -> None:
        payload = self._read_json_body()
        mode = payload.get("mode", "overnight")
        if mode not in ("overnight", "interactive"):
            raise _BadRequest("mode must be overnight or interactive")
        overrides = payload.get("model_overrides", {})
        if not isinstance(overrides, dict) or any(
            not isinstance(value, str) for value in overrides.values()
        ):
            raise _BadRequest("model_overrides must map roles to model strings")
        markdown = payload.get("rfc_markdown", "")
        if not isinstance(markdown, str):
            raise _BadRequest("rfc_markdown must be a string")

        repo = self.server.repo_path
        if markdown.strip():
            try:
                rfc_path = _save_ui_rfc(repo, markdown)
            except OSError as exc:
                self._send_json(500, {"error": f"Cannot save RFC markdown ({exc})"})
                return
        else:
            supplied_path = payload.get("rfc_path")
            if not isinstance(supplied_path, str) or not supplied_path.strip():
                raise _BadRequest("Provide rfc_markdown or rfc_path")
            rfc_path = _resolve_rfc_path(repo, supplied_path)

        store = self.server.store
        run_id = store.create_run(
            repo_path=repo, rfc_path=rfc_path, mode=mode, plan_path=None, model_overrides=overrides
        )
        pid = self._spawn_run_daemon(run_id, RunStatus.FAILED)
        if pid is not None:
            store.log_event(run_id, "daemon_spawned", message=f"Detached daemon started (pid={pid})")
            self._send_json(201, {"run_id": run_id, "daemon_pid": pid, "status": "STARTED"})

    def _post_run_control(self, run_id: str) -> None:
        store = self.server.store
        if store.get_run(run_id) is None:
            self._send_run_not_found(run_id)
            return
        action = self._read_json_body().get("action")
        if action not in ("pause", "resume"):
            raise _BadRequest("action must be pause or resume")
        if action == "pause":
            status, kind = RunStatus.PAUSED, "run_paused"
        else:
            status, kind = RunStatus.RUNNING, "run_resumed"
        store.update_run_status(run_id, status)
        store.log_event(run_id, kind, actor="human", message=f"Run {action} requested from the canvas")
        response: dict[str, str | int] = {"run_id": run_id, "status": status.value}
        if action == "resume":
            pid = self._spawn_run_daemon(run_id, RunStatus.PAUSED)
            if pid is None:
                return
            store.log_event(run_id, "daemon_spawned", message=f"Detached daemon started (pid={pid})")
            response["daemon_pid"] = pid
        self._send_json(200, response)

    def _post_run_resolve(self, run_id: str) -> None:
        store = self.server.store
        if store.get_run(run_id) is None:
            self._send_run_not_found(run_id)
            return
        payload = self._read_json_body()
        decision = payload.get("decision")
        if decision not in ("approve", "reject"):
            raise _BadRequest("decision must be approve or reject")
        note = payload.get("note", "")
        if not isinstance(note, str):
            raise _BadRequest("note must be a string")
        store.record_human_decision(run_id, decision, note)
        pid = None
        if decision == "approve":
            pid = self._spawn_run_daemon(run_id, RunStatus.PAUSED)
            if pid is None:
                return
        self._send_json(200, {"run_id": run_id, "decision": decision, "daemon_pid": pid})

    def _serve_static(self, raw_path: str, path: str) -> None:
        relative = Path(path.lstrip("/") or "index.html")
        forbidden = {"error": "Forbidden static path"}
        if relative.anchor or "\\" in path or ".." in path.split("/") or "%2e" in raw_path.lower():
            self._send_json(403, forbidden)
            return

        root = self.server.static_dir
        try:
            resolved = (root / relative).resolve()
            if not resolved.is_relative_to(root):
                self._send_json(403, forbidden)
                return
            body = resolved.read_bytes() if resolved.is_file() else None
        except (FileNotFoundError, NotADirectoryError, IsADirectoryError):
            body = None
        except (OSError, RuntimeError, ValueError):
            self._send_json(403, forbidden)
            return

        if body is not None:
            mime = _STATIC_MIME_TYPES.get(relative.suffix.lower()) or mimetypes.guess_type(relative.name)[0]
            self._send_bytes(200, mime or "application/octet-stream", body)
        elif path == "/":
            self._send_bytes(200, "text/html; charset=utf-8", _BUILD_NOTICE)
        else:
            self._send_json(404, {"error": "Static file not found"})


def create_server(
    repo_path: Path,
    host: str = "127.0.0.1",
    port: int = 7860,
    static_dir: Path | None = None,
    config_path: Path | None = None,
    daemon_spawner: Callable[[Path, Path, str], int] | None = None,
) -> ThreadingHTTPServer:
    """Bind a server for the repository and initialize its shared context."""
    repo_path = repo_path.resolve()
    loader = HotReloadConfig(find_config_path(repo_path, config_path))
    store = StateStore(repo_path / loader.current.daemon.db_path)
    if static_dir is None:
        static_dir = Path(__file__).resolve().parents[2] / "web" / "dist"
    static_dir = static_dir.resolve()

    server = _CanvasHTTPServer((host, port))
    server.repo_path = repo_path
    server.loader = loader
    server.store = store
    server.static_dir = static_dir
    server.daemon_spawner = daemon_spawner
    return server


class VibeBatonWebServer:
    """Own the listening socket and expose the bound URL for CLI callers."""

    def __init__(
        self,
        repo_path: Path,
        host: str = "127.0.0.1",
        port: int = 7860,
        static_dir: Path | None = None,
        config_path: Path | None = None,
        daemon_spawner: Callable[[Path, Path, str], int] | None = None,
    ) -> None:
        self.server = create_server(repo_path, host, port, static_dir, config_path, daemon_spawner)
        self.url = f"http://{host}:{self.server.server_address[1]}"

    def serve_forever(self) -> None:
        self.server.serve_forever()

    def shutdown(self) -> None:
        try:
            self.server.shutdown()
        finally:
            self.server.server_close()
