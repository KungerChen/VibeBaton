"""Local HTTP API and static hosting for the VibeBaton canvas."""

from __future__ import annotations

import asyncio
import hashlib
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
from contextlib import contextmanager
from dataclasses import asdict
from decimal import Decimal, InvalidOperation
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from time import monotonic
from typing import Any, Callable, Iterable, Iterator, Mapping, Protocol, TypedDict
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
from .db import ActiveRunError, RunTerminalError, StateStore
from .engine import OrchestrationEngine, StopRunTimeoutError
from .gates import run_gate_suite
from .git_ops import (
    GitError,
    _attach_shared_node_modules,
    _detach_shared_node_modules,
    backup_tag_name,
    create_backup_tag,
    integrate_in_isolated_worktree,
    merge_branch_into,
    reset_branch_to,
    resolve_ref_sha,
    revert_range,
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
    ("GET", re.compile(r"/api/lineup-profiles"), "_get_lineup_profiles"),
    ("POST", re.compile(r"/api/lineup-profiles/last-used"), "_post_lineup_last_used"),
    ("POST", re.compile(r"/api/lineup-profiles"), "_post_lineup_profile"),
    ("DELETE", re.compile(r"/api/lineup-profiles/([^/]+)"), "_delete_lineup_profile"),
    ("POST", re.compile(r"/api/rfc/check"), "_post_rfc_check"),
    ("POST", re.compile(r"/api/rfc/brainstorm"), "_post_rfc_brainstorm"),
    ("GET", re.compile(r"/api/cli-registry"), "_get_cli_registry"),
    ("POST", re.compile(r"/api/cli-registry/scan"), "_post_cli_registry_scan"),
    ("POST", re.compile(r"/api/cli-registry/install"), "_post_cli_registry_install"),
    ("POST", re.compile(r"/api/cli-registry/login"), "_post_cli_registry_login"),
    ("GET", re.compile(r"/api/workspace/info"), "_get_workspace_info"),
    ("POST", re.compile(r"/api/workspace/select"), "_post_workspace_select"),
    ("POST", re.compile(r"/api/workspace/browse"), "_post_workspace_browse"),
    ("POST", re.compile(r"/api/workspace/open"), "_post_workspace_open"),
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
    ("POST", re.compile(r"/api/runs/([^/]+)/request-changes"), "_post_run_request_changes"),
    ("POST", re.compile(r"/api/runs/([^/]+)/rollback"), "_post_run_rollback"),
    ("POST", re.compile(r"/api/runs/([^/]+)/stop-and-replan"), "_post_run_stop_and_replan"),
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


_LINEUP_PROFILES_LOCK = threading.Lock()
_MAX_LINEUP_PROFILES = 50


def _lineup_profiles_path(credentials_path: Path | None) -> Path:
    base = credentials.default_credentials_path(credentials_path)
    return base.parent / "lineup_profiles.json"


def _sanitize_str_map(raw: object) -> dict[str, str]:
    if not isinstance(raw, Mapping):
        return {}
    return {
        key.strip(): val.strip()
        for key, val in raw.items()
        if isinstance(key, str) and key.strip() and isinstance(val, str) and val.strip()
    }


def _read_lineup_store(path: Path) -> dict[str, Any]:
    empty: dict[str, Any] = {"profiles": [], "last_used": None}
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, OSError, ValueError, RecursionError):
        return empty
    if not isinstance(raw, dict):
        return empty
    profiles: list[dict[str, Any]] = []
    seen_ids: set[str] = set()
    for item in raw.get("profiles") if isinstance(raw.get("profiles"), list) else []:
        if not isinstance(item, dict):
            continue
        pid = item.get("id")
        name = item.get("name")
        roles = _sanitize_str_map(item.get("roles"))
        if not isinstance(pid, str) or not pid.strip() or pid in seen_ids:
            continue
        if not isinstance(name, str) or not name.strip() or not roles:
            continue
        seen_ids.add(pid)
        updated_at = item.get("updated_at")
        profiles.append({
            "id": pid.strip(),
            "name": name.strip(),
            "roles": roles,
            "model_overrides": _sanitize_str_map(item.get("model_overrides")),
            "updated_at": float(updated_at) if isinstance(updated_at, (int, float)) and math.isfinite(updated_at) else 0.0,
        })
    last_raw = raw.get("last_used")
    last_used: dict[str, Any] | None = None
    if isinstance(last_raw, dict):
        roles = _sanitize_str_map(last_raw.get("roles"))
        if roles:
            pid = last_raw.get("profile_id")
            pname = last_raw.get("profile_name")
            updated_at = last_raw.get("updated_at")
            last_used = {
                "roles": roles,
                "model_overrides": _sanitize_str_map(last_raw.get("model_overrides")),
                "profile_id": pid.strip() if isinstance(pid, str) and pid.strip() else None,
                "profile_name": pname.strip() if isinstance(pname, str) and pname.strip() else None,
                "updated_at": float(updated_at) if isinstance(updated_at, (int, float)) and math.isfinite(updated_at) else 0.0,
            }
    return {"profiles": profiles, "last_used": last_used}


