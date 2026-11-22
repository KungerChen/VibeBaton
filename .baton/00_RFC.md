# Master RFC: VibeBaton Stage 3 (`v0.9.0-beta`) — Smart Allocation, Recipe Plaza, Guided Launch & 3-Arm Benchmark Suite

## 1. Goal

Upgrade VibeBaton from `v0.3.0-dev` (Visual Studio Canvas) to **`v0.9.0-beta`** (Verifiable Multi-Model Ecosystem Release) across 4 integrated milestones:
1. **Unified Smart Allocation & Anti-Drift Prompt Hardening** (`config.py`, `schemas.py`, `allocation.py`, `engine.py`, `report.py`, `prompts/`) — constrained catalog routing supporting single-provider dynamic effort (`@low`/`@high`/`@max`), cross-vendor routing (`eco` / `balanced` / `max_quality`), pinned overrides, and zero-LLM-cost runtime step-up escalation.
2. **Scenario & Same-Family Recipe Plaza + RFC Readiness Gate & Local Credentials Store** (`presets/`, `presets.py`, `graph_schema.py`, `rfc_checker.py`, `credentials.py`, `web_server.py`) — 7 official presets including same-family stacks, mechanical RFC readiness scoring, secret-hygiene local credential storage outside Git, and 5s Click-to-Doctor endpoints.
3. **Stage 3 Studio Frontend (`web/`)** — Recipe Plaza filtering (`Ready on Host`, categories, cost tier), Budget Profile selector, per-node readiness indicators + 5s Doctor button + pin toggle, and a 3-step Guided Launch Wizard (Preflight & API Key Setup -> Interactive Brainstorm / Guarded Skip -> Launch).
4. **Reproducible 3-Arm Benchmark Suite (`benchmarks/`)** — self-contained multi-module contract task, hidden evaluation suite, reproducible `--mock` and `--live` 3-arm runner, Markdown/JSON scoreboard output, and unit tests.

---

## 2. Hard Constraints & Invariants (CRITICAL)

- **Zero New Python Runtime Dependencies**: Python backend MUST use Python 3.11+ standard library only (`pyproject.toml` `dependencies = []`). Keep local HTTP server bound to `127.0.0.1` by default with strict path-traversal rejection.
- **Pre-Installed Frontend Toolchain (CRITICAL — DO NOT run `npm install`)**:
  - `web/package.json`, `web/package-lock.json`, and `web/node_modules/` are **already installed** on the host and mounted into every task worktree via junction.
  - **DO NOT** invoke `npm install` or add/remove npm packages. Use ONLY existing packages: `react`, `react-dom`, `@xyflow/react`, `lucide-react`, `tailwindcss`, `@tailwindcss/vite`, `class-variance-authority`, `clsx`, `tailwind-merge`, `vite`, `@vitejs/plugin-react`, `typescript`, `vitest`.
- **Windows Gate Commands**:
  - Never use `/dev/null`. Always use `npm.cmd` and `npx.cmd` in Windows shells.
  - Python gate: `python -m unittest discover -s tests -v`
  - Frontend gate: `cmd /c "cd /d web && npx.cmd vitest run && npx.cmd tsc --noEmit && npm.cmd run build"` (or `cd web && npx.cmd vitest run && npx.cmd tsc --noEmit && npm.cmd run build`).
- **UI / i18n / Brand / Secret Hygiene Invariants**:
  - Default UI language is **pure English**, with complete **EN | 中文** i18n coverage (`web/src/i18n/messages.ts`, `presets.ts`). No mixed-language UI strings.
  - All user-visible labels & presets must display **`DeepSeek API`** (never advertise third-party `"OpenCode"`), while preserving underlying config key `provider: "dsh_opencode"` and `model: "deepseek-v4.1-flash@max"` untouched.
  - Preserve existing **shadcn/ui + Tailwind v4 + React Flow UI (`BaseNode`) Studio styling**, **`web/src/liquid-theme/`**, and **Web Audio sound controls**.
  - Never store API keys/secrets inside `.baton.json` or `.baton/baton.toml`; never auto-install or auto-login closed third-party CLIs. Store local user credentials exclusively outside the repository (`~/.vibebaton/credentials.json` or injectable `credentials_path` for tests) and always return masked values in API responses.
