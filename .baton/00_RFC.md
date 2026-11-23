# Master RFC: Stage 4.7 (v1.0.3) — DSH Naming Unification, All-CLI Token Usage Extraction & Daily Official API Pricing Engine

## Goals

Align VibeBaton telemetry, presets, Studio UI labels, CLI execution runners, and billing math with real-world usage:

1. **Unify User-Facing Runner Branding (`DeepSeek API` → `DSH`)**:
   - Replace user-facing references to `"DeepSeek API"` that represent the `dsh_opencode` / DeepSeek Harness (`dsh`) CLI runner with **`"DSH"`** across backend display mapping, battle reports, live event formatters, presets, Stage 1 replay trace, Studio UI copy, documentation, and tests (while keeping internal provider config ID `dsh_opencode` and direct OpenAI-compatible HTTP provider examples backward compatible).

2. **Three-Tier Official + Custom API Pricing Engine with 24-Hour Refresh (`pricing.py`)**:
   - Compute token cost (`USD`) using real official API list rates by default, refreshed automatically once every **24 hours** (`refresh_interval_hours = 24`) in a non-blocking background fetch, with full user custom override support.
   - Strict lookup precedence:
     1. **User Custom Pricing**: per-provider `provider.model_pricing` in `baton.toml` → `[pricing.custom]` in `baton.toml` → `~/.vibebaton/custom_pricing.json` (`source = "custom"`).
     2. **Daily Cached Official Pricing**: `~/.vibebaton/pricing_cache.json` populated by official pricing sync (`source = "official_cache"`).
     3. **Built-in Official Fallback Table**: bundled Anthropic Claude, OpenAI Codex, and DeepSeek official list rates (`source = "builtin"`), ensuring accurate offline pricing.
   - Expose `baton pricing sync [--force] [--json]`, `baton pricing show [--json]`, REST endpoints (`GET /api/pricing`, `POST /api/pricing/sync`, `PUT /api/pricing/custom`), and a clean **API Pricing / 模型单价** Studio modal.

3. **All-CLI Structured Token Usage & Cost Collection (`cli_runner.py`, `engine.py`, `baton.example.toml`)**:
   - Extract exact token usage (`prompt_tokens`, `completion_tokens`, `cached_tokens`) and assistant text cleanly from structured JSON / JSONL outputs across all three CLI harnesses:
     - **Claude CLI** (`--output-format json` or `stream-json`);
     - **Codex CLI** (`codex exec --json -o {output_file}`);
     - **DSH CLI** (`dsh --profile headless --json`).
   - Preserve transparent fallback when any CLI returns plain text. Whenever token counts are extracted, compute `cost_usd` via the 3-tier pricing engine and record exact tokens + cost inside `role_completed` events so Web Studio Billing and Bilingual Battle Reports immediately display live consumption across every CLI tier.

## Constraints

- **Zero new Python runtime dependencies**: `pricing.py`, `cli_runner.py`, `cli.py`, and `web_server.py` must use Python 3.11+ standard library modules only (`urllib.request`, `json`, `os`, `time`, `threading`, `decimal`, `pathlib`, `dataclasses`).
- **Zero new npm dependencies**: Do NOT run `npm install` or edit `package-lock.json`; only bump `"version": "1.0.3"` in `web/package.json`. On Windows, invoke `npx.cmd` and `npm.cmd`.
- **Network Safety & Offline Resilience**:
  - Background 24-hour official pricing sync must NEVER block startup or fail a run if offline/timed out; on failure it retains the previous valid cache or falls back seamlessly to `DEFAULT_MODEL_PRICING`.
  - Unit and integration tests must NEVER make real external HTTP requests (`VIBEBATON_DISABLE_PRICING_SYNC=1` or injected mock fetchers in tests).
- **Backward Compatibility & Test Invariants**:
  - Preserve `dsh_opencode` as internal provider ID in `baton.toml`, `baton.example.toml`, and `.baton.json` node `config.provider`.
  - Keep existing `tests/test_http_provider.py` and `tests/test_report_billing.py` APIs (`compute_token_cost_usd` signature & return values) passing cleanly.
  - Keep `tests/test_release_collateral.py` checks (`"1.0.0"`, `"sandbox init"`, `"scripts/install.ps1"` in `README.md` and `v1.0.0` in `docs/ROADMAP.md`) green.
  - Maintain pure English default locale (zero CJK in `MESSAGES.en`), Han characters in `MESSAGES.zh`, and zero `/opencode/i` in UI copy (`web/src/i18n/i18n.test.ts`).
  - `CHANGELOG.md` lists versions strictly oldest-first (`v1.0.3` appended after `v1.0.2`, zero HTML worker comments).

