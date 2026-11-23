# Changelog

All notable changes to VibeBaton are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Releases are listed oldest first so the project's self-hosting history reads top to bottom.

## [v0.1-seed] - 2026-11-21

The zero-dependency seed: a single Python 3.11+ standard-library package that can orchestrate
its own next version.

### Added

- Pure-stdlib core with a SQLite WAL state machine, Windows process-tree stall detection, and
  subscription-aware `429` cooldown/resume scheduling.
- Git worktree isolation for concurrent tasks, a physical path-whitelist guard, and deterministic
  mechanical gates (lint / typecheck / unit test) that run before expensive AI review.
- `baton doctor` readiness probing and `baton report` Build-in-Public battle reports.
- Zero-dependency MCP stdio server for Antigravity control-plane tools.
- `baton promote-seed` dual-copy self-hosting: export an immutable runner so VibeBaton can safely
  build its own next release without mutating the engine that is running.

## [v0.2.0] - 2026-11-21

First four-tier self-bootstrap: VibeBaton built this release with its own seed runner in 107
minutes, completing 3/3 milestones and 9/9 tasks.

### Added

- Declarative node-graph engine (`graph_schema.py`, `graph_engine.py`) with seven atomic node
  types: `planner_node`, `router_node`, `worker_node`, `gate_node`, `reviewer_node`, `merge_node`,
  and `human_gate_node`, plus bounded-loop validation and `max_loops` circuit breakers.
- Three deterministic mock scenarios for offline rehearsal: `happy_path`, `gate_retry`, and
  `escalate`.
- `presets.py` with four official `.baton.json` workflow presets, the `baton presets` and
  `baton graph` CLI commands, and two additional MCP tools (nine total).
- Test suite expanded from 6 to 63 tests, still with zero third-party runtime dependencies.

### Changed

- Backported three-point `merge-base` concurrency isolation, milestone-level `MINOR_FIX`
  auto-repair, and Windows `/dev/null` -> `NUL` gate compatibility into the main engine.

## [v0.3.0] - 2026-11-21

Codename `canvas` (published as `v0.3.0-canvas`): VibeBaton gained a visual studio without
adding a Python dependency.

### Added

- Zero-dependency local backend (`baton ui`) built on `ThreadingHTTPServer` and Server-Sent
  Events, bound to `127.0.0.1` by default, with a REST API, TOML config hot-write, and static
  hosting for the Studio frontend.
- React 19 + TypeScript + React Flow Studio with drag-and-drop canvases, a node property
  inspector, `.baton.json` import/export, live `baton.toml` reloads, and an offline
  `localSimulator.ts` playground.
- Three-color Baton Flow particles, a 60x replay of the real Stage 1 self-bootstrap, and
  zero-backend `#recipe=` URL sharing.
- Complete `EN | 中文` interface with localized event logs and battle reports, plus a
  Quick Start guide.
- Liquid Theme Reveal and synchronized Web Audio effects, with responsive mobile layout.
- 141 frontend and 106 backend tests covering the studio and server.

## [v0.9.0-beta] - 2026-11-22

The ecosystem beta: approachable recipes, smart allocation, and reproducible benchmarks.

### Added

- **Recipe Plaza** with seven scenario presets, including same-family (`claude_only_3tier`,
  `codex_only_3tier`, `deepseek_bulk_factory`), `bulk_batch`, `small_project`, and `audit`
  workflows, plus automatic "ready on this machine" highlighting from `baton doctor`.
- **Unified Smart Allocation**: `eco` / `balanced` / `max_quality` budget profiles, a constrained
  model catalog, zero-cost runtime step-ups (`@low -> @max -> flagship`), and per-node pinning.
- **Preflight and Brainstorm Gate**: a three-step launch wizard covering local CLI / API key
  readiness, a 5-second doctor probe, structured brainstorming with a `safe_for_overnight` score,
  and a pre-launch division-of-labor and guardrail summary.
- **Live Run Canvas Sync**, stage timing (`01_PLAN` and M1-M4), per-model runtime telemetry,
  historical run switching, and expandable task audit / gate / whitelist details.
- Complete bilingual battle reports (`EN | 中文`) and the standalone beginner guide
  `docs/TUTORIAL.md`.
- Public reproducible three-arm benchmark harness under `benchmarks/` with a hidden evaluation
  runner covering pass rate, high-tier call share, and stage latency.

## [v1.0.0] - 2026-11-22

Production release: native HTTP providers, automatic conflict resolution, OS-level container
isolation, and turnkey Windows installation.

### Added

- **Native OpenAI-compatible HTTP provider** (`type = "http"`) built on `urllib.request`, with no
  external CLI or runtime dependency. Works with OpenAI, DeepSeek API, OpenCode Go, and local
  vLLM / Ollama endpoints; resolves keys from environment variables or the local credential
  store, honors custom headers, and feeds HTTP `429` / `Retry-After` responses into the existing
  SQLite cooldown scheduler.
