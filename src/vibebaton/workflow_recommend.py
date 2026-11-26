"""Deterministic Guided recommendations and a read-only launch preflight.

``recommend_workflow`` only reads its arguments.  Host scans, configuration,
and preset inspection belong in ``build_readiness_snapshot``.  At launch,
build a fresh snapshot and call ``validate_launch_selection`` *before* creating
a run or starting a daemon; a recommendation is not a reservation of readiness.

The existing lineup contract contains no previous project size.  New lineups
therefore carry an optional ``size`` tag.  When submitting a retained lineup on
the next iteration, callers should set that tag to the preceding recommendation's
``size``.  Untagged legacy lineups are preserved, but ``size_changed`` is None:
there is no basis for claiming either a change or no change.
"""

from __future__ import annotations

from copy import deepcopy
from dataclasses import dataclass
from pathlib import Path
from typing import Literal, NotRequired, TypedDict, cast
from urllib.parse import urlsplit

from . import cli_registry, credentials, presets
from .config import BatonConfig, ProviderConfig, build_model_catalog
from .panel import build_default_panel_settings

ProjectSize = Literal["small", "medium", "large"]
WorkflowMode = Literal["interactive", "overnight", "panel"]
ProviderKind = Literal["cli", "http"]


class WorkflowLineup(TypedDict):
    """Role-to-provider assignments, model choices, and optional previous size."""

    roles: dict[str, str]
    model_overrides: dict[str, str]
    size: NotRequired[ProjectSize]


@dataclass(frozen=True)
class ProviderReadiness:
    """Non-secret provider facts. Both flags must be true to use a provider.

    For a CLI, credential readiness follows the registry's authentication
    check; local-profile drivers need no separate API key.  HTTP readiness is
    configuration and key presence, not a remote connectivity or quota test.
    """

    provider_id: str
    kind: ProviderKind
    provider_ready: bool
    credential_ready: bool


@dataclass(frozen=True)
class ReadinessSnapshot:
    """Immutable-by-convention facts gathered before the pure recommendation.

    ``panelist_providers`` contains the actual primary member targets. Member
    fallbacks are not sufficient: the engine does not try them for every kind
    of primary failure. The synthesizer is checked separately because role
    overrides do not change it.
    ``required_roles=None`` and ``available_presets=None`` mean unknown, not
    empty.  ``default_lineup`` is the host-derived standard relay; ``eco_lineup``
    uses a configured eco model when one is ready. ``implicit_model_targets``
    lists role/provider pairs for which the existing config can resolve a model
    without an explicit override; None means that information is unavailable.
    """

    providers: tuple[ProviderReadiness, ...]
    default_lineup: WorkflowLineup | None = None
    panelist_providers: tuple[str, ...] = ()
    synthesizer_provider: str | None = None
    eco_lineup: WorkflowLineup | None = None
    preferred_lineup: WorkflowLineup | None = None
    required_roles: tuple[str, ...] | None = None
    available_presets: tuple[str, ...] | None = None
    implicit_model_targets: tuple[tuple[str, str], ...] | None = None
    eco_preset_roles: tuple[tuple[str, str], ...] = ()


@dataclass(frozen=True)
class WorkflowRecommendation:
    """The original M2-T1 recommendation fields, retained for compatibility."""

    mode: WorkflowMode
    preset: str | None
    lineup: WorkflowLineup | None
    size: ProjectSize | None
    reason_code: str
    explanation_key: str
    fallback: bool

    @property
    def size_changed(self) -> bool | None:
        """Unknown for recommendations made with the original constructor."""
        return None


@dataclass(frozen=True)
class ProviderSubstitution:
    role: str
    preferred_provider: str
    chosen_provider: str


@dataclass(frozen=True)
class DetailedWorkflowRecommendation(WorkflowRecommendation):
    """Returned recommendation; ``asdict`` includes the additional details."""

    size_changed: bool | None = None
    explanation_codes: tuple[str, ...] = ()
    substitutions: tuple[ProviderSubstitution, ...] = ()


class LaunchSelectionError(ValueError):
    """A launch preflight failure with stable, machine-readable reason codes."""

    def __init__(self, codes: tuple[str, ...], synthesizer_provider: str | None = None) -> None:
        self.codes = codes
        detail = ", ".join(codes)
        if synthesizer_provider and any(code.startswith("synthesizer_") for code in codes):
            detail += f" (Synthesizer provider: {synthesizer_provider})"
        super().__init__(f"Launch selection rejected: {detail}")


def _ready_providers(snapshot: ReadinessSnapshot) -> tuple[str, ...]:
    """Keep input order and reject contradictory duplicate provider records."""
    grouped: dict[str, list[ProviderReadiness]] = {}
    for provider in snapshot.providers:
        grouped.setdefault(provider.provider_id, []).append(provider)
    return tuple(
        name for name, records in grouped.items()
        if name and all(p.provider_ready and p.credential_ready for p in records)
        and len({p.kind for p in records}) == 1
    )


