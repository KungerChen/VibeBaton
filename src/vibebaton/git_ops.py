"""Git worktree concurrency isolation, path whitelist guard, and safe squash merges."""

from __future__ import annotations

import fnmatch
import os
import shutil
import subprocess
import sys
from collections.abc import Callable, Iterable
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol, TypedDict


class GitError(RuntimeError):
    """Raised when a git command fails."""


class MergeConflictError(GitError):
    """A squash merge could not complete its conflict resolution."""

    def __init__(
        self,
        source_branch: str,
        target_branch: str,
        conflicted_files: list[str],
        *,
        reason: str = "",
    ) -> None:
        self.source_branch = source_branch
        self.target_branch = target_branch
        self.conflicted_files = list(conflicted_files)
        self.reason = reason
        message = f"Merge conflict merging '{source_branch}' into '{target_branch}'"
        if conflicted_files:
            message += f": {', '.join(conflicted_files)}"
        if reason:
            message += f" ({reason})"
        super().__init__(message)


class MergeResult(TypedDict):
    merged: bool
    conflicts: list[str]
    resolved_by_ai: bool


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


def backup_tag_name(run_id: str) -> str:
    return f"baton-backup/{run_id}"


def create_backup_tag(repo: Path, run_id: str, base_branch: str) -> str:
    """Tag the base branch head as ``baton-backup/<run_id>`` (lightweight); an existing tag is kept as-is."""
    tag = backup_tag_name(run_id)
    exists = _run_git(repo, ["rev-parse", "-q", "--verify", f"refs/tags/{tag}"], check=False)
    if exists.returncode != 0:
        _run_git(repo, ["tag", tag, base_branch])
    return tag


def uncommitted_paths(repo: Path) -> list[str]:
    """Paths with uncommitted (staged, unstaged or untracked) changes, ignoring VibeBaton's ``.baton/`` state."""
    out = _run_git(repo, ["status", "--porcelain", "-z"]).stdout
    entries = [entry for entry in out.split("\0") if entry]
    paths: list[str] = []
    skip_next = False
    for entry in entries:
        if skip_next:  # the original path of a rename/copy entry
            skip_next = False
            continue
        code, path = entry[:2], entry[3:]
        skip_next = "R" in code or "C" in code
        if not (path == ".baton" or path.startswith(".baton/")):
            paths.append(path)
    return paths


def restore_backup_tag(repo: Path, run_id: str, base_branch: str) -> str:
    """Check out base_branch and hard-reset it to ``baton-backup/<run_id>``; returns the restored commit."""
    tag = backup_tag_name(run_id)
    target = _run_git(repo, ["rev-parse", "-q", "--verify", f"refs/tags/{tag}^{{commit}}"], check=False)
    if target.returncode != 0:
        raise GitError(f"No backup tag '{tag}' to restore")
    return reset_branch_to(repo, base_branch, target.stdout.strip())


def reset_branch_to(repo: Path, branch: str, commit: str) -> str:
    """Check out ``branch`` and hard-reset it to ``commit``; refuses on uncommitted changes outside ``.baton/``."""
    dirty = uncommitted_paths(repo)
    if dirty:
        raise GitError(f"Refusing to roll back: uncommitted changes in {', '.join(dirty)}")
    _run_git(repo, ["checkout", "-q", branch])
    _run_git(repo, ["reset", "-q", "--hard", commit])
    return commit


def ensure_branch(repo: Path, branch_name: str, start_point: str) -> None:
    check = _run_git(repo, ["rev-parse", "--verify", branch_name], check=False)
    if check.returncode != 0:
        _run_git(repo, ["branch", branch_name, start_point])


def _attach_shared_node_modules(repo: Path, worktree_dir: Path) -> None:
    """Mount repo's pre-warmed web/node_modules into a worktree via junction/symlink so frontend gates run offline."""
    repo_nm = (repo / "web" / "node_modules").resolve()
    wt_web = worktree_dir / "web"
    wt_nm = wt_web / "node_modules"
    is_junc = hasattr(os.path, "isjunction") and os.path.isjunction(wt_nm)
    if not repo_nm.is_dir() or not wt_web.is_dir() or wt_nm.exists() or is_junc:
        return
    if sys.platform == "win32":
        subprocess.run(
            ["cmd", "/c", "mklink", "/J", str(wt_nm), str(repo_nm)],
            capture_output=True,
            check=False,
        )
    else:
        os.symlink(repo_nm, wt_nm, target_is_directory=True)


