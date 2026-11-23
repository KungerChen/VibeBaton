"""Webhook format, detection, resolution, and delivery-isolation contract tests."""

from __future__ import annotations

import io
import json
import os
import tempfile
import unittest
from dataclasses import replace
from pathlib import Path
from typing import Any
from unittest.mock import patch

from vibebaton.config import NotificationSettings
from vibebaton.notifier import (
    AttentionEvent,
    AttentionNotifier,
    NotificationResult,
    detect_webhook_format,
    format_webhook_payload,
    resolve_webhook_url,
)


_EVENT = AttentionEvent(
    run_id="run-demo",
    category="waiting_human",
    severity="warning",
    title="Plan approval needed",
    message="The run is waiting for your review.",
    action_hint="Open the plan in Studio.",
    milestone_id="M1",
    task_id="T1",
    created_at=1_700_000_000.0,
)
_TEXT = "Plan approval needed\nThe run is waiting for your review.\nOpen the plan in Studio."
_WEBHOOK_URL = "https://alerts.example.invalid/private-path?token=private-query"
_WEBHOOK_ENV = "VIBEBATON_TEST_WEBHOOK_URL"
_SECRET_PATH = "private-path"
_SECRET_QUERY = "private-query"
_FEISHU_URL = "https://open.feishu.cn/open-apis/bot/v2/hook/placeholder"
_LARKSUITE_URL = "https://open.larksuite.com/hook/placeholder"
_WECOM_URL = "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=placeholder"
_DINGTALK_URL = "https://oapi.dingtalk.com/robot/send?access_token=placeholder"
_SLACK_URL = "https://hooks.slack.com/services/placeholder"
_DISCORD_URL = "https://discord.com/api/webhooks/placeholder"
_DISCORDAPP_URL = "https://discordapp.com/api/webhooks/placeholder"

_GENERIC_PAYLOAD: dict[str, Any] = {
    "event": "human_attention_required",
    "run_id": "run-demo",
    "category": "waiting_human",
    "severity": "warning",
    "title": "Plan approval needed",
    "message": "The run is waiting for your review.",
    "action_hint": "Open the plan in Studio.",
    "milestone_id": "M1",
    "task_id": "T1",
    "timestamp": "2023-11-14T22:13:20Z",
}
_VENDOR_PAYLOADS: dict[str, dict[str, Any]] = {
    "feishu": {"msg_type": "text", "content": {"text": _TEXT}},
    "wecom": {"msgtype": "text", "text": {"content": _TEXT}},
    "dingtalk": {"msgtype": "text", "text": {"content": _TEXT}},
    "slack": {"text": _TEXT},
    "discord": {"content": _TEXT},
}


class FakeHttpSender:
    def __init__(self, error: Exception | None = None) -> None:
        self.calls: list[tuple[str, dict[str, Any], float]] = []
        self.error = error

    def __call__(self, url: str, payload: dict[str, Any], timeout: float) -> None:
        self.calls.append((url, payload, timeout))
        if self.error is not None:
            raise self.error


class FakeToastRunner:
    def __init__(self) -> None:
        self.calls: list[tuple[str, str]] = []

    def __call__(self, title: str, message: str) -> None:
        self.calls.append((title, message))


class FakeTty(io.StringIO):
    def isatty(self) -> bool:
        return True


class TestWebhookFormatDetection(unittest.TestCase):
    def test_auto_detects_every_host_family(self) -> None:
        cases = (
            (_FEISHU_URL, "feishu"),
            ("https://larksuite.com/hook/placeholder", "feishu"),
            (_LARKSUITE_URL, "feishu"),
            (_WECOM_URL, "wecom"),
            (_DINGTALK_URL, "dingtalk"),
            (_SLACK_URL, "slack"),
            (_DISCORD_URL, "discord"),
            (_DISCORDAPP_URL, "discord"),
            (_WEBHOOK_URL, "generic"),
            ("https://discord.com/api/webhooks-extra/placeholder", "generic"),
            ("https://open.feishu.cn.example.invalid/hook/placeholder", "generic"),
            ("not-a-url", "generic"),
        )
        for url, expected in cases:
            with self.subTest(url=url):
                self.assertEqual(detect_webhook_format(url), expected)

    def test_explicit_configured_format_overrides_detection(self) -> None:
        for configured in ("generic", "feishu", "wecom", "dingtalk", "slack", "discord"):
            for url in (_FEISHU_URL, _WEBHOOK_URL, "not-a-url"):
                with self.subTest(configured=configured, url=url):
                    self.assertEqual(detect_webhook_format(url, configured), configured)
        self.assertEqual(detect_webhook_format(_FEISHU_URL, "auto"), "feishu")


