"""Golden tests for the shared HTTP provider contracts."""

from __future__ import annotations

import json
import os
import tempfile
import threading
import unittest
from dataclasses import replace
from email.message import Message
from io import BytesIO
from pathlib import Path
from unittest.mock import patch
from urllib.error import HTTPError, URLError
from urllib.request import ProxyHandler, Request, build_opener, urlopen

from tests.http_mock_server import MockChatCompletionsServer, MockResponse
from vibebaton.cli_runner import CLIResult, invoke_provider
from vibebaton.config import HotReloadConfig, ProviderConfig
from vibebaton.http_provider import (
    build_chat_completions_request,
    compute_token_cost_usd,
    parse_chat_completions_response,
    probe_http_provider,
    resolve_http_api_key,
    run_http_provider,
)


_KEY_ENV = "VIBEBATON_HTTP_TEST_KEY"
_SECRET = "sk-test-secret-value-1234567890"


_CHOICES = [{"message": {"role": "assistant", "content": "Example reply"}}]
_COMPLETION = {
    "choices": _CHOICES,
    "usage": {
        "prompt_tokens": 1000,
        "completion_tokens": 500,
        "prompt_tokens_details": {"cached_tokens": 250},
    },
}


class TestProviderConfig(unittest.TestCase):
    def test_loads_http_defaults_and_overrides_from_toml(self) -> None:
        folder = Path(self.enterContext(tempfile.TemporaryDirectory()))
        config_path = folder / "baton.toml"
        config_path.write_text(
            """
[providers.openai]
type = "http"

[providers.gateway]
type = "http"
base_url = "http://127.0.0.1:8000/v1"
api_key_env = "GATEWAY_API_KEY"
command = []

[providers.gateway.headers]
"X-Client" = "baton"

[providers.gateway.model_pricing."local.model"]
input_per_1m = 0.5
output_per_1m = 2
cached_input_per_1m = 0.1

[providers.local]
command = ["echo"]
""",
            encoding="utf-8",
        )
        providers = HotReloadConfig(config_path).current.providers
        openai = providers["openai"]
        self.assertEqual(openai.type, "http")
        self.assertEqual(openai.command, [])
        self.assertEqual(openai.base_url, "https://api.openai.com/v1")
        self.assertEqual(openai.api_key_env, "OPENAI_API_KEY")
        self.assertEqual(openai.headers, {})
        self.assertEqual(openai.model_pricing, {})

        gateway = providers["gateway"]
        self.assertEqual(gateway.command, [])
        self.assertEqual(gateway.base_url, "http://127.0.0.1:8000/v1")
        self.assertEqual(gateway.api_key_env, "GATEWAY_API_KEY")
        self.assertEqual(gateway.headers, {"X-Client": "baton"})
        self.assertEqual(gateway.model_pricing, {
            "local.model": {"input_per_1m": 0.5, "output_per_1m": 2.0, "cached_input_per_1m": 0.1},
        })
        self.assertIsInstance(gateway.model_pricing["local.model"]["output_per_1m"], float)
        self.assertEqual(providers["local"], ProviderConfig("local", command=["echo"]))


class TestCLIResult(unittest.TestCase):
    def test_legacy_positional_fields_and_telemetry_defaults(self) -> None:
        result = CLIResult("ok", 0, "stdout", "stderr", 0.25, ["echo"], 5.0, "artifact")
        self.assertEqual(result.retry_after_sec, 5.0)
        self.assertEqual(result.output_file_text, "artifact")
        self.assertEqual((result.prompt_tokens, result.completion_tokens, result.cached_tokens), (0, 0, 0))
        self.assertIsNone(result.cost_usd)


