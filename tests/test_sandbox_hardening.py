"""Hardening assertions for the Stage 4 container sandbox templates and docs."""

from __future__ import annotations

import json
import re
import unittest
from pathlib import Path

from vibebaton.sandbox import SANDBOX_TEMPLATES

REPO_ROOT = Path(__file__).resolve().parents[1]
SECURITY_DOC = REPO_ROOT / "docs" / "SECURITY.md"

DOCKERFILE_PATH = "sandbox/Dockerfile"
COMPOSE_PATH = "sandbox/docker-compose.yml"
DEVCONTAINER_PATH = ".devcontainer/devcontainer.json"


def _template(path: str) -> str:
    return SANDBOX_TEMPLATES[path]


def _dockerfile_instructions() -> list[str]:
    return [
        line.strip()
        for line in _template(DOCKERFILE_PATH).splitlines()
        if line.strip() and not line.lstrip().startswith("#")
    ]


class TestDockerfileHardening(unittest.TestCase):
    def test_runs_as_user_baton(self) -> None:
        lines = [line.strip() for line in _template(DOCKERFILE_PATH).splitlines()]
        self.assertIn("USER baton", lines)

    def test_creates_baton_account_with_uid_1000(self) -> None:
        account_commands = [
            line
            for line in _dockerfile_instructions()
            if re.search(r"\b(?:useradd|adduser)\b", line)
        ]
        self.assertTrue(
            any("1000" in line for line in account_commands),
            "Dockerfile must create the baton user with UID 1000",
        )

    def test_does_not_copy_ssh_or_credentials(self) -> None:
        for instruction in _dockerfile_instructions():
            if instruction.upper().startswith("COPY "):
                with self.subTest(instruction=instruction):
                    self.assertNotIn(".ssh", instruction)
                    self.assertNotIn("credentials", instruction)

    def test_does_not_add_remote_artifacts(self) -> None:
        self.assertIsNone(
            re.search(
                r"(?im)^\s*ADD(?:\s+--\S+)*\s+https?://",
                _template(DOCKERFILE_PATH),
            ),
            "Dockerfile must not ADD remote artifacts",
        )


class TestComposeHardening(unittest.TestCase):
    def test_drops_all_capabilities(self) -> None:
        compose = _template(COMPOSE_PATH)
        self.assertIn("cap_drop", compose)
        # Accept the flow style used by the template or the equivalent block entry.
        self.assertTrue(
            "cap_drop: [ALL]" in compose or "- ALL" in compose,
            "Compose service must drop all Linux capabilities",
        )

    def test_disables_privilege_escalation(self) -> None:
        self.assertIn("no-new-privileges:true", _template(COMPOSE_PATH))

    def test_uses_read_only_root_and_tmpfs(self) -> None:
        compose = _template(COMPOSE_PATH)
        self.assertIn("read_only: true", compose)
        self.assertIn("tmpfs", compose)
        self.assertIn("/tmp", compose)

    def test_mounts_repository_at_workspace(self) -> None:
        self.assertIn("- ..:/workspace:rw", _template(COMPOSE_PATH))

    def test_does_not_mount_ssh_or_enable_privileged_mode(self) -> None:
        compose = _template(COMPOSE_PATH)
        # Inspect the active configuration lines.
        config = "\n".join(
            line
            for line in compose.splitlines()
            if line.strip() and not line.lstrip().startswith("#")
        )
        self.assertNotIn(".ssh", config)
        self.assertNotIn("privileged: true", config)
        self.assertNotIn("privileged:true", config)


class TestDevcontainerHardening(unittest.TestCase):
    def test_uses_baton_user_and_vibebaton_post_create_command(self) -> None:
        config = json.loads(_template(DEVCONTAINER_PATH))
        self.assertEqual(config["remoteUser"], "baton")
        self.assertIn("vibebaton", config["postCreateCommand"])


class TestSecurityDocumentation(unittest.TestCase):
    def test_documents_sandbox_cli_generated_files_and_hardening_controls(self) -> None:
        security_doc = SECURITY_DOC.read_text(encoding="utf-8")
        for expected in (
            "## Container Sandbox (Stage 4, v1.0.0)",
            "baton sandbox init",
            "--force",
            "sandbox/Dockerfile",
            "sandbox/docker-compose.yml",
            ".devcontainer/devcontainer.json",
            "cap_drop",
            "read_only",
        ):
            with self.subTest(text=expected):
                self.assertIn(expected, security_doc)
        self.assertIn("non-root", security_doc.lower())

    def test_documents_every_hardening_control_and_its_limits(self) -> None:
        security_doc = SECURITY_DOC.read_text(encoding="utf-8")
        for expected in (
            "no-new-privileges",
            "tmpfs",
            "/tmp",
            "/workspace",
            "~/.vibebaton",
            "~/.ssh",
            "What this does NOT protect against",
        ):
            with self.subTest(text=expected):
                self.assertIn(expected, security_doc)

    def test_no_longer_defers_the_sandbox_to_a_future_stage(self) -> None:
        security_doc = SECURITY_DOC.read_text(encoding="utf-8")
        self.assertNotIn("scheduled for Stage 4", security_doc)