- **100% Backward Compatibility**: Preserve all 12 CLI subcommands, all 9 MCP tools, all 106 existing Python tests, and all 141 existing frontend Vitest tests.

---

## 3. Milestones & Module Deliverables (Contract-First)

### Milestone M1: Unified Smart Allocation & Prompt Hardening

#### 1. `src/vibebaton/config.py` & `src/vibebaton/schemas.py`
- **`config.py`**:
  - Add `ModelCapability` dataclass (`provider: str`, `model: str`, `efforts: list[str]`, `cost_tier: Literal["eco", "standard", "flagship"]`, `ready: bool`, `detail: str = ""`, with `to_dict()`).
  - Extend `PolicySettings` with `budget_profile: str = "balanced"` (validate allowed values `"eco" | "balanced" | "max_quality"`, falling back or raising clean `ValueError` consistently with config loaders; preserve existing defaults when key is absent).
  - Add `build_model_catalog(cfg: BatonConfig, provider_checks: dict[str, dict[str, Any]] | None = None) -> list[ModelCapability]` inspecting configured `providers` and `roles` + fallback targets without hallucinating unavailable models.
- **`schemas.py`**:
  - Extend `TaskSpec` with optional backward-compatible fields (defaulting cleanly so existing PlanDAG JSONs remain valid):
    - `assigned_model: str | None = None` (e.g. `"deepseek-v4.1-flash@low"` or `"codex_sub:gpt-6.2-sol@max"`)
    - `allocation_reason: str | None = None`
    - `pinned: bool = False`

