"""Windows-hardened async CLI subprocess runner with stall guard & quota 429 detection."""

from __future__ import annotations

import asyncio
import json
import os
import re
import shutil
import subprocess
import sys
import time
import uuid
from collections.abc import Awaitable, Callable, Iterator
from dataclasses import dataclass
from pathlib import Path, PureWindowsPath
from typing import Literal, cast

from . import pricing
from .config import PricingSettings, ProviderConfig


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
    prompt_tokens: int = 0
    completion_tokens: int = 0
    cached_tokens: int = 0
    cost_usd: float | None = None
    parsed_text: str | None = None

    @property
    def text(self) -> str:
        """Return the response text selected by the provider's output rules."""
        if self.parsed_text is not None:
            return self.parsed_text
        return self.output_file_text or self.stdout


@dataclass(frozen=True)
class ParsedCLIOutput:
    """A CLI response with usage normalized to cached tokens within the prompt."""

    text: str
    prompt_tokens: int = 0
    completion_tokens: int = 0
    cached_tokens: int = 0
    structured: bool = False


_CLIFormat = Literal["claude", "codex", "dsh", "gemini", "agy"]
_JSONEvent = dict[str, object]
_DSH_USAGE_KEYS = ("usage", "token_usage", "metrics")
_DSH_RESPONSE_TYPES = ("assistant", "assistant_message", "message", "result", "text", "final", "done")


def _json_object(text: str) -> _JSONEvent | None:
    if not text.lstrip().startswith("{"):
        return None
    try:
        event = json.loads(text)
    except (ValueError, RecursionError):
        return None
    return event if isinstance(event, dict) else None


def _usage_blocks(events: list[_JSONEvent], *keys: str) -> Iterator[_JSONEvent]:
    for event in events:
        for key in keys:
            usage = event.get(key)
            if isinstance(usage, dict):
                yield usage


def _token_count(usage: _JSONEvent, *keys: str) -> int:
    for key in keys:
        value = usage.get(key)
        if type(value) is int and value >= 0:
            return value
    return 0


def _dsh_message_role(event: _JSONEvent) -> object:
    role = event.get("role")
    message = event.get("message")
    if role is None and isinstance(message, dict):
        return message.get("role")
    return role


def _detect_cli_format(
    events: list[_JSONEvent], provider_type: str, command: list[str], provider_name: str,
) -> _CLIFormat | None:
    provider_type = provider_type.lower()
    if provider_type in ("claude", "codex", "dsh", "gemini", "agy"):
        return cast(_CLIFormat, provider_type)

    binary = PureWindowsPath(command[0]).stem.lower() if command else ""
    name = provider_name.lower().replace("-", "_").split("_", 1)[0]
    hints = {binary, name}
    if "gemini" in hints:
        return "gemini"
    if "agy" in hints:
        return "agy"
    arg_pairs = list(zip(command, command[1:]))
    if any(
        ("--output-format", mode) in arg_pairs or f"--output-format={mode}" in command
        for mode in ("json", "stream-json")
    ):
        return "claude"
    if "--json" in command:
        for hint in (binary, name):
            if hint in ("codex", "dsh"):
                return cast(_CLIFormat, hint)
        if ("--profile", "headless") in arg_pairs or "--profile=headless" in command:
            return "dsh"
        if "exec" in command:
            return "codex"

    for event in events:
        kind = event.get("type")
        item = event.get("item")
        if isinstance(kind, str) and kind.startswith(("thread.", "turn.", "item.")):
            return "codex"
        if isinstance(item, dict) and item.get("type") == "agent_message":
            return "codex"

    usage_blocks = list(_usage_blocks(events, "usage"))
    if usage_blocks and "codex" in hints:
        return "codex"
    if any(isinstance(event.get(key), dict) for event in events for key in ("token_usage", "metrics")) or any(
        {
            "prompt_tokens",
            "completion_tokens",
            "cached_tokens",
            "cached_input_tokens",
            "inputTokens",
            "outputTokens",
            "promptTokens",
            "completionTokens",
            "cachedTokens",
            "cachedInputTokens",
            "cacheReadInputTokens",
        }
        & usage.keys()
        for usage in usage_blocks
    ):
        return "dsh"
    if "dsh" not in hints and any(
        event.get("type") == "stream_event"
        or (isinstance(event.get("result"), str)
            and (event.get("type") == "result" or isinstance(event.get("usage"), dict)))
        for event in events
    ):
        return "claude"
    if usage_blocks:
        return "claude" if "claude" in hints else "dsh"
    if any(
        event.get("type") in _DSH_RESPONSE_TYPES or _dsh_message_role(event) == "assistant"
        or ("dsh" in hints and _dsh_response_text(event))
        for event in events
    ):
        return "dsh"
    return None