def _write_lineup_store(path: Path, data: Mapping[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp_file = tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=path.parent, delete=False)
    temp_path = Path(temp_file.name)
    try:
        with temp_file:
            json.dump(dict(data), temp_file, ensure_ascii=False, indent=2)
            temp_file.write("\n")
            temp_file.flush()
            os.fsync(temp_file.fileno())
        os.replace(temp_path, path)
    finally:
        temp_path.unlink(missing_ok=True)


def _save_lineup_profile(
    path: Path,
    name: str,
    roles: dict[str, str],
    model_overrides: dict[str, str],
    profile_id: str | None = None,
) -> dict[str, Any]:
    clean_name = name.strip()
    if not clean_name:
        raise _BadRequest("Profile name must be a non-empty string")
    if not roles:
        raise _BadRequest("roles must be a non-empty mapping")
    now = time.time()
    with _LINEUP_PROFILES_LOCK:
        store = _read_lineup_store(path)
        profiles: list[dict[str, Any]] = store["profiles"]
        existing = next(
            (p for p in profiles if (profile_id and p["id"] == profile_id) or p["name"].lower() == clean_name.lower()),
            None,
        )
        entry = {
            "id": existing["id"] if existing is not None else f"profile-{uuid.uuid4().hex[:8]}",
            "name": clean_name,
            "roles": dict(roles),
            "model_overrides": dict(model_overrides),
            "updated_at": now,
        }
        updated_profiles = [entry, *(p for p in profiles if p["id"] != entry["id"])][:_MAX_LINEUP_PROFILES]
        last_used = store["last_used"]
        if isinstance(last_used, dict) and last_used.get("profile_id") == entry["id"]:
            last_used = {**last_used, "profile_name": entry["name"]}
        next_store = {"profiles": updated_profiles, "last_used": last_used}
        _write_lineup_store(path, next_store)
    return {"profile": entry, **next_store}


def _delete_lineup_profile(path: Path, profile_id: str) -> dict[str, Any] | None:
    with _LINEUP_PROFILES_LOCK:
        store = _read_lineup_store(path)
        remaining = [p for p in store["profiles"] if p["id"] != profile_id]
        if len(remaining) == len(store["profiles"]):
            return None
        last_used = store["last_used"]
        if isinstance(last_used, dict) and last_used.get("profile_id") == profile_id:
            last_used = {**last_used, "profile_id": None, "profile_name": None}
        next_store = {"profiles": remaining, "last_used": last_used}
        _write_lineup_store(path, next_store)
    return next_store


def _save_last_used_lineup(
    path: Path,
    roles: dict[str, str],
    model_overrides: dict[str, str],
    profile_id: str | None = None,
    profile_name: str | None = None,
) -> dict[str, Any]:
    if not roles:
        raise _BadRequest("roles must be a non-empty mapping")
    with _LINEUP_PROFILES_LOCK:
        store = _read_lineup_store(path)
        last_used = {
            "roles": dict(roles),
            "model_overrides": dict(model_overrides),
            "profile_id": profile_id.strip() if isinstance(profile_id, str) and profile_id.strip() else None,
            "profile_name": profile_name.strip() if isinstance(profile_name, str) and profile_name.strip() else None,
            "updated_at": time.time(),
        }
        next_store = {"profiles": store["profiles"], "last_used": last_used}
        _write_lineup_store(path, next_store)
    return next_store


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


class _LineageError(Exception):
    """A non-destructive, machine-readable lifecycle rejection."""

    def __init__(self, code: str, message: str, **details: Any) -> None:
        super().__init__(message)
        self.code, self.details = code, details


class _KeyedLaunchStore(StateStore):
    """Attach a launch key to the engine's insert in the same SQLite transaction.

    The connection-local trigger applies only to this run ID and disappears on
    close. Existing engine admission, snapshot cleanup and DB uniqueness rules
    remain in force without changing their public signatures.
    """

    def __init__(self, store: StateStore, run_id: str, request_id: str) -> None:
        self.db_path = store.db_path
        self.run_id = run_id
        self.request_id = request_id

    @contextmanager
    def _connect(self) -> Iterator[sqlite3.Connection]:
        with super()._connect() as conn:
            run_literal, key_literal = conn.execute("SELECT quote(?), quote(?)", (self.run_id, self.request_id)).fetchone()
            conn.execute(
                "CREATE TEMP TRIGGER keyed_launch_insert AFTER INSERT ON main.runs "
                f"WHEN NEW.id = {run_literal} BEGIN "
                f"UPDATE runs SET launch_request_id = {key_literal} WHERE id = NEW.id; END"
            )
            yield conn


def _checked_out_locations(repo: Path, branch: str) -> list[Path]:
    entries = _git_stdout(repo, "worktree", "list", "--porcelain", "-z").split("\0\0")
    paths: list[Path] = []
    for entry in entries:
        fields = entry.split("\0")
        if f"branch refs/heads/{branch}" in fields:
            paths.extend(Path(field[9:]).resolve() for field in fields if field.startswith("worktree "))
    return paths


def _move_base_ref(repo: Path, branch: str, expected: str, target: str,
                   *, verify_run: tuple[str, str] | None = None) -> None:
    """Move a base ref with compare-and-swap and synchronize our checkout."""
    _git_stdout(repo, "check-ref-format", f"refs/heads/{branch}")
    locations = _checked_out_locations(repo, branch)
    if any(path != repo.resolve() for path in locations):
        raise _LineageError("BASE_CHECKED_OUT", f"{branch} is checked out in another worktree")
    dirty = uncommitted_paths(repo)
    if dirty:
        raise _LineageError("DIRTY_WORKTREE", f"Commit or stash uncommitted changes first: {', '.join(dirty)}")
    on_base = repo.resolve() in locations
    if on_base:
        _git_stdout(repo, "checkout", "-q", "--detach")
    try:
        if on_base:
            # Detect checkout conflicts, including tracked .baton files, before
            # moving the ref. The dry run leaves the index and worktree intact.
            _git_stdout(repo, "read-tree", "--dry-run", "-m", "-u", expected, target)
        try:
            if verify_run is None:
                _git_stdout(repo, "update-ref", f"refs/heads/{branch}", target, expected)
            else:
                run_branch, run_sha = verify_run
                run_ref = f"refs/heads/{run_branch}"
                _git_stdout(repo, "check-ref-format", run_ref)
                transaction = (f"start\nverify {run_ref} {run_sha}\n"
                               f"update refs/heads/{branch} {target} {expected}\nprepare\ncommit\n")
                result = subprocess.run(["git", "-C", str(repo), "update-ref", "--stdin"],
                                        input=transaction.encode("utf-8"), capture_output=True,
                                        timeout=_GIT_TIMEOUT_SEC, check=False)
                if result.returncode:
                    raise GitError((result.stderr or result.stdout).decode("utf-8", errors="replace").strip())
        except GitError as exc:
            if verify_run is not None:
                try:
                    actual_run = resolve_ref_sha(repo, f"refs/heads/{verify_run[0]}")
                except GitError:
                    actual_run = None
                if actual_run != verify_run[1]:
                    raise _LineageError("RUN_STALE", "Run branch changed during approval") from exc
            raise _LineageError("BASE_MOVED", f"{branch} changed during the operation; retry") from exc
    finally:
        if on_base:
            _git_stdout(repo, "checkout", "-q", branch)


def _lineage_gate_commands(store: StateStore, chain: list[dict[str, Any]]) -> list[str]:
    """Collect the task and milestone commands recorded for the entire chain."""
    commands: list[str] = []
    try:
        for run in chain:
            for task in store.get_tasks(run["id"]):
                spec = json.loads(task["spec_json"])
                if not isinstance(spec, dict):
                    raise ValueError("Task specification is not an object")
                command = spec.get("verify_cmd")
                if command is not None and not isinstance(command, str):
                    raise ValueError("Task verify_cmd is not a string")
                if command and command.strip():
                    commands.append(command)
            for milestone in store.get_milestones(run["id"]):
                gates = json.loads(milestone["gate_commands_json"])
                if not isinstance(gates, list) or any(not isinstance(cmd, str) for cmd in gates):
                    raise ValueError("Milestone gate_commands is not a string list")
                commands.extend(cmd for cmd in gates if cmd.strip())
    except (KeyError, TypeError, ValueError) as exc:
        raise _LineageError("INVALID_GATES", f"Cannot read configured gates: {exc}") from exc
    return commands


def _gate_integrated_commit(repo: Path, sha: str, commands: list[str], worktree_root: Path) -> list[dict[str, Any]]:
    """Run the recorded commands against the exact integrated commit."""
    worktree_root.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="baton-gates-", dir=worktree_root) as temp_dir:
        worktree = Path(temp_dir) / "worktree"
        added = False
        try:
            _git_stdout(repo, "worktree", "add", "--detach", "--", str(worktree), sha)
            added = True
            _attach_shared_node_modules(repo, worktree)
            try:
                suite = asyncio.run(run_gate_suite(commands, workdir=worktree))
            except (OSError, subprocess.SubprocessError) as exc:
                raise _LineageError("GATE_EXECUTION_FAILED", f"Could not run configured gates: {exc}") from exc
            results = [asdict(result) for result in suite.results]
            if not suite.passed:
                raise _LineageError("GATE_FAILED", "Integrated result failed its configured gates", gates=results)
            return results
        finally:
            if added:
                _detach_shared_node_modules(worktree)
                _git_stdout(repo, "worktree", "remove", "--force", "--", str(worktree))


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


