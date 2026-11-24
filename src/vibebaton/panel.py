"""00_PANEL: concurrent read-only specialist consultation followed by synthesis.

Contract (M1-T1), implemented in M1-T3. The types, names and payload keys
below are frozen so the engine, report, case export and tests can build on them.

Artifacts
    ``<run_dir>/panel/<member_id>.md``  one transcript per specialist
    ``<run_dir>/panel/master_spec.md``  synthesizer output handed to 01_PLAN
    where ``run_dir`` is ``.baton/runs/<run_id>``.

Provider invocation
    ``invoke_provider`` is awaited with keyword arguments only::

        await invoke_provider(
            provider="claude_sub",          # ProviderConfig name or "host_native"
            model="opus@high",
            prompt="...",                   # full prompt text, template already applied
            artifact_key="panel_<member_id>",  # "panel_synthesizer" for synthesis
            fallback=[FallbackTarget(...)],
            cwd=repo_path,                  # read access only: no worktree, no write tools
        ) -> CLIResult

    The caller owns quota cooldowns, concurrency slots and fallback walking.
    Raising an exception, or returning a CLIResult whose ``status`` is not
    ``"ok"``, marks that call failed.

Events (``store.log_event(run_id, kind, payload=...)``)
    PANEL_STARTED          member_count, run_id
    PANEL_MEMBER_COMPLETED member_id, perspective, provider, model, ok,
                           tokens_in, tokens_out, cost_usd, elapsed_sec,
                           preview, output_path, error
    PANEL_SYNTHESIZED      member_count, succeeded_count, provider, model,
                           tokens_in, tokens_out, cost_usd, elapsed_sec,
                           preview, master_spec_path

    ``preview`` is a truncated, display-safe excerpt; full text lives only in
    the artifact files. ``output_path`` and ``master_spec_path`` are strings
    (empty when nothing was written). ``error`` is an empty string on success.
    ``tokens_in`` / ``tokens_out`` / ``cost_usd`` come from the provider result's
    ``prompt_tokens`` / ``completion_tokens`` / ``cost_usd``.

Failure policy
    A failed member is recorded and skipped. ``PanelPhaseError`` is raised when
    zero members succeed or the synthesizer fails.
"""

from __future__ import annotations

import asyncio
import re
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import Any

from .cli_runner import CLIResult
from .config import BatonConfig, FallbackTarget, PanelMemberConfig, PanelSettings, build_model_catalog
from .db import StateStore


PANEL_STARTED = "panel_started"
PANEL_MEMBER_COMPLETED = "panel_member_completed"
PANEL_SYNTHESIZED = "panel_synthesized"
STAGE_PANEL = "00_PANEL"

InvokeProvider = Callable[..., Awaitable[CLIResult]]

PREVIEW_LIMIT = 600
DEFAULT_PERSPECTIVES: tuple[tuple[str, str], ...] = (
    ("ux", "UX & Copy"),
    ("visual", "Visual & Structure"),
    ("safety", "Source & Safety"),
)
_PLACEHOLDER_RE = re.compile(r"\{\{\s*(\w+)\s*\}\}")
_PACKAGE_ROOT = Path(__file__).resolve().parents[2]


@dataclass
class PanelMemberResult:
    member_id: str
    perspective: str
    provider: str
    model: str
    ok: bool
    output_path: str = ""
    preview: str = ""
    error: str = ""
    tokens_in: int = 0
    tokens_out: int = 0
    cost_usd: float | None = None
    elapsed_sec: float = 0.0


@dataclass
class PanelPhaseResult:
    member_count: int
    succeeded_count: int
    elapsed_sec: float
    master_spec_path: str
    master_spec_text: str
    members: list[PanelMemberResult] = field(default_factory=list)


class PanelPhaseError(RuntimeError):
    """Raised when no specialist succeeds or synthesis fails."""


def _preview(text: str, limit: int = PREVIEW_LIMIT) -> str:
    """Collapse whitespace and cap at ``limit`` characters (ellipsis included)."""
    flat = " ".join(text.split())
    return flat if len(flat) <= limit else flat[: limit - 1].rstrip() + "…"


def _render(template: str, values: dict[str, str]) -> str:
    """Replace ``{{name}}`` placeholders in one pass; unknown names are left as-is."""
    return _PLACEHOLDER_RE.sub(lambda m: values.get(m.group(1), m.group(0)), template)


