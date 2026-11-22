# VibeBaton (`baton`)

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

## Documentation & Beginner Guide

- **Beginner Step-by-Step Tutorial (小白保姆级教程)**: [docs/TUTORIAL.md](docs/TUTORIAL.md) — plain-language relay analogy, 5-step Web Studio walkthrough, budget setup, live canvas sync, telemetry, and FAQ.
- **Built-in Web Guide**: Click **Guide → Tutorial (`详细教程`)** inside the top-right bar of the Web Studio UI (`http://127.0.0.1:7860/`).

---

## Quickstart (Windows PowerShell)

```powershell
# 1. Run directly without installing anything
$env:PYTHONPATH = "D:\Projects\VibeBaton\src"
python -m vibebaton --version

# 2. Initialize inside your target git repository
python -m vibebaton init --repo D:\Projects\MyApp

# 3. Check local CLIs (claude, codex, opencode) and Git health
python -m vibebaton doctor --repo D:\Projects\MyApp

# 4. Run a live 5-second smoke test on a single logical role after changing its model
python -m vibebaton doctor --repo D:\Projects\MyApp --role bulk_worker

# 5. Start an overnight detached run from an RFC
python -m vibebaton run --repo D:\Projects\MyApp --rfc .baton\00_RFC.md --detach

# 6. Check status and generate a Build-in-Public Markdown battle report
python -m vibebaton status --repo D:\Projects\MyApp
python -m vibebaton report --repo D:\Projects\MyApp --out battle_report.md
```

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

- **Core Moat**: Cross-vendor heterogeneous orchestration (`Antigravity` + `Claude` + `Codex` + `OpenCode Go / DeepSeek`) and an open, shareable `.baton.json` workflow recipe ecosystem that no single model vendor will build natively.
- **When to Use It**: Medium-to-large multi-module engineering, batch refactors/migrations, and unattended overnight runs with objective test/lint gates (`unittest`, `tsc`, `vitest`).
- **When NOT to Use It**: Quick 30-second single-file tweaks or vague exploratory UI prototyping — a single interactive agent is faster there.
- **Current Best-Tested Stacks**: Python 3.11+ and TypeScript/Node standalone repositories on Windows (Docker/DevContainer templates and additional ecosystems are on the roadmap).

---

## Security Model

VibeBaton's **Path Whitelist Guard** is a post-hoc Git worktree audit/revert layer — **not** an OS-level kernel sandbox. Running unattended non-interactive CLI agents directly on your host is recommended **only for trusted repositories**. See [docs/SECURITY.md](docs/SECURITY.md) for trust boundaries, polite rate-limiting rules, and secret hygiene.

---

## Roadmap

- **Stage 0 (`v0.1-seed`)** & **Stage 1 (`v0.2.0`)**: Shipped — pure stdlib node-graph workflow engine, initial presets, 63 tests, self-hosted via `.bootstrap-runner`.
- **Stage 2 (`v0.3.0-canvas`)**: Shipped (`main`) — zero-dependency `baton ui` web server (`ThreadingHTTPServer` + SSE), React Flow 3-pane visual canvas (`EN | 中文`, Liquid Theme Reveal, Web Audio), 3-color Baton Flow particles, real Stage 1 run replay, and `#recipe=` URL sharing.
- **Stage 3 (`v0.9.0-beta`)**: Complete on `dev` — Recipe Plaza (7 presets including Same-Family & Scenario workflows), Unified Smart Allocation (`eco` / `balanced` / `max_quality`, step-up ladder, single-node Pin), Preflight & 5s Click-to-Doctor + Local Credentials Setup, Brainstorm / RFC Readiness Gate, Live Run Canvas Sync, Stage & Model Runtime Telemetry, Bilingual Battle Reports (`EN | 中文`), Expandable Task Audit Details, Pre-Launch Division/Guard Summary, Beginner Tutorial, and reproducible 3-arm Benchmark harness (`benchmarks/`).
- **Stage 4 (`v1.0`)**: Planned — Native OpenAI-compatible HTTP provider with exact token/cost billing, Auto-Conflict-Resolver node, Docker/DevContainer sandbox template, and one-click Windows installer.

See [docs/ROADMAP.md](docs/ROADMAP.md), [docs/TUTORIAL.md](docs/TUTORIAL.md), and [docs/RFC_STAGE3_DRAFT.md](docs/RFC_STAGE3_DRAFT.md) for full details.

## License

MIT License — see [`LICENSE`](LICENSE).
