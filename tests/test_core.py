"""Unit tests for config hot-reload, schemas, SQLite WAL state/quotas, and Git worktree whitelist guard."""

from __future__ import annotations

import json
import os
import subprocess
import tempfile
import time
import unittest
from pathlib import Path

from vibebaton.config import HotReloadConfig, parse_config_dict
from vibebaton.db import StateStore
from vibebaton.git_ops import (
    check_path_whitelist,
    commit_worktree_changes,
    create_worktree,
    ensure_git_ready,
    merge_branch_into,
    remove_worktree,
    revert_disallowed_files,
)
from vibebaton.schemas import (
    PlanDAG,
    ReviewVerdict,
    SchemaValidationError,
    VerdictKind,
    extract_json_object,
)


def _init_temp_git_repo(repo_dir: Path) -> None:
    subprocess.run(["git", "init", "-b", "main"], cwd=str(repo_dir), check=True, capture_output=True)
    subprocess.run(["git", "config", "user.email", "test@vibebaton.local"], cwd=str(repo_dir), check=True)
    subprocess.run(["git", "config", "user.name", "VibeBaton Test"], cwd=str(repo_dir), check=True)
    (repo_dir / "README.md").write_text("# Demo\n", encoding="utf-8")
    (repo_dir / "src").mkdir()
    (repo_dir / "src" / "core.py").write_text("VALUE = 1\n", encoding="utf-8")
    subprocess.run(["git", "add", "-A"], cwd=str(repo_dir), check=True)
    subprocess.run(["git", "commit", "-m", "init"], cwd=str(repo_dir), check=True, capture_output=True)


