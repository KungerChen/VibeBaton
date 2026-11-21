"""Windows-hardened async CLI subprocess runner with stall guard & quota 429 detection."""

from __future__ import annotations

import asyncio
import os
import re
import shutil
import subprocess
import sys
import time
from dataclasses import dataclass
from pathlib import Path

from .config import ProviderConfig


@dataclass
class CLIResult:
    status: str  # "ok" | "rate_limited" | "stalled" | "timeout" | "error"
    exit_code: int
    stdout: str
    stderr: str
    duration_sec: float
    command: list[str]
    retry_after_sec: float | None = None
    output_file_text: str | None = None


_RETRY_AFTER_RE = re.compile(
    r"(?:retry|try again|wait|reset)\s*(?:after|in)?\s*(\d+)\s*(s|sec|secs|seconds|m|min|mins|minutes)",
    re.IGNORECASE,
)


def parse_retry_after_seconds(text: str) -> float | None:
    match = _RETRY_AFTER_RE.search(text)
    if not match:
        return None
    amount = int(match.group(1))
    unit = match.group(2).lower()
    if unit.startswith("m"):
        return float(amount * 60)
    return float(amount)


def kill_process_tree(pid: int) -> None:
    """Force-terminate a subprocess and all descendant processes (critical on Windows worktrees)."""
    if pid <= 0:
        return
    if sys.platform == "win32":
        subprocess.run(
            ["taskkill", "/T", "/F", "/PID", str(pid)],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=False,
        )
    else:
        try:
            os.kill(pid, 9)
        except OSError:
            pass


def format_command_template(
    template: list[str],
    *,
    model: str,
    workdir: Path,
    prompt_file: Path,
    output_file: Path,
) -> list[str]:
    mapping = {
        "model": model,
        "workdir": str(workdir),
        "prompt_file": str(prompt_file),
        "output_file": str(output_file),
    }
    rendered: list[str] = []
    for token in template:
        val = token
        for k, v in mapping.items():
            val = val.replace("{" + k + "}", v)
        rendered.append(val)
    return rendered


def check_provider_binary(provider: ProviderConfig) -> dict[str, str | bool]:
    """Check whether the provider's configured CLI binary exists in PATH."""
    if not provider.command:
        return {"provider": provider.name, "ok": False, "binary": "", "resolved": "", "detail": "Empty command template"}
    binary = provider.command[0]
    resolved = shutil.which(binary)
    if resolved is None and Path(binary).exists():
        resolved = str(Path(binary).resolve())
    return {
        "provider": provider.name,
        "ok": resolved is not None,
        "binary": binary,
        "resolved": resolved or "",
        "detail": "Ready" if resolved else f"Binary '{binary}' not found in PATH",
    }


