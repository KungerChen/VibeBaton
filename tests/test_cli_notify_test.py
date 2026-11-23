"""Contract tests for the `baton notify-test` CLI command."""

from __future__ import annotations

import contextlib
import io
import runpy
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from vibebaton import cli
from vibebaton.notifier import AttentionNotifier, NotificationResult, mask_webhook_url

WEBHOOK_URL = "https://hooks.example.invalid/services/T000/B000/private-token"


def _refuse_http(*_: object) -> None:
    raise AssertionError("notify-test must not perform a real HTTP request")


class FakeNotifier:
    """Return fixed channel results and record the delivered event and settings."""

    def __init__(self, channels: list[dict[str, object]]) -> None:
        self.channels = channels
        self.calls: list[tuple[object, object]] = []

    def notify(self, event: object, settings: object) -> NotificationResult:
        self.calls.append((event, settings))
        return NotificationResult(True, None, list(self.channels))


def _run_notify_test(
    argv: list[str], notifier: FakeNotifier | AttentionNotifier
) -> tuple[int, str]:
    """Run the subcommand in-process with an injected notifier."""
    args = cli.build_parser().parse_args(["notify-test", *argv])
    buffer = io.StringIO()
    with contextlib.redirect_stdout(buffer):
        exit_code = cli.run_notify_test(args, notifier=notifier)
    return exit_code, buffer.getvalue()