def _parse_claude_output(events: list[_JSONEvent], file_text: str | None, stdout: str) -> ParsedCLIOutput:
    result = next((
        event for event in reversed(events)
        if event.get("type") == "result" or isinstance(event.get("result"), str)
    ), {})
    final_usage = result.get("usage")
    if isinstance(final_usage, dict):
        # The result includes usage already reported by earlier stream events.
        blocks = [final_usage]
    else:
        blocks = []
        for event in events:
            usage = event.get("usage")
            message = event.get("message")
            if not isinstance(usage, dict) and isinstance(message, dict):
                usage = message.get("usage")
            if isinstance(usage, dict):
                blocks.append(usage)

    cached = sum(_token_count(usage, "cache_read_input_tokens") for usage in blocks)
    prompt = cached + sum(
        _token_count(usage, "input_tokens") + _token_count(usage, "cache_creation_input_tokens")
        for usage in blocks
    )
    completion = sum(_token_count(usage, "output_tokens") for usage in blocks)
    result_text = result.get("result")
    text = file_text or (result_text if isinstance(result_text, str) else "") or stdout
    return ParsedCLIOutput(text, prompt, completion, cached, structured=True)


def _parse_codex_output(events: list[_JSONEvent], file_text: str | None, stdout: str) -> ParsedCLIOutput:
    prompt = completion = cached = 0
    for usage in _usage_blocks(events, "usage"):
        prompt += _token_count(usage, "input_tokens")
        completion += _token_count(usage, "output_tokens")
        cached += _token_count(usage, "cached_input_tokens")

    if file_text is None:
        for event in reversed(events):
            item = event.get("item")
            if isinstance(item, dict) and item.get("type") == "agent_message":
                text = item.get("text")
                if isinstance(text, str) and text.strip():
                    return ParsedCLIOutput(text, prompt, completion, cached, structured=True)
    return ParsedCLIOutput(file_text or stdout, prompt, completion, cached, structured=True)


def _text_from_parts(value: object) -> str:
    if isinstance(value, str):
        return value
    if not isinstance(value, list):
        return ""
    parts: list[str] = []
    for part in value:
        if isinstance(part, dict) and part.get("type", "text") == "text":
            part = part.get("text")
        if isinstance(part, str):
            parts.append(part)
    return "".join(parts)


def _dsh_response_text(event: _JSONEvent) -> str:
    role = _dsh_message_role(event)
    if role is not None and role != "assistant":
        return ""
    if role is None and event.get("type") not in (None, *_DSH_RESPONSE_TYPES):
        return ""
    for key in ("result", "message", "text", "content"):
        value = event.get(key)
        if isinstance(value, dict):
            value = value.get("content", value.get("text"))
        text = _text_from_parts(value)
        if text.strip():
            return text
    return ""


def _parse_dsh_output(events: list[_JSONEvent], file_text: str | None, stdout: str) -> ParsedCLIOutput:
    prompt = completion = cached = 0
    for usage in _usage_blocks(events, *_DSH_USAGE_KEYS):
        prompt += _token_count(usage, "prompt_tokens", "input_tokens", "inputTokens", "promptTokens")
        completion += _token_count(usage, "completion_tokens", "output_tokens", "outputTokens", "completionTokens")
        cached += _token_count(
            usage,
            "cached_tokens",
            "cached_input_tokens",
            "cache_read_input_tokens",
            "cachedTokens",
            "cachedInputTokens",
            "cacheReadInputTokens",
        )

    text = next((text for event in reversed(events) if (text := _dsh_response_text(event))), "")
    return ParsedCLIOutput(text or file_text or stdout, prompt, completion, cached, structured=True)


def _parse_gemini_output(events: list[_JSONEvent], file_text: str | None, stdout: str) -> ParsedCLIOutput:
    prompt = completion = cached = 0
    for event in events:
        stats = event.get("stats")
        models = stats.get("models") if isinstance(stats, dict) else None
        if isinstance(models, dict):
            for entry in models.values():
                tokens = entry.get("tokens") if isinstance(entry, dict) else None
                if isinstance(tokens, dict):
                    prompt += _token_count(tokens, "prompt", "input", "prompt_tokens")
                    completion += _token_count(tokens, "candidates", "output", "completion_tokens")
                    cached += _token_count(tokens, "cached", "cached_tokens")
    text = next(
        (
            val for event in reversed(events)
            for key in ("response", "result")
            if isinstance(val := event.get(key), str) and val.strip()
        ),
        "",
    )
    return ParsedCLIOutput(text or file_text or stdout, prompt, completion, cached, structured=True)


