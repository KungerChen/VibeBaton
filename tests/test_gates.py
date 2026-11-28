"""Integration coverage for shell commands loaded from milestone plans."""

from __future__ import annotations

import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from vibebaton.gates import (
    _decode_process_output,
    _find_windows_posix_bash,
    _looks_like_posix_shell,
    run_gate_command,
)


_REPO = Path(__file__).resolve().parents[1]


@unittest.skipUnless(sys.platform == "win32", "Requires cmd.exe")
class WindowsPythonGateTests(unittest.IsolatedAsyncioTestCase):
    async def test_saved_gate_validates_the_golden_case_graph(self) -> None:
        command = (
            r'cmd /c "set PYTHONPATH=src&& set PYTHONUTF8=1&& '
            r'set VIBEBATON_DISABLE_PRICING_SYNC=1&& python -c \"'
            "import json,pathlib,sys; sys.path.insert(0,'src'); "
            "from vibebaton.graph_schema import WorkflowGraph, validate_graph; "
            "b=json.loads(pathlib.Path('tests/fixtures/golden_case_bundle.json').read_text(encoding='utf-8')); "
            "r=validate_graph(WorkflowGraph.from_dict(b['graph'])); assert r.valid, r.errors; "
            "print('golden graph valid for both validators')"
            r'\""'
        )

        result = await run_gate_command(command, _REPO, timeout_sec=30)

        self.assertEqual(result.command, command)
        self.assertTrue(result.passed, result.stderr)
        self.assertEqual(result.exit_code, 0)
        self.assertEqual(result.stdout.strip(), "golden graph valid for both validators")

    async def test_saved_gate_reports_the_python_assertion(self) -> None:
        command = (
            r'cmd /c "set VIBEBATON_TEST_GATE=invalid&& python -c \"'
            "import os; assert os.environ['VIBEBATON_TEST_GATE'] == 'valid', 'invalid graph && trace'"
            r'\""'
        )

        result = await run_gate_command(command, _REPO, timeout_sec=30)

        self.assertFalse(result.passed)
        self.assertEqual(result.exit_code, 1)
        self.assertIn("AssertionError: invalid graph && trace", result.stderr)

    def test_named_golden_case_gate_runs_on_windows_shell(self) -> None:
        command = (
            'cmd /c "set PYTHONPATH=src&& set PYTHONUTF8=1&& '
            'set VIBEBATON_DISABLE_PRICING_SYNC=1&& '
            'python -m unittest tests.test_case_export.CaseExportTests.test_golden_fixture -v"'
        )
        # Exercise the host shell without relying on the legacy command rewrite.
        result = subprocess.run(
            command,
            shell=True,
            cwd=_REPO,
            capture_output=True,
            encoding="utf-8",
            timeout=60,
        )

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("test_golden_fixture", result.stderr)
        self.assertIn("Ran 1 test", result.stderr)

    @unittest.skipUnless(_find_windows_posix_bash() is not None, "Requires Git Bash on Windows")
    async def test_posix_if_fi_gate_runs_under_git_bash(self) -> None:
        command = (
            '(git status --short || ls -la) && '
            '(if [ -f package.json ]; then npm test --if-present; '
            'elif [ -f pyproject.toml ]; then python -m unittest discover; '
            'else echo "Smoke check passed"; fi)'
        )
        with tempfile.TemporaryDirectory() as tmp:
            result = await run_gate_command(command, Path(tmp), timeout_sec=30)

        self.assertTrue(result.passed, f"stderr={result.stderr!r} stdout={result.stdout!r}")
        self.assertEqual(result.exit_code, 0)
        self.assertIn("Smoke check passed", result.stdout)

    @unittest.skipUnless(_find_windows_posix_bash() is not None, "Requires Git Bash on Windows")
    async def test_posix_test_z_command_substitution_runs_under_git_bash(self) -> None:
        command = 'test -z "$(printf "" | grep -v -E "^keep")"'
        with tempfile.TemporaryDirectory() as tmp:
            result = await run_gate_command(command, Path(tmp), timeout_sec=30)

        self.assertTrue(result.passed, f"stderr={result.stderr!r} stdout={result.stdout!r}")
        self.assertEqual(result.exit_code, 0)


class PosixGateDetectionAndDecodingTests(unittest.TestCase):
    def test_looks_like_posix_shell_classification(self) -> None:
        posix_commands = [
            '(git status --short || ls -la) && (if [ -f package.json ]; then npm test --if-present; elif [ -f pyproject.toml ]; then python -m unittest discover; else echo "Smoke check passed"; fi)',
            'test -z "$(git status --porcelain --untracked-files=all | grep -v -E \'^(\\\\?\\\\?|A |M ) (ledger/|package\\\\.json$)\')"',
            "FOO=bar python -c \"import os; print(os.environ['FOO'])\"",
            "git status --short | grep -q main",
        ]
        for cmd in posix_commands:
            with self.subTest(posix=cmd):
                self.assertTrue(_looks_like_posix_shell(cmd))

        cross_platform_commands = [
            "python -m unittest discover -s tests",
            "npm test",
            "node --test ledger/test/integration.test.js",
            "git status --short",
            'cmd /c "set A=1&& python -c \\"print(1)\\""',
            'powershell -Command "Write-Output ok"',
        ]
        for cmd in cross_platform_commands:
            with self.subTest(cross_platform=cmd):
                self.assertFalse(_looks_like_posix_shell(cmd))

    def test_decode_process_output_utf8_and_gbk_fallback(self) -> None:
        self.assertEqual(_decode_process_output("此时不应有 -f。".encode("utf-8")), "此时不应有 -f。")
        gbk_bytes = "此时不应有 -f。".encode("gbk")
        with patch("vibebaton.gates.sys.platform", "win32"), patch(
            "vibebaton.gates.locale.getpreferredencoding", return_value="cp936"
        ):
            self.assertEqual(_decode_process_output(gbk_bytes), "此时不应有 -f。")
