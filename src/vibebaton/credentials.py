"""Local credential storage and bounded provider preflight checks."""

from __future__ import annotations

import json
import os
import subprocess
import tempfile
import threading
import time
from collections.abc import Callable
from pathlib import Path
from typing import Literal, TypedDict
from urllib.parse import urlparse

from .allocation import parse_model_spec
from .cli_runner import resolve_cli_binary
from .config import BatonConfig, ProviderConfig


SUPPORTED_KEYS = (
    "DEEPSEEK_API_KEY",
    "OPENAI_API_KEY",
    "OPENCODE_API_KEY",
    "ANTHROPIC_API_KEY",
)
PROVIDER_KEY_MAP: dict[str, tuple[str, ...]] = {
    "dsh_deepseek": ("DEEPSEEK_API_KEY",),
    "dsh_opencode": ("OPENCODE_API_KEY",),
}

_SUBSCRIPTION_CLI: dict[str, tuple[tuple[str, ...], str]] = {
    "codex_sub": (("login", "status"), "codex login"),
    "claude_sub": (("auth", "status"), "claude auth login"),
}
_SAVE_LOCK = threading.Lock()
_MASK = "••••"

CredentialSource = Literal["env", "local_file", "none"]
HealthChecker = Callable[[ProviderConfig, float], tuple[bool, str]]


class CredentialStatus(TypedDict):
    provider_key: str
    configured: bool
    source: CredentialSource
    masked: str


class ProbeResult(TypedDict):
    ok: bool
    provider: str
    detail: str
    latency_ms: float
    install_hint: str


def default_credentials_path(credentials_path: Path | None = None) -> Path:
    """Return the override or the user-local credentials file."""
    if credentials_path is not None:
        return credentials_path
    return Path.home() / ".vibebaton" / "credentials.json"


def mask_secret(value: str | None, credentials_path: Path | None = None) -> str:
    """Mask a secret in memory. The path parameter is accepted for API consistency."""
    if not value:
        return ""
    masked = _MASK if len(value) <= 8 else f"{value[:4]}{_MASK}{value[-4:]}"
    return "****" if value in masked else masked


def _read_local_credentials(path: Path, keys: tuple[str, ...] = SUPPORTED_KEYS) -> dict[str, str]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {}
    except (ValueError, RecursionError):
        raise ValueError("Invalid local credentials JSON.") from None
    if not isinstance(data, dict):
        raise ValueError("Local credentials must be a JSON object.")
    return {
        key: value for key in keys
        if isinstance(value := data.get(key), str) and value and "\0" not in value
    }


def _credential_value(key: str, local: dict[str, str]) -> tuple[str, CredentialSource]:
    value = os.environ.get(key)
    if value is not None:
        return value, "env" if value else "none"
    value = local.get(key, "")
    return value, "local_file" if value else "none"


def _credential_statuses(local: dict[str, str]) -> list[CredentialStatus]:
    statuses: list[CredentialStatus] = []
    for key in SUPPORTED_KEYS:
        value, source = _credential_value(key, local)
        statuses.append({
            "provider_key": key,
            "configured": bool(value),
            "source": source,
            "masked": mask_secret(value),
        })
    return statuses


def list_credential_status(credentials_path: Path | None = None) -> list[CredentialStatus]:
    """Report masked status for each supported key. Existing environment entries take precedence."""
    return _credential_statuses(_read_local_credentials(default_credentials_path(credentials_path)))


def list_present_provider_keys(keys: tuple[str, ...], credentials_path: Path | None = None) -> list[str]:
    """Return the sorted subset of ``keys`` holding a non-empty value (environment first, then
    the local store). Read-only; never returns values. An unreadable store counts as empty."""
    try:
        local = _read_local_credentials(default_credentials_path(credentials_path), keys)
    except (OSError, ValueError):
        local = {}
    return sorted({key for key in keys if _credential_value(key, local)[0]})


def _replace_credentials(path: Path, local: dict[str, str]) -> None:
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    temp_file = tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=path.parent, delete=False)
    temp_path = Path(temp_file.name)
    try:
        with temp_file:
            if os.name == "posix":
                os.fchmod(temp_file.fileno(), 0o600)
            json.dump(local, temp_file, indent=2)
            temp_file.write("\n")
            temp_file.flush()
            os.fsync(temp_file.fileno())
        os.replace(temp_path, path)
    finally:
        temp_path.unlink(missing_ok=True)


