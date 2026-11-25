"""Credential contracts using isolated stores and real provider configuration fixtures."""

from __future__ import annotations

import json
import os
import stat
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

from vibebaton.config import BatonConfig, ProviderConfig, build_model_catalog, parse_config_dict
from vibebaton.credentials import (
    SUPPORTED_KEYS,
    ProbeResult,
    default_credentials_path,
    list_credential_status,
    list_present_provider_keys,
    mask_secret,
    probe_role_or_provider,
    resolve_env_for_provider,
    save_credentials,
)


def _probe_config() -> BatonConfig:
    return parse_config_dict({
        "providers": {
            "dsh_deepseek": {"command": ["dsh", "-"]},
            "dsh_opencode": {"command": ["dsh", "--profile", "headless", "-"]},
            "codex_sub": {"command": ["codex", "exec", "-"]},
            "claude_sub": {"command": ["claude", "-p"]},
            "local_cli": {"command": [sys.executable, "-c", "raise SystemExit(9)"]},
        },
        "roles": {
            "bulk_worker": {"provider": "dsh_opencode", "model": "worker@high"},
            "final_gate": {"provider": "host_native", "model": "host-model"},
        },
    })


class _IsolatedCredentials(unittest.TestCase):
    def setUp(self) -> None:
        self.directory = Path(self.enterContext(tempfile.TemporaryDirectory()))
        self.credentials_path = self.directory / ".vibebaton" / "credentials.json"
        self.enterContext(patch.dict(os.environ))
        for key in SUPPORTED_KEYS:
            os.environ.pop(key, None)


