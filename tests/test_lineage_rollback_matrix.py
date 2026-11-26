"""Rollback and drift matrix for the lineage Git primitives; no network required."""

from __future__ import annotations

import unittest
from pathlib import Path

from tests.lineage_fixtures import LineageFixture
from vibebaton import git_ops


RUN_BRANCH = "baton/run"


def guarded_merged_undo(repo: Path, branch: str, merged_sha: str, target_sha: str) -> str:
    """Apply the lineage contract's caller-side guard before resetting the base.

    ``reset_branch_to`` is a hard reset, so it must never run after the base has
    moved past the run's merge and would drop commits that landed afterwards.
    """
    if not git_ops.is_head_commit(repo, branch, merged_sha):
        raise git_ops.GitError(f"Refusing merged undo: {merged_sha} is no longer the head of {branch}")
    return git_ops.reset_branch_to(repo, branch, target_sha)


class LineageRollbackTestCase(unittest.TestCase):
    def setUp(self) -> None:
        self.fixture = LineageFixture()
        self.addCleanup(self.fixture.cleanup)
        self.repo = self.fixture.repo
        self.a = self.fixture.initial_sha
        self.git("checkout", "-b", RUN_BRANCH, self.a)
        self.b = self.fixture.add_commit("work.txt", "B\n", "Produce B")
        self.c = self.fixture.add_commit("work.txt", "C\n", "Produce C")
        self.git("checkout", "main")
        self.worktree_root = self.fixture.root / "integration worktrees"
        self.worktree_root.mkdir()
        self.assertEqual(self.git("rev-parse", "main"), self.a)
        self.assertEqual(self.git("rev-parse", RUN_BRANCH), self.c)

    def git(self, *args: str) -> str:
        return self.fixture.git(*args)

    def prepare_run_branch(self) -> None:
        self.assertEqual(git_ops.create_run_branch_at(self.repo, RUN_BRANCH, self.c), RUN_BRANCH)
        self.assertEqual(self.git("rev-parse", RUN_BRANCH), self.c)

    def reset_base(self) -> None:
        self.git("checkout", "main")
        self.git("reset", "--hard", self.a)
        self.assertEqual(self.git("rev-parse", "main"), self.a)

    def integrate_latest(self) -> str:
        before_worktrees = self.git("worktree", "list", "--porcelain")
        result = git_ops.integrate_in_isolated_worktree(
            self.repo, self.a, self.c, worktree_root=self.worktree_root,
        )
        self.assertEqual(result["conflicts"], [])
        integrated = result["integrated_sha"]
        self.assertIsNotNone(integrated)
        assert integrated is not None
        self.assertEqual(self.git("worktree", "list", "--porcelain"), before_worktrees)
        self.assertEqual(list(self.worktree_root.iterdir()), [])
        return integrated


class TestUnmergedRollbackMatrix(LineageRollbackTestCase):
    def test_revert_latest_revision_lands_on_exact_b(self) -> None:
        self.prepare_run_branch()
        self.assertEqual(git_ops.revert_range(self.repo, RUN_BRANCH, self.c, self.b), self.b)
        self.assertEqual(self.git("rev-parse", RUN_BRANCH), self.b)
        self.assertEqual(self.git("rev-parse", "main"), self.a)
        self.assertEqual(self.git("rev-parse", "HEAD"), self.a)
        self.assertFalse((self.repo / "work.txt").exists())

    def test_abandon_whole_chain_lands_on_exact_a(self) -> None:
        self.prepare_run_branch()
        self.assertEqual(git_ops.revert_range(self.repo, RUN_BRANCH, self.c, self.a), self.a)
        self.assertEqual(self.git("rev-parse", RUN_BRANCH), self.a)
        self.assertEqual(self.git("rev-parse", "main"), self.a)
        self.assertEqual(self.git("rev-parse", "HEAD"), self.a)
        self.assertFalse((self.repo / "work.txt").exists())

    def test_rewind_matrix_refuses_a_stale_head_or_foreign_target(self) -> None:
        self.prepare_run_branch()
        with self.subTest(case="stale head"):
            with self.assertRaises(git_ops.GitError):
                git_ops.revert_range(self.repo, RUN_BRANCH, self.b, self.a)
            self.assertEqual(self.git("rev-parse", RUN_BRANCH), self.c)

        advanced_main = self.fixture.add_commit("manual.txt", "manual\n", "Advance main")
        with self.subTest(case="target outside the run history"):
            with self.assertRaises(git_ops.GitError):
                git_ops.revert_range(self.repo, RUN_BRANCH, self.c, advanced_main)
            self.assertEqual(self.git("rev-parse", RUN_BRANCH), self.c)
            self.assertEqual(self.git("rev-parse", "main"), advanced_main)