class TestInvokeProvider(unittest.IsolatedAsyncioTestCase):
    async def test_cli_forwards_original_model_spec_and_runner_arguments(self) -> None:
        provider = ProviderConfig("local", command=["echo"])
        cwd = Path("worktree")
        output = cwd / "out.json"
        cli_args = {
            "prompt_file": cwd / "prompt.md",
            "default_stall_timeout": 15,
            "default_hard_timeout": 45,
            "extra_env": {"VIBEBATON_ROLE": "worker"},
        }
        expected = CLIResult("ok", 0, "done", "", 0.25, ["echo"])
        with patch("vibebaton.cli_runner.run_provider_cli", return_value=expected) as runner:
            result = await invoke_provider(
                provider, prompt="Hello", model="model@high", effort="high", output_file=output,
                cwd=cwd, credentials_path=cwd / "credentials.json", **cli_args,
            )
        self.assertIs(result, expected)
        runner.assert_awaited_once_with(
            provider, prompt="Hello", model="model@high", output_file=output, workdir=cwd, **cli_args,
        )

    async def test_http_forwards_transport_arguments_and_effective_timeout(self) -> None:
        cwd = Path("worktree")
        credentials_path = cwd / "credentials.json"
        expected = CLIResult("ok", 0, "done", "", 0.25, [], prompt_tokens=1000)
        for explicit, configured, timeout in ((3, 12, 3), (None, 12, 12), (None, None, 45)):
            with self.subTest(explicit=explicit, configured=configured):
                provider = ProviderConfig("gateway", type="http", hard_timeout_sec=configured)
                with patch("vibebaton.http_provider.run_http_provider", return_value=expected) as runner:
                    result = await invoke_provider(
                        provider, prompt="Hello", model="model", effort="high", output_file=None,
                        cwd=cwd, credentials_path=credentials_path, hard_timeout_sec=explicit,
                        default_hard_timeout=45, prompt_file=cwd / "prompt.md",
                    )
                self.assertIs(result, expected)
                runner.assert_awaited_once_with(
                    provider, prompt="Hello", model="model", effort="high", output_file=None,
                    cwd=cwd, credentials_path=credentials_path, hard_timeout_sec=timeout,
                )


class TestCostHelper(unittest.TestCase):
    def test_exact_cost_at_per_million_rates(self) -> None:
        pricing = {"example": {"input_per_1m": 0.5, "output_per_1m": 1.5}}
        self.assertEqual(compute_token_cost_usd("example", 1000, 500, pricing_table=pricing), 0.00125)
        self.assertEqual(compute_token_cost_usd("example", 1000, 500, 250, pricing), 0.00125)

    def test_cached_prompt_tokens_use_the_override_rate_once(self) -> None:
        pricing = {"gpt-4o": {"input_per_1m": 0.5, "output_per_1m": 1.5, "cached_input_per_1m": 0.1}}
        self.assertEqual(compute_token_cost_usd("gpt-4o", 1000, 500, 250, pricing), 0.00115)

    def test_built_in_rates_and_decimal_arithmetic(self) -> None:
        self.assertEqual(compute_token_cost_usd("gpt-4o-mini", 7, 11), 0.00000765)
        self.assertEqual(compute_token_cost_usd("deepseek-flash", 1000, 500, 250, {}), 0.0008265)

    def test_returns_none_for_unknown_model_or_incomplete_override(self) -> None:
        self.assertIsNone(compute_token_cost_usd("unknown", 1000, 500))
        pricing = {"gpt-4o": {"input_per_1m": 0.5}}
        self.assertIsNone(compute_token_cost_usd("gpt-4o", 1000, 500, pricing_table=pricing))


