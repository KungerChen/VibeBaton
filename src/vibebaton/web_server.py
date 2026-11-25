"""Local HTTP API and static hosting for the VibeBaton canvas."""

from __future__ import annotations

import json
import math
import mimetypes
import os
import re
import shutil
import socket
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
import tomllib
import uuid
from concurrent.futures import ThreadPoolExecutor
from dataclasses import asdict
from decimal import Decimal, InvalidOperation
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from time import monotonic
from typing import Any, Callable, Iterable, Mapping, Protocol, TypedDict
from urllib.parse import parse_qs, unquote, urlsplit

from . import __version__, case_export, cli_registry, credentials, model_catalog, presets, pricing
from .brainstorm import RFC_RELATIVE_PATH, brainstorm_turn, confirm_blueprint
from .config import (
    ALLOWED_BUDGET_PROFILES,
    BatonConfig,
    HotReloadConfig,
    RoleConfig,
    build_model_catalog,
    find_config_path,
)
from .db import StateStore
from .git_ops import (
    GitError,
    backup_tag_name,
    create_backup_tag,
    merge_branch_into,
    reset_branch_to,
    uncommitted_paths,
)
from .graph_engine import SCENARIOS, simulate_graph
from .graph_schema import GraphValidationResult, WorkflowGraph, validate_graph
from .mcp_server import _spawn_detached_daemon
from .report import compute_run_telemetry, generate_battle_report
from .rfc_checker import check_rfc_readiness, generate_structured_rfc
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
    ("PUT", re.compile(r"/api/config/budget"), "_put_config_budget"),
    ("GET", re.compile(r"/api/pricing"), "_get_pricing"),
    ("POST", re.compile(r"/api/pricing/sync"), "_post_pricing_sync"),
    ("PUT", re.compile(r"/api/pricing/custom"), "_put_pricing_custom"),
    ("GET", re.compile(r"/api/models/catalog"), "_get_models_catalog"),
    ("POST", re.compile(r"/api/models/catalog/sync"), "_post_models_catalog_sync"),
    ("POST", re.compile(r"/api/doctor/role"), "_post_doctor_role"),
    ("GET", re.compile(r"/api/credentials"), "_get_credentials"),
    ("POST", re.compile(r"/api/credentials"), "_post_credentials"),
    ("GET", re.compile(r"/api/attention/dismissed"), "_get_attention_dismissed"),
    ("POST", re.compile(r"/api/attention/dismiss"), "_post_attention_dismiss"),
    ("POST", re.compile(r"/api/rfc/check"), "_post_rfc_check"),
    ("POST", re.compile(r"/api/rfc/brainstorm"), "_post_rfc_brainstorm"),
    ("GET", re.compile(r"/api/cli-registry"), "_get_cli_registry"),
    ("POST", re.compile(r"/api/cli-registry/scan"), "_post_cli_registry_scan"),
    ("POST", re.compile(r"/api/cli-registry/install"), "_post_cli_registry_install"),
    ("POST", re.compile(r"/api/cli-registry/login"), "_post_cli_registry_login"),
    ("GET", re.compile(r"/api/workspace/info"), "_get_workspace_info"),
    ("POST", re.compile(r"/api/workspace/select"), "_post_workspace_select"),
    ("POST", re.compile(r"/api/workspace/browse"), "_post_workspace_browse"),
    ("POST", re.compile(r"/api/workspace/init-git"), "_post_workspace_init_git"),
    ("POST", re.compile(r"/api/brainstorm/chat"), "_post_brainstorm_chat"),
    ("POST", re.compile(r"/api/brainstorm/confirm"), "_post_brainstorm_confirm"),
    ("GET", re.compile(r"/api/runs"), "_get_runs"),
    ("GET", re.compile(r"/api/runs/latest"), "_get_latest_run"),
    ("GET", re.compile(r"/api/runs/stream"), "_get_run_stream"),
    ("GET", re.compile(r"/api/runs/([^/]+)/report"), "_get_run_report"),
    ("GET", re.compile(r"/api/runs/([^/]+)/case-export"), "_get_run_case_export"),
    ("GET", re.compile(r"/api/runs/([^/]+)/tasks/([^/]+)"), "_get_run_task"),
    ("GET", re.compile(r"/api/runs/([^/]+)"), "_get_run"),
    ("POST", re.compile(r"/api/runs/start"), "_post_run_start"),
    ("POST", re.compile(r"/api/runs/([^/]+)/control"), "_post_run_control"),
    ("POST", re.compile(r"/api/runs/([^/]+)/resolve"), "_post_run_resolve"),
    ("POST", re.compile(r"/api/runs/([^/]+)/finalize"), "_post_run_finalize"),
]

_TOML_STRING_KEY_LINE = re.compile(
    r"""(?P<assignment>[ \t]*(?P<quote>["']?)(?P<key>[\w-]+)(?P=quote)[ \t]*=[ \t]*)"""
    r"""(?:"{3}(?:[^\\]|\\.)*?"{3,5}|'{3}.*?'{3,5}|"(?:[^"\\]|\\.)*"|'[^']*'|[^#"']*?)"""
    r"""(?P<suffix>[ \t]*(?:#.*)?)"""
)
_PROBE_TTL_SEC = 60.0
_DISMISSED_ALERTS_LOCK = threading.Lock()
_MAX_DISMISSED_ALERTS = 50


def _dismissed_alerts_path(credentials_path: Path | None) -> Path:
    base = credentials.default_credentials_path(credentials_path)
    return base.parent / "dismissed_alerts.json"


def _model_catalog_cache_path(credentials_path: Path | None) -> Path:
    base = credentials.default_credentials_path(credentials_path)
    return base.parent / "model_catalog_cache.json"


def _read_dismissed_alerts(path: Path) -> list[str]:
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, OSError, ValueError, RecursionError):
        return []
    if not isinstance(raw, list):
        return []
    return [item for item in raw if isinstance(item, str) and item]


def _record_dismissed_alert(path: Path, fingerprint: str, limit: int = _MAX_DISMISSED_ALERTS) -> list[str]:
    with _DISMISSED_ALERTS_LOCK:
        items = [item for item in _read_dismissed_alerts(path) if item != fingerprint]
        items.append(fingerprint)
        items = items[-limit:]
        path.parent.mkdir(parents=True, exist_ok=True)
        temp_file = tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=path.parent, delete=False)
        temp_path = Path(temp_file.name)
        try:
            with temp_file:
                json.dump(items, temp_file, indent=2)
                temp_file.write("\n")
                temp_file.flush()
                os.fsync(temp_file.fileno())
            os.replace(temp_path, path)
        finally:
            temp_path.unlink(missing_ok=True)
        return items

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


class _UnsupportedMediaType(_BadRequest):
    """A request body that is not declared as JSON; serialized as a JSON 415."""


_LOOPBACK_HOSTNAMES = frozenset({"localhost", "127.0.0.1", "::1"})


def _is_loopback_hostname(hostname: str | None) -> bool:
    return hostname is not None and hostname.lower().rstrip(".") in _LOOPBACK_HOSTNAMES


def _allowed_origin(origin: str | None) -> bool:
    """Only browser pages served from a loopback origin (same server or a local dev server) may call the API."""
    if not origin:
        return False
    try:
        parts = urlsplit(origin)
        return parts.scheme in {"http", "https"} and _is_loopback_hostname(parts.hostname)
    except ValueError:
        return False