_DEFAULT_GIT_IDENTITY = (("user.name", "VibeBaton"), ("user.email", "vibebaton@localhost"))


def _make_first_commit(repo: Path) -> str | None:
    """Give a repository without commits an empty root commit; return a short error, or None.

    The user's files are never staged. When git resolves no ``user.name``/``user.email`` (global or
    local), a repo-local default identity is written first; an existing identity is never replaced.
    """
    for key, value in _DEFAULT_GIT_IDENTITY:
        current = _git(repo, "config", key)
        if current is None:
            return "git is not available"
        if current.returncode != 0 or not current.stdout.strip():
            _git(repo, "config", "--local", key, value)
    commit = _git(repo, "commit", "--allow-empty", "-q", "-m", "chore: initialize repository")
    if commit is None or commit.returncode != 0:
        detail = "git is not available" if commit is None else (commit.stderr or commit.stdout).strip()
        return f"The first commit failed: {detail[:300]}"
    return None


def _open_local_path(target: Path, *, reveal: bool = False) -> None:
    """Open a local file or reveal it inside the OS file manager without invoking a shell."""
    if sys.platform == "win32":
        if reveal and target.is_file():
            subprocess.Popen(["explorer", f"/select,{target}"], shell=False)
        else:
            os.startfile(str(target))
    elif sys.platform == "darwin":
        argv = ["open", "-R", str(target)] if reveal and target.is_file() else ["open", str(target)]
        subprocess.Popen(argv, shell=False)
    else:
        open_target = target.parent if reveal and target.is_file() else target
        subprocess.Popen(["xdg-open", str(open_target)], shell=False)


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
        self._launch_lock = threading.Lock()
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
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
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
        if self.command in {"POST", "PUT", "DELETE", "OPTIONS"} and origin is not None and not _allowed_origin(origin):
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
                except _LineageError as exc:
                    self._send_json(409, {"error": str(exc), "code": exc.code, **exc.details})
                except RunTerminalError as exc:
                    code = "RUN_SUPERSEDED" if exc.status == RunStatus.SUPERSEDED.value else "RUN_STALE"
                    self._send_json(409, {"error": str(exc), "code": code})
                except ActiveRunError as exc:
                    self._send_json(409, {"error": str(exc), "code": "RUN_BUSY"})
                except GitError as exc:
                    self._send_json(409, {"error": str(exc), "code": "GIT_ERROR"})
                return
        if self.command == "GET" and path != "/api" and not path.startswith("/api/"):
            self._serve_static(raw_path, path)
        else:
            self._send_json(404, {"error": "Route not found"})

    do_GET = _dispatch
    do_POST = _dispatch
    do_PUT = _dispatch
    do_DELETE = _dispatch

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

    def _get_lineup_profiles(self) -> None:
        path = _lineup_profiles_path(self.server.credentials_path)
        self._send_json(200, _read_lineup_store(path))

    def _post_lineup_profile(self) -> None:
        payload = self._read_json_body()
        name = _text_field(payload, "name")
        roles = _sanitize_str_map(payload.get("roles"))
        model_overrides = _sanitize_str_map(payload.get("model_overrides"))
        raw_id = payload.get("id")
        profile_id = raw_id.strip() if isinstance(raw_id, str) and raw_id.strip() else None
        path = _lineup_profiles_path(self.server.credentials_path)
        try:
            result = _save_lineup_profile(path, name, roles, model_overrides, profile_id)
        except OSError:
            self._send_json(500, {"error": "Lineup profiles could not be saved"})
            return
        self._send_json(200, result)

    def _post_lineup_last_used(self) -> None:
        payload = self._read_json_body()
        roles = _sanitize_str_map(payload.get("roles"))
        model_overrides = _sanitize_str_map(payload.get("model_overrides"))
        raw_id = payload.get("profile_id")
        raw_name = payload.get("profile_name")
        profile_id = raw_id.strip() if isinstance(raw_id, str) and raw_id.strip() else None
        profile_name = raw_name.strip() if isinstance(raw_name, str) and raw_name.strip() else None
        path = _lineup_profiles_path(self.server.credentials_path)
        try:
            result = _save_last_used_lineup(path, roles, model_overrides, profile_id, profile_name)
        except OSError:
            self._send_json(500, {"error": "Last-used lineup could not be saved"})
            return
        self._send_json(200, result)

    def _delete_lineup_profile(self, profile_id: str) -> None:
        path = _lineup_profiles_path(self.server.credentials_path)
        try:
            result = _delete_lineup_profile(path, profile_id)
        except OSError:
            self._send_json(500, {"error": "Lineup profile could not be deleted"})
            return
        if result is None:
            self._send_json(404, {"error": f"Unknown lineup profile: {profile_id}"})
            return
        self._send_json(200, result)

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

    def _post_workspace_open(self) -> None:
        payload = self._read_json_body(optional=True)
        raw_path = payload.get("path")
        reveal = bool(payload.get("reveal", False))
        repo_root = self.server.repo_path.resolve()
        if raw_path is None or (isinstance(raw_path, str) and not raw_path.strip()):
            target = repo_root
        elif isinstance(raw_path, str):
            target = (repo_root / raw_path.strip()).resolve()
            if not target.is_relative_to(repo_root):
                self._send_json(400, {"error": "Path must stay inside the active workspace."})
                return
        else:
            raise _BadRequest("path must be a string")
        if not target.exists():
            label = raw_path.strip() if isinstance(raw_path, str) and raw_path.strip() else str(repo_root)
            self._send_json(404, {"error": f"Path not found: {label}"})
            return
        opener = getattr(self.server, "path_opener", None) or _open_local_path
        opener(target, reveal=reveal)
        self._send_json(200, {"ok": True, "path": str(target), "reveal": reveal})

    def _post_workspace_init_git(self) -> None:
        self._read_json_body(optional=True)
        repo = self.server.repo_path
        info = _workspace_info(repo)
        created = not info["is_git_repo"]
        if not created:
            if not info["has_commits"]:  # an earlier init left no commit: repair in place, no re-init
                error = _make_first_commit(repo)
                if error:
                    self._send_json(500, {"error": error})
                    return
            self._send_json(200, {**_workspace_info(repo), "created": False})
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
        error = _make_first_commit(repo)
        if error:
            self._send_json(500, {"error": error})
            return
        self._send_json(200, {**_workspace_info(repo), "created": created})

    def _lineup_overrides(self, payload: dict[str, Any]) -> dict[str, str]:
        """``model_overrides`` plus the Guided lineup's ``role_providers`` turned into overrides."""
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
        return overrides

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
        # The Guided page sends its lineup so the brainstorm runs on the L0 model chosen there.
        overrides = self._lineup_overrides(payload) or None
        config = None
        if not offline:  # without a config brainstorm_turn uses the offline composer
            with self.server.config_lock:
                config = self.server.loader.current
        try:
            result = brainstorm_turn(
                self.server.repo_path, payload.get("messages"), scenario, config, locale=locale,
                model_overrides=overrides,
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
                    "parent_run_id": run.get("parent_run_id"),
                    "base_ref": run.get("base_ref"),
                    "start_sha": run.get("start_sha"),
                    "result_sha": run.get("result_sha"),
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
        with self.server._launch_lock:
            self._start_run(payload)

    def _existing_launch(self, request_id: str, deterministic_id: str) -> dict[str, Any] | None:
        store = self.server.store
        run = store.get_run_by_launch_request_id(request_id) or store.get_run(deterministic_id)
        if run is None:
            return None
        if (Path(run["repo_path"]).resolve() != self.server.repo_path
                or run["launch_request_id"] not in (None, request_id)):
            raise _LineageError("LAUNCH_KEY_CONFLICT", "Launch request ID belongs to another run")
        if run["launch_request_id"] is None:
            # The deterministic run ID is durable in the creation transaction.
            # Recover the indexed key if a process stopped immediately after insert.
            with store._connect() as conn:
                conn.execute("UPDATE runs SET launch_request_id = ? WHERE id = ? AND launch_request_id IS NULL",
                             (request_id, run["id"]))
            run = store.get_run(run["id"])
        return run

    def _send_existing_launch(self, run: dict[str, Any]) -> None:
        self._send_json(200, {"run_id": run["id"], "daemon_pid": None,
                              "status": run["status"], "reused": True})

    def _start_run(self, payload: dict[str, Any]) -> None:
        request_id = payload.get("launch_request_id")
        if request_id is not None:
            if (not isinstance(request_id, str) or not request_id.strip() or len(request_id) > 256
                    or "\0" in request_id):
                raise _BadRequest("launch_request_id must be a non-empty string of at most 256 characters")
            try:
                request_bytes = request_id.encode("utf-8")
            except UnicodeEncodeError as exc:
                raise _BadRequest("launch_request_id must be valid UTF-8 text") from exc
            deterministic_id = "run-request-" + hashlib.sha256(request_bytes).hexdigest()
            existing = self._existing_launch(request_id, deterministic_id)
            if existing is not None:
                self._send_existing_launch(existing)
                return
        else:
            deterministic_id = None
        mode = payload.get("mode", "overnight")
        if mode not in ("overnight", "interactive", "panel"):
            raise _BadRequest("mode must be overnight, interactive or panel")
        overrides = self._lineup_overrides(payload)
        markdown = payload.get("rfc_markdown", "")
        if not isinstance(markdown, str):
            raise _BadRequest("rfc_markdown must be a string")

        repo = self.server.repo_path
        info = _workspace_info(repo)
        if info["is_git_repo"] and not info["has_commits"]:
            # The engine branches off the base branch's head; without a commit it would fail right away.
            raise _BadRequest(
                "This repository has no commits yet. Create the first commit "
                "(Guided Workspace: Turn On Version History) before starting a run."
            )
        created_rfc = False
        if markdown.strip():
            try:
                rfc_path = _save_ui_rfc(repo, markdown)
                created_rfc = True
            except OSError as exc:
                self._send_json(500, {"error": f"Cannot save RFC markdown ({exc})"})
                return
        else:
            supplied_path = payload.get("rfc_path")
            if not isinstance(supplied_path, str) or not supplied_path.strip():
                raise _BadRequest("Provide rfc_markdown or rfc_path")
            rfc_path = _resolve_rfc_path(repo, supplied_path)

        store = self.server.store
        creation_store = (_KeyedLaunchStore(store, deterministic_id, request_id)
                          if request_id is not None and deterministic_id is not None else store)
        try:
            if info["is_git_repo"]:
                engine = OrchestrationEngine(repo, self.server.loader, creation_store,
                                             credentials_path=self.server.credentials_path)
                run_id = engine.create_run(rfc_path, mode=mode, model_overrides=overrides,
                                           run_id=deterministic_id)
            else:
                # Preserve the historical non-Git canvas behavior.
                run_id = creation_store.create_run(repo_path=repo, rfc_path=rfc_path, mode=mode,
                                                   plan_path=None, model_overrides=overrides, run_id=deterministic_id)
        except (ActiveRunError, ValueError, sqlite3.IntegrityError, GitError) as exc:
            if request_id is not None:
                existing = self._existing_launch(request_id, deterministic_id)
                if existing is not None:
                    if created_rfc:
                        rfc_path.unlink(missing_ok=True)
                    self._send_existing_launch(existing)
                    return
            if created_rfc:
                rfc_path.unlink(missing_ok=True)
            if isinstance(exc, (ActiveRunError, GitError)):
                raise
            raise _LineageError("LAUNCH_FAILED", f"Could not create run: {exc}") from exc
        if request_id is not None:
            self._existing_launch(request_id, deterministic_id)
        pid = self._spawn_run_daemon(run_id, RunStatus.FAILED)
        if pid is not None:
            store.log_event(run_id, "daemon_spawned", message=f"Detached daemon started (pid={pid})")
            self._send_json(201, {"run_id": run_id, "daemon_pid": pid, "status": "STARTED"})

    def _post_run_control(self, run_id: str) -> None:
        store = self.server.store
        run = store.get_run(run_id)
        if run is None:
            self._send_run_not_found(run_id)
            return
        action = self._read_json_body().get("action")
        if action not in ("pause", "resume"):
            raise _BadRequest("action must be pause or resume")
        if run["status"] == RunStatus.SUPERSEDED.value:
            raise RunTerminalError(run_id, run["status"])
        if action == "pause":
            status, kind = RunStatus.PAUSED, "run_paused"
        else:
            status, kind = RunStatus.RUNNING, "run_resumed"
        if action == "resume" and run["start_sha"]:
            self._validate_run_branch(run)
            store.resume_run(run_id)
        else:
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
        run = store.get_run(run_id)
        if run is None:
            self._send_run_not_found(run_id)
            return
        if run["status"] == RunStatus.SUPERSEDED.value:
            raise RunTerminalError(run_id, run["status"])
        if store.is_stop_requested(run_id):
            raise ActiveRunError(f"Run {run_id} is stopping for replan")
        if run["start_sha"]:
            self._validate_run_branch(run)
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

    def _validate_run_branch(self, run: dict[str, Any]) -> None:
        if not run["start_sha"]:
            return
        try:
            actual = resolve_ref_sha(self.server.repo_path, OrchestrationEngine.run_branch(run["id"]))
            if run["result_sha"] and actual != resolve_ref_sha(self.server.repo_path, run["result_sha"]):
                raise _LineageError("RUN_STALE", "Run branch no longer matches its recorded result")
        except GitError as exc:
            raise _LineageError("RUN_STALE", f"Run branch or recorded result is unavailable: {exc}") from exc

    def _lineage_chain(self, run: dict[str, Any]) -> list[dict[str, Any]]:
        try:
            chain = self.server.store.get_run_lineage_chain(run["id"])
        except ValueError as exc:
            raise _LineageError("RUN_STALE", str(exc)) from exc
        if not chain or not chain[0]["start_sha"] or not run["base_ref"]:
            raise _LineageError("RUN_STALE", "Run lineage has no recorded base")
        for parent, child in zip(chain, chain[1:]):
            if (not parent["result_sha"] or child["start_sha"] != parent["result_sha"]
                    or child["base_ref"] != chain[0]["base_ref"]):
                raise _LineageError("RUN_STALE", "Run lineage does not match its parent results")
        self._validate_run_branch(run)
        return chain

    def _request_changes(self, run: dict[str, Any], note: str, *, allow_stopped: bool = False) -> None:
        store, repo = self.server.store, self.server.repo_path
        run_id = run["id"]
        if run["status"] == RunStatus.SUPERSEDED.value and not (allow_stopped and store.is_stop_requested(run_id)):
            raise RunTerminalError(run_id, run["status"])
        self._lineage_chain(run)
        if not run["result_sha"]:
            raise _LineageError("RUN_STALE", "A revision requires a recorded result commit")
        source = Path(run["rfc_snapshot_path"] or run["rfc_path"])
        try:
            original = source.read_text(encoding="utf-8")
            overrides = json.loads(run["model_overrides_json"] or "{}")
            if not isinstance(overrides, dict):
                raise ValueError("Run model overrides are not an object")
            directory = repo / ".baton" / "ui_rfcs"
            directory.mkdir(parents=True, exist_ok=True)
            with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", suffix=".md", dir=directory,
                                             delete=False) as temp:
                temporary = Path(temp.name)
                temp.write(original.rstrip() + "\n\n## Requested changes\n\n" + note.strip() + "\n")
            child = f"run-{time.strftime('%Y%m%d-%H%M%S')}-{uuid.uuid4().hex}"
            revisions = repo / ".baton" / "runs" / child / "revisions.md"
            made_directory = False
            try:
                revisions.parent.mkdir(parents=True, exist_ok=False)
                made_directory = True
                revisions.write_text(f"## Revision request\n\n{note.strip()}\n", encoding="utf-8")
                engine = OrchestrationEngine(repo, self.server.loader, store,
                                             credentials_path=self.server.credentials_path)
                child = engine.create_run(temporary, parent_run_id=run_id, mode=run["mode"],
                                          model_overrides=overrides, run_id=child)
            except BaseException:
                if made_directory:
                    revisions.unlink(missing_ok=True)
                    try:
                        revisions.parent.rmdir()
                    except OSError:
                        pass
                raise
            finally:
                temporary.unlink(missing_ok=True)
            store.log_event(run_id, "revision_requested", actor="human", message=note,
                            payload={"revision_run_id": child})
        except (OSError, UnicodeError, json.JSONDecodeError) as exc:
            raise _LineageError("REVISION_FAILED", f"Could not create revision: {exc}") from exc
        except ValueError as exc:
            if isinstance(exc, (RunTerminalError, ActiveRunError)):
                raise
            raise _LineageError("RUN_STALE", str(exc)) from exc
        pid = self._spawn_run_daemon(child, RunStatus.FAILED)
        if pid is None:
            return
        store.log_event(child, "daemon_spawned", message=f"Detached daemon started (pid={pid})")
        self._send_json(200, {
            "ok": True, "run_id": run_id, "action": "revise", "status": "SUPERSEDED",
            "backup_tag": None, "base_branch": run["base_ref"],
            "base_head": resolve_ref_sha(repo, run["base_ref"]), "revisions_path": str(revisions),
            "revision_run_id": child, "revision_status": store.get_run(child)["status"], "daemon_pid": pid,
        })

    def _post_run_request_changes(self, run_id: str) -> None:
        run = self.server.store.get_run(run_id)
        if run is None:
            self._send_run_not_found(run_id)
            return
        note = self._read_json_body().get("note")
        if not isinstance(note, str) or not note.strip():
            raise _BadRequest("note must be a non-empty string")
        if not run["start_sha"]:
            raise _LineageError("RUN_STALE", "Request Changes requires a lineage run")
        self._request_changes(run, note, allow_stopped=True)

    def _approve_lineage(self, run: dict[str, Any], note: str) -> None:
        store, repo, run_id = self.server.store, self.server.repo_path, run["id"]
        if run["status"] != RunStatus.READY_FOR_FINAL_GATE.value:
            raise _LineageError("RUN_STALE", f"Run is {run['status']}, not READY_FOR_FINAL_GATE")
        token = store.claim_run_execution(run_id)
        try:
            chain = self._lineage_chain(run)
            if not run["result_sha"]:
                raise _LineageError("RUN_STALE", "Run has no recorded result")
            base, root = run["base_ref"], chain[0]["start_sha"]
            base_head = resolve_ref_sha(repo, f"refs/heads/{base}")
            result_sha = resolve_ref_sha(repo, run["result_sha"])
            ancestor = _git(repo, "merge-base", "--is-ancestor", root, result_sha)
            if ancestor is None or ancestor.returncode != 0:
                raise _LineageError("RUN_STALE", "Run result does not descend from its recorded base")
            dirty = uncommitted_paths(repo)
            if dirty:
                raise _LineageError("DIRTY_WORKTREE", f"Commit or stash uncommitted changes first: {', '.join(dirty)}")
            drifted = base_head != resolve_ref_sha(repo, root)
            gates: list[dict[str, Any]] = []
            if drifted:
                worktree_root = Path(self.server.loader.current.daemon.worktree_root)
                if not worktree_root.is_absolute():
                    worktree_root = repo / worktree_root
                integrated = integrate_in_isolated_worktree(repo, base_head, result_sha, worktree_root=worktree_root)
                if integrated["conflicts"]:
                    raise _LineageError("INTEGRATION_CONFLICT", "Run conflicts with the current base",
                                        conflicts=integrated["conflicts"], base_head=base_head)
                target = integrated["integrated_sha"]
                if not target:
                    raise _LineageError("INTEGRATION_FAILED", "Integration returned no commit")
                gates = _gate_integrated_commit(repo, target, _lineage_gate_commands(store, chain), worktree_root)
            else:
                target = result_sha
            changed = _git_stdout(repo, "diff", "--name-only", base_head, target).splitlines()
            with store._connect() as conn:
                conn.execute("BEGIN IMMEDIATE")
                current = conn.execute("SELECT status, result_sha FROM runs WHERE id = ?", (run_id,)).fetchone()
                stop = conn.execute("SELECT 1 FROM run_stop_requests WHERE run_id = ?", (run_id,)).fetchone()
                owner = conn.execute("SELECT token FROM run_execution_locks WHERE run_id = ?", (run_id,)).fetchone()
                if (not current or current["status"] != RunStatus.READY_FOR_FINAL_GATE.value
                        or current["result_sha"] != run["result_sha"] or stop or not owner or owner["token"] != token):
                    raise _LineageError("RUN_STALE", "Run changed during approval")
                self._validate_run_branch(run)
                if resolve_ref_sha(repo, f"refs/heads/{base}") != base_head:
                    raise _LineageError("BASE_MOVED", "Base changed during integration; retry approval")
                backup_tag = create_backup_tag(repo, run_id, base_head)
                _move_base_ref(repo, base, base_head, target,
                               verify_run=(OrchestrationEngine.run_branch(run_id), result_sha))
                now = time.time()
                conn.execute("UPDATE runs SET status = ?, updated_at = ?, finished_at = ? WHERE id = ?",
                             (RunStatus.COMPLETED.value, now, now, run_id))
                approval = {"backup_tag": backup_tag, "base_branch": base,
                            "dev_branch": OrchestrationEngine.run_branch(run_id), "merged_commit": target,
                            "pre_merge_head": base_head, "drifted": drifted}
                conn.execute("INSERT INTO events (run_id, kind, actor, message, payload_json, created_at) "
                             "VALUES (?, ?, ?, ?, ?, ?)",
                             (run_id, "final_gate_approved", "human", note, json.dumps(approval), now))
            self._send_json(200, {"ok": True, "run_id": run_id, "action": "approve", "status": "COMPLETED",
                                  "backup_tag": backup_tag, "base_branch": base, "base_head": target,
                                  "merged_commit": target, "changed_files": changed,
                                  "reintegrated": drifted, "gates": gates})
        finally:
            store.release_run_execution(run_id, token)

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
        if run["status"] == RunStatus.SUPERSEDED.value:
            raise RunTerminalError(run_id, run["status"])
        if store.is_stop_requested(run_id):
            raise ActiveRunError(f"Run {run_id} is stopping for replan")
        if run["start_sha"]:
            if action == "revise":
                self._request_changes(run, note)
            elif action == "approve":
                self._approve_lineage(run, note)
            else:
                self._rollback_lineage(run, "undo", note, legacy_response=True)
            return
        repo = self.server.repo_path
        if action in ("approve", "revise") and run["status"] in (RunStatus.COMPLETED.value, RunStatus.FAILED.value):
            raise RunTerminalError(run_id, run["status"])
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
                    self._send_json(409, {"error": f"Run is {run['status']}, not READY_FOR_FINAL_GATE", "code": "RUN_STALE"})
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

    def _post_run_rollback(self, run_id: str) -> None:
        run = self.server.store.get_run(run_id)
        if run is None:
            self._send_run_not_found(run_id)
            return
        payload = self._read_json_body()
        mode = payload.get("mode")
        if mode not in ("revert_revision", "abandon_all", "undo"):
            raise _BadRequest("mode must be revert_revision, abandon_all or undo")
        note = payload.get("note", "")
        if not isinstance(note, str):
            raise _BadRequest("note must be a string")
        if run["status"] == RunStatus.SUPERSEDED.value:
            raise RunTerminalError(run_id, run["status"])
        if not run["start_sha"]:
            raise _LineageError("RUN_STALE", "Explicit rollback modes require a lineage run")
        self._rollback_lineage(run, mode, note)

    def _rollback_lineage(self, run: dict[str, Any], mode: str, note: str,
                          *, legacy_response: bool = False) -> None:
        store, repo, run_id = self.server.store, self.server.repo_path, run["id"]
        base = run["base_ref"]
        if mode == "undo":
            if run["status"] != RunStatus.COMPLETED.value:
                raise _LineageError("RUN_STALE", "Only an approved run can be undone")
            with store._connect() as conn:
                conn.execute("BEGIN IMMEDIATE")
                current = conn.execute("SELECT status FROM runs WHERE id = ?", (run_id,)).fetchone()
                event = conn.execute("SELECT kind, payload_json FROM events WHERE run_id = ? "
                                     "AND kind IN ('final_gate_approved', 'final_gate_rolled_back') "
                                     "ORDER BY id DESC LIMIT 1", (run_id,)).fetchone()
                if not current or current["status"] != RunStatus.COMPLETED.value or not event or event["kind"] != "final_gate_approved":
                    raise _LineageError("RUN_STALE", "Run has no approved final-gate merge to undo")
                approved = _json_object(event["payload_json"])
                merged, target = approved.get("merged_commit"), approved.get("pre_merge_head")
                if not isinstance(merged, str) or not isinstance(target, str) or approved.get("base_branch") != base:
                    raise _LineageError("RUN_STALE", "Approval did not record a valid pre-merge base")
                head = resolve_ref_sha(repo, f"refs/heads/{base}")
                if head != merged:
                    raise _LineageError(
                        "MERGE_NOT_HEAD", f"{base} has advanced beyond this run's merge",
                        merged_commit=merged, base_head=head,
                        guidance=f"Review git log {target}..{merged}; use git revert for the run's commits. "
                                 "For a merge commit, use git revert -m 1 <merge-commit>; preserve later commits.",
                    )
                conflict = store._conflicting_run(conn, conn.execute("SELECT * FROM runs WHERE id = ?", (run_id,)).fetchone())
                if conflict:
                    raise _LineageError("RUN_BUSY", f"Repository already has active run {conflict}")
                if merged != target:
                    _move_base_ref(repo, base, merged, target)
                now = time.time()
                conn.execute("UPDATE runs SET status = ?, updated_at = ? WHERE id = ?",
                             (RunStatus.PAUSED.value, now, run_id))
                conn.execute("INSERT INTO events (run_id, kind, actor, message, payload_json, created_at) "
                             "VALUES (?, ?, ?, ?, ?, ?)",
                             (run_id, "final_gate_rolled_back", "human", note,
                              json.dumps({"base_branch": base, "restored_to": target}), now))
            backup_tag = approved.get("backup_tag")
        else:
            if run["status"] not in (RunStatus.READY_FOR_FINAL_GATE.value, RunStatus.PAUSED.value):
                raise _LineageError("RUN_STALE", "Unmerged rollback requires a settled run")
            token = store.claim_run_execution(run_id)
            try:
                chain = self._lineage_chain(run)
                if not run["result_sha"]:
                    raise _LineageError("RUN_STALE", "Run has no recorded result to roll back")
                if mode == "revert_revision" and len(chain) < 2:
                    raise _LineageError("RUN_STALE", "Root runs have no revision to revert")
                target = run["start_sha"] if mode == "revert_revision" else chain[0]["start_sha"]
                branch = OrchestrationEngine.run_branch(run_id)
                if _checked_out_locations(repo, branch):
                    raise _LineageError("RUN_BUSY", "Run branch is checked out in a worktree")
                with store._connect() as conn:
                    conn.execute("BEGIN IMMEDIATE")
                    current = conn.execute("SELECT status, result_sha FROM runs WHERE id = ?", (run_id,)).fetchone()
                    stop = conn.execute("SELECT 1 FROM run_stop_requests WHERE run_id = ?", (run_id,)).fetchone()
                    owner = conn.execute("SELECT token FROM run_execution_locks WHERE run_id = ?", (run_id,)).fetchone()
                    if (not current or current["status"] not in ("READY_FOR_FINAL_GATE", "PAUSED")
                            or current["result_sha"] != run["result_sha"] or stop or not owner or owner["token"] != token):
                        raise _LineageError("RUN_STALE", "Run changed during rollback")
                    head = resolve_ref_sha(repo, f"refs/heads/{base}")
                    is_merged = _git(repo, "merge-base", "--is-ancestor", run["result_sha"], head)
                    if is_merged is None or is_merged.returncode not in (0, 1):
                        raise _LineageError("GIT_ERROR", "Could not verify whether the run result is already merged")
                    if run["result_sha"] != run["start_sha"] and is_merged.returncode == 0:
                        raise _LineageError("RUN_STALE", "Run result is already contained in the base branch")
                    target = revert_range(repo, branch, run["result_sha"], target)
                    now = time.time()
                    conn.execute("UPDATE runs SET result_sha = ?, status = ?, updated_at = ? WHERE id = ?",
                                 (target, RunStatus.PAUSED.value, now, run_id))
                    conn.execute("INSERT INTO events (run_id, kind, actor, message, payload_json, created_at) "
                                 "VALUES (?, ?, ?, ?, ?, ?)",
                                 (run_id, "lineage_rolled_back", "human", note,
                                  json.dumps({"mode": mode, "from_sha": run["result_sha"], "restored_to": target}), now))
                backup_tag = None
            finally:
                store.release_run_execution(run_id, token)
        response: dict[str, Any] = {"ok": True, "run_id": run_id, "mode": mode, "status": "PAUSED",
                                    "restored_to": target, "base_branch": base,
                                    "base_head": resolve_ref_sha(repo, f"refs/heads/{base}")}
        if legacy_response:
            response.update(action="rollback", backup_tag=backup_tag)
        self._send_json(200, response)

    def _post_run_stop_and_replan(self, run_id: str) -> None:
        run = self.server.store.get_run(run_id)
        if run is None:
            self._send_run_not_found(run_id)
            return
        payload = self._read_json_body()
        timeout = payload.get("timeout_sec", 30.0)
        if isinstance(timeout, bool) or not isinstance(timeout, (int, float)) or not math.isfinite(timeout) or not 0 <= timeout <= 30:
            raise _BadRequest("timeout_sec must be a number between 0 and 30")
        engine = OrchestrationEngine(self.server.repo_path, self.server.loader, self.server.store,
                                     credentials_path=self.server.credentials_path)
        try:
            context = asyncio.run(engine.stop_run_for_replan(run_id, timeout_sec=float(timeout)))
        except StopRunTimeoutError as exc:
            raise _LineageError("STOP_PENDING", str(exc)) from exc
        except ValueError as exc:
            if isinstance(exc, (RunTerminalError, ActiveRunError)):
                raise
            raise _LineageError("RUN_STALE", str(exc)) from exc
        self._send_json(200, {"ok": True, "status": "SUPERSEDED", **context})

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
