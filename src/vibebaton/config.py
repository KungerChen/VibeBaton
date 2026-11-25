"""Declarative configuration loading with hot-reload and role/provider decoupling."""

from __future__ import annotations

import importlib
import json
import os
import re
import tomllib
from collections.abc import Iterator, Mapping
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Literal


ALLOWED_BUDGET_PROFILES = ("eco", "balanced", "max_quality")
_WEBHOOK_FORMATS = ("auto", "generic", "slack", "discord", "feishu", "wecom", "dingtalk")
_DYNAMIC_EFFORTS = ("low", "high", "max")
CostTier = Literal["eco", "standard", "flagship"]

# Match whole tokens in the base model name, in table order. Other models are standard.
_MODEL_COST_TIERS: tuple[tuple[CostTier, tuple[str, ...]], ...] = (
    ("eco", ("flash", "haiku", "lite", "mini", "nano", "hydrogen")),
    ("flagship", ("astra", "fable", "flagship", "opus", "pro")),
)


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
    budget_profile: str = "balanced"
    auto_resolve_merge_conflicts: bool = True
    max_conflict_resolve_attempts: int = 1


@dataclass
class NotificationSettings:
    enabled: bool = True
    desktop_toast: bool = True
    terminal_bell: bool = True
    webhook_url: str = field(default="", repr=False)
    webhook_url_env: str = ""
    webhook_format: str = "auto"
    webhook_timeout_sec: float = 5.0
    on_waiting_human: bool = True
    on_ready_for_final_gate: bool = True
    on_failed: bool = True
    on_paused: bool = True
    on_long_cooldown_sec: int = 300

    def __post_init__(self) -> None:
        if not isinstance(self.webhook_format, str) or self.webhook_format not in _WEBHOOK_FORMATS:
            allowed = ", ".join(_WEBHOOK_FORMATS)
            raise ValueError(f"Invalid notifications.webhook_format. Expected one of {allowed}.")


@dataclass
class PricingSettings:
    auto_sync: bool = True
    refresh_interval_hours: int = 24
    source_url: str = (
        "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json"
    )
    timeout_sec: float = 5.0
    cache_path: str = ""  # Defaults to ~/.vibebaton/pricing_cache.json.
    custom_path: str = ""  # Defaults to ~/.vibebaton/custom_pricing.json.
    custom: dict[str, dict[str, float]] = field(default_factory=dict)


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
    base_url: str = "https://api.openai.com/v1"
    api_key_env: str = "OPENAI_API_KEY"
    headers: dict[str, str] = field(default_factory=dict)
    model_pricing: dict[str, dict[str, float]] = field(default_factory=dict)


@dataclass
class ModelCapability:
    """A configured model spec and the efforts available for its base model."""

    provider: str
    model: str
    efforts: list[str]
    cost_tier: CostTier
    ready: bool
    detail: str = ""

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


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
class PanelMemberConfig:
    """One read-only specialist consulted during the 00_PANEL phase."""

    id: str
    perspective: str
    provider: str
    model: str
    prompt_file: str = "prompts/panel_specialist.md"
    fallback: list[FallbackTarget] = field(default_factory=list)


@dataclass
class PanelSettings:
    """Optional [panel] section. Omitted means a disabled panel with no members."""

    enabled: bool = False
    max_concurrency: int = 3
    synthesizer_provider: str = "claude_sub"
    synthesizer_model: str = "sonnet@high"
    synthesizer_prompt_file: str = "prompts/panel_synthesizer.md"
    arbitration_rules: list[str] = field(default_factory=list)
    members: list[PanelMemberConfig] = field(default_factory=list)


@dataclass
class BatonConfig:
    daemon: DaemonSettings
    policies: PolicySettings
    providers: dict[str, ProviderConfig]
    roles: dict[str, RoleConfig]
    source_path: Path | None = None
    notifications: NotificationSettings = field(default_factory=NotificationSettings)
    pricing: PricingSettings = field(default_factory=PricingSettings)
    panel: PanelSettings = field(default_factory=PanelSettings)

    def resolve_role_name(self, preferred: str, *fallbacks: str) -> str:
        """Return the first configured role in preference order."""
        candidates = (preferred, *fallbacks)
        for name in candidates:
            if name in self.roles:
                return name
        raise KeyError(f"No configured role matches {candidates}. Available roles: {sorted(self.roles)}")

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


