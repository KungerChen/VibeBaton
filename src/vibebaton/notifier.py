"""Host notifications for run states that need human attention."""

from __future__ import annotations

import base64
import json
import logging
import os
import subprocess
import sys
import time
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, TextIO, TypedDict

from .config import NotificationSettings


ATTENTION_CATEGORIES = (
    "waiting_human", "ready_for_final_gate", "failed", "paused", "long_cooldown", "test",
)
ATTENTION_SEVERITIES = ("warning", "error", "info")

_LOGGER = logging.getLogger(__name__)
_WEBHOOK_HOST_FORMATS = {
    "open.feishu.cn": "feishu",
    "qyapi.weixin.qq.com": "wecom",
    "oapi.dingtalk.com": "dingtalk",
    "hooks.slack.com": "slack",
    "discordapp.com": "discord",
}
# PowerShell treats smart single quotes as string delimiters too.
_POWERSHELL_SINGLE_QUOTES = str.maketrans({quote: quote * 2 for quote in "'\u2018\u2019\u201a\u201b"})


@dataclass
class AttentionEvent:
    run_id: str
    category: str
    severity: str
    title: str
    message: str
    action_hint: str
    milestone_id: str | None = None
    task_id: str | None = None
    created_at: float = field(default_factory=time.time)


class ChannelResult(TypedDict):
    channel: str
    ok: bool
    detail: str


@dataclass
class NotificationResult:
    """Delivery outcomes. Dispatched indicates at least one channel attempt."""

    dispatched: bool
    skipped_reason: str | None
    channels: list[ChannelResult]


def resolve_webhook_url(settings: NotificationSettings, credentials_path: Path | None = None) -> str:
    """Look up a webhook in the configuration, environment, then local credential store."""
    url = settings.webhook_url.strip()
    if url:
        return url
    key = settings.webhook_url_env.strip()
    if not key:
        return ""
    url = os.environ.get(key, "").strip()
    if url:
        return url

    from .credentials import _read_local_credentials, default_credentials_path

    try:
        local = _read_local_credentials(default_credentials_path(credentials_path), keys=(key,))
        return local.get(key, "").strip()
    except Exception:
        raise ValueError("Could not read the local webhook credential.") from None


def _webhook_parts(url: str) -> urllib.parse.SplitResult | None:
    try:
        parts = urllib.parse.urlsplit(url)
        if (
            parts.scheme in ("http", "https")
            and parts.hostname
            and parts.port != 0
            and not any(char.isspace() or char == "\\" for char in parts.netloc)
        ):
            return parts
    except ValueError:
        pass
    return None


def mask_webhook_url(url: str) -> str:
    """Keep the HTTP(S) scheme and host, with only a placeholder path."""
    parts = _webhook_parts(url)
    if parts is None or not (host := parts.hostname):
        return "***"
    if ":" in host:
        host = f"[{host}]"
    if parts.port is not None:
        host = f"{host}:{parts.port}"
    return f"{parts.scheme}://{host}/***"


def detect_webhook_format(url: str, configured: str = "auto") -> str:
    if configured != "auto":
        return configured

    parts = _webhook_parts(url)
    if parts is None or not (host := parts.hostname):
        return "generic"
    host = host.rstrip(".")
    if host == "larksuite.com" or host.endswith(".larksuite.com"):
        return "feishu"
    if host == "discord.com" and (
        parts.path == "/api/webhooks" or parts.path.startswith("/api/webhooks/")
    ):
        return "discord"
    return _WEBHOOK_HOST_FORMATS.get(host, "generic")


def format_webhook_payload(
    event: AttentionEvent, webhook_url: str, fmt: str = "auto",
) -> dict[str, Any]:
    fmt = detect_webhook_format(webhook_url, fmt)
    if fmt == "generic":
        return {
            "event": "human_attention_required",
            "run_id": event.run_id,
            "category": event.category,
            "severity": event.severity,
            "title": event.title,
            "message": event.message,
            "action_hint": event.action_hint,
            "milestone_id": event.milestone_id,
            "task_id": event.task_id,
            "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(event.created_at)),
        }

    text = "\n".join(part for part in (event.title, event.message, event.action_hint) if part)
    if fmt == "feishu":
        return {"msg_type": "text", "content": {"text": text}}
    if fmt in ("wecom", "dingtalk"):
        return {"msgtype": "text", "text": {"content": text}}
    if fmt == "slack":
        return {"text": text}
    if fmt == "discord":
        return {"content": text}
    raise ValueError("Unsupported webhook format.")


def _category_enabled(category: str, settings: NotificationSettings) -> bool:
    if category == "test":
        return True
    if category == "long_cooldown":
        return settings.on_long_cooldown_sec > 0
    return category in ATTENTION_CATEGORIES and bool(getattr(settings, f"on_{category}"))


