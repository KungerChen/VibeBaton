"""Core async orchestration engine: DAG scheduling, mechanical gates, escalation, and quota cooldowns."""

from __future__ import annotations

import asyncio
import ctypes
import json
import logging
import re
import subprocess
import sys
import time
import uuid
from collections.abc import Iterable
from contextlib import contextmanager, suppress
from dataclasses import replace
from itertools import count
from pathlib import Path
from typing import Any, Iterator, TypedDict

from . import cli_runner, pricing
from .allocation import compute_step_up_target, parse_model_spec, resolve_task_allocation
from .cli_runner import CLIResult, invoke_provider
from .config import (
    BatonConfig,
    FallbackTarget,
    HotReloadConfig,
    ModelCapability,
    ProviderConfig,
    RoleConfig,
    build_model_catalog,
)
from .db import ActiveRunError, RunTerminalError, StateStore
from .gates import run_gate_suite
from .git_ops import (
    GitError,
    MergeConflictError,
    MergeResult,
    check_path_whitelist,
    commit_worktree_changes,
    create_backup_tag,
    create_run_branch_at,
    create_worktree,
    ensure_branch,
    ensure_git_ready,
    get_diff_against,
    merge_branch_into,
    merge_branch_with_resolver,
    remove_worktree,
    resolve_ref_sha,
    revert_disallowed_files,
)
from .notifier import AttentionEvent, AttentionNotifier, ChannelResult, should_notify
from .panel import STAGE_PANEL, build_default_panel_settings, run_panel_phase
from .schemas import (
    PlanDAG,
    ReviewVerdict,
    RunStatus,
    SchemaValidationError,
    TaskSpec,
    TaskStatus,
    TaskTier,
    VerdictKind,
    extract_json_object,
)


_LOGGER = logging.getLogger(__name__)


class StopRunTimeoutError(TimeoutError):
    """The stop remains requested because the executor has not settled."""


class ReplanFailureContext(TypedDict):
    run_id: str
    failed_tasks: list[dict[str, Any]]
    last_errors: dict[str, str]
    current_sha: str
    run_summary: str


async def run_provider_cli(provider: ProviderConfig, **kwargs: Any) -> CLIResult:
    """Keep the engine's CLI hook backed by the shared runner."""
    return await cli_runner.run_provider_cli(provider, **kwargs)


@contextmanager
def windows_wake_lock(enabled: bool) -> Iterator[None]:
    """Prevent Windows from entering sleep mode while unattended pipelines are active."""
    if not enabled or sys.platform != "win32":
        yield
        return
    ES_CONTINUOUS = 0x80000000
    ES_SYSTEM_REQUIRED = 0x00000001
    try:
        ctypes.windll.kernel32.SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED)
        yield
    finally:
        try:
            ctypes.windll.kernel32.SetThreadExecutionState(ES_CONTINUOUS)
        except Exception:
            pass


