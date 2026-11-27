"""Deterministic Guided recommendations and a read-only launch preflight.

``recommend_workflow`` only reads its arguments.  Host scans, configuration,
and preset inspection belong in ``build_readiness_snapshot``.  At launch,
build a fresh snapshot and call ``validate_launch_selection`` *before* creating
a run or starting a daemon; a recommendation is not a reservation of readiness.

The existing lineup contract contains no previous project size.  New lineups
therefore carry an optional ``size`` tag.  When submitting a retained lineup on
the next iteration, callers should set that tag to the preceding recommendation's
``size``.  Untagged legacy lineups have ``size_changed`` None: there is no basis
for claiming either a change or no change.

Teams follow the size: small gets a lean team (strong planning/review, light
execution), medium and large reuse the team confirmed in setup (or the
setup-equivalent tiered default). A lineup flagged ``customized`` (the user
changed it by hand) is always kept.
"""

from __future__ import annotations

import re
from collections.abc import Sequence
from copy import deepcopy
from dataclasses import dataclass
from pathlib import Path
from typing import Literal, NotRequired, TypedDict, cast
from urllib.parse import urlsplit

from . import cli_registry, credentials, model_catalog
from .config import BatonConfig, ProviderConfig
from .panel import build_default_panel_settings
from .rfc_checker import extract_verification_commands

ProjectSize = Literal["small", "medium", "large"]
WorkflowMode = Literal["interactive", "overnight", "panel"]
ProviderKind = Literal["cli", "http"]
PlanFlow = Literal["lean", "full"]


class WorkflowLineup(TypedDict):
    """Role-to-provider assignments, model choices, and optional previous size."""

    roles: dict[str, str]
    model_overrides: dict[str, str]
    size: NotRequired[ProjectSize]
    customized: NotRequired[bool]  # True once the user changed the team by hand


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
    ``required_roles=None`` means unknown, not empty.  ``default_lineup`` follows
    the setup step's tiered catalog picks (the host-derived relay when those cannot
    be built); ``eco_lineup`` is the lean small-project team derived from them.
    ``implicit_model_targets`` lists role/provider pairs for which the existing
    config can resolve a model without an explicit override; None means that
    information is unavailable.
    """

    providers: tuple[ProviderReadiness, ...]
    default_lineup: WorkflowLineup | None = None
    panelist_providers: tuple[str, ...] = ()
    synthesizer_provider: str | None = None
    eco_lineup: WorkflowLineup | None = None
    preferred_lineup: WorkflowLineup | None = None
    required_roles: tuple[str, ...] | None = None
    implicit_model_targets: tuple[tuple[str, str], ...] | None = None
    # The resolved model catalog (per-provider allowed efforts); None means efforts are not checked.
    catalog: tuple[model_catalog.ModelCatalogEntry, ...] | None = None


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
    missing_panelists: tuple[str, ...] = ()
    # Saved team settings that were not legal and were changed: {role, before, after, reason}.
    effort_changes: tuple[dict[str, str], ...] = ()


class LaunchSelectionError(ValueError):
    """A launch preflight failure with stable, machine-readable reason codes."""

    def __init__(
        self, codes: tuple[str, ...], synthesizer_provider: str | None = None, *,
        effort_changes: tuple[dict[str, str], ...] = (), suggested_lineup: WorkflowLineup | None = None,
    ) -> None:
        self.codes = codes
        self.effort_changes = effort_changes
        self.suggested_lineup = suggested_lineup
        detail = ", ".join(codes)
        if effort_changes:
            detail += " (" + "; ".join(
                f"{change['role']}: {change['before']} -> {change['after']}" for change in effort_changes
            ) + ")"
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


def _missing_panelists(snapshot: ReadinessSnapshot) -> tuple[str, ...]:
    ready = set(_ready_providers(snapshot))
    return tuple(provider for provider in snapshot.panelist_providers if provider not in ready)


def _panel_errors(snapshot: ReadinessSnapshot) -> tuple[str, ...]:
    """Launch preflight: the engine skips failed specialists, so one ready panelist suffices."""
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


def normalize_lineup(
    lineup: WorkflowLineup, catalog: tuple[model_catalog.ModelCatalogEntry, ...] | list | None,
) -> tuple[WorkflowLineup, tuple[dict[str, str], ...]]:
    """Run every model override through ``model_catalog.normalize_spec``; returns the legal lineup and
    what changed. Models the catalog cannot check are kept unchanged."""
    if not catalog or not isinstance(lineup, dict) or not isinstance(lineup.get("model_overrides"), dict):
        return lineup, ()
    fixed = deepcopy(lineup)
    changes: list[dict[str, str]] = []
    for role, spec in lineup["model_overrides"].items():
        if not isinstance(spec, str):
            continue
        result = model_catalog.normalize_spec_string(spec, catalog)
        if result["changed"]:
            fixed["model_overrides"][role] = result["spec"]
            changes.append({"role": role, "before": spec, "after": result["spec"], "reason": result["reason"]})
    return fixed, tuple(changes)


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
    effort_changes: tuple[dict[str, str], ...] = ()
    suggested: WorkflowLineup | None = None
    if lineup is not None and readiness.catalog:
        suggested, effort_changes = normalize_lineup(lineup, readiness.catalog)
        if effort_changes:
            errors.append("effort_not_allowed")
    if errors:
        raise LaunchSelectionError(
            tuple(errors), readiness.synthesizer_provider,
            effort_changes=effort_changes, suggested_lineup=suggested if effort_changes else None,
        )


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


SizeBasis = Literal["model", "estimated"]
_BULLET = re.compile(r"^[ \t]*(?:[-*+]|\d+[.)])[ \t]+\S")
_FENCE = re.compile(r"^[ \t]{0,3}(`{3,}|~{3,})")
_PLACEHOLDER_AREA = "Implementation areas are chosen during planning."


def _section_bullets(rfc_markdown: str) -> dict[str, int]:
    """Count list items under each lower-cased ``## `` heading, ignoring fenced code."""
    counts: dict[str, int] = {}
    current: str | None = None
    fence: str | None = None
    for line in rfc_markdown.splitlines():
        match = _FENCE.match(line)
        if fence is not None:
            if match and match.group(1).startswith(fence):
                fence = None
            continue
        if match:
            fence = match.group(1)
            continue
        if line.startswith("## "):
            current = line[3:].strip().lower()
            counts.setdefault(current, 0)
        elif current is not None and _BULLET.match(line) and _PLACEHOLDER_AREA not in line:
            counts[current] += 1
    return counts


