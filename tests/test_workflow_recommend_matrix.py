"""Size x readiness x previous-lineup matrix for ``recommend_workflow``.

Each of the 60 rows asserts the selected mode, fallback flag, primary
explanation code, explanation key, normalized size, and ``size_changed`` value.
Every row is evaluated twice with identical inputs to prove determinism.
"""

from __future__ import annotations

import unittest
from copy import deepcopy
from dataclasses import asdict
from pathlib import Path

from tests.test_workflow_recommend import example_config, example_scan
from vibebaton.workflow_recommend import (
    ReadinessSnapshot,
    WorkflowLineup,
    build_readiness_snapshot,
    recommend_workflow,
)


ALL_READY = "all ready"
NO_PANELIST = "no panelist"
NO_SYNTHESIZER = "no synthesizer"
ONE_CLI_READY = "only one CLI provider ready"
HTTP_ONLY_READY = "only HTTP provider ready"

NO_PREVIOUS = "none"
VALID_PREVIOUS = "still valid"
STALE_PREVIOUS = "no longer valid"

SIZES: tuple[str | None, ...] = ("small", "medium", "large", None)

# The scan's ready CLI ids and whether GEMINI_API_KEY is present.
READINESS_SCANS: dict[str, tuple[tuple[str, ...], bool]] = {
    ALL_READY: (("agy", "gemini", "claude", "codex", "dsh"), True),
    NO_PANELIST: (("agy", "gemini", "dsh"), True),
    NO_SYNTHESIZER: (("agy", "gemini", "claude", "codex", "dsh"), False),
    ONE_CLI_READY: (("claude",), True),
    HTTP_ONLY_READY: ((), True),
}

PREVIOUS_KINDS = (NO_PREVIOUS, VALID_PREVIOUS, STALE_PREVIOUS)