def _role_targets(role: RoleConfig) -> Iterator[tuple[str, str]]:
    yield role.provider, role.model
    for target in role.fallback:
        yield target.provider, target.model


def build_model_catalog(
    cfg: BatonConfig, provider_checks: Mapping[str, Mapping[str, Any]] | None = None
) -> list[ModelCapability]:
    """List distinct configured targets in role and fallback order.

    An effort suffix or an effort-aware CLI template enables the CLI ladder.
    Explicit suffixes such as xhigh remain available. With a check mapping,
    providers omitted from the mapping are unverified and marked unready.
    """
    catalog: dict[tuple[str, str], ModelCapability] = {}
    for role in cfg.roles.values():
        for provider, model in _role_targets(role):
            if provider not in cfg.providers or not model.strip() or (provider, model) in catalog:
                continue
            provider_config = cfg.providers[provider]
            base_model, _, effort = model.partition("@")
            efforts: list[str] = []
            if provider_config.type == "cli" and (
                effort or any("{effort}" in token for token in provider_config.command)
            ):
                efforts.extend(_DYNAMIC_EFFORTS)
            if effort and effort not in efforts:
                efforts.append(effort)

            words = set(re.findall(r"[a-z0-9]+", base_model.lower()))
            cost_tier = next(
                (tier for tier, markers in _MODEL_COST_TIERS if words.intersection(markers)),
                "standard",
            )
            check = None if provider_checks is None else provider_checks.get(provider, {})
            catalog[provider, model] = ModelCapability(
                provider=provider,
                model=model,
                efforts=efforts,
                cost_tier=cost_tier,
                ready=check is None or check.get("ok") is True,
                detail="" if check is None else check.get("detail", ""),
            )
    return list(catalog.values())


def _validate_budget_profile(value: object) -> str:
    if not isinstance(value, str) or value not in ALLOWED_BUDGET_PROFILES:
        allowed = ", ".join(ALLOWED_BUDGET_PROFILES)
        raise ValueError(f"Invalid policies.budget_profile {value!r}. Expected one of {allowed}.")
    return value


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
            # Optional third-party dependency: loaded dynamically so the package
            # keeps zero static non-stdlib imports.
            yaml = importlib.import_module("yaml")
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


def _parse_fallback_targets(items: object) -> list[FallbackTarget]:
    """Keep only well-formed {provider, model} entries, in order."""
    return [
        FallbackTarget(provider=str(fb["provider"]), model=str(fb["model"]))
        for fb in (items or [])
        if isinstance(fb, dict) and "provider" in fb and "model" in fb
    ]


