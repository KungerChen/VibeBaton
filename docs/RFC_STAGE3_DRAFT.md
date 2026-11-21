# Draft Master RFC: VibeBaton Stage 3 (`v0.9-beta`) — Smart Allocation, Scenario Recipes & Reproducible Benchmarks

> [!NOTE]
> This is the working RFC draft consolidated from L0 brainstorming prior to Stage 3 ignition. It will be finalized into `.baton/00_RFC.md` after Stage 2 (`v0.3.0-canvas`) completes L0 Final Gate.

---

## 1. Goal

Transition VibeBaton from an engineering/canvas tool (`v0.3.0`) into an approachable, verifiable **ecosystem release (`v0.9-beta`)** that:
1. Works smoothly for **single-provider / medium projects** as well as **4-tier heavy projects** via **Unified Smart Allocation**;
2. Guides newcomers through **Preflight Config Check → Interactive Brainstorm → RFC Readiness Gate → Launch** without getting stuck on missing CLIs;
3. Ships **Scenario & Same-Family Recipes** plus a **Reproducible 3-Arm Benchmark Suite** proving cost/quality/speed trade-offs objectively.

---

## 2. Core Architectural Additions

### Deliverable 1: Unified Smart Allocation (`config.py`, `schemas.py`, `engine.py`)
Unifies "dynamic reasoning effort for single-model medium projects" and "cross-vendor tier routing for large projects" into one constrained system:
- **`ModelCapability` / `model_catalog` in `config.py`**:
  - Derived from `baton.toml` + `baton doctor` readiness checks (`provider`, `model`, `efforts: list[str]`, `cost_tier: "eco" | "standard" | "flagship"`, `ready: bool`).
  - Supported `budget_profile` policy setting: `"eco" | "balanced" | "max_quality"` (default `"balanced"`).
- **`TaskSpec` extensions in `schemas.py`**:
  - Optional fields `assigned_model: str | None = None` (formatted `model@effort` or `provider:model@effort`, validated strictly against `model_catalog` so planners cannot hallucinate invalid/offline models), `allocation_reason: str | None = None`, and `pinned: bool = False`.
- **Plan-Time Allocation + Zero-Cost Runtime Step-Up in `engine.py`**:
  - L1 Tactical Planner assigns per-task `assigned_model` + `allocation_reason` once during planning according to `budget_profile` (when only 1 provider is ready/configured, automatically degrades cleanly to single-model dynamic effort allocation across `@low` / `@high` / `@max`).
  - If a task running on a lower tier/effort hits `max_self_heal` or `max_review_rejects`, runtime escalation automatically steps up along the configured escalation ladder (e.g., `flash@low` → `flash@max` → `gpt-6.2-sol@max`) without extra LLM routing calls.

### Deliverable 2: Scenario & Same-Family Recipe Plaza (`presets/*.baton.json`, `presets.py`)
- Extend preset schema (`WorkflowGraph` optional metadata) cleanly:
  - `category`: `"flagship" | "same_family" | "bulk_batch" | "small_project" | "audit_only"`
  - `required_providers`: `list[str]`
  - `cost_tier`: `"low" | "medium" | "high"`
  - `inspired_by`: `str | None` (linking community-validated engineering patterns, avoiding unverified celebrity endorsements)
- Add starter & same-family presets under `presets/` / `recipes/`:
  - `claude_only_3tier.baton.json` (Claude Planner + Executor + Opus Reviewer)
  - `codex_only_3tier.baton.json` (Codex Astra + Codex Sol + Gate)
  - `deepseek_bulk_factory.baton.json` (Pure OpenCode Go / DeepSeek cost-optimized batch pipeline)
- Frontend & `/api/presets` highlight presets whose `required_providers` are all `ready == True` on the user's machine.

### Deliverable 3: Interactive Brainstorm, RFC Readiness Gate & Preflight Setup (`rfc_checker.py`, `web_server.py`, `web/`)
- **`src/vibebaton/rfc_checker.py`**:
  - Deterministic mechanical RFC check (`check_rfc_readiness(rfc_text)`) verifying presence of concrete Goal, Out-of-Scope/Constraints, and Verifiable Acceptance/Test Commands. Returns `{score, warnings, missing_sections, safe_for_overnight}`.
- **`baton ui` Guided Launch Flow**:
  - **Step 1 — Preflight Check**: visualizes `🟢 Ready / 🟡 Cooldown / 🔴 Missing` on node cards, adds **⚡ 5s Click-to-Doctor** (`POST /api/doctor/role`) per node, offers API Key setup form for OpenAI-compatible / DeepSeek / OpenCode Go keys (stored locally, never in repo), copyable official install/login commands for missing CLIs (explicitly NOT auto-installing/auto-logging-in third-party closed CLIs), and one-click fallback to ready presets.
  - **Step 2 — Interactive Brainstorm (with Guarded Skip)**: 2–3 turn convergence from plain idea into `.baton/00_RFC.md`; clicking **"Skip Brainstorm"** runs `check_rfc_readiness()` and displays specific risk warnings before confirming launch. Headless `baton run` / MCP remains 100% non-blocking.
- **Mandatory Milestone Integration Gates & Anti-Drift Prompt Hardening**:
  - Backport Stage 2 prompt lessons into `prompts/l1_planner.md` (require cross-module real integration test in every milestone `gate_commands`; assign `reviewer_role: null` for `critical` tasks so `Claude Opus` serves as milestone gatekeeper) and `prompts/l2_codex_orchestrator.md` (no moving goalposts on round 2+).

### Deliverable 4: Reproducible 3-Arm Benchmark Suite (`benchmarks/`)
- Select a **medium-complexity, multi-module contract task** (e.g., implementing 10–12 standardized resource adapters + error codes + unit tests against a shared interface) with an objective **Hidden Eval Suite** unseen by all agents during generation.
- Benchmark harness comparing 3 reproducible arms on identical inputs:
  1. **Arm A**: Low-cost single model (`deepseek-v4.1-flash@max`)
  2. **Arm B**: Flagship single model sequential (`opus@high` or `gpt-6.2-sol@max`)
  3. **Arm C**: VibeBaton 4-tier hybrid (`Claude + Codex + DSH` with path whitelist + mechanical gates)
- Publishes verifiable comparison metrics: Hidden Eval Pass Rate, Whitelist/Contract Violations, Total Wall-Clock Time, and Flagship Invocation Share.

---

## 3. Target Acceptance Criteria (Stage 3)

- [ ] `Smart Allocation` selects only `ready` models from `model_catalog`, supports single-model dynamic effort mode, and passes unit tests for plan-time assignment + runtime step-up escalation.
- [ ] `baton presets --validate` passes all expanded scenario & same-family recipes.
- [ ] `rfc_checker.py` accurately flags missing test commands / constraints when skipping brainstorm in `baton ui`.
- [ ] `POST /api/doctor/role` & API Key setup endpoints work cleanly and pass full unit/UI tests without leaking secrets.
- [ ] `benchmarks/` runs reproducibly and exports Markdown/JSON comparison tables.
