"""HTTP transport and shared helpers for OpenAI-compatible Chat Completions."""

from __future__ import annotations

import asyncio
import http.client
import json
import os
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Mapping
from pathlib import Path
from typing import Literal

from . import pricing
from .cli_runner import CLIResult, parse_retry_after_seconds
from .config import ProviderConfig
from .credentials import default_credentials_path


_DEFAULT_HARD_TIMEOUT_SEC = 600
_REDACTED = "[redacted]"
_INVALID_BASE_URL = "Provider base_url must be an http(s) URL"


DEFAULT_MODEL_PRICING = pricing.DEFAULT_MODEL_PRICING


def resolve_http_api_key(
    provider: ProviderConfig, credentials_path: Path | None = None,
) -> str | None:
    """Read the configured key from the environment or user-local credentials.

    An explicit empty environment value disables the file fallback. The value
    is returned for authentication and kept out of diagnostics.
    """
    key_name = provider.api_key_env
    if not key_name:
        return None
    value = os.environ.get(key_name)
    if value is not None:
        return value or None

    try:
        local = json.loads(default_credentials_path(credentials_path).read_text(encoding="utf-8"))
    except (OSError, ValueError, RecursionError):
        return None
    value = local.get(key_name) if isinstance(local, dict) else None
    if isinstance(value, str) and value and "\0" not in value:
        return value
    return None


def compute_token_cost_usd(
    model: str,
    prompt_tokens: int,
    completion_tokens: int,
    cached_tokens: int = 0,
    pricing_table: Mapping[str, Mapping[str, float]] | None = None,
) -> float | None:
    """Delegate token pricing while keeping the HTTP provider's public signature."""
    return pricing.compute_token_cost_usd(
        model, prompt_tokens, completion_tokens, cached_tokens, pricing_table,
    )


def build_chat_completions_request(
    provider: ProviderConfig, model: str, prompt: str, effort: str | None,
) -> tuple[str, bytes, dict[str, str]]:
    """Build the completion URL, JSON bytes, and configured request headers."""
    url = f"{provider.base_url.rstrip('/')}/chat/completions"
    payload: dict[str, object] = {
        "model": model,
        "messages": [{"role": "user", "content": prompt}],
    }
    if effort:
        payload["reasoning_effort"] = effort
    headers = {"Content-Type": "application/json"}
    headers.update(provider.headers)
    return url, json.dumps(payload).encode("utf-8"), headers


def _missing_api_key_message(provider: ProviderConfig) -> str:
    return (
        f"API key not configured (env {provider.api_key_env} "
        "or ~/.vibebaton/credentials.json)"
    )


def _sanitize(message: str, secret: str | None) -> str:
    if not secret:
        return message
    sanitized = message.replace(secret, _REDACTED)
    return "" if secret in sanitized else sanitized


def _is_http_url(base_url: str) -> bool:
    try:
        parsed = urllib.parse.urlsplit(base_url)
        return (
            parsed.scheme in ("http", "https")
            and bool(parsed.hostname)
            and parsed.port != 0
            and not any(char.isspace() for char in parsed.netloc)
        )
    except ValueError:
        return False


def _is_rate_limited(provider: ProviderConfig, status: int, body_text: str) -> bool:
    if status == 429 or "insufficient_quota" in body_text.lower():
        return True
    pattern = provider.rate_limit_regex
    try:
        return bool(pattern and re.search(pattern, body_text, re.IGNORECASE))
    except re.error:
        return False


def _retry_after_sec(value: str | None, body_text: str) -> float | None:
    if value is not None:
        try:
            seconds = int(value)
            if seconds >= 0:
                return float(seconds)
        except (ValueError, OverflowError):
            pass
    try:
        return parse_retry_after_seconds(body_text)
    except (ValueError, OverflowError):
        return None


def _post_chat_completions(
    url: str, payload: bytes, headers: Mapping[str, str], timeout_sec: float,
) -> tuple[int, str | None, bytes]:
    request = urllib.request.Request(url, data=payload, headers=dict(headers), method="POST")
    try:
        response = urllib.request.urlopen(request, timeout=timeout_sec)
    except urllib.error.HTTPError as exc:
        response = exc
    with response:
        response_headers = response.headers
        retry_after = response_headers.get("Retry-After") if response_headers is not None else None
        return response.status, retry_after, response.read()