class TestResponseParser(unittest.TestCase):
    def test_extracts_text_and_nested_cached_token_usage(self) -> None:
        body = json.dumps(_COMPLETION).encode("utf-8")
        self.assertEqual(parse_chat_completions_response(body), ("Example reply", 1000, 500, 250))

    def test_reads_deepseek_cache_hits_and_defaults_missing_usage(self) -> None:
        body = json.dumps({
            "choices": _CHOICES,
            "usage": {"prompt_tokens": 10, "completion_tokens": 7, "prompt_cache_hit_tokens": 4},
        }).encode("utf-8")
        self.assertEqual(parse_chat_completions_response(body), ("Example reply", 10, 7, 4))
        body = json.dumps({"choices": _CHOICES}).encode("utf-8")
        self.assertEqual(parse_chat_completions_response(body), ("Example reply", 0, 0, 0))

    def test_rejects_malformed_content_and_inconsistent_usage(self) -> None:
        invalid_bodies = (
            b"{",
            b'{"choices": []}',
            b'{"choices": [{"message": {"content": null}}]}',
            json.dumps({"choices": _CHOICES, "usage": {"prompt_tokens": True}}).encode("utf-8"),
            json.dumps({"choices": _CHOICES, "usage": {
                "prompt_tokens": 1, "prompt_tokens_details": {"cached_tokens": 2},
            }}).encode("utf-8"),
        )
        for body in invalid_bodies:
            with self.subTest(body=body), self.assertRaises(ValueError):
                parse_chat_completions_response(body)


class TestResolveHTTPApiKey(unittest.TestCase):
    def setUp(self) -> None:
        self.provider = ProviderConfig("gateway", type="http", api_key_env="VIBEBATON_HTTP_TEST_KEY")
        folder = Path(self.enterContext(tempfile.TemporaryDirectory()))
        self.credentials_path = folder / "credentials.json"
        self.enterContext(patch.dict(os.environ))
        os.environ.pop(self.provider.api_key_env, None)

    def test_env_takes_precedence_over_local_credentials(self) -> None:
        self.credentials_path.write_text(
            json.dumps({self.provider.api_key_env: "test-local-key"}), encoding="utf-8",
        )
        self.assertEqual(resolve_http_api_key(self.provider, self.credentials_path), "test-local-key")
        os.environ[self.provider.api_key_env] = "test-env-key"
        self.assertEqual(resolve_http_api_key(self.provider, self.credentials_path), "test-env-key")
        os.environ[self.provider.api_key_env] = ""
        self.assertIsNone(resolve_http_api_key(self.provider, self.credentials_path))

    def test_missing_and_malformed_credentials_return_none(self) -> None:
        self.assertIsNone(resolve_http_api_key(self.provider, self.credentials_path))
        self.credentials_path.write_text("{", encoding="utf-8")
        self.assertIsNone(resolve_http_api_key(self.provider, self.credentials_path))


class TestMockChatCompletionsServer(unittest.TestCase):
    def test_records_requests_and_serves_the_script(self) -> None:
        script = [
            MockResponse.from_json(_COMPLETION),
            MockResponse.from_json({"error": "busy"}, status=429, headers={"Retry-After": "7"}),
            MockResponse(status=500),
            MockResponse(body=b"{", headers={"Content-Type": "application/json"}),
            MockResponse.from_json(_COMPLETION, delay_sec=5.0),
        ]
        opener = build_opener(ProxyHandler({}))
        with MockChatCompletionsServer(script) as server:
            request = Request(
                f"{server.base_url}/chat/completions", data=b'{"model": "example"}',
                headers={"Content-Type": "application/json", "Authorization": "Bearer test-key"},
            )
            with opener.open(request, timeout=5) as response:
                self.assertEqual(response.status, 200)
                self.assertEqual(parse_chat_completions_response(response.read()), ("Example reply", 1000, 500, 250))
            with self.assertRaises(HTTPError) as limited:
                opener.open(request, timeout=5)
            with limited.exception as response:
                self.assertEqual(response.code, 429)
                self.assertEqual(response.headers["Retry-After"], "7")
            with self.assertRaises(HTTPError) as failed:
                opener.open(request, timeout=5)
            with failed.exception as response:
                self.assertEqual(response.code, 500)
            with opener.open(request, timeout=5) as response, self.assertRaises(json.JSONDecodeError):
                parse_chat_completions_response(response.read())
            with self.assertRaises(TimeoutError):
                opener.open(request, timeout=0.5)

            self.assertEqual(len(server.requests), len(script))
            first = server.requests[0]
            self.assertEqual(first.path, "/chat/completions")
            self.assertEqual(first.headers["Authorization"], "Bearer test-key")
            self.assertEqual(json.loads(first.body), {"model": "example"})