class TestWebhookPayloadFormatting(unittest.TestCase):
    def test_exact_payload_for_every_explicit_format(self) -> None:
        self.assertEqual(format_webhook_payload(_EVENT, _WEBHOOK_URL, "generic"), _GENERIC_PAYLOAD)
        for fmt, payload in _VENDOR_PAYLOADS.items():
            with self.subTest(fmt=fmt):
                self.assertEqual(format_webhook_payload(_EVENT, _WEBHOOK_URL, fmt), payload)

    def test_auto_detection_selects_exact_payload_for_each_host_family(self) -> None:
        cases = (
            (_FEISHU_URL, "feishu"),
            ("https://larksuite.com/hook/placeholder", "feishu"),
            (_LARKSUITE_URL, "feishu"),
            (_WECOM_URL, "wecom"),
            (_DINGTALK_URL, "dingtalk"),
            (_SLACK_URL, "slack"),
            (_DISCORD_URL, "discord"),
            (_DISCORDAPP_URL, "discord"),
            (_WEBHOOK_URL, "generic"),
        )
        for url, fmt in cases:
            expected = _GENERIC_PAYLOAD if fmt == "generic" else _VENDOR_PAYLOADS[fmt]
            with self.subTest(url=url):
                self.assertEqual(format_webhook_payload(_EVENT, url), expected)

    def test_generic_payload_preserves_run_id_and_event_text(self) -> None:
        payload = format_webhook_payload(_EVENT, _WEBHOOK_URL)
        self.assertEqual(payload["run_id"], _EVENT.run_id)
        self.assertEqual(payload["title"], _EVENT.title)
        self.assertEqual(payload["message"], _EVENT.message)
        self.assertEqual(payload["action_hint"], _EVENT.action_hint)

    def test_vendor_text_payloads_include_event_title_message_and_action_hint(self) -> None:
        for fmt, payload in _VENDOR_PAYLOADS.items():
            if fmt == "feishu":
                text = payload["content"]["text"]
            elif fmt in ("wecom", "dingtalk"):
                text = payload["text"]["content"]
            elif fmt == "slack":
                text = payload["text"]
            else:
                text = payload["content"]
            with self.subTest(fmt=fmt):
                for part in (_EVENT.title, _EVENT.message, _EVENT.action_hint):
                    self.assertIn(part, text)