class TestCredentialStore(_IsolatedCredentials):
    def test_default_store_uses_home_and_an_explicit_path_takes_precedence(self) -> None:
        override = self.directory / "override.json"
        with patch.object(Path, "home", return_value=self.directory):
            self.assertEqual(default_credentials_path(), self.credentials_path)
            self.assertEqual(default_credentials_path(override), override)
            save_credentials({"DEEPSEEK_API_KEY": "test-home-credential"})

        self.assertTrue(self.credentials_path.is_file())
        self.assertFalse(override.exists())

    def test_reports_all_supported_keys_when_the_store_is_missing(self) -> None:
        self.assertEqual(list_credential_status(self.credentials_path), [
            {"provider_key": key, "configured": False, "source": "none", "masked": ""}
            for key in SUPPORTED_KEYS
        ])
        self.assertFalse(self.credentials_path.parent.exists())

    def test_lists_present_keys_from_env_and_store_without_values(self) -> None:
        self.credentials_path.parent.mkdir(parents=True)
        self.credentials_path.write_text(
            json.dumps({"DEEPSEEK_API_KEY": "ds-secret", "GEMINI_API_KEY": "", "EXTRA_KEY": "x"}), encoding="utf-8"
        )
        os.environ["OPENAI_API_KEY"] = "oa-secret"
        os.environ["GEMINI_API_KEY"] = ""
        keys = ("OPENAI_API_KEY", "GEMINI_API_KEY", "DEEPSEEK_API_KEY", "ANTHROPIC_API_KEY")
        self.assertEqual(list_present_provider_keys(keys, self.credentials_path), ["DEEPSEEK_API_KEY", "OPENAI_API_KEY"])
        self.credentials_path.write_text("{broken", encoding="utf-8")
        self.assertEqual(list_present_provider_keys(keys, self.credentials_path), ["OPENAI_API_KEY"])

    def test_masks_empty_short_and_long_values(self) -> None:
        cases = (
            ("", ""),
            ("token", "••••"),
            ("12345678", "••••"),
            ("sk-123456789abcdef", "sk-1••••cdef"),
            ("••••", "****"),
        )
        for raw, expected in cases:
            with self.subTest(length=len(raw)):
                masked = mask_secret(raw, credentials_path=self.credentials_path)

                self.assertEqual(masked, expected)
                if raw:
                    self.assertNotIn(raw, masked)

    def test_env_wins_and_public_statuses_expose_only_masks(self) -> None:
        key = "OPENAI_API_KEY"
        env_secret = "sk-env-credential-1234"
        file_secret = "sk-file-credential-5678"
        os.environ[key] = env_secret

        saved = save_credentials({key: file_secret}, self.credentials_path)

        self.assertEqual(saved, list_credential_status(self.credentials_path))
        self.assertIn({
            "provider_key": key, "configured": True, "source": "env", "masked": "sk-e••••1234",
        }, saved)
        self.assertNotIn(env_secret, json.dumps(saved))
        self.assertNotIn(file_secret, json.dumps(saved))

        del os.environ[key]
        status = list_credential_status(self.credentials_path)

        self.assertIn({
            "provider_key": key, "configured": True, "source": "local_file", "masked": "sk-f••••5678",
        }, status)
        self.assertNotIn(file_secret, json.dumps(status))

    def test_merges_updates_and_empty_string_removes_only_the_local_value(self) -> None:
        os.environ["OPENAI_API_KEY"] = "test-env-credential"
        save_credentials({
            "OPENAI_API_KEY": "test-local-credential", "DEEPSEEK_API_KEY": "test-before-update",
        }, self.credentials_path)

        status = save_credentials({
            "OPENAI_API_KEY": "",
            "DEEPSEEK_API_KEY": "test-after-update",
            "ANTHROPIC_API_KEY": "test-claude-token",
        }, self.credentials_path)

        self.assertEqual(json.loads(self.credentials_path.read_text(encoding="utf-8")), {
            "DEEPSEEK_API_KEY": "test-after-update", "ANTHROPIC_API_KEY": "test-claude-token",
        })
        self.assertIn({
            "provider_key": "OPENAI_API_KEY", "configured": True, "source": "env", "masked": "test••••tial",
        }, status)

    def test_resolves_only_provider_keys_absent_from_the_environment(self) -> None:
        local = {key: f"test-credential-{index}" for index, key in enumerate(SUPPORTED_KEYS)}
        save_credentials(local, self.credentials_path)
        cases = (
            ("dsh_deepseek", {"DEEPSEEK_API_KEY": local["DEEPSEEK_API_KEY"]}),
            ("dsh_opencode", {"OPENCODE_API_KEY": local["OPENCODE_API_KEY"]}),
            ("custom_provider", {}),
        )
        for provider, expected in cases:
            with self.subTest(provider=provider):
                self.assertEqual(resolve_env_for_provider(provider, self.credentials_path), expected)

        for value in ("test-env-credential", ""):
            with self.subTest(configured=bool(value)), patch.dict(os.environ, DEEPSEEK_API_KEY=value):
                self.assertEqual(resolve_env_for_provider("dsh_deepseek", self.credentials_path), {})
                status = list_credential_status(self.credentials_path)
                self.assertIn({
                    "provider_key": "DEEPSEEK_API_KEY", "configured": bool(value),
                    "source": "env" if value else "none", "masked": mask_secret(value),
                }, status)
        self.assertNotIn("DEEPSEEK_API_KEY", os.environ)

    def test_subscription_providers_do_not_get_stored_api_keys(self) -> None:
        save_credentials({
            "OPENAI_API_KEY": "test-codex-credential",
            "ANTHROPIC_API_KEY": "test-claude-credential",
        }, self.credentials_path)

        for provider in ("codex_sub", "claude_sub"):
            with self.subTest(provider=provider):
                self.assertEqual(resolve_env_for_provider(provider, self.credentials_path), {})

    def test_rejects_unknown_keys_before_creating_any_file(self) -> None:
        unknown_key = "test-misplaced-secret"
        with self.assertRaisesRegex(ValueError, "Unsupported credential key") as raised:
            save_credentials({
                "OPENAI_API_KEY": "test-valid-update", unknown_key: "test-invalid-update",
            }, self.credentials_path)

        self.assertNotIn(unknown_key, str(raised.exception))
        self.assertFalse(self.credentials_path.parent.exists())

    def test_preserves_malformed_local_data_and_reports_a_safe_error(self) -> None:
        raw = '{"OPENAI_API_KEY": "test-malformed-secret"'
        self.credentials_path.parent.mkdir()
        self.credentials_path.write_text(raw, encoding="utf-8")

        with self.assertRaisesRegex(ValueError, "Invalid local credentials JSON") as raised:
            save_credentials({"DEEPSEEK_API_KEY": "test-valid-update"}, self.credentials_path)

        self.assertNotIn("test-malformed-secret", str(raised.exception))
        self.assertEqual(self.credentials_path.read_text(encoding="utf-8"), raw)

    def test_replaces_from_a_private_temp_file_and_preserves_old_data_on_failure(self) -> None:
        key = "OPENAI_API_KEY"
        save_credentials({key: "test-original-credential"}, self.credentials_path)
        original = self.credentials_path.read_bytes()
        if os.name == "posix":
            self.assertEqual(stat.S_IMODE(self.credentials_path.stat().st_mode), 0o600)

        def fail_replace(source: Path, destination: Path) -> None:
            self.assertEqual(source.parent, destination.parent)
            self.assertNotEqual(source, destination)
            self.assertEqual(destination.read_bytes(), original)
            self.assertEqual(json.loads(source.read_text(encoding="utf-8")), {key: "test-updated-credential"})
            if os.name == "posix":
                self.assertEqual(stat.S_IMODE(source.stat().st_mode), 0o600)
            raise OSError("simulated replacement failure")

        with patch("vibebaton.credentials.os.replace", side_effect=fail_replace) as replace:
            with self.assertRaisesRegex(OSError, "simulated replacement failure"):
                save_credentials({key: "test-updated-credential"}, self.credentials_path)

        replace.assert_called_once()
        self.assertEqual(self.credentials_path.read_bytes(), original)
        self.assertEqual(list(self.credentials_path.parent.iterdir()), [self.credentials_path])

    def test_rejects_repo_and_linked_worktree_paths_before_creating_directories(self) -> None:
        repo = self.directory / "repo"
        (repo / ".git").mkdir(parents=True)
        worktree = self.directory / "worktree"
        worktree.mkdir()
        (worktree / ".git").write_text("gitdir: ../repo/.git/worktrees/test\n", encoding="utf-8")
        for root in (repo, worktree):
            for name in (".baton", "presets"):
                with self.subTest(root=root.name, directory=name):
                    destination = root / name / "credentials.json"
                    with self.assertRaisesRegex(ValueError, "outside the repository"):
                        save_credentials({"OPENAI_API_KEY": "test-credential"}, destination)

                    self.assertFalse(destination.parent.exists())