class TestMergedUndoMatrix(LineageRollbackTestCase):
    def test_merged_undo_only_resets_while_the_merge_is_head(self) -> None:
        cases = (
            ("merge commit is still the base head", False),
            ("base advanced after the merge", True),
        )
        for name, advanced in cases:
            with self.subTest(case=name):
                self.reset_base()
                self.prepare_run_branch()
                result = self.integrate_latest()
                self.git("merge", "--no-ff", "-m", "Merge the run result", result)
                merged = self.git("rev-parse", "main")
                self.assertEqual(self.git("show", "-s", "--format=%P", merged).split(), [self.a, result])
                self.assertEqual(self.git("rev-parse", "main"), merged)

                if advanced:
                    moved = self.fixture.add_commit("after.txt", "after\n", "Advance main after merge")
                    self.assertEqual(self.git("rev-parse", "main"), moved)
                    self.assertFalse(git_ops.is_head_commit(self.repo, "main", merged))
                    with self.assertRaisesRegex(git_ops.GitError, "no longer the head"):
                        guarded_merged_undo(self.repo, "main", merged, self.a)
                    self.assertEqual(self.git("rev-parse", "main"), moved)
                    self.assertEqual(self.git("rev-parse", RUN_BRANCH), self.c)
                    self.assertTrue((self.repo / "after.txt").is_file())
                else:
                    self.assertTrue(git_ops.is_head_commit(self.repo, "main", merged))
                    self.assertEqual(guarded_merged_undo(self.repo, "main", merged, self.a), self.a)
                    self.assertEqual(self.git("rev-parse", "main"), self.a)
                    self.assertEqual(self.git("rev-parse", "HEAD"), self.a)
                    self.assertEqual(self.git("rev-parse", RUN_BRANCH), self.c)
                    self.assertFalse((self.repo / "work.txt").exists())


class TestDriftMatrix(LineageRollbackTestCase):
    def test_drift_matrix_reports_advance_rewind_and_matching_heads(self) -> None:
        cases = (
            ("not detected at the root", self.a, self.a, False),
            ("detected after main advances", self.a, self.b, True),
            ("not detected at the advanced head", self.b, self.b, False),
            ("detected after main rewinds", self.b, self.a, True),
        )
        for name, recorded, head, expected in cases:
            with self.subTest(case=name):
                self.git("checkout", "main")
                self.git("reset", "--hard", head)
                self.assertEqual(self.git("rev-parse", "main"), head)
                self.assertEqual(git_ops.has_ref_advanced(self.repo, "main", recorded), expected)
                self.assertEqual(self.git("rev-parse", "main"), head)


class TestIntegrationCleanup(LineageRollbackTestCase):
    def test_integration_uses_the_exact_shas_and_leaves_no_worktree(self) -> None:
        cases = (
            ("explicit worktree root", self.worktree_root),
            ("default temporary worktree root", None),
        )
        for name, root in cases:
            with self.subTest(case=name):
                self.reset_base()
                self.prepare_run_branch()
                before_worktrees = self.git("worktree", "list", "--porcelain")
                result = git_ops.integrate_in_isolated_worktree(
                    self.repo, self.a, self.c, worktree_root=root,
                )
                integrated = result["integrated_sha"]
                self.assertIsNotNone(integrated)
                assert integrated is not None
                self.assertEqual(result["conflicts"], [])
                self.assertEqual(self.git("rev-parse", "main"), self.a)
                self.assertEqual(self.git("rev-parse", RUN_BRANCH), self.c)
                self.assertEqual(self.git("merge-base", self.a, integrated), self.a)
                self.assertEqual(self.git("merge-base", self.c, integrated), self.c)
                self.assertEqual(self.git("diff", self.c, integrated), "")
                self.assertEqual(self.git("worktree", "list", "--porcelain"), before_worktrees)
                if root is not None:
                    self.assertEqual(list(root.iterdir()), [])
        self.assertEqual(list(self.worktree_root.iterdir()), [])


if __name__ == "__main__":
    unittest.main()
