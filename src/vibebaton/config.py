"""Declarative configuration loading with hot-reload and role/provider decoupling."""

from __future__ import annotations

import json
import os
import tomllib
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any


@dataclass
class DaemonSettings:
    db_path: str = ".baton/state.sqlite"
    worktree_root: str = ".baton/worktrees"
    base_branch: str = "main"
    dev_branch: str = "dev"
    prevent_sleep_windows: bool = True
    default_stall_timeout_sec: int = 300
    default_hard_timeout_sec: int = 1800
    poll_interval_sec: float = 1.0


@dataclass
class PolicySettings:
    machine_gate_before_ai_review: bool = True
    max_self_heal_attempts: int = 2
    max_review_rejects: int = 2
    require_human_approval_at: list[str] = field(
        default_factory=lambda: ["rfc_signoff", "plan_amendment", "final_merge"]
    )


@dataclass
class ProviderConfig:
    name: str
    type: str = "cli"
    max_concurrency: int = 1
    cooldown_backoff_sec: list[int] = field(default_factory=lambda: [300, 900, 1800])
    rate_limit_regex: str = r"(rate.?limit|usage.?limit|429|quota|overloaded)"
    command: list[str] = field(default_factory=list)
    prompt_via: str = "stdin"  # "stdin" | "file_arg"
    env: dict[str, str] = field(default_factory=dict)
    stall_timeout_sec: int | None = None
    hard_timeout_sec: int | None = None


@dataclass
class FallbackTarget:
    provider: str
    model: str


@dataclass
class RoleConfig:
    name: str
    provider: str
    model: str
    prompt_file: str | None = None
    fallback: list[FallbackTarget] = field(default_factory=list)


@dataclass
class BatonConfig:
    daemon: DaemonSettings
    policies: PolicySettings
    providers: dict[str, ProviderConfig]
    roles: dict[str, RoleConfig]
    source_path: Path | None = None

    def resolve_role(
        self,
        role_name: str,
        model_overrides: dict[str, str] | None = None,
    ) -> tuple[RoleConfig, ProviderConfig | None]:
        """Resolve a logical role to its role config + provider config, applying optional overrides."""
        if role_name not in self.roles:
            raise KeyError(f"Unknown role '{role_name}'. Available roles: {sorted(self.roles)}")
        base_role = self.roles[role_name]
        provider_name = base_role.provider
        model_name = base_role.model

        if model_overrides and role_name in model_overrides:
            override = model_overrides[role_name].strip()
            if ":" in override and override.split(":", 1)[0] in self.providers:
                provider_name, model_name = override.split(":", 1)
            else:
                model_name = override

        resolved_role = RoleConfig(
            name=base_role.name,
            provider=provider_name,
            model=model_name,
            prompt_file=base_role.prompt_file,
            fallback=list(base_role.fallback),
        )
        if provider_name == "host_native":
            return resolved_role, None
        if provider_name not in self.providers:
            raise KeyError(
                f"Role '{role_name}' references unknown provider '{provider_name}'. "
                f"Available providers: {sorted(self.providers)}"
            )
        return resolved_role, self.providers[provider_name]


def _load_raw_mapping(path: Path) -> dict[str, Any]:
    suffix = path.suffix.lower()
    raw_bytes = path.read_bytes()
    if suffix == ".toml":
        return tomllib.loads(raw_bytes.decode("utf-8"))
    if suffix == ".json":
        data = json.loads(raw_bytes.decode("utf-8"))
        if not isinstance(data, dict):
            raise ValueError(f"Config JSON in {path} must be an object")
        return data
    if suffix in (".yaml", ".yml"):
        try:
            import yaml  # type: ignore
        except ImportError as exc:
            raise RuntimeError(
                f"Cannot read YAML config '{path}' because PyYAML is not installed. "
                "Use TOML (.toml) / JSON (.json) or install vibebaton[yaml]."
            ) from exc
        data = yaml.safe_load(raw_bytes.decode("utf-8"))
        if not isinstance(data, dict):
            raise ValueError(f"Config YAML in {path} must be a mapping")
        return data
    raise ValueError(f"Unsupported config format '{suffix}' for {path}")