class TestCredentialProbe(_IsolatedCredentials):
    def setUp(self) -> None:
        super().setUp()
        self.cfg = _probe_config()

    def test_resolves_explicit_provider_qualified_model_or_role(self) -> None:
        save_credentials({"OPENCODE_API_KEY": "test-dsh-credential"}, self.credentials_path)
        cases = (
            ({"role": "bulk_worker", "model": "worker@max"}, "dsh_opencode"),
            ({"role": "bulk_worker", "model": "codex_sub:solver@max"}, "codex_sub"),
            ({"model": "codex_sub:solver@max"}, "codex_sub"),
            ({"provider": "local_cli", "role": "bulk_worker", "model": "codex_sub:solver"}, "local_cli"),
        )
        for args, expected in cases:
            with self.subTest(args=args):
                checker = Mock(return_value=(True, "Ready"))

                result = probe_role_or_provider(
                    self.cfg, **args, health_checker=checker,
                    timeout_sec=0.5, credentials_path=self.credentials_path,
                )

                checker.assert_called_once_with(self.cfg.providers[expected], 0.5)
                self.assertEqual({key: value for key, value in result.items() if key != "latency_ms"}, {
                    "ok": True, "provider": expected, "detail": "Ready", "install_hint": "",
                })
                self.assertGreaterEqual(result["latency_ms"], 0)
                self.assertLess(result["latency_ms"], 500)

    def test_native_roles_and_unknown_targets_skip_the_checker(self) -> None:
        cases = (
            ({"role": "final_gate"}, True, "host_native"),
            ({"role": "unknown"}, False, ""),
            ({"provider": "test-secret-as-provider"}, False, ""),
            ({}, False, ""),
        )
        for args, ok, provider in cases:
            with self.subTest(ok=ok, provider=provider):
                checker = Mock()

                result = probe_role_or_provider(
                    self.cfg, **args, health_checker=checker, credentials_path=self.credentials_path,
                )

                self.assertEqual((result["ok"], result["provider"]), (ok, provider))
                self.assertNotIn("test-secret-as-provider", json.dumps(result))
                checker.assert_not_called()

    def test_missing_credentials_return_a_setup_hint_before_execution(self) -> None:
        cases = (
            ("dsh_deepseek", "DEEPSEEK_API_KEY"),
            ("dsh_opencode", "OPENCODE_API_KEY"),
        )
        for provider, hint in cases:
            with self.subTest(provider=provider):
                checker = Mock()

                result = probe_role_or_provider(
                    self.cfg, provider=provider, health_checker=checker, credentials_path=self.credentials_path,
                )

                self.assertFalse(result["ok"])
                self.assertEqual(result["provider"], provider)
                self.assertIn(hint, result["install_hint"])
                checker.assert_not_called()

    def test_subscription_probes_follow_cli_health_without_api_keys(self) -> None:
        for provider, login in (("codex_sub", "codex login"), ("claude_sub", "claude auth login")):
            for logged_in, detail in ((True, "Logged in"), (False, "Login required")):
                with self.subTest(provider=provider, logged_in=logged_in):
                    checker = Mock(return_value=(logged_in, detail))

                    result = probe_role_or_provider(
                        self.cfg, provider=provider, health_checker=checker,
                        credentials_path=self.credentials_path,
                    )

                    checker.assert_called_once_with(self.cfg.providers[provider], 5.0)
                    self.assertIs(result["ok"], logged_in)
                    self.assertEqual(result["detail"], detail)
                    if logged_in:
                        self.assertEqual(result["install_hint"], "")
                    else:
                        self.assertIn(f"`{login}`", result["install_hint"])

    def test_subscription_probes_can_use_cli_when_local_store_is_invalid(self) -> None:
        self.credentials_path.parent.mkdir()
        self.credentials_path.write_text("{", encoding="utf-8")

        for provider in ("codex_sub", "claude_sub"):
            with self.subTest(provider=provider):
                result = probe_role_or_provider(
                    self.cfg, provider=provider, health_checker=lambda _provider, _timeout: (True, "Logged in"),
                    credentials_path=self.credentials_path,
                )

                self.assertTrue(result["ok"], result)

    def test_returns_injected_failure_with_known_secrets_redacted(self) -> None:
        env_secret = "test-active-credential"
        local_secret = "test-shadowed-credential"
        key = "OPENCODE_API_KEY"
        os.environ[key] = env_secret
        save_credentials({key: local_secret}, self.credentials_path)
        checker = Mock(return_value=(False, f"CLI unavailable ({env_secret}, {local_secret})"))

        result = probe_role_or_provider(
            self.cfg, role="bulk_worker", health_checker=checker, credentials_path=self.credentials_path,
        )

        self.assertFalse(result["ok"])
        self.assertEqual(result["detail"], "CLI unavailable (••••, ••••)")
        self.assertNotIn(env_secret, json.dumps(result))
        self.assertNotIn(local_secret, json.dumps(result))
        checker.assert_called_once_with(self.cfg.providers["dsh_opencode"], 5.0)

    def test_handles_checker_timeout_and_errors_without_echoing_exceptions(self) -> None:
        cases = (
            (TimeoutError("test-secret-from-timeout"), "timed out"),
            (subprocess.TimeoutExpired("test-secret-from-command", 0.5), "timed out"),
            (OSError("test-secret-from-error"), "failed"),
        )
        for error, detail in cases:
            with self.subTest(error=type(error).__name__):
                checker = Mock(side_effect=error)

                result = probe_role_or_provider(
                    self.cfg, provider="local_cli", health_checker=checker, credentials_path=self.credentials_path,
                )

                self.assertFalse(result["ok"])
                self.assertIn(detail, result["detail"])
                self.assertNotIn("test-secret", json.dumps(result))

    def test_bounds_latency_when_a_checker_runs_past_its_timeout(self) -> None:
        release = threading.Event()
        started = threading.Event()
        finished = threading.Event()

        def slow_checker(_provider: ProviderConfig, _timeout: float) -> tuple[bool, str]:
            started.set()
            try:
                release.wait(3)
                return True, "Too late"
            finally:
                finished.set()

        start = time.monotonic()
        try:
            result = probe_role_or_provider(
                self.cfg, provider="local_cli", health_checker=slow_checker,
                timeout_sec=0.15, credentials_path=self.credentials_path,
            )
            elapsed = time.monotonic() - start

            self.assertTrue(started.is_set())
            self.assertFalse(result["ok"])
            self.assertIn("timed out", result["detail"])
            self.assertLess(result["latency_ms"], 750)
            self.assertLess(elapsed, 0.75)
        finally:
            release.set()
            if started.is_set():
                finished.wait(1)

    def test_default_checker_runs_only_a_bounded_version_command(self) -> None:
        os.environ["OPENAI_API_KEY"] = "test-secret-from-env"
        completed = subprocess.CompletedProcess([], 0, "test-secret-from-stdout", "test-secret-from-stderr")
        with patch("vibebaton.credentials.subprocess.run", return_value=completed) as run:
            result = probe_role_or_provider(
                self.cfg, provider="local_cli", timeout_sec=0.5, credentials_path=self.credentials_path,
            )

        self.assertTrue(result["ok"])
        self.assertNotIn("test-secret", json.dumps(result))
        run.assert_called_once()
        self.assertEqual(run.call_args.args, ([str(Path(sys.executable).resolve()), "--version"],))
        self.assertNotIn("OPENAI_API_KEY", run.call_args.kwargs["env"])
        for stream in ("stdin", "stdout", "stderr"):
            self.assertEqual(run.call_args.kwargs[stream], subprocess.DEVNULL)
        self.assertGreater(run.call_args.kwargs["timeout"], 0)
        self.assertLessEqual(run.call_args.kwargs["timeout"], 0.5)

    def test_default_checker_reports_missing_executable(self) -> None:
        self.cfg.providers["local_cli"].command = [str(self.directory / "missing-cli")]

        result = probe_role_or_provider(self.cfg, provider="local_cli", credentials_path=self.credentials_path)

        self.assertFalse(result["ok"])
        self.assertIn("not found", result["detail"])
        self.assertTrue(result["install_hint"])

    def test_default_subscription_checks_run_auth_status_with_scrubbed_env(self) -> None:
        save_credentials({
            "OPENAI_API_KEY": "test-stored-codex-credential",
            "ANTHROPIC_API_KEY": "test-stored-claude-credential",
        }, self.credentials_path)
        os.environ["OPENAI_API_KEY"] = "test-codex-env-credential"
        os.environ["ANTHROPIC_API_KEY"] = "test-claude-env-credential"
        cases = (
            ("codex_sub", ["codex", "login", "status"], "codex login"),
            ("claude_sub", ["claude", "auth", "status"], "claude auth login"),
        )
        for provider, command, login in cases:
            for exit_code in (0, 1):
                with (
                    self.subTest(provider=provider, exit_code=exit_code),
                    patch("vibebaton.credentials.resolve_cli_binary", return_value=command[0]),
                    patch("vibebaton.credentials.subprocess.run", return_value=subprocess.CompletedProcess(
                        command, exit_code, stdout="test-private-auth-output", stderr="test-private-auth-error",
                    )) as run,
                ):
                    result = probe_role_or_provider(
                        self.cfg, provider=provider, timeout_sec=0.5, credentials_path=self.credentials_path,
                    )

                    self.assertIs(result["ok"], exit_code == 0)
                    self.assertNotIn("test-private-auth", json.dumps(result))
                    if exit_code == 0:
                        self.assertEqual(result["install_hint"], "")
                    else:
                        self.assertIn(f"`{login}`", result["install_hint"])
                    run.assert_called_once()
                    args, kwargs = run.call_args
                    self.assertEqual(args, (command,))
                    self.assertTrue(set(SUPPORTED_KEYS).isdisjoint(kwargs["env"]))
                    for stream in ("stdin", "stdout", "stderr"):
                        self.assertEqual(kwargs[stream], subprocess.DEVNULL)
                    self.assertGreater(kwargs["timeout"], 0)
                    self.assertLessEqual(kwargs["timeout"], 0.5)