def estimate_project_size(rfc_markdown: str, *, repo_is_empty: bool) -> ProjectSize:
    """Deterministic size from the blueprint when the model gave none.

    Six or more goals or deliverable areas is large; at most two of each in an existing
    project is small; everything else, including a project started from an empty folder
    or a draft without goals, is medium.
    """
    counts = _section_bullets(rfc_markdown)
    if "goals" not in counts:
        return "medium"
    goals = counts["goals"]
    areas = counts.get("architecture & deliverables", 0)
    if goals >= 6 or areas >= 6:
        return "large"
    if goals <= 2 and areas <= 2 and not repo_is_empty:
        return "small"
    return "medium"


def _base_lineup(
    previous: WorkflowLineup | None, readiness: ReadinessSnapshot,
) -> tuple[WorkflowLineup | None, bool]:
    """The setup team when it is still ready, else the (repaired) tiered default; flag = repaired."""
    if _lineup_valid(previous, readiness):
        assert previous is not None
        return {"roles": dict(previous["roles"]), "model_overrides": dict(previous["model_overrides"])}, False
    candidate = readiness.default_lineup
    if _lineup_valid(candidate, readiness):
        return deepcopy(candidate), False
    return _repair_lineup(candidate, readiness), True


def recommend_workflow(
    size: ProjectSize | None,
    readiness: ReadinessSnapshot,
    *,
    previous_lineup: WorkflowLineup | None = None,
    size_basis: SizeBasis | None = None,
) -> DetailedWorkflowRecommendation:
    """Recommend a workflow without I/O, clocks, random choices, or mutation.

    ``previous_lineup`` is the team confirmed in setup (or the last saved team). Flagged
    ``customized`` and still ready, it is kept as is; otherwise small projects get the lean
    team and medium/large reuse it. Large recommends the panel only when the Synthesizer and
    every panelist are ready. ``explanation_codes`` are ordered: size and its basis, the
    arrangement (always present), then notes such as fallbacks or substitutions.
    ``preset`` is always None: presets never changed how a Guided run works.
    """
    known = size in ("small", "medium", "large")
    normalized: ProjectSize = cast(ProjectSize, size) if known else "medium"
    if not known:
        size_code = "size_defaulted_to_medium"
    else:
        size_code = "size_estimated" if size_basis == "estimated" else "size_from_model"
    prior_size = previous_lineup.get("size") if isinstance(previous_lineup, dict) else None
    size_changed = prior_size != normalized if prior_size in ("small", "medium", "large") else None

    notes: list[str] = []
    missing = _missing_panelists(readiness) if normalized == "large" else ()
    if normalized == "large":
        notes.extend(_panel_errors(readiness))
        if missing and "panelist_unavailable" not in notes:
            notes.append("panelist_not_ready")
    mode: WorkflowMode = "panel" if normalized == "large" and not notes else "overnight"

    # A saved team with an effort its tool does not offer is corrected first (the model is never changed).
    effort_changes: tuple[dict[str, str], ...] = ()
    if isinstance(previous_lineup, dict) and readiness.catalog:
        previous_lineup, effort_changes = normalize_lineup(previous_lineup, readiness.catalog)
        if effort_changes:
            notes.append("effort_adjusted")
    custom = isinstance(previous_lineup, dict) and previous_lineup.get("customized") is True
    kept = custom and _lineup_valid(previous_lineup, readiness)
    repaired = False
    if kept:
        lineup = deepcopy(previous_lineup)
        arrangement = "custom_lineup_kept"
    else:
        lineup, repaired = _base_lineup(previous_lineup, readiness)
        if normalized == "small":
            arrangement = "small_eco"
            if _lineup_valid(readiness.eco_lineup, readiness):
                lineup = deepcopy(readiness.eco_lineup)
                repaired = False
            elif lineup is not None:
                notes.append("eco_model_unavailable")
        elif mode == "panel":
            arrangement = "large_panel"
        else:
            arrangement = "large_relay" if normalized == "large" else "medium_relay"
        if lineup is not None:
            lineup["size"] = normalized

    substitutions: list[ProviderSubstitution] = []
    preferred = readiness.preferred_lineup or readiness.default_lineup
    if lineup is not None and repaired and isinstance(preferred, dict) and isinstance(preferred.get("roles"), dict):
        ready = set(_ready_providers(readiness))
        for role, chosen in lineup["roles"].items():
            original = preferred["roles"].get(role)
            if isinstance(original, str) and original != chosen and original not in ready:
                substitutions.append(ProviderSubstitution(role, original, chosen))
    if substitutions:
        notes.append("provider_substituted")
    if lineup is None:
        notes.append("no_ready_provider" if not _ready_providers(readiness) else "lineup_unavailable")

    reasons = (size_code, arrangement, *dict.fromkeys(notes))
    return DetailedWorkflowRecommendation(
        mode=mode, preset=None, lineup=lineup, size=normalized,
        reason_code=arrangement, explanation_key=f"workflow.{arrangement}", fallback=bool(notes),
        size_changed=size_changed, explanation_codes=reasons, substitutions=tuple(substitutions),
        missing_panelists=missing, effort_changes=effort_changes,
    )


