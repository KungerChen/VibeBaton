# Master RFC: VibeBaton Stage 4 (`v1.0.0`) — Native HTTP Provider & Token Billing, Auto-Conflict-Resolver, Container Sandbox & v1.0 Release

## 1. Goal

Upgrade VibeBaton from `v0.9.0-beta` to **`v1.0.0`** (Production Release) across 4 self-contained, verified milestones:
1. **Native OpenAI-Compatible HTTP Provider & Exact Token/USD Billing (`M1`)** — zero-dependency `urllib.request` client supporting direct `/chat/completions` calls (OpenAI, DeepSeek API, OpenCode Go, vLLM/Ollama local servers), parsing `usage` tokens & USD pricing tables, feeding `role_completed` + telemetry + bilingual Battle Reports with real token and USD cost breakdowns, while reusing SQLite 429 cooldown scheduling.
2. **Auto-Conflict-Resolver for Concurrent Worktree Merges (`M2`)** — upgrade `git_ops.py`, `config.py`, and `engine.py` so squash-merge conflicts inside isolated integration worktrees automatically invoke a specialist resolver role with bounded retries, validate zero conflict markers + passing mechanical gates before committing, and escalate cleanly to `WAITING_HUMAN` only when automated resolution is exhausted.
3. **Docker / DevContainer OS-Level Sandbox Templates & CLI (`M3`)** — fulfill `docs/SECURITY.md` with least-privilege container templates (`sandbox/Dockerfile`, `sandbox/docker-compose.yml`, `.devcontainer/devcontainer.json`), a pure-stdlib scaffolding module (`src/vibebaton/sandbox.py`), and `baton sandbox init` CLI command (`src/vibebaton/cli.py`).
4. **Windows One-Click Installer, Web Studio Cost/Conflict Panels & `v1.0.0` Release (`M4`)** — turnkey PowerShell setup script (`scripts/install.ps1`), Web Studio frontend telemetry extensions (token counts, USD cost badges, conflict-resolution event localization in pure EN + `EN | 中文`), version bump to `1.0.0` across Python & frontend manifests, `CHANGELOG.md` + release announcement draft, and full-stack verification.

---

## 2. Hard Constraints & Invariants (CRITICAL)

- **Zero New Python Runtime Dependencies**: Python backend MUST use Python 3.11+ standard library only (`pyproject.toml` `dependencies = []` unchanged). Only use stdlib modules such as `urllib.request`, `urllib.error`, `http.server`, `json`, `sqlite3`, `asyncio`, `tomllib`, and `unittest`.
- **Pre-Installed Frontend Toolchain (CRITICAL — DO NOT run `npm install`)**:
  - `web/package.json` dependencies and `web/node_modules/` are pre-installed and auto-mounted into every task worktree via junction.
  - **DO NOT** invoke `npm install` or add/remove npm packages. Use only existing packages already in `web/package.json`.
- **Windows Gate Commands**:
  - Never write `/dev/null` in shell/test commands; use `os.devnull` in Python or `NUL` in Windows cmd.
  - Always invoke `npm.cmd` and `npx.cmd` on Windows.
  - Python gate: `python -m unittest discover -s tests -v`
  - Frontend gate: `cmd /c "cd /d web && npx.cmd vitest run && npx.cmd tsc --noEmit && npm.cmd run build"`
- **Orchestration & Testing Hygiene**:
  - Set `reviewer_role: null` on every `critical` task so `Claude Opus` milestone gate audits the integrated result cleanly without redundant micro-review loops.
  - Every milestone's `gate_commands` MUST run full regression tests plus cross-module integration tests for that milestone.
