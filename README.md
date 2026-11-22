# VibeBaton (`baton`) v1.0.0

> **Node-based multi-agent coding workflow orchestrator** — compose arbitrary AI coding tiers & local CLI models with Git worktree isolation, mechanical gates, subscription-aware quota scheduling, and Build-in-Public telemetry.
>
> **节点式多 Agent 编程工作流编排器** —— 自由组合任意层级与模型（Antigravity / Claude CLI / Codex CLI / OpenCode Go 等），内置 Git Worktree 并发隔离、机械门禁前置、订阅配额冷却续跑与自举战报生成。

---

## Core Design Principles

1. **Zero-Dependency Seed Core (`v0.1-seed`)**: Runs purely on Python 3.11+ standard library (`sqlite3`, `asyncio`, `tomllib`, `unittest`), including a zero-dependency MCP stdio server for Antigravity.
2. **Provider Agnostic & 1-Line Model Swaps**: Logical roles (`tactical_planner`, `milestone_reviewer`, `micro_orchestrator`, `critical_executor`, `bulk_worker`) are completely decoupled from CLI providers and model IDs. Editing `baton.toml` hot-reloads on the next dispatched task.
3. **Machine-First, LLM-Second**: Deterministic mechanical gates (Lint / Typecheck / Unit Test) and a physical **Path Whitelist Guard** catch defects before spending expensive upper-tier AI review quota.
4. **Subscription-Aware Overnight Execution**: Detects CLI rate-limit / `429` messages, places only the throttled provider into exponential `COOLDOWN` (instead of failing tasks), keeps other workers running, and holds a Windows wake lock until completion.
5. **Safe Dual-Copy Self-Hosting**: Export an immutable snapshot via `baton promote-seed` so VibeBaton can safely develop its own next versions without mutating the running engine.

---

## What's New in v1.0.0

- **Native HTTP providers with exact Token & Cost billing**: `type = "http"` calls any OpenAI-compatible `/v1/chat/completions` endpoint directly from the Python standard library — no external CLI and no SDK. Real `prompt_tokens`, `completion_tokens`, cached tokens, and USD `cost_usd` are recorded per role, aggregated into run telemetry, and rendered in bilingual battle reports and the Studio live-run panel.
- **Auto-Conflict-Resolver for parallel worktrees**: a squash-merge conflict is detected inside an isolated `_merge_*` worktree, dispatched to a specialist resolver role, and accepted only after zero conflict markers remain and the mechanical gates pass. Exhausted retries escalate cleanly to `WAITING_HUMAN` instead of stopping the run.
- **Container sandbox for untrusted repositories**: `baton sandbox init` generates a hardened Docker Compose and Dev Container scaffold with a non-root user, `cap_drop: [ALL]`, `no-new-privileges`, a read-only root filesystem with scoped `tmpfs`, only the target repository mounted, and no `~/.ssh` mount.
- **Turnkey Windows install and Studio panels**: `scripts/install.ps1` validates Python/Git, supports `-DryRun` and `-RepoPath`, and verifies the CLI; the Studio adds exact USD cost badges, token breakdowns, and localized conflict events in pure English and `EN | 中文`.

---

## Documentation & Beginner Guide

- **Beginner Step-by-Step Tutorial (小白保姆级教程)**: [docs/TUTORIAL.md](docs/TUTORIAL.md) — plain-language relay analogy, 5-step Web Studio walkthrough, budget setup, live canvas sync, telemetry, and FAQ.
- **v1.0.0 Release Notes**: [docs/RELEASE_NOTES_v1.0.md](docs/RELEASE_NOTES_v1.0.md) — publishable launch notes, install paths, upgrade notes, and security posture.
- **Built-in Web Guide**: Click **Guide → Tutorial (`详细教程`)** inside the top-right bar of the Web Studio UI (`http://127.0.0.1:7860/`).

---

## Quickstart (Windows PowerShell)

```powershell
# 1. Install once from the VibeBaton checkout (skip to use PYTHONPATH below)
powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1
# or, in any Python 3.11+ environment:
pip install -e .
python -m vibebaton --version

# 2. Run directly without installing anything (alternative to step 1)
$env:PYTHONPATH = "D:\Projects\VibeBaton\src"
python -m vibebaton --version

# 3. Initialize inside your target git repository
python -m vibebaton init --repo D:\Projects\MyApp

# 4. Check local CLIs (claude, codex, opencode) and Git health
python -m vibebaton doctor --repo D:\Projects\MyApp

# 5. Generate a hardened Docker / DevContainer sandbox for untrusted repositories
python -m vibebaton sandbox init --repo D:\Projects\MyApp

# 6a. Trusted repositories only: optionally smoke-test a role, then start an
#     overnight detached run on the host. Both commands read this repository's
#     config and execute its configured CLIs inside it, so never run them for
#     untrusted code — use the container path in step 6b instead.
python -m vibebaton doctor --repo D:\Projects\MyApp --role bulk_worker
python -m vibebaton run --repo D:\Projects\MyApp --rfc .baton\00_RFC.md --detach

# 6b. Untrusted repositories: review the sandbox files generated in step 5, then
#     run inside the container. Do NOT run the host commands in step 6a.
docker compose -f D:\Projects\MyApp\sandbox\docker-compose.yml run --build --rm vibebaton `
  baton run --repo /workspace --rfc /workspace/.baton/00_RFC.md