def _parse_agy_output(events: list[_JSONEvent], file_text: str | None, stdout: str) -> ParsedCLIOutput:
    prompt = completion = cached = 0
    for usage in _usage_blocks(events, "usage"):
        prompt += _token_count(usage, "input_tokens", "prompt_tokens")
        completion += _token_count(usage, "output_tokens", "completion_tokens")
        cached += _token_count(usage, "cache_read_tokens", "cache_read_input_tokens", "cached_tokens")
    text = next(
        (
            val for event in reversed(events)
            for key in ("response", "result")
            if isinstance(val := event.get(key), str) and val.strip()
        ),
        "",
    )
    return ParsedCLIOutput(text or file_text or stdout, prompt, completion, cached, structured=True)


def parse_cli_output_and_usage(
    stdout: str,
    stderr: str,
    output_file_text: str | None,
    *,
    provider_type: str,
    command: list[str],
    provider_name: str,
) -> ParsedCLIOutput:
    """Extract response text and usage from CLI JSON or JSONL stdout.

    Malformed records are skipped. Claude and Codex prefer a nonblank output
    file. DSH prefers its final assistant message. Plain stdout is returned
    verbatim with zero usage. The caller retains stderr for diagnostics.
    """
    event = _json_object(stdout)
    events = [event] if event is not None else [
        event for line in stdout.split("\n") if (event := _json_object(line)) is not None
    ]
    if not events:
        return ParsedCLIOutput(stdout)

    file_text = output_file_text if output_file_text and output_file_text.strip() else None
    output_format = _detect_cli_format(events, provider_type, command, provider_name)
    if output_format == "claude":
        return _parse_claude_output(events, file_text, stdout)
    if output_format == "codex":
        return _parse_codex_output(events, file_text, stdout)
    if output_format == "dsh":
        return _parse_dsh_output(events, file_text, stdout)
    if output_format == "gemini":
        return _parse_gemini_output(events, file_text, stdout)
    if output_format == "agy":
        return _parse_agy_output(events, file_text, stdout)
    return ParsedCLIOutput(stdout)


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
    if "@" in model:
        model_name, effort = model.split("@", 1)
    else:
        model_name, effort = model, ""
    mapping = {
        "model": model,
        "model_name": model_name,
        "effort": effort,
        "workdir": str(workdir),
        "prompt_file": str(prompt_file),
        "output_file": str(output_file),
        "package_root": str(Path(__file__).resolve().parents[2]),
    }
    rendered: list[str] = []
    for token in template:
        if not effort and "{effort}" in token:
            if rendered and rendered[-1] in ("--effort", "-c", "--config"):
                rendered.pop()
            continue
        val = token
        for k, v in mapping.items():
            val = val.replace("{" + k + "}", v)
        rendered.append(val)
    return rendered


def resolve_cli_binary(binary: str) -> str | None:
    """Resolve a CLI binary name/path; on Windows, prefer a newer Codex Desktop bundled CLI over a stale PATH binary."""
    if Path(binary).exists():
        return str(Path(binary).resolve())
    found = shutil.which(binary)
    if sys.platform == "win32" and binary.lower() in ("codex", "codex.exe"):
        local_app = os.environ.get("LOCALAPPDATA")
        if local_app:
            codex_bins = sorted(
                Path(local_app).glob("OpenAI/Codex/bin/*/codex.exe"),
                key=lambda p: p.stat().st_mtime,
                reverse=True,
            )
            if codex_bins:
                newest = codex_bins[0]
                if not found or newest.stat().st_mtime > Path(found).stat().st_mtime:
                    return str(newest)
    if found is None and binary.lower() in ("agy", "agy.exe"):
        if sys.platform == "win32":
            candidates = []
            local_app = os.environ.get("LOCALAPPDATA")
            if local_app:
                candidates.append(Path(local_app) / "agy" / "bin" / "agy.exe")
            candidates.append(Path.home() / "AppData" / "Local" / "agy" / "bin" / "agy.exe")
        else:
            candidates = [Path.home() / ".local" / "bin" / "agy"]
        for candidate in candidates:
            if candidate.exists():
                return str(candidate)
    return found


