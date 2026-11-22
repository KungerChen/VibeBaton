"""Deterministic routing and escalation over a configured model catalog."""

from __future__ import annotations

from collections.abc import Iterable

from .config import (
    ALLOWED_BUDGET_PROFILES as ALLOWED_BUDGET_PROFILES,
    BatonConfig,
    CostTier,
    ModelCapability,
    _DYNAMIC_EFFORTS,
    _role_targets,
    _validate_budget_profile,
)
from .schemas import TaskSpec, TaskTier


_BUDGET_PREFERENCES: dict[tuple[str, TaskTier], tuple[tuple[CostTier, ...], str]] = {
    ("eco", TaskTier.ROUTINE): (("eco", "standard", "flagship"), "low"),
    ("eco", TaskTier.CRITICAL): (("standard", "flagship", "eco"), "high"),
    ("balanced", TaskTier.ROUTINE): (("standard", "eco", "flagship"), "high"),
    ("balanced", TaskTier.CRITICAL): (("flagship", "standard", "eco"), "max"),
    ("max_quality", TaskTier.ROUTINE): (("flagship", "standard", "eco"), "max"),
    ("max_quality", TaskTier.CRITICAL): (("flagship", "standard", "eco"), "max"),
}
_EFFORT_ORDER = ("", "low", "high", "xhigh", "max")


def parse_model_spec(
    spec: str, default_provider: str, known_providers: Iterable[str]
) -> tuple[str, str]:
    """Split a known provider prefix and preserve the model spec verbatim."""
    prefix, separator, model = spec.partition(":")
    if separator and prefix in known_providers:
        return prefix, model
    return default_provider, spec


def _find_capability(
    catalog: list[ModelCapability], provider: str, model: str
) -> ModelCapability | None:
    exact = next((cap for cap in catalog if (cap.provider, cap.model) == (provider, model)), None)
    base_model, _, effort = model.partition("@")
    if exact is not None or not effort:
        return exact
    return next(
        (
            cap for cap in catalog
            if cap.provider == provider and cap.model.partition("@")[0] == base_model
            and effort in cap.efforts
        ),
        None,
    )


def resolve_task_allocation(
    task: TaskSpec,
    cfg: BatonConfig,
    catalog: list[ModelCapability],
    budget_profile: str | None = None,
) -> tuple[str, str, str]:
    """Resolve a task to a ready provider, model spec, and decision reason.

    A ready pin takes precedence. With multiple ready providers, a ready
    planner assignment is preserved. Otherwise balanced follows ready role
    targets and eco or max_quality ranks candidates by cost tier. With one
    ready provider, the chosen model uses the requested effort when available.

    An empty catalog uses the first configured role fallback or the role default.
    A nonempty catalog with no ready candidates raises ValueError.
    """
    profile = _validate_budget_profile(cfg.policies.budget_profile if budget_profile is None else budget_profile)
    role = cfg.roles.get(task.assignee_role)
    if not catalog:
        if role is not None:
            for fallback in role.fallback:
                if fallback.provider in cfg.providers and fallback.model.strip():
                    return fallback.provider, fallback.model, "Model catalog is empty. Using configured role fallback."
        role, _ = cfg.resolve_role(task.assignee_role)
        return role.provider, role.model, "Model catalog is empty. Using configured role default."

    configured = [cap for cap in catalog if cap.provider in cfg.providers]
    ready = [cap for cap in configured if cap.ready]
    if not ready:
        raise ValueError(f"No ready models in the catalog for task '{task.id}'.")
    single_provider = len({cap.provider for cap in ready}) == 1

    preferred: tuple[str, str, ModelCapability] | None = None
    correction = ""
    if task.assigned_model:
        default_provider = role.provider if role is not None else ready[0].provider
        provider, model = parse_model_spec(task.assigned_model, default_provider, cfg.providers)
        capability = _find_capability(configured, provider, model)
        if capability is None:
            correction = f"Assigned model {task.assigned_model!r} is unknown or has unsupported effort. "
        elif not capability.ready:
            correction = f"Assigned model {task.assigned_model!r} is offline. "
        elif task.pinned:
            return provider, model, f"Honored ready pinned assignment {task.assigned_model!r}."
        elif not single_provider:
            return provider, model, f"Kept ready planner assignment {task.assigned_model!r}."
        else:
            preferred = provider, model, capability

    if preferred is None and role is not None:
        for provider, model in _role_targets(role):
            capability = _find_capability(configured, provider, model)
            if capability is not None and capability.ready:
                preferred = provider, model, capability
                break

    cost_order, effort = _BUDGET_PREFERENCES[profile, task.tier]
    best = min(ready, key=lambda cap: cost_order.index(cap.cost_tier))
    prioritize_cost = profile == "max_quality" or (profile == "eco" and not single_provider)
    if preferred is not None and (not prioritize_cost or preferred[2].cost_tier == best.cost_tier):
        provider, model, _ = preferred
    else:
        provider, model = best.provider, best.model

    if single_provider:
        effort_model = f"{model.partition('@')[0]}@{effort}"
        capability = _find_capability(configured, provider, effort_model)
        if capability is not None and capability.ready:
            model = effort_model

    return provider, model, f"{correction}Selected {provider}:{model} for {profile} {task.tier} allocation."


def compute_step_up_target(
    current_provider: str,
    current_model: str,
    cfg: BatonConfig,
    catalog: list[ModelCapability],
    attempt: int = 1,
) -> tuple[str, str] | None:
    """Return the attempt-th ready rung above the current target, counting from one.

    Increase effort on the same model first. Follow with the first configured
    flagship in catalog order, then the distinct critical executor target.
    A model already at the flagship or critical rung can still increase its
    effort. Cross-model escalation never revisits a rung.
    """
    if attempt < 1:
        raise ValueError("Step-up attempt must be at least 1.")

    configured = [cap for cap in catalog if cap.provider in cfg.providers]
    base_model, _, effort = current_model.partition("@")
    current_base = current_provider, base_model
    higher_efforts = _EFFORT_ORDER[_EFFORT_ORDER.index(effort) + 1:] if effort in _EFFORT_ORDER else ()
    rungs: list[tuple[str, str]] = []
    for higher_effort in _DYNAMIC_EFFORTS:
        if higher_effort in higher_efforts:
            model = f"{base_model}@{higher_effort}"
            capability = _find_capability(configured, current_provider, model)
            if capability is not None and capability.ready:
                rungs.append((current_provider, model))

    critical_role = cfg.roles.get("critical_executor")
    critical_base = None
    if critical_role is not None:
        critical_base = critical_role.provider, critical_role.model.partition("@")[0]
    flagships = [
        cap for cap in configured if cap.cost_tier == "flagship"
        and (cap.provider, cap.model.partition("@")[0]) != critical_base
    ]
    if current_base != critical_base:
        if not any((cap.provider, cap.model.partition("@")[0]) == current_base for cap in flagships):
            flagship = next((cap for cap in flagships if cap.ready), None)
            if flagship is not None:
                rungs.append((flagship.provider, flagship.model))
        if critical_role is not None:
            critical = _find_capability(configured, critical_role.provider, critical_role.model)
            if critical is not None and critical.ready:
                rungs.append((critical_role.provider, critical_role.model))

    return rungs[attempt - 1] if attempt <= len(rungs) else None
