"""Static and dry-run assertions for the Windows one-click installer."""

from __future__ import annotations

import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
INSTALL_SCRIPT = REPO_ROOT / "scripts" / "install.ps1"

REQUIRED_SNIPPETS = (
    "param(",
    "$DryRun",
    "$RepoPath",
    "$SkipWeb",
    "$AddToUserPath",
    "Set-StrictMode -Version Latest",
    "git --version",
    "npm.cmd",
    "baton --version",
    "doctor --help",
)

FORBIDDEN_SNIPPETS = (
    "npm install",
    "Start-Process -Verb RunAs",
    "HKLM",
)


def _script_text() -> str:
    return INSTALL_SCRIPT.read_text(encoding="utf-8-sig")


def _user_path() -> tuple[str, int] | None:
    if sys.platform != "win32":
        return None

    import winreg

    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, "Environment") as key:
            return winreg.QueryValueEx(key, "Path")
    except FileNotFoundError:
        return None


class TestInstallScriptContents(unittest.TestCase):
    def test_script_exists(self) -> None:
        self.assertTrue(INSTALL_SCRIPT.is_file(), "scripts/install.ps1 is missing")

    def test_script_is_utf8_with_optional_bom(self) -> None:
        self.assertTrue(INSTALL_SCRIPT.is_file(), "scripts/install.ps1 is missing")
        raw = INSTALL_SCRIPT.read_bytes()
        try:
            text = raw.decode("utf-8-sig")
        except UnicodeDecodeError as error:
            self.fail(f"scripts/install.ps1 is not valid UTF-8: {error}")
        self.assertTrue(text.strip(), "scripts/install.ps1 is empty")

    def test_script_contains_required_parameters_and_commands(self) -> None:
        text = _script_text()
        self.assertRegex(text, r"3,\s*11|3\.11")
        for snippet in REQUIRED_SNIPPETS:
            with self.subTest(snippet=snippet):
                self.assertIn(snippet, text)

    def test_script_avoids_admin_elevation_and_automatic_node_installs(self) -> None:
        text = _script_text()
        for snippet in FORBIDDEN_SNIPPETS:
            with self.subTest(snippet=snippet):
                self.assertNotIn(snippet.lower(), text.lower())
        self.assertNotRegex(text, r"(?i)\bnpm\.cmd\s+install\b")


class TestInstallScriptDryRun(unittest.TestCase):
    def setUp(self) -> None:
        powershell = shutil.which("powershell.exe")
        if powershell is None:
            self.skipTest("Windows PowerShell (powershell.exe) is unavailable")
        self.powershell = powershell

    def _dry_run(self, *options: str, cwd: Path = REPO_ROOT) -> str:
        result = subprocess.run(
            [
                self.powershell,
                "-NoProfile",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
                str(INSTALL_SCRIPT),
                "-DryRun",
                *options,
            ],
            cwd=cwd,
            capture_output=True,
            text=True,
            errors="replace",
            timeout=30,
        )
        output = result.stdout + result.stderr
        self.assertEqual(result.returncode, 0, output)
        self.assertIn("DRYRUN:", output)
        return output

    def test_dry_run_exits_zero_and_echoes_planned_commands(self) -> None:
        output = self._dry_run("-RepoPath", str(REPO_ROOT))
        for step in range(1, 7):
            with self.subTest(step=step):
                self.assertIn(f"[{step}/6]", output)
        self.assertIn("-m pip install -e", output)
        self.assertIn("DRYRUN: baton --version", output)
        self.assertIn("DRYRUN: baton doctor --help", output)
        self.assertNotIn("to the user PATH", output)

    def test_dry_run_defaults_to_the_script_repository(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            output = self._dry_run("-SkipWeb", cwd=Path(temp_dir))
        self.assertIn(' -m pip install -e "', output)

    def test_dry_run_leaves_relative_repo_and_user_path_unchanged(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            repo = Path(temp_dir) / "repo with spaces"
            (repo / "web" / "node_modules").mkdir(parents=True)
            (repo / "pyproject.toml").touch()
            files_before = set(repo.rglob("*"))
            path_before = _user_path()

            output = self._dry_run("-RepoPath", ".", "-SkipWeb", "-AddToUserPath", cwd=repo)

            self.assertIn('DRYRUN: add "', output)
            self.assertIn(r'\repo with spaces\.venv\Scripts" to the user PATH', output)
            self.assertIn("Skipping the Web UI build (-SkipWeb).", output)
            self.assertNotIn("DRYRUN: npm.cmd run build", output)
            self.assertEqual(set(repo.rglob("*")), files_before)
            self.assertTrue(_user_path() == path_before, "Dry run changed the user PATH")
