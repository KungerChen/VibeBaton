"""Deterministic mechanical gate runner (Lint / Typecheck / Unit Test / Build)."""

from __future__ import annotations

import asyncio
import os
import time
from dataclasses import dataclass
from pathlib import Path

from .cli_runner import kill_process_tree


@dataclass
class GateCommandResult:
    command: str
    passed: bool
    exit_code: int
    stdout: str
    stderr: str
    duration_sec: float


@dataclass
class GateSuiteResult:
    passed: bool
    results: list[GateCommandResult]

    def summary_text(self, max_chars: int = 8000) -> str:
        lines: list[str] = []
        for r in self.results:
            badge = "PASS" if r.passed else f"FAIL (exit={r.exit_code})"
            lines.append(f"### Gate `{r.command}` -> {badge} ({r.duration_sec:.2f}s)")
            if not r.passed:
                if r.stdout.strip():
                    lines.append("STDOUT:\n" + r.stdout.strip()[-2500:])
                if r.stderr.strip():
                    lines.append("STDERR:\n" + r.stderr.strip()[-2500:])
        text = "\n\n".join(lines)
        return text[:max_chars]


async def run_gate_command(command: str, workdir: Path, timeout_sec: int = 600) -> GateCommandResult:
    """Execute a single shell verification command inside a worktree."""
    start = time.monotonic()
    env = os.environ.copy()
    env.setdefault("PYTHONDONTWRITEBYTECODE", "1")
    src_dir = workdir / "src"
    if src_dir.is_dir():
        existing_pp = env.get("PYTHONPATH", "")
        env["PYTHONPATH"] = f"{src_dir}{os.pathsep}{existing_pp}" if existing_pp else str(src_dir)
    proc = await asyncio.create_subprocess_shell(
        command,
        cwd=str(workdir),
        env=env,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        stdout_b, stderr_b = await asyncio.wait_for(proc.communicate(), timeout=timeout_sec)
        exit_code = proc.returncode if proc.returncode is not None else -1
    except asyncio.TimeoutError:
        kill_process_tree(proc.pid)
        stdout_b, stderr_b = b"", f"Gate command timed out after {timeout_sec}s".encode("utf-8")
        exit_code = 124

    duration = time.monotonic() - start
    return GateCommandResult(
        command=command,
        passed=(exit_code == 0),
        exit_code=exit_code,
        stdout=stdout_b.decode("utf-8", errors="replace"),
        stderr=stderr_b.decode("utf-8", errors="replace"),
        duration_sec=duration,
    )


async def run_gate_suite(commands: list[str], workdir: Path, timeout_sec: int = 600) -> GateSuiteResult:
    """Run a sequence of deterministic verification commands, stopping on the first failure."""
    results: list[GateCommandResult] = []
    for cmd in commands:
        if not cmd.strip():
            continue
        res = await run_gate_command(cmd, workdir=workdir, timeout_sec=timeout_sec)
        results.append(res)
        if not res.passed:
            return GateSuiteResult(passed=False, results=results)
    return GateSuiteResult(passed=True, results=results)
