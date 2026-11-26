"""Golden examples for isolated run lineage Git operations; no network required.

Work record 20261126-054354-m1-t2-lineage-git (2026-11-26 05:43 PST).
Scope: M1-T2's three allowed paths, on baton/e33e97/m1-t2 at b1e6809.
Implemented SHA/branch/drift operations, isolated merge and atomic ref rewind;
the fixture also selects this worktree's source over an editable main checkout.
Verification: this module's 16 tests passed on Windows; 36 DB/core/conflict
tests passed with PYTHONPATH=src and GIT_CONFIG_COUNT=0. Without that test-only
setting, existing conflict tests lose inherited empty Git config values after
patch.dict restores the Windows environment; they fail before running Git.
Status: self-tested, pending user acceptance; engine/API wiring remains later work.
Rollback reference: the diff from b1e6809 and this newly added test file. No
commit was created. Project LOG/LOG-INDEX updates are outside the whitelist.
"""

from __future__ import annotations

import subprocess
import unittest
from pathlib import Path
from unittest.mock import patch

from tests.lineage_fixtures import LineageFixture
from vibebaton import git_ops


class LineageGitTestCase(unittest.TestCase):
    def setUp(self) -> None:
        self.fixture = LineageFixture()
        self.addCleanup(self.fixture.cleanup)
        self.repo = self.fixture.repo

    def git(self, *args: str) -> str:
        return self.fixture.git(*args)

    def commit(self, filename: str, contents: str, message: str) -> str:
        return self.fixture.add_commit(filename, contents, message)

    def worktrees(self) -> str:
        return self.git("worktree", "list", "--porcelain")


class TestLineageRefs(LineageGitTestCase):
    def test_resolve_full_commit_sha_and_reject_non_commits(self) -> None:
        initial = self.fixture.initial_sha
        self.git("tag", "-a", "release", "-m", "A tagged commit", initial)
        blob = self.git("rev-parse", "main:README.md")
        self.assertEqual(git_ops.resolve_ref_sha(self.repo), initial)
        self.assertEqual(git_ops.resolve_ref_sha(self.repo, initial[:12]), initial)
        self.assertEqual(git_ops.resolve_ref_sha(self.repo, "release"), initial)
        for invalid in ("missing", blob, "--all"):
            with self.subTest(ref=invalid), self.assertRaises(git_ops.GitError):
                git_ops.resolve_ref_sha(self.repo, invalid)

    def test_fresh_and_revision_branches_start_at_the_explicit_commits(self) -> None:
        initial = self.fixture.initial_sha
        self.git("branch", "baton/run", initial)
        current_main = self.commit("manual.txt", "manual\n", "Manual main commit")
        self.assertEqual(git_ops.create_run_branch_at(self.repo, "baton/run", current_main), "baton/run")
        self.assertEqual(self.git("rev-parse", "baton/run"), current_main)
        self.assertEqual(self.git("rev-parse", "main"), current_main)

        # A revision uses its parent result even when that differs from main.
        self.assertEqual(git_ops.create_run_branch_at(self.repo, "baton/revision", initial), "baton/revision")
        self.assertEqual(self.git("rev-parse", "baton/revision"), initial)
        self.assertEqual(self.git("rev-parse", "main"), current_main)

    def test_branch_reset_refuses_a_branch_checked_out_in_any_worktree(self) -> None:
        initial = self.fixture.initial_sha
        advanced = self.commit("manual.txt", "manual\n", "Advance main")
        self.git("branch", "baton/checked-out", initial)
        linked = self.fixture.root / "linked worktree"
        self.git("worktree", "add", str(linked), "baton/checked-out")
        self.addCleanup(lambda: self.git("worktree", "remove", "--force", str(linked)))
        for branch, expected in (("main", advanced), ("baton/checked-out", initial)):
            with self.subTest(branch=branch), self.assertRaises(git_ops.GitError):
                git_ops.create_run_branch_at(self.repo, branch, advanced)
            self.assertEqual(self.git("rev-parse", f"refs/heads/{branch}"), expected)

    def test_drift_detects_advance_rewind_and_unrelated_rewrite(self) -> None:
        initial = self.fixture.initial_sha
        self.assertFalse(git_ops.has_ref_advanced(self.repo, "main", initial))
        advanced = self.commit("manual.txt", "manual\n", "Advance main")
        self.assertTrue(git_ops.has_ref_advanced(self.repo, "main", initial))
        self.assertFalse(git_ops.has_ref_advanced(self.repo, "main", advanced))
        self.assertFalse(git_ops.has_ref_advanced(self.repo, initial, initial))
        self.git("reset", "--hard", initial)
        self.assertTrue(git_ops.has_ref_advanced(self.repo, "main", advanced))
        rewritten = self.commit("other.txt", "other\n", "Rewrite main")
        self.assertTrue(git_ops.has_ref_advanced(self.repo, "main", advanced))
        self.assertNotEqual(rewritten, advanced)
        with self.assertRaises(git_ops.GitError):
            git_ops.has_ref_advanced(self.repo, "missing", initial)

    def test_is_head_commit_resolves_commits_and_uses_the_branch_not_a_same_named_tag(self) -> None:
        initial = self.fixture.initial_sha
        advanced = self.commit("manual.txt", "manual\n", "Advance main")
        self.git("tag", "main", initial)
        self.assertEqual(git_ops.resolve_ref_sha(self.repo), advanced)
        self.assertFalse(git_ops.has_ref_advanced(self.repo, "main", advanced))
        self.assertTrue(git_ops.is_head_commit(self.repo, "main", advanced[:12]))
        self.assertFalse(git_ops.is_head_commit(self.repo, "main", initial))
        with self.assertRaises(git_ops.GitError):
            git_ops.is_head_commit(self.repo, "missing", advanced)
        with self.assertRaises(git_ops.GitError):
            git_ops.is_head_commit(self.repo, "main", "missing")