- **Exact Token & USD billing**: per-provider `model_pricing` tables record
  `prompt_tokens`, `completion_tokens`, `cached_tokens`, and `cost_usd` for every role call.
  Billing flows into run telemetry, bilingual battle reports, and the Studio live-run panel
  without changing legacy report bytes when exact billing is absent.
- **Auto-Conflict-Resolver**: concurrent worktree squash-merge conflicts are detected inside an
  isolated `_merge_*` worktree, dispatched to a specialist resolver role, and accepted only when
  zero conflict markers remain and mechanical gates pass. Exhausted retries escalate cleanly to
  `WAITING_HUMAN` instead of crashing the run.
- **Container sandbox**: `baton sandbox init --repo . [--force]` generates a Dockerfile,
  Docker Compose service, Dev Container definition, `.dockerignore`, runtime archive, and
  credentials placeholder. The templates run as non-root `baton`, drop all capabilities, enable
  `no-new-privileges`, use a read-only root filesystem with scoped `tmpfs`, mount only the target
  repository, and never mount `~/.ssh`.
- **Windows one-click installer** (`scripts/install.ps1`) with `-DryRun` and `-RepoPath`
  parameters; it validates Python 3.11+ and Git, optionally checks Node/npm for the Studio build,
  and verifies `baton --version` and `baton doctor --help`.
- **Studio cost and conflict panels**: exact USD badges and token breakdowns in the live-run
  panel, plus localized `merge_conflict_detected` / `merge_conflict_resolved` /
  `merge_conflict_failed` events in pure English and `EN | 中文`.
- Release collateral: `docs/RELEASE_NOTES_v1.0.md`, refreshed `README.md`, and this changelog.

### Changed

- `ProviderConfig` accepts optional `base_url`, `api_key_env`, `headers`, and `model_pricing`
  fields when `type = "http"`; existing `type = "cli"` providers are untouched.
- `[policies]` gains optional `auto_resolve_merge_conflicts` (default `true`) and
  `max_conflict_resolve_attempts` (default `1`); `roles.conflict_resolver` is optional and falls
  back to the existing critical-executor / micro-orchestrator roles.
- Version reporting is now `1.0.0` across Python and frontend manifests.
- **Fully backward compatible**: existing CLI commands, presets, `baton.toml` files, nine MCP
  tools, and legacy battle-report output continue to work unchanged, with zero new Python runtime
  dependencies.

### Fixed

- Interrupted squash merges left over from a crashed daemon are now detected and recovered in
  their isolated integration worktree instead of blocking subsequent runs.
- Container scaffolds now build from a self-contained runtime archive, so `baton` starts inside
  an unrelated target repository instead of relying on the host module path.

### Security

- `docs/SECURITY.md` documents the container trust boundary, hardening controls, and the rule
  that the path-whitelist guard remains a post-hoc Git audit rather than a kernel sandbox.

## [v1.0.1] - 2026-11-22

### Added

- Resize both Studio side panes with the mouse or keyboard. The Studio remembers their widths.
- Live telemetry includes server time and timing anchors for stages, model calls, and tasks.
- The bilingual Studio spotlight tour opens from Quick Start or Tutorial. It has seven steps when
  a local run is available and six in the standalone demo.
- The Tutorial tab includes three theme-aware SVG diagrams covering the relay, guided launch,
  and worktree safeguards. The beginner guide also illustrates the relay and worktree safeguards
  with Mermaid diagrams. [Beginner tutorial](docs/TUTORIAL.md)

### Changed

- The live-run inspector uses expandable task cards to show gate, review, and whitelist details.
- Active clocks on the canvas, live-run card, and inspector update once a second. Historical runs
  display their recorded durations.

## [v1.0.2] - 2026-11-22

### Added

- **Human attention notifications**: a new optional `[notifications]` config table plus a
  pure-stdlib `AttentionNotifier`. It delivers alerts to Feishu (`feishu`), WeCom (`wecom`),
  DingTalk (`dingtalk`), Slack (`slack`), Discord (`discord`), or any generic (`generic`) webhook,
  raises a Windows toast, and rings the terminal bell.
- Structured `human_attention_required` events and `telemetry.attention` coverage across six
  attention states: `waiting_human`, `ready_for_final_gate`, `failed`, `paused`, `long_cooldown`,
  and `test`.
- `baton notify-test` sends a test attention event and prints one row per notification channel,
  with webhook URLs masked in the output.

### Changed

- The Web Studio now shows an `AttentionBanner` for live attention events, with browser
  notification, tab flash, and an audio chime, localized with full `EN | 中文` parity.