def parse_chat_completions_response(body: bytes) -> tuple[str, int, int, int]:
    """Return the first choice's text, prompt, completion, and cached token counts.

    Omitted usage fields default to zero. Malformed JSON, missing text, and
    invalid counts raise ``ValueError``.
    """
    data = json.loads(body)
    try:
        text = data["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError):
        raise ValueError("Chat Completions response is missing message content.") from None
    if not isinstance(text, str):
        raise ValueError("Chat Completions message content must be text.")

    usage = data.get("usage")
    if usage is None:
        return text, 0, 0, 0
    if not isinstance(usage, dict):
        raise ValueError("Chat Completions usage must be an object.")
    details = usage.get("prompt_tokens_details")
    if details is None:
        details = {}
    if not isinstance(details, dict):
        raise ValueError("Chat Completions prompt token details must be an object.")

    prompt_tokens = usage.get("prompt_tokens", 0)
    completion_tokens = usage.get("completion_tokens", 0)
    cached_tokens = details.get("cached_tokens", usage.get("prompt_cache_hit_tokens", 0))
    if any(type(count) is not int or count < 0 for count in (prompt_tokens, completion_tokens, cached_tokens)):
        raise ValueError("Chat Completions token counts must be non-negative integers.")
    if cached_tokens > prompt_tokens:
        raise ValueError("Chat Completions cached tokens exceed prompt tokens.")
    return text, prompt_tokens, completion_tokens, cached_tokens


async def run_http_provider(
    provider: ProviderConfig,
    *,
    prompt: str,
    model: str,
    effort: str | None,
    output_file: Path | None,
    cwd: Path,
    credentials_path: Path | None = None,
    hard_timeout_sec: float | None = None,
) -> CLIResult:
    """Run blocking urllib transport via asyncio.to_thread and return a CLIResult."""
    started = time.monotonic()
    api_key = resolve_http_api_key(provider, credentials_path)
    command: list[str] = []

    def failure(
        status: Literal["error", "rate_limited", "timeout"],
        message: str,
        exit_code: int = 1,
        *,
        retry_after_sec: float | None = None,
    ) -> CLIResult:
        return CLIResult(
            status=status,
            exit_code=exit_code,
            stdout="",
            stderr=_sanitize(message, api_key)[:500],
            duration_sec=time.monotonic() - started,
            command=command,
            retry_after_sec=retry_after_sec,
        )

    if not api_key:
        return failure("error", _missing_api_key_message(provider))
    if not _is_http_url(provider.base_url):
        return failure("error", _INVALID_BASE_URL)

    url, payload, headers = build_chat_completions_request(provider, model, prompt, effort)
    headers = {"Authorization": f"Bearer {api_key}", **headers}
    command.append(_sanitize(f"POST {url}", api_key))
    timeout_sec = hard_timeout_sec if hard_timeout_sec is not None else provider.hard_timeout_sec
    if timeout_sec is None:
        timeout_sec = _DEFAULT_HARD_TIMEOUT_SEC

    try:
        http_status, retry_after_header, raw = await asyncio.wait_for(
            asyncio.to_thread(_post_chat_completions, url, payload, headers, timeout_sec),
            timeout=timeout_sec,
        )
    except (OSError, ValueError, http.client.HTTPException) as exc:
        reason = exc.reason if isinstance(exc, urllib.error.URLError) else exc
        detail = str(reason)
        normalized = detail.strip().lower()
        if isinstance(reason, TimeoutError) or (
            isinstance(exc, urllib.error.URLError) and (normalized == "timeout" or "timed out" in normalized)
        ):
            return failure("timeout", f"HTTP request timed out after {timeout_sec:g}s")
        return failure("error", f"HTTP request failed: {detail}")

    completion = None
    message = f"HTTP {http_status}"
    if http_status == 200:
        try:
            completion = parse_chat_completions_response(raw)
        except (ValueError, RecursionError) as exc:
            message = f"Malformed Chat Completions response: {exc}"

    # Valid completions can mention rate limits or contain 429 in their usage.
    if completion is None:
        body_text = raw.decode("utf-8", errors="replace").strip()
        if body_text:
            message = f"{message}: {body_text}"
        if _is_rate_limited(provider, http_status, body_text):
            return failure(
                "rate_limited",
                message,
                http_status,
                retry_after_sec=_retry_after_sec(retry_after_header, body_text),
            )
        return failure("error", message, http_status)

    text, prompt_tokens, completion_tokens, cached_tokens = completion
    text = _sanitize(text, api_key)
    cost_usd = compute_token_cost_usd(
        model,
        prompt_tokens,
        completion_tokens,
        cached_tokens,
        pricing_table=provider.model_pricing or None,
    )

    if output_file is not None:
        try:
            output_file.parent.mkdir(parents=True, exist_ok=True)
            output_file.write_bytes(text.encode("utf-8"))
        except (OSError, UnicodeError) as exc:
            return failure("error", f"Could not write output file: {exc}", http_status)

    return CLIResult(
        status="ok",
        exit_code=0,
        stdout=text,
        stderr="",
        duration_sec=time.monotonic() - started,
        command=command,
        output_file_text=text if output_file is not None else None,
        prompt_tokens=prompt_tokens,
        completion_tokens=completion_tokens,
        cached_tokens=cached_tokens,
        cost_usd=cost_usd,
    )


def probe_http_provider(
    provider: ProviderConfig, credentials_path: Path | None = None,
) -> tuple[bool, str]:
    """Check HTTP endpoint configuration and credentials and return readiness details."""
    if not _is_http_url(provider.base_url):
        return False, _INVALID_BASE_URL
    api_key = resolve_http_api_key(provider, credentials_path)
    if api_key is None:
        return False, _missing_api_key_message(provider)
    source = "env" if os.environ.get(provider.api_key_env) else "local_file"
    return True, f"{_sanitize(provider.base_url, api_key)} key via {source}"