class TestIsolatedIntegration(LineageGitTestCase):
    def setUp(self) -> None:
        super().setUp()
        self.worktree_root = self.fixture.root / "integration worktrees"
        self.worktree_root.mkdir()

    def assert_cleaned(self, before_worktrees: str) -> None:
        self.assertEqual(self.worktrees(), before_worktrees)
        self.assertEqual(list(self.worktree_root.iterdir()), [])

    def test_diverged_result_preserves_main_and_dirty_user_worktree_without_git_identity(self) -> None:
        self.git("checkout", "-b", "baton/run")
        result_sha = self.commit("feature.txt", "feature\n", "Run result")
        self.git("checkout", "main")
        base_sha = self.commit("manual.txt", "manual\n", "Manual main commit")
        (self.repo / "README.md").write_text("staged\n", encoding="utf-8")
        self.git("add", "README.md")
        (self.repo / "README.md").write_text("staged and unstaged\n", encoding="utf-8")
        (self.repo / "user notes.txt").write_text("untouched\n", encoding="utf-8")
        before_status = self.git("status", "--porcelain=v1", "-z")
        before_index = self.git("diff", "--cached")
        before_files = {name: (self.repo / name).read_bytes() for name in ("README.md", "user notes.txt")}
        before_worktrees = self.worktrees()

        # The result is a real merge commit even when neither the repo nor the
        # machine has a Git identity configured.
        self.git("config", "--local", "--unset", "user.name")
        self.git("config", "--local", "--unset", "user.email")
        identity = subprocess.run(
            ["git", "var", "GIT_COMMITTER_IDENT"], cwd=self.repo, env=self.fixture._git_env,
            capture_output=True, text=True, check=False,
        )
        self.assertNotEqual(identity.returncode, 0)
        subprocess_run = git_ops.subprocess.run

        def run_without_git_identity(*args, **kwargs):
            kwargs["env"] = self.fixture._git_env
            return subprocess_run(*args, **kwargs)

        with patch.object(git_ops.subprocess, "run", side_effect=run_without_git_identity):
            result = git_ops.integrate_in_isolated_worktree(
                self.repo, base_sha, result_sha, worktree_root=self.worktree_root,
            )
        integrated = result["integrated_sha"]
        self.assertIsNotNone(integrated)
        assert integrated is not None
        self.assertEqual(result["conflicts"], [])
        self.assertEqual(self.git("show", "-s", "--format=%P", integrated).split(), [base_sha, result_sha])
        self.assertEqual(self.git("show", f"{integrated}:manual.txt"), "manual")
        self.assertEqual(self.git("show", f"{integrated}:feature.txt"), "feature")
        self.assertEqual(self.git("rev-parse", "main"), base_sha)
        self.assertEqual(self.git("rev-parse", "baton/run"), result_sha)
        self.assertEqual(self.git("status", "--porcelain=v1", "-z"), before_status)
        self.assertEqual(self.git("diff", "--cached"), before_index)
        self.assertEqual({name: (self.repo / name).read_bytes() for name in before_files}, before_files)
        self.assert_cleaned(before_worktrees)

    def test_conflict_reports_exact_unicode_path_and_removes_worktree(self) -> None:
        filename = "conflict 文件.txt"
        self.commit(filename, "original\n", "Add shared file")
        self.git("checkout", "-b", "baton/run")
        result_sha = self.commit(filename, "result\n", "Change from run")
        self.git("checkout", "main")
        base_sha = self.commit(filename, "main\n", "Change on main")
        (self.repo / "user.txt").write_text("leave me\n", encoding="utf-8")
        before_status = self.git("status", "--porcelain=v1", "-z")
        before_worktrees = self.worktrees()
        result = git_ops.integrate_in_isolated_worktree(
            self.repo, "main", result_sha, worktree_root=self.worktree_root,
        )
        self.assertEqual(result, {"integrated_sha": None, "conflicts": [filename]})
        self.assertEqual(self.git("rev-parse", "main"), base_sha)
        self.assertEqual(self.git("status", "--porcelain=v1", "-z"), before_status)
        self.assertEqual((self.repo / filename).read_text(encoding="utf-8"), "main\n")
        self.assertEqual((self.repo / "user.txt").read_text(encoding="utf-8"), "leave me\n")
        self.assert_cleaned(before_worktrees)

    def test_non_conflict_git_failure_raises_and_removes_worktree(self) -> None:
        self.git("checkout", "--orphan", "unrelated")
        unrelated = self.commit("independent.txt", "independent\n", "Independent root")
        self.git("checkout", "main")
        before_worktrees = self.worktrees()
        with self.assertRaises(git_ops.GitError):
            git_ops.integrate_in_isolated_worktree(
                self.repo, "main", unrelated, worktree_root=self.worktree_root,
            )
        self.assertEqual(self.git("rev-parse", "main"), self.fixture.initial_sha)
        self.assert_cleaned(before_worktrees)

    def test_failure_after_worktree_registration_is_cleaned_up(self) -> None:
        before_worktrees = self.worktrees()
        original = git_ops._run_git

        def fail_after_add(repo: Path, args: list[str], check: bool = True):
            result = original(repo, args, check=check)
            if args[:2] == ["worktree", "add"]:
                raise git_ops.GitError("simulated failure after worktree registration")
            return result

        with patch.object(git_ops, "_run_git", side_effect=fail_after_add):
            with self.assertRaises(git_ops.GitError):
                git_ops.integrate_in_isolated_worktree(
                    self.repo, "main", self.fixture.initial_sha, worktree_root=self.worktree_root,
                )
        self.assert_cleaned(before_worktrees)

    def test_default_temporary_root_also_removes_the_worktree(self) -> None:
        before_worktrees = self.worktrees()
        result = git_ops.integrate_in_isolated_worktree(self.repo, "main", self.fixture.initial_sha)
        self.assertEqual(result, {"integrated_sha": self.fixture.initial_sha, "conflicts": []})
        self.assertEqual(self.worktrees(), before_worktrees)

    def test_ancestor_cases_and_immutable_base_sha(self) -> None:
        initial = self.fixture.initial_sha
        self.git("checkout", "-b", "baton/run")
        result_sha = self.commit("feature.txt", "feature\n", "Run result")
        self.git("checkout", "main")
        advanced_main = self.commit("manual.txt", "manual\n", "Advance main")
        before_worktrees = self.worktrees()
        for base, result, expected in (
            (initial, result_sha, result_sha),
            (advanced_main, initial, advanced_main),
            (initial, initial, initial),
        ):
            with self.subTest(base=base, result=result):
                integration = git_ops.integrate_in_isolated_worktree(
                    self.repo, base, result, worktree_root=self.worktree_root,
                )
                self.assertEqual(integration, {"integrated_sha": expected, "conflicts": []})
                self.assertEqual(self.git("rev-parse", "main"), advanced_main)
                self.assert_cleaned(before_worktrees)


