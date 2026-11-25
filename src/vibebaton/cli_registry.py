"""Universal AI coding CLI driver registry: catalog loading, install allowlist, host scan contracts.

The bundled catalog lives in ``presets/cli_registry.json``. Its ``claude`` entry is the
canonical driver shape; every other driver copies it field for field.

Security invariant: every command in the registry is an argv list (never a shell string),
and install recipes must start with one of ``ALLOWED_INSTALL_PREFIXES``. Commands are only
ever taken from the trusted registry, never from client requests.
"""

from __future__ import annotations

import json
import re
import subprocess  # contract: scan/install/login run argv lists via subprocess (tests patch it here)
import sys
import time
from pathlib import Path
from typing import Any, Literal, Mapping, NotRequired, TypedDict

from . import credentials
from .cli_runner import resolve_cli_binary  # contract: binary discovery (tests patch it here)
from .config import BatonConfig, ProviderConfig

REGISTRY_PATH = Path(__file__).resolve().parents[2] / "presets" / "cli_registry.json"
SCHEMA_VERSION = 1

REQUIRED_DRIVER_IDS = ("claude", "codex", "dsh", "gemini", "opencode", "aider", "qwen", "copilot")
ALLOWED_INSTALL_PREFIXES: tuple[tuple[str, ...], ...] = (
    ("npm",), ("npm.cmd",), ("pip",), ("pipx",), ("uv",), ("brew",), ("winget",), ("gh",),
)
DRIVER_TIERS = ("official", "community")
# Runtime prerequisite id -> candidate binaries probed with ``resolve_cli_binary`` (first hit wins).
PREREQ_BINARIES: dict[str, tuple[str, ...]] = {
    "node": ("node",),
    "python": ("python", "python3"),
    "git": ("git",),
}
# Characters that only mean something to a shell; argv tokens must never contain them.
_SHELL_METACHARS = frozenset(";&|`$<>\n\r")
_PROBE_TIMEOUT_SEC = 10.0
_OUTPUT_TAIL_CHARS = 4000
# Output of a failed probe that looks like a sign-in problem (vs. a broken install).
_AUTH_ERROR_RE = re.compile(
    r"auth|log ?in|sign ?in|unauthori[sz]ed|credential|api[ _-]?key|token|\b40[13]\b", re.IGNORECASE
)

DriverTier = Literal["official", "community"]
ScanStatus = Literal["ready", "installed_unauthenticated", "missing", "prereq_missing"]
LineupSource = Literal["cli", "http", "mixed"]


class CliDriver(TypedDict):
    id: str
    name: str
    tier: DriverTier
    binary: str
    summary_en: str
    summary_zh: str
    prereq: list[str]
    install_cmd: list[str]
    login_cmd: list[str]
    official_url: str
    command_template: list[str]
    version_cmd: list[str]
    provider_ids: list[str]
    env_keys: list[str]
    # Optional argv whose exit code 0 means "authenticated". Absent/None: a successful
    # ``version_cmd`` is enough (local-config CLIs such as ``dsh`` need no env key).
    auth_check_cmd: NotRequired[list[str] | None]


class CliTag(TypedDict):
    id: str
    label_en: str
    label_zh: str
    summary_en: str
    summary_zh: str


class CliRegistry(TypedDict):
    schema_version: int
    drivers: list[CliDriver]
    tags: list[CliTag]


class CliScanEntry(TypedDict):
    id: str
    status: ScanStatus
    binary_path: str | None
    version: str | None
    prereq_missing: list[str]
    reason_en: str
    reason_zh: str


class CliScanResult(TypedDict):
    drivers: list[CliScanEntry]
    http_api_keys_present: list[str]
    scanned_at: float


class RecommendedLineup(TypedDict):
    ready: bool
    roles: dict[str, str]
    source: LineupSource
    notes_en: str
    notes_zh: str


class CliInstallResult(TypedDict):
    id: str
    ok: bool
    command: list[str]
    returncode: int
    output: str


class CliLoginResult(TypedDict):
    id: str
    launched: bool
    command: list[str]
    message_en: str
    message_zh: str


