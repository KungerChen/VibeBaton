"""Size x readiness x previous-lineup matrix for ``recommend_workflow``.

Each of the 60 rows asserts the selected mode, fallback flag, arrangement
reason code, ordered explanation codes, explanation key, normalized size, and
``size_changed`` value.
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

# (size, readiness) -> (mode, fallback, reason_code, extra explanation codes).
# 20261126 workflow tiers: reason_code is now the arrangement (always present); the size code and
# notes sit around it in explanation_codes. Teams are rebuilt from ready providers with the setup
# step's tiered picks, so readiness changes no longer show up as config-default substitutions, and
# large recommends the panel only when every panelist is ready ("only one CLI" now falls back).
EXPECTED: dict[tuple[str | None, str], tuple[str, bool, str, tuple[str, ...]]] = {
    **{("small", readiness): ("overnight", False, "small_eco", ()) for readiness in READINESS_SCANS},
    **{("medium", readiness): ("overnight", False, "medium_relay", ()) for readiness in READINESS_SCANS},
    **{(None, readiness): ("overnight", False, "medium_relay", ()) for readiness in READINESS_SCANS},
    ("large", ALL_READY): ("panel", False, "large_panel", ()),
    ("large", NO_PANELIST): ("overnight", True, "large_relay", ("panelist_unavailable",)),
    ("large", NO_SYNTHESIZER): ("overnight", True, "large_relay", ("synthesizer_credentials_missing",)),
    ("large", ONE_CLI_READY): ("overnight", True, "large_relay", ("panelist_not_ready",)),
    ("large", HTTP_ONLY_READY): ("overnight", True, "large_relay", ("panelist_unavailable",)),
}

MATRIX_CASES = tuple(
    (size, readiness, previous, *EXPECTED[(size, readiness)][:3],
     None if previous == NO_PREVIOUS else (size or "medium") != "medium")
    for size in SIZES for readiness in READINESS_SCANS for previous in PREVIOUS_KINDS
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
                size_code = "size_defaulted_to_medium" if size is None else "size_from_model"
                self.assertEqual(first.explanation_codes, (size_code, reason, *EXPECTED[(size, readiness)][3]))
                self.assertIs(first.size_changed, size_changed)
                self.assertEqual(first.size, "medium" if size is None else size)
                self.assertEqual(asdict(first), asdict(second))
                self.assertEqual(previous, before)


if __name__ == "__main__":
    unittest.main()