class _ProviderProbe(Protocol):
    def __call__(
        self,
        config: BatonConfig,
        /,
        *,
        provider: str | None = None,
        role: str | None = None,
        model: str | None = None,
        credentials_path: Path | None = None,
    ) -> credentials.ProbeResult: ...


_ProviderProbeKey = tuple[Path, str, tuple[str, ...] | None]


class _ProviderProbeCache:
    """Share provider probes for the same credential store and CLI configuration."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._entries: dict[_ProviderProbeKey, tuple[float, credentials.ProbeResult]] = {}

    def check(
        self,
        config: BatonConfig,
        providers: Iterable[str],
        credentials_path: Path,
        probe: _ProviderProbe,
    ) -> dict[str, credentials.ProbeResult]:
        checks: dict[str, credentials.ProbeResult] = {}
        missing: dict[str, _ProviderProbeKey] = {}
        with self._lock:
            now = monotonic()
            self._entries = {key: entry for key, entry in self._entries.items() if entry[0] > now}
            for provider in providers:
                provider_config = config.providers.get(provider)
                command = tuple(provider_config.command) if provider_config is not None else None
                key = (credentials_path, provider, command)
                if key in self._entries:
                    checks[provider] = self._entries[key][1]
                else:
                    missing[provider] = key

            if missing:
                def run_probe(provider: str) -> credentials.ProbeResult:
                    return probe(config, provider=provider, credentials_path=credentials_path)

                with ThreadPoolExecutor() as pool:
                    for (provider, key), result in zip(missing.items(), pool.map(run_probe, missing), strict=True):
                        self._entries[key] = (monotonic() + _PROBE_TTL_SEC, result)
                        checks[provider] = result
        return checks

    def invalidate(self, credentials_path: Path) -> None:
        with self._lock:
            self._entries = {key: entry for key, entry in self._entries.items() if key[0] != credentials_path}


_PROCESS_PROVIDER_PROBES = _ProviderProbeCache()


class _RunSnapshot(TypedDict):
    run: dict[str, Any] | None
    milestones: list[dict[str, Any]]
    tasks: list[dict[str, Any]]
    events: list[dict[str, Any]]
    quotas: list[dict[str, Any]]
    telemetry: dict[str, Any] | None


def _parse_finite_float(token: str) -> float:
    value = float(token)
    if not math.isfinite(value):
        raise ValueError("JSON numbers must be finite")
    return value


def _load_json(
    data: str | bytes | bytearray,
    *,
    parse_float: Callable[[str], float | Decimal] = _parse_finite_float,
) -> Any:
    return json.loads(data, parse_constant=_parse_finite_float, parse_float=parse_float)


def _text_field(payload: Mapping[str, Any], key: str, *, default: str | None = None) -> str:
    value = payload.get(key, default)
    if not isinstance(value, str) or (default is None and not value.strip()):
        expected = "a non-empty string" if default is None else "a string"
        raise _BadRequest(f"{key} must be {expected}")
    return value


_GIT_TIMEOUT_SEC = 30.0
# Client-supplied command fields are never executed; they are only logged as ignored.
_IGNORED_INSTALL_FIELDS = ("argv", "command", "install_cmd")


def _git(repo: Path, *args: str) -> subprocess.CompletedProcess[str] | None:
    """Run git in ``repo``; ``None`` when git itself cannot be started."""
    try:
        return subprocess.run(
            ["git", "-C", str(repo), *args], shell=False, stdin=subprocess.DEVNULL, capture_output=True,
            text=True, encoding="utf-8", errors="replace", timeout=_GIT_TIMEOUT_SEC, check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return None


def _git_stdout(repo: Path, *args: str) -> str:
    """Run git in ``repo`` and return stdout, raising GitError on any failure."""
    result = _git(repo, *args)
    if result is None or result.returncode != 0:
        detail = "git could not be started" if result is None else (result.stderr or result.stdout).strip()
        raise GitError(f"git {' '.join(args)} failed: {detail}")
    return result.stdout


def _workspace_info(repo: Path) -> dict[str, Any]:
    inside = _git(repo, "rev-parse", "--is-inside-work-tree")
    is_git = inside is not None and inside.returncode == 0 and inside.stdout.strip() == "true"
    branch = None
    has_commits = False
    if is_git:
        head = _git(repo, "symbolic-ref", "--short", "-q", "HEAD")  # also names an unborn branch
        if head is not None and head.returncode == 0:
            branch = head.stdout.strip() or None
        verify = _git(repo, "rev-parse", "-q", "--verify", "HEAD")
        has_commits = verify is not None and verify.returncode == 0
    return {
        "path": str(repo),
        "is_git_repo": is_git,
        "branch": branch,
        "has_commits": has_commits,
        "has_rfc": (repo / RFC_RELATIVE_PATH).is_file(),
    }


def _pick_workspace_directory(initial_dir: Path) -> str | None:
    """Open the OS native folder picker dialog in front of active windows and return the path or None."""
    start = str(initial_dir)
    if sys.platform == "win32":
        # Prefer tkinter topmost hidden root; fall back to PowerShell Forms dialog if tkinter is absent.
        try:
            import tkinter as tk
            from tkinter import filedialog

            root = tk.Tk()
            try:
                root.withdraw()
                root.attributes("-topmost", True)
                root.update()
                chosen = filedialog.askdirectory(
                    parent=root,
                    initialdir=start,
                    title="Choose Project Folder — VibeBaton Studio",
                    mustexist=True,
                )
            finally:
                root.destroy()
            return chosen.strip() or None
        except Exception:
            escaped = start.replace("'", "''")
            ps_script = (
                "Add-Type -AssemblyName System.Windows.Forms; "
                "$dlg = New-Object System.Windows.Forms.FolderBrowserDialog; "
                "$dlg.Description = 'Choose Project Folder — VibeBaton Studio'; "
                "$dlg.UseDescriptionForTitle = $true; "
                f"$dlg.SelectedPath = '{escaped}'; "
                "$owner = New-Object System.Windows.Forms.Form -Property @{TopMost=$true}; "
                "if ($dlg.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { "
                "Write-Output $dlg.SelectedPath }"
            )
            proc = subprocess.run(
                ["powershell", "-NoProfile", "-STA", "-Command", ps_script],
                capture_output=True,
                text=True,
                timeout=180,
                check=False,
            )
            if proc.returncode == 0:
                picked = proc.stdout.strip()
                return picked or None
            return None
    if sys.platform == "darwin":
        script = f'POSIX path of (choose folder with prompt "Choose Project Folder" default location POSIX file "{start}")'
        proc = subprocess.run(["osascript", "-e", script], capture_output=True, text=True, timeout=180, check=False)
        return proc.stdout.strip() or None if proc.returncode == 0 else None
    for cmd in (
        ["zenity", "--file-selection", "--directory", f"--filename={start}/"],
        ["kdialog", "--getexistingdirectory", start],
    ):
        if shutil.which(cmd[0]):
            proc = subprocess.run(cmd, capture_output=True, text=True, timeout=180, check=False)
            return proc.stdout.strip() or None if proc.returncode == 0 else None
    raise RuntimeError("No native folder picker dialog is available on this host")


def _json_object(raw: object) -> dict[str, Any]:
    """Decode a stored JSON column, treating anything but an object as empty."""
    if isinstance(raw, dict):
        return raw
    try:
        value = json.loads(raw) if isinstance(raw, str) and raw else {}
    except ValueError:
        return {}
    return value if isinstance(value, dict) else {}


def _validated_pricing_updates(updates: object) -> dict[str, dict[str, float] | None]:
    """Require JSON numbers before passing the rate table to the pricing writer."""
    if not isinstance(updates, dict):
        raise _BadRequest("updates must map model names to rate objects or null")

    validated: dict[str, dict[str, float] | None] = {}
    for model, row in updates.items():
        if row is None:
            validated[model] = None
            continue
        if not isinstance(row, dict):
            raise _BadRequest(f"Pricing for {model!r} must be an object or null")

        rates: dict[str, float] = {}
        for key, value in row.items():
            error = f"{key} for {model!r} must be a finite non-negative number"
            if isinstance(value, bool) or not isinstance(value, (int, Decimal)) or value < 0:
                raise _BadRequest(error)
            try:
                rate = float(value)
            except OverflowError as exc:
                raise _BadRequest(error) from exc
            if not math.isfinite(rate):
                raise _BadRequest(error)
            rates[key] = rate
        validated[model] = rates
    return validated


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


def _config_roles_payload(config: BatonConfig, path: Path) -> dict[str, Any]:
    return {
        "config_path": str(path),
        "providers": {
            name: {"max_concurrency": provider.max_concurrency, "command": provider.command}
            for name, provider in config.providers.items()
        },
        "roles": {name: _role_payload(role) for name, role in config.roles.items()},
    }


def _set_toml_table_keys(
    text: str, table: str, updates: dict[str, str], *, create: bool = False
) -> str:
    """Replace string values in a TOML table while retaining its formatting."""
    # JSON basic string escapes also work in TOML. TOML additionally requires escaping DEL.
    pending = {
        key: json.dumps(value, ensure_ascii=False).replace("\x7f", r"\u007f")
        for key, value in updates.items()
    }
    lines = text.split("\n")
    name = re.escape(table)
    if "." not in table:
        name = rf"""[ \t]*(?:{name}|"{name}"|'{name}')[ \t]*"""
    header = re.compile(rf"[ \t]*\[{name}\][ \t]*(?:#.*)?")
    for index, line in enumerate(lines):
        if header.fullmatch(line.removesuffix("\r")):
            start = index
            break
    else:
        if not create:
            raise ValueError(f"Missing [{table}] section")
        newline = "\r\n" if "\r\n" in text else "\n"
        if text:
            text += newline if text.endswith("\n") else newline * 2
        assignments = [f"{key} = {value}" for key, value in pending.items()]
        return text + newline.join([f"[{table}]", *assignments, ""])

    for index in range(start + 1, len(lines)):
        line = lines[index]
        if line.lstrip(" \t").startswith("["):
            break
        match = _TOML_STRING_KEY_LINE.fullmatch(line.removesuffix("\r"))
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


def _set_toml_role_keys(text: str, role: str, updates: dict[str, str]) -> str:
    return _set_toml_table_keys(text, f"roles.{role}", updates)


def _local_config_path(repo: Path) -> Path:
    path = (repo / ".baton" / "baton.toml").resolve()
    if not path.is_relative_to(repo):
        raise _BadRequest("The local configuration must be inside the repository")
    return path


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
        return {"run": None, "milestones": [], "tasks": [], "events": [], "quotas": [], "telemetry": None}
    return {
        "run": run,
        "milestones": store.get_milestones(run["id"]),
        "tasks": store.get_tasks(run["id"]),
        # SQLite LIMIT -1 retains the full append-only history for SSE.
        "events": store.get_events(run["id"], limit=-1),
        "quotas": store.get_all_quotas(),
        "telemetry": compute_run_telemetry(store, run["id"]),
    }


def _latest_run_snapshot(store: StateStore) -> _RunSnapshot:
    run = store.get_latest_run()
    return _run_snapshot(store, run["id"] if run is not None else None)


_TASK_STATUS_PHRASES = {
    "PENDING": "is waiting to start",
    "RUNNING": "is being worked on",
    "GATE_CHECKING": "is running its automated checks",
    "REVIEWING": "is being reviewed",
    "COOLDOWN": "is waiting for the model provider to cool down",
    "WAITING_HUMAN": "needs your decision",
    "PASSED": "is done and passed its checks",
    "FAILED": "failed",
    "SKIPPED": "was skipped",
}

_TASK_STATUS_PHRASES_ZH = {
    "PENDING": "正在等待开始",
    "RUNNING": "正在开发中",
    "GATE_CHECKING": "正在运行自动检查",
    "REVIEWING": "正在接受评审",
    "COOLDOWN": "正在等待模型供应方冷却",
    "WAITING_HUMAN": "需要你的决定",
    "PASSED": "已完成并通过了所有检查",
    "FAILED": "执行失败",
    "SKIPPED": "已跳过",
}

_TASK_VERDICT_PHRASES_ZH = {
    "PASS": "通过",
    "MINOR_FIX": "建议小幅修改",
    "MAJOR_REWORK": "需要返工",
    "PLAN_AMENDMENT": "需要调整计划",
}


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
    allow_reuse_address = sys.platform != "win32"

    repo_path: Path
    loader: HotReloadConfig
    store: StateStore
    static_dir: Path
    daemon_spawner: Callable[[Path, Path, str], int] | None
    credentials_path: Path
    provider_probe: _ProviderProbe
    provider_probe_cache: _ProviderProbeCache
    pricing_fetcher: pricing.PricingFetcher | None
    cli_model_probe: Callable[[], model_catalog.CliModels]
    folder_picker: Callable[[Path], str | None] | None

    def server_bind(self) -> None:
        # On Windows SO_REUSEADDR lets a second server bind the same port while the old process keeps traffic;
        # SO_EXCLUSIVEADDRUSE ensures port collisions fail cleanly instead of serving stale bundles.
        if sys.platform == "win32" and hasattr(socket, "SO_EXCLUSIVEADDRUSE"):
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        super().server_bind()

    def __init__(self, address: tuple[str, int]) -> None:
        self.shutdown_event = threading.Event()
        self.config_lock = threading.Lock()
        self._lifecycle_lock = threading.Lock()
        self._serving = False
        super().__init__(address, _CanvasRequestHandler)

    def provider_checks(
        self, config: BatonConfig, providers: Iterable[str]
    ) -> dict[str, credentials.ProbeResult]:
        return self.provider_probe_cache.check(config, providers, self.credentials_path, self.provider_probe)

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
        # Never a wildcard: only loopback origins may read responses or pass a preflight.
        origin = self.headers.get("Origin")
        if not _allowed_origin(origin):
            return
        self.send_header("Access-Control-Allow-Origin", origin)
        self.send_header("Vary", "Origin")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PUT, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def _host_allowed(self) -> bool:
        """Reject DNS-rebinding requests whose Host is not loopback (or the explicitly bound host)."""
        host = self.headers.get("Host")
        if not host:
            return False
        try:
            hostname = urlsplit("//" + host).hostname
        except ValueError:
            return False
        if _is_loopback_hostname(hostname):
            return True
        bound = str(self.server.server_address[0]).lower()
        return hostname is not None and bound not in {"", "0.0.0.0", "::"} and hostname.lower() == bound

    def _forbidden_reason(self) -> str | None:
        if not self._host_allowed():
            return "Host header is not a loopback address"
        origin = self.headers.get("Origin")
        if self.command in {"POST", "PUT", "OPTIONS"} and origin is not None and not _allowed_origin(origin):
            return "Cross-origin requests are not allowed"
        return None

    def _send_bytes(
        self,
        status: int,
        content_type: str,
        body: bytes,
        *,
        cors: bool = False,
        extra_headers: Mapping[str, str] | None = None,
    ) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        if extra_headers:
            for name, value in extra_headers.items():
                self.send_header(name, value)
        if cors:
            self._send_cors_headers()
        self.end_headers()
        self.wfile.write(body)

    def _send_json(self, status: int, payload: Mapping[str, Any] | list[credentials.CredentialStatus]) -> None:
        data = dict(payload) if isinstance(payload, Mapping) else payload
        self._send_bytes(status, "application/json", json.dumps(data).encode("utf-8"), cors=True)

    def _read_json_body(
        self,
        *,
        optional: bool = False,
        parse_float: Callable[[str], float | Decimal] = _parse_finite_float,
    ) -> dict[str, Any]:
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError as exc:
            raise _BadRequest("Invalid Content-Length") from exc
        if length < 0:
            raise _BadRequest("Invalid Content-Length")
        if length == 0:
            if optional:
                return {}
            raise _BadRequest("A JSON request body is required")
        # Requiring application/json forces a CORS preflight for any browser-originated request.
        if self.headers.get_content_type() != "application/json":
            raise _UnsupportedMediaType("Content-Type must be application/json")

        body = bytearray()
        while len(body) < length:
            chunk = self.rfile.read(min(length - len(body), 64 * 1024))
            if not chunk:
                raise _BadRequest("Incomplete JSON request body")
            body.extend(chunk)
        try:
            payload = _load_json(body, parse_float=parse_float)
        except InvalidOperation as exc:
            raise _BadRequest("JSON number is outside the supported range") from exc
        except (ValueError, RecursionError) as exc:
            raise _BadRequest(f"Invalid JSON request body: {exc}") from exc
        if not isinstance(payload, dict):
            raise _BadRequest("Request body must be a JSON object")
        return payload

    def do_OPTIONS(self) -> None:
        reason = self._forbidden_reason()
        if reason is not None:
            self._send_json(403, {"error": reason})
            return
        self.send_response(204)
        self._send_cors_headers()
        self.end_headers()

    def _dispatch(self) -> None:
        reason = self._forbidden_reason()
        if reason is not None:
            self._send_json(403, {"error": reason})
            return
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
                except _UnsupportedMediaType as exc:
                    self._send_json(415, {"error": str(exc)})
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
            loader = self.server.loader
            config = _config_roles_payload(loader.current, loader.path)
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
        summaries = presets.list_presets()
        required = {provider for summary in summaries for provider in summary.required_providers}
        with self.server.config_lock:
            config = self.server.loader.current
        checks = self.server.provider_checks(config, required)
        try:
            statuses = credentials.list_credential_status(self.server.credentials_path)
        except (OSError, ValueError):
            statuses = []
        configured_keys = {status["provider_key"] for status in statuses if status["configured"]}
        # Recheck API-key requirements in case the cached probe predates a local key change.
        ready = {
            provider for provider, check in checks.items()
            if check["ok"] and configured_keys.issuperset(credentials.PROVIDER_KEY_MAP.get(provider, ()))
        }

        rows = []
        for summary in summaries:
            graph = presets.load_preset(summary.path)
            validation = validate_graph(graph)
            missing = [provider for provider in summary.required_providers if provider not in ready]
            rows.append(
                {
                    **summary.to_dict(),
                    "host_ready": not missing,
                    "missing_providers": missing,
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
        except _UnsupportedMediaType:
            raise
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
            loader = self.server.loader
            config = loader.current
            payload = _config_roles_payload(config, loader.path)
        self._send_json(200, {**payload, **self._budget_config_payload(config)})

    def _budget_config_payload(self, config: BatonConfig) -> dict[str, Any]:
        checks = self.server.provider_checks(config, config.providers)
        return {
            "budget_profile": config.policies.budget_profile,
            "model_catalog": [capability.to_dict() for capability in build_model_catalog(config, checks)],
        }

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
            try:
                config_path = _local_config_path(self.server.repo_path)
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

    def _put_config_budget(self) -> None:
        profile = self._read_json_body().get("budget_profile")
        if not isinstance(profile, str) or profile not in ALLOWED_BUDGET_PROFILES:
            raise _BadRequest(f"budget_profile must be one of {', '.join(ALLOWED_BUDGET_PROFILES)}")

        with self.server.config_lock:
            loader = self.server.loader
            if loader.path.suffix.lower() != ".toml":
                raise _BadRequest("Budget editing requires a TOML configuration")
            try:
                config_path = _local_config_path(self.server.repo_path)
                if loader.path != config_path and config_path.exists():
                    self._send_json(409, {"error": "A different repo-local baton.toml already exists"})
                    return

                original = loader.path.read_bytes().decode("utf-8")
                try:
                    updated = _set_toml_table_keys(original, "policies", {"budget_profile": profile}, create=True)
                    expected = tomllib.loads(original, parse_float=str)
                    expected.setdefault("policies", {})["budget_profile"] = profile
                    if tomllib.loads(updated, parse_float=str) != expected:
                        raise ValueError("The edit did not change exactly policies.budget_profile")
                    contents = updated.encode("utf-8")
                except (TypeError, ValueError) as exc:
                    raise _BadRequest(f"Cannot edit budget_profile ({exc})") from exc

                _replace_config_file(config_path, contents)
                if loader.path != config_path:
                    loader = HotReloadConfig(config_path)
                config = loader.reload(force=True)
            except OSError as exc:
                self._send_json(500, {"error": f"Cannot save the budget configuration ({exc})"})
                return

            if config.policies.budget_profile != profile:
                self._send_json(500, {"error": "Reloaded budget_profile did not match the requested profile"})
                return
            self.server.loader = loader
        self._send_json(200, self._budget_config_payload(config))

    def _get_pricing(self) -> None:
        with self.server.config_lock:
            settings = self.server.loader.current.pricing
        self._send_json(200, pricing.build_pricing_catalog(settings))

    def _post_pricing_sync(self) -> None:
        force = self._read_json_body(optional=True).get("force", False)
        if not isinstance(force, bool):
            raise _BadRequest("force must be a boolean")

        with self.server.config_lock:
            settings = self.server.loader.current.pricing
        result = pricing.sync_official_pricing(
            settings,
            force=force,
            fetcher=self.server.pricing_fetcher,
        )
        self._send_json(200, {**asdict(result), "catalog": pricing.build_pricing_catalog(settings)})

    def _get_models_catalog(self) -> None:
        cache_path = _model_catalog_cache_path(self.server.credentials_path)
        # The daily loop started with the Studio server refreshes the cache; a stale reply tells the UI to re-poll.
        self._send_json(200, model_catalog.get_model_catalog(cache_path=cache_path))

    def _post_models_catalog_sync(self) -> None:
        force = self._read_json_body(optional=True).get("force", False)
        if not isinstance(force, bool):
            raise _BadRequest("force must be a boolean")
        cache_path = _model_catalog_cache_path(self.server.credentials_path)
        fetcher = getattr(self.server, "pricing_fetcher", None)
        kwargs: dict[str, Any] = {
            "force": force,
            "cache_path": cache_path,
            "cli_probe": getattr(self.server, "cli_model_probe", model_catalog.probe_cli_models),
        }
        if fetcher is not None:
            kwargs["fetcher"] = fetcher
        self._send_json(200, model_catalog.sync_model_catalog(**kwargs))

    def _put_pricing_custom(self) -> None:
        payload = self._read_json_body(parse_float=Decimal)
        updates = _validated_pricing_updates(payload.get("updates"))

        with self.server.config_lock:
            settings = self.server.loader.current.pricing
        try:
            pricing.save_custom_pricing(settings.custom_path, updates)
        except ValueError as exc:
            raise _BadRequest(str(exc)) from exc
        except OSError as exc:
            self._send_json(500, {"error": f"Cannot save custom pricing ({exc})"})
            return
        self._send_json(200, pricing.build_pricing_catalog(settings))

    def _post_doctor_role(self) -> None:
        payload = self._read_json_body()
        provider = _text_field(payload, "provider", default="").strip() or None
        role = _text_field(payload, "role", default="").strip() or None
        model = _text_field(payload, "model", default="").strip() or None
        if provider is None and role is None:
            raise _BadRequest("Provide a provider or role")

        with self.server.config_lock:
            config = self.server.loader.current
        result = self.server.provider_probe(
            config, provider=provider, role=role, model=model, credentials_path=self.server.credentials_path
        )
        self._send_json(200, result)

    def _get_credentials(self) -> None:
        try:
            statuses = credentials.list_credential_status(self.server.credentials_path)
        except (OSError, ValueError):
            self._send_json(500, {"error": "Local credentials could not be read"})
            return
        self._send_json(200, statuses)

    def _post_credentials(self) -> None:
        payload = self._read_json_body()
        updates = payload.get("updates", payload)
        if not isinstance(updates, dict):
            raise _BadRequest("updates must map credential keys to strings")
        try:
            path = self.server.credentials_path.resolve()
            if path.is_relative_to(self.server.repo_path):
                raise ValueError("Credentials must be stored outside the repository")
            name = path.name.lower()
            if name == "baton.toml" or name.endswith(".baton.json"):
                raise ValueError("Credentials require a dedicated local store")
            statuses = credentials.save_credentials(updates, credentials_path=path)
        except ValueError as exc:
            raise _BadRequest(str(exc)) from exc
        except (OSError, RuntimeError):
            self._send_json(500, {"error": "Local credentials could not be saved"})
            return

        self.server.provider_probe_cache.invalidate(self.server.credentials_path)
        self._send_json(200, statuses)

    def _get_attention_dismissed(self) -> None:
        path = _dismissed_alerts_path(self.server.credentials_path)
        self._send_json(200, {"fingerprints": _read_dismissed_alerts(path)})

    def _post_attention_dismiss(self) -> None:
        fingerprint = _text_field(self._read_json_body(), "fingerprint")
        path = _dismissed_alerts_path(self.server.credentials_path)
        try:
            fingerprints = _record_dismissed_alert(path, fingerprint)
        except OSError:
            self._send_json(500, {"error": "Dismissed notifications could not be saved"})
            return
        self._send_json(200, {"fingerprints": fingerprints})

    def _post_rfc_check(self) -> None:
        markdown = _text_field(self._read_json_body(), "rfc_markdown")
        self._send_json(200, check_rfc_readiness(markdown))

    def _post_rfc_brainstorm(self) -> None:
        payload = self._read_json_body()
        result = generate_structured_rfc(
            goal=_text_field(payload, "goal"),
            constraints=_text_field(payload, "constraints", default=""),
            acceptance_cmd=_text_field(payload, "acceptance_cmd", default=""),
            non_goals=_text_field(payload, "non_goals", default=""),
        )
        self._send_json(200, result)

    def _get_cli_registry(self) -> None:
        try:
            registry = cli_registry.load_cli_registry()
        except (OSError, ValueError) as exc:
            self._send_json(500, {"error": f"CLI registry could not be loaded: {exc}"})
            return
        self._send_json(200, registry)

    def _post_cli_registry_scan(self) -> None:
        payload = self._read_json_body(optional=True)
        repo = self.server.repo_path
        if "repo_path" in payload:
            repo = Path(_text_field(payload, "repo_path")).expanduser().resolve()
            if not repo.is_dir():
                raise _BadRequest("repo_path must be an existing directory")
        with self.server.config_lock:
            config = self.server.loader.current
        scan = cli_registry.scan_host_clis(repo, config, self.server.credentials_path)
        self._send_json(200, {"scan": scan, "lineup": cli_registry.build_recommended_lineup(scan, config)})

    @staticmethod
    def _cli_id(payload: Mapping[str, Any]) -> str:
        # "id" is the contract field; "cli_id" is accepted as an alias.
        return _text_field(payload, "cli_id" if "id" not in payload and "cli_id" in payload else "id")

    def _post_cli_registry_install(self) -> None:
        payload = self._read_json_body()
        ignored = [key for key in _IGNORED_INSTALL_FIELDS if key in payload]
        if ignored:
            self.log_message("Ignoring client-supplied install fields %s; only registry recipes run", ignored)
        if payload.get("confirmed") is not True:
            raise _BadRequest("Installing a CLI requires confirmed: true")
        cli_id = self._cli_id(payload)
        try:
            result = cli_registry.run_cli_install(cli_id, confirmed=True)
        except KeyError:
            self._send_json(404, {"error": f"Unknown CLI driver {cli_id!r}"})
            return
        except ValueError as exc:
            self._send_json(500, {"error": str(exc)})
            return
        self._send_json(200, result)

    def _post_cli_registry_login(self) -> None:
        cli_id = self._cli_id(self._read_json_body())
        try:
            result = cli_registry.launch_cli_login(cli_id)
        except KeyError:
            self._send_json(404, {"error": f"Unknown CLI driver {cli_id!r}"})
            return
        except FileNotFoundError as exc:
            self._send_json(409, {"error": str(exc)})
            return
        except OSError as exc:
            self._send_json(500, {"error": f"Login could not be launched: {exc}"})
            return
        self._send_json(200, result)

    def _get_workspace_info(self) -> None:
        self._send_json(200, _workspace_info(self.server.repo_path))

    def _switch_workspace(self, raw: str) -> dict[str, Any]:
        if any(char in raw for char in "\0\r\n"):
            raise _BadRequest("path must not contain NUL or newline characters")
        candidate = Path(raw).expanduser()
        if not candidate.is_absolute():
            raise _BadRequest("path must be absolute")
        try:
            repo = candidate.resolve()
            is_dir = repo.is_dir()
        except (OSError, RuntimeError, ValueError) as exc:
            raise _BadRequest(f"path could not be resolved: {exc}") from exc
        if not is_dir:
            raise _BadRequest("path must be an existing directory")
        with self.server.config_lock:
            explicit = getattr(self.server, "explicit_config_path", None)
            try:
                loader = HotReloadConfig(find_config_path(repo, explicit))
                # Runs live in the workspace's own state DB, so the store and config follow the repo.
                store = StateStore(repo / loader.current.daemon.db_path)
            except (FileNotFoundError, OSError, sqlite3.Error, ValueError) as exc:
                raise _BadRequest(f"Workspace state could not be opened: {exc}") from exc
            self.server.repo_path = repo
            self.server.loader = loader
            self.server.store = store
        return _workspace_info(repo)

    def _post_workspace_select(self) -> None:
        raw = _text_field(self._read_json_body(), "path")
        self._send_json(200, self._switch_workspace(raw))

    def _post_workspace_browse(self) -> None:
        self._read_json_body(optional=True)
        picker = getattr(self.server, "folder_picker", None) or _pick_workspace_directory
        try:
            picked = picker(self.server.repo_path)
        except Exception as exc:
            self._send_json(500, {"error": f"Folder dialog failed: {exc}"})
            return
        if not picked or not picked.strip():
            self._send_json(200, {"cancelled": True, "path": None, "workspace": _workspace_info(self.server.repo_path)})
            return
        workspace = self._switch_workspace(picked.strip())
        self._send_json(200, {"cancelled": False, "path": workspace["path"], "workspace": workspace})

    def _post_workspace_init_git(self) -> None:
        self._read_json_body(optional=True)
        repo = self.server.repo_path
        info = _workspace_info(repo)
        if info["is_git_repo"]:
            self._send_json(200, {**info, "created": False})
            return
        init = _git(repo, "init", "-b", "main")
        if init is not None and init.returncode != 0:  # git < 2.28 has no -b
            init = _git(repo, "init")
            if init is not None and init.returncode == 0:
                init = _git(repo, "symbolic-ref", "HEAD", "refs/heads/main")
        if init is None or init.returncode != 0:
            detail = "git is not available" if init is None else (init.stderr or init.stdout).strip()
            self._send_json(500, {"error": f"git init failed: {detail}"})
            return
        if not any(entry.name not in {".git", ".baton"} for entry in repo.iterdir()):
            # Empty tree: give main a root commit. Best effort; has_commits reports the outcome.
            _git(repo, "commit", "--allow-empty", "-q", "-m", "chore: initialize repository")
        self._send_json(200, {**_workspace_info(repo), "created": True})

    def _post_brainstorm_chat(self) -> None:
        payload = self._read_json_body()
        scenario = payload.get("scenario")
        if scenario is not None and not isinstance(scenario, str):
            raise _BadRequest("scenario must be a string or null")
        offline = payload.get("offline", False)
        if not isinstance(offline, bool):
            raise _BadRequest("offline must be a boolean")
        locale = payload.get("locale")
        if locale is not None and not isinstance(locale, str):
            raise _BadRequest("locale must be a string or null")
        config = None
        if not offline:  # without a config brainstorm_turn uses the offline composer
            with self.server.config_lock:
                config = self.server.loader.current
        try:
            result = brainstorm_turn(
                self.server.repo_path, payload.get("messages"), scenario, config, locale=locale
            )
        except ValueError as exc:
            raise _BadRequest(str(exc)) from exc
        self._send_json(200, result)

    def _post_brainstorm_confirm(self) -> None:
        markdown = _text_field(self._read_json_body(), "rfc_markdown")
        try:
            result = confirm_blueprint(self.server.repo_path, markdown)
        except ValueError as exc:
            raise _BadRequest(str(exc)) from exc
        except OSError as exc:
            self._send_json(500, {"error": f"RFC could not be written: {exc}"})
            return
        self._send_json(200, result)

    def _get_runs(self) -> None:
        store = self.server.store
        raw_runs = store.list_runs(limit=20)
        items: list[dict[str, Any]] = []
        for run in raw_runs:
            rid = str(run["id"])
            milestones = store.get_milestones(rid)
            tasks = store.get_tasks(rid)
            telemetry = compute_run_telemetry(store, rid)
            items.append(
                {
                    "id": rid,
                    "status": run["status"],
                    "mode": run["mode"],
                    "created_at": run["created_at"],
                    "updated_at": run["updated_at"],
                    "finished_at": run.get("finished_at"),
                    "elapsed_sec": telemetry["elapsed_sec"],
                    "passed_tasks": sum(1 for t in tasks if t["status"] == "PASSED"),
                    "total_tasks": len(tasks),
                    "passed_milestones": sum(1 for m in milestones if m["status"] == "PASSED"),
                    "total_milestones": len(milestones),
                }
            )
        self._send_json(200, {"runs": items})

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
        lang = parse_qs(urlsplit(self.path).query).get("lang", ["en"])[0]
        self._send_json(
            200,
            {"run_id": run_id, "battle_report_markdown": generate_battle_report(store, run_id, lang=lang)},
        )

    def _get_run_case_export(self, run_id: str) -> None:
        query = parse_qs(urlsplit(self.path).query, keep_blank_values=True)
        include_reviews = query.get("include_reviews", ["1"])[0]
        anonymize = query.get("anonymize", ["0"])[0]
        for name, value in (("include_reviews", include_reviews), ("anonymize", anonymize)):
            if value not in {"0", "1"}:
                raise _BadRequest(f"{name} must be 0 or 1")
        try:
            bundle = case_export.export_sanitized_case(
                self.server.store,
                run_id,
                title=query.get("title", [None])[0],
                include_review_summaries=include_reviews == "1",
                anonymize_run_id=anonymize == "1",
            )
        except LookupError:
            self._send_json(404, {"error": "Run not found"})
            return
        except ValueError as exc:
            raise _BadRequest(str(exc)) from exc
        self._send_json(200, bundle)

    def _write_sse(self, event: str, payload: Mapping[str, Any]) -> None:
        frame = f"event: {event}\ndata: {json.dumps(dict(payload))}\n\n"
        self.wfile.write(frame.encode("utf-8"))
        self.wfile.flush()

    @staticmethod
    def _sse_snapshot_signature(snapshot: _RunSnapshot) -> tuple[Any, ...]:
        run = snapshot["run"] or {}
        tasks_sig = tuple(
            (
                task.get("id"),
                task.get("status"),
                task.get("attempts"),
                task.get("current_role"),
                task.get("assigned_model"),
            )
            for task in snapshot["tasks"]
        )
        milestones_sig = tuple(
            (milestone.get("id"), milestone.get("status"))
            for milestone in snapshot["milestones"]
        )
        quotas_sig = tuple(
            sorted(
                (
                    quota.get("provider"),
                    quota.get("cooldown_until"),
                    quota.get("cooldown_hits"),
                    round(float(quota.get("remaining_sec") or 0.0)) > 0,
                )
                for quota in snapshot["quotas"]
            )
        )
        return (
            run.get("id"),
            run.get("status"),
            run.get("updated_at"),
            len(snapshot["events"]),
            tasks_sig,
            milestones_sig,
            quotas_sig,
        )

    def _get_run_stream(self) -> None:
        once = "1" in parse_qs(urlsplit(self.path).query).get("once", [])
        previous = _latest_run_snapshot(self.server.store)
        previous_sig = self._sse_snapshot_signature(previous)
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
                current_sig = self._sse_snapshot_signature(current)
                before, after = previous["run"] or {}, current["run"] or {}
                same_run = before.get("id") == after.get("id")
                previous_count = len(previous["events"])
                if current_sig != previous_sig:
                    self._write_sse("snapshot", current)
                    first_new_event = previous_count if same_run else 0
                    for event in current["events"][first_new_event:]:
                        self._write_sse("event", event)
                    previous = current
                    previous_sig = current_sig
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
        if mode not in ("overnight", "interactive", "panel"):
            raise _BadRequest("mode must be overnight, interactive or panel")
        overrides = payload.get("model_overrides", {})
        if not isinstance(overrides, dict) or any(
            not isinstance(value, str) for value in overrides.values()
        ):
            raise _BadRequest("model_overrides must map roles to model strings")
        role_providers = payload.get("role_providers", {})
        if not isinstance(role_providers, dict) or any(
            not isinstance(value, str) for value in role_providers.values()
        ):
            raise _BadRequest("role_providers must map roles to provider ids")
        if role_providers:
            with self.server.config_lock:
                config = self.server.loader.current
            try:
                # Explicit model_overrides win over the lineup for the same role.
                overrides = {**cli_registry.lineup_model_overrides(role_providers, config), **overrides}
            except ValueError as exc:
                raise _BadRequest(str(exc)) from exc
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
        # GuidedDecisionModal sends {task_id, choice, note}; the canvas sends {decision, note}.
        guided = "choice" in payload or "task_id" in payload
        decision = payload.get("choice" if guided else "decision")
        if decision not in ("approve", "reject"):
            raise _BadRequest(f"{'choice' if guided else 'decision'} must be approve or reject")
        note = payload.get("note", "")
        if not isinstance(note, str):
            raise _BadRequest("note must be a string")
        task_id = payload.get("task_id")
        if guided:
            if not isinstance(task_id, str) or not task_id.strip():
                raise _BadRequest("task_id must be a non-empty string")
            if store.get_task(run_id, task_id) is None:
                self._send_json(404, {"error": f"Unknown task {task_id!r} in run {run_id!r}"})
                return
        store.record_human_decision(run_id, decision, note, task_id=task_id if guided else None)
        pid = None
        if decision == "approve":
            pid = self._spawn_run_daemon(run_id, RunStatus.PAUSED)
            if pid is None:
                return
        if guided:
            status = store.get_run(run_id)["status"]
            self._send_json(200, {"ok": True, "run_id": run_id, "task_id": task_id, "status": status})
            return
        self._send_json(200, {"run_id": run_id, "decision": decision, "daemon_pid": pid})

    def _get_run_task(self, run_id: str, task_id: str) -> None:
        store = self.server.store
        if store.get_run(run_id) is None:
            self._send_run_not_found(run_id)
            return
        task = store.get_task(run_id, task_id)
        if task is None:
            self._send_json(404, {"error": f"Unknown task {task_id!r} in run {run_id!r}"})
            return
        review = _json_object(task.get("last_review_json"))
        spec = _json_object(task.get("spec_json"))
        provider = model = None
        cost = 0.0
        changed: list[str] = []
        # The mechanical gate runs before AI review, so reaching review means the gate passed.
        test_status = "not_run" if spec.get("verify_cmd") else "not_configured"
        for event in store.get_events(run_id, task_id=task_id, limit=-1):
            if spec.get("verify_cmd"):
                if event["kind"] == "mechanical_gate_caught":
                    test_status = "failed"
                elif event["kind"] in ("task_review_passed", "task_review_rejected", "task_passed"):
                    test_status = "passed"
            payload = _json_object(event.get("payload_json"))
            if isinstance(payload.get("provider"), str):
                provider = payload["provider"]
            if isinstance(payload.get("model"), str):
                model = payload["model"]
            if isinstance(payload.get("cost_usd"), (int, float)) and not isinstance(payload["cost_usd"], bool):
                cost += float(payload["cost_usd"])
            files = payload.get("changed_files")
            if isinstance(files, list):
                changed = [str(item) for item in files]
        lang = parse_qs(urlsplit(self.path).query).get("lang", ["en"])[0]
        verdict = review.get("verdict")
        verdict = verdict if isinstance(verdict, str) else None
        if lang == "zh":
            phrase = _TASK_STATUS_PHRASES_ZH.get(task["status"], f"当前状态：{task['status']}")
            summary = f"「{task['title']}」{phrase}。"
            if verdict:
                verdict_label = _TASK_VERDICT_PHRASES_ZH.get(verdict, verdict)
                summary += f" 评审结论：{verdict_label}。"
            if task["status"] == "FAILED" and task.get("last_error"):
                summary += f" 最近错误：{str(task['last_error']).strip().splitlines()[0]}"
        else:
            summary = f"“{task['title']}” {_TASK_STATUS_PHRASES.get(task['status'], 'is ' + task['status'].lower())}."
            if verdict:
                summary += f" Reviewer verdict: {verdict}."
            if task["status"] == "FAILED" and task.get("last_error"):
                summary += f" Last error: {str(task['last_error']).strip().splitlines()[0]}"
        self._send_json(
            200,
            {
                "run_id": run_id,
                "task_id": task_id,
                "milestone_id": task["milestone_id"],
                "title": task["title"],
                "tier": task["tier"],
                "status": task["status"],
                "summary": summary,
                "attempts": int(task.get("attempts") or 0),
                "test_status": test_status,
                "provider": provider,
                "model": model,
                "elapsed_sec": float(task.get("duration_sec") or 0.0),
                "cost_usd": round(cost, 6),
                "changed_files": changed,
                "review_verdict": verdict,
            },
        )

    def _post_run_finalize(self, run_id: str) -> None:
        store = self.server.store
        run = store.get_run(run_id)
        if run is None:
            self._send_run_not_found(run_id)
            return
        payload = self._read_json_body()
        action = payload.get("action")
        if action not in ("approve", "revise", "rollback"):
            raise _BadRequest("action must be approve, revise or rollback")
        note = payload.get("note", "")
        if not isinstance(note, str):
            raise _BadRequest("note must be a string")
        if action == "revise" and not note.strip():
            raise _BadRequest("revise requires a non-empty note")
        repo = self.server.repo_path
        with self.server.config_lock:
            daemon_cfg = self.server.loader.current.daemon
        base_branch, dev_branch = daemon_cfg.base_branch, daemon_cfg.dev_branch
        extra: dict[str, Any] = {}
        backup_tag: str | None = None
        try:
            if action == "revise":
                if run["status"] == RunStatus.COMPLETED.value:
                    self._send_json(409, {"error": "Completed runs cannot be sent back with revise; use rollback instead"})
                    return
                revisions = repo / ".baton" / "runs" / run_id / "revisions.md"
                revisions.parent.mkdir(parents=True, exist_ok=True)
                stamp = time.strftime("%Y-%m-%d %H:%M:%S")
                with revisions.open("a", encoding="utf-8") as handle:
                    handle.write(f"## Revision request {stamp}\n\n{note.strip()}\n\n")
                store.record_human_decision(run_id, "revise", note)
                status = RunStatus.PAUSED
                extra["revisions_path"] = str(revisions)
            elif action == "approve":
                if run["status"] != RunStatus.READY_FOR_FINAL_GATE.value:
                    self._send_json(409, {"error": f"Run is {run['status']}, not READY_FOR_FINAL_GATE"})
                    return
                dirty = uncommitted_paths(repo)
                if dirty:
                    self._send_json(409, {"error": f"Commit or stash uncommitted changes first: {', '.join(dirty)}"})
                    return
                backup_tag = create_backup_tag(repo, run_id, base_branch)
                # The run-start tag may predate later base commits; rollback must return here instead.
                pre_merge_head = _git_stdout(repo, "rev-parse", base_branch).strip()
                # merge_branch_into needs a worktree on the base branch, which git refuses
                # while the main checkout holds it; park the checkout on a detached HEAD meanwhile.
                current = _git(repo, "symbolic-ref", "-q", "--short", "HEAD")
                on_base = current is not None and current.returncode == 0 and current.stdout.strip() == base_branch
                worktree_root = Path(daemon_cfg.worktree_root)
                if not worktree_root.is_absolute():
                    worktree_root = repo / worktree_root
                if on_base:
                    _git_stdout(repo, "checkout", "-q", "--detach")
                try:
                    merge_branch_into(
                        repo, dev_branch, base_branch,
                        f"VibeBaton run {run_id}: merge {dev_branch} into {base_branch}", worktree_root,
                    )
                finally:
                    if on_base:
                        _git_stdout(repo, "checkout", "-q", base_branch)
                merged_commit = _git_stdout(repo, "rev-parse", base_branch).strip()
                changed = _git_stdout(repo, "diff", "--name-only", pre_merge_head, merged_commit).splitlines()
                extra.update(merged_commit=merged_commit, changed_files=changed)
                status = RunStatus.COMPLETED
                store.update_run_status(run_id, status)
                store.log_event(run_id, "final_gate_approved", actor="human", message=note,
                                payload={"backup_tag": backup_tag, "base_branch": base_branch,
                                         "dev_branch": dev_branch, "merged_commit": merged_commit,
                                         "pre_merge_head": pre_merge_head})
            else:
                # Only undo our own approved merge, and only while it is still the base head:
                # a hard reset must never drop later user commits or other runs' merges.
                if run["status"] != RunStatus.COMPLETED.value:
                    self._send_json(409, {"error": f"Run is {run['status']}; only an approved (COMPLETED) run can be rolled back"})
                    return
                gate_events = [
                    event for event in store.get_events(run_id, limit=-1)
                    if event["kind"] in ("final_gate_approved", "final_gate_rolled_back")
                ]
                if not gate_events or gate_events[-1]["kind"] != "final_gate_approved":
                    self._send_json(409, {"error": "Run has no approved final-gate merge to roll back"})
                    return
                approved = _json_object(gate_events[-1]["payload_json"])
                merged_commit = approved.get("merged_commit")
                pre_merge_head = approved.get("pre_merge_head")
                head = _git(repo, "rev-parse", base_branch)
                base_head = head.stdout.strip() if head is not None and head.returncode == 0 else None
                if not merged_commit or base_head != merged_commit:
                    self._send_json(
                        409,
                        {"error": f"{base_branch} has moved past this run's merge ({merged_commit}); refusing to roll back"},
                    )
                    return
                if not pre_merge_head:
                    self._send_json(409, {"error": "Approval did not record the pre-merge base head; refusing to roll back"})
                    return
                backup_tag = backup_tag_name(run_id)
                # Reset only past our own squash commit (to the base head at approve time), never to the
                # run-start tag, which would also drop commits that landed on the base during the run.
                # A no-op merge left merged_commit == pre_merge_head, so there is nothing to reset.
                if merged_commit != pre_merge_head:
                    reset_branch_to(repo, base_branch, pre_merge_head)
                extra["restored_to"] = pre_merge_head
                status = RunStatus.PAUSED
                store.update_run_status(run_id, status)
                store.log_event(run_id, "final_gate_rolled_back", actor="human", message=note,
                                payload={"backup_tag": backup_tag, "base_branch": base_branch,
                                         "restored_to": extra["restored_to"]})
        except GitError as exc:
            self._send_json(409, {"error": str(exc)})
            return
        head = _git(repo, "rev-parse", base_branch)
        self._send_json(
            200,
            {
                "ok": True,
                "run_id": run_id,
                "action": action,
                "status": status.value,
                "backup_tag": backup_tag,
                "base_branch": base_branch,
                "base_head": head.stdout.strip() if head is not None and head.returncode == 0 else None,
                **extra,
            },
        )

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
            headers = {"Cache-Control": "no-cache"} if relative.name == "index.html" else None
            self._send_bytes(200, mime or "application/octet-stream", body, extra_headers=headers)
        elif path == "/":
            self._send_bytes(200, "text/html; charset=utf-8", _BUILD_NOTICE)
        elif path == "/favicon.ico":
            self.send_response(204)
            self.send_header("Content-Length", "0")
            self.end_headers()
        else:
            self._send_json(404, {"error": "Static file not found"})


def create_server(
    repo_path: Path,
    host: str = "127.0.0.1",
    port: int = 7860,
    static_dir: Path | None = None,
    config_path: Path | None = None,
    daemon_spawner: Callable[[Path, Path, str], int] | None = None,
    *,
    credentials_path: Path | None = None,
    provider_probe: _ProviderProbe | None = None,
    pricing_fetcher: pricing.PricingFetcher | None = None,
    folder_picker: Callable[[Path], str | None] | None = None,
) -> ThreadingHTTPServer:
    """Bind a server for the repository and initialize its shared context."""
    repo_path = repo_path.resolve()
    loader = HotReloadConfig(find_config_path(repo_path, config_path))
    store = StateStore(repo_path / loader.current.daemon.db_path)
    if static_dir is None:
        static_dir = Path(__file__).resolve().parents[2] / "web" / "dist"
    static_dir = static_dir.resolve()
    local_credentials_path = credentials.default_credentials_path(credentials_path).resolve()

    server = _CanvasHTTPServer((host, port))
    server.repo_path = repo_path
    server.explicit_config_path = config_path.resolve() if config_path is not None else None
    server.loader = loader
    server.store = store
    server.static_dir = static_dir
    server.daemon_spawner = daemon_spawner
    server.credentials_path = local_credentials_path
    server.provider_probe = credentials.probe_role_or_provider if provider_probe is None else provider_probe
    server.provider_probe_cache = _PROCESS_PROVIDER_PROBES if provider_probe is None else _ProviderProbeCache()
    server.pricing_fetcher = pricing_fetcher
    server.folder_picker = folder_picker
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
        *,
        credentials_path: Path | None = None,
        provider_probe: _ProviderProbe | None = None,
    ) -> None:
        self.server = create_server(
            repo_path, host, port, static_dir, config_path, daemon_spawner,
            credentials_path=credentials_path, provider_probe=provider_probe,
        )
        self.url = f"http://{host}:{self.server.server_address[1]}"

    def serve_forever(self) -> None:
        model_catalog.start_daily_sync(
            cache_path=_model_catalog_cache_path(self.server.credentials_path),
            stop_event=self.server.shutdown_event,
        )
        self.server.serve_forever()

    def shutdown(self) -> None:
        try:
            self.server.shutdown()
        finally:
            self.server.server_close()