class TestHTTPCredentialProbe(_IsolatedCredentials):
    def setUp(self) -> None:
        super().setUp()
        os.environ.pop("CUSTOM_HTTP_API_KEY", None)
        self.cfg = parse_config_dict({
            "providers": {
                "openai_http": {
                    "type": "http",
                    "base_url": "https://api.openai.com/v1",
                    "api_key_env": "OPENAI_API_KEY",
                },
                "custom_http": {
                    "type": "http",
                    "base_url": "https://gateway.example.test/v1",
                    "api_key_env": "CUSTOM_HTTP_API_KEY",
                },
                "invalid_http": {
                    "type": "http",
                    "base_url": "ftp://gateway.example.test/v1",
                    "api_key_env": "CUSTOM_HTTP_API_KEY",
                },
            },
            "roles": {
                "http_worker": {"provider": "openai_http", "model": "gpt-4o-mini"},
            },
        })

    def _probe(self, provider: str) -> ProbeResult:
        with (
            patch("vibebaton.credentials._check_cli", side_effect=AssertionError("HTTP used the CLI checker")) as cli,
            patch("vibebaton.credentials.subprocess.run", side_effect=AssertionError("HTTP spawned a process")) as run,
        ):
            result = probe_role_or_provider(
                self.cfg, provider=provider, credentials_path=self.credentials_path,
            )
        cli.assert_not_called()
        run.assert_not_called()
        return result

    def test_http_provider_with_env_key_is_ready(self) -> None:
        secret = "sk-http-env-credential-1234"
        os.environ["OPENAI_API_KEY"] = secret

        result = self._probe("openai_http")

        self.assertTrue(result["ok"], result)
        self.assertIn("https://api.openai.com/v1", result["detail"])
        self.assertIn(mask_secret(secret), result["detail"])
        self.assertNotIn(secret, json.dumps(result))
        self.assertEqual(result["install_hint"], "")

    def test_http_provider_with_local_key_is_ready(self) -> None:
        secret = "sk-http-local-credential-9012"
        save_credentials({"OPENAI_API_KEY": secret}, self.credentials_path)

        result = self._probe("openai_http")

        self.assertTrue(result["ok"], result)
        self.assertIn("https://api.openai.com/v1", result["detail"])
        self.assertIn(mask_secret(secret), result["detail"])
        self.assertNotIn(secret, json.dumps(result))

    def test_http_provider_without_key_is_unready_with_actionable_detail(self) -> None:
        result = self._probe("openai_http")

        self.assertFalse(result["ok"])
        self.assertIn("OPENAI_API_KEY", result["detail"])
        self.assertIn("credentials", result["detail"])
        self.assertTrue(result["install_hint"])

    def test_empty_environment_key_disables_the_local_http_key(self) -> None:
        save_credentials({"OPENAI_API_KEY": "sk-http-local-credential-9012"}, self.credentials_path)
        os.environ["OPENAI_API_KEY"] = ""

        result = self._probe("openai_http")

        self.assertFalse(result["ok"])
        self.assertIn("OPENAI_API_KEY", result["detail"])

    def test_http_provider_rejects_a_non_http_base_url(self) -> None:
        secret = "custom-http-credential-3456"
        os.environ["CUSTOM_HTTP_API_KEY"] = secret

        result = self._probe("invalid_http")

        self.assertFalse(result["ok"])
        self.assertIn("base_url", result["detail"])
        self.assertNotIn(secret, json.dumps(result))

    def test_http_provider_rejects_invalid_hosts_and_ports(self) -> None:
        os.environ["OPENAI_API_KEY"] = "sk-http-invalid-url-1234"
        provider = self.cfg.providers["openai_http"]
        for base_url in (
            "https://:443/v1", "https://example.test:bad/v1", "https://example.test:0/v1",
            "https://invalid host.test/v1", "https://[::1/v1",
        ):
            with self.subTest(base_url=base_url):
                provider.base_url = base_url

                result = self._probe("openai_http")

                self.assertFalse(result["ok"], result)
                self.assertIn("base_url", result["detail"])

    def test_http_detail_omits_credentials_embedded_in_the_base_url(self) -> None:
        key = "sk-http-env-credential-1234"
        os.environ["OPENAI_API_KEY"] = key
        provider = self.cfg.providers["openai_http"]
        username = "test-url-user"
        password = "test-url-password"
        token = "test-url-query-token"
        fragment = "test-url-fragment"
        provider.base_url = f"https://{username}:{password}@api.example.test/v1/{key}?token={token}#{fragment}"

        result = self._probe("openai_http")

        self.assertTrue(result["ok"], result)
        self.assertIn(f"https://api.example.test/v1/{mask_secret(key)}", result["detail"])
        for secret in (username, password, token, fragment, key):
            self.assertNotIn(secret, json.dumps(result))

    def test_http_failure_detail_does_not_echo_a_credentialed_base_url(self) -> None:
        os.environ["OPENAI_API_KEY"] = "sk-http-env-credential-1234"
        provider = self.cfg.providers["openai_http"]
        password = "test-url-password"
        token = "test-url-query-token"
        for base_url in (
            f"ftp://user:{password}@example.test/v1?token={token}",
            f"https://user:{password}@example.test:bad/v1?token={token}",
        ):
            with self.subTest(base_url=base_url):
                provider.base_url = base_url

                result = self._probe("openai_http")

                self.assertFalse(result["ok"], result)
                self.assertIn("base_url", result["detail"])
                for secret in (password, token):
                    self.assertNotIn(secret, json.dumps(result))

    def test_http_probe_masks_any_configured_key_in_the_detail(self) -> None:
        secret = "custom-http-credential-5678"
        local_secret = "custom-http-local-credential-9012"
        header_secret = "custom-http-header-credential-3456"
        os.environ["CUSTOM_HTTP_API_KEY"] = secret
        provider = self.cfg.providers["custom_http"]
        provider.headers["X-Api-Key"] = header_secret
        self.credentials_path.parent.mkdir()
        self.credentials_path.write_text(json.dumps({"CUSTOM_HTTP_API_KEY": local_secret}), encoding="utf-8")
        secrets = (secret, local_secret, header_secret)
        with patch(
            "vibebaton.http_provider.probe_http_provider",
            return_value=(False, f"Gateway rejected {', '.join(secrets)}."),
        ) as probe:
            result = self._probe("custom_http")

        probe.assert_called_once_with(provider, self.credentials_path)
        self.assertFalse(result["ok"])
        masked = ", ".join(mask_secret(value) for value in secrets)
        self.assertEqual(result["detail"], f"Gateway rejected {masked}.")
        for value in secrets:
            self.assertNotIn(value, json.dumps(result))

    def test_resolve_env_for_http_provider_includes_api_key_env(self) -> None:
        secret = "sk-http-provider-credential-7890"
        save_credentials({"OPENAI_API_KEY": secret}, self.credentials_path)
        provider = self.cfg.providers["openai_http"]

        self.assertEqual(
            resolve_env_for_provider(provider, self.credentials_path),
            {"OPENAI_API_KEY": secret},
        )
        with patch.dict(os.environ, OPENAI_API_KEY="test-env-credential"):
            self.assertEqual(resolve_env_for_provider(provider, self.credentials_path), {})

    def test_resolve_env_for_http_provider_loads_its_configured_key_from_home(self) -> None:
        provider = ProviderConfig("dsh_opencode", type="http", api_key_env="DEEPSEEK_API_KEY")
        secret = "test-deepseek-http-credential"
        with patch.object(Path, "home", return_value=self.directory):
            save_credentials({"DEEPSEEK_API_KEY": secret, "OPENCODE_API_KEY": "test-unrelated-credential"})

            self.assertEqual(resolve_env_for_provider(provider), {"DEEPSEEK_API_KEY": secret})
            with patch.dict(os.environ, DEEPSEEK_API_KEY=""):
                self.assertEqual(resolve_env_for_provider(provider), {})

    def test_resolve_env_reads_a_non_supported_api_key_env_from_local_credentials(self) -> None:
        secret = "custom-http-local-credential"
        self.credentials_path.parent.mkdir(parents=True)
        self.credentials_path.write_text(
            json.dumps({"CUSTOM_HTTP_API_KEY": secret}), encoding="utf-8",
        )

        self.assertEqual(
            resolve_env_for_provider(self.cfg.providers["custom_http"], self.credentials_path),
            {"CUSTOM_HTTP_API_KEY": secret},
        )

    def test_model_catalog_readiness_matches_the_http_probe(self) -> None:
        secret = "sk-http-catalog-credential-2468"
        os.environ["OPENAI_API_KEY"] = secret

        ready_check = self._probe("openai_http")
        ready_catalog = build_model_catalog(self.cfg, {"openai_http": ready_check})

        os.environ.pop("OPENAI_API_KEY")
        unready_check = self._probe("openai_http")
        unready_catalog = build_model_catalog(self.cfg, {"openai_http": unready_check})

        self.assertTrue(ready_check["ok"])
        self.assertFalse(unready_check["ok"])
        self.assertEqual(
            [(item.model, item.ready, item.detail) for item in ready_catalog if item.provider == "openai_http"],
            [("gpt-4o-mini", True, ready_check["detail"])],
        )
        self.assertEqual(
            [(item.model, item.ready, item.detail) for item in unready_catalog if item.provider == "openai_http"],
            [("gpt-4o-mini", False, unready_check["detail"])],
        )


if __name__ == "__main__":
    unittest.main()
