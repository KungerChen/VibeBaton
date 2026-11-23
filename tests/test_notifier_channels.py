"""Notification channel tests with injected toast, bell, and HTTP fakes."""

from __future__ import annotations

import io
import unittest
from dataclasses import replace
from typing import Any
from unittest.mock import Mock, patch

from vibebaton.config import NotificationSettings
from vibebaton.notifier import (
    AttentionEvent,
    AttentionNotifier,
    NotificationResult,
    build_toast_script,
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
_CATEGORIES = ("waiting_human", "ready_for_final_gate", "failed", "paused", "long_cooldown", "test")
_BOOLEAN_CATEGORIES = ("waiting_human", "ready_for_final_gate", "failed", "paused")


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


class ChannelTestCase(unittest.TestCase):
    """Fail any test that reaches the real subprocess-backed toast boundary."""

    def setUp(self) -> None:
        super().setUp()
        self._popen_patch = patch("subprocess.Popen")
        self._popen = self._popen_patch.start()
        self.addCleanup(self._popen_patch.stop)
        self.addCleanup(self._popen.assert_not_called)


class TestNotificationGating(ChannelTestCase):
    def test_master_switch_disables_every_category(self) -> None:
        settings = NotificationSettings(enabled=False)
        for category in _CATEGORIES:
            with self.subTest(category=category):
                self.assertFalse(should_notify(category, settings, wait_sec=300))
                self.assertFalse(should_notify(category, settings, wait_sec=None))
        self.assertTrue(should_notify("test", NotificationSettings()))

    def test_category_flags_gate_only_their_own_category(self) -> None:
        flags = {f"on_{category}": True for category in _BOOLEAN_CATEGORIES}
        for category in _BOOLEAN_CATEGORIES:
            for flag in flags:
                settings = replace(NotificationSettings(), **{flag: False})
                with self.subTest(category=category, flag=flag):
                    self.assertEqual(should_notify(category, settings), flag != f"on_{category}")
        self.assertFalse(should_notify("unknown", NotificationSettings()))

    def test_test_and_long_cooldown_ignore_boolean_category_flags(self) -> None:
        for flag in (f"on_{category}" for category in _BOOLEAN_CATEGORIES):
            settings = replace(NotificationSettings(), **{flag: False})
            with self.subTest(flag=flag):
                self.assertTrue(should_notify("test", settings))
                self.assertTrue(should_notify("long_cooldown", settings, wait_sec=300))
                self.assertFalse(should_notify(
                    "long_cooldown", replace(settings, on_long_cooldown_sec=0), wait_sec=300,
                ))

    def test_long_cooldown_threshold_gating(self) -> None:
        settings = NotificationSettings(on_long_cooldown_sec=300)
        cases = (
            (None, False),
            (0, False),
            (299.9, False),
            (300, True),
            (300.1, True),
            (3600, True),
        )
        for wait_sec, expected in cases:
            with self.subTest(wait_sec=wait_sec):
                self.assertEqual(should_notify("long_cooldown", settings, wait_sec=wait_sec), expected)

        never = replace(settings, on_long_cooldown_sec=0)
        for wait_sec in (None, 0, 300, 3600):
            with self.subTest(threshold=0, wait_sec=wait_sec):
                self.assertFalse(should_notify("long_cooldown", never, wait_sec=wait_sec))
        self.assertFalse(should_notify(
            "long_cooldown", replace(settings, on_long_cooldown_sec=-1), wait_sec=3600,
        ))


class TestDesktopToastChannel(ChannelTestCase):
    def test_injected_toast_runner_is_called_exactly_once(self) -> None:
        toast_runner = FakeToastRunner()
        notifier = AttentionNotifier(
            toast_runner=toast_runner, bell_stream=io.StringIO(), platform="win32",
        )

        result = notifier.notify(_EVENT, NotificationSettings(terminal_bell=False))

        self.assertEqual(toast_runner.calls, [(_EVENT.title, _EVENT.message)])
        self.assertEqual(result, NotificationResult(True, None, [
            {"channel": "desktop_toast", "ok": True, "detail": "started"},
        ]))
        self._popen.assert_not_called()

    def test_non_windows_platform_skips_toast_with_success_detail(self) -> None:
        toast_runner = FakeToastRunner()
        notifier = AttentionNotifier(toast_runner=toast_runner, platform="linux")

        result = notifier.notify(_EVENT, NotificationSettings(terminal_bell=False))

        self.assertEqual(toast_runner.calls, [])
        self.assertEqual(result, NotificationResult(False, "no_channels", [
            {"channel": "desktop_toast", "ok": True, "detail": "skipped: not windows"},
        ]))

    def test_disabled_desktop_toast_is_never_attempted(self) -> None:
        toast_runner = FakeToastRunner()
        notifier = AttentionNotifier(toast_runner=toast_runner, platform="win32")

        result = notifier.notify(_EVENT, NotificationSettings(desktop_toast=False, terminal_bell=False))

        # A disabled channel is omitted entirely; the observable skip is the no_channels reason.
        self.assertEqual(toast_runner.calls, [])
        self.assertEqual(result, NotificationResult(False, "no_channels", []))


class TestToastScriptEscaping(ChannelTestCase):
    def test_build_toast_script_doubles_ascii_and_typographic_quotes(self) -> None:
        script = build_toast_script("It's ready \u2019", "It\u2018s \u2018fine\u2019")

        self.assertIn("$icon.BalloonTipTitle = 'It''s ready \u2019\u2019'", script)
        self.assertIn("$icon.BalloonTipText = 'It\u2018\u2018s \u2018\u2018fine\u2019\u2019'", script)

    def test_injection_text_stays_inside_the_quoted_literal(self) -> None:
        title = "Status '; Remove-Item -Recurse -Force C:\\staging"
        message = "Line one\r\n'; Remove-Item -Recurse -Force C:\\staging; '\n$(Get-Process)\n'"
        script = build_toast_script(title, message)

        # Every quote is doubled, so neither field can close its single-quoted literal early.
        self.assertIn(
            "$icon.BalloonTipTitle = 'Status ''; Remove-Item -Recurse -Force C:\\staging'",
            script,
        )
        # Message newlines are legal data inside a PowerShell single-quoted string,
        # so the injected statements stay inside the assignment instead of becoming script lines.
        self.assertIn(
            "$icon.BalloonTipText = 'Line one\r\n''; Remove-Item -Recurse -Force C:\\staging; ''"
            "\n$(Get-Process)\n'''",
            script,
        )
        self.assertEqual(script.count("$icon.BalloonTipText"), 1)
        self.assertEqual(script.count("Remove-Item"), 2)


class TestTerminalBellChannel(ChannelTestCase):
    def test_tty_stream_receives_a_single_alert(self) -> None:
        bell_stream = FakeTty()
        notifier = AttentionNotifier(bell_stream=bell_stream, platform="linux")

        result = notifier.notify(_EVENT, NotificationSettings(desktop_toast=False, terminal_bell=True))

        self.assertEqual(bell_stream.getvalue(), "\a")
        self.assertEqual(result, NotificationResult(True, None, [
            {"channel": "terminal_bell", "ok": True, "detail": "rang"},
        ]))

    def test_non_tty_and_disabled_bell_write_nothing(self) -> None:
        non_tty = io.StringIO()
        notifier = AttentionNotifier(bell_stream=non_tty, platform="linux")

        result = notifier.notify(_EVENT, NotificationSettings(desktop_toast=False, terminal_bell=True))

        self.assertEqual(non_tty.getvalue(), "")
        self.assertEqual(result, NotificationResult(False, "no_channels", [
            {"channel": "terminal_bell", "ok": True, "detail": "skipped: not a TTY"},
        ]))

        bell_stream = FakeTty()
        notifier = AttentionNotifier(bell_stream=bell_stream, platform="win32")

        result = notifier.notify(_EVENT, NotificationSettings(desktop_toast=False, terminal_bell=False))

        self.assertEqual(bell_stream.getvalue(), "")
        self.assertEqual(result, NotificationResult(False, "no_channels", []))


class TestChannelErrorIsolation(ChannelTestCase):
    def test_toast_oserror_marks_only_toast_failed_and_other_channels_run(self) -> None:
        http_sender = FakeHttpSender()
        toast_runner = Mock(side_effect=OSError("toast unavailable"))
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

        self.assertTrue(result.dispatched)
        self.assertIsNone(result.skipped_reason)
        self.assertEqual({item["channel"]: item["ok"] for item in result.channels}, {
            "webhook": True,
            "desktop_toast": False,
            "terminal_bell": True,
        })
        toast = next(item for item in result.channels if item["channel"] == "desktop_toast")
        self.assertEqual(toast["detail"], "could not start toast")
        toast_runner.assert_called_once_with(_EVENT.title, _EVENT.message)
        self.assertEqual(bell_stream.getvalue(), "\a")
        self.assertEqual(len(http_sender.calls), 1)
        self.assertIn("desktop_toast notification failed", "\n".join(logs.output))
        self.assertNotIn("toast unavailable", repr(result))


class TestSkippedReason(ChannelTestCase):
    def test_master_switch_and_category_flag_populate_skipped_reason(self) -> None:
        http_sender = FakeHttpSender()
        toast_runner = FakeToastRunner()
        bell_stream = FakeTty()
        notifier = AttentionNotifier(
            http_sender=http_sender,
            toast_runner=toast_runner,
            bell_stream=bell_stream,
            platform="win32",
        )
        settings = NotificationSettings(webhook_url=_WEBHOOK_URL)

        self.assertEqual(
            notifier.notify(_EVENT, replace(settings, enabled=False)),
            NotificationResult(False, "disabled", []),
        )
        self.assertEqual(
            notifier.notify(_EVENT, replace(settings, on_waiting_human=False)),
            NotificationResult(False, "category_disabled", []),
        )
        cooldown_event = replace(_EVENT, category="long_cooldown")
        self.assertEqual(
            notifier.notify(cooldown_event, replace(settings, on_long_cooldown_sec=0)),
            NotificationResult(False, "category_disabled", []),
        )

        self.assertEqual(http_sender.calls, [])
        self.assertEqual(toast_runner.calls, [])
        self.assertEqual(bell_stream.getvalue(), "")


if __name__ == "__main__":
    unittest.main()
