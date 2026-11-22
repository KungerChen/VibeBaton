"""Run the three resource adapter benchmark arms and export their scores."""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import os
import random
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import time
from dataclasses import asdict, dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import TYPE_CHECKING, Literal
from uuid import uuid4

if TYPE_CHECKING:
    from vibebaton.config import BatonConfig, ProviderConfig, RoleConfig


BENCHMARKS = Path(__file__).resolve().parent
REPO_ROOT = BENCHMARKS.parent
STARTER = BENCHMARKS / "starter_repo"
REFERENCE = BENCHMARKS / "reference_solution"
ADAPTERS = {
    "kv_memory": "KVMemory",
    "kv_ttl": "KVTTL",
    "queue_fifo": "QueueFIFO",
    "queue_priority": "QueuePriority",
    "rate_limiter": "RateLimiter",
    "cache_lru": "CacheLRU",
    "event_bus": "EventBus",
    "retry_policy": "RetryPolicy",
    "circuit_breaker": "CircuitBreaker",
    "config_overlay": "ConfigOverlay",
}
A_MODEL = "deepseek-v4.1-flash@max"
B_MODELS = ("opus@high", "gpt-6.2-sol@max")
C_ROLES = ("tactical_planner", "critical_executor", "bulk_worker", "milestone_reviewer")
HIDDEN_TEST_TOTAL = 109  # The harness checks this against a fresh reference evaluation.
TEST_PATH = "tests/"
CRITICAL_PATHS = frozenset({
    "adapters/circuit_breaker.py", "adapters/rate_limiter.py", "adapters/retry_policy.py",
    TEST_PATH,
})
EDITABLE_PATHS = frozenset({
    "adapters/__init__.py", *(f"adapters/{module}.py" for module in ADAPTERS), TEST_PATH,
})
IGNORE_CACHES = shutil.ignore_patterns("__pycache__", "*.pyc", "*.pyo")

ArmName = Literal["A", "B", "C"]
Mode = Literal["mock", "live"]
EvalError = Literal["timeout", "invalid_summary"]
Snapshot = dict[str, bytes]


@dataclass(frozen=True)
class MockProfile:
    label: str
    adapter_count: int
    wall_clock_sec: float
    flagship_share: float
    frozen_edits: tuple[str, ...] = ()


PROFILES: dict[ArmName, MockProfile] = {
    "A": MockProfile(A_MODEL, 7, 42.0, 0.0, ("adapters/base.py", "adapters/errors.py")),
    "B": MockProfile(f"{B_MODELS[0]} sequential", 9, 180.0, 1.0),
    "C": MockProfile("VibeBaton 4-tier hybrid", 10, 75.0, 0.3),
}


@dataclass(frozen=True)
class HiddenScore:
    passed: int
    total: int
    eval_error: EvalError | None = None

    @property
    def pass_rate(self) -> float:
        return self.passed / self.total


@dataclass(frozen=True)
class ArmResult:
    arm: ArmName
    label: str
    hidden_pass_rate: float
    hidden_passed: int
    hidden_total: int
    contract_violations: int
    wall_clock_sec: float
    flagship_share: float
    eval_error: EvalError | None = None


@dataclass(frozen=True)
class Invocation:
    role: RoleConfig
    provider: ProviderConfig
    flagship: bool


class LiveUnavailable(RuntimeError):
    """The live arms cannot run with the current configuration."""


def _scratch_env(scratch: Path) -> dict[str, str]:
    return {
        "PYTHONDONTWRITEBYTECODE": "1",
        "PYTHONIOENCODING": "utf-8",
        "TEMP": str(scratch),
        "TMP": str(scratch),
        "TMPDIR": str(scratch),
    }


def evaluate_target(target: Path) -> HiddenScore:
    """Score one arm in a fresh Python process using the full hidden suite."""
    target = target.resolve()
    # Several hidden checks launch their own Python processes from the evaluator root.
    with tempfile.TemporaryDirectory(prefix="vibebaton-eval-") as scratch:
        root = Path(scratch)
        package = root / "benchmarks"
        shutil.copytree(BENCHMARKS / "hidden_eval", package / "hidden_eval", ignore=IGNORE_CACHES)
        shutil.copy2(BENCHMARKS / "__init__.py", package)
        try:
            result = subprocess.run(
                [sys.executable, "-B", "-m", "benchmarks.hidden_eval.test_hidden_contract"],
                cwd=root,
                env={
                    **os.environ,
                    **_scratch_env(root),
                    "PYTHONPATH": str(root),
                    "VIBEBATON_BENCH_TARGET": str(target),
                },
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=120,
                check=False,
            )
        except subprocess.TimeoutExpired:
            return HiddenScore(0, HIDDEN_TEST_TOTAL, "timeout")
    try:
        summary = json.loads(result.stdout)
    except (ValueError, RecursionError):
        summary = None
    if isinstance(summary, dict):
        passed, total = summary.get("passed"), summary.get("total")
        if (
            type(passed) is int and type(total) is int
            and total == HIDDEN_TEST_TOTAL and 0 <= passed <= total
            and result.returncode == int(passed < total)
        ):
            return HiddenScore(passed, total)
    return HiddenScore(0, HIDDEN_TEST_TOTAL, "invalid_summary")