- **UI / i18n / Brand / Secret Hygiene Invariants**:
  - Pure English default (`MESSAGES.en` contains zero CJK characters) + complete `EN | 中文` parity (`MESSAGES.zh` every leaf string / callback output contains Chinese Han characters, per `web/src/i18n/i18n.test.ts`).
  - User-facing UI labels and presets display **`DeepSeek API`** (never leak `"opencode"` substring in `MESSAGES`), while preserving `dsh_opencode` backend keys seamlessly.
  - Preserve shadcn/ui + Tailwind CSS v4 + React Flow UI (`BaseNode`) Studio design, `web/src/liquid-theme/`, and Web Audio controls.
  - Never commit or hardcode real API keys, tokens, or secrets into repository files or logs; credentials stay in env vars or user-home `~/.vibebaton/credentials.json`.
- **100% Backward Compatibility**:
  - Preserve existing CLI commands, all 9 MCP tools, existing `baton.toml` / `baton.example.toml` compatibility when new optional HTTP/pricing/conflict sections are omitted, existing `test_report_without_allocation_events_matches_legacy_bytes` exact byte parity, all existing 223 Python tests, and all existing 264 frontend Vitest tests.

---

## 3. Milestones & Module Deliverables (Contract-First)

### Milestone M1: Native OpenAI-Compatible HTTP Provider & Exact Token/USD Billing

#### 1. `src/vibebaton/http_provider.py`
New pure-stdlib async/sync wrapper around OpenAI-compatible `POST {base_url}/chat/completions`:
- Support configuration fields on `ProviderConfig` (`type = "http"` in `config.py`):
  - `base_url: str = "https://api.openai.com/v1"`
  - `api_key_env: str = "OPENAI_API_KEY"`
  - `model_pricing: dict[str, dict[str, float]] = {}` (per-1M-token USD rates, e.g., `input_per_1m`, `output_per_1m`, optional `cached_input_per_1m`)
  - Optional `headers: dict[str, str] = {}`
- Resolve API keys securely from `os.environ` OR `credentials.load_credentials(credentials_path)` without ever logging the secret key.
- Execute HTTPS/HTTP JSON POST with configurable `hard_timeout_sec`, return normalized `CLIResult` (extended with optional default fields `prompt_tokens: int = 0`, `completion_tokens: int = 0`, `cached_tokens: int = 0`, `cost_usd: float | None = None`).
- Handle HTTP `429` + JSON `rate_limit` / quota errors cleanly (`status="rate_limited"`, parsing `Retry-After` response header or body with `parse_retry_after_seconds`), and map `timeout` / HTTP `4xx`/`5xx` / malformed JSON cleanly to `"timeout"` or `"error"` without crashing the worker loop.
- Include deterministic cost helper `compute_token_cost_usd(model: str, prompt_tokens: int, completion_tokens: int, cached_tokens: int = 0, pricing_table: Mapping[str, Mapping[str, float]] | None = None) -> float | None` using configured pricing plus sensible built-in fallback rates for well-known models when explicit pricing is present.
- Include a provider probe helper `probe_http_provider(provider_cfg, credentials_path=...)` integrated into `credentials.py` / `build_model_catalog()` so `type = "http"` providers report accurate readiness (API key configured + base_url valid) without spawning subprocess binaries!

#### 2. `src/vibebaton/config.py`, `src/vibebaton/cli_runner.py`, `src/vibebaton/credentials.py`
- Extend `ProviderConfig` with optional HTTP fields (`base_url`, `api_key_env`, `headers`, `model_pricing`) keeping `type = "cli"` defaults 100% intact.
- Extend `CLIResult` in `cli_runner.py` with default-initialized telemetry attributes (`prompt_tokens: int = 0`, `completion_tokens: int = 0`, `cached_tokens: int = 0`, `cost_usd: float | None = None`).
- Route `invoke_provider(...)` (called from `engine.py` `_invoke_role`) cleanly: when `provider.type == "http"`, invoke `run_http_provider(...)` instead of subprocess `run_provider_cli(...)`; mockable cleanly for tests.

