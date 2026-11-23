"""Integration coverage for shell commands loaded from milestone plans."""

from __future__ import annotations

import subprocess
import sys
import unittest
from pathlib import Path

from vibebaton.gates import run_gate_command


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