def _load_template(prompt_file: str, repo_path: Path) -> str:
    for base in (repo_path, _PACKAGE_ROOT):
        path = base / prompt_file
        if path.is_file():
            return path.read_text(encoding="utf-8")
    raise FileNotFoundError(f"Panel prompt template not found: {prompt_file}")


def _role_fallback(cfg: BatonConfig, provider: str, model: str) -> list[FallbackTarget]:
    """Reuse the fallback chain of the first role configured with the same target."""
    for role in cfg.roles.values():
        if (role.provider, role.model) == (provider, model):
            return list(role.fallback)
    return []


def build_default_panel_settings(cfg: BatonConfig) -> PanelSettings:
    """Return ``cfg.panel`` when it has members, else derive a panel from configured providers.

    Used when ``--mode panel`` runs without an explicit ``[panel]`` section.
    Deterministic: the same config always yields the same members in the same order.
    Each provider (config order) contributes one model: its first standard-tier
    role model, else its first role model. Perspectives are assigned round-robin
    over those picks; the synthesizer is the first eco, else standard, model.
    """
    if cfg.panel.members:
        return cfg.panel

    catalog = build_model_catalog(cfg)
    picks: list[tuple[str, str]] = []
    for provider in cfg.providers:
        models = [cap for cap in catalog if cap.provider == provider]
        chosen = next((cap for cap in models if cap.cost_tier == "standard"), models[0] if models else None)
        if chosen is not None:
            picks.append((chosen.provider, chosen.model))
    if not picks and cfg.providers:
        # Providers exist but no role references them: use the default synthesizer model name.
        picks.append((next(iter(cfg.providers)), PanelSettings().synthesizer_model))
    if not picks:
        return cfg.panel

    members = []
    for index, (member_id, perspective) in enumerate(DEFAULT_PERSPECTIVES):
        provider, model = picks[index % len(picks)]
        fallback = [FallbackTarget(p, m) for p, m in picks if (p, m) != (provider, model)]
        members.append(PanelMemberConfig(member_id, perspective, provider, model, fallback=fallback))

    synth = next(
        ((cap.provider, cap.model) for tier in ("eco", "standard") for cap in catalog if cap.cost_tier == tier),
        picks[0],
    )
    return replace(
        cfg.panel, enabled=True, synthesizer_provider=synth[0], synthesizer_model=synth[1], members=members
    )


def _usage(res: CLIResult | None) -> dict[str, Any]:
    if res is None:
        return {"tokens_in": 0, "tokens_out": 0, "cost_usd": None}
    return {"tokens_in": int(res.prompt_tokens), "tokens_out": int(res.completion_tokens), "cost_usd": res.cost_usd}


def _failure_reason(res: CLIResult) -> str:
    return _preview(f"{res.status} (exit {res.exit_code}): {res.stderr or res.text}", 300)


