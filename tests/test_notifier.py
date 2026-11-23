"""Notification contract tests with in-memory channels and mocked system boundaries."""

from __future__ import annotations

import base64
import io
import json
import os
import tempfile
import tomllib
import unittest
from dataclasses import asdict, replace
from pathlib import Path
from typing import Any
from unittest.mock import Mock, patch

from vibebaton.config import NotificationSettings, parse_config_dict
from vibebaton.notifier import (
    AttentionEvent,
    AttentionNotifier,
    NotificationResult,
    build_toast_script,
    detect_webhook_format,
    format_webhook_payload,
    mask_webhook_url,
    resolve_webhook_url,
    should_notify,
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
_WEBHOOK_URL = "https://alerts.example.invalid/private-path?token=private-query"
_WEBHOOK_ENV = "VIBEBATON_TEST_WEBHOOK_URL"


class FakeHttpSender:
    def __init__(self) -> None:
        self.calls: list[tuple[str, dict[str, Any], float]] = []

    def __call__(self, url: str, payload: dict[str, Any], timeout: float) -> None:
        self.calls.append((url, payload, timeout))


class FakeToastRunner:
    def __init__(self) -> None:
        self.calls: list[tuple[str, str]] = []

    def __call__(self, title: str, message: str) -> None:
        self.calls.append((title, message))


class FakeTty(io.StringIO):
    def isatty(self) -> bool:
        return True


class TestNotificationConfig(unittest.TestCase):
    def test_missing_notifications_uses_independent_defaults(self) -> None:
        config = parse_config_dict({})
        self.assertEqual(config.notifications, NotificationSettings())
        self.assertIsNot(config.notifications, parse_config_dict({}).notifications)

    def test_notifications_table_overrides_all_fields(self) -> None:
        raw = tomllib.loads('''
[notifications]
enabled = false
desktop_toast = false
terminal_bell = false
webhook_url = "https://alerts.example.invalid/webhook/placeholder"
webhook_url_env = "BATON_WEBHOOK_URL"
webhook_format = "discord"
webhook_timeout_sec = 2.5
on_waiting_human = false
on_ready_for_final_gate = false
on_failed = false
on_paused = false
on_long_cooldown_sec = 90
''')
        self.assertEqual(asdict(parse_config_dict(raw).notifications), raw["notifications"])

    def test_invalid_webhook_format_reports_the_config_field(self) -> None:
        with self.assertRaisesRegex(ValueError, r"notifications\.webhook_format.*Expected one of") as error:
            parse_config_dict({"notifications": {"webhook_format": _WEBHOOK_URL}})
        self.assertNotIn(_WEBHOOK_URL, str(error.exception))


class TestWebhookContract(unittest.TestCase):
    def test_detect_webhook_format_by_host(self) -> None:
        cases = (
            ("https://open.feishu.cn/open-apis/bot/v2/hook/placeholder", "feishu"),
            ("https://larksuite.com/hook/placeholder", "feishu"),
            ("https://open.larksuite.com/hook/placeholder", "feishu"),
            ("https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=placeholder", "wecom"),
            ("https://oapi.dingtalk.com/robot/send?access_token=placeholder", "dingtalk"),
            ("https://hooks.slack.com/services/placeholder", "slack"),
            ("https://discord.com/api/webhooks/placeholder", "discord"),
            ("https://discordapp.com/api/webhooks/placeholder", "discord"),
            ("https://discord.com/api/webhooks-extra/placeholder", "generic"),
            ("https://open.feishu.cn.example.invalid/hook/placeholder", "generic"),
            (_WEBHOOK_URL, "generic"),
        )
        for url, expected in cases:
            with self.subTest(url=url):
                self.assertEqual(detect_webhook_format(url), expected)
        self.assertEqual(detect_webhook_format(cases[0][0], "slack"), "slack")

    def test_generic_payload_has_structured_fields_and_utc_timestamp(self) -> None:
        self.assertEqual(format_webhook_payload(_EVENT, _WEBHOOK_URL), {
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
        })

    def test_vendor_payload_shapes(self) -> None:
        text = "Plan approval needed\nThe run is waiting for your review.\nOpen the plan in Studio."
        cases = {
            "feishu": {"msg_type": "text", "content": {"text": text}},
            "wecom": {"msgtype": "text", "text": {"content": text}},
            "dingtalk": {"msgtype": "text", "text": {"content": text}},
            "slack": {"text": text},
            "discord": {"content": text},
        }
        for fmt, payload in cases.items():
            with self.subTest(fmt=fmt):
                self.assertEqual(format_webhook_payload(_EVENT, _WEBHOOK_URL, fmt), payload)

    def test_url_lookup_prefers_direct_then_environment_then_local_store(self) -> None:
        settings = NotificationSettings(webhook_url_env=_WEBHOOK_ENV)
        env_url = "https://alerts.example.invalid/from-environment"
        store_url = "https://alerts.example.invalid/from-store"
        with (
            tempfile.TemporaryDirectory() as folder,
            patch.dict(os.environ, {_WEBHOOK_ENV: env_url}),
        ):
            path = Path(folder) / "credentials.json"
            path.write_text(json.dumps({_WEBHOOK_ENV: store_url}), encoding="utf-8")
            self.assertEqual(resolve_webhook_url(replace(settings, webhook_url=_WEBHOOK_URL), path), _WEBHOOK_URL)
            self.assertEqual(resolve_webhook_url(settings, path), env_url)
            del os.environ[_WEBHOOK_ENV]
            self.assertEqual(resolve_webhook_url(settings, path), store_url)
            os.environ[_WEBHOOK_ENV] = ""
            self.assertEqual(resolve_webhook_url(settings, path), store_url)

    def test_mask_keeps_endpoint_without_credentials_path_query_or_fragment(self) -> None:
        url = "https://user:placeholder@alerts.example.invalid:8443/hook/placeholder?key=placeholder#fragment"
        self.assertEqual(mask_webhook_url(url), "https://alerts.example.invalid:8443/***")
        self.assertEqual(mask_webhook_url("https://[malformed-placeholder"), "***")


class TestNotificationGating(unittest.TestCase):
    def test_master_switch_covers_all_categories_including_test(self) -> None:
        settings = NotificationSettings(enabled=False)
        for category in ("waiting_human", "ready_for_final_gate", "failed", "paused", "long_cooldown", "test"):
            with self.subTest(category=category):
                self.assertFalse(should_notify(category, settings, wait_sec=300))
        self.assertTrue(should_notify("test", NotificationSettings()))

    def test_category_flags_and_unknown_category(self) -> None:
        settings = NotificationSettings()
        for category in ("waiting_human", "ready_for_final_gate", "failed", "paused"):
            with self.subTest(category=category):
                self.assertTrue(should_notify(category, settings))
                self.assertFalse(should_notify(category, replace(settings, **{f"on_{category}": False})))
        self.assertFalse(should_notify("unknown", settings))

    def test_long_cooldown_threshold_is_inclusive_and_positive(self) -> None:
        settings = NotificationSettings(on_long_cooldown_sec=300)
        self.assertFalse(should_notify("long_cooldown", settings))
        self.assertFalse(should_notify("long_cooldown", settings, wait_sec=299.9))
        self.assertTrue(should_notify("long_cooldown", settings, wait_sec=300))
        self.assertFalse(should_notify("long_cooldown", replace(settings, on_long_cooldown_sec=0), wait_sec=300))


class TestAttentionNotifier(unittest.TestCase):
    def test_notify_dispatches_all_three_channels_using_fakes(self) -> None:
        http_sender = FakeHttpSender()
        toast_runner = FakeToastRunner()
        bell_stream = FakeTty()
        notifier = AttentionNotifier(
            http_sender=http_sender,
            toast_runner=toast_runner,
            bell_stream=bell_stream,
            platform="win32",
        )
        settings = NotificationSettings(webhook_url=_WEBHOOK_URL, webhook_timeout_sec=2.5)

        result = notifier.notify(_EVENT, settings)

        self.assertEqual(result, NotificationResult(True, None, [
            {"channel": "webhook", "ok": True, "detail": "sent to https://alerts.example.invalid/***"},
            {"channel": "desktop_toast", "ok": True, "detail": "started"},
            {"channel": "terminal_bell", "ok": True, "detail": "rang"},
        ]))
        self.assertEqual(http_sender.calls, [(_WEBHOOK_URL, format_webhook_payload(_EVENT, _WEBHOOK_URL), 2.5)])
        self.assertEqual(toast_runner.calls, [(_EVENT.title, _EVENT.message)])
        self.assertEqual(bell_stream.getvalue(), "\a")

    def test_disabled_notifications_skip_channels(self) -> None:
        http_sender, toast_runner, bell_stream = FakeHttpSender(), FakeToastRunner(), FakeTty()
        notifier = AttentionNotifier(
            http_sender=http_sender, toast_runner=toast_runner, bell_stream=bell_stream, platform="win32",
        )
        settings = NotificationSettings(webhook_url=_WEBHOOK_URL)
        self.assertEqual(notifier.notify(_EVENT, replace(settings, enabled=False)),
                         NotificationResult(False, "disabled", []))
        self.assertEqual(notifier.notify(_EVENT, replace(settings, on_waiting_human=False)),
                         NotificationResult(False, "category_disabled", []))
        self.assertEqual(http_sender.calls, [])
        self.assertEqual(toast_runner.calls, [])
        self.assertEqual(bell_stream.getvalue(), "")

    def test_channel_failures_are_isolated_and_reported_without_secrets(self) -> None:
        http_sender = Mock(side_effect=RuntimeError(_WEBHOOK_URL))
        toast_runner = Mock(side_effect=RuntimeError(_WEBHOOK_URL))
        bell_stream = FakeTty()
        notifier = AttentionNotifier(
            http_sender=http_sender, toast_runner=toast_runner, bell_stream=bell_stream, platform="win32",
        )
        settings = NotificationSettings(webhook_url=_WEBHOOK_URL)
        with (
            patch.object(bell_stream, "write", side_effect=OSError(_WEBHOOK_URL)) as bell_write,
            self.assertLogs("vibebaton.notifier", level="WARNING") as logs,
        ):
            result = notifier.notify(_EVENT, settings)

        self.assertTrue(result.dispatched)
        self.assertEqual({item["channel"]: item["ok"] for item in result.channels}, {
            "webhook": False, "desktop_toast": False, "terminal_bell": False,
        })
        http_sender.assert_called_once()
        toast_runner.assert_called_once()
        bell_write.assert_called_once_with("\a")
        recorded = "\n".join([repr(settings), repr(result), *logs.output])
        self.assertIn("https://alerts.example.invalid/***", recorded)
        self.assertNotIn("private-path", recorded)
        self.assertNotIn("private-query", recorded)

    def test_non_windows_and_non_tty_are_silent_skips(self) -> None:
        bell_stream = io.StringIO()
        notifier = AttentionNotifier(bell_stream=bell_stream, platform="linux")
        with patch("vibebaton.notifier.subprocess.Popen") as popen:
            result = notifier.notify(_EVENT, NotificationSettings())
        popen.assert_not_called()
        self.assertEqual(bell_stream.getvalue(), "")
        self.assertEqual(result, NotificationResult(False, "no_channels", [
            {"channel": "desktop_toast", "ok": True, "detail": "skipped: not windows"},
            {"channel": "terminal_bell", "ok": True, "detail": "skipped: not a TTY"},
        ]))

    def test_missing_powershell_is_a_silent_skip(self) -> None:
        notifier = AttentionNotifier(platform="win32")
        with patch("vibebaton.notifier.subprocess.Popen", side_effect=FileNotFoundError) as popen:
            result = notifier.notify(_EVENT, NotificationSettings(terminal_bell=False))
        popen.assert_called_once()
        self.assertEqual(result, NotificationResult(False, "no_channels", [
            {"channel": "desktop_toast", "ok": True, "detail": "skipped: not windows"},
        ]))

    def test_default_http_sender_posts_json_with_timeout(self) -> None:
        settings = NotificationSettings(webhook_url=_WEBHOOK_URL, desktop_toast=False, terminal_bell=False)
        event = replace(_EVENT, message="Review the plan \u2713")
        with patch("vibebaton.notifier.urllib.request.urlopen") as urlopen:
            result = AttentionNotifier().notify(event, settings)
        urlopen.assert_called_once()
        request, = urlopen.call_args.args
        self.assertEqual(request.full_url, _WEBHOOK_URL)
        self.assertEqual(request.get_method(), "POST")
        self.assertEqual(request.get_header("Content-type"), "application/json")
        self.assertEqual(json.loads(request.data.decode("utf-8")), format_webhook_payload(event, _WEBHOOK_URL))
        self.assertEqual(urlopen.call_args.kwargs, {"timeout": 5.0})
        self.assertTrue(result.channels[0]["ok"])

    def test_default_toast_encodes_literal_strings_and_does_not_wait(self) -> None:
        event = replace(_EVENT, title="It's ready \u2019", message="Line one\r\n'$env:PATH'; `$literal")
        notifier = AttentionNotifier(platform="win32")
        with patch("vibebaton.notifier.subprocess.Popen") as popen:
            result = notifier.notify(event, NotificationSettings(terminal_bell=False))
        popen.assert_called_once()
        (args,) = popen.call_args.args
        self.assertFalse(popen.call_args.kwargs.get("shell", False))
        popen.return_value.wait.assert_not_called()
        script = base64.b64decode(args[args.index("-EncodedCommand") + 1], validate=True).decode("utf-16le")
        self.assertEqual(script, build_toast_script(event.title, event.message))
        self.assertIn("$icon.BalloonTipTitle = 'It''s ready \u2019\u2019'", script)
        self.assertIn("$icon.BalloonTipText = 'Line one\r\n''$env:PATH''; `$literal'", script)
        self.assertTrue(result.channels[0]["ok"])


if __name__ == "__main__":
    unittest.main()