def check_provider_binary(provider: ProviderConfig) -> dict[str, str | bool]:
    """Check whether the provider's configured CLI binary exists in PATH."""
    if not provider.command:
        return {"provider": provider.name, "ok": False, "binary": "", "resolved": "", "detail": "Empty command template"}
    binary = provider.command[0]
    resolved = resolve_cli_binary(binary)
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
    pricing_settings: PricingSettings | None = None,
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

    # Resolve Windows .cmd / .bat shims (or newer bundled Codex Desktop binary) cleanly
    exe = cmd[0]
    resolved_exe = resolve_cli_binary(exe)
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
    env.setdefault("VIBEBATON_SESSION_ID", str(uuid.uuid4()))

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

    status = "ok" if exit_code == 0 else "error"
    retry_after_sec = None
    if timed_out:
        status = "timeout"
    elif stalled:
        status = "stalled"
    elif exit_code != 0 and provider.rate_limit_regex:
        combined = f"{stdout_text}\n{stderr_text}"
        if re.search(provider.rate_limit_regex, combined, re.IGNORECASE):
            status = "rate_limited"
            retry_after_sec = parse_retry_after_seconds(combined)

    parsed = parse_cli_output_and_usage(
        stdout_text, stderr_text, out_file_text,
        provider_type=provider.type, command=cmd, provider_name=provider.name,
    )
    cost_usd = None
    if parsed.prompt_tokens + parsed.completion_tokens > 0:
        try:
            cost_usd = pricing.compute_token_cost_usd(
                model, parsed.prompt_tokens, parsed.completion_tokens, parsed.cached_tokens,
                pricing_table=provider.model_pricing,
                custom_pricing=pricing_settings.custom if pricing_settings else None,
                cache_path=pricing_settings.cache_path if pricing_settings else None,
                custom_path=pricing_settings.custom_path if pricing_settings else None,
            )
        except ValueError:
            # Malformed usage may report more cached tokens than prompt tokens.
            pass

    return CLIResult(
        status=status,
        exit_code=exit_code,
        stdout=stdout_text,
        stderr=stderr_text,
        duration_sec=duration,
        command=cmd,
        retry_after_sec=retry_after_sec,
        output_file_text=out_file_text,
        prompt_tokens=parsed.prompt_tokens,
        completion_tokens=parsed.completion_tokens,
        cached_tokens=parsed.cached_tokens,
        cost_usd=cost_usd,
        parsed_text=parsed.text if parsed.structured else None,
    )


async def invoke_provider(
    provider: ProviderConfig,
    *,
    prompt: str,
    model: str,
    effort: str | None,
    output_file: Path | None,
    cwd: Path,
    credentials_path: Path | None = None,
    cli_executor: Callable[..., Awaitable[CLIResult]] | None = None,
    pricing_settings: PricingSettings | None = None,
    **kwargs,
) -> CLIResult:
    """Dispatch HTTP with explicit effort or CLI with the original model spec.

    CLI calls require an output path and pass ``prompt_file`` in ``kwargs``.
    ``cli_executor`` preserves caller-supplied CLI execution hooks.
    ``pricing_settings`` supplies CLI rate overrides and pricing file paths.
    HTTP uses the explicit timeout, provider timeout, or caller default in that order.
    """
    if provider.type == "http":
        from . import http_provider

        hard_timeout_sec = kwargs.get("hard_timeout_sec")
        if hard_timeout_sec is None:
            hard_timeout_sec = provider.hard_timeout_sec or kwargs.get("default_hard_timeout")
        http_kwargs: dict[str, object] = {
            "prompt": prompt,
            "model": model,
            "effort": effort,
            "output_file": output_file,
            "cwd": cwd,
            "credentials_path": credentials_path,
            "hard_timeout_sec": hard_timeout_sec,
        }
        # Legacy transports/mocks receive the original arguments when pricing overrides are absent.
        if pricing_settings and (pricing_settings.custom or pricing_settings.cache_path or pricing_settings.custom_path):
            http_kwargs["pricing_settings"] = pricing_settings
        return await http_provider.run_http_provider(provider, **http_kwargs)

    if output_file is None:
        raise ValueError("CLI providers require an output file.")
    execute_cli = run_provider_cli if cli_executor is None else cli_executor
    # Legacy executors receive their original keyword arguments with default pricing.
    if pricing_settings and (pricing_settings.custom or pricing_settings.cache_path or pricing_settings.custom_path):
        kwargs["pricing_settings"] = pricing_settings
    return await execute_cli(
        provider,
        prompt=prompt,
        model=model,
        output_file=output_file,
        workdir=cwd,
        **kwargs,
    )