#### 3. `src/vibebaton/engine.py` & `src/vibebaton/report.py`
- In `engine.py` `_invoke_role`: emit `prompt_tokens`, `completion_tokens`, `cached_tokens`, `cost_usd` inside the `"role_completed"` audit event `payload` whenever > 0 or non-None.
- In `report.py`:
  - Extend `compute_run_telemetry` output cleanly while preserving all existing keys (`elapsed_sec`, `stages`, `models`):
    - Add top-level `"billing"` dict (`total_prompt_tokens`, `total_completion_tokens`, `total_cached_tokens`, `total_tokens`, `total_cost_usd`, `has_exact_billing: bool`) and optional per-model fields (`prompt_tokens`, `completion_tokens`, `cost_usd`) on each entry in `telemetry["models"]`.
  - In `generate_battle_report(..., lang=...)`: append a localized **Token & Cost Summary** (`Token 与美元成本统计` / `Token Usage & Cost Breakdown`) section ONLY when `billing["has_exact_billing"]` is `True` (ensuring `test_report_without_allocation_events_matches_legacy_bytes` stays byte-identical!).
- Add comprehensive unit & integration tests in `tests/test_http_provider.py` using an ephemeral local `http.server` / mock transport verifying: HTTP `/chat/completions`, token & USD cost accumulation, `429 Retry-After` cooldown trigger in `engine.py`, `credentials.py` readiness for `type="http"`, and telemetry + EN/ZH Battle Report output.

---

### Milestone M2: Auto-Conflict-Resolver for Concurrent Worktree Merges

#### 1. `src/vibebaton/git_ops.py` & `src/vibebaton/config.py`
- **`git_ops.py`**:
  - Define explicit `MergeConflictError(GitError)` capturing `source_branch`, `target_branch`, and `conflicted_files: list[str]`.
  - Add pure helper `has_conflict_markers(worktree_dir: Path, files: Iterable[str] | None = None) -> list[str]` checking changed/target files for standard Git conflict markers (`<<<<<<< `, `=======`, `>>>>>>> `) without false-triggering binary files or `.baton/`.
  - Add `merge_branch_with_resolver(...)` (while keeping existing `merge_branch_into(...)` contract intact for backward compatibility!):
    - Uses an isolated `_merge_<target>` worktree (`repo` working directory never switched!).
    - Attempts `git merge --squash <source_branch>`.
    - On clean merge -> commits immediately and returns resolved status dict (`{"merged": True, "conflicts": [], "resolved_by_ai": False}`).
    - On merge conflict -> extracts `conflicted_files` (`git diff --name-only --diff-filter=U`), captures conflict markers & base/ours/theirs context, invokes the supplied async/sync resolver callback inside `merge_wt`, verifies `has_conflict_markers(merge_wt, conflicted_files)` is empty and no unmerged index entries remain (`git diff --name-only --diff-filter=U`), runs `gate_checker(merge_wt)` if provided, stages & commits clean squash merge, and returns `{"merged": True, "conflicts": conflicted_files, "resolved_by_ai": True}`.
    - If resolution fails or gate fails -> aborts merge cleanly in `merge_wt` (`git merge --abort`) and raises `MergeConflictError`.
- **`config.py`**:
  - Add optional `PolicySettings` field `auto_resolve_merge_conflicts: bool = True` and `max_conflict_resolve_attempts: int = 1` (backward compatible defaults) plus optional `roles.conflict_resolver` (defaulting gracefully to `critical_executor` / `micro_orchestrator` when absent from `baton.toml`).

#### 2. `prompts/l2_conflict_resolver.md` & `src/vibebaton/engine.py` & `src/vibebaton/report.py`
- Create concise specialist prompt `prompts/l2_conflict_resolver.md` instructing the resolver to synthesize both branches' intents cleanly, preserve tests, remove all Git conflict markers, and make zero unrelated edits.
- In `engine.py` (all 3 merge sites: task -> milestone, milestone remediation -> milestone, milestone -> dev):
  - Use conflict-aware merge orchestration when `policies.auto_resolve_merge_conflicts` is enabled:
    - Log `merge_conflict_detected` (conflicted file list & branches), invoke resolver role inside the isolated integration worktree, verify zero conflict markers + task/milestone gate commands still pass before final commit, and log `merge_conflict_resolved`.
    - On resolver/gate exhaustion, log `merge_conflict_failed` cleanly; keep existing `WAITING_HUMAN` / remediation escalation behavior safe and deterministic (`_merge_lock` never deadlocks, `_merge_*` worktree always cleaned up in `finally`).