def _detach_shared_node_modules(worktree_dir: Path) -> None:
    """Safely unlink any mounted web/node_modules junction/symlink without deleting the shared target."""
    wt_nm = worktree_dir / "web" / "node_modules"
    if sys.platform == "win32" and hasattr(os.path, "isjunction") and os.path.isjunction(wt_nm):
        os.rmdir(wt_nm)
    elif wt_nm.is_symlink():
        wt_nm.unlink(missing_ok=True)


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
    _attach_shared_node_modules(repo, worktree_dir)
    return worktree_dir


def remove_worktree(repo: Path, worktree_dir: Path, branch_name: str | None = None) -> None:
    """Cleanly remove a git worktree and optionally delete its short-lived branch."""
    worktree_dir = worktree_dir.resolve()
    _detach_shared_node_modules(worktree_dir)
    _run_git(repo, ["worktree", "remove", "--force", str(worktree_dir)], check=False)
    if worktree_dir.exists():
        shutil.rmtree(worktree_dir, ignore_errors=True)
    _run_git(repo, ["worktree", "prune"], check=False)
    if branch_name:
        _run_git(repo, ["branch", "-D", branch_name], check=False)


_EPHEMERAL_DIR_NAMES = frozenset(
    {"__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache", "node_modules", ".vite"}
)


def _is_ephemeral_artifact(rel_path: str) -> bool:
    norm = rel_path.replace("\\", "/").lstrip("./")
    if norm == ".baton" or norm.startswith(".baton/"):
        return True
    if norm == "web/dist" or norm.startswith("web/dist/"):
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
    *,
    on_merge_failure: Callable[[Path, subprocess.CompletedProcess[str]], None] | None = None,
) -> None:
    """Squash-merge source_branch into target_branch using a temporary integration worktree.

    The optional failure handler can repair a failed squash in the same worktree.
    Returning from the handler allows the repaired merge to commit.
    """
    worktree_root = worktree_root.resolve()
    merge_wt = worktree_root / f"_merge_{target_branch.replace('/', '_')}"
    if merge_wt.parent != worktree_root or merge_wt.resolve() != merge_wt:
        raise GitError(f"Invalid merge worktree path for branch '{target_branch}'")
    worktree_root.mkdir(parents=True, exist_ok=True)
    if merge_wt.exists():
        remove_worktree(repo, merge_wt)

    try:
        _run_git(repo, ["worktree", "add", "--", str(merge_wt), target_branch])
        merge_res = _run_git(merge_wt, ["merge", "--squash", "--", source_branch], check=False)
        if merge_res.returncode != 0:
            if on_merge_failure is None:
                _run_git(merge_wt, ["merge", "--abort"], check=False)
                raise GitError(
                    f"Merge conflict merging '{source_branch}' into '{target_branch}': "
                    f"{merge_res.stderr.strip() or merge_res.stdout.strip()}"
                )
            on_merge_failure(merge_wt, merge_res)
        if on_merge_failure is not None:
            _run_git(merge_wt, ["add", "-A"])
        if _git_paths(merge_wt, ["diff", "--cached", "--name-only", "-z"]):
            _run_git(merge_wt, ["commit", "-m", commit_message])
    except MergeConflictError:
        # Squash merges can leave a conflicted index without MERGE_HEAD.
        _run_git(merge_wt, ["merge", "--abort"], check=False)
        _run_git(merge_wt, ["reset", "--hard"], check=False)
        _run_git(merge_wt, ["clean", "-fd"], check=False)
        raise
    finally:
        remove_worktree(repo, merge_wt)


def _git_paths(worktree_dir: Path, args: list[str]) -> list[str]:
    """Parse the NUL-delimited paths returned by Git's -z option."""
    return [path for path in _run_git(worktree_dir, args).stdout.split("\0") if path]


def has_conflict_markers(worktree_dir: Path, files: Iterable[str] | None = None) -> list[str]:
    """Find Git conflict markers in the given relative paths or in changed and untracked files."""
    if files is None:
        files = _git_paths(worktree_dir, ["diff", "--name-only", "-z", "HEAD"])
        files += _git_paths(worktree_dir, ["ls-files", "--others", "--exclude-standard", "-z"])

    worktree_dir = worktree_dir.resolve()
    flagged: list[str] = []
    for name in sorted({Path(file).as_posix() for file in files}):
        relative = Path(name)
        if relative.anchor or ".." in relative.parts or name.startswith(".baton/"):
            continue
        path = worktree_dir / relative
        if path.is_symlink() or not path.is_file() or not path.resolve().is_relative_to(worktree_dir):
            continue
        with path.open("rb") as stream:
            prefix = stream.read(8192)
            if b"\0" in prefix:
                continue
            content = prefix + stream.read()
        try:
            lines = content.decode("utf-8").splitlines()
        except UnicodeDecodeError:
            continue
        if any(line == "=======" or line.startswith(("<<<<<<< ", ">>>>>>> ")) for line in lines):
            flagged.append(name)
    return flagged


