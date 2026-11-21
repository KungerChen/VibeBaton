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

## License

MIT License — see [`LICENSE`](LICENSE).