def plan_flow(size: str | None, mode: str, rfc_markdown: str, *, lean_flow: bool = True) -> tuple[PlanFlow, str]:
    """The plan flow a run uses and why; the engine and the recommendation both decide with this.

    Only a small run whose RFC has a verification command the milestone gate can run as written
    skips planning ("lean": one task for critical_executor, those commands as the milestone gate).
    Runs that are not small, panel runs, runs with the lean flow switched off and RFCs without
    such a command use the full flow.
    """
    if size != "small":
        return "full", "size_not_small"
    if mode == "panel":
        return "full", "panel_mode"
    if not lean_flow:
        return "full", "lean_flow_off"
    if not extract_verification_commands(rfc_markdown):
        return "full", "no_verification_command"
    return "lean", "small_rfc_has_verification"


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


# Execution effort for a small project's single worker model: its default, but no higher than this.
_LEAN_EFFORT_CAP = "high"
_EFFORT_RANK = {effort["id"]: index for index, effort in enumerate(model_catalog.EFFORT_LEVELS)}


def _lean_execution_effort(pick: dict[str, str], models: Sequence[model_catalog.ModelCatalogEntry]) -> str:
    entry = model_catalog.find_catalog_model(pick["provider"], pick["model"], models)
    if entry is None:
        return pick["effort"]
    preferred = entry.get("provider_defaults", {}).get(pick["provider"]) or entry["default_effort"]
    if _EFFORT_RANK.get(preferred, 0) > _EFFORT_RANK[_LEAN_EFFORT_CAP]:
        preferred = _LEAN_EFFORT_CAP
    return model_catalog.legal_default_effort(preferred, model_catalog.allowed_efforts(entry, pick["provider"]))


