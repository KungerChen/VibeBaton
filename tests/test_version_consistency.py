"""Keep the published release metadata and CLI version in sync."""

from __future__ import annotations

import json
import re
import subprocess
import sys
import tomllib
import unittest
from pathlib import Path

from vibebaton import __version__

REPO = Path(__file__).resolve().parents[1]
RELEASE_VERSION = "1.0.1"


class TestVersionConsistency(unittest.TestCase):
    def test_release_versions_agree(self) -> None:
        with (REPO / "pyproject.toml").open("rb") as manifest:
            project_version = tomllib.load(manifest)["project"]["version"]
        package_version = json.loads((REPO / "web" / "package.json").read_text(encoding="utf-8"))["version"]
        changelog = (REPO / "CHANGELOG.md").read_text(encoding="utf-8")
        releases = re.findall(r"^## \[v(\d+\.\d+\.\d+)\] - \d{4}-\d{2}-\d{2}$", changelog, re.MULTILINE)
        self.assertTrue(releases, "CHANGELOG.md must contain a dated stable release heading")

        versions = {
            "pyproject.toml": project_version,
            "src/vibebaton/__init__.py": __version__,
            "web/package.json": package_version,
            "CHANGELOG.md": max(releases, key=lambda version: tuple(map(int, version.split(".")))),
        }
        for source, version in versions.items():
            with self.subTest(source=source):
                self.assertEqual(version, RELEASE_VERSION)

    def test_cli_prints_release_version(self) -> None:
        result = subprocess.run(
            [sys.executable, "-m", "vibebaton", "--version"],
            cwd=REPO,
            capture_output=True,
            text=True,
            encoding="utf-8",
            timeout=10,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), f"vibebaton {RELEASE_VERSION}")