def _overlay_mock(target: Path, arm: ArmName, seed: int) -> None:
    profile = PROFILES[arm]
    rng = random.Random(f"{seed}:{arm}")
    selected = set(rng.sample(tuple(ADAPTERS), profile.adapter_count))
    package = target / "adapters"
    for module in sorted(selected):
        shutil.copy2(REFERENCE / "adapters" / f"{module}.py", package)
    init = (REFERENCE / "adapters" / "__init__.py").read_text(encoding="utf-8")
    for module, name in ADAPTERS.items():
        if module not in selected:
            init = init.replace(f"from .{module} import {name}\n", "").replace(f'    "{name}",\n', "")
    (package / "__init__.py").write_text(init, encoding="utf-8")
    for path in profile.frozen_edits:
        with (target / path).open("a", encoding="utf-8") as file:
            file.write("\n# Simulated edit to a frozen contract file.\n")


def _snapshot(root: Path) -> Snapshot:
    """Fingerprint submission files without following links or Git metadata."""
    if root.resolve() != root:
        raise RuntimeError(f"Submission root was replaced with a link: {root}")
    files: Snapshot = {}
    directories = [root]
    while directories:
        for path in directories.pop().iterdir():
            if path == root / ".git":
                continue
            info = path.lstat()
            relative = path.relative_to(root).as_posix()
            is_link = stat.S_ISLNK(info.st_mode) or bool(
                getattr(info, "st_file_attributes", 0) & stat.FILE_ATTRIBUTE_REPARSE_POINT
            )
            if is_link:
                raise RuntimeError(f"Submission contains a link: {path}")
            if stat.S_ISDIR(info.st_mode):
                directories.append(path)
            elif stat.S_ISREG(info.st_mode):
                with path.open("rb") as file:
                    files[relative] = hashlib.file_digest(file, "sha256").digest()
            else:
                raise RuntimeError(f"Submission contains a special file: {path}")
    return files


def _violations(before: Snapshot, after: Snapshot, allowed: frozenset[str]) -> set[str]:
    violations = set()
    for path in before.keys() | after.keys():
        writable = path in allowed or (TEST_PATH in allowed and path.startswith(TEST_PATH))
        if not writable and before.get(path) != after.get(path):
            violations.add(path)
    return violations


def _public_tests_pass(target: Path, scratch: Path) -> bool:
    try:
        result = subprocess.run(
            [sys.executable, "-B", "-m", "unittest", "discover", "-s", "tests", "-v"],
            cwd=target,
            env={**os.environ, **_scratch_env(scratch)},
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=120,
            check=False,
        )
    except subprocess.TimeoutExpired:
        return False
    return result.returncode == 0 and re.search(r"(?m)^Ran [1-9]\d* tests? in ", result.stderr) is not None


def _load_live(config_path: Path | None) -> tuple[BatonConfig, dict[ArmName, tuple[Invocation, ...]]]:
    from vibebaton.config import HotReloadConfig, build_model_catalog, find_config_path
    from vibebaton.credentials import probe_role_or_provider

    try:
        cfg = HotReloadConfig(find_config_path(REPO_ROOT, config_path)).current
    except FileNotFoundError as exc:
        raise LiveUnavailable("VibeBaton config was not found.") from exc
    except (KeyError, TypeError) as exc:
        raise ValueError("VibeBaton config has invalid provider or role entries.") from exc

    flagship_models = set(B_MODELS)
    flagship_models.update(cap.model for cap in build_model_catalog(cfg) if cap.cost_tier == "flagship")

    def resolve(name: str, model: str | None = None) -> Invocation:
        try:
            role, provider = cfg.resolve_role(name, {name: model} if model else None)
        except KeyError as exc:
            raise LiveUnavailable(f"Configure the {name!r} role and its provider.") from exc
        if provider is None or provider.type != "cli" or not provider.command or not role.model.strip():
            raise LiveUnavailable(f"Configure a CLI provider and model for {name!r}.")
        return Invocation(role, provider, role.model in flagship_models)

    a = resolve("bulk_worker", A_MODEL)
    hybrid = tuple(resolve(name) for name in C_ROLES)
    reviewer = hybrid[-1]
    b = reviewer if reviewer.role.model in B_MODELS else resolve("critical_executor", B_MODELS[1])
    plans: dict[ArmName, tuple[Invocation, ...]] = {"A": (a,), "B": (b,), "C": hybrid}

    if shutil.which("git") is None:
        raise LiveUnavailable("Git is required for the live CLI workspaces.")
    providers = {call.provider.name for plan in plans.values() for call in plan}
    for name in sorted(providers):
        check = probe_role_or_provider(cfg, provider=name)
        if not check["ok"]:
            raise LiveUnavailable(f"{name}: {check['detail']} {check['install_hint']}".strip())
    return cfg, plans