# (size, readiness, previous lineup, mode, fallback, reason_code, size_changed)
MATRIX_CASES = (
    # small
    ("small", ALL_READY, NO_PREVIOUS, "overnight", False, "small_eco", None),
    ("small", ALL_READY, VALID_PREVIOUS, "overnight", False, "previous_lineup_preserved", True),
    ("small", ALL_READY, STALE_PREVIOUS, "overnight", False, "small_eco", True),
    ("small", NO_PANELIST, NO_PREVIOUS, "overnight", True, "provider_substituted", None),
    ("small", NO_PANELIST, VALID_PREVIOUS, "overnight", False, "previous_lineup_preserved", True),
    ("small", NO_PANELIST, STALE_PREVIOUS, "overnight", True, "provider_substituted", True),
    ("small", NO_SYNTHESIZER, NO_PREVIOUS, "overnight", True, "provider_substituted", None),
    ("small", NO_SYNTHESIZER, VALID_PREVIOUS, "overnight", False, "previous_lineup_preserved", True),
    ("small", NO_SYNTHESIZER, STALE_PREVIOUS, "overnight", True, "provider_substituted", True),
    ("small", ONE_CLI_READY, NO_PREVIOUS, "overnight", True, "eco_model_unavailable", None),
    ("small", ONE_CLI_READY, VALID_PREVIOUS, "overnight", False, "previous_lineup_preserved", True),
    ("small", ONE_CLI_READY, STALE_PREVIOUS, "overnight", True, "eco_model_unavailable", True),
    ("small", HTTP_ONLY_READY, NO_PREVIOUS, "overnight", True, "eco_model_unavailable", None),
    ("small", HTTP_ONLY_READY, VALID_PREVIOUS, "overnight", False, "previous_lineup_preserved", True),
    ("small", HTTP_ONLY_READY, STALE_PREVIOUS, "overnight", True, "eco_model_unavailable", True),
    # medium
    ("medium", ALL_READY, NO_PREVIOUS, "overnight", False, "medium_relay", None),
    ("medium", ALL_READY, VALID_PREVIOUS, "overnight", False, "previous_lineup_preserved", False),
    ("medium", ALL_READY, STALE_PREVIOUS, "overnight", False, "medium_relay", False),
    ("medium", NO_PANELIST, NO_PREVIOUS, "overnight", True, "provider_substituted", None),
    ("medium", NO_PANELIST, VALID_PREVIOUS, "overnight", False, "previous_lineup_preserved", False),
    ("medium", NO_PANELIST, STALE_PREVIOUS, "overnight", True, "provider_substituted", False),
    ("medium", NO_SYNTHESIZER, NO_PREVIOUS, "overnight", True, "provider_substituted", None),
    ("medium", NO_SYNTHESIZER, VALID_PREVIOUS, "overnight", False, "previous_lineup_preserved", False),
    ("medium", NO_SYNTHESIZER, STALE_PREVIOUS, "overnight", True, "provider_substituted", False),
    ("medium", ONE_CLI_READY, NO_PREVIOUS, "overnight", True, "provider_substituted", None),
    ("medium", ONE_CLI_READY, VALID_PREVIOUS, "overnight", False, "previous_lineup_preserved", False),
    ("medium", ONE_CLI_READY, STALE_PREVIOUS, "overnight", True, "provider_substituted", False),
    ("medium", HTTP_ONLY_READY, NO_PREVIOUS, "overnight", True, "provider_substituted", None),
    ("medium", HTTP_ONLY_READY, VALID_PREVIOUS, "overnight", False, "previous_lineup_preserved", False),
    ("medium", HTTP_ONLY_READY, STALE_PREVIOUS, "overnight", True, "provider_substituted", False),
    # large
    ("large", ALL_READY, NO_PREVIOUS, "panel", False, "large_panel", None),
    ("large", ALL_READY, VALID_PREVIOUS, "panel", False, "previous_lineup_preserved", True),
    ("large", ALL_READY, STALE_PREVIOUS, "panel", False, "large_panel", True),
    ("large", NO_PANELIST, NO_PREVIOUS, "overnight", True, "panelist_unavailable", None),
    ("large", NO_PANELIST, VALID_PREVIOUS, "overnight", True, "panelist_unavailable", True),
    ("large", NO_PANELIST, STALE_PREVIOUS, "overnight", True, "panelist_unavailable", True),
    ("large", NO_SYNTHESIZER, NO_PREVIOUS, "overnight", True, "synthesizer_credentials_missing", None),
    ("large", NO_SYNTHESIZER, VALID_PREVIOUS, "overnight", True, "synthesizer_credentials_missing", True),
    ("large", NO_SYNTHESIZER, STALE_PREVIOUS, "overnight", True, "synthesizer_credentials_missing", True),
    ("large", ONE_CLI_READY, NO_PREVIOUS, "panel", True, "provider_substituted", None),
    ("large", ONE_CLI_READY, VALID_PREVIOUS, "panel", False, "previous_lineup_preserved", True),
    ("large", ONE_CLI_READY, STALE_PREVIOUS, "panel", True, "provider_substituted", True),
    ("large", HTTP_ONLY_READY, NO_PREVIOUS, "overnight", True, "panelist_unavailable", None),
    ("large", HTTP_ONLY_READY, VALID_PREVIOUS, "overnight", True, "panelist_unavailable", True),
    ("large", HTTP_ONLY_READY, STALE_PREVIOUS, "overnight", True, "panelist_unavailable", True),
    # None defaults to medium
    (None, ALL_READY, NO_PREVIOUS, "overnight", False, "size_defaulted_to_medium", None),
    (None, ALL_READY, VALID_PREVIOUS, "overnight", False, "size_defaulted_to_medium", False),
    (None, ALL_READY, STALE_PREVIOUS, "overnight", False, "size_defaulted_to_medium", False),
    (None, NO_PANELIST, NO_PREVIOUS, "overnight", True, "provider_substituted", None),
    (None, NO_PANELIST, VALID_PREVIOUS, "overnight", False, "size_defaulted_to_medium", False),
    (None, NO_PANELIST, STALE_PREVIOUS, "overnight", True, "provider_substituted", False),
    (None, NO_SYNTHESIZER, NO_PREVIOUS, "overnight", True, "provider_substituted", None),
    (None, NO_SYNTHESIZER, VALID_PREVIOUS, "overnight", False, "size_defaulted_to_medium", False),
    (None, NO_SYNTHESIZER, STALE_PREVIOUS, "overnight", True, "provider_substituted", False),
    (None, ONE_CLI_READY, NO_PREVIOUS, "overnight", True, "provider_substituted", None),
    (None, ONE_CLI_READY, VALID_PREVIOUS, "overnight", False, "size_defaulted_to_medium", False),
    (None, ONE_CLI_READY, STALE_PREVIOUS, "overnight", True, "provider_substituted", False),
    (None, HTTP_ONLY_READY, NO_PREVIOUS, "overnight", True, "provider_substituted", None),
    (None, HTTP_ONLY_READY, VALID_PREVIOUS, "overnight", False, "size_defaulted_to_medium", False),
    (None, HTTP_ONLY_READY, STALE_PREVIOUS, "overnight", True, "provider_substituted", False),
)


