"""Deterministic RFC readiness contracts and structured RFC generation tests."""

from __future__ import annotations

import unittest

from vibebaton.brainstorm import _offline_rfc
from vibebaton.rfc_checker import check_rfc_readiness, extract_verification_commands, generate_structured_rfc

_LONG_GOAL = "Build a deterministic readiness scorer that never performs file or network I/O."
_READINESS_KEYS = {
    "score",
    "safe_for_overnight",
    "missing_sections",
    "warnings",
    "detected_commands",
}


def _rfc(
    goal: str = _LONG_GOAL,
    constraints: str = "Use only the Python standard library.",
    acceptance: str = "1. Running `pytest -q` exits successfully.",
    non_goals: str = "Do not call the network.",
) -> str:
    return "\n".join((
        "# RFC",
        "",
        "## Goal",
        "",
        goal,
        "",
        "## Constraints",
        "",
        constraints,
        "",
        "## Non-goals",
        "",
        non_goals,
        "",
        "## Acceptance Criteria",
        "",
        acceptance,
        "",
    ))


class TestRFCReadiness(unittest.TestCase):
    def test_empty_text_scores_zero_and_reports_all_sections_missing(self) -> None:
        report = check_rfc_readiness("")

        self.assertEqual(set(report), _READINESS_KEYS)
        self.assertEqual(report, {
            "score": 0,
            "safe_for_overnight": False,
            "missing_sections": ["goal", "constraints", "acceptance"],
            "warnings": [],
            "detected_commands": [],
        })
        self.assertIsInstance(report["score"], int)
        self.assertIsInstance(report["safe_for_overnight"], bool)

        whitespace = check_rfc_readiness("  \n\t\n")
        self.assertEqual(whitespace["score"], 0)
        self.assertEqual(whitespace["missing_sections"], ["goal", "constraints", "acceptance"])
        self.assertFalse(whitespace["safe_for_overnight"])

    def test_full_rfc_with_commands_is_safe_for_overnight(self) -> None:
        report = check_rfc_readiness(_rfc())

        self.assertEqual(set(report), _READINESS_KEYS)
        self.assertEqual(report["score"], 100)
        self.assertTrue(report["safe_for_overnight"])
        self.assertEqual(report["missing_sections"], [])
        self.assertEqual(report["warnings"], [])
        self.assertEqual(report["detected_commands"], ["pytest"])

    def test_missing_acceptance_section_is_unsafe(self) -> None:
        report = check_rfc_readiness("\n".join((
            "# RFC",
            "## Goal",
            _LONG_GOAL,
            "## Constraints",
            "Run `pytest -q` before delivery.",
        )))

        self.assertEqual(report["missing_sections"], ["acceptance"])
        self.assertEqual(report["score"], 75)
        self.assertFalse(report["safe_for_overnight"])
        self.assertEqual(report["detected_commands"], ["pytest"])

    def test_ambiguity_warnings_each_lower_the_score_by_five(self) -> None:
        baseline = check_rfc_readiness(_rfc())
        cases = (
            ("marker TBD", _rfc(goal=f"{_LONG_GOAL} TBD")),
            ("marker TODO", _rfc(constraints="TODO: use only the standard library.")),
            ("marker etc.", _rfc(constraints="Use the standard library, etc.")),
            ("marker maybe", _rfc(constraints="Maybe use only the standard library.")),
            (
                "question in heading",
                _rfc().replace("## Acceptance Criteria", "## Acceptance Criteria?"),
            ),
            ("short goal", _rfc(goal="Ship it.")),
            ("unnumbered acceptance", _rfc(acceptance="pytest -q")),
        )
        for label, text in cases:
            with self.subTest(case=label):
                report = check_rfc_readiness(text)

                self.assertEqual(len(report["warnings"]), 1, report["warnings"])
                self.assertEqual(report["score"], baseline["score"] - 5)
                self.assertLess(report["score"], baseline["score"])

    def test_warnings_floor_the_score_at_zero(self) -> None:
        report = check_rfc_readiness("TBD TODO etc. maybe")

        self.assertEqual(report["score"], 0)
        self.assertEqual(report["missing_sections"], ["goal", "constraints", "acceptance"])
        self.assertEqual(len(report["warnings"]), 4)
        self.assertFalse(report["safe_for_overnight"])

    def test_score_below_seventy_is_unsafe_even_with_sections_and_a_command(self) -> None:
        report = check_rfc_readiness(_rfc(
            goal="Maybe",
            constraints="TODO TBD etc.\n### Open question?",
            acceptance="pytest -q",
        ))

        self.assertEqual(report["score"], 65)
        self.assertEqual(report["missing_sections"], [])
        self.assertEqual(report["detected_commands"], ["pytest"])
        self.assertFalse(report["safe_for_overnight"])

    def test_detects_each_supported_command_family(self) -> None:
        cases = (
            ("pytest -q", "pytest"),
            ("python -m unittest discover", "python -m unittest"),
            ("unittest discover", "unittest"),
            ("vitest run", "vitest"),
            ("npm test", "npm test"),
            ("npm t", "npm test"),
            ("npm run lint", "npm run"),
            ("npx vitest run", "npx"),
            ("npx vitest run", "vitest"),
            ("cargo test --all", "cargo test"),
            ("go test ./...", "go test"),
            ("make test", "make test"),
            ("mvn verify", "mvn"),
            ("gradle test", "gradle"),
            ("dotnet test", "dotnet test"),
        )
        for command, expected in cases:
            with self.subTest(command=command, expected=expected):
                report = check_rfc_readiness(_rfc(acceptance=f"1. `{command}` passes."))

                self.assertIn(expected, report["detected_commands"])
                self.assertTrue(report["safe_for_overnight"])

    def test_detects_npm_test_after_workspace_options(self) -> None:
        cases = (
            "npm --workspace web test",
            "npm --workspace=web test",
            "npm -w web test",
            "npm --workspace web run test",
        )
        for command in cases:
            with self.subTest(command=command):
                report = check_rfc_readiness(_rfc(acceptance=f"1. `{command}` passes."))

                self.assertIn("npm test", report["detected_commands"])
                self.assertTrue(report["safe_for_overnight"])

    def test_json_expected_output_is_not_counted_as_an_acceptance_command(self) -> None:
        output = '{"runner": "pytest", "tests": 17, "status": "ok"}'
        for language in ("", "json"):
            with self.subTest(language=language or "plain"):
                report = check_rfc_readiness(
                    _rfc(acceptance=f"```{language}\n{output}\n```"),
                )

                self.assertEqual(report["detected_commands"], [])
                self.assertFalse(report["safe_for_overnight"])

    def test_deduplicates_repeated_commands(self) -> None:
        report = check_rfc_readiness(_rfc(acceptance="1. pytest, then pytest again."))

        self.assertEqual(report["detected_commands"], ["pytest"])

    def test_four_backtick_fence_hides_a_nested_three_backtick_example(self) -> None:
        report = check_rfc_readiness("\n".join((
            "````markdown",
            "```markdown",
            "# RFC",
            "## Goal",
            _LONG_GOAL,
            "## Constraints",
            "Use only the Python standard library.",
            "## Acceptance Criteria",
            "1. `pytest -q` passes.",
            "```",
            "````",
        )))

        self.assertEqual(report["missing_sections"], ["goal", "constraints", "acceptance"])
        self.assertEqual(report["score"], 20)
        self.assertFalse(report["safe_for_overnight"])

    def test_nested_fence_does_not_end_an_acceptance_section_early(self) -> None:
        report = check_rfc_readiness("\n".join((
            "# RFC",
            "## Goal",
            _LONG_GOAL,
            "## Acceptance Criteria",
            "````markdown",
            "```",
            "## Constraints",
            "1. pytest -q",
            "```",
            "````",
            "1. Run the command shown above.",
            "## Constraints",
            "Use only the standard library.",
        )))

        self.assertEqual(report["missing_sections"], [])
        self.assertEqual(report["score"], 100)
        self.assertIn("pytest", report["detected_commands"])
        self.assertTrue(report["safe_for_overnight"])

    def test_sections_accept_case_bold_and_localized_labels(self) -> None:
        report = check_rfc_readiness("\n".join((
            "# RFC",
            "**OBJECTIVE:** Can the deterministic readiness scorer stay fully offline?",
            "**Out-of-scope:** network calls.",
            "**验收:**",
            "1. pytest -q passes.",
        )))

        self.assertEqual(report["missing_sections"], [])
        self.assertEqual(report["warnings"], [])
        self.assertIn("pytest", report["detected_commands"])
        self.assertTrue(report["safe_for_overnight"])

    def test_chinese_headings_are_detected(self) -> None:
        cases = (
            ("目标", "约束", "验收"),
            ("目标说明", "约束条件", "验收标准"),
        )
        for goal, constraints, acceptance in cases:
            with self.subTest(acceptance=acceptance):
                report = check_rfc_readiness("\n".join((
                    "# RFC",
                    f"## {goal}",
                    "构建一个完全离线的确定性 RFC 就绪评分器，并提供完整的测试与验证命令。",
                    f"## {constraints}",
                    "仅使用 Python 标准库。",
                    f"## {acceptance}",
                    "1. pytest -q 通过。",
                )))

                self.assertEqual(report["missing_sections"], [])
                self.assertIn("pytest", report["detected_commands"])
                self.assertTrue(report["safe_for_overnight"])

    def test_numbered_master_rfc_headings_are_detected(self) -> None:
        report = check_rfc_readiness("\n".join((
            "# RFC",
            "## 1. Goal",
            _LONG_GOAL,
            "## 2. Hard Constraints & Invariants",
            "Use only the standard library.",
            "## 3. Verification",
            "1. `go test ./...` passes.",
        )))

        self.assertEqual(report["missing_sections"], [])
        self.assertEqual(report["score"], 100)
        self.assertTrue(report["safe_for_overnight"])

    def test_verification_command_in_constraints_counts_for_readiness(self) -> None:
        report = check_rfc_readiness(_rfc(
            constraints="Run `pytest -q` from the workspace root.",
            acceptance="1. The verification suite exits successfully.",
        ))

        self.assertEqual(report["detected_commands"], ["pytest"])
        self.assertEqual(report["score"], 100)
        self.assertTrue(report["safe_for_overnight"])

    def test_numbered_text_in_a_code_block_does_not_count_as_acceptance(self) -> None:
        report = check_rfc_readiness(_rfc(acceptance="```text\n1. pytest -q\n```"))

        self.assertEqual(report["detected_commands"], ["pytest"])
        self.assertEqual(report["warnings"], ["Acceptance criteria are not numbered."])
        self.assertEqual(report["score"], 95)

    def test_same_input_is_deterministic_and_returns_fresh_lists(self) -> None:
        first = check_rfc_readiness(_rfc(goal="Ship it. TBD"))
        second = check_rfc_readiness(_rfc(goal="Ship it. TBD"))

        self.assertEqual(first, second)
        self.assertIsNot(first["warnings"], second["warnings"])
        self.assertIsNot(first["detected_commands"], second["detected_commands"])

        first["warnings"].append("mutated")
        first["detected_commands"].clear()
        self.assertNotEqual(first, second)


