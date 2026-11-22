"""Contract tests for the `baton sandbox init` CLI command."""

from __future__ import annotations

import contextlib
import io
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import vibebaton
from vibebaton import cli
from vibebaton.sandbox import SANDBOX_FILES, SANDBOX_TEMPLATES

PROJECT_ROOT = Path(__file__).resolve().parents[1]
SOURCE_ROOT = Path(vibebaton.__file__).resolve().parents[1]
EXISTING_COMMANDS = (
    "init",
    "doctor",
    "run",
    "daemon",
    "status",
    "resolve",
    "report",
    "mcp",
    "promote-seed",
    "presets",
    "graph",
    "ui",
)


def _run_cli(argv: list[str]) -> tuple[int, str]:
    """Run the CLI in-process and return its exit code and captured stdout."""
    buffer = io.StringIO()
    with contextlib.redirect_stdout(buffer):
        exit_code = cli.main(argv)
    return exit_code, buffer.getvalue()


class TestSandboxInitCommand(unittest.TestCase):
    def setUp(self) -> None:
        self.repo = Path(self.enterContext(tempfile.TemporaryDirectory())).resolve()

    def test_init_writes_scaffold_files_and_prints_their_paths(self) -> None:
        exit_code, output = _run_cli(["sandbox", "init", "--repo", str(self.repo)])

        self.assertEqual(exit_code, 0, output)
        for rel in SANDBOX_FILES:
            with self.subTest(path=rel):
                target = self.repo / rel
                self.assertTrue(target.is_file())
                self.assertIn(str(target), output)

    def test_rerun_without_force_reports_existing_files(self) -> None:
        self.assertEqual(_run_cli(["sandbox", "init", "--repo", str(self.repo)])[0], 0)
        dockerfile = self.repo / "sandbox/Dockerfile"
        dockerfile.write_text("FROM scratch\n", encoding="utf-8")

        exit_code, output = _run_cli(["sandbox", "init", "--repo", str(self.repo)])

        self.assertEqual(exit_code, 0, output)
        self.assertIn("exist", output.lower())
        self.assertIn("--force", output)
        self.assertEqual(dockerfile.read_text(encoding="utf-8"), "FROM scratch\n")

    def test_force_overwrites_existing_files(self) -> None:
        self.assertEqual(_run_cli(["sandbox", "init", "--repo", str(self.repo)])[0], 0)
        dockerfile = self.repo / "sandbox/Dockerfile"
        dockerfile.write_text("FROM scratch\n", encoding="utf-8")

        exit_code, output = _run_cli(
            ["sandbox", "init", "--repo", str(self.repo), "--force"]
        )

        self.assertEqual(exit_code, 0, output)
        self.assertEqual(
            dockerfile.read_bytes(),
            SANDBOX_TEMPLATES["sandbox/Dockerfile"].encode("utf-8"),
        )

    def test_value_error_returns_two(self) -> None:
        stderr = io.StringIO()
        with (
            patch(
                "vibebaton.sandbox.init_sandbox_files",
                side_effect=ValueError("outside the repository"),
            ),
            contextlib.redirect_stderr(stderr),
        ):
            exit_code, output = _run_cli(["sandbox", "init", "--repo", str(self.repo)])

        self.assertEqual(exit_code, 2, output)
        self.assertIn("outside the repository", stderr.getvalue())


class TestSandboxHelp(unittest.TestCase):
    def test_top_level_help_lists_existing_commands_and_sandbox(self) -> None:
        buffer = io.StringIO()
        with contextlib.redirect_stdout(buffer), self.assertRaises(SystemExit) as raised:
            cli.main(["--help"])

        self.assertEqual(raised.exception.code, 0)
        output = buffer.getvalue()
        section = output.split("positional arguments:", 1)[1].split("\n\n", 1)[0]
        listed = [
            line.split()[0]
            for line in section.splitlines()
            if line.startswith("    ") and not line.startswith("     ")
        ]
        self.assertEqual(listed, [*EXISTING_COMMANDS, "sandbox"])

    def test_module_sandbox_init_help_exits_zero(self) -> None:
        env = dict(os.environ)
        inherited_path = env.get("PYTHONPATH")
        env["PYTHONPATH"] = (
            f"{SOURCE_ROOT}{os.pathsep}{inherited_path}" if inherited_path else str(SOURCE_ROOT)
        )
        result = subprocess.run(
            [sys.executable, "-m", "vibebaton", "sandbox", "init", "--help"],
            capture_output=True,
            text=True,
            cwd=str(PROJECT_ROOT),
            env=env,
        )

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("--repo", result.stdout)
        self.assertIn("--force", result.stdout)


if __name__ == "__main__":
    unittest.main()