- Extend `report.py` telemetry/report safely with conflict counters when conflict events exist (`conflicts_detected`, `conflicts_auto_resolved`).
- Add comprehensive real-git unit & integration tests in `tests/test_conflict_resolver.py`: simulate concurrent conflicting edits on two branches in a temporary Git repo, verify `MergeConflictError` detection, automated specialist callback resolution (leaving working tree clean and merging both intents), conflict-marker rejection guard, mechanical gate failure abort, and engine E2E recovery.

---

### Milestone M3: Docker / DevContainer OS-Level Sandbox Templates & CLI

#### 1. Sandbox Templates (`sandbox/` & `.devcontainer/`)
- **`sandbox/Dockerfile`**: Python 3.12+ / Node LTS slim image installing Git and the scaffolded VibeBaton runtime at `/opt/vibebaton`. The build context is `sandbox/`, allowlisted to the runtime archive. The image runs as non-root `baton` (UID 1000).
- **`sandbox/docker-compose.yml`**: Least-privilege container configuration mounting only the target repo at `/workspace` (rw), optional read-only `~/.vibebaton` credentials or explicit env vars via `${...}`, enforcing `cap_drop: [ALL]`, `security_opt: [no-new-privileges:true]`, `read_only: true` root filesystem with scoped `tmpfs` (`/tmp`), and zero `~/.ssh` mount.
- **`.devcontainer/devcontainer.json`**: Dev Container template referencing `sandbox/Dockerfile` and running `python -P -m vibebaton --help` after creation.

#### 2. `src/vibebaton/sandbox.py`, `src/vibebaton/cli.py`, `docs/SECURITY.md`
- **`sandbox.py`**: Pure-stdlib generator `init_sandbox_files(repo_dir: Path, force: bool = False) -> list[Path]` writing the templates, `sandbox/.dockerignore`, `sandbox/vibebaton-runtime.zip`, and the default credentials-directory placeholder into the target repo. The archive contains the generating VibeBaton instance's package and bundled CLI resources. The generator preserves existing files unless `force=True` and checks all resolved paths before writing.
- **`cli.py`**: Add `baton sandbox init --repo <path> [--force]` subcommand without altering behavior of any existing subcommand (`--help` stays clean).
- **`docs/SECURITY.md`**: Update Stage 4 container sandbox section documenting `baton sandbox init` and exact container hardening controls (`non-root`, `cap_drop: ALL`, `read_only`, zero `~/.ssh`).
- Add tests in `tests/test_sandbox.py` verifying scaffold creation, idempotency without `--force`, overwrite with `--force`, CLI `baton sandbox init`, Dockerfile/Compose hardening assertions (`USER `, `cap_drop`, `read_only`, no `.ssh`), and `baton --help` regression check.

---

### Milestone M4: Windows Installer, Web Studio Cost/Conflict UI & `v1.0.0` Release

#### 1. Windows One-Click Installer (`scripts/install.ps1`)
- Safe, idempotent PowerShell installer script: verifies Python >= 3.11 and Git availability, checks optional `node`/`npm.cmd` for Web UI build, installs/links `vibebaton` command cleanly into user PATH or virtualenv without touching system-wide Admin settings unnecessarily, checks `baton --version` & `baton doctor --help`, and supports `-DryRun` / `-RepoPath` parameters cleanly.