async def run_provider_cli(
    provider: ProviderConfig,
    *,
    model: str,
    prompt: str,
    workdir: Path,
    prompt_file: Path,
    output_file: Path,
    default_stall_timeout: int = 300,
    default_hard_timeout: int = 1800,
    extra_env: dict[str, str] | None = None,
) -> CLIResult:
    """Execute a local CLI agent asynchronously with stdin prompt passing & stall protection."""
    prompt_file.parent.mkdir(parents=True, exist_ok=True)
    output_file.parent.mkdir(parents=True, exist_ok=True)
    prompt_file.write_text(prompt, encoding="utf-8")
    if output_file.exists():
        output_file.unlink()

    cmd = format_command_template(
        provider.command,
        model=model,
        workdir=workdir,
        prompt_file=prompt_file,
        output_file=output_file,
    )
    if not cmd:
        return CLIResult(
            status="error",
            exit_code=-1,
            stdout="",
            stderr=f"Provider '{provider.name}' has an empty command template",
            duration_sec=0.0,
            command=[],
        )

    # Resolve Windows .cmd / .bat shims cleanly when invoking directly via create_subprocess_exec
    exe = cmd[0]
    resolved_exe = shutil.which(exe)
    if resolved_exe:
        cmd[0] = resolved_exe

    env = os.environ.copy()
    env.update(provider.env)
    if extra_env:
        env.update(extra_env)
    env["VIBEBATON_PROMPT_FILE"] = str(prompt_file)
    env["VIBEBATON_OUTPUT_FILE"] = str(output_file)
    env["VIBEBATON_MODEL"] = model
    env["VIBEBATON_PROVIDER"] = provider.name

    stall_limit = provider.stall_timeout_sec or default_stall_timeout
    hard_limit = provider.hard_timeout_sec or default_hard_timeout
    start = time.monotonic()

    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            cwd=str(workdir),
            env=env,
            stdin=asyncio.subprocess.PIPE if provider.prompt_via == "stdin" else asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
    except FileNotFoundError as exc:
        return CLIResult(
            status="error",
            exit_code=127,
            stdout="",
            stderr=f"CLI executable not found: {cmd[0]} ({exc})",
            duration_sec=time.monotonic() - start,
            command=cmd,
        )

    if provider.prompt_via == "stdin" and proc.stdin is not None:
        try:
            proc.stdin.write(prompt.encode("utf-8"))
            await proc.stdin.drain()
        except BrokenPipeError:
            pass
        finally:
            try:
                proc.stdin.close()
            except Exception:
                pass

    stdout_chunks: list[bytes] = []
    stderr_chunks: list[bytes] = []
    last_activity = time.monotonic()

    async def _drain(stream: asyncio.StreamReader | None, bucket: list[bytes]) -> None:
        nonlocal last_activity
        if stream is None:
            return
        while True:
            chunk = await stream.read(4096)
            if not chunk:
                break
            bucket.append(chunk)
            last_activity = time.monotonic()

    stdout_task = asyncio.create_task(_drain(proc.stdout, stdout_chunks))
    stderr_task = asyncio.create_task(_drain(proc.stderr, stderr_chunks))
    wait_task = asyncio.create_task(proc.wait())

    timed_out = False
    stalled = False

    try:
        while not wait_task.done():
            await asyncio.sleep(0.1)
            now = time.monotonic()
            if now - start > hard_limit:
                timed_out = True
                kill_process_tree(proc.pid)
                break
            if now - last_activity > stall_limit:
                stalled = True
                kill_process_tree(proc.pid)
                break
        await asyncio.gather(stdout_task, stderr_task, wait_task, return_exceptions=True)
    finally:
        if proc.returncode is None:
            kill_process_tree(proc.pid)

    duration = time.monotonic() - start
    stdout_text = b"".join(stdout_chunks).decode("utf-8", errors="replace")
    stderr_text = b"".join(stderr_chunks).decode("utf-8", errors="replace")
    exit_code = proc.returncode if proc.returncode is not None else -1
    out_file_text = output_file.read_text(encoding="utf-8", errors="replace") if output_file.exists() else None

    if timed_out:
        return CLIResult("timeout", exit_code, stdout_text, stderr_text, duration, cmd, output_file_text=out_file_text)
    if stalled:
        return CLIResult("stalled", exit_code, stdout_text, stderr_text, duration, cmd, output_file_text=out_file_text)

    combined = f"{stdout_text}\n{stderr_text}"
    if exit_code != 0 and provider.rate_limit_regex:
        if re.search(provider.rate_limit_regex, combined, re.IGNORECASE):
            return CLIResult(
                status="rate_limited",
                exit_code=exit_code,
                stdout=stdout_text,
                stderr=stderr_text,
                duration_sec=duration,
                command=cmd,
                retry_after_sec=parse_retry_after_seconds(combined),
                output_file_text=out_file_text,
            )

    status = "ok" if exit_code == 0 else "error"
    return CLIResult(
        status=status,
        exit_code=exit_code,
        stdout=stdout_text,
        stderr=stderr_text,
        duration_sec=duration,
        command=cmd,
        output_file_text=out_file_text,
    )