def save_credentials(
    updates: dict[str, str], credentials_path: Path | None = None,
) -> list[CredentialStatus]:
    """Merge updates into the local store and return masked statuses. Empty values clear keys."""
    for key, value in updates.items():
        if key not in SUPPORTED_KEYS:
            raise ValueError("Unsupported credential key.")
        if not isinstance(value, str) or "\0" in value:
            raise ValueError("Credential values must be strings without NUL characters.")

    path = default_credentials_path(credentials_path).resolve()
    # The .git marker covers both regular checkouts and linked worktrees.
    if any((parent / ".git").exists() for parent in path.parents):
        raise ValueError("Credentials must be stored outside the repository.")

    with _SAVE_LOCK:
        local = _read_local_credentials(path)
        for key, value in updates.items():
            if value:
                local[key] = value
            else:
                local.pop(key, None)
        _replace_credentials(path, local)
        return _credential_statuses(local)


def resolve_env_for_provider(
    provider: ProviderConfig | str, credentials_path: Path | None = None,
) -> dict[str, str]:
    """Return local credentials for provider key names absent from the environment."""
    if isinstance(provider, ProviderConfig) and provider.type == "http":
        keys = (provider.api_key_env,) if provider.api_key_env else ()
    else:
        name = provider.name if isinstance(provider, ProviderConfig) else provider
        keys = PROVIDER_KEY_MAP.get(name, ())
    keys = tuple(key for key in keys if key not in os.environ)
    if not keys:
        return {}
    return _read_local_credentials(default_credentials_path(credentials_path), keys)


def _check_cli(provider: ProviderConfig, timeout_sec: float) -> tuple[bool, str]:
    if not provider.command or not provider.command[0]:
        return False, "Provider command is empty."
    subscription = _SUBSCRIPTION_CLI.get(provider.name)
    args = subscription[0] if subscription else ("--version",)
    try:
        binary = resolve_cli_binary(provider.command[0]) or provider.command[0]
        env = os.environ.copy()
        for key in SUPPORTED_KEYS:
            env.pop(key, None)
        result = subprocess.run(
            [binary, *args],
            env=env,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=timeout_sec,
            check=False,
        )
    except FileNotFoundError:
        return False, "Provider CLI was not found."
    except subprocess.TimeoutExpired:
        return False, "Provider check timed out."
    except (OSError, ValueError, subprocess.SubprocessError):
        return False, "Provider CLI could not start."
    if result.returncode != 0:
        check = "authentication" if subscription else "version"
        return False, f"Provider {check} check exited with code {result.returncode}."
    if subscription:
        return True, "Provider CLI is authenticated."
    return True, "Provider CLI is available."


def _http_endpoint_detail(base_url: str) -> tuple[str, str]:
    """Return a display endpoint stripped of user info, query, and fragment, or an error."""
    base_url = base_url.strip()
    invalid_url = "Provider base_url must be an HTTP(S) URL with a host."
    try:
        parsed = urlparse(base_url)
    except ValueError:
        return "", invalid_url
    if parsed.scheme not in ("http", "https") or not parsed.hostname or any(char.isspace() for char in base_url):
        return "", invalid_url
    invalid_port = "Provider base_url has an invalid port."
    try:
        port = parsed.port
    except ValueError:
        return "", invalid_port
    if port == 0:
        return "", invalid_port
    host = parsed.netloc.rpartition("@")[2]
    return f"{parsed.scheme}://{host}{parsed.path}", ""


def _check_http(
    provider: ProviderConfig, credentials_path: Path | None, local: dict[str, str],
) -> tuple[bool, str]:
    """Preflight an HTTP provider locally, without subprocesses or network I/O."""
    from . import http_provider

    key_name = provider.api_key_env
    api_key, key_source = _credential_value(key_name, local)
    try:
        ok, detail = http_provider.probe_http_provider(provider, credentials_path)
    except NotImplementedError:
        # M1-T1 provides a stub until the M1-T2 transport is merged.
        ok = bool(api_key)
        detail = f"Set {key_name} in the environment or local credentials store."

    endpoint, error = _http_endpoint_detail(provider.base_url)
    if error:
        return False, error
    if not key_name:
        return False, "Provider api_key_env must name its API key variable."
    if ok:
        source = "env" if key_source == "env" else "local credentials"
        detail = f"{endpoint} key {mask_secret(api_key)} via {source}."
    else:
        detail = detail.replace(provider.base_url, endpoint)
    return ok, detail