_STR_FIELDS = ("id", "name", "tier", "binary", "summary_en", "summary_zh", "official_url")
_ARGV_FIELDS = ("install_cmd", "login_cmd", "command_template", "version_cmd")
_STR_LIST_FIELDS = ("prereq", "provider_ids", "env_keys")
_TAG_FIELDS = ("id", "label_en", "label_zh", "summary_en", "summary_zh")


def _is_argv(value: object) -> bool:
    return (
        isinstance(value, list)
        and bool(value)
        and all(isinstance(token, str) and token and not (_SHELL_METACHARS & set(token)) for token in value)
    )


def validate_install_recipe(argv: object) -> bool:
    """Return True only for a non-shell argv list starting with an allowlisted installer prefix."""
    if not _is_argv(argv):
        return False
    tokens = tuple(argv)  # type: ignore[arg-type]
    return any(
        len(tokens) > len(prefix) and tokens[: len(prefix)] == prefix
        for prefix in ALLOWED_INSTALL_PREFIXES
    )


def _validate_driver(raw: object, index: int) -> CliDriver:
    if not isinstance(raw, dict):
        raise ValueError(f"drivers[{index}] must be a JSON object")
    where = f"driver {raw.get('id', index)!r}"
    for name in _STR_FIELDS:
        if not isinstance(raw.get(name), str) or not raw[name].strip():
            raise ValueError(f"{where}: '{name}' must be a non-empty string")
    if raw["tier"] not in DRIVER_TIERS:
        raise ValueError(f"{where}: 'tier' must be one of {DRIVER_TIERS}")
    for name in _ARGV_FIELDS:
        if not _is_argv(raw.get(name)):
            raise ValueError(f"{where}: '{name}' must be a non-empty argv list of strings without shell syntax")
    for name in _STR_LIST_FIELDS:
        value = raw.get(name)
        if not isinstance(value, list) or not all(isinstance(item, str) and item for item in value):
            raise ValueError(f"{where}: '{name}' must be a list of non-empty strings")
    unknown_prereq = sorted(set(raw["prereq"]) - set(PREREQ_BINARIES))
    if unknown_prereq:
        raise ValueError(f"{where}: unknown prereq runtime(s) {unknown_prereq}")
    if not validate_install_recipe(raw["install_cmd"]):
        raise ValueError(f"{where}: 'install_cmd' must start with an allowlisted installer {ALLOWED_INSTALL_PREFIXES}")
    auth_check = raw.get("auth_check_cmd")
    if auth_check is not None and not _is_argv(auth_check):
        raise ValueError(f"{where}: 'auth_check_cmd' must be null or an argv list")
    return raw  # type: ignore[return-value]


def _validate_tag(raw: object, index: int) -> CliTag:
    if not isinstance(raw, dict) or not all(
        isinstance(raw.get(name), str) and raw[name].strip() for name in _TAG_FIELDS
    ):
        raise ValueError(f"tags[{index}] must be an object with non-empty string fields {_TAG_FIELDS}")
    return raw  # type: ignore[return-value]