def build_previous_lineup(snapshot: ReadinessSnapshot, kind: str) -> WorkflowLineup | None:
    """Return no lineup, the snapshot's valid lineup, or one with a retired provider."""
    if kind == NO_PREVIOUS:
        return None
    if kind not in (VALID_PREVIOUS, STALE_PREVIOUS):
        raise ValueError(f"Unknown previous-lineup kind: {kind!r}")
    lineup = deepcopy(snapshot.default_lineup)
    if lineup is None:
        raise AssertionError("matrix fixture requires a default lineup")
    lineup["size"] = "medium"
    if kind == STALE_PREVIOUS:
        lineup["roles"]["bulk_worker"] = "retired_provider"
        lineup["model_overrides"]["bulk_worker"] = "retired_provider:retired-model"
    return lineup


class WorkflowRecommendationMatrixTests(unittest.TestCase):
    def setUp(self) -> None:
        self.cfg = example_config()
        self.snapshots = {
            name: build_readiness_snapshot(
                Path("."), self.cfg, scan_result=example_scan(ready, http_key=http_key),
            )
            for name, (ready, http_key) in READINESS_SCANS.items()
        }

    def test_matrix_covers_every_axis_combination(self) -> None:
        self.assertGreaterEqual(len(MATRIX_CASES), 20)
        self.assertEqual(len(MATRIX_CASES), len(SIZES) * len(READINESS_SCANS) * len(PREVIOUS_KINDS))
        self.assertEqual(
            {(case[0], case[1], case[2]) for case in MATRIX_CASES},
            {
                (size, readiness, previous)
                for size in SIZES
                for readiness in READINESS_SCANS
                for previous in PREVIOUS_KINDS
            },
        )

    def test_every_matrix_row_is_exact_and_deterministic(self) -> None:
        for size, readiness, previous_kind, mode, fallback, reason, size_changed in MATRIX_CASES:
            with self.subTest(size=size, readiness=readiness, previous=previous_kind):
                snapshot = self.snapshots[readiness]
                previous = build_previous_lineup(snapshot, previous_kind)
                before = deepcopy(previous)
                first = recommend_workflow(size, snapshot, previous_lineup=previous)
                second = recommend_workflow(size, snapshot, previous_lineup=previous)
                self.assertEqual(first.mode, mode)
                self.assertIs(first.fallback, fallback)
                self.assertEqual(first.reason_code, reason)
                self.assertEqual(first.explanation_key, f"workflow.{reason}")
                self.assertIn(reason, first.explanation_codes)
                self.assertIs(first.size_changed, size_changed)
                self.assertEqual(first.size, "medium" if size is None else size)
                self.assertEqual(asdict(first), asdict(second))
                self.assertEqual(previous, before)


if __name__ == "__main__":
    unittest.main()
