"""Core async orchestration engine: DAG scheduling, mechanical gates, escalation, and quota cooldowns."""

from __future__ import annotations

import asyncio
import ctypes
import json
import sys
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator

from .cli_runner import CLIResult, run_provider_cli
from .config import BatonConfig, HotReloadConfig, ProviderConfig, RoleConfig
from .db import StateStore
from .gates import run_gate_suite
from .git_ops import (
    GitError,
    check_path_whitelist,
    commit_worktree_changes,
    create_worktree,
    ensure_branch,
    ensure_git_ready,
    get_diff_against,
    merge_branch_into,
    remove_worktree,
    revert_disallowed_files,
)
from .schemas import (
    PlanDAG,
    ReviewVerdict,
    RunStatus,
    SchemaValidationError,
    TaskSpec,
    TaskStatus,
    VerdictKind,
    extract_json_object,
)


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
    ) -> None:
        self.repo_path = repo_path.resolve()
        self.config_loader = config_loader
        self.store = store
        self.package_root = (package_root or Path(__file__).resolve().parents[2]).resolve()
        self._semaphores: dict[str, tuple[int, asyncio.Semaphore]] = {}
        self._merge_lock = asyncio.Lock()

    @property
    def cfg(self) -> BatonConfig:
        return self.config_loader.current

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
                if task_id:
                    self.store.update_task(run_id, task_id, status=TaskStatus.COOLDOWN)
                self.store.log_event(
                    run_id,
                    "quota_cooldown_wait",
                    actor=active_provider.name,
                    task_id=task_id,
                    milestone_id=milestone_id,
                    message=f"Waiting {cooldown:.1f}s for {active_provider.name} quota cooldown",
                )
                await asyncio.sleep(cooldown)

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
                res = await run_provider_cli(
                    active_provider,
                    model=active_model,
                    prompt=full_prompt,
                    workdir=workdir,
                    prompt_file=prompt_file,
                    output_file=output_file,
                    default_stall_timeout=cfg.daemon.default_stall_timeout_sec,
                    default_hard_timeout=cfg.daemon.default_hard_timeout_sec,
                    extra_env={
                        "VIBEBATON_RUN_ID": run_id,
                        "VIBEBATON_ROLE": role_name,
                        "VIBEBATON_TASK_ID": task_id or "",
                        "VIBEBATON_MILESTONE_ID": milestone_id or "",
                    },
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

    # ------------------------------------------------------------------
    # Top-level Run Lifecycle
    # ------------------------------------------------------------------

    async def execute_run(self, run_id: str) -> RunStatus:
        """Execute (or resume) a full pipeline run."""
        run = self.store.get_run(run_id)
        if not run:
            raise ValueError(f"Run '{run_id}' not found")

        overrides: dict[str, str] = json.loads(run["model_overrides_json"] or "{}")
        rfc_path = Path(run["rfc_path"])
        if not rfc_path.exists():
            self.store.update_run_status(run_id, RunStatus.FAILED, summary=f"RFC file missing: {rfc_path}")
            return RunStatus.FAILED

        rfc_text = rfc_path.read_text(encoding="utf-8")

        with windows_wake_lock(self.cfg.daemon.prevent_sleep_windows):
            try:
                base_branch = ensure_git_ready(
                    self.repo_path,
                    base_branch=self.cfg.daemon.base_branch,
                    dev_branch=self.cfg.daemon.dev_branch,
                )
                dev_branch = self.cfg.daemon.dev_branch

                # Stage 1: Planning (or load pre-supplied / already-registered plan)
                plan = await self._ensure_plan(run_id, run, rfc_text, overrides)
                if plan is None:
                    return RunStatus(self.store.get_run(run_id)["status"])

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
                    )
                    if not ok:
                        current = RunStatus(self.store.get_run(run_id)["status"])
                        if current in (RunStatus.WAITING_HUMAN, RunStatus.PAUSED):
                            return current
                        self.store.update_run_status(
                            run_id,
                            RunStatus.FAILED,
                            summary=f"Milestone {milestone.id} failed.",
                        )
                        return RunStatus.FAILED

                # Stage 3: Ready for L0 Final Gate
                summary = (
                    f"All {len(plan.milestones)} milestone(s) passed mechanical gates and AI reviews "
                    f"and are merged into '{dev_branch}'. Ready for L0 final gate review before merging to '{base_branch}'."
                )
                self.store.update_run_status(run_id, RunStatus.READY_FOR_FINAL_GATE, summary=summary)
                self.store.log_event(run_id, "ready_for_final_gate", message=summary)
                return RunStatus.READY_FOR_FINAL_GATE

            except Exception as exc:
                self.store.log_event(run_id, "run_exception", message=str(exc))
                self.store.update_run_status(run_id, RunStatus.FAILED, summary=f"Unhandled error: {exc}")
                return RunStatus.FAILED

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
                continue
            raw_text = res.output_file_text or res.stdout
            try:
                parsed = extract_json_object(raw_text)
                plan = PlanDAG.from_dict(parsed)
                plan_out.write_text(json.dumps(plan.to_dict(), indent=2, ensure_ascii=False), encoding="utf-8")
                self.store.update_run_status(run_id, RunStatus.RUNNING, plan_path=str(plan_out))
                self.store.register_plan(run_id, plan)
                self.store.log_event(run_id, "plan_generated", actor=actor, message=f"Plan saved to {plan_out}")
                return plan
            except SchemaValidationError as exc:
                last_err = str(exc)
                self.store.log_event(run_id, "plan_schema_error", actor=actor, message=last_err)

        self.store.update_run_status(run_id, RunStatus.FAILED, summary=f"Planning failed: {last_err}")
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
    ) -> bool:
        tasks_by_id: dict[str, TaskSpec] = {t.id: t for t in milestone.tasks}
        in_flight: dict[str, asyncio.Task[bool]] = {}

        while True:
            # Check for external pause
            run_row = self.store.get_run(run_id)
            if run_row and run_row["status"] == RunStatus.PAUSED.value:
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
                self.store.update_run_status(
                    run_id,
                    RunStatus.WAITING_HUMAN,
                    human_prompt=f"Task(s) {sorted(waiting_ids)} in milestone {milestone.id} require human decision.",
                )
                return False

            if len(done_ids) == len(tasks_by_id):
                break

            # Schedule all ready tasks whose dependencies are satisfied
            for tid, spec in tasks_by_id.items():
                if tid in done_ids or tid in in_flight or tid in waiting_ids:
                    continue
                if all(dep in done_ids or dep not in tasks_by_id for dep in spec.depends_on):
                    in_flight[tid] = asyncio.create_task(
                        self._execute_task(
                            run_id=run_id,
                            milestone_id=milestone.id,
                            spec=spec,
                            milestone_branch=milestone_branch,
                            overrides=overrides,
                        )
                    )

            if not in_flight:
                self.store.log_event(
                    run_id,
                    "dag_deadlock",
                    milestone_id=milestone.id,
                    message="No runnable tasks remaining before milestone completion.",
                )
                self.store.update_milestone(run_id, milestone.id, TaskStatus.FAILED)
                return False

            done_futures, _ = await asyncio.wait(in_flight.values(), return_when=asyncio.FIRST_COMPLETED)
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

    async def _execute_task(
        self,
        *,
        run_id: str,
        milestone_id: str,
        spec: TaskSpec,
        milestone_branch: str,
        overrides: dict[str, str],
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
                self.store.update_task(
                    run_id,
                    spec.id,
                    status=TaskStatus.RUNNING,
                    attempts=attempt,
                    current_role=current_role,
                    self_heal_count=self_heal_count,
                    review_reject_count=review_reject_count,
                    escalated=1 if escalated else 0,
                )

                task_prompt = self._build_task_prompt(spec, worktree_dir, feedback_context)
                res, actor = await self._invoke_role(
                    run_id=run_id,
                    role_name=current_role,
                    prompt=task_prompt,
                    workdir=worktree_dir,
                    artifact_key=f"{spec.id}_exec_{attempt}",
                    model_overrides=overrides,
                    task_id=spec.id,
                    milestone_id=milestone_id,
                )

                if res.status != "ok":
                    err_msg = f"CLI execution failed ({res.status}): {(res.stderr or res.stdout)[:500]}"
                    self.store.update_task(run_id, spec.id, last_error=err_msg)
                    self.store.log_event(run_id, "task_exec_error", actor=actor, task_id=spec.id, message=err_msg)
                    if not escalated and current_role != spec.escalate_role:
                        escalated = True
                        current_role = spec.escalate_role
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
                    if not escalated and current_role != spec.escalate_role:
                        escalated = True
                        current_role = spec.escalate_role
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
                        if self_heal_count < max_self_heal:
                            self_heal_count += 1
                            feedback_context = (
                                "Mechanical verification gate FAILED. Fix the error directly without touching forbidden files:\n\n"
                                + gate_text
                            )
                            continue
                        if not escalated and current_role != spec.escalate_role:
                            escalated = True
                            current_role = spec.escalate_role
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
                        if review_reject_count <= max_rejects:
                            feedback_context = (
                                "Reviewer requested MINOR_FIX. Address every blocking_issue:\n"
                                + json.dumps(verdict.to_dict(), indent=2, ensure_ascii=False)
                            )
                            continue
                        # Circuit breaker -> escalate to specialist
                        if current_role != spec.escalate_role:
                            escalated = True
                            current_role = spec.escalate_role
                            feedback_context = (
                                f"Worker exceeded max review rejections ({max_rejects}). "
                                "Circuit breaker escalated this task. Fix all issues cleanly:\n"
                                + json.dumps(verdict.to_dict(), indent=2, ensure_ascii=False)
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
                async with self._merge_lock:
                    merge_branch_into(
                        repo=self.repo_path,
                        source_branch=branch_name,
                        target_branch=milestone_branch,
                        commit_message=f"feat({spec.id}): {spec.title}",
                        worktree_root=self._worktree_root(),
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
            self.store.update_task(
                run_id,
                spec.id,
                status=TaskStatus.FAILED,
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
                    async with self._merge_lock:
                        merge_branch_into(
                            repo=self.repo_path,
                            source_branch=fix_branch,
                            target_branch=milestone_branch,
                            commit_message=f"fix({milestone.id}): address milestone review blocking issues (round {fix_round})",
                            worktree_root=self._worktree_root(),
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

                if verdict.verdict == VerdictKind.PASS:
                    async with self._merge_lock:
                        merge_branch_into(
                            repo=self.repo_path,
                            source_branch=milestone_branch,
                            target_branch=dev_branch,
                            commit_message=f"milestone({milestone.id}): {milestone.title}",
                            worktree_root=self._worktree_root(),
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
                    self.store.update_run_status(
                        run_id,
                        RunStatus.WAITING_HUMAN,
                        human_prompt=f"Milestone {milestone.id} reviewer requested PLAN_AMENDMENT: {verdict.summary}",
                    )
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
        raw_text = res.output_file_text or res.stdout
        try:
            parsed = extract_json_object(raw_text)
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