# 7. Check status and generate a Build-in-Public Markdown battle report
python -m vibebaton status --repo D:\Projects\MyApp
python -m vibebaton report --repo D:\Projects\MyApp --out battle_report.md
```

---

## Native HTTP Providers (DeepSeek API Example)

Providers with `type = "http"` bypass local CLIs and call an OpenAI-compatible endpoint directly. To send the existing `dsh_opencode` role slot to the **DeepSeek API** over HTTP instead of the `dsh` CLI, replace that provider's CLI fields with the HTTP form:

```toml
# User-facing display name: DeepSeek API. Backend key `dsh_opencode` is preserved.
[providers.dsh_opencode]
type = "http"
base_url = "https://api.deepseek.com/v1"
api_key_env = "DEEPSEEK_API_KEY"

# USD per 1M tokens — example rates; use your provider's current pricing.
[providers.dsh_opencode.model_pricing."deepseek-chat"]
input_per_1m = 0.27
output_per_1m = 1.10
cached_input_per_1m = 0.07
```

```powershell
# Placeholder only — put the real key in your environment, never in a committed file.
$env:DEEPSEEK_API_KEY = "sk-REDACTED"
```

Keep the role pointing at `provider = "dsh_opencode"` and set its `model` to a name listed under `model_pricing` (for example, `model = "deepseek-chat"`); token counts and USD cost will appear in the run telemetry and battle report. Omitting the HTTP fields leaves every existing CLI provider unchanged.

---

## Connecting to Antigravity (MCP)

Paste [`agy_integration/mcp_config.snippet.json`](agy_integration/mcp_config.snippet.json) into your Antigravity `mcp_config.json` and copy [`agy_integration/SKILL.md`](agy_integration/SKILL.md) into your skills folder. Antigravity immediately gains 7 asynchronous control-plane tools (`baton_health`, `baton_start`, `baton_status`, `baton_logs`, `baton_resolve`, `baton_control`, `baton_final_package`).

---

## Safe Self-Hosting (Using `v0.1-seed` to Build `v0.2+`)

```powershell
# Export an immutable read-only copy of the verified seed runner outside the git tree
python -m vibebaton promote-seed --dest D:\Projects\VibeBaton-Runner

# Run the immutable runner against D:\Projects\VibeBaton to build Stage 1 (v0.2-engine)
$env:PYTHONPATH = "D:\Projects\VibeBaton-Runner\src"
python -m vibebaton run --repo D:\Projects\VibeBaton --rfc D:\Projects\VibeBaton\.baton\00_RFC.md --detach
```

---

## Running Automated Tests

```powershell
$env:PYTHONPATH = "D:\Projects\VibeBaton\src"
python -m unittest discover -s D:\Projects\VibeBaton\tests -v
```

---

## Why VibeBaton & Honest Boundaries

- **Core Moat**: Cross-vendor heterogeneous orchestration (`Antigravity` + `Claude` + `Codex` + `OpenCode Go / DeepSeek API`) and an open, shareable `.baton.json` workflow recipe ecosystem that no single model vendor will build natively.
- **When to Use It**: Medium-to-large multi-module engineering, batch refactors/migrations, and unattended overnight runs with objective test/lint gates (`unittest`, `tsc`, `vitest`).
- **When NOT to Use It**: Quick 30-second single-file tweaks or vague exploratory UI prototyping — a single interactive agent is faster there.
- **Current Best-Tested Stacks**: Python 3.11+ and TypeScript/Node standalone repositories on Windows; hardened Docker / DevContainer sandbox templates are now included for untrusted repositories (additional ecosystems remain on the roadmap).

---

## Security Model

VibeBaton's **Path Whitelist Guard** is a post-hoc Git worktree audit/revert layer — **not** an OS-level kernel sandbox. Running unattended non-interactive CLI agents directly on your host is recommended **only for trusted repositories**. For untrusted repositories, generate the hardened container sandbox with `baton sandbox init --repo .`. See [docs/SECURITY.md](docs/SECURITY.md) for trust boundaries, sandbox hardening controls, polite rate-limiting rules, and secret hygiene.

---

## Roadmap

- **Stage 0 (`v0.1-seed`)** & **Stage 1 (`v0.2.0`)**: Shipped — pure stdlib node-graph workflow engine, initial presets, 63 tests, self-hosted via `.bootstrap-runner`.
- **Stage 2 (`v0.3.0-canvas`)**: Shipped (`main`) — zero-dependency `baton ui` web server (`ThreadingHTTPServer` + SSE), React Flow 3-pane visual canvas (`EN | 中文`, Liquid Theme Reveal, Web Audio), 3-color Baton Flow particles, real Stage 1 run replay, and `#recipe=` URL sharing.
- **Stage 3 (`v0.9.0-beta`)**: Shipped (`main`) — Recipe Plaza (7 presets including Same-Family & Scenario workflows), Unified Smart Allocation (`eco` / `balanced` / `max_quality`, step-up ladder, single-node Pin), Preflight & 5s Click-to-Doctor + Local Credentials Setup, Brainstorm / RFC Readiness Gate, Live Run Canvas Sync, Stage & Model Runtime Telemetry, Bilingual Battle Reports (`EN | 中文`), Expandable Task Audit Details, Pre-Launch Division/Guard Summary, Beginner Tutorial, and reproducible 3-arm Benchmark harness (`benchmarks/`).
- **Stage 4 (`v1.0.0`)**: Shipped (2026-11-22) — native OpenAI-compatible HTTP providers with exact Token & Cost billing, Auto-Conflict-Resolver for parallel worktrees, `baton sandbox init` Docker/DevContainer templates, `scripts/install.ps1` Windows installer, Studio cost/conflict panels, and `v1.0.0` release collateral (`CHANGELOG.md`, `docs/RELEASE_NOTES_v1.0.md`).

See [docs/ROADMAP.md](docs/ROADMAP.md), [docs/TUTORIAL.md](docs/TUTORIAL.md), and [docs/RFC_STAGE3_DRAFT.md](docs/RFC_STAGE3_DRAFT.md) for full details.

## License

MIT License — see [`LICENSE`](LICENSE).