async def _run_live_arm(
    arm: ArmName, target: Path, cfg: BatonConfig, plan: tuple[Invocation, ...],
) -> tuple[int, float]:
    from vibebaton.cli_runner import run_provider_cli
    from vibebaton.credentials import resolve_env_for_provider

    # Codex's configured exec command expects a Git workspace.
    subprocess.run(
        ["git", "--git-dir=.git", "--work-tree=.", "init", "--quiet", "--template="],
        cwd=target,
        env={
            **os.environ,
            "GIT_COMMON_DIR": str(target / ".git"),
            "GIT_OBJECT_DIRECTORY": str(target / ".git" / "objects"),
        },
        check=True,
        capture_output=True,
    )
    instructions = (BENCHMARKS / "task_spec.md").read_text(encoding="utf-8")
    if arm == "C":
        stages = (
            ("Return a concise implementation plan. Leave the submission files untouched.", frozenset()),
            ("Implement the circuit breaker, rate limiter and retry policy with public tests.", CRITICAL_PATHS),
            ("Implement the remaining seven adapters, publish all ten exports and complete the public tests.",
             EDITABLE_PATHS - (CRITICAL_PATHS - {TEST_PATH})),
            ("Review the completed submission and report findings. Leave the submission files untouched.",
             frozenset()),
        )
    else:
        assignment = "Implement the full task in this workspace."
        if arm == "B":
            assignment += " Implement and verify the adapters sequentially, one at a time."
        stages = ((assignment, EDITABLE_PATHS),)
    before = _snapshot(target)
    violations: set[str] = set()
    invocations: list[Invocation] = []
    notes = ""
    with tempfile.TemporaryDirectory(prefix=f"provider-{arm}-", dir=target.parent) as scratch:
        runtime = Path(scratch)
        for index, (call, (assignment, allowed)) in enumerate(zip(plan, stages, strict=True), 1):
            role, provider = call.role, call.provider
            scope = ", ".join(sorted(allowed)) or "read-only"
            prompt = f"{instructions}\n\n{assignment}\nAllowed write paths: {scope}.\n"
            if notes:
                prompt += f"\nEarlier stages reported:\n{notes}\n"
            result = await run_provider_cli(
                provider,
                model=role.model,
                prompt=prompt,
                workdir=target,
                prompt_file=runtime / f"{index}.md",
                output_file=runtime / f"{index}.out",
                default_stall_timeout=cfg.daemon.default_stall_timeout_sec,
                default_hard_timeout=cfg.daemon.default_hard_timeout_sec,
                extra_env={
                    **resolve_env_for_provider(provider.name),
                    **_scratch_env(runtime),
                    "VIBEBATON_ROLE": role.name,
                },
            )
            invocations.append(call)
            after = _snapshot(target)
            violations.update(_violations(before, after, allowed))
            if result.status != "ok":
                print(f"Arm {arm} stopped at {role.name} ({result.status}, exit {result.exit_code}).", file=sys.stderr)
                break
            if arm == "C" and violations:
                print(f"Arm C stopped at the {role.name} path whitelist gate.", file=sys.stderr)
                break
            before = after
            notes = (result.output_file_text or result.stdout).strip()[-4000:]
            if arm == "C" and role.name == "bulk_worker":
                passed = _public_tests_pass(target, runtime)
                violations.update(_violations(before, _snapshot(target), frozenset()))
                if not passed:
                    print("Arm C stopped at the public unittest gate.", file=sys.stderr)
                    break
                if violations:
                    print("Arm C stopped after the public tests changed submission files.", file=sys.stderr)
                    break
    # Each arm has at least one stage, and every gate follows the recorded call.
    return len(violations), sum(call.flagship for call in invocations) / len(invocations)


