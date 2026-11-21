"""Git worktree concurrency isolation, path whitelist guard, and safe squash merges."""

from __future__ import annotations

import fnmatch
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path


class GitError(RuntimeError):
    """Raised when a git command fails."""


@dataclass
class WhitelistCheckResult:
    ok: bool
    changed_files: list[str]
    violations: list[str]


def _run_git(repo: Path, args: list[str], check: bool = True) -> subprocess.CompletedProcess[str]:
    proc = subprocess.run(
        ["git", *args],
        cwd=str(repo),
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        check=False,
    )
    if check and proc.returncode != 0:
        raise GitError(f"git {' '.join(args)} failed ({proc.returncode}): {proc.stderr.strip() or proc.stdout.strip()}")
    return proc


def ensure_git_ready(repo: Path, base_branch: str, dev_branch: str) -> str:
    """Verify git repo, enable longpaths on Windows, and ensure dev_branch exists."""
    _run_git(repo, ["rev-parse", "--is-inside-work-tree"])
    _run_git(repo, ["config", "core.longpaths", "true"], check=False)

    # Resolve current branch if base_branch doesn't exist yet
    base_check = _run_git(repo, ["rev-parse", "--verify", base_branch], check=False)
    if base_check.returncode != 0:
        current = _run_git(repo, ["rev-parse", "--abbrev-ref", "HEAD"]).stdout.strip()
        base_branch = current

    dev_check = _run_git(repo, ["rev-parse", "--verify", dev_branch], check=False)
    if dev_check.returncode != 0:
        _run_git(repo, ["branch", dev_branch, base_branch])

    return base_branch


def ensure_branch(repo: Path, branch_name: str, start_point: str) -> None:
    check = _run_git(repo, ["rev-parse", "--verify", branch_name], check=False)
    if check.returncode != 0:
        _run_git(repo, ["branch", branch_name, start_point])


def create_worktree(
    repo: Path,
    worktree_dir: Path,
    branch_name: str,
    start_point: str,
) -> Path:
    """Create an isolated git worktree on a fresh branch."""
    worktree_dir = worktree_dir.resolve()
    if worktree_dir.exists():
        remove_worktree(repo, worktree_dir, branch_name=None)

    worktree_dir.parent.mkdir(parents=True, exist_ok=True)
    # Remove stale branch if left behind by a crashed run
    branch_exists = _run_git(repo, ["rev-parse", "--verify", branch_name], check=False).returncode == 0
    if branch_exists:
        _run_git(repo, ["worktree", "add", str(worktree_dir), branch_name])
    else:
        _run_git(repo, ["worktree", "add", "-b", branch_name, str(worktree_dir), start_point])
    return worktree_dir


def remove_worktree(repo: Path, worktree_dir: Path, branch_name: str | None = None) -> None:
    """Cleanly remove a git worktree and optionally delete its short-lived branch."""
    worktree_dir = worktree_dir.resolve()
    _run_git(repo, ["worktree", "remove", "--force", str(worktree_dir)], check=False)
    if worktree_dir.exists():
        shutil.rmtree(worktree_dir, ignore_errors=True)
    _run_git(repo, ["worktree", "prune"], check=False)
    if branch_name:
        _run_git(repo, ["branch", "-D", branch_name], check=False)


_EPHEMERAL_DIR_NAMES = frozenset({"__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache"})


def _is_ephemeral_artifact(rel_path: str) -> bool:
    norm = rel_path.replace("\\", "/").lstrip("./")
    if norm == ".baton" or norm.startswith(".baton/"):
        return True
    parts = norm.split("/")
    if any(part in _EPHEMERAL_DIR_NAMES for part in parts):
        return True
    return norm.endswith((".pyc", ".pyo"))


def list_changed_files(worktree_dir: Path, base_ref: str = "HEAD") -> list[str]:
    """Return all modified, staged, or untracked relative POSIX paths inside a worktree."""
    files: set[str] = set()
    # Uncommitted & untracked files
    porcelain = _run_git(worktree_dir, ["status", "--porcelain", "-uall"]).stdout
    for line in porcelain.splitlines():
        if len(line) >= 4:
            raw_path = line[3:].strip()
            if " -> " in raw_path:
                raw_path = raw_path.split(" -> ", 1)[1].strip()
            files.add(raw_path.strip('"').replace("\\", "/"))

    # Committed files relative to merge-base with base_ref (immune to sibling merges advancing base_ref)
    if base_ref != "HEAD":
        diff_out = _run_git(worktree_dir, ["diff", "--name-only", f"{base_ref}...HEAD"], check=False).stdout
        for line in diff_out.splitlines():
            clean = line.strip().replace("\\", "/")
            if clean:
                files.add(clean)

    # Ignore internal .baton runtime metadata and ephemeral tool/Python caches
    return sorted(f for f in files if not _is_ephemeral_artifact(f))