def _lineup_valid(lineup: WorkflowLineup | None, snapshot: ReadinessSnapshot) -> bool:
    if not isinstance(lineup, dict):
        return False
    roles, overrides = lineup.get("roles"), lineup.get("model_overrides")
    if not isinstance(roles, dict) or not roles or not isinstance(overrides, dict):
        return False
    if snapshot.required_roles is not None and set(roles) != set(snapshot.required_roles):
        return False
    ready = set(_ready_providers(snapshot))
    if any(not isinstance(role, str) or not role or not isinstance(provider, str) or provider not in ready
           for role, provider in roles.items()):
        return False
    for role, spec in overrides.items():
        if role not in roles or not isinstance(spec, str):
            return False
        provider, separator, model = spec.partition(":")
        if not separator or provider != roles[role] or not model.strip():
            return False
    if snapshot.implicit_model_targets is not None:
        known = set(snapshot.implicit_model_targets)
        if any(role not in overrides and (role, provider) not in known for role, provider in roles.items()):
            return False
    return True


def _panel_errors(snapshot: ReadinessSnapshot) -> tuple[str, ...]:
    ready = set(_ready_providers(snapshot))
    errors: list[str] = []
    synth_id = snapshot.synthesizer_provider
    synth = [p for p in snapshot.providers if p.provider_id == synth_id] if synth_id else []
    if not synth_id:
        errors.append("synthesizer_not_configured")
    elif not synth:
        errors.append("synthesizer_provider_unavailable")
    elif not all(p.provider_ready for p in synth):
        errors.append("synthesizer_provider_unavailable")
    elif not all(p.credential_ready for p in synth):
        errors.append("synthesizer_credentials_missing")
    elif synth_id not in ready:
        errors.append("synthesizer_provider_unavailable")
    if not any(provider in ready for provider in snapshot.panelist_providers):
        errors.append("panelist_unavailable")
    return tuple(errors)


def validate_launch_selection(
    mode: WorkflowMode,
    readiness: ReadinessSnapshot,
    *,
    lineup: WorkflowLineup | None = None,
) -> None:
    """Reject an invalid selection by raising ``LaunchSelectionError``.

    This function performs no launch or host scan.  The caller must construct a
    fresh snapshot and invoke it before any run/daemon is created.  Supply the
    lineup to validate its role assignments and model provider prefixes too;
    omitting it checks the mode and panel preflight only.
    """
    errors: list[str] = []
    if mode not in ("interactive", "overnight", "panel"):
        errors.append("invalid_mode")
    if mode == "panel":
        errors.extend(_panel_errors(readiness))
    if lineup is not None and not _lineup_valid(lineup, readiness):
        errors.append("lineup_unavailable")
    if errors:
        raise LaunchSelectionError(tuple(errors), readiness.synthesizer_provider)


def _repair_lineup(lineup: WorkflowLineup | None, snapshot: ReadinessSnapshot) -> WorkflowLineup | None:
    """Substitute ready providers in an externally supplied preferred lineup."""
    if not isinstance(lineup, dict) or not isinstance(lineup.get("roles"), dict):
        return None
    ready = _ready_providers(snapshot)
    if not ready or not lineup["roles"]:
        return None
    if snapshot.required_roles is not None and set(lineup["roles"]) != set(snapshot.required_roles):
        return None
    overrides = lineup.get("model_overrides")
    if not isinstance(overrides, dict):
        return None
    roles: dict[str, str] = {}
    models: dict[str, str] = {}
    for role, desired in lineup["roles"].items():
        if not isinstance(role, str) or not role or not isinstance(desired, str):
            return None
        spec = overrides.get(role)
        candidates = dict.fromkeys((desired, *ready))
        for chosen in candidates:
            if chosen not in ready:
                continue
            explicit = (isinstance(spec, str) and spec.startswith(f"{chosen}:")
                        and bool(spec.partition(":")[2].strip()))
            if not explicit and snapshot.implicit_model_targets is not None and (
                role, chosen
            ) not in snapshot.implicit_model_targets:
                continue
            roles[role] = chosen
            if explicit:
                models[role] = cast(str, spec)
            break
        else:
            return None
    repaired: WorkflowLineup = {"roles": roles, "model_overrides": models}
    return repaired if _lineup_valid(repaired, snapshot) else None


