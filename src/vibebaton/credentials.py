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


def _read_local_credentials(path: Path) -> dict[str, str]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {}
    except (ValueError, RecursionError):
        raise ValueError("Invalid local credentials JSON.") from None
    if not isinstance(data, dict):
        raise ValueError("Local credentials must be a JSON object.")
    return {
        key: value for key in SUPPORTED_KEYS
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
    provider: str, credentials_path: Path | None = None,
) -> dict[str, str]:
    """Return stored API keys needed by an API-key provider for child-process execution."""
    keys = [key for key in PROVIDER_KEY_MAP.get(provider, ()) if key not in os.environ]
    if not keys:
        return {}
    local = _read_local_credentials(default_credentials_path(credentials_path))
    return {key: local[key] for key in keys if key in local}


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


def probe_role_or_provider(
    cfg: BatonConfig,
    provider: str | None = None,
    role: str | None = None,
    model: str | None = None,
    health_checker: HealthChecker | None = None,
    timeout_sec: float = 5.0,
    credentials_path: Path | None = None,
) -> ProbeResult:
    """Check CLI readiness and any required API keys within a shared time budget.

    An explicit provider takes priority, followed by a configured model prefix
    and the role's default provider. Injected checkers run on a daemon thread,
    should honor their timeout, and supply user-facing detail. The result masks
    known credential values in that detail.
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

    checker = health_checker if health_checker is not None else _check_cli
    subscription = _SUBSCRIPTION_CLI.get(target)
    timed_out = (False, "Provider check timed out.", "")
    failed = (False, "Provider check failed.", "")
    outcome = failed

    def remaining() -> float:
        return max(0.0, timeout_sec - (time.monotonic() - started))

    def run_check() -> None:
        nonlocal outcome
        try:
            local = _read_local_credentials(default_credentials_path(credentials_path))
        except (OSError, ValueError, RuntimeError):
            if subscription is None:
                outcome = (False, "Local credentials could not be read.", "")
                return
            local = {}

        keys = PROVIDER_KEY_MAP.get(target, ())
        missing = [key for key in keys if not _credential_value(key, local)[0]]
        if missing:
            hint = f"Set {', '.join(missing)} in the environment or local credentials store."
            outcome = (False, "Required credentials are missing.", hint)
            return

        secrets = {*local.values(), *provider_cfg.env.values()}
        secrets.update(os.environ.get(key, "") for key in SUPPORTED_KEYS)
        secrets.discard("")
        budget = remaining()
        if not budget:
            outcome = timed_out
            return
        try:
            ok, detail = checker(provider_cfg, timeout_sec if health_checker is not None else budget)
            if not isinstance(ok, bool) or not isinstance(detail, str):
                return
            for secret in sorted(secrets, key=lambda value: (-len(value), value)):
                detail = detail.replace(secret, _MASK)
            if any(secret in detail for secret in secrets):
                detail = ""
        except (TimeoutError, subprocess.TimeoutExpired):
            outcome = timed_out
        except Exception:
            outcome = failed
        else:
            hint = "" if ok else "Check the provider CLI installation and PATH."
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