class TestStructuredRFCGeneration(unittest.TestCase):
    def test_generates_markdown_with_a_safe_acceptance_command(self) -> None:
        generated = generate_structured_rfc(
            goal="Build a deterministic RFC readiness scorer with standard-library tests.",
            constraints="Use only the Python standard library.",
            acceptance_cmd="python -m unittest tests.test_rfc_checker -v",
            non_goals="Do not write files or call the network.",
        )

        markdown = generated["rfc_markdown"]
        self.assertEqual(set(generated), {"rfc_markdown", "readiness"})
        for heading in (
            "# RFC",
            "## Goal",
            "## Constraints",
            "## Non-goals",
            "## Acceptance Criteria",
        ):
            with self.subTest(heading=heading):
                self.assertIn(heading, markdown)
        self.assertIn("python -m unittest tests.test_rfc_checker -v", markdown)
        self.assertIn("```", markdown)
        self.assertEqual(generated["readiness"], check_rfc_readiness(markdown))
        self.assertEqual(generated["readiness"], {
            "score": 100,
            "safe_for_overnight": True,
            "missing_sections": [],
            "warnings": [],
            "detected_commands": ["python -m unittest"],
        })

    def test_generated_acceptance_meets_the_inclusive_threshold(self) -> None:
        generated = generate_structured_rfc(
            goal="Maybe?",
            constraints="TODO TBD etc.\n### Open question?",
            acceptance_cmd="pytest -q",
        )
        readiness = generated["readiness"]

        self.assertEqual(readiness["score"], 70)
        self.assertEqual(len(readiness["warnings"]), 6)
        self.assertTrue(readiness["safe_for_overnight"])

    def test_explicit_unknown_acceptance_command_is_detected_on_rescoring(self) -> None:
        generated = generate_structured_rfc(
            goal="Ship a deterministic readiness scorer with complete verification tests.",
            acceptance_cmd="python scripts/verify.py",
        )
        readiness = generated["readiness"]

        self.assertEqual(readiness, check_rfc_readiness(generated["rfc_markdown"]))
        self.assertEqual(readiness["detected_commands"], ["python scripts/verify.py"])
        self.assertTrue(readiness["safe_for_overnight"])

    def test_npm_t_alias_in_the_generated_acceptance_block_is_safe(self) -> None:
        generated = generate_structured_rfc(
            goal="Ship a deterministic readiness scorer with complete verification tests.",
            acceptance_cmd="npm t",
        )
        readiness = generated["readiness"]

        self.assertEqual(readiness, check_rfc_readiness(generated["rfc_markdown"]))
        self.assertEqual(readiness["detected_commands"], ["npm test"])
        self.assertTrue(readiness["safe_for_overnight"])

    def test_backslash_continued_acceptance_command_is_safe(self) -> None:
        generated = generate_structured_rfc(
            goal="Ship a deterministic readiness scorer with complete verification tests.",
            acceptance_cmd="python scripts/verify.py \\\n  --offline",
        )
        readiness = generated["readiness"]

        self.assertIn("```bash", generated["rfc_markdown"])
        self.assertEqual(readiness, check_rfc_readiness(generated["rfc_markdown"]))
        self.assertEqual(readiness["detected_commands"], ["python scripts/verify.py --offline"])
        self.assertTrue(readiness["safe_for_overnight"])

    def test_generator_uses_a_fence_longer_than_backticks_in_the_command(self) -> None:
        command = """python -c 'assert len("```") == 3'"""
        generated = generate_structured_rfc(goal=_LONG_GOAL, acceptance_cmd=command)

        self.assertIn(f"````bash\n{command}\n````", generated["rfc_markdown"])
        self.assertEqual(generated["readiness"]["detected_commands"], [command])
        self.assertTrue(generated["readiness"]["safe_for_overnight"])

    def test_goal_command_counts_when_acceptance_is_a_todo(self) -> None:
        generated = generate_structured_rfc(
            goal="Migrate the test suite and run `pytest -q` from the workspace.",
        )
        readiness = generated["readiness"]

        self.assertEqual(readiness, check_rfc_readiness(generated["rfc_markdown"]))
        self.assertIn("TODO", generated["rfc_markdown"])
        self.assertEqual(readiness["detected_commands"], ["pytest"])
        self.assertTrue(readiness["safe_for_overnight"])

    def test_generates_a_todo_acceptance_when_the_command_is_missing(self) -> None:
        generated = generate_structured_rfc(
            goal="Ship a deterministic readiness scorer with complete verification tests.",
        )

        markdown = generated["rfc_markdown"]
        self.assertIn("TODO", markdown)
        self.assertNotIn("```", markdown)
        self.assertEqual(generated["readiness"], check_rfc_readiness(markdown))
        self.assertFalse(generated["readiness"]["safe_for_overnight"])
        self.assertEqual(generated["readiness"]["detected_commands"], [])
        self.assertEqual(generated["readiness"]["missing_sections"], [])
        self.assertIn("TODO", " ".join(generated["readiness"]["warnings"]))


