"""Table-driven tests for the brainstorm guide's optional ``size`` field."""

from __future__ import annotations

import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from vibebaton.brainstorm import OFFLINE_ENV_VARS, brainstorm_turn


_ABSENT = object()


class BrainstormGuideSizeTests(unittest.TestCase):
    """Parse size from model replies without changing the other guide fields."""

    RFC = (
        "# Health endpoint\n\n## Goals\n- Add a health endpoint.\n\n"
        "## Constraints\n- Use stdlib.\n\n## Non-Goals\n- No authentication.\n\n"
        "## Architecture & Deliverables\n- Add a route.\n\n"
        "## Verification & Acceptance Criteria\n1. Run tests.\n"
    )

    def setUp(self) -> None:
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.repo = Path(temporary.name)

    def _live(self, text: str) -> dict:
        with patch.dict(os.environ, {name: "" for name in OFFLINE_ENV_VARS}):
            result = brainstorm_turn(
                self.repo,
                [{"role": "user", "content": "Add a health endpoint"}],
                dispatch=lambda prompt: ("codex_sub", text),
            )
        self.assertFalse(result["offline"])
        self.assertIsNone(result["error"])
        return result

    def _live_guide(self, guide: dict | str) -> dict:
        payload = guide if isinstance(guide, str) else json.dumps(guide)
        return self._live(f"Reply.\n```guide\n{payload}\n```\n````rfc\n{self.RFC}````\n")["guide"]

    def _base_guide(self) -> dict:
        return {
            "question": "Who will call this endpoint?",
            "options": ["Monitoring only", "Users", "Both", "Other teams", "A fifth one"],
            "checklist": [
                {"id": "what", "status": "clear", "value": "A /health endpoint"},
                {"id": "who", "status": "clear", "value": "Monitoring"},
                {"id": "scope", "status": "assumed", "value": "Version only"},
                {"id": "limits", "status": "clear", "value": "Stdlib only"},
                {"id": "done", "status": "open", "value": "ignored"},
            ],
        }

    def _expected_guide(self) -> dict:
        return {
            "question": "Who will call this endpoint?",
            "options": ["Monitoring only", "Users", "Both", "Other teams"],
            "checklist": [
                {"id": "what", "status": "clear", "value": "A /health endpoint"},
                {"id": "who", "status": "clear", "value": "Monitoring"},
                {"id": "scope", "status": "assumed", "value": "Version only"},
                {"id": "limits", "status": "clear", "value": "Stdlib only"},
                {"id": "done", "status": "open", "value": ""},
            ],
        }

    def test_size_table_keeps_the_existing_guide_fields(self) -> None:
        rows = (
            ("small", "small", "small"),
            ("medium", "medium", "medium"),
            ("large", "large", "large"),
            ("mixed-case small", "SmAlL", "small"),
            ("mixed-case medium", "mEdIuM", "medium"),
            ("mixed-case large", "LaRgE", "large"),
            ("leading and trailing whitespace", " \tLarge\n ", "large"),
            ("unknown value", "huge", None),
            ("empty value", "", None),
            ("non-string value", 4, None),
            ("null value", None, None),
            ("missing size", _ABSENT, _ABSENT),
        )
        for label, raw_size, expected_size in rows:
            with self.subTest(label=label):
                guide = self._base_guide()
                if raw_size is not _ABSENT:
                    guide["size"] = raw_size
                parsed = self._live_guide(guide)
                if expected_size is _ABSENT:
                    self.assertNotIn("size", parsed)
                else:
                    self.assertEqual(parsed.pop("size"), expected_size)
                self.assertEqual(parsed, self._expected_guide())

    def test_size_alongside_every_existing_field(self) -> None:
        guide = {
            "question": "Who will call this endpoint?",
            "options": ["Monitoring only", "Users", "Both", "Other teams", "A fifth one"],
            "checklist": self._base_guide()["checklist"],
            "size": "MEDIUM",
        }
        parsed = self._live_guide(guide)
        self.assertEqual(parsed.pop("size"), "medium")
        self.assertEqual(parsed, self._expected_guide())

    def test_malformed_guide_blocks_fall_back_without_a_size(self) -> None:
        baseline = self._live(f"Reply.\n\n````rfc\n{self.RFC}````\n")["guide"]
        self.assertNotIn("size", baseline)
        for label, payload in (
            ("not json", "{not json"),
            ("non-object array", "[1, 2]"),
            ("non-object string", '"small"'),
            ("null", "null"),
        ):
            with self.subTest(label=label):
                parsed = self._live_guide(payload)
                self.assertNotIn("size", parsed)
                self.assertEqual(parsed, baseline)