def probe_role_or_provider(
    cfg: BatonConfig,
    provider: str | None = None,
    role: str | None = None,
    model: str | None = None,
    health_checker: HealthChecker | None = None,
    timeout_sec: float = 5.0,
    credentials_path: Path | None = None,
) -> ProbeResult:
    """Check provider readiness and any required API keys within a shared time budget.

    An explicit provider takes priority, followed by a configured model prefix
    and the role's default provider. Injected checkers run on a daemon thread,
    should honor their timeout, and supply user-facing detail. CLI providers use
    the injected checker when supplied; HTTP providers always use the local HTTP
    preflight. The result masks known credential values in that detail.
    """
    started = time.monotonic()
    target = provider or ""

    def reply(ok: bool, detail: str, install_hint: str = "") -> ProbeResult:
        return {
            "ok": ok,
            "provider": target,
            "detail": detail,
            "latency_ms": round((time.monotonic() - started) * 1000, 3),
            "install_hint": install_hint,
        }

    if provider is None:
        role_cfg = cfg.roles.get(role) if role is not None else None
        if role is not None and role_cfg is None:
            return reply(False, "Role is not configured.")
        target, _ = parse_model_spec(model or "", role_cfg.provider if role_cfg else "", cfg.providers)
    if target == "host_native":
        return reply(True, "Host-native role uses the host session.")
    provider_cfg = cfg.providers.get(target)
    if provider_cfg is None:
        target = ""
        return reply(False, "Select a configured provider or role.")
    if not 0 < timeout_sec <= threading.TIMEOUT_MAX:
        return reply(False, "Probe timeout must be positive and finite.")

    is_http = provider_cfg.type == "http"
    credential_keys = SUPPORTED_KEYS
    if is_http and provider_cfg.api_key_env:
        credential_keys += (provider_cfg.api_key_env,)
    subscription = None if is_http else _SUBSCRIPTION_CLI.get(target)
    timed_out = (False, "Provider check timed out.", "")
    failed = (False, "Provider check failed.", "")
    outcome = failed

    def remaining() -> float:
        return max(0.0, timeout_sec - (time.monotonic() - started))

    def run_check() -> None:
        nonlocal outcome
        try:
            local = _read_local_credentials(default_credentials_path(credentials_path), credential_keys)
        except (OSError, ValueError, RuntimeError):
            if subscription is None and not is_http:
                outcome = (False, "Local credentials could not be read.", "")
                return
            local = {}

        keys = () if is_http else PROVIDER_KEY_MAP.get(target, ())
        missing = [key for key in keys if not _credential_value(key, local)[0]]
        if missing:
            hint = f"Set {', '.join(missing)} in the environment or local credentials store."
            outcome = (False, "Required credentials are missing.", hint)
            return

        secrets = {*local.values(), *provider_cfg.env.values()}
        secrets.update(os.environ.get(key, "") for key in credential_keys)
        if is_http:
            secrets.update(provider_cfg.headers.values())
        secrets.discard("")
        budget = remaining()
        if not budget:
            outcome = timed_out
            return
        try:
            if is_http:
                ok, detail = _check_http(provider_cfg, credentials_path, local)
            elif health_checker is not None:
                ok, detail = health_checker(provider_cfg, timeout_sec)
            else:
                ok, detail = _check_cli(provider_cfg, budget)
            if not isinstance(ok, bool) or not isinstance(detail, str):
                return
            for secret in sorted(secrets, key=lambda value: (-len(value), value)):
                detail = detail.replace(secret, mask_secret(secret) if is_http else _MASK)
            if any(secret in detail for secret in secrets):
                detail = ""
        except (TimeoutError, subprocess.TimeoutExpired):
            outcome = timed_out
        except Exception:
            outcome = failed
        else:
            if ok:
                hint = ""
            elif is_http:
                hint = "Check the provider base_url and api_key_env configuration."
            else:
                hint = "Check the provider CLI installation and PATH."
            if not ok and subscription:
                hint += f" For subscription sign-in, run `{subscription[1]}` manually."
            outcome = (ok, detail, hint)

    worker = threading.Thread(target=run_check, daemon=True)
    try:
        worker.start()
    except RuntimeError:
        return reply(*failed)
    worker.join(remaining())
    return reply(*(timed_out if worker.is_alive() or not remaining() else outcome))