def recommend_workflow(
    size: ProjectSize | None,
    readiness: ReadinessSnapshot,
    *,
    previous_lineup: WorkflowLineup | None = None,
) -> DetailedWorkflowRecommendation:
    """Recommend a workflow without I/O, clocks, random choices, or mutation.

    Missing/unknown sizes use medium. A valid previous lineup is retained in
    full, including unknown metadata. The selected mode is still re-evaluated,
    so an unsafe panel never survives merely because the lineup was preserved.
    """
    normalized: ProjectSize = cast(ProjectSize, size) if size in ("small", "medium", "large") else "medium"
    prior_size = previous_lineup.get("size") if isinstance(previous_lineup, dict) else None
    size_changed = prior_size != normalized if prior_size in ("small", "medium", "large") else None
    panel_errors = _panel_errors(readiness) if normalized == "large" else ()
    mode: WorkflowMode = "panel" if normalized == "large" and not panel_errors else "overnight"
    preset = "specialist_panel" if mode == "panel" else (
        "starter_2tier" if normalized == "small" else "solo_coder_3tier"
    )
    reasons: list[str] = list(panel_errors)
    fallback = bool(panel_errors)

    kept = _lineup_valid(previous_lineup, readiness)
    if kept:
        lineup = deepcopy(previous_lineup)
    else:
        candidate = readiness.eco_lineup if normalized == "small" and readiness.eco_lineup else readiness.default_lineup
        lineup = deepcopy(candidate) if _lineup_valid(candidate, readiness) else _repair_lineup(candidate, readiness)
        if lineup is not None:
            lineup["size"] = normalized
        if normalized == "small" and readiness.eco_lineup is None and lineup is not None:
            reasons.append("eco_model_unavailable")
            fallback = True

    substitutions: list[ProviderSubstitution] = []
    preferred = readiness.preferred_lineup or readiness.default_lineup
    if lineup is not None and not kept and isinstance(preferred, dict):
        preferred_roles = preferred.get("roles")
        if isinstance(preferred_roles, dict):
            ready = set(_ready_providers(readiness))
            for role, chosen in lineup["roles"].items():
                original = preferred_roles.get(role)
                if isinstance(original, str) and original != chosen and original not in ready:
                    substitutions.append(ProviderSubstitution(role, original, chosen))
    if lineup is not None and not kept and normalized == "small":
        ready = set(_ready_providers(readiness))
        for role, original in readiness.eco_preset_roles:
            chosen = lineup["roles"].get(role)
            if chosen and original != chosen and original not in ready:
                substitution = ProviderSubstitution(role, original, chosen)
                if substitution not in substitutions:
                    substitutions.append(substitution)
    if substitutions:
        reasons.append("provider_substituted")
        fallback = True
    if lineup is None:
        reasons.append("no_ready_provider" if not _ready_providers(readiness) else "lineup_unavailable")
        fallback = True
    if readiness.available_presets is not None and preset not in readiness.available_presets:
        preset = None
        reasons.append("preset_unavailable")
        fallback = True
    if size not in ("small", "medium", "large"):
        reasons.append("size_defaulted_to_medium")
    if kept:
        reasons.append("previous_lineup_preserved")
    if not reasons:
        reasons.append("small_eco" if normalized == "small" else "large_panel" if mode == "panel" else "medium_relay")
    reason = reasons[0]
    return DetailedWorkflowRecommendation(
        mode=mode, preset=preset, lineup=lineup, size=normalized,
        reason_code=reason, explanation_key=f"workflow.{reason}", fallback=fallback,
        size_changed=size_changed, explanation_codes=tuple(reasons), substitutions=tuple(substitutions),
    )


def _http_configured(provider: ProviderConfig) -> bool:
    try:
        url = urlsplit(provider.base_url.strip())
        return bool(url.scheme in ("http", "https") and url.hostname and url.port != 0
                    and not any(char.isspace() for char in provider.base_url))
    except ValueError:
        return False


def _matches_driver(provider: ProviderConfig, driver: cli_registry.CliDriver) -> bool:
    if not provider.command:
        return False
    executable = provider.command[0].replace("\\", "/").rsplit("/", 1)[-1].lower()
    for suffix in (".exe", ".cmd", ".bat", ".ps1"):
        executable = executable.removesuffix(suffix)
    return executable == driver["binary"].lower()


def _host_lineup(
    cfg: BatonConfig, scan: cli_registry.CliScanResult, providers: tuple[ProviderReadiness, ...],
) -> WorkflowLineup | None:
    ready = set(_ready_providers(ReadinessSnapshot(providers)))
    if not ready or not cfg.roles:
        return None
    registry_lineup = cli_registry.build_recommended_lineup(scan, cfg)["roles"]
    roles: dict[str, str] = {}
    overrides: dict[str, str] = {}
    for name, role in cfg.roles.items():
        candidates = (role.provider, *(target.provider for target in role.fallback),
                      registry_lineup.get(name, ""), *cfg.providers)
        for provider in dict.fromkeys(candidates):
            if provider not in ready:
                continue
            model = _configured_override(cfg, name, provider)
            if model is not None:
                roles[name], overrides[name] = provider, model
                break
        else:
            return None
    return {"roles": roles, "model_overrides": overrides}