## Non-Goals

- Do NOT introduce browser scraping, Playwright runtime dependencies, or third-party HTTP/pricing SDKs (`httpx`, `requests`, `litellm`).
- Do NOT break plain-text CLI execution when users run older CLI binaries or custom shell commands without JSON flags.
- Do NOT retroactively modify historical `state.sqlite` event records already saved before Stage 4.7.

## Architecture & Deliverables (Milestones M1–M3)

### M1: Global `DeepSeek API` → `DSH` Naming Unification

- **Backend Display Mapping & Tests**:
  - `src/vibebaton/report.py`: update `PROVIDER_DISPLAY_NAMES` (`"dsh_opencode": "DSH"`, `"dsh_deepseek": "DSH"`) and `display_provider_name`, plus normalize bare `dsh_opencode/` or `dsh_opencode:` prefixes in rendered battle report event summaries when displaying provider names.
  - `tests/test_presets.py`: update `test_deepseek_bulk_factory_uses_api_branding_and_model` to assert `"DSH"` while preserving `dsh_opencode` node `config.provider` assertions.
  - `tests/test_report_telemetry.py`: update `"DeepSeek API"` assertions to `"DSH"`.
- **Frontend i18n, Events, Presets & Stage 1 Replay**:
  - `web/src/i18n/presets.ts`: update `formatProviderDisplay('dsh_opencode')` and `dsh_deepseek` -> `'DSH'`; update `EN_TO_ZH_PRESET_TEXT` keys & values to use `DSH` (for example `'DSH Bulk Factory': 'DSH 批量工厂'`).
  - `web/src/i18n/liveEvents.ts`: update `dsh_opencode/` and bare `dsh_opencode` formatting to display `DSH/` / `DSH` across both English and Chinese event logs.
  - `web/src/i18n/messages.ts`: update quick-start / tutorial / wizard copy from `DeepSeek API` to `DSH` (preserving credential key IDs like `DEEPSEEK_API_KEY` and `OPENCODE_API_KEY`).
  - Update preset files (`presets/deepseek_bulk_factory.baton.json`, `presets/flagship_4tier.baton.json`, `presets/solo_coder_3tier.baton.json`, `presets/starter_2tier.baton.json`, and matching `web/src/data/presets/*.ts`) and Stage 1 replay trace (`web/src/data/stage1Replay.ts`) from `DeepSeek API` to `DSH`.
  - Update `web/src/i18n/i18n.test.ts` and `web/src/i18n/liveEvents.test.ts` to assert `'DSH'` cleanly with zero CJK in EN, Han in ZH, and zero `/opencode/i` matches.
