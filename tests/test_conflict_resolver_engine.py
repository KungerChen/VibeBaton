"""Golden example for resolving parallel task conflicts through the real engine."""

from __future__ import annotations

import asyncio
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from typing import Any
from unittest.mock import patch

from vibebaton.cli_runner import CLIResult
from vibebaton.config import HotReloadConfig, ProviderConfig
from vibebaton.db import StateStore
from vibebaton.engine import OrchestrationEngine
from vibebaton.evidence import gate_receipts
from vibebaton.gates import run_gate_suite
from vibebaton.report import compute_run_telemetry
from vibebaton.schemas import RunStatus, TaskStatus


class TestConflictResolverEngine(unittest.TestCase):
    base = "features = search\n"
    task_edits = {
        "T-EXPORT": "features = search, export\n",
        "T-ALERTS": "features = search, alerts\n",
    }
    merged = "features = search, export, alerts\n"

    def setUp(self) -> None:
        self.root = Path(self.enterContext(tempfile.TemporaryDirectory())).resolve()
        self.repo = self.root / "repo"
        self.repo.mkdir()
        self.enterContext(patch.dict(os.environ, {
            "GIT_CONFIG_GLOBAL": os.devnull,
            "GIT_CONFIG_NOSYSTEM": "1",
            "GIT_AUTHOR_NAME": "VibeBaton Test",
            "GIT_AUTHOR_EMAIL": "test@vibebaton.local",
            "GIT_COMMITTER_NAME": "VibeBaton Test",
            "GIT_COMMITTER_EMAIL": "test@vibebaton.local",
        }))
        self.git("init", "-b", "main")
        (self.repo / "features.txt").write_text(self.base, encoding="utf-8")
        (self.repo / ".gitignore").write_text("/.baton/\n/web/node_modules/\n", encoding="utf-8")
        dependency_dir = self.repo / "web" / "node_modules"
        dependency_dir.mkdir(parents=True)
        (dependency_dir / "test-dependency.txt").write_text("prewarmed\n", encoding="utf-8")
        (dependency_dir.parent / "package.json").write_text("{}\n", encoding="utf-8")
        (self.repo / "verify.py").write_text(
            "from pathlib import Path\n"
            "import sys\n"
            "content = Path('features.txt').read_text(encoding='utf-8')\n"
            "assert 'search' in content and '<<<<<<< ' not in content\n"
            "assert Path('web/node_modules/test-dependency.txt').is_file()\n"
            "if '--single-edit' in sys.argv:\n"
            "    assert ('export' in content) != ('alerts' in content)\n",
            encoding="utf-8",
        )
        self.git("add", ".")
        self.git("commit", "-m", "Seed features and their verification gate")
        self.rfc = self.root / "rfc.md"
        self.rfc.write_text("Add export and alerts in parallel.\n", encoding="utf-8")
        self.store = StateStore(self.repo / ".baton" / "state.sqlite")
        self.run_id = self.store.create_run(self.repo, self.rfc)
        self.milestone_branch = f"milestone/{self.run_id[-6:]}-m1"
        self.worktrees = self.root / "worktrees"
        self.resolver_calls: list[tuple[Path, str]] = []

    def git(self, *args: str) -> str:
        result = subprocess.run(
            ["git", *args], cwd=self.repo, capture_output=True, text=True, encoding="utf-8", check=False,
        )
        self.assertEqual(result.returncode, 0, f"git {' '.join(args)}\n{result.stderr or result.stdout}")
        return result.stdout

    async def execute_pipeline(
        self, *, auto_resolve: bool = True, leave_markers: bool = False, reject_merged: bool = False,
    ) -> RunStatus:
        command = f'"{sys.executable}" verify.py'
        task_command = f"{command} --single-edit" if reject_merged else command
        plan = {
            "rfc_version": "v1.0",
            "complexity_tier": "M",
            "milestones": [{
                "id": "M1",
                "title": "Feature coverage",
                "gate_commands": [command],
                "tasks": [
                    {"id": task_id, "title": task_id, "tier": "critical",
                     "allowed_paths": ["features.txt"], "verify_cmd": task_command}
                    for task_id in self.task_edits
                ],
            }],
        }
        cfg_path = self.root / "baton.json"
        cfg_path.write_text(json.dumps({
            "daemon": {"base_branch": "main", "dev_branch": "dev", "prevent_sleep_windows": False,
                       "worktree_root": str(self.worktrees)},
            "policies": {"auto_resolve_merge_conflicts": auto_resolve, "max_conflict_resolve_attempts": 2},
            "providers": {"test": {"max_concurrency": 2}},
            "roles": {
                role: {"provider": "test", "model": role}
                for role in ("tactical_planner", "critical_executor", "conflict_resolver", "milestone_reviewer")
            },
        }), encoding="utf-8")
        engine = OrchestrationEngine(self.repo, HotReloadConfig(cfg_path), self.store)
        workers_ready = asyncio.Barrier(2)

        async def invoke_provider(
            provider: ProviderConfig, *, cwd: Path, prompt: str, extra_env: dict[str, str], **kwargs: Any,
        ) -> CLIResult:
            role = extra_env["VIBEBATON_ROLE"]
            output = ""
            if role == "tactical_planner":
                output = json.dumps(plan)
            elif role == "critical_executor":
                features = cwd / "features.txt"
                self.assertEqual(features.read_text(encoding="utf-8"), self.base)
                features.write_text(self.task_edits[extra_env["VIBEBATON_TASK_ID"]], encoding="utf-8")
                await workers_ready.wait()  # Both branches start from the same base.
            elif role == "conflict_resolver":
                self.resolver_calls.append((cwd, prompt))
                if not leave_markers:
                    (cwd / "features.txt").write_text(self.merged, encoding="utf-8")
            elif role == "milestone_reviewer":
                output = json.dumps({"verdict": "PASS", "summary": "Feature coverage passed"})
            else:
                self.fail(f"Unexpected role {role}")
            return CLIResult(status="ok", exit_code=0, stdout=output, stderr="", duration_sec=0, command=[])

        with (
            patch("vibebaton.engine.invoke_provider", side_effect=invoke_provider),
            patch("vibebaton.engine.run_gate_suite", wraps=run_gate_suite) as gates,
        ):
            status = await asyncio.wait_for(engine.execute_run(self.run_id), timeout=30)
        self.merge_gate_calls = [
            (call.args[0], call.kwargs["workdir"]) for call in gates.await_args_list
            if call.kwargs["workdir"].name.startswith("_merge_")
        ]
        self.assertEqual(list(self.worktrees.glob("_merge_*")), [])
        registered = self.git("worktree", "list", "--porcelain").splitlines()
        self.assertEqual(sum(line.startswith("worktree ") for line in registered), 1)
        self.assertEqual(self.git("branch", "--show-current"), "main\n")
        self.assertEqual(self.git("status", "--porcelain"), "")
        return status

    def conflict_events(self) -> list[tuple[str, dict[str, Any]]]:
        return [
            (event["kind"], json.loads(event["payload_json"])) for event in self.store.get_events(self.run_id)
            if event["kind"].startswith("merge_conflict_")
        ]

    def merge_receipts(self) -> list[tuple[str, str, bool]]:
        """(target, command, passed) of each receipt the merge gate left; the target is a task merge."""
        receipts = gate_receipts(self.store.get_events(self.run_id, limit=-1))
        self.assertEqual({r["target_id"] for r in receipts if r["scope"] == "task"}, set(self.task_edits))
        merges = [r for r in receipts if r["scope"] == "merge"]
        self.assertTrue(all(r["target_id"] in {f"task_{task_id}" for task_id in self.task_edits} for r in merges))
        return [(r["target_id"][:5], r["command"], r["passed"]) for r in merges]

    def assert_conflict_stopped_before_commit(self) -> None:
        self.assertEqual(self.git("show", "dev:features.txt"), self.base)
        self.assertIn(self.git("show", f"{self.milestone_branch}:features.txt"), self.task_edits.values())
        self.assertEqual(self.git("rev-list", "--count", f"main..{self.milestone_branch}"), "1\n")

    def test_synthesizes_parallel_edits_and_records_telemetry(self) -> None:
        status = asyncio.run(self.execute_pipeline())

        self.assertEqual(status, RunStatus.READY_FOR_FINAL_GATE, self.store.get_run(self.run_id)["summary"])
        self.assertEqual(self.git("show", f"{self.milestone_branch}:features.txt"), self.merged)
        self.assertEqual(self.git("show", "dev:features.txt"), self.merged)
        detected, resolved = self.conflict_events()
        self.assertEqual(detected[0], "merge_conflict_detected")
        self.assertEqual(detected[1]["target_branch"], self.milestone_branch)
        self.assertIn(detected[1]["source_branch"], [
            f"baton/{self.run_id[-6:]}/{task_id.lower()}" for task_id in self.task_edits
        ])
        self.assertEqual(detected[1]["conflicted_files"], ["features.txt"])
        self.assertEqual(resolved, ("merge_conflict_resolved", {"conflicted_files": ["features.txt"], "attempts": 1}))
        self.assertEqual(compute_run_telemetry(self.store, self.run_id)["conflicts"], {
            "conflicts_detected": 1, "conflicts_auto_resolved": 1, "conflicts_failed": 0,
        })
        [(resolver_cwd, prompt)] = self.resolver_calls
        self.assertEqual(resolver_cwd, self.worktrees / f"_merge_{self.milestone_branch.replace('/', '_')}")
        self.assertIn("synthesize both branches' intents", prompt.lower())
        for text in ("File: features.txt", "base (stage 1)", "ours (stage 2)", "theirs (stage 3)", "<<<<<<< "):
            self.assertIn(text, prompt)
        for content in (self.base, *self.task_edits.values()):
            self.assertIn(content.strip(), prompt)
        self.assertEqual(self.merge_gate_calls, [([f'"{sys.executable}" verify.py'], resolver_cwd)])
        self.assertEqual(self.merge_receipts(), [("task_", f'"{sys.executable}" verify.py', True)])

    def test_remaining_markers_exhaust_attempts_and_wait_for_human(self) -> None:
        status = asyncio.run(self.execute_pipeline(leave_markers=True))

        self.assertEqual(status, RunStatus.WAITING_HUMAN)
        self.assertCountEqual([task["status"] for task in self.store.get_tasks(self.run_id)], [
            TaskStatus.PASSED, TaskStatus.WAITING_HUMAN,
        ])
        self.assertEqual(len(self.resolver_calls), 2)
        self.assertEqual(self.merge_gate_calls, [])
        self.assertEqual(self.merge_receipts(), [])
        detected, failed = self.conflict_events()
        self.assertEqual(detected[0], "merge_conflict_detected")
        self.assertEqual(failed, ("merge_conflict_failed", {
            "conflicted_files": ["features.txt"], "reason": "resolution attempts exhausted",
        }))
        self.assert_conflict_stopped_before_commit()

    def test_gate_rejects_resolved_content_before_commit(self) -> None:
        status = asyncio.run(self.execute_pipeline(reject_merged=True))

        self.assertEqual(status, RunStatus.WAITING_HUMAN)
        [(resolver_cwd, _)] = self.resolver_calls
        self.assertEqual(self.merge_gate_calls, [([f'"{sys.executable}" verify.py --single-edit'], resolver_cwd)])
        self.assertEqual(self.merge_receipts(), [("task_", f'"{sys.executable}" verify.py --single-edit', False)])
        self.assertEqual(self.conflict_events()[-1], ("merge_conflict_failed", {
            "conflicted_files": ["features.txt"], "reason": "gate rejected resolution",
        }))
        self.assert_conflict_stopped_before_commit()

    def test_disabled_policy_uses_legacy_git_error(self) -> None:
        status = asyncio.run(self.execute_pipeline(auto_resolve=False))

        self.assertEqual(status, RunStatus.FAILED)
        self.assertEqual(self.resolver_calls, [])
        self.assertEqual(self.merge_gate_calls, [])
        self.assertEqual(self.conflict_events(), [])
        [error] = [event for event in self.store.get_events(self.run_id) if event["kind"] == "git_error"]
        self.assertIn("Merge conflict merging", error["message"])
        self.assert_conflict_stopped_before_commit()