def _tiered_lineup(
    cfg: BatonConfig, providers: tuple[ProviderReadiness, ...], models: Sequence[model_catalog.ModelCatalogEntry],
    *, lean: bool = False,
) -> WorkflowLineup | None:
    """The setup step's per-role catalog picks over ready providers (``recommend_role_assignment``).

    ``lean`` (small projects) uses two models: every planning/review role (L0, L1) shares the L1 pick,
    and every execution role shares the standard-tier (L2) pick, because one worker carries more of the
    work, at its default effort capped at high.
    """
    ready = list(_ready_providers(ReadinessSnapshot(providers)))
    if not ready or not cfg.roles:
        return None
    models = model_catalog.ensure_resolved(models)
    roles: dict[str, str] = {}
    overrides: dict[str, str] = {}
    for name in cfg.roles:
        execution = model_catalog.ROLE_TIERS.get(name, "L2") in ("L2", "L3")
        role_for_pick = name if not lean else ("critical_executor" if execution else "tactical_planner")
        pick = model_catalog.recommend_role_assignment(role_for_pick, ready, models)
        if pick is None:
            return None
        effort = _lean_execution_effort(pick, models) if lean and execution and pick["model"] else pick["effort"]
        if pick["model"]:
            spec: str | None = f"{pick['provider']}:{pick['model']}" + (f"@{effort}" if effort else "")
        else:
            spec = _configured_override(cfg, name, pick["provider"])
        if spec is None:
            return None
        roles[name], overrides[name] = pick["provider"], spec
    return {"roles": roles, "model_overrides": overrides}


def build_readiness_snapshot(
    repo_path: Path,
    cfg: BatonConfig,
    credentials_path: Path | None = None,
    *,
    scan_result: cli_registry.CliScanResult | None = None,
    models: Sequence[model_catalog.ModelCatalogEntry] | None = None,
) -> ReadinessSnapshot:
    """Read config, local credential/CLI scan, presets, and effective panel settings.

    Passing an existing scan avoids running another registry scan. Unregistered
    CLI providers use the existing bounded provider probe. These checks do not
    install or log in. Snapshot contents never include credential values.
    ``models`` is the model catalog the setup step shows; the bundled one by default.
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
    catalog = model_catalog.ensure_resolved(list(models) if models is not None else list(model_catalog.BUNDLED_MODELS))
    settings = cfg.panel if cfg.panel.members else build_default_panel_settings(cfg)
    panelists = tuple(dict.fromkeys(
        member.provider for member in settings.members if member.provider and member.model.strip()
    ))
    preferred: WorkflowLineup = {"roles": {name: role.provider for name, role in cfg.roles.items()}, "model_overrides": {}}
    return ReadinessSnapshot(
        providers=provider_tuple,
        default_lineup=_tiered_lineup(cfg, provider_tuple, catalog) or _host_lineup(cfg, scan, provider_tuple),
        panelist_providers=panelists,
        synthesizer_provider=settings.synthesizer_provider if settings.synthesizer_model.strip() else None,
        eco_lineup=_tiered_lineup(cfg, provider_tuple, catalog, lean=True),
        preferred_lineup=preferred,
        required_roles=tuple(cfg.roles),
        catalog=tuple(catalog),
        implicit_model_targets=tuple(
            (role, provider) for role in cfg.roles for provider in cfg.providers
            if _configured_override(cfg, role, provider) is not None
        ),
    )
