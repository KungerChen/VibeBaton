"""Contract tests for the VibeBaton v1.0.0 release collateral."""

from __future__ import annotations

import re
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
CHANGELOG = REPO_ROOT / "CHANGELOG.md"
RELEASE_NOTES = REPO_ROOT / "docs" / "RELEASE_NOTES_v1.0.md"
README = REPO_ROOT / "README.md"
README_ZH = REPO_ROOT / "README.zh-CN.md"
ROADMAP = REPO_ROOT / "docs" / "ROADMAP.md"
TUTORIAL = REPO_ROOT / "docs" / "TUTORIAL.md"

VERSIONS = (
    "v0.1-seed",
    "v0.2.0",
    "v0.3.0",
    "v0.9.0-beta",
    "v1.0.0",
    "v1.0.1",
    "v1.0.2",
    "v1.0.3",
    "v1.0.4",
    "v1.1.0",
    "v1.2.0",
)
# Stage 6 (v1.2.0) features each user-facing doc must mention; any listed alternative satisfies a topic.
STAGE6_DOCS = (README, README_ZH, ROADMAP, TUTORIAL)
STAGE6_TOPICS = {
    "Guided Mode": ("Guided", "引导模式"),
    "CLI registry": ("CLI Registry", "CLI 注册表"),
    "glossary": ("Glossary", "术语"),
}
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

    def test_v1_2_0_heading_is_dated_2026_11_24(self) -> None:
        self.assertRegex(_read(CHANGELOG), re.compile(r"^## \[v1\.2\.0\] - 2026-11-24$", re.MULTILINE))


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


class TestStage6Docs(unittest.TestCase):
    def test_docs_cover_guided_mode_cli_registry_and_glossary(self) -> None:
        for path in STAGE6_DOCS:
            text = _read(path).casefold()
            for topic, needles in STAGE6_TOPICS.items():
                with self.subTest(doc=path.name, topic=topic):
                    self.assertTrue(
                        any(needle.casefold() in text for needle in needles),
                        f"{path.name} must mention {topic} (one of {needles})",
                    )


class TestRollbackSemantics(unittest.TestCase):
    """Studio rollback resets to the approval-time base head, never to the run-start backup tag."""

    # Wording that wrongly claims rollback resets the base branch to the run-start tag.
    FORBIDDEN = {
        CHANGELOG: ("restores the base branch to", "tag created when the run started"),
        README: ("restores the base branch to", "tag created when the run started"),
        README_ZH: ("恢复到运行启动时创建的",),
    }
    # Wording that states the real contract: restore the base commit recorded at approval.
    REQUIRED = {
        CHANGELOG: "base commit recorded at approval",
        README: "base commit recorded at approval",
        README_ZH: "批准前记录的基准提交",
        ROADMAP: "批准前记录的基准提交",
        TUTORIAL: "批准前记录的基准提交",
    }

    def test_docs_do_not_claim_rollback_resets_to_run_start_tag(self) -> None:
        for path, phrases in self.FORBIDDEN.items():
            text = re.sub(r"\s+", " ", _read(path))
            for phrase in phrases:
                with self.subTest(doc=path.name, phrase=phrase):
                    self.assertNotIn(phrase, text)

    def test_docs_describe_rollback_as_restoring_approval_time_base(self) -> None:
        for path, phrase in self.REQUIRED.items():
            with self.subTest(doc=path.name):
                self.assertIn(phrase, re.sub(r"\s+", " ", _read(path)))


class TestSecretHygiene(unittest.TestCase):
    def test_release_docs_contain_no_api_keys(self) -> None:
        for path in (CHANGELOG, RELEASE_NOTES, README, README_ZH, ROADMAP, TUTORIAL):
            with self.subTest(path=path.name):
                self.assertIsNone(
                    API_KEY_PATTERN.search(_read(path)),
                    f"{path} contains an API-key-shaped string",
                )


if __name__ == "__main__":
    unittest.main()
