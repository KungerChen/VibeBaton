# VibeBaton v1.0.0 — Production Release

**Released 2026-11-22**

VibeBaton (`baton`) is a local-first, node-based orchestrator for heterogeneous AI coding
agents. It splits work across a planner, reviewers, executors, and high-throughput bulk workers,
runs every task in an isolated Git worktree, and lets cheap mechanical gates (lint, typecheck,
tests, path whitelist) decide what is allowed to reach an expensive AI review or a human.

Bring your own CLIs — Claude Code, Codex, DSH (OpenCode Go), Antigravity — or call an
OpenAI-compatible endpoint directly. VibeBaton coordinates them, enforces the contract, and
produces an auditable battle report at the end.

## Highlights

### Native HTTP providers with exact Token & Cost billing

`type = "http"` calls `POST {base_url}/chat/completions` directly through the Python standard
library. There is no external CLI process, no SDK, and no new runtime dependency.

- Works with OpenAI, DeepSeek's API, OpenCode Go, vLLM, Ollama, and any OpenAI-compatible gateway.
- Keys come from environment variables or the local credential store and are never logged.
- Per-provider `model_pricing` tables turn real `usage` counters into exact
  `prompt_tokens`, `completion_tokens`, `cached_tokens`, and USD `cost_usd`.
- HTTP `429` / `Retry-After` responses reuse the existing subscription cooldown scheduler.
- Billing appears in run telemetry, bilingual battle reports, and the Studio live-run panel.

### Auto-Conflict-Resolver

Parallel worktrees are the point of VibeBaton, and parallel branches eventually collide. When a
squash merge conflicts, VibeBaton now:

1. Detects the conflict inside an isolated `_merge_*` worktree, leaving your main checkout alone.
2. Dispatches a specialist resolver role with both branch intents and the conflicted files.
3. Rejects any merge that still contains conflict markers or fails the task's mechanical gates.
4. Retries within a bounded budget, then escalates cleanly to `WAITING_HUMAN` instead of
   crashing the run.

Conflict detection, resolution, and failure are visible in the Studio timeline and battle report.

### Container sandbox for untrusted repositories

The path-whitelist guard is a post-hoc Git audit, not a kernel sandbox. For third-party code,
`baton sandbox init` now generates a hardened container scaffold in one command:

```bash
baton sandbox init --repo .
docker compose -f sandbox/docker-compose.yml run --build --rm vibebaton
```

The generated Docker Compose and Dev Container definitions run as an unprivileged `baton` user,
drop every Linux capability, set `no-new-privileges`, use a read-only root filesystem with scoped
`tmpfs`, mount only the target repository at `/workspace`, and never mount `~/.ssh`.

### Windows one-click install and Studio billing/conflict UI

`scripts/install.ps1` turns a fresh clone into a working `baton` command. It validates Python
3.11+ and Git, checks optional Node/npm for the Studio build, supports `-DryRun` and `-RepoPath`,
and finishes by running `baton --version` and `baton doctor --help`.

The Web Studio now shows exact USD cost badges and token breakdowns in the live-run panel, and
localizes merge-conflict events in pure English and complete `EN | 中文` parity.

## Zero-dependency install

This zero-dependency install requires Python 3.11+ and Git. There are **zero Python runtime
dependencies**; `pip` only installs the package and its `baton` entry point.

### Windows (one command)

From a clone of the repository:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1
baton --version
```

Run with `-DryRun` first if you want to inspect every action without changing your environment.

### From source (all platforms)

```bash
python -m venv .venv
# Windows: .venv\Scripts\activate
source .venv/bin/activate
pip install -e .
python -m vibebaton --version
```

Optionally build the Studio frontend, then launch it:

```powershell
cd web
npm install
npm run build
cd ..
python -m vibebaton ui --repo D:\Projects\YourApp
```

## Security posture

Read the full trust model before running unattended agents:
[docs/SECURITY.md](SECURITY.md).

In short: VibeBaton's path-whitelist guard catches out-of-scope edits inside the Git worktree,
but it cannot roll back network calls or side effects outside the repository. Run event-driven
pipelines on trusted repositories, or use the generated container sandbox for untrusted code.
Never put API keys in `baton.toml`, `.baton.json`, or a committed file; use environment variables
or the local credential store. The sandbox does not protect against container-runtime escapes or
network egress.

## Upgrade notes

**VibeBaton 1.0.0 is fully backward compatible with 0.9.0-beta.** Existing commands, presets,
`baton.toml` files, and all nine MCP tools keep their contracts, and legacy battle reports remain
byte-identical when no exact billing data exists.

New, optional configuration:

- **HTTP providers** — add `type = "http"` plus `base_url`, `api_key_env`, optional `headers`,
  and optional `model_pricing` to any `[providers.<name>]` block. Omit them and every existing
  CLI provider behaves exactly as before.
- **Conflict policies** — `[policies]` accepts `auto_resolve_merge_conflicts` (default `true`)
  and `max_conflict_resolve_attempts` (default `1`). Set `auto_resolve_merge_conflicts = false`
  to keep the previous stop-on-conflict behavior.
- **Resolver role** — `[roles.conflict_resolver]` is optional. When absent, VibeBaton falls back
  to the existing critical executor / micro orchestrator roles.

```toml
[policies]
auto_resolve_merge_conflicts = true
max_conflict_resolve_attempts = 1
```

To try the native HTTP path, set your key as an environment variable and replace a provider's
CLI fields with the HTTP form:

```toml
# User-facing name: DeepSeek API. The backend key `dsh_opencode` is preserved.
[providers.dsh_opencode]
type = "http"
base_url = "https://api.deepseek.com/v1"
api_key_env = "DEEPSEEK_API_KEY"

[providers.dsh_opencode.model_pricing."deepseek-chat"]
input_per_1m = 0.27
output_per_1m = 1.10
cached_input_per_1m = 0.07
```

```powershell
$env:DEEPSEEK_API_KEY = "sk-REDACTED"  # placeholder; set your real key in the environment
```

Then keep the existing role pointing at `provider = "dsh_opencode"` and set its `model` to a name
listed under `model_pricing` (for example, `model = "deepseek-chat"`).

## Thank you

VibeBaton 1.0.0 is the result of four self-hosted stages: the standard-library seed, the
declarative node engine, the visual Studio, and the ecosystem beta. Every stage was planned,
implemented, gated, and reviewed by the previous stage in an isolated worktree. The project now
ships that same loop to you.

---

## Show HN draft

**Show HN: VibeBaton – run Claude, Codex, and DSH as one gated software factory**

I built VibeBaton because a single coding agent is great for a 30-second edit and terrible at
an overnight, multi-module refactor: it runs out of context, edits files it should not touch, and
declares victory without running the tests. VibeBaton splits the work across cost tiers, gives
every task its own Git worktree, and lets deterministic gates decide what gets merged. v1.0.0
adds direct OpenAI-compatible HTTP providers with exact token/USD billing, an auto-conflict
resolver for parallel branches, and a one-command container sandbox for untrusted repos. It is
local-first, needs only Python's standard library at runtime, and has a one-click Windows
installer plus a web Studio for watching the relay live. I would love feedback from anyone who
has tried to keep multiple coding agents honest on a real repository.