def _parse_panel(raw: object, providers: Mapping[str, ProviderConfig]) -> PanelSettings:
    if raw is None:
        return PanelSettings()
    if not isinstance(raw, Mapping):
        raise ValueError("Invalid panel. Expected a table.")
    members_raw = raw.get("members", [])
    if not isinstance(members_raw, list) or any(not isinstance(m, Mapping) for m in members_raw):
        raise ValueError("Invalid panel.members. Expected an array of tables.")

    members: list[PanelMemberConfig] = []
    seen: set[str] = set()
    for index, item in enumerate(members_raw):
        member_id = str(item.get("id", "")).strip()
        if not member_id:
            raise ValueError(f"Invalid panel.members[{index}].id. Expected a non-empty string.")
        if member_id in seen:
            raise ValueError(f"Duplicate panel member id {member_id!r}.")
        seen.add(member_id)
        perspective = str(item.get("perspective", "")).strip()
        if not perspective:
            raise ValueError(f"Panel member {member_id!r} needs a non-empty perspective.")
        provider = str(item.get("provider", ""))
        if provider not in providers:
            raise ValueError(
                f"Panel member {member_id!r} references unknown provider {provider!r}. "
                f"Available providers: {sorted(providers)}"
            )
        members.append(PanelMemberConfig(
            id=member_id,
            perspective=perspective,
            provider=provider,
            model=str(item.get("model", "")),
            prompt_file=str(item.get("prompt_file") or PanelMemberConfig.prompt_file),
            fallback=_parse_fallback_targets(item.get("fallback")),
        ))

    return PanelSettings(
        enabled=bool(raw.get("enabled", PanelSettings.enabled)),
        max_concurrency=max(1, int(raw.get("max_concurrency", PanelSettings.max_concurrency))),
        synthesizer_provider=str(raw.get("synthesizer_provider", PanelSettings.synthesizer_provider)),
        synthesizer_model=str(raw.get("synthesizer_model", PanelSettings.synthesizer_model)),
        synthesizer_prompt_file=str(
            raw.get("synthesizer_prompt_file", PanelSettings.synthesizer_prompt_file)
        ),
        arbitration_rules=[str(rule) for rule in raw.get("arbitration_rules", [])],
        members=members,
    )


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
        budget_profile=_validate_budget_profile(p_raw.get("budget_profile", PolicySettings.budget_profile)),
        auto_resolve_merge_conflicts=bool(
            p_raw.get("auto_resolve_merge_conflicts", PolicySettings.auto_resolve_merge_conflicts)
        ),
        max_conflict_resolve_attempts=int(
            p_raw.get("max_conflict_resolve_attempts", PolicySettings.max_conflict_resolve_attempts)
        ),
    )

    n_raw = raw.get("notifications", {})
    if not isinstance(n_raw, Mapping):
        raise ValueError("Invalid notifications. Expected a table.")
    notifications = NotificationSettings(
        enabled=bool(n_raw.get("enabled", NotificationSettings.enabled)),
        desktop_toast=bool(n_raw.get("desktop_toast", NotificationSettings.desktop_toast)),
        terminal_bell=bool(n_raw.get("terminal_bell", NotificationSettings.terminal_bell)),
        webhook_url=str(n_raw.get("webhook_url", NotificationSettings.webhook_url)),
        webhook_url_env=str(n_raw.get("webhook_url_env", NotificationSettings.webhook_url_env)),
        webhook_format=n_raw.get("webhook_format", NotificationSettings.webhook_format),
        webhook_timeout_sec=float(
            n_raw.get("webhook_timeout_sec", NotificationSettings.webhook_timeout_sec)
        ),
        on_waiting_human=bool(n_raw.get("on_waiting_human", NotificationSettings.on_waiting_human)),
        on_ready_for_final_gate=bool(
            n_raw.get("on_ready_for_final_gate", NotificationSettings.on_ready_for_final_gate)
        ),
        on_failed=bool(n_raw.get("on_failed", NotificationSettings.on_failed)),
        on_paused=bool(n_raw.get("on_paused", NotificationSettings.on_paused)),
        on_long_cooldown_sec=int(
            n_raw.get("on_long_cooldown_sec", NotificationSettings.on_long_cooldown_sec)
        ),
    )

    pricing_raw = raw.get("pricing", {})
    if not isinstance(pricing_raw, Mapping):
        raise ValueError("Invalid pricing. Expected a table.")
    custom_pricing = pricing_raw.get("custom", {})
    if not isinstance(custom_pricing, Mapping) or any(
        not isinstance(rates, Mapping) for rates in custom_pricing.values()
    ):
        raise ValueError("Invalid pricing.custom. Expected a table of model rates.")
    pricing = PricingSettings(
        auto_sync=bool(pricing_raw.get("auto_sync", PricingSettings.auto_sync)),
        refresh_interval_hours=int(
            pricing_raw.get("refresh_interval_hours", PricingSettings.refresh_interval_hours)
        ),
        source_url=str(pricing_raw.get("source_url", PricingSettings.source_url)),
        timeout_sec=float(pricing_raw.get("timeout_sec", PricingSettings.timeout_sec)),
        cache_path=str(pricing_raw.get("cache_path", PricingSettings.cache_path)),
        custom_path=str(pricing_raw.get("custom_path", PricingSettings.custom_path)),
        custom={
            str(model): {str(rate): float(value) for rate, value in rates.items()}
            for model, rates in custom_pricing.items()
        },
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
            base_url=str(item.get("base_url", ProviderConfig.base_url)),
            api_key_env=str(item.get("api_key_env", ProviderConfig.api_key_env)),
            headers={str(k): str(v) for k, v in item.get("headers", {}).items()},
            model_pricing={
                str(model): {str(rate): float(value) for rate, value in rates.items()}
                for model, rates in item.get("model_pricing", {}).items()
            },
        )

    roles: dict[str, RoleConfig] = {}
    for name, item in raw.get("roles", {}).items():
        fallbacks = _parse_fallback_targets(item.get("fallback", []))
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
        notifications=notifications,
        pricing=pricing,
        panel=_parse_panel(raw.get("panel"), providers),
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