class TestWebhookUrlResolution(unittest.TestCase):
    def test_direct_url_wins_over_environment_and_credential_store(self) -> None:
        settings = NotificationSettings(webhook_url_env=_WEBHOOK_ENV)
        env_url = "https://alerts.example.invalid/from-environment"
        store_url = "https://alerts.example.invalid/from-store"
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "credentials.json"
            path.write_text(json.dumps({_WEBHOOK_ENV: store_url}), encoding="utf-8")
            with patch.dict(os.environ, {_WEBHOOK_ENV: env_url}):
                self.assertEqual(
                    resolve_webhook_url(replace(settings, webhook_url=_WEBHOOK_URL), path),
                    _WEBHOOK_URL,
                )
                self.assertEqual(resolve_webhook_url(replace(settings, webhook_url="   "), path), env_url)

    def test_environment_variable_precedes_credential_store(self) -> None:
        settings = NotificationSettings(webhook_url_env=_WEBHOOK_ENV)
        env_url = "https://alerts.example.invalid/from-environment"
        store_url = "https://alerts.example.invalid/from-store"
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "credentials.json"
            path.write_text(json.dumps({_WEBHOOK_ENV: store_url}), encoding="utf-8")
            with patch.dict(os.environ, {_WEBHOOK_ENV: f"  {env_url}  "}):
                self.assertEqual(resolve_webhook_url(settings, path), env_url)

    def test_credential_store_is_used_when_direct_and_environment_are_absent(self) -> None:
        settings = NotificationSettings(webhook_url_env=_WEBHOOK_ENV)
        store_url = "https://alerts.example.invalid/from-store"
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "credentials.json"
            path.write_text(json.dumps({_WEBHOOK_ENV: f"  {store_url}  "}), encoding="utf-8")
            with patch.dict(os.environ, {}, clear=False):
                os.environ.pop(_WEBHOOK_ENV, None)
                self.assertEqual(resolve_webhook_url(settings, path), store_url)
                os.environ[_WEBHOOK_ENV] = ""
                self.assertEqual(resolve_webhook_url(settings, path), store_url)

    def test_empty_when_nothing_is_configured(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            missing_path = Path(folder) / "credentials.json"
            with patch.dict(os.environ, {}, clear=False):
                os.environ.pop(_WEBHOOK_ENV, None)
                self.assertEqual(
                    resolve_webhook_url(NotificationSettings(webhook_url_env=_WEBHOOK_ENV), missing_path),
                    "",
                )
                self.assertEqual(resolve_webhook_url(NotificationSettings(), missing_path), "")

    def test_credential_store_error_is_sanitized_in_exception_and_logs(self) -> None:
        settings = NotificationSettings(
            webhook_url_env=_WEBHOOK_ENV,
            desktop_toast=False,
            terminal_bell=False,
        )
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "credentials.json"
            path.write_text(f'{{"{_WEBHOOK_ENV}": "{_WEBHOOK_URL}"', encoding="utf-8")
            with patch.dict(os.environ, {}, clear=False):
                os.environ.pop(_WEBHOOK_ENV, None)
                with self.assertRaises(ValueError) as error:
                    resolve_webhook_url(settings, path)
                self.assertEqual(str(error.exception), "Could not read the local webhook credential.")
                self.assertNotIn(_SECRET_PATH, str(error.exception))
                self.assertNotIn(_SECRET_QUERY, str(error.exception))

                notifier = AttentionNotifier(credentials_path=path)
                with self.assertLogs("vibebaton.notifier", level="WARNING") as logs:
                    result = notifier.notify(_EVENT, settings)

        self.assertEqual(result, NotificationResult(True, None, [
            {"channel": "webhook", "ok": False, "detail": "could not resolve webhook URL"},
        ]))
        recorded = "\n".join(logs.output)
        self.assertNotIn(_SECRET_PATH, recorded)
        self.assertNotIn(_SECRET_QUERY, recorded)


class TestWebhookDeliveryIsolation(unittest.TestCase):
    def test_failed_webhook_is_isolated_from_remaining_channels(self) -> None:
        http_sender = FakeHttpSender(error=RuntimeError(_WEBHOOK_URL))
        toast_runner = FakeToastRunner()
        bell_stream = FakeTty()
        notifier = AttentionNotifier(
            http_sender=http_sender,
            toast_runner=toast_runner,
            bell_stream=bell_stream,
            platform="win32",
        )
        settings = NotificationSettings(webhook_url=_WEBHOOK_URL)

        with self.assertLogs("vibebaton.notifier", level="WARNING") as logs:
            result = notifier.notify(_EVENT, settings)

        failed_detail = "delivery failed to https://alerts.example.invalid/***"
        self.assertEqual(result, NotificationResult(True, None, [
            {"channel": "webhook", "ok": False, "detail": failed_detail},
            {"channel": "desktop_toast", "ok": True, "detail": "started"},
            {"channel": "terminal_bell", "ok": True, "detail": "rang"},
        ]))
        self.assertEqual(http_sender.calls, [(_WEBHOOK_URL, _GENERIC_PAYLOAD, 5.0)])
        self.assertEqual(toast_runner.calls, [(_EVENT.title, _EVENT.message)])
        self.assertEqual(bell_stream.getvalue(), "\a")
        recorded = "\n".join([repr(settings), repr(result), *logs.output])
        self.assertIn("https://alerts.example.invalid/***", recorded)
        self.assertNotIn(_SECRET_PATH, recorded)
        self.assertNotIn(_SECRET_QUERY, recorded)

    def test_failed_webhook_without_other_channels_is_still_a_dispatch_attempt(self) -> None:
        http_sender = FakeHttpSender(error=RuntimeError(_WEBHOOK_URL))
        notifier = AttentionNotifier(http_sender=http_sender)
        settings = NotificationSettings(
            webhook_url=_WEBHOOK_URL,
            desktop_toast=False,
            terminal_bell=False,
        )

        with self.assertLogs("vibebaton.notifier", level="WARNING"):
            result = notifier.notify(_EVENT, settings)

        self.assertEqual(result, NotificationResult(True, None, [{
            "channel": "webhook",
            "ok": False,
            "detail": "delivery failed to https://alerts.example.invalid/***",
        }]))

    def test_only_skipped_channels_are_not_dispatched(self) -> None:
        http_sender = FakeHttpSender()
        with tempfile.TemporaryDirectory() as folder:
            notifier = AttentionNotifier(
                http_sender=http_sender,
                credentials_path=Path(folder) / "credentials.json",
                bell_stream=io.StringIO(),
                platform="linux",
            )
            with patch.dict(os.environ, {}, clear=False):
                os.environ.pop(_WEBHOOK_ENV, None)
                result = notifier.notify(_EVENT, NotificationSettings(webhook_url_env=_WEBHOOK_ENV))

        self.assertEqual(result, NotificationResult(False, "no_channels", [
            {"channel": "webhook", "ok": True, "detail": "skipped: URL not configured"},
            {"channel": "desktop_toast", "ok": True, "detail": "skipped: not windows"},
            {"channel": "terminal_bell", "ok": True, "detail": "skipped: not a TTY"},
        ]))
        self.assertEqual(http_sender.calls, [])

    def test_invalid_webhook_url_is_rejected_without_logging_secret(self) -> None:
        http_sender = FakeHttpSender()
        notifier = AttentionNotifier(http_sender=http_sender)
        settings = NotificationSettings(
            webhook_url=f"ftp://alerts.example.invalid/{_SECRET_PATH}?token={_SECRET_QUERY}",
            desktop_toast=False,
            terminal_bell=False,
        )

        with self.assertLogs("vibebaton.notifier", level="WARNING") as logs:
            result = notifier.notify(_EVENT, settings)

        self.assertEqual(result, NotificationResult(True, None, [{
            "channel": "webhook",
            "ok": False,
            "detail": "invalid HTTP(S) webhook URL",
        }]))
        self.assertEqual(http_sender.calls, [])
        recorded = "\n".join([repr(result), *logs.output])
        self.assertNotIn(_SECRET_PATH, recorded)
        self.assertNotIn(_SECRET_QUERY, recorded)


class TestWebhookDeliveryForwarding(unittest.TestCase):
    def test_timeout_and_payload_are_forwarded_to_http_sender(self) -> None:
        http_sender = FakeHttpSender()
        notifier = AttentionNotifier(http_sender=http_sender)
        settings = NotificationSettings(
            webhook_url=_FEISHU_URL,
            webhook_timeout_sec=2.5,
            desktop_toast=False,
            terminal_bell=False,
        )

        result = notifier.notify(_EVENT, settings)

        self.assertEqual(http_sender.calls, [(_FEISHU_URL, _VENDOR_PAYLOADS["feishu"], 2.5)])
        self.assertEqual(result, NotificationResult(True, None, [{
            "channel": "webhook",
            "ok": True,
            "detail": "sent to https://open.feishu.cn/***",
        }]))

    def test_configured_format_overrides_detection_before_sending(self) -> None:
        http_sender = FakeHttpSender()
        notifier = AttentionNotifier(http_sender=http_sender)
        settings = NotificationSettings(
            webhook_url=_FEISHU_URL,
            webhook_format="slack",
            webhook_timeout_sec=1.25,
            desktop_toast=False,
            terminal_bell=False,
        )

        result = notifier.notify(_EVENT, settings)

        self.assertEqual(http_sender.calls, [(_FEISHU_URL, _VENDOR_PAYLOADS["slack"], 1.25)])
        self.assertEqual(result, NotificationResult(True, None, [{
            "channel": "webhook",
            "ok": True,
            "detail": "sent to https://open.feishu.cn/***",
        }]))


if __name__ == "__main__":
    unittest.main()