class TestConfigAndSchemas(unittest.TestCase):
    def test_legacy_claude_model_ids_in_overrides_are_migrated(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            cfg_file = Path(tmp) / "baton.toml"
            cfg_file.write_text(
                '[providers.claude_sub]\ncommand = ["echo"]\n'
                '[providers.p2]\ncommand = ["echo"]\n'
                '[roles.worker]\nprovider = "claude_sub"\nmodel = "opus@high"\n',
                encoding="utf-8",
            )
            cfg = HotReloadConfig(cfg_file).current
            cases = {
                "claude_sub:opus-5.5@medium": "claude-opus-5-5@medium",
                "claude_sub:fable-5.2": "claude-fable-5-2",
                "sonnet-5.5@max": "claude-sonnet-5-5@max",
                "haiku-5.5": "claude-haiku-5-5",
                "claude_sub:claude-opus-5-5@high": "claude-opus-5-5@high",
                "opus@high": "opus@high",
            }
            for override, expected in cases.items():
                role, _ = cfg.resolve_role("worker", model_overrides={"worker": override})
                self.assertEqual(role.model, expected, override)
            # Other providers keep whatever id they were given.
            role, prov = cfg.resolve_role("worker", model_overrides={"worker": "p2:opus-5.5@high"})
            self.assertEqual((prov.name, role.model), ("p2", "opus-5.5@high"))

    def test_hot_reload_and_role_override(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            cfg_file = Path(tmp) / "baton.toml"
            cfg_file.write_text(
                '[providers.p1]\ncommand = ["echo"]\n'
                '[providers.p2]\ncommand = ["echo"]\n'
                '[roles.worker]\nprovider = "p1"\nmodel = "m-v1"\n',
                encoding="utf-8",
            )
            loader = HotReloadConfig(cfg_file)
            role, prov = loader.current.resolve_role("worker")
            self.assertEqual(role.model, "m-v1")
            self.assertEqual(prov.name, "p1")

            # Override model & provider dynamically
            role_ov, prov_ov = loader.current.resolve_role("worker", model_overrides={"worker": "p2:m-v2"})
            self.assertEqual(role_ov.model, "m-v2")
            self.assertEqual(prov_ov.name, "p2")

            # Modify file on disk -> hot reload picks up new model
            time.sleep(0.05)
            cfg_file.write_text(
                '[providers.p1]\ncommand = ["echo"]\n'
                '[roles.worker]\nprovider = "p1"\nmodel = "m-v3"\n',
                encoding="utf-8",
            )
            os.utime(cfg_file, (time.time() + 2, time.time() + 2))
            self.assertEqual(loader.current.roles["worker"].model, "m-v3")

    def test_plan_dag_cycle_detection(self) -> None:
        cyclic = {
            "rfc_version": "v1",
            "complexity_tier": "M",
            "milestones": [
                {
                    "id": "M1",
                    "title": "Cyclic",
                    "tasks": [
                        {"id": "T1", "title": "A", "depends_on": ["T2"]},
                        {"id": "T2", "title": "B", "depends_on": ["T1"]},
                    ],
                }
            ],
        }
        with self.assertRaises(SchemaValidationError):
            PlanDAG.from_dict(cyclic)

    def test_extract_json_from_fenced_markdown(self) -> None:
        noisy = 'Sure, here is your review:\n```json\n{"verdict": "PASS", "summary": "clean"}\n```\nDone!'
        obj = extract_json_object(noisy)
        verdict = ReviewVerdict.from_dict(obj, default_target="T1", default_reviewer="astra")
        self.assertEqual(verdict.verdict, VerdictKind.PASS)
        self.assertEqual(verdict.target_id, "T1")


class TestDBAndQuotas(unittest.TestCase):
    def test_quota_cooldown_and_reset(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            store = StateStore(Path(tmp) / "state.sqlite")
            self.assertEqual(store.get_provider_cooldown("claude_sub"), 0.0)
            wait = store.trigger_provider_cooldown("claude_sub", [2, 5], reason="429 rate limit")
            self.assertEqual(wait, 2.0)
            self.assertGreater(store.get_provider_cooldown("claude_sub"), 0.5)
            store.reset_provider_backoff("claude_sub")
            self.assertEqual(store.get_provider_cooldown("claude_sub"), 0.0)


class TestGitWorktreeAndWhitelist(unittest.TestCase):
    def test_whitelist_guard_and_squash_merge(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp) / "repo"
            repo.mkdir()
            _init_temp_git_repo(repo)
            ensure_git_ready(repo, "main", "dev")

            wt_root = repo / ".baton" / "worktrees"
            wt = create_worktree(repo, wt_root / "t1", "baton/t1", "dev")
            try:
                # Write an allowed file + a forbidden file
                (wt / "src" / "feature.py").write_text("OK = True\n", encoding="utf-8")
                (wt / "README.md").write_text("ILLEGAL EDIT\n", encoding="utf-8")

                wl = check_path_whitelist(wt, ["src/feature.py"], base_ref="dev")
                self.assertFalse(wl.ok)
                self.assertEqual(wl.violations, ["README.md"])

                revert_disallowed_files(wt, wl.violations, base_ref="dev")
                wl2 = check_path_whitelist(wt, ["src/feature.py"], base_ref="dev")
                self.assertTrue(wl2.ok)

                committed = commit_worktree_changes(wt, "feat: add feature")
                self.assertTrue(committed)
                merge_branch_into(repo, "baton/t1", "dev", "feat(t1): add feature", wt_root)
            finally:
                remove_worktree(repo, wt, branch_name="baton/t1")

            # Verify dev branch has src/feature.py while main working tree remained untouched
            self.assertFalse((repo / "src" / "feature.py").exists())
            show = subprocess.run(
                ["git", "show", "dev:src/feature.py"],
                cwd=str(repo),
                capture_output=True,
                text=True,
                check=True,
            )
            self.assertIn("OK = True", show.stdout)

    def test_ensure_git_ready_unborn_repo_creates_empty_root_commit(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp) / "unborn"
            repo.mkdir()
            subprocess.run(["git", "init", "-q", "-b", "main", str(repo)], check=True, capture_output=True)
            (repo / "notes.txt").write_text("keep untracked\n", encoding="utf-8")

            env = {
                k: v
                for k, v in os.environ.items()
                if not k.startswith("GIT_") and k not in ("HOME", "USERPROFILE", "XDG_CONFIG_HOME")
            }
            env["HOME"] = tmp
            env["USERPROFILE"] = tmp
            old_env = os.environ.copy()
            os.environ.clear()
            os.environ.update(env)
            try:
                base = ensure_git_ready(repo, "main", "dev")
            finally:
                os.environ.clear()
                os.environ.update(old_env)

            self.assertEqual(base, "main")
            main_sha = subprocess.run(
                ["git", "rev-parse", "--verify", "main^{commit}"],
                cwd=str(repo),
                capture_output=True,
                text=True,
                check=True,
            ).stdout.strip()
            dev_sha = subprocess.run(
                ["git", "rev-parse", "--verify", "dev^{commit}"],
                cwd=str(repo),
                capture_output=True,
                text=True,
                check=True,
            ).stdout.strip()
            self.assertEqual(main_sha, dev_sha)
            ls_files = subprocess.run(
                ["git", "ls-files"],
                cwd=str(repo),
                capture_output=True,
                text=True,
                check=True,
            ).stdout.strip()
            self.assertEqual(ls_files, "")


if __name__ == "__main__":
    unittest.main()