async def run_panel_phase(
    *,
    cfg: BatonConfig,
    settings: PanelSettings,
    store: StateStore,
    run_id: str,
    repo_path: Path,
    rfc_text: str,
    invoke_provider: InvokeProvider,
    run_dir: Path,
    log: Callable[[str], Any] | None = None,
) -> PanelPhaseResult:
    """Consult every panel member concurrently, then synthesize ``master_spec.md``.

    Members run under ``asyncio.Semaphore(settings.max_concurrency)`` and must
    never modify ``repo_path``. Emits PANEL_STARTED, one PANEL_MEMBER_COMPLETED
    per member, then PANEL_SYNTHESIZED. Raises PanelPhaseError when zero members
    succeed or synthesis fails.
    """

    def _log(message: str) -> None:
        if log is not None:
            log(message)

    started = time.monotonic()
    panel_dir = run_dir / "panel"
    panel_dir.mkdir(parents=True, exist_ok=True)
    members = list(settings.members)
    store.log_event(
        run_id, PANEL_STARTED, actor="panel", message=f"Panel started with {len(members)} specialists",
        payload={"member_count": len(members), "run_id": run_id},
    )
    semaphore = asyncio.Semaphore(max(1, settings.max_concurrency))

    async def consult(member: PanelMemberConfig) -> PanelMemberResult:
        result = PanelMemberResult(member.id, member.perspective, member.provider, member.model, ok=False)
        t0 = time.monotonic()
        res: CLIResult | None = None
        try:
            prompt = _render(
                _load_template(member.prompt_file, repo_path),
                {"repo_path": str(repo_path), "perspective": member.perspective, "rfc": rfc_text},
            )
            async with semaphore:
                res = await invoke_provider(
                    provider=member.provider,
                    model=member.model,
                    prompt=prompt,
                    artifact_key=f"panel_{member.id}",
                    fallback=list(member.fallback),
                    cwd=repo_path,
                )
            if res.status != "ok":
                result.error = _failure_reason(res)
            else:
                output = panel_dir / f"{member.id}.md"
                output.write_text(res.text, encoding="utf-8", newline="")
                result.ok = True
                result.output_path = str(output)
                result.preview = _preview(res.text)
        except Exception as exc:  # noqa: BLE001 - one specialist must not sink the panel
            result.error = _preview(f"{type(exc).__name__}: {exc}", 300)
        result.elapsed_sec = round(time.monotonic() - t0, 3)
        usage = _usage(res)
        result.tokens_in, result.tokens_out, result.cost_usd = usage["tokens_in"], usage["tokens_out"], usage["cost_usd"]
        _log(f"[panel] {member.id} ({member.provider}/{member.model}) {'ok' if result.ok else 'failed: ' + result.error}")
        store.log_event(
            run_id, PANEL_MEMBER_COMPLETED, actor=f"panel:{member.id}",
            message=f"Panel specialist {member.id} {'completed' if result.ok else 'failed'}",
            payload={
                "member_id": member.id, "perspective": member.perspective, "provider": member.provider,
                "model": member.model, "ok": result.ok, **usage, "elapsed_sec": result.elapsed_sec,
                "preview": result.preview, "output_path": result.output_path, "error": result.error,
            },
        )
        return result

    gathered = await asyncio.gather(*(consult(m) for m in members), return_exceptions=True)
    results: list[PanelMemberResult] = []
    for member, item in zip(members, gathered):
        if isinstance(item, BaseException):  # consult() records Exceptions itself; this covers the rest
            item = PanelMemberResult(
                member.id, member.perspective, member.provider, member.model, ok=False, error=_preview(repr(item), 300)
            )
        results.append(item)
    succeeded = [r for r in results if r.ok]
    if not succeeded:
        raise PanelPhaseError(f"No panel specialist succeeded ({len(members)} attempted)")

    reports = "\n\n".join(
        f"### {r.perspective} ({r.member_id}, {r.provider}/{r.model})\n\n"
        + Path(r.output_path).read_text(encoding="utf-8").strip()
        for r in succeeded
    )
    rules = "\n".join(f"- {rule}" for rule in settings.arbitration_rules)
    provider, model = settings.synthesizer_provider, settings.synthesizer_model
    try:
        prompt = _render(
            _load_template(settings.synthesizer_prompt_file, repo_path),
            {"rfc": rfc_text, "reports": reports, "arbitration_rules": rules},
        )
        res = await invoke_provider(
            provider=provider,
            model=model,
            prompt=prompt,
            artifact_key="panel_synthesizer",
            fallback=_role_fallback(cfg, provider, model),
            cwd=repo_path,
        )
    except Exception as exc:
        raise PanelPhaseError(f"Panel synthesizer {provider}/{model} failed: {exc}") from exc
    if res.status != "ok":
        raise PanelPhaseError(f"Panel synthesizer {provider}/{model} failed: {_failure_reason(res)}")

    master_spec = panel_dir / "master_spec.md"
    master_spec.write_text(res.text, encoding="utf-8", newline="")
    elapsed = round(time.monotonic() - started, 3)
    _log(f"[panel] synthesized master spec from {len(succeeded)}/{len(members)} reports")
    store.log_event(
        run_id, PANEL_SYNTHESIZED, actor="panel:synthesizer",
        message=f"Panel synthesized master spec from {len(succeeded)}/{len(members)} reports",
        payload={
            "member_count": len(members), "succeeded_count": len(succeeded), "provider": provider, "model": model,
            **_usage(res), "elapsed_sec": elapsed, "preview": _preview(res.text),
            "master_spec_path": str(master_spec),
        },
    )
    return PanelPhaseResult(
        member_count=len(members), succeeded_count=len(succeeded), elapsed_sec=elapsed,
        master_spec_path=str(master_spec), master_spec_text=res.text, members=results,
    )
