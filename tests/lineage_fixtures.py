"""Small, offline Git and SQLite fixtures for lineage tests."""

from __future__ import annotations

import os
import subprocess
import sys
import tempfile
from pathlib import Path
from types import TracebackType

# An editable install can point at the main checkout rather than this worktree.
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from vibebaton.db import StateStore


class LineageFixture:
    """Own a temporary repo on ``main`` and an independent Baton database.

    ``initial_sha`` is the first commit. Use ``add_commit`` for later revisions,
    and call ``cleanup`` (or use this fixture as a context manager) after a test.
    Git configuration and committer identity are local to the fixture.
    """

    def __init__(self) -> None:
        self._tempdir = tempfile.TemporaryDirectory(prefix="baton-lineage-")
        self.root = Path(self._tempdir.name)
        self.repo = self.root / "repo"
        self.repo.mkdir()
        self._git_env = {key: value for key, value in os.environ.items() if not key.startswith("GIT_")}
        self._git_env.update({
            "GIT_CONFIG_GLOBAL": os.devnull,
            "GIT_CONFIG_NOSYSTEM": "1",
            "GIT_TERMINAL_PROMPT": "0",
        })
        try:
            self.git("init", "-b", "main")
            self.git("config", "--local", "user.name", "VibeBaton Lineage Test")
            self.git("config", "--local", "user.email", "lineage-test@vibebaton.local")
            self.git("config", "--local", "commit.gpgsign", "false")
            self.initial_sha = self.add_commit("README.md", "Initial state\n", "Initial commit")
        except BaseException:
            self.cleanup()
            raise

    def git(self, *args: str) -> str:
        """Run Git inside the fixture repo and return stripped stdout."""
        result = subprocess.run(
            ["git", *args], cwd=self.repo, env=self._git_env,
            check=True, capture_output=True, text=True, encoding="utf-8",
        )
        return result.stdout.strip()

    def add_commit(self, filename: str, contents: str, message: str) -> str:
        """Write one repo-relative file, commit it, and return the full SHA."""
        path = self.repo / filename
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(contents, encoding="utf-8")
        self.git("add", "--", filename)
        self.git("commit", "-m", message)
        return self.git("rev-parse", "HEAD")

    def open_db(self, name: str = "state.sqlite") -> StateStore:
        """Open a Baton state database under the temporary fixture root."""
        return StateStore(self.root / name)

    def cleanup(self) -> None:
        self._tempdir.cleanup()

    def __enter__(self) -> LineageFixture:
        return self

    def __exit__(
        self, exc_type: type[BaseException] | None, exc: BaseException | None,
        traceback: TracebackType | None,
    ) -> None:
        self.cleanup()