class TestVerificationCommandExtraction(unittest.TestCase):
    """The milestone gate of a lean run takes these command lines verbatim, so nothing is guessed."""

    def test_guided_blueprint_blocks_yield_their_command_lines_verbatim(self) -> None:
        live = _rfc(acceptance="1. The checks pass.\n\n```bash\npython -m unittest discover -s tests\nnpm --prefix web test\n```")
        self.assertEqual(extract_verification_commands(live),
                         ["python -m unittest discover -s tests", "npm --prefix web test"])
        offline = _offline_rfc([{"role": "user", "content": "Add a greeting. Check it with `pytest -q tests`."}])
        self.assertIn("````bash\npytest -q tests\n````", offline)
        self.assertEqual(extract_verification_commands(offline), ["pytest -q tests"])
        for command, expected in (
            ("""python -c 'assert len("```") == 3'""", """python -c 'assert len("```") == 3'"""),
            ("python scripts/verify.py \\\n  --offline", "python scripts/verify.py --offline"),
        ):
            with self.subTest(command=command):
                generated = generate_structured_rfc(goal=_LONG_GOAL, acceptance_cmd=command)["rfc_markdown"]
                self.assertEqual(extract_verification_commands(generated), [expected])

    def test_repository_rfc_shape_yields_its_three_commands(self) -> None:
        # Mirrors .baton/00_RFC.md: numbered criteria, the bash block, then a roadmap table section.
        text = "\n".join((
            "# VibeBaton Studio Workbench, Phase 1",
            "## Goals",
            "1. **Lean small-task flow (engine)**: skip the L1 planning call for small runs.",
            "## Constraints",
            "- Keep `tests/test_stdlib_only.py` green.",
            "## Verification & Acceptance Criteria",
            "",
            "1. A Guided run launched as `small` makes no planning call.",
            "8. All Python tests and all Studio tests pass, and the production build succeeds.",
            "",
            "```bash",
            "python -m unittest discover -s tests",
            "npm --prefix web test",
            "npm --prefix web run build",
            "```",
            "",
            "## Roadmap After This RFC (information only)",
            "",
            "| Phase | Deliverables | Release gate | Must be settled first |",
            "| --- | --- | --- | --- |",
            "| 2 - Build | Add `artifact_key` to the `role_invoked` payload | Journey 1 passes; run `npm test` | - |",
            "",
            "Dropped for good: pre-launch cost forecasts.",
        ))
        self.assertEqual(extract_verification_commands(text), [
            "python -m unittest discover -s tests", "npm --prefix web test", "npm --prefix web run build",
        ])

    def test_commands_named_only_in_prose_or_outside_runnable_blocks_are_not_taken(self) -> None:
        cases = {
            "prose": _rfc(),
            "block under constraints": _rfc(constraints="```bash\npytest -q\n```", acceptance="1. Tests pass."),
            "python block": _rfc(acceptance="1. Tests pass.\n\n```python\nimport unittest\nunittest.main()\n```"),
            "text block": _rfc(acceptance="1. Tests pass.\n\n```text\npytest -q\n```"),
            "json block": _rfc(acceptance='1. Tests pass.\n\n```\n{"runner": "pytest", "status": "ok"}\n```'),
            "console transcript": _rfc(acceptance="1. Tests pass.\n\n```console\npytest -q\n3 passed\n```"),
            "unclosed fence": _rfc(acceptance="1. Tests pass.\n\n```bash\npytest -q"),
        }
        for label, text in cases.items():
            with self.subTest(case=label):
                self.assertEqual(extract_verification_commands(text), [])
        # Readiness still counts the prose command; only a gate needs the line as written.
        self.assertEqual(check_rfc_readiness(cases["prose"])["detected_commands"], ["pytest"])

    def test_blank_lines_and_comments_are_skipped_and_repeats_dropped_in_order(self) -> None:
        text = _rfc(acceptance="\n".join((
            "1. Both suites pass.",
            "",
            "```sh",
            "#!/bin/sh",
            "# unit tests first",
            "",
            "pytest -q",
            "npm test",
            "```",
            "",
            "~~~cmd",
            "REM the same on Windows",
            ":: no other checks",
            "pytest -q",
            "~~~",
        )))
        self.assertEqual(extract_verification_commands(text), ["pytest -q", "npm test"])

    def test_unlabelled_blocks_follow_the_readiness_rule(self) -> None:
        for block, expected in (
            ("ruff check .", ["ruff check ."]),  # the block's only line
            ("ruff check .\nmypy src", []),  # unknown multi-line commands are not guessed
            ("ruff check .\npytest -q", ["pytest -q"]),  # only the recognised test command
        ):
            with self.subTest(block=block):
                text = _rfc(acceptance=f"1. Checks pass.\n\n```\n{block}\n```")
                self.assertEqual(extract_verification_commands(text), expected)

    def test_blocks_whose_lines_cannot_run_one_by_one_are_skipped(self) -> None:
        for language, block in (
            ("bash", "cd web\nnpm test"),
            ("bash", "export CI=1\npytest -q"),
            ("bash", "set -e\npytest -q"),
            ("bash", "source .venv/bin/activate\npytest -q"),
            ("bash", "PYTHONPATH=src\npytest -q"),
            ("cmd", "set CI=1\npytest -q"),
            ("powershell", "$env:CI = '1'\npytest -q"),
            ("bash", "$ pytest -q"),  # a terminal transcript, not a script
        ):
            with self.subTest(language=language, block=block):
                text = _rfc(acceptance=f"1. Checks pass.\n\n```{language}\n{block}\n```")
                self.assertEqual(extract_verification_commands(text), [])
        chained = _rfc(acceptance="1. Checks pass.\n\n```bash\ncd web && npm test\nPYTHONPATH=src pytest -q\n```")
        self.assertEqual(extract_verification_commands(chained), ["cd web && npm test", "PYTHONPATH=src pytest -q"])


if __name__ == "__main__":
    unittest.main()