class OrchestrationEngine:
    """Self-hosting 4-tier DAG orchestration engine with hot-reload & quota awareness."""

    def __init__(
        self,
        repo_path: Path,
        config_loader: HotReloadConfig,
        store: StateStore,
        package_root: Path | None = None,
        *,
        credentials_path: Path | None = None,
        notifier: AttentionNotifier | None = None,
    ) -> None:
        self.repo_path = repo_path.resolve()
        self.config_loader = config_loader
        self.store = store
        self.package_root = (package_root or Path(__file__).resolve().parents[2]).resolve()
        self.credentials_path = credentials_path
        self.notifier = notifier if notifier is not None else AttentionNotifier(credentials_path=self.credentials_path)
        self._attention_run_id: str | None = None
        self._notified_episodes: set[tuple[str, str, str]] = set()
        self._semaphores: dict[str, tuple[int, asyncio.Semaphore]] = {}
        self._merge_lock = asyncio.Lock()
        self._run_children: dict[str, set[asyncio.Task[bool]]] = {}

    @property
    def cfg(self) -> BatonConfig:
        return self.config_loader.current

    @staticmethod
    def run_branch(run_id: str) -> str:
        """Return the dedicated branch containing a lineage run's result."""
        return f"baton/runs/{run_id}"

    def create_run(
        self, rfc_path: Path, *, parent_run_id: str | None = None,
        mode: str = "overnight", plan_path: Path | None = None,
        model_overrides: dict[str, str] | None = None, run_id: str | None = None,
    ) -> str:
        """Create a lineage run with an immutable RFC and an exact starting ref.

        The DB reservation serializes launches across processes. A revision
        requires its parent to be settled and have a recorded result commit.
        """
        rid = run_id or f"run-{time.strftime('%Y%m%d-%H%M%S')}-{uuid.uuid4().hex}"
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]*", rid):
            raise ValueError("Invalid run ID")
        source = Path(rfc_path)
        if not source.is_absolute():
            source = self.repo_path / source
        snapshot = self.repo_path / ".baton" / "runs" / rid / "00_RFC.md"
        branch = self.run_branch(rid)
        made_snapshot = False
        branch_target: str | None = None

        def prepare(parent: dict[str, Any] | None) -> tuple[Path, str]:
            nonlocal made_snapshot, branch_target
            start_sha = resolve_ref_sha(self.repo_path, parent["result_sha"] if parent else "main")
            existing = subprocess.run(
                ["git", "show-ref", "--verify", "--quiet", f"refs/heads/{branch}"],
                cwd=self.repo_path, capture_output=True, check=False,
            )
            if existing.returncode == 0:
                raise ValueError(f"Run branch {branch} already exists")
            if existing.returncode != 1:
                raise GitError(f"Cannot check run branch {branch}: {existing.stderr.decode(errors='replace').strip()}")
            content = source.read_bytes()
            snapshot.parent.mkdir(parents=True, exist_ok=True)
            with snapshot.open("xb") as handle:
                made_snapshot = True
                handle.write(content)
            branch_target = start_sha
            create_run_branch_at(self.repo_path, branch, start_sha)
            return snapshot, start_sha

        try:
            return self.store.create_lineage_run(
                self.repo_path, rid, parent_run_id=parent_run_id, mode=mode, plan_path=plan_path,
                model_overrides=model_overrides, prepare=prepare,
            )
        except BaseException:
            if branch_target is not None:
                # Only remove the ref we created, and only if it still points at our starting SHA.
                subprocess.run(["git", "update-ref", "-d", f"refs/heads/{branch}", branch_target],
                               cwd=self.repo_path, capture_output=True, check=False)
            if made_snapshot:
                snapshot.unlink(missing_ok=True)
                with suppress(OSError):
                    snapshot.parent.rmdir()
            raise

    async def resume_run(self, run_id: str) -> RunStatus:
        """Resume a nonterminal run after the prior executor has settled."""
        run = self.store.get_run(run_id)
        if not run or Path(run["repo_path"]).resolve() != self.repo_path:
            raise ValueError(f"Run '{run_id}' not found in this repository")
        self.store.resume_run(run_id)
        return await self.execute_run(run_id)

    def finalize_run(self, run_id: str) -> dict[str, Any]:
        """Validate final-gate entry; the caller performs the selected gate action."""
        run = self.store.get_run(run_id)
        if not run or Path(run["repo_path"]).resolve() != self.repo_path:
            raise ValueError(f"Run '{run_id}' not found in this repository")
        if run["status"] in (RunStatus.COMPLETED, RunStatus.FAILED, RunStatus.SUPERSEDED):
            raise RunTerminalError(run_id, run["status"])
        if self.store.is_stop_requested(run_id):
            raise ActiveRunError(f"Run {run_id} is stopping for replan")
        if run["status"] != RunStatus.READY_FOR_FINAL_GATE:
            raise ValueError(f"Run {run_id} is {run['status']}, not READY_FOR_FINAL_GATE")
        return run

    async def stop_run_for_replan(self, run_id: str, *, timeout_sec: float = 30.0) -> ReplanFailureContext:
        """Stop new dispatch, wait for the executor, and return settled failure context.

        A timeout leaves the stop request in place. Retrying after the executor
        drains completes the stop; no terminal state is fabricated on timeout.
        """
        if timeout_sec < 0:
            raise ValueError("timeout_sec must be non-negative")
        run = self.store.get_run(run_id)
        if not run or Path(run["repo_path"]).resolve() != self.repo_path:
            raise ValueError(f"Run '{run_id}' not found in this repository")
        self.store.request_run_stop(run_id)
        deadline = time.monotonic() + timeout_sec
        while not self.store.run_stop_settled(run_id):
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise StopRunTimeoutError(f"Run {run_id} has not settled; stop remains requested")
            await asyncio.sleep(min(0.1, remaining))
        run = self.store.get_run(run_id)
        if run["status"] == RunStatus.SUPERSEDED:
            sha = run["result_sha"]
        else:
            branch = self.run_branch(run_id) if run["start_sha"] else self.cfg.daemon.dev_branch
            try:
                sha = resolve_ref_sha(self.repo_path, branch)
            except GitError:
                if run["start_sha"]:
                    raise
                sha = resolve_ref_sha(self.repo_path, "HEAD")
            self.store.complete_run_stop(run_id, sha)
            sha = self.store.get_run(run_id)["result_sha"]
        tasks = self.store.get_tasks(run_id)
        return {
            "run_id": run_id,
            "failed_tasks": [task for task in tasks if task["status"] == TaskStatus.FAILED],
            "last_errors": {task["id"]: task["last_error"] for task in tasks if task["last_error"]},
            "current_sha": sha,
            "run_summary": self.store.get_run(run_id)["summary"],
        }

    async def _emit_attention(
        self,
        run_id: str,
        category: str,
        severity: str,
        title: str,
        message: str,
        action_hint: str,
        milestone_id: str | None = None,
        task_id: str | None = None,
        wait_sec: float | None = None,
    ) -> None:
        """Record an attention episode and the outcomes of any enabled deliveries."""
        if self._attention_run_id != run_id:
            self._attention_run_id = run_id
            self._notified_episodes.clear()
        episode = (category, milestone_id or "", task_id or "")
        if episode in self._notified_episodes:
            return
        # Claim the episode before dispatch can yield to a second caller.
        self._notified_episodes.add(episode)
        event = AttentionEvent(run_id, category, severity, title, message, action_hint, milestone_id, task_id)
        channels: list[ChannelResult] = []
        try:
            settings = self.cfg.notifications
            if should_notify(category, settings, wait_sec):
                result = await asyncio.to_thread(self.notifier.notify, event, settings)
                channels = result.channels
        except Exception:
            _LOGGER.warning("Attention notification failed for run %s (%s)", run_id, category)
        finally:
            self.store.log_event(
                run_id,
                "human_attention_required",
                task_id=task_id,
                milestone_id=milestone_id,
                message=message,
                payload={
                    "category": category,
                    "severity": severity,
                    "title": title,
                    "message": message,
                    "action_hint": action_hint,
                    "channels": channels,
                },
            )

    async def _stop_if_paused(
        self, run: dict[str, Any] | None, in_flight: Iterable[asyncio.Task[bool]] = (),
    ) -> bool:
        if not run or run["status"] != RunStatus.PAUSED:
            return False
        pending = tuple(in_flight)
        # Replanning drains workers instead of cancelling a gate or merge
        # subprocess that could continue writing after its coroutine exits.
        replan = self.store.is_stop_requested(run["id"])
        if not replan:
            for task in pending:
                task.cancel()
        if pending:
            await asyncio.gather(*pending, return_exceptions=True)
        if replan:
            return True
        await self._emit_attention(
            run["id"], "paused", "warning", "Run paused", "The run was paused by the user or host.",
            "Resume the run in Studio when ready.",
        )
        return True

    async def _request_human_decision(
        self, run_id: str, milestone_id: str, human_prompt: str, *, task_ids: Iterable[str | None] = (None,),
    ) -> None:
        self.store.update_run_status(run_id, RunStatus.WAITING_HUMAN, human_prompt=human_prompt)
        for task_id in task_ids:
            await self._emit_attention(
                run_id, "waiting_human", "warning", "Human decision required", human_prompt,
                "Review and resolve the blocker in Studio.", milestone_id=milestone_id, task_id=task_id,
            )

    def _worktree_root(self) -> Path:
        root = Path(self.cfg.daemon.worktree_root)
        return root if root.is_absolute() else (self.repo_path / root).resolve()

    def _runtime_dir(self, run_id: str) -> Path:
        path = self.repo_path / ".baton" / "runs" / run_id
        path.mkdir(parents=True, exist_ok=True)
        return path

    def _get_semaphore(self, provider: ProviderConfig) -> asyncio.Semaphore:
        existing = self._semaphores.get(provider.name)
        if existing is None or existing[0] != provider.max_concurrency:
            sem = asyncio.Semaphore(provider.max_concurrency)
            self._semaphores[provider.name] = (provider.max_concurrency, sem)
            return sem
        return existing[1]

    def _load_prompt_template(self, role: RoleConfig) -> str:
        if not role.prompt_file:
            return ""
        candidates = [
            self.repo_path / role.prompt_file,
            self.package_root / role.prompt_file,
        ]
        for path in candidates:
            if path.exists():
                return path.read_text(encoding="utf-8")
        return ""

    async def _invoke_role(
        self,
        run_id: str,
        role_name: str,
        prompt: str,
        workdir: Path,
        artifact_key: str,
        model_overrides: dict[str, str],
        task_id: str | None = None,
        milestone_id: str | None = None,
        max_rate_limit_waits: int = 4,
    ) -> tuple[CLIResult, str]:
        """Dispatch a prompt to a logical role with hot-reload, concurrency slots & quota cooldown."""
        cfg = self.cfg
        role, provider = cfg.resolve_role(role_name, model_overrides=model_overrides)
        if provider is None:
            raise RuntimeError(f"Role '{role_name}' uses 'host_native' and cannot be invoked as a CLI subprocess.")

        system_prefix = self._load_prompt_template(role)
        full_prompt = f"{system_prefix.strip()}\n\n---\n\n{prompt}" if system_prefix.strip() else prompt

        rt_dir = self._runtime_dir(run_id)
        prompt_file = rt_dir / "prompts" / f"{artifact_key}.md"
        output_file = rt_dir / "out" / f"{artifact_key}.json"

        attempts = 0
        active_provider = provider
        active_model = role.model
        fallback_index = 0

        while True:
            # Respect subscription cooldown window before acquiring slot
            cooldown = self.store.get_provider_cooldown(active_provider.name)
            if cooldown > 0:
                task = self.store.get_task(run_id, task_id) if task_id else None
                if task is not None:
                    self.store.update_task(run_id, task_id, status=TaskStatus.COOLDOWN)
                message = f"Waiting {cooldown:.1f}s for {active_provider.name} quota cooldown"
                self.store.log_event(
                    run_id,
                    "quota_cooldown_wait",
                    actor=active_provider.name,
                    task_id=task_id,
                    milestone_id=milestone_id,
                    message=message,
                    payload={"wait_sec": cooldown},
                )
                try:
                    if cooldown >= cfg.notifications.on_long_cooldown_sec > 0:
                        await asyncio.gather(
                            asyncio.sleep(cooldown),
                            self._emit_attention(
                                run_id, "long_cooldown", "warning", "Provider quota cooldown", message,
                                "The run will retry automatically after the cooldown.",
                                milestone_id=milestone_id, task_id=task_id, wait_sec=cooldown,
                            ),
                        )
                    else:
                        await asyncio.sleep(cooldown)
                finally:
                    if self._attention_run_id == run_id:
                        self._notified_episodes.discard(("long_cooldown", milestone_id or "", task_id or ""))
                    if task is not None:
                        self.store.update_task(run_id, task["id"], status=task["status"])

            sem = self._get_semaphore(active_provider)
            async with sem:
                self.store.log_event(
                    run_id,
                    "role_invoked",
                    actor=f"{role_name}:{active_model}",
                    task_id=task_id,
                    milestone_id=milestone_id,
                    message=f"Invoking {role_name} ({active_provider.name}/{active_model})",
                )
                transport_model = active_model
                effort: str | None = None
                if active_provider.type == "http":
                    transport_model, _, effort_suffix = active_model.partition("@")
                    effort = effort_suffix or None
                res = await invoke_provider(
                    active_provider,
                    model=transport_model,
                    effort=effort,
                    prompt=full_prompt,
                    cwd=workdir,
                    prompt_file=prompt_file,
                    output_file=output_file,
                    credentials_path=self.credentials_path,
                    cli_executor=run_provider_cli,
                    pricing_settings=cfg.pricing,
                    default_stall_timeout=cfg.daemon.default_stall_timeout_sec,
                    default_hard_timeout=cfg.daemon.default_hard_timeout_sec,
                    extra_env={
                        "VIBEBATON_RUN_ID": run_id,
                        "VIBEBATON_ROLE": role_name,
                        "VIBEBATON_TASK_ID": task_id or "",
                        "VIBEBATON_MILESTONE_ID": milestone_id or "",
                    },
                )
                payload: dict[str, str | int | float] = {
                    "role": role_name,
                    "provider": active_provider.name,
                    "model": active_model,
                    "duration_sec": round(float(res.duration_sec), 3),
                    "status": res.status,
                    "exit_code": res.exit_code,
                }
                has_cli_usage = active_provider.type != "http" and any((
                    res.prompt_tokens, res.completion_tokens, res.cached_tokens,
                ))
                if has_cli_usage or res.prompt_tokens > 0:
                    payload["prompt_tokens"] = res.prompt_tokens
                if has_cli_usage or res.completion_tokens > 0:
                    payload["completion_tokens"] = res.completion_tokens
                if has_cli_usage or res.cached_tokens > 0:
                    payload["cached_tokens"] = res.cached_tokens
                if res.cost_usd is not None:
                    payload["cost_usd"] = res.cost_usd
                self.store.log_event(
                    run_id,
                    "role_completed",
                    actor=f"{role_name}:{active_model}",
                    task_id=task_id,
                    milestone_id=milestone_id,
                    message=(
                        f"Completed {role_name} ({active_provider.name}/{active_model}) "
                        f"in {float(res.duration_sec):.1f}s ({res.status})"
                    ),
                    payload=payload,
                )

            if res.status == "rate_limited":
                wait_sec = self.store.trigger_provider_cooldown(
                    active_provider.name,
                    backoff_schedule=active_provider.cooldown_backoff_sec,
                    reason=(res.stderr or res.stdout)[:240],
                    explicit_wait_sec=res.retry_after_sec,
                )
                self.store.log_event(
                    run_id,
                    "quota_rate_limited",
                    actor=active_provider.name,
                    task_id=task_id,
                    milestone_id=milestone_id,
                    message=f"{active_provider.name} hit rate limit; cooldown {wait_sec:.1f}s",
                    payload={"wait_sec": wait_sec, "model": active_model},
                )
                attempts += 1
                if attempts <= max_rate_limit_waits:
                    continue
                # Try configured fallback provider if main provider stays throttled
                if fallback_index < len(role.fallback):
                    fb = role.fallback[fallback_index]
                    fallback_index += 1
                    if fb.provider in cfg.providers:
                        active_provider = cfg.providers[fb.provider]
                        active_model = fb.model
                        attempts = 0
                        self.store.log_event(
                            run_id,
                            "role_fallback",
                            actor=role_name,
                            task_id=task_id,
                            milestone_id=milestone_id,
                            message=f"Switching {role_name} to fallback {active_provider.name}/{active_model}",
                        )
                        continue
                return res, f"{active_provider.name}:{active_model}"

            if res.status == "ok":
                self.store.reset_provider_backoff(active_provider.name)
            return res, f"{active_provider.name}:{active_model}"

    async def _merge_with_conflict_resolution(
        self,
        run_id: str,
        source_branch: str,
        target_branch: str,
        commit_message: str,
        *,
        gate_commands: list[str] | None,
        scope_id: str,
    ) -> MergeResult:
        """Serialize integration merges and dispatch callbacks on the engine event loop."""
        async with self._merge_lock:
            policies = self.cfg.policies
            worktree_root = self._worktree_root()
            if not policies.auto_resolve_merge_conflicts:
                merge_branch_into(self.repo_path, source_branch, target_branch, commit_message, worktree_root)
                return {"merged": True, "conflicts": [], "resolved_by_ai": False}

            loop = asyncio.get_running_loop()
            attempts = 0

            async def resolve_conflict(merge_wt: Path, files: list[str], context: str) -> bool:
                nonlocal attempts
                attempts += 1
                if attempts == 1:
                    self.store.log_event(
                        run_id, "merge_conflict_detected", message=f"Merge conflict in {scope_id}",
                        payload={
                            "source_branch": source_branch,
                            "target_branch": target_branch,
                            "conflicted_files": files,
                        },
                    )
                role_name = self.cfg.resolve_role_name("conflict_resolver", "critical_executor", "micro_orchestrator")
                template = (self.package_root / "prompts" / "l2_conflict_resolver.md").read_text(encoding="utf-8")
                file_list = "\n".join(f"- `{file}`" for file in files)
                prompt = (
                    f"{template.strip()}\n\n"
                    f"## Merge `{source_branch}` into `{target_branch}`\n\n"
                    f"## Conflicted Files\n{file_list}\n\n"
                    f"## Conflict Context\n{context}"
                )
                run = self.store.get_run(run_id) or {}
                res, _ = await self._invoke_role(
                    run_id=run_id,
                    role_name=role_name,
                    prompt=prompt,
                    workdir=merge_wt,
                    artifact_key=f"merge_{scope_id}_resolve_{attempts}",
                    model_overrides=json.loads(run.get("model_overrides_json") or "{}"),
                )
                return res.status == "ok"

            def resolver(merge_wt: Path, files: list[str], context: str) -> bool:
                return asyncio.run_coroutine_threadsafe(resolve_conflict(merge_wt, files, context), loop).result()

            def gate_checker(merge_wt: Path) -> bool:
                gate = run_gate_suite(gate_commands or [], workdir=merge_wt)
                return asyncio.run_coroutine_threadsafe(gate, loop).result().passed

            merge = asyncio.create_task(asyncio.to_thread(
                merge_branch_with_resolver,
                self.repo_path, source_branch, target_branch, commit_message, worktree_root,
                resolver=resolver,
                gate_checker=gate_checker if gate_commands else None,
                max_attempts=policies.max_conflict_resolve_attempts,
                squash_merge=merge_branch_into,
            ))
            try:
                result = await asyncio.shield(merge)
            except MergeConflictError as exc:
                self.store.log_event(
                    run_id, "merge_conflict_failed", message=str(exc),
                    payload={"conflicted_files": exc.conflicted_files, "reason": exc.reason or str(exc)},
                )
                raise GitError(str(exc)) from exc
            finally:
                # A cancelled waiter must hold the lock until the Git thread finishes cleanup.
                if not merge.done():
                    await asyncio.gather(merge, return_exceptions=True)

            if result["resolved_by_ai"]:
                self.store.log_event(
                    run_id, "merge_conflict_resolved", message=f"Resolved merge conflict in {scope_id}",
                    payload={"conflicted_files": result["conflicts"], "attempts": attempts},
                )
            return result

    # ------------------------------------------------------------------
    # Top-level Run Lifecycle
    # ------------------------------------------------------------------

    async def execute_run(self, run_id: str) -> RunStatus:
        """Execute (or resume) a full pipeline run."""
        run = self.store.get_run(run_id)
        if not run or Path(run["repo_path"]).resolve() != self.repo_path:
            raise ValueError(f"Run '{run_id}' not found in this repository")
        if run["status"] in (RunStatus.COMPLETED, RunStatus.FAILED, RunStatus.SUPERSEDED):
            # Preserve the historical read-only result of re-executing a failed
            # legacy run. Explicit resume always rejects terminal runs.
            if run["status"] == RunStatus.FAILED and not run["start_sha"]:
                return RunStatus.FAILED
            raise RunTerminalError(run_id, run["status"])
        token = self.store.claim_run_execution(run_id)
        self._run_children[run_id] = set()
        try:
            return await self._execute_run_claimed(run_id)
        finally:
            children = self._run_children.pop(run_id, set())
            if children:
                await asyncio.gather(*children, return_exceptions=True)
            self.store.release_run_execution(run_id, token)

    async def _execute_run_claimed(self, run_id: str) -> RunStatus:
        run = self.store.get_run(run_id)

        try:
            if await self._stop_if_paused(run):
                return RunStatus.PAUSED
            if run["status"] == RunStatus.WAITING_HUMAN:
                return RunStatus.WAITING_HUMAN
            if self._attention_run_id == run_id:
                self._notified_episodes.difference_update(
                    {episode for episode in self._notified_episodes if episode[0] in ("waiting_human", "paused")}
                )

            cfg = self.cfg
            with suppress(Exception):
                pricing.trigger_background_pricing_sync(cfg.pricing)

            overrides: dict[str, str] = json.loads(run["model_overrides_json"] or "{}")
            snapshot = self.repo_path / ".baton" / "runs" / run_id / "00_RFC.md"
            # Once recorded, a missing snapshot must not fall back to mutable input.
            rfc_path = (Path(run["rfc_snapshot_path"]) if run["rfc_snapshot_path"]
                        else snapshot if snapshot.exists() else Path(run["rfc_path"]))
            if not rfc_path.exists():
                summary = f"RFC file missing: {rfc_path}"
                self.store.update_run_status(run_id, RunStatus.FAILED, summary=summary)
                await self._emit_attention(
                    run_id, "failed", "error", "RFC file missing", summary, "Restore the RFC file and rerun.",
                )
                return RunStatus.FAILED
            rfc_text = rfc_path.read_text(encoding="utf-8")

            with windows_wake_lock(cfg.daemon.prevent_sleep_windows):
                dev_branch = self.run_branch(run_id) if run["start_sha"] else cfg.daemon.dev_branch
                if run["start_sha"]:
                    # A deleted run branch must not be silently recreated at main.
                    resolve_ref_sha(self.repo_path, dev_branch)
                    resolve_ref_sha(self.repo_path, run["base_ref"])
                base_branch = ensure_git_ready(
                    self.repo_path,
                    base_branch=run["base_ref"] or cfg.daemon.base_branch,
                    dev_branch=dev_branch,
                )
                # Snapshot the base head before any dev change so the final gate can roll back.
                try:
                    create_backup_tag(self.repo_path, run_id, base_branch)
                except GitError as exc:
                    self.store.log_event(run_id, "backup_tag_failed", message=str(exc))

                # Stage 0: Specialist panel (panel mode only); its master spec feeds the planner.
                plan_input = rfc_text
                if run["mode"] == "panel":
                    if await self._stop_if_paused(self.store.get_run(run_id)):
                        return RunStatus.PAUSED
                    master_spec_text = await self._ensure_panel_spec(run_id, rfc_text)
                    plan_input = f"{rfc_text}\n\n# Panel Master Spec\n\n{master_spec_text}"

                # Stage 1: Planning (or load pre-supplied / already-registered plan)
                if await self._stop_if_paused(self.store.get_run(run_id)):
                    return RunStatus.PAUSED
                plan = await self._ensure_plan(run_id, run, plan_input, overrides)
                current_run = self.store.get_run(run_id)
                if await self._stop_if_paused(current_run):
                    return RunStatus.PAUSED
                if plan is None:
                    return RunStatus(current_run["status"])

                # The engine tracks quota cooldowns, which _invoke_role handles at dispatch.
                catalog = build_model_catalog(self.cfg, None)
                self.store.update_run_status(run_id, RunStatus.RUNNING)

                # Stage 2: Milestones
                for milestone in plan.milestones:
                    m_rows = {m["id"]: m for m in self.store.get_milestones(run_id)}
                    m_row = m_rows[milestone.id]
                    if m_row["status"] == TaskStatus.PASSED.value:
                        continue

                    m_branch = m_row["branch_name"]
                    ensure_branch(self.repo_path, m_branch, dev_branch)
                    self.store.update_milestone(run_id, milestone.id, TaskStatus.RUNNING)

                    ok = await self._execute_milestone(
                        run_id=run_id,
                        milestone=milestone,
                        milestone_branch=m_branch,
                        dev_branch=dev_branch,
                        rfc_text=rfc_text,
                        overrides=overrides,
                        catalog=catalog,
                    )
                    current_run = self.store.get_run(run_id)
                    if await self._stop_if_paused(current_run):
                        return RunStatus.PAUSED
                    if not ok:
                        current = RunStatus(current_run["status"])
                        if current in (RunStatus.WAITING_HUMAN, RunStatus.FAILED):
                            return current
                        summary = f"Milestone {milestone.id} failed."
                        self.store.update_run_status(run_id, RunStatus.FAILED, summary=summary)
                        await self._emit_attention(
                            run_id, "failed", "error", "Milestone failed", summary,
                            "Inspect the milestone and its tasks in Studio.", milestone_id=milestone.id,
                        )
                        return RunStatus.FAILED

                # Stage 3: Ready for L0 Final Gate
                if await self._stop_if_paused(self.store.get_run(run_id)):
                    return RunStatus.PAUSED
                summary = (
                    f"All {len(plan.milestones)} milestone(s) passed mechanical gates and AI reviews "
                    f"and are merged into '{dev_branch}'. Ready for L0 final gate review before merging to '{base_branch}'."
                )
                try:
                    result_sha = resolve_ref_sha(self.repo_path, dev_branch)
                except GitError:
                    # Legacy callers can supply a fully mocked Git backend in
                    # a non-repository directory. Real repos and all lineage
                    # runs must resolve a result commit before becoming ready.
                    probe = subprocess.run(
                        ["git", "rev-parse", "--is-inside-work-tree"], cwd=self.repo_path,
                        capture_output=True, text=True, encoding="utf-8", errors="replace", check=False,
                    )
                    if run["start_sha"] or probe.returncode == 0 or "not a git repository" not in probe.stderr.lower():
                        raise
                    result_sha = None
                if not self.store.mark_run_ready(run_id, result_sha, summary):
                    return RunStatus(self.store.get_run(run_id)["status"])
                self.store.log_event(run_id, "ready_for_final_gate", message=summary)
                await self._emit_attention(
                    run_id, "ready_for_final_gate", "info", "Ready for final gate", summary,
                    "Open the battle report and review the L0 final gate.",
                )
                return RunStatus.READY_FOR_FINAL_GATE

        except Exception as exc:
            current = self.store.get_run(run_id)
            if current and current["status"] == RunStatus.PAUSED and self.store.is_stop_requested(run_id):
                return RunStatus.PAUSED
            self.store.log_event(run_id, "run_exception", message=str(exc))
            summary = f"Unhandled error: {exc}"
            self.store.update_run_status(run_id, RunStatus.FAILED, summary=summary)
            current = self.store.get_run(run_id)
            if current and current["status"] == RunStatus.PAUSED and self.store.is_stop_requested(run_id):
                return RunStatus.PAUSED
            await self._emit_attention(
                run_id, "failed", "error", "Run failed", summary, "Inspect the run events in Studio.",
            )
            return RunStatus.FAILED

    async def _ensure_panel_spec(self, run_id: str, rfc_text: str) -> str:
        """Run 00_PANEL once and return the master spec; on resume reuse the saved one.

        PanelPhaseError propagates so execute_run fails the run through its normal path.
        """
        run_dir = self._runtime_dir(run_id)
        master_spec = run_dir / "panel" / "master_spec.md"
        if master_spec.exists():
            return master_spec.read_text(encoding="utf-8")

        cfg = self.cfg
        settings = cfg.panel if cfg.panel.members else build_default_panel_settings(cfg)
        self.store.update_run_status(run_id, RunStatus.PLANNING)
        started = time.monotonic()
        result = await run_panel_phase(
            cfg=cfg,
            settings=settings,
            store=self.store,
            run_id=run_id,
            repo_path=self.repo_path,
            rfc_text=rfc_text,
            invoke_provider=lambda **kwargs: self._invoke_panel_provider(run_id, **kwargs),
            run_dir=run_dir,
        )
        self.store.log_event(
            run_id, "stage_completed", actor="panel", message=f"Stage {STAGE_PANEL} completed",
            payload={"stage": STAGE_PANEL, "wall_sec": round(time.monotonic() - started, 3)},
        )
        return result.master_spec_text

    async def _invoke_panel_provider(
        self,
        run_id: str,
        *,
        provider: str,
        model: str,
        prompt: str,
        artifact_key: str,
        fallback: list[FallbackTarget],
        cwd: Path,
    ) -> CLIResult:
        """panel.InvokeProvider adapter: cooldown waits, concurrency slots and fallback walking."""
        cfg = self.cfg
        rt_dir = self._runtime_dir(run_id)
        targets = [(provider, model)] + [(fb.provider, fb.model) for fb in fallback]
        res: CLIResult | None = None
        for name, target_model in targets:
            if name not in cfg.providers:
                continue
            active = cfg.providers[name]
            cooldown = self.store.get_provider_cooldown(name)
            if cooldown > 0:
                await asyncio.sleep(cooldown)
            transport_model, effort = target_model, None
            if active.type == "http":
                transport_model, _, effort_suffix = target_model.partition("@")
                effort = effort_suffix or None
            async with self._get_semaphore(active):
                res = await invoke_provider(
                    active,
                    model=transport_model,
                    effort=effort,
                    prompt=prompt,
                    cwd=cwd,
                    prompt_file=rt_dir / "prompts" / f"{artifact_key}.md",
                    output_file=rt_dir / "out" / f"{artifact_key}.json",
                    credentials_path=self.credentials_path,
                    cli_executor=run_provider_cli,
                    pricing_settings=cfg.pricing,
                    default_stall_timeout=cfg.daemon.default_stall_timeout_sec,
                    default_hard_timeout=cfg.daemon.default_hard_timeout_sec,
                    extra_env={"VIBEBATON_RUN_ID": run_id, "VIBEBATON_ROLE": artifact_key},
                )
            if res.status == "rate_limited":
                self.store.trigger_provider_cooldown(
                    name,
                    backoff_schedule=active.cooldown_backoff_sec,
                    reason=(res.stderr or res.stdout)[:240],
                    explicit_wait_sec=res.retry_after_sec,
                )
                continue
            if res.status == "ok":
                self.store.reset_provider_backoff(name)
            return res
        if res is None:
            raise RuntimeError(f"No configured provider for panel call {artifact_key} ({provider}/{model})")
        return res

    async def _ensure_plan(
        self,
        run_id: str,
        run: dict[str, Any],
        rfc_text: str,
        overrides: dict[str, str],
    ) -> PlanDAG | None:
        # Resume from existing plan_path if present
        plan_path_str = run.get("plan_path")
        if plan_path_str and Path(plan_path_str).exists():
            raw = json.loads(Path(plan_path_str).read_text(encoding="utf-8"))
            plan = PlanDAG.from_dict(raw)
            if not self.store.get_milestones(run_id):
                self.store.register_plan(run_id, plan)
            return plan

        self.store.update_run_status(run_id, RunStatus.PLANNING)
        plan_out = self._runtime_dir(run_id) / "01_PLAN.dag.json"

        prompt = (
            "Convert the following Master RFC into a strict executable PlanDAG JSON.\n"
            "Write ONLY valid JSON (or save it to VIBEBATON_OUTPUT_FILE) matching keys:\n"
            "`rfc_version`, `complexity_tier`, `summary`, `milestones[{id, title, reviewer_role, gate_commands, tasks[{id, title, description, tier, assignee_role, reviewer_role, depends_on, allowed_paths, golden_example, acceptance_criteria, verify_cmd}]}]`.\n\n"
            f"# Master RFC\n\n{rfc_text}"
        )

        last_err = ""
        for attempt in range(1, 3):
            attempt_prompt = prompt if not last_err else (
                f"{prompt}\n\n## Previous JSON Schema Error (Fix strictly)\n{last_err}"
            )
            res, actor = await self._invoke_role(
                run_id=run_id,
                role_name="tactical_planner",
                prompt=attempt_prompt,
                workdir=self.repo_path,
                artifact_key=f"plan_attempt_{attempt}",
                model_overrides=overrides,
            )
            if res.status != "ok":
                last_err = f"Planner CLI failed ({res.status}): {res.stderr or res.stdout}"
            else:
                try:
                    parsed = extract_json_object(res.text)
                    plan = PlanDAG.from_dict(parsed)
                    plan_out.write_text(json.dumps(plan.to_dict(), indent=2, ensure_ascii=False), encoding="utf-8")
                    current = self.store.get_run(run_id)["status"]
                    status = RunStatus.PAUSED if current == RunStatus.PAUSED else RunStatus.RUNNING
                    self.store.update_run_status(run_id, status, plan_path=str(plan_out))
                    self.store.register_plan(run_id, plan)
                    self.store.log_event(run_id, "plan_generated", actor=actor, message=f"Plan saved to {plan_out}")
                    return plan
                except SchemaValidationError as exc:
                    last_err = str(exc)
                    self.store.log_event(run_id, "plan_schema_error", actor=actor, message=last_err)

            if self.store.get_run(run_id)["status"] == RunStatus.PAUSED:
                return None

        summary = f"Planning failed: {last_err}"
        self.store.update_run_status(run_id, RunStatus.FAILED, summary=summary)
        await self._emit_attention(
            run_id, "failed", "error", "Planning failed", summary, "Inspect the planner output and the RFC.",
        )
        return None

    async def _execute_milestone(
        self,
        *,
        run_id: str,
        milestone: Any,
        milestone_branch: str,
        dev_branch: str,
        rfc_text: str,
        overrides: dict[str, str],
        catalog: list[ModelCapability],
    ) -> bool:
        tasks_by_id: dict[str, TaskSpec] = {t.id: t for t in milestone.tasks}
        in_flight: dict[str, asyncio.Task[bool]] = {}

        while True:
            # Check for external pause
            if await self._stop_if_paused(self.store.get_run(run_id), in_flight.values()):
                return False

            db_tasks = {r["id"]: r for r in self.store.get_tasks(run_id, milestone_id=milestone.id)}
            done_ids = {tid for tid, r in db_tasks.items() if r["status"] == TaskStatus.PASSED.value}
            failed_ids = {tid for tid, r in db_tasks.items() if r["status"] == TaskStatus.FAILED.value}
            waiting_ids = {tid for tid, r in db_tasks.items() if r["status"] == TaskStatus.WAITING_HUMAN.value}

            if failed_ids:
                if in_flight:
                    await asyncio.gather(*in_flight.values(), return_exceptions=True)
                self.store.update_milestone(run_id, milestone.id, TaskStatus.FAILED)
                return False

            if waiting_ids and not in_flight:
                task_ids = sorted(waiting_ids)
                human_prompt = f"Task(s) {task_ids} in milestone {milestone.id} require human decision."
                reasons = [f"{tid}: {db_tasks[tid]['last_error']}" for tid in task_ids if db_tasks[tid]["last_error"]]
                if reasons:
                    human_prompt += "\n" + "\n".join(reasons)
                await self._request_human_decision(run_id, milestone.id, human_prompt, task_ids=task_ids)
                return False

            if len(done_ids) == len(tasks_by_id):
                break

            # Schedule all ready tasks whose dependencies are satisfied
            for tid, spec in tasks_by_id.items():
                if tid in done_ids or tid in in_flight or tid in waiting_ids:
                    continue
                if all(dep in done_ids or dep not in tasks_by_id for dep in spec.depends_on):
                    if not self.store.try_dispatch_task(run_id, tid):
                        break
                    task = asyncio.create_task(
                        self._execute_task(
                            run_id=run_id,
                            milestone_id=milestone.id,
                            spec=spec,
                            milestone_branch=milestone_branch,
                            overrides=overrides,
                            catalog=catalog,
                        )
                    )
                    in_flight[tid] = task
                    children = self._run_children.get(run_id)
                    if children is not None:
                        children.add(task)
                        task.add_done_callback(children.discard)

            if not in_flight:
                if await self._stop_if_paused(self.store.get_run(run_id)):
                    return False
                message = "No runnable tasks remaining before milestone completion."
                self.store.log_event(
                    run_id,
                    "dag_deadlock",
                    milestone_id=milestone.id,
                    message=message,
                )
                self.store.update_milestone(run_id, milestone.id, TaskStatus.FAILED)
                summary = f"Milestone {milestone.id}: {message}"
                self.store.update_run_status(run_id, RunStatus.FAILED, summary=summary)
                await self._emit_attention(
                    run_id, "failed", "error", "Milestone DAG deadlock", summary,
                    "Inspect task dependencies in the plan.", milestone_id=milestone.id,
                )
                return False

            done_futures, _ = await asyncio.wait(
                in_flight.values(), timeout=0.1, return_when=asyncio.FIRST_COMPLETED,
            )
            completed_keys = [k for k, fut in in_flight.items() if fut in done_futures]
            for k in completed_keys:
                fut = in_flight.pop(k)
                fut.result()

        # Milestone Mechanical Gate
        gate_ok = await self._run_milestone_gate_and_review(
            run_id=run_id,
            milestone=milestone,
            milestone_branch=milestone_branch,
            dev_branch=dev_branch,
            rfc_text=rfc_text,
            overrides=overrides,
        )
        return gate_ok

    @staticmethod
    def _resolve_task_worker_model(
        task: TaskSpec,
        cfg: BatonConfig,
        catalog: list[ModelCapability],
        role_name: str,
        overrides: dict[str, str],
        step_up_target: tuple[str, str] | None,
    ) -> tuple[str, str, str, bool]:
        """Resolve a worker target and indicate whether it honors the planner's pin."""
        if role_name in overrides:
            role, _ = cfg.resolve_role(role_name, model_overrides=overrides)
            return role.provider, role.model, f"Applied explicit model override for {role_name}.", False
        if step_up_target is not None and step_up_target[0] in cfg.providers:
            provider, model = step_up_target
            return provider, model, "Stepped up after reaching the task retry limit.", False

        pin = None
        if task.pinned and task.assigned_model:
            pin = parse_model_spec(task.assigned_model, cfg.roles[task.assignee_role].provider, cfg.providers)
        if role_name != task.assignee_role:
            # Reallocate for the specialist role while retaining the original provider of a pin.
            task = replace(
                task, assignee_role=role_name, tier=TaskTier.CRITICAL,
                assigned_model=":".join(pin) if pin else None,
            )

        role = cfg.roles[role_name]
        if (
            catalog and not task.assigned_model and role.provider in cfg.providers and role.model.strip()
            and all((cap.provider, cap.model) != (role.provider, role.model) for cap in catalog)
        ):
            # A model added by hot reload can become the role default before the next catalog is built.
            return role.provider, role.model, "Using the hot-reloaded role default.", False

        provider, model, reason = resolve_task_allocation(task, cfg, catalog, cfg.policies.budget_profile)
        return provider, model, reason, (provider, model) == pin

    async def _execute_task(
        self,
        *,
        run_id: str,
        milestone_id: str,
        spec: TaskSpec,
        milestone_branch: str,
        overrides: dict[str, str],
        catalog: list[ModelCapability],
    ) -> bool:
        start_time = time.monotonic()
        branch_name = f"baton/{run_id[-6:]}/{spec.id.lower()}"
        worktree_dir = self._worktree_root() / run_id[-6:] / spec.id.lower()

        max_self_heal = (
            spec.max_self_heal
            if spec.max_self_heal is not None
            else self.cfg.policies.max_self_heal_attempts
        )
        max_rejects = (
            spec.max_review_rejects
            if spec.max_review_rejects is not None
            else self.cfg.policies.max_review_rejects
        )

        current_role = spec.assignee_role
        self_heal_count = 0
        review_reject_count = 0
        escalated = False
        feedback_context = ""
        planned_task = replace(spec)
        step_up_target: tuple[str, str] | None = None
        tried_targets: set[tuple[str, str]] = set()

        def schedule_step_up(feedback: str) -> bool:
            nonlocal step_up_target, feedback_context
            if pin_honored or current_role in overrides:
                return False
            for rung in count(1):
                target = compute_step_up_target(*worker_target, cfg, catalog, attempt=rung)
                if target is None:
                    return False
                if target not in tried_targets:
                    break

            step_up_target = target
            feedback_context = feedback
            from_model, to_model = ":".join(worker_target), ":".join(target)
            self.store.log_event(
                run_id, "task_step_up", task_id=spec.id, milestone_id=milestone_id,
                message=f"Stepping up from {from_model} to {to_model}",
                payload={"task_id": spec.id, "from": from_model, "to": to_model, "attempt": attempt + 1},
            )
            return True

        # Create isolated worktree from the latest milestone branch (synchronized under merge_lock)
        async with self._merge_lock:
            create_worktree(self.repo_path, worktree_dir, branch_name, start_point=milestone_branch)

        self.store.update_task(
            run_id,
            spec.id,
            status=TaskStatus.RUNNING,
            current_role=current_role,
            worktree_path=str(worktree_dir),
            branch_name=branch_name,
        )

        try:
            attempt = 0
            while True:
                attempt += 1
                task_prompt = self._build_task_prompt(spec, worktree_dir, feedback_context)
                cfg = self.cfg
                provider, model, reason, pin_honored = self._resolve_task_worker_model(
                    planned_task, cfg, catalog, current_role, overrides, step_up_target,
                )
                worker_target = provider, model
                tried_targets.add(worker_target)
                spec.assigned_model = ":".join(worker_target)
                spec.allocation_reason = reason
                self.store.update_task(
                    run_id,
                    spec.id,
                    status=TaskStatus.RUNNING,
                    attempts=attempt,
                    current_role=current_role,
                    self_heal_count=self_heal_count,
                    review_reject_count=review_reject_count,
                    escalated=1 if escalated else 0,
                    spec_json=json.dumps(spec.to_dict(), ensure_ascii=False),
                )
                self.store.log_event(
                    run_id, "task_allocated", task_id=spec.id, milestone_id=milestone_id,
                    message=f"Allocated {spec.id} to {spec.assigned_model}",
                    payload={
                        "task_id": spec.id, "provider": provider, "model": model, "reason": reason,
                        "budget_profile": cfg.policies.budget_profile, "pinned": spec.pinned,
                    },
                )
                role = cfg.roles[current_role]
                dispatch_overrides = overrides
                if current_role not in overrides and worker_target != (role.provider, role.model):
                    dispatch_overrides = {**overrides, current_role: spec.assigned_model}
                res, actor = await self._invoke_role(
                    run_id=run_id,
                    role_name=current_role,
                    prompt=task_prompt,
                    workdir=worktree_dir,
                    artifact_key=f"{spec.id}_exec_{attempt}",
                    model_overrides=dispatch_overrides,
                    task_id=spec.id,
                    milestone_id=milestone_id,
                )
                # A quota fallback may have actually executed this attempt on another model.
                actual_provider, _, actual_model = actor.partition(":")
                if actual_provider in cfg.providers and actual_model:
                    worker_target = actual_provider, actual_model
                    tried_targets.add(worker_target)

                if res.status != "ok":
                    err_msg = f"CLI execution failed ({res.status}): {(res.stderr or res.stdout)[:500]}"
                    self.store.update_task(run_id, spec.id, last_error=err_msg)
                    self.store.log_event(run_id, "task_exec_error", actor=actor, task_id=spec.id, message=err_msg)
                    if not escalated and current_role != spec.escalate_role:
                        escalated = True
                        current_role = spec.escalate_role
                        step_up_target = None
                        feedback_context = f"Previous worker failed to run cleanly:\n{err_msg}"
                        self.store.log_event(
                            run_id, "task_escalated", task_id=spec.id, message=f"Escalated to {current_role}"
                        )
                        continue
                    self.store.update_task(
                        run_id, spec.id, status=TaskStatus.FAILED, duration_sec=time.monotonic() - start_time
                    )
                    return False

                # 1. Path Whitelist Physical Guard
                wl = check_path_whitelist(worktree_dir, spec.allowed_paths, base_ref=milestone_branch)
                if not wl.ok:
                    revert_disallowed_files(worktree_dir, wl.violations, base_ref=milestone_branch)
                    msg = (
                        f"Path whitelist violation! Modified forbidden file(s): {wl.violations}. "
                        f"Allowed patterns: {spec.allowed_paths}. Forbidden files were reverted."
                    )
                    self.store.log_event(run_id, "whitelist_violation", task_id=spec.id, message=msg)
                    if self_heal_count < max_self_heal:
                        self_heal_count += 1
                        feedback_context = msg
                        continue
                    if schedule_step_up(msg):
                        continue
                    if not escalated and current_role != spec.escalate_role:
                        escalated = True
                        current_role = spec.escalate_role
                        step_up_target = None
                        feedback_context = msg
                        self.store.log_event(
                            run_id, "task_escalated", task_id=spec.id, message=f"Escalated to {current_role} after whitelist violations"
                        )
                        continue
                    self.store.update_task(
                        run_id,
                        spec.id,
                        status=TaskStatus.FAILED,
                        last_error=msg,
                        duration_sec=time.monotonic() - start_time,
                    )
                    return False
                self.store.log_event(
                    run_id,
                    "task_changes",
                    task_id=spec.id,
                    milestone_id=milestone_id,
                    message=f"{len(wl.changed_files)} file(s) changed on attempt {attempt}",
                    payload={"changed_files": wl.changed_files},
                )

                # 2. Deterministic Mechanical Gate (Machine-First, LLM-Second)
                if self.cfg.policies.machine_gate_before_ai_review and spec.verify_cmd:
                    self.store.update_task(run_id, spec.id, status=TaskStatus.GATE_CHECKING)
                    gate_res = await run_gate_suite([spec.verify_cmd], workdir=worktree_dir)
                    if not gate_res.passed:
                        gate_text = gate_res.summary_text()
                        self.store.log_event(
                            run_id,
                            "mechanical_gate_caught",
                            task_id=spec.id,
                            milestone_id=milestone_id,
                            message=f"Mechanical gate failed on attempt {attempt}",
                            payload={"command": spec.verify_cmd},
                        )
                        gate_feedback = (
                            "Mechanical verification gate FAILED. Fix the error directly without touching forbidden files:\n\n"
                            + gate_text
                        )
                        if self_heal_count < max_self_heal:
                            self_heal_count += 1
                            feedback_context = gate_feedback
                            continue
                        if schedule_step_up(gate_feedback):
                            continue
                        if not escalated and current_role != spec.escalate_role:
                            escalated = True
                            current_role = spec.escalate_role
                            step_up_target = None
                            self_heal_count = 0
                            feedback_context = (
                                f"Worker exhausted self-heal attempts. Escalating to {current_role}.\n\n{gate_text}"
                            )
                            self.store.log_event(
                                run_id,
                                "task_escalated",
                                task_id=spec.id,
                                milestone_id=milestone_id,
                                message=f"Circuit breaker escalated {spec.id} to {current_role} after gate failures",
                            )
                            continue
                        self.store.update_task(
                            run_id,
                            spec.id,
                            status=TaskStatus.FAILED,
                            last_error=gate_text[:1000],
                            duration_sec=time.monotonic() - start_time,
                        )
                        return False

                # Commit worktree changes before AI review / merge
                commit_worktree_changes(worktree_dir, f"baton({spec.id}): {spec.title}")

                # 3. Micro-Review (e.g. Codex Astra reviewing DSH output)
                if spec.reviewer_role and not escalated:
                    self.store.update_task(run_id, spec.id, status=TaskStatus.REVIEWING)
                    diff_text = get_diff_against(worktree_dir, base_ref=milestone_branch)
                    verdict = await self._run_review(
                        run_id=run_id,
                        reviewer_role=spec.reviewer_role,
                        target_id=spec.id,
                        context_title=f"Task {spec.id}: {spec.title}",
                        acceptance_criteria=spec.acceptance_criteria,
                        diff_text=diff_text,
                        workdir=worktree_dir,
                        artifact_key=f"{spec.id}_review_{attempt}",
                        overrides=overrides,
                        task_id=spec.id,
                        milestone_id=milestone_id,
                    )
                    self.store.update_task(run_id, spec.id, last_review_json=verdict.to_dict())

                    if verdict.verdict == VerdictKind.PASS:
                        self.store.log_event(
                            run_id,
                            "task_review_passed",
                            actor=verdict.reviewer,
                            task_id=spec.id,
                            milestone_id=milestone_id,
                            message=verdict.summary or "PASS",
                        )
                    elif verdict.verdict == VerdictKind.PLAN_AMENDMENT:
                        self.store.update_task(
                            run_id,
                            spec.id,
                            status=TaskStatus.WAITING_HUMAN,
                            last_error=verdict.escalate_reason or verdict.summary,
                            duration_sec=time.monotonic() - start_time,
                        )
                        self.store.log_event(
                            run_id,
                            "plan_amendment_requested",
                            actor=verdict.reviewer,
                            task_id=spec.id,
                            milestone_id=milestone_id,
                            message=verdict.escalate_reason or verdict.summary,
                        )
                        return False
                    elif verdict.verdict == VerdictKind.MAJOR_REWORK:
                        if current_role != spec.escalate_role:
                            escalated = True
                            current_role = spec.escalate_role
                            step_up_target = None
                            feedback_context = (
                                "Reviewer requested MAJOR_REWORK and escalated this task:\n"
                                + json.dumps(verdict.to_dict(), indent=2, ensure_ascii=False)
                            )
                            self.store.log_event(
                                run_id,
                                "task_escalated",
                                actor=verdict.reviewer,
                                task_id=spec.id,
                                milestone_id=milestone_id,
                                message=f"MAJOR_REWORK escalated {spec.id} to {current_role}",
                            )
                            continue
                        self.store.update_task(
                            run_id,
                            spec.id,
                            status=TaskStatus.FAILED,
                            last_error=verdict.summary,
                            duration_sec=time.monotonic() - start_time,
                        )
                        return False
                    else:  # MINOR_FIX
                        review_reject_count += 1
                        self.store.log_event(
                            run_id,
                            "task_review_rejected",
                            actor=verdict.reviewer,
                            task_id=spec.id,
                            milestone_id=milestone_id,
                            message=f"MINOR_FIX (#{review_reject_count}): {verdict.summary}",
                        )
                        review_json = json.dumps(verdict.to_dict(), indent=2, ensure_ascii=False)
                        review_feedback = (
                            "Reviewer requested MINOR_FIX. Address every blocking_issue:\n"
                            + review_json
                        )
                        if review_reject_count <= max_rejects:
                            feedback_context = review_feedback
                            continue
                        if schedule_step_up(review_feedback):
                            continue
                        # Circuit breaker -> escalate to specialist
                        if current_role != spec.escalate_role:
                            escalated = True
                            current_role = spec.escalate_role
                            step_up_target = None
                            feedback_context = (
                                f"Worker exceeded max review rejections ({max_rejects}). "
                                "Circuit breaker escalated this task. Fix all issues cleanly:\n"
                                + review_json
                            )
                            self.store.log_event(
                                run_id,
                                "task_escalated",
                                task_id=spec.id,
                                milestone_id=milestone_id,
                                message=f"Circuit breaker escalated {spec.id} to {current_role} after {review_reject_count} rejections",
                            )
                            continue
                        self.store.update_task(
                            run_id,
                            spec.id,
                            status=TaskStatus.FAILED,
                            last_error=verdict.summary,
                            duration_sec=time.monotonic() - start_time,
                        )
                        return False

                # 4. Merge verified branch into milestone branch
                await self._merge_with_conflict_resolution(
                    run_id=run_id,
                    source_branch=branch_name,
                    target_branch=milestone_branch,
                    commit_message=f"feat({spec.id}): {spec.title}",
                    gate_commands=[spec.verify_cmd] if spec.verify_cmd else None,
                    scope_id=f"task_{spec.id}",
                )

                self.store.update_task(
                    run_id,
                    spec.id,
                    status=TaskStatus.PASSED,
                    self_heal_count=self_heal_count,
                    review_reject_count=review_reject_count,
                    escalated=1 if escalated else 0,
                    duration_sec=time.monotonic() - start_time,
                )
                self.store.log_event(
                    run_id,
                    "task_passed",
                    actor=current_role,
                    task_id=spec.id,
                    milestone_id=milestone_id,
                    message=f"Task {spec.id} merged into {milestone_branch}",
                    payload={"escalated": escalated, "self_heals": self_heal_count, "rejects": review_reject_count},
                )
                return True

        except GitError as exc:
            conflict = isinstance(exc, MergeConflictError) or isinstance(exc.__cause__, MergeConflictError)
            status = TaskStatus.WAITING_HUMAN if conflict else TaskStatus.FAILED
            self.store.update_task(
                run_id,
                spec.id,
                status=status,
                last_error=str(exc),
                duration_sec=time.monotonic() - start_time,
            )
            self.store.log_event(run_id, "git_error", task_id=spec.id, message=str(exc))
            return False
        finally:
            remove_worktree(self.repo_path, worktree_dir, branch_name=branch_name)

    async def _run_milestone_gate_and_review(
        self,
        *,
        run_id: str,
        milestone: Any,
        milestone_branch: str,
        dev_branch: str,
        rfc_text: str,
        overrides: dict[str, str],
    ) -> bool:
        max_milestone_fixes = max(1, self.cfg.policies.max_review_rejects)
        pending_fix_feedback: str | None = None

        m_rows = {m["id"]: m for m in self.store.get_milestones(run_id)}
        existing_rev_raw = m_rows.get(milestone.id, {}).get("review_json")
        if existing_rev_raw:
            try:
                existing_rev = json.loads(existing_rev_raw)
                if isinstance(existing_rev, dict) and existing_rev.get("verdict") in ("MINOR_FIX", "MAJOR_REWORK"):
                    pending_fix_feedback = json.dumps(existing_rev, indent=2, ensure_ascii=False)
            except (ValueError, TypeError):
                pass

        for fix_round in range(max_milestone_fixes + 1):
            fix_branch = f"baton/{run_id[-6:]}/ms-{milestone.id.lower()}-r{fix_round}"
            review_wt = self._worktree_root() / run_id[-6:] / f"_ms_{milestone.id.lower()}_r{fix_round}"
            create_worktree(self.repo_path, review_wt, fix_branch, milestone_branch)
            try:
                if pending_fix_feedback:
                    gates_hint = "\n".join(f"- `{cmd}`" for cmd in (milestone.gate_commands or [])) or "- None"
                    fix_prompt = (
                        f"# Milestone Remediation: {milestone.id} — {milestone.title}\n\n"
                        "The milestone reviewer or mechanical gate found blocking issues on this milestone branch.\n"
                        "Fix EVERY blocking issue directly in this worktree, add regression tests for each fix, "
                        "and ensure all mechanical gates pass cleanly.\n\n"
                        f"## Blocking Feedback\n{pending_fix_feedback}\n\n"
                        f"## Milestone Gate Commands\n{gates_hint}\n"
                    )
                    fix_res, fix_actor = await self._invoke_role(
                        run_id=run_id,
                        role_name="critical_executor",
                        prompt=fix_prompt,
                        workdir=review_wt,
                        artifact_key=f"milestone_{milestone.id}_fix_r{fix_round}",
                        model_overrides=overrides,
                        milestone_id=milestone.id,
                    )
                    if fix_res.status != "ok":
                        err_msg = f"Milestone remediation CLI failed ({fix_res.status}): {(fix_res.stderr or fix_res.stdout)[:500]}"
                        self.store.log_event(
                            run_id,
                            "milestone_fix_error",
                            actor=fix_actor,
                            milestone_id=milestone.id,
                            message=err_msg,
                        )
                        self.store.update_milestone(run_id, milestone.id, TaskStatus.FAILED)
                        return False

                    commit_worktree_changes(
                        review_wt,
                        f"fix({milestone.id}): address milestone review blocking issues (round {fix_round})",
                    )
                    await self._merge_with_conflict_resolution(
                        run_id=run_id,
                        source_branch=fix_branch,
                        target_branch=milestone_branch,
                        commit_message=f"fix({milestone.id}): address milestone review blocking issues (round {fix_round})",
                        gate_commands=milestone.gate_commands,
                        scope_id=f"milestone_{milestone.id}_fix_r{fix_round}",
                    )
                    self.store.log_event(
                        run_id,
                        "milestone_fix_applied",
                        actor=fix_actor,
                        milestone_id=milestone.id,
                        message=f"Applied remediation round {fix_round} onto {milestone_branch}",
                    )
                    pending_fix_feedback = None

                gate_report = "No milestone gate commands configured."
                if milestone.gate_commands:
                    gate_res = await run_gate_suite(milestone.gate_commands, workdir=review_wt)
                    gate_report = gate_res.summary_text()
                    if not gate_res.passed:
                        self.store.log_event(
                            run_id,
                            "milestone_gate_failed",
                            milestone_id=milestone.id,
                            message=gate_report[:500],
                        )
                        if fix_round < max_milestone_fixes:
                            pending_fix_feedback = f"Milestone mechanical gate FAILED:\n{gate_report}"
                            continue
                        self.store.update_milestone(run_id, milestone.id, TaskStatus.FAILED)
                        return False

                diff_text = get_diff_against(self.repo_path, base_ref=dev_branch, head_ref=milestone_branch)
                verdict = await self._run_review(
                    run_id=run_id,
                    reviewer_role=milestone.reviewer_role,
                    target_id=milestone.id,
                    context_title=f"Milestone {milestone.id}: {milestone.title}",
                    acceptance_criteria=[
                        "Matches Master RFC architecture and boundaries",
                        "All milestone mechanical gates passed",
                        f"Gate summary:\n{gate_report}",
                        f"Master RFC excerpt:\n{rfc_text[:3000]}",
                    ],
                    diff_text=diff_text,
                    workdir=review_wt,
                    artifact_key=f"milestone_{milestone.id}_review_r{fix_round}",
                    overrides=overrides,
                    milestone_id=milestone.id,
                )

                if await self._stop_if_paused(self.store.get_run(run_id)):
                    return False
                if verdict.verdict == VerdictKind.PASS:
                    await self._merge_with_conflict_resolution(
                        run_id=run_id,
                        source_branch=milestone_branch,
                        target_branch=dev_branch,
                        commit_message=f"milestone({milestone.id}): {milestone.title}",
                        gate_commands=milestone.gate_commands,
                        scope_id=f"milestone_{milestone.id}",
                    )
                    self.store.update_milestone(run_id, milestone.id, TaskStatus.PASSED, review_json=verdict.to_dict())
                    self.store.log_event(
                        run_id,
                        "milestone_passed",
                        actor=verdict.reviewer,
                        milestone_id=milestone.id,
                        message=f"Milestone {milestone.id} merged into {dev_branch}",
                    )
                    return True

                if verdict.verdict == VerdictKind.PLAN_AMENDMENT:
                    self.store.update_milestone(run_id, milestone.id, TaskStatus.WAITING_HUMAN, review_json=verdict.to_dict())
                    human_prompt = f"Milestone {milestone.id} reviewer requested PLAN_AMENDMENT: {verdict.summary}"
                    await self._request_human_decision(run_id, milestone.id, human_prompt)
                    return False

                self.store.update_milestone(run_id, milestone.id, TaskStatus.FAILED, review_json=verdict.to_dict())
                self.store.log_event(
                    run_id,
                    "milestone_rejected",
                    actor=verdict.reviewer,
                    milestone_id=milestone.id,
                    message=verdict.summary,
                )
                if fix_round < max_milestone_fixes:
                    pending_fix_feedback = json.dumps(verdict.to_dict(), indent=2, ensure_ascii=False)
                    continue
                return False
            except GitError as exc:
                if not (isinstance(exc, MergeConflictError) or isinstance(exc.__cause__, MergeConflictError)):
                    raise
                if await self._stop_if_paused(self.store.get_run(run_id)):
                    return False
                self.store.update_milestone(run_id, milestone.id, TaskStatus.WAITING_HUMAN)
                await self._request_human_decision(run_id, milestone.id, str(exc))
                return False
            finally:
                remove_worktree(self.repo_path, review_wt, branch_name=fix_branch)
        return False

    async def _run_review(
        self,
        *,
        run_id: str,
        reviewer_role: str,
        target_id: str,
        context_title: str,
        acceptance_criteria: list[str],
        diff_text: str,
        workdir: Path,
        artifact_key: str,
        overrides: dict[str, str],
        task_id: str | None = None,
        milestone_id: str | None = None,
    ) -> ReviewVerdict:
        criteria_md = "\n".join(f"- {c}" for c in acceptance_criteria) or "- Ensure correctness and cleanliness"
        prompt = (
            f"# Review Target: {context_title}\n\n"
            f"## Acceptance Criteria\n{criteria_md}\n\n"
            f"## Git Diff\n```diff\n{diff_text or '(no diff)'}\n```\n\n"
            "Return ONLY a JSON object with keys: `target_id`, `reviewer`, `verdict` "
            "(`PASS` | `MINOR_FIX` | `MAJOR_REWORK` | `PLAN_AMENDMENT`), `summary`, `confidence`, "
            "`blocking_issues` (list of `{file, line, category, message, suggested_fix}`), "
            "`nitpicks` (list of strings), `escalate_reason`.\n"
            "IMPORTANT: Nitpicks MUST NOT cause rejection; only real defects/contract violations are blocking."
        )
        res, actor = await self._invoke_role(
            run_id=run_id,
            role_name=reviewer_role,
            prompt=prompt,
            workdir=workdir,
            artifact_key=artifact_key,
            model_overrides=overrides,
            task_id=task_id,
            milestone_id=milestone_id,
        )
        if res.status != "ok":
            return ReviewVerdict(
                target_id=target_id,
                reviewer=actor,
                verdict=VerdictKind.MAJOR_REWORK,
                summary=f"Reviewer CLI error ({res.status}): {(res.stderr or res.stdout)[:300]}",
            )
        try:
            parsed = extract_json_object(res.text)
            return ReviewVerdict.from_dict(parsed, default_target=target_id, default_reviewer=actor)
        except SchemaValidationError as exc:
            return ReviewVerdict(
                target_id=target_id,
                reviewer=actor,
                verdict=VerdictKind.MINOR_FIX,
                summary=f"Reviewer returned malformed JSON: {exc}",
            )

    def _build_task_prompt(self, spec: TaskSpec, worktree_dir: Path, feedback: str) -> str:
        parts = [
            f"# Task {spec.id}: {spec.title}",
            f"**Tier**: {spec.tier.value}",
        ]
        if spec.description:
            parts.append(f"## Description\n{spec.description}")
        if spec.allowed_paths:
            parts.append(
                "## Allowed File Paths (STRICT WHITELIST)\n"
                + "\n".join(f"- `{p}`" for p in spec.allowed_paths)
            )
        if spec.acceptance_criteria:
            parts.append(
                "## Acceptance Criteria\n" + "\n".join(f"- {c}" for c in spec.acceptance_criteria)
            )
        if spec.verify_cmd:
            parts.append(f"## Verification Command\n`{spec.verify_cmd}`")
        if spec.golden_example:
            golden_path = worktree_dir / spec.golden_example
            if golden_path.exists():
                snippet = golden_path.read_text(encoding="utf-8", errors="replace")[:6000]
                parts.append(f"## Golden Example (`{spec.golden_example}`)\n```\n{snippet}\n```")
            else:
                parts.append(f"## Golden Example Reference\nFollow the conventions in `{spec.golden_example}`.")
        if feedback:
            parts.append(f"## Required Fixes / Context from Previous Attempt\n{feedback}")
        return "\n\n".join(parts)