_CONFLICT_EXCERPT_CHARS = 4000


def _conflict_excerpt(text: str) -> str:
    excerpt = text[:_CONFLICT_EXCERPT_CHARS]
    if "\0" in excerpt:
        return "[binary content]"
    if len(text) > _CONFLICT_EXCERPT_CHARS:
        return excerpt + "\n[truncated]"
    return excerpt


def _build_conflict_context(worktree_dir: Path, conflicted_files: list[str]) -> str:
    sections: list[str] = []
    for file in conflicted_files:
        sections.append(f"File: {file}")
        for stage, label in enumerate(("base", "ours", "theirs"), start=1):
            result = _run_git(worktree_dir, ["show", f":{stage}:{file}"], check=False)
            excerpt = _conflict_excerpt(result.stdout) if result.returncode == 0 else "[missing]"
            sections.append(f"{label} (stage {stage})\n{excerpt}")
        path = worktree_dir / file
        working_copy = "[missing]"
        if path.is_file() and not path.is_symlink():
            with path.open(encoding="utf-8", errors="replace") as stream:
                working_copy = _conflict_excerpt(stream.read(_CONFLICT_EXCERPT_CHARS + 1))
        sections.append(f"working copy\n{working_copy}")
    return "\n\n".join(sections)


class _SquashMerge(Protocol):
    def __call__(
        self,
        repo: Path,
        source_branch: str,
        target_branch: str,
        commit_message: str,
        worktree_root: Path,
        *,
        on_merge_failure: Callable[[Path, subprocess.CompletedProcess[str]], None],
    ) -> None: ...


def merge_branch_with_resolver(
    repo: Path,
    source_branch: str,
    target_branch: str,
    commit_message: str,
    worktree_root: Path,
    *,
    resolver: Callable[[Path, list[str], str], bool] | None = None,
    gate_checker: Callable[[Path], bool] | None = None,
    max_attempts: int = 1,
    squash_merge: _SquashMerge = merge_branch_into,
) -> MergeResult:
    """Squash-merge in an isolated worktree, with bounded conflict resolution retries.

    The resolver edits the worktree and returns True when its resolution is ready.
    Each attempt receives the original conflict context. The optional gate checks
    the staged resolution before the target branch advances.
    """
    conflicted: list[str] = []

    def handle_failed_merge(merge_wt: Path, merge: subprocess.CompletedProcess[str]) -> None:
        nonlocal conflicted
        unmerged_paths = ["diff", "--name-only", "--diff-filter=U", "-z"]
        conflicted = sorted(set(_git_paths(merge_wt, unmerged_paths)))
        if not conflicted:
            reason = merge.stderr.strip() or merge.stdout.strip()
            raise MergeConflictError(source_branch, target_branch, conflicted, reason=reason)
        if resolver is None:
            raise MergeConflictError(source_branch, target_branch, conflicted)

        context = _build_conflict_context(merge_wt, conflicted)
        for _ in range(max_attempts):
            try:
                resolved = resolver(merge_wt, conflicted.copy(), context)
            except Exception as exc:
                raise MergeConflictError(source_branch, target_branch, conflicted, reason="resolver failed") from exc

            # A deletion staged on a previous attempt may now be absent from the index and disk.
            indexed = set(_git_paths(merge_wt, ["--literal-pathspecs", "ls-files", "-z", "--", *conflicted]))
            to_stage = [file for file in conflicted if file in indexed or os.path.lexists(merge_wt / file)]
            if to_stage:
                _run_git(merge_wt, ["--literal-pathspecs", "add", "-A", "--", *to_stage])
            markers = has_conflict_markers(merge_wt, conflicted)
            unmerged = _git_paths(merge_wt, unmerged_paths)
            if resolved and not markers and not unmerged:
                break
        else:
            raise MergeConflictError(source_branch, target_branch, conflicted, reason="resolution attempts exhausted")

        if gate_checker is not None:
            try:
                _attach_shared_node_modules(repo, merge_wt)
                passed = gate_checker(merge_wt)
            except Exception as exc:
                raise MergeConflictError(source_branch, target_branch, conflicted, reason="gate checker failed") from exc
            finally:
                _detach_shared_node_modules(merge_wt)
            if not passed:
                raise MergeConflictError(source_branch, target_branch, conflicted, reason="gate rejected resolution")

    squash_merge(repo, source_branch, target_branch, commit_message, worktree_root, on_merge_failure=handle_failed_merge)
    return {"merged": True, "conflicts": conflicted, "resolved_by_ai": bool(conflicted)}
