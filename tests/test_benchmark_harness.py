"""End-to-end tests for isolated benchmark submissions and scoreboards."""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from datetime import datetime, timedelta
from io import StringIO
from pathlib import Path
from typing import Any
from unittest.mock import patch

from benchmarks import run_benchmark
from benchmarks.reference_solution import adapters
from benchmarks.run_benchmark import ADAPTERS, BENCHMARKS, IGNORE_CACHES, REFERENCE, evaluate_target

METRICS = (
    "Hidden Eval Pass Rate",
    "Contract Violations",
    "Wall-Clock Time",
    "Flagship Invocation Share",
)
ARM_FIELDS = {
    "arm", "label", "hidden_pass_rate", "hidden_passed", "hidden_total",
    "contract_violations", "wall_clock_sec", "flagship_share",
}
GENERATED_REPORTS = frozenset({"results/latest.json", "results/latest.md"})
FAKE_PROVIDER = """
import os
import shutil
import sys
from pathlib import Path

scenario, model, reference = sys.argv[1:]
prompt = sys.stdin.read()
arm = Path.cwd().name
role = os.environ["VIBEBATON_ROLE"]
eval_fixture = scenario in ("eval-timeout", "eval-output")
assert model == os.environ["VIBEBATON_MODEL"]
assert Path(".git").is_dir()
assert "Implement the resource adapters" in prompt
assert not Path("hidden_eval").exists()
if arm in ("arm_A", "arm_B"):
    tests = Path("tests")
    tests.mkdir()
    (tests / "model.txt").write_text(model, encoding="utf-8")
    if eval_fixture:
        for adapter in Path(reference).glob("*.py"):
            if adapter.name not in {"base.py", "errors.py"}:
                shutil.copy2(adapter, "adapters")
        if arm == "arm_B":
            with Path("adapters/kv_memory.py").open("a", encoding="utf-8") as file:
                file.write({
                    "eval-timeout": "\\nfrom threading import Event\\nEvent().wait()\\n",
                    "eval-output": '\\nimport os\\nos.write(1, b"fixture output\\\\n")\\n',
                }[scenario])
elif role == "tactical_planner":
    assert model == "fable@high"
    if scenario == "whitelist":
        Path("adapters/base.py").write_text("# forbidden edit", encoding="utf-8")
    print("fixture plan")
elif role == "critical_executor":
    assert model == "gpt-6.2-sol@max"
    assert "fixture plan" in prompt
    Path("adapters/rate_limiter.py").write_text("# critical adapter", encoding="utf-8")
elif role == "bulk_worker":
    assert model == "deepseek-v4.1-flash@max"
    assert Path("adapters/rate_limiter.py").is_file()
    if eval_fixture:
        shutil.copy2(Path(reference) / "kv_memory.py", "adapters")
        with Path("adapters/__init__.py").open("a", encoding="utf-8") as file:
            file.write("\\nfrom .kv_memory import KVMemory\\n")
    tests = Path("tests")
    tests.mkdir()
    passing = scenario != "public-test"
    (tests / "test_public.py").write_text(
        f"import unittest\\nclass TestPublic(unittest.TestCase):\\n"
        f"    def test_one(self): self.assertTrue({passing})\\n",
        encoding="utf-8",
    )
    print("fixture bulk result")
elif role == "milestone_reviewer":
    assert model == "opus@high"
    assert "fixture bulk result" in prompt
else:
    raise AssertionError(role)
"""


def _tree(
    root: Path, *, generated_reports: frozenset[str] = frozenset(),
) -> dict[str, bytes | tuple[int, int, int] | None]:
    entries: dict[str, bytes | tuple[int, int, int] | None] = {}
    for path in root.rglob("*"):
        relative = path.relative_to(root).as_posix()
        try:
            entries[relative] = path.read_bytes() if path.is_file() else None
        except PermissionError:
            if relative not in generated_reports:
                raise
            # Older scoreboards can retain a private Windows ACL after export.
            info = path.stat()
            entries[relative] = (info.st_ino, info.st_size, info.st_mtime_ns)
    return entries


