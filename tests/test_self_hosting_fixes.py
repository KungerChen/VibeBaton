"""Regression tests for bugs uncovered during v1.0.4 self-hosting verification."""

from __future__ import annotations

import asyncio
import contextlib
import io
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock
from zipfile import ZipFile

from vibebaton import cli, cli_runner, sandbox
from vibebaton.config import PricingSettings, ProviderConfig, RoleConfig


class TestDshCamelCaseUsageParsing(unittest.TestCase):
    def test_parses_real_dsh_step_end_camel_case_tokens_and_text(self) -> None:
        stdout = "\n".join([
            json.dumps({"type": "session", "sessionId": "session-1"}),
            json.dumps({"type": "status", "phase": "step_start", "turn": 1, "step": 1}),
            json.dumps({"type": "thinking", "text": "thinking..."}),
            json.dumps({
                "type": "status",
                "phase": "step_end",
                "turn": 1,
                "step": 1,
                "usage": {
                    "inputTokens": 7771,
                    "outputTokens": 31,
                    "cachedInputTokens": 1200,
                    "totalTokens": 7802,
                },
            }),
            json.dumps({
                "type": "final",
                "sessionId": "session-1",
                "reason": {"kind": "completed"},
                "text": '{"status":"ok"}',
            }),
        ])
        parsed = cli_runner.parse_cli_output_and_usage(
            stdout,
            "",
            None,
            provider_type="cli",
            command=["dsh", "--profile", "headless", "--json", "-"],
            provider_name="dsh_opencode",
        )
        self.assertTrue(parsed.structured)
        self.assertEqual(parsed.prompt_tokens, 7771)
        self.assertEqual(parsed.completion_tokens, 31)
        self.assertEqual(parsed.cached_tokens, 1200)
        self.assertEqual(parsed.text, '{"status":"ok"}')

    def test_detects_dsh_format_from_camel_case_usage_even_without_flag_hint(self) -> None:
        stdout = "\n".join([
            json.dumps({
                "type": "status",
                "phase": "step_end",
                "usage": {"inputTokens": 500, "outputTokens": 25},
            }),
            json.dumps({"type": "final", "text": "done"}),
        ])
        parsed = cli_runner.parse_cli_output_and_usage(
            stdout,
            "",
            None,
            provider_type="cli",
            command=["custom-agent", "-"],
            provider_name="custom_worker",
        )
        self.assertEqual(parsed.prompt_tokens, 500)
        self.assertEqual(parsed.completion_tokens, 25)
        self.assertEqual(parsed.text, "done")