def _configured_override(cfg: BatonConfig, role: str, provider: str) -> str | None:
    try:
        override = cli_registry.lineup_model_overrides({role: provider}, cfg).get(role)
    except ValueError:
        return None
    model = override if override is not None else f"{provider}:{cfg.roles[role].model}"
    return model if model.partition(":")[2].strip() else None


def _eco_lineup(
    cfg: BatonConfig, providers: tuple[ProviderReadiness, ...], starter_targets: tuple[tuple[str, str], ...],
) -> WorkflowLineup | None:
    if not cfg.roles:
        return None
    ready = set(_ready_providers(ReadinessSnapshot(providers)))
    eco = [model for model in build_model_catalog(cfg) if model.cost_tier == "eco" and model.provider in ready]
    if not eco:
        return None
    choice = next((model for target in starter_targets for model in eco
                   if (model.provider, model.model) == target), eco[0])
    return {
        "roles": {name: choice.provider for name in cfg.roles},
        "model_overrides": {name: f"{choice.provider}:{choice.model}" for name in cfg.roles},
    }


def build_readiness_snapshot(
    repo_path: Path,
    cfg: BatonConfig,
    credentials_path: Path | None = None,
    *,
    scan_result: cli_registry.CliScanResult | None = None,
) -> ReadinessSnapshot:
    """Read config, local credential/CLI scan, presets, and effective panel settings.

    Passing an existing scan avoids running another registry scan. Unregistered
    CLI providers use the existing bounded provider probe. These checks do not
    install or log in. Snapshot contents never include credential values.
    """
    registry = cli_registry.load_cli_registry()
    scan = scan_result if scan_result is not None else cli_registry.scan_host_clis(
        repo_path, cfg, credentials_path, registry=registry,
    )
    entries = {entry["id"]: entry for entry in scan["drivers"]}
    keys = set(scan["http_api_keys_present"])
    providers: list[ProviderReadiness] = []
    for name, provider in cfg.providers.items():
        if provider.type == "http":
            providers.append(ProviderReadiness(name, "http", _http_configured(provider),
                                               bool(provider.api_key_env and provider.api_key_env in keys)))
        elif provider.type == "cli":
            matched = [entries[driver["id"]] for driver in registry["drivers"]
                       if name in driver["provider_ids"] and _matches_driver(provider, driver)
                       and driver["id"] in entries]
            installed = any(entry["status"] in ("ready", "installed_unauthenticated")
                            and bool(entry["binary_path"]) for entry in matched)
            authenticated = any(entry["status"] == "ready" and bool(entry["binary_path"]) for entry in matched)
            if not any(name in driver["provider_ids"] for driver in registry["drivers"]):
                # Custom CLI providers have no registry driver. Use the normal
                # provider check; never use this fallback to bypass a known
                # driver's authentication or configured binary mismatch.
                probe = credentials.probe_role_or_provider(cfg, provider=name, credentials_path=credentials_path)
                installed = authenticated = bool(probe["ok"])
            providers.append(ProviderReadiness(name, "cli", installed, authenticated))
    provider_tuple = tuple(providers)
    preset_ids = tuple(summary.id for summary in presets.list_presets())
    starter = presets.load_preset("starter_2tier") if "starter_2tier" in preset_ids else None
    starter_nodes = starter.nodes if starter is not None else ()
    starter_targets = tuple(
        (provider, model) for node in starter_nodes
        if isinstance(provider := node.config.get("provider"), str)
        and isinstance(model := node.config.get("model"), str)
    )
    starter_roles = tuple(
        (node.role, provider) for node in starter_nodes
        if node.role in cfg.roles and isinstance(provider := node.config.get("provider"), str)
        and provider != "host_native"
    )
    settings = cfg.panel if cfg.panel.members else build_default_panel_settings(cfg)
    panelists = tuple(dict.fromkeys(
        member.provider for member in settings.members if member.provider and member.model.strip()
    ))
    preferred: WorkflowLineup = {"roles": {name: role.provider for name, role in cfg.roles.items()}, "model_overrides": {}}
    return ReadinessSnapshot(
        providers=provider_tuple,
        default_lineup=_host_lineup(cfg, scan, provider_tuple),
        panelist_providers=panelists,
        synthesizer_provider=settings.synthesizer_provider if settings.synthesizer_model.strip() else None,
        eco_lineup=_eco_lineup(cfg, provider_tuple, starter_targets),
        preferred_lineup=preferred,
        required_roles=tuple(cfg.roles),
        available_presets=preset_ids,
        implicit_model_targets=tuple(
            (role, provider) for role in cfg.roles for provider in cfg.providers
            if _configured_override(cfg, role, provider) is not None
        ),
        eco_preset_roles=starter_roles,
    )