#### 2. `src/vibebaton/allocation.py`
New pure-stdlib smart-allocation helper module:
- `ALLOWED_BUDGET_PROFILES = ("eco", "balanced", "max_quality")`
- `parse_model_spec(spec: str, default_provider: str, known_providers: Iterable[str]) -> tuple[str, str]`
- `resolve_task_allocation(task: TaskSpec, cfg: BatonConfig, catalog: list[ModelCapability], budget_profile: str | None = None) -> tuple[str, str, str]`:
  - Returns `(provider_name, model_name, reason)`.
  - If `task.pinned` is `True` and `task.assigned_model` resolves to a valid configured/ready candidate, honor it directly.
  - Strictly constrains selection to `ready=True` catalog entries (or degrades cleanly to role's configured fallback / default if catalog checks are unavailable).
  - Supports **single-provider dynamic effort mode**: when only 1 provider is `ready`, varies reasoning effort (`@low` / `@high` / `@max`) by `task.tier` (`routine` vs `critical`) and `budget_profile` (`eco` favors `@low` for routine / `@high` for critical, `balanced` favors `@high`/`@max`, `max_quality` prefers flagship/`@max`).
  - Rejects or safely corrects hallucinated offline/unknown `assigned_model` specs back onto a `ready` catalog target with an explicit reason string.
- `compute_step_up_target(current_provider: str, current_model: str, cfg: BatonConfig, catalog: list[ModelCapability], attempt: int = 1) -> tuple[str, str] | None`:
  - Deterministic zero-LLM-cost runtime escalation ladder (e.g., `eco/@low` -> `@max` same model -> configured role/fallback flagship -> `critical_executor`). Returns `None` when no higher ready tier exists.

#### 3. `src/vibebaton/engine.py`, `src/vibebaton/report.py`, `prompts/`
- **`engine.py`**:
  - Integrate smart-allocation resolution when dispatching tasks (`_invoke_task_worker` / worker execution path), logging allocation decisions cleanly (`task_allocated`) and stepping up along `compute_step_up_target` when retries/self-heal hit effort ceiling without breaking existing `_invoke_role` or `model_overrides` precedence.
  - Keep existing E2E mocked pipeline behavior 100% compatible (`tests/test_e2e_pipeline.py`).
- **`report.py`**:
  - Add concise **Smart Allocation Summary** table/section (budget profile, pinned tasks, runtime step-up events) when allocation events exist, preserving existing battle report structure cleanly.
- **Prompt Hardening (`prompts/l1_planner.md`, `prompts/l2_codex_orchestrator.md`)**:
  - Backport Stage 2 lessons: require a cross-module real integration test in every milestone's `gate_commands`; assign `reviewer_role: null` for `critical` milestone tasks so `Claude Opus` serves as milestone gatekeeper; forbid `MINOR_FIX` rounds from adding new out-of-contract requirements on round 2+.
- **Milestone M1 Gate Commands**:
  - Every critical/integration task and milestone gate must run: `python -m unittest discover -s tests -v`.
  - Add comprehensive unit tests in `tests/test_allocation.py`. (Always set `reviewer_role: null` on `critical` tasks.)

---

### Milestone M2: Recipe Plaza Expansion, RFC Readiness Gate, Local Credentials Store & Backend APIs

#### 1. `src/vibebaton/graph_schema.py` & `src/vibebaton/presets.py` + New Presets (`presets/`)
- **`graph_schema.py`**:
  - Add optional metadata fields to `WorkflowGraph`: `category: str | None = None`, `required_providers: list[str] | None = None`, `cost_tier: str | None = None`, `inspired_by: str | None = None`.
  - Keep `_omit_none` behavior so presets omitting optional metadata serialize identically (preserving existing frontend parity tests until M3 updates both JSON & TS together!).
- **`presets.py`**:
  - Extend `PresetSummary` with `category: str`, `required_providers: list[str]`, `cost_tier: str`, `inspired_by: str | None`. When a `.baton.json` omits explicit `required_providers`, derive unique non-`host_native` providers from `graph.nodes`; derive default `category` from `id`/difficulty so older graphs still get useful metadata cleanly.
- **Add 3 New Official Presets (`presets/*.baton.json`)**:
  - `presets/claude_only_3tier.baton.json` (`id: "claude_only_3tier"`, `category: "same_family"`, `required_providers: ["claude_sub"]`, `cost_tier: "high"`)
  - `presets/codex_only_3tier.baton.json` (`id: "codex_only_3tier"`, `category: "same_family"`, `required_providers: ["codex_sub"]`, `cost_tier: "medium"`)
  - `presets/deepseek_bulk_factory.baton.json` (`id: "deepseek_bulk_factory"`, `category: "bulk_batch"`, `required_providers: ["dsh_opencode"]`, `cost_tier: "low"` — display text uses `"DeepSeek API"` only)
- **IMPORTANT TEST UPDATES in M2**:
  - Update hardcoded 4-preset lists/counts to all 7 presets in `tests/test_presets.py`, `tests/test_graph_cli_mcp.py`, and `tests/test_web_server.py`.
  - Keep existing `presets/{flagship_4tier,review_only_audit,solo_coder_3tier,starter_2tier}.baton.json` untouched during M2 so `web/src/data/presets/*.test.ts` stays 100% green at M2 exit (they get explicit metadata synced in M3 alongside TS).

#### 2. `src/vibebaton/rfc_checker.py` & `src/vibebaton/credentials.py`
- **`rfc_checker.py`**:
  - `check_rfc_readiness(rfc_text: str) -> dict[str, Any]`: pure deterministic checker evaluating Goal, Constraints / Out-of-Scope, Concrete Acceptance / Test Commands (`pytest`, `unittest`, `vitest`, `npm`, `cargo`, `go test`, etc.), and Ambiguity warnings. Returns `{"score": int (0..100), "safe_for_overnight": bool, "missing_sections": list[str], "warnings": list[str], "detected_commands": list[str]}`.
  - `generate_structured_rfc(goal: str, constraints: str = "", acceptance_cmd: str = "", non_goals: str = "") -> dict[str, Any]`: synthesizes structured Markdown RFC and immediately returns `{rfc_markdown, readiness}`.
- **`credentials.py`**:
  - Pure stdlib secret-hygiene manager defaulting to `~/.vibebaton/credentials.json` (with explicit `credentials_path: Path | None = None` override for isolated testing — NEVER writes into repo `.baton/` or `presets/`).
  - Supports keys like `DEEPSEEK_API_KEY`, `OPENAI_API_KEY`, `OPENCODE_API_KEY`, `ANTHROPIC_API_KEY` (reading `os.environ` + local credentials JSON cleanly).
  - `list_credential_status(credentials_path=...)`: returns ONLY `{provider_key, configured: bool, source: "env" | "local_file" | "none", masked: str}` (never returns raw key!).
  - `save_credentials(updates: dict[str, str], credentials_path=...)`: writes safely with restrictive file permissions (`0o600` on POSIX) and returns masked statuses only.
  - `probe_role_or_provider(...)`: fast (~<=5s bounded) readiness check with injectable `health_checker` for deterministic testing.
  - `claude_sub` and `codex_sub` derive readiness from `claude auth status` and `codex login status`, respectively. Doctor suggests the manual sign-in command when the CLI reports a failure.
  - `dsh_deepseek` and `dsh_opencode` require their respective API keys. `resolve_env_for_provider` supplies stored key additions only for these API-key providers.

#### 3. `src/vibebaton/web_server.py`
Add REST endpoints cleanly (preserving all existing 14 routes and CORS/traversal safety):
- Enrich `GET /api/presets` items with `"host_ready": bool` and `"missing_providers": list[str]` computed from local provider health + local credentials.
- Enrich `GET /api/config/roles` with `"budget_profile": cfg.policies.budget_profile` and `"model_catalog": [cap.to_dict() for cap in catalog]`.
- `PUT /api/config/budget`: accepts `{"budget_profile": "eco" | "balanced" | "max_quality"}` (HTTP 400 on invalid), ensures `.baton/baton.toml` exists, persists `[policies] budget_profile = ...` cleanly preserving comments/sections, verifies reload, returns updated budget + catalog.
- `POST /api/doctor/role`: accepts `{"provider"?: str, "role"?: str, "model"?: str}`, runs fast bounded check (injectable probe hook), returns `{ok, provider, detail, latency_ms, install_hint}`.
- `GET /api/credentials` & `POST /api/credentials`: lists masked status & persists keys outside repo (empty string clears local key cleanly).
- `POST /api/rfc/check`: accepts `{"rfc_markdown": str}` -> returns `check_rfc_readiness(rfc_markdown)`.
- `POST /api/rfc/brainstorm`: accepts `{"goal": str, "constraints"?: str, "acceptance_cmd"?: str, "non_goals"?: str}` -> returns `generate_structured_rfc(...)`.
- Add unit tests `tests/test_rfc_checker.py`, `tests/test_credentials.py`, expand `tests/test_web_server.py`, and run full Python + Frontend gate (`tests/test_presets.py`, `test_graph_cli_mcp.py`, `test_web_server.py`, plus existing `vitest run`).

---

### Milestone M3: Stage 3 Studio Frontend (`web/`) — Recipe Plaza, Budget Selector, 5s Doctor & Guided Launch Wizard

1. **Presets Sync & Parity Tests (`presets/*.baton.json` + `web/src/data/presets/`)**:
   - Add explicit `category`, `required_providers`, `cost_tier`, `inspired_by` metadata to the original 4 presets in `presets/*.baton.json`, AND create matching TS exports + parity `.test.ts` files for all **7 presets** (`flagship_4tier`, `solo_coder_3tier`, `starter_2tier`, `review_only_audit`, `claude_only_3tier`, `codex_only_3tier`, `deepseek_bulk_factory`) in `web/src/data/presets/`.
2. **Types, Offline Engine & Dual-Mode Client (`web/src/types/graph.ts`, `web/src/api/client.ts`)**:
   - Extend TypeScript types (`PresetCategory`, `CostTier`, `BudgetProfile`, `ModelCapability`, `ProviderHealthSummary`, `CredentialStatus`, `RfcReadinessResult`, `DoctorRoleResult`, `PresetItem`, `WorkflowGraph`).
   - Implement clean Local HTTP calls + full standalone Demo fallbacks in `BatonApiClient` (so standalone static mode works with zero errors: offline RFC readiness checker matching key heuristics, offline brainstorm generator, simulated host readiness & 5s Doctor preview). Update/expand `web/src/api/client.test.ts`.
3. **Complete Bilingual i18n (`web/src/i18n/messages.ts`, `web/src/i18n/presets.ts`)**:
   - Add pure EN & pure ZH translations for all 3 new presets, Recipe Plaza filters, Budget Profile selector, Node Readiness badges, 5s Doctor, Credentials Setup, Brainstorm Wizard, and Skip Warning dialog (displaying `"DeepSeek API"` cleanly everywhere). Update `web/src/i18n/i18n.test.ts`.
4. **Workspace Components Upgrade (`shadcn/ui` + `Tailwind CSS v4`)**:
   - `LeftSidebar.tsx` / `.css`: **Recipe Plaza** filter chips (`All`, `Ready on Host`, `Same-Family`, `Bulk Batch`, `Small Project`, `Audit`), host-ready indicator & cost tier badge on each preset card, and compact **Smart Budget Profile** segmented switcher (`Eco` / `Balanced` / `Max Quality`).
   - `BatonNode.tsx` / `.css` & `GraphEditor.tsx`: subtle node readiness dot (`Ready` / `Cooldown` / `Missing` derived from provider checks), **`5s Doctor`** button in `NodeEditor` triggering `client.doctorRole(...)` and displaying latency + install hint if missing, plus `Pin model override` checkbox/toggle.
   - `StartRunModal.tsx`: **3-Step Guided Launch Wizard** inside clean `Modal`:
     - Step 1 (**Preflight & Credentials**): shows required providers' status, one-click switch to a Ready preset if missing, and collapsible local API Key Setup saving via `client.saveCredentials` (masked display + note that closed third-party CLIs must be logged in manually with copyable command hints).
     - Step 2 (**Interactive Brainstorm / RFC**): guided fields (Goal, Constraints, Verification Command, Non-goals) -> "Generate RFC", plus live RFC Markdown editor with real-time `RfcReadiness` score pill & warnings. Clicking **"Skip Brainstorm"** checks readiness; if `missing_sections` exist, shows an explicit warning confirmation panel before proceeding cleanly.
     - Step 3 (**Launch Config**): Overnight / Interactive mode + optional model overrides -> Start Real Run!
5. **Version Bump & Full-Stack Build Gate**:
   - Bump version from `0.3.0-dev` to `0.9.0-beta` in `pyproject.toml`, `src/vibebaton/__init__.py`, and `web/package.json` (version field ONLY).
   - Run full frontend gate (`cd web && npx.cmd vitest run && npx.cmd tsc --noEmit && npm.cmd run build`) and Python gate (`python -m unittest discover -s tests -v`, including unskipped `tests/test_web_fullstack.py`).

---

### Milestone M4: Reproducible 3-Arm Benchmark Suite (`benchmarks/`)

1. **`benchmarks/starter_repo/`**:
   - Clean self-contained Python stdlib starter package (`adapters/base.py`, `adapters/errors.py`, `adapters/__init__.py`) defining a clear typed Resource Adapter protocol + error hierarchy for **10 distinct standardized adapters** (e.g., `kv_memory`, `kv_ttl`, `queue_fifo`, `queue_priority`, `rate_limiter`, `cache_lru`, `event_bus`, `retry_policy`, `circuit_breaker`, `config_overlay`).
2. **`benchmarks/task_spec.md` & `benchmarks/hidden_eval/test_hidden_contract.py`**:
   - Detailed task prompt given equally to all 3 arms; independent comprehensive `unittest` hidden evaluation suite (edge cases, error contracts, concurrency/bounds) NOT disclosed in `task_spec.md`.
3. **`benchmarks/run_benchmark.py` & `benchmarks/README.md`**:
   - CLI runner comparing 3 reproducible arms on copies of `starter_repo/`:
     - **Arm A**: Cheap single model (`deepseek-v4.1-flash@max`)
     - **Arm B**: Flagship single model sequential (`opus@high` / `gpt-6.2-sol@max`)
     - **Arm C**: VibeBaton 4-tier hybrid (`Claude + Codex + DeepSeek API` with path whitelist + mechanical gates)
   - Supports `--mock` (deterministic offline simulation computing metrics + running `hidden_eval` cleanly in CI) and `--live` (optional real CLI invocation). Exports `benchmarks/results/latest.json` and `benchmarks/results/latest.md` scoreboard comparing Hidden Eval Pass Rate, Contract Violations, Wall-Clock Time, and Flagship Invocation Share.
   - Each arm uses the same hidden test denominator. An evaluation timeout or invalid summary gives that arm zero passes and records an evaluation error in both scoreboards. The runner still evaluates the remaining arms and exports all results.
4. **`tests/test_benchmark_harness.py`**:
   - Unit tests verifying `--mock` runner executes all 3 arms into temporary dirs without dirtying the repo, validates hidden eval pass/fail detection, and emits valid JSON + Markdown scoreboard output.
   - Milestone M4 Final Gate runs full Python (`python -m unittest discover -s tests -v`) AND full Frontend (`cd web && npx.cmd vitest run && npx.cmd tsc --noEmit && npm.cmd run build`). (Always set `reviewer_role: null` on `critical` tasks.)