class TestBuildChatCompletionsRequest(unittest.TestCase):
    def test_builds_url_body_and_configured_headers(self) -> None:
        provider = ProviderConfig(
            "gateway",
            type="http",
            base_url="http://127.0.0.1:8000/v1/",
            headers={"X-Client": "baton"},
        )
        url, body, headers = build_chat_completions_request(provider, "local.model", "Hello", None)

        self.assertEqual(url, "http://127.0.0.1:8000/v1/chat/completions")
        self.assertEqual(headers, {"Content-Type": "application/json", "X-Client": "baton"})
        self.assertEqual(json.loads(body), {
            "model": "local.model",
            "messages": [{"role": "user", "content": "Hello"}],
        })

    def test_adds_reasoning_effort_only_when_provided(self) -> None:
        provider = ProviderConfig("gateway", type="http")
        _, body, _ = build_chat_completions_request(provider, "model", "Hello", "high")
        self.assertEqual(json.loads(body)["reasoning_effort"], "high")
        for effort in (None, ""):
            with self.subTest(effort=effort):
                _, body, _ = build_chat_completions_request(provider, "model", "Hello", effort)
                self.assertNotIn("reasoning_effort", json.loads(body))


class TestRunHTTPProvider(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        self.enterContext(patch.dict(os.environ, {_KEY_ENV: _SECRET, "no_proxy": "127.0.0.1"}))
        folder = Path(self.enterContext(tempfile.TemporaryDirectory()))
        self.credentials_path = folder / "credentials.json"
        self.output_file = folder / "out" / "reply.txt"

    def _provider(self, server: MockChatCompletionsServer) -> ProviderConfig:
        return ProviderConfig("gateway", type="http", base_url=server.base_url, api_key_env=_KEY_ENV)

    async def _run(
        self,
        provider: ProviderConfig,
        *,
        model: str = "local.model",
        output_file: Path | None = None,
        hard_timeout_sec: float | None = None,
    ) -> CLIResult:
        return await run_http_provider(
            provider,
            prompt="Hello",
            model=model,
            effort=None,
            output_file=output_file,
            cwd=self.credentials_path.parent,
            credentials_path=self.credentials_path,
            hard_timeout_sec=hard_timeout_sec,
        )

    async def test_ok_returns_usage_cost_and_writes_output_file(self) -> None:
        pricing = {
            "local.model": {
                "input_per_1m": 0.5,
                "output_per_1m": 2.0,
                "cached_input_per_1m": 0.1,
            },
        }
        with MockChatCompletionsServer([MockResponse.from_json(_COMPLETION)]) as server:
            provider = replace(self._provider(server), headers={"X-Client": "baton"}, model_pricing=pricing)
            result = await invoke_provider(
                provider,
                prompt="Hello",
                model="local.model",
                effort="high",
                output_file=self.output_file,
                cwd=self.credentials_path.parent,
                credentials_path=self.credentials_path,
            )
            self.assertEqual(len(server.requests), 1)
            request = server.requests[0]

        self.assertEqual(result.status, "ok")
        self.assertEqual(result.exit_code, 0)
        self.assertEqual(result.stdout, "Example reply")
        self.assertEqual(result.output_file_text, "Example reply")
        self.assertEqual(self.output_file.read_text(encoding="utf-8"), "Example reply")
        self.assertEqual(
            (result.prompt_tokens, result.completion_tokens, result.cached_tokens),
            (1000, 500, 250),
        )
        self.assertEqual(result.cost_usd, 0.0014)
        self.assertEqual(request.path, "/chat/completions")
        headers = {key.lower(): value for key, value in request.headers.items()}
        self.assertEqual(headers["authorization"], f"Bearer {_SECRET}")
        self.assertEqual(headers["content-type"], "application/json")
        self.assertEqual(headers["x-client"], "baton")
        self.assertEqual(json.loads(request.body), {
            "model": "local.model",
            "messages": [{"role": "user", "content": "Hello"}],
            "reasoning_effort": "high",
        })
        self.assertNotIn(_SECRET, " ".join(result.command))

    async def test_ok_without_known_pricing_leaves_cost_none(self) -> None:
        with MockChatCompletionsServer([MockResponse.from_json(_COMPLETION)]) as server:
            result = await self._run(self._provider(server), model="unknown-model")

        self.assertEqual(result.status, "ok")
        self.assertIsNone(result.output_file_text)
        self.assertIsNone(result.cost_usd)

    async def test_reads_api_key_from_local_credentials(self) -> None:
        os.environ.pop(_KEY_ENV)
        self.credentials_path.write_text(
            json.dumps({_KEY_ENV: _SECRET}), encoding="utf-8",
        )
        with MockChatCompletionsServer([MockResponse.from_json(_COMPLETION)]) as server:
            result = await self._run(self._provider(server))
            request = server.requests[0]

        self.assertEqual(result.status, "ok")
        headers = {key.lower(): value for key, value in request.headers.items()}
        self.assertEqual(headers["authorization"], f"Bearer {_SECRET}")

    async def test_429_uses_retry_after_header(self) -> None:
        response = MockResponse.from_json(
            {"error": {"message": "retry after 2 minutes"}}, status=429, headers={"Retry-After": "7"},
        )
        with MockChatCompletionsServer([response]) as server:
            result = await self._run(self._provider(server))

        self.assertEqual(result.status, "rate_limited")
        self.assertEqual(result.exit_code, 429)
        self.assertEqual(result.retry_after_sec, 7.0)

    async def test_429_reads_retry_after_from_body_text(self) -> None:
        body = b"Too many requests. Please retry after 2 minutes."
        responses = [
            MockResponse(status=429, body=body),
            MockResponse(status=429, body=body, headers={"Retry-After": "unknown"}),
        ]
        with MockChatCompletionsServer(responses) as server:
            for response in responses:
                with self.subTest(headers=response.headers):
                    result = await self._run(self._provider(server))
                    self.assertEqual(result.status, "rate_limited")
                    self.assertEqual(result.exit_code, 429)
                    self.assertEqual(result.retry_after_sec, 120.0)

    async def test_classifies_quota_errors_and_custom_rate_limit_body(self) -> None:
        responses = [
            MockResponse.from_json({"error": {"code": "insufficient_quota"}}),
            MockResponse(status=503, body=b"Capacity exhausted. Try again in 3 seconds."),
        ]
        with MockChatCompletionsServer(responses) as server:
            provider = replace(self._provider(server), rate_limit_regex=r"capacity exhausted")
            quota = await self._run(provider)
            busy = await self._run(provider)

        self.assertEqual((quota.status, quota.exit_code), ("rate_limited", 200))
        self.assertEqual((busy.status, busy.exit_code, busy.retry_after_sec), ("rate_limited", 503, 3.0))

    async def test_valid_completion_can_discuss_rate_limits(self) -> None:
        reply = "A rate limit can cause HTTP 429."
        response = MockResponse.from_json({"choices": [{"message": {"content": reply}}]})
        with MockChatCompletionsServer([response]) as server:
            result = await self._run(self._provider(server))

        self.assertEqual((result.status, result.stdout), ("ok", reply))

    async def test_500_maps_to_error(self) -> None:
        with MockChatCompletionsServer([
            MockResponse(body=b'{"error": "boom"}', status=500),
        ]) as server:
            result = await self._run(self._provider(server))

        self.assertEqual(result.status, "error")
        self.assertEqual(result.exit_code, 500)
        self.assertIn("500", result.stderr)

    async def test_http_error_body_is_read_and_closed_in_worker(self) -> None:
        caller_thread = threading.get_ident()

        def read() -> bytes:
            self.assertNotEqual(threading.get_ident(), caller_thread)
            return b"server failed"

        with MockChatCompletionsServer([]) as server:
            response_body = BytesIO()
            error = HTTPError(server.base_url, 500, "failure", Message(), response_body)
            with patch.object(error, "read", side_effect=read), patch("urllib.request.urlopen", side_effect=error):
                result = await self._run(self._provider(server))

        self.assertEqual((result.status, result.exit_code), ("error", 500))
        self.assertIn("server failed", result.stderr)
        self.assertTrue(response_body.closed)

    async def test_malformed_json_and_missing_choices_map_to_error(self) -> None:
        responses = (
            MockResponse(body=b"{", headers={"Content-Type": "application/json"}),
            MockResponse.from_json({"usage": {"prompt_tokens": 10, "completion_tokens": 5}}),
        )
        with MockChatCompletionsServer(responses) as server:
            provider = self._provider(server)
            for response in responses:
                with self.subTest(body=response.body):
                    result = await self._run(provider)
                    self.assertEqual((result.status, result.exit_code), ("error", 200))
                    self.assertIn("Malformed Chat Completions response", result.stderr)

    async def test_success_requires_http_200(self) -> None:
        with MockChatCompletionsServer([MockResponse.from_json(_COMPLETION, status=201)]) as server:
            result = await self._run(self._provider(server))

        self.assertEqual((result.status, result.exit_code), ("error", 201))

    async def test_slow_response_with_hard_timeout_maps_to_timeout(self) -> None:
        with MockChatCompletionsServer([
            MockResponse.from_json(_COMPLETION, delay_sec=5.0),
        ]) as server:
            provider = replace(self._provider(server), hard_timeout_sec=10)
            result = await self._run(provider, hard_timeout_sec=0.5)

        self.assertEqual(result.status, "timeout")
        self.assertEqual(result.exit_code, 1)

    async def test_falls_back_to_provider_then_default_timeout(self) -> None:
        with MockChatCompletionsServer([MockResponse.from_json(_COMPLETION)] * 2) as server:
            for configured, expected in ((30, 30), (None, 600)):
                with self.subTest(configured=configured), patch("urllib.request.urlopen", wraps=urlopen) as opener:
                    provider = replace(self._provider(server), hard_timeout_sec=configured)
                    result = await self._run(provider)
                    self.assertEqual(result.status, "ok")
                    self.assertEqual(opener.call_args.kwargs["timeout"], expected)

    async def test_url_errors_map_to_timeout_or_sanitized_error(self) -> None:
        cases = [(TimeoutError("timed out"), "timeout"), (f"connection refused for {_SECRET}", "error")]
        with MockChatCompletionsServer([]) as server:
            for reason, expected in cases:
                with self.subTest(expected=expected), patch("urllib.request.urlopen", side_effect=URLError(reason)):
                    result = await self._run(self._provider(server))
                    self.assertEqual((result.status, result.exit_code), (expected, 1))
                    self.assertTrue(result.stderr)
                    self.assertNotIn(_SECRET, result.stderr)

    async def test_api_key_never_leaks_into_result_fields(self) -> None:
        body = json.dumps({"error": f"request rejected for {_SECRET}"}).encode("utf-8")
        reply = {"choices": [{"message": {"content": f"Request key was {_SECRET}."}}]}
        with MockChatCompletionsServer([
            MockResponse(body=body, status=401, headers={"Content-Type": "application/json"}),
            MockResponse.from_json(reply),
        ]) as server:
            provider = self._provider(server)
            denied = await self._run(provider)
            accepted = await self._run(provider, output_file=self.output_file)

        self.assertEqual((denied.status, denied.exit_code), ("error", 401))
        self.assertEqual(accepted.status, "ok")
        for result in (denied, accepted):
            for field in (result.stdout, result.stderr, " ".join(result.command)):
                self.assertNotIn(_SECRET, field)
        self.assertIn("[redacted]", denied.stderr)
        self.assertEqual(accepted.stdout, "Request key was [redacted].")
        self.assertEqual(accepted.output_file_text, accepted.stdout)
        self.assertEqual(self.output_file.read_text(encoding="utf-8"), accepted.stdout)

    async def test_command_redacts_key_in_configured_url(self) -> None:
        os.environ[_KEY_ENV] = "v1"
        with MockChatCompletionsServer([MockResponse.from_json(_COMPLETION)]) as server:
            provider = replace(self._provider(server), base_url=f"{server.base_url}/v1")
            result = await self._run(provider)

        self.assertEqual(result.status, "ok")
        self.assertNotIn("v1", " ".join(result.command))

    async def test_missing_api_key_returns_error_without_request(self) -> None:
        os.environ.pop("OPENAI_API_KEY", None)
        with MockChatCompletionsServer([]) as server:
            provider = ProviderConfig("gateway", type="http", base_url=server.base_url)
            result = await self._run(provider)
            self.assertEqual(server.requests, [])

        self.assertEqual(result.status, "error")
        self.assertEqual(result.exit_code, 1)
        self.assertEqual(
            result.stderr,
            "API key not configured (env OPENAI_API_KEY or ~/.vibebaton/credentials.json)",
        )
        self.assertEqual(result.command, [])


class TestProbeHTTPProvider(unittest.TestCase):
    def setUp(self) -> None:
        self.enterContext(patch.dict(os.environ))
        os.environ.pop(_KEY_ENV, None)
        opener = self.enterContext(patch("urllib.request.urlopen"))
        self.addCleanup(opener.assert_not_called)
        folder = Path(self.enterContext(tempfile.TemporaryDirectory()))
        self.credentials_path = folder / "credentials.json"
        self.provider = ProviderConfig(
            "gateway", type="http", base_url="http://127.0.0.1:8000/v1", api_key_env=_KEY_ENV,
        )

    def test_reports_env_key_without_network_io(self) -> None:
        os.environ[_KEY_ENV] = _SECRET
        ok, detail = probe_http_provider(self.provider, self.credentials_path)

        self.assertTrue(ok)
        self.assertEqual(detail, "http://127.0.0.1:8000/v1 key via env")

    def test_reports_local_credentials_key(self) -> None:
        self.credentials_path.write_text(
            json.dumps({_KEY_ENV: _SECRET}), encoding="utf-8",
        )
        ok, detail = probe_http_provider(self.provider, self.credentials_path)

        self.assertTrue(ok)
        self.assertEqual(detail, "http://127.0.0.1:8000/v1 key via local_file")

    def test_rejects_non_http_base_url(self) -> None:
        os.environ[_KEY_ENV] = _SECRET
        for base_url in ("file:///tmp/v1", "api.openai.com/v1", "", "http:///v1", "http://127.0.0.1:bad/v1"):
            with self.subTest(base_url=base_url):
                provider = ProviderConfig(
                    "gateway", type="http", base_url=base_url, api_key_env=_KEY_ENV,
                )
                ok, reason = probe_http_provider(provider, self.credentials_path)
                self.assertFalse(ok)
                self.assertIn("http", reason)

    def test_reports_missing_key(self) -> None:
        ok, reason = probe_http_provider(self.provider, self.credentials_path)

        self.assertFalse(ok)
        self.assertEqual(
            reason,
            f"API key not configured (env {_KEY_ENV} or ~/.vibebaton/credentials.json)",
        )