def _matches_any_glob(rel_path: str, patterns: list[str]) -> bool:
    norm = rel_path.replace("\\", "/").lstrip("./")
    for raw_pat in patterns:
        pat = raw_pat.replace("\\", "/").lstrip("./")
        if fnmatch.fnmatch(norm, pat):
            return True
        # Handle directory prefix globs like "src/repos/**" matching nested files
        if pat.endswith("/**"):
            prefix = pat[:-3].rstrip("/")
            if norm == prefix or norm.startswith(prefix + "/"):
                return True
        if pat.endswith("/*"):
            prefix = pat[:-2].rstrip("/")
            if norm.startswith(prefix + "/") and "/" not in norm[len(prefix) + 1 :]:
                return True
    return False


def check_path_whitelist(
    worktree_dir: Path,
    allowed_paths: list[str],
    base_ref: str = "HEAD",
) -> WhitelistCheckResult:
    """Enforce physical write-scope guard: reject edits outside allowed_paths."""
    changed = list_changed_files(worktree_dir, base_ref=base_ref)
    if not allowed_paths:
        return WhitelistCheckResult(ok=True, changed_files=changed, violations=[])
    violations = [f for f in changed if not _matches_any_glob(f, allowed_paths)]
    return WhitelistCheckResult(ok=len(violations) == 0, changed_files=changed, violations=violations)


def revert_disallowed_files(worktree_dir: Path, violations: list[str], base_ref: str = "HEAD") -> None:
    """Restore or delete files that violated the allowed_paths whitelist."""
    restore_ref = "HEAD"
    if base_ref != "HEAD":
        mb = _run_git(worktree_dir, ["merge-base", base_ref, "HEAD"], check=False).stdout.strip()
        if mb:
            restore_ref = mb
    for rel in violations:
        tracked = _run_git(worktree_dir, ["cat-file", "-e", f"{restore_ref}:{rel}"], check=False).returncode == 0
        if tracked:
            _run_git(worktree_dir, ["checkout", restore_ref, "--", rel], check=False)
        else:
            _run_git(worktree_dir, ["rm", "--cached", "--ignore-unmatch", "--", rel], check=False)
            target = worktree_dir / rel
            if target.exists():
                if target.is_dir():
                    shutil.rmtree(target, ignore_errors=True)
                else:
                    target.unlink(missing_ok=True)


def commit_worktree_changes(worktree_dir: Path, message: str) -> bool:
    """Stage and commit all worktree changes (excluding .baton/ and ephemeral tool caches). Returns True if a commit was created."""
    _run_git(worktree_dir, ["add", "-A"])
    staged_all = [
        line.strip().replace("\\", "/")
        for line in _run_git(worktree_dir, ["diff", "--cached", "--name-only"]).stdout.splitlines()
        if line.strip()
    ]
    ignored = [p for p in staged_all if _is_ephemeral_artifact(p)]
    if ignored:
        _run_git(worktree_dir, ["reset", "-q", "--", *ignored], check=False)
    staged = _run_git(worktree_dir, ["diff", "--cached", "--name-only"]).stdout.strip()
    if not staged:
        return False
    _run_git(worktree_dir, ["commit", "-m", message])
    return True


def get_diff_against(worktree_or_repo: Path, base_ref: str, head_ref: str | None = None, max_chars: int = 40000) -> str:
    """Extract unified git diff for AI review."""
    target = head_ref or "HEAD"
    args = ["diff", f"{base_ref}...{target}"] if base_ref != target else ["diff", base_ref]
    out = _run_git(worktree_or_repo, args, check=False).stdout
    if len(out) > max_chars:
        return out[:max_chars] + f"\n\n... [diff truncated at {max_chars} chars] ..."
    return out


def merge_branch_into(
    repo: Path,
    source_branch: str,
    target_branch: str,
    commit_message: str,
    worktree_root: Path,
) -> None:
    """Squash-merge source_branch into target_branch using a temporary integration worktree.

    Using an isolated integration worktree means the user's main working directory
    is never switched or dirtied during background/overnight execution!
    """
    merge_wt = (worktree_root / f"_merge_{target_branch.replace('/', '_')}").resolve()
    if merge_wt.exists():
        remove_worktree(repo, merge_wt)
    merge_wt.parent.mkdir(parents=True, exist_ok=True)
    _run_git(repo, ["worktree", "add", str(merge_wt), target_branch])
    try:
        merge_res = _run_git(merge_wt, ["merge", "--squash", source_branch], check=False)
        if merge_res.returncode != 0:
            _run_git(merge_wt, ["merge", "--abort"], check=False)
            raise GitError(
                f"Merge conflict merging '{source_branch}' into '{target_branch}': "
                f"{merge_res.stderr.strip() or merge_res.stdout.strip()}"
            )
        staged = _run_git(merge_wt, ["diff", "--cached", "--name-only"]).stdout.strip()
        if staged:
            _run_git(merge_wt, ["commit", "-m", commit_message])
    finally:
        remove_worktree(repo, merge_wt)