class TestLineageRewind(LineageGitTestCase):
    def setUp(self) -> None:
        super().setUp()
        self.a = self.fixture.initial_sha
        self.git("checkout", "-b", "baton/run")
        self.b = self.commit("work.txt", "B\n", "First run result")
        self.c = self.commit("work.txt", "C\n", "Revision result")
        self.git("checkout", "main")

    def test_revert_latest_revision_and_reset_whole_chain_to_exact_shas(self) -> None:
        self.assertEqual(git_ops.revert_range(self.repo, "baton/run", self.c, self.b), self.b)
        self.assertEqual(self.git("rev-parse", "baton/run"), self.b)
        self.assertEqual(self.git("rev-parse", "main"), self.a)
        self.assertEqual(git_ops.reset_branch_to(self.repo, "baton/run", self.a), self.a)
        self.assertEqual(self.git("rev-parse", "HEAD"), self.a)
        self.assertFalse((self.repo / "work.txt").exists())

        self.git("checkout", "main")
        self.git("branch", "baton/whole-chain", self.c)
        self.assertEqual(git_ops.reset_branch_to(self.repo, "baton/whole-chain", self.a), self.a)
        self.assertEqual(self.git("rev-parse", "baton/whole-chain"), self.a)

    def test_rewind_rejects_stale_head_and_non_ancestor_without_moving_branch(self) -> None:
        self.git("checkout", "main")
        unrelated = self.commit("manual.txt", "manual\n", "Separate main result")
        for start, target in ((self.b, self.a), (self.c, unrelated), (self.c, "missing")):
            with self.subTest(start=start, target=target), self.assertRaises(git_ops.GitError):
                git_ops.revert_range(self.repo, "baton/run", start, target)
            self.assertEqual(self.git("rev-parse", "baton/run"), self.c)

    def test_rewind_compares_and_swaps_the_expected_old_head(self) -> None:
        original = git_ops._run_git

        def move_before_update(repo: Path, args: list[str], check: bool = True):
            if args and args[0] == "update-ref":
                self.git("update-ref", "refs/heads/baton/run", self.a, self.c)
            return original(repo, args, check=check)

        with patch.object(git_ops, "_run_git", side_effect=move_before_update):
            with self.assertRaises(git_ops.GitError):
                git_ops.revert_range(self.repo, "baton/run", self.c, self.b)
        self.assertEqual(self.git("rev-parse", "baton/run"), self.a)

    def test_ref_only_rewind_preserves_a_checked_out_worktree_and_index(self) -> None:
        self.git("checkout", "baton/run")
        (self.repo / "work.txt").write_text("staged work\n", encoding="utf-8")
        self.git("add", "work.txt")
        (self.repo / "work.txt").write_text("unstaged work\n", encoding="utf-8")
        before_index = self.git("show", ":work.txt")
        before_file = (self.repo / "work.txt").read_bytes()
        self.assertEqual(git_ops.revert_range(self.repo, "baton/run", self.c, self.b), self.b)
        self.assertEqual(self.git("rev-parse", "HEAD"), self.b)
        self.assertEqual(self.git("show", ":work.txt"), before_index)
        self.assertEqual((self.repo / "work.txt").read_bytes(), before_file)

    def test_reset_refuses_to_overwrite_uncommitted_user_changes(self) -> None:
        (self.repo / "README.md").write_text("uncommitted\n", encoding="utf-8")
        with self.assertRaises(git_ops.GitError):
            git_ops.reset_branch_to(self.repo, "baton/run", self.a)
        self.assertEqual(self.git("branch", "--show-current"), "main")
        self.assertEqual(self.git("rev-parse", "baton/run"), self.c)
        self.assertEqual((self.repo / "README.md").read_text(encoding="utf-8"), "uncommitted\n")


if __name__ == "__main__":
    unittest.main()