class TestHttpDoctorAndPricingSettings(unittest.TestCase):
    def _write_http_repo(self, root: Path, *, with_git: bool = True) -> None:
        if with_git:
            (root / ".git").mkdir(parents=True, exist_ok=True)
        baton_dir = root / ".baton"
        baton_dir.mkdir(parents=True, exist_ok=True)
        (baton_dir / "baton.toml").write_text(
            """
[providers.deepseek_http]
type = "http"
base_url = "https://api.deepseek.com/v1"
api_key_env = "TEST_DS_HTTP_KEY"

[roles.tactical_planner]
provider = "deepseek_http"
model = "deepseek-chat"
""".strip()
            + "\n",
            encoding="utf-8",
        )

    def test_doctor_probes_http_provider_without_empty_command_template_error(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            self._write_http_repo(repo)
            args = SimpleNamespace(repo=str(repo), config=None, role=None)

            # Missing key -> clean MISS without "Empty command template"
            with mock.patch.dict(os.environ, {}, clear=False):
                os.environ.pop("TEST_DS_HTTP_KEY", None)
                buf_miss = io.StringIO()
                with (
                    mock.patch("shutil.which", return_value="git"),
                    contextlib.redirect_stdout(buf_miss),
                ):
                    code_miss = cli.cmd_doctor(args)
            self.assertEqual(code_miss, 1)
            self.assertNotIn("Empty command template", buf_miss.getvalue())
            self.assertIn("[MISS]", buf_miss.getvalue())

            # Present key -> OK and exit 0
            with mock.patch.dict(os.environ, {"TEST_DS_HTTP_KEY": "sk-dummy-test-key"}, clear=False):
                buf_ok = io.StringIO()
                with (
                    mock.patch("shutil.which", return_value="git"),
                    contextlib.redirect_stdout(buf_ok),
                ):
                    code_ok = cli.cmd_doctor(args)
            self.assertEqual(code_ok, 0)
            self.assertIn("[OK  ] deepseek_http", buf_ok.getvalue())
            self.assertIn("type=http", buf_ok.getvalue())

    def test_doctor_role_smoke_routes_http_role_through_invoke_provider(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            self._write_http_repo(repo)
            args = SimpleNamespace(repo=str(repo), config=None, role="tactical_planner")
            fake_result = cli_runner.CLIResult(
                status="ok",
                exit_code=0,
                stdout='{"status": "ok"}',
                stderr="",
                duration_sec=0.42,
                command=["POST", "https://api.deepseek.com/v1/chat/completions"],
                prompt_tokens=120,
                completion_tokens=10,
                cached_tokens=0,
                cost_usd=0.0005,
                parsed_text='{"status": "ok"}',
            )
            buf = io.StringIO()
            with (
                mock.patch.dict(os.environ, {"TEST_DS_HTTP_KEY": "sk-dummy-test-key"}, clear=False),
                mock.patch("shutil.which", return_value="git"),
                mock.patch("vibebaton.cli.invoke_provider", new=mock.AsyncMock(return_value=fake_result)) as mocked_invoke,
                contextlib.redirect_stdout(buf),
            ):
                code = cli.cmd_doctor(args)
            self.assertEqual(code, 0)
            self.assertTrue(mocked_invoke.called)
            self.assertIn("Usage: prompt=120 completion=10", buf.getvalue())
            self.assertIn("cost=$0.0005", buf.getvalue())

    def test_invoke_provider_forwards_pricing_settings_to_http_provider(self) -> None:
        provider = ProviderConfig(
            name="custom_http",
            type="http",
            base_url="https://api.example.com/v1",
            api_key_env="TEST_HTTP_PRICING_KEY",
        )
        custom_rates = {
            "custom-model-v1": {"input_per_1m": 10.0, "output_per_1m": 20.0, "cached_input_per_1m": 5.0}
        }
        pricing_settings = PricingSettings(custom=custom_rates)
        response_bytes = json.dumps({
            "choices": [{"message": {"content": "hello"}}],
            "usage": {
                "prompt_tokens": 1_000_000,
                "completion_tokens": 500_000,
                "prompt_tokens_details": {"cached_tokens": 0},
            },
        }).encode("utf-8")

        class _FakeResp:
            status = 200
            headers: dict[str, str] = {}

            def read(self) -> bytes:
                return response_bytes

            def __enter__(self) -> _FakeResp:
                return self

            def __exit__(self, *args: object) -> None:
                return None

        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            out_file = tmp_path / "out.json"
            with (
                mock.patch.dict(os.environ, {"TEST_HTTP_PRICING_KEY": "sk-dummy-test-key"}, clear=False),
                mock.patch("urllib.request.urlopen", return_value=_FakeResp()),
            ):
                result = asyncio.run(
                    cli_runner.invoke_provider(
                        provider,
                        prompt="hi",
                        model="custom-model-v1",
                        effort=None,
                        output_file=out_file,
                        cwd=tmp_path,
                        pricing_settings=pricing_settings,
                    )
                )
        self.assertEqual(result.status, "ok")
        self.assertAlmostEqual(result.cost_usd or 0.0, 20.0, places=4)


class TestPromoteSeedSafetyGuard(unittest.TestCase):
    def test_promote_seed_refuses_git_dir_repo_root_and_parent(self) -> None:
        package_root = cli._package_root().resolve()
        with tempfile.TemporaryDirectory() as tmp:
            git_dir = Path(tmp) / "existing_repo"
            (git_dir / ".git").mkdir(parents=True)
            sentinel = git_dir / "keep.txt"
            sentinel.write_text("safe", encoding="utf-8")

            for unsafe in (package_root, package_root.parent, git_dir):
                with self.subTest(dest=str(unsafe)):
                    err = io.StringIO()
                    with contextlib.redirect_stderr(err):
                        code = cli.cmd_promote_seed(SimpleNamespace(dest=str(unsafe)))
                    self.assertEqual(code, 1)
                    self.assertIn("Refusing to overwrite unsafe promote-seed destination", err.getvalue())
            self.assertTrue(sentinel.is_file())

    def test_promote_seed_succeeds_for_dedicated_subdirectory(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            dest = Path(tmp) / "runner-copy"
            out = io.StringIO()
            with contextlib.redirect_stdout(out):
                code = cli.cmd_promote_seed(SimpleNamespace(dest=str(dest)))
            self.assertEqual(code, 0)
            self.assertTrue((dest / "src" / "vibebaton" / "cli.py").is_file())
            self.assertTrue((dest / "presets" / "dsh-headless-opencode-go.patch.yml").is_file())


class TestSandboxArchiveCompleteness(unittest.TestCase):
    def test_runtime_archive_includes_preset_patch_overlays(self) -> None:
        payload = sandbox._runtime_archive()
        with ZipFile(io.BytesIO(payload), "r") as archive:
            names = set(archive.namelist())
        self.assertIn("presets/dsh-headless-opencode-go.patch.yml", names)
        self.assertIn("src/vibebaton/cli.py", names)
        self.assertIn("baton.example.toml", names)


if __name__ == "__main__":
    unittest.main()