class TestBenchmarkHarness(unittest.TestCase):
    def setUp(self) -> None:
        self.root = Path(self.enterContext(tempfile.TemporaryDirectory())).resolve()

    def run_cli(self, run: str, *args: str) -> tuple[subprocess.CompletedProcess[str], Path, Path]:
        out, work = self.root / f"{run}-out", self.root / f"{run}-work"
        result = subprocess.run(
            [
                sys.executable, str(BENCHMARKS / "run_benchmark.py"),
                "--out-dir", str(out), "--work-dir", str(work), *args,
            ],
            cwd=self.root,
            env={**os.environ, "VIBEBATON_BENCH_TARGET": str(self.root / "wrong-target")},
            capture_output=True,
            text=True,
            encoding="utf-8",
            timeout=90,
            check=False,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        return result, out, work

    def test_mock_cli_exports_three_reproducible_scores_without_repo_writes(self) -> None:
        before = _tree(BENCHMARKS, generated_reports=GENERATED_REPORTS)
        previous_out = self.root / "repeat-out"
        previous_out.mkdir()
        for report in GENERATED_REPORTS:
            (previous_out / Path(report).name).write_text("previous export", encoding="utf-8")
        _, out, work = self.run_cli("first", "--mock", "--seed", "42")
        _, repeated_out, repeated_work = self.run_cli("repeat")
        self.assertEqual(_tree(BENCHMARKS, generated_reports=GENERATED_REPORTS), before)
        self.assertEqual(_tree(work), _tree(repeated_work))
        self.assertEqual(sorted(path.name for path in work.iterdir()), ["arm_A", "arm_B", "arm_C"])
        for directory in (out, repeated_out):
            self.assertEqual(sorted(path.name for path in directory.iterdir()), ["latest.json", "latest.md"])

        score = json.loads((out / "latest.json").read_text(encoding="utf-8"))
        repeated = json.loads((repeated_out / "latest.json").read_text(encoding="utf-8"))
        self.assertEqual(set(score), {"generated_at", "mode", "seed", "arms"})
        self.assertEqual(datetime.fromisoformat(score.pop("generated_at")).utcoffset(), timedelta())
        repeated.pop("generated_at")
        self.assertEqual(score, repeated)
        self.assertEqual((score["mode"], score["seed"]), ("mock", 42))
        self.assertEqual([arm["arm"] for arm in score["arms"]], ["A", "B", "C"])

        for arm, expected_adapters, expected_violations in zip(
            score["arms"], (7, 9, 10), (2, 0, 0), strict=True
        ):
            with self.subTest(arm=arm["arm"]):
                self.assertEqual(set(arm), ARM_FIELDS)
                self.assertTrue(arm["label"])
                self.assertEqual(arm["contract_violations"], expected_violations)
                self.assertGreater(arm["hidden_total"], 0)
                self.assertGreater(arm["hidden_passed"], 0)
                self.assertLessEqual(arm["hidden_passed"], arm["hidden_total"])
                self.assertEqual(arm["hidden_pass_rate"], arm["hidden_passed"] / arm["hidden_total"])
                self.assertGreater(arm["wall_clock_sec"], 0)
                self.assertGreaterEqual(arm["flagship_share"], 0)
                self.assertLessEqual(arm["flagship_share"], 1)
                package = work / f"arm_{arm['arm']}" / "adapters"
                self.assertEqual(sum((package / f"{module}.py").is_file() for module in ADAPTERS), expected_adapters)
        a, b, c = score["arms"]
        self.assertEqual(b["label"], "opus@high sequential")
        self.assertLess(a["hidden_pass_rate"], b["hidden_pass_rate"])
        self.assertLess(b["hidden_pass_rate"], c["hidden_pass_rate"])
        self.assertEqual(a["hidden_total"], b["hidden_total"])
        self.assertEqual(b["hidden_total"], c["hidden_total"])
        self.assertEqual(c["hidden_pass_rate"], 1)
        self.assertEqual(c["flagship_share"], 0.3)

        markdown = (out / "latest.md").read_text(encoding="utf-8")
        self.assertEqual(markdown, (repeated_out / "latest.md").read_text(encoding="utf-8"))
        table = [line for line in markdown.splitlines() if line.startswith("|")]
        self.assertEqual(tuple(field.strip() for field in table[0].split("|")[3:-1]), METRICS)
        self.assertEqual([line.split("|")[1].strip() for line in table[2:]], ["A", "B", "C"])

    def test_snapshot_detects_unreadable_report_changes(self) -> None:
        report = self.root / "results" / "latest.json"
        report.parent.mkdir()
        report.write_text("previous export", encoding="utf-8")
        with patch.object(Path, "read_bytes", side_effect=PermissionError):
            before = _tree(self.root, generated_reports=GENERATED_REPORTS)
            self.assertIn("results/latest.json", before)
            self.assertEqual(_tree(self.root, generated_reports=GENERATED_REPORTS), before)
            report.write_text("updated export with a different size", encoding="utf-8")
            self.assertNotEqual(_tree(self.root, generated_reports=GENERATED_REPORTS), before)
            (self.root / "source.py").touch()
            with self.assertRaises(PermissionError):
                _tree(self.root, generated_reports=GENERATED_REPORTS)

    def test_hidden_eval_reports_a_broken_implementation(self) -> None:
        target = self.root / "submission"
        shutil.copytree(REFERENCE, target, ignore=IGNORE_CACHES)
        reference = evaluate_target(target)
        self.assertEqual(reference.total, run_benchmark.HIDDEN_TEST_TOTAL)
        self.assertEqual(reference.passed, reference.total)
        self.assertGreater(reference.total, 0)
        self.assertIsNone(reference.eval_error)

        with (target / "adapters" / "kv_memory.py").open("a", encoding="utf-8") as file:
            file.write('\nprint("noisy implementation")\nKVMemory.get = lambda self, key: None\n')
        broken = evaluate_target(target)
        self.assertEqual(broken.total, reference.total)
        self.assertGreater(broken.passed, 0)
        self.assertLess(broken.pass_rate, reference.pass_rate)
        self.assertIsNone(broken.eval_error)

    def test_hidden_eval_rejects_an_incomplete_test_count(self) -> None:
        result = subprocess.CompletedProcess([], 0, '{"passed": 1, "total": 1}', "")
        with patch.object(subprocess, "run", return_value=result):
            score = evaluate_target(self.root / "submission")
        self.assertEqual(score, run_benchmark.HiddenScore(0, run_benchmark.HIDDEN_TEST_TOTAL, "invalid_summary"))

    def test_reference_exports_each_concrete_adapter(self) -> None:
        for module, name in ADAPTERS.items():
            with self.subTest(adapter=name):
                self.assertIn(name, adapters.__all__)
                implementation = getattr(adapters, name)
                self.assertTrue(issubclass(implementation, adapters.ResourceAdapter))
                self.assertEqual(implementation.__module__, f"{adapters.__name__}.{module}")

    def test_live_skips_without_configured_providers(self) -> None:
        config = self.root / "unconfigured.toml"
        config.write_text("[providers]\n[roles]\n", encoding="utf-8")
        result, out, work = self.run_cli("skipped", "--live", "--config", str(config))
        self.assertIn("Live benchmark skipped", result.stdout)
        self.assertIn("Configure VibeBaton providers", result.stdout)
        self.assertFalse(out.exists())
        self.assertFalse(work.exists())

    def run_live_cli(self, scenario: str) -> tuple[Path, Path, str]:
        driver = self.root / "provider.py"
        driver.write_text(FAKE_PROVIDER, encoding="utf-8")
        roles = {
            "tactical_planner": ("fixture_claude", "fable@high"),
            "milestone_reviewer": ("fixture_claude", "opus@high"),
            "critical_executor": ("fixture_codex", "gpt-6.2-sol@max"),
            "bulk_worker": ("fixture_deepseek", "deepseek-v4.1-flash@max"),
        }
        config = self.root / f"{scenario}.toml"
        provider_names = sorted({provider for provider, _ in roles.values()})
        command = json.dumps([sys.executable, "-B", str(driver), scenario, "{model}", str(REFERENCE / "adapters")])
        config.write_text(
            "".join(f"[providers.{name}]\ncommand = {command}\n" for name in provider_names)
            + "".join(
                f'[roles.{role}]\nprovider = "{provider}"\nmodel = "{model}"\n'
                for role, (provider, model) in roles.items()
            ),
            encoding="utf-8",
        )
        out, work = self.root / f"{scenario}-out", self.root / f"{scenario}-work"
        stderr = StringIO()
        with (
            patch("vibebaton.credentials.default_credentials_path", return_value=self.root / "credentials.json"),
            patch.object(sys, "path", sys.path.copy()),
            redirect_stdout(StringIO()),
            redirect_stderr(stderr),
        ):
            exit_code = run_benchmark.main(
                ["--live", "--config", str(config), "--out-dir", str(out), "--work-dir", str(work)]
            )
        self.assertEqual(exit_code, 0, stderr.getvalue())
        return out, work, stderr.getvalue()

    def test_configured_live_dispatch_and_hybrid_gates(self) -> None:
        for scenario, flagship_share, violations, message in (
            ("success", 3 / 4, 0, ""),
            ("public-test", 2 / 3, 0, "public unittest gate"),
            ("whitelist", 1.0, 1, "path whitelist gate"),
        ):
            with self.subTest(scenario=scenario):
                out, work, stderr = self.run_live_cli(scenario)
                if message:
                    self.assertIn(message, stderr)
                else:
                    self.assertEqual(stderr, "")
                score = json.loads((out / "latest.json").read_text(encoding="utf-8"))
                self.assertEqual(score["mode"], "live")
                for arm, model in (("A", "deepseek-v4.1-flash@max"), ("B", "opus@high")):
                    chosen = (work / f"arm_{arm}" / "tests" / "model.txt").read_text(encoding="utf-8")
                    self.assertEqual(chosen, model)
                hybrid = score["arms"][2]
                self.assertEqual(hybrid["arm"], "C")
                self.assertEqual(hybrid["flagship_share"], flagship_share)
                self.assertEqual(hybrid["contract_violations"], violations)

    def test_live_exports_all_arms_after_hidden_eval_failure(self) -> None:
        run = subprocess.run
        stalled_arm = self.root / "eval-timeout-work" / "arm_B"

        def run_with_short_timeout(command: list[str], **kwargs: Any) -> subprocess.CompletedProcess[str]:
            if (kwargs.get("env") or {}).get("VIBEBATON_BENCH_TARGET") == str(stalled_arm):
                kwargs["timeout"] = 1
            return run(command, **kwargs)

        for scenario, error in (("eval-timeout", "timeout"), ("eval-output", "invalid_summary")):
            with self.subTest(scenario=scenario), patch.object(subprocess, "run", run_with_short_timeout):
                out, _, _ = self.run_live_cli(scenario)
                scoreboard = json.loads((out / "latest.json").read_text(encoding="utf-8"))
                self.assertEqual(scoreboard["mode"], "live")
                self.assertEqual([arm["arm"] for arm in scoreboard["arms"]], ["A", "B", "C"])
                a, b, c = scoreboard["arms"]
                self.assertGreater(a["hidden_total"], 0)
                self.assertEqual(a["hidden_passed"], a["hidden_total"])
                self.assertEqual(b["hidden_total"], a["hidden_total"])
                self.assertEqual(c["hidden_total"], a["hidden_total"])
                self.assertEqual((b["hidden_passed"], b["hidden_pass_rate"], b["eval_error"]), (0, 0.0, error))
                self.assertGreater(c["hidden_passed"], 0)
                self.assertNotIn("eval_error", a)
                self.assertNotIn("eval_error", c)
                markdown = (out / "latest.md").read_text(encoding="utf-8")
                self.assertIn(f"0.0% (0/{a['hidden_total']})", markdown)
                self.assertIn(f"Arm B hidden evaluation failed (`{error}`)", markdown)


if __name__ == "__main__":
    unittest.main()