def parse_config_dict(raw: dict[str, Any], source_path: Path | None = None) -> BatonConfig:
    d_raw = raw.get("daemon", {})
    daemon = DaemonSettings(
        db_path=str(d_raw.get("db_path", ".baton/state.sqlite")),
        worktree_root=str(d_raw.get("worktree_root", ".baton/worktrees")),
        base_branch=str(d_raw.get("base_branch", "main")),
        dev_branch=str(d_raw.get("dev_branch", "dev")),
        prevent_sleep_windows=bool(d_raw.get("prevent_sleep_windows", True)),
        default_stall_timeout_sec=int(d_raw.get("default_stall_timeout_sec", 300)),
        default_hard_timeout_sec=int(d_raw.get("default_hard_timeout_sec", 1800)),
        poll_interval_sec=float(d_raw.get("poll_interval_sec", 1.0)),
    )

    p_raw = raw.get("policies", {})
    policies = PolicySettings(
        machine_gate_before_ai_review=bool(p_raw.get("machine_gate_before_ai_review", True)),
        max_self_heal_attempts=int(p_raw.get("max_self_heal_attempts", 2)),
        max_review_rejects=int(p_raw.get("max_review_rejects", 2)),
        require_human_approval_at=[
            str(x)
            for x in p_raw.get(
                "require_human_approval_at",
                ["rfc_signoff", "plan_amendment", "final_merge"],
            )
        ],
    )

    providers: dict[str, ProviderConfig] = {}
    for name, item in raw.get("providers", {}).items():
        providers[name] = ProviderConfig(
            name=name,
            type=str(item.get("type", "cli")),
            max_concurrency=max(1, int(item.get("max_concurrency", 1))),
            cooldown_backoff_sec=[int(s) for s in item.get("cooldown_backoff_sec", [300, 900, 1800])],
            rate_limit_regex=str(
                item.get("rate_limit_regex", r"(rate.?limit|usage.?limit|429|quota|overloaded)")
            ),
            command=[str(c) for c in item.get("command", [])],
            prompt_via=str(item.get("prompt_via", "stdin")),
            env={str(k): str(v) for k, v in item.get("env", {}).items()},
            stall_timeout_sec=(
                int(item["stall_timeout_sec"]) if item.get("stall_timeout_sec") is not None else None
            ),
            hard_timeout_sec=(
                int(item["hard_timeout_sec"]) if item.get("hard_timeout_sec") is not None else None
            ),
        )

    roles: dict[str, RoleConfig] = {}
    for name, item in raw.get("roles", {}).items():
        fallbacks = [
            FallbackTarget(provider=str(fb["provider"]), model=str(fb["model"]))
            for fb in item.get("fallback", [])
            if isinstance(fb, dict) and "provider" in fb and "model" in fb
        ]
        roles[name] = RoleConfig(
            name=name,
            provider=str(item["provider"]),
            model=str(item["model"]),
            prompt_file=str(item["prompt_file"]) if item.get("prompt_file") else None,
            fallback=fallbacks,
        )

    return BatonConfig(
        daemon=daemon,
        policies=policies,
        providers=providers,
        roles=roles,
        source_path=source_path,
    )


def find_config_path(repo_dir: Path, explicit: Path | None = None) -> Path:
    """Locate configuration file in priority order: explicit > repo local > package example."""
    if explicit is not None:
        return explicit.resolve()
    candidates = [
        repo_dir / ".baton" / "baton.toml",
        repo_dir / "baton.toml",
        repo_dir / ".baton" / "config.json",
        repo_dir / "baton.json",
        repo_dir / ".baton" / "config.yaml",
        Path(__file__).resolve().parents[2] / "baton.example.toml",
    ]
    for path in candidates:
        if path.exists():
            return path.resolve()
    raise FileNotFoundError(
        f"No VibeBaton config found in {repo_dir}. Run 'baton init' or pass --config."
    )


class HotReloadConfig:
    """Watches config file mtime so users can swap models/policies without restarting the daemon."""

    def __init__(self, path: Path) -> None:
        self.path = path.resolve()
        self._mtime_ns: int = -1
        self._config: BatonConfig | None = None
        self.reload(force=True)

    def reload(self, force: bool = False) -> BatonConfig:
        stat = os.stat(self.path)
        if force or self._config is None or stat.st_mtime_ns != self._mtime_ns:
            raw = _load_raw_mapping(self.path)
            self._config = parse_config_dict(raw, source_path=self.path)
            self._mtime_ns = stat.st_mtime_ns
        return self._config

    @property
    def current(self) -> BatonConfig:
        return self.reload(force=False)
