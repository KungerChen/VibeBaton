"""Deterministic mechanical gate runner (Lint / Typecheck / Unit Test / Build)."""

from __future__ import annotations

import asyncio
import locale
import os
import re
import shutil
import sys
import time
from dataclasses import dataclass
from pathlib import Path

from .cli_runner import kill_process_tree


_WINDOWS_INLINE_PYTHON_GATE = re.compile(
    r'cmd(?:\.exe)? +/c +"(?P<prefix>(?:set +[a-z_][a-z_0-9]*=[^"&|<>^\r\n]*&& *)+'
    r'python(?:\.exe)? +-c +)\\"(?P<source>[^"\r\n]+)(?<!\\)\\""',
    re.IGNORECASE,
)
_WINDOWS_EXPLICIT_SHELL = re.compile(
    r"^\s*(?:cmd(?:\.exe)?|powershell(?:\.exe)?|pwsh(?:\.exe)?)\b",
    re.IGNORECASE,
)
_POSIX_SHELL_PATTERNS = (
    re.compile(r"(?:^|[;&|()])\s*if\s+\[\[?"),
    re.compile(r"(?:^|;)\s*(?:then|elif|fi)\b"),
    re.compile(r"(?:^|[;&|()])\s*test\s+-[znfderwx]\b"),
    re.compile(r"\$\([^)]+\)"),
    re.compile(r"(?:^|[;&|()])\s*\[\s+-[znfderwx]\s+"),
    re.compile(r"(?:^|[;&|()])\s*\[\[[\s\S]+?\]\]"),
    re.compile(r"\|\s*(?:grep|awk|sed|wc|head|tail|xargs)\b"),
    re.compile(r"^\s*[A-Za-z_][A-Za-z0-9_]*=\S+\s+\S+"),
)


def _is_wsl_bash_stub(path: Path) -> bool:
    norm = str(path).replace("/", "\\").lower()
    return "\\windowsapps\\" in norm or "\\system32\\" in norm


def _find_windows_posix_bash() -> str | None:
    """Locate Git for Windows bash.exe, avoiding WSL bash stubs."""
    candidates: list[Path] = []
    git_path = shutil.which("git")
    if git_path:
        git_root = Path(git_path).resolve().parent.parent
        candidates.extend([git_root / "bin" / "bash.exe", git_root / "usr" / "bin" / "bash.exe"])
    for env_key, sub in (
        ("ProgramFiles", Path("Git") / "bin" / "bash.exe"),
        ("ProgramFiles(x86)", Path("Git") / "bin" / "bash.exe"),
        ("LOCALAPPDATA", Path("Programs") / "Git" / "bin" / "bash.exe"),
    ):
        base = os.environ.get(env_key)
        if base:
            candidates.append(Path(base) / sub)
    for candidate in candidates:
        if candidate.is_file() and not _is_wsl_bash_stub(candidate):
            return str(candidate)
    bash_on_path = shutil.which("bash")
    if bash_on_path:
        resolved = Path(bash_on_path)
        if resolved.is_file() and not _is_wsl_bash_stub(resolved):
            return str(resolved)
    return None


def _looks_like_posix_shell(command: str) -> bool:
    """Return True when a command uses POSIX shell syntax unsupported by cmd.exe."""
    stripped = command.strip()
    if not stripped or _WINDOWS_EXPLICIT_SHELL.match(stripped):
        return False
    return any(pattern.search(stripped) for pattern in _POSIX_SHELL_PATTERNS)


def _decode_process_output(data: bytes) -> str:
    """Decode subprocess bytes as UTF-8, falling back to Windows locale encoding."""
    try:
        return data.decode("utf-8")
    except UnicodeDecodeError:
        if sys.platform == "win32":
            encoding = locale.getpreferredencoding(False) or "mbcs"
            return data.decode(encoding, errors="replace")
        return data.decode("utf-8", errors="replace")


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
    env.setdefault("PYTHONUTF8", "1")
    src_dir = workdir / "src"
    if src_dir.is_dir():
        existing_pp = env.get("PYTHONPATH", "")
        env["PYTHONPATH"] = f"{src_dir}{os.pathsep}{existing_pp}" if existing_pp else str(src_dir)
    exec_cmd = command
    bash_path: str | None = None
    if sys.platform == "win32":
        if _looks_like_posix_shell(command):
            bash_path = _find_windows_posix_bash()
        if bash_path is None:
            exec_cmd = re.sub(r"([<>]\s*)/dev/null\b", r"\1NUL", exec_cmd)
            # The subprocess shell supplies cmd.exe. Quote the Python source for that shell.
            inline_python = _WINDOWS_INLINE_PYTHON_GATE.fullmatch(exec_cmd)
            if inline_python:
                exec_cmd = f'{inline_python["prefix"]}"{inline_python["source"]}"'
    if bash_path is not None:
        proc = await asyncio.create_subprocess_exec(
            bash_path,
            "-c",
            exec_cmd,
            cwd=str(workdir),
            env=env,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
    else:
        proc = await asyncio.create_subprocess_shell(
            exec_cmd,
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
        stdout=_decode_process_output(stdout_b),
        stderr=_decode_process_output(stderr_b),
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
