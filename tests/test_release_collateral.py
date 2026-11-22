"""Contract tests for the VibeBaton v1.0.0 release collateral."""

from __future__ import annotations

import re
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
CHANGELOG = REPO_ROOT / "CHANGELOG.md"
RELEASE_NOTES = REPO_ROOT / "docs" / "RELEASE_NOTES_v1.0.md"
README = REPO_ROOT / "README.md"
ROADMAP = REPO_ROOT / "docs" / "ROADMAP.md"

VERSIONS = ("v0.1-seed", "v0.2.0", "v0.3.0", "v0.9.0-beta", "v1.0.0")
API_KEY_PATTERN = re.compile(r"sk-[A-Za-z0-9]{20,}")


def _read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


class TestChangelog(unittest.TestCase):
    def test_all_version_headings_appear_in_order(self) -> None:
        text = _read(CHANGELOG)
        offsets = []
        for version in VERSIONS:
            heading = re.search(
                rf"^## \[{re.escape(version)}\] - \d{{4}}-\d{{2}}-\d{{2}}$",
                text,
                re.MULTILINE,
            )
            self.assertIsNotNone(heading, f"CHANGELOG.md is missing a dated heading for {version}")
            offsets.append(heading.start())
        self.assertEqual(
            offsets,
            sorted(offsets),
            "CHANGELOG.md version headings must follow release order",
        )


class TestReleaseNotes(unittest.TestCase):
    def test_release_notes_exist_and_cover_the_launch(self) -> None:
        self.assertTrue(RELEASE_NOTES.is_file(), f"missing {RELEASE_NOTES}")
        text = _read(RELEASE_NOTES).lower()
        for needle in ("sandbox init", "install.ps1", "http"):
            with self.subTest(needle=needle):
                self.assertIn(needle, text)


class TestReadmeAndRoadmap(unittest.TestCase):
    def test_readme_advertises_v1_install_and_sandbox(self) -> None:
        text = _read(README)
        for needle in ("1.0.0", "sandbox init", "scripts/install.ps1"):
            with self.subTest(needle=needle):
                self.assertIn(needle, text)

    def test_roadmap_marks_stage_4_as_released(self) -> None:
        text = _read(ROADMAP)
        self.assertIn("v1.0.0", text)
        self.assertIn("正式发布", text)
        self.assertIn("2026-11-22", text)


class TestSecretHygiene(unittest.TestCase):
    def test_release_docs_contain_no_api_keys(self) -> None:
        for path in (CHANGELOG, RELEASE_NOTES, README, ROADMAP):
            with self.subTest(path=path.name):
                self.assertIsNone(
                    API_KEY_PATTERN.search(_read(path)),
                    f"{path} contains an API-key-shaped string",
                )


if __name__ == "__main__":
    unittest.main()