def load_cli_registry(path: str | Path | None = None) -> CliRegistry:
    """Load and strictly validate the CLI driver registry; raise ``ValueError`` on malformed data."""
    source = Path(path) if path is not None else REGISTRY_PATH
    try:
        data: Any = json.loads(source.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise ValueError(f"Invalid CLI registry JSON in {source}: {exc}") from None
    if not isinstance(data, dict):
        raise ValueError("CLI registry root must be a JSON object")
    if data.get("schema_version") != SCHEMA_VERSION:
        raise ValueError(f"CLI registry 'schema_version' must be {SCHEMA_VERSION}")
    drivers, tags = data.get("drivers"), data.get("tags")
    if not isinstance(drivers, list) or not drivers:
        raise ValueError("CLI registry 'drivers' must be a non-empty list")
    if not isinstance(tags, list):
        raise ValueError("CLI registry 'tags' must be a list")
    validated = [_validate_driver(raw, index) for index, raw in enumerate(drivers)]
    ids = [driver["id"] for driver in validated]
    duplicates = sorted({driver_id for driver_id in ids if ids.count(driver_id) > 1})
    if duplicates:
        raise ValueError(f"Duplicate CLI driver id(s): {duplicates}")
    return {
        "schema_version": SCHEMA_VERSION,
        "drivers": validated,
        "tags": [_validate_tag(raw, index) for index, raw in enumerate(tags)],
    }


def _find_driver(cli_id: str, registry: CliRegistry | None) -> CliDriver:
    """Return the trusted registry entry for ``cli_id`` or raise ``KeyError``."""
    for driver in (registry or load_cli_registry())["drivers"]:
        if driver["id"] == cli_id:
            return driver
    raise KeyError(f"Unknown CLI driver: {cli_id!r}")


def _probe(binary_path: str, argv: list[str]) -> tuple[int | None, str]:
    """Run ``[binary_path, *argv[1:]]``; return (returncode or None if it could not run, stdout+stderr)."""
    try:
        result = subprocess.run(
            [binary_path, *argv[1:]],
            shell=False,
            stdin=subprocess.DEVNULL,
            capture_output=True,
            text=True,
            timeout=_PROBE_TIMEOUT_SEC,
            check=False,
        )
    except subprocess.TimeoutExpired:
        return None, "timed out"
    except (OSError, ValueError, subprocess.SubprocessError) as exc:
        return None, str(exc)
    return result.returncode, f"{result.stdout or ''}\n{result.stderr or ''}"


def _scan_entry(
    driver: CliDriver, keys_present: set[str], prereq_cache: dict[str, bool],
) -> CliScanEntry:
    def entry(status: ScanStatus, reason_en: str, reason_zh: str, **extra: Any) -> CliScanEntry:
        result: CliScanEntry = {
            "id": driver["id"], "status": status, "binary_path": None, "version": None,
            "prereq_missing": [], "reason_en": reason_en, "reason_zh": reason_zh,
        }
        result.update(extra)  # type: ignore[typeddict-item]
        return result

    name = driver["name"]
    for prereq in driver["prereq"]:
        if prereq not in prereq_cache:
            prereq_cache[prereq] = any(resolve_cli_binary(binary) for binary in PREREQ_BINARIES[prereq])
    prereq_missing = [prereq for prereq in driver["prereq"] if not prereq_cache[prereq]]

    binary_path = resolve_cli_binary(driver["binary"])
    if binary_path is None:
        if prereq_missing:
            needed = ", ".join(prereq_missing)
            return entry(
                "prereq_missing",
                f"{name} needs {needed} installed first.",
                f"{name} 需要先安装 {needed}。",
                prereq_missing=prereq_missing,
            )
        return entry("missing", f"{name} is not installed.", f"{name} 尚未安装。")

    code, output = _probe(binary_path, driver["version_cmd"])
    version_ok = code == 0
    version = next((line.strip() for line in output.splitlines() if line.strip()), None) if version_ok else None
    found = {"binary_path": binary_path, "version": version, "prereq_missing": prereq_missing}

    auth_check = driver.get("auth_check_cmd")
    if auth_check:
        # An explicit auth check is authoritative: an env key alone does not log the CLI in.
        auth_code, auth_output = _probe(binary_path, auth_check)
        authenticated, failure_output = auth_code == 0, auth_output
    else:
        # Local-config CLIs (e.g. dsh): a clean version run means usable even without env keys.
        authenticated = version_ok or bool(keys_present & set(driver["env_keys"]))
        failure_output = output
    if authenticated:
        return entry("ready", f"{name} is installed and ready.", f"{name} 已安装并可用。", **found)
    login = " ".join(driver["login_cmd"])
    if _AUTH_ERROR_RE.search(failure_output):
        return entry(
            "installed_unauthenticated",
            f"{name} is installed but not signed in. Run `{login}`.",
            f"{name} 已安装但未登录，请运行 `{login}`。",
            **found,
        )
    return entry(
        "installed_unauthenticated",
        f"{name} is installed but its check failed. Try `{login}` or reinstall it.",
        f"{name} 已安装但自检失败，请尝试 `{login}` 或重新安装。",
        **found,
    )


def scan_host_clis(
    repo_path: Path,
    cfg: BatonConfig | None = None,
    credentials_path: Path | None = None,
    *,
    registry: CliRegistry | None = None,
) -> CliScanResult:
    """Scan this host for every registry driver (one ``CliScanEntry`` per driver, registry order).

    Contract (all subprocess calls are argv lists with ``shell=False`` and a short timeout):
    - Binary discovery uses ``resolve_cli_binary(driver["binary"])``.
    - Binary missing: ``"prereq_missing"`` when any ``prereq`` id has no binary in
      ``PREREQ_BINARIES`` resolvable (listed in ``prereq_missing``), else ``"missing"``.
    - Binary found: run ``version_cmd`` via ``subprocess.run``; ``version`` is the first
      non-empty stdout line (None on failure). Then authentication:
      ``auth_check_cmd`` present -> exit code 0 means authenticated; otherwise any
      ``env_keys`` set counts; with no ``auth_check_cmd`` a successful ``version_cmd`` is
      enough (fixes the ``dsh`` false negative when its local profile works without
      ``OPENCODE_API_KEY``). Authenticated -> ``"ready"``, else ``"installed_unauthenticated"``.
    - ``http_api_keys_present``: sorted names of API-key env vars that are set (environment or
      ``credentials_path`` local file) among ``credentials.SUPPORTED_KEYS`` and the
      ``api_key_env`` of ``cfg``'s HTTP providers. Values are never returned.
    - ``reason_en`` is pure English, ``reason_zh`` contains Chinese; ``scanned_at`` is ``time.time()``.
    """
    drivers = (registry or load_cli_registry())["drivers"]
    http_keys = {
        provider.api_key_env
        for provider in (cfg.providers.values() if cfg is not None else ())
        if provider.type == "http" and provider.api_key_env
    } | set(credentials.SUPPORTED_KEYS)
    all_keys = tuple(sorted(http_keys | {key for driver in drivers for key in driver["env_keys"]}))
    keys_present = set(credentials.list_present_provider_keys(all_keys, credentials_path))
    prereq_cache: dict[str, bool] = {}
    return {
        "drivers": [_scan_entry(driver, keys_present, prereq_cache) for driver in drivers],
        "http_api_keys_present": sorted(keys_present & http_keys),
        "scanned_at": time.time(),
    }


def run_cli_install(
    cli_id: str,
    confirmed: bool = False,
    *,
    registry: CliRegistry | None = None,
    timeout_sec: float = 900.0,
) -> CliInstallResult:
    """Run the registry's ``install_cmd`` for ``cli_id`` after explicit user confirmation.

    Contract:
    - ``confirmed`` false -> ``PermissionError``; unknown ``cli_id`` -> ``KeyError``.
    - The argv comes ONLY from the trusted registry and must pass ``validate_install_recipe``
      (else ``ValueError``). ``argv[0]`` is replaced by ``resolve_cli_binary(argv[0])`` when it
      resolves (e.g. ``npm`` -> ``npm.cmd`` on Windows); ``argv[1:]`` is passed unchanged to
      ``subprocess.run(..., shell=False, capture_output=True, text=True, timeout=timeout_sec)``.
    - Returns ``command`` = the registry ``install_cmd``, ``ok`` = returncode == 0, and
      ``output`` = combined stdout/stderr tail (at most 4000 characters).
    """
    if confirmed is not True:
        raise PermissionError("Installing a CLI requires explicit user confirmation.")
    driver = _find_driver(cli_id, registry)
    recipe = driver["install_cmd"]
    if not validate_install_recipe(recipe):
        raise ValueError(f"Install recipe for {cli_id!r} is not on the installer allowlist.")
    # ``resolve_cli_binary`` honours PATHEXT, so ``npm`` normally resolves to ``npm.cmd`` on
    # Windows; the explicit mapping covers the unresolved case (CreateProcess ignores .cmd).
    installer = resolve_cli_binary(recipe[0])
    if installer is None:
        installer = "npm.cmd" if sys.platform == "win32" and recipe[0] == "npm" else recipe[0]
    argv = [installer, *recipe[1:]]
    try:
        result = subprocess.run(
            argv, shell=False, stdin=subprocess.DEVNULL, capture_output=True, text=True,
            timeout=timeout_sec, check=False,
        )
        returncode, output = result.returncode, f"{result.stdout or ''}{result.stderr or ''}"
    except subprocess.TimeoutExpired:
        returncode, output = -1, f"Install timed out after {timeout_sec:g}s."
    except (OSError, ValueError, subprocess.SubprocessError) as exc:
        returncode, output = -1, f"Installer could not start: {exc}"
    return {
        "id": cli_id,
        "ok": returncode == 0,
        "command": list(recipe),
        "returncode": returncode,
        "output": output[-_OUTPUT_TAIL_CHARS:],
    }


def launch_cli_login(cli_id: str, *, registry: CliRegistry | None = None) -> CliLoginResult:
    """Launch the driver's official interactive ``login_cmd`` without waiting for it.

    Contract:
    - Unknown ``cli_id`` -> ``KeyError``; binary not resolvable -> ``FileNotFoundError``.
    - Starts ``subprocess.Popen`` with ``[resolved_binary, *login_cmd[1:]]``, ``shell=False``
      (a new console window on Windows). Never types passwords or solves CAPTCHAs.
    - Returns ``launched=True``, ``command`` = the registry ``login_cmd`` and bilingual guidance.
    """
    driver = _find_driver(cli_id, registry)
    login = driver["login_cmd"]
    binary_path = resolve_cli_binary(login[0])
    if binary_path is None:
        raise FileNotFoundError(f"{driver['name']} is not installed; install it before logging in.")
    if sys.platform == "win32":
        options: dict[str, Any] = {"creationflags": subprocess.CREATE_NEW_CONSOLE}
    else:
        options = {"start_new_session": True}
    # Fire and forget: the user completes the official sign-in themselves; we never wait or type.
    subprocess.Popen([binary_path, *login[1:]], shell=False, **options)
    url = driver["official_url"]
    return {
        "id": cli_id,
        "launched": True,
        "command": list(login),
        "message_en": f"Started `{' '.join(login)}`. Finish signing in to {driver['name']} in the new window, then rescan. Help: {url}",
        "message_zh": f"已启动 `{' '.join(login)}`。请在新窗口中完成 {driver['name']} 登录，然后重新扫描。帮助：{url}",
    }


def build_recommended_lineup(scan_result: CliScanResult, cfg: BatonConfig) -> RecommendedLineup:
    """Synthesize a runnable role->provider_id lineup from what is ready on this host.

    Contract:
    - ``roles`` covers every role name in ``cfg.roles``; each value is a provider id present in
      ``cfg.providers``. Keep a role's configured provider when it is backed by a ``"ready"``
      driver (via ``provider_ids``) or a present HTTP key; otherwise substitute the best ready one.
    - A ready driver only backs a provider that can really run: an ``http`` provider needs its
      ``api_key_env`` present, a CLI provider's command must invoke that driver's own binary.
    - A single ready CLI (or a single HTTP provider whose ``api_key_env`` is present) is enough:
      ``ready=True`` and every role maps to that provider.
    - ``source`` is ``"cli"`` / ``"http"`` / ``"mixed"`` depending on the chosen providers.
    - Nothing ready: ``ready=False``, ``roles={}``, ``source="cli"`` and notes explaining the
      next step (install or log in to one CLI, or add one API key).
    """
    drivers = {driver["id"]: driver for driver in load_cli_registry()["drivers"]}
    entries = [entry for entry in scan_result["drivers"] if entry["id"] in drivers]
    keys = set(scan_result["http_api_keys_present"])

    # Ready providers in preference order: ready CLIs (registry/scan order) first, then HTTP keys.
    ready: list[str] = []
    for entry in entries:
        if entry["status"] == "ready":
            driver = drivers[entry["id"]]
            ready += [
                pid for pid in driver["provider_ids"]
                if pid in cfg.providers and _provider_runnable(cfg.providers[pid], driver, keys)
            ]
    ready += [
        name for name, provider in cfg.providers.items()
        if provider.type == "http" and provider.api_key_env in keys
    ]
    ready = list(dict.fromkeys(ready))

    if not ready:
        notes_en, notes_zh = _next_step_notes(entries, drivers, cfg)
        return {"ready": False, "roles": {}, "source": "cli", "notes_en": notes_en, "notes_zh": notes_zh}

    roles = {
        name: next(
            (p for p in (role.provider, *(fb.provider for fb in role.fallback)) if p in ready),
            ready[0],
        )
        for name, role in cfg.roles.items()
    }
    kinds = {"http" if cfg.providers[pid].type == "http" else "cli" for pid in roles.values()}
    source: LineupSource = kinds.pop() if len(kinds) == 1 else "mixed"  # type: ignore[assignment]
    chosen = ", ".join(sorted(set(roles.values())))
    return {
        "ready": True,
        "roles": roles,
        "source": source,
        "notes_en": f"Every role is covered by ready providers: {chosen}.",
        "notes_zh": f"所有角色均已分配到可用的提供方：{chosen}。",
    }


def lineup_model_overrides(role_providers: Mapping[str, str], cfg: BatonConfig) -> dict[str, str]:
    """Turn a lineup's role->provider map into ``resolve_role`` overrides of the form ``provider:model``.

    Roles that keep their configured provider need no override. A role moved to another provider
    takes a model already configured for that provider: the role's own fallback first, then any
    other role's primary or fallback target. Raises ``ValueError`` for an unknown role/provider or
    a provider with no configured model.
    """
    overrides: dict[str, str] = {}
    for role_name, provider_id in role_providers.items():
        role = cfg.roles.get(role_name)
        if role is None:
            raise ValueError(f"role_providers names unknown role {role_name!r}")
        if provider_id not in cfg.providers:
            raise ValueError(f"role_providers names unknown provider {provider_id!r} for role {role_name!r}")
        if provider_id == role.provider:
            continue
        candidates = [
            *role.fallback,
            *cfg.roles.values(),
            *(target for other in cfg.roles.values() for target in other.fallback),
            *(cfg.panel.members if cfg.panel else ()),
        ]
        model = next((c.model for c in candidates if c.provider == provider_id and c.model.strip()), None)
        if model is None:
            raise ValueError(
                f"No model is configured for provider {provider_id!r}; set one in baton.toml for role {role_name!r}"
            )
        overrides[role_name] = f"{provider_id}:{model}"
    return overrides


def _provider_runnable(provider: ProviderConfig, driver: CliDriver, keys: set[str]) -> bool:
    """A ready driver backs a provider only if that provider really runs: HTTP needs its key, CLI needs this binary."""
    if provider.type == "http":
        return provider.api_key_env in keys
    if not provider.command:
        return False
    executable = provider.command[0].replace("\\", "/").rsplit("/", 1)[-1].lower()
    for suffix in (".exe", ".cmd", ".bat", ".ps1"):
        executable = executable.removesuffix(suffix)
    return executable == driver["binary"].lower()


def _next_step_notes(
    entries: list[CliScanEntry], drivers: dict[str, CliDriver], cfg: BatonConfig,
) -> tuple[str, str]:
    """Name the single cheapest next step when nothing is ready: log in > install > add a key > prereq."""
    by_status: dict[str, CliDriver] = {}
    for entry in entries:
        by_status.setdefault(entry["status"], drivers[entry["id"]])
    if driver := by_status.get("installed_unauthenticated"):
        login = " ".join(driver["login_cmd"])
        return (
            f"Nothing is ready yet. Next step: sign in to {driver['name']} by running `{login}`.",
            f"尚无可用的提供方。下一步：运行 `{login}` 登录 {driver['name']}。",
        )
    if driver := by_status.get("missing"):
        return (
            f"Nothing is ready yet. Next step: install {driver['name']} (one click, then sign in).",
            f"尚无可用的提供方。下一步：一键安装 {driver['name']}，然后登录。",
        )
    key = next(
        (provider.api_key_env for provider in cfg.providers.values() if provider.type == "http" and provider.api_key_env),
        None,
    )
    if key:
        return (
            f"Nothing is ready yet. Next step: add {key} in the credentials panel.",
            f"尚无可用的提供方。下一步：在凭据面板中填写 {key}。",
        )
    prereq = next((p for entry in entries for p in entry["prereq_missing"]), "node")
    return (
        f"Nothing is ready yet. Next step: install {prereq}, then install one AI coding CLI.",
        f"尚无可用的提供方。下一步：先安装 {prereq}，再安装一个 AI 编程 CLI。",
    )