class TestNotifyTestCommand(unittest.TestCase):
    def setUp(self) -> None:
        self.repo = Path(self.enterContext(tempfile.TemporaryDirectory())).resolve()

    def test_all_channels_ok_returns_zero_and_prints_ok_rows(self) -> None:
        notifier = FakeNotifier(
            [
                {
                    "channel": "webhook",
                    "ok": True,
                    "detail": f"sent to {mask_webhook_url(WEBHOOK_URL)}",
                },
                {"channel": "desktop_toast", "ok": True, "detail": "started"},
                {"channel": "terminal_bell", "ok": True, "detail": "rang"},
            ]
        )

        exit_code, output = _run_notify_test(
            ["--repo", str(self.repo), "--webhook-url", WEBHOOK_URL, "--message", "hello"],
            notifier,
        )

        self.assertEqual(exit_code, 0, output)
        self.assertIn("OK   webhook  ", output)
        self.assertIn("OK   toast  started", output)
        self.assertIn("OK   bell  rang", output)
        event, settings = notifier.calls[0]
        self.assertEqual(event.run_id, "notify-test")
        self.assertEqual(event.category, "test")
        self.assertEqual(event.severity, "info")
        self.assertEqual(event.title, "VibeBaton notification test")
        self.assertEqual(event.message, "hello")
        self.assertEqual(event.action_hint, "No action required")
        self.assertEqual(settings.webhook_url, WEBHOOK_URL)

    def test_explicit_webhook_ok_with_failing_toast_returns_zero(self) -> None:
        notifier = FakeNotifier(
            [
                {
                    "channel": "webhook",
                    "ok": True,
                    "detail": f"sent to {mask_webhook_url(WEBHOOK_URL)}",
                },
                {"channel": "desktop_toast", "ok": False, "detail": "could not start toast"},
            ]
        )

        exit_code, output = _run_notify_test(
            ["--repo", str(self.repo), "--webhook-url", WEBHOOK_URL], notifier
        )

        self.assertEqual(exit_code, 0, output)
        self.assertIn("OK   webhook  ", output)
        self.assertIn("FAIL toast  could not start toast", output)

    def test_skipped_channels_are_reported_and_exit_zero(self) -> None:
        notifier = FakeNotifier(
            [
                {"channel": "desktop_toast", "ok": True, "detail": "skipped: not windows"},
                {"channel": "terminal_bell", "ok": True, "detail": "skipped: not a TTY"},
            ]
        )

        exit_code, output = _run_notify_test(["--repo", str(self.repo)], notifier)

        self.assertEqual(exit_code, 0, output)
        self.assertIn("SKIP toast  skipped: not windows", output)
        self.assertIn("SKIP bell  skipped: not a TTY", output)

    def test_disabled_notifications_with_explicit_webhook_prints_skip_row(self) -> None:
        config_path = self.repo / ".baton" / "baton.toml"
        config_path.parent.mkdir(parents=True)
        config_path.write_text("[notifications]\nenabled = false\n", encoding="utf-8")
        notifier = AttentionNotifier(http_sender=_refuse_http)

        exit_code, output = _run_notify_test(
            [
                "--repo",
                str(self.repo),
                "--config",
                str(config_path),
                "--webhook-url",
                WEBHOOK_URL,
            ],
            notifier,
        )

        self.assertEqual(exit_code, 0, output)
        self.assertEqual(output.splitlines(), ["SKIP webhook  skipped: disabled"])
        self.assertNotIn("private-token", output)

    def test_failing_webhook_returns_one_and_masks_the_secret_path(self) -> None:
        notifier = FakeNotifier(
            [
                {"channel": "webhook", "ok": False, "detail": f"delivery failed to {WEBHOOK_URL}"},
            ]
        )

        exit_code, output = _run_notify_test(
            ["--repo", str(self.repo), "--webhook-url", WEBHOOK_URL], notifier
        )

        self.assertEqual(exit_code, 1, output)
        self.assertIn("FAIL webhook  ", output)
        self.assertNotIn("private-token", output)
        self.assertIn(mask_webhook_url(WEBHOOK_URL), output)

    def test_malformed_webhook_url_returns_one_without_a_notifier_call(self) -> None:
        for bad_url in (
            "hooks.example.invalid/services/private-token",
            "ftp://hooks.example.invalid/services/private-token",
        ):
            with self.subTest(url=bad_url):
                notifier = FakeNotifier([])
                args = cli.build_parser().parse_args(
                    ["notify-test", "--repo", str(self.repo), "--webhook-url", bad_url]
                )
                stdout = io.StringIO()
                stderr = io.StringIO()
                with (
                    contextlib.redirect_stdout(stdout),
                    contextlib.redirect_stderr(stderr),
                ):
                    exit_code = cli.run_notify_test(args, notifier=notifier)

                self.assertEqual(exit_code, 1)
                self.assertEqual(notifier.calls, [])
                self.assertEqual(stdout.getvalue(), "")
                self.assertIn("HTTP(S)", stderr.getvalue())
                self.assertNotIn("private-token", stderr.getvalue())


class TestNotifyTestHelp(unittest.TestCase):
    def test_help_documents_options_and_exits_zero(self) -> None:
        buffer = io.StringIO()
        with contextlib.redirect_stdout(buffer), self.assertRaises(SystemExit) as raised:
            cli.main(["notify-test", "--help"])

        self.assertEqual(raised.exception.code, 0)
        output = buffer.getvalue()
        self.assertIn("notify-test", output)
        for option in ("--repo", "--config", "--webhook-url", "--message"):
            with self.subTest(option=option):
                self.assertIn(option, output)

    def test_module_notify_test_help_exits_zero(self) -> None:
        stdout = io.StringIO()
        stderr = io.StringIO()
        argv = ["vibebaton", "notify-test", "--help"]
        with (
            patch.object(sys, "argv", argv),
            contextlib.redirect_stdout(stdout),
            contextlib.redirect_stderr(stderr),
            self.assertRaises(SystemExit) as raised,
        ):
            runpy.run_module("vibebaton", run_name="__main__")

        self.assertEqual(raised.exception.code, 0, stderr.getvalue())
        output = stdout.getvalue()
        self.assertIn("notify-test", output)
        for option in ("--repo", "--config", "--webhook-url", "--message"):
            with self.subTest(option=option):
                self.assertIn(option, output)


if __name__ == "__main__":
    unittest.main()
