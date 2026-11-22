"""Real Git examples for the squash merge conflict resolution contract."""

from __future__ import annotations

import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

from vibebaton.config import HotReloadConfig, PolicySettings, parse_config_dict
from vibebaton.git_ops import (
    GitError,
    MergeConflictError,
    has_conflict_markers,
    merge_branch_into,
    merge_branch_with_resolver,
)


class _GitRepoTestCase(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = Path(self.enterContext(tempfile.TemporaryDirectory()))
        self.repo = self.temp_dir / "repo"
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

    def git(self, *args: str, cwd: Path | None = None, expected_returncode: int = 0) -> str:
        result = subprocess.run(
            ["git", *args], cwd=cwd or self.repo, capture_output=True,
            text=True, encoding="utf-8", check=False,
        )
        self.assertEqual(result.returncode, expected_returncode, f"git {' '.join(args)}\n{result.stderr or result.stdout}")
        return result.stdout

    def commit_file(self, file: str, content: str, message: str) -> None:
        (self.repo / file).write_text(content, encoding="utf-8")
        self.git("add", "--", file)
        self.git("commit", "-m", message)


class TestMergeWithResolver(_GitRepoTestCase):
    file = "features.txt"
    base = "features = search\n"
    ours = "features = search, export\n"
    theirs = "features = search, alerts\n"
    both = "features = search, export, alerts\n"
    source = "feature"
    target = "baton/integration"
    message = "Merge feature intents"

    def setUp(self) -> None:
        super().setUp()
        self.worktree_root = self.temp_dir / "worktrees"
        self.commit_file(self.file, self.base, "base")
        self.git("switch", "-c", self.target)
        self.commit_file(self.file, self.ours, "add export support")
        self.git("switch", "-c", self.source, "main")
        self.commit_file(self.file, self.theirs, "add alert support")
        self.git("switch", "main")
        self.target_head = self.git("rev-parse", self.target)

    def assert_merge_cleanup(self) -> None:
        self.assertEqual(self.git("branch", "--show-current"), "main\n")
        self.assertEqual(self.git("status", "--porcelain"), "")
        self.assertEqual((self.repo / self.file).read_text(encoding="utf-8"), self.base)
        worktrees = self.git("worktree", "list", "--porcelain").splitlines()
        self.assertEqual(sum(line.startswith("worktree ") for line in worktrees), 1)
        self.assertEqual(list(self.worktree_root.glob("_merge_*")), [])

    def assert_target_preserved(self) -> None:
        self.assertEqual(self.git("rev-parse", self.target), self.target_head)
        self.assert_merge_cleanup()

    def test_conflict_without_resolver_preserves_target_and_checkout(self) -> None:
        with self.assertRaises(MergeConflictError) as raised:
            merge_branch_with_resolver(self.repo, self.source, self.target, self.message, self.worktree_root)

        error = raised.exception
        self.assertIsInstance(error, GitError)
        self.assertEqual(error.source_branch, self.source)
        self.assertEqual(error.target_branch, self.target)
        self.assertEqual(error.conflicted_files, [self.file])
        self.assertIn(self.file, str(error))
        self.assert_target_preserved()

    def test_resolver_merges_both_intents(self) -> None:
        def resolver(worktree: Path, files: list[str], context: str) -> bool:
            self.assertEqual(worktree, self.worktree_root.resolve() / "_merge_baton_integration")
            self.assertEqual(self.git("branch", "--show-current"), "main\n")
            self.assertEqual(files, [self.file])
            self.assertIn(f"base (stage 1)\n{self.base}", context)
            self.assertIn(f"ours (stage 2)\n{self.ours}", context)
            self.assertIn(f"theirs (stage 3)\n{self.theirs}", context)
            self.assertIn("working copy\n<<<<<<< ", context)
            (worktree / self.file).write_text(self.both, encoding="utf-8")
            return True

        def gate_checker(worktree: Path) -> bool:
            self.assertEqual(self.git("diff", "--name-only", "--diff-filter=U", cwd=worktree), "")
            self.assertEqual(has_conflict_markers(worktree, [self.file]), [])
            self.assertEqual(self.git("show", f":{self.file}", cwd=worktree), self.both)
            return True

        result = merge_branch_with_resolver(
            self.repo, self.source, self.target, self.message, self.worktree_root,
            resolver=resolver, gate_checker=gate_checker,
        )

        self.assertEqual(result, {"merged": True, "conflicts": [self.file], "resolved_by_ai": True})
        self.assertEqual(self.git("show", f"{self.target}:{self.file}"), self.both)
        self.assertEqual(self.git("log", "-1", "--format=%s", self.target), f"{self.message}\n")
        self.assertEqual(self.git("rev-parse", f"{self.target}^"), self.target_head)
        self.assert_merge_cleanup()

    def test_resolver_recovers_interrupted_squash_merge(self) -> None:
        stale_worktree = self.worktree_root / "_merge_baton_integration"
        self.git("worktree", "add", "--", str(stale_worktree), self.target)
        self.git("merge", "--squash", "--", self.source, cwd=stale_worktree, expected_returncode=1)
        self.assertEqual(
            self.git("diff", "--name-only", "--diff-filter=U", cwd=stale_worktree), f"{self.file}\n",
        )
        scratch_file = "abandoned-resolution.txt"
        (stale_worktree / scratch_file).write_text("work from the interrupted run\n", encoding="utf-8")
        self.git("add", "--", scratch_file, cwd=stale_worktree)

        def resolver(worktree: Path, files: list[str], context: str) -> bool:
            self.assertFalse((worktree / scratch_file).exists())
            self.assertEqual(has_conflict_markers(worktree, files), [self.file])
            (worktree / self.file).write_text(self.both, encoding="utf-8")
            return True

        gate = Mock(return_value=True)
        result = merge_branch_with_resolver(
            self.repo, self.source, self.target, self.message, self.worktree_root,
            resolver=resolver, gate_checker=gate,
        )

        self.assertEqual(result, {"merged": True, "conflicts": [self.file], "resolved_by_ai": True})
        gate.assert_called_once_with(stale_worktree.resolve())
        self.assertEqual(self.git("show", f"{self.target}:{self.file}"), self.both)
        self.assertEqual(self.git("rev-parse", f"{self.target}^"), self.target_head)
        self.assertEqual(self.git("diff", "--name-only", f"{self.target}^", self.target), f"{self.file}\n")
        self.assert_merge_cleanup()

    def test_merge_rejects_redirected_integration_worktree(self) -> None:
        self.worktree_root.mkdir()
        merge_worktree = self.worktree_root / "_merge_baton_integration"
        unrelated = self.temp_dir / "unrelated"
        unrelated.mkdir()
        sentinel = unrelated / "keep.txt"
        sentinel.write_text("keep this file\n", encoding="utf-8")
        if os.name == "nt":
            subprocess.run(
                ["cmd", "/c", "mklink", "/J", str(merge_worktree), str(unrelated)],
                capture_output=True, check=True,
            )
        else:
            merge_worktree.symlink_to(unrelated, target_is_directory=True)

        for merge in (merge_branch_into, merge_branch_with_resolver):
            with self.subTest(merge=merge.__name__):
                with self.assertRaisesRegex(GitError, "Invalid merge worktree path"):
                    merge(self.repo, self.source, self.target, self.message, self.worktree_root)
                self.assertEqual(sentinel.read_text(encoding="utf-8"), "keep this file\n")
                self.assertEqual(self.git("rev-parse", self.target), self.target_head)

    def test_clean_merge_returns_status(self) -> None:
        self.git("switch", "-c", "clean-feature", "main")
        self.commit_file("notes.txt", "Release notes\n", "add release notes")
        self.git("switch", "main")
        callback = Mock(return_value=True)

        result = merge_branch_with_resolver(
            self.repo, "clean-feature", self.target, self.message, self.worktree_root,
            resolver=callback, gate_checker=callback,
        )

        self.assertEqual(result, {"merged": True, "conflicts": [], "resolved_by_ai": False})
        self.assertEqual(self.git("show", f"{self.target}:notes.txt"), "Release notes\n")
        callback.assert_not_called()
        self.assert_merge_cleanup()

    def test_missing_source_reports_empty_conflict_list(self) -> None:
        resolver = Mock(return_value=True)
        with self.assertRaises(MergeConflictError) as raised:
            merge_branch_with_resolver(
                self.repo, "missing", self.target, self.message, self.worktree_root, resolver=resolver,
            )

        self.assertEqual(raised.exception.conflicted_files, [])
        resolver.assert_not_called()
        self.assert_target_preserved()

    def test_exhausted_attempt_rejects_markers_in_staged_file(self) -> None:
        resolver = Mock(return_value=True)
        gate = Mock(return_value=True)
        with self.assertRaises(MergeConflictError):
            merge_branch_with_resolver(
                self.repo, self.source, self.target, self.message, self.worktree_root,
                resolver=resolver, gate_checker=gate,
            )

        resolver.assert_called_once()
        gate.assert_not_called()
        self.assert_target_preserved()

    def test_retries_after_markers_and_resolver_decline(self) -> None:
        contexts: list[str] = []

        def resolver(worktree: Path, files: list[str], context: str) -> bool:
            contexts.append(context)
            if len(contexts) == 1:
                return True  # Git can stage the file while the markers remain.
            (worktree / files[0]).write_text(self.both, encoding="utf-8")
            return len(contexts) == 3

        gate = Mock(return_value=True)
        result = merge_branch_with_resolver(
            self.repo, self.source, self.target, self.message, self.worktree_root,
            resolver=resolver, gate_checker=gate, max_attempts=3,
        )

        self.assertTrue(result["resolved_by_ai"])
        self.assertEqual(len(contexts), 3)
        self.assertEqual(contexts, [contexts[0]] * 3)
        gate.assert_called_once()
        self.assertEqual(self.git("show", f"{self.target}:{self.file}"), self.both)
        self.assert_merge_cleanup()

    def test_retries_after_conflicted_file_deletion_is_staged(self) -> None:
        self.git("switch", self.target)
        self.git("rm", "--", self.file)
        self.git("commit", "-m", "remove features file")
        self.git("switch", "main")
        self.target_head = self.git("rev-parse", self.target)
        attempts = 0

        def resolver(worktree: Path, files: list[str], context: str) -> bool:
            nonlocal attempts
            attempts += 1
            self.assertIn("ours (stage 2)\n[missing]", context)
            (worktree / files[0]).unlink(missing_ok=True)
            return attempts == 2

        result = merge_branch_with_resolver(
            self.repo, self.source, self.target, self.message, self.worktree_root,
            resolver=resolver, max_attempts=2,
        )

        self.assertEqual(result, {"merged": True, "conflicts": [self.file], "resolved_by_ai": True})
        self.assertEqual(attempts, 2)
        self.assert_target_preserved()

    def test_resolver_exception_preserves_target_and_checkout(self) -> None:
        failure = RuntimeError("resolver unavailable")
        resolver = Mock(side_effect=failure)
        with self.assertRaises(MergeConflictError) as raised:
            merge_branch_with_resolver(
                self.repo, self.source, self.target, self.message, self.worktree_root,
                resolver=resolver, max_attempts=2,
            )

        self.assertIs(raised.exception.__cause__, failure)
        resolver.assert_called_once()
        self.assert_target_preserved()

    def test_gate_failure_preserves_target_and_checkout(self) -> None:
        def resolve(worktree: Path, files: list[str], context: str) -> bool:
            (worktree / files[0]).write_text(self.both, encoding="utf-8")
            return True

        def reject(worktree: Path) -> bool:
            (worktree / "gate-output.txt").write_text("failed\n", encoding="utf-8")
            return False

        resolver = Mock(side_effect=resolve)
        gate = Mock(side_effect=reject)
        with self.assertRaises(MergeConflictError) as raised:
            merge_branch_with_resolver(
                self.repo, self.source, self.target, self.message, self.worktree_root,
                resolver=resolver, gate_checker=gate, max_attempts=2,
            )

        self.assertEqual(raised.exception.conflicted_files, [self.file])
        resolver.assert_called_once()
        gate.assert_called_once()
        self.assert_target_preserved()


class TestMergeResolverEdgeCases(_GitRepoTestCase):
    file = "features.txt"
    asset = "asset.bin"
    base = "features = search\n"
    ours = "features = search, export\n"
    theirs = "features = search, alerts\n"
    both = "features = search, export, alerts\n"
    source = "feature"
    target = "baton/integration"
    message = "Merge feature intents"

    def build_repo(self, name: str, *, binary: bool = False) -> tuple[Path, Path, str]:
        root = self.temp_dir / name
        repo = root / "repo"
        repo.mkdir(parents=True)
        self.git("init", "-b", "main", cwd=repo)
        self.commit_content(repo, self.file, self.base, "base")
        if binary:
            self.commit_bytes(repo, self.asset, b"base\0asset\n", "base asset")
        self.git("switch", "-c", self.target, cwd=repo)
        self.commit_content(repo, self.file, self.ours, "add export support")
        if binary:
            self.commit_bytes(repo, self.asset, b"<<<<<<< ours\0asset\n", "target asset")
        self.git("switch", "-c", self.source, "main", cwd=repo)
        self.commit_content(repo, self.file, self.theirs, "add alert support")
        if binary:
            self.commit_bytes(repo, self.asset, b"<<<<<<< theirs\0asset\n", "source asset")
        self.git("switch", "main", cwd=repo)
        return repo, root / "worktrees", self.git("rev-parse", self.target, cwd=repo)

    def commit_content(self, repo: Path, file: str, content: str, message: str) -> None:
        (repo / file).write_text(content, encoding="utf-8")
        self.git("add", "--", file, cwd=repo)
        self.git("commit", "-m", message, cwd=repo)

    def commit_bytes(self, repo: Path, file: str, content: bytes, message: str) -> None:
        (repo / file).write_bytes(content)
        self.git("add", "--", file, cwd=repo)
        self.git("commit", "-m", message, cwd=repo)

    def assert_target_preserved(self, repo: Path, worktree_root: Path, target_head: str) -> None:
        self.assertEqual(self.git("rev-parse", self.target, cwd=repo), target_head)
        self.assert_merge_cleanup(repo, worktree_root)

    def assert_merge_cleanup(self, repo: Path, worktree_root: Path) -> None:
        self.assertEqual(self.git("branch", "--show-current", cwd=repo), "main\n")
        self.assertEqual(self.git("status", "--porcelain", cwd=repo), "")
        self.assertEqual((repo / self.file).read_text(encoding="utf-8"), self.base)
        worktrees = self.git("worktree", "list", "--porcelain", cwd=repo).splitlines()
        self.assertEqual(sum(line.startswith("worktree ") for line in worktrees), 1)
        self.assertEqual(list(worktree_root.glob("_merge_*")), [])

    def scenario_marker_rejection(self) -> None:
        repo, worktree_root, target_head = self.build_repo("marker-rejection")
        checkout_head = self.git("rev-parse", "HEAD", cwd=repo)

        def resolver(worktree: Path, files: list[str], context: str) -> bool:
            (worktree / self.file).write_text(self.both + "<<<<<<< source\n", encoding="utf-8")
            return True

        with self.assertRaises(MergeConflictError) as raised:
            merge_branch_with_resolver(
                repo, self.source, self.target, self.message, worktree_root, resolver=resolver,
            )

        self.assertEqual(raised.exception.conflicted_files, [self.file])
        self.assertIn("attempts exhausted", str(raised.exception))
        self.assertEqual(self.git("rev-parse", "HEAD", cwd=repo), checkout_head)
        self.assert_target_preserved(repo, worktree_root, target_head)

    def scenario_gate_failure(self) -> None:
        repo, worktree_root, target_head = self.build_repo("gate-failure")

        def resolve(worktree: Path, files: list[str], context: str) -> bool:
            (worktree / self.file).write_text(self.both, encoding="utf-8")
            return True

        resolver = Mock(side_effect=resolve)
        gate = Mock(return_value=False)
        with self.assertRaises(MergeConflictError) as raised:
            merge_branch_with_resolver(
                repo, self.source, self.target, self.message, worktree_root,
                resolver=resolver, gate_checker=gate,
            )

        self.assertIn("gate rejected", str(raised.exception))
        resolver.assert_called_once()
        gate.assert_called_once()
        self.assert_target_preserved(repo, worktree_root, target_head)

    def scenario_retry_after_marker(self) -> None:
        repo, worktree_root, target_head = self.build_repo("retry-after-marker")
        attempts: list[str] = []

        def resolver(worktree: Path, files: list[str], context: str) -> bool:
            attempts.append(context)
            if len(attempts) == 2:
                (worktree / self.file).write_text(self.both, encoding="utf-8")
            return True

        result = merge_branch_with_resolver(
            repo, self.source, self.target, self.message, worktree_root,
            resolver=resolver, max_attempts=2,
        )

        self.assertEqual(result, {"merged": True, "conflicts": [self.file], "resolved_by_ai": True})
        self.assertEqual(len(attempts), 2)
        self.assertEqual(self.git("show", f"{self.target}:{self.file}", cwd=repo), self.both)
        self.assertEqual(self.git("rev-parse", f"{self.target}^", cwd=repo), target_head)
        self.assert_merge_cleanup(repo, worktree_root)

    def scenario_binary_conflict(self) -> None:
        repo, worktree_root, _ = self.build_repo("binary-conflict", binary=True)
        conflicted = [self.asset, self.file]

        def resolver(worktree: Path, files: list[str], context: str) -> bool:
            self.assertEqual(files, conflicted)
            self.assertEqual(has_conflict_markers(worktree, files), [self.file])
            self.assertIn("[binary content]", context)
            (worktree / self.file).write_text(self.both, encoding="utf-8")
            (worktree / self.asset).write_bytes(b"resolved\0asset\n")
            return True

        def gate(worktree: Path) -> bool:
            self.assertEqual(has_conflict_markers(worktree, conflicted), [])
            return True

        result = merge_branch_with_resolver(
            repo, self.source, self.target, self.message, worktree_root,
            resolver=resolver, gate_checker=gate,
        )

        self.assertEqual(result, {"merged": True, "conflicts": conflicted, "resolved_by_ai": True})
        self.assertEqual(self.git("show", f"{self.target}:{self.asset}", cwd=repo), "resolved\0asset\n")
        self.assertEqual(self.git("show", f"{self.target}:{self.file}", cwd=repo), self.both)
        self.assert_merge_cleanup(repo, worktree_root)

    def scenario_resolver_exception(self) -> None:
        repo, worktree_root, target_head = self.build_repo("resolver-exception")
        failure = RuntimeError("resolver unavailable")
        resolver = Mock(side_effect=failure)
        with self.assertRaises(MergeConflictError) as raised:
            merge_branch_with_resolver(
                repo, self.source, self.target, self.message, worktree_root,
                resolver=resolver, max_attempts=2,
            )

        self.assertIs(raised.exception.__cause__, failure)
        resolver.assert_called_once()
        self.assert_target_preserved(repo, worktree_root, target_head)

    def scenario_clean_merge(self) -> None:
        repo, worktree_root, target_head = self.build_repo("clean-merge")
        self.git("switch", "-c", "clean-feature", cwd=repo)
        self.commit_content(repo, "notes.txt", "Release notes\n", "add release notes")
        self.git("switch", "main", cwd=repo)
        resolver = Mock(return_value=True)
        gate = Mock(return_value=True)

        result = merge_branch_with_resolver(
            repo, "clean-feature", self.target, self.message, worktree_root,
            resolver=resolver, gate_checker=gate,
        )

        self.assertEqual(result, {"merged": True, "conflicts": [], "resolved_by_ai": False})
        self.assertEqual(self.git("show", f"{self.target}:notes.txt", cwd=repo), "Release notes\n")
        self.assertEqual(self.git("rev-parse", f"{self.target}^", cwd=repo), target_head)
        resolver.assert_not_called()
        gate.assert_not_called()
        self.assert_merge_cleanup(repo, worktree_root)

    def scenario_baton_marker_content(self) -> None:
        repo, worktree_root, _ = self.build_repo("baton-marker-content")

        def resolver(worktree: Path, files: list[str], context: str) -> bool:
            ignored = worktree / ".baton"
            ignored.mkdir(exist_ok=True)
            (ignored / "state.txt").write_text("<<<<<<< banner\n=======\n>>>>>>> banner\n", encoding="utf-8")
            self.assertEqual(has_conflict_markers(worktree, [".baton/state.txt", self.file]), [self.file])
            self.assertEqual(has_conflict_markers(worktree, [".baton/state.txt"]), [])
            (worktree / self.file).write_text(self.both, encoding="utf-8")
            (ignored / "state.txt").unlink()
            return True

        result = merge_branch_with_resolver(
            repo, self.source, self.target, self.message, worktree_root, resolver=resolver,
        )

        self.assertEqual(result, {"merged": True, "conflicts": [self.file], "resolved_by_ai": True})
        self.assertEqual(self.git("show", f"{self.target}:{self.file}", cwd=repo), self.both)
        self.assert_merge_cleanup(repo, worktree_root)

    def test_edge_case_scenarios(self) -> None:
        scenarios = (
            ("resolver leaves conflict marker", self.scenario_marker_rejection),
            ("gate rejects resolution", self.scenario_gate_failure),
            ("retry resolves after marker", self.scenario_retry_after_marker),
            ("binary conflict scans only text", self.scenario_binary_conflict),
            ("resolver raises an exception", self.scenario_resolver_exception),
            ("clean merge skips resolver", self.scenario_clean_merge),
            (".baton marker content is ignored", self.scenario_baton_marker_content),
        )
        for label, scenario in scenarios:
            with self.subTest(scenario=label):
                scenario()


class TestConflictMarkers(_GitRepoTestCase):
    def test_scans_changed_and_untracked_text_files(self) -> None:
        for file in ("z tracked.txt", "middle.txt", "deleted.txt"):
            (self.repo / file).write_text("plain text\n", encoding="utf-8")
        (self.repo / "unchanged.txt").write_text("<<<<<<< source\n", encoding="utf-8")
        (self.repo / ".gitignore").write_text("ignored.txt\n", encoding="utf-8")
        self.git("add", "-A")
        self.git("commit", "-m", "base files")

        (self.repo / "z tracked.txt").write_text(">>>>>>> source\n", encoding="utf-8")
        self.git("add", "--", "z tracked.txt")
        (self.repo / "middle.txt").write_text("<<<<<<< source\n", encoding="utf-8")
        (self.repo / "a-冲突.txt").write_bytes(b"before\r\n=======\r\n")
        (self.repo / "deleted.txt").unlink()
        (self.repo / "binary.bin").write_bytes(b"<<<<<<< source\n\0")
        (self.repo / "undecodable.txt").write_bytes(b"<<<<<<< source\n\xff")
        (self.repo / "near-misses.txt").write_text(
            "text >>>>>>> source\n <<<<<<< source\n======= \n========\n<<<<<<<\n", encoding="utf-8",
        )
        (self.repo / "ignored.txt").write_text("=======\n", encoding="utf-8")
        (self.repo / ".baton").mkdir()
        (self.repo / ".baton" / "state.txt").write_text("=======\n", encoding="utf-8")

        self.assertEqual(has_conflict_markers(self.repo), ["a-冲突.txt", "middle.txt", "z tracked.txt"])
        files = iter([
            "z tracked.txt", "./z tracked.txt", "a-冲突.txt", "unchanged.txt",
            "binary.bin", "undecodable.txt", "./.baton/state.txt", "deleted.txt", "near-misses.txt",
        ])
        self.assertEqual(has_conflict_markers(self.repo, files), ["a-冲突.txt", "unchanged.txt", "z tracked.txt"])


class TestConflictPolicySettings(unittest.TestCase):
    def test_policy_defaults(self) -> None:
        policies = PolicySettings()
        self.assertIs(policies.auto_resolve_merge_conflicts, True)
        self.assertEqual(policies.max_conflict_resolve_attempts, 1)

    def test_old_toml_loads_with_defaults(self) -> None:
        temp_dir = Path(self.enterContext(tempfile.TemporaryDirectory()))
        config = temp_dir / "baton.toml"
        config.write_text("[policies]\nmax_self_heal_attempts = 4\n", encoding="utf-8")
        policies = HotReloadConfig(config).current.policies
        self.assertEqual(policies.max_self_heal_attempts, 4)
        self.assertIs(policies.auto_resolve_merge_conflicts, True)
        self.assertEqual(policies.max_conflict_resolve_attempts, 1)

    def test_conflict_policy_overrides(self) -> None:
        config = parse_config_dict({"policies": {
            "auto_resolve_merge_conflicts": False,
            "max_conflict_resolve_attempts": 3,
        }})
        self.assertIs(config.policies.auto_resolve_merge_conflicts, False)
        self.assertEqual(config.policies.max_conflict_resolve_attempts, 3)

    def test_conflict_resolver_role_fallback_order(self) -> None:
        candidates = ("conflict_resolver", "critical_executor", "micro_orchestrator")
        config = parse_config_dict({"roles": {
            name: {"provider": "host_native", "model": name} for name in candidates
        }})
        for preferred in candidates:
            with self.subTest(configured=list(config.roles)):
                self.assertEqual(config.resolve_role_name(*candidates), preferred)
                del config.roles[preferred]
        with self.assertRaises(KeyError):
            config.resolve_role_name(*candidates)


if __name__ == "__main__":
    unittest.main()
