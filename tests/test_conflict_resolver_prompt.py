"""Contract checks for the merge-conflict resolver prompt."""

from __future__ import annotations

import re
import unittest
from pathlib import Path

PROMPTS_DIR = Path(__file__).resolve().parents[1] / "prompts"
CONFLICT_RESOLVER_PROMPT = PROMPTS_DIR / "l2_conflict_resolver.md"
MARKER_TOKENS = ("<<<<<<< ", "=======", ">>>>>>> ")
API_KEY_PATTERN = re.compile(r"\bsk-[A-Za-z0-9_-]{8,}", re.IGNORECASE)


class TestConflictResolverPrompt(unittest.TestCase):
    def setUp(self) -> None:
        self.path = CONFLICT_RESOLVER_PROMPT
        self.assertTrue(self.path.is_file(), f"missing prompt: {self.path}")
        self.text = self.path.read_text(encoding="utf-8")

    def test_prompt_is_concise_and_utf8(self) -> None:
        self.assertLess(len(self.text.splitlines()), 80)
        self.assertTrue(self.text.strip())

    def test_prompt_mentions_all_conflict_markers(self) -> None:
        for marker in MARKER_TOKENS:
            with self.subTest(marker=marker):
                self.assertIn(marker, self.text)

    def test_prompt_requires_intent_synthesis_and_test_preservation(self) -> None:
        lowered = self.text.lower()
        self.assertIn("synthesize both branches' intents", lowered)
        self.assertIn("tests", lowered)
        self.assertIn("never delete", lowered)
        self.assertIn("zero unrelated edits", self.text)
        for command in ("git commit", "git merge", "git rebase", "git checkout"):
            with self.subTest(command=command):
                self.assertIn(command, lowered)

    def test_prompt_leaks_no_provider_name_or_api_key(self) -> None:
        self.assertNotIn("opencode", self.text.lower())
        self.assertIsNone(API_KEY_PATTERN.search(self.text))

    def test_every_prompt_is_non_empty_and_readable(self) -> None:
        prompt_files = sorted(path for path in PROMPTS_DIR.iterdir() if path.is_file())
        self.assertTrue(prompt_files)
        for path in prompt_files:
            with self.subTest(prompt=path.name):
                self.assertGreater(path.stat().st_size, 0)
                self.assertTrue(path.read_text(encoding="utf-8").strip())


if __name__ == "__main__":
    unittest.main()
