"""Discover every adapter contract and report per-test outcomes for the benchmark."""

import json
import sys
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from typing import TextIO


def load_tests(
    loader: unittest.TestLoader,
    standard_tests: unittest.TestSuite,
    pattern: str | None,
) -> unittest.TestSuite:
    """Collect contracts with the same qualified names as direct test runs."""
    here = Path(__file__).resolve()
    standard_tests.addTests(
        loader.discover(
            start_dir=str(here.with_name("contracts")),
            pattern="test_*.py",
            top_level_dir=str(here.parents[2]),
        )
    )
    return standard_tests


class _ScoreResult(unittest.TextTestResult):
    def __init__(self, stream: TextIO, descriptions: bool, verbosity: int) -> None:
        super().__init__(stream, descriptions, verbosity)
        self.passed = 0

    def addSuccess(self, test: unittest.TestCase) -> None:
        super().addSuccess(test)
        self.passed += 1


def _main() -> int:
    loader = unittest.TestLoader()
    suite = load_tests(loader, unittest.TestSuite(), None)
    if loader.errors:
        raise RuntimeError("Hidden contract discovery failed:\n" + "\n".join(loader.errors))
    with redirect_stdout(sys.stderr):
        result = unittest.TextTestRunner(resultclass=_ScoreResult).run(suite)
    print(json.dumps({"passed": result.passed, "total": result.testsRun}))
    return int(result.passed < result.testsRun)


if __name__ == "__main__":
    raise SystemExit(_main())