def should_notify(category: str, settings: NotificationSettings, wait_sec: float | None = None) -> bool:
    """Check category preferences and the duration of a pending cooldown."""
    if not settings.enabled or not _category_enabled(category, settings):
        return False
    return category != "long_cooldown" or (
        wait_sec is not None and wait_sec >= settings.on_long_cooldown_sec
    )


def build_toast_script(title: str, message: str) -> str:
    """Embed notification text as literal PowerShell strings."""
    title = title.translate(_POWERSHELL_SINGLE_QUOTES)
    message = message.translate(_POWERSHELL_SINGLE_QUOTES)
    return f"""Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$icon = New-Object System.Windows.Forms.NotifyIcon
try {{
    $icon.Icon = [System.Drawing.SystemIcons]::Information
    $icon.BalloonTipTitle = '{title}'
    $icon.BalloonTipText = '{message}'
    $icon.Visible = $true
    $icon.ShowBalloonTip(5000)
    Start-Sleep -Milliseconds 5000
}} finally {{
    $icon.Dispose()
}}
"""


def _start_windows_toast(title: str, message: str) -> bool:
    encoded_script = base64.b64encode(build_toast_script(title, message).encode("utf-16le"))
    try:
        subprocess.Popen(
            ["powershell.exe", "-NoProfile", "-NonInteractive", "-STA", "-EncodedCommand",
             encoded_script.decode("ascii")],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
    except FileNotFoundError:
        return False
    return True


def _post_webhook(url: str, payload: dict[str, Any], timeout: float) -> None:
    request = urllib.request.Request(
        url,
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=timeout):
        pass


def _failed_channel(channel: str, detail: str) -> ChannelResult:
    try:
        _LOGGER.warning("%s notification failed (%s)", channel, detail)
    except Exception:
        # Keep delivery outcomes available if a logging handler fails.
        pass
    return {"channel": channel, "ok": False, "detail": detail}


class AttentionNotifier:
    def __init__(
        self,
        credentials_path: Path | None = None,
        http_sender: Callable[[str, dict[str, Any], float], None] | None = None,
        toast_runner: Callable[[str, str], None] | None = None,
        bell_stream: TextIO | None = None,
        platform: str | None = None,
    ) -> None:
        self._credentials_path = credentials_path
        self._http_sender = http_sender if http_sender is not None else _post_webhook
        self._toast_runner = toast_runner
        self._bell_stream = bell_stream if bell_stream is not None else sys.stdout
        self._platform = platform if platform is not None else sys.platform

    def notify(self, event: AttentionEvent, settings: NotificationSettings) -> NotificationResult:
        """Deliver an event. Callers qualify cooldown duration with should_notify first."""
        if not settings.enabled:
            return NotificationResult(False, "disabled", [])
        if not _category_enabled(event.category, settings):
            return NotificationResult(False, "category_disabled", [])

        channels: list[ChannelResult] = []
        if settings.webhook_url or settings.webhook_url_env:
            channels.append(self._notify_webhook(event, settings))
        if settings.desktop_toast:
            channels.append(self._notify_toast(event))
        if settings.terminal_bell:
            channels.append(self._notify_bell())

        dispatched = any(not channel["detail"].startswith("skipped:") for channel in channels)
        return NotificationResult(dispatched, None if dispatched else "no_channels", channels)

    def _notify_webhook(self, event: AttentionEvent, settings: NotificationSettings) -> ChannelResult:
        masked_url = ""
        try:
            url = resolve_webhook_url(settings, self._credentials_path)
            if not url:
                return {"channel": "webhook", "ok": True, "detail": "skipped: URL not configured"}
            if _webhook_parts(url) is None:
                return _failed_channel("webhook", "invalid HTTP(S) webhook URL")
            masked_url = mask_webhook_url(url)
            payload = format_webhook_payload(event, url, settings.webhook_format)
            self._http_sender(url, payload, settings.webhook_timeout_sec)
        except Exception:
            detail = f"delivery failed to {masked_url}" if masked_url else "could not resolve webhook URL"
            return _failed_channel("webhook", detail)
        return {"channel": "webhook", "ok": True, "detail": f"sent to {masked_url}"}

    def _notify_toast(self, event: AttentionEvent) -> ChannelResult:
        started = False
        try:
            if self._platform == "win32":
                if self._toast_runner is None:
                    started = _start_windows_toast(event.title, event.message)
                else:
                    self._toast_runner(event.title, event.message)
                    started = True
        except Exception:
            return _failed_channel("desktop_toast", "could not start toast")
        detail = "started" if started else "skipped: not windows"
        return {"channel": "desktop_toast", "ok": True, "detail": detail}

    def _notify_bell(self) -> ChannelResult:
        try:
            if not self._bell_stream.isatty():
                return {"channel": "terminal_bell", "ok": True, "detail": "skipped: not a TTY"}
            self._bell_stream.write("\a")
            self._bell_stream.flush()
        except Exception:
            return _failed_channel("terminal_bell", "could not write terminal bell")
        return {"channel": "terminal_bell", "ok": True, "detail": "rang"}