#### 2. Web Studio Frontend (`web/src/`) Cost & Conflict UI + Bilingual i18n
- **`web/src/types/graph.ts`**: Add `BillingTelemetry` (`total_prompt_tokens`, `total_completion_tokens`, `total_cached_tokens`, `total_tokens`, `total_cost_usd`, `has_exact_billing`) and optional per-model token/cost fields (`prompt_tokens?: number`, `completion_tokens?: number`, `cost_usd?: number`) on `ModelTelemetry` + `billing?: BillingTelemetry | null` on `RunTelemetry`.
- **`web/src/components/inspector/LiveRunPanel.tsx`**:
  - Render compact USD cost badge & token breakdown inside the existing **Model Runtime** card when `telemetry.billing?.has_exact_billing` is true (displaying total cost e.g. `$0.0142` and formatted token counts without breaking mobile `375px` width!).
- **`web/src/i18n/liveEvents.ts`, `web/src/i18n/messages.ts`, `web/src/i18n/i18n.test.ts`**:
  - Add `merge_conflict_detected`, `merge_conflict_resolved`, `merge_conflict_failed` event kinds & formatters (`EN | 中文`), plus Token & Cost UI strings. Keep `i18n.test.ts` invariants 100% green (pure EN, Han chars in every ZH leaf string, zero `"opencode"` anywhere).

#### 3. `v1.0.0` Version Bump & Release Collateral
- Bump version string `"0.9.0-beta"` -> `"1.0.0"` in:
  - `pyproject.toml` (also update classifier from `"3 - Alpha"` to `"4 - Beta"` or `"5 - Production/Stable"`)
  - `src/vibebaton/__init__.py`
  - `web/package.json`
- Write `CHANGELOG.md` (documenting `v0.1-seed`, `v0.2.0`, `v0.3.0`, `v0.9.0-beta`, and `v1.0.0`), `docs/RELEASE_NOTES_v1.0.md` (ready-to-post launch notes for GitHub Release / Show HN / tech communities), and update `README.md` & `docs/ROADMAP.md` reflecting `v1.0.0` completion.
- Update any installer/frontend/full-stack tests (`tests/test_web_server.py`, `tests/test_web_fullstack.py`, `web/src/i18n/liveEvents.test.ts`), run `npm.cmd run build` in `web/`, and verify zero failures across the entire suite.

---

## 4. Non-Goals

- No cloud multi-tenant SaaS hosting, user accounts, or remote database dependencies.
- No third-party Python pip dependencies (`pyproject.toml` `dependencies = []` must remain empty).
- Do not add npm dependencies or execute `npm install` in worktrees.
- Do not commit API keys, secrets, runtime `.baton/state.sqlite*`, `.baton/logs/`, or `.baton/worktrees/` artifacts, and never touch `main` directly during automated execution.

---

## 5. Acceptance Criteria

1. Pure stdlib OpenAI-compatible HTTP provider (`type = "http"`) executes prompts directly against local/mocked HTTP endpoints, records exact `prompt_tokens`, `completion_tokens`, and USD `cost_usd`, triggers existing SQLite cooldown on HTTP `429`, and renders bilingual billing tables in Battle Reports without regressing legacy byte-exact report parity.
2. Concurrent branch squash-merge conflicts are detected inside isolated `_merge_*` worktrees via `MergeConflictError`, automatically dispatched to the specialist resolver, verified for zero conflict markers and passing gate commands before committing, and cleanly fall back to `WAITING_HUMAN` on failure.
3. `baton sandbox init` generates hardened non-root Docker Compose and Dev Container templates that launch the image-installed VibeBaton CLI in an unrelated Git repository. Tests cover `cap_drop: [ALL]`, Compose's `read_only` root filesystem, no host `~/.ssh` mount, and the CLI startup commands.
4. `scripts/install.ps1` exists with `-DryRun` verification, Web Studio renders exact Token/USD billing and conflict events in pure EN + `中文`, manifests consistently report `1.0.0`, and all automated verification gates exit `0`:

```bash
python -m unittest discover -s tests -v
```

```bash
cmd /c "cd /d web && npx.cmd vitest run && npx.cmd tsc --noEmit && npm.cmd run build"
```
