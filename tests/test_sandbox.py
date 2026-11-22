"""Golden examples for sandbox scaffolding and container hardening."""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch
from uuid import uuid4
from zipfile import ZipFile

from vibebaton.sandbox import (
    SANDBOX_FILES,
    SANDBOX_TEMPLATES,
    init_sandbox_files,
    sandbox_file_status,
)


REPO_ROOT = Path(__file__).resolve().parents[1]


class TestInitSandboxFiles(unittest.TestCase):
    def setUp(self) -> None:
        temp_dir = Path(self.enterContext(TemporaryDirectory())).resolve()
        self.repo = temp_dir / "repo"
        self.repo.mkdir()

    def test_writes_scaffold_files_with_exact_paths_and_bytes(self) -> None:
        expected_paths = (
            ".devcontainer/devcontainer.json",
            "sandbox/Dockerfile",
            "sandbox/docker-compose.yml",
            "sandbox/.dockerignore",
            ".vibebaton-empty/.gitkeep",
            "sandbox/vibebaton-runtime.zip",
        )

        written = init_sandbox_files(self.repo)

        self.assertEqual(SANDBOX_FILES, expected_paths)
        self.assertEqual(
            tuple(path.relative_to(self.repo).as_posix() for path in written),
            expected_paths,
        )
        for rel, template in SANDBOX_TEMPLATES.items():
            with self.subTest(path=rel):
                self.assertEqual(
                    (self.repo / rel).read_bytes(),
                    template.encode("utf-8"),
                )

    def test_second_call_preserves_existing_contents(self) -> None:
        written = init_sandbox_files(self.repo)
        written[0].write_bytes(b"local configuration\r\n")
        (self.repo / "sandbox/vibebaton-runtime.zip").write_bytes(b"local archive")
        original = {path: path.read_bytes() for path in written}

        self.assertEqual(init_sandbox_files(self.repo), [])
        self.assertEqual({path: path.read_bytes() for path in written}, original)

    def test_force_overwrites_modified_template_and_runtime(self) -> None:
        written = init_sandbox_files(self.repo)
        rel = "sandbox/Dockerfile"
        dockerfile = self.repo / rel
        dockerfile.write_bytes(b"FROM scratch\n")
        archive_path = self.repo / "sandbox/vibebaton-runtime.zip"
        archive_path.write_bytes(b"old archive")

        self.assertEqual(init_sandbox_files(self.repo, force=True), written)
        self.assertEqual(dockerfile.read_bytes(), SANDBOX_TEMPLATES[rel].encode("utf-8"))
        with ZipFile(archive_path) as archive:
            self.assertIn("src/vibebaton/__main__.py", archive.namelist())

    def test_bundled_runtime_runs_startup_commands_in_an_unrelated_repo(self) -> None:
        subprocess.run(["git", "init", "-q"], cwd=self.repo, check=True)
        (self.repo / ".env").write_text("TEST_VALUE=repository-only\n", encoding="utf-8")
        init_sandbox_files(self.repo)

        archive_path = self.repo / "sandbox/vibebaton-runtime.zip"
        with ZipFile(archive_path) as archive:
            self.assertNotIn(".env", archive.namelist())
            self.assertEqual(
                archive.read("src/vibebaton/__main__.py"),
                (REPO_ROOT / "src/vibebaton/__main__.py").read_bytes(),
            )
        # Install the generated archive into an isolated directory as the image does.
        runtime = self.repo.parent / "opt/vibebaton"
        subprocess.run(
            [sys.executable, "-m", "zipfile", "-e", str(archive_path), str(runtime)],
            check=True,
        )
        env = {**os.environ, "PYTHONPATH": str(runtime / "src")}
        dockerfile = (self.repo / "sandbox/Dockerfile").read_text(encoding="utf-8")
        default_command = next(
            line[4:] for line in dockerfile.splitlines() if line.startswith("CMD ")
        )
        devcontainer = json.loads(
            (self.repo / ".devcontainer/devcontainer.json").read_text(encoding="utf-8")
        )

        # Workspace files are outside the import path of the two startup commands.
        (self.repo / "vibebaton.py").write_text(
            "raise AssertionError('workspace import')\n", encoding="utf-8"
        )
        for command in (json.loads(default_command), devcontainer["postCreateCommand"]):
            with self.subTest(command=command):
                self.assertEqual(command[0], "python")
                help_result = subprocess.run(
                    [sys.executable, "-S", *command[1:]], cwd=self.repo, env=env,
                    capture_output=True, text=True, timeout=30,
                )
                self.assertEqual(help_result.returncode, 0, help_result.stderr)
                self.assertIn("Multi-agent coding workflow orchestrator", help_result.stdout)

        init_result = subprocess.run(
            [sys.executable, "-S", "-P", "-m", "vibebaton", "init", "--repo", "."],
            cwd=self.repo, env=env, capture_output=True, text=True, timeout=30,
        )
        self.assertEqual(init_result.returncode, 0, init_result.stderr)
        self.assertEqual(
            (self.repo / ".baton/baton.toml").read_bytes(),
            (REPO_ROOT / "baton.example.toml").read_bytes(),
        )

    def test_docker_compose_builds_and_runs_in_an_unrelated_repository(self) -> None:
        docker = shutil.which("docker")
        if docker is None:
            self.skipTest("Docker CLI is unavailable")
        if os.environ.get("VIBEBATON_TEST_DOCKER") != "1":
            self.skipTest("Set VIBEBATON_TEST_DOCKER=1 to build and run the sandbox image")

        subprocess.run(["git", "init", "-q"], cwd=self.repo, check=True)
        init_sandbox_files(self.repo)
        compose = [
            docker, "compose", "-p", f"baton-sandbox-test-{uuid4().hex[:12]}",
            "-f", "sandbox/docker-compose.yml",
        ]
        env = {
            **os.environ,
            "COMPOSE_DISABLE_ENV_FILE": "1",
            "VIBEBATON_CREDENTIALS_DIR": "",
            "OPENAI_API_KEY": "",
            "DEEPSEEK_API_KEY": "",
        }
        self.addCleanup(
            subprocess.run, [*compose, "down", "--rmi", "local"],
            cwd=self.repo, env=env, capture_output=True, timeout=60, check=True,
        )
        result = subprocess.run(
            [*compose, "run", "--build", "--rm", "-T", "vibebaton"],
            cwd=self.repo, env=env, timeout=300, capture_output=True,
            encoding="utf-8", errors="replace",
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("Multi-agent coding workflow orchestrator", result.stdout)

    def test_rejects_traversal_before_writing(self) -> None:
        with patch.dict(SANDBOX_TEMPLATES, {"../x": "outside\n"}):
            with self.assertRaisesRegex(ValueError, "outside the repository"):
                init_sandbox_files(self.repo)

        self.assertFalse((self.repo.parent / "x").exists())
        self.assertEqual(list(self.repo.iterdir()), [])

    def test_rejects_symlink_to_directory_outside_repo(self) -> None:
        outside = self.repo.parent / "outside"
        outside.mkdir()
        try:
            (self.repo / "sandbox").symlink_to(outside, target_is_directory=True)
        except (NotImplementedError, OSError) as error:
            self.skipTest(f"Directory symlinks unavailable: {error}")

        with self.assertRaisesRegex(ValueError, "outside the repository"):
            init_sandbox_files(self.repo, force=True)

        self.assertFalse((self.repo / ".devcontainer").exists())
        self.assertEqual(list(outside.iterdir()), [])

    def test_status_reports_presence_by_template_path(self) -> None:
        self.assertEqual(sandbox_file_status(self.repo), dict.fromkeys(SANDBOX_FILES, False))

        rel = "sandbox/Dockerfile"
        dockerfile = self.repo / rel
        dockerfile.parent.mkdir()
        dockerfile.write_bytes(b"FROM scratch\n")

        self.assertEqual(
            sandbox_file_status(self.repo),
            {path: path == rel for path in SANDBOX_FILES},
        )
        init_sandbox_files(self.repo)
        self.assertEqual(sandbox_file_status(self.repo), dict.fromkeys(SANDBOX_FILES, True))


class TestRepoTemplatesInSync(unittest.TestCase):
    def test_repo_templates_match_registry(self) -> None:
        for rel, template in SANDBOX_TEMPLATES.items():
            with self.subTest(path=rel):
                path = REPO_ROOT / rel
                self.assertTrue(path.is_file(), f"Missing shipped sandbox template: {rel}")
                # read_text normalizes checkout line endings and preserves whitespace.
                self.assertEqual(
                    path.read_text(encoding="utf-8"),
                    template,
                    "Regenerate with `python -m vibebaton sandbox init --repo . --force`",
                )

    def test_docker_compose_config(self) -> None:
        docker = shutil.which("docker")
        if docker is None:
            self.skipTest("Docker CLI is unavailable")
        compose = [docker, "compose"]
        version = subprocess.run([*compose, "version"], capture_output=True, timeout=30)
        if version.returncode != 0:
            self.skipTest("Docker Compose is unavailable")

        result = subprocess.run(
            [*compose, "-f", "sandbox/docker-compose.yml", "config", "--quiet"],
            cwd=REPO_ROOT,
            env={
                **os.environ,
                "COMPOSE_DISABLE_ENV_FILE": "1",
                "VIBEBATON_CREDENTIALS_DIR": "",
                "OPENAI_API_KEY": "",
                "DEEPSEEK_API_KEY": "",
            },
            capture_output=True,
            encoding="utf-8",
            errors="replace",
            timeout=30,
        )
        self.assertEqual(result.returncode, 0, result.stderr)


class TestSandboxTemplates(unittest.TestCase):
    def test_dockerfile_uses_unprivileged_user_and_no_build_context_copy(self) -> None:
        dockerfile = SANDBOX_TEMPLATES["sandbox/Dockerfile"]
        self.assertIn("FROM python:3.12-slim", dockerfile.splitlines())
        self.assertIn("groupadd --gid 1000 baton", dockerfile)
        self.assertIn("useradd --uid 1000 --gid 1000 --create-home", dockerfile)
        self.assertIn("USER baton", dockerfile.splitlines())
        self.assertIn('CMD ["python", "-P", "-m", "vibebaton", "--help"]', dockerfile.splitlines())
        self.assertFalse(
            any(line.lstrip().startswith(("COPY ", "ADD ")) for line in dockerfile.splitlines())
        )

    def test_dockerfile_installs_the_runtime_outside_workspace_before_switching_user(self) -> None:
        dockerfile = SANDBOX_TEMPLATES["sandbox/Dockerfile"]
        self.assertIn("source=vibebaton-runtime.zip,target=/tmp/vibebaton-runtime.zip", dockerfile)
        install = "python -m zipfile -e /tmp/vibebaton-runtime.zip /opt/vibebaton"
        self.assertIn(install, dockerfile)
        self.assertLess(dockerfile.index(install), dockerfile.index("USER baton"))
        self.assertIn("PYTHONPATH=/opt/vibebaton/src", dockerfile)
        self.assertNotIn("PYTHONPATH=/workspace", dockerfile)
        self.assertEqual(
            SANDBOX_TEMPLATES["sandbox/.dockerignore"].splitlines(),
            ["**", "!vibebaton-runtime.zip"],
        )

    def test_compose_hardening_and_credential_boundary(self) -> None:
        compose = SANDBOX_TEMPLATES["sandbox/docker-compose.yml"]
        lines = {line.strip() for line in compose.splitlines()}
        for line in (
            "context: .",
            "dockerfile: Dockerfile",
            'user: "1000:1000"',
            "cap_drop: [ALL]",
            "security_opt: [no-new-privileges:true]",
            "read_only: true",
            "tmpfs: [/tmp, /home/baton/.cache]",
            "pids_limit: 256",
            "mem_limit: 2g",
            "- ..:/workspace:rw",
            '- "${VIBEBATON_CREDENTIALS_DIR:-../.vibebaton-empty}:/home/baton/.vibebaton:ro"',
            "- OPENAI_API_KEY=${OPENAI_API_KEY:-}",
            "- DEEPSEEK_API_KEY=${DEEPSEEK_API_KEY:-}",
        ):
            with self.subTest(line=line):
                self.assertIn(line, lines)
        self.assertNotIn(".ssh", compose)

    def test_devcontainer_uses_the_sandbox_image_and_restricted_user(self) -> None:
        config = json.loads(SANDBOX_TEMPLATES[".devcontainer/devcontainer.json"])
        self.assertEqual(
            config["build"], {"dockerfile": "../sandbox/Dockerfile", "context": "../sandbox"}
        )
        self.assertEqual(config["remoteUser"], "baton")
        self.assertFalse(config["updateRemoteUserUID"])
        self.assertEqual(config["workspaceFolder"], "/workspace")
        self.assertEqual(
            config["workspaceMount"],
            "source=${localWorkspaceFolder},target=/workspace,type=bind",
        )
        self.assertEqual(config["postCreateCommand"], ["python", "-P", "-m", "vibebaton", "--help"])
        self.assertEqual(
            config["runArgs"],
            ["--cap-drop=ALL", "--security-opt=no-new-privileges:true"],
        )