- **Documentation Alignment**:
  - Update DSH harness references in `docs/TUTORIAL.md`, `docs/ROADMAP.md`, `docs/SECURITY.md`, `docs/RELEASE_NOTES_v1.0.md`, `benchmarks/README.md`, and `README.md` to `DSH` (keeping `README.md`'s native HTTP provider example clearly framed as direct OpenAI-compatible HTTP API usage and preserving all `test_release_collateral.py` checks).

### M2: Pure-Stdlib 3-Tier Pricing Engine (`pricing.py`), Daily 24h Sync, Custom Pricing, CLI & REST API

- **`src/vibebaton/config.py`**:
  - Add `@dataclass class PricingSettings`:
    - `auto_sync: bool = True`
    - `refresh_interval_hours: int = 24`
    - `source_url: str = "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json"`
    - `timeout_sec: float = 5.0`
    - `cache_path: str = ""` (defaults to `~/.vibebaton/pricing_cache.json`)
    - `custom_path: str = ""` (defaults to `~/.vibebaton/custom_pricing.json`)
    - `custom: dict[str, dict[str, float]] = field(default_factory=dict)` (from `[pricing.custom."<model>"]`)
  - Add `pricing: PricingSettings = field(default_factory=PricingSettings)` to `BatonConfig` and parse optional `[pricing]` table cleanly in `parse_config_dict` so existing TOML files load unchanged.
- **`src/vibebaton/pricing.py`**:
  - Define `DEFAULT_MODEL_PRICING: dict[str, dict[str, float]]` with official USD per 1M token rates (`input_per_1m`, `output_per_1m`, `cached_input_per_1m`) covering:
    - Anthropic Claude (`claude-opus-4-6`, `claude-opus-4-5`, `claude-sonnet-4-6`, `claude-haiku-4-5`, plus VibeBaton aliases `opus`, `sonnet`, `haiku`, `fable`);
    - OpenAI / Codex (`gpt-4o`, `gpt-4o-mini`, `gpt-4.1`, `gpt-5`, `gpt-5-mini`, `gpt-5-codex`, `o3`, `o4-mini`, plus VibeBaton aliases `gpt-6.2-sol`, `gpt-6.2-astra`);
    - DeepSeek (`deepseek-chat`, `deepseek-reasoner`, `deepseek-flash`, `deepseek-v4-pro`, `deepseek-v4.1-flash`).
  - Implement `normalize_model_name(model: str) -> str`: strips `@effort` (`@low`, `@high`, `@max`, `@xhigh`) and provider prefixes (`anthropic/`, `openai/`, `deepseek/`, `opencode-go/`).
  - Implement 3-tier resolution `resolve_model_pricing(...) -> ResolvedModelPricing | None`:
    1. Custom (`provider.model_pricing` -> `[pricing.custom]` -> `~/.vibebaton/custom_pricing.json`);
    2. Official cached table (`~/.vibebaton/pricing_cache.json`);
    3. Built-in `DEFAULT_MODEL_PRICING`.
  - Implement `compute_token_cost_usd(model, prompt_tokens, completion_tokens, cached_tokens=0, pricing_table=None, custom_pricing=None, cache_path=None, custom_path=None) -> float | None` using exact `Decimal` math; delegate `http_provider.compute_token_cost_usd` to this shared helper cleanly.
  - Implement `sync_official_pricing(settings, *, force=False, fetcher=None) -> PricingSyncResult`:
    - Checks whether cache is missing or older than `settings.refresh_interval_hours * 3600` (`86400s` default);
    - Parses LiteLLM schema (`input_cost_per_token * 1_000_000`, `output_cost_per_token * 1_000_000`, `cache_read_input_token_cost * 1_000_000`, storing canonical keys and mapped aliases safely) as well as direct `per_1m` maps;
    - Writes `~/.vibebaton/pricing_cache.json` atomically (`fetched_at`, `source_url`, `models`);
    - On network/parse error returns `PricingSyncResult(ok=False, ..., preserved_cache=True)` without throwing.
  - Implement `trigger_background_pricing_sync(settings, *, cache_path=None, fetcher=None) -> threading.Thread | None`: respects `settings.auto_sync` and `os.environ.get("VIBEBATON_DISABLE_PRICING_SYNC") == "1"`.
  - Implement `load_custom_pricing(path)` / `save_custom_pricing(path, updates)` / `build_pricing_catalog(...)` helpers.
- **CLI & Web API**:
  - `src/vibebaton/cli.py`: add `baton pricing sync [--repo .] [--config ...] [--force] [--json]` and `baton pricing show [--repo .] [--config ...] [--json]`.
  - `src/vibebaton/web_server.py`: add `GET /api/pricing`, `POST /api/pricing/sync`, and `PUT /api/pricing/custom` (supporting updating or clearing per-model custom overrides in `~/.vibebaton/custom_pricing.json`, validated strictly for finite non-negative numbers).
  - `baton.example.toml`: document optional `[pricing]` (`refresh_interval_hours = 24`, `auto_sync = true`, commented `[pricing.custom."..."]` override snippet).
  - `tests/test_pricing.py`: comprehensive unit tests covering TOML config, 3-tier override precedence, `@effort` normalization, 24h staleness detection, LiteLLM JSON parsing, failure cache preservation, custom file persistence, CLI `baton pricing sync/show`, and REST endpoints using injected mock fetchers (zero live HTTP calls).

### M3: All-CLI Native JSON/JSONL Token Collection (`cli_runner.py`, `engine.py`), Studio Pricing Modal & `v1.0.3` Release

- **All-CLI Structured Token Extraction (`src/vibebaton/cli_runner.py`, `src/vibebaton/engine.py`, `baton.example.toml`)**:
  - Add pure helper `parse_cli_output_and_usage(stdout: str, stderr: str, output_file_text: str | None, *, provider_type: str, command: list[str], provider_name: str)` handling:
    1. **Claude JSON (`--output-format json` / `stream-json`)**: extracts `result` text (preferring `output_file_text` if already written cleanly by tool use, or falling back to extracted JSON `result` text) and sums `usage`:
       - `cached = cache_read_input_tokens`
       - `prompt = input_tokens + cache_read_input_tokens + cache_creation_input_tokens`
       - `completion = output_tokens`
    2. **Codex JSONL (`codex exec --json`)**: parses newline-delimited JSON objects from stdout, sums all `usage` blocks (`input_tokens`, `cached_input_tokens`, `output_tokens`), and falls back to last `agent_message` text only when `output_file_text` is empty.
    3. **DSH JSONL (`dsh --profile headless --json`)**: parses newline-delimited JSON events from stdout, sums token usage across `usage` / `token_usage` / `metrics` dicts (`prompt_tokens`/`input_tokens`, `completion_tokens`/`output_tokens`, `cached_tokens`/`cached_input_tokens`/`cache_read_input_tokens`), and extracts final assistant text if structured (`message`/`result`/`text`/`content`) when present.
    4. **Plain-text fallback**: non-JSON stdout leaves text unchanged with zero tokens and `cost_usd = None`.
  - Compute `cost_usd` in `run_provider_cli` / `invoke_provider` via `pricing.compute_token_cost_usd(...)` using active provider `model_pricing` + `[pricing.custom]` + custom JSON + daily official cache + built-in official table, and populate `CLIResult.{prompt_tokens, completion_tokens, cached_tokens, cost_usd}`.
  - Update `engine.py` `OrchestrationEngine.execute_run` to invoke `trigger_background_pricing_sync(cfg.pricing)` at run start (daemon thread, non-blocking) and pass `[pricing]` overrides cleanly when pricing CLI invocations (`_invoke_role`).
  - Update default command templates in `baton.example.toml` (`claude_sub` with `--output-format json`, `codex_sub` with `--json`, `dsh_opencode` with `--json`).
  - Add unit + engine billing integration tests in `tests/test_cli_usage_billing.py` verifying Claude JSON, Codex JSONL, DSH JSONL, plain-text fallback, and end-to-end `role_completed` -> `compute_run_telemetry` USD billing.
- **Studio API Pricing UI (`web/`)**:
  - `web/src/types/graph.ts` & `web/src/api/client.ts`: add `PricingModelEntry`, `PricingStatusResponse`, `CustomPricingUpdate`, and client methods `getPricing()`, `syncPricing()`, `saveCustomPricing(...)` (with full demo-mode support).
  - `web/src/components/inspector/PricingModal.tsx` (+ tests): modal launched from `LiveRunPanel` (header action button next to Model Runtime / billing summary) showing:
    - Sync status badge (last fetched time, `24h` auto-sync interval, `Sync Official Prices / 立即同步官方价` button);
    - Model rate table displaying source badge (`Custom / 自定义`, `Official Cache / 官方缓存`, `Built-in / 内置官方价`), Input / Cached / Output USD per 1M tokens, inline edit inputs to set custom per-1M rates, Save, and Reset to Official buttons.
  - Complete `EN | 中文` parity in `web/src/i18n/messages.ts` (`messages.pricing`, pure EN zero CJK, Han in ZH, zero `OpenCode`).
- **Release Metadata & Collateral (`1.0.3`)**:
  - Update version to `1.0.3` in `pyproject.toml`, `src/vibebaton/__init__.py`, `web/package.json`.
  - Append `## [v1.0.3] - 2026-11-22` at the end of `CHANGELOG.md` after `v1.0.2`.
  - Add Stage 4.7 (`v1.0.3`) entry at the end of `docs/ROADMAP.md`.
  - Update `RELEASE_VERSION = "1.0.3"` in `tests/test_version_consistency.py`.

## Verification & Acceptance Criteria

Run all verification suites cleanly inside the target branch/worktree:

```bash
cmd /c "cd /d web && npx.cmd vitest run && npx.cmd tsc --noEmit && npm.cmd run build"
cmd /c "set PYTHONPATH=src&& set PYTHONUTF8=1&& python -m unittest discover -s tests -v"
```

1. Zero remaining unintended `"DeepSeek API"` strings remain across presets, UI labels, telemetry display mapping, and test suites (`"DSH"` used consistently with internal `dsh_opencode` IDs preserved).
2. `tests/test_pricing.py` passes with 100% mocked fetchers, verifying 3-tier priority (`custom > official_cache > builtin`), 24-hour refresh threshold, atomic cache updates, and offline error isolation.
3. `tests/test_cli_usage_billing.py` verifies JSON/JSONL usage extraction and USD calculation across Claude CLI, Codex CLI, DSH CLI, plain-text fallback, and end-to-end engine telemetry.
4. `python -m vibebaton --version` prints `vibebaton 1.0.3`, and `python -m vibebaton pricing show --help` / `baton pricing sync --help` exit `0`.
5. Frontend `npx.cmd vitest run`, `npx.cmd tsc --noEmit`, and `npm.cmd run build` exit `0` with full `EN | 中文` parity and zero `/opencode/i` leaks in `i18n.test.ts`.
6. All Python unit and full-stack integration tests (`python -m unittest discover -s tests -v`) exit `0` (`test_version_consistency.py` and `test_release_collateral.py` green).