def _export(out_dir: Path, mode: Mode, seed: int, arms: list[ArmResult]) -> None:
    arm_records = []
    for arm in arms:
        record = asdict(arm)
        if arm.eval_error is None:
            del record["eval_error"]
        arm_records.append(record)
    payload = {
        "generated_at": datetime.now(UTC).isoformat(),
        "mode": mode,
        "seed": seed,
        "arms": arm_records,
    }
    rows = [
        "# Resource adapter benchmark",
        "",
        f"Mode `{mode}` · Seed `{seed}`",
        "",
        "| Arm | Label | Hidden Eval Pass Rate | Contract Violations | Wall-Clock Time | Flagship Invocation Share |",
        "| --- | --- | ---: | ---: | ---: | ---: |",
    ]
    rows.extend(
        f"| {arm.arm} | {arm.label} | {arm.hidden_pass_rate:.1%} ({arm.hidden_passed}/{arm.hidden_total}) "
        f"| {arm.contract_violations} | {arm.wall_clock_sec:.2f} s | {arm.flagship_share:.1%} |"
        for arm in arms
    )
    errors = [
        f"- Arm {arm.arm} hidden evaluation failed (`{arm.eval_error}`)."
        for arm in arms if arm.eval_error is not None
    ]
    if errors:
        rows.extend(["", *errors])
    out_dir.mkdir(parents=True, exist_ok=True)
    for name, content in (
        ("latest.json", json.dumps(payload, indent=2) + "\n"),
        ("latest.md", "\n".join(rows) + "\n"),
    ):
        # Direct siblings inherit the output directory's permissions on Windows.
        path = out_dir / f".scoreboard-{uuid4().hex}.tmp"
        file = path.open("x", encoding="utf-8")
        try:
            with file:
                file.write(content)
            path.replace(out_dir / name)
        finally:
            path.unlink(missing_ok=True)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    mode_arg = parser.add_mutually_exclusive_group()
    mode_arg.add_argument("--mock", dest="mode", action="store_const", const="mock", help="use seeded profiles")
    mode_arg.add_argument("--live", dest="mode", action="store_const", const="live", help="run configured CLIs")
    parser.set_defaults(mode="mock")
    parser.add_argument("--out-dir", type=Path, default=BENCHMARKS / "results")
    parser.add_argument("--work-dir", type=Path, help="fresh arm workspace root (default: a new temporary directory)")
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--config", type=Path, help="optional VibeBaton config for --live")
    args = parser.parse_args(argv)
    mode: Mode = args.mode
    try:
        live = None
        if mode == "live":
            sys.path.insert(0, str(REPO_ROOT / "src"))
            live = _load_live(args.config)
        out_dir = args.out_dir.resolve()
        work_dir = args.work_dir.resolve() if args.work_dir else Path(
            tempfile.mkdtemp(prefix="vibebaton-benchmark-")
        ).resolve()
        if any(
            directory.is_relative_to(source)
            for directory in (work_dir, out_dir)
            for source in (STARTER, REFERENCE, BENCHMARKS / "hidden_eval")
        ):
            raise ValueError("Choose output and work directories outside the benchmark inputs.")
        targets = {arm: work_dir / f"arm_{arm}" for arm in PROFILES}
        for target in targets.values():
            if target.exists() or target.is_symlink() or out_dir.is_relative_to(target):
                raise ValueError(f"Use a fresh work directory and place the scoreboard outside {target}.")
        work_dir.mkdir(parents=True, exist_ok=True)
        results: list[ArmResult] = []
        for arm, profile in PROFILES.items():
            start = time.monotonic()
            target = targets[arm]
            shutil.copytree(STARTER, target, ignore=IGNORE_CACHES)
            label = profile.label
            if live is None:
                before = _snapshot(target)
                _overlay_mock(target, arm, args.seed)
                violations = len(_violations(before, _snapshot(target), EDITABLE_PATHS))
                flagship_share = profile.flagship_share
            else:
                cfg, plans = live
                violations, flagship_share = asyncio.run(_run_live_arm(arm, target, cfg, plans[arm]))
                if arm == "B":
                    label = f"{plans[arm][0].role.model} sequential"
            score = evaluate_target(target)
            elapsed = profile.wall_clock_sec if live is None else round(time.monotonic() - start, 3)
            results.append(ArmResult(
                arm, label, score.pass_rate, score.passed, score.total, violations, elapsed, flagship_share,
                eval_error=score.eval_error,
            ))
        _export(out_dir, mode, args.seed, results)
    except LiveUnavailable as exc:
        print(f"Live benchmark skipped. {exc} Configure VibeBaton providers or rerun with --mock.")
        return 0
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as exc:
        print(f"Benchmark failed: {exc}", file=sys.stderr)
        return 1
    print(f"Scoreboards written to {out_dir}. Arm workspaces are in {work_dir}.")
    return 0


if __name__ == "__main__":
    sys.dont_write_bytecode = True
    raise SystemExit(main())
